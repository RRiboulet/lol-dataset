// The two promises around the pipeline rather than inside it:
//
//   1. the build never reaches the network (spec D5's purity boundary, ticket 01);
//   2. every committed source byte is attributable and traceable (spec D7, R9), and
//      the licence notice covers the recorded fixtures rather than the dataset it
//      was written for.
//
// Both are assertions about the repository, so they fail when someone adds a fetch
// call below the cache or commits a payload without its provenance sidecar.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { buildDataset } from "../build.ts";
import { readPayloads, sha256 } from "../cache.ts";
import { DATASET_DIR, FIXTURE_RAW, REPO_ROOT } from "./helpers.ts";

/** Modules below the cache. `record.ts` and `cli.ts` are above it / users of it. */
const PIPELINE = [
	"cache.ts",
	"normalize.ts",
	"rule.ts",
	"eras.ts",
	"assemble.ts",
	"games.ts",
	"identity.ts",
	"emit.ts",
	"validate.ts",
	"build.ts",
];

test("no pipeline module can reach the network", async () => {
	const forbidden = [/\bfetch\s*\(/, /node:https?/, /node:net/, /XMLHttpRequest/, /undici/, /\baxios\b/, /WebSocket/];
	for (const name of PIPELINE) {
		const source = await readFile(path.join(DATASET_DIR, name), "utf8");
		for (const pattern of forbidden) {
			assert.doesNotMatch(source, pattern, `${name} must not reach the network (matched ${pattern})`);
		}
	}
});

test("the build runs with the network taken away", async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (() => {
		throw new Error("the dataset build must not fetch");
	}) as typeof fetch;
	try {
		const { events } = await buildDataset({ rawDir: FIXTURE_RAW });
		assert.ok(events.length > 0);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("a payload outside <source>/<endpoint>/<table>/ is an error, not silently skipped", async () => {
	// The table is a path segment because a Cargo body does not say which table it
	// came from. A file at the wrong depth has no table, and guessing would route it
	// to the wrong normalizer.
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-layout-"));
	try {
		const flat = path.join(dir, "lol-fandom", "cargoexport");
		await mkdir(flat, { recursive: true });
		await writeFile(path.join(flat, "stray.json"), "[]", "utf8");
		await assert.rejects(readPayloads(dir), /expected <source>\/<endpoint>\/<table>\/<key>\.json/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Sidecar strictness: a sidecar that exists must be readable, complete and
// honest, because the manifest pins what it says verbatim (spec D7, ticket 07).
// ---------------------------------------------------------------------------

/** One recorded payload, the way `record.ts`/`fetch.ts` would leave it, in a scratch cache. */
async function scratchPayload(
	t: { after: (fn: () => Promise<void> | void) => void },
	override: Record<string, unknown> = {},
): Promise<{ dir: string; bodyFile: string }> {
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-sidecar-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const body = JSON.stringify([{ Name: "scratch", OverviewPage: "scratch" }]);
	const bodyFile = path.join(dir, "lol-fandom", "cargoexport", "Tournaments", "0000aaaa.json");
	await mkdir(path.dirname(bodyFile), { recursive: true });
	await writeFile(bodyFile, body, "utf8");
	const record: Record<string, unknown> = {
		source: "lol-fandom",
		endpoint: "cargoexport",
		query: { endpoint: "cargoexport", tables: "Tournaments", fields: "Name,OverviewPage", limit: 10 },
		url: "https://lol.fandom.com/wiki/Special:CargoExport?format=json&tables=Tournaments&fields=Name%2COverviewPage&limit=10",
		fetchedAt: "2026-11-12T00:00:00.000Z",
		status: 200,
		bodySha256: sha256(body),
	};
	for (const [key, value] of Object.entries(override)) {
		if (value === undefined) delete record[key];
		else record[key] = value;
	}
	await writeFile(bodyFile.replace(/\.json$/, ".meta.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
	return { dir, bodyFile };
}

function assertSidecarError(error: unknown, file: string, pattern: RegExp): void {
	assert.ok(error instanceof Error);
	assert.match(error.message, new RegExp(`${file.replace(/\./g, "\\.")}\\.meta\.json`), "the error must name the sidecar file");
	assert.match(error.message, pattern);
	assert.match(error.message, /re-run record\.ts or fetch\.ts for this query, or restore the payload from the recording/, "the error must carry a remedy");
}

test("a fully-formed sidecar reads back as provenance", async (t) => {
	const { dir } = await scratchPayload(t);
	const [payload] = await readPayloads(dir);
	assert.ok(payload.meta !== undefined, "a sidecar that exists must be handed to the build");
	assert.equal(payload.meta.source, "lol-fandom");
	assert.equal(payload.meta.status, 200);
	assert.ok(payload.query !== undefined);
	assert.equal(payload.query.tables, "Tournaments");
});

test("a sidecar whose fetchedAt is not a parseable ISO-8601 instant is refused", async (t) => {
	for (const fetchedAt of ["not-a-date", "November 12, 2026"]) {
		const { dir, bodyFile } = await scratchPayload(t, { fetchedAt });
		try {
			await readPayloads(dir);
			assert.fail(`fetchedAt ${JSON.stringify(fetchedAt)} was accepted`);
		} catch (error) {
			assertSidecarError(error, path.basename(bodyFile), /fetchedAt .* is not a parseable ISO-8601 instant/);
		}
	}
});

test("a sidecar that omits the url or the source D7 records is refused", async (t) => {
	for (const field of ["url", "source"] as const) {
		const { dir, bodyFile } = await scratchPayload(t, { [field]: undefined });
		try {
			await readPayloads(dir);
			assert.fail(`a sidecar without ${field} was accepted`);
		} catch (error) {
			assertSidecarError(error, path.basename(bodyFile), new RegExp(`sidecar states no ${field}`));
		}
	}
});

test("a sidecar query with an unknown field is refused, so the pin cannot drop it silently", async (t) => {
	const { dir, bodyFile } = await scratchPayload(t, {
		query: { endpoint: "cargoexport", tables: "Tournaments", fields: "Name", orderBy: "Name ASC" },
	});
	try {
		await readPayloads(dir);
		assert.fail("a query with an unknown field was accepted");
	} catch (error) {
		assertSidecarError(error, path.basename(bodyFile), /unknown query field "orderBy"/);
	}
});

test("a payload with no sidecar is legal, and reads as body-only", async (t) => {
	// The other half of the strictness: "no sidecar" (a scratch cache a test builds
	// from bodies alone) must stay legal, and must read differently from "a sidecar
	// that lies" — meta stays undefined rather than half-filled.
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-bodies-only-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const bodyFile = path.join(dir, "lol-fandom", "cargoexport", "Tournaments", "0000aaaa.json");
	await mkdir(path.dirname(bodyFile), { recursive: true });
	await writeFile(bodyFile, "[]", "utf8");
	const [payload] = await readPayloads(dir);
	assert.equal(payload.meta, undefined);
	assert.equal(payload.query, undefined);
	assert.equal(payload.table, "Tournaments");
});

test("every recorded payload carries provenance that matches its bytes", async () => {
	// Every body, in every table directory: the sidecar is what lets a value be
	// walked back to the bytes it came from (spec D7, R9), and the table it names has
	// to agree with the directory the build routes by, or a payload would be parsed
	// as the wrong kind of row.
	const payloads = await readPayloads(FIXTURE_RAW);
	const tables = new Set(payloads.map((payload) => payload.table));
	for (const table of ["Tournaments", "Teams", "TeamRedirects", "PlayerRedirects", "Champions", "ScoreboardPlayers"]) {
		assert.ok(tables.has(table), `the fixtures must carry recorded ${table} payloads`);
	}
	for (const payload of payloads) {
		const bodyPath = path.join(FIXTURE_RAW, payload.file);
		const metaPath = bodyPath.replace(/\.json$/, ".meta.json");
		const meta = JSON.parse(await readFile(metaPath, "utf8")) as {
			url: string;
			status: number;
			fetchedAt: string;
			bodySha256: string;
			query: { tables: string; fields: string; where?: string };
		};
		assert.equal(meta.bodySha256, sha256(payload.body), `${payload.file}: recorded hash does not match the recorded bytes`);
		assert.equal(meta.status, 200, `${payload.file}: recorded with a failing status`);
		assert.match(meta.url, /^https:\/\/lol\.fandom\.com\//);
		assert.ok(Number.isFinite(Date.parse(meta.fetchedAt)), `${payload.file}: fetchedAt is not a timestamp`);
		// Ticket 09 reuses these queries, so the query text has to travel with the bytes.
		assert.equal(meta.query.tables, payload.table, `${payload.file}: the recorded table disagrees with its directory`);
		assert.ok(meta.query.fields.length > 0, `${payload.file}: the recorded query has no fields`);
		assert.doesNotThrow(() => JSON.parse(payload.body), `${payload.file}: body is not JSON`);
	}
});

test("no recorded payload is orphaned from the fixture tree the build reads", async () => {
	// A fixture copied into the tree without its sidecar, or a payload recorded to a
	// path the build does not scan, is invisible to `buildDataset` — which would make
	// the test above pass while the build silently ignored the file.
	const { events, selection } = await buildDataset({ rawDir: FIXTURE_RAW });
	assert.ok(events.length >= 10, `expected the recorded events to be selected, got ${events.length}`);
	assert.ok(selection.length >= 19, `expected every recorded tournament row to be considered, got ${selection.length}`);
});

test("the licence notice covers the recorded fixtures, not only the future dataset", async () => {
	const notice = await readFile(path.join(REPO_ROOT, "licenses", "NOTICE.md"), "utf8");
	assert.match(notice, /Leaguepedia/);
	assert.match(notice, /CC BY-SA 3\.0/);
	assert.match(notice, /recorded source payloads/, "the notice must name the fixtures as source-derived content");
	assert.match(notice, /test fixtures|fixtures/, "the notice must say the fixtures are committed");
});
