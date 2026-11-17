// normalize: raw cached payload -> typed source record.
//
// Pure by construction (spec D5): it takes bytes that are already on disk and
// returns values. No network, no clock, no ordering assumptions — a payload's
// position in the directory must never change the output.
//
// This stage maps *source fields to source fields*. It does not decide whether an
// event belongs in the dataset (that is `rule.ts`) and it does not mint identity
// (that is `identity.ts`). Keeping it that literal is what lets ticket 09 replace
// the corpus without revisiting the rule.
//
// Routing is by the table directory the payload sits in (`cache.ts`), never by
// shape: a ScoreboardPlayers row and a Tournaments row both carry `OverviewPage`,
// so shape sniffing would feed one stage's rows to another's parser. An unknown
// table is an error, because a payload nobody reads is worse than a loud stop.
//
// Two source quirks are measured, not guessed, and both are handled here rather
// than pushed onto every caller:
//
//   - `Special:CargoExport` answers an underscored field name with a space:
//     requesting `DateTime_UTC` returns the key `DateTime UTC`. `raw()` accepts
//     either spelling.
//   - values keep the wiki's HTML entities (`Nunu &amp; Willump`, and the source
//     spells it that way in the champion table *and* in 2011 scoreboard rows).
//     The two kinds of string are treated differently on purpose: a *source string*
//     — an alias, a page, a league — keeps those bytes, because spec R7 says source
//     strings are preserved verbatim and exact matching against the registry depends
//     on both sides carrying the same bytes. A *display name* goes through
//     `displayName()` below, because spec R12 asks for the human-readable name and
//     `&amp;` is the wiki's escaping, not part of Riot's name.

import type { CachedPayload } from "./cache.ts";

/**
 * The human-readable form of a source string: HTML entities decoded once.
 *
 * Used for display names only (`name`, `entityName`), never for an alias `string`, a
 * page or a league — those are source strings under spec R7. Decoding happens once
 * by scanning left to right, so `&amp;lt;` becomes `&lt;` and never `<`: a source
 * string that meant to show `&lt;` still does.
 */
export function displayName(source: string): string {
	const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
	return source.replace(/&(?:(amp|lt|gt|quot|apos|nbsp)|#x([0-9a-fA-F]+)|#(\d+));/g, (whole, entity, hex, dec) => {
		if (entity !== undefined) return named[entity as keyof typeof named];
		const code = hex !== undefined ? Number.parseInt(hex, 16) : Number(dec);
		if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
		return String.fromCodePoint(code);
	});
}

/** One tournament row as the source states it, already trimmed. */
export type SourceEvent = {
	/** Source `Name`: the human-readable display name. */
	name: string;
	/** Source `OverviewPage`: the event's page, and the input to its canonical ID. */
	overviewPage: string;
	/** Source `League`, e.g. `World Championship`. */
	league: string;
	/** Source `Region`, e.g. `International`. Empty when the source has no value. */
	region: string;
	/** Source `DateStart` as a UTC calendar date (`YYYY-MM-DD`), empty when absent. */
	dateStart: string;
	/** Which cached payload carried this row, for errors that name a file. */
	sourceFile: string;
};

/** One team page. `RenamedTo` is the source's own rename edge (measured: SKT -> T1). */
export type SourceTeam = {
	page: string;
	name: string;
	/** The page this team was renamed to, or empty. Never a display string. */
	renamedTo: string;
	region: string;
	sourceFile: string;
};

/** One `TeamRedirects` row: a string the source also calls a team by. */
export type SourceTeamName = {
	page: string;
	allName: string;
	sourceFile: string;
};

/** One `PlayerRedirects` row: a page, a string that denotes it, and the handle then. */
export type SourcePlayerName = {
	page: string;
	allName: string;
	id: string;
	sourceFile: string;
};

/** One champion registry row. `riotKey` is Riot's numeric champion id. */
export type SourceChampion = {
	name: string;
	riotKey: number;
	sourceFile: string;
};

/**
 * One player row from a game. Only the fields identity needs: tickets 03-05 own
 * the statistics. `Link` is the player page (the identity), `Name` is the handle
 * the scoreboard displayed (a string that denotes that entity on that date).
 */
export type SourceScoreboardRow = {
	/** Source GameId when the payload carries one. Empty for the older identity-only queries. */
	gameId: string;
	page: string;
	/** UTC calendar date of the game, `YYYY-MM-DD`, empty when the source has none. */
	date: string;
	playerName: string;
	playerLink: string;
	team: string;
	opponent: string;
	champion: string;
	sourceFile: string;
};

/**
 * The per-side team statistics a `ScoreboardGames` row states, in the order they are
 * emitted. The source column names are the wiki's own (`Team1` + suffix).
 *
 * `deaths` is deliberately absent: `cargofields` on `ScoreboardGames` (measured, 69
 * fields) has no `Deaths` and no `Assists` column for either side, so a deaths figure
 * could only be derived from the opponent's kills. A kill is not always one death —
 * executions exist — so deriving it would put a fabricated number where spec R4 says
 * an absence belongs.
 */
