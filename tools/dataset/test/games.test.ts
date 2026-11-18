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
import { FIXTURE_RAW, savePayloadBody, writeTempRule } from "./helpers.ts";

const WORLDS = "2023 Season World Championship";
const IEM = "IEM Season IX - World Championship";
const IPL = "IGN ProLeague Season 5";

/** One build for the whole file; each test asserts a different property of it. */
let built: Promise<BuildResult> | undefined;
function build(): Promise<BuildResult> {
	built ??= buildDataset({ rawDir: FIXTURE_RAW });
	return built;
}

function gamesUnder(result: BuildResult, page: string): GameRecord[] {
	return result.scoreboards.games.filter((game) => game.overviewPage.startsWith(page));
}

/**
 * Build from a scratch copy of the recorded fixtures after `edit` changes one payload.
 *
 * The suite mutates recorded payloads rather than inventing rows: the row still carries
 * everything the source said, and only the field under test differs.
 */
async function buildAfterEdit(edit: (raw: string) => Promise<void>): Promise<BuildResult> {
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-edit-"));
	try {
		const raw = path.join(dir, "raw");
		await cp(FIXTURE_RAW, raw, { recursive: true });
		await edit(raw);
		return await buildDataset({ rawDir: raw });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Every body file of one table in a scratch fixture tree, sidecars excluded. */
async function payloadBodies(raw: string, table: string): Promise<string[]> {
	const dir = path.join(raw, "lol-fandom", "cargoexport", table);
	return (await readdir(dir))
		.filter((name) => name.endsWith(".json") && !name.endsWith(".meta.json"))
		.sort()
		.map((name) => path.join(dir, name));
}

test("a recorded event yields exactly the games the source states, once each", async () => {
	const result = await build();
	const { games } = result.scoreboards;
	assert.equal(
		games.length,
		377,
		"110 Worlds 2023 + 76 MSI 2023 + 19 IEM 2015 + 72 IPL 5 + 21 Rift Rivals 2017 + 25 Mid-Season Cup 2020 + 19 Esports World Cup 2024 + 35 First Stand 2025",
	);
	assert.equal(gamesUnder(result, WORLDS).length, 110);
	assert.equal(gamesUnder(result, IEM).length, 19);
	assert.equal(gamesUnder(result, IPL).length, 72);
	assert.equal(gamesUnder(result, "Rift Rivals 2017/NA-EU").length, 21);
	assert.equal(gamesUnder(result, "2020 Mid-Season Cup").length, 25);
	assert.equal(gamesUnder(result, "Esports World Cup 2024").length, 19);
	assert.equal(gamesUnder(result, "2025 First Stand").length, 35);
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
	assert.equal(
		matches.length,
		230,
		"52 Worlds 2023 + 25 MSI 2023 + 13 IEM 2015 + 36 IPL 5 (48 rows: 6 contradicted by every game naming them, ticket 14, 6 wildcard-qualifier series) + 48 World Cyber Games 2013 + 19 Rift Rivals 2017 + 17 Mid-Season Cup 2020 + 7 Esports World Cup 2024 + 13 First Stand 2025",
	);
	const byId = new Map(matches.map((match) => [match.id, match]));
	for (const game of games) {
		if (game.matchId === undefined) {
			// Detached on purpose: the series row names two other teams (ticket 14). The
			// exact set is asserted in series-rows.test.ts.
			assert.ok(result.scoreboards.detachedGames.some((detached) => detached.gameId === game.source.gameId), `${game.source.gameId}: a game without a matchId is in the detachment report`);
			continue;
		}
		assert.ok(byId.has(game.matchId), `${game.source.gameId}: the canonical series id resolves`);
	}
	// One recorded Indian Pro League qualifier series states no result at all: the source
	// has the row (and no game for it), so no winner is the honest answer, not a gap here.
	const NO_WINNER = "IGN ProLeague Season 5/Qualifiers/Wildcard Qualifiers_Group Stage_6";
	for (const match of matches) {
		assert.equal(match.sides.length, 2);
		if (match.source.matchId === NO_WINNER) {
			assert.equal(match.winnerTeamId, undefined, "measured: the one series the source left without a result");
		} else {
			assert.ok(match.winnerTeamId !== undefined, `${match.source.matchId}: the source states a winner`);
			assert.ok(match.sides.some((side) => side.teamId === match.winnerTeamId));
		}
		assert.equal(match.isNullified, false, `measured: no nullified series in the fixtures`);
		assert.ok(!("forfeit" in match), "measured: no forfeit in the fixtures, so the key is absent rather than false");
	}
	// A match row is the source's column order, not a game side: `Team1`/`Team2` here are
	// positions on one `MatchSchedule` row, and the games of a series may line up either
	// way. Claiming `blue` on a match would be a fabricated fact (52 of the 129 recorded
	// game rows sit beside a series whose `Team1` is their `Team2`); a match must therefore
	// say only which column each team came from. Games keep their blue/red side above.
	for (const match of matches) {
		assert.deepEqual(
			match.sides.map((side) => side.sourceOrder),
			[1, 2],
			`${match.source.matchId}: Team1 is source order 1 and Team2 is 2`,
		);
		for (const side of match.sides) {
			assert.ok(!("side" in side), `${match.source.matchId}: a match side claims no blue/red side`);
			assert.ok(!("side" in match), `${match.source.matchId}: nor does the match itself`);
		}
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
	// Recorded queries that answer a series table and no game table: the ticket 10 crawl
	// found 48 `MatchSchedule` rows and no scoreboard at all for World Cyber Games 2013, so
	// the event is `recorded` with zero games — the state that keeps "thin" apart from
	// "unfetched". Its 62 qualifier series are not the event (see the qualifier test).
	assert.equal(state.get("2013 World Cyber Games")?.state, "recorded");
	assert.equal(state.get("2013 World Cyber Games")?.games, 0);
	assert.equal(state.get("2013 World Cyber Games")?.matches, 48);
	// IPL 5 is `recorded` now that ticket 14 settled its series rows: the four recorded
	// payloads carry 72 games and 48 series, 6 of which are contradicted and not emitted,
	// and 6 of which are wildcard-qualifier series that are not the event (ticket 10).
	// Before that change the only recorded query for it was a `ScoreboardPlayers` one, and
	// rows in a player table say nothing about whether the event has games — which is why
	// the event used to read `missing` rather than `empty`.
	assert.equal(state.get(IPL)?.state, "recorded");
	assert.equal(state.get(IPL)?.games, 72);
	assert.equal(state.get(IPL)?.matches, 36);
	// MSI 2023 was crawled for real in this ticket: it carries games, so it is recorded.
	assert.equal(state.get("2023 Mid-Season Invitational")?.state, "recorded");
	// WCG 2011 is the earliest era: a real `LIKE '2011 World Cyber Games%'` query came
	// back empty, which is the measurement that separates "the source has no games here"
	// from "nobody asked".
	assert.equal(state.get("2011 World Cyber Games")?.state, "empty");
	assert.equal(state.get("2011 World Cyber Games")?.games, 0);
	// Counts reconcile with the emitted files.
	const total = report.reduce((sum, row) => sum + row.games, 0);
	assert.equal(total, result.scoreboards.games.length);
	assert.equal(
		report.reduce((sum, row) => sum + row.matches, 0),
		result.scoreboards.matches.length,
	);
});

test("an event name that only appears inside a LIKE pattern is not a query for that event", async () => {
	// The report must read the query structurally: `LIKE '%2011 World Cyber Games%'` names a
	// shape, not the event, and substring matching used to turn it into `empty`. The body is
	// untouched, so every other fact about the corpus is unchanged — and the event has no
	// games in this corpus, so "nobody asked" is the only honest state left for it.
	const result = await buildAfterEdit(async (raw) => {
		let changed = 0;
		// Both game-row tables, because "empty" is established by any of them: the 2011
		// scoreboard, series, picks and player queries all came back empty.
		for (const table of ["ScoreboardGames", "MatchSchedule", "PicksAndBansS7", "ScoreboardPlayers"]) {
			for (const body of await payloadBodies(raw, table)) {
				const metaFile = body.replace(/\.json$/, ".meta.json");
				const meta = JSON.parse(await readFile(metaFile, "utf8")) as { query: Record<string, unknown> };
				if (!String(meta.query.where ?? "").includes("2011 World Cyber Games")) continue;
				// A substring pattern names a shape, not the event: an unanchored match would make
				// this event look "empty" although no query asked for it by name.
				meta.query.where = `OverviewPage LIKE '%2011 World Cyber Games%'`;
				await writeFile(metaFile, JSON.stringify(meta), "utf8");
				changed += 1;
			}
		}
		assert.equal(changed, 4, "the fixtures carry four 2011 queries");
	});
	const state = new Map(result.scoreboards.eventGames.map((row) => [row.overviewPage, row.state]));
	assert.equal(state.get("2011 World Cyber Games"), "missing", "a substring LIKE pattern is not a literal that names the event");
});

test("a game whose teams are not its series' teams is detached and reported, not attached", async () => {
	// A game belongs to a series between the same two teams. Retargeting one game to
	// another series of the same event passes every id check — the match exists and its
	// event is the same — so only the team set catches it. Side swaps are legitimate, which
	// is why the comparison is a set: 11 recorded series have every game the other way up.
	//
	// Ticket 14 decides what catching it means: the game keeps its own data and loses the
	// link (the source's own IPL 5 does this systematically), and the gate still refuses an
	// emitted record that claims such a series — see invariants.test.ts.
	const SOURCE = "2023 Season World Championship/Play-In_Round 1_1";
	const TARGET = "2023 Season World Championship/Play-In_Round 1_4";
	const retargeted = await buildAfterEdit(async (raw) => {
		for (const file of await payloadBodies(raw, "ScoreboardGames")) {
			const rows = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>[];
			const row = rows.find((candidate) => candidate.MatchId === SOURCE);
			if (row === undefined) continue;
			row.MatchId = TARGET;
			await savePayloadBody(file, JSON.stringify(rows));
			return;
		}
		throw new Error(`the fixtures carry no game for ${SOURCE}`);
	});
	const detached = retargeted.scoreboards.detachedGames.filter((game) => game.matchId === TARGET);
	assert.equal(detached.length, 1, "exactly the retargeted game is detached");
	const game = retargeted.scoreboards.games.find((candidate) => candidate.source.gameId === detached[0].gameId);
	assert.ok(game);
	assert.equal(game.matchId, undefined, "the game is emitted without a series, not between two other teams");
	assert.equal(game.source.matchId, TARGET, "the source's own id is preserved on the row (spec R7)");
	// The series itself is still emitted: its own games (there are others, from the recorded
	// payload) still name it, so only the link is contradicted.
	assert.ok(retargeted.scoreboards.matches.some((match) => match.source.matchId === TARGET));
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
		assert.equal(
			result.scoreboards.ignoredMatches.length,
			120,
			"52 Worlds series, 6 IPL 5 qualifier series and 62 World Cyber Games 2013 qualifier series",
		);
		assert.equal(result.scoreboards.games.length, 267, "the other seven events still contribute their games");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a qualifier page under a selected event is not that event", async () => {
	// The spec's event set excludes "qualifiers for an already-included event", and the
	// wiki records them beneath the event page (`2013 World Cyber Games/Qualifiers/China`).
	// A prefix-only attachment absorbed 62 such series into World Cyber Games 2013 from the
	// real crawl, so the boundary is the first path segment after the event page: a stage
	// page (`…/Main Event`, `…/Play-In`) is the event, a qualifier page is not.
	const moved = `${WORLDS}/Qualifiers/EU`;
	const result = await buildAfterEdit(async (raw) => {
		for (const file of await payloadBodies(raw, "ScoreboardGames")) {
			const rows = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>[];
			const row = rows.find((candidate) => candidate.OverviewPage === `${WORLDS}/Play-In`);
			if (row === undefined) continue;
			row.OverviewPage = moved;
			await savePayloadBody(file, JSON.stringify(rows));
			return;
		}
		throw new Error(`the fixtures carry no game on ${WORLDS}/Play-In`);
	});
	assert.equal(result.scoreboards.games.length, 376, "the moved game is not emitted as the event's");
	assert.ok(result.scoreboards.ignoredGames.includes(moved), "the page is counted as ignored, not absorbed");
	assert.ok(
		result.scoreboards.games.some((game) => game.overviewPage.startsWith(`${WORLDS}/`)),
		"the event's real stage pages still attach",
	);
});

test("a side-swapped series still resolves both of its teams", async () => {
	// The measured case, and the reason a match carries no `side`: Play-In_Round 1_1 lists
	// Movistar R7 as the source's `Team1`, while both of its games have PSG Talon in the
	// `Team1` column. The series is still between those two teams, and the winner still
	// resolves — what must not travel is a blue/red claim about the match row.
	const result = await build();
	const matchId = "2023 Season World Championship/Play-In_Round 1_1";
	const match = result.scoreboards.matches.find((candidate) => candidate.source.matchId === matchId);
	assert.ok(match !== undefined, `the fixtures carry ${matchId}`);
	const games = result.scoreboards.games.filter((game) => game.matchId === match?.id);
	assert.equal(games.length, 2, "the series has two recorded games");
	for (const game of games) {
		assert.deepEqual(
			game.sides.map((side) => side.side),
			["blue", "red"],
			`${game.source.gameId}: a game keeps its own blue/red side`,
		);
		assert.equal(game.sides[0].teamName, "PSG Talon", `${game.source.gameId}: Team1 is the game's blue side`);
	}
	assert.deepEqual(
		match.sides.map((side) => [side.sourceOrder, side.sourceTeam]),
		[
			[1, "Movistar R7"],
			[2, "PSG Talon"],
		],
		"the match states its columns, not the games' sides — the source strings, which stay put "
			+ "when the team is renamed (ticket 10's registry crawl resolves Movistar R7 to the LYON chain)",
	);
	assert.deepEqual(
		[...new Set(match.sides.map((side) => side.teamId))].sort(),
		[...new Set(games.flatMap((game) => game.sides.map((side) => side.teamId)))].sort(),
		"the series is between exactly the teams its games are",
	);
	assert.equal(match.winnerTeamName, "PSG Talon", "the winner still resolves across the swap");
});

test("a departed patch is an absent key, not an empty string", async () => {
	// A patch is absent in the recorded corpus already: no IPL 5 2012 row states one, which
	// is the era, not a defect. The mutation makes the same absence on a 2023 row, so the
	// mapping is tested as well: the row still carries everything else the source said.
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-patch-"));
	try {
		const raw = path.join(dir, "raw");
		await cp(FIXTURE_RAW, raw, { recursive: true });
		const tableDir = path.join(raw, "lol-fandom", "cargoexport", "ScoreboardGames");
		let edited = "";
		for (const name of await readdir(tableDir)) {
			if (!name.endsWith(".json") || name.endsWith(".meta.json")) continue;
			const file = path.join(tableDir, name);
			const rows = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>[];
			const row = rows.find((candidate) => candidate.Patch !== null && candidate.Patch !== undefined);
			if (row === undefined) continue;
			delete row.Patch;
			edited = String(row.GameId);
			await savePayloadBody(file, JSON.stringify(rows));
			break;
		}
		assert.notEqual(edited, "", "the fixtures carry a game with a stated patch");
		const result = await buildDataset({ rawDir: raw });
		const bare = result.scoreboards.games.filter((game) => !("patch" in game));
		const changed = bare.find((game) => game.source.gameId === edited);
		assert.ok(changed, `the edited game (${edited}) states no patch, as an absent key`);
		assert.equal(changed.coverage.teamStats, "complete", "the patch is not part of the team-statistics coverage group");
		assert.equal(new Set(bare.map((game) => game.source.gameId)).size, bare.length, "one record per game, absent patch or not");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a value the era table declares ineligible stops the build, naming the game", async () => {
	// The era table is the dataset's authority for "could have been recorded", so a source
	// row that contradicts it is not silently dropped: R10 wants the invariant in the build,
	// not only in this suite, because a real crawl is validated by the build alone. Void
	// grubs arrived in patch 14.1, so a 2015 game carrying them means either the game's date
	// or the table is wrong.
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-era-"));
	try {
		const raw = path.join(dir, "raw");
		await cp(FIXTURE_RAW, raw, { recursive: true });
		const tableDir = path.join(raw, "lol-fandom", "cargoexport", "ScoreboardGames");
		for (const name of await readdir(tableDir)) {
			if (!name.endsWith(".json") || name.endsWith(".meta.json")) continue;
			const file = path.join(tableDir, name);
			const rows = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>[];
			const target = rows.find((row) => String(row.DateTime_UTC ?? row["DateTime UTC"]).startsWith("2015-"));
			if (target === undefined) continue;
			target.Team1VoidGrubs = 2;
			await savePayloadBody(file, JSON.stringify(rows));
			break;
		}
		await assert.rejects(buildDataset({ rawDir: raw }), /states voidGrubs, which the era table declares ineligible in pre-herald/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a half-recorded game is partial, not unavailable", async () => {
	// One side with every eligible field and the other with none is the case R6 calls out:
	// "no game is silently half-empty". The marker must say `partial`, because `unavailable`
	// would claim the source recorded nothing for a row that is half full.
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-half-"));
	try {
		const raw = path.join(dir, "raw");
		await cp(FIXTURE_RAW, raw, { recursive: true });
		const tableDir = path.join(raw, "lol-fandom", "cargoexport", "ScoreboardGames");
		let targetId = "";
		for (const name of await readdir(tableDir)) {
			if (!name.endsWith(".json") || name.endsWith(".meta.json")) continue;
			const file = path.join(tableDir, name);
			const rows = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>[];
			const target = rows.find((row) => String(row.DateTime_UTC ?? row["DateTime UTC"]).startsWith("2015-"));
			if (target === undefined) continue;
			targetId = String(target.GameId);
			for (const key of Object.keys(target)) {
				if (key.startsWith("Team2") && key !== "Team2" && key !== "Team2Players" && key !== "Team2Bans" && key !== "Team2Picks") {
					target[key] = null;
				}
			}
			await savePayloadBody(file, JSON.stringify(rows));
			break;
		}
		const result = await buildDataset({ rawDir: raw });
		const half = result.scoreboards.games.find((game) => game.source.gameId === targetId);
		assert.ok(half !== undefined);
		assert.equal(half.coverage.teamStats, "partial", "half a row is partial");
		assert.ok(half.sides[0].kills !== undefined, "the populated side is still emitted");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a Gamelength this stage cannot parse stops the build instead of vanishing", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-length-"));
	try {
		const raw = path.join(dir, "raw");
		await cp(FIXTURE_RAW, raw, { recursive: true });
		const tableDir = path.join(raw, "lol-fandom", "cargoexport", "ScoreboardGames");
		for (const name of await readdir(tableDir)) {
			if (!name.endsWith(".json") || name.endsWith(".meta.json")) continue;
			const file = path.join(tableDir, name);
			const rows = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>[];
			if (rows.length === 0) continue;
			// The source once answered float minutes here (`Gamelength_Number`); if its
			// `mm:ss` column ever changed shape, every duration would go absent silently.
			rows[0].Gamelength = "28.65";
			await savePayloadBody(file, JSON.stringify(rows));
			break;
		}
		await assert.rejects(buildDataset({ rawDir: raw }), /expected a Gamelength of mm:ss or h:mm:ss, got "28\.65"/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the games are byte-identical across two builds", async () => {
	const first = await build();
	const second = await buildDataset({ rawDir: FIXTURE_RAW });
	assert.equal(first.files["games.jsonl"], second.files["games.jsonl"]);
	assert.equal(first.files["matches.jsonl"], second.files["matches.jsonl"]);
	assert.equal(first.files["series-conflicts.jsonl"], second.files["series-conflicts.jsonl"]);
	assert.equal(first.files["event-games.jsonl"], second.files["event-games.jsonl"]);
});

test("the committed games match a rebuild over the recorded fixtures", async () => {
	const result = await build();
	for (const file of ["games.jsonl", "matches.jsonl", "series-conflicts.jsonl", "event-games.jsonl"] as const) {
		const committed = await readFile(path.join(import.meta.dirname, "..", "..", "..", "data", "curated", file), "utf8").catch(
			() => undefined,
		);
		assert.equal(committed, result.files[file], `${file} is committed and current — run the build without --check`);
	}
});

test("a game table that answered with rows does not make an event empty", async () => {
	// `empty` is a claim that a game query came back with nothing. A payload that names
	// the event and returned rows — a player table, or a game table with data — must not
	// produce it, or the report says the source has no games while the source answered.
	const result = await build();
	const state = new Map(result.scoreboards.eventGames.map((row) => [row.overviewPage, row.state]));
	for (const page of [WORLDS, IEM, "2023 Mid-Season Invitational"]) {
		assert.equal(state.get(page), "recorded", `${page} carries games, so it is recorded`);
	}
	const empty = result.scoreboards.eventGames.filter((row) => row.state === "empty");
	for (const row of empty) {
		assert.equal(row.games, 0);
		assert.equal(row.matches, 0);
	}
	assert.ok(empty.length > 0, "the fixtures still carry an event the source answered with nothing");
});
