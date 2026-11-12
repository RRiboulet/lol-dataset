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
import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import { buildDataset } from "../build.ts";
import { sha256 } from "../cache.ts";
import { DATASET_DIR, FIXTURE_RAW, REPO_ROOT } from "./helpers.ts";

/** Modules below the cache. `record.ts` and `cli.ts` are above it / users of it. */
const PIPELINE = ["cache.ts", "normalize.ts", "rule.ts", "assemble.ts", "emit.ts", "validate.ts", "build.ts"];

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

test("every recorded payload carries provenance that matches its bytes", async () => {
	const dir = path.join(FIXTURE_RAW, "lol-fandom", "cargoexport");
	const files = (await readdir(dir)).sort();
	const bodies = files.filter((name) => name.endsWith(".json") && !name.endsWith(".meta.json"));
	assert.ok(bodies.length > 0, "ticket 01 commits recorded fixtures");

	for (const body of bodies) {
		const metaName = body.replace(/\.json$/, ".meta.json");
		assert.ok(files.includes(metaName), `${body} has no provenance sidecar`);

		const bytes = await readFile(path.join(dir, body), "utf8");
		const meta = JSON.parse(await readFile(path.join(dir, metaName), "utf8")) as {
			url: string;
			status: number;
			fetchedAt: string;
			bodySha256: string;
			query: { tables: string; fields: string; where?: string };
		};
		assert.equal(meta.bodySha256, sha256(bytes), `${body}: recorded hash does not match the recorded bytes`);
		assert.equal(meta.status, 200, `${body}: recorded with a failing status`);
		assert.match(meta.url, /^https:\/\/lol\.fandom\.com\//);
		assert.ok(Number.isFinite(Date.parse(meta.fetchedAt)), `${body}: fetchedAt is not a timestamp`);
		// Ticket 09 reuses these queries, so the query text has to travel with the bytes.
		assert.equal(meta.query.tables, "Tournaments");
		assert.ok(meta.query.fields.includes("OverviewPage"));
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
