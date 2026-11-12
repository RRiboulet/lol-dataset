# 13: Build the model over the full committed dataset

**Blocked by:** 10, 12
**Status:** ready

## What to build

The dimensional model built over every event in the curated dataset, committed
alongside it, with conformance checks that make a hand-edit or a half-built model
impossible to land: row counts reconcile with the curated layer, every foreign key
resolves, every grain is unique, and the coverage declarations survive into the model
rather than being averaged away.

## Scope

The full model build, its committed output, conformance tests against the curated
dataset, and the load path — DDL plus whatever the agreed emission format needs.
Leaves the analyst-facing documentation and worked examples to ticket 11, which now
documents both layers.

## Acceptance criteria

- [ ] Every curated game appears in all three facts exactly as many times as the
      facts' grains require — no more, no fewer.
- [ ] Every foreign key in every fact resolves to a dimension row; the unknown member
      is used wherever the curated data has no value, not left as a null join key.
- [ ] Grain uniqueness holds at dataset scale, not just for fixtures.
- [ ] A game in a thin era is as visible in the model as one in a rich era — nothing
      is dropped because a measure is absent.
- [ ] The model rebuilds byte-identically from the same curated dataset, and the
      rebuild is part of the build rather than a manual step.
- [ ] Loading the model into a SQL engine reproduces the curated dataset's counts for
      games, sides, player rows and draft slots.

## Validation

Conformance suite over the committed model plus the rebuild check. Covers spec R13,
R8 and R10 at the model layer.
