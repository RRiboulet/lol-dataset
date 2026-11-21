// model: the star schema on top of the curated records (spec R13, D10, D2).
//
//   loadModelInput(curated/) -> validateModelInput -> dimensions -> facts -> conformance -> CSV + DDL + dictionary
//
// The curated layer is the evidence; this layer is the analysis surface. It never
// writes back: the CSVs under `data/model/` are derived from `data/curated/` and are
// rebuilt from scratch on every run. Everything here is a pure function of the
// records on disk — no network, no clock, no ambient state — which is what makes the
// output byte-identical across runs instead of merely similar.
//
// Map of the model:
//
//   dimensions   event, match, game, team, player, champion, patch, date
//   facts        game x side, game x player, draft slot
//   bridge       alias -> one dimension row, with the window the source used it
//
// The `dim_game` dimension carries the game's coverage declarations. Without it the
// only place to put "this era has no player statistics" would be a fact row that does
// not exist for that game, which is precisely how a thin era gets averaged away.
//
// Keys and formatting are decisions, not defaults:
//
//   - Every dimension has an unknown member at key 0, with an empty natural key and
//     the display name `Unknown`. A fact joins to it when the curated record has no
//     value; it never carries an empty join key.
//   - Surrogate keys are 1..N assigned in ascending natural-key order within a build.
//     They are build-local: the natural key is the durable identifier, and every fact
//     is derived in the same run, so renumbering cannot leave a dangling reference.
//     This is chosen over hash-derived integers because this model is a CSV a person
//     opens first, and a 15-digit hash in every fact column is not readable.
//   - Facts carry only grain keys, foreign keys, source-stated attributes (side, role,
//     phase, slot), and measures. No rate, ratio, average or percentage is computed.
//   - CSV is RFC 4180 field quoting and escaping with LF record terminators, UTF-8
//     without a BOM, a header row, fixed column order, ISO-8601 dates/instants, plain
//     integers, and an empty field wherever a value was not recorded. LF rather than
//     RFC 4180's CRLF is deliberate: `.gitattributes` normalizes this repository to
//     LF, so CRLF would be a committed file that differs from the bytes the build
//     wrote. SQLite, DuckDB, Python and spreadsheets accept LF.
//
// The DDL and the data dictionary are generated from the same column metadata as the
// CSVs, so a column cannot exist in one and be missing from another.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { EventRecord } from "./assemble.ts";
import type { CoverageGroups, EraCoverageRecord, EventCoverageRecord } from "./coverage.ts";
import { COVERAGE_GROUPS, summariseGroup } from "./coverage.ts";
import type { Coverage } from "./eras.ts";
import type { GameRecord, MatchRecord } from "./games.ts";
import type { AliasRecord, ChampionRecord, EntityKind, PlayerRecord, TeamRecord } from "./identity.ts";
import type { PlayerGameRecord } from "./playerGames.ts";

export const DEFAULT_CURATED_DIR = path.join(import.meta.dirname, "..", "..", "data", "curated");
export const DEFAULT_MODEL_DIR = path.join(import.meta.dirname, "..", "..", "data", "model");

const SCHEMA_FILE = "schema.sql";
const DICTIONARY_FILE = "data-dictionary.md";

/** The tables in the order the DDL, the dictionary and the writer present them. */
export const MODEL_TABLE_ORDER = [
	"dim_event",
	"dim_match",
	"dim_game",
	"dim_team",
	"dim_player",
	"dim_champion",
	"dim_patch",
	"dim_date",
	"bridge_alias",
	"fact_game_side",
	"fact_player_game",
	"fact_draft_slot",
] as const;

export type ModelTableName = (typeof MODEL_TABLE_ORDER)[number];

export type ModelInput = {
	events: EventRecord[];
	matches: MatchRecord[];
	teams: TeamRecord[];
	players: PlayerRecord[];
	champions: ChampionRecord[];
	aliases: AliasRecord[];
	games: GameRecord[];
	playerGames: PlayerGameRecord[];
};

export type ModelColumn = {
	name: string;
	type: "INTEGER" | "TEXT";
	/** What the column is in the model, for the DDL's readers and the dictionary. */
	key?: "surrogate" | "natural" | "foreign" | "grain" | "measure" | "attribute";
	/** For a foreign key: `table.column`, so resolution is declarative rather than guessed. */
	references?: string;
	description: string;
	/** What an empty field means; omitted for a column that is always stated. */
	absent?: string;
};

export type ModelRow = Record<string, string | number>;

export type ModelTable = {
	name: ModelTableName;
	file: string;
	kind: "dimension" | "fact" | "bridge";
	description: string;
	/** The declared grain, in prose, repeated in the dictionary. */
	grain: string;
	naturalKey?: string;
	displayKey?: string;
	surrogateKey?: string;
	columns: ModelColumn[];
	/** The columns whose combination identifies one row (facts and the bridge). */
	grainColumns: string[];
	rows: ModelRow[];
};

export type ModelBuild = {
	tables: ModelTable[];
	/** The bytes to write, keyed by file name, including the DDL and dictionary. */
	files: Record<string, string>;
};

const ENTITY_KIND: readonly EntityKind[] = ["team", "player", "champion"];
const EVIDENCE_ORDER = ["registry", "rename", "redirect", "handle", "observed", "declared"] as const;
const KIND_TABLE = { team: "dim_team", player: "dim_player", champion: "dim_champion" } as const;

// ---- metadata helpers -------------------------------------------------------

function surrogate(name = "key"): ModelColumn {
	return { name, type: "INTEGER", key: "surrogate", description: "Build-local surrogate key. 0 is the unknown member; values are assigned 1..N in natural-key order." };
}

function natural(name: string, description: string): ModelColumn {
	return { name, type: "TEXT", key: "natural", description };
}

function attribute(name: string, type: "INTEGER" | "TEXT", description: string, absent?: string): ModelColumn {
	return { name, type, key: "attribute", description, ...(absent === undefined ? {} : { absent }) };
}

function foreign(name: string, references: string, description: string, absent?: string): ModelColumn {
	return { name, type: "INTEGER", key: "foreign", references, description, ...(absent === undefined ? {} : { absent }) };
}

function measure(name: string, description: string, absent = "empty when the source did not record it; 0 is a real zero"): ModelColumn {
	return { name, type: "INTEGER", key: "measure", description, absent };
}

function textMeasure(name: string, description: string, absent = "empty when the source did not record it"): ModelColumn {
	return { name, type: "TEXT", key: "measure", description, absent };
}

function unknownRow(
	columns: ModelColumn[],
	surrogateKey: string,
	displayKey: string,
	overrides: Record<string, string | number> = {},
): ModelRow {
	const row: ModelRow = {};
	for (const column of columns) {
		if (column.name === surrogateKey) row[column.name] = 0;
		else if (column.name === displayKey) row[column.name] = "Unknown";
		else if (column.name in overrides) row[column.name] = overrides[column.name];
		else row[column.name] = "";
	}
	return row;
}

function normaliseRow(columns: ModelColumn[], row: ModelRow): ModelRow {
	const out: ModelRow = {};
	for (const column of columns) out[column.name] = row[column.name] ?? "";
	return out;
}

/** Code-unit order, not locale order: `sort()` must not depend on the machine's locale. */
export function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function compareValues(a: string | number | undefined, b: string | number | undefined): number {
	const left = a ?? "";
	const right = b ?? "";
	if (typeof left === "number" && typeof right === "number") return left - right;
	return compareText(String(left), String(right));
}

function compareBy(values: (row: ModelRow) => (string | number | undefined)[]): (a: ModelRow, b: ModelRow) => number {
	return (a, b) => {
		const left = values(a);
		const right = values(b);
		for (let index = 0; index < Math.max(left.length, right.length); index++) {
			const difference = compareValues(left[index], right[index]);
			if (difference !== 0) return difference;
		}
		return 0;
	};
}

function sortedRows(rows: ModelRow[], columns: string[]): ModelRow[] {
	return [...rows].sort(compareBy((row) => columns.map((column) => row[column])));
}

/**
 * A dimension: unknown member at 0, then one row per natural key, keyed 1..N.
 *
 * The key map is returned because facts are built from it; it is also the only place
 * a missing natural key can be noticed, so a duplicate stops the build here rather
 * than becoming two rows that look like one.
 */
