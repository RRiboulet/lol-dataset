// identity: what a source string is, and what a canonical ID is derived from.
//
// Spec D3 is the constraint everything here serves: a canonical ID is a surrogate
// derived from the entity's **source identity**, never from its display string and
// never from a row counter. What that source identity actually *is* differs per
// entity kind, and each answer below was measured on the recorded payloads in
// `fixtures/raw` rather than assumed:
//
//   team      the wiki team page (`Teams.OverviewPage`). A rebrand is a new page
//             linked by `Teams.RenamedTo`, not a moved page — measured: SK Telecom
//             T1 (page id 196774, `RenamedTo=T1`) and T1 (page id 294322) are two
//             pages, so the page alone is *not* stable across a rebrand. One
//             entity is therefore the whole rename chain, and its ID is anchored
//             on the chain's **root** (the page nothing renames into). A future
//             rebrand appends to the chain and leaves the ID alone, which is why
//             the anchor is the root and not the current page.
//   player    the wiki player page (`PlayerRedirects.OverviewPage`, carried by
//             `ScoreboardPlayers.Link`). Handle changes survive because the old
//             page or old handle is a `PlayerRedirects` row pointing at the page:
//             measured, `LEE` -> page `Hojin`, `Knight9`/`ZHUO` -> page
//             `Knight (Zhuo Ding)`, `Sneakymonster` -> `Sneaky (Chris Esser)`. The
//             handle is a display string, so it lives in the alias table.
//   champion  Riot's numeric champion id (`Champions.KeyInteger`; 20 = Nunu). The
//             display name cannot serve: the wiki rewrites it retroactively —
//             measured, a 2012-11-29 row and a 2011-06-18 row both already say
//             `Nunu &amp; Willump`, years before Riot renamed the champion — and
//             there is no redirect table for champions (the export endpoint answers
//             `Table ChampionRedirects not found`), while `KeyDdragon` is empty for
//             every champion. A Riot rename therefore cannot mint a second entity,
//             and the retired display string has to be declared by hand in
//             `rules/identity-aliases.json`.
//
// What the identity cannot be: the display string (it changes), the payload it
// arrived in or its position in one (adding an earlier event must not renumber —
// every ID here is a hash of an anchor, so it never depends on read order), and
// `_pageID` (it survives a page *move*, but a rebrand creates a new page: SKT and
// T1 have different page ids and one identity).
//
// The team anchor has one known failure mode, stated rather than hidden: a newly
// discovered *earlier* page in a rename chain would move the chain's root and so
// re-ID that one team. Renames go forward in time, so growth appends to the chain
// and leaves the anchor alone; a backward correction is a source fix, not a rename,
// and it is the only thing in this scheme that can renumber an existing entity.
//
// Resolution order is fixed by the ticket: exact source identity, then the alias
// table, then a new entity that is reported. The tiers are tried in that order, so a
// string that is one entity's own identity and another's redirect name resolves to
// the first — the alias table never overrides a registry's own statement. Case is
// folded only as the last step before minting, and a folded match naming more than
// one entity is an error, never a pick. Measured reason: the wiki's own `AllName` rows disagree with the
// scoreboard's casing (`sOAZ` vs `SOAZ`, `kujaa` vs `Kujaa`, `Yellowstar` vs
// `YellOwStaR`), so exact-only matching would mint a duplicate of a player the
// source already knows. A silent *merge* is what must never happen, so ambiguity is
// reported with its candidates and mints nothing.
//
// Every emitted record carries the entity's display name beside its ID (spec R12):
// the entity files do, and so does every alias row, so a reader joins on an ID
// without having to decode it.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import type {
	SourceChampion,
	SourceDataset,
	SourcePlayerName,
	SourceScoreboardRow,
	SourceTeam,
	SourceTeamName,
} from "./normalize.ts";

export type EntityKind = "team" | "player" | "champion";

