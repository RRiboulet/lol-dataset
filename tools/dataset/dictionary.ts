// dictionary: the curated layer's data dictionary, rendered from the JSON schemas that
// guard it (ticket 11).
//
// The schemas under `data/curated/schema/` are the field-level contract — `validate.ts`
// checks every emitted row against them — but a reader who wants to know whether `gold`
// can be absent should not have to read JSON Schema to find out. This renders them as
// markdown tables, one section per curated file.
//
// It is generated rather than hand-copied for the reason the model's dictionary is: a
// field added to a schema cannot then go undocumented. `dictionary --check` (and the
// suite) regenerates the bytes and compares them with the committed file, so a schema
// change that forgets the dictionary fails the gate instead of quietly leaving a stale
// table behind.
//
// What is deliberately *not* here: prose about grains, joins, identity or coverage. Those
// are decisions and caveats, and they live in `docs/dataset/using-the-dataset.md`, which
// can say why. This file says what is in each record.

import { readFile } from "node:fs/promises";
import * as path from "node:path";

export const DEFAULT_SCHEMA_DIR = path.join(import.meta.dirname, "..", "..", "data", "curated", "schema");
export const DEFAULT_CURATED_DIR = path.join(import.meta.dirname, "..", "..", "data", "curated");
export const DEFAULT_DICTIONARY_FILE = path.join(import.meta.dirname, "..", "..", "docs", "dataset", "curated-data-dictionary.md");

/** One curated file and the checked-in schema that guards it. */
export type DictionaryInput = { file: string; schema: string };

type SchemaNode = {
	title?: string;
	description?: string;
	type?: string;
	required?: string[];
	properties?: Record<string, SchemaNode>;
	items?: SchemaNode;
	enum?: (string | number)[];
	const?: string | number;
	minimum?: number;
};

type Field = { path: string; type: string; state: "always" | "when present" | "no"; notes: string };

function typeOf(node: SchemaNode): string {
	if (node.type === "array") return `array of ${node.items === undefined ? "any" : typeOf(node.items)}`;
	return node.type ?? "any";
}

/**
 * Every field in the schema, flattened, with the nested path a reader can follow:
 * `sides[].teamId` is a field of one element of `sides`.
 *
 * Presence has three states, because two would lie. `always` means the key is in every
 * record. `when present` means the field is required *inside* its object but some object
 * above it is optional, so a record can still lack it by lacking the parent. `no` means it
 * is optional within its own object. Collapsing the middle case into `always` would claim
 * a key every record has, and into `no` would lose the fact that a pick always names a
 * champion.
 */
function fieldsOf(schema: SchemaNode, prefix = "", ancestorsRequired = true, out: Field[] = []): Field[] {
	for (const [name, node] of Object.entries(schema.properties ?? {})) {
		const fieldPath = prefix === "" ? name : `${prefix}.${name}`;
		const requiredHere = (schema.required ?? []).includes(name);
		const state: Field["state"] = !requiredHere ? "no" : ancestorsRequired ? "always" : "when present";
		const notes: string[] = [];
		if (node.description !== undefined) notes.push(node.description);
		if (node.enum !== undefined) notes.push(`one of ${node.enum.map((value) => `\`${value}\``).join(", ")}`);
		if (node.const !== undefined) notes.push(`always \`${node.const}\``);
		if (node.minimum !== undefined) notes.push(`at least ${node.minimum}`);
		out.push({ path: fieldPath, type: typeOf(node), state, notes: notes.join(" ") });
		const element = node.type === "array" ? node.items : node;
		if (element?.type === "object" && element.properties !== undefined) {
			const childPrefix = node.type === "array" ? `${fieldPath}[]` : fieldPath;
			fieldsOf(element, childPrefix, ancestorsRequired && requiredHere, out);
		}
	}
	return out;
}

