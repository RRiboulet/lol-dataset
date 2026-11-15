// games: the game and match entities (spec R2/R3, ticket 03), plus the report that
// says which selected events the corpus actually carries games for.
//
// Three decisions are measured rather than assumed, and each one is visible below:
//
//   - `Team1`/`Team2` are **sides**, not teams. On the recorded fixture a side-swapped
//     series has the same team as `Team1` in games 1-2 and as `Team2` in game 3, so the
//     side is blue/red by position while the team is a reference identity resolves.
//   - `Winner` (an integer) and `WinTeam` (a string) are cross-checks, not alternative
//     sources of truth: the comparison is on **canonical IDs**, so an old spelling of a
//     renamed team still agrees with the side it names, while a genuine contradiction
//     stops the build naming the game.
//   - Coverage is judged against the era table (`eras.ts`), never against one uniform
//     field list — otherwise every game before 2024 is `partial` for want of a void
//     grub, and the marker stops meaning anything.
//
// The series score is a *match* fact (spec D1): `ScoreboardGames.Team1Score` is the
// cumulative score when that game started, so it is not emitted on the game at all.

import type { EventRecord } from "./assemble.ts";
import type { CachedPayload } from "./cache.ts";
import type { Coverage, EraTable } from "./eras.ts";
import { coverageOf, eraOn } from "./eras.ts";
import type { IdentityIndex, Resolution } from "./identity.ts";
import { AmbiguousIdentity, surrogateId } from "./identity.ts";
import type { SourceGame, SourceMatch, TeamStatField } from "./normalize.ts";
import { TEAM_STAT_FIELDS } from "./normalize.ts";

/** One side of a game. Stats are present only where the source stated a value. */
export type GameSideRecord = {
	side: "blue" | "red";
	teamId: string;
	teamName: string;
	/** The team string the source used, verbatim (spec R7). */
	sourceTeam: string;
} & Partial<Record<TeamStatField, number>>;

export type GameRecord = {
	id: string;
	eventId: string;
	eventName: string;
	/** The series this game belongs to, when the corpus also carries its `MatchSchedule` row. */
	matchId?: string;
	overviewPage: string;
	dateTimeUtc: string;
	patch?: string;
	durationSeconds?: number;
	/** The era whose field set judged this game's coverage. */
	era: string;
	coverage: { teamStats: Coverage };
	sides: [GameSideRecord, GameSideRecord];
	winnerTeamId: string;
	winnerTeamName: string;
	source: { gameId: string; matchId: string; riotPlatformGameId?: string };
};

export type MatchSideRecord = {
	side: "blue" | "red";
	teamId: string;
	teamName: string;
	sourceTeam: string;
	/** Cumulative series score for this side, when the source states it. */
	seriesScore?: number;
};

export type MatchRecord = {
	id: string;
	eventId: string;
	eventName: string;
	overviewPage: string;
	dateTimeUtc: string;
	bestOf?: number;
	/** The source's round label (`Tab`): `Phase` and `Round` are null on every recorded match. */
	tab?: string;
	patch?: string;
	forfeit?: boolean;
	isNullified: boolean;
	sides: [MatchSideRecord, MatchSideRecord];
	winnerTeamId?: string;
	winnerTeamName?: string;
	source: { matchId: string };
};

/**
 * What the corpus says about one selected event's games.
 *
 * `empty` is the state that only exists because the source is trustworthy in a
 * specific way: a query for an event can come back with zero rows (measured on World
 * Cyber Games 2013), and that is not the same claim as "nobody fetched this event".
 */
export type EventGamesState = "recorded" | "empty" | "missing";

export type EventGamesRecord = {
	eventId: string;
	eventName: string;
	overviewPage: string;
	state: EventGamesState;
	games: number;
	matches: number;
};

export type ScoreboardAssembly = {
	games: GameRecord[];
	matches: MatchRecord[];
	eventGames: EventGamesRecord[];
	/** Pages the rule does not select: counted by the caller, never emitted. */
	ignoredGames: string[];
	ignoredMatches: string[];
	/** Games whose series the corpus does not carry, so no canonical `matchId` is set. */
	gamesWithoutMatch: string[];
};

export type ScoreboardInput = {
	games: SourceGame[];
	matches: SourceMatch[];
	events: EventRecord[];
	identity: IdentityIndex;
	eras: EraTable;
	/** The payloads, for the sidecars: the event report needs to know what was asked for. */
	payloads: CachedPayload[];
};

