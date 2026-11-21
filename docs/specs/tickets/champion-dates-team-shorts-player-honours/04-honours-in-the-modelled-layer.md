# 04: The model carries player honours at one row per distinction

**Blocked by:** 03
**Status:** ready

## What to build

`data/model/fact_player_honour.csv`: one row per curated honour, keyed by `player_key`
and `event_key` (both required), with `team_key` **0** — the unknown member — when the
source's team string did not resolve to a team the dataset carries. The distinction
itself rides on the row as the degenerate attribute it is: title, award type, the page it
was stated on, and place/place number where the source states them.

No `dim_honour`: the title vocabulary is free text with no controlled values, so a
distinct-string dimension would be a table nobody joins to for a reason (spec D6). No
measure either — `mvp_count`, `honours_per_player` or any pre-aggregation is the
analyst's to compute, not the fact's to store.

The table joins the generated DDL, the model data dictionary, the model's table order and
its conformance checks: the fact's row count must equal the curated honour count, its
grain must be unique, every foreign key must resolve (with key `0` legal for the team),
and the coverage rollup over `data/model/` must still reproduce the committed
`event-coverage.jsonl` and `era-coverage.jsonl` — honours are enrichment and must not move
a coverage number.

## Scope

- The model's fact builder, dimension-key lookups, `MODEL_TABLE_ORDER`, the generated
  `schema.sql` and the generated model dictionary.
- The conformance checks that count facts and assert grain uniqueness and key resolution.
- The load-path proof (SQLite plus the independent RFC 4180 reader) over the wider model.
- `docs/dataset/using-the-dataset.md`: the table, its grain and its keys.

Leaves for later: the 54-event crawl that fills the file with real awards (05). The
worked-query documentation belongs there, where the data exists.

## Acceptance criteria

- [ ] `fact_player_honour.csv` has exactly one row per curated honour; a curated honour
      missing from the fact, or a fact with no curated row, fails the model gate.
- [ ] `player_key` and `event_key` always resolve; `team_key` is `0` exactly when the
      curated row carries no team id, and `0` is the documented unknown member.
- [ ] The row carries title, award type, source page and place as attributes, and no
      derived measure.
- [ ] Grain uniqueness is enforced and checked: (player, event, title, source page) — or
      whatever the curated id anchors — cannot repeat.
- [ ] The coverage rollup still reproduces the committed per-event and per-era reports
      byte for byte.
- [ ] `schema.sql`, the model dictionary and `MODEL_TABLE_ORDER` are regenerated
      together; `model --check` is clean; the SQLite and RFC 4180 load paths still pass.
- [ ] The invariant that every emitted player is reachable from a fact does not fire for
      a player whose only evidence is an honour (03 widened the curated gate; the model
      must agree).

## Validation

The model conformance suite over `data/curated/` plus the load-path test, both offline.
Covers spec B11 and B13, and decisions D6 and D7.

Note for landing: fourth in the linear chain 01 → 02 → 03 → 04 → 05; 05 rebuilds the
model from a larger corpus on top of this ticket, so the two do not land side by side.
