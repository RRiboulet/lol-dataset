// build: the pipeline seam (spec test seam S1).
//
//   readPayloads(rawDir) -> normalize -> rule -> assemble -> emit -> validate
//
// Everything below the cache is a pure function of files on disk (spec D5): this
// function takes a directory of recorded payloads and a rule file, and returns
// bytes. No network, no clock, no ambient state — which is why the whole suite can
// run with no network access available, and why two runs over the same directory
// are byte-identical by construction rather than by luck.
//
// Ticket 08 grows the fetch layer above this seam; tickets 03-05 add more entity
// paths beside `events`; ticket 06 adds the invariant gate after validation. None of
// them need to move the boundary drawn here.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { AssembledDataset, EventRecord, SelectionRecord } from "./assemble.ts";
import { assembleDataset } from "./assemble.ts";
import { readPayloads } from "./cache.ts";
import { toJsonl } from "./emit.ts";
import { normalizeTournaments } from "./normalize.ts";
import type { EventSelectionRule } from "./rule.ts";
import { loadRule } from "./rule.ts";
import { assertValid } from "./validate.ts";

/** The entity file and the selection report, each with the schema that guards it. */
export const OUTPUTS = {
	"events.jsonl": { schema: "event.schema.json" },
	"event-selection.jsonl": { schema: "event-selection.schema.json" },
} as const;

export type OutputFile = keyof typeof OUTPUTS;

export type BuildOptions = {
	/** Directory of recorded payloads; `raw/` in a real build, fixtures in tests. */
	rawDir: string;
	/** The committed rule. Defaults to this tool's own `rules/event-selection.json`. */
	ruleFile?: string;
	/** Directory holding the checked-in schemas. Defaults to `data/curated/schema/`. */
	schemaDir?: string;
};

export type BuildResult = AssembledDataset & {
	/** The bytes to write, keyed by file name. */
	files: Record<OutputFile, string>;
	/** The rule that produced them, so a caller can explain a decision. */
	rule: EventSelectionRule;
};

const TOOL_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(TOOL_DIR, "..", "..");

export const DEFAULT_RULE_FILE = path.join(TOOL_DIR, "rules", "event-selection.json");
export const DEFAULT_SCHEMA_DIR = path.join(REPO_ROOT, "data", "curated", "schema");

type Schema = Record<string, unknown>;

async function loadSchema(schemaDir: string, file: string): Promise<Schema> {
	return JSON.parse(await readFile(path.join(schemaDir, file), "utf8")) as Schema;
}

function validateFile(file: OutputFile, body: string, schema: Schema): void {
	if (body === "") return;
	const lines = body.endsWith("\n") ? body.slice(0, -1).split("\n") : body.split("\n");
	for (const [index, line] of lines.entries()) {
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch (error) {
			throw new Error(`${file}:${index + 1}: not JSON (${(error as Error).message})`);
		}
		assertValid(schema, record, `${file}:${index + 1}`, OUTPUTS[file].schema);
	}
}

/** Build the dataset from recorded payloads. Throws rather than emit anything invalid. */
export async function buildDataset(options: BuildOptions): Promise<BuildResult> {
	const ruleFile = options.ruleFile ?? DEFAULT_RULE_FILE;
	const schemaDir = options.schemaDir ?? DEFAULT_SCHEMA_DIR;

	const rule = await loadRule(ruleFile);
	const payloads = await readPayloads(options.rawDir);
	if (payloads.length === 0) {
		// An empty cache is a failed build, not an empty dataset: emitting zero rows
		// would look like a successful run over an event that has no data.
		throw new Error(`${options.rawDir}: no recorded payloads found`);
	}
	const sources = normalizeTournaments(payloads);
	const assembled = assembleDataset(rule, sources);

	const files: Record<OutputFile, string> = {
		"events.jsonl": toJsonl(assembled.events),
		"event-selection.jsonl": toJsonl(assembled.selection),
	};

	for (const [file, output] of Object.entries(OUTPUTS) as [OutputFile, (typeof OUTPUTS)[OutputFile]][]) {
		validateFile(file, files[file], await loadSchema(schemaDir, output.schema));
	}

	return { ...assembled, files, rule };
}

/** Write the emitted bytes. The only stage that writes to the output directory. */
export async function writeDataset(result: Pick<BuildResult, "files">, outDir: string): Promise<void> {
	await mkdir(outDir, { recursive: true });
	for (const [file, body] of Object.entries(result.files) as [OutputFile, string][]) {
		await writeFile(path.join(outDir, file), body, "utf8");
	}
}

/** Export the two record types so callers and tests can name them. */
export type { EventRecord, SelectionRecord };
