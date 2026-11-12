# 10: The full crawl, and a coverage report per era

**Blocked by:** 07, 09
**Status:** ready

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

- [ ] Every event selected by the rule is present with at least one game, or its
      absence is recorded as an explicit exclusion with a reason.
- [ ] The dataset validates clean end to end.
- [ ] The coverage report's totals reconcile with the per-game coverage markers — no
      event is reported complete whose games are partial.
- [ ] The crawl resumes across interruptions; re-running issues no duplicate
      fetches and produces byte-identical output.
- [ ] The manifest pins the payload hashes the committed dataset came from.
- [ ] A person can point at any game in the dataset and reach the source payload it
      came from using only committed files plus the manifest.
- [ ] The committed curated files load directly into a dataframe library, a SQL engine
      and a spreadsheet-grade tool with no preprocessing step, and the file list is
      discoverable rather than guessed (spec R12).

## Validation

The invariant gate over the committed dataset, plus a reconciliation check between
the coverage report and the markers. Covers spec R2 through R10 on real data, and
R1's rule at full scale.
