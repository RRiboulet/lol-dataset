# LoL esports dataset — spec v0 (draft for argument)

Status: v0, decided in review on 2026-11-12 — era-aware completeness accepted,
so the dataset keeps 2011 rather than starting where the sources become uniform.
Written before any dataset code exists. Broken into tickets under
`docs/specs/tickets/lol-esports-dataset/`.

## Objective

The repository is a scaffold: a devcontainer, pi extensions and skills, and a
test suite that guards them, with no data and no code that fetches data. The
goal is a **complete per-game dataset of every major international League of
Legends event from 2011 through 2026** — the games themselves, per-game team
statistics, per-game player statistics, and the champion draft for each game — plus
**a dimensional model over it**, so that a junior analyst opens dimensions and facts
rather than reverse-engineering the ingestion format (R13).

This matters now because nothing downstream (a site, an analysis notebook, a
model) can begin until three things are fixed, and all three are expensive to
change later: the **grain** (what one row is), the **identity scheme** (what a
team, player or champion is across sixteen years of renames), and the
**semantics of "complete"** when the sources are not uniformly complete. That
is exactly the "schema decisions outlive the scrapers" constraint in `AGENTS.md`,
so this spec is written before a single request is made.

## Current behavior

Observed today on `dev` (`b4e9406`), not assumed:

- No dataset, no `data/`, no `docs/`, no `README.md`. The only non-scaffold
  files are `tools/measure-session-usage.mjs` and `bin/devc`.
- The scaffold suite passes: `node --test .pi/extensions/subagent/test/*.test.ts`
  → 1076 pass, 0 fail.
- The candidate source was probed live, so the field inventory below is
  measured rather than remembered. `action=cargofields` and `action=cargoquery`
  both work against `lol.fandom.com/api.php`.
- The probe also **hit the rate limiter**: after three to four requests the API
  returns `{"error":{"code":"ratelimited"}}`, and the limit was still in force
  more than 100 seconds later. This is the single most consequential operational
  fact in this spec; see Constraints and D9.

## Required behavior

Numbered so tickets and tests can cite them.

**R1 — Event selection is a rule, not a hand-list.** The dataset contains every
event matching the committed inclusion rule, and nothing else. The rule is data
(namespace, region, level, exclusion list), versioned in the repository, with
per-event overrides that are explicit and reviewable. Anyone must be able to
compute the event set from the repository alone.

**R2 — Every game appears exactly once.** For each selected event, every game
that was played is present, identified by a stable ID, with a reference to its
event, its date/time in UTC, its patch (where the source has one), its duration,
its winner, and exactly two sides.

**R3 — Per-game team statistics.** Each game carries, per side: kills, deaths,
gold, towers, inhibitors, dragons (total and per elemental type), barons, rift
heralds, void grubs, atakhans.

**R4 — Per-game player statistics.** Each game carries, per player: player
reference, team reference, champion reference, role, side, kills, deaths,
assists, CS, gold, damage to champions, vision score, items, trinket, summoner
spells, and keystone/runes. Every stat is a number or explicitly absent; absent
is never encoded as `0`.

**R5 — Drafts, with their own fidelity recorded.** Each game carries the picks
and bans per side. Where the source preserves **order**, the dataset preserves
order; where it only preserves **sets**, the dataset says so, per game, with a
`ordered` / `unordered` marker. Order is never fabricated or inferred from role
order.

**R6 — Completeness is per-field and machine-readable.** "Complete" means
complete *for the era the source covers*, and the dataset states which era it is
in. Each game carries a coverage record naming, per field group (team stats,
player stats, ordered draft), whether it is present, partially present, or
unavailable for that event. No game is silently half-empty; no aggregate hides
a blank.

**R7 — Identity is canonical and stable.** Events, teams, players, champions and
patches have canonical IDs that do not change when an alias, spelling or display
name changes, and that do not depend on the order in which sources are read.
Source strings are preserved verbatim alongside the canonical ID. Known renames
(a team renaming its brand, a player changing handle, a champion renamed by
Riot) resolve to one canonical entity with an alias history.

**R8 — The build is deterministic and idempotent.** Building twice from the same
cached inputs produces byte-identical output: stable ordering everywhere, no
wall-clock timestamps in the data, no map iteration order leaking into the
files.

**R9 — Provenance is recorded for every payload.** Each raw response is cached
on disk with the URL, the fetch time, and a hash of the body. A dataset-level
manifest names the snapshot it was built from, so any value can be traced to the
exact bytes it came from, and a rebuild is reproducible without the network.

