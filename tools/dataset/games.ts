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
//     two other teams, and a side swap means the order cannot be compared. Where the two
//     disagree the game is emitted **without** a `matchId` and counted (ticket 14): the
//     source's own `MatchSchedule` swaps three pairs of IPL 5 `MatchId`s, so both records
//     are real and only their link is wrong. The invariant gate refuses any emitted
//     record that *does* claim a series between two other teams, so a hand-edit or a bad
//     merge still fails — what changed is where the source's contradiction lands, not
//     whether a game may sit in someone else's series.
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
import type { GameFormats } from "./formats.ts";
import { blindPickFor, contradictedDraftsFor } from "./formats.ts";
import type { Coverage, EraTable } from "./eras.ts";
import { coverageOf, eraOn } from "./eras.ts";
import type { IdentityIndex, Resolution } from "./identity.ts";
import { AmbiguousIdentity, surrogateId } from "./identity.ts";
import type { SourceDraft, SourceGame, SourceMatch, TeamStatField } from "./normalize.ts";
import { TEAM_STAT_FIELDS } from "./normalize.ts";
import { eventForPage, pageUnderEvent } from "./pages.ts";

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
	/**
	 * Present and true only for a game `rules/game-formats.json` declares played without a
	 * pick-ban phase. It explains an otherwise impossible draft: no bans, and the same
	 * champion possibly on both sides (measured on 2020 Mid-Season Cup game 1s).
	 */
	blindPick?: boolean;
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
	source: { gameId: string; matchId: string; riotPlatformGameId?: string; riotHash?: string };
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

/** One team in a conflict pair, with its display name so the row reads without a join. */
export type ConflictTeam = { teamId: string; teamName: string };

/**
 * One row of `series-conflicts.jsonl`: a game whose series row names other teams, or the
 * series row every game naming it contradicts (ticket 15). Committed beside the entities
 * because a build's stdout is not a dataset: without it, "this series is contradicted"
 * and "this series was never fetched" look identical in `data/curated/`.
 *
 * `gameId`/`sourceGameId` are null on a contradicted-series row, which has no emitted
 * game; `matchId` is present on both, because a detached game still names the series it
 * claims. The team pairs are canonical ids and names, sorted by id so a side swap cannot
 * move them, and the source strings stay on the game and match rows themselves (R7).
 */
export type SeriesConflictRecord = {
	kind: "detached-game" | "contradicted-series";
	eventId: string;
	eventName: string;
	gameId: string | null;
	matchId: string;
	sourceGameId: string | null;
	sourceMatchId: string;
	gameTeams: [ConflictTeam, ConflictTeam] | null;
	matchTeams: [ConflictTeam, ConflictTeam];
};

/** One declared blind-pick rule and how many source games it actually selected. */
export type BlindPickMatch = {
	overviewPage: string;
	gameIdPattern: string;
	/** Zero is reported rather than omitted: a rule that stopped matching is the failure to see. */
	games: number;
};

export type ScoreboardAssembly = {
	games: GameRecord[];
	matches: MatchRecord[];
	eventGames: EventGamesRecord[];
	/**
	 * One entry per declaration in `rules/game-formats.json`, in file order, including the
	 * ones that matched zero games. `cites` is prose no gate reads, so the summary is where
	 * a widening or a dead pattern becomes visible.
	 */
	blindPickMatches: BlindPickMatch[];
	/** Declared contradicted bans, with how many games each actually applied to. */
	contradictedDraftMatches: { overviewPage: string; gameIdPattern: string; champion: string; drop: string; games: number }[];
	/** Pages the rule does not select: counted by the caller, never emitted. */
	ignoredGames: string[];
	ignoredMatches: string[];
	/** Games whose series the corpus does not carry, so no canonical `matchId` is set. */
	gamesWithoutMatch: string[];
	/**
	 * Games the corpus *does* carry a series row for, but whose teams are not that row's
	 * teams. They are emitted with no `matchId` rather than refused or force-fitted: the
	 * source says two things that cannot both be true, and the game's own data is not in
	 * doubt (only the link is). Each entry names both source ids so the report is checkable.
	 */
	detachedGames: { gameId: string; matchId: string }[];
	/**
	 * Series rows every game naming them contradicts. Not emitted: a match row with no
	 * games cannot be told apart from a series whose games were not crawled, so shipping
	 * it would read as "games missing" rather than "this row is contradicted".
	 */
	contradictedMatches: string[];
	/** One row per detached game and per contradicted series, for `series-conflicts.jsonl`. */
	seriesConflicts: SeriesConflictRecord[];
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
	/** Declared game formats: games with no pick-ban phase (ticket 10). */
	formats: GameFormats;
};

