// eras: which fields could exist when a game was played, and therefore what
// "complete" is allowed to mean for that game (spec R6, decision D4).
//
// The problem this solves is measured, not hypothetical. `ScoreboardGames` answers
// `null` for `Team1VoidGrubs` on every 2023 row and for `Team1Clouds` on every 2015
// row, because those objectives did not exist yet — and it also answers `null` for
// `Team1Inhibitors` on every 2015 row, because the wiki simply did not record it.
// Those two nulls mean different things, and a coverage marker that cannot tell them
// apart marks all history `partial` and catches nothing.
//
// So a field is judged only if it was eligible in the game's era. `Inhibitors` is
// eligible in every era, which is why a 2015 game stays `partial` forever: not a
// defect, a fact about the source. `VoidGrubs` is ineligible before 2024-01-10, so a
// 2023 game with no void grubs is not penalised for it.
//
// The dates are declared from outside this dataset — the wiki's own patch pages, cited
// per boundary — never inferred from the corpus. Inferring them would make the one
// assertion worth making ("no game before an era's `from` carries a field that era
// declares ineligible") true by construction; `test/games.test.ts` makes it instead.

import { readFile } from "node:fs/promises";
import * as path from "node:path";

/** The field groups a record can declare coverage for. Only `team-stats` is filled today. */
export const ERA_GROUPS = ["team-stats", "player-stats", "draft"] as const;
export type EraGroup = (typeof ERA_GROUPS)[number];

export type Era = {
	/** Stable label, carried on every record the era applies to ("which era it is in"). */
	id: string;
	/** First UTC date the era governs, `YYYY-MM-DD`. */
	from: string;
	/** Where the boundary comes from: a patch version, a date and a source. */
	cites: string;
	/** The field names that could hold a value in this era. */
	eligible: string[];
};

export type EraTable = {
	/** Reserved for a migration: bump it when the meaning of an era changes, not the data. */
	version: number;
	groups: Record<EraGroup, Era[]>;
};

export const DEFAULT_ERA_FILE = path.join(import.meta.dirname, "rules", "game-eras.json");

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type Coverage = "complete" | "partial" | "unavailable";

/**
 * Parse and validate the committed table. Validation is strict on purpose: a table
 * that silently lost an era, or listed a date out of order, would mislabel every
 * record after the mistake and nothing else would notice.
 */
export function parseEraTable(parsed: unknown, where: string): EraTable {
	if (parsed === null || typeof parsed !== "object") throw new Error(`${where}: expected an object`);
	const body = parsed as Record<string, unknown>;
	if (!Number.isInteger(body.version)) throw new Error(`${where}: \`version\` must be an integer`);
	if (body.groups === null || typeof body.groups !== "object") throw new Error(`${where}: expected a \`groups\` object`);

	const groups = {} as Record<EraGroup, Era[]>;
	const seenIds = new Set<string>();
	for (const group of ERA_GROUPS) {
		const value = (body.groups as Record<string, unknown>)[group];
		if (value === undefined) throw new Error(`${where}: group ${JSON.stringify(group)} is missing — declare it even when empty`);
		if (!Array.isArray(value)) throw new Error(`${where}: group ${JSON.stringify(group)} must be an array`);
		const eras: Era[] = [];
		for (const [index, entry] of value.entries()) {
			const at = `${where}: ${group}[${index}]`;
			if (entry === null || typeof entry !== "object") throw new Error(`${at}: expected an object`);
			const era = entry as Record<string, unknown>;
			if (typeof era.id !== "string" || era.id.trim() === "") throw new Error(`${at}: \`id\` must be a non-empty string`);
			const id = era.id.trim();
			if (seenIds.has(id)) throw new Error(`${at}: era id ${JSON.stringify(id)} is used twice; a record names its era by id`);
			seenIds.add(id);
			if (typeof era.from !== "string" || !DATE.test(era.from)) throw new Error(`${at}: \`from\` must be a YYYY-MM-DD date`);
			if (typeof era.cites !== "string" || era.cites.trim() === "") {
				throw new Error(`${at}: \`cites\` must say where the boundary comes from, as the event rule requires a reason`);
			}
			if (!Array.isArray(era.eligible) || era.eligible.length === 0) throw new Error(`${at}: \`eligible\` must list at least one field`);
			const eligible: string[] = [];
			for (const field of era.eligible) {
				if (typeof field !== "string" || field.trim() === "") throw new Error(`${at}: \`eligible\` holds a non-string field name`);
				if (eligible.includes(field)) throw new Error(`${at}: field ${JSON.stringify(field)} is listed twice`);
				eligible.push(field);
			}
			const previous = eras[eras.length - 1];
			if (previous !== undefined && previous.from >= era.from) {
				throw new Error(`${at}: eras must be in ascending date order and never share a date (${previous.from} then ${era.from})`);
			}
			eras.push({ id, from: era.from, cites: era.cites.trim(), eligible });
		}
		groups[group] = eras;
	}
	return { version: body.version as number, groups };
}

export async function loadEraTable(file: string = DEFAULT_ERA_FILE): Promise<EraTable> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		throw new Error(`${file}: cannot read the era table (${(error as Error).message})`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${file}: not JSON (${(error as Error).message})`);
	}
	return parseEraTable(parsed, file);
}

/**
 * The era governing `date` in `group`.
 *
 * A date before the first era is a build error rather than a silent `undefined`:
 * it means the game predates the declared floor, and guessing an era there would
 * be exactly the fabrication the field-level rule exists to prevent.
 */
export function eraOn(table: EraTable, group: EraGroup, date: string): Era {
	if (!DATE.test(date)) throw new Error(`era lookup needs a YYYY-MM-DD date, got ${JSON.stringify(date)}`);
	const eras = table.groups[group];
	if (eras.length === 0) throw new Error(`no eras are declared for group ${JSON.stringify(group)}`);
	let found: Era | undefined;
	for (const era of eras) {
		if (era.from <= date) found = era;
		else break;
	}
	if (found === undefined) {
		throw new Error(`${date} precedes the first declared ${group} era (${eras[0].from}); the era table does not cover this game`);
	}
	return found;
}

/**
 * Which of an era's eligible fields a record actually carries.
 *
 * `both` is what a reader would call complete — the field is stated for each side —
 * while `any` is what exists at all. Keeping the two apart is what stops a half-empty
 * game from being reported as if the source had recorded nothing.
 */
export type FieldPresence = { both: ReadonlySet<string>; any: ReadonlySet<string> };

/**
 * How covered one field group is, judged only against fields that could hold a value
 * in that era.
 *
 * `complete` needs both sides; `unavailable` needs the whole group empty on both sides.
 * Everything in between is `partial`, including the asymmetrical case of one side
 * populated and the other blank — that is the half-empty game R6 says must not be
 * hidden, and calling it `unavailable` would be the lie the marker exists to prevent.
 */
export function coverageOf(era: Era, presence: FieldPresence): Coverage {
	let both = 0;
	let any = 0;
	for (const field of era.eligible) {
		if (presence.both.has(field)) both += 1;
		if (presence.any.has(field)) any += 1;
	}
	if (both === era.eligible.length) return "complete";
	if (any === 0) return "unavailable";
	return "partial";
}