export const TEAM_STAT_FIELDS = [
	["kills", "Kills"],
	["gold", "Gold"],
	["towers", "Towers"],
	["inhibitors", "Inhibitors"],
	["barons", "Barons"],
	["dragons", "Dragons"],
	["dragonsClouds", "Clouds"],
	["dragonsInfernals", "Infernals"],
	["dragonsMountains", "Mountains"],
	["dragonsOceans", "Oceans"],
	["dragonsHextechs", "Hextechs"],
	["dragonsChemtechs", "Chemtechs"],
	["dragonsElders", "Elders"],
	["riftHeralds", "RiftHeralds"],
	["voidGrubs", "VoidGrubs"],
	["atakhans", "Atakhans"],
] as const;

export type TeamStatField = (typeof TEAM_STAT_FIELDS)[number][0];

/** One side of one game, as the source states it. `null` means the source recorded no value. */
export type SourceSide = { team: string } & Record<TeamStatField, number | null>;

/** A champion in one numbered draft slot, as the source states it. */
export type DraftSlot = { slot: number; champion: string };

/** One side of an ordered draft: each slot keeps its source number (R5). */
export type SourceDraftSide = { picks: DraftSlot[]; bans: DraftSlot[] };

/**
 * One `PicksAndBansS7` row: the ordered draft of a 2017+ game.
 *
 * `SwitchedSides` is the source's own flag, kept as 0/1 or null when absent.
 * Unmatched rows are possible (a crawl can cover events the rule rejects); they are
 * left unused rather than silently attached to another game.
 */
export type SourceDraft = {
	gameId: string;
	switchedSides: 0 | 1 | null;
	sides: [SourceDraftSide, SourceDraftSide];
	sourceFile: string;
};

/**
 * One `ScoreboardGames` row: the game itself and its two sides.
 *
 * `Team1`/`Team2` are **sides**, not teams — measured on the recorded fixture, where a
 * side-swapped series has the same team as `Team1` in games 1-2 and as `Team2` in game
 * 3. So the side is blue/red by position, and the team is a reference that identity
 * resolves per game.
 */
export type SourceGame = {
	page: string;
	/** UTC calendar date, `YYYY-MM-DD`. */
	date: string;
	/** UTC instant, `YYYY-MM-DDTHH:MM:SSZ`. */
	dateTimeUtc: string;
	gameId: string;
	matchId: string;
	/** The team string the source credits with the win (a display string, not an ID). */
	winTeam: string;
	/** Source `Winner`: 1 or 2. NaN when the source states none. */
	winnerSide: number;
	/** Seconds, parsed from the exact `Gamelength` (`mm:ss`); null when the source has none. */
	durationSeconds: number | null;
	/** Patch as the source states it, as text: the column is numeric, so `4.10` arrives as `4.1`. */
	patch: string | null;
	sides: [SourceSide, SourceSide];
	/** List-typed `Team*Picks`/`Team*Bans`: sets, not draft order (R5). */
	picks: [string[], string[]];
	bans: [string[], string[]];
	riotPlatformGameId: string;
	/**
	 * The source's `RiotHash`: Riot's own hash of the game record, where the source
	 * recorded one (the 2015-era rows carry it; the 2023 rows do not).
	 */
	riotHash: string;
	sourceFile: string;
};

/**
 * One `MatchSchedule` row: a series. Unlike `ScoreboardGames`, its `Team1`/`Team2`
 * are source column positions, not game sides — the two are unrelated across games of
 * a side-swapped series, so no blue/red claim is made for a match.
 */
export type SourceMatch = {
	page: string;
	matchId: string;
	date: string;
	dateTimeUtc: string;
	sides: [string, string];
	/** Source `Winner`: "1" or "2". NaN when absent. */
	winnerSide: number;
	bestOf: number | null;
	/** Source `Tab` — the round label the source actually carries (`Phase`/`Round` are null). */
	tab: string;
	patch: string | null;
	/** Source `FF` == 1. Measured null on both recorded events; kept because a walkover is a real row. */
	forfeit: boolean;
	isNullified: boolean;
	/** Cumulative series score per side, aligned with `sides`; null when not stated. */
	seriesScore: [number | null, number | null];
	sourceFile: string;
};

/** Everything the stages below the cache hand to `assemble` / `identity`. */
/** One `ScoreboardPlayers` row with statistics (ticket 04), not just an identity observation. */
export type SourcePlayerGame = {
	gameId: string;
	date: string;
	/** The player page: the identity, while `playerName` is the handle then displayed. */
	playerLink: string;
	playerName: string;
	team: string;
	champion: string;
	/** The source's `Side`, 1 or 2; null when it did not state one. */
	side: 1 | 2 | null;
	/** The played position, preferring `IngameRole` over the source's `Role` label. */
	role: string;
	kills: number | null;
	deaths: number | null;
	assists: number | null;
	cs: number | null;
	gold: number | null;
	damage: number | null;
	vision: number | null;
	items: string[];
	trinket: string | null;
	summonerSpells: string[];
	keystone: string | null;
	primaryTree: string | null;
	secondaryTree: string | null;
	runes: string[];
	sourceFile: string;
};

