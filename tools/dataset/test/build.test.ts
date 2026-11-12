// The build seam: recorded payloads -> bytes (spec test seam S1, ticket 01).
//
// Two kinds of assertion, both about the artifact rather than about a mock:
//   - the emitted files say what the ticket promises (sorted, named, schema-valid);
//   - a rebuild of the committed data is byte-identical, so `data/curated/` cannot
//     drift from the fixtures and the rule without a test failing.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { buildDataset, writeDataset } from "../build.ts";
import { CURATED_DIR, DATASET_DIR, FIXTURE_RAW, SCHEMA_DIR } from "./helpers.ts";

const run = promisify(execFile);

/** Path of the recorded payload that carries `page`, so a test need not know file names. */
async function payloadContaining(page: string): Promise<string> {
	const source = path.join(FIXTURE_RAW, "lol-fandom", "cargoexport");
	for (const name of await readdir(source)) {
		if (!name.endsWith(".json") || name.endsWith(".meta.json")) continue;
		const file = path.join(source, name);
		const rows = JSON.parse(await readFile(file, "utf8")) as { OverviewPage?: string }[];
		if (rows.some((row) => row.OverviewPage === page)) return file;
	}
	throw new Error(`no recorded payload carries ${page}`);
}

async function fixtureBuild(): Promise<Awaited<ReturnType<typeof buildDataset>>> {
	return buildDataset({ rawDir: FIXTURE_RAW });
}

test("the build emits one record per selected event, sorted by canonical ID", async () => {
	const { events } = await fixtureBuild();
	assert.ok(events.length > 0, "the fixtures must select something");
	const ids = events.map((event) => event.id);
	assert.deepEqual(ids, [...ids].sort(), "records must be sorted by ID");
	assert.equal(new Set(ids).size, ids.length, "IDs must be unique");
	for (const event of events) {
		assert.match(event.id, /^evt-[0-9a-f]{12}$/);
		assert.ok(event.name.length > 0, `${event.id} must carry a display name (R12)`);
		assert.ok(event.overviewPage.length > 0, `${event.id} must carry its source page (R12)`);
	}
});

test("the event file reads without decoding identifiers", async () => {
	const { events } = await fixtureBuild();
	const byPage = new Map(events.map((event) => [event.overviewPage, event]));
	const worlds = byPage.get("2023 Season World Championship");
	assert.ok(worlds, "Worlds 2023 must be selected");
	assert.equal(worlds.name, "Worlds 2023");
	assert.equal(worlds.league, "World Championship");
	assert.equal(worlds.year, 2023);
	assert.deepEqual(worlds.selection, { rule: "admitted", key: "worlds" });
});

test("the rejection is visible: every considered event has a decision in the report", async () => {
	const { events, selection } = await fixtureBuild();
	assert.ok(selection.length > events.length, "the fixtures must contain rejections to be worth checking");
	const included = selection.filter((record) => record.decision === "included");
	assert.deepEqual(
		included.map((record) => record.id),
		events.map((event) => event.id),
		"the report's includes and the entity file must agree, in the same order",
	);
	const rejected = selection.filter((record) => record.decision === "rejected");
	assert.ok(rejected.length > 0);
	for (const record of rejected) assert.ok(record.key.length > 0, `${record.name} must record which clause rejected it`);
});

test("the committed dataset is exactly a rebuild of the committed fixtures", async () => {
	const result = await fixtureBuild();
	for (const [file, body] of Object.entries(result.files) as [keyof typeof result.files, string][]) {
		const committed = await readFile(path.join(CURATED_DIR, file), "utf8");
		assert.equal(committed, body, `data/curated/${file} is stale — rebuild it with: node tools/dataset/cli.ts build --raw tools/dataset/fixtures/raw`);
	}
});

test("the command builds the same bytes twice, in two directories", async () => {
	const dirs = await Promise.all([mkdtemp(path.join(tmpdir(), "dataset-a-")), mkdtemp(path.join(tmpdir(), "dataset-b-"))]);
	try {
		const cli = path.join(DATASET_DIR, "cli.ts");
		const args = ["--raw", FIXTURE_RAW, "--out"];
		for (const dir of dirs) {
			await run(process.execPath, [cli, "build", ...args, dir], { cwd: DATASET_DIR });
		}
		for (const file of ["events.jsonl", "event-selection.jsonl"]) {
			const [a, b] = await Promise.all(dirs.map((dir) => readFile(path.join(dir, file), "utf8")));
			assert.equal(a, b, `${file} differed between two runs over the same fixtures`);
		}
		// A third run in the same directory must not change anything either.
		const before = await Promise.all(dirs.map((dir) => readFile(path.join(dir, "events.jsonl"), "utf8")));
		await run(process.execPath, [cli, "build", ...args, dirs[0]], { cwd: DATASET_DIR });
		assert.equal(await readFile(path.join(dirs[0], "events.jsonl"), "utf8"), before[0]);
	} finally {
		await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
	}
});

