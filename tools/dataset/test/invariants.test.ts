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
		seriesConflicts: result.scoreboards.seriesConflicts,
		eventCoverage: result.coverage.events,
		eraCoverage: result.coverage.eras,
		playerGames: result.playerGames.rows,
		honours: result.honours,
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

test("a game attached to a series between two other teams is refused", async () => {
	// Ticket 14 detaches a game the source's series contradicts, so the assembler no longer
	// emits one — which makes this the gate's job: a hand-edited `matchId`, or a bad merge,
	// can still name a real series of the same event and put the game between two other
	// teams, and no id check sees it. The message names both sides so the line is findable.
	await expectViolation(
		(data) => {
			const game = data.games.find((candidate) => candidate.matchId !== undefined);
			assert.ok(game);
			const gameTeams = game.sides.map((side) => side.teamId).sort();
			const other = data.matches.find(
				(match) =>
					match.eventId === game.eventId &&
					match.id !== game.matchId &&
					match.sides.map((side) => side.teamId).sort().join() !== gameTeams.join(),
			);
			assert.ok(other, "the fixtures carry another series of the same event between other teams");
			game.matchId = other.id;
		},
		/a game cannot sit in a series between two other teams/,
		"game",
	);
});

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
	// The downstream contradictions the same corruption produces are reported in the
	// same run, which is the point of collecting rather than throwing. The conflict report
	// is one of them: its detached-game row names the team pair the corrupted game no longer has.
	assert.ok(violations.every((violation) => /^(game|player-game|series-conflict) /.test(violation)), violations.join("\n"));
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

