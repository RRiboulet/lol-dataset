// Ticket 10's blind-pick seam: a declared game format, checked against the rows.
//
// The 2020 Mid-Season Cup played game one of every best-of-five in blind pick, which the
// source records three ways at once — no `PicksAndBansS7` row, no bans, and the same
// champion on both sides. The dataset could not represent that without either dropping
// the draft (the lie R6 prevents) or weakening the duplicate invariant (which would hide
// a corrupted row). So the format is declared in `rules/game-formats.json`, and these
// tests hold both halves of the bargain: a declared blind pick is emitted as one, and a
// declaration that contradicts the rows stops the build.

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import type { BuildResult } from "../build.ts";
import { buildDataset } from "../build.ts";
import { parseGameFormats } from "../formats.ts";
import { findInvariantViolations } from "../invariants.ts";
import { FIXTURE_RAW, savePayloadBody } from "./helpers.ts";

const MSC = "2020 Mid-Season Cup";
const RULES = path.join(import.meta.dirname, "..", "rules", "game-formats.json");

let built: Promise<BuildResult> | undefined;
function build(): Promise<BuildResult> {
	built ??= buildDataset({ rawDir: FIXTURE_RAW });
	return built;
}

/** Build from a scratch copy of the fixtures with a different formats file. */
async function buildWithFormats(formats: unknown): Promise<BuildResult> {
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-format-"));
	try {
		const file = path.join(dir, "game-formats.json");
		await writeFile(file, typeof formats === "string" ? formats : JSON.stringify(formats), "utf8");
		return await buildDataset({ rawDir: FIXTURE_RAW, formatFile: file });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function payloadBodies(raw: string, table: string): Promise<string[]> {
	const { readdir } = await import("node:fs/promises");
	const dir = path.join(raw, "lol-fandom", "cargoexport", table);
	return (await readdir(dir))
		.filter((name) => name.endsWith(".json") && !name.endsWith(".meta.json"))
		.sort()
		.map((name) => path.join(dir, name));
}

test("the committed formats file declares the Mid-Season Cup's blind-pick games", async () => {
	const parsed = parseGameFormats(JSON.parse(await readFile(RULES, "utf8")), RULES);
	assert.equal(parsed.blindPick.length, 1);
	assert.equal(parsed.blindPick[0].overviewPage, MSC);
	assert.match(parsed.blindPick[0].cites, /blind pick/i);
});

test("declarations are validated strictly: a typo cannot silently match everything", () => {
	const base = { version: 1, blindPick: [] };
	assert.throws(() => parseGameFormats({ ...base, blindpick: [] }, "x"), /unknown field/);
	assert.throws(
		() => parseGameFormats({ version: 1, blindPick: [{ overviewPage: "E", gameIdPattern: "(", cites: "c" }] }, "x"),
		/not a regular expression/,
	);
	assert.throws(() => parseGameFormats({ version: 1, blindPick: [{ overviewPage: "", gameIdPattern: ".*", cites: "c" }] }, "x"), /overviewPage/);
	assert.throws(() => parseGameFormats({ version: 1, blindPick: [{ overviewPage: "E", gameIdPattern: ".*", cites: " " }] }, "x"), /cites/);
	assert.throws(() => parseGameFormats({ version: 1 }, "x"), /blindPick/);
	assert.throws(() => parseGameFormats("nope", "x"), /expected an object/);
	assert.doesNotThrow(() => parseGameFormats(base, "x"));
});

test("a declared blind-pick game keeps its picks, has no bans, and is complete", async () => {
	const result = await build();
	const game = result.scoreboards.games.find((candidate) => candidate.source.gameId === `${MSC}_Finals_1_1`);
	assert.ok(game !== undefined, "the fixtures carry the Mid-Season Cup finals");
	assert.equal(game.draft?.blindPick, true, "the format is stated on the row, so a reader sees why it looks odd");
	assert.equal(game.draft?.fidelity, "unordered");
	for (const side of game.draft?.sides ?? []) {
		assert.equal(side.picks.length, 5);
		assert.deepEqual(side.bans, [], "a blind pick has no ban phase, so the source states none");
	}
	// The measured fact the declaration exists for: Varus on both teams, which no draft
	// could produce and blind pick regularly does.
	assert.deepEqual(
		game.draft?.sides.map((side) => side.picks.filter((entry) => entry.championName === "Varus").length),
		[1, 1],
	);
	assert.equal(game.coverage.draft, "complete", "five picks a side is the whole of a blind-pick draft");
});

test("a duplicate champion across sides is still refused in a draft game", async () => {
	// The invariant is not weakened for everyone: the same ordered row edited into a
	// cross-side duplicate (Finals_1_2 has bans and a numbered draft) contradicts itself.
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-dup-"));
	try {
		const raw = path.join(dir, "raw");
		await cp(FIXTURE_RAW, raw, { recursive: true });
		for (const file of await payloadBodies(raw, "PicksAndBansS7")) {
			const rows = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>[];
			const row = rows.find((candidate) => candidate.GameId === `${MSC}_Finals_1_2`);
			if (row === undefined) continue;
			row.Team2Pick1 = row.Team1Pick1;
			await savePayloadBody(file, JSON.stringify(rows));
			await assert.rejects(buildDataset({ rawDir: raw }), /same champion appears on both sides|appears twice/);
			return;
		}
		throw new Error(`the fixtures carry no ${MSC}_Finals_1_2 draft row`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a declaration is checked against the rows it covers", async () => {
	// A declaration matching no game of an event the corpus carries is a typo: the games it
	// meant to cover would fail as a duplicate champion and never point at this file.
	const committed = parseGameFormats(JSON.parse(await readFile(RULES, "utf8")), RULES);
	await assert.rejects(
		buildWithFormats({
			version: 1,
			blindPick: [...committed.blindPick, { overviewPage: "2025 First Stand", gameIdPattern: "_NoSuchGame$", cites: "test: a typo" }],
		}),
		/matches none of its/,
	);
	// A declaration that they had no ban phase is contradicted by a stated ban.
	await assert.rejects(
		buildWithFormats({
			version: 1,
			blindPick: [...committed.blindPick, { overviewPage: MSC, gameIdPattern: "_Finals_1_2$", cites: "test: a game with a draft" }],
		}),
		/declares this game blind pick, but a PicksAndBansS7 row exists/,
	);
	// A declaration for an event the corpus carries no games for is inert rather than an
	// error: a narrow fixture set has to be able to share one rules file.
	const inert = await buildWithFormats({
		version: 1,
		blindPick: [...committed.blindPick, { overviewPage: "2011 World Cyber Games", gameIdPattern: "^2011", cites: "test" }],
	});
	assert.equal(inert.formats.blindPick.length, 2, "the declaration is accepted and simply matches nothing here");
});

test("the gate refuses a blind-pick claim the row contradicts", async () => {
	const result = await build();
	const data = structuredClone({
		events: result.events,
		selection: result.selection,
		identity: {
			teams: result.identity.teams,
			players: result.identity.players,
			champions: result.identity.champions,
			aliases: result.identity.aliases,
			unresolved: result.identity.unresolved,
		},
		games: result.scoreboards.games,
		matches: result.scoreboards.matches,
		eventGames: result.scoreboards.eventGames,
		eventCoverage: result.coverage.events,
		eraCoverage: result.coverage.eras,
		playerGames: result.playerGames.rows,
		eras: result.eras,
	});
	assert.deepEqual(findInvariantViolations(data), []);
	const game = data.games.find((candidate) => candidate.draft?.blindPick === true);
	assert.ok(game?.draft !== undefined);
	// Bans on a declared blind pick: the phase does not exist there.
	game.draft.sides[0].bans.push({ ...game.draft.sides[0].picks[0] });
	const violations = findInvariantViolations(data);
	assert.ok(violations.some((violation) => violation.includes("no ban phase")), violations.join(" | "));
});
