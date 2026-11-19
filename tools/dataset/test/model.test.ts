// Ticket 12's seam: curated records in, a star schema out (spec R13, D10).
//
// Everything below is asserted against the committed model and against a rebuild of
// the committed curated layer, not against hand-written fixtures. The model is a
// derived artifact, so "the files are committed and current" is one of the tests.
//
// The tests fall into four groups, matching the ticket's acceptance criteria:
//   - shape and format: one CSV per table, canonical bytes, DDL, data dictionary;
//   - grain: every fact's declared grain is unique;
//   - conformance: row counts reconcile per event and per game, every foreign key
//     resolves (the unknown member counts), and coverage survives;
//   - provenance of decisions: an unknown member exists and is used, and a real
//     rename is one dimension row plus two dated alias rows.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type { EraCoverageRecord, EventCoverageRecord } from "../coverage.ts";
import type { ModelBuild, ModelInput, ModelTable } from "../model.ts";
import {
	assembleModel,
	buildModel,
	DERIVED_MEASURE_PATTERN,
	findModelViolations,
	loadModelInput,
	parseCsv,
	REQUIRED_FACT_KEYS,
	rollupCoverage,
	writeModel,
} from "../model.ts";
import { CURATED_DIR, DATASET_DIR, REPO_ROOT } from "./helpers.ts";

const run = promisify(execFile);
const MODEL_DIR = path.join(REPO_ROOT, "data", "model");

const DIMENSIONS = ["dim_event", "dim_match", "dim_team", "dim_player", "dim_champion", "dim_patch", "dim_date", "dim_game"] as const;
const FACTS = ["fact_game_side", "fact_player_game", "fact_draft_slot"] as const;

const input: ModelInput = await loadModelInput(CURATED_DIR);
const built: ModelBuild = buildModel(input);

function table(name: string): ModelTable {
	const found = built.tables.find((candidate) => candidate.name === name);
	if (found === undefined) throw new Error(`the model has no table ${name}`);
	return found;
}

function rows(name: string): Record<string, string | number>[] {
	return table(name).rows;
}

function csvRows(text: string): Record<string, string>[] {
	const [header, ...body] = parseCsv(text);
	if (header === undefined) throw new Error("a model CSV must have a header row");
	return body.map((values) => Object.fromEntries(header.map((name, index) => [name, values[index] ?? ""])));
}

function committed(name: string): Promise<string> {
	return readFile(path.join(MODEL_DIR, name), "utf8");
}

/**
 * The committed model as name-plus-rows, the way a reader who has only
 * `data/model/` has it: the CSV bytes, no in-memory build, no curated input.
 */
async function committedTables(): Promise<{ name: string; rows: Record<string, string>[] }[]> {
	const tables: { name: string; rows: Record<string, string>[] }[] = [];
	for (const file of (await readdir(MODEL_DIR)).sort()) {
		if (file.endsWith(".csv")) tables.push({ name: file.slice(0, -4), rows: csvRows(await committed(file)) });
	}
	return tables;
}

/** A committed curated JSONL file, parsed. */
async function curatedJsonl<T>(file: string): Promise<T[]> {
	const text = await readFile(path.join(CURATED_DIR, file), "utf8");
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as T);
}

function keys(name: string): Set<string> {
	const dimension = table(name);
	const column = dimension.columns.find((candidate) => candidate.key === "surrogate");
	if (column === undefined) throw new Error(`${name} has no surrogate key column`);
	return new Set(dimension.rows.map((row) => String(row[column.name])));
}

test("the committed model is exactly a rebuild of the committed curated layer", async () => {
	const committedFiles = (await readdir(MODEL_DIR)).sort();
	assert.deepEqual(committedFiles, Object.keys(built.files).sort(), "data/model/ holds every generated file and nothing else");
	for (const [file, body] of Object.entries(built.files)) {
		assert.equal(await committed(file), body, `data/model/${file} is stale — rebuild with: node tools/dataset/cli.ts model`);
	}
});

test("the artifact is CSV, DDL and a data dictionary — never a generated database", async () => {
	const files = await readdir(MODEL_DIR);
	assert.ok(files.includes("schema.sql"), "the DDL ships beside the CSVs");
	assert.ok(files.includes("data-dictionary.md"), "the data dictionary ships beside the CSVs");
	assert.deepEqual(files.filter((file) => /\.(sqlite|db|db3)$/i.test(file)), [], "a generated database file is never committed");
	for (const dimension of DIMENSIONS) {
		assert.ok(files.includes(`${dimension}.csv`), `${dimension}.csv is committed`);
	}
	for (const fact of FACTS) {
		assert.ok(files.includes(`${fact}.csv`), `${fact}.csv is committed`);
	}
	assert.ok(files.includes("bridge_alias.csv"), "the alias bridge is committed");
});

