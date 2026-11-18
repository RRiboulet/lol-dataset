// invariants: the gate that makes a bad dataset impossible to commit (spec R10).
//
// The schemas decide whether a record is *shaped* correctly. This decides whether the
// dataset as a whole is *true*: that a game has one winner and two different sides,
// that every reference resolves, that a coverage marker does not claim more than the
// rows contain, and that a player's kills are the kills their team scored. A single
// record can satisfy its schema and still contradict the row beside it, which is
// exactly what a hand-edit or a bad merge produces.
//
// Three rules shape this file:
//
//   - every violation is collected, never thrown at the first one. A corruption in
//     one file must not hide the corruptions in the others (ticket 06, criterion 5).
//   - each message names the record by its id, so the failure says which line of
//     which file to open rather than "the dataset is invalid".
//   - it reads only the emitted records. It does not re-derive them, because a gate
//     that calls the assembler again would agree with the assembler by construction.

import type { EventRecord, SelectionRecord } from "./assemble.ts";
import type { CoverageGroups, EventCoverageRecord, EraCoverageRecord } from "./coverage.ts";
import { COVERAGE_GROUPS, countGroups } from "./coverage.ts";
import type { Coverage, EraTable } from "./eras.ts";
import type { EventGamesRecord, GameRecord, MatchRecord, SeriesConflictRecord } from "./games.ts";
import type { AssembledIdentity } from "./identity.ts";
import { TEAM_STAT_FIELDS } from "./normalize.ts";
import type { PlayerGameRecord } from "./playerGames.ts";

/** Everything the gate reads: the emitted records, not the payloads they came from. */
export type InvariantInput = {
	events: EventRecord[];
	selection: SelectionRecord[];
	identity: AssembledIdentity;
	games: GameRecord[];
	matches: MatchRecord[];
	eventGames: EventGamesRecord[];
	seriesConflicts: SeriesConflictRecord[];
	/** The per-event aggregation of the games' coverage markers (ticket 10). */
	eventCoverage: EventCoverageRecord[];
	/** The per-era aggregation of the same markers (ticket 10). */
	eraCoverage: EraCoverageRecord[];
	playerGames: PlayerGameRecord[];
	eras: EraTable;
};

/** The enum the coverage markers use, so a typo cannot pass as a state. */
const COVERAGE: readonly Coverage[] = ["complete", "partial", "unavailable"];

/** The surrogate-key prefix each entity kind uses, for checking an alias points at its own kind. */
const KIND_PREFIX = { team: "tm-", player: "pl-", champion: "ch-" } as const;

class Collector {
	readonly violations: string[] = [];

	add(record: string, message: string): void {
		this.violations.push(`${record}: ${message}`);
	}

	/** Every value that must appear once, reported with the duplicate ids. */
	unique<T extends { id: string }>(what: string, records: T[]): void {
		const seen = new Map<string, number>();
		for (const record of records) seen.set(record.id, (seen.get(record.id) ?? 0) + 1);
		for (const [id, count] of seen) {
			if (count > 1) this.add(`${what} ${id}`, `appears ${count} times — an id identifies one record`);
		}
	}

	/** The same, for a record keyed by something other than `id` (the per-event report). */
	uniqueBy(what: string, records: Record<string, unknown>[], key: string): void {
		const seen = new Map<string, number>();
		for (const record of records) seen.set(String(record[key]), (seen.get(String(record[key])) ?? 0) + 1);
		for (const [value, count] of seen) {
			if (count > 1) this.add(`${what} ${value}`, `appears ${count} times — one record per key`);
		}
	}

	/** A statistic the source may omit, but never a negative one. */
	nonNegative(record: string, fields: Record<string, unknown>): void {
		for (const [name, value] of Object.entries(fields)) {
			if (value === undefined) continue;
			if (typeof value !== "number" || !Number.isFinite(value)) {
				this.add(record, `${name} is ${JSON.stringify(value)}, which is not a number`);
			} else if (value < 0) {
				this.add(record, `${name} is ${value} — a statistic cannot be negative`);
			}
		}
	}
}

