// Ticket 14's seam: IPL 5 (2012), the earliest event with games, whose
// `MatchSchedule` rows disagree with the games that name them.
//
// The classification below is *derived from the recorded payloads*, not remembered: the
// test pairs every IPL 5 game with its series row, compares the two source strings as
// sets (a side swap is legitimate), and asks identity what each string denotes. That
// yields exactly two causes, and the assertions pin both the counts and the shape:
//
//   - a **legacy team name** — `Counter Logic Gaming` on the games, `CLG Prime` on the
//     series rows: two strings, one canonical team, resolved by the declaration in
//     `rules/identity-aliases.json` (spec R7);
//   - a **cross-match mixup** — three pairs of series rows whose `MatchId`s the source
//     swapped, so every game naming them contradicts them: the games are emitted with no
//     `matchId` and the contradicted series rows are not emitted (ticket 14's decision).
//
// Ticket 09 reported 11 such pairings (9 legacy + 3 mixups). That number does not
// reproduce on these bytes and the split does not add up either; the measured counts are
// asserted here, so a future crawl cannot quietly move them.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import type { BuildResult } from "../build.ts";
import { buildDataset } from "../build.ts";
import { readPayloads } from "../cache.ts";
import { findInvariantViolations } from "../invariants.ts";
import type { SourceGame, SourceMatch } from "../normalize.ts";
import { normalizeSources } from "../normalize.ts";
import { validateAgainst } from "../validate.ts";
import { CURATED_DIR, FIXTURE_RAW, REPO_ROOT, SCHEMA_DIR } from "./helpers.ts";

const run = promisify(execFile);

/** The event's own page. Its qualifier pages are stage pages under it. */
const IPL = "IGN ProLeague Season 5";

let built: Promise<BuildResult> | undefined;
function build(): Promise<BuildResult> {
	built ??= buildDataset({ rawDir: FIXTURE_RAW });
	return built;
}

/** IPL 5's games and series as the source states them. */
async function iplSource(): Promise<{ games: SourceGame[]; series: Map<string, SourceMatch> }> {
	const sources = normalizeSources(await readPayloads(FIXTURE_RAW));
	return {
		games: sources.games.filter((game) => game.page === IPL || game.page.startsWith(`${IPL}/`)),
		series: new Map(sources.matches.filter((match) => match.page === IPL || match.page.startsWith(`${IPL}/`)).map((match) => [match.matchId, match])),
	};
}

/** A side-swap-insensitive view of two source team strings. */
function pair(teams: readonly [string, string]): [string, string] {
	return [...teams].sort() as [string, string];
}

/**
 * One game/series pairing whose two *source strings* differ.
 *
 * `sameEntity` says whether identity resolves the differing strings to one canonical team,
 * which is what separates a legacy name from a mixup: an alias can make one entity out of
 * two names, and nothing can make two matches into one.
 */
type Disagreement = { game: SourceGame; series: SourceMatch; gameTeams: [string, string]; seriesTeams: [string, string]; sameEntity: boolean };

async function disagreements(): Promise<Disagreement[]> {
	const { games, series } = await iplSource();
	const { index } = (await build()).identity;
	const found: Disagreement[] = [];
	for (const game of games) {
		const match = series.get(game.matchId);
		if (match === undefined) continue;
		const gameTeams = [game.sides[0].team, game.sides[1].team] as [string, string];
		const seriesTeams = match.sides;
		if (pair(gameTeams).join("\u0000") === pair(seriesTeams).join("\u0000")) continue;
		const resolved = (team: string): string | undefined => index.resolve("team", team, game.date)?.id;
		const gameIds = [resolved(gameTeams[0]), resolved(gameTeams[1])].sort();
		const seriesIds = [resolved(seriesTeams[0]), resolved(seriesTeams[1])].sort();
		found.push({ game, series: match, gameTeams, seriesTeams, sameEntity: gameIds[0] === seriesIds[0] && gameIds[1] === seriesIds[1] });
	}
	return found;
}

