// rule: is this source event in the dataset? (spec R1)
//
// The rule is data — `rules/event-selection.json` — not code. This module only
// evaluates it, and it holds **no policy text of its own**: every reason a decision
// cites is read from the file. That is what makes the set computable by someone
// reading the repository alone, and it is why changing the scope is a reviewable
// diff to a JSON file rather than an edit to a function.
//
// Evaluation order, fixed here and restated in the rule file:
//
//   1. override exclude   — a per-event decision wins over everything below
//   2. override include   — likewise; both require a stated reason
//   3. region unknown     — absent or explicitly unknown region is rejected, never guessed
//   4. region not admitted
//   5. year outside the declared era / year unknown
//   6. exclusions         — All-Star, national teams, stage sub-pages, qualifiers
//   7. admitted league    — the positive half of the rule
//   8. fallback           — nothing matched; rejected, not dropped
//
// Overrides come first on purpose: an override is a human decision about one
// event, and a rule that could overrule it would make the override untestable.
//
// Two evidence vocabularies, kept apart on purpose:
//   - exclusions match on *any* evidence (`leagues`, `leaguePatterns`, `namePatterns`);
//   - admissions match on League evidence only (`leagues`, `leaguePatterns`), and may
//     add a `requiresNamePatterns` filter that must also hold. Admitting on a name
//     alone would let a page title drag an event in; the name is only used to *narrow*
//     a league that also runs events the scope excludes (IEM's regional stops).

import { readFile } from "node:fs/promises";

import type { SourceEvent } from "./normalize.ts";

export type RuleEntry = { key: string; reason: string };

/** Which source fields an entry looks at. Every field present must be checked. */
export type MatchClause = {
	/** Source `League` strings, compared case- and punctuation-insensitively. */
	leagues?: string[];
	/** RegExp sources tried against the source `League` string. */
	leaguePatterns?: string[];
	/** RegExp sources tried against the display name and the overview page. */
	namePatterns?: string[];
};

export type AdmittedLeague = RuleEntry &
	Omit<MatchClause, "namePatterns"> & {
		/** The format this league is admitted *as*; must equal `format.required`. */
		format: string;
		/** An extra condition on the event's own name that must also hold. */
		requiresNamePatterns?: string[];
		/** Required with `requiresNamePatterns`: why a page in this league did not match. */
		notMatching?: RuleEntry;
	};

export type Exclusion = RuleEntry & MatchClause;

export type Override = { overviewPage: string; reason: string };

export type EventSelectionRule = {
	version: number;
	description: string;
	format: { required: string; reason: string };
	years: {
		/** First year in the dataset's declared era. */
		from: number;
		/** Why an event dated before the floor is out of scope. */
		before: RuleEntry;
		/** Why an event the source did not date cannot be placed in the era. */
		unknown: RuleEntry;
	};
	region: {
		include: string[];
		/** Source values that mean "not recorded", matched case-insensitively. */
		unknownValues: string[];
		unknown: RuleEntry;
		notInternational: RuleEntry;
	};
	admitted: AdmittedLeague[];
	exclusions: Exclusion[];
	fallback: RuleEntry;
	overrides: { include: Override[]; exclude: Override[] };
};

export type RuleDecision = {
	decision: "included" | "rejected";
	/** Which clause decided it. */
	rule: "override" | "region" | "year" | "exclusion" | "admitted" | "fallback";
	/** Which entry inside that clause, e.g. `all-star` or `worlds`. */
	key: string;
	/** The stated reason, verbatim from the rule file. */
	reason: string;
};

