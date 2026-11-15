// Ticket 03's seam: the recorded scoreboard payloads in, games and matches out.
//
// The fixtures are recorded bytes, so every assertion below is about what the source
// actually said — including the assertions about absence, which are the ones that
// matter. Two events are recorded: Worlds 2023 (110 games, complete team statistics)
// and IEM Season IX World Championship 2015 (19 games, thin statistics), plus a query
// for World Cyber Games 2013 that the source answered with zero rows.
//
// Deliberately not asserted here: that a player's kills sum to the team's (ticket 04),
// anything about drafts (ticket 05), and the full invariant gate (ticket 06). This file
// proves the shape of a game row and the fact that a missing statistic stays missing.

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import type { BuildResult } from "../build.ts";
import { buildDataset } from "../build.ts";
import { readPayloads } from "../cache.ts";
import { eraOn } from "../eras.ts";
import type { GameRecord, MatchRecord } from "../games.ts";
import { normalizeSources } from "../normalize.ts";
import { TEAM_STAT_FIELDS } from "../normalize.ts";
import { FIXTURE_RAW, writeTempRule } from "./helpers.ts";

const WORLDS = "2023 Season World Championship";
const IEM = "IEM Season IX - World Championship";

/** One build for the whole file; each test asserts a different property of it. */
let built: Promise<BuildResult> | undefined;
function build(): Promise<BuildResult> {
	built ??= buildDataset({ rawDir: FIXTURE_RAW });
	return built;
}

function gamesUnder(result: BuildResult, page: string): GameRecord[] {
	return result.scoreboards.games.filter((game) => game.overviewPage.startsWith(page));
}

test("a recorded event yields exactly the games the source states, once each", async () => {
	const result = await build();
	const { games } = result.scoreboards;
	assert.equal(games.length, 129, "110 Worlds 2023 games + 19 IEM 2015 games");
	assert.equal(gamesUnder(result, WORLDS).length, 110);
	assert.equal(gamesUnder(result, IEM).length, 19);
	assert.equal(new Set(games.map((game) => game.id)).size, games.length, "no duplicate game ids");
	// Exactly once means exactly: the source's own ids are unique too, and every game is
	// attached to a selected event rather than floating.
	assert.equal(new Set(games.map((game) => game.source.gameId)).size, games.length);
	for (const game of games) {
		assert.match(game.eventId, /^evt-[0-9a-f]{12}$/, `${game.source.gameId} is attached to an event`);
	}
});

test("every game has exactly two sides and exactly one winner, and the winner is one of them", async () => {
	const result = await build();
	for (const game of result.scoreboards.games) {
		assert.equal(game.sides.length, 2, `${game.source.gameId}: two sides`);
		assert.deepEqual(
			game.sides.map((side) => side.side),
			["blue", "red"],
			`${game.source.gameId}: blue is Team1 and red is Team2`,
		);
		assert.ok(
			game.sides.some((side) => side.teamId === game.winnerTeamId),
			`${game.source.gameId}: the winner is one of the two sides`,
		);
		assert.notEqual(game.sides[0].teamId, game.sides[1].teamId, `${game.source.gameId}: two different teams`);
	}
});

test("a statistic the source did not record is absent, not zero, and the coverage says so", async () => {
	const result = await build();
	// 2015: the source states kills, gold, towers, barons and a dragon total, and records
	// no inhibitors at all — while barons and towers are present, which is why the
	// acceptance criterion that used to say "say, baron counts" now names inhibitors.
	const old = gamesUnder(result, IEM);
	for (const game of old) {
		for (const side of game.sides) {
			assert.ok(!("inhibitors" in side), `${game.source.gameId}: inhibitors must be an absent key, not 0 or null`);
			assert.ok("barons" in side, `${game.source.gameId}: barons are stated, which is why they cannot be the missing-field fixture`);
		}
		assert.equal(game.coverage.teamStats, "partial", `${game.source.gameId}: some eligible fields are absent`);
		assert.equal(game.era, "pre-herald");
	}
	// The same rows must not be blamed for a field that did not exist yet: elemental
	// drakes arrived with patch 6.1, so an absent `dragonsClouds` is not an absence.
	for (const game of old) {
		for (const side of game.sides) {
			assert.ok(!("dragonsClouds" in side));
			assert.ok(!("voidGrubs" in side));
		}
	}
	// 2023: every field eligible in its era is stated for both sides.
	for (const game of gamesUnder(result, WORLDS)) {
		assert.equal(game.coverage.teamStats, "complete", `${game.source.gameId}: complete team statistics`);
		assert.equal(game.era, "chemtech-restored");
		assert.ok(!("voidGrubs" in game.sides[0]), "void grubs did not exist in 2023");
	}
});

