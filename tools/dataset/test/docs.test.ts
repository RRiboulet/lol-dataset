// docs: the dataset documentation is checked, not trusted (ticket 11).
//
// A data dictionary that is hand-copied goes stale the first time a schema changes, and an
// attribution notice that is hand-copied goes stale the first time an event is crawled.
// Both are executable here instead: the dictionary is regenerated and compared byte for
// byte, the notice's event table is compared with the committed corpus, and the nine Cargo
// tables the build actually read are required to be named in the attribution.
//
// What is not checked is prose. A test can prove the guide mentions every file and every
// table; it cannot prove the sentence next to the mention is true. That is what the two
// readers in "Validation" of the ticket are for.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import { OUTPUTS } from "../build.ts";
import { renderCuratedDictionary } from "../dictionary.ts";
import { MANIFEST_FILE } from "../manifest.ts";
import { MODEL_TABLE_ORDER } from "../model.ts";
import { CURATED_DIR, REPO_ROOT } from "./helpers.ts";

const DOCS_DIR = path.join(REPO_ROOT, "docs", "dataset");
const DICTIONARY_FILE = path.join(DOCS_DIR, "curated-data-dictionary.md");
const GUIDE_FILE = path.join(DOCS_DIR, "using-the-dataset.md");
const NOTICE_FILE = path.join(REPO_ROOT, "licenses", "NOTICE.md");
const ATTRIBUTION_FILE = path.join(REPO_ROOT, "data", "ATTRIBUTION.md");

/** The curated files the dictionary documents: the build's registry plus the manifest. */
const DICTIONARY_INPUTS = [
	...Object.entries(OUTPUTS).map(([file, output]) => ({ file, schema: output.schema })),
	{ file: MANIFEST_FILE, schema: "manifest.schema.json" },
];

async function text(file: string): Promise<string> {
	return readFile(file, "utf8");
}

async function jsonl<T>(file: string): Promise<T[]> {
	return (await text(path.join(CURATED_DIR, file)))
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as T);
}

/** The notice's `| Event | Games | Series |` table, as cells. */
function eventTable(notice: string): string[][] {
	const section = notice.slice(notice.indexOf("Data source attribution"));
	const start = section.indexOf("| Event | Games | Series |");
	assert.ok(start >= 0, "the notice must carry the event table the attribution criterion is about");
	const rows: string[][] = [];
	for (const line of section.slice(start).split("\n").slice(1)) {
		if (!line.startsWith("|")) break;
		if (/^\|[\s|:-]+\|$/.test(line)) continue;
		rows.push(line.split("|").slice(1, -1).map((cell) => cell.trim()));
	}
	return rows;
}

test("the curated data dictionary is exactly a rebuild from the schemas and the committed records", async () => {
	const rebuilt = await renderCuratedDictionary(DICTIONARY_INPUTS);
	assert.equal(
		await text(DICTIONARY_FILE),
		rebuilt,
		"docs/dataset/curated-data-dictionary.md is stale — rebuild with: node tools/dataset/cli.ts dictionary",
	);
	assert.match(rebuilt, /node tools\/dataset\/cli\.ts dictionary/, "the dictionary says how to regenerate itself");
});

test("the dictionary documents every field, nested paths included, and marks what can be absent", async () => {
	const dictionary = await text(DICTIONARY_FILE);
	for (const input of DICTIONARY_INPUTS) {
		const schema = JSON.parse(await text(path.join(CURATED_DIR, "schema", input.schema))) as {
			properties?: Record<string, unknown>;
		};
		const properties = Object.keys(schema.properties ?? {});
		assert.ok(properties.length > 0, `${input.schema} declares no properties, so this check would prove nothing`);
		for (const field of properties) {
			assert.ok(dictionary.includes(`| \`${field}\` |`), `${input.file}: the field \`${field}\` must have a row`);
		}
	}
	// Nested paths, which a flat walk would lose, and the three presence states.
	assert.match(dictionary, /\| `sides\[\]\.teamId` \| string \| always \|/, "a nested field is documented by its path");
	assert.match(
		dictionary,
		/\| `draft\.sides\[\]\.picks\[\]\.championId` \| string \| when present \|/,
		"a field inside an optional object is not claimed to be in every record",
	);
	assert.match(dictionary, /\| `gold` \| number \| no \|/, "a measure the source can omit is marked absent-able");
	assert.match(dictionary, /never `null` and never `0`/, "the dictionary states what absence means");
});

