// The era table's contract (spec R6/D4, ticket 03).
//
// Coverage is only worth computing if the table that defines "could have been recorded"
// is itself checked: a table that lost an era, listed its dates out of order, or reused
// an id would mislabel every game after the mistake, and nothing else in the build would
// notice. The dates themselves are declared from the wiki's patch pages and cited in the
// file; `games.test.ts` checks the recorded data against them from the other side.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Era } from "../eras.ts";
import { coverageOf, eraOn, loadEraTable, parseEraTable } from "../eras.ts";
import { TEAM_STAT_FIELDS } from "../normalize.ts";

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

// A typo in a field name is the quietest way to break the whole table: the era still
// parses, and every game in it is judged against a field that no record can carry, so
// every one of them comes out `partial` and the build exits 0. The names are therefore
// checked against the canonical list the record layer emits, not just against the shape.
test("an eligible name that is not a canonical field is refused, naming file, era and field", () => {
	for (const bogus of ["dragonsCloud", "deaths"]) {
		assert.throws(
			() =>
				parseEraTable(
					table({
						"team-stats": [{ id: "elemental-drakes", from: "2016-01-14", cites: "V6.1", eligible: ["kills", bogus] }],
					}),
					"rules/game-eras.json",
				),
			(error: Error) => {
				assert.match(error.message, /rules\/game-eras\.json/);
				assert.match(error.message, /team-stats/);
				assert.match(error.message, /elemental-drakes/);
				assert.match(error.message, new RegExp(bogus));
				return true;
			},
			bogus,
		);
	}
});

// The groups without a canonical field list stay legal even when empty, and are not
// judged against the team-stat names: `player-stats` and `draft` are filled by later
// tickets, and an era there may name a column this dataset has not modelled yet.
test("the canonical-name rule applies to team-stats only, and empty groups stay legal", () => {
	const parsed = parseEraTable(
		table({ "player-stats": [{ id: "some-later-column", from: "2011-01-01", cites: "a placeholder window", eligible: ["championDamageShare"] }] }),
		"test",
	);
	assert.equal(parsed.groups["player-stats"][0].id, "some-later-column");
	assert.deepEqual(parsed.groups.draft, []);
});

// The last era is the one the present is judged against, so leaving a canonical field
// out of it would mark every game from that boundary on `partial` — the same silent
// failure the name check above prevents for a typo, reached by omission instead.
test("the final team-stats era must cover every canonical field", () => {
	const all = TEAM_STAT_FIELDS.map(([field]) => field);
	const withoutAtakhan = all.filter((field) => field !== "atakhans");
	assert.throws(
		() =>
			parseEraTable(
				table({ "team-stats": [{ id: "atakhan", from: "2025-01-09", cites: "V25.S1.1", eligible: withoutAtakhan }] }),
				"rules/game-eras.json",
			),
		/must list every canonical field.*atakhans/,
	);
	assert.doesNotThrow(() =>
		parseEraTable(
			table({ "team-stats": [{ id: "atakhan", from: "2025-01-09", cites: "V25.S1.1", eligible: all }] }),
			"test",
		),
	);
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

// Patch 11.23 reached live servers on 2021-11-17, not the 18th: Riot's notes are dated
// 2021-11-16, release-day coverage reports it going live on the 17th, and the wiki's
// Season 2022 page dates the preseason start (V11.23) to 2021-11-17. The boundary is a
// data fact, not prose: a game played that day carries Hextech and Chemtech columns, and
// the old date refused its own field names as ineligible.
test("Hextech and Chemtech are eligible from 2021-11-17, the day patch 11.23 went live", async () => {
	const eras = await loadEraTable();
	const boundary = eraOn(eras, "team-stats", "2021-11-17");
	assert.equal(boundary.id, "hextech-chemtech");
	assert.ok(boundary.eligible.includes("dragonsHextechs") && boundary.eligible.includes("dragonsChemtechs"));
	assert.match(boundary.cites, /11\.23/, "the citation names the patch");
	assert.match(boundary.cites, /2021-11-17/, "the citation states the date the era starts");
	assert.equal(eraOn(eras, "team-stats", "2021-11-16").id, "elemental-drakes", "the day before the patch has only the four elemental drakes");
});

// Every era must keep everything the one before it declared, minus the one withdrawal
// the table documents. A field silently dropped from a later era is otherwise invisible:
// coverage simply stops asking about it, and the loss looks like a clean game.
const DECLARED_WITHDRAWAL = { era: "chemtech-withdrawn", field: "dragonsChemtechs" };

test("era eligibility only ever grows, except the one declared Chemtech withdrawal", async () => {
	const teamStats = (await loadEraTable()).groups["team-stats"];
	for (let index = 1; index < teamStats.length; index += 1) {
		const earlier = teamStats[index - 1];
		const later = teamStats[index];
		const withdrawn = later.id === DECLARED_WITHDRAWAL.era ? DECLARED_WITHDRAWAL.field : undefined;
		for (const field of earlier.eligible) {
			if (field === withdrawn) continue;
			assert.ok(
				later.eligible.includes(field),
				`${later.id} (${later.from}) drops ${field}, which ${earlier.id} (${earlier.from}) declared eligible; only ${DECLARED_WITHDRAWAL.era} may withdraw ${DECLARED_WITHDRAWAL.field}`,
			);
		}
	}
	const last = teamStats[teamStats.length - 1];
	assert.deepEqual(
		[...last.eligible].sort(),
		TEAM_STAT_FIELDS.map(([field]) => field).sort(),
		`${last.id} is the era the present is judged against, so it must declare every canonical field`,
	);
});

test("coverage counts only the fields the era could hold", () => {
	// Era values are built directly: this test is about the arithmetic of `coverageOf`, and
	// going through `parseEraTable` would drag in the canonical-field rules for no gain.
	const early: Era = { id: "a", from: "2011-01-01", cites: "the floor", eligible: ["kills", "gold"] };
	const late: Era = { id: "b", from: "2024-01-01", cites: "a later field", eligible: ["kills", "gold", "voidGrubs"] };
	const presence = (both: string[], any = both) => ({ both: new Set(both), any: new Set(any) });
	assert.equal(coverageOf(early, presence(["kills", "gold"])), "complete");
	assert.equal(coverageOf(early, presence(["kills", "gold", "voidGrubs"])), "complete", "an ineligible field is not counted either way");
	assert.equal(coverageOf(early, presence(["kills"])), "partial");
	assert.equal(coverageOf(early, presence([])), "unavailable");
	// One side populated, the other blank: stated somewhere, so neither complete nor
	// unavailable. Calling this `unavailable` would report a half-recorded game as empty.
	assert.equal(coverageOf(early, presence([], ["kills", "gold"])), "partial");
	assert.equal(coverageOf(early, presence(["kills"], ["kills", "gold"])), "partial");

	assert.equal(coverageOf(late, presence(["kills", "gold"])), "partial", "a field that could exist but is absent makes the group partial");
	assert.equal(coverageOf(late, presence(["kills", "gold", "voidGrubs"])), "complete");
	assert.equal(coverageOf(late, presence(["kills", "gold"], ["kills", "gold", "voidGrubs"])), "partial", "both sides need it");
});
