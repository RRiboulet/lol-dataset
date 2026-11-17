// Provenance and a byte-identical rebuild (spec R8, R9; ticket 07).
//
// The manifest is the build's account of itself, so these tests assert it like an
// artifact rather than like a log: every payload the build read is named with the
// hash of the bytes on disk, the entity files are digested in a documented order,
// and the one timestamp in the repository lives here and nowhere else.
//
// The three claims that need a scratch cache rather than the committed fixtures:
//
//   - tampering: one byte changed in one payload, with its sidecar left alone, stops
//     the build and names the payload, the table and the records it would have made;
//   - byte identity: two builds (same cache, a restored cache, a cache whose sidecars
//     were revalidated) produce the same entity bytes, with `fetchedAt` the only
//     difference the manifest is allowed to show;
//   - the inherited double fetch: the same IEM 2015 rows with a different `fields=`
//     order are a second payload, not a second truth — both are listed, both are
//     pinned, and the entity files do not move.
//
// The audit at the bottom is the ticket's fourth point: every emitted record has a
// path back to a cached payload's row. It walks the committed files and the recorded
// payloads, so adding an entity without an identifier fails here rather than being
// discovered by a reader years later.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import type { BuildResult, OutputFile } from "../build.ts";
import { buildDataset, OUTPUTS } from "../build.ts";
import type { CargoQuery, CachedPayload } from "../cache.ts";
import { readPayloads, sha256, writePayload } from "../cache.ts";
import { compareManifest, entityDigestOf, MANIFEST_FILE, MANIFEST_SCHEMA_FILE, TABLE_CONSUMERS, assertTableConsumersMatchNormalizers } from "../manifest.ts";
import { displayName, KNOWN_TABLES } from "../normalize.ts";
import { validateAgainst } from "../validate.ts";
import { CURATED_DIR, DATASET_DIR, FIXTURE_RAW, SCHEMA_DIR } from "./helpers.ts";

const run = promisify(execFile);

/** The emitted entity files, in the registry order the manifest's digest is defined on. */
const ENTITY_FILES = Object.keys(OUTPUTS) as OutputFile[];

let shared: Promise<BuildResult> | undefined;
function build(): Promise<BuildResult> {
	shared ??= buildDataset({ rawDir: FIXTURE_RAW });
	return shared;
}

async function scratchCopy(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-provenance-"));
	await cp(FIXTURE_RAW, dir, { recursive: true });
	return dir;
}

/** One payload's rows, from either recorded envelope (see `cache.ts`). */
function rowsOf(payload: CachedPayload): Record<string, unknown>[] {
	const parsed = JSON.parse(payload.body) as unknown;
	if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
	const wrapped = (parsed as { cargoquery?: { title?: Record<string, unknown> }[] }).cargoquery ?? [];
	return wrapped.map((entry) => entry.title ?? {});
}

/** Every payload body under the fixtures, with its rows. */
async function recorded(): Promise<{ payloads: CachedPayload[]; byTable: Map<string, { payload: CachedPayload; row: Record<string, unknown> }[]> }> {
	const payloads = await readPayloads(FIXTURE_RAW);
	const byTable = new Map<string, { payload: CachedPayload; row: Record<string, unknown> }[]>();
	for (const payload of payloads) {
		const list = byTable.get(payload.table) ?? [];
		for (const row of rowsOf(payload)) list.push({ payload, row });
		byTable.set(payload.table, list);
	}
	return { payloads, byTable };
}

/** A Cargo value as text, the way `normalize.ts` compares it: numbers and lists included. */
function text(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (Array.isArray(value)) return value.map(text).filter((item) => item !== "").join(", ");
	return String(value).trim();
}

/** Every scalar in a parsed JSON value, stringified, for "does this string appear" checks. */
function scalars(value: unknown, into: Set<string> = new Set()): Set<string> {
	if (value === null || value === undefined) return into;
	if (Array.isArray(value)) {
		for (const item of value) scalars(item, into);
		return into;
	}
	if (typeof value === "object") {
		for (const item of Object.values(value as Record<string, unknown>)) scalars(item, into);
		return into;
	}
	into.add(String(value));
	return into;
}

/** The column names a source string for each identity kind can appear in. */
const IDENTITY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
	team: ["Team1", "Team2", "Team", "TeamVs", "WinTeam", "LossTeam", "_pageName", "Name", "OverviewPage", "AllName", "OtherName", "RenamedTo"],
	player: ["Name", "Link", "_pageName", "AllName", "ID", "OverviewPage"],
	champion: ["Name", "Champion", "Team1Picks", "Team2Picks", "Team1Bans", "Team2Bans", "Team1Pick1", "Team1Pick2", "Team1Pick3", "Team1Pick4", "Team1Pick5", "Team2Pick1", "Team2Pick2", "Team2Pick3", "Team2Pick4", "Team2Pick5", "Team1Ban1", "Team1Ban2", "Team1Ban3", "Team1Ban4", "Team1Ban5", "Team2Ban1", "Team2Ban2", "Team2Ban3", "Team2Ban4", "Team2Ban5"],
};