test("every disagreeing IPL 5 pairing is a legacy name or a cross-match mixup, and the split is derived", async () => {
	const found = await disagreements();
	const legacy = found.filter((pairing) => pairing.sameEntity);
	const mixups = found.filter((pairing) => !pairing.sameEntity);
	assert.equal(found.length, 20, "the recorded bytes hold 20 pairings whose source strings differ");
	assert.equal(legacy.length, 12, "12 games whose series row spells the team differently (6 series rows)");
	assert.equal(mixups.length, 8, "8 games whose series row names two other teams (6 series rows)");

	// A legacy name is exactly a pairing where two strings denote one canonical team: the
	// declaration is what makes that true, and the strings themselves stay different.
	for (const pairing of legacy) {
		assert.notEqual(pair(pairing.gameTeams).join("|"), pair(pairing.seriesTeams).join("|"), "the source really does spell it two ways");
		const differing = [...pairing.gameTeams, ...pairing.seriesTeams].filter(
			(team) => !(pairing.gameTeams.includes(team) && pairing.seriesTeams.includes(team)),
		);
		assert.deepEqual([...new Set(differing)].sort(), ["CLG Prime", "Counter Logic Gaming"], "the one legacy rename in this corpus");
	}
	// Every mixup is a *swap*: the series' team pair is some other series' game pair, and
	// that other series is swapped in return. Three reciprocal pairs, not random damage.
	const { index } = (await build()).identity;
	const teamSet = (teams: readonly [string, string], date: string): string =>
		teams.map((team) => index.resolve("team", team, date)?.id ?? `?${team}`).sort().join("|");
	const gamesByTeamSet = new Map<string, Disagreement[]>();
	for (const pairing of mixups) {
		const key = teamSet(pairing.gameTeams, pairing.game.date);
		gamesByTeamSet.set(key, [...(gamesByTeamSet.get(key) ?? []), pairing]);
	}
	const swaps = new Set<string>();
	for (const pairing of mixups) {
		// The series names a team pair that games carrying a *different* series id actually
		// played, which is the reciprocal half of the swap.
		const key = teamSet(pairing.seriesTeams, pairing.series.date);
		const holders = gamesByTeamSet.get(key) ?? [];
		assert.ok(holders.length > 0, `${pairing.series.matchId}: its teams are nobody's game teams`);
		assert.ok(
			holders.every((holder) => holder.game.matchId !== pairing.series.matchId),
			`${pairing.series.matchId}: the games that played its teams carry another series id`,
		);
		swaps.add([...new Set([pairing.series.matchId, ...holders.map((holder) => holder.game.matchId)])].sort().join(" <-> "));
	}
	assert.equal(swaps.size, 3, "three swapped pairs of series");
});

test("the legacy name resolves through the declared alias, and both source strings stay on their rows", async () => {
	const result = await build();
	const { index } = result.identity;
	const date = "2012-11-29";
	const gameName = index.resolve("team", "Counter Logic Gaming", date);
	const seriesName = index.resolve("team", "CLG Prime", date);
	assert.ok(gameName && seriesName);
	assert.equal(seriesName.id, gameName.id, "one roster under the name it was playing as, not two teams");
	assert.equal(gameName.name, "Counter Logic Gaming", "the entity is the org name the games use");
	const declared = result.identity.aliases.find((alias) => alias.kind === "team" && alias.string === "CLG Prime");
	assert.ok(declared, "the alias table carries the declared string");
	assert.equal(declared.entityId, gameName.id);
	assert.ok(declared.evidence.includes("declared"), "the declaration is the reason it resolves");
	assert.ok(declared.evidence.includes("observed"), "and the corpus used it");
	assert.deepEqual([declared.firstSeen, declared.lastSeen], ["2012-10-04", "2012-12-02"], "the window the series rows used it");

	// Spec R7: the source string is preserved beside the canonical id on every row, so the
	// game still says what the game said and the series still says what the series said.
	const games = result.scoreboards.games.filter((game) => game.overviewPage === IPL);
	const sides = games.flatMap((game) => game.sides).filter((side) => side.teamId === gameName.id);
	assert.equal(sides.length, 12, "12 IPL 5 game sides are that team");
	assert.ok(sides.every((side) => side.sourceTeam === "Counter Logic Gaming"), "the games' own string is untouched");
	const matchSides = result.scoreboards.matches
		.filter((match) => match.overviewPage === IPL)
		.flatMap((match) => match.sides)
		.filter((side) => side.teamId === gameName.id);
	assert.equal(matchSides.length, 6, "6 series rows name it");
	assert.ok(matchSides.every((side) => side.sourceTeam === "CLG Prime"), "the series' own string is untouched");
	assert.ok(
		games.filter((game) => game.sides.some((side) => side.teamId === gameName.id)).every((game) => game.matchId !== undefined),
		"every one of those games is still attached to its series",
	);
});

