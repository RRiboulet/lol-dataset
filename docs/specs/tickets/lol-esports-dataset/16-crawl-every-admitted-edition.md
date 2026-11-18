# 16: The event set is computed, not hand-listed

**Blocked by:** 10 (done), 14, 15
**Status:** in progress

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

- [ ] Every candidate the committed cache carries has exactly one decision row in
      `event-selection.jsonl` — the report is complete over the universe, not over a
      hand-picked subset.
- [ ] Every admitted event appears in `event-games.jsonl`, and its `games` count equals the
      rows `games.jsonl` carries for it. An event the source has no scoreboard for is
      `empty`/`recorded` with zero games, named as evidence, never silently absent.
- [ ] The crawl plan is generated (`node tools/dataset/cli.ts plan`), and the queries the
      crawl ran are the queries in the committed plan.
- [ ] The identity registries resolve every team, player and champion the new games name; a
      string no registry carries is reported in `identity-unresolved.jsonl`, not dropped.
- [ ] Both layers rebuild byte-identically, the invariant gate passes, and the coverage
      reports (per event and per era) reconcile with the new games.
- [ ] The documentation states the new counts, every event is named in
      `licenses/NOTICE.md` with its committed counts, and the era/coverage table in the
      guide is current.
- [ ] The suite fails if the universe and the decisions disagree again (a gate, not prose).

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
