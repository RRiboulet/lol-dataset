// build: the pipeline seam (spec test seam S1).
//
//   readPayloads(rawDir) -> verify provenance -> normalize -> rule -> assemble
//                        -> emit -> validate -> invariants -> manifest
//
// Everything below the cache is a pure function of files on disk (spec D5): this
// function takes a directory of recorded payloads and a rule file, and returns
// bytes. No network, no clock, no ambient state — which is why the whole suite can
// run with no network access available, and why two runs over the same directory
// are byte-identical by construction rather than by luck.
//
// Two steps are ticket 07's (spec R8, R9): the provenance gate refuses a payload whose
// bytes no longer match its sidecar, and the returned manifest pins every payload read
// plus the digests of the emitted files. Both ship beside the bytes, so `--check` can
// tell "same data" from "different data" without a fresh network call.
//
// Ticket 08 grows the fetch layer above this seam; tickets 03-05 add more entity
// paths beside `events` and the identity tables; ticket 06 adds the invariant gate
// after validation. None of them need to move the boundary drawn here.
//
// `OUTPUTS` is the single registry of emitted files: the file name, the checked-in
// schema that guards it, and (in `toJsonl` calls below) the records it holds. A new
// entity file is one entry here plus one record list, and both the schema gate and
// `--check` pick it up without further wiring.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { AssembledDataset } from "./assemble.ts";
import { assembleDataset } from "./assemble.ts";
import { readPayloads } from "./cache.ts";
import type { CoverageReport } from "./coverage.ts";
import { assembleCoverage } from "./coverage.ts";
import { toJsonl } from "./emit.ts";
import type { EraTable } from "./eras.ts";
import { DEFAULT_ERA_FILE, loadEraTable } from "./eras.ts";
import type { GameFormats } from "./formats.ts";
import { DEFAULT_FORMAT_FILE, loadGameFormats } from "./formats.ts";
import type { ScoreboardAssembly } from "./games.ts";
import { assembleScoreboards, selectedGameIds } from "./games.ts";
import type { HonourRecord } from "./honours.ts";
import { assembleHonours } from "./honours.ts";
import type { AssembledIdentity } from "./identity.ts";
import { assembleIdentity, DEFAULT_ALIAS_FILE, emitReferenced, loadDeclaredAliases } from "./identity.ts";
import type { Manifest } from "./manifest.ts";
import { assertPayloadHashes, buildManifest, MANIFEST_FILE, renderManifest } from "./manifest.ts";
import { normalizeSources } from "./normalize.ts";
import { assertInvariants } from "./invariants.ts";
import { assemblePlayerGames } from "./playerGames.ts";
import type { PlayerGamesAssembly } from "./playerGames.ts";
import type { EventSelectionRule } from "./rule.ts";
import { loadRule } from "./rule.ts";
import { assertValid } from "./validate.ts";

/**
 * Every emitted file and the schema that guards it. One registry, because the
 * schema gate, the CLI's `--check` and the writer all read it.
 */
export const OUTPUTS = {
	"events.jsonl": { schema: "event.schema.json" },
	"event-selection.jsonl": { schema: "event-selection.schema.json" },
	"event-games.jsonl": { schema: "event-games.schema.json" },
	"event-coverage.jsonl": { schema: "event-coverage.schema.json" },
	"era-coverage.jsonl": { schema: "era-coverage.schema.json" },
	"games.jsonl": { schema: "game.schema.json" },
	"matches.jsonl": { schema: "match.schema.json" },
	"series-conflicts.jsonl": { schema: "series-conflicts.schema.json" },
	"player-games.jsonl": { schema: "player-game.schema.json" },
	"honours.jsonl": { schema: "honour.schema.json" },
	"teams.jsonl": { schema: "team.schema.json" },
	"players.jsonl": { schema: "player.schema.json" },
	"champions.jsonl": { schema: "champion.schema.json" },
	"aliases.jsonl": { schema: "alias.schema.json" },
	"identity-unresolved.jsonl": { schema: "identity-unresolved.schema.json" },
} as const;

export type OutputFile = keyof typeof OUTPUTS;