function buildDimension<T>(spec: {
	name: ModelTableName;
	description: string;
	grain: string;
	naturalKey: string;
	displayKey: string;
	surrogateKey: string;
	columns: ModelColumn[];
	/** Overrides for the unknown member's cells; a foreign key must resolve, never be empty. */
	unknown?: Record<string, string | number>;
	items: T[];
	natural: (item: T) => string;
	row: (item: T, key: number) => ModelRow;
}): { table: ModelTable; keys: Map<string, number> } {
	const seen = new Set<string>();
	const ordered = [...spec.items].sort((a, b) => compareText(spec.natural(a), spec.natural(b)));
	ordered.forEach((item) => {
		const value = spec.natural(item);
		if (value === "") throw new Error(`${spec.name}: an empty natural key is the unknown member's job`);
		if (seen.has(value)) throw new Error(`${spec.name}: natural key ${JSON.stringify(value)} appears twice`);
		seen.add(value);
	});
	const keys = new Map<string, number>();
	ordered.forEach((item, index) => keys.set(spec.natural(item), index + 1));
	const rows = [
		unknownRow(spec.columns, spec.surrogateKey, spec.displayKey, spec.unknown),
		...ordered.map((item, index) => normaliseRow(spec.columns, spec.row(item, index + 1))),
	];
	return {
		keys,
		table: {
			name: spec.name,
			file: `${spec.name}.csv`,
			kind: "dimension",
			description: spec.description,
			grain: spec.grain,
			naturalKey: spec.naturalKey,
			displayKey: spec.displayKey,
			surrogateKey: spec.surrogateKey,
			columns: spec.columns,
			grainColumns: [spec.naturalKey],
			rows,
		},
	};
}

function buildFact(spec: {
	name: ModelTableName;
	description: string;
	grain: string;
	columns: ModelColumn[];
	rows: ModelRow[];
	grainColumns: string[];
	orderColumns?: string[];
}): ModelTable {
	return {
		name: spec.name,
		file: `${spec.name}.csv`,
		kind: "fact",
		description: spec.description,
		grain: spec.grain,
		columns: spec.columns,
		grainColumns: spec.grainColumns,
		rows: sortedRows(spec.rows.map((row) => normaliseRow(spec.columns, row)), spec.orderColumns ?? spec.grainColumns),
	};
}

function requiredKey(keys: Map<string, number>, value: string | undefined, what: string): number {
	if (value === undefined) throw new Error(`${what}: no value to resolve`);
	const key = keys.get(value);
	if (key === undefined) throw new Error(`${what}: ${JSON.stringify(value)} has no dimension row`);
	return key;
}

/** A key that may legitimately be absent; absence is the unknown member, never a blank. */
function optionalKey(keys: Map<string, number>, value: string | undefined, what: string): number {
	if (value === undefined) return 0;
	return requiredKey(keys, value, what);
}

function measureValue(value: number | undefined): string | number {
	return value === undefined ? "" : value;
}

// ---- input ------------------------------------------------------------------

async function readJsonl<T>(file: string): Promise<T[]> {
	const text = await readFile(file, "utf8");
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line, index) => {
			try {
				return JSON.parse(line) as T;
			} catch (error) {
				throw new Error(`${file}:${index + 1}: not JSON (${(error as Error).message})`);
			}
		});
}

/** Read the curated layer exactly as the build emitted it. No schema is re-applied here. */
export async function loadModelInput(curatedDir: string = DEFAULT_CURATED_DIR): Promise<ModelInput> {
	const read = <T>(file: string) => readJsonl<T>(path.join(curatedDir, file));
	return {
		events: await read<EventRecord>("events.jsonl"),
		matches: await read<MatchRecord>("matches.jsonl"),
		teams: await read<TeamRecord>("teams.jsonl"),
		players: await read<PlayerRecord>("players.jsonl"),
		champions: await read<ChampionRecord>("champions.jsonl"),
		aliases: await read<AliasRecord>("aliases.jsonl"),
		games: await read<GameRecord>("games.jsonl"),
		playerGames: await read<PlayerGameRecord>("player-games.jsonl"),
	};
}

/**
 * The curated fields the model relies on, checked at the seam rather than assumed.
 *
 * The invariant gate polices the build's own output, but the model reads the files
 * from disk, where a hand edit or a bad merge can put a row the gate never saw. This
 * fails early, naming the record, instead of letting the contradiction survive into
 * the facts.
 */
export function validateModelInput(input: ModelInput): void {
	const requireIds = (records: { id: string }[], file: string) => {
		for (const record of records) {
			if (record.id === "") throw new Error(`curated ${file}: a record has an empty id`);
		}
	};
	requireIds(input.events, "events.jsonl");
	requireIds(input.matches, "matches.jsonl");
	requireIds(input.teams, "teams.jsonl");
	requireIds(input.players, "players.jsonl");
	requireIds(input.champions, "champions.jsonl");

	for (const match of input.matches) {
		if (match.eventId === "") throw new Error(`curated matches.jsonl: match ${match.id} has an empty eventId`);
	}
	for (const alias of input.aliases) {
		if (alias.entityId === "") throw new Error(`curated aliases.jsonl: alias ${JSON.stringify(alias.string)} has an empty entityId`);
	}

	const gamesById = new Map<string, GameRecord>();
	for (const game of input.games) {
		if (game.id === "") throw new Error("curated games.jsonl: a game has an empty id");
		if (game.eventId === "") throw new Error(`curated games.jsonl: game ${game.id} has an empty eventId`);
		if (game.sides.length !== 2) throw new Error(`curated games.jsonl: game ${game.id} has ${game.sides.length} sides, expected 2`);
		for (const side of game.sides) {
			if (side.teamId === "") throw new Error(`curated games.jsonl: game ${game.id} has a side with an empty teamId`);
		}
		if (game.winnerTeamId !== undefined && !game.sides.some((side) => side.teamId === game.winnerTeamId)) {
			throw new Error(
				`curated games.jsonl: game ${game.id} records winner ${JSON.stringify(game.winnerTeamId)}, which is neither side ` +
					`(${game.sides.map((side) => side.teamId).join(", ")})`,
			);
		}
		gamesById.set(game.id, game);
	}

	for (const row of input.playerGames) {
		if (row.gameId === "") throw new Error("curated player-games.jsonl: a row has an empty gameId");
		if (row.eventId === "") throw new Error(`curated player-games.jsonl: the row for game ${row.gameId} has an empty eventId`);
		const game = gamesById.get(row.gameId);
		if (game === undefined) {
			throw new Error(`curated player-games.jsonl: the row for player ${row.playerId} references game ${row.gameId}, which the corpus does not carry`);
		}
		if (row.eventId !== game.eventId) {
			throw new Error(
				`curated player-games.jsonl: the row for game ${row.gameId} claims event ${row.eventId}, but the game belongs to ${game.eventId}`,
			);
		}
		if (row.playerId === "" || row.teamId === "" || row.championId === "") {
			throw new Error(`curated player-games.jsonl: the row for game ${row.gameId} has an empty player, team or champion reference`);
		}
	}
}

// ---- dimensions -------------------------------------------------------------

