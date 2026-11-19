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
//   - a string the source registers nothing for (`w2w`, a 2013 qualifier team).
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
import { readPayloads } from "../cache.ts";
import { AmbiguousIdentity, assembleIdentity, loadDeclaredAliases, surrogateId } from "../identity.ts";
import { displayName, normalizeSources } from "../normalize.ts";
import type { BuildResult } from "../build.ts";
import type { SourceDataset } from "../normalize.ts";
import { validateAgainst } from "../validate.ts";
import { CURATED_DIR, FIXTURE_RAW, isPayloadBody, readPayloadBodyFile, savePayloadBody, SCHEMA_DIR, sidecarPath, writePayloadBodyFile } from "./helpers.ts";

// The windows are the observed use in the whole recorded corpus, and ticket 03 makes
// games observations too: `SK Telecom T1` is dated from the 2013 World Cyber Games rows
// to the 2015 IEM rows, and `T1` from the 2020 Mid-Season Cup to the 2024 Esports World
// Cup, so each alias carries the span the corpus saw it in.
const TEAM_RENAME = { entity: "T1", from: "SK Telecom T1", fromSeen: "2013-09-15", fromLastSeen: "2019-11-03", currentSeen: "2026-11-09", currentFirstSeen: "2020-05-28" } as const;

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
	const names = (await readdir(dir)).filter(isPayloadBody);
	assert.ok(names.length > 0, `expected a recorded ${table} payload`);
	return names.sort().map((name) => path.join(dir, name));
}

/**
 * The first recorded payload for a table, for cases that only append a row.
 *
 * A crawl leaves several payloads per table (one per query batch), so a test that needs a
 * *particular* row edits every payload and lets the matching one change — see `editRows`.
 */
async function payloadFile(root: string, table: string): Promise<string> {
	const files = await payloadFiles(root, table);
	return files[0];
}

/** Apply `edit` to every payload of a table, saving the ones it changed. */
async function editRows(root: string, table: string, edit: (rows: Record<string, unknown>[]) => boolean): Promise<void> {
	for (const file of await payloadFiles(root, table)) {
		const rows = await readRows(file);
		if (edit(rows)) await savePayloadBody(file, JSON.stringify(rows));
	}
}

