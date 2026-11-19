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
import type { CargoQuery } from "../cache.ts";
import { writePayload } from "../cache.ts";
import type { GameRecord } from "../games.ts";
import { FIXTURE_RAW, isPayloadBody, readPayloadBodyFile, savePayloadBody, sidecarPath } from "./helpers.ts";

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
	const names = (await readdir(dir)).filter(isPayloadBody).sort();
	return names.map((name) => path.join(dir, name));
}

async function rows(file: string): Promise<Record<string, unknown>[]> {
	return JSON.parse(await readPayloadBodyFile(file)) as Record<string, unknown>[];
}

/** The recorded payload of `table` that carries a row `matches` accepts. */
async function payloadWith(root: string, table: string, matches: (row: Record<string, unknown>) => boolean): Promise<string> {
	for (const file of await bodies(root, table)) {
		if ((await rows(file)).some(matches)) return file;
	}
	throw new Error(`no recorded ${table} payload carries that row`);
}

async function save(file: string, values: Record<string, unknown>[]): Promise<void> {
	await savePayloadBody(file, `${JSON.stringify(values)}\n`);
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
	assert.equal(
		ordered.length,
		2450,
		"every game with a recorded PicksAndBansS7 row: the table starts in 2017, so the ordered-draft era (Worlds, MSI, Rift Rivals, the Mid-Season Cup, the Esports World Cups, First Stand) is ordered and everything before it is not",
	);
	assert.equal(
		unordered.length,
		641,
		"the rest fall back to the list fields: every pre-2017 game (IPL 5, IEM, WCG, Worlds 2011-2016) plus the Mid-Season Cup's 3 declared blind picks, which have no ordered row",
	);
	const championById = new Map(result.identity.champions.map((champion) => [champion.id, champion]));
	const championIds = new Set(championById.keys());
	// The source writes `None` for an unused draft slot (measured on one MSI 2023 ban), and
	// that slot must be absent rather than a champion called `None`. It is the only
	// ordered game whose draft is therefore partial, which is the honest marker.
	const NONE_SLOT_GAME = "2023 Mid-Season Invitational_Bracket Round 1_4_3";
	// The same placeholder in the unordered path, measured on an IPL 5 2012 row: this game's
	// `Team2Bans` ends with `None`, so its red side carries two bans rather than three.
	const NONE_UNORDERED_GAME = "IGN ProLeague Season 5_Loser's Round 2 (1)_2_1";
	for (const game of games) {
		// The pre-2017 rows state five picks and at most three bans a side, so R6 calls them
		// partial: a coverage marker that called them complete would hide the missing slots.
		// A declared blind pick is complete with five picks and no bans, because the ban
		// phase does not exist there (ticket 10).
		// The marker is checked by its *claim*, not by a second copy of the rule: `complete`
		// means every slot is there (asserted per side below), `partial` means a draft with
		// slots missing, and the two measured `None` placeholders are the case that proves it.
		if (game.source.gameId === NONE_SLOT_GAME || game.source.gameId === NONE_UNORDERED_GAME) {
			assert.equal(game.coverage.draft, "partial", `${game.source.gameId}: the source's None placeholder makes it partial`);
		}
		assert.ok(["complete", "partial"].includes(game.coverage.draft), `${game.source.gameId}: a draft is present, so not unavailable`);
		assert.ok(game.draft, `${game.source.gameId}: a draft is present`);
		assert.deepEqual(game.draft.sides.map((side) => side.side), ["blue", "red"]);
		for (const side of game.draft.sides) {
			for (const group of ["picks", "bans"] as const) {
				const placeholder = side.side === "red" && group === "bans" && (game.source.gameId === NONE_SLOT_GAME || game.source.gameId === NONE_UNORDERED_GAME);
				// The corpus states up to five slots a side; a declared blind pick states no
				// bans at all, and the two measured `None` placeholders leave four bans (ordered)
				// or two (unordered) on the red side. A complete draft is exactly five picks and
				// the group's full width, which is what the coverage marker promises.
				const stated = side[group].length;
				assert.ok(stated <= 5, `${game.source.gameId}: at most five ${group} a side (got ${stated})`);
				if (group === "bans" && game.draft.blindPick === true) {
					assert.equal(stated, 0, `${game.source.gameId}: a blind pick states no bans`);
				}
				if (placeholder) assert.equal(stated, group === "bans" ? (game.draft.fidelity === "ordered" ? 4 : 2) : 5, `${game.source.gameId}: the measured placeholder leaves ${group} one short`);
				if (game.coverage.draft === "complete") {
					assert.equal(stated, group === "bans" ? (game.draft.blindPick === true ? 0 : 5) : 5, `${game.source.gameId}: a complete draft states every ${group} slot`);
				}
				for (const entry of side[group]) {
					assert.ok(championIds.has(entry.championId), `${game.source.gameId}: ${entry.sourceChampion} has a canonical entity`);
					assert.notEqual(championById.get(entry.championId)?.riotKey, null, `${entry.sourceChampion} is anchored on Riot's id, not a display string`);
					assert.equal(entry.championName.length > 0, true);
					// Slots are the source's own numbers, in order. A placeholder slot is absent,
					// so the sequence may skip one (measured: MSI `Team2Ban4` is `None`).
					if (game.draft.fidelity === "ordered") {
						const previous = side[group][side[group].indexOf(entry) - 1]?.slot ?? 0;
						assert.ok((entry.slot ?? 0) > previous, `${game.source.gameId}: slots ascend`);
					}
					else assert.ok(!("slot" in entry), "unordered entries never claim a slot");
				}
			}
		}
		// The source states the flag per ordered row: false on most, true where it swapped the
		// pick/ban table's Team1 (measured on 2023 rows), so the value is carried, not normalised.
		if (game.draft.fidelity === "ordered") assert.equal(typeof game.draft.switchedSides, "boolean", `${game.source.gameId}: the source's side-switch flag`);
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
			error.message.includes(target.source.gameId) && /twice/.test(error.message),
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a missing pick is partial, and no draft data at all is unavailable", async () => {
	const dir = await scratch();
	try {
		// Every payload that carries an IEM 2015 game: two recorded queries can overlap, and
		// editing one copy would leave the other stating the picks (a stale disagreement).
		let edited = 0;
		for (const file of await bodies(dir, "game")) {
			const source = await rows(file);
			let changed = false;
			for (const row of source) {
				if (!String(row.GameId).startsWith("IEM Season IX")) continue;
				delete row.Team1Picks;
				changed = true;
				edited += 1;
			}
			if (changed) await save(file, source);
		}
		assert.ok(edited > 0, "the corpus carries IEM 2015 games");
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
		// The declared contradicted drafts keep their rows: their declarations are checked
		// against the corpus, so stripping them would fail as a stale declaration instead of
		// testing "no draft data at all".
		const DECLARED = [
			/^Season 3 World Championship_Day 6_2_1$/,
			/^IEM Season VII - World Championship_Group A_5_1$/,
			/^IEM Season VII - World Championship_Group A_6_1$/,
		];
		for (const file of await bodies(dir, "game")) {
			const source = await rows(file);
			for (const row of source) {
				if (DECLARED.some((pattern) => pattern.test(String(row.GameId)))) continue;
				for (const key of ["Team1Picks", "Team2Picks", "Team1Bans", "Team2Bans"]) delete row[key];
			}
			await save(file, source);
		}
		const result = await buildDataset({ rawDir: dir });
		// The declared contradicted drafts keep their picks (their declarations are checked
		// against the corpus), so they are the only games still carrying a draft here.
		const declared = (game: { source: { gameId: string } }) =>
			[
				/^Season 3 World Championship_Day 6_2_1$/,
				/^IEM Season VII - World Championship_Group A_5_1$/,
				/^IEM Season VII - World Championship_Group A_6_1$/,
			].some((pattern) =>
				pattern.test(game.source.gameId),
			);
		for (const game of result.scoreboards.games) {
			if (declared(game)) continue;
			assert.equal(game.coverage.draft, "unavailable", `${game.source.gameId}: explicitly unavailable`);
			assert.ok(!("draft" in game), `${game.source.gameId}: no draft object is emitted`);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an empty ordered row cannot hide the list picks the source still states", async () => {
	const base = await build();
	const target = base.scoreboards.games.find((game) => game.draft?.fidelity === "ordered");
	assert.ok(target);
	const expected = target.draft?.sides[0].picks.map((entry) => entry.sourceChampion);
	const dir = await scratch();
	try {
		let changed = false;
		for (const file of await bodies(dir, "draft")) {
			const source = await rows(file);
			const row = source.find((candidate) => candidate.GameId === target.source.gameId);
			if (row === undefined) continue;
			for (const key of Object.keys(row)) {
				if (/^Team[12](Pick|Ban)[1-5]$/.test(key)) delete row[key];
			}
			await save(file, source);
			changed = true;
			break;
		}
		assert.ok(changed);
		const result = await buildDataset({ rawDir: dir });
		const game = gameById(result, target.source.gameId);
		assert.equal(game.draft?.fidelity, "unordered", "the list fields answer when the ordered row is empty");
		assert.notEqual(game.coverage.draft, "unavailable", "real picks are not relabelled as no draft");
		assert.deepEqual(game.draft?.sides[0].picks.map((entry) => entry.sourceChampion).sort(), [...(expected ?? [])].sort());
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a champion repeated anywhere in a draft fails the build, naming the game", async () => {
	const base = await build();
	const target = base.scoreboards.games.find((game) => game.draft?.fidelity === "ordered");
	assert.ok(target);
	for (const mutate of ["cross-side picks", "duplicate bans", "ban equals pick"] as const) {
		const dir = await scratch();
		try {
			for (const file of await bodies(dir, "draft")) {
				const source = await rows(file);
				const row = source.find((candidate) => candidate.GameId === target.source.gameId);
				if (row === undefined) continue;
				if (mutate === "cross-side picks") row.Team2Pick1 = row.Team1Pick1;
				if (mutate === "duplicate bans") row.Team2Ban1 = row.Team1Ban1;
				if (mutate === "ban equals pick") row.Team1Ban1 = row.Team1Pick1;
				await save(file, source);
				break;
			}
			// The duplicate is refused either way; only the message differs, because a
			// cross-side duplicate is a blind-pick fact and a same-side one never is.
			await assert.rejects(buildDataset({ rawDir: dir }), (error: Error) =>
				error.message.includes(target.source.gameId) && /twice|both sides/.test(error.message),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}
});

test("two payloads carrying identical rows are one draft and one game, not a stale conflict", async () => {
	const dir = await scratch();
	const OVERLAP_GAME = "2023 Season World Championship/Main Event_Finals_1_1";
	// The fixtures carry several payloads per table since IPL 5 was committed, so the
	// overlap is built from the payload that actually holds this game, not the first one.
	const draftFile = await payloadWith(dir, "draft", (row) => row.GameId === OVERLAP_GAME);
	const metaPath = sidecarPath(draftFile);
	const meta = JSON.parse(await readFile(metaPath, "utf8")) as { query: Record<string, unknown> };
	const draftRows = await rows(draftFile);
	const overlapGameId = OVERLAP_GAME;
	const query = { ...meta.query, where: `GameId='${overlapGameId}'`, limit: 1 } as CargoQuery;
	await writePayload(dir, query, `${JSON.stringify([draftRows.find((row) => row.GameId === overlapGameId)])}\n`, {
		url: "https://lol.fandom.com/wiki/Special:CargoExport?overlap=1",
		fetchedAt: new Date().toISOString(),
		status: 200,
	});
	const gameFile = await payloadWith(dir, "game", (row) => row.GameId === OVERLAP_GAME);
	const gameMetaPath = sidecarPath(gameFile);
	const gameMeta = JSON.parse(await readFile(gameMetaPath, "utf8")) as { query: Record<string, unknown> };
	const gameRows = await rows(gameFile);
	const overlapGame = gameRows.find((row) => row.GameId === overlapGameId);
	assert.ok(overlapGame);
	await writePayload(dir, { ...gameMeta.query, where: `GameId='${overlapGameId}'`, limit: 1 } as CargoQuery, `${JSON.stringify([overlapGame])}\n`, {
		url: "https://lol.fandom.com/wiki/Special:CargoExport?overlap-game=1",
		fetchedAt: new Date().toISOString(),
		status: 200,
	});
	const result = await buildDataset({ rawDir: dir });
	assert.equal(result.scoreboards.games.length, 3091, "the overlapping rows did not duplicate a game");
	assert.equal(
		result.scoreboards.games.filter((game) => game.coverage.draft === "complete").length,
		2438,
		"3 091 games: 2 438 drafts are complete (the source's `None` placeholders and the pre-2017 era's partial lists are the rest), and the overlap added none",
	);
});

test("a draft from a rejected event mints no champion or unresolved entity", async () => {
	const dir = await scratch();
	const gameId = "LCK 2023 Spring/Summer_1_1";
	const sourceRows = await rows(await payloadWith(dir, "game", (row) => String(row.OverviewPage).startsWith("2023 Season World Championship")));
	const source = sourceRows.find((row) => String(row.OverviewPage).startsWith("2023 Season World Championship"));
	assert.ok(source);
	await writeFile(path.join(dir, ...GAME_DIR.split(path.sep), "rejected.json"), JSON.stringify([{ ...source, GameId: gameId, OverviewPage: "LCK 2023 Spring/Summer", MatchId: "LCK 2023 Spring/Summer_1" }]), "utf8");
	await writeFile(path.join(dir, ...DRAFT_DIR.split(path.sep), "rejected.json"), JSON.stringify([{ GameId: gameId, SwitchedSides: 0, Team1Pick1: "Invented Champion ZZ" }]), "utf8");
	const result = await buildDataset({ rawDir: dir });
	assert.ok(!result.identity.champions.some((champion) => champion.name === "Invented Champion ZZ"));
	assert.ok(!result.identity.unresolved.some((row) => row.string === "Invented Champion ZZ"));
	assert.ok(!result.scoreboards.games.some((game) => game.source.gameId === gameId));
});

test("an unknown side-switch value or a sixth slot stops the build", async () => {
	for (const [name, mutate] of [
		["SwitchedSides", (row: Record<string, unknown>) => { row.SwitchedSides = "Yes"; }],
		["sixth slot", (row: Record<string, unknown>) => { row.Team1Pick6 = "Ahri"; }],
	] as const) {
		const dir = await scratch();
		try {
			for (const file of await bodies(dir, "draft")) {
				const source = await rows(file);
				const row = source.find((candidate) => typeof candidate.Team1Pick1 === "string");
				if (row === undefined) continue;
				mutate(row);
				await save(file, source);
				break;
			}
			await assert.rejects(buildDataset({ rawDir: dir }), (error: Error) =>
				name === "SwitchedSides" ? /SwitchedSides "Yes"/.test(error.message) : /outside 1\.\.5/.test(error.message),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}
});

test("the source's None placeholder is absent in both draft paths", async () => {
	// MSI 2023 writes `None` for an unused slot in TWO places: the numbered
	// `PicksAndBansS7` ban field and the `ScoreboardGames` ban list. Handling only the
	// ordered path mints an entity named `None` and lets the unordered fallback emit a
	// "complete" draft containing it. IPL 5 2012 states the same placeholder in the
	// unordered list path, so the filter is load-bearing in both eras, not only in 2023.
	const result = await build();
	assert.ok(!result.identity.champions.some((champion) => champion.name === "None"), "no champion entity is named None");
	assert.ok(!result.identity.unresolved.some((row) => row.string === "None"), "None is not reported as unresolved either");
	for (const game of result.scoreboards.games) {
		for (const side of game.draft?.sides ?? []) {
			for (const entry of [...side.picks, ...side.bans]) {
				assert.notEqual(entry.sourceChampion.toLowerCase(), "none", `${game.source.gameId}: a placeholder is never a champion`);
			}
		}
	}
});