**R10 — Invariants are enforced, not documented.** Structural, referential and
arithmetic invariants fail the build. If the data violates the schema, or a
player's kills do not sum to their team's kills, or a game references a champion
that does not exist, the build stops.

**R11 — A full rebuild needs no secrets and does not hammer anyone.** No
credential, cookie or token is stored in the repository. The fetch layer
throttles, backs off on rate-limit responses, resumes from the cache, and can be
interrupted and restarted without duplicating or losing work.

**R12 — A junior analyst can use it without reading the build code.** The committed
data is the deliverable; the builder is a means to it. Both layers ship, are
documented, and load with no preprocessing step. Every record carries
the human-readable name beside its canonical ID — and, where it exists, the source's
own string — so no row has to be decoded through an identifier before it can be
understood. The documentation names the files, the grain and the join keys, and
answers questions an analyst would actually ask (who won a given series game; what a
given player picked in a given event).

**R13 — A modelled layer, built by the data engineer, aggregated by the analyst.**
A dimensional model sits above the curated data as a first-class deliverable, not a
stretch goal: conformed dimensions (event, match, team, player, champion, patch) and
facts at declared grains — one row per game per side, one row per game per player,
one row per draft slot. Joins use integer surrogate keys; every dimension row carries
its natural key and display name so a fact table can still be read. Renames are
handled without duplicating a dimension row per alias. Facts hold measures only: no
rates, ratios, averages or pre-aggregations — the analyst aggregates. The model is
conformance-tested against the curated layer (row counts, referential integrity,
grain uniqueness), ships with its DDL, and loads directly into a SQL engine and a
dataframe library.

## Non-goals

- Regional leagues (LCK, LPL, LEC, LCS, CBLOL, …) and national competitions.
  International only, per the user's scope.
- Exhibition events: All-Star (its 1v1 bracket and alternate-mode showmatches are
  not comparable games) and national-team events such as the Asian Games. Both are
  deliberate exclusions, not oversights — see Open assumption 2.
- Live or real-time data; this is an archive, rebuilt on demand.
- Player biographies, career totals, contracts, rosters over time.
- Ratings, Elo, power rankings, or any derived model output.
- Item-build analytics, skill order, or per-minute timelines (a later spec can
  add timelines; see D4 and the ACS note in Constraints).
- VOD media. Links may be recorded; nothing is downloaded.
- Any website, API server, or query interface over the data.
- Aggregates, reports or metrics computed on top of the model — win rates, ratings,
  leaderboards, summary tables. The model itself is in scope (R13); the summing is the
  analyst's job, and a dataset that pre-computes it answers fewer questions than one
  that does not.
- Translations, commentary, or narrative content.

## Constraints

- **Source licence.** Leaguepedia-derived content is CC BY-SA 3.0. Derived data
  committed to a **public** repository inherits attribution and share-alike
  obligations, and that is a human decision, not an implementation detail. The
  repository is currently private, so this is not blocking today but is decided
  before the first public commit.
- **Riot's ACS endpoints** (`acs.leagueoflegends.com/v1/stats/game/…`), which
  hold the richest per-player payloads, are not a public API: they need a
  platform game id plus a hash, are heavily rate-limited, and in practice want a
  logged-in session cookie. R11 forbids storing such a cookie, so ACS is treated
  as an optional, human-run enrichment path at most — not as the primary source.
- **Rate limiting.** Verified, not theoretical: a handful of Cargo requests
  triggers `ratelimited`, persisting for minutes. A full crawl is a slow,
  cached, resumable job measured in tens of minutes, not a tight loop.
- **Volume (estimate, to be replaced by a measurement).** Order of 3–4 thousand
  games across 2011–2026 international events, ~10 player rows per game. JSON
  text at this size is a few megabytes; git-friendly.
- **Determinism** (R8) rules out "fetched at" fields inside entity files, and
  forces explicit sort keys on every emitted record.
- **Toolchain.** Node runs TypeScript directly with no build step, and the repo
  deliberately has no typechecker and no compiler dependency. New code must run
  under `node --test` the same way the scaffold suite does.

## Design decisions

**D1 — Grain.** Three levels: *event* → *match* (a best-of series) → *game*.
Statistics and drafts attach to the game, never to the match. A match exists
because series score is a source fact that cannot be recovered by counting games
(forfeits, ties, and nullified games all break the arithmetic).

