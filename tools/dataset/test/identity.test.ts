// Identity: renames, duplicates and unresolved strings, at the build seam (ticket 02).
//
// Assertions here are made against the *emitted records* and the resolver built
// from the recorded fixtures, not against internal maps, because the promises the
// ticket makes are promises about the artifact: one entity per person across a
// rename, one row per display string per era, no renumbering when the corpus grows.
//
// Three cases live in the fixtures as recorded payloads:
//   - a team rebrand (`SK Telecom T1` -> `T1`, a `Teams.RenamedTo` edge),
//   - a duplicate display string (`Wolf`, the handle of eight player pages),
//   - a string the source registers nothing for (`The Bandits Prime`, a 2026 team).
// The champion rename is measured too, but not as a rename pair: the source rewrites
// retired champion names retroactively, so the retired string is declared in
// `rules/identity-aliases.json` and the test below feeds a payload the source can no
// longer produce.

import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { buildDataset } from "../build.ts";
import { AmbiguousIdentity } from "../identity.ts";
import type { BuildResult } from "../build.ts";
import { validateAgainst } from "../validate.ts";
import { CURATED_DIR, FIXTURE_RAW, SCHEMA_DIR } from "./helpers.ts";

const TEAM_RENAME = { entity: "T1", from: "SK Telecom T1", fromSeen: "2015-10-01", currentSeen: "2023-10-19" } as const;

async function fixtureBuild(): Promise<BuildResult> {
	return buildDataset({ rawDir: FIXTURE_RAW });
}

/** A writable copy of the recorded fixtures, for the cases a payload must be edited to express. */
async function fixtureCopy(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-identity-"));
	await cp(FIXTURE_RAW, dir, { recursive: true });
	return dir;
}

/** Every recorded payload for `table` inside a cache root. */
async function payloadFiles(root: string, table: string): Promise<string[]> {
	const dir = path.join(root, "lol-fandom", "cargoexport", table);
	const names = (await readdir(dir)).filter((name) => name.endsWith(".json") && !name.endsWith(".meta.json"));
	assert.ok(names.length > 0, `expected a recorded ${table} payload`);
	return names.sort().map((name) => path.join(dir, name));
}

/** The one recorded payload for a table that only needs one. */
async function payloadFile(root: string, table: string): Promise<string> {
	const files = await payloadFiles(root, table);
	assert.equal(files.length, 1, `expected one recorded ${table} payload, found ${files.length}`);
	return files[0];
}

async function readRows(file: string): Promise<Record<string, unknown>[]> {
	return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>[];
}

async function schema(name: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path.join(SCHEMA_DIR, name), "utf8")) as Record<string, unknown>;
}

test("a team rebrand in the fixtures is one entity carrying both strings and their eras", async () => {
	const { identity } = await fixtureBuild();
	const t1 = identity.teams.filter((team) => team.name === TEAM_RENAME.entity);
	assert.equal(t1.length, 1, "a rebrand must not leave two T1 entities behind");
	const rows = identity.aliases.filter((alias) => alias.kind === "team" && alias.entityId === t1[0].id);
	const old = rows.find((alias) => alias.string === TEAM_RENAME.from);
	const current = rows.find((alias) => alias.string === TEAM_RENAME.entity);
	assert.ok(old, `the entity must carry its old display string ${TEAM_RENAME.from}`);
	assert.ok(current, "the entity must carry its current display string");
	assert.deepEqual([old.firstSeen, old.lastSeen], [TEAM_RENAME.fromSeen, TEAM_RENAME.fromSeen]);
	assert.deepEqual([current.firstSeen, current.lastSeen], [TEAM_RENAME.currentSeen, TEAM_RENAME.currentSeen]);
	assert.ok(old.evidence.includes("rename"), "the old page is evidenced by the source's own RenamedTo edge");
	assert.ok(old.evidence.includes("observed"), "the old name is evidenced by a recorded scoreboard row");
})

test("an old page, a redirect name and a case variant all resolve to the renamed team", async () => {
	const { identity } = await fixtureBuild();
	const t1 = identity.teams.find((team) => team.name === TEAM_RENAME.entity);
	assert.ok(t1);
	for (const string of [TEAM_RENAME.from, "SKT T1", "SK Telecom", "t1", "sk telecom t1"]) {
		const hit = identity.index.resolve("team", string, TEAM_RENAME.fromSeen);
		assert.equal(hit?.id, t1.id, `${JSON.stringify(string)} must resolve to ${t1.id}`);
	}
})