function markdownCell(text: string): string {
	return text.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

/** How many records the committed file holds; the manifest is one document, not a stream. */
async function recordCount(curatedDir: string, file: string): Promise<string> {
	const text = await readFile(path.join(curatedDir, file), "utf8");
	if (file.endsWith(".jsonl")) return `${text.split("\n").filter((line) => line.length > 0).length} row(s)`;
	return "1 document";
}

/**
 * Render the curated dictionary.
 *
 * The inputs are passed in, not discovered, so the caller's registry (`OUTPUTS` plus the
 * manifest) stays the one place a curated file is declared: a file the build stops
 * emitting leaves this dictionary in the same change, rather than lingering as
 * documentation for a file that no longer exists.
 */
export async function renderCuratedDictionary(
	inputs: readonly DictionaryInput[],
	options: { schemaDir?: string; curatedDir?: string } = {},
): Promise<string> {
	const schemaDir = options.schemaDir ?? DEFAULT_SCHEMA_DIR;
	const curatedDir = options.curatedDir ?? DEFAULT_CURATED_DIR;

	const loaded: { input: DictionaryInput; schema: SchemaNode; fields: Field[]; records: string }[] = [];
	for (const input of inputs) {
		const text = await readFile(path.join(schemaDir, input.schema), "utf8");
		const schema = JSON.parse(text) as SchemaNode;
		loaded.push({ input, schema, fields: fieldsOf(schema), records: await recordCount(curatedDir, input.file) });
	}

	const lines: string[] = [
		"# The curated layer — data dictionary",
		"",
		"Generated from `data/curated/schema/*.schema.json` and the committed records by",
		"`node tools/dataset/cli.ts dictionary`. **Do not edit by hand**: the dataset suite",
		"regenerates this file and fails when the committed bytes differ, so a schema change",
		"that forgets the dictionary fails the gate rather than leaving a stale table behind.",
		"",
		"## How to read this",
		"",
		"- One file per section, below, in the order the build emits them (`OUTPUTS` in",
		"  `tools/dataset/build.ts`), with `manifest.json` last.",
		"- **Records** is the row count of the committed file today. It moves when the corpus",
		"  grows; the schema does not.",
		"- **Required `no` means the field can be absent**, and an absent key means the source",
		"  did not state the value. Absence is never `null` and never `0`: a recorded zero is",
		"  `0`, and the two are different answers. The column has three states, because two",
		"  would lie: **always** (the key is in every record), **when present** (the field is",
		"  required inside its object, but an object above it is optional, so a record can still",
		"  lack it by lacking the parent), and **no** (optional within its own object).",
		"- Every schema forbids unknown fields (`additionalProperties: false`), so a field not",
		"  listed in a file's table is a defect, not an extension point.",
		"- Canonical ids are `evt-`, `mt-`, `gm-`, `pg-`, `tm-`, `pl-` and `ch-` followed by 12",
		"  hex characters, derived from the source's own identifiers so a rebuild cannot",
		"  renumber them (spec D3). Every reference carries the display name beside the id, so",
		"  a record reads without a join. The exact pattern for each id column is in its schema.",
		"- Dates are `YYYY-MM-DD`, instants are `YYYY-MM-DDTHH:MM:SSZ` in UTC, files are UTF-8",
		"  with LF line endings, and one JSON object is one line.",
		"- `manifest.json` is a single JSON document rather than a stream of records; its",
		"  section describes the document's shape.",
		"",
		"## At a glance",
		"",
		"| File | Records | Schema | What it holds |",
		"|---|---|---|---|",
	];
	for (const { input, schema, records } of loaded) {
		lines.push(
			`| \`${input.file}\` | ${records} | \`${input.schema}\` | ${markdownCell(schema.title ?? "")} |`,
		);
	}

	lines.push("");
	for (const { input, schema, fields } of loaded) {
		lines.push(`## \`${input.file}\`${schema.title === undefined ? "" : ` — ${schema.title}`}`, "");
		if (schema.description !== undefined) lines.push(markdownCell(schema.description), "");
		lines.push(`Schema: \`data/curated/schema/${input.schema}\`. Fields: ${fields.length}.`, "");
		lines.push("| Field | Type | Required | Notes |", "|---|---|---|---|");
		for (const field of fields) {
			lines.push(`| \`${field.path}\` | ${field.type} | ${field.state} | ${field.notes === "" ? "—" : markdownCell(field.notes)} |`);
		}
		lines.push("");
	}

	return `${lines.join("\n").trimEnd()}\n`;
}
