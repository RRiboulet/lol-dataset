// formats: games the source records without a pick-ban phase.
//
// The full crawl surfaced a game shape the two-event rehearsal never saw. The 2020
// Mid-Season Cup played **game one of every best-of-five in blind pick** (declared by
// Riot in the tournament format, reported 2020-05-23; the wiki's event page states it),
// which the source records in exactly three ways at once: no `PicksAndBansS7` row, no
// ban on either side, and — legal only in blind pick — the same champion on both sides
// (`Semifinals_1_1` and `Finals_1_1` both have Varus on both teams; impossible in a
// draft, ordinary in blind pick).
//
// The dataset could absorb that by weakening the "one champion plays once per game"
// invariant, but then it could no longer tell a legitimate blind pick from a corrupted
// row. It could also drop the draft, but that is the lie R6 exists to prevent. So the
// format is **declared**, the way the era boundaries and the identity aliases are: the
// game id pattern names the games, `cites` says where the claim comes from, and the
// build refuses a declaration that contradicts the rows it covers (a blind pick that
// states bans, or a declaration that matches no game of an event the corpus carries).
//
// Nothing here is inferred from absence. A game with no bans and no `PicksAndBansS7`
// row is indistinguishable from an early-era game whose bans the wiki never recorded —
// measured: IEM Season IX 2015 states three bans a side and has no ordered row — so
// only a declaration can say which one it is.

import { readFile } from "node:fs/promises";
import * as path from "node:path";

/** One declared set of games played without pick-ban. */
export type BlindPickRule = {
	/** The event's overview page, exactly as the event record carries it. */
	overviewPage: string;
	/** Regular expression the source `GameId` must match (the source's own id, not a surrogate). */
	gameIdPattern: string;
	/** Where the claim comes from, as a patch citation is required to. */
	cites: string;
};

/**
 * A champion the source states twice in one draft, in a way the draft rules forbid.
 *
 * Measured three times in the full crawl, in two shapes:
 *
 *   - a side bans a champion it also picks (Season 3 World Championship `Day 6_2_1`:
 *     Twisted Fate; IEM Season VII `Group A_5_1`: Lee Sin). The player rows state each
 *     player's champion and match the pick list exactly, so the pick is the doubly stated
 *     half and the ban entry is the one nothing corroborates: `drop: "bans"`.
 *   - the same champion is picked by **both** sides in a game with no bans (IEM Season VII
 *     `Group A_6_1`: Lee Sin). That is legal only in blind pick, and this game is not one;
 *     the player rows corroborate each side, so neither statement can be set aside:
 *     `drop: "both-picks"` refuses to assert an impossible fact and marks the draft partial.
 *
 * Either way the entry is dropped, declared here with its evidence, and the coverage marker
 * becomes `partial` — the source's own draft is incomplete, which is what the marker is for.
 */
export type ContradictedDraftRule = {
	/** The event's overview page, exactly as the event record carries it. */
	overviewPage: string;
	/** Regular expression the source `GameId` must match. */
	gameIdPattern: string;
	/** The source champion string stated twice. */
	champion: string;
	/** Which statement is set aside, and why the other one (or neither) is not. */
	drop: "bans" | "both-picks";
	/** Where the claim comes from, and what corroborates the kept half. */
	cites: string;
};

export type GameFormats = {
	/** Bumped when the meaning of a declaration changes, not when the data does. */
	version: number;
	blindPick: BlindPickRule[];
	contradictedDrafts: ContradictedDraftRule[];
};

export const DEFAULT_FORMAT_FILE = path.join(import.meta.dirname, "rules", "game-formats.json");

const KEYS = new Set(["overviewPage", "gameIdPattern", "cites"]);
const DRAFT_KEYS = new Set(["overviewPage", "gameIdPattern", "champion", "drop", "cites"]);
const DROP_VALUES = new Set(["bans", "both-picks"]);

/**
 * Parse and validate the committed declarations.
 *
 * Strict for the same reason the era table is: a declaration that silently stopped
 * matching would turn a blind-pick game back into a contradiction the build cannot
 * represent, and a pattern that does not compile would only fail when a game reached
 * it. Unknown keys are refused too — `gameidPattern` would otherwise be ignored and
 * the rule would match everything.
 */