test("a game whose series row names two other teams is emitted without a matchId and counted", async () => {
	const result = await build();
	const { detachedGames, contradictedMatches, gamesWithoutMatch, games } = result.scoreboards;
	assert.deepEqual(
		[...new Set(detachedGames.map((game) => game.matchId))].sort(),
		[
			"IGN ProLeague Season 5_Group C_3",
			"IGN ProLeague Season 5_Group C_4",
			"IGN ProLeague Season 5_Group D_3",
			"IGN ProLeague Season 5_Group D_4",
			"IGN ProLeague Season 5_Loser's Round 1_2",
			"IGN ProLeague Season 5_Loser's Round 1_3",
		],
		"the three swapped pairs, named by the series id each game claims",
	);
	assert.equal(detachedGames.length, 8, "8 games carry those ids (two of the swapped series have two games each)");
	for (const detached of detachedGames) {
		const game = games.find((candidate) => candidate.source.gameId === detached.gameId);
		assert.ok(game, `${detached.gameId} is still emitted — the game data is not in doubt, only the link`);
		assert.equal(game.matchId, undefined, `${detached.gameId}: no canonical matchId`);
		assert.equal(game.source.matchId, detached.matchId, `${detached.gameId}: the source's own id is preserved (R7)`);
		assert.equal(game.coverage.playerStats, "partial", `${detached.gameId}: its player rows still join it`);
	}
	assert.deepEqual(contradictedMatches.sort(), [...new Set(detachedGames.map((game) => game.matchId))].sort(), "each contradicted series is reported once");
	assert.equal(contradictedMatches.length, 6);
	assert.ok(
		detachedGames.every((detached) => !gamesWithoutMatch.includes(detached.gameId)),
		"a detached game is not reported as one whose series the corpus lacks — the two are different facts",
	);
	// The invariant, checked on the emitted records rather than only in the assembler: no
	// game sits in a series between two other teams.
	const byId = new Map(result.scoreboards.matches.map((match) => [match.id, match]));
	for (const game of games) {
		if (game.matchId === undefined) continue;
		const match = byId.get(game.matchId);
		assert.ok(match);
		assert.deepEqual(
			game.sides.map((side) => side.teamId).sort(),
			match.sides.map((side) => side.teamId).sort(),
			`${game.source.gameId}: an emitted matchId names a series between its own teams`,
		);
	}
});