const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Lexicographic compare, for the conflict report's deterministic order. */
function compareKeys(a: readonly string[], b: readonly string[]): number {
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const left = a[index] ?? "";
		const right = b[index] ?? "";
		if (left < right) return -1;
		if (left > right) return 1;
	}
	return 0;
}

/** The two sides of a game or series as a pair sorted by canonical id. */
function conflictTeamPair(sides: readonly { teamId: string; teamName: string }[]): [ConflictTeam, ConflictTeam] {
	const pair = sides.map((side) => ({ teamId: side.teamId, teamName: side.teamName }));
	pair.sort((left, right) => (left.teamId < right.teamId ? -1 : left.teamId > right.teamId ? 1 : 0));
	return pair as [ConflictTeam, ConflictTeam];
}

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
type MatchSeries = { eventId: string; teamIds: [string, string]; record: MatchRecord };

/**
 * The draft of one game, with fidelity taken from the source rather than inferred.
 *
 * A `PicksAndBansS7` row carries numbered slots and is emitted as `ordered`; only the
 * list fields of `ScoreboardGames` are `unordered`, and those are sorted by canonical id
 * so their list position never becomes an invented draft order (R5, R8).
 *
 * A game the formats file declares blind pick is the exception that proves the rule: it
 * has no pick-ban phase at all, so it states five picks a side and no bans, and the same
 * champion may stand on both sides (legal in blind pick, impossible in a draft). The
 * declaration is checked against the rows rather than trusted: a declared blind pick
 * that carries an ordered row or a ban stops the build.
 */
