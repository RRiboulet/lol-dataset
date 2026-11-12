# 12: The dimensional model, proved on fixtures

**Blocked by:** 05
**Status:** ready

## What to build

The star schema that the analyst will actually query, built from the curated records
and proved on fixtures long before the full crawl exists.

Conformed dimensions — event, match, team, player, champion, patch — and three facts
at declared grains: one row per game per side (team statistics), one row per game per
player (player statistics), one row per draft slot (ordered and unordered alike).
Joins use integer surrogate keys; every dimension carries its natural key and display
name, so a fact table can still be read by eye. An explicit unknown member stands in
for "not recorded", so an inner join does not silently drop games from a thin era.
Renames resolve through an alias bridge with validity dates rather than a duplicated
dimension row per alias.

Facts hold measures only. No rates, no averages, no pre-aggregations: the analyst
does the summing, and a model that pre-computes it answers fewer questions.

## Scope

The model's design, its DDL, its per-dimension and per-fact data dictionary, and the
build step from curated fixtures into `data/model/`. Emission format is open
assumption 6 in the spec — resolve it before writing the emitter, not after.

Leaves for later tickets: building the model over the full committed dataset, and the
analyst-facing documentation.

## Acceptance criteria

- [ ] Each fact has a declared grain and a uniqueness test that fails if two rows
      share one grain key.
- [ ] Fact row counts reconcile with the curated layer per event: every game, every
      side, every draft slot accounted for, none invented.
- [ ] No inner join between a fact and any dimension loses a row: an era with a
      missing value joins to the unknown member instead of vanishing.
- [ ] A rename in the fixtures produces one dimension row plus two alias rows with
      dates, and both old and new source strings resolve to that one row.
- [ ] Every dimension row carries its natural key and display name; every fact row is
      readable next to its dimensions without decoding a key.
- [ ] Facts contain no derived measure — no rate, ratio, average or percentage —
      enforced by a test that fails on an added column matching that shape.
- [ ] The DDL loads into a SQL engine and the model loads into a dataframe library,
      both with no preprocessing step.
- [ ] The data dictionary covers every dimension and fact, including which measures
      can be absent and what the unknown member means.

## Validation

Build seam over fixtures, plus the uniqueness, reconciliation, orphan and
no-derived-measure tests. Covers spec R13 and D10, and delivers R12's analysis
surface early enough to be argued with.
