// plan: the crawl is computed from the rule, and the computed queries are the ones that
// were fetched (spec R1, ticket 16).
//
// The risk this guards: `EVENT_QUERY_FIELDS` is a copy of the field lists the crawl used.
// The cache key is the whole query, so a field list that drifts from the committed plans
// would refetch every event into new keys and orphan the committed payloads — the exact
// class of quiet breakage the hand-listed era produced. Comparing against the committed
// plan turns "the constants match" from a hope into a check.

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import type { CargoQuery } from "../cache.ts";
import { eventQueries } from "../plan.ts";
import { DATASET_DIR, FIXTURE_RAW } from "./helpers.ts";

const PLAN_FILE = path.join(DATASET_DIR, "plans", "ticket-10-events.json");

/** The `where` of every query in the committed plan, and the queries it produced. */
async function committedPlan(): Promise<Map<string, CargoQuery[]>> {
	const plan = JSON.parse(await readFile(PLAN_FILE, "utf8")) as { queries: CargoQuery[] };
	const byPage = new Map<string, CargoQuery[]>();
	for (const query of plan.queries) {
		const match = /^(?:OverviewPage|GameId) LIKE '(.+)%'$/.exec(query.where ?? "");
		assert.ok(match, `a committed plan query has an unexpected where clause: ${JSON.stringify(query.where)}`);
		const page = match[1];
		const list = byPage.get(page) ?? [];
		list.push(query);
		byPage.set(page, list);
	}
	return byPage;
}

test("the generated queries are exactly the ones the committed plan fetched", async () => {
	const byPage = await committedPlan();
	assert.ok(byPage.size >= 5, "the committed plan must name several events, or this check proves nothing");
	// The committed plan predates the distinctions query (ticket 03 of the enrichment
	// series), so the generated plan is the committed one plus exactly that table. Every
	// committed query still has to match byte for byte: its cache key is the payload's
	// file name, and a changed field list would orphan the fixture.
	const newest = new Set(["IndividualAchievements"]);
	for (const [overviewPage, committed] of byPage) {
		const generated = eventQueries({ overviewPage } as Parameters<typeof eventQueries>[0]);
		assert.equal(generated.length, committed.length + newest.size, `${overviewPage}: the committed tables plus the distinctions query`);
		for (const query of generated) {
			const same = committed.find((candidate) => candidate.tables === query.tables);
			if (same === undefined) {
				assert.ok(newest.has(query.tables), `${overviewPage}: the plan has a ${query.tables} query`);
				continue;
			}
			assert.deepEqual(
				query,
				same,
				`${overviewPage}/${query.tables}: a generated query must equal the fetched one, or the cache key moves and the payload is orphaned`,
			);
		}
	}
});

test("the distinctions query equals the one the fixtures were recorded with", async () => {
	// The committed plan predates this table, so the recorded payload's own sidecar is the
	// record of what was fetched. Comparing the two is the assertion that catches a drifted
	// field list — otherwise the crawler's cache key moves and 54 events refetch into keys
	// nobody committed.
	const dir = path.join(FIXTURE_RAW, "lol-fandom", "cargoexport", "IndividualAchievements");
	const names = (await readdir(dir)).filter((name) => name.endsWith(".meta.json")).sort();
	assert.ok(names.length > 0, "the fixtures must carry recorded distinctions payloads");
	for (const name of names) {
		const meta = JSON.parse(await readFile(path.join(dir, name), "utf8")) as {
			query: { tables: string; fields: string; where?: string; order_by?: string; limit?: number };
		};
		const match = /^(?:OverviewPage|GameId) LIKE '(.+)%'$/.exec(meta.query.where ?? "");
		assert.ok(match, `${name}: a recorded distinctions query addresses a page by prefix`);
		const generated = eventQueries({ overviewPage: match[1] } as Parameters<typeof eventQueries>[0]).find(
			(query) => query.tables === "IndividualAchievements",
		);
		assert.ok(generated, `${name}: the plan carries a distinctions query`);
		assert.equal(generated.fields, meta.query.fields, `${name}: the field list must not drift, or the cache key moves`);
		assert.equal(generated.where, meta.query.where);
		assert.equal(generated.order_by, meta.query.order_by);
		assert.equal(generated.limit, meta.query.limit);
	}
});

test("an event's queries address the page the plan addresses, with the stage pages included", () => {
	const queries = eventQueries({ overviewPage: "2023 Season World Championship" } as Parameters<typeof eventQueries>[0]);
	assert.equal(queries.length, 5, "the four game-bearing tables plus the distinctions");
	assert.deepEqual(
		queries.map((query) => query.tables),
		["ScoreboardGames", "ScoreboardPlayers", "MatchSchedule", "PicksAndBansS7", "IndividualAchievements"],
		"one query per event table, in a stable order",
	);
	assert.deepEqual(
		queries.map((query) => query.where),
		[
			"OverviewPage LIKE '2023 Season World Championship%'",
			"OverviewPage LIKE '2023 Season World Championship%'",
			"OverviewPage LIKE '2023 Season World Championship%'",
			"GameId LIKE '2023 Season World Championship%'",
			"OverviewPage LIKE '2023 Season World Championship%'",
		],
		"a prefix match, so a stage page's games — and its awards — are collected under their parent event",
	);
	for (const query of queries) assert.equal(query.endpoint, "cargoexport");
});