export type SourceDataset = {
	tournaments: SourceEvent[];
	teams: SourceTeam[];
	teamNames: SourceTeamName[];
	playerNames: SourcePlayerName[];
	champions: SourceChampion[];
	scoreboard: SourceScoreboardRow[];
	/** Games and matches (ticket 03). Empty when the corpus carries no scoreboard payload. */
	games: SourceGame[];
	matches: SourceMatch[];
	/** Ordered drafts (ticket 05). Empty before 2017 payloads are recorded. */
	drafts: SourceDraft[];
	/** Per-player statistics for recorded games (ticket 04). */
	playerGames: SourcePlayerGame[];
};

/** Cargo returns list-typed fields as arrays; everything else as strings. */
function asText(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (Array.isArray(value)) return value.map((item) => asText(item)).filter((item) => item !== "").join(", ");
	return String(value).trim();
}

/** A Cargo list field: each element kept verbatim, with empty entries dropped. */
function asList(value: unknown): string[] {
	if (!Array.isArray(value)) return asText(value) === "" ? [] : [asText(value)];
	return value.map((item) => asText(item)).filter((item) => item !== "");
}

/** `2023-10-10 07:00:00` -> `2023-10-10`; anything unparseable stays empty. */
function asDate(value: unknown): string {
	const text = asText(value);
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
	return match ? match[1] : "";
}

/** An integer field, or NaN when the source has none (the caller decides what that means). */
function asInteger(value: unknown): number {
	const text = asText(value);
	return text === "" ? Number.NaN : Number(text);
}

/**
 * A Cargo field, by its documented name. The export endpoint answers an
 * underscored name with a space, so `DateTime UTC` is what `DateTime_UTC` arrives
 * as — measured on every scoreboard payload in this repository.
 */
function raw(row: Record<string, unknown>, name: string): unknown {
	if (name in row) return row[name];
	const spaced = name.replace(/_/g, " ");
	if (spaced in row) return row[spaced];
	return undefined;
}

type CargoRow = { title?: Record<string, unknown> };

/**
 * Row objects from either recorded envelope (see `cache.ts`):
 *   api.php?action=cargoquery  -> { cargoquery: [{ title: {...} }], error? }
 *   Special:CargoExport        -> [ {...}, ... ]
 * Anything else is a payload this stage does not understand, and guessing at it
 * would be worse than failing: it would silently contribute no rows.
 */
function rowsOf(payload: CachedPayload, parsed: unknown): Record<string, unknown>[] {
	if (Array.isArray(parsed)) {
		return parsed.map((row, index) => {
			if (row === null || typeof row !== "object" || Array.isArray(row)) {
				throw new Error(`${payload.file}: row ${index} is not an object`);
			}
			return row as Record<string, unknown>;
		});
	}
	const body = parsed as { error?: { code?: string; info?: string }; cargoquery?: CargoRow[] };
	if (body.error) {
		throw new Error(`${payload.file}: the source returned an error (${body.error.code}): ${body.error.info ?? ""}`);
	}
	if (!Array.isArray(body.cargoquery)) {
		throw new Error(`${payload.file}: unrecognised payload — expected Cargo rows (an array) or \`cargoquery\``);
	}
	return body.cargoquery.map((row) => row.title ?? {});
}

function parse(payload: CachedPayload): Record<string, unknown>[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload.body);
	} catch (error) {
		throw new Error(`${payload.file}: not JSON (${(error as Error).message})`);
	}
	return rowsOf(payload, parsed);
}

/**
 * Collapse rows that describe the same thing, and refuse to pick between two
 * payloads that disagree about it.
 *
 * Overlapping payloads are normal for a crawl (a year window and a single-event
 * query both carry the same page). Disagreement is not: it means one payload is
 * stale, and choosing a winner would make the output depend on file order (spec
 * R7/R8). The error names both files so the stale one can be re-recorded.
 */
function dedupe<T extends { sourceFile: string }>(
	rows: T[],
	key: (row: T) => string,
	equal: (a: T, b: T) => boolean,
	what: string,
	conflict?: (seen: T, row: T, key: string) => string,
): T[] {
	const byKey = new Map<string, T>();
	for (const row of rows) {
		const k = key(row);
		const seen = byKey.get(k);
		if (seen === undefined) byKey.set(k, row);
		else if (!equal(seen, row)) {
			throw new Error(conflict ? conflict(seen, row, k) : `${what} ${JSON.stringify(k)}: ${seen.sourceFile} and ${row.sourceFile} disagree`);
		}
	}
	return [...byKey.values()];
}

/**
 * Structural equality that does not care about key order.
 *
 * A Cargo row's field order is an artifact of the `fields=` list the query asked for,
 * not a fact about the data: two payloads that requested the same columns in a
 * different order carry the same row. Comparing `JSON.stringify` directly would turn
 * that into a "one payload is stale" failure, which is the sort of false alarm that
 * teaches people to ignore the check.
 */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
		return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

