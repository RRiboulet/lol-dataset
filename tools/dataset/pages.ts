// pages: where a wiki page attaches to an event.
//
// Both consumers of this boundary need the same answer: the scoreboard assembly
// (`games.ts`) emits a game or series only when its page belongs to a selected
// event, and `identity.ts` marks an observation as a reference only when the row
// it came from would be emitted — the entity files carry only the entities some
// emitted record names, so "is this page an emitted event's page" must not be
// decided twice, differently.

/**
 * Is `page` the event's own page, or a stage page under it? The rule selects the event page.
 *
 * One kind of subpage is **not** the event: the qualifiers. The spec's event set
 * (Open assumption 2) excludes "qualifiers for an already-included event", and the
 * wiki puts them beneath the event's page (`2013 World Cyber Games/Qualifiers/China`),
 * so a prefix-only test absorbed 62 qualifier series from five countries into World
 * Cyber Games 2013 — a competition the rule never selected. The boundary is the first
 * path segment, so `…/Qualifiers/China` and `…/Qualifier/…` are excluded while a stage
 * page such as `…/Main Event` is not. The rows are still crawled; the build counts
 * them as ignored rather than emitting them as the event's games, which is the same
 * treatment any other page outside the selected window gets.
 */
export function pageUnderEvent(page: string, overviewPage: string): boolean {
	if (page === overviewPage) return true;
	if (!page.startsWith(`${overviewPage}/`)) return false;
	const section = page.slice(overviewPage.length + 1).split("/")[0].trim().toLowerCase();
	return section !== "qualifiers" && section !== "qualifier";
}