/** Case- and punctuation-insensitive league match: `All-Star` = `All Star` = `allstar`. */
export function leagueKey(league: string): string {
	return league.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Does an event's display name or page match a `namePatterns` entry? */
function matchesName(pattern: string, event: SourceEvent): boolean {
	const regex = new RegExp(pattern, "i");
	return regex.test(event.name) || regex.test(event.overviewPage);
}

/** Does the event's source `League` satisfy an entry's league evidence? */
function matchesLeague(clause: MatchClause, league: string): boolean {
	const exact = clause.leagues ?? [];
	const patterns = clause.leaguePatterns ?? [];
	return exact.some((candidate) => leagueKey(candidate) === leagueKey(league)) || patterns.some((pattern) => new RegExp(pattern, "i").test(league));
}

function hasLeagueEvidence(clause: MatchClause): boolean {
	return (clause.leagues ?? []).length > 0 || (clause.leaguePatterns ?? []).length > 0;
}

function patternsOf(clause: MatchClause): string[] {
	return [...(clause.leaguePatterns ?? []), ...(clause.namePatterns ?? [])];
}

/** Parse and check the rule data. A malformed rule fails the build, not the output. */
export function parseRule(text: string, source = "event-selection rule"): EventSelectionRule {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${source}: not JSON (${(error as Error).message})`);
	}
	const rule = parsed as EventSelectionRule;
	const problems: string[] = [];
	const entry = (label: string, value: RuleEntry | undefined): void => {
		if (!value || typeof value.key !== "string" || value.key.trim() === "") problems.push(`${label}: \`key\` must be a non-empty string`);
		if (!value || typeof value.reason !== "string" || value.reason.trim() === "") problems.push(`${label}: \`reason\` is mandatory`);
	};
	const checkPatterns = (label: string, patterns: string[] | undefined): void => {
		for (const pattern of patterns ?? []) {
			try {
				new RegExp(pattern, "i");
			} catch (error) {
				problems.push(`${label}: bad pattern ${JSON.stringify(pattern)} (${(error as Error).message})`);
			}
		}
	};

	if (!Number.isInteger(rule.version) || rule.version < 1) problems.push("`version` must be a positive integer");
	if (typeof rule.description !== "string" || rule.description.trim() === "") problems.push("`description` is mandatory");
	if (!rule.format || typeof rule.format.required !== "string" || rule.format.required.trim() === "") {
		problems.push("`format.required` is mandatory — the rule says *what* is being selected");
	}
	if (typeof rule.format?.reason !== "string" || rule.format.reason.trim() === "") problems.push("`format.reason` is mandatory");

	if (!Number.isInteger(rule.years?.from)) problems.push("`years.from` must be the first year of the declared era");
	entry("years.before", rule.years?.before);
	entry("years.unknown", rule.years?.unknown);

	if (!rule.region || !Array.isArray(rule.region.include) || rule.region.include.length === 0) {
		problems.push("`region.include` must list at least one region");
	}
	if (!Array.isArray(rule.region?.unknownValues)) problems.push("`region.unknownValues` must be an array of source values meaning 'not recorded'");
	entry("region.unknown", rule.region?.unknown);
	entry("region.notInternational", rule.region?.notInternational);
	entry("fallback", rule.fallback);

	const admittedKeys = new Set<string>();
	for (const [index, admitted] of (rule.admitted ?? []).entries()) {
		const label = `admitted[${index}]${admitted?.key ? ` (${admitted.key})` : ""}`;
		entry(label, admitted);
		if (admittedKeys.has(admitted?.key)) problems.push(`${label}: duplicate key`);
		admittedKeys.add(admitted?.key);
		if (!hasLeagueEvidence(admitted)) problems.push(`${label}: needs \`leagues\` or \`leaguePatterns\` — a name alone is not admission evidence`);
		if (admitted?.format !== rule.format?.required) {
			problems.push(`${label}: format ${JSON.stringify(admitted?.format)} is not the required format ${JSON.stringify(rule.format?.required)}`);
		}
		checkPatterns(label, patternsOf(admitted));
		checkPatterns(`${label}.requiresNamePatterns`, admitted?.requiresNamePatterns);
		if ((admitted?.requiresNamePatterns ?? []).length > 0 && admitted?.notMatching === undefined) {
			problems.push(`${label}: \`requiresNamePatterns\` needs a \`notMatching\` entry so the events it filters out are rejected with a stated reason`);
		}
		if (admitted?.notMatching !== undefined) entry(`${label}.notMatching`, admitted.notMatching);
	}
	if ((rule.admitted ?? []).length === 0) problems.push("`admitted` must list at least one league");

	const exclusionKeys = new Set<string>();
	for (const [index, exclusion] of (rule.exclusions ?? []).entries()) {
		const label = `exclusions[${index}]${exclusion?.key ? ` (${exclusion.key})` : ""}`;
		entry(label, exclusion);
		if (exclusionKeys.has(exclusion?.key)) problems.push(`${label}: duplicate key`);
		exclusionKeys.add(exclusion?.key);
		if (!hasLeagueEvidence(exclusion) && (exclusion?.namePatterns ?? []).length === 0) {
			problems.push(`${label}: needs \`leagues\`, \`leaguePatterns\` or \`namePatterns\``);
		}
		checkPatterns(label, patternsOf(exclusion));
	}

	// An exclusion that names an admitted league would make the rule contradict
	// itself and keep whichever clause happened to run first.
	const admittedLeagues = new Set((rule.admitted ?? []).flatMap((a) => (a?.leagues ?? []).map(leagueKey)));
	for (const exclusion of rule.exclusions ?? []) {
		for (const league of exclusion?.leagues ?? []) {
			if (admittedLeagues.has(leagueKey(league))) {
				problems.push(`exclusion ${exclusion.key}: league ${JSON.stringify(league)} is also admitted`);
			}
		}
	}

	const seenOverrides = new Map<string, "include" | "exclude">();
	for (const side of ["include", "exclude"] as const) {
		for (const [index, override] of (rule.overrides?.[side] ?? []).entries()) {
			const label = `overrides.${side}[${index}]`;
			if (typeof override?.overviewPage !== "string" || override.overviewPage.trim() === "") {
				problems.push(`${label}: \`overviewPage\` is mandatory — an override must name its event`);
				continue;
			}
			if (typeof override.reason !== "string" || override.reason.trim() === "") problems.push(`${label}: \`reason\` is mandatory`);
			const previous = seenOverrides.get(override.overviewPage);
			if (previous !== undefined && previous !== side) problems.push(`overrides: ${override.overviewPage} is both included and excluded`);
			seenOverrides.set(override.overviewPage, side);
		}
	}
	if (!rule.overrides || !Array.isArray(rule.overrides.include) || !Array.isArray(rule.overrides.exclude)) {
		problems.push("`overrides.include` and `overrides.exclude` must both be arrays (empty is fine)");
	}

	if (problems.length > 0) {
		throw new Error(`${source}: invalid rule\n  - ${problems.join("\n  - ")}`);
	}
	return rule;
}

