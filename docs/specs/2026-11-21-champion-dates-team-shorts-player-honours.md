# Champion release dates, team short names and player honours

Follows the dataset spec (`2026-11-12-lol-esports-dataset.md`) and answers
[issue #35](https://github.com/RRiboulet/lol-dataset/issues/35), opened by Cristina
Andrés: *"add champion release date / add distinction titles of each player (ex:
worlds mvp) / add shortnames for teams (Karmine Corp = KC)"*.

## Objective

The three entity files are what an analyst opens first, and today they answer less
than the source already states: a champion row says nothing about when the champion
existed, a team row says nothing about how the team is abbreviated, and nothing in
either layer records that a player was named Worlds MVP. Each of the three is an
*attribute of an entity the corpus already carries*, not a new grain, so adding them
is cheap in data and expensive to postpone: every one of them changes
`data/curated/` and `data/model/` shapes, and the entity schemas are the contract a
downstream reader writes against.

The honours are the one part that is a new record rather than a new column: a
"distinction" is a fact about (player, event), so it needs its own file, its own
grain and a place in the model.

## Current behavior

Measured on `dev`, not assumed.

- **Champion release dates are already fetched and thrown away.** The committed
  `Champions` payload query asks for `Name,KeyInteger,ReleaseDate`, and both
  committed payloads carry a value for every one of their 217 rows at day precision
  (`ReleaseDate__precision: 1`). `normalizeChampions` reads only `Name` and
  `KeyInteger`, so `data/curated/champions.jsonl` has no date column; all 171 curated
  champions have a non-null source row, so no champion is left without one.
- **Team short names are not fetched at all.** The committed `Teams` payloads ask for
  `_pageName,Name,OverviewPage,Region,RenamedTo`, so `data/curated/teams.jsonl`
  (`id`, `name`, `overviewPage`, `region`) cannot carry a short name. A live probe of
  `Teams` for the 193 curated teams that still resolve to a registry page returned a
  non-empty `Short` for **all 193** (`Karmine Corp` → `KC`, `T1` → `T1`,
  `100 Thieves` → `100T`); the other 4 curated teams are minted from strings no
  registry carries and have no page to ask about. Four short names are each shared by
  two teams in this corpus (`ESC`, `GMB`, `IM`, `RED`).
- **Nothing records a distinction.** No file in `data/curated/` or `data/model/`
  carries one. The source's table for them is `IndividualAchievements`, live and
  measured: fields `Player`, `Link`, `Team`, `OverviewPage`, `Display`, `Place`,
  `Place_Number`, `AchievementType`, `Description`; `AchievementType` has exactly one
  value, `Season Award`, so the distinction itself is the free-text `Display`
  (`Most Valuable Player`, `Finals MVP`, `MSI MVP`, `All Pro Team`, `Best Coach`).
  Worlds MVPs are there for nine editions — Season 1 (Shushei), 2014 (Mata), 2017
  (Ruler), 2021 (Scout), 2022 (Kingen), 2023 (Zeus), 2024 (Faker), 2025 (Gumayusi),
  2026 (Knight) — and MSI awards too (`2015` → Clearlove, `2016` → Faker,
  `2023`/`2024`/`2025` finals MVPs). The award history is **not** complete per edition:
  no Worlds MVP row exists for 2012, 2013, 2015, 2016, 2018, 2019 or 2020.
  Two things make the join non-trivial and are measured, not guessed: `Link` is null
  on exactly the tournament-MVP rows and populated for the regional season awards, and
  `Player` is a page name *or* one of its aliases (`knight (Zhuo Ding)` for the page
  `Knight (Zhuo Ding)` — MediaWiki first-letter case, an alias the player registry
  already carries).
- **The model's columns are enumerated by hand.** `dim_champion` is
  (`champion_key, champion_id, champion_name, riot_key`), `dim_team` is
  (`team_key, team_id, team_name, overview_page, region`), `dim_player` is
  (`player_key, player_id, player_name, overview_page`); the DDL and the per-column
  dictionary are generated from that list, so a new attribute is three coordinated
  edits plus a regenerated dictionary.

