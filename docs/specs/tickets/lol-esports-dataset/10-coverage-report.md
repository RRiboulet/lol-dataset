# Ticket 10 — the full crawl, and what the covered eras hold

Ten selected events, crawled through `tools/dataset/fetch.ts` in 45 requests, assembled
into the committed dataset, and summarized by a coverage report the build generates. This
is the record of what the source actually gave us, era by era, and of the three
decisions the full crawl forced that a two-event rehearsal could not see.

## What was asked

Four crawl plans, all under `tools/dataset/plans/`, run one after another through
`node tools/dataset/cli.ts fetch --plan … --raw raw` at the fetcher's measured-safe
interval (75 s plus up to 15 s of jitter, one request at a time):

| Plan | Queries | Requests | Purpose |
|---|---|---|---|
| `ticket-10-events.json` | 24 | 20 (4 cached) | the four game-bearing tables for the six events without games |
| `ticket-10-identity.json` | 19 | 19 | `Teams`, `TeamRedirects` and `PlayerRedirects` for every string identity had minted |
| `ticket-10-teams-closure.json` | 1 | 1 | `Teams` rows for the pages a rename or redirect points at |
| `ticket-10-registry-probes.json` | 5 | 5 | a redirect name used as a rename target, and the strings no registry carries |

The event plan asks each table for one anchored page prefix per event —
`OverviewPage LIKE '2020 Mid-Season Cup%'` for games, players and series, and
`GameId LIKE '2020 Mid-Season Cup%'` for `PicksAndBansS7` — with the field lists ticket 09
measured. The four events ticket 09 and 14 already crawled keep their own plans; a second
query shape for them would be the same rows fetched twice under a different cache key.

**45 requests, zero `ratelimited` answers, zero retries, zero run-ending failures**, in
about 77 minutes wall-clock (08:57–10:14 UTC). The source did not push back once; the
interval is what made that true, not luck — ticket 09 measured the limiter tripping after
three or four unspaced requests.

The crawl wrote into the gitignored `raw/` cache and the payloads were copied into
`tools/dataset/fixtures/raw/`, so `build --raw tools/dataset/fixtures/raw` reproduces the
committed dataset with no network. **79 payloads, 10.8 MB committed** (from 34 payloads /
8.0 MB): 8.9 MB of that is `ScoreboardPlayers`, which is one row per player per game and
had to be fetched in full for the report to say anything true about player coverage.

## What the dataset now holds

| Event | Year | Games | Series | Fields the source states |
|---|---|---|---|---|
| World Cyber Games 2011 | 2011 | 0 | 0 | nothing: four game-bearing queries returned zero rows |
| IPL 5 | 2012 | 72 | 36 | player kills/deaths/assists/CS/gold, no team statistics at all, no player damage |
| World Cyber Games 2013 | 2013 | 0 | 48 | series rows only; every game-bearing query returned zero rows |
| IEM Season IX World Championship | 2015 | 19 | 13 | player kills/deaths/assists/CS/gold/trinket, thin team statistics |
| Rift Rivals 2017 NA-EU | 2017 | 21 | 19 | ordered drafts, player trinket only |
| Mid-Season Cup 2020 | 2020 | 25 | 17 | vision and keystone on every player row, no damage, no runes |
| MSI 2023 | 2023 | 76 | 25 | everything R4/R6 asks for, one ban slot the source marks `None` |
| Worlds 2023 | 2023 | 110 | 52 | everything |
| Esports World Cup 2024 | 2024 | 19 | 7 | everything |
| First Stand 2025 | 2025 | 35 | 13 | everything |
| **total** | | **377** | **230** | |

3 770 player-game rows, 111 teams, 323 players, 173 champions, 791 alias rows, 11
unresolved references. `event-games.jsonl` reports nine events `recorded` and WCG 2011
`empty`; World Cyber Games 2013 is `recorded` with zero games and 48 series, which is the
state that keeps "the source carries series rows and no scoreboards" apart from "nobody
asked".

## The coverage report, per era

`data/curated/event-coverage.jsonl` and `data/curated/era-coverage.jsonl` are emitted by
the build from the per-game markers in `games.jsonl`, and the invariant gate re-counts
both against those markers — so an event can never be reported more complete than its
games (that reconciliation is the ticket's third acceptance criterion, tested in
`tools/dataset/test/coverage.test.ts`).

