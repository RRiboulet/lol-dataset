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
import type { Coverage, EraTable } from "./eras.ts";
import type { EventGamesRecord, GameRecord, MatchRecord } from "./games.ts";
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
	playerGames: PlayerGameRecord[];
	eras: EraTable;
};

/** The enum the coverage markers use, so a typo cannot pass as a state. */
const COVERAGE: readonly Coverage[] = ["complete", "partial", "unavailable"];

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
	const { events, selection, identity, games, matches, eventGames, playerGames, eras } = input;

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
	}
	for (const row of identity.unresolved) {
		if (row.id !== null && !entityIds.has(row.id)) collector.add(`unresolved ${JSON.stringify(row.string)}`, `points at ${row.id}, which is not an entity`);
	}

	// ---- events and the selection report ----------------------------------------
	const eventIds = new Set(events.map((event) => event.id));
	collector.unique("event", events);
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

	// ---- games, matches and their cross-references -------------------------------
	const gameIds = new Set(games.map((game) => game.id));
	const matchIds = new Set(matches.map((match) => match.id));
	collector.unique("game", games);
	collector.unique("match", matches);
	const eligible = eligibleByEra(eras);

	for (const game of games) {
		const where = `game ${game.id}`;
		if (!eventIds.has(game.eventId)) collector.add(where, `references event ${game.eventId}, which is not emitted`);
		if (game.matchId !== undefined && !matchIds.has(game.matchId)) collector.add(where, `references match ${game.matchId}, which is not emitted`);
		const [blue, red] = game.sides;
		if (blue.teamId === red.teamId) collector.add(where, `both sides are ${blue.teamId} — a game cannot be a team against itself`);
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
				const stated = Object.keys(side).filter((key) => !["side", "teamId", "teamName", "sourceTeam"].includes(key));
				if (stated.length > 0) collector.add(where, `claims team statistics are unavailable but ${side.side} carries ${stated.join(", ")}`);
			}
		}
		// Draft claims.
		if (game.draft !== undefined) {
			const seen = new Set<string>();
			for (const side of game.draft.sides) {
				for (const entry of [...side.picks, ...side.bans]) {
					if (!championIds.has(entry.championId)) collector.add(where, `draft references champion ${entry.championId}, which is not emitted`);
					if (seen.has(entry.championId)) collector.add(where, `draft drafts ${entry.championId} twice — one champion plays once per game`);
					seen.add(entry.championId);
				}
			}
			if (game.coverage.draft === "complete") {
				for (const side of game.draft.sides) {
					if (side.picks.length !== 5) collector.add(where, `claims complete draft but ${side.side} has ${side.picks.length} picks`);
					if (side.bans.length !== 5) collector.add(where, `claims complete draft but ${side.side} has ${side.bans.length} bans`);
				}
			}
		} else if (game.coverage.draft !== "unavailable") {
			collector.add(where, `claims draft ${game.coverage.draft} but carries no draft`);
		}
	}

	for (const match of matches) {
		const where = `match ${match.id}`;
		if (!eventIds.has(match.eventId)) collector.add(where, `references event ${match.eventId}, which is not emitted`);
		const [first, second] = match.sides;
		if (first.teamId === second.teamId) collector.add(where, `both sides are ${first.teamId} — a series cannot be a team against itself`);
		for (const side of match.sides) {
			if (!teamIds.has(side.teamId)) collector.add(where, `side ${side.sourceOrder} references team ${side.teamId}, which is not emitted`);
			if (side.seriesScore !== undefined && side.seriesScore < 0) collector.add(where, `seriesScore is ${side.seriesScore} — a score cannot be negative`);
		}
		if (match.winnerTeamId !== undefined && !match.sides.some((side) => side.teamId === match.winnerTeamId)) {
			collector.add(where, `names winner ${match.winnerTeamId}, which is not one of its sides`);
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
	for (const record of eventGames) {
		const where = `event-games ${record.eventId}`;
		if (record.games !== (gamesPerEvent.get(record.eventId) ?? 0)) {
			collector.add(where, `says ${record.games} games but ${gamesPerEvent.get(record.eventId) ?? 0} are emitted`);
		}
		if (record.matches !== (matchesPerEvent.get(record.eventId) ?? 0)) {
			collector.add(where, `says ${record.matches} matches but ${matchesPerEvent.get(record.eventId) ?? 0} are emitted`);
		}
		if (record.state === "recorded" && record.games === 0 && record.matches === 0) {
			collector.add(where, "says recorded but carries neither a game nor a match");
		}
		if (record.state === "empty" && (record.games > 0 || record.matches > 0)) {
			collector.add(where, "says empty but carries rows");
		}
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