test("the attribution notice names every event the corpus carries, with its committed counts", async () => {
	const rows = eventTable(await text(NOTICE_FILE));
	assert.ok(rows.length > 0, "the event table must have rows");
	const coverage = await jsonl<{ eventName: string; games: number }>("event-coverage.jsonl");
	const series = new Map<string, number>();
	for (const match of await jsonl<{ eventName: string }>("matches.jsonl")) {
		series.set(match.eventName, (series.get(match.eventName) ?? 0) + 1);
	}

	for (const event of coverage) {
		const named = rows.filter((row) => (row[0] ?? "").includes(event.eventName));
		assert.equal(named.length, 1, `${event.eventName} must appear exactly once in the notice's event table`);
		const [, games, matches] = named[0];
		assert.equal(Number.parseInt(games ?? "", 10), event.games, `${event.eventName}: the notice's game count must be the committed one`);
		assert.equal(
			Number.parseInt(matches ?? "", 10),
			series.get(event.eventName) ?? 0,
			`${event.eventName}: the notice's series count must be the committed one`,
		);
	}
	for (const row of rows) {
		assert.ok(
			coverage.some((event) => (row[0] ?? "").includes(event.eventName)),
			`the notice names ${JSON.stringify(row[0])}, which the committed corpus does not carry`,
		);
	}
});

test("the attribution states the licence, the source and every Cargo table the build read", async () => {
	const notice = await text(NOTICE_FILE);
	const attribution = await text(ATTRIBUTION_FILE);
	const guide = await text(GUIDE_FILE);
	const manifest = JSON.parse(await text(path.join(CURATED_DIR, MANIFEST_FILE))) as {
		payloads: { query: { tables: string } }[];
	};
	const tables = [...new Set(manifest.payloads.map((payload) => payload.query.tables))].sort();
	assert.ok(tables.length >= 5, "the manifest must name the tables the crawl read, or this check proves nothing");
	for (const table of tables) {
		assert.ok(attribution.includes(`\`${table}\``), `data/ATTRIBUTION.md must name the ${table} table the build read`);
		assert.ok(notice.includes(`\`${table}\``), `licenses/NOTICE.md must name the ${table} table the build read`);
	}
	for (const [name, body] of [
		["licenses/NOTICE.md", notice],
		["data/ATTRIBUTION.md", attribution],
		["docs/dataset/using-the-dataset.md", guide],
	] as const) {
		assert.match(body, /CC BY-SA 3\.0/, `${name} must state the licence`);
		assert.match(body, /https:\/\/lol\.fandom\.com/, `${name} must name and link the source`);
		assert.match(body, /fandom\.com\/licensing/, `${name} must link the licence text`);
	}
	// The obligations a reader inherits, and where the attribution came from in history.
	assert.match(attribution, /share derivative work alike/i, "the attribution must state the share-alike obligation");
	assert.match(attribution, /827d63f/, "the attribution must name the commit that started it");
	assert.match(guide, /827d63f/, "the guide must say where the attribution came from in history");
});

test("the guide names every committed file, every model table, and the rebuild commands", async () => {
	const guide = await text(GUIDE_FILE);
	for (const file of Object.keys(OUTPUTS)) {
		assert.ok(guide.includes(`\`${file}\``), `docs/dataset/using-the-dataset.md must name \`${file}\``);
	}
	assert.ok(guide.includes(`\`${MANIFEST_FILE}\``), "the guide must name the manifest");
	for (const table of MODEL_TABLE_ORDER) {
		assert.ok(guide.includes(`\`${table}\``), `the guide must name the model table \`${table}\``);
	}
	assert.ok(guide.includes("curated-data-dictionary.md"), "the guide must point at the curated dictionary");
	assert.ok(guide.includes("data/model/data-dictionary.md"), "the guide must point at the model dictionary");
	for (const command of [
		"node tools/dataset/cli.ts build",
		"node tools/dataset/cli.ts model",
		"node tools/dataset/cli.ts dictionary",
		"node tools/check.ts",
	]) {
		assert.ok(guide.includes(command), `the guide must show how to run \`${command}\``);
	}
	assert.match(guide, /throttl|75 s/, "the guide must state the rebuild's throttled cost honestly");
	assert.match(guide, /no aggregates|aggregates/i, "the guide must say what was never modelled");
});