/** The kinds in a fixed order, so error text and iteration do not depend on insertion. */
export const ENTITY_KINDS: readonly EntityKind[] = ["team", "player", "champion"];

/** `<prefix>-` + 12 hex of the anchor. Opaque on purpose; read the row through `name`. */
export function surrogateId(prefix: string, anchor: string): string {
	return `${prefix}-${createHash("sha256").update(anchor).digest("hex").slice(0, 12)}`;
}

export type TeamRecord = {
	id: string;
	/** The current display name from the registry, so the row reads without decoding the ID. */
	name: string;
	/** The current page. Null only for an entity minted from a string no registry carries. */
	overviewPage: string | null;
	/** The source's region string, verbatim; empty when the source records none. */
	region: string;
};

export type PlayerRecord = {
	id: string;
	/** The current handle. */
	name: string;
	/** The player page. Null only for an entity minted from an unresolved string. */
	overviewPage: string | null;
};

export type ChampionRecord = {
	id: string;
	/** The current display name, verbatim (the source carries HTML entities; see normalize.ts). */
	name: string;
	/** Riot's numeric champion id. Null only for an entity minted from an unresolved string. */
	riotKey: number | null;
};

/**
 * Where a string's mapping to an entity comes from. Not the same thing as the era:
 * `firstSeen`/`lastSeen` below say *when*, this says *why we believe it*.
 */
export type AliasEvidence = "registry" | "rename" | "redirect" | "handle" | "observed" | "declared";

const EVIDENCE_ORDER: readonly AliasEvidence[] = ["registry", "rename", "redirect", "handle", "observed", "declared"];

export type AliasRecord = {
	kind: EntityKind;
	/** The source string, verbatim. Two rows may share it when it names two entities. */
	string: string;
	entityId: string;
	/** The entity's current display name, so the row reads without a join (spec R12). */
	entityName: string;
	/**
	 * The window in which this string is known to have been used. Observed use in
	 * the recorded corpus where it appears there, otherwise the window a declared
	 * alias states. Null means "not known", not "not used".
	 */
	firstSeen: string | null;
	lastSeen: string | null;
	evidence: AliasEvidence[];
};

export type UnresolvedReason = "no-source-identity" | "ambiguous";

export type UnresolvedRecord = {
	kind: EntityKind;
	/** The source string that resolved to nothing, verbatim. */
	string: string;
	/** The minted entity's display name (the string itself) or the string, for an ambiguity. */
	name: string;
	/** The minted entity, or null for an ambiguity, where minting would hide the problem. */
	id: string | null;
	firstSeen: string | null;
	lastSeen: string | null;
	reason: UnresolvedReason;
	/** For `ambiguous`, the entities the string could mean, sorted. Empty otherwise. */
	candidates: string[];
};

/** A resolved string, for the stages that join entities into rows (tickets 03-05). */
export type Resolution = {
	kind: EntityKind;
	id: string;
	/** The entity's display name, so a caller never emits a bare ID (spec R12). */
	name: string;
	via: "identity" | "alias";
};

/** Several entities answer to one string with nothing to choose between them. */
export class AmbiguousIdentity extends Error {
	kind: EntityKind;
	string: string;
	candidates: Resolution[];

	constructor(kind: EntityKind, string: string, candidates: Resolution[]) {
		const named = candidates.map((candidate) => `${candidate.id} (${candidate.name})`).join(", ");
		super(
			`${kind} ${JSON.stringify(string)} names more than one entity: ${named}. ` +
				"Pass the date the source used it, or declare the intended entity in rules/identity-aliases.json — " +
				"merging two entities on a shared display string is exactly what this module must not do.",
		);
		this.name = "AmbiguousIdentity";
		this.kind = kind;
		this.string = string;
		this.candidates = candidates;
	}
}

/** Lookup without minting: null means "no entity, the caller decides". */
export type IdentityIndex = {
	resolve(kind: EntityKind, source: string, date?: string): Resolution | null;
};