const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function resolveTeam(identity: IdentityIndex, source: string, date: string, where: string): Resolution {
	if (source.trim() === "") throw new Error(`${where}: an empty team string cannot be resolved`);
	let found: Resolution | null;
	try {
		found = identity.resolve("team", source, date);
	} catch (error) {
		if (error instanceof AmbiguousIdentity) throw new Error(`${where}: ${error.message}`);
		throw error;
	}
	if (found === null) {
		throw new Error(
			`${where}: team ${JSON.stringify(source)} resolves to no entity; identity-unresolved.jsonl records the reference, ` +
				"and rules/identity-aliases.json is where a human resolution belongs",
		);
	}
	return found;
}

/**
 * The selected event a source page belongs to, by page prefix at a `/` boundary.
 *
 * The source splits an event across stage pages (`…/Play-In`, `…/Main Event`) while the
 * rule selects the tournament page, so a game has to be attached rather than joined.
 * The longest matching page wins, so overlapping event names cannot steal each other's
 * games. A page under no selected event belongs to an event the rule excluded, and it
 * is returned to the caller rather than emitted.
 */
function eventForPage(page: string, events: EventRecord[]): EventRecord | undefined {
	let found: EventRecord | undefined;
	for (const event of events) {
		const inside = page === event.overviewPage || page.startsWith(`${event.overviewPage}/`);
		if (!inside) continue;
		if (found === undefined || event.overviewPage.length > found.overviewPage.length) found = event;
	}
	return found;
}

function gameSide(sideIndex: 0 | 1, side: SourceGame["sides"][number], identity: IdentityIndex, date: string, where: string): GameSideRecord {
	const team = resolveTeam(identity, side.team, date, `${where}: ${sideIndex === 0 ? "Team1" : "Team2"}`);
	const record = {
		side: sideIndex === 0 ? "blue" : "red",
		teamId: team.id,
		teamName: team.name,
		sourceTeam: side.team,
	} as GameSideRecord;
	for (const [field] of TEAM_STAT_FIELDS) {
		const value = side[field];
		if (value !== null) record[field] = value;
	}
	return record;
}

function assembleGame(game: SourceGame, event: EventRecord, input: ScoreboardInput, matchIds: ReadonlySet<string>): GameRecord {
	const where = `${game.sourceFile}: game ${JSON.stringify(game.gameId)}`;
	const sides: [GameSideRecord, GameSideRecord] = [
		gameSide(0, game.sides[0], input.identity, game.date, where),
		gameSide(1, game.sides[1], input.identity, game.date, where),
	];
	if (sides[0].teamId === sides[1].teamId) {
		throw new Error(`${where}: both sides resolve to ${sides[0].teamId} (${sides[0].teamName}) — a game cannot be a team against itself`);
	}
	if (game.winTeam === "") {
		throw new Error(`${where}: the source states no WinTeam, so the game has no winner (spec R2 wants exactly one)`);
	}
	const winner = resolveTeam(input.identity, game.winTeam, game.date, `${where}: WinTeam`);
	const winnerIndex = sides.findIndex((side) => side.teamId === winner.id);
	if (winnerIndex === -1) {
		throw new Error(
			`${where}: WinTeam ${JSON.stringify(game.winTeam)} resolves to ${winner.id} (${winner.name}), which is neither side ` +
				`(${sides.map((side) => `${side.teamId} ${side.teamName}`).join(" vs ")}) — the source contradicts itself`,
		);
	}
	// Cross-check rather than trust: a corrected WinTeam beside a stale Winner is the
	// likeliest inconsistency, and it is free to catch.
	if (Number.isFinite(game.winnerSide) && game.winnerSide !== winnerIndex + 1) {
		throw new Error(
			`${where}: Winner is ${game.winnerSide} but WinTeam ${JSON.stringify(game.winTeam)} is side ${winnerIndex + 1} — one of them is stale`,
		);
	}

	const era = eraOn(input.eras, "team-stats", game.date);
	const present = new Set<TeamStatField>();
	for (const [field] of TEAM_STAT_FIELDS) {
		if (sides.every((side) => side[field] !== undefined)) present.add(field);
	}

	const matchId = surrogateId("mt", game.matchId);
	return {
		id: surrogateId("gm", game.gameId),
		eventId: event.id,
		eventName: event.name,
		...(matchIds.has(game.matchId) ? { matchId } : {}),
		overviewPage: game.page,
		dateTimeUtc: game.dateTimeUtc,
		...(game.patch === null ? {} : { patch: game.patch }),
		...(game.durationSeconds === null ? {} : { durationSeconds: game.durationSeconds }),
		era: era.id,
		coverage: { teamStats: coverageOf(era, present) },
		sides,
		winnerTeamId: sides[winnerIndex].teamId,
		winnerTeamName: sides[winnerIndex].teamName,
		source: {
			gameId: game.gameId,
			matchId: game.matchId,
			...(game.riotPlatformGameId === "" ? {} : { riotPlatformGameId: game.riotPlatformGameId }),
		},
	};
}

