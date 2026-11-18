// Ticket 10's seam: the per-game coverage markers aggregated into a dataset-level
// report, per event and per era (spec R6, D4).
//
// The property worth asserting is not "the file exists" but "the file cannot claim more
// than the games do": the report is generated from the emitted markers, so the test
// re-counts them independently and compares, including the ticket's own criterion that
// no event is reported complete whose games are partial. The invariant gate re-checks
// the same thing over the emitted records (see invariants.test.ts); this file checks the
// assembler directly, with the fixtures that carry both a complete era and a thin one.

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDataset } from "../build.ts";
import { assembleCoverage, countGroups } from "../coverage.ts";
import { findInvariantViolations } from "../invariants.ts";
import { FIXTURE_RAW } from "./helpers.ts";

let built: ReturnType<typeof buildDataset> | undefined;
function build(): ReturnType<typeof buildDataset> {
	built ??= buildDataset({ rawDir: FIXTURE_RAW });
	return built;
}

test("every selected event has a coverage row, and its counts are its games'", async () => {
	const result = await build();
	const { events } = result;
	const games = result.scoreboards.games;
	const { events: eventCoverage } = result.coverage;
	assert.equal(eventCoverage.length, events.length, "one row per selected event, including the events with no games");
	const byId = new Map(eventCoverage.map((record) => [record.eventId, record]));
	for (const event of events) {
		const record = byId.get(event.id);
		assert.ok(record !== undefined, `${event.name} is reported on`);
		const own = games.filter((game) => game.eventId === event.id);
		assert.equal(record.games, own.length, `${event.name}: games reconcile with games.jsonl`);
		assert.deepEqual(record.eras, [...new Set(own.map((game) => game.era))].sort(), `${event.name}: eras are its games'`);
		for (const group of ["teamStats", "draft", "playerStats"] as const) {
			const stated = record.coverage[group];
			assert.equal(stated.complete + stated.partial + stated.unavailable, own.length);
			for (const state of ["complete", "partial", "unavailable"] as const) {
				assert.equal(stated[state], own.filter((game) => game.coverage[group] === state).length, `${event.name} ${group} ${state}`);
			}
		}
	}
});

test("an event is never reported complete while one of its games is partial", async () => {
	// The measured case: MSI 2023 has one game whose fourth ban slot is the source's
	// `None` placeholder, so the event's draft coverage is `partial`, not `complete` —
	// the exact over-claim ticket 10's criterion forbids.
	const result = await build();
	const msi = result.coverage.events.find((record) => record.overviewPage === "2023 Mid-Season Invitational");
	assert.ok(msi !== undefined);
	assert.equal(msi.games, 76);
	assert.equal(msi.coverage.draft.partial, 1, "one MSI game's draft is partial");
	assert.equal(msi.coverage.draft.state, "partial", "so the event is partial, not complete");
	assert.equal(msi.coverage.teamStats.state, "complete");
	assert.equal(msi.coverage.playerStats.state, "complete");
});

test("an era's totals are its games', and the eras reconcile with games.jsonl", async () => {
	const result = await build();
	const { eras: eraCoverage } = result.coverage;
	const declared = result.eras.groups["team-stats"];
	assert.deepEqual(
		eraCoverage.map((record) => record.era),
		declared.map((era) => era.id),
		"one row per declared era, in the table's order — including the ones no game has reached",
	);
	assert.equal(eraCoverage.reduce((sum, record) => sum + record.games, 0), result.scoreboards.games.length, "every game belongs to one era");
	for (const record of eraCoverage) {
		const era = declared.find((candidate) => candidate.id === record.era);
		assert.equal(record.from, era?.from);
		const own = result.scoreboards.games.filter((game) => game.era === record.era);
		assert.equal(record.games, own.length);
		assert.equal(record.events, new Set(own.map((game) => game.eventId)).size);
		const counted = countGroups(own);
		assert.deepEqual(record.coverage, counted, `${record.era}: the row is the games' own count`);
	}
	// The two grains agree with each other, so no game can hide from either report.
	assert.equal(
		result.coverage.events.reduce((sum, record) => sum + record.games, 0),
		result.scoreboards.games.length,
	);
	const empty = eraCoverage.filter((record) => record.games === 0);
	for (const record of empty) {
		assert.equal(record.coverage.teamStats.state, "unavailable", `${record.era}: an era with no games is unavailable, not blank`);
	}
});

test("the report is a function of the games: two builds produce the same bytes", async () => {
	const first = await build();
	const again = await buildDataset({ rawDir: FIXTURE_RAW });
	assert.equal(first.files["event-coverage.jsonl"], again.files["event-coverage.jsonl"]);
	assert.equal(first.files["era-coverage.jsonl"], again.files["era-coverage.jsonl"]);
	// Sorted by their keys, so a reordering of the input list is not a data change.
	const shuffled = assembleCoverage({
		events: [...first.events].reverse(),
		games: [...first.scoreboards.games].reverse(),
		eras: first.eras,
	});
	assert.deepEqual(shuffled, first.coverage);
});

test("the gate refuses a coverage row that over-claims, or drops a game", async () => {
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
		seriesConflicts: result.scoreboards.seriesConflicts,
		eventCoverage: result.coverage.events,
		eraCoverage: result.coverage.eras,
		playerGames: result.playerGames.rows,
		eras: result.eras,
	});
	assert.deepEqual(findInvariantViolations(data), []);

	// One game's draft marker becomes `complete` on the row while its game is partial:
	// exactly the over-claim the criterion is about.
	const msi = data.eventCoverage.find((record) => record.overviewPage === "2023 Mid-Season Invitational");
	assert.ok(msi !== undefined);
	const original = msi.coverage.draft;
	msi.coverage.draft = { complete: msi.games, partial: 0, unavailable: 0, state: "complete" };
	const overClaim = findInvariantViolations(data);
	assert.ok(
		overClaim.some((violation) => violation.includes("draft") && violation.includes("partial")),
		`the gate names the over-claim, got: ${overClaim.join(" | ")}`,
	);
	msi.coverage.draft = original;

	// A game that no row accounts for is a coverage report that hides data.
	data.eventCoverage = data.eventCoverage.filter((record) => record.eventId !== msi.eventId);
	const dropped = findInvariantViolations(data);
	assert.ok(dropped.some((violation) => violation.includes("has no coverage row")));
});
