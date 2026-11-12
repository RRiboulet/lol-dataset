// assemble: source events + rule -> the emitted records.
//
// Two outputs, one pass. `events` is the entity file the ticket asks for;
// `selection` is the report that makes the rule's *rejections* visible rather than
// merely absent (ticket 01's acceptance criteria, spec R1). Both are sorted by
// canonical ID, so a diff shows one changed line and two builds agree byte for
// byte (spec R8).
//
// Identity (spec D3, R7): a canonical ID is a surrogate derived from the source
// identity — here the wiki's `OverviewPage` — never from the display name and
// never from a row counter. Adding an earlier event therefore cannot renumber a
// later one, and renaming a display name cannot mint a new ID. The page itself is
// carried beside the ID, so the hash stays an implementation detail a reader never
// has to decode (R12).

import { surrogateId } from "./identity.ts";
import type { SourceEvent } from "./normalize.ts";
import type { EventSelectionRule, RuleDecision } from "./rule.ts";
import { evaluateEvent } from "./rule.ts";

/** One selected event. Field order here *is* the emitted field order. */
export type EventRecord = {
	id: string;
	name: string;
	overviewPage: string;
	league: string;
	region: string;
	dateStart: string;
	year: number;
	selection: { rule: "admitted" | "override"; key: string };
};

/** One considered event and what the rule did with it. */
export type SelectionRecord = {
	id: string;
	name: string;
	overviewPage: string;
	league: string;
	region: string;
	decision: "included" | "rejected";
	rule: RuleDecision["rule"];
	key: string;
};

export type AssembledDataset = {
	events: EventRecord[];
	selection: SelectionRecord[];
	/** Decisions keyed by canonical ID, carrying the reasons for the CLI to print. */
	decisions: Map<string, RuleDecision>;
};

/**
 * `evt-` + 12 hex of the source page. Opaque on purpose; see the note above. The
 * hashing lives in `identity.ts` so an event cannot drift onto a different scheme
 * from the teams, players and champions it will be joined to (tickets 03-05).
 */
export function eventId(overviewPage: string): string {
	return surrogateId("evt", overviewPage);
}

export function assembleDataset(rule: EventSelectionRule, sources: SourceEvent[]): AssembledDataset {
	const events: EventRecord[] = [];
	const selection: SelectionRecord[] = [];
	const decisions = new Map<string, RuleDecision>();
	/** Canonical ID -> the page it came from, so a hash collision cannot merge two events. */
	const byId = new Map<string, string>();

	for (const source of sources) {
		const id = eventId(source.overviewPage);
		const existing = byId.get(id);
		if (existing !== undefined && existing !== source.overviewPage) {
			throw new Error(`canonical ID ${id} collides: ${JSON.stringify(existing)} and ${JSON.stringify(source.overviewPage)}`);
		}
		byId.set(id, source.overviewPage);
		const decision = evaluateEvent(rule, source);
		decisions.set(id, decision);

		selection.push({
			id,
			name: source.name,
			overviewPage: source.overviewPage,
			league: source.league,
			region: source.region,
			decision: decision.decision,
			rule: decision.rule,
			key: decision.key,
		});

		if (decision.decision !== "included") continue;
		if (source.dateStart === "") {
			throw new Error(`${source.overviewPage} (${source.sourceFile}): selected but has no DateStart, so it cannot be dated`);
		}
		const year = Number(source.dateStart.slice(0, 4));
		if (!Number.isInteger(year)) {
			throw new Error(`${source.overviewPage} (${source.sourceFile}): unparseable DateStart ${JSON.stringify(source.dateStart)}`);
		}
		events.push({
			id,
			name: source.name,
			overviewPage: source.overviewPage,
			league: source.league,
			region: source.region,
			dateStart: source.dateStart,
			year,
			// `fallback` cannot reach here: it is a rejection.
			selection: { rule: decision.rule as "admitted" | "override", key: decision.key },
		});
	}

	// Sort in place so every emitter and every consumer sees one order.
	events.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	selection.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return { events, selection, decisions };
}
