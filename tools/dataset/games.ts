// games: the game and match entities (spec R2/R3, ticket 03), plus the report that
// says which selected events the corpus actually carries games for.
//
// Five decisions are measured rather than assumed, and each one is visible below:
//
//   - `ScoreboardGames.Team1`/`Team2` are the game's **sides**. On the recorded fixture
//     a side-swapped series has the same team as `Team1` in games 1-2 and as `Team2` in
//     game 3, so blue/red is a position there while the team is a reference identity
//     resolves.
//   - `MatchSchedule.Team1`/`Team2` are **source positions, not sides**. They are the
//     column order of one series row, and 52 of the 129 recorded game rows sit beside a
//     series whose `Team1` is their `Team2` (11 series are the other way up in every
//     game). A match therefore carries `sourceOrder` and claims no blue/red side; only a
//     game does.
//   - A game's teams must be its series' teams as a set. The match id alone is too weak:
//     a retargeted game keeps a valid same-event match while landing in a series between
//     two other teams, and a side swap means the order cannot be compared.
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
import type { SourceDraft, SourceGame, SourceMatch, TeamStatField } from "./normalize.ts";
import { TEAM_STAT_FIELDS } from "./normalize.ts";

/** One side of a game. Stats are present only where the source stated a value. */
export type GameSideRecord = {
	side: "blue" | "red";
	teamId: string;
	teamName: string;
	/** The team string the source used, verbatim (spec R7). */
	sourceTeam: string;
} & Partial<Record<TeamStatField, number>>;

/** One champion in a draft, with the source string kept beside the canonical entity. */
export type DraftEntry = {
	/** Source slot number, present only in ordered drafts (R5). */
	slot?: number;
	championId: string;
	championName: string;
	sourceChampion: string;
};

export type DraftSideRecord = {
	side: "blue" | "red";
	picks: DraftEntry[];
	bans: DraftEntry[];
};

export type DraftRecord = {
	/** `ordered` preserves source slots; `unordered` is a set and never implies order. */
	fidelity: "ordered" | "unordered";
	/** The source's side-switch flag, only where an ordered row states one. */
	switchedSides?: boolean;
	sides: [DraftSideRecord, DraftSideRecord];
};

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
	coverage: { teamStats: Coverage; draft: Coverage; playerStats: Coverage };
	/** Absent when the corpus states no draft at all; coverage.draft says `unavailable`. */
	draft?: DraftRecord;
	sides: [GameSideRecord, GameSideRecord];
	winnerTeamId: string;
	winnerTeamName: string;
	source: { gameId: string; matchId: string; riotPlatformGameId?: string };
};

export type MatchSideRecord = {
	/**
	 * The source's own column: `Team1` is 1 and `Team2` is 2. This is a position on the
	 * `MatchSchedule` row, **not** a game side — the games of a series line up either way.
	 */
	sourceOrder: 1 | 2;
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
 * Cyber Games 2013, and a `ScoreboardPlayers` query did the same for IPL 5), and that
 * is not the same claim as "nobody fetched this event".
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
	drafts: SourceDraft[];
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
/** Is `page` the event's own page, or a stage page under it? The rule selects the event page. */
export function pageUnderEvent(page: string, overviewPage: string): boolean {
	return page === overviewPage || page.startsWith(`${overviewPage}/`);
}

