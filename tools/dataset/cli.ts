// cli: one command over the pipeline.
//
//   node tools/dataset/cli.ts build                     # raw/ -> data/curated/, always offline
//   node tools/dataset/cli.ts build --check             # fail if the committed data drifted
//   node tools/dataset/cli.ts build --raw fixtures/raw --check   # ... against the recorded fixtures
//   node tools/dataset/cli.ts model                     # data/curated/ -> data/model/
//   node tools/dataset/cli.ts model --check             # fail if the committed model drifted
// `model` reads `data/curated/` and writes `data/model/` by default; `--curated` and
// `--out` point it at another tree.
//
// `--check` compares entity files byte for byte and the manifest on everything that
// describes the data. It deliberately tolerates one difference: a payload's
// `fetchedAt`. Revalidating the same bytes against the source changes only that
// timestamp, and a data rebuild must not fail because the cache was refreshed
// (ticket 07). A payload the committed manifest does not name, a changed body hash,
// or an entity digest from some other dataset all still fail.
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

import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";

import type { BuildResult, OutputFile } from "./build.ts";
import { buildDataset, DEFAULT_RULE_FILE, DEFAULT_SCHEMA_DIR, OUTPUTS, writeDataset } from "./build.ts";
import type { CargoQuery } from "./cache.ts";
import type { ModelBuild } from "./model.ts";
import { compareManifest, MANIFEST_FILE } from "./manifest.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