## Required behavior

Numbered so tickets and tests can cite them. B1–B5 extend the parent spec's R7 and
R12 (source-faithful attributes, readable rows); B6–B11 extend R13 (the modelled
layer); B12–B13 are R8/R9 restated for the new payloads.

**B1 — A champion states its release date.** Every `champions.jsonl` row carries the
source's release date as an ISO `YYYY-MM-DD` string, or the key is absent. It is never
inferred, rounded or taken from another champion; the value comes from the registry
row that already anchors the champion's identity.

**B2 — The date is only stated at the precision the source states.** A source row
whose `ReleaseDate__precision` is not day-level fails the build with a message naming
the champion, instead of the dataset stating a day the source does not claim.

**B3 — One champion, one release date.** If two registry rows for the same Riot
champion id disagree on the release date, the build fails and names both payloads, the
same way it already fails on two display names for one id.

**B4 — A team states its short name.** Every `teams.jsonl` row carries the source's
`Short` string, decoded the way every emitted display string is (the build
entity-decodes names; nothing else is rewritten), or the key is absent. A team minted
from a string no registry carries has none.

**B5 — A short name is a label, never an identity.** It is not unique — measured,
`ESC`, `GMB`, `IM` and `RED` each denote two teams in this corpus — so nothing may
join, deduplicate or look up by it, and the documentation says so beside the column.
Two teams sharing a short is data, not a defect, and the build must not "fix" it.

**B6 — A distinction is a record with its own file.** A new curated file holds one row
per player distinction at an admitted event, carrying: the player and the event it is
attached to, the source page it was stated on, the distinction title as the source
states it (`Display`), the source's award type, the source's team string and the
resolved team id where the registry resolves one, and the source's place and place number
where it states them. No row is dropped for being unusual: "Best Coach" and "All Pro
Team" are distinctions the source states. The source's `Description` column is **not**
carried: measured live on the table, it is `-` on a tournament MVP and the full roster's
wikitext on an All-Pro row, so it is markup, not a description of the award.

**B7 — A distinction has a stable identity and a declared grain.** Its canonical id is
derived from the source tuple that identifies the distinction (event page, player and
distinction title), never from a row counter, so a re-crawl does not renumber and a new
award does not shift the others — the page it was stated on is provenance, not identity,
so the same award stated on an event's page and on its `/Main Event` page is **one** row,
matching the grain. Re-reading the same payload twice yields one row; two rows that differ
in title, event or player stay two rows.

**B8 — Distinctions belong to admitted events.** A distinction is included when the
page it was stated on is the admitted event's page or a stage sub-page of it — the same
`LIKE '<event page>%'` rule the crawl already applies to scoreboards, so
`2024 Season World Championship/Main Event` counts as the 2024 event. Awards from
regional leagues, qualifiers and events the selection rule rejects never enter the
dataset, and their absence is not a coverage gap.

**B9 — A distinction's player is resolved through the player registry, and an
unresolved one is reported.** A resolved player is emitted in `players.jsonl` even when
no scoreboard row names them (a coach, an analyst), and the invariant gate's rule that
every emitted player is named by a player-game row is widened to accept a distinction
row as evidence. A player string that resolves ambiguously, or to no page and no alias,
is reported in `identity-unresolved.jsonl` rather than dropped or guessed.

**B10 — A distinction's team is context, not an entity claim.** The resolved team id is
emitted when the registry resolves the string; when it does not, the source's string is
carried and no team entity is minted from it. A distinction never fails the build over a
team string.

**B11 — The model carries the distinction at a declared grain.** One fact row per
distinction, keyed by player, event and team (team key `0` is the unknown member), with
the title as the row's own attribute. No derived measure, no pre-aggregation: counting
MVPs is the analyst's job. Champion release dates and team short names ride on their
dimensions, and the release date is a dated attribute, *not* a foreign key into
`dim_date`, because `dim_date` is the calendar of the games the facts describe.

