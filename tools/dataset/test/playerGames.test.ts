// Ticket 04's seam: recorded ScoreboardPlayers rows in, player-game rows out,
// reconciled against the team totals that ticket 03 already emits.
//
// The broad payload covers both fixture events and also carries games from IEM IX
// events the rule rejects; those rows are observations but never rows in this dataset.

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import type { BuildResult } from "../build.ts";
import { buildDataset } from "../build.ts";
import { FIXTURE_RAW, savePayloadBody } from "./helpers.ts";

const PLAYERS_DIR = path.join("lol-fandom", "cargoexport", "ScoreboardPlayers");

let built: Promise<BuildResult> | undefined;
function build(): Promise<BuildResult> {
	built ??= buildDataset({ rawDir: FIXTURE_RAW });
	return built;
}

async function scratch(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-player-game-"));
	await cp(FIXTURE_RAW, dir, { recursive: true });
	return dir;
}

async function broadFile(root: string): Promise<string> {
	const dir = path.join(root, ...PLAYERS_DIR.split(path.sep));
	for (const name of (await readdir(dir)).sort()) {
		if (!name.endsWith(".json") || name.endsWith(".meta.json")) continue;
		const file = path.join(dir, name);
		if (JSON.parse(await readFile(file, "utf8")).length > 100) return file;
	}
	throw new Error("the broad ScoreboardPlayers fixture is missing");
}

async function rows(file: string): Promise<Record<string, unknown>[]> {
	return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>[];
}

test("ten rows per game, five played roles per side, and sums that reconcile", async () => {
	const result = await build();
	const rowsOut = result.playerGames.rows;
	assert.equal(rowsOut.length, 2050, "110 Worlds + 76 MSI + 19 IEM games, ten players each");
	const games = new Map(result.scoreboards.games.map((game) => [game.id, game]));
	const perGame = new Map<string, typeof rowsOut>();
	for (const row of rowsOut) {
		const list = perGame.get(row.gameId) ?? [];
		list.push(row);
		perGame.set(row.gameId, list);
	}
	assert.equal(perGame.size, 205);
	const coverage = new Map(result.scoreboards.games.map((game) => [game.id, game.coverage.playerStats]));
	assert.equal([...coverage.values()].filter((state) => state === "complete").length, 186);
	assert.equal([...coverage.values()].filter((state) => state === "partial").length, 19);
	for (const [gameId, players] of perGame) {
		assert.equal(players.length, 10, `${gameId}: ten player rows`);
		const game = games.get(gameId);
		assert.ok(game);
		for (const side of ["blue", "red"] as const) {
			const sideRows = players.filter((row) => row.side === side);
			assert.equal(sideRows.length, 5, `${gameId}: five per side`);
			assert.equal(new Set(sideRows.map((row) => row.role)).size, 5, `${gameId}: one per played role`);
		}
		if (coverage.get(gameId) !== "complete") continue;
		for (const side of game.sides) {
			const sideRows = players.filter((row) => row.teamId === side.teamId);
			assert.equal(sideRows.reduce((sum, row) => sum + (row.kills ?? 0), 0), side.kills, `${gameId}: kills reconcile for ${side.teamName}`);
			assert.equal(sideRows.reduce((sum, row) => sum + (row.gold ?? 0), 0), side.gold, `${gameId}: gold reconciles for ${side.teamName}`);
		}
	}
	const sample = rowsOut.find((row) => "damage" in row);
	assert.ok(sample);
	assert.ok(Array.isArray(sample.items) && sample.items.length > 0, "items are a list, not a blob");
	assert.ok(Array.isArray(sample.summonerSpells), "spells are a list");
	assert.ok(Array.isArray(sample.runes) && sample.runes.length > 0, "runes are a list");
	assert.equal(typeof sample.keystone, "string");
});

