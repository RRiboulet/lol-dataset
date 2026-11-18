// The event-selection rule, exercised over recorded payloads (spec R1, ticket 01).
//
// Every page named below came back from the source in `fixtures/raw/`, so these are
// assertions about the rule meeting real source strings — All-Star's league value is
// `All-Star Las Vegas 2018`, Rift Rivals' is `Rift Rivals 2017 NA-EU`, and Worlds
// 2023 has stage pages with no games of their own — rather than about a tidy
// imaginary source.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { parseRule } from "../rule.ts";
import { decisionFor, fixtureDecisions, loadFixtureRule, rawRule, RULE_FILE, writeTempRule } from "./helpers.ts";

test("the rule selects the fixture Worlds and MSI events", async () => {
	const worlds = await decisionFor("2023 Season World Championship");
	const msi = await decisionFor("2023 Mid-Season Invitational");

	assert.equal(worlds.decision.decision, "included");
	assert.equal(worlds.decision.rule, "admitted");
	assert.equal(worlds.decision.key, "worlds");

	assert.equal(msi.decision.decision, "included");
	assert.equal(msi.decision.rule, "admitted");
	assert.equal(msi.decision.key, "msi");
});

test("a regional league event is rejected on region, with the rule's reason", async () => {
	const lck = await decisionFor("LCK/2023 Season/Spring Season");

	assert.equal(lck.decision.decision, "rejected");
	assert.equal(lck.decision.rule, "region");
	assert.equal(lck.decision.key, "region-not-international");
	assert.match(lck.decision.reason, /non-international region/);
	// The rejection names the value that caused it, so the reason is checkable.
	assert.match(lck.decision.reason, /region: Korea/);
});

test("All-Star is rejected for its own stated reason, not dropped as an unknown league", async () => {
	const allStar = await decisionFor("All-Star Las Vegas 2019");

	assert.equal(allStar.source.region, "International", "the fixture must be international, or the test proves nothing");
	assert.equal(allStar.decision.decision, "rejected");
	assert.equal(allStar.decision.key, "all-star");
	assert.match(allStar.decision.reason, /1v1 bracket/);
	assert.match(allStar.decision.reason, /alternate-mode showmatches/);
});

test("a stage page of an admitted event is rejected, so Worlds is not counted twice", async () => {
	for (const page of ["2023 Season World Championship/Main Event", "2023 Season World Championship/Play-In"]) {
		const stage = await decisionFor(page);
		assert.equal(stage.decision.decision, "rejected", page);
		assert.equal(stage.decision.key, "stage-subpage", page);
		assert.match(stage.decision.reason, /count the same event twice or three times/, page);
	}
});

test("a qualifier for an admitted event is rejected", async () => {
	const qualifier = await decisionFor("2023 Worlds Qualifying Series");

	assert.equal(qualifier.source.league, "World Championship", "a Worlds qualifier carries the Worlds league, which is why the rule needs a qualifier clause");
	assert.equal(qualifier.decision.decision, "rejected");
	assert.equal(qualifier.decision.rule, "exclusion");
	assert.equal(qualifier.decision.key, "qualifier");
});

test("an event whose region is unknown is rejected rather than guessed", async () => {
	const unknown = await decisionFor("Curse King Of The Hill");

	assert.equal(unknown.source.region, "Unknown", "the fixture must carry the source's own not-a-region value");
	assert.equal(unknown.decision.decision, "rejected");
	assert.equal(unknown.decision.key, "region-unknown");
});

test("the declared era rejects an admitted league's earlier event, and one it cannot date", async () => {
	const before = await decisionFor("2010 World Cyber Games");
	assert.equal(before.decision.rule, "year");
	assert.equal(before.decision.key, "before-declared-era");

	const undated = await decisionFor("2027 First Stand");
	assert.equal(undated.source.dateStart, "");
	assert.equal(undated.decision.rule, "year");
	assert.equal(undated.decision.key, "year-unknown");
});