**B12 — Both new payloads are provenance-pinned and tamper-reported.** Each new or
re-fetched payload has its sidecar and manifest pin like every other, and the tamper
report names the emitted files the new table feeds.

**B13 — The gates stay honest.** The schemas keep `additionalProperties: false`; the
generated curated and model dictionaries, the DDL and the data documentation are
regenerated by the build, so a schema change that forgets them fails rather than
leaving a stale table; two builds from the same cache remain byte-identical.

## Non-goals

- **Regional season awards** (LCK/LPL/LEC/LCS splits, All-Pro teams of a regular
  season). Decided 2026-11-21: the dataset takes the **tournament's** distinctions, not
  the season's, and the event rule is the boundary. Not moved by this spec.
- Career totals, "number of MVPs" counters, Hall of Fame, or any rank/ordering of
  distinctions.
- Normalising distinction titles into a controlled vocabulary (`MVP`, `Finals MVP`,
  `Most Valuable Player` stay three strings, as the source states them).
- Champion statistics, lore, skins, price or kit; only the release date.
- Historical or per-era team short names (`Teamnames` carries a short per team name
  variant over time). One short per team, the current one.
- Per-game MVP or player-of-the-game markers: the source does not carry them.
- Any change to coverage markers. A distinction is enrichment; an event with none is
  not "incomplete".

## Constraints

- **The source rate-limits hard**, measured at 75s between Cargo requests with a limiter
  that outlasts 100s. The honours crawl adds one request per admitted event — 54
  queries, roughly 70 minutes on top of the existing crawl — and the `Teams` re-fetch is
  2 payloads over 5 582 rows. Both are slow-job work, not a test.
- **The field list is part of the cache key.** Adding `Short` to the `Teams` query
  orphans the two committed `Teams` payloads, which identity also reads for
  `RenamedTo`; they are re-fetched with the extra field and the old files removed, and
  the manifest, the plan files and the fixtures move together. Changing a normalizer
  alone does not re-query, which is why the champion date rides for free and the short
  name does not.
- **Determinism** (parent R8): ordered ids, no fetch time inside the data.
- **Licence** (parent Constraints): the new payloads are Leaguepedia-derived CC BY-SA
  3.0 content and are covered by `data/ATTRIBUTION.md` and `licenses/NOTICE.md` before
  they land.
- **Toolchain**: Node runs TypeScript directly, no build step, no typechecker.
- **Model conformance**: the honour fact must satisfy the existing foreign-key,
  grain-uniqueness and rollup checks, which means the unknown member at key `0` must
  absorb a distinction with no team.

## Design decisions

**D1 — The champion release date comes from the registry row identity already uses,
and costs no request.** `Champions.ReleaseDate` is in the cache today; the normalizer
starts reading it. *Rejected*: Riot's Data Dragon, which carries no release date, and
mer.gg/wikis, which would introduce a second source and a second identity anchor for a
date the source of record already states.

**D2 — Day precision is a precondition, not a column.** The dataset states a date or
nothing. A coarser source stamp is a schema change to be made deliberately, not a
precision field every reader must interpret. *Rejected*: a `releaseDatePrecision`
column, which would be a constant `1` for 217 rows today and push a Cargo encoding
(`__precision`) into the public schema.

**D3 — The short name is `Teams.Short`, fetched by widening the existing `Teams`
query.** *Rejected*: a separate narrow `(Name, OverviewPage, Short)` crawl, which would
keep the committed payloads alive but duplicate 5 582 rows to avoid re-fetching them;
and *rejected*: `Teamnames`, which is richer (a short per name variant, keyed by a
wiki template registry) and out of scope per Non-goals.

