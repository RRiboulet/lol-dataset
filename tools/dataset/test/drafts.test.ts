// Ticket 05's seam: recorded drafts in, per-game drafts with their fidelity out.
//
// Two sources are recorded. `PicksAndBansS7` carries numbered slots and a side-switch
// flag; `ScoreboardGames` carries only list-typed picks and bans, which are in role
// order and must therefore be emitted as unordered sets (spec R5). Every assertion
// below is made through buildDataset over the recorded bytes, with scratch copies for
// the cases a mutation has to express.

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import type { BuildResult } from "../build.ts";
import { buildDataset } from "../build.ts";
import type { GameRecord } from "../games.ts";
import { FIXTURE_RAW } from "./helpers.ts";

const DRAFT_DIR = path.join("lol-fandom", "cargoexport", "PicksAndBansS7");
const GAME_DIR = path.join("lol-fandom", "cargoexport", "ScoreboardGames");

let built: Promise<BuildResult> | undefined;
function build(): Promise<BuildResult> {
	built ??= buildDataset({ rawDir: FIXTURE_RAW });
	return built;
}

async function scratch(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-draft-"));
	await cp(FIXTURE_RAW, dir, { recursive: true });
	return dir;
}

/** Payload files under `root/<table>`, bodies only, in stable order. */
async function bodies(root: string, table: string): Promise<string[]> {
	const dir = path.join(root, ...(table === "draft" ? DRAFT_DIR.split(path.sep) : GAME_DIR.split(path.sep)));
	const names = (await readdir(dir)).filter((name) => name.endsWith(".json") && !name.endsWith(".meta.json")).sort();
	return names.map((name) => path.join(dir, name));
}

async function rows(file: string): Promise<Record<string, unknown>[]> {
	return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>[];
}

async function save(file: string, values: Record<string, unknown>[]): Promise<void> {
	await writeFile(file, `${JSON.stringify(values)}\n`, "utf8");
}

function gameById(result: BuildResult, id: string): GameRecord {
	const found = result.scoreboards.games.find((game) => game.source.gameId === id);
	assert.ok(found, `fixture game ${id} exists`);
	return found;
}

test("2023 games carry ordered slots, 2015 games carry unordered sets, and all champions resolve", async () => {
	const result = await build();
	const games = result.scoreboards.games;
	const ordered = games.filter((game) => game.draft?.fidelity === "ordered");
	const unordered = games.filter((game) => game.draft?.fidelity === "unordered");
	assert.equal(ordered.length, 110, "the recorded PicksAndBansS7 rows are joined to every 2023 game");
	assert.equal(unordered.length, 19, "the pre-2017 games fall back to the list fields");
	const championIds = new Set(result.identity.champions.map((champion) => champion.id));
	for (const game of games) {
		// The 2015 rows state five picks and three bans a side, so R6 calls them partial:
		// a coverage marker that called them complete would hide the missing ban slots.
		assert.equal(game.coverage.draft, game.draft?.fidelity === "ordered" ? "complete" : "partial", `${game.source.gameId}: honest draft coverage`);
		assert.ok(game.draft, `${game.source.gameId}: a draft is present`);
		assert.deepEqual(game.draft.sides.map((side) => side.side), ["blue", "red"]);
		for (const side of game.draft.sides) {
			for (const group of ["picks", "bans"] as const) {
				assert.equal(side[group].length, group === "picks" || game.draft.fidelity === "ordered" ? 5 : 3, `${game.source.gameId}: the source's ${group} count per side`);
				for (const entry of side[group]) {
					assert.ok(championIds.has(entry.championId), `${game.source.gameId}: ${entry.sourceChampion} has a canonical entity`);
					assert.equal(entry.championName.length > 0, true);
					if (game.draft.fidelity === "ordered") assert.equal(entry.slot, side[group].indexOf(entry) + 1, "slots are source numbers");
					else assert.ok(!("slot" in entry), "unordered entries never claim a slot");
				}
			}
		}
		if (game.draft.fidelity === "ordered") assert.equal(game.draft.switchedSides, false, "the 2023 rows all state 0");
	}
});

