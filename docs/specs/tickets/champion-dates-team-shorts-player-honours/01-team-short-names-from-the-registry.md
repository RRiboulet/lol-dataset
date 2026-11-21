# 01: Every team row reads with its source short name

**Blocked by:** None (can start immediately)
**Status:** done

## What to build

`data/curated/teams.jsonl` gains a `short` field: the abbreviation the source's team
registry states for that team, so the row reads `Karmine Corp` / `KC` without a lookup.
Measured on the live registry, **all 193** curated teams that still resolve to a page
state one; the other 4 curated teams are minted from strings no registry carries
(`Team Baron (MSI 2026)`, `Team Dragon (MSI 2026)`, `LoL Championship Series`,
`LoL EMEA Championship`) and so have no short to state.

The short is a **label, not an identity**: measured, `ESC`, `GMB`, `IM` and `RED` each
denote two different teams in this corpus. Both keep it, and nothing in the build, the
model or the documentation may join, deduplicate or look up by it.

The fetch is part of this ticket. The committed `Teams` payloads were recorded with
`_pageName,Name,OverviewPage,Region,RenamedTo`, and the field list is part of the cache
key, so `Short` means re-recording those two pages (5 582 rows) and deleting the old
files. Identity reads the same payloads for `RenamedTo`: the re-record keeps every field
already asked for, or the rename chain loses evidence.

## Scope

- `teams.jsonl`, its schema and the regenerated curated dictionary.
- The `Teams` re-record: two payloads and their sidecars replaced, manifest re-pinned,
  the crawl plans that name this query updated so a re-run hits the cache instead of
  re-fetching.
- The model's `dim_team` gains the column, with the generated DDL and model dictionary.
- `docs/dataset/using-the-dataset.md`: the column, and one sentence that a short name is
  never a key.

Leaves for later: champion release dates (02) and honours (03–05). No new table, no new
normalizer, no change to how a team's identity is derived.

## Acceptance criteria

- [x] Every team that resolves to a registry page carries a non-empty `short`; the 4
      minted teams omit the key rather than carrying `""`.
- [x] `Karmine Corp` reads `KC`, and both teams sharing each of `ESC`, `GMB`, `IM` and
      `RED` keep the shared value — the build does not treat the collision as an error.
- [x] The re-recorded payloads carry `Short` **and** still carry `_pageName`, `Name`,
      `OverviewPage`, `Region`, `RenamedTo`; no other table's payload bytes change.
- [x] Team output is otherwise unchanged: same canonical ids, same aliases, same
      unresolved report, same row count. A new column must not move an identity.
- [x] The model writes the source's value, and empty (a loadable absent value) for a
      team that has none — no `NULL`, no `0`.
- [x] `build --check` and `model --check` are clean, a second build is byte-identical,
      and the test suite needs no network.
- [x] Both dictionaries are regenerated in the same change, so the gate that compares
      them does not fail.

## Validation

The build seam over the committed payloads (`tools/dataset/test/`), the identity suite
(a re-recorded registry must not renumber a team), and the invariant/model gate over the
committed data. Covers spec B4, B5 and B13.

Landing order: this is the first ticket of the linear chain 01 → 02 → 03 → 04 → 05.
Each ticket regenerates `data/curated/manifest.json` and `data/model/`, so they land one
at a time rather than in parallel; the edge on 02 is an ordering decision, not a code
dependency.

## Outcome

- **The re-record was two requests, and every row states a short.** 2 000 rows
  (`limit 2000`) and 3 582 rows (`limit 5000`), both with
  `_pageName,Name,OverviewPage,Region,RenamedTo,Short`; the old two payloads were deleted
  rather than kept, so no stale row without the field survives in the cache. Measured
  afterwards: **no row in the registry has an empty short**, so an absent `short` in the
  dataset always means "this team was minted", never "the source declined".
- **The targeted `Teams` payloads were left as fetched.** They exist to close rename
  chains, and the normalizer already had the rule this needed: an empty value is an
  absence and a stated value wins, so the value travels from whichever payload states it
  (tested, including the two-different-shorts contradiction). Re-recording ten closure
  queries for a field they do not need would have cost ten requests and changed nothing.
- **Nothing else in the dataset moved.** 197 teams, 3 791 alias rows and 43 unresolved
  strings before and after; the identity suite's byte-identity test and the committed
  files agree. 193 team rows gained `short`; the 4 minted teams (`Team Baron (MSI 2026)`,
  `Team Dragon (MSI 2026)`, `LoL Championship Series`, `LoL EMEA Championship`) omit it.
- **No committed plan names the registry-wide pull**, so there was no plan file to edit —
  the previous pulls were recorded the same way. The sidecar carries the exact query a
  re-run needs (it is part of the cache key), and the manifest pins both new payloads with
  their query and fetch time.
