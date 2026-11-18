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
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type { ModelBuild, ModelInput, ModelTable } from "../model.ts";
import {
	assembleModel,
	buildModel,
	DERIVED_MEASURE_PATTERN,
	findModelViolations,
	loadModelInput,
	parseCsv,
	REQUIRED_FACT_KEYS,
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
	assert.deepEqual(
		[...byShape.entries()].sort(),
		[
			["partial/partial/partial", input.games.filter((game) => game.eventName === "IEM Season 9 World Championship").length],
			["unavailable/partial/partial", input.games.filter((game) => game.eventName === "IPL 5").length],
		].sort(),
		`the thin era keeps each event's own coverage shape: ${JSON.stringify([...byShape])}`,
	);
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