/** The numeric fields a player row may carry; the rest of the row is references and lists. */
const PLAYER_STATS = ["kills", "deaths", "assists", "cs", "gold", "damage", "vision"] as const;

/** The numeric team statistics a game side may carry. */
const TEAM_STATS = TEAM_STAT_FIELDS.map(([field]) => field);

/** The fields a game's era allows, by era id, for the coverage cross-check. */
function eligibleByEra(eras: EraTable): Map<string, Set<string>> {
	const byId = new Map<string, Set<string>>();
	for (const era of eras.groups["team-stats"]) byId.set(era.id, new Set(era.eligible));
	return byId;
}

/**
 * Every invariant violation in `input`, or an empty list for a clean dataset.
 *
 * Kept separate from `assertInvariants` so a caller can count or report them without
 * catching an exception.
 */
export function findInvariantViolations(input: InvariantInput): string[] {
	const collector = new Collector();
	const { events, selection, identity, games, matches, eventGames, seriesConflicts, eventCoverage, eraCoverage, playerGames, eras } = input;

	// ---- identity: the tables every other record references ----------------------
	const teamIds = new Set(identity.teams.map((team) => team.id));
	const playerIds = new Set(identity.players.map((player) => player.id));
	const championIds = new Set(identity.champions.map((champion) => champion.id));
	const entityIds = new Set([...teamIds, ...playerIds, ...championIds]);
	collector.unique("team", identity.teams);
	collector.unique("player", identity.players);
	collector.unique("champion", identity.champions);
	for (const alias of identity.aliases) {
		if (!entityIds.has(alias.entityId)) collector.add(`alias ${JSON.stringify(alias.string)}`, `points at ${alias.entityId}, which is not an entity`);
		// An alias must point at an entity of its own kind: the prefixes are disjoint, so a
		// team alias resolving to a champion is a merge nobody meant.
		else if (!alias.entityId.startsWith(KIND_PREFIX[alias.kind])) {
			collector.add(`alias ${JSON.stringify(alias.string)}`, `is a ${alias.kind} alias but points at ${alias.entityId}, which is another kind of entity`);
		}
	}
	for (const row of identity.unresolved) {
		if (row.id === null) continue;
		if (!entityIds.has(row.id)) collector.add(`unresolved ${JSON.stringify(row.string)}`, `points at ${row.id}, which is not an entity`);
		else if (!row.id.startsWith(KIND_PREFIX[row.kind])) {
			collector.add(`unresolved ${JSON.stringify(row.string)}`, `is a ${row.kind} reference but points at ${row.id}, which is another kind of entity`);
		}
	}

	// ---- events and the selection report ----------------------------------------
	const eventIds = new Set(events.map((event) => event.id));
	collector.unique("event", events);
	collector.unique("selection", selection);
	const included = new Set(selection.filter((record) => record.decision === "included").map((record) => record.id));
	for (const event of events) {
		if (!included.has(event.id)) collector.add(`event ${event.id}`, "is emitted but the selection report has no included row for it");
	}
	for (const record of selection) {
		if (record.decision === "included" && !eventIds.has(record.id)) {
			collector.add(`selection ${record.id}`, "is marked included but no event carries that id");
		}
		if (record.decision === "rejected" && eventIds.has(record.id)) {
			collector.add(`event ${record.id}`, "is emitted although the selection report rejects it");
		}
	}
	for (const record of eventGames) {
		if (!eventIds.has(record.eventId)) collector.add(`event-games ${record.eventId}`, "reports on an event that is not emitted");
	}
	collector.uniqueBy("event-games", eventGames as unknown as Record<string, unknown>[], "eventId");

	// ---- games, matches and their cross-references -------------------------------
	const gameIds = new Set(games.map((game) => game.id));
	const matchIds = new Set(matches.map((match) => match.id));
	collector.unique("game", games);
	collector.unique("match", matches);
	const eligible = eligibleByEra(eras);

	for (const game of games) {
		const where = `game ${game.id}`;
		if (!eventIds.has(game.eventId)) collector.add(where, `references event ${game.eventId}, which is not emitted`);
		if (game.durationSeconds !== undefined && game.durationSeconds < 0) {
			collector.add(where, `durationSeconds is ${game.durationSeconds} — a duration cannot be negative`);
		}
		if (game.matchId !== undefined) {
			const match = matches.find((candidate) => candidate.id === game.matchId);
			if (match === undefined) collector.add(where, `references match ${game.matchId}, which is not emitted`);
			else if (match.eventId !== game.eventId) collector.add(where, `references match ${game.matchId} of another event (${match.eventId}) — a game and its series share an event`);
			else if (game.sides.length === 2) {
				// The link has to be the truth, not merely a valid id. A hand-edit or a bad merge
				// can keep a same-event match while putting the game between two other teams, and
				// no id check sees it — only the team set does. The build detaches a game the
				// source's series contradicts (ticket 14), so this fires on an edited record or on
				// an assembler that stopped detaching, never on the recorded data.
				const teams = game.sides.map((side) => side.teamId).sort();
				const series = match.sides.map((side) => side.teamId).sort();
				if (teams[0] !== series[0] || teams[1] !== series[1]) {
					collector.add(
						where,
						`names series ${game.matchId} between ${series.join(" and ")}, but its own sides are ${teams.join(" and ")} — ` +
							"a game cannot sit in a series between two other teams",
					);
				}
			}
		}
		if (game.sides.length !== 2) {
			collector.add(where, `has ${game.sides.length} sides — a game has exactly two`);
		} else {
			const [blue, red] = game.sides;
			if (blue.teamId === red.teamId) collector.add(where, `both sides are ${blue.teamId} — a game cannot be a team against itself`);
		}
		for (const side of game.sides) {
			if (!teamIds.has(side.teamId)) collector.add(where, `side ${side.side} references team ${side.teamId}, which is not emitted`);
			collector.nonNegative(`${where} ${side.side}`, Object.fromEntries(TEAM_STATS.map((field) => [field, (side as unknown as Record<string, unknown>)[field]])));
		}
		const winners = game.sides.filter((side) => side.teamId === game.winnerTeamId).length;
		if (winners !== 1) collector.add(where, `has ${winners} winning sides for ${game.winnerTeamId} — exactly one side wins`);
		for (const [group, state] of Object.entries(game.coverage)) {
			if (!COVERAGE.includes(state)) collector.add(where, `coverage.${group} is ${JSON.stringify(state)}, which is not a coverage state`);
		}
		// A `complete` claim must be backed by the record. The era decides which fields
		// the source could have held, so the check uses the same table the build used.
		if (game.coverage.teamStats === "complete") {
			const fields = eligible.get(game.era);
			if (fields === undefined) {
				collector.add(where, `claims complete team statistics in era ${JSON.stringify(game.era)}, which is not in the era table`);
			} else {
				for (const field of fields) {
					for (const side of game.sides) {
						if (!(field in side)) collector.add(where, `claims complete team statistics but ${side.side} has no ${field}`);
					}
				}
			}
		}
		if (game.coverage.teamStats === "unavailable") {
			for (const side of game.sides) {
				// Presence, not key existence: an absent statistic is not written at all, so a
				// key set to `undefined` is absence too (this is what `coverageOf` implements).
				const stated = Object.entries(side)
					.filter(([key, value]) => !["side", "teamId", "teamName", "sourceTeam"].includes(key) && value !== undefined)
					.map(([key]) => key);
				if (stated.length > 0) collector.add(where, `claims team statistics are unavailable but ${side.side} carries ${stated.join(", ")}`);
			}
		}
		if (game.draft !== undefined && game.coverage.draft === "unavailable") {
			collector.add(where, "carries a draft while claiming none is available");
		}
		// Draft claims.
		if (game.draft !== undefined) {
			// A champion plays once per **side**. Across the two sides it is legal only in a
			// declared blind pick, where there is no ban phase and both teams may lock the same
			// champion (measured on 2020 Mid-Season Cup game 1s); anywhere else it is a
			// contradiction, and a declaration is the only thing that can say which it is.
			const blindPick = game.draft.blindPick === true;
			const across = new Map<string, number>();
			for (const side of game.draft.sides) {
				const onThisSide = new Set<string>();
				for (const entry of [...side.picks, ...side.bans]) {
					if (!championIds.has(entry.championId)) collector.add(where, `draft references champion ${entry.championId}, which is not emitted`);
					if (onThisSide.has(entry.championId)) {
						collector.add(where, `draft drafts ${entry.championId} twice on the ${side.side} side — a team cannot draft one champion twice`);
					}
					onThisSide.add(entry.championId);
					across.set(entry.championId, (across.get(entry.championId) ?? 0) + 1);
				}
			}
			if (!blindPick) {
				for (const [championId, count] of across) {
					if (count > 1) collector.add(where, `draft drafts ${championId} ${count} times across both sides — one champion plays once per game unless the game is a declared blind pick`);
				}
			}
			if (blindPick) {
				// The complement of the exception: a declared blind pick states no bans, and a
				// record that claims the declaration while carrying bans is not credible either.
				for (const side of game.draft.sides) {
					if (side.bans.length > 0) collector.add(where, `is a declared blind pick but ${side.side} carries ${side.bans.length} ban(s) — a blind pick has no ban phase`);
				}
			}
			if (game.coverage.draft === "complete") {
				for (const side of game.draft.sides) {
					if (side.picks.length !== 5) collector.add(where, `claims complete draft but ${side.side} has ${side.picks.length} picks`);
					// A blind pick is complete with no bans: the phase does not exist there.
					const expectedBans = blindPick ? 0 : 5;
					if (side.bans.length !== expectedBans) collector.add(where, `claims complete draft but ${side.side} has ${side.bans.length} bans`);
					// `ordered` means the source kept the slots, so a complete ordered draft must
					// carry each slot exactly once. Length alone would accept a swapped or
					// missing slot, which is the fidelity R5 exists to preserve.
					if (game.draft.fidelity === "ordered") {
						for (const group of ["picks", "bans"] as const) {
							const slots = side[group].map((entry) => entry.slot);
							// Slots are the source order, so they must read 1..5 in sequence. Comparing
							// as a multiset would accept a swap, and order is exactly what R5 preserves.
							const inOrder = slots.length === 5 && slots.every((slot, index) => slot === index + 1);
							if (!inOrder) {
								collector.add(where, `claims an ordered complete draft but ${side.side} ${group} slots are ${JSON.stringify(slots)}`);
							}
						}
					} else {
						for (const group of ["picks", "bans"] as const) {
							if (side[group].some((entry) => entry.slot !== undefined)) {
								collector.add(where, `is an unordered draft but ${side.side} ${group} carry slots — order was not recorded`);
							}
						}
					}
				}
			}
			for (const side of game.draft.sides) {
				for (const entry of [...side.picks, ...side.bans]) {
					if (entry.slot !== undefined && (entry.slot < 1 || entry.slot > 5)) {
						collector.add(where, `draft slot ${entry.slot} is outside 1..5`);
					}
				}
			}
		} else if (game.coverage.draft !== "unavailable") {
			collector.add(where, `claims draft ${game.coverage.draft} but carries no draft`);
		}
	}

	for (const match of matches) {
		const where = `match ${match.id}`;
		if (!eventIds.has(match.eventId)) collector.add(where, `references event ${match.eventId}, which is not emitted`);
		if (match.bestOf !== undefined && match.bestOf < 1) collector.add(where, `bestOf is ${match.bestOf} — a series is at least one game`);
		if (match.sides.length !== 2) {
			collector.add(where, `has ${match.sides.length} sides — a series has exactly two`);
		} else if (match.sides[0].teamId === match.sides[1].teamId) {
			collector.add(where, `both sides are ${match.sides[0].teamId} — a series cannot be a team against itself`);
		}
		for (const side of match.sides) {
			if (!teamIds.has(side.teamId)) collector.add(where, `side ${side.sourceOrder} references team ${side.teamId}, which is not emitted`);
			if (side.seriesScore !== undefined && side.seriesScore < 0) collector.add(where, `seriesScore is ${side.seriesScore} — a score cannot be negative`);
		}
		if (match.winnerTeamId !== undefined && !match.sides.some((side) => side.teamId === match.winnerTeamId)) {
			collector.add(where, `names winner ${match.winnerTeamId}, which is not one of its sides`);
		}
	}

	// ---- the conflict report: a detached game, or a series that is not emitted ---
	// The report is committed data, so its references are checked like any other file's.
	// It cannot be re-derived from the emitted rows (a contradicted series is absent by
	// definition), but a row that names the wrong game, event or team is a hand-edit or a
	// bad merge and is refused here.
	const conflictKeys = new Set<string>();
	for (const row of seriesConflicts) {
		const key = row.kind === "detached-game" ? `game\u0000${row.gameId ?? ""}` : `series\u0000${row.matchId}`;
		const where = `series-conflict ${row.sourceGameId ?? row.sourceMatchId}`;
		if (conflictKeys.has(key)) collector.add(where, "appears more than once — one row per detached game or contradicted series");
		conflictKeys.add(key);
		if (!eventIds.has(row.eventId)) collector.add(where, `references event ${row.eventId}, which is not emitted`);
		for (const team of [...(row.gameTeams ?? []), ...row.matchTeams]) {
			if (!teamIds.has(team.teamId)) collector.add(where, `references team ${team.teamId}, which is not emitted`);
		}
		if (row.kind === "detached-game") {
			if (row.gameId === null || row.sourceGameId === null) {
				collector.add(where, "is a detached game without a canonical or source game id");
				continue;
			}
			const game = games.find((candidate) => candidate.id === row.gameId);
			if (game === undefined) {
				collector.add(where, `names game ${row.gameId}, which is not emitted`);
			} else {
				if (game.matchId !== undefined) collector.add(where, `says game ${row.gameId} is detached but the game carries matchId ${game.matchId}`);
				if (game.source.matchId !== row.sourceMatchId) collector.add(where, `names source series ${row.sourceMatchId}, but game ${row.gameId} names ${game.source.matchId}`);
				if (game.eventId !== row.eventId) collector.add(where, `names event ${row.eventId}, but game ${row.gameId} belongs to ${game.eventId}`);
				const gameTeams = game.sides.map((side) => side.teamId).sort().join("|");
				if (row.gameTeams?.map((team) => team.teamId).sort().join("|") !== gameTeams) {
					collector.add(where, `names game teams ${row.gameTeams?.map((team) => team.teamId).join(" and ") ?? "none"}, but game ${row.gameId} has ${gameTeams}`);
				}
			}
			// The series may still be emitted for the other games that name it; only this
			// game's link to it was refused. A contradicted-series row is where absence is claimed.
			const series = matches.find((match) => match.id === row.matchId);
			if (series !== undefined) {
				const seriesTeams = series.sides.map((side) => side.teamId).sort().join("|");
				if (row.matchTeams.map((team) => team.teamId).sort().join("|") !== seriesTeams) {
					collector.add(where, `names series teams ${row.matchTeams.map((team) => team.teamId).join(" and ")}, but series ${row.matchId} has ${seriesTeams}`);
				}
			}
		} else {
			if (row.gameId !== null || row.sourceGameId !== null) collector.add(where, "is a contradicted series that still names an emitted game");
			if (matchIds.has(row.matchId)) collector.add(where, `names series ${row.matchId}, which is emitted — a contradicted series is not`);
			if (games.some((game) => game.matchId === row.matchId)) collector.add(where, `names series ${row.matchId}, which an emitted game still claims`);
		}
	}

	// ---- player rows: references, grain, coverage and the sums -------------------
	collector.unique("player-game", playerGames);
	const rowsByGame = new Map<string, PlayerGameRecord[]>();
	for (const row of playerGames) {
		const where = `player-game ${row.id}`;
		if (!gameIds.has(row.gameId)) collector.add(where, `references game ${row.gameId}, which is not emitted`);
		if (!playerIds.has(row.playerId)) collector.add(where, `references player ${row.playerId}, which is not emitted`);
		if (!teamIds.has(row.teamId)) collector.add(where, `references team ${row.teamId}, which is not emitted`);
		if (!championIds.has(row.championId)) collector.add(where, `references champion ${row.championId}, which is not emitted`);
		collector.nonNegative(where, Object.fromEntries(PLAYER_STATS.map((field) => [field, (row as unknown as Record<string, unknown>)[field]])));
		// A row must belong to a game's own teams and event. Without this, a row can be
		// silently attached to an unrelated game whenever the game's coverage is partial,
		// because only `complete` games are otherwise cross-checked.
		const owner = games.find((game) => game.id === row.gameId);
		if (owner !== undefined) {
			if (!owner.sides.some((side) => side.teamId === row.teamId)) {
				collector.add(where, `names team ${row.teamId}, which is not one of its game's sides`);
			}
			if (row.eventId !== owner.eventId) collector.add(where, `names event ${row.eventId} but its game belongs to ${owner.eventId}`);
		}
		const list = rowsByGame.get(row.gameId) ?? [];
		list.push(row);
		rowsByGame.set(row.gameId, list);
	}

	const gamesById = new Map(games.map((game) => [game.id, game]));
	for (const game of games) {
		const rows = rowsByGame.get(game.id) ?? [];
		const where = `game ${game.id}`;
		if (game.coverage.playerStats === "complete") {
			if (rows.length !== 10) collector.add(where, `claims complete player statistics but carries ${rows.length} player rows`);
			for (const side of game.sides) {
				const sideRows = rows.filter((row) => row.teamId === side.teamId);
				if (sideRows.length !== 5) collector.add(where, `claims complete player statistics but ${side.side} has ${sideRows.length} players`);
				const roles = new Set(sideRows.map((row) => row.role.trim().toLowerCase()));
				if (sideRows.length === 5 && roles.size !== 5) collector.add(where, `claims complete player statistics but ${side.side} repeats a played role`);
				const kills = sideRows.reduce((sum, row) => sum + (row.kills ?? 0), 0);
				const gold = sideRows.reduce((sum, row) => sum + (row.gold ?? 0), 0);
				if (side.kills !== undefined && kills !== side.kills) {
					collector.add(where, `claims complete player statistics but ${side.side} players sum to ${kills} kills against the team's ${side.kills}`);
				}
				if (side.gold !== undefined && gold !== side.gold) {
					collector.add(where, `claims complete player statistics but ${side.side} players sum to ${gold} gold against the team's ${side.gold}`);
				}
			}
		}
		// A player row whose side disagrees with the game's side for that team is a
		// contradiction no schema can see, because both records are individually valid.
		for (const row of rows) {
			const side = game.sides.find((candidate) => candidate.teamId === row.teamId);
			if (side !== undefined && side.side !== row.side) {
				collector.add(`player-game ${row.id}`, `says ${row.side} but its team is the game's ${side.side} side`);
			}
		}
		if (game.coverage.playerStats === "unavailable" && rows.length > 0) {
			collector.add(where, `claims player statistics are unavailable but carries ${rows.length} player rows`);
		}
		if (game.coverage.playerStats === "partial" && rows.length === 0) {
			collector.add(where, "claims partial player statistics but carries no player rows");
		}
	}
	for (const [gameId, rows] of rowsByGame) {
		if (!gamesById.has(gameId)) continue; // already reported per row
		const seenPlayers = new Set<string>();
		for (const row of rows) {
			if (seenPlayers.has(row.playerId)) collector.add(`game ${gameId}`, `player ${row.playerId} appears more than once`);
			seenPlayers.add(row.playerId);
		}
	}

	// ---- the per-event report must not contradict the emitted rows ---------------
	const gamesPerEvent = new Map<string, number>();
	for (const game of games) gamesPerEvent.set(game.eventId, (gamesPerEvent.get(game.eventId) ?? 0) + 1);
	const matchesPerEvent = new Map<string, number>();
	for (const match of matches) matchesPerEvent.set(match.eventId, (matchesPerEvent.get(match.eventId) ?? 0) + 1);
	const reportByEvent = new Map(eventGames.map((record) => [record.eventId, record]));
	for (const event of events) {
		if (!reportByEvent.has(event.id)) collector.add(`event-games ${event.id}`, "has no report row — every selected event is reported on");
	}
	for (const record of eventGames) {
		const where = `event-games ${record.eventId}`;
		if (record.games < 0 || record.matches < 0) collector.add(where, "reports a negative count");
		if (record.games !== (gamesPerEvent.get(record.eventId) ?? 0)) {
			collector.add(where, `says ${record.games} games but ${gamesPerEvent.get(record.eventId) ?? 0} are emitted`);
		}
		if (record.matches !== (matchesPerEvent.get(record.eventId) ?? 0)) {
			collector.add(where, `says ${record.matches} matches but ${matchesPerEvent.get(record.eventId) ?? 0} are emitted`);
		}
		if (record.state === "recorded" && record.games === 0 && record.matches === 0) {
			collector.add(where, "says recorded but carries neither a game nor a match");
		}
		// `empty` and `missing` both mean "no rows": a query that named the event came
		// back with none, or nobody asked. Either way a row would contradict the state.
		if ((record.state === "empty" || record.state === "missing") && (record.games > 0 || record.matches > 0)) {
			collector.add(where, `says ${record.state} but carries ${record.games} games and ${record.matches} matches`);
		}
	}

	// ---- the coverage report must be the games' own markers, re-counted -----------
	// Ticket 10's criterion: an event is never reported more complete than its games.
	// The report is generated, so this is not a second opinion — it is the check that the
	// generator ran over the rows that were emitted, rather than over a stale list or a
	// hand edit. Both grains are re-counted, and the two totals must agree with each other
	// and with `games.jsonl`, so no game can hide from either report.
	collector.uniqueBy("event-coverage", eventCoverage as unknown as Record<string, unknown>[], "eventId");
	collector.uniqueBy("era-coverage", eraCoverage as unknown as Record<string, unknown>[], "era");
	const gamesByEventId = new Map<string, GameRecord[]>();
	for (const game of games) {
		const list = gamesByEventId.get(game.eventId) ?? [];
		list.push(game);
		gamesByEventId.set(game.eventId, list);
	}
	const compareGroups = (where: string, gamesForRow: GameRecord[], stated: CoverageGroups): void => {
		const actual = countGroups(gamesForRow);
		for (const group of COVERAGE_GROUPS) {
			const said = stated[group];
			if (said === undefined) {
				collector.add(where, `has no coverage for ${group}`);
				continue;
			}
			const sum = said.complete + said.partial + said.unavailable;
			if (sum !== gamesForRow.length) {
				collector.add(where, `${group} counts sum to ${sum} but ${gamesForRow.length} game(s) are here`);
			}
			for (const state of COVERAGE) {
				if (said[state] !== actual[group][state]) {
					collector.add(where, `${group} says ${said[state]} ${state} but the games are ${actual[group][state]}`);
				}
			}
			if (said.state !== actual[group].state) {
				collector.add(where, `${group} state is ${JSON.stringify(said.state)} but the games make it ${JSON.stringify(actual[group].state)}`);
			}
		}
	};
	const coverageByEvent = new Map(eventCoverage.map((record) => [record.eventId, record]));
	for (const record of eventCoverage) {
		const where = `event-coverage ${record.eventId}`;
		if (!eventIds.has(record.eventId)) collector.add(where, "reports on an event that is not emitted");
		const eventGamesForRow = gamesByEventId.get(record.eventId) ?? [];
		if (record.games !== eventGamesForRow.length) {
			collector.add(where, `says ${record.games} games but ${eventGamesForRow.length} are emitted for it`);
		}
		const rowEras = [...new Set(eventGamesForRow.map((game) => game.era))].sort();
		if (JSON.stringify(record.eras) !== JSON.stringify(rowEras)) {
			collector.add(where, `names eras ${JSON.stringify(record.eras)} but its games are in ${JSON.stringify(rowEras)}`);
		}
		compareGroups(where, eventGamesForRow, record.coverage);
	}
	for (const event of events) {
		if (!coverageByEvent.has(event.id)) collector.add(`event-coverage ${event.id}`, "has no coverage row — every selected event is reported on");
	}
	const declaredEras = eras.groups["team-stats"];
	const coverageByEra = new Map(eraCoverage.map((record) => [record.era, record]));
	for (const era of declaredEras) {
		const record = coverageByEra.get(era.id);
		const where = `era-coverage ${era.id}`;
		if (record === undefined) {
			collector.add(where, "is declared in the era table but has no coverage row");
			continue;
		}
		const eraGames = games.filter((game) => game.era === era.id);
		if (record.from !== era.from) collector.add(where, `says the era starts ${record.from} but the era table says ${era.from}`);
		if (record.games !== eraGames.length) collector.add(where, `says ${record.games} games but ${eraGames.length} carry that era`);
		const contributors = new Set(eraGames.map((game) => game.eventId)).size;
		if (record.events !== contributors) collector.add(where, `says ${record.events} event(s) but ${contributors} contribute games`);
		compareGroups(where, eraGames, record.coverage);
	}
	for (const record of eraCoverage) {
		if (!declaredEras.some((era) => era.id === record.era)) {
			collector.add(`era-coverage ${record.era}`, "reports on an era the era table does not declare");
		}
	}
	const coverageTotal = eraCoverage.reduce((sum, record) => sum + record.games, 0);
	if (coverageTotal !== games.length) {
		collector.add("era-coverage", `accounts for ${coverageTotal} games but ${games.length} are emitted — every game belongs to exactly one era`);
	}
	const perEventTotal = eventCoverage.reduce((sum, record) => sum + record.games, 0);
	if (perEventTotal !== games.length) {
		collector.add("event-coverage", `accounts for ${perEventTotal} games but ${games.length} are emitted`);
	}

	// ---- the same source row cannot become two games -----------------------------
	const bySourceGame = new Map<string, string[]>();
	for (const game of games) {
		const list = bySourceGame.get(game.source.gameId) ?? [];
		list.push(game.id);
		bySourceGame.set(game.source.gameId, list);
	}
	for (const [sourceGameId, ids] of bySourceGame) {
		if (ids.length > 1) collector.add(`source game ${sourceGameId}`, `is emitted as ${ids.length} games (${ids.join(", ")})`);
	}

	return collector.violations;
}

/**
 * Throw unless the dataset satisfies every invariant, listing all violations.
 *
 * The gate is part of the build, not an opt-in flag (ticket 06, criterion 3): a
 * dataset that only passes when someone remembers to check it is a dataset that ships
 * broken.
 */
export function assertInvariants(input: InvariantInput): void {
	const violations = findInvariantViolations(input);
	if (violations.length === 0) return;
	throw new Error(
		`the dataset violates ${violations.length} invariant${violations.length === 1 ? "" : "s"}:\n  - ${violations.join("\n  - ")}`,
	);
}