function eventForPage(page: string, events: EventRecord[]): EventRecord | undefined {
	let found: EventRecord | undefined;
	for (const event of events) {
		if (!pageUnderEvent(page, event.overviewPage)) continue;
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

/** What a game needs to know about its series: which event it sits in, and its two teams. */
type MatchSeries = { eventId: string; teamIds: [string, string] };

/**
 * The draft of one game, with fidelity taken from the source rather than inferred.
 *
 * A `PicksAndBansS7` row carries numbered slots and is emitted as `ordered`; only the
 * list fields of `ScoreboardGames` are `unordered`, and those are sorted by canonical id
 * so their list position never becomes an invented draft order (R5, R8).
 */
function assembleDraft(game: SourceGame, input: ScoreboardInput, where: string): { draft?: DraftRecord; coverage: Coverage } {
	const resolveChampion = (source: string): DraftEntry => {
		const found = input.identity.resolve("champion", source, game.date);
		if (found === null) throw new Error(`${where}: draft champion ${JSON.stringify(source)} resolves to no entity`);
		return { championId: found.id, championName: found.name, sourceChampion: source };
	};
	// A champion occurs at most once across both sides' picks and bans: one entity
	// cannot be drafted twice in the same game, whichever column it arrived in.
	const checkDuplicates = (entries: DraftEntry[]): void => {
		const ids = new Set(entries.map((entry) => entry.championId));
		if (ids.size !== entries.length) throw new Error(`${where}: the same champion appears twice in this game's draft — picks and bans on both sides must be distinct`);
	};
	const cover = (sides: [DraftSideRecord, DraftSideRecord], ordered: boolean): Coverage => {
		const complete = sides.every((side) =>
			["picks", "bans"].every((group) => {
				const entries = side[group as "picks" | "bans"];
				return entries.length === 5 && (!ordered || entries.every((entry, index) => entry.slot === index + 1));
			}),
		);
		if (complete) return "complete";
		return sides.some((side) => side.picks.length > 0 || side.bans.length > 0) ? "partial" : "unavailable";
	};

	const ordered = input.drafts.find((draft) => draft.gameId === game.gameId);
	if (ordered !== undefined) {
		if (game.date < "2017-01-01") {
			throw new Error(`${where}: an ordered draft is joined to a ${game.date} game, before the ordered-draft era`);
		}
		const sides: [DraftSideRecord, DraftSideRecord] = ordered.sides.map((side, index) => {
			const toEntries = (slots: typeof side.picks): DraftEntry[] =>
				slots.map((slot) => ({ ...resolveChampion(slot.champion), slot: slot.slot }));
			const picks = toEntries(side.picks);
			const bans = toEntries(side.bans);
			return { side: index === 0 ? "blue" : "red", picks, bans };
		}) as [DraftSideRecord, DraftSideRecord];
		const coverage = cover(sides, true);
		checkDuplicates(sides.flatMap((side) => [...side.picks, ...side.bans]));
		// An ordered row that states nothing is not evidence that the game had no draft:
		// the list fields may still carry it. Fall through to them rather than emitting a
		// false `unavailable` (R6).
		if (coverage === "unavailable") {
			// fall through to the unordered source below
		} else return {
			draft: {
				fidelity: "ordered",
				...(ordered.switchedSides === null ? {} : { switchedSides: ordered.switchedSides === 1 }),
				sides,
			},
			coverage,
		};
	}

	const sides: [DraftSideRecord, DraftSideRecord] = [0, 1].map((index) => {
		const picks = game.picks[index].map(resolveChampion).sort((a, b) => (a.championId < b.championId ? -1 : a.championId > b.championId ? 1 : 0));
		const bans = game.bans[index].map(resolveChampion).sort((a, b) => (a.championId < b.championId ? -1 : a.championId > b.championId ? 1 : 0));
		return { side: index === 0 ? "blue" : "red", picks, bans };
	}) as [DraftSideRecord, DraftSideRecord];
	const coverage = cover(sides, false);
	checkDuplicates(sides.flatMap((side) => [...side.picks, ...side.bans]));
	return coverage === "unavailable" ? { coverage } : { draft: { fidelity: "unordered", sides }, coverage };
}

function assembleGame(
	game: SourceGame,
	event: EventRecord,
	input: ScoreboardInput,
	seriesById: ReadonlyMap<string, MatchSeries>,
): GameRecord {
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
	// The era table is the dataset's authority for "could have been recorded", so a value
	// it declares ineligible is a contradiction the build refuses — not something a test
	// catches later over the fixtures while a real crawl (tickets 09/10) sails past it. R10
	// asks for invariants that fail the build, not ones that are documented.
	const eligible = new Set<string>(era.eligible);
	const stated = new Set<string>();
	const both = new Set<TeamStatField>();
	for (const [field] of TEAM_STAT_FIELDS) {
		const onSides = sides.filter((side) => side[field] !== undefined).length;
		if (onSides > 0) stated.add(field);
		if (onSides === sides.length) both.add(field);
	}
	for (const field of stated) {
		if (!eligible.has(field)) {
			throw new Error(
				`${where}: the source states ${field}, which the era table declares ineligible in ${era.id} (${era.from}) — ` +
					"either the game is dated wrong or rules/game-eras.json is, and silently dropping the value would hide which",
			);
		}
	}

	const draft = assembleDraft(game, input, where);

	const matchId = surrogateId("mt", game.matchId);
	const series = seriesById.get(game.matchId);
	if (series !== undefined && series.eventId !== event.id) {
		throw new Error(
			`${where}: its series ${JSON.stringify(game.matchId)} belongs to another event (${series.eventId}, not ${event.id}) — ` +
				"a game and its match cannot sit in different events",
		);
	}
	// The id check above is not enough on its own: a game retargeted to another series of
	// the same event keeps a valid match while landing between two other teams. The compare
	// is on the set, because a side swap is legitimate — 11 recorded series have every game
	// with `Team1` and `Team2` the other way up.
	if (series !== undefined) {
		const gameTeams = [sides[0].teamId, sides[1].teamId].sort();
		const seriesTeams = [...series.teamIds].sort();
		if (gameTeams[0] !== seriesTeams[0] || gameTeams[1] !== seriesTeams[1]) {
			throw new Error(
				`${where}: its teams (${sides.map((side) => `${side.teamId} ${side.teamName}`).join(" vs ")}) are not the teams of its series ` +
					`${JSON.stringify(game.matchId)} (${series.teamIds.join(" vs ")}) — a game cannot sit in a series between two other teams`,
			);
		}
	}
	return {
		id: surrogateId("gm", game.gameId),
		eventId: event.id,
		eventName: event.name,
		...(series === undefined ? {} : { matchId }),
		overviewPage: game.page,
		dateTimeUtc: game.dateTimeUtc,
		...(game.patch === null ? {} : { patch: game.patch }),
		...(game.durationSeconds === null ? {} : { durationSeconds: game.durationSeconds }),
		era: era.id,
		coverage: { teamStats: coverageOf(era, { both, any: stated }), draft: draft.coverage, playerStats: "unavailable" },
		...(draft.draft === undefined ? {} : { draft: draft.draft }),
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
			sourceOrder: (sideIndex + 1) as 1 | 2,
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
 * Did a recorded query address this event's games?
 *
 * Only tables that can carry games or series answer this: a `Tournaments` row names an
 * event without saying anything about whether it has games. The measure is the
 * *literals* a Cargo `where` clause supplies for a page/name column — `OverviewPage='…'`,
 * `Tournament IN ('…','…')`, `GameId LIKE '…%'` — so a substring pattern is not mistaken
 * for a query for the event, and a literal has to equal the event's page, a stage page
 * under it, or its display name rather than merely contain it.
 */

/**
 * The tables whose rows are *games*. Only these can establish "the source has no games
 * for this event": a `ScoreboardPlayers` payload that returned rows says nothing about
 * whether games exist, and treating it as evidence of emptiness marked IPL 5 (`empty`)
 * while a recorded query had in fact returned rows.
 */
const GAME_ROW_TABLES: ReadonlySet<string> = new Set(["ScoreboardGames", "MatchSchedule"]);

/** The Cargo columns a game-bearing table names an event by, lower-case: Cargo columns are not case-sensitive. */
const EVENT_COLUMNS: ReadonlySet<string> = new Set(["overviewpage", "tournament"]);

/**
 * The string literals a Cargo `where` clause supplies for the named columns.
 *
 * Read structurally rather than by substring: `Column='text'`, `Column IN ('a','b')` and
 * an anchored `Column LIKE 'text%'` are the shapes a recorded query uses, while a
 * substring pattern (`LIKE '%text%'`) names no event and is ignored. Cargo escapes a
 * quote inside a literal by doubling it (`'Cho''Gath'`).
 */
function whereLiterals(where: string, columns: ReadonlySet<string>): string[] {
	const found: string[] = [];
	const clause = /\b([A-Za-z_][A-Za-z0-9_]*)\s*(=\s*|IN\s*|LIKE\s*)('(?:[^']|'')*'|\([^)]*\))/gi;
	for (const match of where.matchAll(clause)) {
		if (!columns.has(match[1].toLowerCase())) continue;
		const operator = match[2].trim().toUpperCase();
		for (const literal of match[3].matchAll(/'((?:[^']|'')*)'/g)) {
			const text = literal[1].replace(/''/g, "'");
			if (operator !== "LIKE") {
				found.push(text);
				continue;
			}
			// A `LIKE` names the event only when it is anchored at the start: `LIKE 'page%'`
			// is a query for `page`, and `LIKE 'page'` (no wildcard) is exactly that page.
			// A leading wildcard, or one anywhere but the end, makes it a substring match:
			// it could hit any page that merely contains those words, so it names nothing.
			const body = text.endsWith("%") ? text.slice(0, -1) : text;
			if (body === "" || body.includes("%")) continue;
			found.push(body);
		}
	}
	return found;
}

/** Does a query literal name this event: its page, a stage page under it, or its name? */
function namesEvent(literal: string, event: EventRecord): boolean {
	if (literal === event.overviewPage || literal === event.name) return true;
	// The source splits an event across stage pages (`…/Play-In`, `…/Main Event`), the same
	// boundary `eventForPage` uses, so asking for a stage page is asking for the event.
	return literal.startsWith(`${event.overviewPage}/`);
}

/** How many rows a payload body holds, without trusting it to be well formed. */
function rowCount(payload: CachedPayload): number {
	try {
		const parsed: unknown = JSON.parse(payload.body);
		if (Array.isArray(parsed)) return parsed.length;
		const envelope = parsed as { cargoquery?: unknown } | null;
		return Array.isArray(envelope?.cargoquery) ? envelope.cargoquery.length : 0;
	} catch {
		return 0;
	}
}

function wasAsked(payload: CachedPayload, event: EventRecord): boolean {
	// A game table asked and came back empty is the claim `empty` makes. A player-table
	// payload is still a query that named the event, but its rows are not games, so it
	// cannot say the event has none.
	if (!GAME_ROW_TABLES.has(payload.table) || rowCount(payload) > 0) return false;
	const where = payload.query?.where;
	if (typeof where !== "string" || where === "") return false;
	return whereLiterals(where, EVENT_COLUMNS).some((literal) => namesEvent(literal, event));
}

/** Game ids whose page belongs to a selected event, for identity's draft observations. */
export function selectedGameIds(games: SourceGame[], events: EventRecord[]): Set<string> {
	const ids = new Set<string>();
	for (const game of games) {
		if (eventForPage(game.page, events) !== undefined) ids.add(game.gameId);
	}
	return ids;
}

/** Games, matches, and the per-event report. Sorted, so a rebuild is byte-identical. */
export function assembleScoreboards(input: ScoreboardInput): ScoreboardAssembly {
	const seriesById = new Map<string, MatchSeries>();
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
		const record = assembleMatch(match, event, input);
		matches.push(record);
		seriesById.set(match.matchId, { eventId: event.id, teamIds: [record.sides[0].teamId, record.sides[1].teamId] });
		count(event.id, "matches");
	}
	for (const game of input.games) {
		const event = eventForPage(game.page, input.events);
		if (event === undefined) {
			ignoredGames.push(game.page);
			continue;
		}
		games.push(assembleGame(game, event, input, seriesById));
		count(event.id, "games");
		if (!seriesById.has(game.matchId)) gamesWithoutMatch.push(game.gameId);
	}

	games.sort(byId);
	matches.sort(byId);

	const eventGames: EventGamesRecord[] = input.events.map((event) => {
		const seen = perEvent.get(event.id) ?? { games: 0, matches: 0 };
		// `recorded` means the corpus carries rows for this event, games or series: an event
		// with match rows and no game rows is thin, not unfetched. The wording of the schema
		// and of `event-games.jsonl` says the same thing, so a reader can rely on it.
		const state: EventGamesState =
			seen.games > 0 || seen.matches > 0
				? "recorded"
				: input.payloads.some((payload) => wasAsked(payload, event))
					? "empty"
					: "missing";
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