function stringsInColumns(
	byTable: Map<string, { payload: CachedPayload; row: Record<string, unknown> }[]>,
	columns: readonly string[],
): Set<string> {
	const found = new Set<string>();
	for (const list of byTable.values()) {
		for (const { row } of list) {
			for (const column of columns) {
				if (!(column in row)) continue;
				scalars(row[column], found);
			}
		}
	}
	return found;
}

function findRow(
	byTable: Map<string, { payload: CachedPayload; row: Record<string, unknown> }[]>,
	table: string,
	predicate: (row: Record<string, unknown>) => boolean,
	what: string,
): { payload: CachedPayload; row: Record<string, unknown> } {
	const hit = (byTable.get(table) ?? []).find(({ row }) => predicate(row));
	assert.ok(hit, `no recorded ${table} row for ${what}`);
	return hit;
}

/** ISO-shaped date/data-time strings, the only shape a stored instant takes. */
const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?$/;

/** Field names allowed to hold an ISO string. Nothing else may be a date-like value. */
const DATE_FIELDS = new Set(["dateStart", "dateTimeUtc", "firstSeen", "lastSeen"]);

/** Assert every ISO-shaped string sits in a field that is defined to hold data dates. */
function assertDatesAreData(file: string, value: unknown, field: string, where: string): void {
	if (typeof value === "string") {
		if (ISO.test(value)) {
			assert.ok(DATE_FIELDS.has(field), `${file}: ${where} holds an ISO value ${JSON.stringify(value)} in field ${JSON.stringify(field)}, which is not a data-date field`);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) assertDatesAreData(file, item, field, `${where}[${index}]`);
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
			assertDatesAreData(file, item, name, `${where}.${name}`);
		}
	}
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