/**
 * Two payloads may carry the same row; `sourceFile` is provenance, not data.
 * Comparing it too would make every overlapping crawl window look like a stale
 * disagreement, which is the one case deduplication exists to accept.
 */
const sameIgnoringSource = <T extends { sourceFile: string }>(a: T, b: T): boolean => {
	const { sourceFile: _seen, ...left } = a;
	const { sourceFile: _row, ...right } = b;
	return same(left, right);
};

/**
 * Tournaments rows from every cached payload, deduplicated by page.
 *
 * Two payloads may overlap (a year window and a single-event query), so the same
 * page arriving twice is normal and is collapsed. The same page arriving with
 * *different* values is not normal: it means one of the payloads is stale or they
 * disagree about the source, and picking a winner silently would make the output
 * depend on file order. That is a build failure naming both files.
 */
export function normalizeTournaments(payloads: CachedPayload[]): SourceEvent[] {
	const rows: SourceEvent[] = [];
	for (const payload of payloads) {
		for (const title of parse(payload)) {
			const overviewPage = asText(title.OverviewPage);
			if (overviewPage === "") {
				throw new Error(`${payload.file}: a tournament row without an OverviewPage cannot be identified`);
			}
			rows.push({
				name: asText(title.Name) || overviewPage,
				overviewPage,
				league: asText(title.League),
				region: asText(title.Region),
				dateStart: asDate(title.DateStart),
				sourceFile: payload.file,
			});
		}
	}
	const fields = (row: SourceEvent): Omit<SourceEvent, "sourceFile"> => {
		const { sourceFile: _sourceFile, ...rest } = row;
		return rest;
	};
	return dedupe(
		rows,
		(row) => row.overviewPage,
		(a, b) => same([a.name, a.league, a.region, a.dateStart], [b.name, b.league, b.region, b.dateStart]),
		"tournament page",
		(seen, row, page) =>
			`${page}: ${seen.sourceFile} and ${row.sourceFile} disagree about the same page ` +
			`(${JSON.stringify(fields(seen))} vs ${JSON.stringify(fields(row))})`,
	);
}

/** Team pages, deduplicated by page. `RenamedTo` must name a page this payload set also carries. */
export function normalizeTeams(payloads: CachedPayload[]): SourceTeam[] {
	const rows: SourceTeam[] = [];
	for (const payload of payloads) {
		for (const row of parse(payload)) {
			const page = asText(row.OverviewPage) || asText(row._pageName);
			if (page === "") throw new Error(`${payload.file}: a Teams row without an OverviewPage cannot be identified`);
			rows.push({
				page,
				name: asText(row.Name) || page,
				renamedTo: asText(row.RenamedTo),
				region: asText(row.Region),
				sourceFile: payload.file,
			});
		}
	}
	return dedupe(
		rows,
		(row) => row.page,
		(a, b) => same([a.name, a.renamedTo, a.region], [b.name, b.renamedTo, b.region]),
		"team page",
	);
}

/** `TeamRedirects` rows, deduplicated by (page, name). */
export function normalizeTeamNames(payloads: CachedPayload[]): SourceTeamName[] {
	const rows: SourceTeamName[] = [];
	for (const payload of payloads) {
		for (const row of parse(payload)) {
			const page = asText(row._pageName) || asText(row.OverviewPage);
			const allName = asText(row.AllName);
			if (page === "" || allName === "") throw new Error(`${payload.file}: a TeamRedirects row without a page and an AllName cannot be used`);
			rows.push({ page, allName, sourceFile: payload.file });
		}
	}
	return dedupe(rows, (row) => `${row.page}\u0000${row.allName}`, () => true, "team name");
}

/** `PlayerRedirects` rows, deduplicated by (page, name); the handle may differ per name. */
export function normalizePlayerNames(payloads: CachedPayload[]): SourcePlayerName[] {
	const rows: SourcePlayerName[] = [];
	for (const payload of payloads) {
		for (const row of parse(payload)) {
			const page = asText(row.OverviewPage) || asText(row._pageName);
			const allName = asText(row.AllName);
			if (page === "" || allName === "") throw new Error(`${payload.file}: a PlayerRedirects row without a page and an AllName cannot be used`);
			rows.push({ page, allName, id: asText(row.ID), sourceFile: payload.file });
		}
	}
	return dedupe(rows, (row) => `${row.page}\u0000${row.allName}`, (a, b) => a.id === b.id, "player name");
}

