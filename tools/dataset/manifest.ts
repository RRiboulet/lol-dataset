// manifest: the build's account of its own inputs and outputs (spec D7, D8, R8, R9).
//
// One file, `data/curated/manifest.json`, written by the build and by nothing else. It
// answers two questions that the entity files cannot answer without lying about
// determinism:
//
//   1. *Which bytes was this dataset built from?* One entry per cached payload the
//      build actually read, in cache-relative path order, with the table and endpoint
//      that routed it, the query the sidecar records, the fetch time and HTTP status,
//      and the sha256 of the body. That is the one place a timestamp is allowed
//      (spec D8); the entity files carry data dates only, never a build time.
//
//   2. *Does this manifest describe these entity files?* One digest per emitted file
//      plus an aggregate digest over the set, so a reader holding a manifest can tell
//      whether the entity files beside it are the ones it was written for.
//
// The entity digest is defined precisely, because "a digest of the files" is ambiguous
// the moment the order changes:
//
//     entityDigest = sha256( for each entity file, in the build's OUTPUTS order:
//                              `${file}\t${sha256(body)}\t${records}\n` )
//
// The order is the `OUTPUTS` registry order in `build.ts` (events first, then the
// selection report, then games, matches, player-games, teams, players, champions,
// aliases, identity-unresolved), which is also the order the writer writes and the
// reader should read. `records` is the line count after stripping the trailing newline,
// so an empty file is 0 rather than 1.
//
// Hash verification lives here rather than in `cache.ts` because it is a provenance
// claim, not a cache concern: `readPayloads` hands the build every body it finds, and
// this module is what refuses a body that no longer matches the sidecar which claims to
// describe it. A payload with no sidecar stays legal — a scratch directory a test builds
// from bodies alone has no provenance to betray, and that case is documented and tested
// rather than special-cased away.
//
// What `--check` compares, and why it is not a byte comparison of this file: the
// manifest records `fetchedAt`, which changes when the same bytes are re-fetched, and a
// data rebuild must not fail because the cache was revalidated. So `--check` compares
// exactly the parts that describe the *data*: the format, the entity digests, and every
// payload field except `fetchedAt` (file, table, endpoint, bodySha256, status, query).
// An unknown extra entry, a missing entry, or one changed hash is drift; a new timestamp
// is not.

import { createHash } from "node:crypto";

import type { CargoEndpoint, CargoQuery, CachedPayload } from "./cache.ts";
import { canonicalQuery, sha256 } from "./cache.ts";

/** The committed manifest's name, beside the entity files it describes. */
export const MANIFEST_FILE = "manifest.json";

/** The manifest's own format marker, so a reader can refuse a version it does not know. */
export const MANIFEST_FORMAT = "lol-dataset-provenance/1";

/** One cached payload the build read. `fetchedAt` is the only timestamp in the dataset. */
export type ManifestPayload = {
	/** Path relative to the cache root, e.g. `lol-fandom/cargoexport/Tournaments/<key>.json`. */
	file: string;
	/** The Cargo table whose directory the payload sits in; this is how the build routed it. */
	table: string;
	endpoint: CargoEndpoint;
	/** sha256 of the body bytes on disk, verified against the sidecar when there is one. */
	bodySha256: string;
	/** The sidecar's recorded fetch time. Absent for a body-only payload. */
	fetchedAt?: string;
	/** The sidecar's recorded HTTP status. Absent for a body-only payload. */
	status?: number;
	/** The query the sidecar records: what produced these bytes. Absent for a body-only payload. */
	query?: CargoQuery;
};

/** One emitted entity file, digested. Field order here is the emitted field order. */
export type ManifestEntity = {
	file: string;
	/** Non-empty JSONL lines: the record count, so a reader can sanity-check a file. */
	records: number;
	sha256: string;
};

export type Manifest = {
	format: string;
	/** sha256 over the digests below, in `OUTPUTS` order; see the definition at the top. */
	entityDigest: string;
	entities: ManifestEntity[];
	payloads: ManifestPayload[];
};

