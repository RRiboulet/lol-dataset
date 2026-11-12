# 09: A real crawl of two events, end to end

**Blocked by:** 03, 04, 05, 06, 08
**Status:** ready

## What to build

The first live run: fetch two events for real — one from the early era and one from
the ordered-draft era — then build and validate them with the real fetcher, the
real cache and the real gate. This is where the pipeline meets the source.

It is also the ticket that replaces an assumption with a measurement. The spec
accepts era-aware completeness; this run reports what the early era **actually**
holds (which field groups are present, which are thin, whether a scoreboard exists
for the earliest games) and corrects the spec if the era boundary sits elsewhere.

## Scope

No new entities. Live fetching, cache hygiene under real throttling, the first
committed slice of real data, a written coverage finding, and **the attribution
notice that must accompany that first committed data** — the source is a
share-alike wiki, so data never lands in a commit without its attribution.
Leaves the full event list to ticket 10.

## Acceptance criteria

- [ ] Both events are fetched through the real fetcher without a run-ending rate
      limit failure.
- [ ] The build over that cache validates clean.
- [ ] The early-era event's emitted coverage matches the measurement: field groups
      absent in the source are absent and marked, not invented.
- [ ] The ordered-draft era yields ordered drafts; the early era yields unordered
      ones, as the fidelity marker claims.
- [ ] A written report of what each event contains, with the queries used.
- [ ] Any divergence from the spec's era assumption is recorded in the spec, not
      silently absorbed.
- [ ] The attribution the licence requires is present in the same change that
      commits the first real data; no data lands unattributed.
- [ ] Killing the crawl mid-run and re-running completes it without duplicate
      fetches.

## Validation

The real build's own validator run, plus the written measurement. Covers spec R6 and
R11, the licence/attribution constraint, and resolves Open assumption 1 of the spec.