test("every declared grain is unique, and the model proves it", () => {
	for (const name of FACTS) {
		const fact = table(name);
		assert.ok(fact.grainColumns.length > 0, `${name} must declare a grain`);
		const seen = new Set<string>();
		for (const row of fact.rows) {
			const key = fact.grainColumns.map((column) => String(row[column])).join("\u0000");
			assert.ok(!seen.has(key), `${name} repeats grain ${JSON.stringify(key)}`);
			seen.add(key);
		}
		assert.equal(seen.size, fact.rows.length, `${name}'s grain must identify every row exactly once`);
	}
	for (const name of DIMENSIONS) {
		const dimension = table(name);
		const surrogate = dimension.columns.find((candidate) => candidate.key === "surrogate");
		assert.ok(surrogate, `${name} must carry a surrogate key`);
		const surrogateValues = dimension.rows.map((row) => row[surrogate.name]);
		assert.equal(new Set(surrogateValues).size, surrogateValues.length, `${name}'s surrogate key must be unique`);
		if (dimension.naturalKey !== undefined) {
			const natural = dimension.rows.map((row) => row[dimension.naturalKey!]).filter((value) => value !== "");
			assert.equal(new Set(natural).size, natural.length, `${name}'s natural key must be unique`);
		}
	}
});

test("row counts reconcile with the curated layer per event and per game", () => {
	const eventKeyToId = new Map(rows("dim_event").map((row) => [String(row.event_key), String(row.event_id)]));
	const gameKeyToId = new Map(rows("dim_game").map((row) => [String(row.game_key), String(row.game_id)]));

	const expectedGames = new Map<string, number>();
	for (const game of input.games) expectedGames.set(game.eventId, (expectedGames.get(game.eventId) ?? 0) + 1);
	const expectedPlayers = new Map<string, number>();
	for (const row of input.playerGames) expectedPlayers.set(row.eventId, (expectedPlayers.get(row.eventId) ?? 0) + 1);
	const expectedDraftSlots = new Map<string, number>();
	for (const game of input.games) {
		if (game.draft === undefined) continue;
		const slots = game.draft.sides.reduce((sum, side) => sum + side.picks.length + side.bans.length, 0);
		expectedDraftSlots.set(game.eventId, (expectedDraftSlots.get(game.eventId) ?? 0) + slots);
	}

	const countByEvent = (name: string): Map<string, number> => {
		const counts = new Map<string, number>();
		for (const row of rows(name)) {
			const eventId = eventKeyToId.get(String(row.event_key));
			assert.ok(eventId, `${name} carries an event key that is not in dim_event`);
			counts.set(eventId, (counts.get(eventId) ?? 0) + 1);
		}
		return counts;
	};

	const sides = countByEvent("fact_game_side");
	for (const [eventId, games] of expectedGames) {
		assert.equal(sides.get(eventId) ?? 0, games * 2, `${eventId}: every game needs exactly two side rows`);
	}
	const players = countByEvent("fact_player_game");
	for (const [eventId, playerRows] of expectedPlayers) {
		assert.equal(players.get(eventId) ?? 0, playerRows, `${eventId}: every curated player row needs one fact row`);
	}
	const draft = countByEvent("fact_draft_slot");
	for (const eventId of new Set([...expectedGames.keys(), ...expectedDraftSlots.keys()])) {
		assert.equal(draft.get(eventId) ?? 0, expectedDraftSlots.get(eventId) ?? 0, `${eventId}: every draft slot needs one fact row`);
	}

	// Per game, the same statement without an event in the middle.
	const sideCounts = new Map<string, number>();
	for (const row of rows("fact_game_side")) sideCounts.set(String(row.game_key), (sideCounts.get(String(row.game_key)) ?? 0) + 1);
	for (const game of input.games) {
		const gameKey = [...gameKeyToId].find(([, gameId]) => gameId === game.id)?.[0];
		assert.ok(gameKey, `${game.id} must have a dim_game row`);
		assert.equal(sideCounts.get(gameKey) ?? 0, 2, `${game.id}: every game needs exactly two side rows`);
	}
	assert.equal(rows("fact_game_side").length, input.games.length * 2);
	assert.equal(rows("fact_player_game").length, input.playerGames.length);
	assert.equal(
		rows("fact_draft_slot").length,
		input.games.reduce((sum, game) => sum + (game.draft?.sides.reduce((inner, side) => inner + side.picks.length + side.bans.length, 0) ?? 0), 0),
	);
});

test("every fact foreign key resolves to a dimension row, including the unknown member", () => {
	const dimensionKeys = new Map<string, Set<string>>();
	for (const name of DIMENSIONS) dimensionKeys.set(name, keys(name));
	for (const name of FACTS) {
		const fact = table(name);
		const foreignKeys = fact.columns.filter((column) => column.references !== undefined);
		assert.ok(foreignKeys.length > 0, `${name} must declare its foreign keys`);
		for (const column of foreignKeys) {
			const [targetTable, targetColumn] = column.references!.split(".");
			const target = table(targetTable);
			assert.ok(target, `${name}.${column.name} references a table that is not in the model`);
			const targetValues = new Set(target.rows.map((row) => String(row[targetColumn])));
			for (const row of fact.rows) {
				const value = String(row[column.name]);
				assert.ok(value !== "", `${name}.${column.name} is an empty join key — absence is the unknown member's 0, never a blank`);
				assert.ok(targetValues.has(value), `${name}.${column.name}=${value} has no row in ${targetTable}`);
			}
		}
	}
	// The bridge is polymorphic, so its target depends on `kind`.
	const entityTables = { team: "dim_team", player: "dim_player", champion: "dim_champion" } as const;
	for (const row of rows("bridge_alias")) {
		const target = entityTables[row.kind as keyof typeof entityTables];
		assert.ok(target, `bridge_alias.kind=${row.kind} is not an entity kind`);
		assert.ok(dimensionKeys.get(target)!.has(String(row.entity_key)), `alias ${row.alias_string} points at a missing ${row.kind}`);
	}
});