export async function loadRule(file: string): Promise<EventSelectionRule> {
	return parseRule(await readFile(file, "utf8"), file);
}

/** Apply the rule to one source event. */
export function evaluateEvent(rule: EventSelectionRule, event: SourceEvent): RuleDecision {
	const overrideExclude = rule.overrides.exclude.find((override) => override.overviewPage === event.overviewPage);
	if (overrideExclude) {
		return { decision: "rejected", rule: "override", key: "override-exclude", reason: overrideExclude.reason };
	}
	const overrideInclude = rule.overrides.include.find((override) => override.overviewPage === event.overviewPage);
	if (overrideInclude) {
		return { decision: "included", rule: "override", key: "override-include", reason: overrideInclude.reason };
	}

	const region = event.region.trim();
	const unknownRegions = new Set((rule.region.unknownValues ?? [""]).map((value) => value.trim().toLowerCase()));
	if (region === "" || unknownRegions.has(region.toLowerCase())) {
		return { decision: "rejected", rule: "region", key: rule.region.unknown.key, reason: rule.region.unknown.reason };
	}
	if (!rule.region.include.some((admitted) => admitted.trim().toLowerCase() === region.toLowerCase())) {
		return {
			decision: "rejected",
			rule: "region",
			key: rule.region.notInternational.key,
			reason: `${rule.region.notInternational.reason} (region: ${region})`,
		};
	}

	if (event.dateStart === "") {
		return { decision: "rejected", rule: "year", key: rule.years.unknown.key, reason: rule.years.unknown.reason };
	}
	const year = Number(event.dateStart.slice(0, 4));
	if (!Number.isInteger(year) || year < rule.years.from) {
		return {
			decision: "rejected",
			rule: "year",
			key: rule.years.before.key,
			reason: `${rule.years.before.reason} (event dated ${event.dateStart}, era starts ${rule.years.from})`,
		};
	}

	for (const exclusion of rule.exclusions) {
		const leagueHit = matchesLeague(exclusion, event.league);
		const patternHit = (exclusion.namePatterns ?? []).some((pattern) => matchesName(pattern, event));
		if (leagueHit || patternHit) {
			return { decision: "rejected", rule: "exclusion", key: exclusion.key, reason: exclusion.reason };
		}
	}

	const admitted = rule.admitted.find((candidate) => matchesLeague(candidate, event.league));
	if (admitted) {
		const required = admitted.requiresNamePatterns ?? [];
		if (required.length === 0 || required.some((pattern) => matchesName(pattern, event))) {
			return { decision: "included", rule: "admitted", key: admitted.key, reason: admitted.reason };
		}
		const notMatching = admitted.notMatching;
		if (notMatching) {
			return { decision: "rejected", rule: "exclusion", key: notMatching.key, reason: `${notMatching.reason} (event: ${event.name})` };
		}
	}

	return {
		decision: "rejected",
		rule: "fallback",
		key: rule.fallback.key,
		reason: `${rule.fallback.reason} (league: ${event.league || "none recorded"})`,
	};
}