export type AssembledIdentity = {
	teams: TeamRecord[];
	players: PlayerRecord[];
	champions: ChampionRecord[];
	aliases: AliasRecord[];
	unresolved: UnresolvedRecord[];
	index: IdentityIndex;
};

/**
 * A rename the source does not record, declared as data (like the event rule).
 *
 * The champion case is why this file exists: the wiki has no champion redirect
 * table and normalizes retired champion names retroactively, so the only way a
 * retired string can resolve to its entity is a declaration someone reviewed.
 */
export type DeclaredAlias = {
	kind: EntityKind;
	string: string;
	/** Which entity the string denotes: a page for team/player, Riot's id for a champion. */
	page?: string;
	riotKey?: number;
	/** The declared era, used only where the corpus never dates the string itself. */
	from?: string | null;
	until?: string | null;
	reason: string;
};

export const DEFAULT_ALIAS_FILE = path.join(import.meta.dirname, "rules", "identity-aliases.json");

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The committed alias declarations, validated.
 *
 * `reason` is mandatory for the same reason the event rule's overrides require one:
 * the file records human judgement, so it has to say what the judgement was.
 */
export async function loadDeclaredAliases(file: string = DEFAULT_ALIAS_FILE): Promise<DeclaredAlias[]> {
	const parsed = JSON.parse(await readFile(file, "utf8")) as { aliases?: unknown };
	if (!Array.isArray(parsed.aliases)) throw new Error(`${file}: expected an \`aliases\` array`);
	const aliases: DeclaredAlias[] = [];
	for (const [index, entry] of parsed.aliases.entries()) {
		const where = `${file}: aliases[${index}]`;
		if (entry === null || typeof entry !== "object") throw new Error(`${where}: expected an object`);
		const alias = entry as Record<string, unknown>;
		const kind = alias.kind;
		if (kind !== "team" && kind !== "player" && kind !== "champion") {
			throw new Error(`${where}: kind must be team, player or champion (got ${JSON.stringify(kind)})`);
		}
		const string = typeof alias.string === "string" ? alias.string.trim() : "";
		if (string === "") throw new Error(`${where}: string must be a non-empty source string`);
		const reason = typeof alias.reason === "string" ? alias.reason.trim() : "";
		if (reason === "") throw new Error(`${where}: a declared alias must state its reason`);
		for (const bound of ["from", "until"] as const) {
			const value = alias[bound];
			if (value === undefined || value === null) continue;
			if (typeof value !== "string" || !DATE.test(value)) throw new Error(`${where}: ${bound} must be a YYYY-MM-DD date or null`);
		}
		const declared: DeclaredAlias = { kind, string, reason };
		if (kind === "champion") {
			if (!Number.isInteger(alias.riotKey) || (alias.riotKey as number) <= 0) {
				throw new Error(`${where}: a champion alias needs Riot's numeric riotKey, not a display name`);
			}
			declared.riotKey = alias.riotKey as number;
		} else {
			if (typeof alias.page !== "string" || alias.page.trim() === "") {
				throw new Error(`${where}: a ${kind} alias needs the target \`page\``);
			}
			declared.page = alias.page.trim();
		}
		declared.from = (alias.from as string | null | undefined) ?? null;
		declared.until = (alias.until as string | null | undefined) ?? null;
		aliases.push(declared);
	}
	return aliases;
}

type Tier = "identity" | "alias";

type Era = { first: string | null; last: string | null };

const KIND_PREFIX: Record<EntityKind, string> = { team: "tm", player: "pl", champion: "ch" };

/** `lowercase` is the whole fold: no Unicode normalisation, because that would merge spellings. */
function fold(text: string): string {
	return text.toLowerCase();
}

function add<T>(map: Map<string, Set<T>>, key: string, value: T): void {
	const set = map.get(key);
	if (set === undefined) map.set(key, new Set([value]));
	else set.add(value);
}