test("the entity's ID does not change when its display name changes", async () => {
	const baseline = await fixtureBuild();
	const baselineTeams = new Map(baseline.identity.teams.map((team) => [team.overviewPage, team.id]));
	const baselineChampions = new Map(baseline.identity.champions.map((champion) => [champion.riotKey, champion.id]));
	const dir = await fixtureCopy();
	try {
		// A rebrand is a new page in the source, so the *name* is the part a payload
		// can change without touching identity: rename the page's display name and the
		// champion's display name, and assert the IDs stand still.
		const teamsFile = await payloadFile(dir, "Teams");
		const teams = await readRows(teamsFile);
		for (const row of teams) {
			if (row.OverviewPage === "T1") row.Name = "T1 Esports";
			if (row.OverviewPage === "Team Liquid") row.Name = "Team Liquid Rebranded";
		}
		await writeFile(teamsFile, JSON.stringify(teams), "utf8");

		// The source rewrites the *current* champion name retroactively (measured: 2011
		// and 2012 rows already say `Nunu &amp; Willump`), so a display rename arrives as
		// a coordinated rewrite of both the registry and the scoreboard. Identity is the
		// Riot id, so neither side of that rewrite moves the ID.
		const championsFile = await payloadFile(dir, "Champions");
		const champions = await readRows(championsFile);
		for (const row of champions) if (row.KeyInteger === 20) row.Name = "Nunu";
		await writeFile(championsFile, JSON.stringify(champions), "utf8");
		for (const file of await payloadFiles(dir, "ScoreboardPlayers")) {
			const rows = await readRows(file);
			for (const row of rows) if (row.Champion === "Nunu &amp; Willump") row.Champion = "Nunu";
			await writeFile(file, JSON.stringify(rows), "utf8");
		}

		const changed = await buildDataset({ rawDir: dir });
		const t1 = changed.identity.teams.find((team) => team.overviewPage === "T1");
		assert.ok(t1);
		assert.equal(t1.id, baselineTeams.get("T1"), "renaming a team's display name must not mint a new team ID");
		assert.equal(t1.name, "T1 Esports", "the display name is what changed");
		const nunu = changed.identity.champions.find((champion) => champion.riotKey === 20);
		assert.ok(nunu);
		assert.equal(nunu.id, baselineChampions.get(20), "renaming a champion's display name must not mint a new champion ID");
		assert.equal(nunu.name, "Nunu");
		assert.equal(changed.identity.champions.length, baseline.identity.champions.length, "no champion was minted");
		assert.equal(changed.identity.unresolved.length, baseline.identity.unresolved.length, "no reference became unresolved");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
})

test("adding an earlier event mints new IDs without altering existing ones", async () => {
	const baseline = await fixtureBuild();
	const before = {
		teams: new Map(baseline.identity.teams.map((team) => [team.id, team.name])),
		players: new Map(baseline.identity.players.map((player) => [player.id, player.name])),
		champions: new Map(baseline.identity.champions.map((champion) => [champion.id, champion.name])),
		events: new Set(baseline.events.map((event) => event.id)),
	};
	const dir = await fixtureCopy();
	try {
		// A fabricated earlier event: a Tournament the fixtures do not carry, dated
		// before the others, with one game's worth of rows. Nothing here renumbers
		// anything unless identity depends on read order or on a row counter.
		const tournaments = path.join(dir, "lol-fandom", "cargoexport", "Tournaments", "fabricated.json");
		await writeFile(
			tournaments,
			JSON.stringify([
				{
					Name: "IEM Season VI World Championship",
					OverviewPage: "IEM Season VI - World Championship",
					DateStart: "2012-03-06",
					League: "Intel Extreme Masters",
					Region: "International",
				},
			]),
			"utf8",
		);
		const scoreboard = path.join(dir, "lol-fandom", "cargoexport", "ScoreboardPlayers", "fabricated.json");
		await writeFile(
			scoreboard,
			JSON.stringify([
				{
					Name: "Fabricated Player",
					Link: "Fabricated Player",
					Team: "Fabricated Five",
					TeamVs: "T1",
					Champion: "Annie",
					OverviewPage: "IEM Season VI - World Championship",
					"DateTime UTC": "2012-03-06 10:00:00",
				},
			]),
			"utf8",
		);

		const grown = await buildDataset({ rawDir: dir });
		for (const [id, name] of before.teams) {
			const now = grown.identity.teams.find((team) => team.id === id);
			assert.ok(now, `team ${id} (${name}) disappeared when an earlier event was added`);
			assert.equal(now.name, name, `team ${id} was renamed by adding an earlier event`);
		}
		for (const [id, name] of before.players) {
			assert.equal(grown.identity.players.find((player) => player.id === id)?.name, name, `player ${id} changed`);
		}
		for (const [id, name] of before.champions) {
			assert.equal(grown.identity.champions.find((champion) => champion.id === id)?.name, name, `champion ${id} changed`);
		}
		for (const id of before.events) assert.ok(grown.events.some((event) => event.id === id), `event ${id} changed`);
		// And the new material is new, not a rewording of what was there.
		assert.ok(grown.events.length > baseline.events.length, "the fabricated 2012 event must be admitted");
		const mintedTeam = grown.identity.teams.find((team) => team.name === "Fabricated Five");
		assert.ok(mintedTeam, "the fabricated team must exist");
		assert.equal(mintedTeam.overviewPage, null, "nothing registers that team, so it has no source page");
		assert.ok(grown.identity.players.some((player) => player.name === "Fabricated Player"));
		assert.deepEqual(
			grown.identity.unresolved.filter((row) => row.reason === "no-source-identity").map((row) => row.string).sort(),
			["Fabricated Five", "Fabricated Player", "The Bandits Prime"],
			"both fabricated strings are reported, and the recorded one stays",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
})

test("two players with the same display string stay two entities, and a bare handle is ambiguous", async () => {
	const { identity } = await fixtureBuild();
	const wolves = identity.players.filter((player) => player.name === "Wolf");
	assert.ok(wolves.length >= 2, "the fixtures must carry the duplicate display string");
	assert.equal(new Set(wolves.map((wolf) => wolf.id)).size, wolves.length, "duplicates must be distinct entities");
	assert.equal(new Set(wolves.map((wolf) => wolf.overviewPage)).size, wolves.length, "each wolf is its own page");
	// The same string in the alias table, one row per entity, and only one of them dated.
	const rows = identity.aliases.filter((alias) => alias.kind === "player" && alias.string === "Wolf");
	assert.ok(rows.length >= 2, "the alias table must record the shared handle once per entity");
	assert.equal(new Set(rows.map((row) => row.entityId)).size, rows.length, "one row per entity, never a merge");
	assert.deepEqual(rows.filter((row) => row.firstSeen !== null).map((row) => row.firstSeen), ["2015-10-01"]);
	// Without a date the string names eight people: reporting that is the point.
	assert.throws(() => identity.index.resolve("player", "Wolf"), (error: unknown) => {
		assert.ok(error instanceof AmbiguousIdentity);
		assert.ok(error.candidates.length >= 2);
		return true;
	});
	const dated = identity.index.resolve("player", "Wolf", "2015-10-01");
	assert.ok(dated);
	assert.equal(dated.name, "Wolf");
	assert.equal(dated.id, rows.find((row) => row.firstSeen === "2015-10-01")?.entityId);
	// The page, unlike the handle, is unambiguous — which is why it is the identity.
	assert.ok(identity.index.resolve("player", "Wolf (Lee Jae-wan)")?.id);
})

test("an unresolved source string mints an entity and is reported, rather than failing or vanishing", async () => {
	const { identity } = await fixtureBuild();
	const [report, ...rest] = identity.unresolved;
	assert.equal(rest.length, 0, `expected exactly one unresolved reference, got ${identity.unresolved.length}`);
	assert.equal(report.kind, "team");
	assert.equal(report.string, "The Bandits Prime");
	assert.equal(report.reason, "no-source-identity");
	assert.deepEqual([report.firstSeen, report.lastSeen], ["2026-10-13", "2026-10-13"]);
	assert.ok(report.id);
	const entity = identity.teams.find((team) => team.id === report.id);
	assert.ok(entity, "the report must point at a real entity");
	assert.equal(entity.name, "The Bandits Prime", "the minted entity carries the source string as its display name");
	assert.equal(entity.overviewPage, null, "no registry page exists, and inventing one would hide that");
	// The string resolves from then on, so a later payload citing it joins the same entity.
	assert.equal(identity.index.resolve("team", "The Bandits Prime")?.id, report.id);
	// And a registry page that later appears under that exact name keeps the ID.
	const baseline = await fixtureBuild();
	const dir = await fixtureCopy();
	try {
		const teamsFile = await payloadFile(dir, "Teams");
		const teams = await readRows(teamsFile);
		teams.push({ _pageName: "The Bandits Prime", Name: "The Bandits Prime", OverviewPage: "The Bandits Prime", Region: "EMEA", RenamedTo: null });
		await writeFile(teamsFile, JSON.stringify(teams), "utf8");
		const resolved = await buildDataset({ rawDir: dir });
		const now = resolved.identity.teams.find((team) => team.name === "The Bandits Prime");
		assert.equal(now?.id, entity.id, "registering the page later must not renumber the entity");
		assert.equal(now?.overviewPage, "The Bandits Prime");
		assert.equal(resolved.identity.unresolved.length, 0, "a resolved string leaves the report");
		assert.ok(baseline.identity.unresolved.length === 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
})

test("the champion rename the source cannot record resolves through the declared alias", async () => {
	const baseline = await fixtureBuild();
	const nunu = baseline.identity.champions.find((champion) => champion.riotKey === 20);
	assert.ok(nunu);
	const declared = baseline.identity.aliases.find((alias) => alias.kind === "champion" && alias.string === "Nunu");
	assert.equal(declared?.entityId, nunu.id, "the retired display name points at the champion, not a second one");
	assert.deepEqual(declared?.evidence, ["declared"]);
	assert.equal(declared?.firstSeen, "2009-02-21", "the declared era starts at the source's own release date");

	// The source normalizes champion names retroactively, so no recording can carry a
	// `Nunu` pick. This is the payload that could: it must join the champion, not mint one.
	const dir = await fixtureCopy();
	try {
		let rewrote = 0;
		for (const file of await payloadFiles(dir, "ScoreboardPlayers")) {
			const rows = await readRows(file);
			const pick = rows.find((row) => row.Champion === "Nunu &amp; Willump");
			if (!pick) continue;
			pick.Champion = "Nunu";
			rewrote += 1;
			await writeFile(file, JSON.stringify(rows), "utf8");
		}
		assert.equal(rewrote, 1, "the recorded fixtures must carry exactly one Nunu pick to rewrite");
		const built = await buildDataset({ rawDir: dir });
		assert.equal(built.identity.champions.length, baseline.identity.champions.length, "a retired name must not mint a champion");
		const observed = built.identity.aliases.find((alias) => alias.kind === "champion" && alias.string === "Nunu");
		assert.equal(observed?.entityId, nunu.id);
		assert.ok(observed?.evidence.includes("declared"));
		assert.ok(observed?.evidence.includes("observed"));
		assert.equal(built.identity.unresolved.length, baseline.identity.unresolved.length);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
})

test("names are folded only as a last resort, and a folded match naming two entities is an error", async () => {
	const { identity } = await fixtureBuild();
	// Measured case mismatches between the scoreboard and the wiki's own AllName rows.
	const soaz = identity.index.resolve("player", "sOAZ", "2011-06-18");
	assert.equal(soaz?.name, "SOAZ");
	assert.equal(soaz?.via, "alias");
	const yell = identity.index.resolve("player", "Yellowstar", "2011-06-18");
	assert.equal(yell?.name, "YellOwStaR");
	assert.equal(yell?.via, "alias");
	// The same fold against an ambiguous handle must not pick a winner.
	assert.throws(() => identity.index.resolve("player", "WOlF"), AmbiguousIdentity);
})

test("the alias table round-trips: a dated string resolves to the entity the row names", async () => {
	const { identity } = await fixtureBuild();
	let dated = 0;
	for (const alias of identity.aliases) {
		if (alias.firstSeen === null) continue;
		dated += 1;
		const hit = identity.index.resolve(alias.kind, alias.string, alias.firstSeen);
		assert.equal(hit?.id, alias.entityId, `${alias.kind} ${JSON.stringify(alias.string)} on ${alias.firstSeen}`);
	}
	assert.ok(dated > 20, `expected the fixtures to date most aliases, got ${dated}`);
})

test("every emitted reference carries a display name beside its ID", async () => {
	const { identity } = await fixtureBuild();
	const entities = new Set<string>();
	for (const entity of [...identity.teams, ...identity.players, ...identity.champions]) {
		assert.ok(entity.name.length > 0, `${entity.id} must carry a display name (R12)`);
		entities.add(entity.id);
	}
	for (const alias of identity.aliases) {
		assert.ok(alias.entityName.length > 0, `${alias.kind} ${JSON.stringify(alias.string)} must name its entity`);
		assert.ok(entities.has(alias.entityId), `${alias.entityId} must be an emitted entity`);
	}
	for (const row of identity.unresolved) {
		assert.ok(row.name.length > 0);
		if (row.id !== null) assert.ok(entities.has(row.id));
	}
})

test("every identity file satisfies its checked-in schema, and an empty file is legal", async () => {
	const { identity } = await fixtureBuild();
	const files: [string, Record<string, unknown>, unknown[]][] = [
		["team.schema.json", await schema("team.schema.json"), identity.teams],
		["player.schema.json", await schema("player.schema.json"), identity.players],
		["champion.schema.json", await schema("champion.schema.json"), identity.champions],
		["alias.schema.json", await schema("alias.schema.json"), identity.aliases],
		["identity-unresolved.schema.json", await schema("identity-unresolved.schema.json"), identity.unresolved],
	];
	for (const [name, guard, records] of files) {
		assert.ok(records.length > 0, `${name}: the fixtures must carry rows to validate`);
		for (const record of records) assert.deepEqual(validateAgainst(guard, record, name), []);
	}
	// A corpus with no unresolved references emits an empty file, not a stub row.
	const dir = await fixtureCopy();
	try {
		const teamsFile = await payloadFile(dir, "Teams");
		const teams = await readRows(teamsFile);
		teams.push({ _pageName: "The Bandits Prime", Name: "The Bandits Prime", OverviewPage: "The Bandits Prime", Region: "EMEA", RenamedTo: null });
		await writeFile(teamsFile, JSON.stringify(teams), "utf8");
		const built = await buildDataset({ rawDir: dir });
		assert.equal(built.files["identity-unresolved.jsonl"], "");
		assert.equal((await schema("identity-unresolved.schema.json")).type, "object");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
})

test("the identity files are deterministic: two builds agree byte for byte", async () => {
	const [a, b] = await Promise.all([fixtureBuild(), fixtureBuild()]);
	for (const file of ["teams.jsonl", "players.jsonl", "champions.jsonl", "aliases.jsonl", "identity-unresolved.jsonl"] as const) {
		assert.equal(a.files[file], b.files[file], `${file} differed between two builds over the same payloads`);
		const committed = await readFile(path.join(CURATED_DIR, file), "utf8");
		assert.equal(committed, a.files[file], `data/curated/${file} is stale — rebuild with: node tools/dataset/cli.ts build --raw tools/dataset/fixtures/raw`);
	}
})

test("the committed identity files are sorted, LF-only and BOM-free", async () => {
	for (const file of ["teams.jsonl", "players.jsonl", "champions.jsonl", "aliases.jsonl", "identity-unresolved.jsonl"]) {
		const body = await readFile(path.join(CURATED_DIR, file), "utf8");
		assert.ok(!body.includes("\r"), `${file} must use LF endings`);
		assert.ok(!body.startsWith("\uFEFF"), `${file} must not carry a BOM`);
		if (body === "") continue;
		assert.ok(body.endsWith("\n"), `${file} must end with a newline`);
		const ids = body
			.slice(0, -1)
			.split("\n")
			.map((line) => JSON.parse(line) as { kind?: string; string?: string; id?: string; entityId?: string });
		const keys = ids.map((record) => [record.kind ?? "", record.string ?? "", record.id ?? record.entityId ?? ""]);
		const sorted = [...keys].sort((left, right) => {
			for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
				const l = left[index] ?? "";
				const r = right[index] ?? "";
				if (l < r) return -1;
				if (l > r) return 1;
			}
			return 0;
		});
		assert.deepEqual(keys, sorted, `${file} must be sorted by (kind, string, id)`);
	}
})

test("a string that names two entities is reported with its candidates and mints nothing", async () => {
	const baseline = await fixtureBuild();
	const dir = await fixtureCopy();
	try {
		const playersFile = await payloadFile(dir, "PlayerRedirects");
		const players = await readRows(playersFile);
		for (const page of ["Wolf (Lee Jae-wan)", "Faker"]) {
			players.push({ _pageName: page, AllName: "Ambiguous Handle", OverviewPage: page, ID: "Ambiguous Handle" });
		}
		await writeFile(playersFile, JSON.stringify(players), "utf8");
		const [scoreboardFile] = await payloadFiles(dir, "ScoreboardPlayers");
		const scoreboard = await readRows(scoreboardFile);
		scoreboard.push({
			Name: "Ambiguous Handle",
			Link: "Ambiguous Handle",
			Team: "T1",
			TeamVs: "Team Liquid",
			Champion: "Annie",
			OverviewPage: "2023 Season World Championship/Main Event",
			"DateTime UTC": "2023-10-19 05:16:00",
		});
		await writeFile(scoreboardFile, JSON.stringify(scoreboard), "utf8");

		const built = await buildDataset({ rawDir: dir });
		const row = built.identity.unresolved.find((record) => record.string === "Ambiguous Handle");
		assert.ok(row, "an ambiguous string must be reported, not dropped");
		assert.equal(row.reason, "ambiguous");
		assert.equal(row.id, null, "picking one of two players is exactly the silent merge this module must refuse");
		assert.equal(row.candidates.length, 2);
		assert.deepEqual([...row.candidates].sort(), [...row.candidates], "candidates must be sorted");
		assert.ok(!built.identity.players.some((player) => player.overviewPage === null), "nothing was minted for it");
		assert.equal(built.identity.players.length, baseline.identity.players.length);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
})

test("a team rename edge the payloads cannot complete stops the build", async () => {
	const dir = await fixtureCopy();
	try {
		const teamsFile = await payloadFile(dir, "Teams");
		const teams = await readRows(teamsFile);
		for (const row of teams) if (row.OverviewPage === "H2k-Gaming") row.RenamedTo = "H2k-Gaming Esports";
		await writeFile(teamsFile, JSON.stringify(teams), "utf8");
		await assert.rejects(
			buildDataset({ rawDir: dir }),
			/team "H2k-Gaming" says it was renamed to "H2k-Gaming Esports", but no Teams payload carries that page/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
})

test("two pages renamed into one successor stop the build", async () => {
	const dir = await fixtureCopy();
	try {
		const teamsFile = await payloadFile(dir, "Teams");
		const teams = await readRows(teamsFile);
		for (const row of teams) {
			if (row.OverviewPage === "H2k-Gaming") row.RenamedTo = "T1";
			if (row.OverviewPage === "Team Dynamic") row.RenamedTo = "T1";
		}
		await writeFile(teamsFile, JSON.stringify(teams), "utf8");
		await assert.rejects(buildDataset({ rawDir: dir }), /two team pages claim to have been renamed into "T1"/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
})

test("a declared alias that points at nothing stops the build, and one without a reason is rejected", async () => {
	const dir = await fixtureCopy();
	const rules = await mkdtemp(path.join(tmpdir(), "dataset-aliases-"));
	try {
		const aliasFile = path.join(rules, "identity-aliases.json");
		await writeFile(
			aliasFile,
			JSON.stringify({
				version: 1,
				aliases: [{ kind: "champion", string: "Old Name", riotKey: 9999, reason: "a target that no payload registers" }],
			}),
			"utf8",
		);
		await assert.rejects(buildDataset({ rawDir: dir, aliasFile }), /points at riotKey 9999, which no recorded payload registers/);

		await writeFile(
			aliasFile,
			JSON.stringify({ version: 1, aliases: [{ kind: "champion", string: "Old Name", riotKey: 20 }] }),
			"utf8",
		);
		await assert.rejects(buildDataset({ rawDir: dir, aliasFile }), /must state its reason/);

		await writeFile(
			aliasFile,
			JSON.stringify({ version: 1, aliases: [{ kind: "champion", string: "Old Name", page: "Nunu", reason: "wrong target kind" }] }),
			"utf8",
		);
		await assert.rejects(buildDataset({ rawDir: dir, aliasFile }), /needs Riot's numeric riotKey/);
	} finally {
		await rm(dir, { recursive: true, force: true });
		await rm(rules, { recursive: true, force: true });
	}
})

test("a payload in a table with no normalizer stops the build instead of being skipped", async () => {
	const dir = await fixtureCopy();
	try {
		const stray = path.join(dir, "lol-fandom", "cargoexport", "MatchSchedule", "stray.json");
		await mkdir(path.dirname(stray), { recursive: true });
		await writeFile(stray, JSON.stringify([{ OverviewPage: "anything" }]), "utf8");
		await assert.rejects(buildDataset({ rawDir: dir }), /table "MatchSchedule" has no normalizer/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
})
