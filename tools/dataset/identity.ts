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
// A declaration in `rules/identity-aliases.json` is the one statement that arrives
// before any payload is read, so it is registered before the scoreboard observations:
// a declared string therefore resolves instead of minting, and two judged spellings
// become one entity rather than two. Its target is a page or a Riot id when the
// registries carry the entity, and another observed source string (`aliasOf`) when they
// do not — the provisional id is then the target string's hash, which is exactly what an
// undeclared observation would have minted, and the pair is never reported as two
// unresolved strings a future crawl should chase.
//
// Two checks keep a declaration honest. A declared `from`/`until` is an era, so it bounds
// the string on every lookup, not only when two candidates need a tie-break: outside the
// window the declaration says nothing, and an observation mints and reports instead of
// silently joining the declared entity. And an `aliasOf` target has no registry row to
// check it against, so the corpus must show that the two strings stood on the same side
// of one series — otherwise a typo would merge two teams that never met.
//
// Emission is narrower than registration. Every string the registries and the payloads
// carry is registered — `index` must resolve a qualifier-page string exactly as it always
// did — but the entity *files* carry only the entities an emitted record names: a game
// side, a match side, a player-game row, a draft entry. The rest of the registry (pages
// the source knows but this dataset's events never touch) and the entities minted by rows
// the selection rule never emitted stay resolution input and nothing else, so an analyst
// joining the facts never meets a dimension row no fact reaches.
//
// Every emitted record carries the entity's display name beside its ID (spec R12):
// the entity files do, and so does every alias row, so a reader joins on an ID
// without having to decode it.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { displayName } from "./normalize.ts";
import type {
	SourceChampion,
	SourceDataset,
	SourceMatch,
	SourcePlayerName,
	SourceScoreboardRow,
	SourceTeam,
	SourceTeamName,
} from "./normalize.ts";
import { pageUnderEvent } from "./pages.ts";

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
	/**
	 * Rename edges whose successor page no registry carries. The wiki states them (measured
	 * in the full crawl: `D-City Gaming Stars` → `1. Esport Verein Darmstadt e.V.` names no
	 * page and no redirect), so the edge is skipped and the old page keeps its identity
	 * rather than the build inventing a successor — and the count is reported so a truncated
	 * registry, which looks the same from here, cannot pass for a source gap unnoticed.
	 */
	danglingRenames: { page: string; target: string; sourceFile: string }[];
	/**
	 * `TeamRedirects` rows whose page the `Teams` table does not carry: 122 of 3 703 pages in
	 * the wholesale registries, nearly all national teams and all-star squads the club table
	 * deliberately does not list. The row is not evidence of an entity the corpus can have —
	 * the page is not in the club registry — so it is counted and skipped rather than turned
	 * into an entity with no page. A string that only such a row names still reaches the
	 * unresolved report if a record uses it.
	 */
	unregisteredRedirects: { allName: string; page: string; sourceFile: string }[];
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
	/**
	 * Which entity the string denotes, named as another source string instead of a page.
	 *
	 * This is for an entity the source's registries carry **nothing** for, so `page` and
	 * `riotKey` have no target to point at: the declaration then says "these two observed
	 * strings are one entity", and the entity's provisional ID is derived from the target
	 * string (exactly what an undeclared observed string would mint), never from the
	 * alias's own string, so the answer does not depend on read order. When the target
	 * string *is* something the registries state, resolving it wins, and a declaration that
	 * chains onto another declaration is refused rather than being order-dependent.
	 */
	aliasOf?: string;
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
		const from = (alias.from as string | null | undefined) ?? null;
		const until = (alias.until as string | null | undefined) ?? null;
		if (from !== null && until !== null && until < from) {
			throw new Error(
				`${where}: from ${from} is after until ${until} — a declared era cannot end before it starts ` +
					`(${kind} ${JSON.stringify(string)})`,
			);
		}
		const declared: DeclaredAlias = { kind, string, reason };
		const aliasOf = typeof alias.aliasOf === "string" ? alias.aliasOf.trim() : "";
		if (aliasOf !== "") {
			if (aliasOf === string) throw new Error(`${where}: a declared alias cannot name itself`);
			if (alias.page !== undefined || alias.riotKey !== undefined) {
				throw new Error(`${where}: a declared alias names one target — \`aliasOf\`, not \`page\` or \`riotKey\` as well`);
			}
			declared.aliasOf = aliasOf;
		} else if (kind === "champion") {
			if (!Number.isInteger(alias.riotKey) || (alias.riotKey as number) <= 0) {
				throw new Error(`${where}: a champion alias needs Riot's numeric riotKey, not a display name (or an \`aliasOf\` source string)`);
			}
			declared.riotKey = alias.riotKey as number;
		} else {
			if (typeof alias.page !== "string" || alias.page.trim() === "") {
				throw new Error(`${where}: a ${kind} alias needs the target \`page\`, or an \`aliasOf\` source string`);
			}
			declared.page = alias.page.trim();
		}
		declared.from = from;
		declared.until = until;
		aliases.push(declared);
	}
	// A declaration that targets another declaration would resolve by file order, which
	// is exactly the read-order dependence the canonical IDs exist to avoid.
	const declaredStrings = new Set(aliases.map((alias) => `${alias.kind}\u0000${alias.string}`));
	for (const alias of aliases) {
		if (alias.aliasOf === undefined) continue;
		if (declaredStrings.has(`${alias.kind}\u0000${alias.aliasOf}`)) {
			throw new Error(
				`${file}: alias ${JSON.stringify(alias.string)} targets the declared string ${JSON.stringify(alias.aliasOf)} — ` +
					"one declaration cannot chain onto another, because the answer would depend on file order",
			);
		}
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

export function assembleIdentity(
	sources: SourceDataset,
	declaredAliases: DeclaredAlias[] = [],
	options: {
		/** Games the selection rule admitted; every other named game is a rejected event. */
		selectedGameIds?: ReadonlySet<string>;
		/** Event pages the rule selected. */
		selectedPages?: readonly string[];
		/** Pages of events the rule considered and rejected, for rows that name no game. */
		rejectedPages?: ReadonlySet<string>;
	} = {},
): AssembledIdentity {
	const key2 = (kind: EntityKind, string: string): string => `${kind}\u0000${string}`;
	const key3 = (kind: EntityKind, string: string, id: string): string => `${kind}\u0000${string}\u0000${id}`;

	/** Strings the source's registries state as an entity's own identity. */
	const identityStrings = new Map<string, Set<string>>();
	/** Strings that point at an entity without being its own identity (old pages, handles, declarations). */
	const aliasStrings = new Map<string, Set<string>>();
	/** The union, keyed case-folded: the last resort before minting, and never on its own. */
	const foldedStrings = new Map<string, Set<string>>();
	/**
	 * Folded keys registered at the identity tier, so a page name can outrank another
	 * entity's historical handle when the case differs. Measured: the scoreboard writes
	 * `imp`, page `Imp` is the player, and page `Egnom`'s old handle is also `Imp`
	 * (`Imp (Qusai Alhazmi)`); without this the folded lookup sees two players and refuses.
	 */
	const foldedIdentityStrings = new Map<string, Set<string>>();
	const evidence = new Map<string, Set<AliasEvidence>>();
	const observed = new Map<string, Era>();
	const declaredEras = new Map<string, Era>();
	/** The same windows under the case fold, so a case variant cannot escape its declaration. */
	const declaredErasFolded = new Map<string, Era>();
	const names = new Map<string, string>();

	const register = (kind: EntityKind, source: string, id: string, tier: Tier, why: AliasEvidence): void => {
		const string = source.trim();
		if (string === "") return;
		add(tier === "identity" ? identityStrings : aliasStrings, key2(kind, string), id);
		if (tier === "identity") add(foldedIdentityStrings, key2(kind, fold(string)), id);
		add(foldedStrings, key2(kind, fold(string)), id);
		add(evidence, key3(kind, string, id), why);
	};

	const eraOf = (kind: EntityKind, string: string, id: string): Era | null => {
		return (
			observed.get(key3(kind, string, id)) ??
			declaredEras.get(key3(kind, string, id)) ??
			declaredErasFolded.get(key3(kind, fold(string), id)) ??
			null
		);
	};

	/**
	 * Drop candidates whose *declared* era does not contain `date`.
	 *
	 * A declaration is the only statement that can be older than the corpus (a retired
	 * champion name) or narrower than it (a legacy team name used for five days), so its
	 * window has to be consulted before `pick` decides, not only when `pick` is already
	 * choosing between two candidates. A registry identity is never dropped: the
	 * declaration is inert behind the registry's own statement.
	 */
	const boundDeclaredEra = (kind: EntityKind, string: string, ids: Set<string>, date: string | undefined): Set<string> => {
		if (date === undefined || !DATE.test(date)) return ids;
		const kept = new Set<string>();
		for (const id of ids) {
			const era = declaredEras.get(key3(kind, string, id)) ?? declaredErasFolded.get(key3(kind, fold(string), id));
			if (era === undefined) {
				kept.add(id);
				continue;
			}
			if ((era.first === null || era.first <= date) && (era.last === null || date <= era.last)) kept.add(id);
		}
		return kept;
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
			const bounded = boundDeclaredEra(kind, string, exactAlias, date);
			if (bounded.size === 0) return null;
			const found = pick(kind, string, bounded, date);
			return { ...found, via: "alias" };
		}
		// A folded page name outranks a folded alias: the identity tier is what the corpus's
		// own string is, and only then is a historical handle considered.
		const foldedIdentity = foldedIdentityStrings.get(key2(kind, fold(string)));
		if (foldedIdentity !== undefined && foldedIdentity.size > 0) return pick(kind, string, foldedIdentity, date);
		const folded = foldedStrings.get(key2(kind, fold(string)));
		if (folded !== undefined && folded.size > 0) {
			const bounded = boundDeclaredEra(kind, string, folded, date);
			if (bounded.size === 0) return null;
			const found = pick(kind, string, bounded, date);
			return { ...found, via: "alias" };
		}
		return null;
	};

	// ---- team entities: one per rename chain, anchored on the chain's root ---------
	const teams: TeamRecord[] = [];
	const teamIdByPage = new Map<string, string>();
	/**
	 * A page's display name is registered only when it denotes one entity. The wholesale
	 * registry carries distinct pages that share a display name — `ESC Gaming` and
	 * `ESC Gaming (Italian Team)` both call themselves `ESC Gaming` (measured in the full
	 * crawl) — and registering both makes a scoreboard's `ESC Gaming` ambiguous, which the
	 * resolver refuses rather than merging two teams. The name is not evidence then: the
	 * page and its redirects still resolve, and the string goes to whichever entity's page
	 * it actually is.
	 */
	const teamNameUses = new Map<string, number>();
	for (const team of sources.teams) {
		// Both the page and the display name count, because a page name is itself a string a
		// record can carry: `ESC Gaming` is the page and display name of one team and the
		// display name of another, so it denotes neither in particular.
		for (const string of new Set([team.page, team.name])) teamNameUses.set(string, (teamNameUses.get(string) ?? 0) + 1);
	}
	// A redirect name can be what a rename points at (measured: Lyon Gaming (2013 Latin
	// American Team) → `Rainbow7` → page Movistar R7), so the chain follows the source's
	// own redirect table rather than failing on a link the registry does carry.
	const redirectPage = new Map<string, string>();
	for (const name of sources.teamNames) redirectPage.set(name.allName, name.page);
	const danglingRenames: { page: string; target: string; sourceFile: string }[] = [];
	const unregisteredRedirects: { allName: string; page: string; sourceFile: string }[] = [];
	for (const { root, chain } of teamChains(sources.teams, redirectPage, danglingRenames)) {
		const current = chain[chain.length - 1];
		const id = surrogateId(KIND_PREFIX.team, root.page);
		teams.push({ id, name: displayName(current.name), overviewPage: current.page, region: current.region });
		names.set(id, displayName(current.name));
		for (const page of chain) teamIdByPage.set(page.page, id);
		chain.forEach((page, index) => {
			const isCurrent = index === chain.length - 1;
			const tier: Tier = isCurrent ? "identity" : "alias";
			register("team", page.page, id, tier, isCurrent ? "registry" : "rename");
			// A page's display name can differ from the page only by case in the fixture
			// set (Epik Gamer / EPIK Gamer), and the scoreboard uses whichever it likes.
			// Only when it denotes this one entity, though: a shared display name is not evidence.
			if (page.name !== page.page && (teamNameUses.get(page.name) ?? 0) === 1) register("team", page.name, id, tier, "registry");
		});
	}

	for (const name of sources.teamNames) {
		const id = teamIdByPage.get(name.page);
		if (id === undefined) {
			// A page the club registry does not carry (a national team, an all-star squad) has
			// no entity to point at; the row is counted, never turned into an entity with no page.
			unregisteredRedirects.push({ allName: name.allName, page: name.page, sourceFile: name.sourceFile });
			continue;
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
	const handleUses = new Map<string, number>();
	for (const [page, id] of playerIdByPage) {
		void id;
		for (const string of new Set([page, currentHandle.get(page) ?? page])) {
			handleUses.set(string, (handleUses.get(string) ?? 0) + 1);
		}
	}
	for (const [page, id] of playerIdByPage) {
		const handle = currentHandle.get(page) ?? page;
		players.push({ id, name: displayName(handle), overviewPage: page });
		names.set(id, displayName(handle));
		register("player", page, id, "identity", "registry");
		// Two pages can state the same current handle; then the handle denotes neither of
		// them in particular, and only the pages themselves are evidence.
		if (handle !== page && (handleUses.get(handle) ?? 0) === 1) register("player", handle, id, "identity", "handle");
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
		champions.push({ id, name: displayName(champion.name), riotKey: champion.riotKey });
		names.set(id, displayName(champion.name));
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
	/**
	 * The entity a string only ever appeared as, with no registry identity to point at.
	 *
	 * Its ID is the string's hash, which is the same provisional ID an undeclared
	 * observation would mint — so a declaration can name it without inventing a second
	 * anchoring scheme. `why` is what put the string here: a declaration says so before any
	 * payload has been observed, and a later observation adds `observed` beside it.
	 */
	const mint = (kind: EntityKind, string: string, why: AliasEvidence = "observed"): string => {
		const id = surrogateId(KIND_PREFIX[kind], string);
		if (kind === "team") teams.push({ id, name: displayName(string), overviewPage: null, region: "" });
		else if (kind === "player") players.push({ id, name: displayName(string), overviewPage: null });
		else champions.push({ id, name: displayName(string), riotKey: null });
		names.set(id, displayName(string));
		register(kind, string, id, "identity", why);
		return id;
	};

	/** Which entity a declaration's `aliasOf` string denotes, resolving it the way the source would. */
	const entityForDeclaredTarget = (declared: DeclaredAlias): string => {
		const target = declared.aliasOf as string;
		let found: Resolution | null;
		try {
			found = lookup(declared.kind, target);
		} catch (error) {
			if (!(error instanceof AmbiguousIdentity)) throw error;
			throw new Error(`declared alias ${JSON.stringify(declared.string)}: its target ${JSON.stringify(target)} is ambiguous — ${error.message}`);
		}
		return found === null ? mint(declared.kind, target, "declared") : found.id;
	};

	/** Which strings the recorded corpus actually used, for declaration-evidence checks. */
	const observedStrings = new Set<string>();
	/** `aliasOf` declarations whose target the corpus has to justify (not inert behind a registry). */
	const aliasOfToCheck: DeclaredAlias[] = [];

	for (const declared of declaredAliases) {
		// A `page`/`riotKey` declaration needs its registry in the corpus to have a target at
		// all, so it is skipped when that registry is absent (a fixture set that only carries
		// events has no champion for `Nunu` to denote). An `aliasOf` declaration targets no
		// registry, so it applies either way: whether a `Teams` payload happens to be in the
		// corpus must not decide whether two observed strings are one team.
		if (declared.aliasOf === undefined && !registryPresent[declared.kind]) continue;
		// A declaration states what the registries do not, so it is registered in the alias
		// tier: when a registry *does* answer for the string, `lookup` prefers the registry
		// and the declaration is inert. That is the documented order, and it is the right
		// one — the source adopting a string is not a contradiction to fail on. An inert
		// declaration needs no corpus evidence either: it cannot merge anything.
		const registryAnswers = (identityStrings.get(key2(declared.kind, declared.string))?.size ?? 0) > 0;
		const id =
			declared.aliasOf !== undefined
				? entityForDeclaredTarget(declared)
				: declared.kind === "champion"
					? championIdByRiotKey.get(declared.riotKey as number)
					: (declared.kind === "team" ? teamIdByPage : playerIdByPage).get(declared.page as string);
		if (id === undefined) {
			const target = declared.kind === "champion" ? `riotKey ${declared.riotKey}` : `page ${JSON.stringify(declared.page)}`;
			throw new Error(
				`declared alias ${JSON.stringify(declared.string)} (${declared.kind}) points at ${target}, which no recorded payload registers`,
			);
		}
		register(declared.kind, declared.string, id, "alias", "declared");
		const declaredEra = { first: declared.from ?? null, last: declared.until ?? null };
		declaredEras.set(key3(declared.kind, declared.string.trim(), id), declaredEra);
		declaredErasFolded.set(key3(declared.kind, fold(declared.string.trim()), id), declaredEra);
		if (declared.aliasOf !== undefined && declared.kind === "team" && !registryAnswers) aliasOfToCheck.push(declared);
	}

	// ---- the scoreboard's own strings: observe, mint, or report --------------------
	const unresolved = new Map<string, UnresolvedRecord>();

	const recordObservation = (kind: EntityKind, string: string, id: string, date: string): void => {
		if (!DATE.test(date)) return;
		observedStrings.add(key2(kind, string));
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
				name: displayName(string),
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

	/** Resolve one reference, minting an entity (and reporting it) when nothing answers. */
	const observe = (kind: EntityKind, source: string, date: string): string | null => {
		const string = source.trim();
		if (string === "") return null;
		let found: Resolution | null;
		try {
			found = lookup(kind, string, date);
		} catch (error) {
			if (!(error instanceof AmbiguousIdentity)) throw error;
			// The registries cannot say which of several namesakes this string denotes — measured:
			// a 2015 scoreboard names `Lee`, and three players carry that handle historically
			// (`Lee (Lee Dae-hyeong)`, `Lee (Lee In-cheol)`, `Lee (Lee Joo-won)`), none of them the
			// one who played. Picking one would be a guess; failing the build would make the
			// corpus depend on which payloads happen to be cached. So the string gets one
			// provisional entity, the report names every candidate, and the mapping is stated as
			// uncertain where a reader looks for it. The registration is at the identity tier so
			// later lookups of the same string resolve to it instead of re-detecting the clash.
			const id = mint(kind, string);
			register(kind, string, id, "identity", "observed");
			recordObservation(kind, string, id, date);
			noteUnresolved(kind, string, date, {
				id,
				reason: "ambiguous",
				candidates: error.candidates.map((candidate) => candidate.id),
			});
			return id;
		}
		const id = found === null ? mint(kind, string) : found.id;
		register(kind, string, id, "alias", "observed");
		recordObservation(kind, string, id, date);
		if (found === null) noteUnresolved(kind, string, date, { id, reason: "no-source-identity", candidates: [] });
		return id;
	};

	// The caller passes the games the selection rule admitted. A broad crawl also
	// carries scoreboard rows for rejected events: when such a row names its game it
	// is not a reference in this dataset and must not mint entities or unresolved
	// rows. The older identity-only payloads carry no GameId, so a row without one is
	// judged by its page — but only against events the rule *explicitly rejected*. A
	// page the rule never considered is curated identity evidence (ticket 02's rename
	// and duplicate cases), not a crawl artifact, and dropping it would erase the eras
	// those fixtures establish.
	const selected = (gameId: string): boolean => options.selectedGameIds === undefined || options.selectedGameIds.has(gameId);
	const underAny = (page: string, bases: ReadonlySet<string> | readonly string[]): boolean => {
		for (const base of bases) {
			if (page === base || page.startsWith(`${base}/`)) return true;
		}
		return false;
	};
	// A page under a *selected* event is kept even when the rule rejected the page as an
	// event of its own: `Worlds 2023 Main Event` is rejected as a stage subpage, yet its
	// games are that selected event's games. Only a page under no selected event and
	// under a rejected one is excluded.
	const pageRejected = (page: string): boolean =>
		page !== "" &&
		options.rejectedPages !== undefined &&
		underAny(page, options.rejectedPages) &&
		!(options.selectedPages !== undefined && underAny(page, options.selectedPages));
	for (const row of sources.scoreboard) {
		if (row.gameId !== "" ? !selected(row.gameId) : pageRejected(row.page)) continue;

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

	// ---- games and matches: the team references ticket 03 joins on ------------------
	// A `ScoreboardGames` row names its two sides as display strings, so they are
	// observations exactly like a player scoreboard's: resolved through the registry and
	// the alias table where one answers, minted (and reported) where none does. Ticket
	// 10's crawl fetches those Teams pages and the report shrinks on its own.
	//
	// Draft champions are observations too (ticket 05): the recorded champion registry
	// covers only part of the vocabulary, so a pick the registry does not name still has
	// to resolve to one canonical entity before it goes on a game row. The unresolved
	// report says which strings a future registry payload should answer.
	const gameDates = new Map(sources.games.map((game) => [game.gameId, game.date]));
	for (const game of sources.games) {
		if (!selected(game.gameId)) continue;
		for (const side of game.sides) observe("team", side.team, game.date);
		observe("team", game.winTeam, game.date);
		for (const index of [0, 1] as const) {
			for (const champion of [...game.picks[index], ...game.bans[index]]) observe("champion", champion, game.date);
		}
	}
	for (const draft of sources.drafts) {
		const date = gameDates.get(draft.gameId);
		if (date === undefined || !selected(draft.gameId)) continue;
		for (const side of draft.sides) {
			for (const slot of [...side.picks, ...side.bans]) observe("champion", slot.champion, date);
		}
	}
	// Player-game rows are observations as well: their handles, team strings and
	// champions must resolve to the same entities the emitted rows reference.
	for (const row of sources.playerGames) {
		if (!selected(row.gameId)) continue;
		const playerId = observe("player", row.playerLink, row.date);
		if (playerId !== null && row.playerName !== "") {
			register("player", row.playerName, playerId, "alias", "handle");
			recordObservation("player", row.playerName, playerId, row.date);
		}
		observe("team", row.team, row.date);
		observe("champion", row.champion, row.date);
	}
	for (const match of sources.matches) {
		// A series belongs to an event by its page, exactly like a game: a match under no
		// selected event is a rejected event's row and is not a reference here.
		if (options.selectedPages !== undefined && !underAny(match.page, options.selectedPages)) continue;
		observe("team", match.sides[0], match.date);
		observe("team", match.sides[1], match.date);
	}

	// ---- a declared target the corpus does not carry must be evidenced --------------
	// `aliasOf` exists because the corpus has no registry row to check the target against,
	// so nothing would stop a typo from merging two teams that never met: the build would
	// stay green and only the detached/contradicted counts would move. The evidence is
	// derived from the source, not asserted in the declaration's prose — a game and the
	// series row it names must put the declared string on one side and the target on the
	// same side (the same opponent). IPL 5's `CLG Prime` series rows and their
	// `Counter Logic Gaming` games are exactly that; a target that never shares a side is
	// not.
	//
	// A declaration whose string no corpus row uses is inert (it cannot merge anything),
	// which keeps an identity-only fixture set buildable; a string the registry already
	// states is inert behind the registry and is not checked either.
	const seriesByMatchId = new Map<string, SourceMatch>();
	for (const match of sources.matches) {
		// The emitted series rows only (`pageUnderEvent`, as `eventForPage` judges the
		// rows the build emits), so the evidence joins records the dataset actually carries.
		if (
			options.selectedPages !== undefined &&
			!options.selectedPages.some((page) => pageUnderEvent(match.page, page))
		) {
			continue;
		}
		if (!seriesByMatchId.has(match.matchId)) seriesByMatchId.set(match.matchId, match);
	}
	const sharesASeriesSide = (declared: DeclaredAlias): boolean => {
		const alias = declared.string.trim();
		const target = (declared.aliasOf as string).trim();
		for (const game of sources.games) {
			if (!selected(game.gameId)) continue;
			const match = seriesByMatchId.get(game.matchId);
			if (match === undefined) continue;
			const sides = [game.sides[0].team.trim(), game.sides[1].team.trim()];
			for (const [index, team] of sides.entries()) {
				if (team !== alias && team !== target) continue;
				const opponent = sides[1 - index];
				// The two strings on opposite sides of a game are two teams, which is the
				// opposite of evidence that they are one.
				if (opponent === alias || opponent === target) continue;
				const other = team === alias ? target : alias;
				if (match.sides.includes(other) && match.sides.includes(opponent)) return true;
			}
		}
		return false;
	};
	for (const declared of aliasOfToCheck) {
		if (!observedStrings.has(key2(declared.kind, declared.string))) continue;
		if (sharesASeriesSide(declared)) continue;
		throw new Error(
			`declared alias ${JSON.stringify(declared.string)} (${declared.kind}) targets ${JSON.stringify(declared.aliasOf)}, ` +
				"but no recorded game and its series row put the two strings on the same side — an `aliasOf` declaration " +
				"must be evidenced by the corpus, because a typo here would merge two teams that never met",
		);
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
		danglingRenames: danglingRenames.sort((a, b) => compare([a.sourceFile, a.page], [b.sourceFile, b.page])),
		unregisteredRedirects: unregisteredRedirects.sort((a, b) => compare([a.sourceFile, a.page, a.allName], [b.sourceFile, b.page, b.allName])),
		index: { resolve: (kind, source, date) => lookup(kind, source, date) },
	};
}

/**
 * The identity tables the dataset emits, given the entities the emitted records name.
 *
 * Emission is narrower than registration. Everything this module registers stays
 * registered — `index` resolves a qualifier-page string exactly as it always did —
 * but an entity belongs in the entity files only when some emitted record names it:
 * a game side, a match side, a player-game row, a draft entry, or a conflict-report
 * row (ticket 10's decision log). The registries keep every string they carry, so a
 * registry row that answers a reference to an emitted entity can never have been
 * dropped — the reference would not resolve. What leaves is the rest: pages the
 * source registers but this dataset's events never touch (a qualifier's teams, a team
 * retired before the earliest admitted event), and entities minted by rows the build
 * never emitted. An entity first seen only on an excluded page is not a reference in
 * this dataset, and a dimension row no fact can reach is not a member of it either.
 *
 * The caller passes the references **from the emitted records themselves** — not from
 * this module's own observations — because which rows are emitted is decided after
 * assembly: a series row whose games name other teams is held back by the scoreboard
 * assembly, and only it knows that. A minted unresolved row survives exactly when its
 * entity is one of those references — its string minted it, so the string is a
 * reference too. An `ambiguous` row survives either way: ambiguity is a property of
 * the string in the corpus, not of one row's reference, and it cannot appear on an
 * emitted record at all (a row that could not resolve is never emitted), so there is
 * no emitted-record test for it — dropping it would hide a merge hazard the next
 * crawl could step into.
 *
 * The filter never touches an alias row's *string*, only its entity: a legacy name
 * observed on an excluded page of a team that also played the main event is still the
 * identity history of an emitted entity, and dropping it would erase the era it dates.
 */
export function emitReferenced(identity: AssembledIdentity, referenced: ReadonlySet<string>): AssembledIdentity {
	return {
		teams: identity.teams.filter((team) => referenced.has(team.id)),
		players: identity.players.filter((player) => referenced.has(player.id)),
		champions: identity.champions.filter((champion) => referenced.has(champion.id)),
		aliases: identity.aliases.filter((alias) => referenced.has(alias.entityId)),
		unresolved: identity.unresolved.filter((row) => row.id === null || referenced.has(row.id)),
		// The two registry-gap reports describe the payloads, not the emitted entities, so
		// they travel unfiltered: the count is what tells a truncated registry from a source gap.
		danglingRenames: identity.danglingRenames,
		unregisteredRedirects: identity.unregisteredRedirects,
		index: identity.index,
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
 *
 * A `RenamedTo` value is usually the successor **page**, and sometimes a name that page
 * used to have (`Lyon Gaming (2013 Latin American Team)` → `Rainbow7`, which is now a
 * `TeamRedirects` name for page `Movistar R7`). Following the source's own redirect row
 * is not a guess; failing to would split one team into two because a page was renamed
 * twice. A target that is neither a page nor a redirect name is still a hard stop.
 */
function teamChains(
	teams: SourceTeam[],
	redirectPage: Map<string, string>,
	dangling: { page: string; target: string; sourceFile: string }[],
): { root: SourceTeam; chain: SourceTeam[] }[] {
	const byPage = new Map(teams.map((team) => [team.page, team]));
	const foldedRedirect = new Map<string, Set<string>>();
	for (const [name, page] of redirectPage) add(foldedRedirect, fold(name), page);
	/**
	 * The page a `RenamedTo` target denotes, or `undefined` when the registries cannot say.
	 *
	 * The redirect lookup folds case as a last resort, the same way a source string does
	 * everywhere else in this file, because the wiki's rename edge and its own redirect
	 * table disagree on case: `Boba Marines` says it was renamed to `GIGABYTE Marines`, and
	 * the only redirect row for that name is `Gigabyte marines` → page `GAM Esports`
	 * (measured in the full crawl). Refusing that would split one team into two — the
	 * failure this check exists to prevent. Two pages sharing a folded name still stop the
	 * build, because the successor would then depend on payload order.
	 */
	const successor = (target: string): SourceTeam | undefined => {
		const exactPage = byPage.get(target);
		if (exactPage !== undefined) return exactPage;
		const exactRedirect = redirectPage.get(target);
		if (exactRedirect !== undefined) return byPage.get(exactRedirect);
		const folded = foldedRedirect.get(fold(target));
		if (folded === undefined) return undefined;
		if (folded.size > 1) {
			throw new Error(
				`a rename target ${JSON.stringify(target)} matches ${folded.size} redirect names that differ only in case ` +
					`(${[...folded].map((page) => JSON.stringify(page)).sort().join(", ")}) — which page it denotes would depend on payload order`,
			);
		}
		return byPage.get([...folded][0]);
	};
	// A `RenamedTo` whose successor is neither a page nor a redirect name is a gap in the
	// *source*, not in the registry: the wiki states the edge and carries no such page. The
	// edge is skipped so the old page keeps its identity, and the target — if any emitted
	// record names it — appears in the unresolved report with no registry row, which is the
	// honest record of it. The full crawl found several; a filtered registry hid them.
	for (const team of teams) {
		if (team.renamedTo !== "" && successor(team.renamedTo) === undefined) {
			dangling.push({ page: team.page, target: team.renamedTo, sourceFile: team.sourceFile });
		}
	}
	// The rename graph is read as **components**, not as chains, because the source merges
	// as well as renames: two pages can state the same successor (`AXIZ Academy` and
	// `Crest Gaming Act Academy` both rename into `AXIZ CREST Academy`, measured in the full
	// crawl). A chain model would refuse that or keep whichever payload was read last; a
	// component is one entity with two histories, which is what the source says happened.
	// A linear rename is the one-root case of the same rule, so its ids do not move.
	const parent = new Map<string, string>(teams.map((team) => [team.page, team.page]));
	const find = (page: string): string => {
		let current = page;
		while (parent.get(current) !== current) current = parent.get(current) as string;
		return current;
	};
	const union = (a: string, b: string): void => {
		const rootA = find(a);
		const rootB = find(b);
		if (rootA !== rootB) parent.set(rootA, rootB);
	};
	const outgoing = new Map<string, SourceTeam>();
	for (const team of teams) {
		if (team.renamedTo === "") continue;
		const target = successor(team.renamedTo);
		if (target === undefined) continue;
		if (outgoing.has(team.page)) throw new Error(`Teams.RenamedTo gives ${JSON.stringify(team.page)} two successors`);
		outgoing.set(team.page, target);
		union(team.page, target.page);
	}

	const components = new Map<string, SourceTeam[]>();
	for (const team of teams) {
		const root = find(team.page);
		const list = components.get(root) ?? [];
		list.push(team);
		components.set(root, list);
	}

	const chains: { root: SourceTeam; chain: SourceTeam[] }[] = [];
	for (const pages of components.values()) {
		// A component has one page nothing renames out of (the current page) unless the edges
		// form a cycle, and at least one page nothing renames into (a history's start).
		const current = pages.filter((team) => !outgoing.has(team.page));
		if (current.length === 0) {
			throw new Error(
				`Teams.RenamedTo contains a cycle among ${pages.map((team) => JSON.stringify(team.page)).sort().join(", ")} — a rename chain cannot be a cycle`,
			);
		}
		const predecessorPages = new Set([...outgoing.values()].map((team) => team.page));
		const roots = pages.filter((team) => !predecessorPages.has(team.page));
		if (roots.length === 0) {
			throw new Error(
				`Teams.RenamedTo has no start among ${pages.map((team) => JSON.stringify(team.page)).sort().join(", ")} — every page claims a predecessor`,
			);
		}
		// The id is derived from the smallest root page, so a merged history still has one
		// stable id and a linear chain (one root) keeps the id it already had.
		const root = [...roots].sort((a, b) => compare([a.page], [b.page]))[0];
		const sink = current[0];
		const others = pages.filter((team) => team.page !== sink.page).sort((a, b) => compare([a.page], [b.page]));
		chains.push({ root, chain: [...others, sink] });
	}
	return chains;
}