function buildDimensions(input: ModelInput) {
	const event = buildDimension<EventRecord>({
		name: "dim_event",
		description: "One row per admitted international event.",
		grain: "one row per event",
		naturalKey: "event_id",
		displayKey: "event_name",
		surrogateKey: "event_key",
		columns: [
			surrogate("event_key"),
			natural("event_id", "The curated event's canonical ID (`evt-…`)."),
			attribute("event_name", "TEXT", "The event's display name, so a fact reads without decoding a key."),
			attribute("overview_page", "TEXT", "The source page the event was recorded from."),
			attribute("league", "TEXT", "The source's league string, verbatim; empty when the source records none."),
			attribute("region", "TEXT", "The source's region string, verbatim."),
			attribute("date_start", "TEXT", "The event's start date, ISO-8601 (`YYYY-MM-DD`)."),
			attribute("year", "INTEGER", "UTC calendar year of `date_start`, repeated for grouping."),
		],
		items: input.events,
		natural: (record) => record.id,
		row: (record, key) => ({
			event_key: key,
			event_id: record.id,
			event_name: record.name,
			overview_page: record.overviewPage,
			league: record.league,
			region: record.region,
			date_start: record.dateStart,
			year: record.year,
		}),
	});

	const match = buildDimension<MatchRecord>({
		name: "dim_match",
		description: "One row per series the corpus carries.",
		grain: "one row per series (match)",
		naturalKey: "match_id",
		displayKey: "match_name",
		surrogateKey: "match_key",
		unknown: { event_key: 0 },
		columns: [
			surrogate("match_key"),
			natural("match_id", "The curated match's canonical ID (`mt-…`)."),
			foreign("event_key", "dim_event.event_key", "The event the series belongs to, so a series is sliceable by event without joining through its games."),
			attribute("match_name", "TEXT", "A readable series label: event, round label and date."),
			attribute("date_time_utc", "TEXT", "The series' start instant, ISO-8601 UTC."),
			attribute("best_of", "INTEGER", "The series length the source declares.", "empty when the source states none"),
			attribute("tab", "TEXT", "The source's round label.", "empty when the source has none"),
			attribute("is_nullified", "INTEGER", "1 when the source marks the series nullified, else 0."),
			attribute("forfeit", "INTEGER", "1 when the source records a forfeit; empty when it records none.", "empty when the source records none"),
		],
		items: input.matches,
		natural: (record) => record.id,
		row: (record, key) => ({
			match_key: key,
			match_id: record.id,
			event_key: requiredKey(event.keys, record.eventId, "dim_match"),
			match_name: [record.eventName, record.tab, record.dateTimeUtc.slice(0, 10)].filter((part) => part).join(" — "),
			date_time_utc: record.dateTimeUtc,
			best_of: record.bestOf,
			tab: record.tab,
			is_nullified: record.isNullified ? 1 : 0,
			forfeit: record.forfeit === undefined ? "" : record.forfeit ? 1 : 0,
		}),
	});

	const game = buildDimension<GameRecord>({
		name: "dim_game",
		description: "One row per game: its identity, era and coverage declarations.",
		grain: "one row per game",
		naturalKey: "game_id",
		displayKey: "game_name",
		surrogateKey: "game_key",
		columns: [
			surrogate("game_key"),
			natural("game_id", "The curated game's canonical ID (`gm-…`)."),
			attribute("game_name", "TEXT", "A readable game label: event, the two teams and the date."),
			attribute("date_time_utc", "TEXT", "The game's start instant, ISO-8601 UTC."),
			attribute("era", "TEXT", "The era id whose field set judged this game's coverage."),
			attribute("team_stats_coverage", "TEXT", "The curated `coverage.teamStats` marker: complete, partial or unavailable."),
			attribute("draft_coverage", "TEXT", "The curated `coverage.draft` marker."),
			attribute("player_stats_coverage", "TEXT", "The curated `coverage.playerStats` marker."),
			attribute("draft_fidelity", "TEXT", "`ordered`, `unordered`, or empty when the corpus carries no draft."),
			attribute("draft_switched_sides", "INTEGER", "The source's switched-sides flag on an ordered draft; empty when it states none."),
		],
		items: input.games,
		natural: (record) => record.id,
		row: (record, key) => ({
			game_key: key,
			game_id: record.id,
			game_name: [record.eventName, `${record.sides[0].teamName} vs ${record.sides[1].teamName}`, record.dateTimeUtc.slice(0, 10)].join(" — "),
			date_time_utc: record.dateTimeUtc,
			era: record.era,
			team_stats_coverage: record.coverage.teamStats,
			draft_coverage: record.coverage.draft,
			player_stats_coverage: record.coverage.playerStats,
			draft_fidelity: record.draft?.fidelity ?? "",
			draft_switched_sides: record.draft?.switchedSides === undefined ? "" : record.draft.switchedSides ? 1 : 0,
		}),
	});

	const team = buildDimension<TeamRecord>({
		name: "dim_team",
		description: "One row per canonical team; renames live in the alias bridge, not here.",
		grain: "one row per team",
		naturalKey: "team_id",
		displayKey: "team_name",
		surrogateKey: "team_key",
		columns: [
			surrogate("team_key"),
			natural("team_id", "The curated team's canonical ID (`tm-…`)."),
			attribute("team_name", "TEXT", "The team's current display name."),
			attribute(
				"short",
				"TEXT",
				"The team's short name as the source's registry states it for the team's current page (`Karmine Corp` -> `KC`). A label, not a key: two teams can share one, so never join on it.",
				"empty when the source states no short name for the team's current page — always the case for a minted team; a rename does not carry an older name's short forward",
			),
			attribute("overview_page", "TEXT", "The team's current wiki page.", "empty only for an entity minted from a string no registry carries"),
			attribute("region", "TEXT", "The source's region string, verbatim; empty when it records none."),
		],
		items: input.teams,
		natural: (record) => record.id,
		row: (record, key) => ({
			team_key: key,
			team_id: record.id,
			team_name: record.name,
			short: record.short ?? "",
			overview_page: record.overviewPage ?? "",
			region: record.region,
		}),
	});

	const player = buildDimension<PlayerRecord>({
		name: "dim_player",
		description: "One row per canonical player; handles and old pages live in the alias bridge.",
		grain: "one row per player",
		naturalKey: "player_id",
		displayKey: "player_name",
		surrogateKey: "player_key",
		columns: [
			surrogate("player_key"),
			natural("player_id", "The curated player's canonical ID (`pl-…`)."),
			attribute("player_name", "TEXT", "The player's current handle."),
			attribute("overview_page", "TEXT", "The player's wiki page.", "empty only for an entity minted from a string no registry carries"),
		],
		items: input.players,
		natural: (record) => record.id,
		row: (record, key) => ({
			player_key: key,
			player_id: record.id,
			player_name: record.name,
			overview_page: record.overviewPage ?? "",
		}),
	});

	const champion = buildDimension<ChampionRecord>({
		name: "dim_champion",
		description: "One row per canonical champion; retired display names live in the alias bridge.",
		grain: "one row per champion",
		naturalKey: "champion_id",
		displayKey: "champion_name",
		surrogateKey: "champion_key",
		columns: [
			surrogate("champion_key"),
			natural("champion_id", "The curated champion's canonical ID (`ch-…`)."),
			attribute("champion_name", "TEXT", "The champion's current display name."),
			attribute("riot_key", "INTEGER", "Riot's numeric champion id.", "empty only for a champion minted from a name no registry carries"),
		],
		items: input.champions,
		natural: (record) => record.id,
		row: (record, key) => ({
			champion_key: key,
			champion_id: record.id,
			champion_name: record.name,
			riot_key: record.riotKey ?? "",
		}),
	});

	const patches = [...new Set(input.games.map((record) => record.patch).filter((patch): patch is string => patch !== undefined))];
	const patch = buildDimension<string>({
		name: "dim_patch",
		description: "One row per patch string the source states, shared across games.",
		grain: "one row per patch",
		naturalKey: "patch",
		displayKey: "patch_name",
		surrogateKey: "patch_key",
		columns: [
			surrogate("patch_key"),
			natural("patch", "The patch as the source states it, as text; never padded or inferred."),
			attribute("patch_name", "TEXT", "A readable label for the patch."),
		],
		items: patches,
		natural: (record) => record,
		row: (record, key) => ({ patch_key: key, patch: record, patch_name: `Patch ${record}` }),
	});

	const dates = [...new Set(input.games.map((record) => record.dateTimeUtc.slice(0, 10)))];
	const date = buildDimension<string>({
		name: "dim_date",
		description: "One row per UTC calendar date on which a modelled game was played.",
		grain: "one row per UTC calendar date",
		naturalKey: "date",
		displayKey: "date_name",
		surrogateKey: "date_key",
		columns: [
			surrogate("date_key"),
			natural("date", "The calendar date, ISO-8601 (`YYYY-MM-DD`)."),
			attribute("date_name", "TEXT", "The same ISO date, so a fact reads without decoding the key."),
			attribute("year", "INTEGER", "UTC calendar year."),
			attribute("month", "INTEGER", "Calendar month, 1–12."),
			attribute("day", "INTEGER", "Day of month, 1–31."),
		],
		items: dates,
		natural: (record) => record,
		row: (record, key) => ({
			date_key: key,
			date: record,
			date_name: record,
			year: Number(record.slice(0, 4)),
			month: Number(record.slice(5, 7)),
			day: Number(record.slice(8, 10)),
		}),
	});

	return { event, match, game, team, player, champion, patch, date };
}

// ---- alias bridge -----------------------------------------------------------

