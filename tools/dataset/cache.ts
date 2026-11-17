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
// One payload is two files in `raw/<source>/<endpoint>/<table>/`:
//   <key>.json       the response body exactly as received
//   <key>.meta.json  URL, fetch time, HTTP status and body hash (spec D7)
//
// The table is a directory, not a field, because a Cargo body does not say which
// table it came from: `Special:CargoExport` returns bare rows, and a row's keys
// only *hint* at its table. Reading the table from the path is the only routing
// input that survives the byte-identity rule below (ticket 02 measures it: a
// ScoreboardPlayers row and a Tournaments row both carry `OverviewPage`, so shape
// sniffing would quietly feed one stage's rows to another's).
//
// The sidecar is provenance, and the build's *data* output never depends on it: the
// normalizers read bodies, so a fixture and a live payload are byte-compatible and the
// emitted rows cannot depend on when a payload was fetched (spec R8 — no wall-clock in
// the data). Two things do read it: the game report needs the recorded query text to
// tell "the source answered zero games" from "nobody asked", and the build verifies the
// body hash and copies the fetch time into `data/curated/manifest.json` (ticket 07,
// `manifest.ts`). The sidecar is therefore optional — a scratch directory built from
// bodies alone is legal — but a sidecar that exists is read strictly, because provenance
// that cannot be read is worse than provenance that is absent.
//
// Two "a body with no sidecar" situations read the same through `readPayloads`, and must
// not be confused when deciding what may be pinned:
//
//   body-only by design    a scratch directory a test builds from bodies alone, or a
//                          fixture recorded before the sidecar format existed. Legal:
//                          the build pins it with no `fetchedAt`, `status` or `query`,
//                          and nothing downstream can be wrong about provenance that
//                          is absent.
//   body-only by accident  an interrupted `writePayload`, which writes the body first
//                          and the sidecar last. The bytes are real, but nobody verified
//                          them. The fetcher already treats this as incomplete —
//                          `readPayload` returns `undefined`, so the query is requested
//                          again and the body is overwritten with a complete pair. The
//                          build cannot tell the two cases apart, so whether a committed
//                          manifest may carry a body-only pin (or should warn about one)
//                          is the manifest owner's call (`manifest.ts` / `build.ts`),
//                          not this module's.

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

/** The query fields the cache understands; anything else is a typo or a format drift. */
const QUERY_FIELDS = new Set(["endpoint", "tables", "fields", "where", "order_by", "limit", "offset"]);

const REMEDY = "re-run record.ts or fetch.ts for this query, or restore the payload from the recording";

/**
 * Refuse a query carrying fields the cache does not know, instead of dropping them.
 *
 * `canonicalQuery` builds the cache key and the manifest's query identity from the known
 * fields only, so a query with an extra field would hash exactly like the query without
 * it: two caches differing only in that field would pin identical manifests, and the pin
 * would claim a query identity it never compared. `fetch.ts`'s plan parser applies the
 * same rule to plans; this applies it wherever a query arrives without one.
 */
function assertKnownQueryFields(query: CargoQuery, where: string): void {
	for (const key of Object.keys(query)) {
		if (!QUERY_FIELDS.has(key)) {
			throw new Error(`${where}: unknown query field ${JSON.stringify(key)} — refused rather than dropped, so the cache key and the manifest's query identity cannot silently ignore it — ${REMEDY}`);
		}
	}
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

/**
 * The table a query reads, as a single path segment.
 *
 * A Cargo query can name several tables (`ScoreboardPlayers=SP,ScoreboardGames=SG`),
 * and the cache cannot name a directory after that list. Joins are rejected here
 * rather than written somewhere surprising: the dataset fetches one table per
 * query, which is also what makes a payload's table unambiguous.
 */
export function tableOf(query: CargoQuery): string {
	if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(query.tables)) {
		throw new Error(`tables ${JSON.stringify(query.tables)}: the cache names one table per directory, so a joined query is not recordable`);
	}
	return query.tables;
}

/** Directory holding one table's cached payloads. */
export function payloadDir(root: string, endpoint: CargoEndpoint, table: string): string {
	return path.join(root, SOURCE, endpoint, table);
}

