// Ticket 04's seam: recorded ScoreboardPlayers rows in, player-game rows out,
// reconciled against the team totals that ticket 03 already emits.
//
// The broad payload covers both fixture events and also carries games from IEM IX
// events the rule rejects; those rows are observations but never rows in this dataset.

import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import type { BuildResult } from "../build.ts";
import { buildDataset } from "../build.ts";
import { readPayloads } from "../cache.ts";
import { FIXTURE_RAW, isPayloadBody, readPayloadBodyFile, savePayloadBody } from "./helpers.ts";

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
	// A payload that states damage: the corpus now has 124 player payloads, and the
	// alphabetically first large one is an event whose rows predate the damage column.
	for (const name of (await readdir(dir)).sort()) {
		if (!isPayloadBody(name)) continue;
		const file = path.join(dir, name);
		const body = JSON.parse(await readPayloadBodyFile(file)) as Record<string, unknown>[];
		if (body.length > 100 && body.some((row) => typeof row.DamageToChampions === "number")) return file;
	}
	throw new Error("the broad ScoreboardPlayers fixture is missing");
}

async function rows(file: string): Promise<Record<string, unknown>[]> {
	return JSON.parse(await readPayloadBodyFile(file)) as Record<string, unknown>[];
}

/** Every payload body of one table under a scratch cache, in a stable order. */
async function bodies(root: string, table: "player" | "game" | "match" | "draft"): Promise<string[]> {
	const name = { player: "ScoreboardPlayers", game: "ScoreboardGames", match: "MatchSchedule", draft: "PicksAndBansS7" }[table];
	const dir = path.join(root, ...`lol-fandom/cargoexport/${name}`.split("/"));
	return (await readdir(dir)).filter(isPayloadBody).sort().map((entry) => path.join(dir, entry));
}

/** The first payload of one table carrying a row `matches`. */
async function payloadWith(root: string, table: "player" | "game" | "match" | "draft", matches: (row: Record<string, unknown>) => boolean): Promise<string> {
	for (const file of await bodies(root, table)) {
		if ((await rows(file)).some(matches)) return file;
	}
	throw new Error(`no ${table} payload carries a matching row`);
}

/**
 * A player row whose source row lives in `file`.
 *
 * A crawl leaves one payload per query batch, so the "first row with damage" can belong to
 * a payload other than the one a test edits — the edit would then change nothing and the
 * assertion would measure the wrong file. Selecting the row *through* the payload keeps
 * the two in step.
 */
async function damageRowIn(base: BuildResult, file: string) {
	const source = await rows(file);
	const inFile = new Set(source.filter((row) => typeof row.GameId === "string").map((row) => `${row.GameId}\u0000${row.Link}`));
	return base.playerGames.rows.find((row) => "damage" in row && inFile.has(`${row.source.gameId}\u0000${row.sourcePlayer}`));
}

