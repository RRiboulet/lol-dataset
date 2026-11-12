// fetch: the one stage allowed to touch the network, so the etiquette lives here.
//
// Spec D5 puts the purity boundary at the cache; D9 makes fetch etiquette a
// designed component rather than an afterthought; R11 is the promise it keeps —
// no secrets, no hammering, and an interruption that costs only the request in
// flight. The intervals and backoff below are not conservative guesses: measured
// 2026-11-12, the source refused after three or four Cargo requests and stayed
// refused for more than a hundred seconds, so a tight loop is not merely rude,
// it does not work.
//
// The measured behaviour that shapes classification: a rate limit arrives as
// HTTP **200** with `{"error":{"code":"ratelimited","info":"..."}}` in the body.
// A fetcher that trusts the status code would cache that as a payload and the
// next build would fail on it — or worse, treat the empty result as real. So
// `classifyResponse` looks inside the body, and only a Cargo array or a
// `cargoquery` envelope is written to the cache. Everything else is retried or
// stops the run; nothing that is not a payload reaches disk.
//
// Both endpoints in `cache.ts` are handled because both are reachable and the
// limiter is on one of them: `api.php?action=cargoquery` is what gets limited,
// while `Special:CargoExport` served the same rows throughout. `action=query`
// kept working too, which is why a `ratelimited` body is a limit on that Cargo
// action rather than an outage — retry it, do not declare the source down.
//
// Testability is injection, not a test mode: `now`, `sleep`, `random` and
// `transport` are parameters with production defaults. The fake-clock tests run
// this same loop with a clock they own, which is the only way to assert spacing
// without a real sleep.
//
// Resumability is a property of the cache key, not of the process: a query is
// skipped exactly when its body and sidecar already agree on disk, so a killed
// run resumes by re-running the same plan and issuing requests only for what is
// missing. The plan itself is ticket 10's job; the manual `fetch` command in
// `cli.ts` takes an explicit one.

import { readFile } from "node:fs/promises";

import type { CargoQuery } from "./cache.ts";
import { cacheKey, canonicalQuery, payloadPaths, queryUrl, readPayload, writePayload } from "./cache.ts";

/** Descriptive and stable; the source is doing us a favour and should see who we are. */
export const USER_AGENT = "lol-dataset/0.1 (+https://github.com/RRiboulet/lol-dataset; throttled crawler)";

/** Measured limiter window: a Cargo request every 75s, with jitter so runs do not sync. */
export const DEFAULT_INTERVAL_MS = 75_000;
export const DEFAULT_JITTER_MS = 15_000;

/** The limiter outlasted 100s in the measurement; 60s then doubling recovers without a storm. */
export const DEFAULT_BACKOFF_MS = 60_000;
export const DEFAULT_ATTEMPTS = 4;

/** What the transport needs, and what it may answer. Kept small so a fake is honest. */
export type TransportRequest = { url: string; headers: Record<string, string> };
export type TransportResponse = { status: number; body: string };
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

/** The real transport: one HTTP request, body as text, no cookies or credentials. */
export const httpTransport: Transport = async ({ url, headers }) => {
	const response = await fetch(url, { headers });
	return { status: response.status, body: await response.text() };
};

/** What a response means to the crawler — never just "did it return 200". */
export type ResponseClass =
	| { kind: "payload"; rows: number }
	| { kind: "ratelimited"; info: string }
	| { kind: "error"; reason: string };