| Era | From | Games | team-stats | draft | player-stats |
|---|---|---|---|---|---|
| `pre-herald` | 2011-01-01 | 91 | partial (19/91) | partial (91) | partial (91) |
| `herald` | 2015-11-11 | 0 | unavailable | unavailable | unavailable |
| `elemental-drakes` | 2016-01-14 | 46 | partial (46) | complete | partial (46) |
| `hextech-chemtech` | 2021-11-17 | 0 | unavailable | unavailable | unavailable |
| `chemtech-withdrawn` | 2022-01-25 | 0 | unavailable | unavailable | unavailable |
| `chemtech-restored` | 2022-11-16 | 186 | complete | partial (1 of 186) | complete |
| `voidgrubs` | 2024-01-10 | 19 | complete | complete | complete |
| `atakhan` | 2025-01-09 | 35 | complete | complete | complete |

What that says, field by field rather than as a score:

- **2012 (IPL 5)** is the thinnest data in the corpus and it is thin in a specific way:
  every game has ten player rows with kills, deaths, assists, CS and gold, and **no team
  statistic at all** — the source's `ScoreboardGames` row for those games states neither
  kills nor gold for either side. Team coverage is therefore `unavailable`, not `partial`.
  Player coverage is `partial` because damage, vision, keystone and runes are absent.
- **2013 is not a data gap that a better crawl could close.** Four game-bearing queries
  returned zero rows; the `MatchSchedule` query returned 48 series rows, so the event is
  represented by its series and has no games. The 62 series rows recorded under
  `…/Qualifiers/{Argentina,Chile,China,Korea,Taiwan}` are **not** the event (see below).
- **2014–2016** states kills, gold, towers, barons and a plain dragon count, and nothing
  else the era table judges. `inhibitors` is eligible in every era and every IEM 2015 row
  omits it, so that game set stays `partial` forever — a source gap, not a defect.
- **2017 keeps the ordered draft but not the player detail.** Rift Rivals 2017 has
  numbered draft slots and 21 complete drafts, but its player rows state only trinket
  beyond the kills/deaths/assists/CS/gold core: no damage, no vision, no keystone, no
  runes. Its team-stats row has kills, gold, towers, barons, rift heralds and a plain
  dragon count, and **no inhibitors and no elemental drake split**, which is what makes
  that era's team coverage `partial`. Draft coverage flips to `complete` a full three
  years before player coverage does.
- **2020 is the transition.** The Mid-Season Cup states vision score and keystone on every
  player row, still no damage and no runes, and its team row has every field the era table
  judges except the elemental drake split. Its three blind-pick games are draft-complete
  with no bans (see below).
- **2023 is the first year every field group is complete**, with one exception: MSI's
  `Team2Ban4` is the literal string `None`, the source's placeholder for an unused slot,
  so that one game's draft is honestly `partial` and MSI's event-level draft state is
  `partial` with it.
- **2024 and 2025 are complete in all three groups**, with void grubs and Atakhan eligible
  and stated.

So the spec's expectation ("the 2011–2016 era is genuinely thinner") holds, but the
shape is more specific than "early is thin": **team statistics and player statistics thin
out and recover at different dates, and the ordered draft appears in 2017 without them.**
The era table needs no new boundary for this; the three field groups are judged
independently, which is what makes the difference visible instead of averaging it away.

## Three decisions the crawl forced

### 1. A qualifier page under an event is not the event

`2013 World Cyber Games/Qualifiers/China` is a subpage of the event's page, and the
game→event attachment was a prefix test, so the crawl pulled **62 qualifier series from
five countries into World Cyber Games 2013** — a competition the spec's event set
explicitly excludes ("qualifiers for an already-included event"). IPL 5's six
wildcard-qualifier series had already been committed the same way by ticket 14.

The boundary is now the **first path segment after the event page**: a stage page
(`…/Play-In`, `…/Main Event`) is the event, `…/Qualifiers/…` is not. The rows are still
crawled and still counted — they appear in the build's summary as 68 ignored series from
pages no selected event covers — so the exclusion is visible rather than silent. IPL 5's
committed series count drops from 42 to 36 as a result; ticket 14's document records why
its "a match with no games" example moved to World Cyber Games 2013.

### 2. Blind pick is a draft fidelity, and it is declared

