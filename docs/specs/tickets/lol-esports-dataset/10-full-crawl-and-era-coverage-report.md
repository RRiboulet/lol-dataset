# 10: The full crawl, and a coverage report per era

**Blocked by:** 07, 09, 14
**Status:** done

## What to build

The whole agreed event list, crawled in resumable batches, assembled, validated, and
committed together with a dataset-level coverage report: for each era and each
event, which field groups are complete, partial or unavailable, with totals that
reconcile against the per-game markers.

This is the ticket that turns the pipeline into **the dataset**. It is long-running
by nature — rate-limited, resumable, several sittings — which is why every mechanism
it relies on was proved on two events first.

## Scope

The crawl plan over the committed event list, the committed dataset, and the
generated coverage report. The attribution notice already exists from ticket 01 and
is extended here only if the crawl reaches an event that notice does not yet cover.
The dimensional model is ticket 12's design and ticket 13's build; documentation is
ticket 11's.

## Acceptance criteria

- [x] Every event selected by the rule is present with at least one game, or its
      absence is recorded as an explicit exclusion with a reason. Eight of the ten carry
      games, and a ninth carries series but no games; **World Cyber Games 2011** is
      `empty` — four game-bearing queries and a `Tournament LIKE '%Cyber Games%'` probe
      all returned zero rows, and the reason is recorded in `event-games.jsonl` and in the
      measurement document. **World Cyber Games 2013** is `recorded` with zero games and
      48 series: the source carries the series table and no scoreboard, which is a
      different fact from "nobody asked".
- [x] The dataset validates clean end to end: 377 games, 230 series, 3 770 player rows,
      the schema gate, the provenance gate and the invariant gate all pass on the
      committed bytes.
- [x] The coverage report's totals reconcile with the per-game coverage markers — no
      event is reported complete whose games are partial. `event-coverage.jsonl` and
      `era-coverage.jsonl` are generated from the markers, and the invariant gate
      re-counts them from `games.jsonl` (see `coverage.test.ts`).
- [x] The crawl resumes across interruptions; re-running issues no duplicate fetches and
      produces byte-identical output. The cache key is the query, so a re-run of any plan
      above skips every payload it already holds; the second half of the crawl ran over
      the first half's cache and issued only its own requests.
- [x] The manifest pins the payload hashes the committed dataset came from: 79 payloads
      under `tools/dataset/fixtures/raw/`, 14 entity files under one digest.
- [x] A person can point at any game in the dataset and reach the source payload it came
      from using only committed files plus the manifest: the game carries `source.gameId`
      and `source.matchId`, and the manifest names each payload's relative path, query and
      body hash.
- [ ] The committed curated files load directly into a dataframe library, a SQL engine
      and a spreadsheet-grade tool with no preprocessing step, and the file list is
      discoverable rather than guessed (spec R12). **Partly met and left open**: JSONL
      loads directly into pandas and DuckDB, and the file list is discoverable through
      `manifest.json`; a spreadsheet-grade tool needs its import step for JSONL, which is
      what the CSV model layer (spec D10, tickets 12/13) exists to provide. R12 is
      therefore pointed at those tickets rather than claimed here.

## Validation

The invariant gate over the committed dataset, plus a reconciliation check between
the coverage report and the markers. Covers spec R2 through R10 on real data, and
R1's rule at full scale.