function snippet(body: string): string {
	const flat = body.replace(/\s+/g, " ").trim();
	return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

/**
 * Classify by status *and* body.
 *
 * The `ratelimited` check is body-first and deliberately runs before the status
 * check's success branch, because the measured response is 200. A 429 is treated
 * the same way. A Cargo error other than the limit is an error, not a payload,
 * and so is a 200 carrying HTML or anything else that is not a Cargo envelope.
 */
export function classifyResponse(status: number, body: string): ResponseClass {
	if (status === 429) return { kind: "ratelimited", info: `HTTP ${status}` };
	if (status < 200 || status >= 300) return { kind: "error", reason: `HTTP ${status}: ${snippet(body)}` };

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { kind: "error", reason: `HTTP ${status} but the body is not JSON: ${snippet(body)}` };
	}

	if (Array.isArray(parsed)) return { kind: "payload", rows: parsed.length };
	if (parsed === null || typeof parsed !== "object") {
		return { kind: "error", reason: `HTTP ${status} but the body is not a Cargo envelope: ${snippet(body)}` };
	}

	const envelope = parsed as { error?: { code?: unknown; info?: unknown }; cargoquery?: unknown };
	if (envelope.error !== undefined && envelope.error !== null) {
		const code = String(envelope.error.code ?? "");
		const info = String(envelope.error.info ?? "");
		if (code.toLowerCase() === "ratelimited" || code.toLowerCase() === "rate-limited") {
			return { kind: "ratelimited", info: info || code };
		}
		return { kind: "error", reason: `API error ${code || "(no code)"}: ${info}` };
	}
	if (Array.isArray(envelope.cargoquery)) return { kind: "payload", rows: envelope.cargoquery.length };
	return { kind: "error", reason: `HTTP ${status} but unrecognised payload — expected an array or cargoquery` };
}

function describe(last: ResponseClass | undefined): string {
	if (last === undefined) return "no attempt was made";
	if (last.kind === "ratelimited") return `ratelimited: ${last.info}`;
	if (last.kind === "error") return last.reason;
	return `${last.rows} row(s)`;
}

/** Details of the run-ending failure, so the caller can name what to resume. */
export type FetchStop = {
	query: CargoQuery;
	root: string;
	url: string;
	key: string;
	attempts: number;
	last: ResponseClass | undefined;
	fetched: number;
	requests: number;
};

/**
 * The hard stop. It is an error rather than a quiet return because a crawl that
 * silently stops short looks complete, and ticket 07's manifest would pin a
 * partial cache without anyone noticing.
 */
export class FetchStoppedError extends Error {
	readonly stop: FetchStop;

	constructor(stop: FetchStop) {
		const paths = payloadPaths(stop.root, stop.query);
		super(
			`fetch stopped after ${stop.attempts} attempt(s) on ${stop.url}\n` +
				`  last answer: ${describe(stop.last)}\n` +
				`  query: ${canonicalQuery(stop.query)}\n` +
				`  cache key: ${stop.key}\n` +
				`  body would be: ${paths.body}\n` +
				`  ${stop.fetched} payload(s) from this run, ${stop.requests} request(s) total, are on disk.\n` +
				"  Re-run the same plan to resume: cached queries are not requested again.",
		);
		this.name = "FetchStoppedError";
		this.stop = stop;
	}
}

export type FetchOptions = {
	queries: CargoQuery[];
	root: string;
	intervalMs?: number;
	jitterMs?: number;
	backoffMs?: number;
	maxAttempts?: number;
	userAgent?: string;
	transport?: Transport;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
	log?: (line: string) => void;
};

export type FetchSummary = {
	fetched: CargoQuery[];
	skipped: CargoQuery[];
	/** Requests actually sent, including retries, so a test can assert "zero". */
	requests: number;
};