**D2 — Storage: two layers, both committed. Curated JSONL as source of truth, a
dimensional model on top of it.** The curated layer is one JSONL file per entity plus
JSON Schema: source-faithful, provenance-bearing, the thing the build validates and
the audit trail when a value is questioned. The modelled layer is the star schema of
R13, derived from it and never edited by hand. The split exists so that the analysis
surface can change (a better dimension, a new grain) without disturbing the evidence
it was built from. The paragraph below explains the curated layer's format;
Chosen over SQLite (a binary blob nobody can review in a pull request, and a
merge conflict nobody can resolve) and over CSV (nested drafts and per-player
arrays force either a second table or a serialized column). JSONL gives
line-per-record diffs, so a changed stat shows as one changed line, and byte
stability (R8) needs only stable ordering. The schema file is the contract the
build validates against.

**D3 — Identity.** A canonical ID is a surrogate key derived from the entity's
source identity, not from its display string and not from a row counter, so
adding an earlier event never renumbers later ones. Display names live on the
entity; aliases live in a separate alias table with the era they applied to.
Rejected: using the source string as the key (breaks on every rename and on
cross-source spelling differences — the archive spans sixteen years of both).
Every record repeats the entity's display name beside the ID, and the source's own
string where one exists, so the ID stays an implementation detail and an analyst
never has to decode one to read a row (R12).

**D4 — Era-aware coverage instead of uniform fields.** Field groups carry a
per-game coverage marker (R6) rather than a nullable column whose meaning
depends on the year. This is the decision that keeps 2011 in the dataset at all;
the alternative is a dataset that starts in 2014 and calls itself complete.

**D5 — Pipeline shape, and where the purity boundary is.** Five stages:
*fetch* (network, throttled, cached) → *cache* (raw bytes on disk) →
*normalize* (raw payload → typed entity, pure) → *assemble* (entities →
dataset, pure, resolves identity and coverage) → *emit + validate* (deterministic
serialization, then invariants). Only the first two touch the network or the
clock. Everything below the cache is a pure function of inputs on disk, which is
what makes the whole thing testable without a mock server.

**D6 — Repository layout.** `data/curated/` holds the emitted dataset, one file per
entity plus the manifest; `data/curated/schema/` holds the JSON Schema; `data/model/`
holds the dimensional model (dimensions, facts, its DDL, and its own data dictionary);
`raw/` (gitignored) holds the payload cache; `tools/dataset/` holds fetch, normalize,
assemble, emit, model and validate, with its tests beside them. The raw cache is not
committed — it is large, it duplicates a third party's content, and R9's manifest plus
hashes already pin it.

**D7 — Provenance record.** Each cached payload gets a sidecar with URL,
fetch time, HTTP status and body hash; the manifest lists the payload hashes the
dataset was built from. Entity records carry the source identifiers they came
from (the wiki's game id and match id, and Riot's platform game id and hash where
present) so any row can be walked back to a source page by hand.

**D8 — Ordering and determinism.** Every emitted file is sorted by its canonical
ID; no file contains a build timestamp; numbers are serialized with one fixed
format. The manifest is the only place a time appears, and it is excluded from
the byte-identity check.

**D10 — Modelling approach.** Curated → star. Decided: the curated layer is never
overwritten by the model; renames use an **alias bridge with validity dates rather
than a slowly-changing dimension** (type-2 rows duplicate a dimension key per change
and quietly break naive `COUNT(*)`/`GROUP BY` for the analyst who has not read the
docs — the archive is append-only and facts point at canonical entities, so the bridge
carries the history at a fraction of the confusion); facts carry integer surrogate
keys; dimensions carry natural keys and display names; an explicit **unknown member**
row exists for "not recorded", so an inner join does not silently drop games from an
era with thin data; and no derived measures live in facts. Rejected: type-2
dimensions (cost without benefit here), text keys in facts (no stability guarantee and
worse joins), and a single-layer design (a model built on source-faithful records
forbids ever correcting the source without losing the audit trail). The model is
emitted as **CSV plus DDL** (Open assumption 6), so it opens in a spreadsheet before
anyone writes a query.

**D9 — Fetch etiquette as a designed component, not an afterthought.** One
process, sequential requests, a fixed interval with jitter, exponential backoff
on a rate-limit response, a hard stop after repeated failures, and a cache that
makes every re-run a no-op for already-fetched windows. Resumability is the
requirement that shapes the cache key: it is derived from the query, not from
position in a loop.

**Measured source inventory** (from a live `cargofields` call, kept here because
the field set *is* the requirement, not an example):