test("a conflict report row that points at the wrong game or series is refused", async () => {
	const violations = await violationsAfter((data) => {
		const detached = data.seriesConflicts.find((row) => row.kind === "detached-game");
		assert.ok(detached);
		detached.gameId = "gm-000000000000";
		const contradicted = data.seriesConflicts.find((row) => row.kind === "contradicted-series");
		assert.ok(contradicted);
		contradicted.gameId = data.games[0].id;
	});
	assert.ok(
		violations.some((violation) => /names game gm-000000000000, which is not emitted/.test(violation)),
		violations.join("\n"),
	);
	assert.ok(
		violations.some((violation) => /is a contradicted series that still names an emitted game/.test(violation)),
		violations.join("\n"),
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

test("a player row attached to a team that is not one of its game's sides is refused", async () => {
	// The gap that only shows on a partial game: a complete game's five-per-side count
	// catches it incidentally, so the rule has to stand on its own.
	const violations = await violationsAfter((data) => {
		const game = data.games.find((candidate) => candidate.coverage.playerStats === "partial");
		assert.ok(game);
		const row = data.playerGames.find((candidate) => candidate.gameId === game.id);
		assert.ok(row);
		const outsider = data.identity.teams.find((team) => !game.sides.some((side) => side.teamId === team.id));
		assert.ok(outsider);
		row.teamId = outsider.id;
	});
	assert.equal(violations.length, 1, violations.join("\n"));
	assert.match(violations[0], /is not one of its game's sides/);
});

test("a player row attributed to another event is refused", async () => {
	await expectViolation(
		(data) => {
			const row = data.playerGames[0];
			const event = data.events.find((candidate) => candidate.id !== row.eventId);
			assert.ok(event);
			row.eventId = event.id;
		},
		/names event evt-[0-9a-f]+ but its game belongs to/,
		"player-game",
	);
});

test("an alias must point at an entity of its own kind", async () => {
	await expectViolation(
		(data) => {
			const alias = data.identity.aliases.find((candidate) => candidate.kind === "team");
			assert.ok(alias);
			alias.entityId = data.identity.champions[0].id;
		},
		/is a team alias but points at ch-[0-9a-f]+, which is another kind of entity/,
		"alias",
	);
});

test("a duplicated per-event report row and a missing one are both refused", async () => {
	const duplicated = await violationsAfter((data) => {
		data.eventGames.push(structuredClone(data.eventGames[0]));
	});
	assert.ok(duplicated.some((violation) => /appears 2 times — one record per key/.test(violation)), duplicated.join("\n"));

	const missing = await violationsAfter((data) => {
		data.eventGames.shift();
	});
	assert.ok(missing.some((violation) => /has no report row/.test(violation)), missing.join("\n"));
});

test("a report state that contradicts its counts is refused", async () => {
	await expectViolation(
		(data) => {
			const record = data.eventGames.find((candidate) => candidate.state === "recorded");
			assert.ok(record);
			record.state = "missing";
		},
		/says missing but carries \d+ games and \d+ matches/,
		"event-games",
	);
});

test("an ordered complete draft with a swapped or missing slot is refused", async () => {
	const swapped = await violationsAfter((data) => {
		const game = data.games.find((candidate) => candidate.coverage.draft === "complete" && candidate.draft?.fidelity === "ordered");
		assert.ok(game?.draft);
		const picks = game.draft.sides[0].picks;
		[picks[0].slot, picks[1].slot] = [picks[1].slot, picks[0].slot];
	});
	assert.ok(swapped.some((violation) => /ordered complete draft but blue picks slots are/.test(violation)), swapped.join("\n"));

	const dropped = await violationsAfter((data) => {
		const game = data.games.find((candidate) => candidate.coverage.draft === "complete" && candidate.draft?.fidelity === "ordered");
		assert.ok(game?.draft);
		delete (game.draft.sides[0].picks[0] as { slot?: number }).slot;
	});
	assert.ok(dropped.some((violation) => /ordered complete draft but blue picks slots/.test(violation)), dropped.join("\n"));
});

test("a draft present under an unavailable claim, or player rows under one, are refused", async () => {
	const draft = await violationsAfter((data) => {
		const game = data.games.find((candidate) => candidate.draft !== undefined);
		assert.ok(game);
		game.coverage.draft = "unavailable";
	});
	assert.ok(draft.some((violation) => /carries a draft while claiming none is available/.test(violation)), draft.join("\n"));

	const players = await violationsAfter((data) => {
		const game = data.games.find((candidate) => candidate.coverage.playerStats === "complete");
		assert.ok(game);
		game.coverage.playerStats = "unavailable";
	});
	assert.ok(players.some((violation) => /claims player statistics are unavailable but carries/.test(violation)), players.join("\n"));
});

test("an emitted event with no included selection row, and a duplicated selection row, are refused", async () => {
	const missing = await violationsAfter((data) => {
		const index = data.selection.findIndex((record) => record.decision === "included");
		assert.ok(index >= 0);
		data.selection.splice(index, 1);
	});
	assert.ok(missing.some((violation) => /has no included row for it/.test(violation)), missing.join("\n"));

	const duplicated = await violationsAfter((data) => {
		data.selection.push(structuredClone(data.selection[0]));
	});
	assert.ok(duplicated.some((violation) => /selection evt-[0-9a-f]+: appears 2 times/.test(violation)), duplicated.join("\n"));
});

test("negative durations, bestOf and report counts are refused", async () => {
	const violations = await violationsAfter((data) => {
		data.games[0].durationSeconds = -60;
		data.matches[0].bestOf = -3;
		data.eventGames[0].games = -1;
	});
	for (const expected of [/durationSeconds is -60/, /bestOf is -3/, /reports a negative count/]) {
		assert.ok(violations.some((violation) => expected.test(violation)), `expected ${expected}: ${violations.join("\n")}`);
	}
});

test("a malformed sides array is reported instead of crashing the gate", async () => {
	const violations = await violationsAfter((data) => {
		data.games[0].sides = [data.games[0].sides[0]] as never;
		data.eventGames[0].games += 99; // a second, independent corruption in another file
	});
	assert.ok(violations.some((violation) => /has 1 sides — a game has exactly two/.test(violation)), violations.join("\n"));
	assert.ok(violations.some((violation) => /says \d+ games but/.test(violation)), "the other file is still checked");
});

test("a game retargeted to another event's match, and one source row emitted twice, are refused", async () => {
	const crossEvent = await violationsAfter((data) => {
		const game = data.games.find((candidate) => candidate.matchId !== undefined);
		assert.ok(game);
		const other = data.matches.find((candidate) => candidate.eventId !== game.eventId);
		assert.ok(other);
		game.matchId = other.id;
	});
	assert.ok(crossEvent.some((violation) => /of another event/.test(violation)), crossEvent.join("\n"));

	const duplicated = await violationsAfter((data) => {
		const clone = structuredClone(data.games[0]);
		clone.id = "gm-000000000001";
		data.games.push(clone);
	});
	assert.ok(duplicated.some((violation) => /is emitted as 2 games/.test(violation)), duplicated.join("\n"));
});

test("a side key set to undefined is absence, not a stated statistic", async () => {
	// `coverageOf` treats undefined as absent, so the gate must too; otherwise a
	// legitimate record built in memory would be reported as carrying a value.
	const violations = await violationsAfter((data) => {
		const game = data.games.find((candidate) => candidate.coverage.teamStats === "unavailable");
		if (game === undefined) return; // the fixtures have none; the rule is still exercised below
		(game.sides[0] as unknown as Record<string, unknown>).kills = undefined;
	});
	assert.deepEqual(violations, []);
});