test("the unknown member exists in every dimension and is what a missing value joins to", () => {
	for (const name of DIMENSIONS) {
		const dimension = table(name);
		const surrogate = dimension.columns.find((column) => column.key === "surrogate")!;
		const unknown = dimension.rows.filter((row) => row[surrogate.name] === 0);
		assert.equal(unknown.length, 1, `${name} needs exactly one unknown member`);
		assert.equal(unknown[0][dimension.naturalKey!], "", `${name}'s unknown member has no natural key`);
		assert.equal(unknown[0][dimension.displayKey!], "Unknown", `${name}'s unknown member has a display name`);
	}

	// A game with no patch and no series is the thin-era case: the model must keep it,
	// with the unknown key, rather than dropping it from an inner join.
	const thin: ModelInput = JSON.parse(JSON.stringify(input));
	const game = thin.games.find((candidate) => candidate.patch !== undefined && candidate.matchId !== undefined)!;
	delete game.patch;
	delete game.matchId;
	const changed = buildModel(thin);
	const sideRows = changed.tables.find((candidate) => candidate.name === "fact_game_side")!.rows;
	const gameKey = changed.tables.find((candidate) => candidate.name === "dim_game")!.rows.find((row) => row.game_id === game.id)!.game_key;
	const rowsForGame = sideRows.filter((row) => row.game_key === gameKey);
	assert.equal(rowsForGame.length, 2, "the game survives with two side rows");
	for (const row of rowsForGame) {
		assert.equal(row.match_key, 0, "a missing series joins to the unknown match");
		assert.equal(row.patch_key, 0, "a missing patch joins to the unknown patch");
	}
});