The 2020 Mid-Season Cup played **game one of every best-of-five in blind pick** (Riot's
announced format; the wiki's event page states it). Three things happen at once in the
source for those games: no `PicksAndBansS7` row, no ban on either side, and — legal only
in blind pick — the same champion on both sides (`Semifinals_1_1` and `Finals_1_1` both
have Varus on both teams). The old build stopped with "the same champion appears twice in
this game's draft".

The dataset could have absorbed that by weakening the duplicate invariant, but then it
could not tell a legitimate blind pick from a corrupted row; it could have dropped the
draft, which is the lie R6 exists to prevent. Instead the format is **declared** in
`tools/dataset/rules/game-formats.json`, next to the era table and the identity aliases:
the game id pattern names the games, `cites` says where the claim comes from, the game
carries `draft.blindPick: true`, and the build refuses a declaration that contradicts its
rows (a blind pick that states bans, a declared pattern matching no game of an event the
corpus carries). A duplicate champion is still refused everywhere else, and still
refused **within one side** everywhere. Spec R5 gained the third fidelity for it.

### 3. Identity is a crawl of its own, and it mostly closes

Before this ticket the build minted **374 provisional entities** — 105 teams and 269
players — because the recorded registries only covered the strings tickets 02–09 happened
to need. The identity plan asked the source about exactly those strings, and the report
fell to **11** (nine teams from World Cyber Games 2013's qualifier stage — `w2w`, `Mook`,
`Cash`, … — and two players, `Eliade` and `Insta`). The final probe confirmed the registry
carries none of them: `Teams where Name IN (…)` and `PlayerRedirects where ID IN (…)`
both returned zero rows. A human resolution for those eleven belongs in
`rules/identity-aliases.json`, not in a scraper guess.

Two source facts surfaced while closing the registry, both now handled and tested:

- **A duplicate `Teams` row.** `Phoenix1` has two rows that differ only in `RenamedTo`
  (one names `Sentinels`, one is empty). An empty value is an absence, not a contradiction
  of a stated rename, so the stated value wins; two rows stating *different* renames still
  stop the build.
- **A rename that points at a redirect name.** `Lyon Gaming (2013 Latin American Team)`
  says it was renamed to `Rainbow7`, which is not a page any more — `TeamRedirects` maps
  it to page `Movistar R7`, which was itself renamed to `LYON (2024 American Team)`. The
  chain now follows the source's own redirect row instead of stopping; a target that is
  neither a page nor a redirect name is still a hard stop.

### 4. A `matchId` is still never invented

The crawl added five events' worth of games and series, and the ticket-14 rule held: 8 IPL
5 games whose series row names two other teams are emitted without a `matchId`, and the 6
contradicted series are not emitted. No new detachment appeared in the newly crawled
events.

### 5. Entities are emitted only when referenced

The registry crawl fetched every page the source names — the build registered 111 teams and
323 players — but the entity files are the dataset's join surface, and 43 of those teams and
32 of those players were named by no emitted record: first seen on the excluded qualifier
pages whose games and series this dataset deliberately does not carry, or on pages the rule
never considered (Season 1's scoreboard payload, kept as ticket 02's identity evidence), or
registry pages no admitted event touches (`NaJin Black Sword`, `Samsung Blue`). They stay
resolution input — a qualifier-page string identical to a string an emitted row uses still
resolves to the one entity — but they left `teams.jsonl`, `players.jsonl`, `champions.jsonl`,
the alias table and the unresolved report, which now carries only the two strings an emitted
row still cannot resolve (`Eliade`, `Insta`). The filter runs on the emitted records
themselves at the end of assembly, so a series the build holds back as contradicted cannot
keep an entity either; and the invariant gate refuses an emitted entity that no game side,
match side, player-game row or conflict-report row names, so the rule is executable rather
than prose.

## What is left

- **11 unresolved references** with no registry row at all (above). They are reported, not
  guessed; resolving them is a human statement in `rules/identity-aliases.json`.
- **`data/model/` was rebuilt over the full dataset**, because ticket 12's dimensional
  model merged while this crawl was running and its CSVs would otherwise describe four
  events while the curated layer carries nine. Ticket 13 is the deeper model work (the
  full-dimension review); keeping the committed model current is all this ticket does:
  `node tools/dataset/cli.ts model` and `model --check` both pass, 3 770 fact rows at the
  player grain and 7 144 at the draft-slot grain.
- **R12's "loads into a spreadsheet with no preprocessing"** is only partly met by the
  curated layer: JSONL loads directly into pandas (`read_json(lines=True)`) and DuckDB
  (`read_json_auto`), and needs an import step in spreadsheet-grade tools. The CSV model
  layer (spec D10, tickets 12/13) is where that criterion is actually satisfied, so it
  stays unticked here and is pointed at those tickets.

## Validation

- `node tools/dataset/cli.ts build --raw tools/dataset/fixtures/raw --check` — the
  committed dataset is exactly a rebuild of the committed fixtures, manifest included.
- `node tools/check.ts` — both suites green (dataset 195 tests, scaffold unchanged).
- The coverage reconciliation lives in `tools/dataset/test/coverage.test.ts` (the report
  is re-counted against the markers it claims to aggregate) and in
  `tools/dataset/invariants.ts` (the gate refuses a report row that over-claims or drops a
  game).
- The blind-pick declaration and its refusals are covered by
  `tools/dataset/test/formats.test.ts`; the qualifier boundary by a case in
  `tools/dataset/test/games.test.ts`.