test("the conflict report is committed, schema-valid, sorted, and reconciles with the emitted rows", async () => {
	const result = await build();
	const rows = result.scoreboards.seriesConflicts;
	const detached = rows.filter((row) => row.kind === "detached-game");
	const contradicted = rows.filter((row) => row.kind === "contradicted-series");
	assert.equal(rows.length, 14, "one row per detached game and per contradicted series");
	assert.equal(detached.length, 8);
	assert.equal(contradicted.length, 6);

	const schema = JSON.parse(await readFile(path.join(SCHEMA_DIR, "series-conflicts.schema.json"), "utf8")) as Record<string, unknown>;
	for (const [index, row] of rows.entries()) {
		assert.deepEqual(validateAgainst(schema, row, `series-conflicts:${index + 1}`), []);
	}
	const body = result.files["series-conflicts.jsonl"];
	assert.equal(body, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
	assert.equal(await readFile(path.join(CURATED_DIR, "series-conflicts.jsonl"), "utf8"), body, "the committed report is current");

	// Sorted and byte-stable, like the other reports. A rebuild must not reorder rows.
	const keys = rows.map((row) => [row.kind, row.eventId, row.matchId, row.gameId ?? "", row.sourceGameId ?? ""]);
	const sorted = [...keys].sort((left, right) => {
		for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
			const l = left[index] ?? "";
			const r = right[index] ?? "";
			if (l < r) return -1;
			if (l > r) return 1;
		}
		return 0;
	});
	assert.deepEqual(keys, sorted);

	const gamesBySource = new Map(result.scoreboards.games.map((game) => [game.source.gameId, game]));
	for (const row of detached) {
		assert.ok(row.gameId !== null && row.sourceGameId !== null);
		const game = gamesBySource.get(row.sourceGameId);
		assert.ok(game, `${row.sourceGameId}: the detached game is still emitted`);
		assert.equal(game.id, row.gameId);
		assert.equal(game.matchId, undefined, `${row.sourceGameId}: the detached game carries no canonical matchId`);
		assert.equal(game.source.matchId, row.sourceMatchId, "the source's own id is preserved (R7)");
		assert.deepEqual(row.gameTeams?.map((team) => team.teamId), game.sides.map((side) => side.teamId).sort(), "the game's own team pair");
		assert.ok(row.matchTeams, "the series' team pair is in the row");
		assert.notDeepEqual(row.gameTeams?.map((team) => team.teamId), row.matchTeams.map((team) => team.teamId), "the two pairs are the disagreement");
	}
	for (const row of contradicted) {
		assert.equal(row.gameId, null);
		assert.equal(row.sourceGameId, null);
		assert.equal(result.scoreboards.matches.some((match) => match.id === row.matchId), false, `${row.sourceMatchId}: the series is not emitted`);
		assert.equal(result.scoreboards.games.some((game) => game.matchId === row.matchId), false, "no game claims a contradicted series");
		assert.ok(row.matchTeams.length === 2);
	}
	assert.deepEqual(
		[...new Set(detached.map((row) => row.sourceGameId))].sort(),
		[...result.scoreboards.detachedGames.map((game) => game.gameId)].sort(),
		"every detached game is reported, and only detached games",
	);
	assert.deepEqual(
		[...new Set(contradicted.map((row) => row.sourceMatchId))].sort(),
		[...result.scoreboards.contradictedMatches].sort(),
		"every contradicted series is reported, and only contradicted series",
	);
});

test("the corrected evidence prose matches the bytes: 6 CLG Prime series rows and 3 Counter Logic Gaming ones", async () => {
	const result = await build();
	const underIpl = (page: string): boolean => page === IPL || page.startsWith(`${IPL}/`);
	const series = result.scoreboards.matches.filter((match) => underIpl(match.overviewPage));
	const seriesStrings = (name: string): number =>
		series.flatMap((match) => match.sides).filter((side) => side.sourceTeam === name).length;
	assert.equal(seriesStrings("CLG Prime"), 6, "six emitted series rows use the 2012 name");
	// The org name on the series table belongs to the wildcard qualifiers, which are not the
	// event (ticket 10): they are still in the recorded payloads, so the evidence is read
	// there rather than from the emitted matches.
	assert.equal(seriesStrings("Counter Logic Gaming"), 0, "no emitted IPL 5 series uses the org name");
	const source = await iplSource();
	const qualifierSeries = [...source.series.values()].filter(
		(match) => match.page.startsWith(`${IPL}/Qualifiers/`) && match.sides.includes("Counter Logic Gaming"),
	);
	assert.equal(qualifierSeries.length, 3, "the wildcard qualifiers already use the org name");
	const games = result.scoreboards.games.filter((game) => underIpl(game.overviewPage));
	assert.equal(
		games.flatMap((game) => game.sides).filter((side) => side.sourceTeam === "Counter Logic Gaming").length,
		12,
		"twelve game sides use the org name, none use CLG Prime",
	);
	assert.equal(games.flatMap((game) => game.sides).filter((side) => side.sourceTeam === "CLG Prime").length, 0);
});