/** Champion registry rows, deduplicated by display name; one Riot id keeps one name. */
export function normalizeChampions(payloads: CachedPayload[]): SourceChampion[] {
	const rows: SourceChampion[] = [];
	for (const payload of payloads) {
		for (const row of parse(payload)) {
			const name = asText(row.Name);
			const riotKey = asInteger(raw(row, "KeyInteger"));
			if (name === "") throw new Error(`${payload.file}: a Champions row without a Name cannot be identified`);
			if (!Number.isInteger(riotKey) || riotKey <= 0) {
				throw new Error(`${payload.file}: champion ${name} has no usable KeyInteger (${JSON.stringify(raw(row, "KeyInteger"))}) — Riot's champion id is the identity`);
			}
			rows.push({ name, riotKey, sourceFile: payload.file });
		}
	}
	const byName = dedupe(rows, (row) => row.name, (a, b) => a.riotKey === b.riotKey, "champion");
	const byKey = new Map<number, SourceChampion>();
	for (const row of byName) {
		const seen = byKey.get(row.riotKey);
		if (seen !== undefined) {
			throw new Error(
				`Riot champion id ${row.riotKey} is claimed by two display names (${JSON.stringify(seen.name)} in ${seen.sourceFile}, ` +
					`${JSON.stringify(row.name)} in ${row.sourceFile}); one champion cannot have two current names`,
			);
		}
		byKey.set(row.riotKey, row);
	}
	return byName;
}

/** Player rows from games: one per player per game, kept as observations of identity. */
export function normalizeScoreboard(payloads: CachedPayload[]): SourceScoreboardRow[] {
	const rows: SourceScoreboardRow[] = [];
	for (const payload of payloads) {
		for (const row of parse(payload)) {
			rows.push({
				gameId: asText(raw(row, "GameId")),
				page: asText(row.OverviewPage),
				date: asDate(raw(row, "DateTime_UTC")),
				playerName: asText(row.Name),
				playerLink: asText(row.Link),
				team: asText(row.Team),
				opponent: asText(row.TeamVs),
				champion: asText(row.Champion),
				sourceFile: payload.file,
			});
		}
	}
	// `gameId` is part of the key because it decides whether the row is evidence at all
	// (a rejected event's row is not). Without it, an identity-only overlapping payload
	// whose file sorts first could replace a stat row and blank its GameId, which would
	// make the output depend on file order (R7/R8).
	return dedupe(
		rows,
		(row) => [row.gameId, row.page, row.date, row.playerLink, row.team, row.opponent, row.champion].join("\u0000"),
		() => true,
		"scoreboard row",
	);
}

/**
 * An integer field, or `null` when the source has no value. A value that is present
 * but not a number is a source change this stage does not understand, so it stops
 * rather than becoming an absence the reader would mistake for "never recorded".
 */
function optionalInteger(value: unknown, where: string): number | null {
	const text = asText(value);
	if (text === "") return null;
	const parsed = Number(text);
	if (!Number.isFinite(parsed)) throw new Error(`${where}: expected a number, got ${JSON.stringify(text)}`);
	return parsed;
}

/** `2023-10-10 07:17:00` -> `2023-10-10T07:17:00Z`; empty stays empty. */
function asIsoDateTime(value: unknown): string {
	const text = asText(value);
	const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(text);
	return match ? `${match[1]}T${match[2]}Z` : "";
}

/**
 * `Gamelength` (`mm:ss`, or `h:mm:ss`) as whole seconds.
 *
 * The exact value is this string: `Gamelength_Number` is float *minutes* (measured
 * 28.65 for `28:39`), which cannot round-trip `:39` and is therefore not used.
 */
function asDurationSeconds(value: unknown, where: string): number | null {
	const text = asText(value);
	if (text === "") return null;
	const parts = text.split(":");
	if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
		// Same rule as `optionalInteger`: a value that is present but not understood is a
		// source change, and turning it into an absence would make every duration in a
		// re-recorded corpus vanish quietly.
		throw new Error(`${where}: expected a Gamelength of mm:ss or h:mm:ss, got ${JSON.stringify(text)}`);
	}
	return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

/**
 * The patch as text. The column is numeric in the source (`13.19`, `5.4`) even though
 * `cargofields` reports `String`, and `PatchSort`/`LegacyPatch` add nothing: the source
 * cannot distinguish `4.10` from `4.1`, so this carries the digits it sent and never
 * pads or infers. An absent patch is an absent key, never an empty string.
 */
function asPatch(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	const text = asText(value);
	return text === "" ? null : text;
}

function gameSide(row: Record<string, unknown>, prefix: "Team1" | "Team2", where: string): SourceSide {
	const side = { team: asText(raw(row, prefix)) } as SourceSide;
	for (const [field, suffix] of TEAM_STAT_FIELDS) {
		side[field] = optionalInteger(raw(row, `${prefix}${suffix}`), `${where}: ${prefix}${suffix}`);
	}
	return side;
}

