// Tournament distinctions, at the build seam (ticket 03 of the enrichment series).
//
// The recorded fixtures carry the two measured shapes: an event whose awards sit on its
// own page (`2016 Mid-Season Invitational`, six rows) and one whose awards sit on a stage
// sub-page (`2024 Season World Championship/Main Event`, one row). Between them they also
// carry the three resolution cases the source actually produces — a player named by a page
// (`Faker`), a lowercase handle (`xiaohu`, `mlxg`), and a team string that is a legacy name
// (`SKT T1` -> `T1`).
//
// The cases that need a broken source edit a scratch copy of the payloads, as the rest of
// this suite does: the build verifies each body against its sidecar's hash, and
// `savePayloadBody` refreshes that hash as the recorder does.

import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { buildDataset } from "../build.ts";
import { validateAgainst } from "../validate.ts";
import { CURATED_DIR, FIXTURE_RAW, isPayloadBody, readPayloadBodyFile, savePayloadBody, SCHEMA_DIR } from "./helpers.ts";

const TABLE = "IndividualAchievements";

async function fixtureCopy(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-honours-"));
	await cp(FIXTURE_RAW, dir, { recursive: true });
	return dir;
}

async function payloadFiles(root: string): Promise<string[]> {
	const dir = path.join(root, "lol-fandom", "cargoexport", TABLE);
	const names = (await readdir(dir)).filter(isPayloadBody);
	assert.ok(names.length > 0, `expected a recorded ${TABLE} payload`);
	return names.sort().map((name) => path.join(dir, name));
}

async function readRows(file: string): Promise<Record<string, unknown>[]> {
	return JSON.parse(await readPayloadBodyFile(file)) as Record<string, unknown>[];
}

/** Apply `edit` to every payload of the table, saving the ones it changed. */
async function editRows(root: string, edit: (rows: Record<string, unknown>[]) => boolean): Promise<void> {
	for (const file of await payloadFiles(root)) {
		const rows = await readRows(file);
		if (edit(rows)) await savePayloadBody(file, JSON.stringify(rows));
	}
}

async function guard(): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path.join(SCHEMA_DIR, "honour.schema.json"), "utf8")) as Record<string, unknown>;
}

test("the recorded distinctions resolve to an event, a player, and the team the registry knows", async () => {
	const { honours, files } = await buildDataset({ rawDir: FIXTURE_RAW });
	assert.equal(honours.length, 7, "the fixtures carry six awards at MSI 2016 and one at Worlds 2024");

	// The MVP row: a page-name player, a legacy team string that resolves to the current
	// entity, and the title exactly as the source words it.
	const mvp = honours.find((row) => row.title === "MVP");
	assert.ok(mvp, "the fixtures carry the MSI 2016 MVP");
	assert.equal(mvp.playerName, "Faker");
	assert.equal(mvp.eventName, "MSI 2016");
	assert.equal(mvp.sourcePlayer, "Faker");
	assert.equal(mvp.team, "SKT T1", "the source's string stays on the row");
	assert.equal(mvp.teamName, "T1", "and the registry resolves it to the entity it denotes");
	assert.equal(mvp.type, "Season Award", "the award type is the source's own value");

	// The sub-page row belongs to the event, not to an event of its own.
	const finals = honours.find((row) => row.title === "Finals MVP");
	assert.ok(finals, "the fixtures carry the Worlds 2024 finals MVP");
	assert.equal(finals.sourcePage, "2024 Season World Championship/Main Event", "the record keeps the page it was stated on, for provenance");
	assert.equal(finals.eventName, "Worlds 2024", "a stage page is collected under its parent event");
	assert.equal(finals.eventId, "evt-7f2d7d6e4ffa");

	// Identity: the lowercase handle resolves to the capitalised one.
	const handle = honours.find((row) => row.sourcePlayer === "xiaohu");
	assert.equal(handle?.playerName, "Xiaohu", "a handle resolves to the player's current one");

	// Shape: unique, sorted, and every row satisfies its checked-in schema.
	const ids = honours.map((row) => row.id);
	assert.equal(new Set(ids).size, ids.length, "one id per distinction");
	assert.deepEqual(ids, [...ids].sort(), "the file is sorted by id");
	const checked = await guard();
	for (const row of honours) assert.deepEqual(validateAgainst(checked, row, "honour.schema.json"), []);
	assert.ok(files["honours.jsonl"].endsWith("\n"));
});

test("an award stated outside the admitted events stops the build", async () => {
	const dir = await fixtureCopy();
	try {
		await editRows(dir, (rows) => {
			let changed = false;
			for (const row of rows) {
				row.OverviewPage = "LCS/2016 Season/Spring Season";
				changed = true;
			}
			return changed;
		});
		await assert.rejects(
			() => buildDataset({ rawDir: dir }),
			/LCS\/2016 Season\/Spring Season: a distinction is stated under no admitted event/,
			"a regional season award is not this dataset's to carry",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a player named only by an award is emitted and reported, not dropped", async () => {
	const dir = await fixtureCopy();
	try {
		await editRows(dir, (rows) => {
			const row = rows.find((candidate) => candidate.Display === "MVP");
			if (row === undefined) return false;
			row.Player = "Nobody Coach";
			row.Link = null;
			row.Team = null;
			return true;
		});
		const { honours, files } = await buildDataset({ rawDir: dir });
		const award = honours.find((row) => row.title === "MVP");
		assert.equal(award?.playerName, "Nobody Coach", "the entity is minted from the award's own string");
		assert.equal(award?.team, undefined, "an absent team states nothing");
		assert.equal(award?.teamId, undefined, "and resolves to no entity");
		assert.ok(files["players.jsonl"].includes("Nobody Coach"), "a player no game row names is still an emitted player");
		assert.ok(files["identity-unresolved.jsonl"].includes("Nobody Coach"), "and the report says the registries do not carry them");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a team string the registry cannot resolve is carried, and mints no team", async () => {
	const dir = await fixtureCopy();
	try {
		await editRows(dir, (rows) => {
			const row = rows.find((candidate) => candidate.Display === "MVP");
			if (row === undefined) return false;
			row.Team = "Nonexistent Esports";
			return true;
		});
		const { honours, files } = await buildDataset({ rawDir: dir });
		const award = honours.find((row) => row.title === "MVP");
		assert.equal(award?.team, "Nonexistent Esports", "the source's string is carried");
		assert.equal(award?.teamId, undefined, "no entity to point at");
		assert.ok(!files["teams.jsonl"].includes("Nonexistent Esports"), "an award is context, not evidence a team existed");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("two payloads carrying the same award produce one row", async () => {
	const dir = await fixtureCopy();
	try {
		// A second copy of the same query's payload: the cache key differs, the rows do not.
		const [file] = await payloadFiles(dir);
		const copy = path.join(path.dirname(file), "aaaaaaaaaaaaaaaaaaaaaaaa.json.gz");
		await writeFile(copy, await readFile(file));
		await writeFile(copy.replace(/\.json\.gz$/, ".meta.json"), await readFile(file.replace(/\.json\.gz$/, ".meta.json")));
		const { honours } = await buildDataset({ rawDir: dir });
		assert.equal(honours.length, 7, "the same award twice is one distinction");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