- `ScoreboardGames` (69 fields) — `OverviewPage`, `Tournament`, `Team1`, `Team2`,
  `WinTeam`, `LossTeam`, `DateTime_UTC`, `Gamelength`, `Gamelength_Number`,
  `Team1Bans`/`Team2Bans` and `Team1Picks`/`Team2Picks` (list-typed),
  `Team1Players`/`Team2Players`, per-side `Dragons`, `Clouds`, `Infernals`,
  `Mountains`, `Oceans`, `Hextechs`, `Chemtechs`, `Elders`, `Barons`, `Towers`,
  `Gold`, `Kills`, `RiftHeralds`, `VoidGrubs`, `Atakhans`, `Inhibitors`,
  `Patch`/`LegacyPatch`/`PatchSort`, `MatchHistory`, `VOD`, `GameId`, `MatchId`,
  `RiotPlatformGameId`, `RiotGameId`, `RiotHash`, `RiotVersion`.
- `ScoreboardPlayers` — `Name`, `Link`, `Champion`, `Kills`, `Deaths`, `Assists`,
  `SummonerSpells`, `Gold`, `CS`, `DamageToChampions`, `VisionScore`, `Items`,
  `Trinket`, `Pentakills`, `Keystone*`/`PrimaryTree`/`SecondaryTree`/`Runes`,
  `Team`, `TeamVs`, `TeamKills`, `TeamGold`, `Tournament`, `Role`, `IngameRole`,
  `Side`, `DateTime_UTC`.
- `PicksAndBansS7` — `Team1Role1..5`, `Team1Ban1..5`, `Team1Pick1..5` (and the
  Team2 mirror), `SwitchedSides`, `Team1PicksByRoleOrder`, `GameId`, `MatchId`.
  The ordered draft lives here; the table's name and shape say 2017 onward, which
  is why R5 exists.
- `Tournaments` — `Name`, `OverviewPage`, `DateStart`, `League`, `Region`,
  `Prizepool`, `EventType`, `Organizer`, `StandardName`, `BasePage`. This is the
  R1 inclusion rule's input: `Region` carries `International` as a value.
- `MatchSchedule` — `Team1`, `Team2`, `Winner`, `Team1Score`, `Team2Score`,
  `BestOf`, `Phase`, `Round`, `Tab`, `DateTime_UTC`, `OverviewPage` — the match
  level for D1.

## Test seams

One high seam, then two narrow ones. Prior art in the repository: the worktree
and devc tests run real scripts against scratch directories rather than mocking
them, and `changelog-structure.test.ts` asserts shape over a real file — both
are "test the artifact, not a stand-in".

- **S1 (primary) — `buildDataset(rawDir) → Dataset`.** The whole pipeline below
  the cache, fed from a handful of **recorded** payloads checked into the test
  fixtures: one pre-2017 event, one 2017+ event, one edge-case event (forfeit or
  tied series). Asserts R2–R7 end to end. This is the seam every new behavior is
  added through; if a change cannot be expressed here, that is a design smell.
- **S2 — Dataset invariant suite over the committed `data/`.** Runs with no
  network and no fixtures: schema validity, referential integrity (R7), both-sides
  symmetry, winner consistency, team totals equal to the sum over that team's
  players (R10), coverage declarations that do not contradict the data (R6).
  This is the suite that catches a bad merge or a hand-edit.
- **S3 — Fetch etiquette, with a fake transport and a fake clock.** Assertions:
  requests are spaced, a rate-limit response triggers backoff and is not lost,
  the cache makes the second run issue zero requests, and an interrupted run
  resumes (R11). Deliberately no real network in any test.

Rejected seam: testing `normalize` field-by-field per Cargo table. It invites a
test per field, which is a test of the mapping syntax rather than of the dataset.

## Acceptance criteria

- [ ] R1 — the event set is computed by a committed rule; a test proves the rule
      selects the agreed international events and rejects a regional league.
- [ ] R2 — every game in the fixtures and in the committed dataset appears
      exactly once, with both sides, and no game is orphaned from its event.
- [ ] R3 — all team stat fields present per game, or explicitly marked absent.
- [ ] R4 — all player stat fields present per player-game, or explicitly marked
      absent; no stat is `0` where the source had no value.
- [ ] R5 — ordered drafts round-trip for a 2017+ fixture; a pre-2017 fixture
      yields unordered drafts with the marker set, and order is not inferred.
- [ ] R6 — every game carries a coverage record; a game with missing player stats
      is visibly partial, and the dataset-level coverage summary agrees with the
      per-game records.
- [ ] R7 — a rename pair in the fixtures resolves to one canonical entity with
      two aliases, and a second build does not mint a new ID.
- [ ] R8 — two builds from the same raw cache produce byte-identical output
      (manifest excluded).
- [ ] R9 — every emitted record's source identifiers resolve to a cached payload
      with a matching hash; deleting the cache and rebuilding from it changes
      nothing.
