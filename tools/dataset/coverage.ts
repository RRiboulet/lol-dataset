// coverage: the dataset-level report that aggregates the per-game coverage markers
// (spec R6), one row per event and one row per era.
//
// R6 asks for the marker on every game, and ticket 03/04/05 deliver it. A marker per
// game answers "what does this game hold"; it does not answer "what does this era
// hold", and a reader who wants the second has to aggregate the first — badly, and
// differently every time. This file is that aggregation, produced by the build so it
// cannot drift from the rows it describes: its counts are computed from the emitted
// games, and the invariant gate re-counts them from `games.jsonl` to prove it.
//
// Two grains, because both questions are real:
//
//   - per event: which field groups this event's games complete, partial or lack.
//     The counts are over games, so `complete: 110` means 110 of the event's games
//     are complete in that group, and `state` is the worst case — an event is
//     `complete` only when every one of its games is, which is the claim ticket 10's
//     criterion forbids exaggerating.
//   - per era: the same counts over the games the era table governs. An event that
//     straddles a boundary (a Worlds semifinal played across a patch) appears in
//     both eras' rows, which is why the event row also lists the eras it touches.
//
// The era rows cover **every declared era**, including those with no games yet: an
// absent row would be indistinguishable from "nobody looked", the same distinction
// `event-games.jsonl` makes for events. Eras are the table's, not the corpus's, so
// the report never invents a boundary (spec D4).
//
// Group state is derived, never stated independently: `complete` when every game is,
// `unavailable` when none of the games has anything in the group (or the event has no
// games at all), `partial` otherwise. That derivation is what makes the event and
// era rows reconcilable with `games.jsonl` by construction rather than by assertion.

import type { Coverage, EraTable } from "./eras.ts";
import type { EventRecord } from "./assemble.ts";
import type { GameRecord } from "./games.ts";

/** The field groups a game's coverage marker names, in a fixed order. */
export const COVERAGE_GROUPS = ["teamStats", "draft", "playerStats"] as const;
export type CoverageGroup = (typeof COVERAGE_GROUPS)[number];

/** How many of a set of games are complete, partial or unavailable in one group. */
export type GroupCoverage = {
	complete: number;
	partial: number;
	unavailable: number;
	/** The group's state over the set: complete only when every game is. */
	state: Coverage;
};

export type CoverageGroups = Record<CoverageGroup, GroupCoverage>;

/** One row of `event-coverage.jsonl`: every selected event, with or without games. */
export type EventCoverageRecord = {
	eventId: string;
	eventName: string;
	overviewPage: string;
	/** Distinct eras among the event's games, sorted; empty when it carries none. */
	eras: string[];
	games: number;
	coverage: CoverageGroups;
};

/** One row of `era-coverage.jsonl`: every declared era, with or without games. */
export type EraCoverageRecord = {
	era: string;
	from: string;
	games: number;
	/** How many distinct events contribute games to this era. */
	events: number;
	coverage: CoverageGroups;
};

export type CoverageReport = {
	events: EventCoverageRecord[];
	eras: EraCoverageRecord[];
};

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Count the group states of a set of games. Pure, so the invariant gate can reuse it. */
export function countGroups(games: readonly GameRecord[]): CoverageGroups {
	const groups = {} as CoverageGroups;
	for (const group of COVERAGE_GROUPS) {
		const counts = { complete: 0, partial: 0, unavailable: 0 } as GroupCoverage;
		for (const game of games) counts[game.coverage[group]] += 1;
		counts.state =
			games.length === 0 || counts.unavailable === games.length
				? "unavailable"
				: counts.complete === games.length
					? "complete"
					: "partial";
		groups[group] = counts;
	}
	return groups;
}

/**
 * The coverage report for the emitted events and games.
 *
 * Both lists are sorted by their key so a rebuild is byte-identical (spec R8): events
 * by surrogate id, eras by their declared order (which is date order — the era table
 * is validated to be ascending and non-overlapping, so the two agree).
 */
export function assembleCoverage(input: { events: readonly EventRecord[]; games: readonly GameRecord[]; eras: EraTable }): CoverageReport {
	const gamesByEvent = new Map<string, GameRecord[]>();
	for (const game of input.games) {
		const list = gamesByEvent.get(game.eventId) ?? [];
		list.push(game);
		gamesByEvent.set(game.eventId, list);
	}

	const events: EventCoverageRecord[] = input.events.map((event) => {
		const games = gamesByEvent.get(event.id) ?? [];
		return {
			eventId: event.id,
			eventName: event.name,
			overviewPage: event.overviewPage,
			eras: [...new Set(games.map((game) => game.era))].sort(byString),
			games: games.length,
			coverage: countGroups(games),
		};
	});
	events.sort((a, b) => byString(a.eventId, b.eventId));

	const gamesByEra = new Map<string, GameRecord[]>();
	for (const game of input.games) {
		const list = gamesByEra.get(game.era) ?? [];
		list.push(game);
		gamesByEra.set(game.era, list);
	}
	const declared = input.eras.groups["team-stats"];
	const eras: EraCoverageRecord[] = declared.map((era) => {
		const games = gamesByEra.get(era.id) ?? [];
		return {
			era: era.id,
			from: era.from,
			games: games.length,
			events: new Set(games.map((game) => game.eventId)).size,
			coverage: countGroups(games),
		};
	});
	// A game in an era the table does not declare cannot exist — `eraOn` would have
	// thrown while assembling it — so any leftover is an assembler bug, and silently
	// dropping it would hide games from every total in the report.
	const declaredIds = new Set(declared.map((era) => era.id));
	const undeclared = [...gamesByEra.keys()].filter((era) => !declaredIds.has(era)).sort(byString);
	if (undeclared.length > 0) {
		throw new Error(`coverage: games carry era(s) ${undeclared.join(", ")}, which the era table does not declare`);
	}

	return { events, eras };
}