function describe(result: BuildResult): string {
	const lines: string[] = [];
	const { events, selection, decisions, identity, scoreboards } = result;
	const rejected = selection.length - events.length;
	lines.push(`${events.length} event(s) selected, ${rejected} rejected, from ${selection.length} considered`);
	lines.push(
		`${identity.teams.length} team(s), ${identity.players.length} player(s), ${identity.champions.length} champion(s), ` +
			`${identity.aliases.length} alias row(s), ${identity.unresolved.length} unresolved reference(s)`,
	);
	const playerStates = new Map<string, number>();
	for (const game of scoreboards.games) {
		const state = game.coverage.playerStats;
		playerStates.set(state, (playerStates.get(state) ?? 0) + 1);
	}
	lines.push(
		`${result.playerGames.rows.length} player-game row(s): ` +
			[...playerStates.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([state, count]) => `${count} ${state}`).join(", "),
	);
	const states = new Map<string, number>();
	for (const record of scoreboards.eventGames) states.set(record.state, (states.get(record.state) ?? 0) + 1);
	const stateText = [...states.entries()]
		.sort((a, b) => (a[0] < b[0] ? -1 : 1))
		.map(([state, count]) => `${count} ${state}`)
		.join(", ");
	lines.push(`${scoreboards.games.length} game(s), ${scoreboards.matches.length} match(es) — events: ${stateText}`);
	if (scoreboards.gamesWithoutMatch.length > 0) {
		lines.push(`  ${scoreboards.gamesWithoutMatch.length} game(s) whose series the corpus does not carry — no canonical matchId`);
	}
	if (scoreboards.detachedGames.length > 0) {
		// Not the same thing as an absent series row: the corpus carries one, and it names two
		// other teams. The game is kept, the link is refused (ticket 14).
		lines.push(
			`  ${scoreboards.detachedGames.length} game(s) whose series row names other teams — emitted without a canonical matchId ` +
				`(${[...new Set(scoreboards.detachedGames.map((game) => game.matchId))].sort().join(", ")})`,
		);
	}
	if (scoreboards.contradictedMatches.length > 0) {
		lines.push(
			`  ${scoreboards.contradictedMatches.length} series row(s) every game naming them contradicts — not emitted ` +
				`(${scoreboards.contradictedMatches.join(", ")})`,
		);
	}
	if (scoreboards.seriesConflicts.length > 0) {
		// The same facts are committed in series-conflicts.jsonl, so a reader who was not
		// watching this terminal can still tell a contradicted series from an unfetched one.
		const detached = scoreboards.seriesConflicts.filter((row) => row.kind === "detached-game").length;
		const contradicted = scoreboards.seriesConflicts.filter((row) => row.kind === "contradicted-series").length;
		lines.push(`  ${scoreboards.seriesConflicts.length} series conflict row(s) committed: ${detached} detached game(s), ${contradicted} contradicted series`);
	}
	if (scoreboards.ignoredGames.length > 0 || scoreboards.ignoredMatches.length > 0) {
		// A payload that covers a page the rule rejected is normal for a crawl window, but
		// it must never be silently absorbed: these rows are counted, not emitted.
		const pages = [...new Set([...scoreboards.ignoredGames, ...scoreboards.ignoredMatches])].sort();
		lines.push(`  ignored ${scoreboards.ignoredGames.length} game(s) and ${scoreboards.ignoredMatches.length} match(es) from pages no selected event covers: ${pages.join(", ")}`);
	}
	for (const record of scoreboards.eventGames) {
		if (record.state === "recorded") continue;
		lines.push(`  ${record.eventName}: ${record.state} — ${record.overviewPage}`);
	}
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

/** One line per model table: its row count and declared grain. */
function describeModel(result: ModelBuild): string {
	const lines = result.tables.map((table) => `${table.name}: ${table.rows.length} row(s) — ${table.grain}`);
	return lines.join("\n");
}

/** Compare the model's bytes with what is committed; the model has no manifest. */
async function checkModel(result: ModelBuild, outDir: string): Promise<string[]> {
	const drift: string[] = [];
	// The directory is part of the contract, not just the emitted files: a stray file a
	// former build left behind must fail the check, or a schema change that drops a
	// table would leave a stale CSV that still looks committed and current.
	const emitted = new Set(Object.keys(result.files));
	const present = new Set(await readdir(outDir).catch(() => []));
	for (const entry of [...present].sort()) {
		if (!emitted.has(entry)) {
			drift.push(`${entry}: the model build does not emit this file — remove it`);
		}
	}
	for (const [file, body] of Object.entries(result.files)) {
		const committed = await readFile(path.join(outDir, file), "utf8").catch(() => undefined);
		if (committed === body) continue;
		if (committed === undefined) {
			drift.push(`${file}: not committed (run \`node tools/dataset/cli.ts model\`)`);
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

/** Compare the build's bytes with what is committed; report the first difference per file. */
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
	// The manifest is not compared byte for byte: it carries each payload's `fetchedAt`,
	// and revalidating the same bytes against the source must not look like data drift
	// (ticket 07). Everything that describes the data is compared — the entity digests
	// and every payload pin except that timestamp — so a cache that changed, a payload
	// the build stopped reading, or a manifest describing some other dataset all fail.
	const committedManifest = await readFile(path.join(outDir, MANIFEST_FILE), "utf8").catch(() => undefined);
	if (committedManifest === undefined) {
		drift.push(`${MANIFEST_FILE}: not committed (run the build without --check)`);
	} else {
		let parsed: unknown;
		try {
			parsed = JSON.parse(committedManifest);
		} catch (error) {
			drift.push(`${MANIFEST_FILE}: not JSON (${(error as Error).message})`);
			parsed = undefined;
		}
		if (parsed !== undefined) drift.push(...compareManifest(parsed, result.manifest));
	}
	return drift;
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			raw: { type: "string" },
			out: { type: "string" },
			curated: { type: "string" },
			rule: { type: "string" },
			aliases: { type: "string" },
			eras: { type: "string" },
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

	if (command === "model") {
		// Imported here so `build` keeps exactly the modules it had (spec D5). The model
		// stage is below the cache and reads only the committed curated files.
		const { buildModel, loadModelInput, writeModel } = await import("./model.ts");
		const curatedDir = values.curated ?? path.join(REPO_ROOT, "data", "curated");
		const outDir = values.out ?? path.join(REPO_ROOT, "data", "model");
		const result = buildModel(await loadModelInput(curatedDir));
		console.log(describeModel(result));
		console.log(`inputs: ${curatedDir}`);
		if (values.check) {
			const drift = await checkModel(result, outDir);
			if (drift.length > 0) {
				console.error(`\nthe committed model does not match a rebuild:\n  - ${drift.join("\n  - ")}`);
				process.exitCode = 1;
				return;
			}
			console.log("committed model matches a rebuild");
			return;
		}
		await writeModel(result, outDir);
		console.log(`wrote ${Object.keys(result.files).join(", ")} to ${outDir}`);
		return;
	}

	if (command !== "build") {
		throw new Error(`unknown command ${JSON.stringify(command)}; expected \`build\`, \`fetch\` or \`model\``);
	}

	const outDir = values.out ?? path.join(REPO_ROOT, "data", "curated");
	const result = await buildDataset({
		rawDir,
		ruleFile: values.rule ?? DEFAULT_RULE_FILE,
		aliasFile: values.aliases,
		eraFile: values.eras,
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
	console.log(
		`provenance: ${result.manifest.payloads.length} payload(s) pinned by sha256, ` +
			`${result.manifest.entities.length} entity file(s) under digest ${result.manifest.entityDigest.slice(0, 12)}`,
	);
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
	console.log(`wrote ${Object.keys(OUTPUTS).join(", ")}, ${MANIFEST_FILE} to ${outDir}`);
}

await main();