- [ ] R10 — a deliberately corrupted fixture (player kills not summing to team
      kills; unknown champion; duplicate game id) fails the build with a message
      naming the offending record.
- [ ] R11 — a full build issues requests at the designed interval, stores no
      credential, and resumes after an interruption without duplicate fetches.

## Verification

```bash
node --test tools/dataset/test/*.test.ts     # S1 + S3, fixtures only, no network
node tools/dataset/cli.ts build --offline    # emit + validate the committed dataset
node tools/dataset/cli.ts model --offline    # build + conformance-test the star schema
node --test .pi/extensions/subagent/test/*.test.ts   # scaffold stays green
```

A real crawl is verified separately and deliberately not part of the gate: it is
slow, depends on a third party, and its output is pinned by hashes rather than
re-derived on every run.

## Open assumptions

1. **The 2011–2016 era is genuinely thinner, and this spec accepts that.**
   *(Decided 2026-11-12: era-aware completeness accepted — R5 and R6 stay as
   written, and 2011 stays in the dataset. The coverage measurement is ticket 09's
   job; the decision to accept a thinner early era is not open again.)* The
   ordered draft table is `PicksAndBansS7`, so order is expected to be unavailable
   before 2017, and per-player statistics are expected to be sparse or absent for
   the earliest events. R5 and R6 are written to survive that. The measurement
   that replaces the expectation is ticket 09's; the shape question behind it is
   closed, because starting the dataset in 2014/2017 instead was rejected on
   2026-11-12 in favour of keeping 2011 and marking it.
2. **What counts as a "major international event"** beyond Worlds and MSI.
   *(Decided 2026-11-12: the third-party-majors scope, with All-Star excluded.)* The
   admitted set is: World Championship (2011–2026), MSI (2015–2026, none in 2020),
   First Stand (2025–2026), Mid-Season Cup (2020), Rift Rivals (2017–2019), IEM World
   Championships, IPL, World Cyber Games, and the Esports World Cup. Deliberately
   **excluded**: All-Star (its 5v5 invitationals are real games but its 1v1 bracket
   and alternate-mode showmatches are not, so admitting it would push a per-game
   "is this a real game" judgement into the event rule), national-team events such as
   the Asian Games (a different competitive unit from the club dataset), regional
   leagues, IEM's regional stops, and qualifiers for an already-included event. The
   set lives in the repository as data, so a later change to it is a reviewable diff
   rather than a rewrite. Size estimates used to make this call were computed from
   team counts and format, not measured: ticket 09 measures, ticket 10 counts.
3. **Licence and public release.** CC BY-SA share-alike on Leaguepedia-derived
   data, and what that means for the repository when it stops being private.
   *(Partly decided 2026-11-12: attribution lands in the same change as the first
   committed data — ticket 09 — rather than after the full crawl in ticket 11, so
   no data ever lands unattributed. Refined the same day: the first committed
   source-derived material is ticket 01's recorded payload fixtures, not ticket 09's
   data, so attribution lands in ticket 01 and tickets 09 and 11 extend it. Whether
   the repository goes public is still the user's call, and does not block the data
   being correct.)*
4. **Whether per-minute timelines are ever in scope.** They are the one thing ACS
   holds that no other source does, and they are excluded here. If the answer is
   yes, ACS's cookie requirement collides with R11 and needs its own decision.
   *Confirm:* user, on a later spec.
5. **Whether the dataset ships committed data or only the builder.** *(Decided
   2026-11-12: the data ships. The builder is a means, not the product — the artifact
   is a dataset a data analyst can open and work with, which is R12, on the modelled
   layer of R13.)*
6. **The modelled layer's file format.** *(Decided 2026-11-12: CSV plus committed
   DDL.)* One CSV per dimension and per fact, RFC 4180 quoting, UTF-8 without a BOM,
   a header row, stable column order, ISO-8601 UTC dates, unformatted integers, and
   an **empty field for absent** — distinct from `0`, which is why a measure is never
   defaulted. The DDL is committed beside the CSVs and targets SQLite's dialect, which
   DuckDB accepts as written and Postgres accepts with a type mapping, so the model
   loads with no conversion step. A local `lol.sqlite` may be generated from them and
   is not committed: binary in git is unreviewable, which is the same argument that
   kept the curated layer out of SQLite in D2. Also settled here: dimensions carry an
   **alias bridge, not a type-2 history** (D10) — type-2 duplicates keys and quietly
   breaks naive `COUNT(*)` for a reader who has not studied the docs. Rejected: a
   committed SQLite file (binary in git), Parquet (a dependency this repository
   refuses, and unopenable by a junior analyst without tooling).