test("IPL 5 builds, validates and passes the gate, with the event report saying so", async () => {
	const result = await build();
	assert.deepEqual(
		findInvariantViolations({
			events: result.events,
			selection: result.selection,
			identity: result.identity,
			games: result.scoreboards.games,
			matches: result.scoreboards.matches,
			eventGames: result.scoreboards.eventGames,
			seriesConflicts: result.scoreboards.seriesConflicts,
			eventCoverage: result.coverage.events,
			eraCoverage: result.coverage.eras,
			playerGames: result.playerGames.rows,
			eras: result.eras,
		}),
		[],
		"the whole dataset is gate-clean",
	);
	const report = result.scoreboards.eventGames.find((row) => row.overviewPage === IPL);
	assert.ok(report, "every selected event is reported on");
	assert.equal(report.state, "recorded");
	assert.equal(report.games, 72, "the four recorded payloads carry 72 games");
	assert.equal(report.matches, 36, "48 series rows: 6 contradicted and not emitted, 6 wildcard-qualifier series that are not the event");
	// The four payloads that were pending are in the cache the build reads, and the
	// manifest pins them: a reader can walk from a game's source ids to its bytes.
	const pinned = new Set(result.manifest.payloads.map((payload) => payload.file));
	for (const table of ["MatchSchedule", "ScoreboardGames", "ScoreboardPlayers", "PicksAndBansS7"]) {
		const files = result.manifest.payloads.filter((payload) => payload.table === table);
		assert.ok(files.length > 0, `${table} payloads are pinned`);
		for (const payload of files) assert.ok(pinned.has(payload.file));
	}
	assert.ok(
		result.manifest.payloads.some((payload) => payload.query?.where === "OverviewPage LIKE 'IGN ProLeague Season 5%'"),
		"the IPL 5 queries are the recorded ones, so the pins are traceable",
	);
});

test("the build's summary names both counts, so a crawl cannot absorb them silently", async () => {
	// The CLI is the artifact a reviewer reads after a build, so the counts are asserted
	// through it rather than through an internal function.
	const { stdout } = await run(process.execPath, [
		path.join(REPO_ROOT, "tools", "dataset", "cli.ts"),
		"build",
		"--raw",
		path.join(REPO_ROOT, "tools", "dataset", "fixtures", "raw"),
		"--out",
		path.join(REPO_ROOT, "data", "curated"),
		"--check",
	], { cwd: REPO_ROOT });
	assert.match(stdout, /8 game\(s\) whose series row names other teams — emitted without a canonical matchId/);
	assert.match(stdout, /6 series row\(s\) every game naming them contradicts — not emitted/);
	assert.match(stdout, /14 series conflict row\(s\) committed: 8 detached game\(s\), 6 contradicted series/);
	assert.match(stdout, /committed data matches a rebuild/);
	assert.match(stdout, /3091 game\(s\), 2068 match\(es\)/);
});

test("no disagreement is left unclassified: the class decides the handling", async () => {
	// The guard that makes the counts above load-bearing: every string-level disagreement
	// the recorded payloads hold is either resolved to one entity (legacy, link survives) or
	// detached (mixup, link refused). A third kind would show up as one of the two
	// assertions failing, and the assembler has no path that emits it.
	const found = await disagreements();
	const result = await build();
	const emitted = new Map(result.scoreboards.games.map((game) => [game.source.gameId, game]));
	for (const pairing of found) {
		const game = emitted.get(pairing.game.gameId);
		assert.ok(game, `${pairing.game.gameId}: an IPL 5 game is emitted`);
		if (pairing.sameEntity) assert.ok(game.matchId !== undefined, `${pairing.game.gameId}: a legacy name keeps its series`);
		else assert.equal(game.matchId, undefined, `${pairing.game.gameId}: a mixup is detached, never force-fitted`);
	}
	// The alias file is the only place the legacy class is decided, so removing it would
	// turn 12 pairings into mixups. That is the counterfactual this test protects: the
	// declaration is load-bearing, not decorative.
	const aliases = JSON.parse(await readFile(path.join(import.meta.dirname, "..", "rules", "identity-aliases.json"), "utf8")) as {
		aliases: { kind: string; string: string; aliasOf?: string }[];
	};
	assert.deepEqual(
		aliases.aliases.filter((alias) => alias.kind === "team").map((alias) => [alias.string, alias.aliasOf]),
		[["CLG Prime", "Counter Logic Gaming"]],
		"one team declaration, and it is the legacy name",
	);
});