/** `ScoreboardGames` rows: one per game, deduplicated by the source's `GameId`. */
export function normalizeScoreboardGames(payloads: CachedPayload[]): SourceGame[] {
	const rows: SourceGame[] = [];
	for (const payload of payloads) {
		for (const row of parse(payload)) {
			const gameId = asText(raw(row, "GameId"));
			const page = asText(raw(row, "OverviewPage"));
			const matchId = asText(raw(row, "MatchId"));
			if (gameId === "" || page === "" || matchId === "") {
				throw new Error(`${payload.file}: a game row needs GameId, MatchId and OverviewPage (got ${JSON.stringify({ gameId, matchId, page })})`);
			}
			const dateTimeUtc = asIsoDateTime(raw(row, "DateTime_UTC"));
			rows.push({
				page,
				date: asDate(raw(row, "DateTime_UTC")),
				dateTimeUtc,
				gameId,
				matchId,
				winTeam: asText(raw(row, "WinTeam")),
				winnerSide: asInteger(raw(row, "Winner")),
				durationSeconds: asDurationSeconds(raw(row, "Gamelength"), `${payload.file}: ${gameId}: Gamelength`),
				patch: asPatch(raw(row, "Patch")),
				sides: [gameSide(row, "Team1", `${payload.file}: ${gameId}`), gameSide(row, "Team2", `${payload.file}: ${gameId}`)],
				picks: [draftNames(raw(row, "Team1Picks")), draftNames(raw(row, "Team2Picks"))],
				bans: [draftNames(raw(row, "Team1Bans")), draftNames(raw(row, "Team2Bans"))],
				riotPlatformGameId: asText(raw(row, "RiotPlatformGameId")),
				riotHash: asText(raw(row, "RiotHash")),
				sourceFile: payload.file,
			});
		}
	}
	return dedupe(
		rows,
		(row) => row.gameId,
		sameIgnoringSource,
		"game",
		(seen, row, id) => `${id}: ${seen.sourceFile} and ${row.sourceFile} disagree about the same game — one payload is stale`,
	);
}

/** `MatchSchedule` rows: one per series, deduplicated by the source's `MatchId`. */
export function normalizeMatches(payloads: CachedPayload[]): SourceMatch[] {
	const rows: SourceMatch[] = [];
	for (const payload of payloads) {
		for (const row of parse(payload)) {
			const matchId = asText(raw(row, "MatchId"));
			const page = asText(raw(row, "OverviewPage"));
			if (matchId === "" || page === "") {
				throw new Error(`${payload.file}: a match row needs MatchId and OverviewPage (got ${JSON.stringify({ matchId, page })})`);
			}
			const winner = asText(raw(row, "Winner"));
			rows.push({
				page,
				matchId,
				date: asDate(raw(row, "DateTime_UTC")),
				dateTimeUtc: asIsoDateTime(raw(row, "DateTime_UTC")),
				sides: [asText(raw(row, "Team1")), asText(raw(row, "Team2"))],
				winnerSide: winner === "" ? Number.NaN : Number(winner),
				bestOf: optionalInteger(raw(row, "BestOf"), `${payload.file}: ${matchId}: BestOf`),
				tab: asText(raw(row, "Tab")),
				patch: asPatch(raw(row, "Patch")),
				forfeit: Number(asText(raw(row, "FF"))) === 1,
				isNullified: asText(raw(row, "IsNullified")) === "1",
				seriesScore: [
					optionalInteger(raw(row, "Team1Score"), `${payload.file}: ${matchId}: Team1Score`),
					optionalInteger(raw(row, "Team2Score"), `${payload.file}: ${matchId}: Team2Score`),
				],
				sourceFile: payload.file,
			});
		}
	}
	return dedupe(
		rows,
		(row) => row.matchId,
		sameIgnoringSource,
		"match",
		(seen, row, id) => `${id}: ${seen.sourceFile} and ${row.sourceFile} disagree about the same series — one payload is stale`,
	);
}

const DRAFT_SLOTS = 5;

/** A source that grows past five slots is a change this stage must not silently drop. */
function checkDraftSlots(row: Record<string, unknown>, where: string): void {
	for (const key of Object.keys(row)) {
		const slot = /^Team[12](?:Pick|Ban)(\d+)$/.exec(key);
		if (slot === null) continue;
		const number = Number(slot[1]);
		if (!Number.isInteger(number) || number < 1 || number > DRAFT_SLOTS) {
			throw new Error(`${where}: draft slot ${JSON.stringify(key)} is outside 1..${DRAFT_SLOTS} — a source change cannot be dropped silently`);
		}
	}
}

/**
 * A timestamp the source states must be a real calendar instant, not merely
 * date-shaped: `2023-13-45 99:99:99` passes a prefix test and would then drive
 * date-sensitive identity resolution with an impossible day. An absent value stays
 * absent; a stated-but-blank one is a source anomaly and stops the build.
 */
