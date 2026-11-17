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
// data rebuild must not fail because the cache was revalidated. So `--check` first reads
// the committed manifest through its checked-in schema (`manifest.schema.json`), then
// compares exactly the parts that describe the *data*: the format, the entity digests,
// and every payload field except `fetchedAt` (file, table, endpoint, bodySha256, status,
// query). The committed `entityDigest` is recomputed from its own `entities` list and the
// list is checked against the build's OUTPUTS order, so a scrambled, duplicated,
// missing or extra entry fails rather than being compared as an opaque string. An
// unknown field, a non-hex hash, a `query` that is not an object or a `fetchedAt` that
// is not an ISO-8601 instant is refused: the schema is the shape contract (spec D2),
// not documentation. A new timestamp is not drift.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import type { CargoEndpoint, CargoQuery, CachedPayload } from "./cache.ts";
import { canonicalQuery, sha256 } from "./cache.ts";
import { KNOWN_TABLES } from "./normalize.ts";
import { assertValid, validateAgainst } from "./validate.ts";
import type { ValidationError } from "./validate.ts";

/** The committed manifest's name, beside the entity files it describes. */
export const MANIFEST_FILE = "manifest.json";

/** The checked-in schema that is the manifest's shape contract (spec D2). */
export const MANIFEST_SCHEMA_FILE = "manifest.schema.json";

/** The manifest's own format marker, so a reader can refuse a version it does not know. */
export const MANIFEST_FORMAT = "lol-dataset-provenance/1";

const MANIFEST_SCHEMA_DIR = path.join(import.meta.dirname, "..", "..", "data", "curated", "schema");

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

/**
 * The consumer map and the normalizer registry must route exactly the same tables.
 *
 * They answer different questions — `normalize.ts` decides what a payload becomes,
 * `TABLE_CONSUMERS` says which files a tampered payload feeds — so neither can be
 * derived from the other, but a table in one and not the other is always a bug: a
 * payload would either be normalized into files the tamper report does not name, or
 * be named by the report while having no normalizer. Checked at module load so the
 * build fails immediately rather than at the first tampered payload.
 */
export function assertTableConsumersMatchNormalizers(
	consumers: Readonly<Record<string, readonly string[]>> = TABLE_CONSUMERS,
	tables: readonly string[] = KNOWN_TABLES,
): void {
	const consumerTables = new Set(Object.keys(consumers));
	const normalizerTables = new Set(tables);
	const withoutNormalizer = [...consumerTables].filter((table) => !normalizerTables.has(table)).sort();
	const withoutConsumers = [...normalizerTables].filter((table) => !consumerTables.has(table)).sort();
	if (withoutNormalizer.length === 0 && withoutConsumers.length === 0) return;
	const problems: string[] = [];
	if (withoutNormalizer.length > 0) {
		problems.push(`TABLE_CONSUMERS names ${withoutNormalizer.join(", ")}, which normalize.ts has no normalizer for`);
	}
	if (withoutConsumers.length > 0) {
		problems.push(`normalize.ts normalizes ${withoutConsumers.join(", ")}, which TABLE_CONSUMERS does not name`);
	}
	throw new Error(
		`${problems.join("; ")} — update both TABLE_CONSUMERS in manifest.ts and NORMALIZERS in normalize.ts; ` +
			"they must route exactly the same source tables.",
	);
}

assertTableConsumersMatchNormalizers();

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

type Schema = Record<string, unknown>;
const schemaCache = new Map<string, Schema>();

/** The checked-in manifest schema, read once per directory. */
export function loadManifestSchema(schemaDir: string = MANIFEST_SCHEMA_DIR): Schema {
	const file = path.join(schemaDir, MANIFEST_SCHEMA_FILE);
	const cached = schemaCache.get(file);
	if (cached !== undefined) return cached;
	const schema = JSON.parse(readFileSync(file, "utf8")) as Schema;
	schemaCache.set(file, schema);
	return schema;
}

/** Every violation of the checked-in manifest schema by `value`. */
export function validateManifest(value: unknown, schemaDir?: string): ValidationError[] {
	return validateAgainst(loadManifestSchema(schemaDir), value, MANIFEST_SCHEMA_FILE);
}