function assembleMatch(match: SourceMatch, event: EventRecord, input: ScoreboardInput): MatchRecord {
	const where = `${match.sourceFile}: match ${JSON.stringify(match.matchId)}`;
	const sides: [MatchSideRecord, MatchSideRecord] = [0, 1].map((index) => {
		const sideIndex = index as 0 | 1;
		const team = resolveTeam(input.identity, match.sides[sideIndex], match.date, `${where}: ${sideIndex === 0 ? "Team1" : "Team2"}`);
		const score = match.seriesScore[sideIndex];
		return {
			side: sideIndex === 0 ? "blue" : "red",
			teamId: team.id,
			teamName: team.name,
			sourceTeam: match.sides[sideIndex],
			...(score === null ? {} : { seriesScore: score }),
		} as MatchSideRecord;
	}) as [MatchSideRecord, MatchSideRecord];
	if (sides[0].teamId === sides[1].teamId) {
		throw new Error(`${where}: both sides resolve to ${sides[0].teamId} (${sides[0].teamName})`);
	}
	if (Number.isFinite(match.winnerSide) && match.winnerSide !== 1 && match.winnerSide !== 2) {
		throw new Error(`${where}: Winner is ${match.winnerSide}; the source states 1 or 2, so this row is not understood`);
	}
	const winner = Number.isFinite(match.winnerSide) ? sides[match.winnerSide - 1] : undefined;

	return {
		id: surrogateId("mt", match.matchId),
		eventId: event.id,
		eventName: event.name,
		overviewPage: match.page,
		dateTimeUtc: match.dateTimeUtc,
		...(match.bestOf === null ? {} : { bestOf: match.bestOf }),
		...(match.tab === "" ? {} : { tab: match.tab }),
		...(match.patch === null ? {} : { patch: match.patch }),
		...(match.forfeit ? { forfeit: true } : {}),
		isNullified: match.isNullified,
		sides,
		...(winner === undefined ? {} : { winnerTeamId: winner.teamId, winnerTeamName: winner.teamName }),
		source: { matchId: match.matchId },
	};
}

/**
 * Did a recorded query address this event? The sidecar's `where` names the page or the
 * source tournament, and either is enough: a query that asked for the event and came
 * back with no rows is a different fact from a query nobody made.
 */
function wasAsked(payload: CachedPayload, event: EventRecord): boolean {
	if (payload.table !== "ScoreboardGames") return false;
	const where = payload.query?.where;
	if (where === undefined) return false;
	return where.includes(event.overviewPage) || (event.name !== "" && where.includes(event.name));
}

/** Games, matches, and the per-event report. Sorted, so a rebuild is byte-identical. */
export function assembleScoreboards(input: ScoreboardInput): ScoreboardAssembly {
	const matchIds = new Set(input.matches.map((match) => match.matchId));
	const games: GameRecord[] = [];
	const matches: MatchRecord[] = [];
	const ignoredGames: string[] = [];
	const ignoredMatches: string[] = [];
	const gamesWithoutMatch: string[] = [];
	const perEvent = new Map<string, { games: number; matches: number }>();
	const count = (eventId: string, field: "games" | "matches"): void => {
		const seen = perEvent.get(eventId) ?? { games: 0, matches: 0 };
		seen[field] += 1;
		perEvent.set(eventId, seen);
	};

	for (const match of input.matches) {
		const event = eventForPage(match.page, input.events);
		if (event === undefined) {
			ignoredMatches.push(match.page);
			continue;
		}
		matches.push(assembleMatch(match, event, input));
		count(event.id, "matches");
	}
	for (const game of input.games) {
		const event = eventForPage(game.page, input.events);
		if (event === undefined) {
			ignoredGames.push(game.page);
			continue;
		}
		games.push(assembleGame(game, event, input, matchIds));
		count(event.id, "games");
		if (!matchIds.has(game.matchId)) gamesWithoutMatch.push(game.gameId);
	}

	games.sort(byId);
	matches.sort(byId);

	const eventGames: EventGamesRecord[] = input.events.map((event) => {
		const seen = perEvent.get(event.id) ?? { games: 0, matches: 0 };
		const state: EventGamesState =
			seen.games > 0 ? "recorded" : input.payloads.some((payload) => wasAsked(payload, event)) ? "empty" : "missing";
		return {
			eventId: event.id,
			eventName: event.name,
			overviewPage: event.overviewPage,
			state,
			games: seen.games,
			matches: seen.matches,
		};
	});
	eventGames.sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));

	return { games, matches, eventGames, ignoredGames, ignoredMatches, gamesWithoutMatch };
}