/**
 * Which emitted files a source table feeds, for the tamper report.
 *
 * A byte change in one payload must be reported against something a person can open:
 * the payload file and the entity files whose records came from it. This is the table
 * the normalizers route by (`normalize.ts`), so an unknown table here is a bug in this
 * map rather than a payload the build silently ignored — `normalizeSources` reads every
 * payload and rejects a table it does not know.
 */
export const TABLE_CONSUMERS: Readonly<Record<string, readonly string[]>> = {
	Tournaments: ["events.jsonl", "event-selection.jsonl", "event-games.jsonl"],
	Teams: ["teams.jsonl", "aliases.jsonl"],
	TeamRedirects: ["teams.jsonl", "aliases.jsonl"],
	PlayerRedirects: ["players.jsonl", "aliases.jsonl"],
	Champions: ["champions.jsonl", "games.jsonl", "player-games.jsonl"],
	ScoreboardGames: ["games.jsonl", "event-games.jsonl"],
	MatchSchedule: ["matches.jsonl", "games.jsonl", "event-games.jsonl"],
	PicksAndBansS7: ["games.jsonl"],
	ScoreboardPlayers: ["player-games.jsonl", "players.jsonl", "teams.jsonl", "champions.jsonl", "aliases.jsonl", "identity-unresolved.jsonl"],
};

/** `[]` and a single-row body count as one record each; an empty body counts as none. */
function recordCount(body: string): number {
	if (body === "") return 0;
	const trimmed = body.endsWith("\n") ? body.slice(0, -1) : body;
	// An all-whitespace file is not valid JSONL either, but the writer never produces one;
	// counting its blank lines as records would be worse than counting them as none.
	return trimmed === "" ? 0 : trimmed.split("\n").length;
}

/** The digest definition from the file header, in one place so tests can recompute it. */
export function entityDigestOf(entities: readonly ManifestEntity[]): string {
	return createHash("sha256")
		.update(entities.map((entity) => `${entity.file}\t${entity.sha256}\t${entity.records}\n`).join(""))
		.digest("hex");
}

/**
 * The entity file digests, in the order given.
 *
 * The caller passes the `OUTPUTS` registry order: this module must not import
 * `build.ts`, or the manifest would depend on the pipeline that depends on the
 * manifest.
 */
export function digestEntities(files: readonly { file: string; body: string }[]): ManifestEntity[] {
	return files.map((file) => ({ file: file.file, records: recordCount(file.body), sha256: sha256(file.body) }));
}

/** One manifest payload entry from a payload the build read, body hash computed from the bytes. */
function manifestPayload(payload: CachedPayload): ManifestPayload {
	const bodySha256 = sha256(payload.body);
	const meta = payload.meta;
	const entry: ManifestPayload = { file: payload.file, table: payload.table, endpoint: payload.endpoint, bodySha256 };
	if (meta !== undefined) {
		entry.fetchedAt = meta.fetchedAt;
		entry.status = meta.status;
		if (payload.query !== undefined) entry.query = payload.query;
	}
	return entry;
}

/** The manifest for a build: every payload read, and the entity files it produced. */
export function buildManifest(payloads: readonly CachedPayload[], files: readonly { file: string; body: string }[]): Manifest {
	const entities = digestEntities(files);
	const ordered = [...payloads].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
	return {
		format: MANIFEST_FORMAT,
		entityDigest: entityDigestOf(entities),
		entities,
		payloads: ordered.map(manifestPayload),
	};
}

