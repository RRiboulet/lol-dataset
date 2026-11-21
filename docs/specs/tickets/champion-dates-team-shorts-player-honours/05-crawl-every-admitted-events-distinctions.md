# 05: Every admitted event's distinctions are in the committed dataset

**Blocked by:** 04
**Status:** ready

## What to build

The fifth per-event query is run for all 54 admitted events, and the committed dataset
carries the tournament distinctions the source states for them: Worlds and MSI MVPs,
All-Pro teams, Best Coach — the awards of the events the rule admits, and nothing from a
regional season. The crawl is the slow part and is expected to be: 54 Cargo requests at
the measured 75s interval is roughly 70 minutes, and the payloads are committed so the
gate never needs the network again.

The ticket reports the measured result in its own body when it is done — rows per event,
which events state no award at all, and how the count splits between player awards and
team-context rows — because "the dataset now has honours" is not a number anyone can
check.

The written dataset documentation gains the question this exists to answer, answered from
the committed data: **who was MVP at each Worlds, and at each MSI** — including the honest
answer for the years the source states none. Two of the spec's open assumptions become
visible there: the source's MVP coverage is partial (no Worlds MVP row for 2012, 2013,
2015, 2016, 2018, 2019 or 2020), and coaches appear as players with no game row.

## Scope

- A committed plan for the honours crawl and its recorded payloads (gzipped, with
  sidecars), the manifest re-pinned to them.
- `data/curated/honours.jsonl` and `data/curated/players.jsonl` filled from the crawl,
  plus the regenerated curated dictionary — and, if 04 is merged, the regenerated model.
- The worked question in `docs/dataset/using-the-dataset.md`, and the file's row count in
  the "at a glance" table.
- `AGENTS.md`'s current-state paragraph and `CHANGELOG.md`'s unreleased section, as every
  data-changing ticket before this one did.
- The attribution check: `data/ATTRIBUTION.md` and `licenses/NOTICE.md` must cover the
  new payloads before they land.

Leaves for later: nothing in this feature. A later spec would carry per-era team short
names or career awards across regional leagues, and neither is in scope here.

## Acceptance criteria

- [ ] Every one of the 54 admitted events has been queried for distinctions; the report
      says which events stated none.
- [ ] A re-run of the crawl issues zero requests for already-cached queries — the cache
      key, not a row counter, decides what is missing.
- [ ] The games, series and player counts are unchanged by this change; only honours,
      the players an honour is the sole evidence for, and the re-pinned manifest move.
- [ ] The committed dataset answers "who was MVP at Worlds 2014?" and "who was finals MVP
      at Worlds 2024?" from the files alone, and says nothing for a year the source has no
      row for.
- [ ] Every new payload is pinned in the manifest with its query and fetch time, and the
      tamper report names the files it feeds.
- [ ] `build --check` and `model --check` are clean; both dictionaries are regenerated;
      `node tools/check.ts` is green with no network.
- [ ] Attribution covers the new payloads.

## Validation

The committed-data gate (S2) over the grown corpus, the crawl's own summary, and the
determinism check (a second build from the same cache is byte-identical). Covers spec B8,
B9, B12 and B13 over the whole corpus, and settles the row-count expectations the spec
left unmeasured.

Note for landing: last in the linear chain 01 → 02 → 03 → 04 → 05. This ticket
regenerates every data file and the model, which is why it closes the chain rather than
running beside it.