**D4 — Distinctions get their own curated file, not a field on `players.jsonl`.**
A player row is one row per player; a list of awards inside it would break the
line-per-record diff, force the model to read a nested array, and make the entity file
the join surface for something that joins to events. *Rejected*: embedding an
`honours` array (breaks R12's one-entity-per-line reading and the model's dimension
shape), and *rejected*: a model-only table built from the raw payload (breaks D2 of the
parent spec — the curated layer is the evidence, the model is derived from it).

**D5 — Honours are crawled per admitted event with the plan generator, not as a whole
table.** The crawl gains a fifth per-event query, so the rule that decides which events
exist also decides which awards exist, and an event added later brings its awards with
it. *Rejected*: one global query filtered client-side, which would fetch tens of
thousands of regional season awards to discard most of them.

**D6 — The distinction title is a degenerate attribute on the fact, not a dimension.**
Titles are free text with no controlled vocabulary, so a `dim_honour` would be a
distinct-string table nobody joins to for a reason. *Rejected*: classifying titles into
an enum, which would be the dataset inventing a taxonomy the source does not have.

**D7 — The release date is a dated attribute, not `date_key`.** `dim_date` exists to
date the games a fact describes; putting 2009–2026 champion release dates into it would
add calendar rows no fact can reach. The alternative, extending `dim_date`'s grain to
"any date the dataset mentions", is a bigger change than this one and belongs to
whoever needs the join.

**D8 — A distinction's team stays optional.** The source states a team string that
often is an abbreviation or an old name (`ssw`, `SKT T1`); resolving it through the
existing alias registry is worth doing, and an award may therefore put a *known* team in
`teams.jsonl` that no game attests — accepted, because the string is the source's and the
entity is real. Minting a *new* team from an award would not be: it would invent an
entity the corpus's games never name, so a string nothing carries stays text.

**D9 — The invariant gate widens by one clause per entity kind, not by an exemption.**
"Every emitted player is named by a player-game row" becomes "…by a player-game row or a
distinction row", and the team clause follows because a resolved honour team is a
reference too, in the direction the gate already checks (an entity that nothing names is a
defect). A coach named only by an award is legal; an orphan entity still is not.

## Test seams

The parent spec's seams carry this change; one narrow seam is added, and it is the
one the source's messy `Player` strings justify.

- **S1 (primary) — `buildDataset` over fixtures.** Add fixture payloads for the new
  table and re-record the `Teams` payloads with `Short` (the champion payloads already
  suffice). Asserts B1, B3, B4, B6, B7, B8, B9, B10 end to end, and byte-identical
  output across two builds.
- **S2 — Invariant and model gate over the committed data.** Every distinction's
  player and event resolve; every fact foreign key resolves under the existing checks;
  the regenerated dictionaries and DDL match the committed bytes; coverage files are
  unchanged by the enrichment. Prior art: `tools/dataset/test/invariants.test.ts`,
  `model.test.ts`, `dictionary.test.ts`.
- **S3 (new, narrow) — the honour normalizer's player resolution.** A table of
  measured cases: page name, alias (`knight (Zhuo Ding)`), a coach with no scoreboard
  row, a handle shared by two pages, and a string that resolves nowhere. Prior art:
  `identity.test.ts`'s rename pairs and the unresolved report.
- **S4 — the fetch plan gains the query.** The plan test that already asserts a
  generated query equals the committed plan gains the honours query for one event, so
  the field list cannot drift from what the crawl actually fetched. Prior art:
  `plan.test.ts`.

Rejected seam: a per-field assertion on every Cargo column in the achievement row. It
tests the mapping syntax, not the dataset — the same reason the parent spec rejected
per-field normalizer tests.

## Acceptance criteria

- [ ] B1 — every champion row carries its source release date or omits it; a rebuild
      reproduces the committed bytes.
- [ ] B2 — a fixture row with a coarser precision fails the build, naming the champion.
- [ ] B3 — two Registry rows for one Riot id that disagree fail the build.
- [ ] B4 — every team row that resolved to a registry page carries a non-empty short
      name; a minted team omits it.