/** Fixed bytes: two-space JSON, LF, one trailing newline, no BOM. */
export function renderManifest(manifest: Manifest): string {
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * The identifiers the payload's rows carry, for a tamper report that names records.
 *
 * Best effort on purpose: a one-byte change can break the JSON, and a report that says
 * only "which file" is still useful, so parsing failure is not itself an error here.
 * Capped so a large payload does not turn one error into a screenful.
 */
function affectedRows(body: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return "";
	}
	const rows = Array.isArray(parsed)
		? parsed
		: parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { cargoquery?: unknown }).cargoquery)
			? ((parsed as { cargoquery: { title?: Record<string, unknown> }[] }).cargoquery.map((row) => row.title) ?? [])
			: [];
	const ids = new Set<string>();
	for (const row of rows) {
		if (row === null || typeof row !== "object") continue;
		for (const field of ["OverviewPage", "GameId", "MatchId"]) {
			const value = (row as Record<string, unknown>)[field];
			if (typeof value === "string" && value !== "") ids.add(value);
		}
	}
	const named = [...ids].sort().slice(0, 5);
	if (named.length === 0) return "";
	const more = ids.size > named.length ? ` and ${ids.size - named.length} more` : "";
	return ` Its rows name ${named.join(", ")}${more}.`;
}

/**
 * Refuse a payload whose bytes no longer match the sidecar that claims to describe them.
 *
 * This is the gate spec R9 needs: the manifest pins hashes, so the build must not read a
 * body that its own sidecar contradicts — otherwise the committed manifest would claim
 * bytes nobody verified. A payload with no sidecar is skipped, because a scratch
 * directory built from bodies alone has nothing to contradict; that is documented and
 * covered by the suite rather than being an accident of this loop.
 */
export function assertPayloadHashes(payloads: readonly CachedPayload[]): void {
	for (const payload of payloads) {
		const meta = payload.meta;
		if (meta === undefined) continue;
		const actual = sha256(payload.body);
		if (actual === meta.bodySha256) continue;
		const consumers = TABLE_CONSUMERS[payload.table] ?? ["no emitted file (unknown table)"];
		throw new Error(
			`${payload.file}: the bytes on disk no longer match the sidecar's bodySha256 ` +
				`(recorded ${meta.bodySha256}, actual ${actual}). Table ${payload.table} feeds ${consumers.join(", ")}.${affectedRows(payload.body)} ` +
				"A cached payload is evidence: restore the recorded bytes or re-record the payload — never edit it in place.",
		);
	}
}

// ---------------------------------------------------------------------------
// `--check`: compare the committed manifest with the one this build just made.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A canonical rendering of a query, so field order inside the sidecar is not data. */
function queryText(query: CargoQuery): string {
	return canonicalQuery(query);
}

function describe(value: unknown): string {
	return JSON.stringify(value);
}

/** Structural check: a committed manifest that is not one cannot be compared field by field. */
function readManifest(value: unknown): Manifest | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.format !== "string" || typeof value.entityDigest !== "string") return undefined;
	if (!Array.isArray(value.entities) || !Array.isArray(value.payloads)) return undefined;
	const entities: ManifestEntity[] = [];
	for (const entry of value.entities) {
		if (!isRecord(entry)) return undefined;
		if (typeof entry.file !== "string" || typeof entry.sha256 !== "string" || typeof entry.records !== "number") return undefined;
		entities.push({ file: entry.file, records: entry.records, sha256: entry.sha256 });
	}
	const payloads: ManifestPayload[] = [];
	for (const entry of value.payloads) {
		if (!isRecord(entry)) return undefined;
		if (typeof entry.file !== "string" || typeof entry.table !== "string") return undefined;
		if (entry.endpoint !== "cargoquery" && entry.endpoint !== "cargoexport") return undefined;
		if (typeof entry.bodySha256 !== "string") return undefined;
		if (entry.fetchedAt !== undefined && typeof entry.fetchedAt !== "string") return undefined;
		if (entry.status !== undefined && typeof entry.status !== "number") return undefined;
		payloads.push({
			file: entry.file,
			table: entry.table,
			endpoint: entry.endpoint as CargoEndpoint,
			bodySha256: entry.bodySha256,
			...(entry.fetchedAt === undefined ? {} : { fetchedAt: entry.fetchedAt }),
			...(entry.status === undefined ? {} : { status: entry.status }),
			...(isRecord(entry.query) ? { query: entry.query as unknown as CargoQuery } : {}),
		});
	}
	// A record that only *nearly* matches is refused rather than half-read: `--check` is
	// worthless if it compares a manifest it only partly understood.
	return { format: value.format, entityDigest: value.entityDigest, entities, payloads };
}

