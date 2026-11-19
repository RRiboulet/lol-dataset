// plan: generate the crawl queries from the committed rule, instead of hand-listing pages
// (spec R1, ticket 16).
//
// Before this, the event set was whatever a hand-written `OverviewPage IN (…)` /
// `LIKE` list named. The rule was applied to those 19 pages and looked complete over
// them — but an edition the rule admits and nobody listed was invisible to the rule,
// the report and every gate. The candidate universe is now a query over `Tournaments`
// (committed under `tools/dataset/plans/ticket-16-universe.json`), and this module turns
// it into the four per-event queries the crawl runs.
//
// The field lists below are the ones the earlier plans fetched, verbatim. They are part
// of the cache key (the cache is keyed by the query), so an event that is already cached
// keeps its payload — which is what makes a re-run skip it instead of re-fetching.

import * as path from "node:path";

import type { CargoQuery } from "./cache.ts";
import { readPayloads } from "./cache.ts";
import { normalizeSources } from "./normalize.ts";
import type { SourceEvent } from "./normalize.ts";
import type { EventSelectionRule, RuleDecision } from "./rule.ts";
import { evaluateEvent, loadRule } from "./rule.ts";

export const DEFAULT_RULE_FILE = path.join(import.meta.dirname, "rules", "event-selection.json");

/**
 * The columns each event query asks for, as the earlier plans asked for them.
 *
 * Copying these is deliberate: the cache key is the whole query, so a changed field list
 * would refetch every event and orphan the committed payloads. `plan.test.ts` asserts the
 * generated query for an already-crawled event equals the query in the committed plan, so
 * this cannot drift from what was actually fetched without failing.
 */
export const EVENT_QUERY_FIELDS = {
	ScoreboardGames:
		"OverviewPage,Tournament,Team1,Team2,WinTeam,LossTeam,DateTime_UTC,Team1Score,Team2Score,Winner,Gamelength,Gamelength_Number,Team1Players,Team2Players,Team1Bans,Team2Bans,Team1Picks,Team2Picks,Team1Dragons,Team2Dragons,Team1Clouds,Team1Infernals,Team1Mountains,Team1Oceans,Team1Hextechs,Team1Chemtechs,Team1Elders,Team2Clouds,Team2Infernals,Team2Mountains,Team2Oceans,Team2Hextechs,Team2Chemtechs,Team2Elders,Team1Barons,Team2Barons,Team1Towers,Team2Towers,Team1Gold,Team2Gold,Team1Kills,Team2Kills,Team1RiftHeralds,Team2RiftHeralds,Team1VoidGrubs,Team2VoidGrubs,Team1Atakhans,Team2Atakhans,Team1Inhibitors,Team2Inhibitors,Patch,LegacyPatch,PatchSort,MatchHistory,GameId,MatchId,RiotPlatformGameId,RiotPlatformId,RiotGameId,RiotHash,RiotVersion",
	ScoreboardPlayers:
		"OverviewPage,Name,Link,Champion,Kills,Deaths,Assists,SummonerSpells,Gold,CS,DamageToChampions,VisionScore,Items,RoleBoundItem,Trinket,Pentakills,KeystoneMastery,KeystoneRune,PrimaryTree,SecondaryTree,Runes,TeamKills,TeamGold,Team,TeamVs,Time,PlayerWin,DateTime_UTC,DST,Tournament,Role,Role_Number,IngameRole,Side,UniqueLine,UniqueLineVs,UniqueRole,UniqueRoleVs,GameId,MatchId,GameTeamId,GameRoleId,GameRoleIdVs,StatsPage",
	MatchSchedule:
		"OverviewPage,MatchId,Team1,Team2,Team1Final,Team2Final,Winner,Team1Score,Team2Score,Team1Points,Team2Points,BestOf,Phase,Round,Tab,N_MatchInTab,FF,IsNullified,DateTime_UTC,HasTime,MatchDay,Patch,PatchPage",
	PicksAndBansS7:
		"GameId,MatchId,SwitchedSides,Team1Role1,Team1Role2,Team1Role3,Team1Role4,Team1Role5,Team2Role1,Team2Role2,Team2Role3,Team2Role4,Team2Role5,Team1Ban1,Team1Ban2,Team1Ban3,Team1Ban4,Team1Ban5,Team2Ban1,Team2Ban2,Team2Ban3,Team2Ban4,Team2Ban5,Team1Pick1,Team1Pick2,Team1Pick3,Team1Pick4,Team1Pick5,Team2Pick1,Team2Pick2,Team2Pick3,Team2Pick4,Team2Pick5,Team1PicksByRoleOrder",
} as const;

type EventTable = keyof typeof EVENT_QUERY_FIELDS;

/** How each table's rows are addressed and ordered, so paging and the cache key are stable. */
const EVENT_TABLE_SHAPE: Record<EventTable, { column: "OverviewPage" | "GameId"; orderBy: string; limit: number }> = {
	ScoreboardGames: { column: "OverviewPage", orderBy: "GameId", limit: 500 },
	ScoreboardPlayers: { column: "OverviewPage", orderBy: "GameId", limit: 2000 },
	MatchSchedule: { column: "OverviewPage", orderBy: "MatchId", limit: 500 },
	PicksAndBansS7: { column: "GameId", orderBy: "GameId", limit: 500 },
};

export type EventDecision = { source: SourceEvent; decision: RuleDecision };

/** Every candidate the committed cache carries, with the rule's decision (ticket 16). */
export async function decideCandidates(options: { rawDir: string; ruleFile?: string }): Promise<EventDecision[]> {
	const rule: EventSelectionRule = await loadRule(options.ruleFile ?? DEFAULT_RULE_FILE);
	const sources = (await normalizeSources(await readPayloads(options.rawDir))).tournaments;
	return sources
		.map((source) => ({ source, decision: evaluateEvent(rule, source) }))
		.sort((a, b) => (a.source.dateStart ?? "").localeCompare(b.source.dateStart ?? "") || a.source.name.localeCompare(b.source.name));
}

export function admittedEvents(decisions: readonly EventDecision[]): SourceEvent[] {
	return decisions.filter((entry) => entry.decision.decision === "included").map((entry) => entry.source);
}

/**
 * The four queries that fetch one event's rows.
 *
 * `LIKE '<overviewPage>%'` rather than equality: the source records a stage page beneath
 * the event's own page (`…/Main Event`), and the crawl collects a stage's games under its
 * parent (rule exclusion `stage-subpage`). Equality would silently drop them.
 */
export function eventQueries(event: SourceEvent): CargoQuery[] {
	return (Object.keys(EVENT_QUERY_FIELDS) as EventTable[]).map((table) => {
		const shape = EVENT_TABLE_SHAPE[table];
		return {
			endpoint: "cargoexport",
			tables: table,
			fields: EVENT_QUERY_FIELDS[table],
			where: `${shape.column} LIKE '${event.overviewPage}%'`,
			order_by: shape.orderBy,
			limit: shape.limit,
		} as CargoQuery;
	});
}

/**
 * The whole plan: one event's four queries per admitted event, in date order.
 *
 * Events already in the cache are included anyway — `fetch` skips a complete cache entry
 * without a request, so listing everything keeps the plan a statement of what the dataset
 * needs rather than a diff against today's cache.
 */
export function planEventCrawl(events: readonly SourceEvent[]): CargoQuery[] {
	return events.flatMap((event) => eventQueries(event));
}