export function assembleIdentity(sources: SourceDataset, declaredAliases: DeclaredAlias[] = []): AssembledIdentity {
	const key2 = (kind: EntityKind, string: string): string => `${kind}\u0000${string}`;
	const key3 = (kind: EntityKind, string: string, id: string): string => `${kind}\u0000${string}\u0000${id}`;

	/** Strings the source's registries state as an entity's own identity. */
	const identityStrings = new Map<string, Set<string>>();
	/** Strings that point at an entity without being its own identity (old pages, handles, declarations). */
	const aliasStrings = new Map<string, Set<string>>();
	/** The union, keyed case-folded: the last resort before minting, and never on its own. */
	const foldedStrings = new Map<string, Set<string>>();
	const evidence = new Map<string, Set<AliasEvidence>>();
	const observed = new Map<string, Era>();
	const declaredEras = new Map<string, Era>();
	const names = new Map<string, string>();

	const register = (kind: EntityKind, source: string, id: string, tier: Tier, why: AliasEvidence): void => {
		const string = source.trim();
		if (string === "") return;
		add(tier === "identity" ? identityStrings : aliasStrings, key2(kind, string), id);
		add(foldedStrings, key2(kind, fold(string)), id);
		add(evidence, key3(kind, string, id), why);
	};

	const eraOf = (kind: EntityKind, string: string, id: string): Era | null => {
		return observed.get(key3(kind, string, id)) ?? declaredEras.get(key3(kind, string, id)) ?? null;
	};

	const resolution = (kind: EntityKind, id: string): Resolution => ({
		kind,
		id,
		name: names.get(id) ?? id,
		via: "identity",
	});

	const named = (kind: EntityKind, ids: Iterable<string>): Resolution[] => [...ids].sort().map((id) => resolution(kind, id));

	const pick = (kind: EntityKind, string: string, ids: Set<string>, date: string | undefined): Resolution => {
		if (ids.size === 1) return resolution(kind, [...ids][0]);
		const candidates = named(kind, ids);
		if (date !== undefined && DATE.test(date)) {
			const inside = candidates.filter((candidate) => {
				const era = eraOf(kind, string, candidate.id);
				if (era === null || (era.first === null && era.last === null)) return false; // unknown is not evidence
				const after = era.first === null || era.first <= date;
				const before = era.last === null || date <= era.last;
				return after && before;
			});
			if (inside.length === 1) return inside[0];
		}
		throw new AmbiguousIdentity(kind, string, candidates);
	};

	const lookup = (kind: EntityKind, source: string, date?: string): Resolution | null => {
		const string = source.trim();
		if (string === "") return null;
		const exactIdentity = identityStrings.get(key2(kind, string));
		if (exactIdentity !== undefined && exactIdentity.size > 0) return pick(kind, string, exactIdentity, date);
		const exactAlias = aliasStrings.get(key2(kind, string));
		if (exactAlias !== undefined && exactAlias.size > 0) {
			const found = pick(kind, string, exactAlias, date);
			return { ...found, via: "alias" };
		}
		const folded = foldedStrings.get(key2(kind, fold(string)));
		if (folded !== undefined && folded.size > 0) {
			const found = pick(kind, string, folded, date);
			return { ...found, via: "alias" };
		}
		return null;
	};

	// ---- team entities: one per rename chain, anchored on the chain's root ---------
	const teams: TeamRecord[] = [];
	const teamIdByPage = new Map<string, string>();
	for (const { root, chain } of teamChains(sources.teams)) {
		const current = chain[chain.length - 1];
		const id = surrogateId(KIND_PREFIX.team, root.page);
		teams.push({ id, name: current.name, overviewPage: current.page, region: current.region });
		names.set(id, current.name);
		for (const page of chain) teamIdByPage.set(page.page, id);
		chain.forEach((page, index) => {
			const isCurrent = index === chain.length - 1;
			const tier: Tier = isCurrent ? "identity" : "alias";
			register("team", page.page, id, tier, isCurrent ? "registry" : "rename");
			// A page's display name can differ from the page only by case in the fixture
			// set (Epik Gamer / EPIK Gamer), and the scoreboard uses whichever it likes.
			if (page.name !== page.page) register("team", page.name, id, tier, "registry");
		});
	}

	for (const name of sources.teamNames) {
		const id = teamIdByPage.get(name.page);
		if (id === undefined) {
			throw new Error(
				`${name.sourceFile}: TeamRedirects names page ${JSON.stringify(name.page)}, which no Teams payload registers — ` +
					"fetch the page or drop the payload, rather than inventing an entity for it",
			);
		}
		register("team", name.allName, id, name.allName === name.page ? "identity" : "alias", "redirect");
	}

	// ---- player entities: one per page -------------------------------------------
	const players: PlayerRecord[] = [];
	const playerIdByPage = new Map<string, string>();
	for (const row of sources.playerNames) {
		if (playerIdByPage.has(row.page)) continue;
		const id = surrogateId(KIND_PREFIX.player, row.page);
		playerIdByPage.set(row.page, id);
	}
	/**
	 * The current handle is the `ID` on the row whose `AllName` is the page itself:
	 * that is how the wiki states "this page is currently called this". A page with
	 * no such row falls back to the page, which is still a string a reader knows.
	 */
	const currentHandle = new Map<string, string>();
	for (const row of sources.playerNames) {
		if (row.allName === row.page && row.id !== "") currentHandle.set(row.page, row.id);
	}
	for (const [page, id] of playerIdByPage) {
		const handle = currentHandle.get(page) ?? page;
		players.push({ id, name: handle, overviewPage: page });
		names.set(id, handle);
		register("player", page, id, "identity", "registry");
		if (handle !== page) register("player", handle, id, "identity", "handle");
	}
	for (const row of sources.playerNames) {
		const id = playerIdByPage.get(row.page);
		if (id === undefined) continue;
		if (row.allName !== row.page) register("player", row.allName, id, "alias", "redirect");
		if (row.id !== "" && row.id !== currentHandle.get(row.page) && row.id !== row.page) {
			register("player", row.id, id, "alias", "handle");
		}
	}

	// ---- champion entities: one per Riot champion id ------------------------------
	const champions: ChampionRecord[] = [];
	const championIdByRiotKey = new Map<number, string>();
	for (const champion of sources.champions) {
		const id = surrogateId(KIND_PREFIX.champion, `riot:${champion.riotKey}`);
		championIdByRiotKey.set(champion.riotKey, id);
		champions.push({ id, name: champion.name, riotKey: champion.riotKey });
		names.set(id, champion.name);
		register("champion", champion.name, id, "identity", "registry");
	}

	// ---- declarations the source does not carry -----------------------------------
	// A declaration is ignored when its whole registry is absent from this corpus
	// (a fixture set that only carries events has no champion for `Nunu` to denote),
	// but a declaration whose target is missing *while its registry is present* is a
	// source bug and stops the build: silently dropping it would leave the retired
	// string minting the duplicate entity this file exists to prevent.
	const registryPresent: Record<EntityKind, boolean> = {
		team: sources.teams.length > 0,
		player: sources.playerNames.length > 0,
		champion: sources.champions.length > 0,
	};
	for (const declared of declaredAliases) {
		if (!registryPresent[declared.kind]) continue;
		const id =
			declared.kind === "champion"
				? championIdByRiotKey.get(declared.riotKey as number)
				: (declared.kind === "team" ? teamIdByPage : playerIdByPage).get(declared.page as string);
		if (id === undefined) {
			const target = declared.kind === "champion" ? `riotKey ${declared.riotKey}` : `page ${JSON.stringify(declared.page)}`;
			throw new Error(
				`declared alias ${JSON.stringify(declared.string)} (${declared.kind}) points at ${target}, which no recorded payload registers`,
			);
		}
		register(declared.kind, declared.string, id, "alias", "declared");
		declaredEras.set(key3(declared.kind, declared.string.trim(), id), {
			first: declared.from ?? null,
			last: declared.until ?? null,
		});
	}

	// ---- the scoreboard's own strings: observe, mint, or report --------------------
	const unresolved = new Map<string, UnresolvedRecord>();

	const recordObservation = (kind: EntityKind, string: string, id: string, date: string): void => {
		if (!DATE.test(date)) return;
		const era = observed.get(key3(kind, string, id));
		if (era === undefined) observed.set(key3(kind, string, id), { first: date, last: date });
		else {
			if (era.first === null || date < era.first) era.first = date;
			if (era.last === null || date > era.last) era.last = date;
		}
	};

	const noteUnresolved = (
		kind: EntityKind,
		string: string,
		date: string,
		outcome: { id: string | null; reason: UnresolvedReason; candidates: string[] },
	): void => {
		const key = key2(kind, string);
		const seen = unresolved.get(key);
		if (seen === undefined) {
			unresolved.set(key, {
				kind,
				string,
				name: string,
				id: outcome.id,
				firstSeen: DATE.test(date) ? date : null,
				lastSeen: DATE.test(date) ? date : null,
				reason: outcome.reason,
				candidates: outcome.candidates,
			});
			return;
		}
		if (DATE.test(date)) {
			if (seen.firstSeen === null || date < seen.firstSeen) seen.firstSeen = date;
			if (seen.lastSeen === null || date > seen.lastSeen) seen.lastSeen = date;
		}
	};

	const mint = (kind: EntityKind, string: string): string => {
		const id = surrogateId(KIND_PREFIX[kind], string);
		if (kind === "team") teams.push({ id, name: string, overviewPage: null, region: "" });
		else if (kind === "player") players.push({ id, name: string, overviewPage: null });
		else champions.push({ id, name: string, riotKey: null });
		names.set(id, string);
		register(kind, string, id, "identity", "observed");
		return id;
	};

	/** Resolve one reference, minting an entity (and reporting it) when nothing answers. */
	const observe = (kind: EntityKind, source: string, date: string): string | null => {
		const string = source.trim();
		if (string === "") return null;
		let found: Resolution | null;
		try {
			found = lookup(kind, string, date);
		} catch (error) {
			if (!(error instanceof AmbiguousIdentity)) throw error;
			noteUnresolved(kind, string, date, {
				id: null,
				reason: "ambiguous",
				candidates: error.candidates.map((candidate) => candidate.id),
			});
			return null;
		}
		const id = found === null ? mint(kind, string) : found.id;
		register(kind, string, id, "alias", "observed");
		recordObservation(kind, string, id, date);
		if (found === null) noteUnresolved(kind, string, date, { id, reason: "no-source-identity", candidates: [] });
		return id;
	};

	for (const row of sources.scoreboard) {
		observe("team", row.team, row.date);
		observe("team", row.opponent, row.date);
		const playerId = observe("player", row.playerLink, row.date);
		// The scoreboard's displayed handle denotes whatever its Link denoted, on that
		// date. It is an alias, never an identity: "Wolf" alone names eight players.
		if (playerId !== null && row.playerName !== "") {
			register("player", row.playerName, playerId, "alias", "handle");
			recordObservation("player", row.playerName, playerId, row.date);
		}
		observe("champion", row.champion, row.date);
	}

	// ---- emit --------------------------------------------------------------------
	const aliases: AliasRecord[] = [];
	for (const [compound, found] of evidence) {
		const [kind, string, entityId] = compound.split("\u0000") as [EntityKind, string, string];
		const era = eraOf(kind, string, entityId);
		aliases.push({
			kind,
			string,
			entityId,
			entityName: names.get(entityId) ?? entityId,
			firstSeen: era?.first ?? null,
			lastSeen: era?.last ?? null,
			evidence: EVIDENCE_ORDER.filter((why) => found.has(why)),
		});
	}
	aliases.sort((a, b) => compare([a.kind, a.string, a.entityId], [b.kind, b.string, b.entityId]));

	teams.sort((a, b) => compare([a.id], [b.id]));
	players.sort((a, b) => compare([a.id], [b.id]));
	champions.sort((a, b) => compare([a.id], [b.id]));

	const seenIds = new Set<string>();
	for (const entity of [...teams, ...players, ...champions]) {
		if (seenIds.has(entity.id)) {
			throw new Error(`canonical ID ${entity.id} is carried by two entities — a hash collision would merge two identities`);
		}
		seenIds.add(entity.id);
	}

	// Nothing to report is the normal case, and its file is empty rather than a stub
	// row: an empty identity-unresolved.jsonl says every reference resolved.
	return {
		teams,
		players,
		champions,
		aliases,
		unresolved: [...unresolved.values()].sort((a, b) => compare([a.kind, a.string], [b.kind, b.string])),
		index: { resolve: (kind, source, date) => lookup(kind, source, date) },
	};
}