function buildAliasBridge(input: ModelInput, dimensions: ReturnType<typeof buildDimensions>): ModelTable {
	const entityKeys = { team: dimensions.team.keys, player: dimensions.player.keys, champion: dimensions.champion.keys };
	const aliases = [...input.aliases].sort((a, b) => {
		const kind = compareText(a.kind, b.kind);
		if (kind !== 0) return kind;
		const left = entityKeys[a.kind].get(a.entityId) ?? 0;
		const right = entityKeys[b.kind].get(b.entityId) ?? 0;
		if (left !== right) return left - right;
		return compareText(a.string, b.string);
	});

	const columns: ModelColumn[] = [
		{ name: "alias_key", type: "INTEGER", key: "surrogate", description: "Bridge row key, 1..N in the bridge's sort order." },
		{ name: "kind", type: "TEXT", key: "attribute", description: "Which dimension `entity_key` points into: team, player or champion." },
		{ name: "alias_string", type: "TEXT", key: "grain", description: "The source string, verbatim." },
		{ name: "entity_key", type: "INTEGER", key: "grain", description: "The dimension row the string denotes; the target table depends on `kind`." },
		{ name: "entity_id", type: "TEXT", key: "attribute", description: "The entity's natural key, repeated so the bridge reads without a join." },
		{ name: "entity_name", type: "TEXT", key: "attribute", description: "The entity's current display name." },
		{ name: "valid_from", type: "TEXT", key: "attribute", description: "First date the corpus or a declared alias is known to have used this string.", absent: "empty when the corpus does not date it, not when it was never used" },
		{ name: "valid_to", type: "TEXT", key: "attribute", description: "Last date the string is known to have been used.", absent: "empty when the corpus does not date it" },
		{ name: "evidence", type: "TEXT", key: "attribute", description: "Why the mapping is believed, as semicolon-separated evidence values in canonical order." },
	];

	const rows = aliases.map((alias, index): ModelRow => {
		if (!ENTITY_KIND.includes(alias.kind)) throw new Error(`alias ${JSON.stringify(alias.string)} has unknown kind ${alias.kind}`);
		const entityKey = entityKeys[alias.kind].get(alias.entityId);
		if (entityKey === undefined) throw new Error(`alias ${JSON.stringify(alias.string)} points at ${alias.entityId}, which has no dimension row`);
		const evidence = [...new Set(alias.evidence)].sort((a, b) => EVIDENCE_ORDER.indexOf(a) - EVIDENCE_ORDER.indexOf(b));
		return normaliseRow(columns, {
			alias_key: index + 1,
			kind: alias.kind,
			alias_string: alias.string,
			entity_key: entityKey,
			entity_id: alias.entityId,
			entity_name: alias.entityName,
			valid_from: alias.firstSeen ?? "",
			valid_to: alias.lastSeen ?? "",
			evidence: evidence.join(";"),
		});
	});

	return {
		name: "bridge_alias",
		file: "bridge_alias.csv",
		kind: "bridge",
		description: "Alias bridge: one row per source string and entity, with the window it applied to.",
		grain: "one row per (kind, alias_string, entity_key)",
		naturalKey: undefined,
		displayKey: "alias_string",
		surrogateKey: "alias_key",
		columns,
		grainColumns: ["kind", "alias_string", "entity_key"],
		rows,
	};
}

// ---- facts ------------------------------------------------------------------

const TEAM_MEASURES: readonly [column: string, field: keyof GameRecord["sides"][number]][] = [
	["kills", "kills"],
	["gold", "gold"],
	["towers", "towers"],
	["inhibitors", "inhibitors"],
	["barons", "barons"],
	["dragons", "dragons"],
	["dragons_clouds", "dragonsClouds"],
	["dragons_infernals", "dragonsInfernals"],
	["dragons_mountains", "dragonsMountains"],
	["dragons_oceans", "dragonsOceans"],
	["dragons_hextechs", "dragonsHextechs"],
	["dragons_chemtechs", "dragonsChemtechs"],
	["dragons_elders", "dragonsElders"],
	["rift_heralds", "riftHeralds"],
	["void_grubs", "voidGrubs"],
	["atakhans", "atakhans"],
];

const PLAYER_MEASURES: readonly [column: string, field: keyof PlayerGameRecord][] = [
	["kills", "kills"],
	["deaths", "deaths"],
	["assists", "assists"],
	["cs", "cs"],
	["gold", "gold"],
	["damage", "damage"],
	["vision", "vision"],
];

function commonFactColumns(): ModelColumn[] {
	return [
		foreign("game_key", "dim_game.game_key", "The game this row belongs to."),
		foreign("event_key", "dim_event.event_key", "The event the game belongs to, so facts slice by event without a join through dim_game."),
		foreign("match_key", "dim_match.match_key", "The series the game belongs to; 0 when the corpus carries no series row.", "0 (the unknown member) when the game has no series"),
		foreign("date_key", "dim_date.date_key", "The UTC date the game was played."),
		foreign("patch_key", "dim_patch.patch_key", "The patch the source states for the game; 0 when it states none.", "0 (the unknown member) when the source states no patch"),
	];
}

function factGameSide(input: ModelInput, dimensions: ReturnType<typeof buildDimensions>): ModelTable {
	const columns: ModelColumn[] = [
		...commonFactColumns(),
		foreign("team_key", "dim_team.team_key", "The team on this side of the game."),
		attribute("side", "TEXT", "The source's side for this game: `blue` is Team1 and `red` is Team2."),
		attribute("is_winner", "INTEGER", "1 when this side won the game, 0 when it lost; empty when the source records no winner.", "empty when the source records no winner"),
		measure("duration_seconds", "Game length in whole seconds, a game-level measure repeated on both side rows.", "empty when the source states no duration"),
		...TEAM_MEASURES.map(([name, field]) => measure(name, `The source's ${field} figure for this side.`)),
	];

	const rows: ModelRow[] = [];
	for (const game of input.games) {
		for (const side of game.sides) {
			const row: ModelRow = {
				game_key: requiredKey(dimensions.game.keys, game.id, "fact_game_side"),
				event_key: requiredKey(dimensions.event.keys, game.eventId, "fact_game_side"),
				match_key: optionalKey(dimensions.match.keys, game.matchId, "fact_game_side"),
				date_key: requiredKey(dimensions.date.keys, game.dateTimeUtc.slice(0, 10), "fact_game_side"),
				patch_key: optionalKey(dimensions.patch.keys, game.patch, "fact_game_side"),
				team_key: requiredKey(dimensions.team.keys, side.teamId, "fact_game_side"),
				side: side.side,
				is_winner: game.winnerTeamId === undefined ? "" : side.teamId === game.winnerTeamId ? 1 : 0,
				duration_seconds: measureValue(game.durationSeconds),
			};
			for (const [column, field] of TEAM_MEASURES) row[column] = measureValue(side[field] as number | undefined);
			rows.push(row);
		}
	}

	return buildFact({
		name: "fact_game_side",
		description: "Team statistics at one row per game per side.",
		grain: "one row per game per side",
		columns,
		rows,
		grainColumns: ["game_key", "side"],
	});
}

function factPlayerGame(input: ModelInput, dimensions: ReturnType<typeof buildDimensions>): ModelTable {
	const columns: ModelColumn[] = [
		...commonFactColumns(),
		foreign("player_key", "dim_player.player_key", "The player this row describes."),
		foreign("team_key", "dim_team.team_key", "The player's team in this game."),
		foreign("champion_key", "dim_champion.champion_key", "The champion the player played."),
		attribute("side", "TEXT", "The side the player's team was on in this game."),
		attribute("role", "TEXT", "The position actually played (`IngameRole`), not the source's label when they disagree."),
		...PLAYER_MEASURES.map(([name, field]) => measure(name, `The player's source-stated ${String(field)}.`)),
	];

	const gamesById = new Map(input.games.map((game) => [game.id, game]));
	const rows = input.playerGames.map((record): ModelRow => {
		const game = gamesById.get(record.gameId);
		if (game === undefined) throw new Error(`fact_player_game: player row references game ${record.gameId}, which is not in the model`);
		return {
			game_key: requiredKey(dimensions.game.keys, record.gameId, "fact_player_game"),
			event_key: requiredKey(dimensions.event.keys, record.eventId, "fact_player_game"),
			match_key: optionalKey(dimensions.match.keys, game.matchId, "fact_player_game"),
			date_key: requiredKey(dimensions.date.keys, game.dateTimeUtc.slice(0, 10), "fact_player_game"),
			patch_key: optionalKey(dimensions.patch.keys, game.patch, "fact_player_game"),
			player_key: requiredKey(dimensions.player.keys, record.playerId, "fact_player_game"),
			team_key: requiredKey(dimensions.team.keys, record.teamId, "fact_player_game"),
			champion_key: requiredKey(dimensions.champion.keys, record.championId, "fact_player_game"),
			side: record.side,
			role: record.role,
			...Object.fromEntries(PLAYER_MEASURES.map(([column, field]) => [column, measureValue(record[field] as number | undefined)])),
		};
	});

	return buildFact({
		name: "fact_player_game",
		description: "Player statistics at one row per game per player.",
		grain: "one row per game per player",
		columns,
		rows,
		grainColumns: ["game_key", "player_key"],
	});
}