test("a source without damage marks the game partial and leaves the key absent", async () => {
	const result = await build();
	const old = result.scoreboards.games.filter((game) => game.eventName === "IEM Season 9 World Championship");
	assert.equal(old.length, 19);
	for (const game of old) {
		assert.equal(game.coverage.playerStats, "partial");
		const players = result.playerGames.rows.filter((row) => row.gameId === game.id);
		assert.equal(players.length, 10);
		assert.ok(players.every((row) => !("damage" in row)), "no damage figure is invented");
		assert.ok(players.every((row) => !("vision" in row) && !("keystone" in row)));
	}
});

test("the played position wins when the source's role label disagrees", async () => {
	const base = await build();
	const target = base.playerGames.rows.find((row) => "damage" in row);
	assert.ok(target);
	const dir = await scratch();
	try {
		const file = await broadFile(dir);
		const source = await rows(file);
		const row = source.find((candidate) => candidate.GameId === target.source.gameId && candidate.Link === target.sourcePlayer);
		assert.ok(row);
		const played = String(row.IngameRole);
		row.Role = played === "Top" ? "Jungle" : "Top";
		await savePayloadBody(file, `${JSON.stringify(source)}\n`);
		const result = await buildDataset({ rawDir: dir });
		const emitted = result.playerGames.rows.find((candidate) => candidate.id === target.id);
		assert.equal(emitted?.role, played, "IngameRole, the position actually played, is authoritative");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a player appearing twice in one game fails the build, naming the game", async () => {
	const base = await build();
	const target = base.playerGames.rows.find((row) => "damage" in row);
	assert.ok(target);
	const dir = await scratch();
	try {
		const file = await broadFile(dir);
		const source = await rows(file);
		const sameGame = source.filter((row) => row.GameId === target.source.gameId);
		assert.ok(sameGame.length > 1);
		sameGame[1].Link = target.sourcePlayer;
		await savePayloadBody(file, `${JSON.stringify(source)}\n`);
		await assert.rejects(buildDataset({ rawDir: dir }), (error: Error) =>
			error.message.includes(target.source.gameId) && /twice/.test(error.message),
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a broken sum fails the build, naming the game and the team", async () => {
	const base = await build();
	const target = base.playerGames.rows.find((row) => "damage" in row);
	assert.ok(target);
	const dir = await scratch();
	try {
		const file = await broadFile(dir);
		const source = await rows(file);
		const row = source.find((candidate) => candidate.GameId === target.source.gameId && candidate.Link === target.sourcePlayer);
		assert.ok(row);
		row.Kills = Number(row.Kills) + 1;
		await savePayloadBody(file, `${JSON.stringify(source)}\n`);
		await assert.rejects(buildDataset({ rawDir: dir }), (error: Error) =>
			error.message.includes(target.source.gameId) && /players sum to/.test(error.message) && error.message.includes(target.teamName),
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("only games the rule selected produce player rows", async () => {
	const result = await build();
	for (const row of result.playerGames.rows) {
		assert.ok(!row.source.gameId.startsWith("IEM Season IX - Cologne"), "a rejected IEM event has no player rows");
		assert.ok(result.scoreboards.games.some((game) => game.source.gameId === row.source.gameId), "a player row joins to an emitted game");
	}
});

test("two builds emit byte-identical player rows", async () => {
	const first = await build();
	const second = await buildDataset({ rawDir: FIXTURE_RAW });
	assert.equal(first.files["player-games.jsonl"], second.files["player-games.jsonl"]);
});

test("rejected IEM games mint no teams, players or unresolved references", async () => {
	const result = await build();
	for (const name of ["Dignitas", "007x", "CaoMei"]) {
		assert.ok(!result.identity.teams.some((team) => team.name === name), `${name} is not a team in this dataset`);
		assert.ok(!result.identity.players.some((player) => player.name === name), `${name} is not a player in this dataset`);
		assert.ok(!result.identity.unresolved.some((row) => row.string === name), `${name} is not unresolved either`);
	}
	assert.equal(result.playerGames.rows.length, 2050, "filtering identity observations does not remove real player rows");
});

test("a game with duplicate roles is partial, not complete", async () => {
	const base = await build();
	const target = base.playerGames.rows.find((row) => "damage" in row);
	assert.ok(target);
	const sameSide = base.playerGames.rows.filter((row) => row.gameId === target.gameId && row.side === target.side && row.id !== target.id);
	assert.ok(sameSide.length > 0);
	const dir = await scratch();
	try {
		const file = await broadFile(dir);
		const source = await rows(file);
		const row = source.find((candidate) => candidate.GameId === target.source.gameId && candidate.Link === sameSide[0].sourcePlayer);
		assert.ok(row);
		row.IngameRole = target.role;
		await savePayloadBody(file, `${JSON.stringify(source)}\n`);
		const result = await buildDataset({ rawDir: dir });
		const game = result.scoreboards.games.find((candidate) => candidate.source.gameId === target.source.gameId);
		assert.equal(game?.coverage.playerStats, "partial", "the coverage marker does not claim an impossible complete draft of roles");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an identical duplicate player row in one payload fails the build", async () => {
	const base = await build();
	const target = base.playerGames.rows.find((row) => "damage" in row);
	assert.ok(target);
	const dir = await scratch();
	try {
		const file = await broadFile(dir);
		const source = await rows(file);
		const original = source.find((row) => row.GameId === target.source.gameId && row.Link === target.sourcePlayer);
		assert.ok(original);
		source.push({ ...original });
		await savePayloadBody(file, `${JSON.stringify(source)}\n`);
		await assert.rejects(buildDataset({ rawDir: dir }), (error: Error) =>
			error.message.includes(target.source.gameId) && /appears twice/.test(error.message),
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("present-but-unparseable source values stop the build", async () => {
	for (const [field, value, expected] of [
		["Side", "blue", /Side "blue"/],
		["Items", 5, /Items 5 is not a Cargo list/],
		["DateTime_UTC", "yesterday", /DateTime_UTC: "yesterday" is not a timestamp/],
		["DateTime_UTC", "2023-13-45 99:99:99", /not a real calendar instant/],
		["DateTime_UTC", "   ", /present but empty/],
	] as const) {
		const dir = await scratch();
		try {
			const file = await broadFile(dir);
			const source = await rows(file);
			const row = source.find((candidate) => typeof candidate.Kills === "number");
			assert.ok(row);
			row[field] = value;
			await savePayloadBody(file, `${JSON.stringify(source)}\n`);
			await assert.rejects(buildDataset({ rawDir: dir }), expected);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}
});

test("a malformed row in a rejected event still fails loudly", async () => {
	const dir = await scratch();
	try {
		const file = await broadFile(dir);
		const source = await rows(file);
		const row = source.find((candidate) => String(candidate.OverviewPage).startsWith("IEM Season IX - Cologne"));
		assert.ok(row);
		row.Kills = "abc";
		await savePayloadBody(file, `${JSON.stringify(source)}\n`);
		await assert.rejects(buildDataset({ rawDir: dir }), /expected a number, got "abc"/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an identity-only payload for a rejected event mints nothing, while a stage page of a selected event still counts", async () => {
	const dir = await scratch();
	try {
		const rejected = path.join(dir, ...PLAYERS_DIR.split(path.sep), "0000rejected.json");
		await writeFile(
			rejected,
			JSON.stringify([
				{
					Name: "ProbeRejectedPlayer",
					Link: "ProbeRejectedPlayer",
					Team: "ProbeRejectedTeam",
					TeamVs: "Other Probe Team",
					Champion: "Annie",
					OverviewPage: "IEM Season IX - Cologne",
					"DateTime UTC": "2014-12-19 17:00:00",
				},
			]),
			"utf8",
		);
		const built = await buildDataset({ rawDir: dir });
		assert.ok(!built.identity.players.some((player) => player.name === "ProbeRejectedPlayer"));
		assert.ok(!built.identity.teams.some((team) => team.name === "ProbeRejectedTeam"));
		assert.ok(!built.identity.unresolved.some((row) => row.string === "ProbeRejectedPlayer"));
		// A stage page under a selected event is that event's games, not a rejected event.
		assert.ok(built.identity.players.some((player) => player.name === "TheShy"), "Worlds Main Event players survive");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("games and matches under a rejected event mint no teams", async () => {
	const dir = await scratch();
	try {
		const gamesFile = path.join(dir, "lol-fandom", "cargoexport", "ScoreboardGames", "probe-rejected.json");
		const gameSource = await rows(path.join(dir, "lol-fandom", "cargoexport", "ScoreboardGames", "2c56284940e4601ab472b28c.json"));
		const template = gameSource[0];
		await writeFile(
			gamesFile,
			JSON.stringify([
				{
					...template,
					GameId: "IEM Season IX - Cologne_Probe_1_1",
					MatchId: "IEM Season IX - Cologne_Probe_1",
					OverviewPage: "IEM Season IX - Cologne",
					Team1: "ProbeGameTeam",
					Team2: "ProbeGameTeamTwo",
					WinTeam: "ProbeGameTeam",
				},
			]),
			"utf8",
		);
		const matchFile = path.join(dir, "lol-fandom", "cargoexport", "MatchSchedule", "probe-rejected.json");
		const matchSource = await rows(path.join(dir, "lol-fandom", "cargoexport", "MatchSchedule", "fe0b28d45f0561129ca42fb9.json"));
		await writeFile(
			matchFile,
			JSON.stringify([
				{
					...matchSource[0],
					MatchId: "IEM Season IX - Cologne_Probe_1",
					OverviewPage: "IEM Season IX - Cologne",
					Team1: "ProbeMatchTeam",
					Team2: "ProbeMatchTeamTwo",
				},
			]),
			"utf8",
		);
		const built = await buildDataset({ rawDir: dir });
		for (const name of ["ProbeGameTeam", "ProbeGameTeamTwo", "ProbeMatchTeam", "ProbeMatchTeamTwo"]) {
			assert.ok(!built.identity.teams.some((team) => team.name === name), `${name} must not be minted`);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a role differing only in case still counts as one played position", async () => {
	const base = await build();
	const target = base.playerGames.rows.find((row) => "damage" in row);
	assert.ok(target);
	const sameSide = base.playerGames.rows.filter((row) => row.gameId === target.gameId && row.side === target.side && row.id !== target.id);
	assert.ok(sameSide.length > 0);
	const dir = await scratch();
	try {
		const file = await broadFile(dir);
		const source = await rows(file);
		const row = source.find((candidate) => candidate.GameId === target.source.gameId && candidate.Link === sameSide[0].sourcePlayer);
		assert.ok(row);
		row.IngameRole = String(target.role).toLowerCase();
		await savePayloadBody(file, `${JSON.stringify(source)}\n`);
		const result = await buildDataset({ rawDir: dir });
		const game = result.scoreboards.games.find((candidate) => candidate.source.gameId === target.source.gameId);
		assert.equal(game?.coverage.playerStats, "partial");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an identity-only row cannot blank a stat row's GameId through deduplication", async () => {
	const base = await build();
	const target = base.playerGames.rows.find((row) => "damage" in row);
	assert.ok(target);
	const dir = await scratch();
	try {
		// File names are read in sorted order, so a payload named earlier wins a dedupe
		// tie. The identity-only copy must not erase the stat row's GameId.
		const overlap = path.join(dir, ...PLAYERS_DIR.split(path.sep), "000000000000000000000000.json");
		await writeFile(
			overlap,
			JSON.stringify([
				{
					Name: target.playerName,
					Link: target.sourcePlayer,
					Team: target.sourceTeam,
					TeamVs: "someone",
					Champion: target.sourceChampion,
					OverviewPage: "2023 Season World Championship/Main Event",
					"DateTime UTC": "2023-11-19 08:00:00",
				},
			]),
			"utf8",
		);
		const result = await buildDataset({ rawDir: dir });
		assert.equal(result.playerGames.rows.length, 2050, "the stat rows survive the overlapping identity copy");
		assert.ok(
			result.playerGames.rows.some((row) => row.id === target.id && "damage" in row),
			"the stat row is still a stat row",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