/** Body and sidecar paths for a query under `root`. */
export function payloadPaths(root: string, query: CargoQuery): { body: string; meta: string } {
	const base = path.join(payloadDir(root, query.endpoint, tableOf(query)), cacheKey(query));
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
	// What is written must be readable: a sidecar whose query carries a field the strict
	// reader rejects would leave a cache the build refuses to pin, so refuse it here,
	// before the body is written on top of a half-secret query.
	assertKnownQueryFields(query, paths.meta);
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

/**
 * A recorded payload as the build sees it: the body is the input. The sidecar is
 * optional and read for reporting only — the game report's `wasAsked` needs the recorded
 * query text, and nothing else here does — so a fixture with no sidecar still builds.
 */
export type CachedPayload = {
	/** Path relative to the cache root, for error messages that name a file. */
	file: string;
	/** The Cargo table the query read, from the directory. This is how the build routes it. */
	table: string;
	/** The endpoint whose directory the payload sits in, carried into the manifest (spec D7). */
	endpoint: CargoEndpoint;
	body: string;
	/**
	 * The query the sidecar records, when there is one. Never emitted and never hashed
	 * into the output, which is why it can travel here: the game report has to tell "this
	 * event came back empty" from "nobody asked for this event", and only the query says.
	 */
	query?: CargoQuery;
	/**
	 * The sidecar exactly as recorded, when there is one: the build verifies `bodySha256`
	 * against the bytes it just read (`manifest.ts`) and the manifest carries `fetchedAt`
	 * and `status`. A sidecar that exists but cannot be read is a broken cache and fails
	 * the build — "no sidecar" and "a sidecar that lies" must not look alike.
	 */
	meta?: PayloadMeta;
};

/**
 * Every payload body under `root`, in a stable order.
 *
 * Sorted by file name so a build is reproducible even before assembly sorts its
 * records. The walk is recursive only because it descends from the root: the layout is
 * flat — `<source>/<endpoint>/<table>/<key>.json` — and the shape check below rejects
 * anything deeper. A year-bucketed layout (the crawl never needed one) would bury the
 * table segment the build routes by, so bucketing would have to live inside a table's
 * directory and re-negotiate that check, not be silently readable here.
 * `.meta.json` sidecars are skipped: they carry a fetch time and must never reach the
 * output.
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
		const relative = path.relative(root, file);
		const parts = relative.split(path.sep);
		// <source>/<endpoint>/<table>/<key>.json: a payload outside that shape has no
		// table, and guessing one would route it to the wrong normalizer.
		if (parts.length !== 4 || (parts[1] !== "cargoexport" && parts[1] !== "cargoquery")) {
			throw new Error(`${relative}: expected <source>/<endpoint>/<table>/<key>.json`);
		}
		payloads.push({
			file: relative,
			table: parts[2],
			endpoint: parts[1] as CargoEndpoint,
			body: await readFile(file, "utf8"),
			...(await sidecarOf(file, relative)),
		});
	}
	return payloads;
}

/**
 * The sidecar an optional payload carries: its provenance and the query it records.
 *
 * A sidecar is written by `record.ts`/`fetch.ts` and is not required: a scratch
 * directory a test builds from bodies alone is legal, which is why this is optional
 * rather than a second thing that has to exist before the build runs. Optional is not
 * the same as ignorable, though: a sidecar that *is* there is read strictly and
 * completely — every field spec D7 names (source, URL, fetch time, HTTP status, body
 * hash) plus the query that produced the body must be present and well-formed, because
 * a cache whose provenance cannot be read is a broken cache, and silently treating it
 * as "no sidecar" would hide exactly the thing the manifest exists to prove.
 */
async function sidecarOf(bodyFile: string, relative: string): Promise<{ meta?: PayloadMeta; query?: CargoQuery }> {
	const metaFile = bodyFile.replace(/\.json$/, ".meta.json");
	const text = await readIfExists(metaFile);
	if (text === undefined) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${relative}.meta.json: sidecar is not JSON (${(error as Error).message})`);
	}
	const meta = (parsed ?? {}) as Partial<PayloadMeta>;
	if (typeof meta.bodySha256 !== "string" || meta.bodySha256 === "") {
		throw new Error(`${relative}.meta.json: sidecar states no bodySha256, so its bytes cannot be verified — ${REMEDY}`);
	}
	// D7 names the URL; the manifest carries it only through the sidecar.
	if (typeof meta.url !== "string" || meta.url === "") {
		throw new Error(`${relative}.meta.json: sidecar states no url — D7 records URL, fetch time, HTTP status and body hash — ${REMEDY}`);
	}
	if (typeof meta.source !== "string" || meta.source === "") {
		throw new Error(`${relative}.meta.json: sidecar states no source — D7 records URL, fetch time, HTTP status and body hash — ${REMEDY}`);
	}
	if (typeof meta.fetchedAt !== "string" || meta.fetchedAt === "") {
		throw new Error(`${relative}.meta.json: sidecar states no fetchedAt — ${REMEDY}`);
	}
	// The manifest pins `fetchedAt` verbatim, so garbage here becomes the dataset's only
	// timestamp. The shape is what `record.ts`/`fetch.ts` write (`new Date().toISOString()`);
	// anything else — even a string `Date.parse` would accept — is refused, not normalised.
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(meta.fetchedAt) || !Number.isFinite(Date.parse(meta.fetchedAt))) {
		throw new Error(`${relative}.meta.json: fetchedAt ${JSON.stringify(meta.fetchedAt)} is not a parseable ISO-8601 instant, and the manifest would pin it verbatim — ${REMEDY}`);
	}
	if (typeof meta.status !== "number" || !Number.isInteger(meta.status)) {
		throw new Error(`${relative}.meta.json: sidecar states no HTTP status — ${REMEDY}`);
	}
	const query = meta.query as CargoQuery | undefined;
	if (query === null || typeof query !== "object") {
		throw new Error(`${relative}.meta.json: sidecar states no query — ${REMEDY}`);
	}
	assertKnownQueryFields(query, `${relative}.meta.json`);
	if (typeof query.tables !== "string" || typeof query.fields !== "string") {
		throw new Error(`${relative}.meta.json: sidecar's query names no tables and fields — ${REMEDY}`);
	}
	// `where` is read as text by the game report, so a sidecar holding a non-string there
	// is an error rather than something handed on to fail later as `where.includes is not a
	// function`.
	if (query.where !== undefined && typeof query.where !== "string") {
		throw new Error(`${relative}.meta.json: sidecar's query has a non-string where — ${REMEDY}`);
	}
	return { meta: meta as PayloadMeta, query };
}