function factDraftSlot(input: ModelInput, dimensions: ReturnType<typeof buildDimensions>): ModelTable {
	const columns: ModelColumn[] = [
		...commonFactColumns(),
		attribute("side", "TEXT", "The side whose draft turn this is, as the source recorded it."),
		attribute("phase", "TEXT", "`ban` or `pick`."),
		attribute("entry_index", "INTEGER", "Position within this game, side and phase. It equals `slot` for an ordered draft and is the only stable order an unordered draft has."),
		attribute("slot", "INTEGER", "The source's slot number, present only when the draft is ordered.", "empty for an unordered draft — absent order is never invented"),
		attribute("is_ordered", "INTEGER", "1 when the source kept pick/ban slots, else 0."),
		foreign("champion_key", "dim_champion.champion_key", "The champion picked or banned in this slot."),
	];

	const rows: ModelRow[] = [];
	for (const game of input.games) {
		if (game.draft === undefined) continue;
		const ordered = game.draft.fidelity === "ordered";
		for (const side of game.draft.sides) {
			for (const [phase, entries] of [
				["ban", side.bans],
				["pick", side.picks],
			] as const) {
				entries.forEach((entry, index) => {
					const slot = ordered ? entry.slot : undefined;
					if (ordered && slot === undefined) throw new Error(`game ${game.id}: an ordered draft entry has no slot`);
					const entryIndex = ordered ? (slot as number) : index + 1;
					rows.push({
						game_key: requiredKey(dimensions.game.keys, game.id, "fact_draft_slot"),
						event_key: requiredKey(dimensions.event.keys, game.eventId, "fact_draft_slot"),
						match_key: optionalKey(dimensions.match.keys, game.matchId, "fact_draft_slot"),
						date_key: requiredKey(dimensions.date.keys, game.dateTimeUtc.slice(0, 10), "fact_draft_slot"),
						patch_key: optionalKey(dimensions.patch.keys, game.patch, "fact_draft_slot"),
						side: side.side,
						phase,
						entry_index: entryIndex,
						slot: slot === undefined ? "" : slot,
						is_ordered: ordered ? 1 : 0,
						champion_key: requiredKey(dimensions.champion.keys, entry.championId, "fact_draft_slot"),
					});
				});
			}
		}
	}

	return buildFact({
		name: "fact_draft_slot",
		description: "One row per pick or ban, ordered and unordered drafts alike.",
		grain: "one row per game, side, phase and draft position",
		columns,
		rows,
		grainColumns: ["game_key", "side", "phase", "entry_index"],
	});
}

// ---- emission ---------------------------------------------------------------

