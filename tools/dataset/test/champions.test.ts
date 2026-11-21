// Champion attributes: the release date the registry already states (ticket 02).
//
// The date is the whole of this ticket, and it has three ways to be wrong rather than
// absent — a source stamp coarser than a day, two registry rows that disagree, and a
// value no date parser can read. Each fails the build instead of becoming a plausible
// date, because the dataset's promise is that a stated day is a day the source stated.
//
// The cases that need a broken source are built by editing a scratch copy of the recorded
// payloads, the way the rest of this suite does it: the build verifies each body against
// its sidecar's hash, and `savePayloadBody` refreshes that hash as the recorder does.

import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { buildDataset } from "../build.ts";
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

test("every champion carries the release date the registry states for its Riot id", async () => {
	const { identity } = await buildDataset({ rawDir: FIXTURE_RAW });
	const registry = new Map<number, unknown>();
	for (const file of await championPayloads(FIXTURE_RAW)) {
		for (const row of await readRows(file)) registry.set(Number(row.KeyInteger), row.ReleaseDate);
	}
	assert.equal(identity.champions.length, 171, "the fixtures carry 171 referenced champions");
	for (const champion of identity.champions) {
		assert.ok(champion.riotKey !== null, `${champion.name}: every fixture champion resolves to a Riot id`);
		assert.equal(champion.releaseDate, registry.get(champion.riotKey), `${champion.name}: the date must be the registry's own, not a derivation`);
		assert.match(String(champion.releaseDate), /^\d{4}-\d{2}-\d{2}$/, `${champion.name}: the date must be a calendar date`);
	}
	const ahri = identity.champions.find((champion) => champion.name === "Ahri");
	assert.equal(ahri?.releaseDate, "2011-12-14", "the ticket's worked example reads its own date");
});

test("a source date coarser than a day fails the build instead of being rounded", async () => {
	const dir = await fixtureCopy();
	try {
		for (const file of await championPayloads(dir)) {
			const rows = await readRows(file);
			let changed = false;
			for (const row of rows) {
				if (row.Name !== "Ahri") continue;
				row.ReleaseDate__precision = 2;
				changed = true;
			}
			if (changed) await savePayloadBody(file, JSON.stringify(rows));
		}
		await assert.rejects(
			() => buildDataset({ rawDir: dir }),
			/champion Ahri states ReleaseDate 2011-12-14 at precision 2, not day precision \(1\)/,
			"a month-precision stamp has no day to state, so the build must stop rather than invent one",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("two registry rows disagreeing on one champion's date fail the build, naming both payloads", async () => {
	const dir = await fixtureCopy();
	try {
		// The narrow pull is the payload whose champions are a strict subset of another's —
		// derived from the bytes, so a re-record cannot silently turn this into a no-op.
		const files = await championPayloads(dir);
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
		// Its first row is, by the subset relation above, a champion the wide pull also states.
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

test("a release date the source states but no parser can read fails the build", async () => {
	const dir = await fixtureCopy();
	try {
		const file = (await championPayloads(dir))[0];
		const rows = await readRows(file);
		for (const row of rows) if (row.Name === "Ahri") row.ReleaseDate = "sometime in 2011";
		await savePayloadBody(file, JSON.stringify(rows));
		await assert.rejects(
			() => buildDataset({ rawDir: dir }),
			/champion Ahri states ReleaseDate "sometime in 2011", which is not a calendar date/,
			"an unreadable value is a defect, not an absence",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a champion the registry does not carry omits the release date", async () => {
	const dir = await fixtureCopy();
	try {
		// A scoreboard row still cites Ahri, so removing the registry row mints the entity
		// instead of dropping it — which is exactly the case with no date to state.
		for (const file of await championPayloads(dir)) {
			const rows = (await readRows(file)).filter((row) => row.Name !== "Ahri");
			await savePayloadBody(file, JSON.stringify(rows));
		}
		const { identity } = await buildDataset({ rawDir: dir });
		const ahri = identity.champions.find((champion) => champion.name === "Ahri");
		assert.ok(ahri, "the entity is minted from the scoreboard string, not dropped");
		assert.equal(ahri.riotKey, null, "a minted champion has no Riot id");
		assert.ok(!("releaseDate" in ahri), "and no date to borrow: the key is absent, never empty or a sentinel");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
