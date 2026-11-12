// The raw payload cache: where source bytes live, and how a request names them.
//
// Spec D5 puts the purity boundary here: everything *below* the cache is a pure
// function of files on disk, and everything above it (fetch) is the only code
// allowed to touch the network or the clock. Cache layout is therefore part of
// the pipeline's interface, not an implementation detail — ticket 08's real
// fetch layer and ticket 09's crawl both build on the keys fixed here.
//
// Keying rule (spec D9): the key is derived from the *query*, never from a
// position in a loop. A crawl that stops after request 412 must resume by
// re-deriving the same key for request 412, not by counting rows already on
// disk. Two runs over the same query therefore land on the same file, which is
// what makes a re-run a no-op.
//
// The wiki serves the same Cargo table rows through two endpoints, and both are
// recorded here verbatim because both are reachable in practice:
//
//   cargoquery   `api.php?action=cargoquery`   -> {"cargoquery":[{"title":{...}}]}
//   cargoexport  `wiki/Special:CargoExport`    -> [{...}, ...]
//
// Measured 2026-11-12: `action=cargoquery` refuses with `ratelimited` for long
// stretches on a shared address while `Special:CargoExport` keeps answering, and
// `action=query` keeps working throughout — so the limit is on the Cargo API
// action, not on the wiki. Recording fixtures through the export endpoint is the
// difference between fixtures taken from the live source and fixtures invented,
// and `normalize.ts` accepts either envelope. Which endpoint a crawl prefers is
// ticket 08's decision.
//
// One payload is two files in `raw/<source>/<endpoint>/`:
//   <key>.json       the response body exactly as received
//   <key>.meta.json  URL, fetch time, HTTP status and body hash (spec D7)
//
// The sidecar is provenance, not input: the build reads bodies, so a fixture and a
// live payload are byte-compatible and the build cannot depend on when a payload
// was fetched (spec R8 — no wall-clock in the data).

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";

/** Which wiki endpoint a recorded payload came from. */
export type CargoEndpoint = "cargoquery" | "cargoexport";

/** A Cargo query, as recorded. Field names are Cargo's, not ours. */
export type CargoQuery = {
	endpoint: CargoEndpoint;
	tables: string;
	fields: string;
	where?: string;
	order_by?: string;
	limit?: number;
	offset?: number;
};

/** What a cached payload's sidecar says about where the body came from. */
export type PayloadMeta = {
	source: string;
	endpoint: CargoEndpoint;
	query: CargoQuery;
	url: string;
	fetchedAt: string;
	status: number;
	bodySha256: string;
};

export const SOURCE = "lol-fandom";

const API_URL = "https://lol.fandom.com/api.php";
const EXPORT_URL = "https://lol.fandom.com/wiki/Special:CargoExport";

/** The query with its parameters in a fixed order, so equal queries hash equal. */
export function canonicalQuery(query: CargoQuery): string {
	const ordered: Record<string, string> = {
		endpoint: query.endpoint,
		tables: query.tables,
		fields: query.fields,
	};
	if (query.where !== undefined) ordered.where = query.where;
	if (query.order_by !== undefined) ordered.order_by = query.order_by;
	if (query.limit !== undefined) ordered.limit = String(query.limit);
	if (query.offset !== undefined) ordered.offset = String(query.offset);
	return JSON.stringify(ordered);
}

/** Cache key for a query: a hash of the canonical query, never of its position. */
export function cacheKey(query: CargoQuery): string {
	return createHash("sha256").update(canonicalQuery(query)).digest("hex").slice(0, 24);
}

/** The URL that reproduces the payload for a query. */
export function queryUrl(query: CargoQuery): string {
	const params = new URLSearchParams({ format: "json" });
	const fields: Record<string, string | number | undefined> = {
		tables: query.tables,
		fields: query.fields,
		where: query.where,
		order_by: query.order_by,
		limit: query.limit,
		offset: query.offset,
	};
	for (const [key, value] of Object.entries(fields)) {
		if (value !== undefined) params.set(key, String(value));
	}
	if (query.endpoint === "cargoquery") {
		params.set("action", "cargoquery");
		return `${API_URL}?${params.toString()}`;
	}
	return `${EXPORT_URL}?${params.toString()}`;
}

