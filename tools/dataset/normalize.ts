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
//     They are carried verbatim (spec R7): decoding would rewrite the source's own
//     string, and exact matching against the registry works precisely because both
//     sides carry the same bytes.

import type { CachedPayload } from "./cache.ts";

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

/** Everything the stages below the cache hand to `assemble` / `identity`. */
export type SourceDataset = {
	tournaments: SourceEvent[];
	teams: SourceTeam[];
	teamNames: SourceTeamName[];
	playerNames: SourcePlayerName[];
	champions: SourceChampion[];
	scoreboard: SourceScoreboardRow[];
};

/** Cargo returns list-typed fields as arrays; everything else as strings. */
function asText(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (Array.isArray(value)) return value.map((item) => asText(item)).filter((item) => item !== "").join(", ");
	return String(value).trim();
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

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

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
	return dedupe(
		rows,
		(row) => [row.page, row.date, row.playerLink, row.team, row.opponent, row.champion].join("\u0000"),
		() => true,
		"scoreboard row",
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
	};
}
