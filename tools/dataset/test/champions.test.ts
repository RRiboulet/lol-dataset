// Champion attributes: the release date the registry already states (ticket 02).
//
// The date is the whole of this ticket, and it has four ways to be wrong rather than
// absent — a source stamp coarser than a day, two registry rows that disagree, a value no
// parser can read, and a value that looks like a date but is not a day (`0000-00-00`,
// `2010-02-31`). Each fails the build instead of becoming a plausible date, because the
// dataset's promise is that a stated day is a day the source stated.
//
// The cases that need a broken source are built by editing a scratch copy of the recorded
// payloads, the way the rest of this suite does it: the build verifies each body against
// its sidecar's hash, and `savePayloadBody` refreshes that hash as the recorder does.

import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { buildDataset } from "../build.ts";
import { buildModel, loadModelInput } from "../model.ts";
import { FIXTURE_RAW, isPayloadBody, readPayloadBodyFile, savePayloadBody } from "./helpers.ts";

async function fixtureCopy(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-champions-"));
	await cp(FIXTURE_RAW, dir, { recursive: true });
	return dir;
}

async function championPayloads(root: string): Promise<string[]> {
	const dir = path.join(root, "lol-fandom", "cargoexport", "Champions");
	const names = (await readdir(dir)).filter(isPayloadBody);
	assert.ok(names.length > 0, "expected a recorded Champions payload");
	return names.sort().map((name) => path.join(dir, name));
}

async function readRows(file: string): Promise<Record<string, unknown>[]> {
	return JSON.parse(await readPayloadBodyFile(file)) as Record<string, unknown>[];
}

/**
 * The narrow Champions pull: the payload whose champions are a strict subset of another's.
 *
 * Derived from the bytes rather than from a row count or a file name, so a re-record
 * cannot silently turn the cases built on it into no-ops.
 */
async function narrowChampionPayload(root: string): Promise<string> {
	const files = await championPayloads(root);
	const keys = new Map<string, Set<number>>();
	for (const file of files) keys.set(file, new Set((await readRows(file)).map((row) => Number(row.KeyInteger))));
	const narrow = files.find((file) => {
		const mine = keys.get(file) as Set<number>;
		return files.some((other) => {
			const theirs = keys.get(other) as Set<number>;
			return theirs.size > mine.size && [...mine].every((key) => theirs.has(key));
		});
	});
	assert.ok(narrow, "the fixtures must carry a narrow Champions pull beside the registry-wide one");
	return narrow;
}

/** Rewrite one champion's `ReleaseDate` (and precision) in every payload that states it. */
async function restate(root: string, champion: string, stated: string, precision: number): Promise<void> {
	for (const file of await championPayloads(root)) {
		const rows = await readRows(file);
		let changed = false;
		for (const row of rows) {
			if (row.Name !== champion) continue;
			row.ReleaseDate = stated;
			row.ReleaseDate__precision = precision;
			changed = true;
		}
		if (changed) await savePayloadBody(file, JSON.stringify(rows));
	}
}

test("every champion carries the release date the registry states for its Riot id", async () => {
	const { identity } = await buildDataset({ rawDir: FIXTURE_RAW });
	const registry = new Map<number, unknown>();
	for (const file of await championPayloads(FIXTURE_RAW)) {
		for (const row of await readRows(file)) registry.set(Number(row.KeyInteger), row.ReleaseDate);
	}
	assert.ok(identity.champions.length > 0, "the fixtures must carry referenced champions");
	for (const champion of identity.champions) {
		assert.ok(champion.riotKey !== null, `${champion.name}: every fixture champion resolves to a Riot id`);
		assert.ok(champion.releaseDate !== undefined, `${champion.name}: the payloads must state a date; a narrow pull that drops the column is a cache defect`);
		assert.equal(champion.releaseDate, registry.get(champion.riotKey), `${champion.name}: the date must be the registry's own, not a derivation`);
		assert.match(String(champion.releaseDate), /^\d{4}-\d{2}-\d{2}$/, `${champion.name}: the date must be a calendar date`);
	}
	const ahri = identity.champions.find((champion) => champion.name === "Ahri");
	assert.equal(ahri?.releaseDate, "2011-12-14", "the ticket's worked example reads its own date");
});