test("the manifest names every payload the build read, with its table, endpoint, query and bytes pinned", async () => {
	const result = await build();
	const { payloads } = await recorded();
	assert.equal(result.manifest.payloads.length, payloads.length, "the manifest must list every payload, including payloads with no sidecar");
	const files = result.manifest.payloads.map((entry) => entry.file);
	assert.deepEqual(files, [...files].sort(), "payloads must be sorted by cache-relative path");

	const byFile = new Map(payloads.map((payload) => [payload.file, payload]));
	for (const entry of result.manifest.payloads) {
		const payload = byFile.get(entry.file);
		assert.ok(payload, `${entry.file} is in the manifest but not in the cache`);
		assert.equal(entry.table, payload.table, `${entry.file}: the manifest's table must be the directory the build routed by`);
		assert.equal(entry.endpoint, payload.endpoint);
		assert.equal(entry.bodySha256, sha256(payload.body), `${entry.file}: the manifest must pin the bytes on disk`);
		assert.equal(entry.fetchedAt, payload.meta?.fetchedAt, `${entry.file}: the manifest carries the sidecar's fetch time`);
		assert.equal(entry.status, payload.meta?.status);
		assert.ok(entry.query, `${entry.file}: the recorded fixtures carry sidecars, so their queries are in the manifest`);
		assert.equal(entry.query.tables, entry.table);
		assert.match(entry.fetchedAt ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	}
});

test("the manifest digests every entity file in a documented order, and the committed manifest is current", async () => {
	const result = await build();
	assert.deepEqual(
		result.manifest.entities.map((entity) => entity.file),
		ENTITY_FILES,
		"entity digests follow the build's OUTPUTS registry order, which is the documented definition",
	);
	for (const entity of result.manifest.entities) {
		const body = result.files[entity.file as OutputFile];
		assert.equal(entity.sha256, sha256(body), `${entity.file}: digest must be of the emitted bytes`);
		const records = body === "" ? 0 : body.replace(/\n$/, "").split("\n").length;
		assert.equal(entity.records, records, `${entity.file}: the manifest's record count must match the file`);
	}
	// The digest definition, recomputed independently of the implementation.
	const expected = createHash("sha256")
		.update(result.manifest.entities.map((entity) => `${entity.file}\t${entity.sha256}\t${entity.records}\n`).join(""))
		.digest("hex");
	assert.equal(result.manifest.entityDigest, expected);
	assert.equal(result.manifest.entityDigest, entityDigestOf(result.manifest.entities));

	const committed = await readFile(path.join(CURATED_DIR, MANIFEST_FILE), "utf8");
	assert.equal(
		committed,
		result.manifestText,
		`data/curated/${MANIFEST_FILE} is stale — rebuild it with: node tools/dataset/cli.ts build --raw tools/dataset/fixtures/raw`,
	);
});

test("the manifest's shape is the checked-in schema, and both the committed and the built manifest satisfy it", async () => {
	const schema = JSON.parse(await readFile(path.join(SCHEMA_DIR, MANIFEST_SCHEMA_FILE), "utf8")) as Record<string, unknown>;
	const committed = JSON.parse(await readFile(path.join(CURATED_DIR, MANIFEST_FILE), "utf8")) as unknown;
	assert.deepEqual(validateAgainst(schema, committed, MANIFEST_SCHEMA_FILE), []);

	const result = await build();
	assert.deepEqual(validateAgainst(schema, JSON.parse(result.manifestText), MANIFEST_SCHEMA_FILE), []);

	// The contract is strict, not decorative: what `readManifest` used to ignore is a
	// schema violation, so `--check` cannot compare a manifest it only partly understood.
	const withUnknown = JSON.parse(JSON.stringify(committed)) as Record<string, unknown>;
	withUnknown.extraField = true;
	assert.ok(
		validateAgainst(schema, withUnknown, MANIFEST_SCHEMA_FILE).some((error) => error.message === 'unexpected field "extraField"'),
		"the manifest schema must reject an unknown field",
	);

	// The format marker is a constant, not free text: a reader must be able to refuse a
	// version it does not know even when every other field happens to parse.
	const wrongFormat = { ...(committed as Record<string, unknown>), format: "lol-dataset-provenance/2" };
	assert.ok(
		validateAgainst(schema, wrongFormat, MANIFEST_SCHEMA_FILE).some((error) => error.path === "format" && /expected the constant/.test(error.message)),
		"the manifest schema must pin the format marker",
	);
});

test("TABLE_CONSUMERS and normalize.ts's normalizers route exactly the same tables", () => {
	assert.deepEqual(Object.keys(TABLE_CONSUMERS).sort(), KNOWN_TABLES);
	assert.throws(
		() => assertTableConsumersMatchNormalizers({ ...TABLE_CONSUMERS, Extra: ["events.jsonl"] }),
		/update both TABLE_CONSUMERS in manifest\.ts and NORMALIZERS in normalize\.ts/,
	);
	assert.throws(() => assertTableConsumersMatchNormalizers({}, ["Tournaments"]), /normalize\.ts normalizes Tournaments/);
});

test("no entity file carries a fetch time: the manifest is the only place a timestamp lives", async () => {
	const result = await build();
	const fetchTimes = result.manifest.payloads.map((payload) => payload.fetchedAt).filter((value): value is string => value !== undefined);
	assert.ok(fetchTimes.length > 0, "the fixtures must carry recorded fetch times for this to prove anything");
	for (const [file, body] of Object.entries(result.files) as [OutputFile, string][]) {
		for (const fetchTime of fetchTimes) {
			assert.ok(!body.includes(fetchTime), `${file} must not contain the fetch time ${fetchTime} (spec R8)`);
		}
	}
});

// ---------------------------------------------------------------------------
// Fixed representation
// ---------------------------------------------------------------------------

test("every number and date has one representation, and no entity file leaks the build's environment", async () => {
	const result = await build();
	const host = hostname();
	const repoRoot = path.resolve(DATASET_DIR, "..", "..");
	for (const [file, body] of Object.entries(result.files) as [OutputFile, string][]) {
		assert.ok(!body.includes(repoRoot), `${file} must not contain the repository path ${repoRoot}`);
		assert.ok(!body.includes(FIXTURE_RAW), `${file} must not contain the fixture path ${FIXTURE_RAW}`);
		if (host.length >= 4) assert.ok(!body.includes(host), `${file} must not contain the host name ${host}`);
		assert.ok(!body.includes("\r"), `${file} must use LF endings`);
		for (const [index, line] of body.replace(/\n$/, "").split("\n").entries()) {
			// JSON's own serialization is the fixed representation: a line that does not
			// round-trip carries something JSON.stringify would never write (1.0, 1e3, -0,
			// escaped-but-identical, or key order introduced by hand).
			assert.equal(JSON.stringify(JSON.parse(line)), line, `${file}:${index + 1}: not one canonical JSON representation`);
			const record = JSON.parse(line) as Record<string, unknown>;
			assertDatesAreData(file, record, "record", `${file}:${index + 1}`);
			const visit = (value: unknown, where: string): void => {
				if (typeof value === "number") {
					assert.ok(Number.isFinite(value), `${file}:${index + 1}: ${where} is not finite`);
					assert.ok(!Object.is(value, -0), `${file}:${index + 1}: ${where} is negative zero`);
					return;
				}
				if (typeof value === "string") {
					assert.ok(!value.startsWith("/"), `${file}:${index + 1}: ${where} is an absolute path (${JSON.stringify(value)})`);
					assert.ok(!/^[A-Za-z]:\\/.test(value), `${file}:${index + 1}: ${where} is an absolute path (${JSON.stringify(value)})`);
					return;
				}
				if (Array.isArray(value)) {
					value.forEach((item, at) => visit(item, `${where}[${at}]`));
					return;
				}
				if (value !== null && typeof value === "object") {
					for (const [name, item] of Object.entries(value as Record<string, unknown>)) visit(item, `${where}.${name}`);
				}
			};
			visit(record, "record");
		}
	}
});

// ---------------------------------------------------------------------------
// Byte identity, and the manifest as the only permitted difference
// ---------------------------------------------------------------------------

test("two builds from the same cache are byte-identical, manifest included", async () => {
	const a = await buildDataset({ rawDir: FIXTURE_RAW });
	const b = await buildDataset({ rawDir: FIXTURE_RAW });
	for (const file of ENTITY_FILES) assert.equal(a.files[file], b.files[file], `${file} differed between two builds over the same cache`);
	assert.equal(a.manifestText, b.manifestText, "the same cache must produce the same manifest bytes");
});

test("deleting the cache and restoring the same payloads changes nothing in the output", async () => {
	const dir = await scratchCopy();
	try {
		const first = await buildDataset({ rawDir: dir });
		await rm(dir, { recursive: true, force: true });
		await cp(FIXTURE_RAW, dir, { recursive: true });
		const second = await buildDataset({ rawDir: dir });
		for (const file of ENTITY_FILES) assert.equal(second.files[file], first.files[file], `${file} changed when the cache was restored`);
		assert.equal(second.manifestText, first.manifestText);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("re-fetching the same bytes with a new fetch time moves the manifest and nothing else", async () => {
	// A revalidated payload is not a data change: the entity files must be untouched and
	// `fetchedAt` is the only manifest field allowed to differ (spec D8, ticket 07).
	const dir = await scratchCopy();
	try {
		for (const payload of await readPayloads(dir)) {
			if (payload.meta === undefined) continue;
			const metaFile = path.join(dir, payload.file).replace(/\.json$/, ".meta.json");
			const meta = JSON.parse(await readFile(metaFile, "utf8")) as Record<string, unknown>;
			meta.fetchedAt = "2030-01-01T00:00:00.000Z";
			await writeFile(metaFile, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
		}
		const base = await build();
		const refetched = await buildDataset({ rawDir: dir });
		for (const file of ENTITY_FILES) {
			assert.equal(refetched.files[file], base.files[file], `${file} must not depend on when a payload was fetched`);
		}
		const withoutTimes = (text: string): string =>
			JSON.stringify(JSON.parse(text), (key, value) => (key === "fetchedAt" ? undefined : value));
		assert.equal(withoutTimes(refetched.manifestText), withoutTimes(base.manifestText), "only fetchedAt may differ");
		assert.notEqual(refetched.manifestText, base.manifestText, "the manifest must record the new fetch time");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// The payload gate
// ---------------------------------------------------------------------------

test("one changed byte in one payload is detected, naming the payload, the table and its records", async () => {
	const dir = await scratchCopy();
	try {
		const tournaments = (await readPayloads(dir)).filter((payload) => payload.table === "Tournaments");
		assert.ok(tournaments.length > 0);
		const victim = tournaments[0];
		const body = JSON.parse(victim.body) as { OverviewPage?: string; Name?: string }[];
		const row = body.find((entry) => entry.OverviewPage !== undefined);
		assert.ok(row);
		row.Name = "Tampered (ticket 07)";
		// The sidecar is deliberately left alone: this is the tamper case, not a re-record.
		await writeFile(path.join(dir, victim.file), JSON.stringify(body), "utf8");
		await assert.rejects(buildDataset({ rawDir: dir }), (error: Error) => {
			assert.match(error.message, new RegExp(`${victim.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: the bytes on disk no longer match`));
			assert.match(error.message, /bodySha256/);
			assert.match(error.message, /Table Tournaments feeds events\.jsonl/);
			assert.match(error.message, /Its rows name /);
			return true;
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a payload with no sidecar is legal and appears in the manifest without a fetch time", async () => {
	// Scratch directories build from bodies alone (a test's scratch cache, a payload
	// carried over from another tool). There is no provenance to contradict and no
	// timestamp to invent, so the entry is the body and its hash — nothing else.
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-bodyonly-"));
	try {
		const source = (await readPayloads(FIXTURE_RAW)).find((payload) => payload.table === "Tournaments");
		assert.ok(source);
		const table = path.join(dir, "lol-fandom", "cargoexport", "Tournaments");
		await mkdir(table, { recursive: true });
		await writeFile(path.join(table, "recorded.json"), source.body, "utf8");

		const result = await buildDataset({ rawDir: dir });
		assert.equal(result.manifest.payloads.length, 1);
		const [entry] = result.manifest.payloads;
		assert.deepEqual(Object.keys(entry), ["file", "table", "endpoint", "bodySha256"], "a body-only payload has no fetch time, status or query");
		assert.equal(entry.bodySha256, sha256(source.body));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// `--check`
// ---------------------------------------------------------------------------

/** Build into a scratch output directory, then run `--check` against a mutated manifest. */
async function checkWith(edit: (manifest: Record<string, unknown>) => void): Promise<{ code: number; output: string }> {
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-check-prov-"));
	try {
		await run(process.execPath, [path.join(DATASET_DIR, "cli.ts"), "build", "--raw", FIXTURE_RAW, "--out", dir], { cwd: DATASET_DIR });
		const manifestFile = path.join(dir, MANIFEST_FILE);
		const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as Record<string, unknown>;
		edit(manifest);
		await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		try {
			const { stdout, stderr } = await run(process.execPath, [path.join(DATASET_DIR, "cli.ts"), "build", "--raw", FIXTURE_RAW, "--out", dir, "--check"], {
				cwd: DATASET_DIR,
			});
			return { code: 0, output: `${stdout}${stderr}` };
		} catch (error) {
			const failure = error as { code?: number; stdout?: string; stderr?: string };
			return { code: failure.code ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("`--check` passes when only a payload's fetchedAt differs, and fails when a pin does not describe the cache", async () => {
	const untouched = await checkWith(() => {});
	assert.equal(untouched.code, 0, untouched.output);

	const refetched = await checkWith((manifest) => {
		const payloads = manifest.payloads as { fetchedAt?: string }[];
		assert.ok(payloads[0].fetchedAt);
		payloads[0].fetchedAt = "2031-02-03T04:05:06.789Z";
	});
	assert.equal(refetched.code, 0, `a new fetch time must not look like data drift:\n${refetched.output}`);

	const missing = await checkWith((manifest) => {
		(manifest.payloads as { file: string }[]).splice(0, 1);
	});
	assert.equal(missing.code, 1);
	assert.match(missing.output, new RegExp(`does not list .*\\.json`), missing.output);

	const changedHash = await checkWith((manifest) => {
		const payloads = manifest.payloads as { bodySha256: string }[];
		payloads[0].bodySha256 = "0".repeat(64);
	});
	assert.equal(changedHash.code, 1);
	assert.match(changedHash.output, /bodySha256 is [0-9a-f]{64}, committed as 0{64}/, changedHash.output);

	const noManifest = await checkWith((manifest) => {
		manifest.entities = [];
	});
	assert.equal(noManifest.code, 1);
	assert.match(noManifest.output, /does not list events\.jsonl/, noManifest.output);
});

test("`--check` rejects a manifest whose entities list is out of order, duplicated, or the wrong length", async () => {
	const reversed = await checkWith((manifest) => {
		(manifest.entities as unknown[]).reverse();
	});
	assert.equal(reversed.code, 1);
	assert.match(reversed.output, /entity files are out of order at position 1/, reversed.output);
	assert.match(reversed.output, /entityDigest does not match its own entities list/, reversed.output);

	const duplicated = await checkWith((manifest) => {
		const entities = manifest.entities as Record<string, unknown>[];
		entities.push({ ...entities[0] });
	});
	assert.equal(duplicated.code, 1);
	assert.match(duplicated.output, /lists events\.jsonl more than once among entities/, duplicated.output);

	const missing = await checkWith((manifest) => {
		(manifest.entities as unknown[]).splice(0, 1);
	});
	assert.equal(missing.code, 1);
	assert.match(missing.output, /lists 10 entity file\(s\), the build emits 11/, missing.output);
	assert.match(missing.output, /does not list events\.jsonl/, missing.output);
});

test("`--check` rejects a duplicated payload entry even when its last copy is valid", async () => {
	// A Map is last-wins. Before the duplicate was refused, a first copy with a wrong
	// hash was invisible because the second, valid copy overwrote it.
	const duplicated = await checkWith((manifest) => {
		const payloads = manifest.payloads as Record<string, unknown>[];
		const valid = { ...payloads[0] };
		payloads[0] = { ...payloads[0], bodySha256: "0".repeat(64) };
		payloads.push(valid);
	});
	assert.equal(duplicated.code, 1);
	assert.match(duplicated.output, /lists .*\.json more than once among payloads/, duplicated.output);
});

test("`--check` refuses a manifest field or shape the schema does not allow", async () => {
	const unknownField = await checkWith((manifest) => {
		manifest.extraField = true;
	});
	assert.equal(unknownField.code, 1);
	assert.match(unknownField.output, /unexpected field "extraField"/, unknownField.output);

	const payloadUrl = await checkWith((manifest) => {
		(manifest.payloads as Record<string, unknown>[])[0].url = "https://example.invalid";
	});
	assert.equal(payloadUrl.code, 1);
	assert.match(payloadUrl.output, /payloads\[0\]: unexpected field "url"/, payloadUrl.output);

	const shortHash = await checkWith((manifest) => {
		(manifest.entities as Record<string, unknown>[])[0].sha256 = "abc";
	});
	assert.equal(shortHash.code, 1);
	assert.match(shortHash.output, /does not match \^\[0-9a-f\]\{64\}\$/, shortHash.output);

	const badQuery = await checkWith((manifest) => {
		(manifest.payloads as Record<string, unknown>[])[0].query = "not an object";
	});
	assert.equal(badQuery.code, 1);
	assert.match(badQuery.output, /query: expected object, got string/, badQuery.output);

	const badFetchedAt = await checkWith((manifest) => {
		(manifest.payloads as Record<string, unknown>[])[0].fetchedAt = "yesterday";
	});
	assert.equal(badFetchedAt.code, 1);
	assert.match(badFetchedAt.output, /fetchedAt: .* does not match/, badFetchedAt.output);
});

test("`--check` reports one cause once when an entity file changed, and names a cache-only change honestly", async () => {
	// A changed entity digest used to print both the per-file line and the aggregate
	// `entityDigest is ...` line, which makes one cause look like two.
	const changedEntity = await checkWith((manifest) => {
		const entities = manifest.entities as { file: string; records: number; sha256: string }[];
		entities[0] = { ...entities[0], sha256: "0".repeat(64) };
		manifest.entityDigest = createHash("sha256")
			.update(entities.map((entity) => `${entity.file}\t${entity.sha256}\t${entity.records}\n`).join(""))
			.digest("hex");
	});
	assert.equal(changedEntity.code, 1);
	assert.match(changedEntity.output, /events\.jsonl is [0-9a-f]{64}, committed as 0{64}/, changedEntity.output);
	assert.doesNotMatch(changedEntity.output, /entityDigest is /, changedEntity.output);

	// The other direction: the entity files are fine and only the cache set moved, so the
	// report should say exactly that instead of leaving it to be inferred from payload pins.
	const cacheOnly = await checkWith((manifest) => {
		(manifest.payloads as unknown[]).splice(0, 1);
	});
	assert.equal(cacheOnly.code, 1);
	assert.match(cacheOnly.output, /the entity files are identical; only the cache set changed — regenerate the manifest/, cacheOnly.output);
});

// ---------------------------------------------------------------------------
// Source identifiers: every record resolves to a payload row
// ---------------------------------------------------------------------------

test("every emitted record resolves to a recorded payload row, and that payload is pinned in the manifest", async () => {
	const result = await build();
	const { payloads, byTable } = await recorded();
	const pinned = new Map(result.manifest.payloads.map((entry) => [entry.file, entry]));
	const recordFile = (file: OutputFile): Record<string, unknown>[] =>
		result.files[file]
			.replace(/\n$/, "")
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	const assertPinned = (payload: CachedPayload, what: string): void => {
		const entry = pinned.get(payload.file);
		assert.ok(entry, `${what}: ${payload.file} is not in the manifest`);
		assert.equal(entry.bodySha256, sha256(payload.body), `${what}: ${payload.file} is pinned to bytes that are not on disk`);
	};

	// Events, the selection report and the per-event game report all name their
	// `Tournaments` row by page; the report's `state` is derived, not a source field.
	for (const file of ["events.jsonl", "event-selection.jsonl", "event-games.jsonl"] as const) {
		for (const record of recordFile(file)) {
			const page = record.overviewPage;
			assert.equal(typeof page, "string");
			const hit = findRow(byTable, "Tournaments", (row) => text(row.OverviewPage) === page, `${file} ${String(record.id)} page ${String(page)}`);
			assertPinned(hit.payload, `${file} ${String(record.id)}`);
		}
	}

	let hashes = 0;
	for (const game of recordFile("games.jsonl")) {
		const source = game.source as Record<string, unknown>;
		const gameId = text(source.gameId);
		assert.ok(gameId !== "", "every game carries its source GameId");
		const hit = findRow(byTable, "ScoreboardGames", (row) => text(row.GameId) === gameId, `game ${gameId}`);
		assert.equal(text(hit.row.MatchId), text(source.matchId), `game ${gameId}: MatchId must match the payload row`);
		// Unconditional on both sides: a row that states the identifier must be emitted
		// with it, and a row that does not must not invent one (spec D7).
		const platformGameId = text(hit.row.RiotPlatformGameId);
		assert.equal(source.riotPlatformGameId, platformGameId === "" ? undefined : platformGameId, `game ${gameId}: platform game id must match the row`);
		const riotHash = text(hit.row.RiotHash);
		assert.equal(source.riotHash, riotHash === "" ? undefined : riotHash, `game ${gameId}: Riot hash must match the row (spec D7)`);
		if (riotHash !== "") hashes += 1;
		assertPinned(hit.payload, `game ${gameId}`);
	}
	// The recorded corpus states Riot's hash for the 2015-era rows and not for 2023's,
	// so a non-zero count proves the field is exercised rather than merely declared.
	assert.ok(hashes > 0, "the audit must cover at least one game whose payload states Riot's hash");

	for (const match of recordFile("matches.jsonl")) {
		const source = match.source as Record<string, unknown>;
		const matchId = text(source.matchId);
		assert.ok(matchId !== "", "every match carries its source MatchId");
		const hit = findRow(byTable, "MatchSchedule", (row) => text(row.MatchId) === matchId, `match ${matchId}`);
		const sides = [text(hit.row.Team1), text(hit.row.Team2)];
		for (const side of match.sides as Record<string, unknown>[]) {
			assert.ok(sides.includes(text(side.sourceTeam)), `match ${matchId}: ${String(side.sourceTeam)} must be one of the series' sides`);
		}
		assertPinned(hit.payload, `match ${matchId}`);
	}

	for (const row of recordFile("player-games.jsonl")) {
		const source = row.source as Record<string, unknown>;
		const gameId = text(source.gameId);
		const link = text(source.playerLink);
		assert.ok(gameId !== "" && link !== "", "every player-game row carries its game id and player link");
		const hit = findRow(
			byTable,
			"ScoreboardPlayers",
			(candidate) => text(candidate.GameId) === gameId && (text(candidate.Link) === link || text(candidate.Name) === link),
			`player game ${gameId} / ${link}`,
		);
		assert.ok(text(hit.row.Team) !== "", `player game ${gameId}/${link}: the payload row must state a team`);
		assertPinned(hit.payload, `player game ${gameId}/${link}`);
	}

	// Identity: a registry page where the source has one, otherwise the alias bridge —
	// the row in `aliases.jsonl` that says which recorded string denotes this entity.
	const teamStrings = stringsInColumns(byTable, IDENTITY_COLUMNS.team);
	for (const team of recordFile("teams.jsonl")) {
		if (team.overviewPage !== null) {
			const hit = findRow(byTable, "Teams", (row) => text(row.OverviewPage) === team.overviewPage, `team ${String(team.id)}`);
			assertPinned(hit.payload, `team ${String(team.id)}`);
			continue;
		}
		const alias = result.identity.aliases.find((entry) => entry.kind === "team" && entry.entityId === team.id);
		assert.ok(alias, `team ${String(team.id)} (${String(team.name)}) has no page and no alias row, so it has no way back to a payload`);
		assert.ok(teamStrings.has(alias.string), `team ${String(team.name)}: ${JSON.stringify(alias.string)} appears in no recorded team column`);
	}

	const playerStrings = stringsInColumns(byTable, IDENTITY_COLUMNS.player);
	for (const player of recordFile("players.jsonl")) {
		if (player.overviewPage !== null) {
			const hit = findRow(byTable, "PlayerRedirects", (row) => text(row.OverviewPage) === player.overviewPage, `player ${String(player.id)}`);
			assertPinned(hit.payload, `player ${String(player.id)}`);
			continue;
		}
		const alias = result.identity.aliases.find((entry) => entry.kind === "player" && entry.entityId === player.id);
		assert.ok(alias, `player ${String(player.id)} (${String(player.name)}) has no page and no alias row, so it has no way back to a payload`);
		assert.ok(playerStrings.has(alias.string), `player ${String(player.name)}: ${JSON.stringify(alias.string)} appears in no recorded player column`);
	}

	for (const champion of recordFile("champions.jsonl")) {
		const riotKey = champion.riotKey;
		assert.equal(typeof riotKey, "number", `champion ${String(champion.id)} must carry Riot's numeric id, which is its source identity`);
		const hit = findRow(byTable, "Champions", (row) => Number(row.KeyInteger) === riotKey, `champion ${String(champion.id)}`);
		assert.equal(displayName(text(hit.row.Name)), champion.name, `champion ${String(champion.id)}: the registry row must name this champion`);
		assertPinned(hit.payload, `champion ${String(champion.id)}`);
	}

	// Declared aliases are the one identity row the source does not carry: they come
	// from `rules/identity-aliases.json`, and the row says so through `evidence`. A
	// declaration names its entity either directly (`page`/`riotKey`) or, when the corpus
	// has no registry row for it at all, through another source string (`aliasOf`) — that
	// target is itself a string the payloads carry, so the same walk-back applies to it.
	const declared = JSON.parse(await readFile(path.join(DATASET_DIR, "rules", "identity-aliases.json"), "utf8")) as {
		aliases?: { string?: string; aliasOf?: string }[];
	};
	const declaredStrings = new Set((declared.aliases ?? []).map((alias) => alias.string ?? ""));
	const declaredTargets = new Set((declared.aliases ?? []).map((alias) => alias.aliasOf ?? ""));
	const allScalars = scalars(payloads.map((payload) => rowsOf(payload)));
	for (const alias of result.identity.aliases) {
		if (alias.evidence.includes("declared")) {
			assert.ok(
				declaredStrings.has(alias.string) || declaredTargets.has(alias.string),
				`alias ${JSON.stringify(alias.string)}: declared evidence needs a row in rules/identity-aliases.json`,
			);
			if (declaredStrings.has(alias.string)) continue;
		}
		assert.ok(
			stringsInColumns(byTable, IDENTITY_COLUMNS[alias.kind]).has(alias.string),
			`alias ${JSON.stringify(alias.string)} (${alias.kind}): no recorded row carries that string`,
		);
	}
	for (const unresolved of result.identity.unresolved) {
		assert.ok(allScalars.has(unresolved.string), `unresolved ${unresolved.kind} ${JSON.stringify(unresolved.string)} appears in no payload`);
	}
});

// ---------------------------------------------------------------------------
// The inherited decision: IEM 2015 fetched twice
// ---------------------------------------------------------------------------

test("a second fetch of identical rows under a different fields= order is a second payload, not a second truth", async () => {
	// Ticket 09's measured case: the same IEM 2015 rows re-fetched with the columns in a
	// different order. The rows are identical, the bytes are not, so the cache key and the
	// body hash differ. The decision: both payloads are listed and pinned, because the
	// manifest describes what the build read, not which fetch someone prefers; the entity
	// files prove the rows are one dataset by not moving.
	const base = await build();
	const dir = await scratchCopy();
	try {
		const iem = (await readPayloads(dir)).find(
			(payload) => payload.table === "ScoreboardGames" && payload.body.includes("IEM Season IX - World Championship") && payload.query !== undefined,
		);
		assert.ok(iem, "the fixtures must carry the original IEM 2015 scoreboard payload");
		const query: CargoQuery = { ...iem.query!, fields: iem.query!.fields.split(",").reverse().join(",") };
		const reordered = rowsOf(iem).map((row) => Object.fromEntries(Object.entries(row).reverse()));
		const refetched = await writePayload(dir, query, JSON.stringify(reordered), {
			url: iem.meta?.url ?? "https://lol.fandom.com/wiki/Special:CargoExport",
			fetchedAt: "2026-11-18T00:00:00.000Z",
			status: 200,
		});
		const refetchedFile = path.relative(dir, refetched.body);
		assert.notEqual(refetchedFile, iem.file, "a different fields= order must land under a different cache key");

		const doubled = await buildDataset({ rawDir: dir });
		for (const file of ENTITY_FILES) {
			assert.equal(doubled.files[file], base.files[file], `${file} must not depend on which byte variant of the same rows was read`);
		}
		const pins = doubled.manifest.payloads.filter((payload) => payload.file === iem.file || payload.file === refetchedFile);
		assert.equal(pins.length, 2, "both payloads the build read must be listed");
		assert.notEqual(pins[0].bodySha256, pins[1].bodySha256, "the two variants are different bytes, and the manifest must say so");
		assert.deepEqual(
			JSON.parse(await readFile(path.join(dir, refetchedFile), "utf8")),
			JSON.parse(iem.body),
			"the re-fetch is the same rows, so only the bytes differ",
		);

		// A committed manifest from the single-payload cache must not pass against the
		// doubled one: `--check` requires the manifest to name the payloads actually read.
		const drift = compareManifest(JSON.parse(base.manifestText), doubled.manifest);
		assert.ok(
			drift.some((line) => line.includes(refetchedFile) && /does not list/.test(line)),
			`--check must report the payload the committed manifest does not name, got:\n${drift.join("\n")}`,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