test("`--check` reports drift instead of rewriting it", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-check-"));
	try {
		await run(process.execPath, [path.join(DATASET_DIR, "cli.ts"), "build", "--raw", FIXTURE_RAW, "--out", dir], { cwd: DATASET_DIR });
		await run(process.execPath, [path.join(DATASET_DIR, "cli.ts"), "build", "--raw", FIXTURE_RAW, "--out", dir, "--check"], { cwd: DATASET_DIR });
		// One hand-edit, the way a merge or an editor would do it.
		const file = path.join(dir, "events.jsonl");
		await writeFile(file, (await readFile(file, "utf8")).replace('"name":"IPL 5"', '"name":"IPL Five"'), "utf8");
		await assert.rejects(
			run(process.execPath, [path.join(DATASET_DIR, "cli.ts"), "build", "--raw", FIXTURE_RAW, "--out", dir, "--check"], { cwd: DATASET_DIR }),
			/(does not match a rebuild|differs at line)/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the same recorded bytes under two cache keys are one event, not two", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-dup-"));
	try {
		const source = await payloadContaining("2023 Season World Championship");
		await cp(source, path.join(dir, "copy-a.json"));
		await cp(source, path.join(dir, "copy-b.json"));
		const result = await buildDataset({ rawDir: dir });
		const baseline = await fixtureBuild();
		// Only the payload under this temp dir is seen, so this proves dedupe by page
		// rather than by file: two files, one record per event.
		const unique = new Set(result.events.map((event) => event.overviewPage));
		assert.equal(result.events.length, unique.size);
		assert.ok(result.events.some((event) => event.overviewPage === "2023 Season World Championship"));
		assert.ok(baseline.events.length >= result.events.length);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("two payloads that disagree about the same page fail the build, naming both files", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-conflict-"));
	try {
		const source = await payloadContaining("2023 Season World Championship");
		const body = JSON.parse(await readFile(source, "utf8")) as { OverviewPage: string; Name: string }[];
		const worlds = body.find((row) => row.OverviewPage === "2023 Season World Championship");
		assert.ok(worlds);
		await cp(source, path.join(dir, "a.json"));
		worlds.Name = "A Different Name For The Same Page";
		await writeFile(path.join(dir, "b.json"), JSON.stringify(body), "utf8");
		await assert.rejects(buildDataset({ rawDir: dir }), /2023 Season World Championship: .* disagree about the same page/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an empty cache fails instead of emitting an empty dataset", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-empty-"));
	try {
		await assert.rejects(buildDataset({ rawDir: dir }), /no recorded payloads/);
		await assert.rejects(buildDataset({ rawDir: path.join(dir, "missing") }), /no recorded payloads/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("output that violates the checked-in schema fails the build", async () => {
	// Tear the schema, not the data: the build must notice. This is what proves
	// validation is wired rather than decorative.
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-schema-"));
	try {
		const schemas = await readdir(SCHEMA_DIR);
		for (const name of schemas) await cp(path.join(SCHEMA_DIR, name), path.join(dir, name));
		const eventSchema = JSON.parse(await readFile(path.join(dir, "event.schema.json"), "utf8")) as { required: string[] };
		eventSchema.required = [...eventSchema.required, "season"];
		await writeFile(path.join(dir, "event.schema.json"), JSON.stringify(eventSchema), "utf8");
		await assert.rejects(buildDataset({ rawDir: FIXTURE_RAW, schemaDir: dir }), /missing required field "season"/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("writeDataset is what the committed files are made of", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-write-"));
	try {
		const result = await fixtureBuild();
		await writeDataset(result, dir);
		assert.deepEqual((await readdir(dir)).sort(), Object.keys(result.files).sort());
		for (const [file, body] of Object.entries(result.files)) {
			assert.equal(await readFile(path.join(dir, file), "utf8"), body);
			assert.ok(body.endsWith("\n"), `${file} must end with a newline`);
			assert.ok(!body.startsWith("\uFEFF"), `${file} must not carry a BOM`);
			assert.ok(!body.includes("\r"), `${file} must use LF endings`);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