/** Directory holding one endpoint's cached payloads. */
export function payloadDir(root: string, endpoint: CargoEndpoint): string {
	return path.join(root, SOURCE, endpoint);
}

/** Body and sidecar paths for a query under `root`. */
export function payloadPaths(root: string, query: CargoQuery): { body: string; meta: string } {
	const base = path.join(payloadDir(root, query.endpoint), cacheKey(query));
	return { body: `${base}.json`, meta: `${base}.meta.json` };
}

export function sha256(body: string): string {
	return createHash("sha256").update(body).digest("hex");
}

/**
 * Write through a temporary name, then rename: a reader sees the old file or the
 * new one, never a half-written one. `rename` is atomic within a filesystem.
 */
async function writeAtomic(file: string, body: string): Promise<void> {
	const temporary = `${file}.tmp-${randomUUID()}`;
	await writeFile(temporary, body, "utf8");
	await rename(temporary, file);
}

/**
 * Write a recorded body and its provenance sidecar, body first and sidecar last.
 *
 * The order matters to the fetcher: a run killed between the two leaves a body
 * with no sidecar, and `readPayload` reports that as incomplete rather than as a
 * cached payload. Rewriting it is cheap; treating it as complete would leave a
 * payload whose provenance is a lie (spec D7, ticket 07's manifest).
 */
export async function writePayload(
	root: string,
	query: CargoQuery,
	body: string,
	meta: { url: string; fetchedAt: string; status: number },
): Promise<{ body: string; meta: string }> {
	const paths = payloadPaths(root, query);
	const record: PayloadMeta = {
		source: SOURCE,
		endpoint: query.endpoint,
		query,
		url: meta.url,
		fetchedAt: meta.fetchedAt,
		status: meta.status,
		bodySha256: sha256(body),
	};
	await mkdir(path.dirname(paths.body), { recursive: true });
	await writeAtomic(paths.body, body);
	await writeAtomic(paths.meta, `${JSON.stringify(record, null, 2)}\n`);
	return paths;
}

/** A cached payload that is complete enough for the fetcher to skip re-requesting it. */
export type CachedPair = { body: string; meta: PayloadMeta };

async function readIfExists(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * A body and sidecar that agree, or `undefined` when either is missing or the
 * recorded hash does not match the recorded bytes.
 *
 * The fetcher uses this as its cache check, so "incomplete" must include the old
 * body left by an interrupted write, not only a missing file. `readPayloads`
 * stays deliberately looser: the build reads committed fixtures, some of which
 * legitimately have no sidecar in a test's scratch directory.
 */
export async function readPayload(root: string, query: CargoQuery): Promise<CachedPair | undefined> {
	const paths = payloadPaths(root, query);
	const body = await readIfExists(paths.body);
	if (body === undefined) return undefined;
	const text = await readIfExists(paths.meta);
	if (text === undefined) return undefined;
	let meta: PayloadMeta;
	try {
		meta = JSON.parse(text) as PayloadMeta;
	} catch {
		return undefined;
	}
	if (meta === null || typeof meta !== "object" || meta.bodySha256 !== sha256(body)) return undefined;
	return { body, meta };
}

/** A recorded payload as the build sees it: the body is the input, never the sidecar. */
export type CachedPayload = {
	/** Path relative to the cache root, for error messages that name a file. */
	file: string;
	body: string;
};

/**
 * Every payload body under `root`, in a stable order.
 *
 * Sorted by file name so a build is reproducible even before assembly sorts its
 * records, and recursive so nested windows (ticket 09 may bucket by year) stay
 * readable. `.meta.json` sidecars are skipped: they carry a fetch time and must
 * never reach the output.
 */
export async function readPayloads(root: string): Promise<CachedPayload[]> {
	const found: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.name.endsWith(".json") && !entry.name.endsWith(".meta.json")) found.push(full);
		}
	}
	await walk(root);
	const payloads: CachedPayload[] = [];
	for (const file of found) {
		payloads.push({ file: path.relative(root, file), body: await readFile(file, "utf8") });
	}
	return payloads;
}