test("a real zero survives: the coverage rule never rewrites 0 as absent", async () => {
	const result = await build();
	const zeroes = result.scoreboards.games
		.filter((game) => game.overviewPage.startsWith(WORLDS))
		.flatMap((game) => game.sides)
		.filter((side) => side.dragonsElders === 0);
	assert.ok(zeroes.length > 0, "the recorded fixtures state games without an Elder Drake");
	for (const side of zeroes) {
		assert.equal(side.dragonsElders, 0, "a stated 0 is emitted as 0");
		assert.ok("dragonsElders" in side, "and the key is present, which is what distinguishes it from absent");
	}
});

test("a game whose era declares a field ineligible never carries it", async () => {
	// This is the assertion that keeps the era table honest from below: the table is
	// declared from the wiki's patch pages, and this checks the recorded source against
	// it. A game that carried void grubs before patch 14.1 would mean the table is wrong.
	const result = await build();
	for (const game of result.scoreboards.games) {
		const era = eraOn(result.eras, "team-stats", game.dateTimeUtc.slice(0, 10));
		const eligible = new Set(era.eligible);
		for (const side of game.sides) {
			for (const [field] of TEAM_STAT_FIELDS) {
				if (!(field in side)) continue;
				assert.ok(eligible.has(field), `${game.source.gameId} (${era.id}): ${field} is stated but ineligible in this era`);
			}
		}
	}
});

test("duration and date have one fixed representation, and the duration is the exact one", async () => {
	const result = await build();
	const sources = new Map((await normalizeSources(await readPayloads(FIXTURE_RAW))).games.map((game) => [game.gameId, game]));
	const payloads = new Map(
		(await readPayloads(FIXTURE_RAW))
			.filter((payload) => payload.table === "ScoreboardGames")
			.map((payload) => [payload.file, JSON.parse(payload.body) as Record<string, unknown>[]]),
	);
	for (const game of result.scoreboards.games) {
		assert.match(game.dateTimeUtc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, `${game.source.gameId}: ISO-8601 UTC`);
		assert.ok(Number.isInteger(game.durationSeconds), `${game.source.gameId}: whole seconds`);
		const source = sources.get(game.source.gameId);
		assert.ok(source !== undefined);
		// The exact value is the `mm:ss` string: 28:39 must come out as 1719, not as the
		// source's float minutes (28.65) rounded, which would lose the seconds.
		const rows = payloads.get(source?.sourceFile ?? "") ?? [];
		const row = rows.find((candidate) => candidate.GameId === game.source.gameId);
		assert.ok(row !== undefined, `${game.source.gameId}: the payload row is in the corpus`);
		const [minutes, seconds] = String(row?.Gamelength).split(":");
		assert.equal(game.durationSeconds, Number(minutes) * 60 + Number(seconds), `${game.source.gameId}: ${row?.Gamelength}`);
	}
	const worlds = gamesUnder(result, WORLDS);
	assert.deepEqual(
		[...new Set(worlds.map((game) => game.era))],
		["chemtech-restored"],
		"one era label across an event inside a single era",
	);
});

test("the source identifiers travel with the row, wherever the source provided them", async () => {
	const result = await build();
	const sources = new Map((await normalizeSources(await readPayloads(FIXTURE_RAW))).games.map((game) => [game.gameId, game]));
	for (const game of result.scoreboards.games) {
		const source = sources.get(game.source.gameId);
		assert.ok(source !== undefined, `${game.source.gameId} came from a recorded row`);
		assert.equal(game.source.matchId, source?.matchId);
		assert.equal(game.source.riotPlatformGameId, source?.riotPlatformGameId === "" ? undefined : source?.riotPlatformGameId);
		assert.equal(game.patch, source?.patch === null ? undefined : source?.patch);
		assert.ok(game.overviewPage.startsWith(source?.page ?? "\u0000"), "the source page is carried");
	}
});

test("matches: every series the source states, with the score the games cannot recover", async () => {
	const result = await build();
	const { matches, games } = result.scoreboards;
	assert.equal(matches.length, 65, "52 Worlds 2023 series + 13 IEM 2015 series");
	const byId = new Map(matches.map((match) => [match.id, match]));
	for (const game of games) {
		assert.ok(game.matchId !== undefined, `${game.source.gameId}: its series is in the corpus`);
		assert.ok(byId.has(game.matchId), `${game.source.gameId}: the canonical series id resolves`);
	}
	for (const match of matches) {
		assert.equal(match.sides.length, 2);
		assert.ok(match.winnerTeamId !== undefined, `${match.source.matchId}: the source states a winner`);
		assert.ok(match.sides.some((side) => side.teamId === match.winnerTeamId));
		assert.equal(match.isNullified, false, `measured: no nullified series in the fixtures`);
		assert.ok(!("forfeit" in match), "measured: no forfeit in the fixtures, so the key is absent rather than false");
	}
	// The series score is a match fact, and the fixtures carry the case that proves it:
	// a five-game series ends 3-2, which is the source's number on the match row, not a
	// count of anything on the game rows.
	const fiveGame = matches.find((match) => games.filter((game) => game.matchId === match.id).length === 5);
	assert.ok(fiveGame !== undefined, "the fixtures carry a five-game series");
	assert.deepEqual(
		fiveGame?.sides.map((side) => side.seriesScore).sort((a, b) => (a ?? 0) - (b ?? 0)),
		[2, 3],
	);
	assert.equal(fiveGame?.bestOf, 5);
});