test("the model refuses curated input the invariant gate never saw, and the facts agree with each other", () => {
	// A hand-edited curated file can hold a player row whose eventId disagrees with its
	// game's. Every fact stays self-consistent, so only the seam and the cross-fact
	// gate catch it — and both must name the game and the two events.
	const bad = JSON.parse(JSON.stringify(input));
	const row = bad.playerGames[0];
	const ownEvent = row.eventId;
	const otherEvent = bad.events.find((event) => event.id !== row.eventId).id;
	row.eventId = otherEvent;
	assert.throws(
		() => buildModel(bad),
		(error: Error) => {
			assert.match(error.message, new RegExp(row.gameId), "the seam names the game");
			assert.match(error.message, new RegExp(otherEvent), "the seam names the row's claimed event");
			assert.match(error.message, new RegExp(ownEvent), "the seam names the game's own event");
			return true;
		},
		"a player row whose eventId disagrees with its game is refused",
	);
	// The conformance gate catches the same contradiction if the facts are built anyway.
	const assembled = assembleModel(bad);
	const violations = findModelViolations(bad, assembled);
	assert.ok(
		violations.some((violation) => violation.includes(row.gameId) && violation.includes(otherEvent) && violation.includes("disagree on the event")),
		`the cross-fact gate must flag the disagreement, got: ${JSON.stringify(violations)}`,
	);

	// The same for a player row whose team is not one of the game's two sides.
	const stranger = JSON.parse(JSON.stringify(input));
	const playerRow = stranger.playerGames[0];
	const game = stranger.games.find((candidate) => candidate.id === playerRow.gameId);
	const outsideTeam = stranger.teams.find((team) => !game.sides.some((side) => side.teamId === team.id)).id;
	playerRow.teamId = outsideTeam;
	const strangerAssembled = assembleModel(stranger);
	assert.ok(
		findModelViolations(stranger, strangerAssembled).some(
			(violation) => violation.includes(playerRow.gameId) && /not one of the game's two sides/.test(violation),
		),
		"a player fact row whose team is neither side is flagged",
	);
	assert.throws(() => buildModel(stranger), /not one of the game's two sides|claims event/, "the seam refuses the inconsistent team");
});

test("a winner that is neither side is refused, and an unrecorded winner is an empty field, not a zero", () => {
	// Absent: both sides carry an empty is_winner, distinguishable from a recorded loss.
	const absent = JSON.parse(JSON.stringify(input));
	const game = absent.games[0];
	game.winnerTeamId = undefined;
	const builtAbsent = buildModel(absent);
	const dimGame = builtAbsent.tables.find((candidate) => candidate.name === "dim_game");
	const gameKey = dimGame.rows.find((row) => row.game_id === game.id).game_key;
	const sideRows = builtAbsent.tables.find((candidate) => candidate.name === "fact_game_side").rows.filter((row) => String(row.game_key) === String(gameKey));
	assert.deepEqual(
		sideRows.map((row) => row.is_winner),
		["", ""],
		"no recorded winner is an empty field on both side rows, not a 0",
	);
	const column = builtAbsent.tables.find((candidate) => candidate.name === "fact_game_side").columns.find((candidate) => candidate.name === "is_winner");
	assert.match(column.absent ?? "", /no winner/, "the column's absence rule must state the winner convention");

	// A winner id that is neither side contradicts the fact's own rows: refused.
	const badWinner = JSON.parse(JSON.stringify(input));
	const otherGame = badWinner.games[0];
	const outsideTeam = badWinner.teams.find((team) => !otherGame.sides.some((side) => side.teamId === team.id)).id;
	otherGame.winnerTeamId = outsideTeam;
	assert.throws(
		() => buildModel(badWinner),
		(error: Error) => {
			assert.match(error.message, new RegExp(otherGame.id));
			assert.match(error.message, /neither side/);
			return true;
		},
		"an out-of-sides winner is refused, naming the game",
	);
});

test("the unknown member is joinable from exactly the fact keys the curated record can miss", () => {
	const joinable = new Set<string>();
	for (const name of FACTS) {
		for (const column of table(name).columns.filter((candidate) => candidate.references !== undefined)) {
			if (REQUIRED_FACT_KEYS.has(column.name)) {
				for (const row of rows(name)) {
					assert.notEqual(String(row[column.name]), "0", `${name}.${column.name} must never reach the unknown member`);
				}
			} else {
				joinable.add(column.name);
			}
		}
	}
	assert.deepEqual(
		[...joinable].sort(),
		["match_key", "patch_key"],
		"exactly the optional keys — series and patch — may join to key 0; every other dimension's unknown member is unreachable by design",
	);
	const documented = built.files["data-dictionary.md"];
	assert.match(documented, /Every dimension keeps its unknown member, including the ones no fact can currently reach at `0`/);
	assert.match(documented, /refuses `0` in a fact key the curated record always states/);
});

test("dim_match is sliceable by event: it carries event_key, and its unknown member joins to the unknown event", () => {
	const match = table("dim_match");
	const column = match.columns.find((candidate) => candidate.name === "event_key");
	assert.ok(column, "dim_match must carry event_key");
	assert.equal(column.references, "dim_event.event_key", "event_key is a declared foreign key into dim_event");
	const unknown = match.rows.find((row) => row.match_key === 0);
	assert.equal(unknown.event_key, 0, "the unknown member's event_key joins to the unknown event, never an empty field");
	const eventKeys = new Set(rows("dim_event").map((row) => String(row.event_key)));
	for (const row of match.rows) {
		assert.ok(eventKeys.has(String(row.event_key)), `dim_match event_key ${row.event_key} must resolve`);
	}
	// And it agrees with the facts: a series' event is its games' event.
	const matchEventByKey = new Map(match.rows.map((row) => [String(row.match_key), String(row.event_key)]));
	for (const factRow of rows("fact_game_side")) {
		const matchKey = String(factRow.match_key);
		if (matchKey === "0") continue;
		assert.equal(matchEventByKey.get(matchKey), String(factRow.event_key), "a fact's series event must be the fact's event");
	}
});

test("a rename is one dimension row plus two dated alias rows, and both strings resolve to it", () => {
	const team = rows("dim_team").find((row) => row.team_id === "tm-9a4fde0c4aad");
	assert.ok(team, "the fixture's renamed team must be in the model");
	assert.equal(rows("dim_team").filter((row) => row.team_id === "tm-9a4fde0c4aad").length, 1, "a rename must not duplicate the dimension row");

	const dated = rows("bridge_alias").filter(
		(row) => row.kind === "team" && row.entity_key === team.team_key && row.valid_from !== "" && row.valid_to !== "",
	);
	assert.equal(dated.length, 2, "the rename has two dated source strings");
	assert.deepEqual(dated.map((row) => row.alias_string).sort(), ["SK Telecom T1", "T1"]);

	// Both the old and the new source string resolve to the same dimension row.
	const resolve = (source: string, date: string): number | undefined => {
		const candidates = rows("bridge_alias").filter(
			(row) => row.kind === "team" && row.alias_string === source && String(row.valid_from) <= date && date <= String(row.valid_to),
		);
		assert.equal(candidates.length, 1, `${source} must resolve to exactly one team on ${date}`);
		return candidates[0].entity_key as number;
	};
	assert.equal(resolve("SK Telecom T1", "2015-10-01"), team.team_key);
	assert.equal(resolve("T1", "2023-05-10"), team.team_key);
});

test("coverage declarations survive into the model rather than being averaged away", () => {
	const gamesById = new Map(input.games.map((game) => [game.id, game]));
	for (const row of rows("dim_game")) {
		if (row.game_key === 0) continue;
		const game = gamesById.get(String(row.game_id));
		assert.ok(game, `${row.game_id} is a modelled game the curated layer does not carry`);
		assert.equal(row.era, game.era, `${game.id}: era survives`);
		assert.equal(row.team_stats_coverage, game.coverage.teamStats, `${game.id}: team-stat coverage survives`);
		assert.equal(row.draft_coverage, game.coverage.draft, `${game.id}: draft coverage survives`);
		assert.equal(row.player_stats_coverage, game.coverage.playerStats, `${game.id}: player-stat coverage survives`);
		assert.equal(row.draft_fidelity, game.draft?.fidelity ?? "", `${game.id}: draft fidelity survives`);
	}
	// Thin eras are present, not filtered out — and each keeps its own shape rather
	// than being flattened to one "thin" label. IEM IX 2015 (pre-herald) states a
	// partial team row; IPL 5 (2012, also pre-herald) states no team statistics at all
	// and no gold per player, so its coverage is `unavailable`/`partial`. A blanket
	// "thin means partial" assertion would hide exactly that difference.
	const thin = rows("dim_game").filter((row) => row.era === "pre-herald");
	assert.equal(thin.length, input.games.filter((game) => game.era === "pre-herald").length);
	const byShape = new Map<string, number>();
	for (const row of thin) {
		const shape = `${row.team_stats_coverage}/${row.player_stats_coverage}/${row.draft_coverage}`;
		byShape.set(shape, (byShape.get(shape) ?? 0) + 1);
	}
	// The pre-herald era is not one shape: IPL 5 states no team statistics at all, while the
	// 2011-2016 events that do state them are `partial` for the fields the wiki never
	// recorded. Both shapes are present, and each is counted rather than averaged.
	assert.deepEqual(
		[...byShape.keys()].sort(),
		["partial/partial/partial", "unavailable/partial/partial"],
		`the thin era keeps each event's own coverage shape: ${JSON.stringify([...byShape])}`,
	);
	assert.equal(
		byShape.get("unavailable/partial/partial"),
		thin.filter((row) => row.team_stats_coverage === "unavailable").length,
		"the games the source states no team statistics for (IPL 5 and the 2011-2013 events)",
	);
	assert.equal(
		(byShape.get("partial/partial/partial") ?? 0) + (byShape.get("unavailable/partial/partial") ?? 0),
		thin.length,
		"every pre-herald game is one of the two shapes",
	);

	// A game whose measures are absent is as visible as a rich one: it keeps its
	// dimension row and both side rows, and the absent measures are empty fields rather
	// than zeros that a later SUM would read as recorded data (ticket 13).
	const ipl = input.games.filter((game) => game.eventName === "IPL 5");
	assert.ok(ipl.length > 0, "the corpus must still carry the thin event this asserts about");
	const iplGameKeys = new Set(
		rows("dim_game")
			.filter((row) => ipl.some((game) => game.id === row.game_id))
			.map((row) => String(row.game_key)),
	);
	assert.equal(iplGameKeys.size, ipl.length, "every IPL 5 game has a dim_game row");
	for (const gameKey of iplGameKeys) {
		const sideRows = rows("fact_game_side").filter((row) => String(row.game_key) === gameKey);
		assert.equal(sideRows.length, 2, `game ${gameKey}: an absent measure must not cost the game its side rows`);
		for (const row of sideRows) {
			assert.equal(row.kills, "", `game ${gameKey}: a measure the source never recorded is absent, not 0`);
			assert.equal(row.gold, "", `game ${gameKey}: a measure the source never recorded is absent, not 0`);
		}
	}
});

test("facts contain measures only: a derived-measure column name fails the test", () => {
	const derived = DERIVED_MEASURE_PATTERN;
	assert.ok(
		derived.test("win_rate") && derived.test("avg_gold") && derived.test("kills_per_game") && derived.test("kda") && derived.test("gpm") && derived.test("damage_per_min_10"),
		"the guard must catch the shapes it names, including the kda, gpm and per-min ones",
	);
	for (const name of FACTS) {
		for (const column of table(name).columns) {
			assert.doesNotMatch(column.name, derived, `${name}.${column.name} is a derived measure; the analyst does the aggregating (R13)`);
		}
	}
	// The guard is a naming heuristic and says so: the dictionary must not overclaim it.
	assert.match(
		built.files["data-dictionary.md"],
		/naming heuristic, not a semantic one/,
		"the dictionary must state that the no-derived-measure guard is a name heuristic",
	);
});

test("the CSVs are canonical: header, stable order, RFC 4180 quoting, LF, no BOM, ISO dates, plain integers", () => {
	for (const [file, body] of Object.entries(built.files)) {
		if (!file.endsWith(".csv")) continue;
		const tableName = file.slice(0, -4);
		const model = table(tableName);
		assert.ok(body.length > 0, `${file} must not be empty`);
		assert.ok(!body.startsWith("\uFEFF"), `${file} must not carry a BOM`);
		assert.ok(!body.includes("\r"), `${file} must use LF line endings`);
		assert.ok(body.endsWith("\n"), `${file} must end with a newline`);
		const parsed = parseCsv(body);
		assert.deepEqual(parsed[0], model.columns.map((column) => column.name), `${file}'s header is the declared column order`);
		assert.equal(parsed.length - 1, model.rows.length, `${file}'s row count is its header plus every row`);
		for (const values of parsed.slice(1)) assert.equal(values.length, parsed[0].length, `${file}: every row has one field per column`);
		for (const [index, column] of model.columns.entries()) {
			if (column.type !== "INTEGER") continue;
			for (const values of parsed.slice(1)) {
				const value = values[index];
				if (value === "") continue;
				assert.match(value, /^-?\d+$/, `${file}.${column.name} must be an unformatted integer, got ${JSON.stringify(value)}`);
			}
		}
	}
	for (const [file, body] of Object.entries(built.files)) {
		if (!file.endsWith(".csv")) continue;
		for (const match of body.matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g)) {
			assert.match(match[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, `${file}: timestamps are ISO-8601 UTC`);
		}
	}
	// RFC 4180 quoting is exercised on a value that needs it, not assumed.
	const quoting: ModelInput = JSON.parse(JSON.stringify(input));
	quoting.teams[0].name = 'A, "B"\nC';
	const changed = buildModel(quoting);
	const body = changed.files["dim_team.csv"];
	assert.ok(body.includes('"A, ""B""\nC"'), "a field with a comma, a quote and a newline is quoted and escaped");
	const roundTrip = csvRows(body).find((row) => row.team_id === quoting.teams[0].id);
	assert.equal(roundTrip?.team_name, 'A, "B"\nC', "the quoted field round-trips");
});

test("the model is deterministic: two builds produce byte-identical files", () => {
	const second = buildModel(JSON.parse(JSON.stringify(input)));
	assert.deepEqual(second.files, built.files, "the model must not depend on object identity, iteration order or the clock");
});

test("the DDL loads the CSVs into SQLite, and no inner join between a fact and a dimension loses a row", () => {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(built.files["schema.sql"]);
		for (const model of built.tables) {
			const csv = built.files[model.file];
			const [header, ...body] = parseCsv(csv);
			const insert = db.prepare(`INSERT INTO ${model.name} (${header.join(", ")}) VALUES (${header.map(() => "?").join(", ")})`);
			for (const values of body) insert.run(...values);
		}
		const count = (sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);

		for (const model of built.tables) {
			assert.equal(count(`SELECT COUNT(*) AS n FROM ${model.name}`), model.rows.length, `${model.name} loaded every CSV row`);
		}
		assert.equal(count("SELECT COUNT(*) AS n FROM dim_game WHERE game_key <> 0"), input.games.length);
		assert.equal(count("SELECT COUNT(*) AS n FROM dim_match WHERE match_key <> 0"), input.matches.length);
		assert.equal(count("SELECT COUNT(*) AS n FROM fact_game_side"), input.games.length * 2);
		assert.equal(count("SELECT COUNT(*) AS n FROM fact_player_game"), input.playerGames.length);
		assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), [], "the DDL's foreign keys hold after loading the CSVs");

		// The load reproduces the curated dataset's counts per event too, not only per
		// table: a row that reached the right table carrying the wrong event would pass a
		// whole-table count and fail here (ticket 13).
		const perEvent = (sql: string): Map<string, number> =>
			new Map((db.prepare(sql).all() as { event_id: string; n: number }[]).map((row) => [row.event_id, Number(row.n)]));
		const expectedGames = new Map<string, number>();
		for (const game of input.games) expectedGames.set(game.eventId, (expectedGames.get(game.eventId) ?? 0) + 1);
		const expectedPlayerRows = new Map<string, number>();
		for (const row of input.playerGames) expectedPlayerRows.set(row.eventId, (expectedPlayerRows.get(row.eventId) ?? 0) + 1);
		const expectedDraftRows = new Map<string, number>();
		let draftEntries = 0;
		for (const game of input.games) {
			const entries = game.draft?.sides.reduce((sum, side) => sum + side.picks.length + side.bans.length, 0) ?? 0;
			draftEntries += entries;
			expectedDraftRows.set(game.eventId, (expectedDraftRows.get(game.eventId) ?? 0) + entries);
		}
		assert.equal(count("SELECT COUNT(*) AS n FROM fact_draft_slot"), draftEntries, "every curated draft entry loaded");
		const sqlPerEvent = (fact: string): Map<string, number> =>
			perEvent(`SELECT e.event_id AS event_id, COUNT(*) AS n FROM ${fact} AS f INNER JOIN dim_event AS e ON f.event_key = e.event_key GROUP BY e.event_id`);
		const sidesPerEvent = sqlPerEvent("fact_game_side");
		const playersPerEvent = sqlPerEvent("fact_player_game");
		const draftsPerEvent = sqlPerEvent("fact_draft_slot");
		for (const [eventId, games] of expectedGames) {
			assert.equal(sidesPerEvent.get(eventId), games * 2, `${eventId}: SQL counts two side rows per curated game`);
			assert.equal(playersPerEvent.get(eventId) ?? 0, expectedPlayerRows.get(eventId) ?? 0, `${eventId}: SQL counts the curated player rows`);
			assert.equal(draftsPerEvent.get(eventId) ?? 0, expectedDraftRows.get(eventId) ?? 0, `${eventId}: SQL counts the curated draft entries`);
		}

		for (const name of FACTS) {
			const fact = table(name);
			for (const column of fact.columns.filter((candidate) => candidate.references !== undefined)) {
				const [targetTable, targetColumn] = column.references!.split(".");
				const joined = count(
					`SELECT COUNT(*) AS n FROM ${name} AS fact INNER JOIN ${targetTable} AS dim ON fact.${column.name} = dim.${targetColumn}`,
				);
				assert.equal(joined, fact.rows.length, `INNER JOIN ${targetTable} loses ${fact.rows.length - joined} ${name} row(s) on ${column.name}`);
			}
		}
	} finally {
		db.close();
	}
});