function compare(a: string[], b: string[]): number {
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const left = a[index] ?? "";
		const right = b[index] ?? "";
		if (left < right) return -1;
		if (left > right) return 1;
	}
	return 0;
}

/**
 * The team rename chains, each as its root page and the pages in rename order.
 *
 * `Teams.RenamedTo` is an edge from the old page to the new one, so one entity's
 * pages form a linear chain. Anything else — two pages claiming the same successor,
 * a cycle, an edge to a page no payload carries — is a source inconsistency that
 * would otherwise be resolved by whichever payload happened to be read first, so it
 * stops the build instead.
 */
function teamChains(teams: SourceTeam[]): { root: SourceTeam; chain: SourceTeam[] }[] {
	const byPage = new Map(teams.map((team) => [team.page, team]));
	for (const team of teams) {
		if (team.renamedTo !== "" && !byPage.has(team.renamedTo)) {
			throw new Error(
				`${team.sourceFile}: team ${JSON.stringify(team.page)} says it was renamed to ${JSON.stringify(team.renamedTo)}, ` +
					"but no Teams payload carries that page — the registry is incomplete, and guessing the successor would split one identity in two",
			);
		}
	}
	const predecessor = new Map<string, string>();
	for (const team of teams) {
		if (team.renamedTo === "") continue;
		const seen = predecessor.get(team.renamedTo);
		if (seen !== undefined) {
			throw new Error(
				`two team pages claim to have been renamed into ${JSON.stringify(team.renamedTo)}: ` +
					`${JSON.stringify(seen)} and ${JSON.stringify(team.page)} — one identity cannot have two histories`,
			);
		}
		predecessor.set(team.renamedTo, team.page);
	}
	const chains: { root: SourceTeam; chain: SourceTeam[] }[] = [];
	const visited = new Set<string>();
	for (const team of teams) {
		if (predecessor.has(team.page)) continue;
		const chain: SourceTeam[] = [];
		let current = team;
		while (true) {
			if (visited.has(current.page)) {
				throw new Error(`Teams.RenamedTo revisits ${JSON.stringify(current.page)} — a rename chain cannot be a cycle`);
			}
			visited.add(current.page);
			chain.push(current);
			if (current.renamedTo === "") break;
			current = byPage.get(current.renamedTo) as SourceTeam;
		}
		chains.push({ root: team, chain });
	}
	if (visited.size !== teams.length) {
		const stranded = teams.filter((team) => !visited.has(team.page)).map((team) => team.page);
		throw new Error(`Teams.RenamedTo contains a cycle: ${stranded.sort().join(", ")} cannot be reached from a root page`);
	}
	return chains;
}
