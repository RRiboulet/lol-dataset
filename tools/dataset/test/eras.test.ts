// The era table's contract (spec R6/D4, ticket 03).
//
// Coverage is only worth computing if the table that defines "could have been recorded"
// is itself checked: a table that lost an era, listed its dates out of order, or reused
// an id would mislabel every game after the mistake, and nothing else in the build would
// notice. The dates themselves are declared from the wiki's patch pages and cited in the
// file; `games.test.ts` checks the recorded data against them from the other side.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { EraTable } from "../eras.ts";
import { coverageOf, eraOn, loadEraTable, parseEraTable } from "../eras.ts";

const GROUPS = { "team-stats": [], "player-stats": [], draft: [] };

function table(groups: Record<string, unknown>): Record<string, unknown> {
	return { version: 1, groups: { ...GROUPS, ...groups } };
}

test("the committed era table loads and every boundary states where it comes from", async () => {
	const eras = await loadEraTable();
	assert.ok(eras.groups["team-stats"].length >= 2, "the committed table covers more than one era");
	for (const era of eras.groups["team-stats"]) {
		assert.match(era.from, /^\d{4}-\d{2}-\d{2}$/);
		assert.ok(era.cites.length > 20, `${era.id}: the citation says which patch and which date`);
		assert.ok(era.eligible.includes("kills"));
	}
});

test("an era table that would mislabel records is refused at load, not used", () => {
	const cases: [string, Record<string, unknown>, RegExp][] = [
		[
			"out of order",
			{ "team-stats": [{ id: "b", from: "2020-01-01", cites: "x", eligible: ["kills"] }, { id: "a", from: "2019-01-01", cites: "y", eligible: ["kills"] }] },
			/ascending date order/,
		],
		[
			"same date twice",
			{ "team-stats": [{ id: "a", from: "2020-01-01", cites: "x", eligible: ["kills"] }, { id: "b", from: "2020-01-01", cites: "y", eligible: ["kills"] }] },
			/ascending date order/,
		],
		["duplicate id", { "team-stats": [{ id: "a", from: "2020-01-01", cites: "x", eligible: ["kills"] }, { id: "a", from: "2021-01-01", cites: "y", eligible: ["gold"] }] }, /used twice/],
		["no citation", { "team-stats": [{ id: "a", from: "2020-01-01", cites: "", eligible: ["kills"] }] }, /cites/],
		["no eligible fields", { "team-stats": [{ id: "a", from: "2020-01-01", cites: "x", eligible: [] }] }, /eligible/],
		["bad date", { "team-stats": [{ id: "a", from: "2020-1-1", cites: "x", eligible: ["kills"] }] }, /YYYY-MM-DD/],
	];
	for (const [name, groups, expected] of cases) {
		assert.throws(() => parseEraTable(table(groups), "test"), expected, name);
	}
});

test("a missing group is an error, so a group cannot be silently forgotten", () => {
	assert.throws(
		() => parseEraTable({ version: 1, groups: { "team-stats": [] } }, "test"),
		/group "player-stats" is missing/,
	);
});

test("the last era whose start is not after the date governs it", async () => {
	const eras = await loadEraTable();
	assert.equal(eraOn(eras, "team-stats", "2015-03-13").id, "pre-herald");
	assert.equal(eraOn(eras, "team-stats", "2015-11-11").id, "herald", "the boundary day itself belongs to the new era");
	assert.equal(eraOn(eras, "team-stats", "2023-10-10").id, "chemtech-restored");
	assert.equal(eraOn(eras, "team-stats", "2025-01-09").id, "atakhan");
	assert.equal(eraOn(eras, "team-stats", "2025-01-08").id, "voidgrubs");
});

test("a date before the declared floor stops the build rather than guessing an era", async () => {
	const eras = await loadEraTable();
	assert.throws(() => eraOn(eras, "team-stats", "2010-12-31"), /precedes the first declared/);
	assert.throws(() => eraOn(eras, "team-stats", "not-a-date"), /YYYY-MM-DD/);
	assert.throws(() => eraOn(eras, "player-stats", "2023-10-10"), /no eras are declared/);
});

test("coverage counts only the fields the era could hold", () => {
	const eras: EraTable = parseEraTable(
		table({
			"team-stats": [
				{ id: "a", from: "2011-01-01", cites: "the floor", eligible: ["kills", "gold"] },
				{ id: "b", from: "2024-01-01", cites: "a later field", eligible: ["kills", "gold", "voidGrubs"] },
			],
		}),
		"test",
	);
	const presence = (both: string[], any = both) => ({ both: new Set(both), any: new Set(any) });
	const early = eraOn(eras, "team-stats", "2013-01-01");
	assert.equal(coverageOf(early, presence(["kills", "gold"])), "complete");
	assert.equal(coverageOf(early, presence(["kills", "gold", "voidGrubs"])), "complete", "an ineligible field is not counted either way");
	assert.equal(coverageOf(early, presence(["kills"])), "partial");
	assert.equal(coverageOf(early, presence([])), "unavailable");
	// One side populated, the other blank: stated somewhere, so neither complete nor
	// unavailable. Calling this `unavailable` would report a half-recorded game as empty.
	assert.equal(coverageOf(early, presence([], ["kills", "gold"])), "partial");
	assert.equal(coverageOf(early, presence(["kills"], ["kills", "gold"])), "partial");

	const late = eraOn(eras, "team-stats", "2024-06-01");
	assert.equal(coverageOf(late, presence(["kills", "gold"])), "partial", "a field that could exist but is absent makes the group partial");
	assert.equal(coverageOf(late, presence(["kills", "gold", "voidGrubs"])), "complete");
	assert.equal(coverageOf(late, presence(["kills", "gold"], ["kills", "gold", "voidGrubs"])), "partial", "both sides need it");
});
