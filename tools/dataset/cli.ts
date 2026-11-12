// cli: one command over the pipeline.
//
//   node tools/dataset/cli.ts build                     # raw/ -> data/curated/, always offline
//   node tools/dataset/cli.ts build --check             # fail if the committed data drifted
//   node tools/dataset/cli.ts build \
//     --raw tools/dataset/fixtures/raw                  # build from the recorded fixtures
//
// `--offline` is accepted and is the only mode there is: ticket 01's pipeline reads
// the cache and nothing else. Ticket 08 adds the fetch stage as a separate command,
// so `build --offline` keeps meaning exactly what the spec's verification section
// says it means.
//
// The run prints every rejection with its stated reason. The same decisions are
// committed in `event-selection.jsonl`, so a reviewer who was not watching the
// terminal can still see what the rule threw away and why.

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";

import type { BuildResult, OutputFile } from "./build.ts";
import { buildDataset, DEFAULT_RULE_FILE, DEFAULT_SCHEMA_DIR, OUTPUTS, writeDataset } from "./build.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

function describe(result: BuildResult): string {
	const lines: string[] = [];
	const { events, selection, decisions } = result;
	const rejected = selection.length - events.length;
	lines.push(`${events.length} event(s) selected, ${rejected} rejected, from ${selection.length} considered`);
	for (const record of selection) {
		const decision = decisions.get(record.id);
		const reason = decision?.reason ?? "";
		const verb = record.decision === "included" ? "included" : "rejected";
		lines.push(`  ${verb} ${record.name} [${record.league || "no league"}] — ${record.rule}:${record.key} — ${reason}`);
	}
	return lines.join("\n");
}

/** Compare built bytes with what is committed; report the first difference per file. */
async function check(result: BuildResult, outDir: string): Promise<string[]> {
	const drift: string[] = [];
	for (const [file, body] of Object.entries(result.files) as [OutputFile, string][]) {
		const committed = await readFile(path.join(outDir, file), "utf8").catch(() => undefined);
		if (committed === body) continue;
		if (committed === undefined) {
			drift.push(`${file}: not committed (run the build without --check)`);
			continue;
		}
		const built = body.split("\n");
		const there = committed.split("\n");
		const index = built.findIndex((line, i) => line !== there[i]);
		const first = index === -1 ? Math.min(built.length, there.length) : index;
		drift.push(`${file}: differs at line ${first + 1}\n    committed: ${there[first] ?? "<end of file>"}\n    built:     ${built[first] ?? "<end of file>"}`);
	}
	return drift;
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			raw: { type: "string" },
			out: { type: "string" },
			rule: { type: "string" },
			schema: { type: "string" },
			offline: { type: "boolean", default: false },
			check: { type: "boolean", default: false },
		},
	});

	const command = positionals[0] ?? "build";
	if (command !== "build") {
		throw new Error(`unknown command ${JSON.stringify(command)}; tickets 06/08 add \`model\` and \`fetch\``);
	}

	const rawDir = values.raw ?? path.join(REPO_ROOT, "raw");
	const outDir = values.out ?? path.join(REPO_ROOT, "data", "curated");
	const result = await buildDataset({
		rawDir,
		ruleFile: values.rule ?? DEFAULT_RULE_FILE,
		schemaDir: values.schema ?? DEFAULT_SCHEMA_DIR,
	}).catch((error: Error) => {
		if (values.raw === undefined && /no recorded payloads/.test(error.message)) {
			// `raw/` is the real cache and is not committed (spec D6). Until the crawl
			// (ticket 08/09) fills it, the committed dataset is built from the recorded
			// fixtures — say so rather than leaving a bare "no payloads".
			throw new Error(
				`${error.message}\n  raw/ is the (gitignored) crawl cache and is empty.\n` +
					"  The committed dataset is built from the recorded fixtures:\n" +
					"    node tools/dataset/cli.ts build --raw tools/dataset/fixtures/raw",
			);
		}
		throw error;
	});

	console.log(describe(result));
	console.log(`rule: ${values.rule ?? DEFAULT_RULE_FILE}`);
	console.log(`inputs: ${rawDir}`);

	if (values.check) {
		const drift = await check(result, outDir);
		if (drift.length > 0) {
			console.error(`\nthe committed data does not match a rebuild:\n  - ${drift.join("\n  - ")}`);
			process.exitCode = 1;
			return;
		}
		console.log("committed data matches a rebuild");
		return;
	}

	await writeDataset(result, outDir);
	console.log(`wrote ${Object.keys(OUTPUTS).join(", ")} to ${outDir}`);
}

await main();