test("a source date coarser than a day fails the build instead of being rounded", async () => {
	const dir = await fixtureCopy();
	try {
		// The precision marker is checked before the value is judged: a coarser stamp
		// changes the *shape* of the value too (`2011-12`), and reporting that as
		// unparseable would name the wrong defect.
		await restate(dir, "Ahri", "2011-12", 2);
		await assert.rejects(
			() => buildDataset({ rawDir: dir }),
			/champion Ahri states ReleaseDate "2011-12" at precision 2, not day precision \(1\)/,
			"a month-precision stamp has no day to state, so the build must stop rather than invent one",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("two registry rows disagreeing on one champion's date fail the build, naming both payloads", async () => {
	const dir = await fixtureCopy();
	try {
		const narrow = await narrowChampionPayload(dir);
		// Its first row is, by the subset relation, a champion the wide pull also states.
		const rows = await readRows(narrow);
		const champion = String(rows[0].Name);
		const stated = String(rows[0].ReleaseDate);
		rows[0].ReleaseDate = "2001-01-01";
		await savePayloadBody(narrow, JSON.stringify(rows));

		await assert.rejects(() => buildDataset({ rawDir: dir }), (error: Error) => {
			const message = error.message;
			for (const needle of [champion, path.basename(narrow), stated, "2001-01-01", "one champion cannot have two"]) {
				assert.ok(message.includes(needle), `the error must name ${needle}: ${message}`);
			}
			return true;
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a payload that does not ask for the date is silent about it, not disagreeing", async () => {
	const dir = await fixtureCopy();
	try {
		const narrow = await narrowChampionPayload(dir);
		const rows = await readRows(narrow);
		const champion = String(rows[0].Name);
		const stated = String(rows[0].ReleaseDate);
		for (const row of rows) {
			delete row.ReleaseDate;
			delete row.ReleaseDate__precision;
		}
		await savePayloadBody(narrow, JSON.stringify(rows));

		// The registry-wide pull still states the day, so the value travels and the build
		// succeeds: an absence loses to a stated value, the way `Teams.Short` already does.
		const { identity } = await buildDataset({ rawDir: dir });
		const found = identity.champions.find((entry) => entry.name === champion);
		assert.equal(found?.releaseDate, stated, "the payload that states the date must supply it");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a day that does not exist is a defect, not a date", async () => {
	// Shape is not existence: the zero-date sentinel SQL and Cargo both write, an
	// impossible day, an impossible month and an instant all pass a `\d{4}-\d{2}-\d{2}`
	// prefix and none of them is a day a reader could parse.
	for (const stated of ["0000-00-00", "2010-02-31", "2010-13-01", "2011-12-14T00:00:00Z"]) {
		const dir = await fixtureCopy();
		try {
			await restate(dir, "Ahri", stated, 1);
			const pattern = new RegExp(`champion Ahri states ReleaseDate ${JSON.stringify(stated).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, which is not a calendar day`);
			await assert.rejects(() => buildDataset({ rawDir: dir }), pattern, `${stated} must not become a release date`);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}
});

test("a release date the source states but no parser can read fails the build", async () => {
	const dir = await fixtureCopy();
	try {
		await restate(dir, "Ahri", "sometime in 2011", 1);
		await assert.rejects(
			() => buildDataset({ rawDir: dir }),
			/champion Ahri states ReleaseDate "sometime in 2011", which is not a calendar day/,
			"an unreadable value is a defect, not an absence",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a champion the registry does not carry omits the release date, and the model writes empty", async () => {
	const dir = await fixtureCopy();
	const curated = await mkdtemp(path.join(tmpdir(), "dataset-champions-model-"));
	try {
		// A scoreboard row still cites Ahri, so removing the registry row mints the entity
		// instead of dropping it — exactly the case with no date to state.
		for (const file of await championPayloads(dir)) {
			const rows = (await readRows(file)).filter((row) => row.Name !== "Ahri");
			await savePayloadBody(file, JSON.stringify(rows));
		}
		const built = await buildDataset({ rawDir: dir });
		const ahri = built.identity.champions.find((champion) => champion.name === "Ahri");
		assert.ok(ahri, "the entity is minted from the scoreboard string, not dropped");
		assert.equal(ahri.riotKey, null, "a minted champion has no Riot id");
		assert.ok(!("releaseDate" in ahri), "and no date to borrow: the key is absent, never empty or a sentinel");

		// The model is derived from the files, so write this build's curated layer out and
		// model it: the row has to carry the empty column, not a placeholder day.
		await mkdir(curated, { recursive: true });
		for (const [file, text] of Object.entries(built.files)) await writeFile(path.join(curated, file), text, "utf8");
		const model = buildModel(await loadModelInput(curated));
		const row = model.tables
			.find((table) => table.name === "dim_champion")
			?.rows.find((entry) => entry.champion_name === "Ahri");
		assert.ok(row, "the minted champion must be in dim_champion");
		assert.equal(row.release_date, "", "an absent date is the empty column the dictionary documents");
	} finally {
		await rm(dir, { recursive: true, force: true });
		await rm(curated, { recursive: true, force: true });
	}
});