/**
 * Drift between the committed manifest and a rebuild, ignoring `fetchedAt`.
 *
 * One line per difference, each naming the file so `--check` output is actionable. A
 * body-only payload legitimately drops `fetchedAt`, `status` and `query`; a sidecar
 * appearing or disappearing is drift, because the manifest would no longer describe the
 * same provenance.
 */
export function compareManifest(committedValue: unknown, built: Manifest): string[] {
	const committed = readManifest(committedValue);
	if (committed === undefined) {
		return [`${MANIFEST_FILE}: not a provenance manifest this build understands (run the build without --check)`];
	}
	const drift: string[] = [];
	if (committed.format !== built.format) {
		drift.push(`${MANIFEST_FILE}: format is ${describe(committed.format)}, expected ${describe(built.format)}`);
	}

	// Entity digests: the manifest has to describe the files beside it.
	const committedEntities = new Map(committed.entities.map((entity) => [entity.file, entity]));
	const builtEntities = new Map(built.entities.map((entity) => [entity.file, entity]));
	for (const [file, entity] of builtEntities) {
		const there = committedEntities.get(file);
		if (there === undefined) {
			drift.push(`${MANIFEST_FILE}: does not list ${file}, which the build emits`);
			continue;
		}
		if (there.sha256 !== entity.sha256) {
			drift.push(`${MANIFEST_FILE}: ${file} is ${entity.sha256}, committed as ${there.sha256}`);
		}
		if (there.records !== entity.records) {
			drift.push(`${MANIFEST_FILE}: ${file} has ${entity.records} record(s), committed as ${there.records}`);
		}
	}
	for (const file of committedEntities.keys()) {
		if (!builtEntities.has(file)) drift.push(`${MANIFEST_FILE}: lists ${file}, which the build does not emit`);
	}
	if (committed.entityDigest !== built.entityDigest) {
		drift.push(`${MANIFEST_FILE}: entityDigest is ${built.entityDigest}, committed as ${committed.entityDigest}`);
	}

	// Payload pins: same payloads, same bytes, same provenance — timestamps aside.
	const committedPayloads = new Map(committed.payloads.map((payload) => [payload.file, payload]));
	const builtPayloads = new Map(built.payloads.map((payload) => [payload.file, payload]));
	for (const [file, payload] of builtPayloads) {
		const there = committedPayloads.get(file);
		if (there === undefined) {
			drift.push(`${MANIFEST_FILE}: does not list ${file} (table ${payload.table}), which this build read`);
			continue;
		}
		const differences: string[] = [];
		if (there.table !== payload.table) differences.push(`table is ${payload.table}, committed as ${there.table}`);
		if (there.endpoint !== payload.endpoint) differences.push(`endpoint is ${payload.endpoint}, committed as ${there.endpoint}`);
		if (there.bodySha256 !== payload.bodySha256) {
			differences.push(`bodySha256 is ${payload.bodySha256}, committed as ${there.bodySha256}`);
		}
		if (there.status !== payload.status) differences.push(`status is ${describe(payload.status)}, committed as ${describe(there.status)}`);
		const leftQuery = there.query === undefined ? undefined : queryText(there.query);
		const rightQuery = payload.query === undefined ? undefined : queryText(payload.query);
		if (leftQuery !== rightQuery) differences.push(`query is ${rightQuery ?? "absent"}, committed as ${leftQuery ?? "absent"}`);
		if (differences.length > 0) drift.push(`${MANIFEST_FILE}: ${file}: ${differences.join("; ")}`);
	}
	for (const file of committedPayloads.keys()) {
		if (!builtPayloads.has(file)) drift.push(`${MANIFEST_FILE}: lists ${file}, which this build did not read`);
	}
	return drift;
}