function assembleDraft(
	game: SourceGame,
	input: ScoreboardInput,
	event: EventRecord,
	where: string,
	blindPick: boolean,
): { draft?: DraftRecord; coverage: Coverage } {
	const resolveChampion = (source: string): DraftEntry => {
		const found = input.identity.resolve("champion", source, game.date);
		if (found === null) throw new Error(`${where}: draft champion ${JSON.stringify(source)} resolves to no entity`);
		return { championId: found.id, championName: found.name, sourceChampion: source };
	};
	/**
	 * A champion occurs at most once per side: a team cannot pick the same champion twice.
	 * Across the two sides it is a blind-pick fact, and is refused outside a declared
	 * blind pick — measured on 2020 Mid-Season Cup `Semifinals_1_1` and `Finals_1_1`,
	 * where Varus stands on both teams in a game the source also says had no bans.
	 */
	/**
	 * A ban the same side also picked is a contradiction the source cannot mean. The pick
	 * list is corroborated by the player rows (each player's recorded champion), so the ban
	 * is the unverifiable half; it is dropped when the game declares it in
	 * `rules/game-formats.json`, and the build stops otherwise rather than choosing a side
	 * of the contradiction on the reader's behalf.
	 */
	const declared = contradictedDraftsFor(input.formats, event.overviewPage, game.gameId);
	/**
	 * Apply the declared drops: a declared champion is removed from the statement the
	 * declaration sets aside. An *undeclared* contradiction is left in place, so
	 * `checkDuplicates` still stops the build and names the file to declare it in.
	 */
	const resolveContradictedEntries = (sides: DraftSideRecord[]): void => {
		for (const rule of declared) {
			for (const side of sides) {
				if (rule.drop === "bans") side.bans = side.bans.filter((entry) => entry.sourceChampion !== rule.champion);
				else side.picks = side.picks.filter((entry) => entry.sourceChampion !== rule.champion);
			}
		}
	};
	const checkDuplicates = (sides: readonly DraftSideRecord[]): void => {
		for (const side of sides) {
			const ids = new Set([...side.picks, ...side.bans].map((entry) => entry.championId));
			if (ids.size !== side.picks.length + side.bans.length) {
				throw new Error(
					`${where}: the same champion appears twice on the ${side.side} side — a team cannot draft one champion twice. ` +
						"If the source states it that way, declare it in rules/game-formats.json (`contradictedDrafts`)",
				);
			}
		}
		if (blindPick) return;
		const ids = sides.flatMap((side) => [...side.picks, ...side.bans]).map((entry) => entry.championId);
		if (new Set(ids).size !== ids.length) {
			throw new Error(
				`${where}: the same champion appears on both sides — that is legal only in blind pick. ` +
					"Declare the game as blind pick, or the entry as contradicted (`contradictedDrafts`), in rules/game-formats.json",
			);
		}
	};
	const cover = (sides: [DraftSideRecord, DraftSideRecord], ordered: boolean): Coverage => {
		// Blind pick has no ban phase: a complete draft there is five picks a side and no
		// bans, and blaming it for the absent bans would mark it `partial` forever.
		const groups = blindPick ? (["picks"] as const) : (["picks", "bans"] as const);
		const complete = sides.every((side) =>
			groups.every((group) => {
				const entries = side[group];
				return entries.length === 5 && (!ordered || entries.every((entry, index) => entry.slot === index + 1));
			}),
		);
		if (complete) return "complete";
		return sides.some((side) => side.picks.length > 0 || side.bans.length > 0) ? "partial" : "unavailable";
	};

	const ordered = input.drafts.find((draft) => draft.gameId === game.gameId);
	if (ordered !== undefined && blindPick) {
		throw new Error(
			`${where}: the formats file declares this game blind pick, but a PicksAndBansS7 row exists for it — ` +
				"a blind pick has no pick-ban phase, so either the declaration or the row is wrong",
		);
	}
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
		resolveContradictedEntries(sides);
		const coverage = cover(sides, true);
		checkDuplicates(sides);
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
	resolveContradictedEntries(sides);
	const coverage = cover(sides, false);
	checkDuplicates(sides);
	if (blindPick) {
		// Checked, not trusted: the declaration says there was no ban phase, so a stated ban
		// contradicts it and the build says so rather than dropping the row silently.
		const stated = sides.flatMap((side) => side.bans.map((entry) => entry.sourceChampion));
		if (stated.length > 0) {
			throw new Error(
				`${where}: the formats file declares this game blind pick, but the source states ${stated.length} ban(s) ` +
					`(${stated.slice(0, 5).join(", ")}) — a blind pick has no ban phase`,
			);
		}
	}
	if (coverage === "unavailable") return { coverage };
	return {
		draft: { fidelity: "unordered", ...(blindPick ? { blindPick: true } : {}), sides },
		coverage,
	};
}

type GameAssembly = {
	record: GameRecord;
	/** False when the corpus carries the game's series row but it names two other teams. */
	attached: boolean;
};

function assembleGame(
	game: SourceGame,
	event: EventRecord,
	input: ScoreboardInput,
	seriesById: ReadonlyMap<string, MatchSeries>,
): GameAssembly {
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
		const values = sides.map((side) => side[field]).filter((value): value is number => value !== undefined);
		if (values.length === 0) continue;
		if (!eligible.has(field)) {
			// A zero for a field that did not exist yet is the wiki's tool writing 0 for "not
			// applicable", not a claim about the game — measured on 2022 MSI, where the
			// withdrawn Chemtech Drake is stated as 0 on both sides. It is dropped rather than
			// emitted (a 0 would claim the drake could have been taken) and does not count
			// towards coverage. A non-zero value is a real contradiction: the game is dated
			// wrong or the era table is.
			if (values.every((value) => value === 0)) {
				for (const side of sides) delete side[field];
				continue;
			}
			throw new Error(
				`${where}: the source states ${field}, which the era table declares ineligible in ${era.id} (${era.from}) — ` +
					`the value is ${values.find((value) => value !== 0)}, so either the game is dated wrong or rules/game-eras.json is, ` +
					"and silently dropping the value would hide which",
			);
		}
		stated.add(field);
		if (values.length === sides.length) both.add(field);
	}

	const blindPick = blindPickFor(input.formats, event.overviewPage, game.gameId) !== undefined;
	const draft = assembleDraft(game, input, event, where, blindPick);

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
	//
	// A disagreement detaches the game instead of stopping the build (ticket 14). IPL 5's
	// `MatchSchedule` swaps the `MatchId`s of three pairs of series, so the games and the
	// series rows are both real data and only their *link* is wrong; refusing the event
	// would throw 72 games away over three swapped keys, and trusting the link would attach
	// a game to a series between two other teams. The emitted game therefore carries no
	// `matchId`, the summary counts it, and the invariant gate still refuses any record
	// that *does* claim such a match — so nothing is loosened, only the honest record is
	// written.
	let attached = series !== undefined;
	if (series !== undefined) {
		const gameTeams = [sides[0].teamId, sides[1].teamId].sort();
		const seriesTeams = [...series.teamIds].sort();
		attached = gameTeams[0] === seriesTeams[0] && gameTeams[1] === seriesTeams[1];
	}
	return {
		attached,
		record: {
			id: surrogateId("gm", game.gameId),
			eventId: event.id,
			eventName: event.name,
			...(attached ? { matchId } : {}),
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
				...(game.riotHash === "" ? {} : { riotHash: game.riotHash }),
			},
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
	if (literal === event.name) return true;
	// The source splits an event across stage pages (`…/Play-In`, `…/Main Event`), and the
	// qualifier boundary is the same one `eventForPage` uses, so this must be that predicate
	// rather than a bare prefix: an empty qualifier query is not a query for the event.
	return pageUnderEvent(literal, event.overviewPage);
}

