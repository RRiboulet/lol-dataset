# 13: Build the model over the full committed dataset

**Blocked by:** 10, 12
**Status:** done

## What to build

The dimensional model built over every event in the curated dataset, committed
alongside it, with conformance checks that make a hand-edit or a half-built model
impossible to land: row counts reconcile with the curated layer, every foreign key
resolves, every grain is unique, and the coverage declarations survive into the model
rather than being averaged away.

## Scope

The full model build, its committed output, conformance tests against the curated
dataset, and the load path — the committed CSVs plus their DDL (Open assumption 6).
Leaves the analyst-facing documentation and worked examples to ticket 11, which now
documents both layers.

## Acceptance criteria

- [x] Every curated game appears in all three facts exactly as many times as the
      facts' grains require — no more, no fewer.
- [x] Every foreign key in every fact resolves to a dimension row; the unknown member
      is used wherever the curated data has no value, not left as a null join key.
- [x] Grain uniqueness holds at dataset scale, not just for fixtures.
- [x] A game in a thin era is as visible in the model as one in a rich era — nothing
      is dropped because a measure is absent.
- [x] The model rebuilds byte-identically from the same curated dataset, and the
      rebuild is part of the build rather than a manual step.
- [x] Loading the model into a SQL engine reproduces the curated dataset's counts for
      games, sides, player rows and draft slots.

## Validation

Conformance suite over the committed model plus the rebuild check. Covers spec R13,
R8 and R10 at the model layer.

## Decisions made while building

### The model over the full layer is the same build, at scale

Nothing in the schema changed for this ticket: `node tools/dataset/cli.ts model`
already derived the model from whatever `data/curated/` held, so building over the
full crawl was a measurement rather than a rewrite. The committed layer is now
**377 games, 230 series, 3 770 player rows and 7 144 draft entries**, with 10 events,
68 teams, 291 players, 149 champions, 7 patch strings, 68 game dates and 647 alias rows
— each file carrying its unknown member at key 0. The reconciliation the suite asserts
is the same per-game and per-event statement ticket 12 proved on four events, now over
eight: `fact_game_side` = 754 rows (two per game), `fact_player_game` = 3 770,
`fact_draft_slot` = 7 144, `bridge_alias` = 647.

### Coverage rolls up out of the model, and that is asserted rather than assumed

The gap ticket 12 left open was that `event-coverage.jsonl` and `era-coverage.jsonl`
were only ever reconciled against `games.jsonl`, never against the layer an analyst
queries. `rollupCoverage` (`tools/dataset/model.ts`) re-derives both grains from the
model alone — `dim_game` carries the era and the three markers, and a game's event comes
from its side fact rows, since `dim_game` deliberately carries no event key (ticket 12,
A7) and every modelled game has exactly two side rows the gate proves agree on the event.

Two constraints are stated in the code rather than papered over:

- an era's `from` is the era table's declaration, not a game fact, so the rollup does not
  have it and the suite compares "everything a game states" (`Omit<EraCoverageRecord, "from">`);
- a declared era with **no** games has no row to roll up (three of the eight: `herald`,
  `hextech-chemtech`, `chemtech-withdrawn`). The suite asserts those are exactly the
  report rows the rollup lacks and that the rollup's era set is otherwise identical, so
  an era cannot go quietly missing while it still has games. 91 + 46 + 186 + 19 + 35 = 377
  games across the five eras that hold any.

The rollup is a suite assertion, not a third build-gate rule, on purpose: `buildModel`
already proves each marker reaches `dim_game` unchanged, and the invariant gate already
re-counts the reports from `games.jsonl`, so a build-time rollup would re-check facts two
other gates hold. What was actually unproven is the **model-side** claim — a reader who
has only `data/model/` reproduces the curated report — and that belongs in the suite,
where it runs against the committed CSV bytes (`committedTables()`), not the in-memory
build. The state-derivation rule (`complete` only when every game is, `unavailable` when
the set is empty) is shared with `coverage.ts` through the extracted `summariseGroup`, so
the two layers cannot drift in how they read a set of markers.

Red-before: pointing the rollup's `teamStats` group at the draft column made the new test
fail; a marker outside the three states (`banana`) is refused by name rather than counted.

### "Part of the build", and why `build` does not write `data/model/`

The rebuild is a build stage: `node tools/dataset/cli.ts model` derives the layer from
`data/curated/` with no manual step, `model --check` fails on any drift (including a file
the build no longer emits), and `tools/dataset/test/model.test.ts` rebuilds in-process and
compares every byte of `data/model/`. It is deliberately **not** folded into
`node tools/dataset/cli.ts build`: that command writes one output tree, its `--raw`/`--out`
pair names that tree, and its `--check` compares exactly what it would write. Emitting a
second tree from the same command would make `build --out <tmp>` try to write the model
too, and would bury a model failure behind a curated build that succeeded (spec D5 keeps
the model stage's module off the build path).

### The dataframe half of the load criterion: proved through an independent reader

The SQL half is executed at full scale: the committed CSVs plus `schema.sql` load into an
in-memory SQLite database with no preprocessing, `PRAGMA foreign_key_check` is clean, no
fact→dimension inner join loses a row, and — new in this ticket — per-event `GROUP BY`
counts in SQL equal the curated per-event counts for games, player rows and draft entries,
so a row that reached the right table with the wrong event cannot pass.

pandas, polars and pyarrow are still not installed, and adding one would be the
repository's first data dependency for a test (ticket 12's constraint, kept). The
criterion is instead proved through a reader this repository did not write: Python's
stdlib `csv` module, doing its own header handling, field splitting and quote unescaping.
The suite writes a probe, has it read all twelve CSVs, and requires the same header, row
count, absent-cell count, integer-cell count and SHA-256 over every field as the build's
own parser recovers — with every non-empty integer round-tripping through `int()` and
`str()` unchanged. What that establishes is the claim the criterion makes: the exported
bytes need no quoting repair, no header fix and no type-fixing step. What it does **not**
establish is that `pandas.read_csv` specifically was run; that remains unexecuted here,
and the probe is skipped (loudly) on a machine without `python3`.