function assertNonNegative(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number, got ${value}`);
}

/**
 * Fetch a plan in order, one request at a time.
 *
 * A query whose payload is already complete is skipped before any clock work, so
 * a second run over a complete cache sends zero requests and sleeps zero times.
 * A rate-limit answer is backed off exponentially and retried; after
 * `maxAttempts` failed attempts on one query the whole run stops, because the
 * source is telling us to go away and continuing would make it worse.
 */
export async function fetchQueries(options: FetchOptions): Promise<FetchSummary> {
	const queries = options.queries;
	const root = options.root;
	const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
	const jitterMs = options.jitterMs ?? DEFAULT_JITTER_MS;
	const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
	const maxAttempts = options.maxAttempts ?? DEFAULT_ATTEMPTS;
	const userAgent = options.userAgent ?? USER_AGENT;
	const transport = options.transport ?? httpTransport;
	const now = options.now ?? (() => Date.now());
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const random = options.random ?? Math.random;
	const log = options.log ?? (() => {});

	assertNonNegative(intervalMs, "intervalMs");
	assertNonNegative(jitterMs, "jitterMs");
	assertNonNegative(backoffMs, "backoffMs");
	if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error(`maxAttempts must be an integer >= 1, got ${maxAttempts}`);

	const fetched: CargoQuery[] = [];
	const skipped: CargoQuery[] = [];
	let requests = 0;
	let lastRequestAt: number | undefined;

	/** Keep request *starts* at least interval + jitter apart, retries included. */
	async function waitForSlot(): Promise<void> {
		if (lastRequestAt !== undefined) {
			const target = lastRequestAt + intervalMs + Math.floor(random() * jitterMs);
			const wait = target - now();
			if (wait > 0) await sleep(wait);
		}
		lastRequestAt = now();
	}

	for (const query of queries) {
		const key = cacheKey(query);
		const url = queryUrl(query);
		const cached = await readPayload(root, query);
		if (cached !== undefined) {
			skipped.push(query);
			log(`cached ${key} (${cached.body.length} bytes) — no request`);
			continue;
		}

		let last: ResponseClass | undefined;
		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			if (attempt > 1) {
				const delay = backoffMs * 2 ** (attempt - 2);
				log(`backing off ${Math.round(delay / 1000)}s before attempt ${attempt}/${maxAttempts} for ${key}`);
				await sleep(delay);
			}
			await waitForSlot();
			requests += 1;

			let response: TransportResponse;
			try {
				response = await transport({ url, headers: { "User-Agent": userAgent, Accept: "application/json" } });
			} catch (error) {
				last = { kind: "error", reason: `transport failed: ${(error as Error).message}` };
				log(`attempt ${attempt}/${maxAttempts} for ${key} failed: ${describe(last)}`);
				continue;
			}

			last = classifyResponse(response.status, response.body);
			if (last.kind === "payload") {
				await writePayload(root, query, response.body, {
					url,
					fetchedAt: new Date(now()).toISOString(),
					status: response.status,
				});
				fetched.push(query);
				log(`fetched ${last.rows} row(s) -> ${payloadPaths(root, query).body}`);
				break;
			}
			log(`attempt ${attempt}/${maxAttempts} for ${key}: ${describe(last)}`);
		}

		if (last === undefined || last.kind !== "payload") {
			throw new FetchStoppedError({ query, root, url, key, attempts: maxAttempts, last, fetched: fetched.length, requests });
		}
	}

	return { fetched, skipped, requests };
}

/** Keys a plan may carry; an unknown key is a typo the source would ignore silently. */
const QUERY_KEYS = new Set(["endpoint", "tables", "fields", "where", "order_by", "limit", "offset"]);

function planQuery(value: unknown, where: string): CargoQuery {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where}: a query must be an object`);
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!QUERY_KEYS.has(key)) throw new Error(`${where}: unknown query field ${JSON.stringify(key)}`);
	}
	if (record.endpoint !== "cargoquery" && record.endpoint !== "cargoexport") {
		throw new Error(`${where}: endpoint must be "cargoquery" or "cargoexport"`);
	}
	for (const key of ["tables", "fields"] as const) {
		if (typeof record[key] !== "string" || record[key].trim() === "") throw new Error(`${where}: ${key} must be a non-empty string`);
	}
	for (const key of ["where", "order_by"] as const) {
		if (record[key] !== undefined && typeof record[key] !== "string") throw new Error(`${where}: ${key} must be a string`);
	}
	for (const key of ["limit", "offset"] as const) {
		if (record[key] === undefined) continue;
		if (typeof record[key] !== "number" || !Number.isInteger(record[key]) || (record[key] as number) < 0) {
			throw new Error(`${where}: ${key} must be a non-negative integer`);
		}
	}
	return record as CargoQuery;
}

/**
 * Parse an explicit plan: a JSON array of `CargoQuery`, or `{ "queries": [...] }`.
 *
 * This is the manual command's input until ticket 10 builds the crawl plan. It
 * is intentionally strict: a misspelled `orderBy` would otherwise be dropped by
 * `queryUrl` and the cache key would silently describe a different query.
 */
export function parsePlan(text: string, source: string): CargoQuery[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${source}: not JSON (${(error as Error).message})`);
	}
	const list = Array.isArray(parsed) ? parsed : (parsed as { queries?: unknown })?.queries;
	if (!Array.isArray(list) || list.length === 0) {
		throw new Error(`${source}: expected a non-empty array of queries, or an object with a non-empty "queries" array`);
	}
	return list.map((query, index) => planQuery(query, `${source}: query ${index}`));
}

/** Read and parse a plan file. */
export async function loadPlan(file: string): Promise<CargoQuery[]> {
	return parsePlan(await readFile(file, "utf8"), file);
}
