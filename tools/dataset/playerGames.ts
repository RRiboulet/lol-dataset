// playerGames: one row per player per game (spec R4, ticket 04), and the arithmetic
// check that ties those rows back to the team totals emitted in ticket 03.
//
// The source's `Role` is a label; `IngameRole` is the position actually played. When
// they disagree the row takes the played position, because a draft slot is not a
// player's role. Absent statistics stay absent: a null from the source is never 0,
// and a game is only required to reconcile when all of its player fields are stated.

import type { GameRecord } from "./games.ts";
import type { IdentityIndex } from "./identity.ts";
import { surrogateId } from "./identity.ts";
import type { SourcePlayerGame } from "./normalize.ts";
import { AmbiguousIdentity } from "./identity.ts";

export type PlayerGameRecord = {
	id: string;
	gameId: string;
	eventId: string;
	eventName: string;
	playerId: string;
	playerName: string;
	sourcePlayer: string;
	teamId: string;
	teamName: string;
	sourceTeam: string;
	championId: string;
	championName: string;
	sourceChampion: string;
	side: "blue" | "red";
	role: string;
	kills?: number;
	deaths?: number;
	assists?: number;
	cs?: number;
	gold?: number;
	damage?: number;
	vision?: number;
	items?: string[];
	trinket?: string;
	summonerSpells?: string[];
	keystone?: string;
	primaryTree?: string;
	secondaryTree?: string;
	runes?: string[];
	source: { gameId: string; playerLink: string };
};

export type PlayerGamesAssembly = {
	rows: PlayerGameRecord[];
	coverageByGame: Map<string, "complete" | "partial" | "unavailable">;
};

/** Fields that must be stated on every player before a game's stats count as complete. */
const REQUIRED = ["kills", "deaths", "assists", "cs", "gold", "damage", "vision", "items", "trinket", "summonerSpells", "keystone", "runes", "role"] as const;

function resolve(identity: IdentityIndex, kind: "player" | "team" | "champion", source: string, date: string, where: string) {
	if (source === "") throw new Error(`${where}: an empty ${kind} reference cannot be resolved`);
	let found;
	try {
		found = identity.resolve(kind, source, date);
	} catch (error) {
		if (error instanceof AmbiguousIdentity) throw new Error(`${where}: ${error.message}`);
		throw error;
	}
	if (found === null) throw new Error(`${where}: ${kind} ${JSON.stringify(source)} resolves to no entity`);
	return found;
}

/** Assemble the player rows and check their sums against the games that carry them. */
export function assemblePlayerGames(input: {
	source: SourcePlayerGame[];
	games: GameRecord[];
	identity: IdentityIndex;
}): PlayerGamesAssembly {
	const games = new Map(input.games.map((game) => [game.source.gameId, game]));
	const grouped = new Map<string, SourcePlayerGame[]>();
	for (const row of input.source) {
		const game = games.get(row.gameId);
		// A crawl carries games from events the rule rejected: their player rows are not
		// references in this dataset and must not become rows or mint identities.
		if (game === undefined) continue;
		const list = grouped.get(row.gameId) ?? [];
		list.push(row);
		grouped.set(row.gameId, list);
	}

	const rows: PlayerGameRecord[] = [];
	const coverageByGame = new Map<string, "complete" | "partial" | "unavailable">();
	for (const [sourceGameId, players] of grouped) {
		const game = games.get(sourceGameId);
		if (game === undefined) continue;
		const where = `${game.source.gameId}: player game`;
		const seen = new Set<string>();
		const sideTeams = game.sides.map((side) => side.teamId);
		for (const player of players) {
			const found = resolve(input.identity, "player", player.playerLink, player.date, `${where}: ${player.playerLink}`);
			if (seen.has(found.id)) throw new Error(`${where}: player ${player.playerLink} resolves to ${found.id}, which appears twice in this game`);
			seen.add(found.id);
			const team = resolve(input.identity, "team", player.team, player.date, `${where}: ${player.playerLink}: Team`);
			const sideIndex = sideTeams.indexOf(team.id);
			if (sideIndex === -1) throw new Error(`${where}: ${player.playerLink}'s team ${player.team} is not one of the game's sides`);
			const champion = resolve(input.identity, "champion", player.champion, player.date, `${where}: ${player.playerLink}: Champion`);
			if (player.role === "") throw new Error(`${where}: ${player.playerLink} has no played role`);
			rows.push({
				id: surrogateId("pg", `${sourceGameId}\u0000${player.playerLink}`),
				gameId: game.id,
				eventId: game.eventId,
				eventName: game.eventName,
				playerId: found.id,
				playerName: found.name,
				sourcePlayer: player.playerLink,
				teamId: team.id,
				teamName: team.name,
				sourceTeam: player.team,
				championId: champion.id,
				championName: champion.name,
				sourceChampion: player.champion,
				side: sideIndex === 0 ? "blue" : "red",
				role: player.role,
				...(player.kills === null ? {} : { kills: player.kills }),
				...(player.deaths === null ? {} : { deaths: player.deaths }),
				...(player.assists === null ? {} : { assists: player.assists }),
				...(player.cs === null ? {} : { cs: player.cs }),
				...(player.gold === null ? {} : { gold: player.gold }),
				...(player.damage === null ? {} : { damage: player.damage }),
				...(player.vision === null ? {} : { vision: player.vision }),
				...(player.items.length === 0 ? {} : { items: player.items }),
				...(player.trinket === null ? {} : { trinket: player.trinket }),
				...(player.summonerSpells.length === 0 ? {} : { summonerSpells: player.summonerSpells }),
				...(player.keystone === null ? {} : { keystone: player.keystone }),
				...(player.primaryTree === null ? {} : { primaryTree: player.primaryTree }),
				...(player.secondaryTree === null ? {} : { secondaryTree: player.secondaryTree }),
				...(player.runes.length === 0 ? {} : { runes: player.runes }),
				source: { gameId: sourceGameId, playerLink: player.playerLink },
			});
		}
		const complete = players.length === 10 && players.every((player) =>
			player.kills !== null && player.deaths !== null && player.assists !== null && player.cs !== null &&
			player.gold !== null && player.damage !== null && player.vision !== null && player.trinket !== null &&
			player.keystone !== null && player.items.length > 0 && player.summonerSpells.length > 0 &&
			player.runes.length > 0 && player.role !== "",
		);
		coverageByGame.set(game.id, complete ? "complete" : "partial");
		if (!complete) continue;
		// The check this ticket exists for: only a game whose player fields are all
		// stated is required to reconcile with the team totals.
		for (const side of game.sides) {
			const sideRows = rows.filter((row) => row.gameId === game.id && row.teamId === side.teamId);
			const kills = sideRows.reduce((sum, row) => sum + (row.kills ?? 0), 0);
			const gold = sideRows.reduce((sum, row) => sum + (row.gold ?? 0), 0);
			if (kills !== side.kills || gold !== side.gold) {
				throw new Error(
					`${where}: ${side.teamName} (${side.teamId}) players sum to ${kills} kills and ${gold} gold, ` +
						`but the game states ${side.kills} and ${side.gold} — the two grains disagree`,
				);
			}
		}
	}
	for (const game of input.games) {
		if (!coverageByGame.has(game.id)) coverageByGame.set(game.id, "unavailable");
	}
	rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return { rows, coverageByGame };
}
