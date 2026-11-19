# 16: The event set is computed, not hand-listed

**Blocked by:** 10 (done), 14, 15
**Status:** done

## What to build

The editions the committed rule admits but which were never fetched. Before this ticket the
candidate universe was a hand-written `OverviewPage IN (…)` / `LIKE` list of nineteen
pages; the rule decided over those and the report looked complete over them. An edition the
rule admits and nobody listed was invisible to the rule, the report and every gate — so
"every event selected by the rule is present" (ticket 10) was true only vacuously, and
spec R1 ("the dataset contains every event matching the committed inclusion rule, and
nothing else") was not met.

The universe is now a query over `Tournaments` (committed in
`tools/dataset/plans/ticket-16-universe.json`), the plan is generated from the rule
(`node tools/dataset/cli.ts plan`), and this ticket crawls the difference, re-derives the
identity registries for the strings the new games name, and rebuilds both layers.

## Measured, before any of it

One Cargo query (`Region='International'`, 232 rows, no pagination needed) gives **235
candidates** once the older, narrower `Tournaments` payloads are included. The committed
rule decides:

| Decision | Count |
|---|---|
| `admitted:*` (Worlds 16, MSI 11, Rift Rivals 14, IEM World Championship 6, Esports World Cup 3, First Stand 2, Mid-Season Cup 1, WCG 2, IPL 1) | 56 |
| `fallback:league-not-admitted` | 87 |
| `exclusion:stage-subpage` | 27 |
| `exclusion:qualifier` | 16 |
| `year:year-unknown` | 16 |
| `exclusion:iem-regional-stop` | 14 |
| `exclusion:all-star` | 9 |
| `exclusion:national-team` | 7 |
| `year:before-declared-era`, `region:region-unknown`, `region:region-not-international` | 1 each |

The corpus carries 10 of the 56 admitted events. **46 editions are missing**, including
every Worlds except 2023 (`Worlds Season 1` and `Season 2`/`3` are how the source names
2011–2013), every MSI except 2023, 13 of the 14 Rift Rivals, five of six IEM World
Championships, two of three Esports World Cups, and First Stand 2026. The source also
records **Worlds 2026, MSI 2026 and Esports World Cup 2026**, which the repository's own
description claims to cover.

Two source facts the crawl already exposes: `Worlds 2011` is `Worlds Season 1` on the wiki,
so a name-prefix rule would miss it; and two Rift Rivals rows carry a stale `League`
(`Rift Rivals 2018` has `Rift Rivals 2017 LCK-LPL-LMS`), which the league-prefix rule admits
anyway — a reason to match on patterns, not names.

## Acceptance criteria

- [x] Every candidate the committed cache carries has exactly one decision row in
      `event-selection.jsonl` — the report is complete over the universe, not over a
      hand-picked subset.
- [x] Every admitted event appears in `event-games.jsonl`, and its `games` count equals the
      rows `games.jsonl` carries for it. An event the source has no scoreboard for is
      `empty`/`recorded` with zero games, named as evidence, never silently absent.
- [x] The crawl plan is generated (`node tools/dataset/cli.ts plan`), and the queries the
      crawl ran are the queries in the committed plan.
- [x] The identity registries resolve every team, player and champion the new games name; a
      string no registry carries is reported in `identity-unresolved.jsonl`, not dropped.
- [x] Both layers rebuild byte-identically, the invariant gate passes, and the coverage
      reports (per event and per era) reconcile with the new games.
- [x] The documentation states the new counts, every event is named in
      `licenses/NOTICE.md` with its committed counts, and the era/coverage table in the
      guide is current.
- [x] The suite fails if the universe and the decisions disagree again (a gate, not prose).

## Validation

`node tools/check.ts`, `build --raw … --check`, `model --check`, `dictionary --check`, and the
new gates over the universe/decision reconciliation.

## Decisions made while building

### The candidate universe is a committed payload, and the plan is generated

`tools/dataset/plans/ticket-16-universe.json` is one query: `Tournaments` where
`Region='International'`, ordered by `OverviewPage`, limit 500. It returned 232 rows, so it
is complete without pagination; a future universe larger than the limit would have to page,
and a `plan` run would then silently see the first page only — worth stating because the
failure mode is the same class of bug this ticket exists to fix.

`tools/dataset/plan.ts` turns the rule's decisions into the four per-event queries the crawl
runs, with the field lists the earlier plans used **verbatim**: the cache key is the whole
query, so a changed field list would refetch all 56 events and orphan the committed
payloads. A test compares the generated queries for the six events in
`ticket-10-events.json` against that committed plan, so the constants cannot drift from what
was actually fetched.

`like '<overviewPage>%'` rather than equality stays: the source records a stage page beneath
the event's own page, and the crawl collects a stage's games under its parent.

### Cost, measured rather than guessed

224 event queries, of which **190 are not cached** (the 34 cached ones are the eight events
whose field lists already match). At the fetch layer's default 75 s ± 15 s spacing that is
roughly **four and a quarter hours** of wall-clock, in resumable sittings; the identity
pass afterwards adds a further batch. This is the honest price of 46 more events, and it is
why the earlier tickets crawled in batches.

### What is still hand-made: the identity registries

The event crawl is rule-derived now; the registry crawl is not. Ticket 10 fetched `Teams`,
`TeamRedirects` and `PlayerRedirects` filtered to the names its games used, which means a
new event needs a new identity pass. This ticket regenerates that pass from the strings the
new rows name. Fetching the registries wholesale would remove the dependency entirely, at
the cost of several pages of redirects no game uses; that is a later decision, recorded
here rather than taken quietly.

## What the crawl and the rebuild changed, beyond the data

The full corpus did not just add rows; it exposed six things the ten-event sample could not,
and each is now a declared, checked rule rather than a special case (the changelog entry
carries the measurements):

- `rules/game-formats.json` gained `contradictedDrafts`: a champion banned and picked by the
  same side (twice) or picked by both sides in a game that is not blind pick (once). The build
  still refuses an undeclared contradiction, and a declaration that stops matching is a
  failure, not silence.
- The rename graph is read as **components**, because the source merges as well as renames
  (`AXIZ Academy` + `Crest Gaming Act Academy` → `AXIZ CREST Academy`); a chain model either
  refused that or kept whichever payload was read last.
- A rename edge into a page no registry carries is skipped and **counted** (10 of them), and
  a `TeamRedirects` row naming a page the club registry lacks is counted too (166) — so a
  truncated registry, which looks the same from here, cannot pass for a source gap unnoticed.
- An **ambiguous** string (a handle three players used) mints one provisional entity and
  reports its candidates, instead of failing the build on which payloads happen to be cached.
- `TeamRedirects`/`PlayerRedirects` are read **whole**, in range partitions: a single response
  is capped at 5 000 rows, and offset paging over a non-unique order loses rows at page
  boundaries — measured, it dropped the `Teams` page a rename chain needed.
- A champion stated as `0` in an era where it did not exist (2022 MSI, the withdrawn Chemtech
  Drake) is the wiki's zero-fill: dropped, not emitted as a claim that the drake could be
  taken. A non-zero value still stops the build.

Two of the six are behaviour the tests already covered for small corpora and the full crawl
contradicted; the rest are new cases. The payloads are stored gzipped (ticket 17) because
3 091 games of pretty-printed JSON were 95 MB, which is what made this change affordable to
commit at all.
