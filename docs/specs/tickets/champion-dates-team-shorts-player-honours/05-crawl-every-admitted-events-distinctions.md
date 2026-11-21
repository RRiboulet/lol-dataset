# 05: Every admitted event's distinctions are in the committed dataset

**Blocked by:** 04
**Status:** done

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
- `AGENTS.md`'s current-state paragraph and `CHANGELOG.md`'s unreleased section, so the
  repository's description of what the build emits matches the data it carries — including
  the team short names and champion release dates the earlier tickets in this series moved
  without describing there.
- The attribution check: `data/ATTRIBUTION.md` and `licenses/NOTICE.md` must cover the
  new payloads before they land.

Leaves for later: nothing in this feature. A later spec would carry per-era team short
names or career awards across regional leagues, and neither is in scope here.

## Acceptance criteria

- [ ] Every one of the 54 admitted events has been queried for distinctions; **the report
      saying which events stated none is not delivered** — see the Outcome. The events are
      queried, but the per-event count lives only in the guide's MVP table, not in a
      committed report file.
- [x] A re-run of the crawl issues zero requests for already-cached queries — the cache
      key, not a row counter, decides what is missing.
- [x] The games, series and player counts are unchanged by this change; only honours,
      the players an honour is the sole evidence for, and the re-pinned manifest move.
- [x] The committed dataset answers "who was MVP at Worlds 2014?" and "who was finals MVP
      at Worlds 2024?" from the files alone, and says nothing for a year the source has no
      row for.
- [x] Every new payload is pinned in the manifest with its query and fetch time, and the
      tamper report names the files it feeds.
- [x] `build --check` and `model --check` are clean; both dictionaries are regenerated;
      `node tools/check.ts` is green with no network.
- [x] Attribution covers the new payloads.

## Validation

The committed-data gate (S2) over the grown corpus, the crawl's own summary, and the
determinism check (a second build from the same cache is byte-identical). Covers spec B8,
B9, B12 and B13 over the whole corpus, and settles the row-count expectations the spec
left unmeasured.

Note for landing: last in the linear chain 01 → 02 → 03 → 04 → 05. This ticket
regenerates every data file and the model, which is why it closes the chain rather than
running beside it.

## Outcome

- **The crawl ran to completion in one process**: 53 requests of ~65 minutes; 215 of the
  plan's 216 game queries and two already-recorded distinctions queries were skipped
  (`no request`). The one game query that was **not** cached is a known one: Esports World
  Cup 2026's `ScoreboardPlayers` pull, which `plans/ticket-16-ewc-2026-players.json` records
  as lossy (ordered by a non-unique `GameId`, so paging lost 320 of 2 320 rows). The plan
  still generates that query, so the crawl fetched it again and its 2 000-row prefix is now
  pinned. Harmless here — those rows are a subset of the `UniqueLine`-ordered payloads, so
  `player-games.jsonl` did not move and the model's short-row check would have failed loudly
  — but the plan should be given the `UniqueLine` ordering, which is a change to every
  event's cache key and therefore its own ticket.
- **24 distinctions in the committed dataset**, from 19 events: nine Worlds editions
  (Season 1, 2014, 2017, 2021–2026), **seven** MSI editions (2015, 2016, **2022**, 2023–2026),
  three Esports World Cups and MSI 2016's five All-Pro places — 9 + 7 + 3 + 5 = 24, and
  `fact_player_honour` carries the same 24 rows.
- **The gaps are the source's and the guide says so**: no MVP row exists for Worlds
  2012/2013/2015/2016/2018–2020, and MSI has none from 2017 to 2021. The worked
  question in `using-the-dataset.md` lists all 15 MVP rows and names the missing editions,
  so an empty answer is never mistaken for a dataset failure.
- **Title coverage measured**: `Finals MVP` (11), `Most Valuable Player` (5), `All Pro Team`
  (5), `MVP` (1), `MSI MVP` (1), `Tournament MVP` (1) — five spellings for "MVP", left as
  the source words them.
- **One row carries no team**: the Esports World Cup 2025 tournament MVP states a string the
  registry resolves to nothing, so it is emitted with the string and `team_key` 0 — the
  unknown member doing the job it exists for.
- Gates: `build --check` and `model --check` clean, both dictionaries regenerated,
  `AGENTS.md`'s current state and the CHANGELOG updated, attribution already covers the
  table (ticket 03).

## Not delivered

The ticket's "What to build" asked for a report naming, per event, how many distinctions the
source states — including the 35 events that state none. It was not built: the counts exist in
the guide's MVP table and in the crawl's own output, not in a committed file. That gap is what
let a wrong "six MSI editions" survive until review (MSI 2022's Wei was missing from the
table). A per-event honours report, alongside `event-games.jsonl`'s `state`, is the honest
follow-up; it is not in this series.
