// Shared helpers for the dataset suite.
//
// The fixtures are recorded payloads (see `../record.ts`), not hand-written
// stand-ins, so every rule assertion below is made against bytes the source
// actually returned. The suite runs with no network access available: everything
// here reads local files.

import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import * as path from "node:path";

import { readPayloads, sha256, sidecarPath } from "../cache.ts";
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

/**
 * Rewrite a payload body the way the recorder would, keeping its sidecar honest.
 *
 * Several tests change a recorded payload to express a case (a renamed team, a
 * contradicted side). The build now verifies each body against its sidecar's
 * `bodySha256` (spec R9, ticket 07), so an edited body without a refreshed hash is a
 * tampered cache and fails correctly. This is the recorder's behaviour for an edited
 * body: write the bytes, then update the hash that claims to describe them. A payload
 * that never had a sidecar stays body-only, which is also legal.
 */
export async function savePayloadBody(file: string, body: string): Promise<void> {
	// A committed body is gzipped (ticket 17); a scratch body a test writes may be plain.
	// The helper follows whichever form the path names, so editing a payload keeps the
	// storage it already had.
	if (file.endsWith(".json.gz")) await writeFile(file, gzipSync(Buffer.from(body, "utf8"), { level: 9 }));
	else await writeFile(file, body, "utf8");
	const metaFile = sidecarPath(file);
	let text: string;
	try {
		text = await readFile(metaFile, "utf8");
	} catch {
		return;
	}
	let meta: Record<string, unknown>;
	try {
		meta = JSON.parse(text) as Record<string, unknown>;
	} catch {
		return;
	}
	meta.bodySha256 = sha256(body);
	await writeFile(metaFile, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

/** Is this directory-entry name a payload body (either storage form), not a sidecar? */
export function isPayloadBody(name: string): boolean {
	return (name.endsWith(".json.gz") || name.endsWith(".json")) && !name.endsWith(".meta.json");
}

/** A stored payload body's text, decompressed whichever form it is stored in. */
export async function readPayloadBodyFile(file: string): Promise<string> {
	const bytes = await readFile(file);
	return file.endsWith(".json.gz") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
}

/** Write a payload body in the storage form its path names: `.json.gz` is compressed. */
export async function writePayloadBodyFile(file: string, body: string): Promise<void> {
	if (file.endsWith(".json.gz")) await writeFile(file, gzipSync(Buffer.from(body, "utf8"), { level: 9 }));
	else await writeFile(file, body, "utf8");
}

export { sidecarPath } from "../cache.ts";