async function readRows(file: string): Promise<Record<string, unknown>[]> {
	return JSON.parse(await readPayloadBodyFile(file)) as Record<string, unknown>[];
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
	assert.deepEqual([old.firstSeen, old.lastSeen], [TEAM_RENAME.fromSeen, TEAM_RENAME.fromLastSeen]);
	// A span, not a point: the name is dated by the 2023 scoreboard row and again by the
	// Worlds final the games payload carries (ticket 03).
	assert.deepEqual([current.firstSeen, current.lastSeen], [TEAM_RENAME.currentFirstSeen, TEAM_RENAME.currentSeen]);
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
		await editRows(dir, "Teams", (teams) => {
			let changed = false;
			for (const row of teams) {
				if (row.OverviewPage === "T1") {
					row.Name = "T1 Esports";
					changed = true;
				}
				if (row.OverviewPage === "Team Liquid") {
					row.Name = "Team Liquid Rebranded";
					changed = true;
				}
			}
			return changed;
		});

		// The source rewrites the *current* champion name retroactively (measured: 2011
		// and 2012 rows already say `Nunu &amp; Willump`), so a display rename arrives as
		// a coordinated rewrite of the registry and *every* place a game states a champion:
		// the player rows and the list-typed picks/bans on the game row. Identity is the Riot
		// id, so none of those rewrites moves the ID; leaving one path behind would make this
		// test measure the rename of a single column instead.
		for (const championsFile of await payloadFiles(dir, "Champions")) {
			const champions = await readRows(championsFile);
			for (const row of champions) if (row.KeyInteger === 20) row.Name = "Nunu";
			await savePayloadBody(championsFile, JSON.stringify(champions));
		}
		for (const file of await payloadFiles(dir, "ScoreboardPlayers")) {
			const rows = await readRows(file);
			for (const row of rows) if (row.Champion === "Nunu &amp; Willump") row.Champion = "Nunu";
			await savePayloadBody(file, JSON.stringify(rows));
		}
		for (const file of await payloadFiles(dir, "ScoreboardGames")) {
			const rows = await readRows(file);
			for (const row of rows) {
				for (const field of ["Team1Picks", "Team2Picks", "Team1Bans", "Team2Bans"]) {
					const champions = row[field];
					if (!Array.isArray(champions)) continue;
					row[field] = champions.map((champion: unknown) => (champion === "Nunu &amp; Willump" ? "Nunu" : champion));
				}
			}
			await savePayloadBody(file, JSON.stringify(rows));
		}
		// The ordered draft path states champions too, in one column per slot. Ticket 10's
		// crawl added ordered rows for five more events, so leaving this path out would mint
		// a second Nunu from a single column rather than measure the rename.
		for (const file of await payloadFiles(dir, "PicksAndBansS7")) {
			const rows = await readRows(file);
			for (const row of rows) {
				for (const [field, value] of Object.entries(row)) {
					if (/^Team[12](Pick|Ban)[1-5]$/.test(field) && value === "Nunu &amp; Willump") row[field] = "Nunu";
				}
			}
			await savePayloadBody(file, JSON.stringify(rows));
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
		// anything unless identity depends on read order or on a row counter. The rows
			// carry a GameId and the stat key the player-game join needs, because ticket 10's
		// emission rule emits entities only from rows the build actually emits — a
			// scoreboard row that names no game would be resolution input and nothing else.
		const gameId = "Fabricated World Championship 2012_Game 1";
		const tournaments = path.join(dir, "lol-fandom", "cargoexport", "Tournaments", "fabricated.json");
		await writeFile(
			tournaments,
			JSON.stringify([
				{
					// A page the corpus does not carry: fabricating a row for one it does
					// would make two payloads disagree about that page, which is a different
					// (and correct) build failure.
					Name: "Fabricated World Championship 2012",
					OverviewPage: "Fabricated World Championship 2012",
					DateStart: "2012-03-06",
					League: "Intel Extreme Masters",
					Region: "International",
				},
			]),
			"utf8",
			);
		const gamesFile = path.join(dir, "lol-fandom", "cargoexport", "ScoreboardGames", "fabricated.json");
		await writeFile(
			gamesFile,
			JSON.stringify([
				{
					OverviewPage: "Fabricated World Championship 2012",
					GameId: gameId,
					MatchId: "Fabricated World Championship 2012_Group A_1",
					Team1: "Fabricated Five",
					Team2: "T1",
					WinTeam: "T1",
					DateTime_UTC: "2012-03-06 10:00:00",
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
					Kills: 0,
					IngameRole: "middle",
					OverviewPage: "Fabricated World Championship 2012",
					GameId: gameId,
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
		const reported = new Set(grown.identity.unresolved.map((row) => row.string));
		// `Eliade`, not `w2w`: ticket 10's emission rule narrowed the report to strings an
		// emitted record still cannot resolve, and the qualifier strings (`w2w` among them)
		// name no emitted row any more.
		for (const string of ["Fabricated Five", "Fabricated Player", "Eliade"]) {
			assert.ok(reported.has(string), `${string} must stay in the unresolved report`);
		}
		assert.ok(grown.identity.unresolved.length >= baseline.identity.unresolved.length, "adding material never empties the report");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
})

test("a duplicate display string is never merged, and its unreferenced entities are not emitted", async () => {
	const { identity } = await fixtureBuild();
	// Eight player pages are called `Wolf`; the full crawl (ticket 16) emitted exactly one of
	// them, because one emitted row names that page (`Wolf (Lee Jae-wan)`). The other seven
	// live in resolution only, which is where a merge would happen — and the bare string is
	// still refused below.
	assert.equal(
		identity.players.filter((player) => player.name === "Wolf").length,
		1,
		"only the Wolf an emitted row names is emitted",
	);
	// Without a date the string names eight people: reporting that is the point.
	assert.throws(() => identity.index.resolve("player", "Wolf"), (error: unknown) => {
		assert.ok(error instanceof AmbiguousIdentity);
		assert.ok(error.candidates.length >= 2, "the duplicates stay distinct candidates");
		assert.equal(new Set(error.candidates.map((candidate) => candidate.id)).size, error.candidates.length, "one candidate per entity, never a merge");
		return true;
	});
	// The page, unlike the handle, is unambiguous — which is why it is the identity.
	assert.ok(identity.index.resolve("player", "Wolf (Lee Jae-wan)")?.id);
	// And a dated lookup still resolves the handle to the entity the corpus saw that day:
	// the observation eras survive the emission filter, because resolution is unchanged.
	const dated = identity.index.resolve("player", "Wolf", "2015-10-01");
	assert.ok(dated);
	assert.equal(dated.name, "Wolf");
})

test("an unresolved source string mints an entity and is reported, rather than failing or vanishing", async () => {
	const { identity } = await fixtureBuild();
	// Ticket 10's emission rule narrowed this report to the strings an emitted record
	// still cannot resolve. The World Cyber Games 2013 qualifier teams the series rows
	// carried (`w2w` and seven others) name no emitted row, so they left the report and
	// stay resolution input; what remains is the IPL 5 pair the dataset itself uses.
	const report = identity.unresolved.find((row) => row.string === "Eliade");
	assert.ok(report, `the report must name the minted string, got ${identity.unresolved.map((row) => row.string).join(", ")}`);
	assert.equal(report.kind, "player");
	assert.equal(report.string, "Eliade");
	assert.equal(report.reason, "no-source-identity");
	assert.deepEqual([report.firstSeen, report.lastSeen], ["2012-11-29", "2012-11-29"]);
	assert.ok(report.id);
	const entity = identity.players.find((player) => player.id === report.id);
	assert.ok(entity, "the report must point at a real entity");
	assert.equal(entity.name, "Eliade", "the minted entity carries the source string as its display name");
	assert.equal(entity.overviewPage, null, "no registry page exists, and inventing one would hide that");
	// Games reference players as display strings too (ticket 04), and the corpus still
	// carries PlayerRedirects rows for none of IPL 5's unregistered players, so they are
	// minted and reported the same way. The string resolves from then on, so a later
	// payload citing it joins the same entity.
	assert.equal(identity.index.resolve("player", "Eliade")?.id, report.id);
	// And a registry page that later appears under that exact name keeps the ID.
	const baseline = await fixtureBuild();
	const dir = await fixtureCopy();
	try {
		const playersFile = await payloadFile(dir, "PlayerRedirects");
		const players = await readRows(playersFile);
		players.push({ _pageName: "Eliade", AllName: "Eliade", OverviewPage: "Eliade", ID: "Eliade" });
		await savePayloadBody(playersFile, JSON.stringify(players));
		const resolved = await buildDataset({ rawDir: dir });
		const now = resolved.identity.players.find((player) => player.name === "Eliade");
		assert.equal(now?.id, entity.id, "registering the page later must not renumber the entity");
		assert.equal(now?.overviewPage, "Eliade");
		// Only the registered string leaves the report; the game-minted players have no page
		// in this corpus and must stay, which is what keeps the report from emptying itself.
		assert.equal(
			resolved.identity.unresolved.some((row) => row.string === "Eliade"),
			false,
			"a resolved string leaves the report",
		);
		assert.equal(
			resolved.identity.unresolved.length,
			baseline.identity.unresolved.length - 1,
			"and only that one",
		);
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
			await savePayloadBody(file, JSON.stringify(rows));
		}
		assert.ok(rewrote >= 1, "the recorded fixtures carry Nunu picks to rewrite");
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

test("a declared era bounds a single candidate, and an inverted window is refused", async () => {
	const rules = await mkdtemp(path.join(tmpdir(), "dataset-aliases-window-"));
	try {
		const aliasFile = path.join(rules, "identity-aliases.json");
		const declaration = {
			kind: "team",
			string: "CLG Prime",
			aliasOf: "Counter Logic Gaming",
			from: "2012-11-29",
			until: "2012-11-30",
			reason: "the recorded series rows use this string for five days; the window bounds it",
		};
		await writeFile(aliasFile, JSON.stringify({ version: 1, aliases: [declaration] }), "utf8");
		const empty: SourceDataset = {
			tournaments: [],
			teams: [],
			teamNames: [],
			playerNames: [],
			champions: [],
			scoreboard: [],
			games: [],
			matches: [],
			drafts: [],
			playerGames: [],
		};
		const identity = assembleIdentity(empty, await loadDeclaredAliases(aliasFile));
		const inside = identity.index.resolve("team", "CLG Prime", "2012-11-30");
		assert.equal(inside?.name, "Counter Logic Gaming", "inside the declared window the alias answers");
		assert.equal(
			identity.index.resolve("team", "CLG Prime", "2012-12-02"),
			null,
			"outside it the declaration says nothing, even though there is only one candidate",
		);
		assert.equal(
			identity.index.resolve("team", "clg prime", "2012-12-02"),
			null,
			"a case-folded lookup cannot escape the declared window either",
		);
		assert.equal(identity.index.resolve("team", "clg prime", "2012-11-30")?.name, "Counter Logic Gaming");
		const row = identity.aliases.find((alias) => alias.kind === "team" && alias.string === "CLG Prime");
		assert.deepEqual([row?.firstSeen, row?.lastSeen], ["2012-11-29", "2012-11-30"], "the alias row carries the declared window");

		await writeFile(
			aliasFile,
			JSON.stringify({ version: 1, aliases: [{ ...declaration, from: "2012-12-02", until: "2012-11-29" }] }),
			"utf8",
		);
		await assert.rejects(
			loadDeclaredAliases(aliasFile),
			/from 2012-12-02 is after until 2012-11-29 — a declared era cannot end before it starts \(team "CLG Prime"\)/,
		);
	} finally {
		await rm(rules, { recursive: true, force: true });
	}
});

test("an observation outside a declared window mints a separate entity instead of silently joining it", async () => {
	const rules = await mkdtemp(path.join(tmpdir(), "dataset-aliases-window-"));
	try {
		const aliasFile = path.join(rules, "identity-aliases.json");
		await writeFile(
			aliasFile,
			JSON.stringify({
				version: 1,
				aliases: [
					{
						kind: "team",
						string: "CLG Prime",
						aliasOf: "Counter Logic Gaming",
						from: "2012-11-29",
						until: "2012-11-30",
						reason: "a deliberately short window, to prove the era bounds every observation",
					},
				],
			}),
			"utf8",
		);
		const sources = normalizeSources(await readPayloads(FIXTURE_RAW));
		const identity = assembleIdentity(sources, await loadDeclaredAliases(aliasFile));
		const declared = identity.aliases.find((alias) => alias.kind === "team" && alias.string === "CLG Prime" && alias.evidence.includes("declared"));
		assert.ok(declared, "the declaration still resolves inside its window");
		const outside = identity.unresolved.find((row) => row.kind === "team" && row.string === "CLG Prime");
		assert.ok(outside, "the series rows after the window are an unresolved reference, not a silent merge");
		assert.notEqual(outside.id, identity.index.resolve("team", "Counter Logic Gaming", "2012-12-02")?.id, "it is not the declared team");
		const minted = identity.teams.find((team) => team.id === outside.id);
		assert.equal(minted?.name, "CLG Prime", "the string keeps its own entity outside the declared era");
	} finally {
		await rm(rules, { recursive: true, force: true });
	}
});

test("self-targeting and chained declarations are refused, and a wrong target stops the build", async () => {
	const rules = await mkdtemp(path.join(tmpdir(), "dataset-aliases-check-"));
	try {
		const aliasFile = path.join(rules, "identity-aliases.json");
		const write = async (aliases: unknown[]): Promise<void> => {
			await writeFile(aliasFile, JSON.stringify({ version: 1, aliases }), "utf8");
		};
		await write([{ kind: "team", string: "CLG Prime", aliasOf: "CLG Prime", reason: "self" }]);
		await assert.rejects(loadDeclaredAliases(aliasFile), /a declared alias cannot name itself/);

		await write([
			{ kind: "team", string: "A", aliasOf: "B", reason: "chain one" },
			{ kind: "team", string: "B", aliasOf: "C", reason: "chain two" },
		]);
		await assert.rejects(loadDeclaredAliases(aliasFile), /one declaration cannot chain onto another/);

		await write([
			{
				kind: "team",
				string: "CLG Prime",
				aliasOf: "TSM",
				from: "2012-11-29",
				until: null,
				reason: "a typo that names another team the corpus never puts on its side of a series",
			},
		]);
		await assert.rejects(
			buildDataset({ rawDir: FIXTURE_RAW, aliasFile }),
			/no recorded game and its series row put the two strings on the same side/,
			"an aliasOf target has to be evidenced by the corpus, or a typo merges two teams",
		);
	} finally {
		await rm(rules, { recursive: true, force: true });
	}
});

test("an aliasOf target the registries do not carry mints the target string's provisional id", async () => {
	const { identity } = await fixtureBuild();
	const declared = identity.aliases.find((alias) => alias.kind === "team" && alias.string === "CLG Prime");
	assert.ok(declared);
	assert.equal(declared.entityId, surrogateId("tm", "Counter Logic Gaming"), "the id is the target's hash, not the alias's");
	const entity = identity.teams.find((team) => team.id === declared.entityId);
	assert.ok(entity);
	// The full crawl brought the registry in, so the target now has its page: the declared
	// string joins the registry's own entity rather than minting a page-less one.
	assert.equal(entity.name, "Counter Logic Gaming");
	assert.equal(entity.overviewPage, "Counter Logic Gaming", "the registry carries the target's page");
});

test("a declaration behind a registry identity is inert, so it needs no corpus evidence", async () => {
	const rules = await mkdtemp(path.join(tmpdir(), "dataset-aliases-registry-"));
	try {
		const aliasFile = path.join(rules, "identity-aliases.json");
		await writeFile(
			aliasFile,
			JSON.stringify({
				version: 1,
				aliases: [
					{
						kind: "team",
						string: "T1",
						aliasOf: "The Bandits Prime",
						from: null,
						until: null,
						reason: "a declaration the registry already answers for; it must not override the registry",
					},
				],
			}),
			"utf8",
		);
		// The two strings never share a series side, so evidence would fail if the declaration
		// were active. `T1` is the registry's own identity, which wins: the declaration is inert.
		const built = await buildDataset({ rawDir: FIXTURE_RAW, aliasFile });
		const t1 = built.identity.teams.find((team) => team.name === "T1");
		assert.ok(t1);
		assert.equal(built.identity.index.resolve("team", "T1", "2023-11-19")?.id, t1.id, "the registry's statement wins");
	} finally {
		await rm(rules, { recursive: true, force: true });
	}
});

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
		let hit;
		try {
			hit = identity.index.resolve(alias.kind, alias.string, alias.firstSeen);
		} catch (error) {
			// A string two entities carry cannot round-trip; the alias table keeps both
			// statements and the resolver refuses to pick. `Wolf` (eight pages) is the case.
			assert.ok(error instanceof AmbiguousIdentity, `${alias.kind} ${JSON.stringify(alias.string)}: unexpected ${(error as Error).message}`);
			continue;
		}
		if (hit?.id === alias.entityId) continue;
		// A page name outranks another entity's historical handle: `Exo` is a page, and
		// `Exosen` was also called `Exo` (measured in the full registry). The alias row is
		// still true as history; it is just not what the string denotes today.
		const pageOwner = identity.index.resolve(alias.kind, alias.string);
		assert.ok(pageOwner !== null, `${alias.kind} ${JSON.stringify(alias.string)} on ${alias.firstSeen} resolves somewhere`);
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
	// A corpus with no unresolved references emits an empty file, not a stub row. The
	// game and draft payloads are removed for this case on purpose: their team and
	// champion strings have no registry pages in the fixtures, so they would mint
	// entities and leave the report non-empty for a reason unrelated to the case here.
	const dir = await fixtureCopy();
	try {
		await rm(path.join(dir, "lol-fandom", "cargoexport", "ScoreboardGames"), { recursive: true, force: true });
		await rm(path.join(dir, "lol-fandom", "cargoexport", "MatchSchedule"), { recursive: true, force: true });
		await rm(path.join(dir, "lol-fandom", "cargoexport", "ScoreboardPlayers"), { recursive: true, force: true });
		await rm(path.join(dir, "lol-fandom", "cargoexport", "PicksAndBansS7"), { recursive: true, force: true });
		const teamsFile = await payloadFile(dir, "Teams");
		const teams = await readRows(teamsFile);
		teams.push({ _pageName: "w2w", Name: "w2w", OverviewPage: "w2w", Region: "China", RenamedTo: null });
		await savePayloadBody(teamsFile, JSON.stringify(teams));
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

test("a string that names two entities mints one provisional entity and reports its candidates", async () => {
	const baseline = await fixtureBuild();
	const dir = await fixtureCopy();
	try {
		const playersFile = await payloadFile(dir, "PlayerRedirects");
		const players = await readRows(playersFile);
		for (const page of ["Wolf (Lee Jae-wan)", "Faker"]) {
			players.push({ _pageName: page, AllName: "Ambiguous Handle", OverviewPage: page, ID: "Ambiguous Handle" });
		}
		await savePayloadBody(playersFile, JSON.stringify(players));
		const [scoreboardFile] = await payloadFiles(dir, "ScoreboardPlayers");
		const scoreboard = await readRows(scoreboardFile);
		scoreboard.push({
			Name: "Ambiguous Handle",
			Link: "Ambiguous Handle",
			Team: "T1",
			TeamVs: "Team Liquid",
			Champion: "Annie",
			// A stat key: a row with no statistic at all is not a player-game row (R4), so it
			// would never be observed and the string would never be reported. A played role is
			// required too: a player row without one cannot be placed on the map.
			Kills: 0,
			IngameRole: "Mid",
			OverviewPage: "2023 Season World Championship/Main Event",
			// A real game id: the emission rule reports only strings an emitted record still
			// cannot resolve, so a row that names no game would be resolution input alone.
			GameId: "2023 Season World Championship/Main Event_Finals_1_1",
			"DateTime UTC": "2023-10-19 05:16:00",
		});
		await savePayloadBody(scoreboardFile, JSON.stringify(scoreboard));

		const built = await buildDataset({ rawDir: dir });
		const row = built.identity.unresolved.find((record) => record.string === "Ambiguous Handle");
		assert.ok(row, "an ambiguous string must be reported, not dropped");
		assert.equal(row.reason, "ambiguous");
		// The string cannot be resolved to either namesake, so the record it names gets one
		// provisional entity — not a pick between the two, and not a row dropped from the
		// dataset — and the report lists every candidate so a reader can see the uncertainty.
		assert.ok(typeof row.id === "string" && row.id.length > 0, "the string gets a provisional entity, not a silent merge");
		assert.equal(row.candidates.length, 2);
		assert.deepEqual([...row.candidates].sort(), [...row.candidates], "candidates must be sorted");
		assert.equal(built.identity.players.filter((player) => player.name === "Ambiguous Handle").length, 1, "one entity for the string");
		assert.equal(built.identity.players.length, baseline.identity.players.length + 1, "exactly the ambiguous string was minted");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
})

test("a rename edge to a page no payload carries is skipped and reported, not followed", async () => {
	// The wiki states rename edges into pages it does not carry (`D-City Gaming Stars` →
	// `1. Esport Verein Darmstadt e.V.`, measured in the full crawl; ten such edges exist).
	// The old page keeps its identity, and the count is reported so a truncated registry —
	// which looks the same from here — cannot pass for a source gap unnoticed.
	const baseline = await fixtureBuild();
	const dir = await fixtureCopy();
	try {
		await editRows(dir, "Teams", (teams) => {
			let changed = false;
			for (const row of teams) {
				if (row.OverviewPage === "H2k-Gaming") {
					row.RenamedTo = "H2k-Gaming Esports";
					changed = true;
				}
			}
			return changed;
		});
		const built = await buildDataset({ rawDir: dir });
		assert.ok(
			built.identity.danglingRenames.some((edge) => edge.page === "H2k-Gaming" && edge.target === "H2k-Gaming Esports"),
			"the edge is reported",
		);
		const team = built.identity.teams.find((candidate) => candidate.overviewPage === "H2k-Gaming");
		assert.ok(team, "the old page keeps its own entity");
		assert.ok(
			built.identity.danglingRenames.length >= baseline.identity.danglingRenames.length,
			"the source's own dangling edges are still reported",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
})

test("two pages renamed into one successor are one entity with two histories", async () => {
	// The source merges as well as renames: `AXIZ Academy` and `Crest Gaming Act Academy`
	// both rename into `AXIZ CREST Academy` (measured in the full crawl). A chain model
	// would refuse that or keep whichever payload was read last; a component is one entity
	// with two histories, which is what the source says happened.
	// The measured case, not a fabricated one: editing two real pages into a shared
	// successor can join two teams that played each other (H2k-Gaming against SK Telecom
	// T1), which is a different, correct failure. `AXIZ Academy` and
	// `Crest Gaming Act Academy` both rename into `AXIZ CREST Academy` in the source, and
	// neither plays a game in this corpus, so the resolution is what shows the merge.
	const { identity } = await fixtureBuild();
	const first = identity.index.resolve("team", "AXIZ Academy", "2023-01-01");
	const second = identity.index.resolve("team", "Crest Gaming Act Academy", "2023-01-01");
	assert.ok(first, "the first history resolves");
	assert.ok(second, "the second history resolves");
	assert.equal(first.id, second.id, "one entity for the merged history, not one per root");
	assert.equal(first.name, second.name);
	assert.equal(first.name, "AXIZ CREST Academy", "the successor's page is the current one");
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
		// A table no ticket reads: a payload for it is a table this stage does not
		// understand, and guessing would be worse. PicksAndBansS7 has a normalizer now.
		const stray = path.join(dir, "lol-fandom", "cargoexport", "NoSuchTable", "stray.json");
		await mkdir(path.dirname(stray), { recursive: true });
		await writeFile(stray, JSON.stringify([{ OverviewPage: "anything" }]), "utf8");
		await assert.rejects(buildDataset({ rawDir: dir }), /table "NoSuchTable" has no normalizer/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
})

test("a qualifier-page string identical to an emitted team's string resolves to the one entity", async () => {
	const { identity } = await fixtureBuild();
	// Ticket 10's crawl carries the World Cyber Games 2013 qualifier series, and CJ Entus
	// Blaze appears both there (a page the rule excludes, whose series are counted as
	// ignored) and in the event's own series. The emission filter works on entity ids, so
	// the string still resolves to the one entity — the qualifier rows are resolution
	// input, and the entity is emitted because the main-event rows name it.
	const rows = identity.aliases.filter((alias) => alias.kind === "team" && alias.string === "CJ Entus Blaze");
	assert.equal(rows.length, 1, "one alias row, never one per page");
	const hit = identity.index.resolve("team", "CJ Entus Blaze", "2013-11-29");
	assert.equal(hit?.id, rows[0].entityId, "the qualifier-date lookup lands on the same entity");
	assert.equal(hit?.name, "CJ Entus Blaze");
	assert.equal(identity.teams.filter((team) => team.id === rows[0].entityId).length, 1, "and the entity is emitted once");
})

// ---- display names vs source strings -------------------------------------------
//
// The wiki stores HTML-escaped strings, so `Nunu &amp; Willump` is what the champion
// table and the 2011 scoreboard rows both say. Two different promises apply to it:
// spec R7 keeps a *source string* verbatim (the alias table, exact matching), and
// spec R12 puts the *human-readable* name on the record. A decoder that ran over
// both would rewrite source bytes; one that ran over neither would put `&amp;` in
// front of an analyst, and in every player row built on top (ticket 04).

test("display names are decoded once, so a source string that meant to show an entity still does", () => {
	assert.equal(displayName("Nunu &amp; Willump"), "Nunu & Willump");
	assert.equal(displayName("A &amp;lt; B"), "A &lt; B", "one pass: `&amp;lt;` is a literal `&lt;`, not `<`");
	assert.equal(displayName("Misfits &quot;Black&quot;"), 'Misfits "Black"');
	assert.equal(displayName("&#38;&#x26;"), "&&");
	assert.equal(displayName("KT Rolster"), "KT Rolster");
	assert.equal(displayName("100&#37;"), "100%");
});

test("a champion's display name is decoded while its alias string stays verbatim", async () => {
	const files = await fixtureBuild();
	const champion = (files.files["champions.jsonl"] ?? "")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as { name: string; riotKey: number | null })
		.find((record) => record.riotKey === 20);
	assert.ok(champion, "the fixtures carry Riot champion 20 (Nunu & Willump)");
	assert.equal(champion.name, "Nunu & Willump");

	const aliases = (files.files["aliases.jsonl"] ?? "")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as { kind: string; string: string; entityName: string });
	const sourceString = aliases.find((alias) => alias.kind === "champion" && alias.string.includes("Willump"));
	assert.ok(sourceString, "the registry string must be in the alias table");
	assert.equal(sourceString.string, "Nunu &amp; Willump", "the alias keeps the source's own bytes (R7)");
	assert.equal(sourceString.entityName, "Nunu & Willump", "the alias names its entity by display name (R12)");
});