export type BuildOptions = {
	/** Directory of recorded payloads; `raw/` in a real build, fixtures in tests. */
	rawDir: string;
	/** The committed rule. Defaults to this tool's own `rules/event-selection.json`. */
	ruleFile?: string;
	/** Declared renames the source does not record. Defaults to `rules/identity-aliases.json`. */
	aliasFile?: string;
	/** The era table that judges coverage. Defaults to `rules/game-eras.json`. */
	eraFile?: string;
	/** The declared game formats (blind pick). Defaults to `rules/game-formats.json`. */
	formatFile?: string;
	/** Directory holding the checked-in schemas. Defaults to `data/curated/schema/`. */
	schemaDir?: string;
};

export type BuildResult = AssembledDataset & {
	/** The tournament distinctions the corpus states (ticket 03 of the enrichment series). */
	honours: HonourRecord[];
	/** The bytes to write, keyed by file name. */
	files: Record<OutputFile, string>;
	/** The provenance manifest: every payload read, and the digests of `files`. */
	manifest: Manifest;
	/** `manifest` as the bytes written to `manifest.json` (spec D8: the only timestamp). */
	manifestText: string;
	/** The teams, players, champions, alias table and unresolved report. */
	identity: AssembledIdentity;
	/** Games, matches and the per-event game report (ticket 03). */
	scoreboards: ScoreboardAssembly;
	/** The per-event and per-era aggregation of the games' coverage markers (ticket 10). */
	coverage: CoverageReport;
	/** One row per player per game (ticket 04). */
	playerGames: PlayerGamesAssembly;
	/** The rule that produced the events, so a caller can explain a decision. */
	rule: EventSelectionRule;
	/** The era table coverage was judged against, for callers that explain a marker. */
	eras: EraTable;
	/** The declared game formats (blind pick), for callers that explain a draft. */
	formats: GameFormats;
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
	const eras = await loadEraTable(options.eraFile ?? DEFAULT_ERA_FILE);
	const formats = await loadGameFormats(options.formatFile ?? DEFAULT_FORMAT_FILE);
	const payloads = await readPayloads(options.rawDir);
	if (payloads.length === 0) {
		// An empty cache is a failed build, not an empty dataset: emitting zero rows
		// would look like a successful run over an event that has no data.
		throw new Error(`${options.rawDir}: no recorded payloads found`);
	}
	// Provenance before data (spec R9, ticket 07): a payload whose bytes contradict its
	// sidecar is refused here, naming the payload and the records it would have produced,
	// rather than being normalized into a dataset that the committed manifest cannot pin.
	assertPayloadHashes(payloads);
	const sources = normalizeSources(payloads);
	const assembled = assembleDataset(rule, sources.tournaments);
	// Identity first: games and matches reference teams, and their team strings are
	// observations identity has to see before the join can resolve them. Draft champion
	// observations are limited to games the selection rule admitted.
	const selected = selectedGameIds(sources.games, assembled.events);
	const selectedPages = assembled.events.map((event) => event.overviewPage);
	const rejectedPages = new Set(
		assembled.selection
			.filter((record) => record.decision === "rejected" && record.overviewPage !== "")
			.map((record) => record.overviewPage),
	);
	const assembledIdentity = assembleIdentity(sources, await loadDeclaredAliases(options.aliasFile ?? DEFAULT_ALIAS_FILE), {
		selectedGameIds: selected,
		selectedPages,
		rejectedPages,
	});
	const scoreboards = assembleScoreboards({
		games: sources.games,
		matches: sources.matches,
		drafts: sources.drafts,
		events: assembled.events,
		identity: assembledIdentity.index,
		eras,
		payloads,
		formats,
	});

	const playerGames = assemblePlayerGames({
		source: sources.playerGames,
		games: scoreboards.games,
		identity: assembledIdentity.index,
	});
	for (const game of scoreboards.games) game.coverage.playerStats = playerGames.coverageByGame.get(game.id) ?? "unavailable";

	// After the player rows, because `playerStats` is the marker they set: aggregating
	// before it would report every game's player coverage as unavailable.
	const coverage = assembleCoverage({ events: assembled.events, games: scoreboards.games, eras });

	// Distinctions after player games: the players they name are observations identity has
	// already resolved, and a player named *only* by an award becomes a referenced entity
	// here, which is what puts a coach in `players.jsonl` without a player-game row.
	const honours = assembleHonours({ source: sources.honours, events: assembled.events, identity: assembledIdentity.index });

	// The identity tables the dataset emits, named by the emitted records themselves.
	// This is the last assembly step on purpose: which rows are emitted is fully known
	// only here — a series row whose games name other teams is held back above — so the
	// entity files cannot carry a dimension row no fact reaches (ticket 10's decision
	// log: registries are resolution input, the entity files carry what the dataset uses).
	const referencedIds = new Set<string>();
	for (const game of scoreboards.games) {
		for (const side of game.sides) referencedIds.add(side.teamId);
		if (game.draft !== undefined) {
			for (const side of game.draft.sides) {
				for (const entry of [...side.picks, ...side.bans]) referencedIds.add(entry.championId);
			}
		}
	}
	for (const match of scoreboards.matches) {
		for (const side of match.sides) referencedIds.add(side.teamId);
	}
	// The conflict report is committed data too (ticket 15), and its team pairs are the
	// ids an analyst needs to join it — including the pairs a contradiction put there
	// precisely because the rows naming them disagree.
	for (const row of scoreboards.seriesConflicts) {
		for (const pair of [row.gameTeams, row.matchTeams]) {
			if (pair === null) continue;
			for (const team of pair) referencedIds.add(team.teamId);
		}
	}
	for (const row of playerGames.rows) {
		referencedIds.add(row.playerId);
		referencedIds.add(row.teamId);
		referencedIds.add(row.championId);
	}
	for (const row of honours) {
		referencedIds.add(row.playerId);
		if (row.teamId !== undefined) referencedIds.add(row.teamId);
	}
	const identity = emitReferenced(assembledIdentity, referencedIds);

	const files: Record<OutputFile, string> = {
		"events.jsonl": toJsonl(assembled.events),
		"event-selection.jsonl": toJsonl(assembled.selection),
		"event-games.jsonl": toJsonl(scoreboards.eventGames),
		"event-coverage.jsonl": toJsonl(coverage.events),
		"era-coverage.jsonl": toJsonl(coverage.eras),
		"games.jsonl": toJsonl(scoreboards.games),
		"matches.jsonl": toJsonl(scoreboards.matches),
		"series-conflicts.jsonl": toJsonl(scoreboards.seriesConflicts),
		"player-games.jsonl": toJsonl(playerGames.rows),
		"honours.jsonl": toJsonl(honours),
		"teams.jsonl": toJsonl(identity.teams),
		"players.jsonl": toJsonl(identity.players),
		"champions.jsonl": toJsonl(identity.champions),
		"aliases.jsonl": toJsonl(identity.aliases),
		"identity-unresolved.jsonl": toJsonl(identity.unresolved),
	};

	for (const [file, output] of Object.entries(OUTPUTS) as [OutputFile, (typeof OUTPUTS)[OutputFile]][]) {
		validateFile(file, files[file], await loadSchema(schemaDir, output.schema));
	}

	// The manifest is built from the same payload list and the same bytes that were read
	// and normalized, so it cannot describe a dataset the build did not produce. Entity
	// digests are taken in `OUTPUTS` order, which is the documented definition.
	const manifest = buildManifest(
		payloads,
		(Object.keys(OUTPUTS) as OutputFile[]).map((file) => ({ file, body: files[file] })),
	);
	const manifestText = renderManifest(manifest);

	// Structure first, then truth: a record can satisfy its schema and still contradict
	// the row beside it, and only this gate sees that (spec R10, ticket 06).
	assertInvariants({
		events: assembled.events,
		selection: assembled.selection,
		identity,
		games: scoreboards.games,
		matches: scoreboards.matches,
		eventGames: scoreboards.eventGames,
		seriesConflicts: scoreboards.seriesConflicts,
		eventCoverage: coverage.events,
		eraCoverage: coverage.eras,
		playerGames: playerGames.rows,
		honours,
		eras,
	});

	return { ...assembled, files, manifest, manifestText, identity, scoreboards, coverage, playerGames, honours, rule, eras, formats };
}

/**
 * Write the emitted bytes. The only stage that writes to the output directory.
 *
 * The manifest goes last and is written by the same call, so a checkout cannot end up
 * with entity files newer than the manifest that describes them.
 */
export async function writeDataset(result: Pick<BuildResult, "files" | "manifestText">, outDir: string): Promise<void> {
	await mkdir(outDir, { recursive: true });
	for (const [file, body] of Object.entries(result.files) as [OutputFile, string][]) {
		await writeFile(path.join(outDir, file), body, "utf8");
	}
	await writeFile(path.join(outDir, MANIFEST_FILE), result.manifestText, "utf8");
}