/** Refuse a manifest whose shape is not the checked-in contract. */
export function assertManifestValid(manifest: Manifest, schemaDir?: string): void {
	assertValid(loadManifestSchema(schemaDir), manifest, MANIFEST_FILE, MANIFEST_SCHEMA_FILE);
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
	const manifest: Manifest = {
		format: MANIFEST_FORMAT,
		entityDigest: entityDigestOf(entities),
		entities,
		payloads: ordered.map(manifestPayload),
	};
	// The build writes only a manifest that satisfies the committed contract (spec D2).
	assertManifestValid(manifest);
	return manifest;
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

/** A canonical rendering of a query, so field order inside the sidecar is not data. */
function queryText(query: CargoQuery): string {
	return canonicalQuery(query);
}

function describe(value: unknown): string {
	return JSON.stringify(value);
}

type ManifestRead = { manifest: Manifest; errors: [] } | { manifest?: undefined; errors: string[] };

/**
 * Read a committed manifest through the checked-in schema, then refuse duplicates.
 *
 * The schema is the shape contract (spec D2), so an unknown field, a hash that is not
 * 64 lowercase hex characters, a `format` that is not this manifest's, a `query` that
 * is not an object or a `fetchedAt` that is not an ISO-8601 instant is refused here
 * rather than coerced or ignored. `--check` is worthless if it compares a manifest it
 * only partly understood. Duplicates are a cross-entry rule the schema cannot state by
 * file name, so they are checked after validation, before the maps would silently make
 * the last copy win.
 */
function readManifest(value: unknown, schemaDir?: string): ManifestRead {
	const schemaErrors = validateManifest(value, schemaDir);
	if (schemaErrors.length > 0) {
		return {
			errors: schemaErrors.map((error) => `${MANIFEST_FILE}${error.path === "" ? "" : `.${error.path}`}: ${error.message}`),
		};
	}
	const record = value as Json;
	const errors: string[] = [];

	const entities: ManifestEntity[] = [];
	const entityFiles = new Set<string>();
	for (const entry of record.entities as Json[]) {
		const file = entry.file as string;
		if (entityFiles.has(file)) {
			errors.push(`${MANIFEST_FILE}: lists ${file} more than once among entities, but each emitted file appears exactly once`);
		}
		entityFiles.add(file);
		entities.push({ file, records: entry.records as number, sha256: entry.sha256 as string });
	}

	const payloads: ManifestPayload[] = [];
	const payloadFiles = new Set<string>();
	for (const entry of record.payloads as Json[]) {
		const file = entry.file as string;
		if (payloadFiles.has(file)) {
			errors.push(`${MANIFEST_FILE}: lists ${file} more than once among payloads, but each cached payload appears exactly once`);
		}
		payloadFiles.add(file);
		payloads.push({
			file,
			table: entry.table as string,
			endpoint: entry.endpoint as CargoEndpoint,
			bodySha256: entry.bodySha256 as string,
			...(entry.fetchedAt === undefined ? {} : { fetchedAt: entry.fetchedAt as string }),
			...(entry.status === undefined ? {} : { status: entry.status as number }),
			...(entry.query === undefined ? {} : { query: entry.query as CargoQuery }),
		});
	}
	if (errors.length > 0) return { errors };
	return {
		manifest: { format: record.format as string, entityDigest: record.entityDigest as string, entities, payloads },
		errors: [],
	};
}

/**
 * Drift between the committed manifest and a rebuild, ignoring `fetchedAt`.
 *
 * One line per difference, each naming the file so `--check` output is actionable. A
 * body-only payload legitimately drops `fetchedAt`, `status` and `query`; a sidecar
 * appearing or disappearing is drift, because the manifest would no longer describe the
 * same provenance.
 *
 * The committed manifest is validated, not merely compared: `entityDigest` is recomputed
 * from the committed `entities` (in the build's OUTPUTS order), a duplicate file is
 * refused before a `Map` can make one copy win, and a changed entity file is reported
 * once rather than once per cause.
 */
export function compareManifest(committedValue: unknown, built: Manifest, schemaDir?: string): string[] {
	const read = readManifest(committedValue, schemaDir);
	if (read.manifest === undefined) return read.errors;
	const committed = read.manifest;
	const drift: string[] = [];
	if (committed.format !== built.format) {
		drift.push(`${MANIFEST_FILE}: format is ${describe(committed.format)}, expected ${describe(built.format)}`);
	}

	// Entity digests: the manifest has to describe the files beside it, in the order the
	// digest definition names. A file-level difference already explains the aggregate, so
	// the aggregate is only reported when it is the *only* entity problem.
	const entityDrift: string[] = [];
	if (committed.entities.length !== built.entities.length) {
		entityDrift.push(`${MANIFEST_FILE}: lists ${committed.entities.length} entity file(s), the build emits ${built.entities.length}`);
	}
	const committedEntities = new Map(committed.entities.map((entity) => [entity.file, entity]));
	const builtEntities = new Map(built.entities.map((entity) => [entity.file, entity]));
	for (const [file, entity] of builtEntities) {
		const there = committedEntities.get(file);
		if (there === undefined) {
			entityDrift.push(`${MANIFEST_FILE}: does not list ${file}, which the build emits`);
			continue;
		}
		if (there.sha256 !== entity.sha256) {
			entityDrift.push(`${MANIFEST_FILE}: ${file} is ${entity.sha256}, committed as ${there.sha256}`);
		}
		if (there.records !== entity.records) {
			entityDrift.push(`${MANIFEST_FILE}: ${file} has ${entity.records} record(s), committed as ${there.records}`);
		}
	}
	for (const file of committedEntities.keys()) {
		if (!builtEntities.has(file)) entityDrift.push(`${MANIFEST_FILE}: lists ${file}, which the build does not emit`);
	}

	// The order is part of the digest definition, so a scrambled `entities` array is not
	// an equivalent manifest. Checked separately from the set, which the maps above
	// deliberately ignore.
	const committedOrder = committed.entities.map((entity) => entity.file);
	const builtOrder = built.entities.map((entity) => entity.file);
	const sameSet =
		committedEntities.size === builtEntities.size && [...builtEntities.keys()].every((file) => committedEntities.has(file));
	let orderDrift: string | undefined;
	if (sameSet && committedOrder.some((file, index) => file !== builtOrder[index])) {
		const at = committedOrder.findIndex((file, index) => file !== builtOrder[index]);
		orderDrift = `${MANIFEST_FILE}: entity files are out of order at position ${at + 1}: ${committedOrder[at]} where the build's OUTPUTS order has ${builtOrder[at]}`;
	}

	let entityConsistent = entityDrift.length === 0;
	if (entityDrift.length > 0) {
		drift.push(...entityDrift);
	} else {
		if (orderDrift !== undefined) {
			drift.push(orderDrift);
			entityConsistent = false;
		}
		// Recompute the digest from the committed list rather than trusting the string:
		// a hand-edit that changes `entities` and leaves `entityDigest` is an internally
		// inconsistent manifest, whatever the rebuild says.
		const recomputed = entityDigestOf(committed.entities);
		if (recomputed !== committed.entityDigest) {
			drift.push(`${MANIFEST_FILE}: entityDigest does not match its own entities list (recomputed ${recomputed}, committed ${committed.entityDigest})`);
			entityConsistent = false;
		} else if (committed.entityDigest !== built.entityDigest) {
			drift.push(`${MANIFEST_FILE}: entityDigest is ${built.entityDigest}, committed as ${committed.entityDigest}`);
			entityConsistent = false;
		}
	}

	// Payload pins: same payloads, same bytes, same provenance — timestamps aside.
	const payloadDrift: string[] = [];
	const committedPayloads = new Map(committed.payloads.map((payload) => [payload.file, payload]));
	const builtPayloads = new Map(built.payloads.map((payload) => [payload.file, payload]));
	for (const [file, payload] of builtPayloads) {
		const there = committedPayloads.get(file);
		if (there === undefined) {
			payloadDrift.push(`${MANIFEST_FILE}: does not list ${file} (table ${payload.table}), which this build read`);
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
		if (differences.length > 0) payloadDrift.push(`${MANIFEST_FILE}: ${file}: ${differences.join("; ")}`);
	}
	for (const file of committedPayloads.keys()) {
		if (!builtPayloads.has(file)) payloadDrift.push(`${MANIFEST_FILE}: lists ${file}, which this build did not read`);
	}
	drift.push(...payloadDrift);

	// One cause, one line: when the entity files agree and only the cache set moved, say
	// that plainly instead of leaving the reader to infer it from a list of payload pins.
	if (entityConsistent && payloadDrift.length > 0) {
		drift.push(`${MANIFEST_FILE}: the entity files are identical; only the cache set changed — regenerate the manifest`);
	}
	return drift;
}