test("the `model` command writes the committed bytes and `--check` reports drift", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "model-cli-"));
	try {
		await run(process.execPath, [path.join(DATASET_DIR, "cli.ts"), "model", "--out", dir], { cwd: DATASET_DIR });
		for (const [file, body] of Object.entries(built.files)) {
			assert.equal(await readFile(path.join(dir, file), "utf8"), body, `${file} written by the CLI must equal the built bytes`);
		}
		await run(process.execPath, [path.join(DATASET_DIR, "cli.ts"), "model", "--out", dir, "--check"], { cwd: DATASET_DIR });
		assert.equal(await committed("dim_team.csv"), built.files["dim_team.csv"], "the committed model is current");

		// Drift is reported, not rewritten: a changed byte in one table fails the check.
		await writeFile(path.join(dir, "dim_team.csv"), "tampered\n", "utf8");
		await assert.rejects(
			run(process.execPath, [path.join(DATASET_DIR, "cli.ts"), "model", "--out", dir, "--check"], { cwd: DATASET_DIR }),
			(error: Error & { code?: number; stderr?: string }) => {
				assert.equal(error.code, 1, "a drifted model exits non-zero");
				assert.match(error.stderr ?? "", /dim_team\.csv/, "the failing file is named");
				return true;
			},
		);
		await writeFile(path.join(dir, "dim_team.csv"), built.files["dim_team.csv"], "utf8");

		// So does a file the build no longer emits: a former build's leftover must not
		// let a dropped table look committed and current.
		await writeFile(path.join(dir, "stray-leftover-from-an-old-build.csv"), "stale\n", "utf8");
		await assert.rejects(
			run(process.execPath, [path.join(DATASET_DIR, "cli.ts"), "model", "--out", dir, "--check"], { cwd: DATASET_DIR }),
			(error: Error & { code?: number; stderr?: string }) => {
				assert.equal(error.code, 1, "a stray file exits non-zero");
				assert.match(error.stderr ?? "", /stray-leftover-from-an-old-build\.csv/, "the stray file is named");
				assert.match(error.stderr ?? "", /does not emit this file/, "the reason is the build's own file set");
				return true;
			},
		);
		await rm(path.join(dir, "stray-leftover-from-an-old-build.csv"));

		// And a missing emitted file: the check must notice a table is gone.
		await rm(path.join(dir, "dim_match.csv"));
		await assert.rejects(
			run(process.execPath, [path.join(DATASET_DIR, "cli.ts"), "model", "--out", dir, "--check"], { cwd: DATASET_DIR }),
			(error: Error & { code?: number; stderr?: string }) => {
				assert.equal(error.code, 1, "a missing table exits non-zero");
				assert.match(error.stderr ?? "", /dim_match\.csv/, "the missing file is named");
				return true;
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("`writeModel` is the only writer and leaves the curated layer alone", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "model-write-"));
	try {
		const curated = async (): Promise<Map<string, Buffer>> => {
			const files = new Map<string, Buffer>();
			for (const name of (await readdir(CURATED_DIR)).sort()) {
				if (name.endsWith(".jsonl") || name === "manifest.json") files.set(name, await readFile(path.join(CURATED_DIR, name)));
			}
			return files;
		};
		const before = await curated();
		const rebuilt = buildModel(await loadModelInput(CURATED_DIR));
		await writeModel(rebuilt, dir);
		assert.deepEqual(await curated(), before, "building and writing the model must not touch data/curated/");
		const written = (await readdir(dir)).sort();
		assert.deepEqual(written, Object.keys(built.files).sort());
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the model alone reproduces the curated coverage reports, at both grains", async () => {
	// `event-coverage.jsonl` and `era-coverage.jsonl` aggregate the per-game markers. The
	// markers live on `dim_game`, so the same rollup is computable from the modelled layer
	// — and it has to say the same thing, or a fact consumer and a curated consumer answer
	// "what does this era hold?" differently (ticket 13, spec R6 and R13).
	const reportEvents = await curatedJsonl<EventCoverageRecord>("event-coverage.jsonl");
	const reportEras = await curatedJsonl<EraCoverageRecord>("era-coverage.jsonl");
	const modelTables = await committedTables();
	const rollup = rollupCoverage(modelTables);

	assert.deepEqual(
		rollup.events,
		reportEvents,
		"a reader with only data/model/*.csv must derive the curated per-event rollup — games, eras touched and every group count and state",
	);
	assert.deepEqual(
		rollupCoverage(built.tables).events,
		rollup.events,
		"the committed CSVs and the in-memory build must roll up identically",
	);
	assert.equal(
		rollup.events.reduce((sum, record) => sum + record.games, 0),
		input.games.length,
		"every modelled game appears in exactly one event's rollup",
	);

	const derivedEras = new Map(rollup.eras.map((record) => [record.era, record]));
	for (const record of reportEras) {
		const derived = derivedEras.get(record.era);
		if (record.games === 0) {
			// A declared era with no games is the era table's declaration, not a game fact:
			// the model has no row to roll up and must not invent one. What must not happen
			// is an era going missing while it still has games — asserted just below.
			assert.equal(derived, undefined, `${record.era} has no games; the model must not carry an era row for it`);
			continue;
		}
		assert.ok(derived, `${record.era} carries ${record.games} game(s) in the report, so the model must roll them up`);
		// `from` is the era table's boundary date, not something a game states; everything
		// else in the row is a property of the games and must match.
		const expected: Partial<EraCoverageRecord> = { ...record };
		delete expected.from;
		assert.deepEqual(derived, expected, `${record.era}: the model's era rollup must match era-coverage.jsonl on everything a game states`);
	}
	assert.deepEqual(
		[...derivedEras.keys()].sort(),
		reportEras.filter((record) => record.games > 0).map((record) => record.era).sort(),
		"the model rolls up exactly the eras its games belong to — no era invented, none dropped",
	);
	assert.equal(
		rollup.eras.reduce((sum, record) => sum + record.games, 0),
		input.games.length,
		"every modelled game appears in exactly one era's rollup",
	);

	// The rollup reads the tables it is handed, not the curated files, so a model whose
	// markers drifted cannot agree with the report by accident.
	const tampered = modelTables.map((table) => ({
		name: table.name,
		rows: table.rows.map((row) => ({ ...row })),
	}));
	const dimGame = tampered.find((table) => table.name === "dim_game")!.rows;
	const thin = dimGame.find((row) => row.game_id !== "" && row.team_stats_coverage === "unavailable");
	assert.ok(thin, "the corpus must still carry a game with no team statistics");
	thin.team_stats_coverage = "complete";
	assert.notDeepEqual(rollupCoverage(tampered).events, reportEvents, "a marker flipped in the model must move the rollup away from the report");
	thin.team_stats_coverage = "banana";
	assert.throws(() => rollupCoverage(tampered), /expected complete, partial or unavailable/, "a marker outside the three states is refused, not counted");
});

test("the committed CSVs load through an independent RFC 4180 reader with no preprocessing", async (t) => {
	// pandas, polars and pyarrow are not installed here, and adding one would be the
	// repository's first data dependency for a test — so the dataframe half of the load
	// criterion is proved through a reader that this repository did not write: Python's
	// stdlib `csv` module. It does its own field splitting, quoting and header handling.
	// If it recovers every field exactly and reads every integer as-is, then no export-side
	// quoting repair or type-fixing step is needed, which is the whole claim.
	const python = await run("python3", ["--version"]).catch(() => undefined);
	if (python === undefined) {
		t.skip("python3 is not installed, so the independent-reader load cannot be executed here");
		return;
	}

	const probe = path.join(await mkdtemp(path.join(tmpdir(), "csv-load-")), "load.py");
	const integerColumns: Record<string, string[]> = {};
	for (const model of built.tables) {
		integerColumns[model.name] = model.columns.filter((column) => column.type === "INTEGER").map((column) => column.name);
	}
	try {
		await writeFile(
			probe,
			`import csv, hashlib, json, os, sys

root, spec = sys.argv[1], json.loads(sys.argv[2])
report = {}
for name in sorted(os.listdir(root)):
    if not name.endswith(".csv"):
        continue
    table = name[:-4]
    with open(os.path.join(root, name), newline="", encoding="utf-8") as handle:
        rows = list(csv.reader(handle))
    header, body = rows[0], rows[1:]
    for index, row in enumerate(body):
        if len(row) != len(header):
            raise SystemExit("%s: row %d has %d fields, the header has %d" % (name, index + 1, len(row), len(header)))
    integers = 0
    for column in spec.get(table, []):
        position = header.index(column)
        for row in body:
            value = row[position]
            if value == "":
                continue
            if str(int(value)) != value:
                raise SystemExit("%s.%s: %r is not an integer this reader can take as-is" % (name, column, value))
            integers += 1
    flat = "\\u0000".join(cell for row in rows for cell in row)
    report[table] = {
        "header": header,
        "rows": len(body),
        "empty": sum(1 for row in body for value in row if value == ""),
        "integers": integers,
        "sha256": hashlib.sha256(flat.encode("utf-8")).hexdigest(),
    }
print(json.dumps(report))
`,
			"utf8",
		);
		const { stdout } = await run("python3", [probe, MODEL_DIR, JSON.stringify(integerColumns)]);
		const loaded = JSON.parse(stdout) as Record<
			string,
			{ header: string[]; rows: number; empty: number; integers: number; sha256: string }
		>;

		// The same facts, read back through this repository's own parser.
		const expected: typeof loaded = {};
		for (const model of built.tables) {
			const parsed = parseCsv(built.files[model.file]);
			const [header, ...body] = parsed;
			expected[model.name] = {
				header,
				rows: body.length,
				empty: body.reduce((sum, row) => sum + row.filter((value) => value === "").length, 0),
				integers: model.columns.reduce(
					(sum, column, index) => (column.type === "INTEGER" ? sum + body.filter((row) => row[index] !== "").length : sum),
					0,
				),
				sha256: createHash("sha256").update(parsed.flat().join("\u0000"), "utf8").digest("hex"),
			};
		}
		assert.deepEqual(
			loaded,
			expected,
			"the independent reader must recover the same header, row count, absent cells, integer cells and fields as the build wrote",
		);
		assert.ok(loaded.dim_game, "the reader found dim_game");
		assert.ok(Object.values(loaded).some((table) => table.empty > 0), "the thin era's absent values are empty fields this reader saw as empty");
		assert.ok(Object.values(loaded).every((table) => table.integers > 0), "every table's integer columns read back unchanged");
	} finally {
		await rm(path.dirname(probe), { recursive: true, force: true });
	}
});
