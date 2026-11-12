// Shared helpers for the dataset suite.
//
// The fixtures are recorded payloads (see `../record.ts`), not hand-written
// stand-ins, so every rule assertion below is made against bytes the source
// actually returned. The suite runs with no network access available: everything
// here reads local files.

import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { readPayloads } from "../cache.ts";
import { normalizeSources } from "../normalize.ts";
import type { SourceEvent } from "../normalize.ts";
import type { EventSelectionRule, RuleDecision } from "../rule.ts";
import { evaluateEvent, loadRule } from "../rule.ts";

export const DATASET_DIR = path.join(import.meta.dirname, "..");
export const REPO_ROOT = path.resolve(DATASET_DIR, "..", "..");
export const FIXTURE_RAW = path.join(DATASET_DIR, "fixtures", "raw");
export const RULE_FILE = path.join(DATASET_DIR, "rules", "event-selection.json");
export const CURATED_DIR = path.join(REPO_ROOT, "data", "curated");
export const SCHEMA_DIR = path.join(CURATED_DIR, "schema");

/** The committed rule, parsed. */
export async function loadFixtureRule(): Promise<EventSelectionRule> {
	return loadRule(RULE_FILE);
}

/** Every source event the recorded fixtures carry, deduplicated by page. */
export async function fixtureSources(): Promise<SourceEvent[]> {
	return (await normalizeSources(await readPayloads(FIXTURE_RAW))).tournaments;
}

export type Decision = { source: SourceEvent; decision: RuleDecision };

/** Decisions for every fixture event, keyed by overview page. */
export async function fixtureDecisions(rule?: EventSelectionRule): Promise<Map<string, Decision>> {
	const active = rule ?? (await loadFixtureRule());
	const decisions = new Map<string, Decision>();
	for (const source of await fixtureSources()) {
		decisions.set(source.overviewPage, { source, decision: evaluateEvent(active, source) });
	}
	return decisions;
}

/** One decision, failing loudly if the fixtures no longer carry that page. */
export async function decisionFor(page: string, rule?: EventSelectionRule): Promise<Decision> {
	const found = (await fixtureDecisions(rule)).get(page);
	if (found === undefined) throw new Error(`the fixtures no longer carry ${JSON.stringify(page)}`);
	return found;
}

/** The committed rule as raw JSON, for assertions about the file rather than its use. */
export async function rawRule(): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(RULE_FILE, "utf8")) as Record<string, unknown>;
}

/** Write a rule file beside a temporary build, returning its path. */
export async function writeTempRule(dir: string, rule: unknown, name = "event-selection.json"): Promise<string> {
	const file = path.join(dir, name);
	await writeFile(file, `${JSON.stringify(rule, null, "\t")}\n`, "utf8");
	return file;
}