test("the per-event report separates 'no games in the source' from 'nobody asked'", async () => {
	const result = await build();
	const report = result.scoreboards.eventGames;
	assert.equal(report.length, result.events.length, "one row per selected event");
	const state = new Map(report.map((row) => [row.overviewPage, row]));
	assert.equal(state.get(WORLDS)?.state, "recorded");
	assert.equal(state.get(IEM)?.state, "recorded");
	// Recorded query, zero rows — the fixture that keeps this state from collapsing into
	// "missing", which would be a lie about what was fetched.
	assert.equal(state.get("2013 World Cyber Games")?.state, "empty");
	assert.equal(state.get("2013 World Cyber Games")?.games, 0);
	assert.equal(state.get("2023 Mid-Season Invitational")?.state, "missing");
	// Counts reconcile with the emitted files.
	const total = report.reduce((sum, row) => sum + row.games, 0);
	assert.equal(total, result.scoreboards.games.length);
	assert.equal(
		report.reduce((sum, row) => sum + row.matches, 0),
		result.scoreboards.matches.length,
	);
});

test("a game for an event the rule does not select is ignored, not emitted", async () => {
	// Excluding Worlds 2023 through the rule makes its 110 games and 52 matches rows for
	// pages no selected event covers. They must be reported and dropped rather than
	// attached to the nearest event or silently absorbed.
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-gate-"));
	try {
		const rulePath = path.join(dir, "event-selection.json");
		const rule = JSON.parse(await readFile(path.join(import.meta.dirname, "..", "rules", "event-selection.json"), "utf8")) as {
			overrides?: unknown;
			[key: string]: unknown;
		};
		await writeFile(
			rulePath,
			JSON.stringify({
				...rule,
				overrides: { include: [], exclude: [{ overviewPage: WORLDS, reason: "test: pretend the rule rejects it" }] },
			}),
			"utf8",
		);
		const result = await buildDataset({ rawDir: FIXTURE_RAW, ruleFile: rulePath });
		assert.ok(result.scoreboards.games.every((game) => !game.overviewPage.startsWith(WORLDS)));
		assert.equal(result.scoreboards.ignoredGames.length, 110, "the 110 Worlds games are counted as ignored");
		assert.equal(result.scoreboards.ignoredMatches.length, 52);
		assert.equal(result.scoreboards.games.length, 19, "only the IEM event still contributes games");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a departed patch is an absent key, not an empty string", async () => {
	// The recorded fixtures all state a patch, so the absence has to be made by deleting
	// the field from a copy of a real payload. That is a mapping test, not invented data:
	// the row still carries everything else the source said.
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-patch-"));
	try {
		const raw = path.join(dir, "raw");
		await cp(FIXTURE_RAW, raw, { recursive: true });
		const tableDir = path.join(raw, "lol-fandom", "cargoexport", "ScoreboardGames");
		for (const name of await readdir(tableDir)) {
			if (!name.endsWith(".json") || name.endsWith(".meta.json")) continue;
			const file = path.join(tableDir, name);
			const rows = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>[];
			if (rows.length === 0) continue;
			delete rows[0].Patch;
			await writeFile(file, JSON.stringify(rows), "utf8");
			break;
		}
		const result = await buildDataset({ rawDir: raw });
		const bare = result.scoreboards.games.filter((game) => !("patch" in game));
		assert.equal(bare.length, 1, "exactly one game lost its patch");
		assert.equal(bare[0].coverage.teamStats, "complete", "the patch is not part of the team-statistics coverage group");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the games are byte-identical across two builds", async () => {
	const first = await build();
	const second = await buildDataset({ rawDir: FIXTURE_RAW });
	assert.equal(first.files["games.jsonl"], second.files["games.jsonl"]);
	assert.equal(first.files["matches.jsonl"], second.files["matches.jsonl"]);
	assert.equal(first.files["event-games.jsonl"], second.files["event-games.jsonl"]);
});

test("the committed games match a rebuild over the recorded fixtures", async () => {
	const result = await build();
	for (const file of ["games.jsonl", "matches.jsonl", "event-games.jsonl"] as const) {
		const committed = await readFile(path.join(import.meta.dirname, "..", "..", "..", "data", "curated", file), "utf8").catch(
			() => undefined,
		);
		assert.equal(committed, result.files[file], `${file} is committed and current — run the build without --check`);
	}
});