function csvField(value: string | number | undefined): string {
	const text = value === undefined ? "" : String(value);
	if (/[",\r\n]/.test(text) || /^\s|\s$/.test(text)) return `"${text.replaceAll('"', '""')}"`;
	return text;
}

/** CSV: header, one field per column, RFC 4180 quoting, LF, trailing newline. */
export function toCsv(table: ModelTable): string {
	const lines = [table.columns.map((column) => csvField(column.name)).join(",")];
	for (const row of table.rows) lines.push(table.columns.map((column) => csvField(row[column.name])).join(","));
	return `${lines.join("\n")}\n`;
}

/**
 * Parse the canonical CSV back into fields. Exported because the conformance suite
 * reads the committed bytes, not the in-memory rows, and because a loader should not
 * have to reverse-engineer the quoting rules.
 */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (quoted) {
			if (character === '"') {
				if (text[index + 1] === '"') {
					field += '"';
					index++;
				} else {
					quoted = false;
				}
			} else {
				field += character;
			}
			continue;
		}
		if (character === '"' && field === "") {
			quoted = true;
		} else if (character === ",") {
			row.push(field);
			field = "";
		} else if (character === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else if (character === "\r") {
			// Tolerated on input, never emitted.
		} else {
			field += character;
		}
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

const COLUMN_ROLE: Record<NonNullable<ModelColumn["key"]>, string> = {
	surrogate: "surrogate key",
	natural: "natural key",
	foreign: "foreign key",
	grain: "grain key",
	measure: "measure",
	attribute: "attribute",
};

/** The DDL: one `CREATE TABLE` per model table, in `MODEL_TABLE_ORDER`. */
export function renderDdl(tables: ModelTable[]): string {
	const lines = [
		"-- Dimensional model DDL (SQLite dialect).",
		"-- Generated from data/curated/ by `node tools/dataset/cli.ts model`; do not edit by hand.",
		"-- Load the CSVs in this file's table order, or in MODEL_TABLE_ORDER: dimensions first.",
		"-- Empty CSV fields are absent values, not NULL and not zero; 0 in a foreign key is the",
		"-- unknown member. See data-dictionary.md.",
		"",
		"PRAGMA foreign_keys = ON;",
		"",
	];
	for (const table of tables) {
		lines.push(`-- ${table.name}: ${table.description}`);
		lines.push(`CREATE TABLE ${table.name} (`);
		const definitions = table.columns.map((column) => {
			const reference =
				column.references === undefined
					? ""
					: ` REFERENCES ${column.references.split(".")[0]}(${column.references.split(".")[1]})`;
			return `  ${column.name} ${column.type}${reference}`;
		});
		if (table.kind === "bridge" && table.surrogateKey !== undefined) definitions.push(`  PRIMARY KEY (${table.surrogateKey})`);
		else if (table.kind === "dimension" && table.surrogateKey !== undefined) definitions.push(`  PRIMARY KEY (${table.surrogateKey})`);
		else if (table.kind === "fact") definitions.push(`  PRIMARY KEY (${table.grainColumns.join(", ")})`);
		if (table.naturalKey !== undefined) definitions.push(`  UNIQUE (${table.naturalKey})`);
		if (table.kind === "bridge") definitions.push(`  UNIQUE (${table.grainColumns.join(", ")})`);
		lines.push(definitions.join(",\n"));
		lines.push(");", "");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

function markdownCell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** The data dictionary: generated from the same metadata as the DDL and the CSVs. */
export function renderDictionary(tables: ModelTable[]): string {
	const lines: string[] = [
		"# Dimensional model — data dictionary",
		"",
		"Generated from `data/curated/` by `node tools/dataset/cli.ts model`. Do not edit by hand.",
		"The curated JSONL is the source of truth; this layer is derived, rebuilt as a whole, and never",
		"written back to the curated files.",
		"",
		"## Files, grains and keys",
		"",
		"| Table | File | Kind | Grain | Natural key | Surrogate key |",
		"|---|---|---|---|---|---|",
	];
	for (const table of tables) {
		lines.push(
			`| \`${table.name}\` | \`${table.file}\` | ${table.kind} | ${markdownCell(table.grain)} | ${
				table.naturalKey === undefined ? "—" : `\`${table.naturalKey}\``
			} | ${table.surrogateKey === undefined ? "—" : `\`${table.surrogateKey}\``} |`,
		);
	}
	lines.push(
		"",
		"## Canonical form",
		"",
		"One CSV per table, RFC 4180 field quoting and escaping, UTF-8 without a BOM, one header row,",
		"fixed column order, LF record terminators, ISO-8601 dates (`YYYY-MM-DD`) and UTC instants",
		"(`YYYY-MM-DDTHH:MM:SSZ`), unformatted decimal integers, and an **empty field wherever the source",
		"did not record a value**. An empty field is not `0`: `0` is a recorded zero, and the two mean",
		"different things. A foreign key is never empty — absence is the unknown member's `0`.",
		"",
		"LF is deliberate. RFC 4180 also permits CRLF, but this repository normalizes every text file to",
		"LF (`.gitattributes`), so a CRLF artifact would be a committed file that differs from the bytes",
		"the build wrote. SQLite, DuckDB, Python's `csv` module and spreadsheets all read LF.",
		"",
		"## Unknown member",
		"",
		"Every dimension has exactly one row with surrogate key `0`, an empty natural key and the display",
		"name `Unknown`. A fact joins to it when the curated record has no value — today, a game with no",
		"series or no patch (`match_key`, `patch_key`). An inner join therefore never drops a thin-era row,",
		"and `0` is never mistaken for a real entity. The unknown row's attributes are empty, not zero,",
		"except a foreign key it carries itself, which joins to the target's own unknown member",
		"(`dim_match`'s `event_key` is `0`).",
		"",
		"Every dimension keeps its unknown member, including the ones no fact can currently reach at `0`",
		"(`dim_event`, `dim_game`, `dim_date`, `dim_team`, `dim_player`, `dim_champion`): the rule — a",
		"foreign key is never empty, and absence is key `0` — then stays uniform, a reader never learns a",
		"per-dimension special case, and a future fact that can miss one of these values needs no new",
		"convention. The conformance gate refuses `0` in a fact key the curated record always states",
		"(`game_key`, `event_key`, `date_key`, `team_key`, `player_key`, `champion_key`), so the",
		"unreachable members stay unreachable rather than silently absorbable.",
		"",
		"## Surrogate keys and ordering",
		"",
		"Surrogate keys are `0` for the unknown member and `1..N` for the real rows, assigned in ascending",
		"natural-key order within each build. They are build-local: the natural key (the canonical ID,",
		"ISO date or patch string) is the durable identifier, and every fact is rebuilt in the same run, so",
		"a key can never dangle. The keys can shift between builds — a new event sorting earlier",
		"renumbers everything after it — which is not a defect: an analyst joining across a rebuild, or",
		"storing a key outside the model, uses the natural key, which is the durable handle. Rows are",
		"sorted by that same order; facts are sorted by their declared grain columns, and the bridge by",
		"`kind`, `entity_key`, `alias_string`. No file contains a build timestamp.",
		"",
		"## Measures, and the limit of the no-derived-measure guard",
		"",
		"Facts carry only measures the source stated — counts and durations. The analyst does the summing,",
		"dividing and averaging. The build refuses a fact column whose **name** looks like a derived",
		"measure: `rate`, `ratio`, `average`, `avg`, `mean`, `percentage`, `percent`, `pct`, `share`,",
		"`kda`, `gpm`, `win_rate`, `win_pct`, and `per_game`, `per_minute`, `per_min` shapes. That guard is",
		"a naming heuristic, not a semantic one: it catches the obvious shapes (`kda`, `gpm`,",
		"`damage_per_min_10`) but cannot tell what a column computes, so a new measure still needs a",
		"reviewer's judgement that it is source-stated and additive. Do not rely on the guard for",
		"correctness.",
		"",
		"## Alias bridge",
		"",
		"`bridge_alias` carries source strings, not duplicate dimension rows: a renamed team is one",
		"`dim_team` row and several bridge rows, each with `valid_from`/`valid_to` dates where the corpus",
		"dates them. `entity_key` is a foreign key into the dimension named by `kind` (`team`, `player` or",
		"`champion`), so one bridge serves all three. `evidence` is the source's reason for believing the",
		"mapping, joined with semicolons in canonical order. An empty validity date means the corpus does",
		"not date the string, not that it was never used.",
		"",
		"## Tables",
		"",
	);
	for (const table of tables) {
		lines.push(`### \`${table.name}\` — ${table.kind}`, "", table.description, "", `**Grain:** ${table.grain}.`);
		if (table.naturalKey !== undefined) lines.push(`**Natural key:** \`${table.naturalKey}\`.`);
		if (table.surrogateKey !== undefined) lines.push(`**Surrogate key:** \`${table.surrogateKey}\`.`);
		if (table.kind === "fact") lines.push(`**Grain key:** ${table.grainColumns.map((column) => `\`${column}\``).join(", ")}.`);
		lines.push("", "| Column | Type | Role | References | Absent / notes |", "|---|---|---|---|---|");
		for (const column of table.columns) {
			const absent = column.absent ?? "never absent";
			lines.push(
				`| \`${column.name}\` | ${column.type} | ${column.key === undefined ? "—" : COLUMN_ROLE[column.key]} | ${
					column.references === undefined ? "—" : `\`${column.references}\``
				} | ${markdownCell(`${column.description} ${absent === "never absent" ? "" : `Absent: ${absent}.`}`.trim())} |`,
			);
		}
		lines.push("");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

function buildFiles(tables: ModelTable[]): Record<string, string> {
	const files: Record<string, string> = {};
	for (const table of tables) files[table.file] = toCsv(table);
	files[SCHEMA_FILE] = renderDdl(tables);
	files[DICTIONARY_FILE] = renderDictionary(tables);
	return files;
}

// ---- conformance ------------------------------------------------------------

export const DERIVED_MEASURE_PATTERN = /(^|_)(rate|ratio|average|avg|mean|percentage|percent|pct|share|kda|gpm|win_rate|win_pct)(_|$)|_(per_game|per_minute|per_min)(_|$)/i;
/** The fact keys the curated record always states; the conformance gate refuses the unknown member for them. */
export const REQUIRED_FACT_KEYS = new Set(["game_key", "event_key", "date_key", "team_key", "player_key", "champion_key"]);

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
	return counts;
}

/**
 * Every conformance violation in a built model, or an empty list.
 *
 * The build calls this and refuses to emit a model that fails. It is separate so the
 * suite (and a reader) can see all violations at once instead of only the first.
 */
export function findModelViolations(input: ModelInput, result: ModelBuild): string[] {
	const violations: string[] = [];
	const byName = new Map(result.tables.map((table) => [table.name, table]));
	const get = (name: ModelTableName): ModelTable => {
		const table = byName.get(name);
		if (table === undefined) {
			violations.push(`the model is missing ${name}`);
			return { name, file: `${name}.csv`, kind: "dimension", description: "", grain: "", columns: [], grainColumns: [], rows: [] };
		}
		return table;
	};

	const dimensions = ["dim_event", "dim_match", "dim_game", "dim_team", "dim_player", "dim_champion", "dim_patch", "dim_date"] as const;
	const facts = ["fact_game_side", "fact_player_game", "fact_draft_slot"] as const;

	// Shape: one unknown member, unique keys, a natural key and a display name per row.
	for (const name of dimensions) {
		const table = get(name);
		if (table.surrogateKey === undefined) {
			violations.push(`${name}: no surrogate key column declared`);
			continue;
		}
		const surrogates = table.rows.map((row) => row[table.surrogateKey!]);
		if (new Set(surrogates).size !== surrogates.length) violations.push(`${name}: surrogate key is not unique`);
		const unknown = table.rows.filter((row) => row[table.surrogateKey!] === 0);
		if (unknown.length !== 1) violations.push(`${name}: expected exactly one unknown member at key 0, found ${unknown.length}`);
		if (table.naturalKey !== undefined) {
			const natural = table.rows.filter((row) => row[table.surrogateKey!] !== 0).map((row) => String(row[table.naturalKey!]));
			if (natural.some((value) => value === "")) violations.push(`${name}: a real row has an empty natural key`);
			if (new Set(natural).size !== natural.length) violations.push(`${name}: natural key is not unique`);
			if (unknown[0] !== undefined && unknown[0][table.naturalKey] !== "") violations.push(`${name}: the unknown member must have an empty natural key`);
		}
		if (table.displayKey !== undefined) {
			for (const row of table.rows) {
				if (String(row[table.displayKey] ?? "") === "") violations.push(`${name}: a row has no display name`);
			}
		}
	}

	// The dimension's rows are exactly the curated entities, plus the unknown member.
	const dimensionSets: [ModelTableName, string, string[]][] = [
		["dim_event", "event_id", input.events.map((record) => record.id)],
		["dim_match", "match_id", input.matches.map((record) => record.id)],
		["dim_game", "game_id", input.games.map((record) => record.id)],
		["dim_team", "team_id", input.teams.map((record) => record.id)],
		["dim_player", "player_id", input.players.map((record) => record.id)],
		["dim_champion", "champion_id", input.champions.map((record) => record.id)],
		["dim_patch", "patch", [...new Set(input.games.map((game) => game.patch).filter((patch): patch is string => patch !== undefined))]],
		["dim_date", "date", [...new Set(input.games.map((game) => game.dateTimeUtc.slice(0, 10)))]],
	];
	for (const [name, column, expected] of dimensionSets) {
		const table = get(name);
		const actual = new Set(table.rows.map((row) => String(row[column])).filter((value) => value !== ""));
		const wanted = new Set(expected);
		const missing = [...wanted].filter((value) => !actual.has(value));
		const extra = [...actual].filter((value) => !wanted.has(value));
		if (missing.length > 0) violations.push(`${name}: missing ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}`);
		if (extra.length > 0) violations.push(`${name}: carries ${extra.slice(0, 3).join(", ")}${extra.length > 3 ? ", …" : ""} that the curated layer does not`);
	}

	// Grains are unique, and every foreign key resolves (the unknown member is a row).
	for (const name of [...facts, "bridge_alias"] as const) {
		const table = get(name);
		const seen = new Set<string>();
		for (const row of table.rows) {
			const grain = table.grainColumns.map((column) => String(row[column])).join("\u0000");
			if (seen.has(grain)) violations.push(`${name}: grain ${JSON.stringify(grain)} appears twice`);
			seen.add(grain);
		}
	}
	for (const name of facts) {
		const table = get(name);
		for (const column of table.columns) {
			if (column.key === "measure" || column.key === "attribute") {
				if (DERIVED_MEASURE_PATTERN.test(column.name)) violations.push(`${name}.${column.name}: derived measures are not allowed in facts`);
			}
			if (column.references === undefined) continue;
			const [targetTable, targetColumn] = column.references.split(".");
			const targetValues = new Set(get(targetTable as ModelTableName).rows.map((row) => String(row[targetColumn])));
			for (const row of table.rows) {
				const value = String(row[column.name]);
				if (!targetValues.has(value)) violations.push(`${name}.${column.name}=${JSON.stringify(value)} does not resolve to ${targetTable}`);
				if (REQUIRED_FACT_KEYS.has(column.name) && value === "0") {
					violations.push(`${name}.${column.name} uses the unknown member where the curated record always states a value`);
				}
			}
		}
	}

	// Dimensions can carry a foreign key too (dim_match's event); it must resolve, unknown member included.
	for (const name of dimensions) {
		const table = get(name);
		for (const column of table.columns.filter((candidate) => candidate.references !== undefined)) {
			const [targetTable, targetColumn] = column.references.split(".");
			const targetValues = new Set(get(targetTable as ModelTableName).rows.map((row) => String(row[targetColumn])));
			for (const row of table.rows) {
				const value = String(row[column.name]);
				if (!targetValues.has(value)) violations.push(`${name}.${column.name}=${JSON.stringify(value)} does not resolve to ${targetTable}`);
			}
		}
	}

	// The bridge is polymorphic; resolve each row against the dimension its kind names.
	const entityKeys = {
		team: new Set(get("dim_team").rows.map((row) => String(row.team_key))),
		player: new Set(get("dim_player").rows.map((row) => String(row.player_key))),
		champion: new Set(get("dim_champion").rows.map((row) => String(row.champion_key))),
	};
	for (const row of get("bridge_alias").rows) {
		const keys = entityKeys[row.kind as EntityKind];
		if (keys === undefined) violations.push(`bridge_alias: unknown kind ${JSON.stringify(row.kind)}`);
		else if (!keys.has(String(row.entity_key))) violations.push(`bridge_alias: ${row.alias_string} points at a missing ${row.kind} row`);
	}

	// Row counts reconcile with the curated layer, per game and per event.
	const expectedSides = input.games.length * 2;
	const expectedPlayers = input.playerGames.length;
	const expectedDraft = input.games.reduce(
		(sum, game) => sum + (game.draft?.sides.reduce((inner, side) => inner + side.picks.length + side.bans.length, 0) ?? 0),
		0,
	);
	if (get("fact_game_side").rows.length !== expectedSides) {
		violations.push(`fact_game_side: ${get("fact_game_side").rows.length} rows for ${input.games.length} games, expected ${expectedSides}`);
	}
	if (get("fact_player_game").rows.length !== expectedPlayers) {
		violations.push(`fact_player_game: ${get("fact_player_game").rows.length} rows, expected ${expectedPlayers} curated player rows`);
	}
	if (get("fact_draft_slot").rows.length !== expectedDraft) {
		violations.push(`fact_draft_slot: ${get("fact_draft_slot").rows.length} rows, expected ${expectedDraft} draft entries`);
	}
	if (get("bridge_alias").rows.length !== input.aliases.length) {
		violations.push(`bridge_alias: ${get("bridge_alias").rows.length} rows, expected ${input.aliases.length} curated aliases`);
	}
	if (get("dim_game").rows.length !== input.games.length + 1) {
		violations.push(`dim_game: ${get("dim_game").rows.length} rows for ${input.games.length} games plus the unknown member`);
	}

	const gameIdByKey = new Map(get("dim_game").rows.map((row) => [String(row.game_key), String(row.game_id)]));
	const eventIdByKey = new Map(get("dim_event").rows.map((row) => [String(row.event_key), String(row.event_id)]));
	const sidesPerGame = countBy(get("fact_game_side").rows, (row) => String(gameIdByKey.get(String(row.game_key))));
	const playersPerGame = countBy(get("fact_player_game").rows, (row) => String(gameIdByKey.get(String(row.game_key))));
	const draftPerGame = countBy(get("fact_draft_slot").rows, (row) => String(gameIdByKey.get(String(row.game_key))));
	for (const game of input.games) {
		if ((sidesPerGame.get(game.id) ?? 0) !== 2) violations.push(`game ${game.id}: ${sidesPerGame.get(game.id) ?? 0} side fact rows, expected 2`);
		const expected = input.playerGames.filter((row) => row.gameId === game.id).length;
		if ((playersPerGame.get(game.id) ?? 0) !== expected) violations.push(`game ${game.id}: ${playersPerGame.get(game.id) ?? 0} player fact rows, expected ${expected}`);
		const draft = game.draft?.sides.reduce((sum, side) => sum + side.picks.length + side.bans.length, 0) ?? 0;
		if ((draftPerGame.get(game.id) ?? 0) !== draft) violations.push(`game ${game.id}: ${draftPerGame.get(game.id) ?? 0} draft fact rows, expected ${draft}`);
	}

	const factEvents = (name: ModelTableName) => countBy(get(name).rows, (row) => String(eventIdByKey.get(String(row.event_key))));
	const expectedGames = countBy(input.games, (game) => game.eventId);
	const expectedPlayerRows = countBy(input.playerGames, (row) => row.eventId);
	const expectedDraftRows = new Map<string, number>();
	for (const game of input.games) {
		const count = game.draft?.sides.reduce((sum, side) => sum + side.picks.length + side.bans.length, 0) ?? 0;
		expectedDraftRows.set(game.eventId, (expectedDraftRows.get(game.eventId) ?? 0) + count);
	}
	for (const [eventId, games] of expectedGames) {
		if ((factEvents("fact_game_side").get(eventId) ?? 0) !== games * 2) violations.push(`event ${eventId}: side fact rows do not reconcile`);
	}
	for (const [eventId, playerRows] of expectedPlayerRows) {
		if ((factEvents("fact_player_game").get(eventId) ?? 0) !== playerRows) violations.push(`event ${eventId}: player fact rows do not reconcile`);
	}
	for (const [eventId, draftRows] of expectedDraftRows) {
		if ((factEvents("fact_draft_slot").get(eventId) ?? 0) !== draftRows) violations.push(`event ${eventId}: draft fact rows do not reconcile`);
	}

	// One game must present one event across every fact, and a player row's team and side
	// must be one of the game's two sides. Each fact is self-consistent on its own, so a
	// hand-edited curated row (a player row carrying another event's id) passes every
	// per-fact check and only contradicts across them.
	const eventKeysByGame = new Map<string, Set<number>>();
	for (const name of facts) {
		for (const row of get(name).rows) {
			const gameId = String(gameIdByKey.get(String(row.game_key)));
			const set = eventKeysByGame.get(gameId) ?? new Set<number>();
			set.add(row.event_key as number);
			eventKeysByGame.set(gameId, set);
		}
	}
	for (const [gameId, keys] of eventKeysByGame) {
		if (keys.size > 1) {
			violations.push(
				`game ${gameId}: its facts disagree on the event — ${[...keys].map((key) => `event ${eventIdByKey.get(String(key))}`).join(" vs ")}`,
			);
		}
	}
	const sideTeamsByGame = new Map<string, { teamKey: number; side: string }[]>();
	for (const row of get("fact_game_side").rows) {
		const gameId = String(gameIdByKey.get(String(row.game_key)));
		const list = sideTeamsByGame.get(gameId) ?? [];
		list.push({ teamKey: row.team_key as number, side: String(row.side) });
		sideTeamsByGame.set(gameId, list);
	}
	for (const row of get("fact_player_game").rows) {
		const gameId = String(gameIdByKey.get(String(row.game_key)));
		const played = sideTeamsByGame.get(gameId)?.find((side) => String(side.teamKey) === String(row.team_key));
		if (played === undefined) {
			violations.push(`game ${gameId}: a player fact row's team ${row.team_key} is not one of the game's two sides`);
		} else if (played.side !== row.side) {
			violations.push(
				`game ${gameId}: a player fact row says side ${JSON.stringify(row.side)}, but that team played ${JSON.stringify(played.side)}`,
			);
		}
	}

	// Coverage is a claim about the game, so it lives on dim_game and must survive.
	const dimGameById = new Map(get("dim_game").rows.map((row) => [String(row.game_id), row]));
	for (const game of input.games) {
		const row = dimGameById.get(game.id);
		if (row === undefined) {
			violations.push(`dim_game: ${game.id} has no row`);
			continue;
		}
		if (row.era !== game.era) violations.push(`dim_game ${game.id}: era ${JSON.stringify(row.era)} does not match ${JSON.stringify(game.era)}`);
		if (row.team_stats_coverage !== game.coverage.teamStats) violations.push(`dim_game ${game.id}: team-stat coverage does not survive`);
		if (row.draft_coverage !== game.coverage.draft) violations.push(`dim_game ${game.id}: draft coverage does not survive`);
		if (row.player_stats_coverage !== game.coverage.playerStats) violations.push(`dim_game ${game.id}: player-stat coverage does not survive`);
		if (row.draft_fidelity !== (game.draft?.fidelity ?? "")) violations.push(`dim_game ${game.id}: draft fidelity does not survive`);
	}

	return violations;
}

/** Throw unless the model is a conforming star schema over `input`, listing every violation. */
export function assertModelConforms(input: ModelInput, result: ModelBuild): void {
	const violations = findModelViolations(input, result);
	if (violations.length === 0) return;
	throw new Error(
		`the dimensional model violates ${violations.length} conformance rule${violations.length === 1 ? "" : "s"}:\n  - ${violations.join("\n  - ")}`,
	);
}

// ---- coverage rollup --------------------------------------------------------

/**
 * The model reduced to what a rollup needs: a table name and its rows.
 *
 * Deliberately narrower than `ModelBuild`, so the rollup runs as well over tables read
 * back from the committed CSVs as over the in-memory build. That is the point: an
 * analyst who has only `data/model/` must be able to derive the same answer.
 */
export type RollupTables = readonly { name: string; rows: readonly ModelRow[] }[];

/** The two grains of the curated coverage report, as the model can state them. */
export type ModelCoverageRollup = {
	events: EventCoverageRecord[];
	eras: Omit<EraCoverageRecord, "from">[];
};

/**
 * The curated coverage report's two grains, re-derived from the model alone.
 *
 * `event-coverage.jsonl` and `era-coverage.jsonl` are aggregation of the per-game
 * markers (spec R6). Because the markers live on `dim_game`, the same rollup is
 * computable from the modelled layer — and it must agree with the curated report, or a
 * fact consumer and a curated consumer would answer "what does this era hold?"
 * differently. The suite asserts that agreement against the committed bytes.
 *
 * Two fields are honestly out of reach here, and neither is a game fact:
 *
 *   - an era's `from` is the era table's declaration, not something a game states; and
 *   - a declared era with **no** games has no row to roll up (its absence is the era
 *     table's business, the same way `event-games.jsonl` records an empty event). The
 *     suite asserts every era the report has and the rollup lacks carries `games: 0`,
 *     so an era cannot be missing because games vanished from the model.
 *
 * `dim_game` deliberately carries no event key (ticket 12, A7), so a game's event comes
 * from its fact rows: every modelled game has exactly two side rows, and the conformance
 * gate proves they agree on the event, which makes this join total and consistent.
 */
export function rollupCoverage(tables: RollupTables): ModelCoverageRollup {
	const rowsOf = (name: ModelTableName): readonly ModelRow[] => {
		const found = tables.find((candidate) => candidate.name === name);
		if (found === undefined) throw new Error(`rollupCoverage: the model has no ${name}`);
		return found.rows;
	};

	const COVERAGE_COLUMN: Record<(typeof COVERAGE_GROUPS)[number], string> = {
		teamStats: "team_stats_coverage",
		draft: "draft_coverage",
		playerStats: "player_stats_coverage",
	};
	const STATES: readonly string[] = ["complete", "partial", "unavailable"];

	const eventByGame = new Map<string, string>();
	for (const row of rowsOf("fact_game_side")) {
		const gameKey = String(row.game_key);
		const eventKey = String(row.event_key);
		const known = eventByGame.get(gameKey);
		if (known === undefined) eventByGame.set(gameKey, eventKey);
		else if (known !== eventKey) throw new Error(`rollupCoverage: game ${gameKey} sits in events ${known} and ${eventKey}`);
	}

	const gamesByEvent = new Map<string, ModelRow[]>();
	const gamesByEra = new Map<string, ModelRow[]>();
	for (const row of rowsOf("dim_game")) {
		const gameKey = String(row.game_key);
		if (gameKey === "0") continue; // the unknown member is not a game
		const eventKey = eventByGame.get(gameKey);
		if (eventKey === undefined) {
			throw new Error(`rollupCoverage: game ${row.game_id} has no side row, so the event it belongs to is unknown`);
		}
		const perEvent = gamesByEvent.get(eventKey) ?? [];
		perEvent.push(row);
		gamesByEvent.set(eventKey, perEvent);
		const era = String(row.era);
		const perEra = gamesByEra.get(era) ?? [];
		perEra.push(row);
		gamesByEra.set(era, perEra);
	}

	const coverageOf = (games: readonly ModelRow[]): CoverageGroups => {
		const groups = {} as CoverageGroups;
		for (const group of COVERAGE_GROUPS) {
			const markers = games.map((row) => {
				const marker = String(row[COVERAGE_COLUMN[group]]);
				if (!STATES.includes(marker)) {
					throw new Error(
						`rollupCoverage: game ${row.game_id} states ${JSON.stringify(marker)} for ${group}; expected complete, partial or unavailable`,
				);
				}
				return marker as Coverage;
			});
			groups[group] = summariseGroup(markers);
		}
		return groups;
	};

	const events: EventCoverageRecord[] = rowsOf("dim_event")
		.filter((row) => String(row.event_key) !== "0")
		.map((row) => {
			const games = gamesByEvent.get(String(row.event_key)) ?? [];
			return {
				eventId: String(row.event_id),
				eventName: String(row.event_name),
				overviewPage: String(row.overview_page),
				eras: [...new Set(games.map((game) => String(game.era)))].sort(compareText),
				games: games.length,
				coverage: coverageOf(games),
			};
		})
		.sort((a, b) => compareText(a.eventId, b.eventId));

	const eras = [...gamesByEra.entries()]
		.map(([era, games]) => ({
			era,
			games: games.length,
			events: new Set(games.map((game) => eventByGame.get(String(game.game_key)))).size,
			coverage: coverageOf(games),
		}))
		.sort((a, b) => compareText(a.era, b.era));

	return { events, eras };
}

// ---- entry points -----------------------------------------------------------

/**
 * Assemble the tables without validating them.
 *
 * Exported so the conformance rules can be tested against a deliberately inconsistent
 * input — the kind a hand-edited curated file produces — without being refused at the
 * door; `buildModel` is the seam that runs validation and conformance over this.
 */
export function assembleModel(input: ModelInput): ModelBuild {
	const dimensions = buildDimensions(input);
	const tablesByName = new Map<ModelTableName, ModelTable>([
		["dim_event", dimensions.event.table],
		["dim_match", dimensions.match.table],
		["dim_game", dimensions.game.table],
		["dim_team", dimensions.team.table],
		["dim_player", dimensions.player.table],
		["dim_champion", dimensions.champion.table],
		["dim_patch", dimensions.patch.table],
		["dim_date", dimensions.date.table],
		["bridge_alias", buildAliasBridge(input, dimensions)],
		["fact_game_side", factGameSide(input, dimensions)],
		["fact_player_game", factPlayerGame(input, dimensions)],
		["fact_draft_slot", factDraftSlot(input, dimensions)],
	]);
	const tables = MODEL_TABLE_ORDER.map((name) => {
		const table = tablesByName.get(name);
		if (table === undefined) throw new Error(`the model builder did not produce ${name}`);
		return table;
	});
	const result: ModelBuild = { tables, files: buildFiles(tables) };
	return result;
}

/**
 * Derive the model from curated records. Validates the curated fields the model relies
 * on, then throws rather than return a model that fails a grain, a foreign key or a
 * row-count reconciliation.
 */
export function buildModel(input: ModelInput): ModelBuild {
	validateModelInput(input);
	const result = assembleModel(input);
	assertModelConforms(input, result);
	return result;
}

/** Write every model file. The only stage that writes to the model output directory. */
export async function writeModel(result: Pick<ModelBuild, "files">, outDir: string = DEFAULT_MODEL_DIR): Promise<void> {
	await mkdir(outDir, { recursive: true });
	for (const [file, body] of Object.entries(result.files)) await writeFile(path.join(outDir, file), body, "utf8");
}