function assertTimestamp(text: string, stated: boolean, where: string): void {
	if (text === "") {
		if (stated) throw new Error(`${where}: present but empty — a stated timestamp cannot become an undated observation`);
		return;
	}
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
	if (match === null) throw new Error(`${where}: ${JSON.stringify(text)} is not a timestamp`);
	const [, year, month, day, hour = "0", minute = "0", second = "0"] = match.map((part) => Number(part ?? 0));
	const months = [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	const valid =
		month >= 1 && month <= 12 && day >= 1 && day <= months[month - 1] && hour <= 23 && minute <= 59 && second <= 59;
	if (!valid) throw new Error(`${where}: ${JSON.stringify(text)} is not a real calendar instant`);
}

/**
 * The champion names in a Cargo list field, with the source's placeholder removed.
 *
 * `ScoreboardGames.Team*Picks`/`Team*Bans` use the same `None` for an unused slot as
 * `PicksAndBansS7` does (measured on one MSI 2023 ban list). Filtering it here as well
 * as in the ordered path matters twice over: otherwise the identity tables mint an
 * entity called `None`, and the unordered fallback can emit a "complete" draft that
 * contains it.
 */
function draftNames(value: unknown): string[] {
	return asList(value).filter((name) => !/^none$/i.test(name));
}

/** A comma-separated Cargo string is a list, not a free-text blob. */
function asNameList(value: unknown): string[] {
	if (Array.isArray(value)) return asList(value);
	return asText(value)
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");
}

/**
 * `ScoreboardPlayers` rows that carry statistics. The earlier identity-only fixture
 * queries name some of the same players, so a row with none of the stat keys is an
 * identity observation, not a second statement about the same player-game.
 */
const PLAYER_STAT_KEYS = [
	"Kills", "Deaths", "Assists", "CS", "Gold", "DamageToChampions", "VisionScore",
	"Items", "Trinket", "SummonerSpells", "KeystoneRune", "Runes", "Role", "IngameRole", "Side",
] as const;

export function normalizePlayerGames(payloads: CachedPayload[]): SourcePlayerGame[] {
	const rows: SourcePlayerGame[] = [];
	for (const payload of payloads) {
		for (const row of parse(payload)) {
			if (!PLAYER_STAT_KEYS.some((key) => key in row)) continue;
			const gameId = asText(raw(row, "GameId"));
			const playerLink = asText(raw(row, "Link"));
			if (gameId === "" || playerLink === "") {
				throw new Error(`${payload.file}: a player-game row needs GameId and Link (got ${JSON.stringify({ gameId, playerLink })})`);
			}
			const where = `${payload.file}: ${gameId}: ${playerLink}`;
			const sideText = asText(raw(row, "Side"));
			if (sideText !== "" && sideText !== "1" && sideText !== "2") {
				throw new Error(`${where}: Side ${JSON.stringify(sideText)} is neither 1 nor 2 — a source change cannot be read as an absent side`);
			}
			const dateText = asText(raw(row, "DateTime_UTC"));
			assertTimestamp(dateText, raw(row, "DateTime_UTC") !== undefined, `${where}: DateTime_UTC`);
			for (const field of ["Items", "SummonerSpells"] as const) {
				const value = raw(row, field);
				if (value !== undefined && value !== null && !Array.isArray(value) && asText(value) !== "") {
					throw new Error(`${where}: ${field} ${JSON.stringify(value)} is not a Cargo list — a source change cannot be read as a one-item list`);
				}
			}
			rows.push({
				gameId,
				date: asDate(raw(row, "DateTime_UTC")),
				playerLink,
				playerName: asText(raw(row, "Name")),
				team: asText(raw(row, "Team")),
				champion: asText(raw(row, "Champion")),
				side: sideText === "1" ? 1 : sideText === "2" ? 2 : null,
				role: asText(raw(row, "IngameRole")) || asText(raw(row, "Role")),
				kills: optionalInteger(raw(row, "Kills"), `${payload.file}: ${gameId}: ${playerLink}: Kills`),
				deaths: optionalInteger(raw(row, "Deaths"), `${payload.file}: ${gameId}: ${playerLink}: Deaths`),
				assists: optionalInteger(raw(row, "Assists"), `${payload.file}: ${gameId}: ${playerLink}: Assists`),
				cs: optionalInteger(raw(row, "CS"), `${payload.file}: ${gameId}: ${playerLink}: CS`),
				gold: optionalInteger(raw(row, "Gold"), `${payload.file}: ${gameId}: ${playerLink}: Gold`),
				damage: optionalInteger(raw(row, "DamageToChampions"), `${payload.file}: ${gameId}: ${playerLink}: DamageToChampions`),
				vision: optionalInteger(raw(row, "VisionScore"), `${payload.file}: ${gameId}: ${playerLink}: VisionScore`),
				items: asList(raw(row, "Items")),
				trinket: asText(raw(row, "Trinket")) || null,
				summonerSpells: asList(raw(row, "SummonerSpells")),
				keystone: asText(raw(row, "KeystoneRune")) || null,
				primaryTree: asText(raw(row, "PrimaryTree")) || null,
				secondaryTree: asText(raw(row, "SecondaryTree")) || null,
				runes: asNameList(raw(row, "Runes")),
				sourceFile: payload.file,
			});
		}
	}
	// Identical rows from different payloads are normal overlap and collapse. Two
	// rows from the SAME payload for the same (game, player) are a duplicate the
	// ticket says must fail — even when their bytes are identical.
	const byKey = new Map<string, SourcePlayerGame[]>();
	for (const row of rows) {
		const key = `${row.gameId}\u0000${row.playerLink}`;
		const seen = byKey.get(key) ?? [];
		if (seen.some((other) => other.sourceFile === row.sourceFile)) {
			throw new Error(`${row.gameId}: player ${row.playerLink} appears twice in ${row.sourceFile} — a duplicate row would double the player's contribution`);
		}
		seen.push(row);
		byKey.set(key, seen);
	}
	const result: SourcePlayerGame[] = [];
	for (const group of byKey.values()) {
		const first = group[0];
		for (const other of group.slice(1)) {
			if (!sameIgnoringSource(first, other)) {
				throw new Error(`${first.gameId}: player ${first.playerLink} has disagreeing rows in ${first.sourceFile} and ${other.sourceFile} — one payload is stale`);
			}
		}
		result.push(first);
	}
	return result;
}

/**
 * `PicksAndBansS7` rows: the ordered draft (R5). Slots are read as numbered fields,
 * so their order is a source fact rather than an inference from list position.
 */
export function normalizePicksAndBans(payloads: CachedPayload[]): SourceDraft[] {
	const rows: SourceDraft[] = [];
	const side = (row: Record<string, unknown>, prefix: "Team1" | "Team2"): SourceDraftSide => {
		const slots = (kind: "Pick" | "Ban"): DraftSlot[] => {
			const found: DraftSlot[] = [];
			for (let slot = 1; slot <= DRAFT_SLOTS; slot += 1) {
				const champion = asText(raw(row, `${prefix}${kind}${slot}`));
				// The source writes `None` for a slot that was never used (measured on one
				// MSI 2023 ban). It is a placeholder, not a champion, so the slot is absent —
				// inventing a `None` entity would put a fake pick in the draft.
				if (champion === "" || /^none$/i.test(champion)) continue;
				found.push({ slot, champion });
			}
			return found;
		};
		return { picks: slots("Pick"), bans: slots("Ban") };
	};
	for (const payload of payloads) {
		for (const row of parse(payload)) {
			const gameId = asText(raw(row, "GameId"));
			if (gameId === "") throw new Error(`${payload.file}: an ordered draft row without a GameId cannot be attached to a game`);
			checkDraftSlots(row, `${payload.file}: ${gameId}`);
			const switched = asText(raw(row, "SwitchedSides"));
			if (switched !== "" && switched !== "0" && switched !== "1") {
				throw new Error(`${payload.file}: ${gameId}: SwitchedSides ${JSON.stringify(switched)} is neither 0 nor 1 — a source change cannot be read as an absent flag`);
			}
			rows.push({
				gameId,
				switchedSides: switched === "1" ? 1 : switched === "0" ? 0 : null,
				sides: [side(row, "Team1"), side(row, "Team2")],
				sourceFile: payload.file,
			});
		}
	}
	return dedupe(
		rows,
		(row) => row.gameId,
		sameIgnoringSource,
		"ordered draft",
		(seen, row, id) => `${id}: ${seen.sourceFile} and ${row.sourceFile} disagree about the same ordered draft — one payload is stale`,
	);
}

/** Which normalizer reads which Cargo table. The cache layout names the table. */
const NORMALIZERS: Record<string, (payloads: CachedPayload[]) => unknown> = {
	Tournaments: normalizeTournaments,
	Teams: normalizeTeams,
	TeamRedirects: normalizeTeamNames,
	PlayerRedirects: normalizePlayerNames,
	Champions: normalizeChampions,
	ScoreboardPlayers: normalizeScoreboard,
	ScoreboardGames: normalizeScoreboardGames,
	MatchSchedule: normalizeMatches,
	PicksAndBansS7: normalizePicksAndBans,
};

/** The tables this pipeline can read, for error messages and tests. */
export const KNOWN_TABLES = Object.keys(NORMALIZERS).sort();

/**
 * Every cached payload, routed by its table directory into one source dataset.
 *
 * A table with no payload contributes an empty list — a build over fixtures that
 * only carry events is legal, and ticket 01 still passes. A payload whose table
 * has no normalizer stops the build: silently ignoring it would make a typo in a
 * `--tables` value look like "the source had no rows".
 */
export function normalizeSources(payloads: CachedPayload[]): SourceDataset {
	const byTable = new Map<string, CachedPayload[]>();
	for (const payload of payloads) {
		const unknown = !(payload.table in NORMALIZERS);
		if (unknown) {
			throw new Error(
				`${payload.file}: table ${JSON.stringify(payload.table)} has no normalizer — ` +
					`add one to normalize.ts rather than leaving the payload unread (known: ${KNOWN_TABLES.join(", ")})`,
			);
		}
		const group = byTable.get(payload.table);
		if (group === undefined) byTable.set(payload.table, [payload]);
		else group.push(payload);
	}
	const group = (table: string): CachedPayload[] => byTable.get(table) ?? [];
	return {
		tournaments: normalizeTournaments(group("Tournaments")),
		teams: normalizeTeams(group("Teams")),
		teamNames: normalizeTeamNames(group("TeamRedirects")),
		playerNames: normalizePlayerNames(group("PlayerRedirects")),
		champions: normalizeChampions(group("Champions")),
		scoreboard: normalizeScoreboard(group("ScoreboardPlayers")),
		games: normalizeScoreboardGames(group("ScoreboardGames")),
		matches: normalizeMatches(group("MatchSchedule")),
		drafts: normalizePicksAndBans(group("PicksAndBansS7")),
		playerGames: normalizePlayerGames(group("ScoreboardPlayers")),
	};
}