- [ ] B5 — two teams sharing a short name both keep it, and no lookup path in the
      build or the docs uses a short name as a key.
- [ ] B6 — a distinction row carries player, event, source page, title, type, team
      string, resolved team id when available, and place/description when stated.
- [ ] B7 — reading the same distinction payload twice produces one row; a distinct
      title at the same event and player produces two; ids are stable across builds.
- [ ] B8 — an award on a stage sub-page of an admitted event is included; an award
      from a rejected event and from a regional season is absent.
- [ ] B9 — a player named only by a distinction appears in `players.jsonl` and passes
      the invariant gate; an ambiguous or unresolvable one appears in
      `identity-unresolved.jsonl`.
- [ ] B10 — a distinction whose team string resolves to nothing keeps the string, adds
      no team row, and does not fail the build.
- [ ] B11 — the model carries one honour fact row per distinction, team key `0` when
      unknown, and the conformance suite passes over the full dataset.
- [ ] B12 — each new payload has a sidecar and a manifest pin, and the tamper report
      names the files the new table feeds.
- [ ] B13 — both dictionaries, the DDL and the data documentation are regenerated in
      the same change; `build --check` and `model --check` are clean.

## Verification

```bash
node tools/check.ts                                  # both suites, no network
node tools/dataset/cli.ts build --check              # curated bytes + manifest, offline
node tools/dataset/cli.ts model --check              # model, DDL, dictionary, offline
node --test tools/dataset/test/*.test.ts             # dataset suite alone while iterating
```

The crawl itself is verified the way ticket 16's was: a re-run issues zero requests for
already-cached queries, and the new payloads are pinned by hash rather than re-fetched
by the gate.

## Open assumptions

1. ~~**Distinctions are scoped to the 54 admitted events.**~~ **Decided 2026-11-21:
   the tournament's distinctions, not the season's.** The source files both kinds in the
   same table (`AchievementType` is `Season Award` throughout, and the season awards are
   the majority of its rows), so the boundary is the event rule: an award stated on an
   admitted event's page or a stage sub-page is in; `LCS/2024 Season/Spring Season`,
   a regional All-Pro team and anything else from a league the rule rejects is out. That
   keeps the dataset's existing boundary and its crawl to 54 queries. Not open again.
2. **A player named only by a distinction is emitted.** Coaches and analysts are
   "players" in the source's registry and appear in award rows; B9 emits them, so
   `players.jsonl` will contain people with no player-game row. If a player file is
   meant to be *only* game participants, the alternative is to drop those distinctions
   with a report — which loses the "Best Coach" titles. Risk: medium — a schema
   semantics question, not a shape one.
3. **All distinction titles are kept, unfiltered.** `All Pro Team`, `Best Social Media`
   and `Outstanding Rookie` are as much source facts as `Finals MVP`; the dataset does
   not rank them. If only MVPs are wanted, the filter has to be declared somewhere
   reviewable (a rule file) rather than in the normalizer. Risk: low.
4. **The source's MVP coverage is partial and the dataset will not say otherwise.**
   Measured, `IndividualAchievements` carries a Worlds MVP for Season 1 and 2014 and for
   2017 and every year since 2021, but none for 2012, 2013, 2015, 2016, 2018, 2019 or
   2020. The dataset
   therefore reports what the source states and never claims an award list is complete;
   R6's per-game coverage markers are not extended to awards. Risk: low — an
   expectation-setting point for the user, not an implementation one.
5. **The short name is the current one, not an era's.** `Teamnames` could give the
   short in use at each of a team's name variants; that is deliberately out of scope and
   can be a later spec if the analyst asks. Risk: low.
6. **Naming.** The tickets pin `data/curated/honours.jsonl`, its schema, the `hn-` id
   prefix and the model table `fact_player_honour`; "honours" is the word this spec uses
   for what the issue calls "distinction titles", and a rename is cheapest before the
   schema is written. Risk: low.
