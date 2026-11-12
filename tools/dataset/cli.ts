// cli: one command over the pipeline.
//
//   node tools/dataset/cli.ts build                     # raw/ -> data/curated/, always offline
//   node tools/dataset/cli.ts build --check             # fail if the committed data drifted
//   node tools/dataset/cli.ts build \
//     --raw tools/dataset/fixtures/raw                  # build from the recorded fixtures
//
// `--offline` is accepted and is the only mode there is: the pipeline below the
// cache reads the cache and nothing else. Ticket 08 adds the fetch stage as a
// separate command, so `build` keeps meaning exactly what the spec's verification
// section says it means — and `fetch.ts` is imported only when that command is
// chosen, never on the build path.
//
// The fetch command takes an explicit, small plan; the crawler that generates a
// plan is ticket 10, not this ticket. A plan is a JSON array of cache queries
// (`CargoQuery` in `cache.ts`), or an object with a `queries` array:
//
//   node tools/dataset/cli.ts fetch --plan plan.json --raw raw
//   node tools/dataset/cli.ts fetch --raw raw \
//     --query '{"endpoint":"cargoexport","tables":"Tournaments","fields":"Name,OverviewPage","limit":20}'
//
// `--interval`/`--jitter` are seconds and default to the measured-safe 75/15;
// `--backoff` is the first retry delay in seconds and doubles; `--attempts` caps
// retries per query. The run is sequential, skips anything already complete in
// the cache, and stops with the query to resume from rather than hammering.
//
// The run prints every rejection with its stated reason. The same decisions are
// committed in `event-selection.jsonl`, so a reviewer who was not watching the
// terminal can still see what the rule threw away and why.

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";

import type { BuildResult, OutputFile } from "./build.ts";
import { buildDataset, DEFAULT_RULE_FILE, DEFAULT_SCHEMA_DIR, OUTPUTS, writeDataset } from "./build.ts";
import type { CargoQuery } from "./cache.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

function describe(result: BuildResult): string {
	const lines: string[] = [];
	const { events, selection, decisions, identity } = result;
	const rejected = selection.length - events.length;
	lines.push(`${events.length} event(s) selected, ${rejected} rejected, from ${selection.length} considered`);
	lines.push(
		`${identity.teams.length} team(s), ${identity.players.length} player(s), ${identity.champions.length} champion(s), ` +
			`${identity.aliases.length} alias row(s), ${identity.unresolved.length} unresolved reference(s)`,
	);
	for (const record of identity.unresolved) {
		const what = record.id === null ? `${record.candidates.join(", ")}` : record.id;
		lines.push(`  unresolved ${record.kind} ${JSON.stringify(record.string)} (${record.reason}) -> ${what}`);
	}
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
			aliases: { type: "string" },
			schema: { type: "string" },
			offline: { type: "boolean", default: false },
			check: { type: "boolean", default: false },
			plan: { type: "string" },
			query: { type: "string", multiple: true },
			interval: { type: "string" },
			jitter: { type: "string" },
			backoff: { type: "string" },
			attempts: { type: "string" },
		},
	});

	const command = positionals[0] ?? "build";
	const rawDir = values.raw ?? path.join(REPO_ROOT, "raw");

	if (command === "fetch") {
		// Imported here, not at module load: the build path must not pull in the module
		// that can reach the network (spec D5, sources.test.ts).
		const { fetchQueries, loadPlan, parsePlan } = await import("./fetch.ts");
		const queries: CargoQuery[] = [];
		if (values.plan !== undefined) queries.push(...(await loadPlan(values.plan)));
		for (const text of values.query ?? []) queries.push(...parsePlan(text, "--query"));
		if (queries.length === 0) throw new Error("fetch needs a plan: pass --plan <file> or one or more --query <json>");

		const seconds = (value: string | undefined, name: string): number | undefined => {
			if (value === undefined) return undefined;
			const parsed = Number(value);
			if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${name} must be a non-negative number of seconds`);
			return parsed * 1000;
		};
		const attempts = values.attempts === undefined ? undefined : Number(values.attempts);
		if (attempts !== undefined && (!Number.isInteger(attempts) || attempts < 1)) {
			throw new Error("--attempts must be an integer >= 1");
		}

		const result = await fetchQueries({
			queries,
			root: rawDir,
			intervalMs: seconds(values.interval, "interval"),
			jitterMs: seconds(values.jitter, "jitter"),
			backoffMs: seconds(values.backoff, "backoff"),
			maxAttempts: attempts,
			log: (line) => console.log(line),
		});
		console.log(`${result.fetched.length} fetched, ${result.skipped.length} already cached, ${result.requests} request(s)`);
		console.log(`cache: ${rawDir}`);
		return;
	}

	if (command !== "build") {
		throw new Error(`unknown command ${JSON.stringify(command)}; expected \`build\` or \`fetch\``);
	}

	const outDir = values.out ?? path.join(REPO_ROOT, "data", "curated");
	const result = await buildDataset({
		rawDir,
		ruleFile: values.rule ?? DEFAULT_RULE_FILE,
		aliasFile: values.aliases,
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