test("ten rows per game, five played roles per side, and sums that reconcile", async () => {
	const result = await build();
	const rowsOut = result.playerGames.rows;
	assert.equal(rowsOut.length, 30910, "every game the corpus carries, ten players each");
	const games = new Map(result.scoreboards.games.map((game) => [game.id, game]));
	const perGame = new Map<string, typeof rowsOut>();
	for (const row of rowsOut) {
		const list = perGame.get(row.gameId) ?? [];
		list.push(row);
		perGame.set(row.gameId, list);
	}
	assert.equal(perGame.size, 3091);
	const coverage = new Map(result.scoreboards.games.map((game) => [game.id, game.coverage.playerStats]));
	// Every game now states ten player rows, so none is `unavailable`; the split is between
	// the games whose fields are all stated and the pre-2016 ones missing damage, vision or runes.
	assert.equal([...coverage.values()].filter((state) => state === "complete").length, 1587);
	assert.equal([...coverage.values()].filter((state) => state === "partial").length, 1504);
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
	const dir = await scratch();
	try {
		const file = await broadFile(dir);
		const target = await damageRowIn(base, file);
		assert.ok(target);
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
	const dir = await scratch();
	try {
		const file = await broadFile(dir);
		const target = await damageRowIn(base, file);
		assert.ok(target);
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
	const dir = await scratch();
	try {
		const file = await broadFile(dir);
		const target = await damageRowIn(base, file);
		assert.ok(target);
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
	// The names are computed from the payloads, not remembered: only a rejected event names
	// them. `Dignitas`, `Jankos` and `Team ROCCAT` used to be on this list and are real teams
	// and players now that the full corpus carries the events they played in, which is
	// exactly why the list has to be read from the source each time (ticket 16).
	const onlyRejected = new Set<string>();
	for (const payload of await readPayloads(FIXTURE_RAW)) {
		if (payload.table !== "ScoreboardPlayers") continue;
		for (const row of JSON.parse(payload.body) as Record<string, unknown>[]) {
			if (!String(row.OverviewPage).startsWith("IEM Season IX - Cologne")) continue;
			onlyRejected.add(String(row.Name));
		}
	}
	const elsewhere = new Set<string>();
	for (const payload of await readPayloads(FIXTURE_RAW)) {
		if (payload.table !== "ScoreboardPlayers") continue;
		for (const row of JSON.parse(payload.body) as Record<string, unknown>[]) {
			if (!String(row.OverviewPage).startsWith("IEM Season IX - Cologne")) elsewhere.add(String(row.Name));
		}
	}
	const rejectedPages = elsewhere;
	const names = [...onlyRejected].filter((name) => !rejectedPages.has(name)).slice(0, 3);
	assert.ok(names.length > 0, "the rejected IEM rows name players nothing else names");
	for (const name of names) {
		assert.ok(!result.identity.teams.some((team) => team.name === name), `${name} is not a team in this dataset`);
		assert.ok(!result.identity.players.some((player) => player.name === name), `${name} is not a player in this dataset`);
		assert.ok(!result.identity.unresolved.some((row) => row.string === name), `${name} is not unresolved either`);
	}
	assert.equal(result.playerGames.rows.length, 30910, "filtering identity observations does not remove real player rows");
});

test("a game with duplicate roles is partial, not complete", async () => {
	const base = await build();
	const dir = await scratch();
	try {
		const file = await broadFile(dir);
		const target = await damageRowIn(base, file);
		assert.ok(target);
		const sameSide = base.playerGames.rows.filter((row) => row.gameId === target.gameId && row.side === target.side && row.id !== target.id);
		assert.ok(sameSide.length > 0);
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
	const dir = await scratch();
	try {
		const file = await broadFile(dir);
		const target = await damageRowIn(base, file);
		assert.ok(target);
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
		let edited = 0;
		for (const file of await bodies(dir, "player")) {
			const source = await rows(file);
			let changed = false;
			for (const row of source) {
				if (!String(row.OverviewPage).startsWith("IEM Season IX - Cologne")) continue;
				row.Kills = "abc";
				changed = true;
				edited += 1;
			}
			if (changed) await savePayloadBody(file, `${JSON.stringify(source)}\n`);
		}
		assert.ok(edited > 0, "the corpus carries IEM Season IX - Cologne rows");
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
		const gameFile = await payloadWith(dir, "game", (row) => String(row.OverviewPage).startsWith("2023 Season World Championship"));
		const gameSource = await rows(gameFile);
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
		const matchFile2 = await payloadWith(dir, "match", (row) => String(row.OverviewPage).startsWith("2023 Season World Championship"));
		const matchSource = await rows(matchFile2);
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
	const dir = await scratch();
	try {
		const file = await broadFile(dir);
		const target = await damageRowIn(base, file);
		assert.ok(target);
		const sameSide = base.playerGames.rows.filter((row) => row.gameId === target.gameId && row.side === target.side && row.id !== target.id);
		assert.ok(sameSide.length > 0);
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
		assert.equal(result.playerGames.rows.length, 30910, "the stat rows survive the overlapping identity copy");
		assert.ok(
			result.playerGames.rows.some((row) => row.id === target.id && "damage" in row),
			"the stat row is still a stat row",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