export function parseGameFormats(parsed: unknown, where: string): GameFormats {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${where}: expected an object`);
	const body = parsed as Record<string, unknown>;
	for (const key of Object.keys(body)) {
		if (key !== "version" && key !== "$comment" && key !== "blindPick" && key !== "contradictedDrafts") {
			throw new Error(`${where}: unknown field ${JSON.stringify(key)}`);
		}
	}
	if (!Number.isInteger(body.version)) throw new Error(`${where}: \`version\` must be an integer`);
	if (!Array.isArray(body.blindPick)) throw new Error(`${where}: \`blindPick\` must be an array — declare it empty when no event has one`);

	const seen = new Set<string>();
	const blindPick: BlindPickRule[] = [];
	for (const [index, entry] of body.blindPick.entries()) {
		const at = `${where}: blindPick[${index}]`;
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${at}: expected an object`);
		const record = entry as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			if (!KEYS.has(key)) throw new Error(`${at}: unknown field ${JSON.stringify(key)}`);
		}
		if (typeof record.overviewPage !== "string" || record.overviewPage.trim() === "") {
			throw new Error(`${at}: \`overviewPage\` must be the event's page, as a non-empty string`);
		}
		if (typeof record.gameIdPattern !== "string" || record.gameIdPattern === "") {
			throw new Error(`${at}: \`gameIdPattern\` must be a non-empty regular expression`);
		}
		const overviewPage = record.overviewPage.trim();
		try {
			new RegExp(record.gameIdPattern, "u");
		} catch (error) {
			throw new Error(`${at}: \`gameIdPattern\` is not a regular expression (${(error as Error).message})`);
		}
		if (typeof record.cites !== "string" || record.cites.trim() === "") {
			throw new Error(`${at}: \`cites\` must say where the claim comes from`);
		}
		const key = `${overviewPage}\u0000${record.gameIdPattern}`;
		if (seen.has(key)) throw new Error(`${at}: the same page and pattern are declared twice`);
		seen.add(key);
		blindPick.push({ overviewPage, gameIdPattern: record.gameIdPattern, cites: record.cites.trim() });
	}
	const declared = body.contradictedDrafts ?? [];
	if (!Array.isArray(declared)) {
		throw new Error(`${where}: \`contradictedDrafts\` must be an array — declare it empty when no game needs one`);
	}
	const contradictedDrafts: ContradictedDraftRule[] = [];
	const seenDrafts = new Set<string>();
	for (const [index, entry] of declared.entries()) {
		const at = `${where}: contradictedDrafts[${index}]`;
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${at}: expected an object`);
		const record = entry as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			if (!DRAFT_KEYS.has(key)) throw new Error(`${at}: unknown field ${JSON.stringify(key)}`);
		}
		if (typeof record.overviewPage !== "string" || record.overviewPage.trim() === "") {
			throw new Error(`${at}: \`overviewPage\` must be the event's page, as a non-empty string`);
		}
		if (typeof record.gameIdPattern !== "string" || record.gameIdPattern === "") {
			throw new Error(`${at}: \`gameIdPattern\` must be a non-empty regular expression`);
		}
		try {
			new RegExp(record.gameIdPattern, "u");
		} catch (error) {
			throw new Error(`${at}: \`gameIdPattern\` is not a regular expression (${(error as Error).message})`);
		}
		if (typeof record.champion !== "string" || record.champion.trim() === "") {
			throw new Error(`${at}: \`champion\` must be the source string stated twice`);
		}
		if (typeof record.drop !== "string" || !DROP_VALUES.has(record.drop)) {
			throw new Error(`${at}: \`drop\` must be "bans" or "both-picks"`);
		}
		if (typeof record.cites !== "string" || record.cites.trim() === "") {
			throw new Error(`${at}: \`cites\` must say where the claim comes from`);
		}
		const overviewPage = record.overviewPage.trim();
		const champion = record.champion.trim();
		const key = `${overviewPage}\u0000${record.gameIdPattern}\u0000${champion}`;
		if (seenDrafts.has(key)) throw new Error(`${at}: the same page, pattern and champion are declared twice`);
		seenDrafts.add(key);
		contradictedDrafts.push({
			overviewPage,
			gameIdPattern: record.gameIdPattern,
			champion,
			drop: record.drop as ContradictedDraftRule["drop"],
			cites: record.cites.trim(),
		});
	}
	return { version: body.version as number, blindPick, contradictedDrafts };
}

export async function loadGameFormats(file: string = DEFAULT_FORMAT_FILE): Promise<GameFormats> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		throw new Error(`${file}: cannot read the game formats (${(error as Error).message})`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${file}: not JSON (${(error as Error).message})`);
	}
	return parseGameFormats(parsed, file);
}

/** The champion drops each contradicted-draft declaration applies to this game. */
export function contradictedDraftsFor(formats: GameFormats, overviewPage: string, gameId: string): ContradictedDraftRule[] {
	return formats.contradictedDrafts.filter(
		(rule) => rule.overviewPage === overviewPage && new RegExp(rule.gameIdPattern, "u").test(gameId),
	);
}

/** The declaration covering this game, or `undefined` when it had a pick-ban phase. */
export function blindPickFor(formats: GameFormats, overviewPage: string, gameId: string): BlindPickRule | undefined {
	return formats.blindPick.find(
		(rule) => rule.overviewPage === overviewPage && new RegExp(rule.gameIdPattern, "u").test(gameId),
	);
}
