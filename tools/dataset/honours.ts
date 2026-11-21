// honours: the distinctions a tournament states for a player (ticket 03).
//
// A distinction is a fact about (player, event), not an attribute of either, so it gets
// its own curated record rather than a field on an entity or an array inside one. What
// this module decides is only *which* entities a source row names — the source's own
// wording (`Display`, `AchievementType`) travels verbatim, because the table states one
// type for every award and the title is free text (three strings for the same idea:
// `MVP`, `Most Valuable Player`, `MSI MVP` are all in the corpus).
//
// The page the award was stated on is not the event page in general: a tournament keeps
// its awards on a stage page (`2024 Season World Championship/Main Event`), which is why
// the event is the admitted page the record's page sits under, exactly as the crawl's
// `LIKE '<event page>%'` collects it.
//
// Two absences are legal and mean different things. A team string the registry does not
// answer is carried as text and resolves to no entity — an award is context, not evidence
// that a team existed, so nothing is minted from it. A player string, by contrast, has to
// resolve: identity observed it, so a string the registries do not carry already minted a
// provisional entity and reported it in `identity-unresolved.jsonl`.

import type { EventRecord } from "./assemble.ts";
import { AmbiguousIdentity, surrogateId } from "./identity.ts";
import type { IdentityIndex } from "./identity.ts";
import type { SourceHonour } from "./normalize.ts";

/** One player's distinction at one admitted event, as the curated layer states it. */
export type HonourRecord = {
	id: string;
	eventId: string;
	eventName: string;
	playerId: string;
	playerName: string;
	/** The source's `Player` string, verbatim, so the row reads back to the award table. */
	sourcePlayer: string;
	/** The source's team string, verbatim; absent when the source states none. */
	team?: string;
	/** The team the corpus knows, when the registry resolves the string. */
	teamId?: string;
	teamName?: string;
	/** The distinction in the source's words (`Finals MVP`, `All Pro Team`). */
	title: string;
	/** The source's own award type (`Season Award`), carried verbatim. */
	type: string;
	/** The page the award was stated on, for provenance: a stage page is a sub-page. */
	sourcePage: string;
	place?: string;
	placeNumber?: number;
};

/**
 * The page's own `overviewPage` under an event's page — the same rule the crawl uses.
 *
 * Equality is checked too, because an event can keep its awards on its own page
 * (measured: `2016 Mid-Season Invitational`), and a `/` boundary matters so that
 * `MSI 2018` does not claim `MSI 2018 Play-In` as a *different* event's prefix.
 */
function underEvent(page: string, event: EventRecord): boolean {
	return page === event.overviewPage || page.startsWith(`${event.overviewPage}/`);
}

/**
 * Resolve a distinction's player, failing loudly rather than dropping the record.
 *
 * Identity observed every honour's player string before this runs, so a null here means
 * the string never reached the registries — a programming error in the observation order,
 * not a source gap. The award is not dropped: a distinction without a player would be the
 * silent loss the report exists to prevent.
 */
function playerFor(identity: IdentityIndex, source: SourceHonour): { id: string; name: string } {
	const string = source.playerLink !== "" ? source.playerLink : source.playerName;
	// No date: the source states no day for an award, and a page name or a handle is a
	// fact about the entity, not about a window (see `SourceHonour`).
	const found = identity.resolve("player", string, "");
	if (found === null) throw new Error(`${source.sourceFile}: ${source.sourcePage}: the player ${JSON.stringify(string)} did not resolve — identity must observe an honour's player before assembly`);
	return { id: found.id, name: found.name };
}

/**
 * Resolve a distinction's team string, or say the corpus does not know it.
 *
 * Never mints: a team string on an award is context, and an entity the corpus would
 * otherwise not carry must not enter `teams.jsonl` because an award mentioned it. A string
 * that names several teamsakes resolves to none of them — picking one is the guess the
 * unresolved report exists to refuse — and the row still reads, because the source's own
 * string stays on it.
 */
function teamFor(identity: IdentityIndex, team: string): { id: string; name: string } | null {
	if (team === "") return null;
	try {
		const found = identity.resolve("team", team, "");
		return found === null ? null : { id: found.id, name: found.name };
	} catch (error) {
		if (error instanceof AmbiguousIdentity) return null;
		throw error;
	}
}

/**
 * One curated record per source distinction, in a stable order.
 *
 * The id is derived from the tuple that identifies the row in the source — the event's
 * page, the player's page and the title, plus the stated page — so a re-crawl cannot
 * renumber a distinction and a new award cannot shift the others.
 */
export function assembleHonours(input: {
	source: readonly SourceHonour[];
	events: readonly EventRecord[];
	identity: IdentityIndex;
}): HonourRecord[] {
	const records: HonourRecord[] = [];
	const seen = new Set<string>();
	for (const source of input.source) {
		const event = input.events.find((candidate) => underEvent(source.sourcePage, candidate));
		if (event === undefined) {
			throw new Error(`${source.sourceFile}: ${source.sourcePage}: a distinction is stated under no admitted event — the crawl must only ask for admitted pages`);
		}
		const player = playerFor(input.identity, source);
		const id = surrogateId("hn", `${event.overviewPage}\u0000${player.id}\u0000${source.title}\u0000${source.sourcePage}`);
		if (seen.has(id)) continue;
		seen.add(id);
		const team = teamFor(input.identity, source.team);
		records.push({
			id,
			eventId: event.id,
			eventName: event.name,
			playerId: player.id,
			playerName: player.name,
			sourcePlayer: source.playerName !== "" ? source.playerName : source.playerLink,
			...(source.team === "" ? {} : { team: source.team }),
			...(team === null ? {} : { teamId: team.id, teamName: team.name }),
			title: source.title,
			type: source.type,
			sourcePage: source.sourcePage,
			...(source.place === "" ? {} : { place: source.place }),
			...(source.placeNumber === null ? {} : { placeNumber: source.placeNumber }),
		});
	}
	return records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