test("a source side-switch flag is carried on an ordered draft", async () => {
	const base = await build();
	const target = base.scoreboards.games.find((game) => game.draft?.fidelity === "ordered");
	assert.ok(target);
	const dir = await scratch();
	try {
		const files = await bodies(dir, "draft");
		let switchedFile = "";
		for (const file of files) {
			if ((await rows(file)).some((row) => row.SwitchedSides === 1)) {
				switchedFile = file;
				break;
			}
		}
		assert.ok(switchedFile, "the recorded fixture carries a side-switched row");
		const switchedSource = await rows(switchedFile);
		const switched = switchedSource.find((row) => row.SwitchedSides === 1);
		assert.ok(switched);
		// Leave the 2026 row recorded but unmatched, and carry its source facts onto the
		// real 2023 row: one drafted game, no duplicate payload for the same GameId.
		switched.GameId = "scratch-switched-row-not-a-game";
		await save(switchedFile, switchedSource);
		for (const file of files) {
			const source = await rows(file);
			const row = source.find((candidate) => candidate.GameId === target.source.gameId);
			if (row === undefined) continue;
			row.SwitchedSides = 1;
			for (const key of Object.keys(switched)) {
				if (/^Team[12](Pick|Ban)[1-5]$/.test(key)) row[key] = switched[key];
			}
			await save(file, source);
			break;
		}
		const result = await buildDataset({ rawDir: dir });
		const draft = gameById(result, target.source.gameId).draft;
		assert.equal(draft?.fidelity, "ordered");
		assert.equal(draft?.switchedSides, true, "the source's flag is a fact about the draft");
		assert.deepEqual(draft?.sides[0].picks.map((entry) => entry.slot), [1, 2, 3, 4, 5], "slots still round-trip");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("reordering slots changes only the ordered draft, never the unordered sets", async () => {
	const base = await build();
	const orderedGame = base.scoreboards.games.find((game) => game.draft?.fidelity === "ordered");
	const unorderedGame = base.scoreboards.games.find((game) => game.draft?.fidelity === "unordered");
	assert.ok(orderedGame && unorderedGame);
	const beforeOrdered = orderedGame.draft?.sides[0].picks.map((entry) => entry.championId);
	const beforeUnordered = unorderedGame.draft?.sides[0].picks.map((entry) => entry.championId);
	const dir = await scratch();
	try {
		for (const file of await bodies(dir, "draft")) {
			const source = await rows(file);
			const row = source.find((candidate) => candidate.GameId === orderedGame.source.gameId);
			if (row === undefined) continue;
			[row.Team1Pick1, row.Team1Pick2] = [row.Team1Pick2, row.Team1Pick1];
			await save(file, source);
			break;
		}
		for (const file of await bodies(dir, "game")) {
			const source = await rows(file);
			const row = source.find((candidate) => candidate.GameId === unorderedGame.source.gameId);
			if (row === undefined) continue;
			row.Team1Picks = [...(row.Team1Picks as unknown[])].reverse();
			await save(file, source);
			break;
		}
		const result = await buildDataset({ rawDir: dir });
		assert.notDeepEqual(gameById(result, orderedGame.source.gameId).draft?.sides[0].picks.map((entry) => entry.championId), beforeOrdered);
		assert.deepEqual(gameById(result, unorderedGame.source.gameId).draft?.sides[0].picks.map((entry) => entry.championId), beforeUnordered);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a duplicate champion in one side's picks stops the build, naming the game", async () => {
	const base = await build();
	const target = base.scoreboards.games.find((game) => game.draft?.fidelity === "ordered");
	assert.ok(target);
	const dir = await scratch();
	try {
		let changed = false;
		for (const file of await bodies(dir, "draft")) {
			const source = await rows(file);
			const row = source.find((candidate) => candidate.GameId === target.source.gameId);
			if (row === undefined) continue;
			row.Team1Pick2 = row.Team1Pick1;
			await save(file, source);
			changed = true;
			break;
		}
		assert.ok(changed);
		await assert.rejects(buildDataset({ rawDir: dir }), (error: Error) =>
			/target\.source\.gameId|draft champion|twice/.test(error.message) && /twice/.test(error.message),
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a missing pick is partial, and no draft data at all is unavailable", async () => {
	const dir = await scratch();
	try {
		for (const file of await bodies(dir, "game")) {
			const source = await rows(file);
			const row = source.find((candidate) => String(candidate.GameId).startsWith("IEM Season IX"));
			if (row === undefined) continue;
			delete row.Team1Picks;
			await save(file, source);
			break;
		}
		const result = await buildDataset({ rawDir: dir });
		const game = result.scoreboards.games.find((candidate) => String(candidate.source.gameId).startsWith("IEM Season IX"));
		assert.ok(game);
		assert.equal(game.coverage.draft, "partial");
		assert.equal(game.draft?.sides[0].picks.length, 0, "the absent list is not five empty slots");
		assert.equal(game.draft?.sides[1].picks.length, 5, "the other side is still stated");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a game with no draft at all says unavailable instead of emitting empty lists", async () => {
	const dir = await scratch();
	try {
		await rm(path.join(dir, ...DRAFT_DIR.split(path.sep)), { recursive: true, force: true });
		for (const file of await bodies(dir, "game")) {
			const source = await rows(file);
			for (const row of source) {
				for (const key of ["Team1Picks", "Team2Picks", "Team1Bans", "Team2Bans"]) delete row[key];
			}
			await save(file, source);
		}
		const result = await buildDataset({ rawDir: dir });
		const bare = result.scoreboards.games.find((game) => game.draft?.fidelity === "unordered");
		assert.equal(bare, undefined, "no draft object is emitted");
		for (const game of result.scoreboards.games) {
			assert.equal(game.coverage.draft, "unavailable", `${game.source.gameId}: explicitly unavailable`);
			assert.ok(!("draft" in game));
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