/**
 * How many rows a payload body holds. A body that is not JSON is a build error naming the
 * payload: the normalizer would refuse it later anyway, and reading it as zero rows here
 * could back an `empty` verdict on bytes that were never understood.
 */
function rowCount(payload: CachedPayload): number {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload.body);
	} catch (error) {
		throw new Error(`${payload.file}: not JSON (${(error as Error).message})`);
	}
	if (Array.isArray(parsed)) return parsed.length;
	const envelope = parsed as { cargoquery?: unknown } | null;
	return Array.isArray(envelope?.cargoquery) ? envelope.cargoquery.length : 0;
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
	const detachedGames: { gameId: string; matchId: string }[] = [];
	const contradictedMatches: string[] = [];
	const seriesConflicts: SeriesConflictRecord[] = [];
	const perEvent = new Map<string, { games: number; matches: number }>();
	const count = (eventId: string, field: "games" | "matches"): void => {
		const seen = perEvent.get(eventId) ?? { games: 0, matches: 0 };
		seen[field] += 1;
		perEvent.set(eventId, seen);
	};

	/**
	 * For each series a game names, how many of those games it actually holds. Presence is
	 * what says a game named it at all; zero is the case ticket 14 is about.
	 */
	const held = new Map<string, number>();

	// Series first, because a game needs to know whether its series' teams are its own. A
	// series is held back until every game has been compared: one that every game naming
	// it contradicts is not those games' series, and emitting it would look like a series
	// whose games were not crawled.
	const candidates: { match: SourceMatch; event: EventRecord; record: MatchRecord }[] = [];
	for (const match of input.matches) {
		const event = eventForPage(match.page, input.events);
		if (event === undefined) {
			ignoredMatches.push(match.page);
			continue;
		}
		const record = assembleMatch(match, event, input);
		candidates.push({ match, event, record });
		seriesById.set(match.matchId, { eventId: event.id, teamIds: [record.sides[0].teamId, record.sides[1].teamId], record });
	}
	for (const game of input.games) {
		const event = eventForPage(game.page, input.events);
		if (event === undefined) {
			ignoredGames.push(game.page);
			continue;
		}
		const { record, attached } = assembleGame(game, event, input, seriesById);
		games.push(record);
		count(event.id, "games");
		const series = seriesById.get(game.matchId);
		if (series === undefined) {
			gamesWithoutMatch.push(game.gameId);
			continue;
		}
		held.set(game.matchId, (held.get(game.matchId) ?? 0) + (attached ? 1 : 0));
		if (!attached) {
			detachedGames.push({ gameId: game.gameId, matchId: game.matchId });
			seriesConflicts.push({
				kind: "detached-game",
				eventId: event.id,
				eventName: event.name,
				gameId: record.id,
				matchId: series.record.id,
				sourceGameId: game.gameId,
				sourceMatchId: game.matchId,
				gameTeams: conflictTeamPair(record.sides),
				matchTeams: conflictTeamPair(series.record.sides),
			});
		}
	}
	for (const candidate of candidates) {
		const agreed = held.get(candidate.match.matchId);
		// `agreed === undefined` is a series no game names at all: the corpus states it and
		// says nothing against it, so it is emitted as it always was.
		if (agreed === 0) {
			contradictedMatches.push(candidate.match.matchId);
			seriesConflicts.push({
				kind: "contradicted-series",
				eventId: candidate.event.id,
				eventName: candidate.event.name,
				gameId: null,
				matchId: candidate.record.id,
				sourceGameId: null,
				sourceMatchId: candidate.match.matchId,
				gameTeams: null,
				matchTeams: conflictTeamPair(candidate.record.sides),
			});
			continue;
		}
		matches.push(candidate.record);
		count(candidate.event.id, "matches");
	}

	games.sort(byId);
	matches.sort(byId);
	seriesConflicts.sort((a, b) =>
		compareKeys(
			[a.kind, a.eventId, a.matchId, a.gameId ?? "", a.sourceGameId ?? ""],
			[b.kind, b.eventId, b.matchId, b.gameId ?? "", b.sourceGameId ?? ""],
		),
	);

	// A declaration that matches no game of an event the corpus carries is a typo, and a typo
	// here is silent in the worst way: the games it meant to cover would fail as a duplicate
	// champion instead of pointing at the file to fix. An event the corpus does not carry is
	// skipped, so a narrow fixture set can still use the same rules file.
	//
	// Every declaration is counted, matching or not, and the count travels to the CLI summary:
	// a pattern that silently widened as the corpus grew would otherwise be invisible.
	const blindPickMatches: BlindPickMatch[] = [];
	for (const rule of input.formats.blindPick) {
		const under = input.games.filter((game) => eventForPage(game.page, input.events)?.overviewPage === rule.overviewPage);
		const pattern = new RegExp(rule.gameIdPattern, "u");
		const games = under.filter((game) => pattern.test(game.gameId)).length;
		blindPickMatches.push({ overviewPage: rule.overviewPage, gameIdPattern: rule.gameIdPattern, games });
		if (under.length === 0) continue;
		if (games === 0) {
			throw new Error(
				`rules/game-formats.json: the blind-pick declaration for ${JSON.stringify(rule.overviewPage)} ` +
					`(pattern ${JSON.stringify(rule.gameIdPattern)}) matches none of its ${under.length} game(s) — the corpus has games for that event, so this is a typo`,
			);
		}
	}

	// A declared contradicted ban is checked the way a blind pick is: the declaration must
	// still describe a row the corpus carries, or it has stopped covering the thing it was
	// written for and the next crawl will fail on that row with no pointer to the file.
	const eventPageById = new Map(input.events.map((event) => [event.id, event.overviewPage]));
	// `?? []`: a hand-built input in a test predates the field; a loaded formats file always
	// carries it (the parser requires the array, empty when there is nothing to declare).
	const contradictedDraftMatches = (input.formats.contradictedDrafts ?? []).map((rule) => {
		const pattern = new RegExp(rule.gameIdPattern, "u");
		const under = games.filter(
			(game) => eventPageById.get(game.eventId) === rule.overviewPage && pattern.test(game.source.gameId),
		);
		// The declaration has to have done something: the dropped statement is gone, and the
		// kept one is still there. A rule that matched nothing would otherwise be silent.
		const applied = under.filter((game) => {
			const sides = game.draft?.sides ?? [];
			const inPicks = sides.some((side) => side.picks.some((entry) => entry.sourceChampion === rule.champion));
			const inBans = sides.some((side) => side.bans.some((entry) => entry.sourceChampion === rule.champion));
			return rule.drop === "bans" ? inPicks && !inBans : !inPicks && !inBans;
		}).length;
		if (under.length > 0 && applied === 0) {
			throw new Error(
				`rules/game-formats.json: the contradicted-draft declaration for ${JSON.stringify(rule.overviewPage)} ` +
					`(pattern ${JSON.stringify(rule.gameIdPattern)}, champion ${JSON.stringify(rule.champion)}) matches no such row — ` +
					"the corpus carries games for that event, so either the row changed or the declaration is a typo",
			);
		}
		return { overviewPage: rule.overviewPage, gameIdPattern: rule.gameIdPattern, champion: rule.champion, drop: rule.drop, games: applied };
	});

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

	return { games, matches, eventGames, blindPickMatches, contradictedDraftMatches, ignoredGames, ignoredMatches, gamesWithoutMatch, detachedGames, contradictedMatches, seriesConflicts };
}