test("IEM is admitted as a World Championship and its regional stop is not", async () => {
	const championship = await decisionFor("IEM Season IX - World Championship");
	assert.equal(championship.decision.decision, "included");
	assert.equal(championship.decision.key, "iem-world-championship");

	const stop = await decisionFor("IEM Season IX - Cologne");
	assert.equal(stop.source.league, "Intel Extreme Masters", "both events share a league, which is why a name filter is needed");
	assert.equal(stop.decision.decision, "rejected");
	assert.equal(stop.decision.key, "iem-regional-stop");
});

test("an override changes the selected set, and says why", async () => {
	const included = await decisionFor("2011 World Cyber Games");
	assert.equal(included.decision.decision, "included");
	assert.equal(included.decision.rule, "override");
	assert.match(included.decision.reason, /no League value/);

	// Remove the override from a copy of the committed rule: the same recorded row
	// must now fall through to the fallback, which is what "changes the set" means.
	const rule = await rawRule();
	const overrides = rule.overrides as { include: unknown[]; exclude: unknown[] };
	overrides.include = [];
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-rule-"));
	try {
		const ruleFile = await writeTempRule(dir, rule);
		const withoutOverride = parseRule(await readFile(ruleFile, "utf8"));
		const fallback = await decisionFor("2011 World Cyber Games", withoutOverride);
		assert.equal(fallback.decision.decision, "rejected");
		assert.equal(fallback.decision.rule, "fallback");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an exclusion override removes an otherwise admitted event", async () => {
	const rule = await rawRule();
	(rule.overrides as { exclude: unknown[] }).exclude = [
		{ overviewPage: "2023 Mid-Season Invitational", reason: "test: the override must be able to remove an admitted event" },
	];
	const msi = await decisionFor("2023 Mid-Season Invitational", parseRule(JSON.stringify(rule)));
	assert.equal(msi.decision.decision, "rejected");
	assert.equal(msi.decision.rule, "override");
	assert.equal(msi.decision.key, "override-exclude");
});

test("an override without a reason is refused when the rule loads", async () => {
	const rule = await rawRule();
	(rule.overrides as { include: unknown[] }).include = [{ overviewPage: "2011 World Cyber Games" }];
	assert.throws(() => parseRule(JSON.stringify(rule)), /overrides\.include\[0\]: `reason` is mandatory/);
});

test("rule data is self-documenting: every clause that can decide a rejection states a reason", async () => {
	const rule = await rawRule();
	const reasons: { where: string; value: unknown }[] = [];
	const collect = (where: string, entry: unknown): void => {
		reasons.push({ where, value: (entry as { reason?: unknown } | undefined)?.reason });
	};
	const region = rule.region as { unknown: unknown; notInternational: unknown };
	collect("region.unknown", region.unknown);
	collect("region.notInternational", region.notInternational);
	const years = rule.years as { before: unknown; unknown: unknown };
	collect("years.before", years.before);
	collect("years.unknown", years.unknown);
	collect("fallback", rule.fallback);
	for (const [index, admitted] of (rule.admitted as unknown[]).entries()) collect(`admitted[${index}]`, admitted);
	for (const [index, exclusion] of (rule.exclusions as unknown[]).entries()) collect(`exclusions[${index}]`, exclusion);
	for (const [index, override] of (rule.overrides as { include: unknown[] }).include.entries()) collect(`overrides.include[${index}]`, override);

	for (const { where, value } of reasons) {
		assert.equal(typeof value, "string", `${where} must carry a stated reason`);
		assert.ok((value as string).trim().length > 0, `${where} reason must not be empty`);
	}
});

test("every admitted league is exercised by a recorded fixture", async () => {
	// If someone adds a league to the rule without a fixture, the rule's behaviour
	// for it is untested — and a typo in a source value would go unnoticed until the
	// crawl. This keeps the fixtures pushed up against the rule.
	const rule = await loadFixtureRule();
	const decisions = await fixtureDecisions(rule);
	const selectedKeys = new Set([...decisions.values()].filter((d) => d.decision.decision === "included").map((d) => d.decision.key));
	for (const admitted of rule.admitted) {
		assert.ok(selectedKeys.has(admitted.key), `admitted league ${admitted.key} has no selected fixture event`);
	}
});

test("the committed rule file is the file the tests exercised", async () => {
	const text = await readFile(RULE_FILE, "utf8");
	assert.equal(parseRule(text).version, 1);
	assert.match(text, /"key": "worlds"/);
});
