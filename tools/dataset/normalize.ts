// normalize: raw cached payload -> typed source record.
//
// Pure by construction (spec D5): it takes bytes that are already on disk and
// returns values. No network, no clock, no ordering assumptions — a payload's
// position in the directory must never change the output.
//
// This stage maps *source fields to source fields*. It does not decide whether an
// event belongs in the dataset (that is `rule.ts`) and it does not mint identity
// (that is `assemble.ts`). Keeping it that literal is what lets ticket 09 replace
// the corpus without revisiting the rule.

import type { CachedPayload } from "./cache.ts";

/** One tournament row as the source states it, already trimmed. */
export type SourceEvent = {
	/** Source `Name`: the human-readable display name. */
	name: string;
	/** Source `OverviewPage`: the event's page, and the input to its canonical ID. */
	overviewPage: string;
	/** Source `League`, e.g. `World Championship`. */
	league: string;
	/** Source `Region`, e.g. `International`. Empty when the source has no value. */
	region: string;
	/** Source `DateStart` as a UTC calendar date (`YYYY-MM-DD`), empty when absent. */
	dateStart: string;
	/** Which cached payload carried this row, for errors that name a file. */
	sourceFile: string;
};

/** Cargo returns list-typed fields as arrays; everything else as strings. */
function asText(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (Array.isArray(value)) return value.map((item) => asText(item)).filter((item) => item !== "").join(", ");
	return String(value).trim();
}

/** `2023-10-10 07:00:00` -> `2023-10-10`; anything unparseable stays empty. */
function asDate(value: unknown): string {
	const text = asText(value);
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
	return match ? match[1] : "";
}

type CargoRow = { title?: Record<string, unknown> };

/**
 * Row objects from either recorded envelope (see `cache.ts`):
 *   api.php?action=cargoquery  -> { cargoquery: [{ title: {...} }], error? }
 *   Special:CargoExport        -> [ {...}, ... ]
 * Anything else is a payload this stage does not understand, and guessing at it
 * would be worse than failing: it would silently contribute no rows.
 */
function rowsOf(payload: CachedPayload, parsed: unknown): Record<string, unknown>[] {
	if (Array.isArray(parsed)) {
		return parsed.map((row, index) => {
			if (row === null || typeof row !== "object" || Array.isArray(row)) {
				throw new Error(`${payload.file}: row ${index} is not an object`);
			}
			return row as Record<string, unknown>;
		});
	}
	const body = parsed as { error?: { code?: string; info?: string }; cargoquery?: CargoRow[] };
	if (body.error) {
		throw new Error(`${payload.file}: the source returned an error (${body.error.code}): ${body.error.info ?? ""}`);
	}
	if (!Array.isArray(body.cargoquery)) {
		throw new Error(`${payload.file}: unrecognised payload — expected Cargo rows (an array) or \`cargoquery\``);
	}
	return body.cargoquery.map((row) => row.title ?? {});
}

/**
 * Tournaments rows from every cached payload, deduplicated by page.
 *
 * Two payloads may overlap (a year window and a single-event query), so the same
 * page arriving twice is normal and is collapsed. The same page arriving with
 * *different* values is not normal: it means one of the payloads is stale or they
 * disagree about the source, and picking a winner silently would make the output
 * depend on file order. That is a build failure naming both files.
 */
export function normalizeTournaments(payloads: CachedPayload[]): SourceEvent[] {
	const byPage = new Map<string, SourceEvent>();
	for (const payload of payloads) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload.body);
		} catch (error) {
			throw new Error(`${payload.file}: not JSON (${(error as Error).message})`);
		}
		for (const title of rowsOf(payload, parsed)) {
			const overviewPage = asText(title.OverviewPage);
			if (overviewPage === "") {
				throw new Error(`${payload.file}: a tournament row without an OverviewPage cannot be identified`);
			}
			const event: SourceEvent = {
				name: asText(title.Name) || overviewPage,
				overviewPage,
				league: asText(title.League),
				region: asText(title.Region),
				dateStart: asDate(title.DateStart),
				sourceFile: payload.file,
			};
			const seen = byPage.get(overviewPage);
			if (seen === undefined) {
				byPage.set(overviewPage, event);
			} else if (!sameEvent(seen, event)) {
				throw new Error(
					`${overviewPage}: ${seen.sourceFile} and ${event.sourceFile} disagree about the same page ` +
						`(${JSON.stringify(fields(seen))} vs ${JSON.stringify(fields(event))})`,
				);
			}
		}
	}
	return [...byPage.values()];
}

function fields(event: SourceEvent): Omit<SourceEvent, "sourceFile"> {
	const { sourceFile: _sourceFile, ...rest } = event;
	return rest;
}

function sameEvent(a: SourceEvent, b: SourceEvent): boolean {
	return JSON.stringify(fields(a)) === JSON.stringify(fields(b));
}
