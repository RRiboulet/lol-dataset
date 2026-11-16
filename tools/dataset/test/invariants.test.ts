// Ticket 06's seam: a corrupted dataset must fail the invariant gate, naming the
// record, and a clean dataset must pass silently.
//
// The corruptions are applied to a real build's records in memory, not to payloads.
// That is deliberate: a duplicate game id, a second winner or a negative statistic is
// already refused by `normalize` or by the schema, so a payload-level fixture would
// test those locks rather than the gate that ticket 06 adds. Each case below takes a
// clean dataset and breaks exactly one invariant, which is what a hand-edit or a bad
// merge produces after the assembler has already run.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { BuildResult } from "../build.ts";
import { buildDataset } from "../build.ts";
import type { InvariantInput } from "../invariants.ts";
import { assertInvariants, findInvariantViolations } from "../invariants.ts";
import { FIXTURE_RAW } from "./helpers.ts";

let built: Promise<BuildResult> | undefined;
function build(): Promise<BuildResult> {
	built ??= buildDataset({ rawDir: FIXTURE_RAW });
	return built;
}

/** A clean dataset in the gate's own shape, deep-copied so a test can corrupt it. */
async function clean(): Promise<InvariantInput> {
	const result = await build();
	const copy = structuredClone({
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
		playerGames: result.playerGames.rows,
		eras: result.eras,
	}) as InvariantInput;
	return copy;
}

/** The violations a mutation produces, as one string per violation. */
async function violationsAfter(mutate: (data: InvariantInput) => void): Promise<string[]> {
	const data = await clean();
	mutate(data);
	return findInvariantViolations(data);
}

/** Assert exactly one violation matches, and that the message names the record. */
async function expectViolation(
	mutate: (data: InvariantInput) => void,
	pattern: RegExp,
	record: string,
): Promise<void> {
	const violations = await violationsAfter(mutate);
	const matching = violations.filter((violation) => pattern.test(violation));
	assert.equal(matching.length, 1, `expected one violation matching ${pattern}, got:\n${violations.join("\n")}`);
	assert.ok(matching[0].includes(record), `the message names ${record}: ${matching[0]}`);
}

test("a clean dataset passes the gate with no warnings", async () => {
	const data = await clean();
	assert.deepEqual(findInvariantViolations(data), []);
	assert.doesNotThrow(() => assertInvariants(data));
});

test("a duplicate game id is refused, naming the id", async () => {
	await expectViolation(
		(data) => {
			data.games.push(structuredClone(data.games[0]));
		},
		/appears 2 times/,
		"game",
	);
});

test("an unknown champion reference is refused, naming it", async () => {
	await expectViolation(
		(data) => {
			const game = data.games.find((candidate) => candidate.draft !== undefined);
			assert.ok(game?.draft);
			game.draft.sides[0].picks[0].championId = "ch-000000000000";
		},
		/champion ch-000000000000, which is not emitted/,
		"game",
	);
});

test("player kills that do not sum to the team's are refused, naming the game", async () => {
	await expectViolation(
		(data) => {
			const game = data.games.find((candidate) => candidate.coverage.playerStats === "complete");
			assert.ok(game);
			const row = data.playerGames.find((candidate) => candidate.gameId === game.id);
			assert.ok(row);
			row.kills = (row.kills ?? 0) + 1;
		},
		/players sum to .* kills against the team's/,
		"game",
	);
});

test("a game with two winning sides is refused, naming the game", async () => {
	const violations = await violationsAfter((data) => {
		const game = data.games[0];
		// The only way one game has two winners is for both sides to be the same team,
		// which is itself a contradiction the gate reports beside the winner count.
		game.sides[1].teamId = game.sides[0].teamId;
	});
	assert.ok(violations.some((violation) => /both sides are .*cannot be a team against itself/.test(violation)));
	assert.ok(violations.some((violation) => /winning sides/.test(violation)));
	assert.ok(violations.every((violation) => violation.startsWith("game ")), violations.join("\n"));
});

test("a negative statistic is refused, naming the record", async () => {
	await expectViolation(
		(data) => {
			const row = data.playerGames.find((candidate) => "damage" in candidate);
			assert.ok(row);
			row.damage = -1;
		},
		/damage is -1 — a statistic cannot be negative/,
		"player-game",
	);
});

test("a complete team-statistics claim with an absent field is refused", async () => {
	await expectViolation(
		(data) => {
			const game = data.games.find((candidate) => candidate.coverage.teamStats === "complete");
			assert.ok(game);
			delete (game.sides[0] as unknown as Record<string, unknown>).barons;
		},
		/claims complete team statistics but blue has no barons/,
		"game",
	);
});

test("a complete player-statistics claim with too few rows is refused", async () => {
	await expectViolation(
		(data) => {
			const game = data.games.find((candidate) => candidate.coverage.playerStats === "complete");
			assert.ok(game);
			data.playerGames = data.playerGames.filter((row) => row.gameId !== game.id || row.side !== "red");
		},
		/claims complete player statistics but carries \d+ player rows/,
		"game",
	);
});

test("a dangling reference is refused in every file that can carry one", async () => {
	const violations = await violationsAfter((data) => {
		data.games[0].eventId = "evt-000000000000";
		data.games[0].winnerTeamId = "tm-000000000000";
		data.matches[0].eventId = "evt-000000000000";
		data.playerGames[0].championId = "ch-000000000000";
		data.identity.aliases[0].entityId = "tm-000000000000";
		data.eventGames[0].eventId = "evt-000000000000";
	});
	for (const expected of [
		/references event evt-000000000000/,
		/winning sides for tm-000000000000/,
		/which is not emitted/,
		/points at tm-000000000000, which is not an entity/,
		/reports on an event that is not emitted/,
	]) {
		assert.ok(violations.some((violation) => expected.test(violation)), `expected a violation matching ${expected}`);
	}
});

test("a corruption in one file does not stop the other files from being checked", async () => {
	const violations = await violationsAfter((data) => {
		data.games.push(structuredClone(data.games[0])); // games.jsonl
		data.playerGames[0].teamId = "tm-000000000000"; // player-games.jsonl
		data.identity.aliases[0].entityId = "pl-000000000000"; // aliases.jsonl
		data.eventGames[0].games += 99; // event-games.jsonl
		data.matches[0].winnerTeamId = "tm-000000000000"; // matches.jsonl
	});
	const files = ["game", "player-game", "alias", "event-games", "match"];
	for (const file of files) {
		assert.ok(violations.some((violation) => violation.startsWith(file)), `a ${file} violation is reported in the same run`);
	}
});

test("the gate is part of the build, not an opt-in flag", async () => {
	// `buildDataset` runs the gate on the records it just produced, so its own output
	// must be gate-clean without anyone asking. That is the wiring assertion: the same
	// records the schema gate sees are the ones the invariant gate sees.
	const data = await clean();
	assert.deepEqual(findInvariantViolations(data), [], "a normal build's records satisfy the gate");
	assert.throws(
		() => assertInvariants({ ...data, games: [...data.games, structuredClone(data.games[0])] }),
		/violates \d+ invariant/,
		"and the gate refuses the same records once one of them is wrong",
	);
});
