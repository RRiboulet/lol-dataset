# Ticket 09 — crawl measurement: MSI 2023 and IEM Season IX 2015

The first live run: two events fetched through `fetch.ts` into `raw/`, built with the
real pipeline, and validated by the real gate. This is the record of what the source
**actually** holds, which is what the spec's era-aware completeness decision was
waiting to learn.

## What was asked

Both events were queried through `Special:CargoExport` (the endpoint that answers
while `action=cargoquery` is rate-limited), at the fetcher's measured-safe interval of
75 s plus jitter, one request at a time. The plan is committed at
`tools/dataset/plans/ticket-09-two-events.json` and
`tools/dataset/plans/ticket-09-early-era.json`, so the run can be reproduced or resumed.

| Event | Table | `where` | Rows |
|---|---|---|---|
| MSI 2023 | `ScoreboardGames` | `OverviewPage LIKE '2023 Mid-Season Invitational%'` | 76 |
| MSI 2023 | `ScoreboardPlayers` | same | 760 |
| MSI 2023 | `MatchSchedule` | same | 25 |
| MSI 2023 | `PicksAndBansS7` | `GameId LIKE '2023 Mid-Season Invitational%'` | 76 |
| IEM IX 2015 | `ScoreboardGames` | `OverviewPage LIKE 'IEM Season IX - World Championship%'` | 19 |
| IEM IX 2015 | `ScoreboardPlayers` | same | 190 |
| IEM IX 2015 | `MatchSchedule` | same | 13 |
| IEM IX 2015 | `PicksAndBansS7` | `GameId LIKE 'IEM Season IX - World Championship%'` | 0 |

Seventeen requests in total (the two above, a probe, and the earliest-era queries
below), **zero `ratelimited` responses**, and no run-ending failure.

## What each event contains

**MSI 2023 (ordered-draft era, `chemtech-restored`)** — 76 games, 760 player rows,
25 series. Every game states every era-eligible team statistic, all R4 player fields
(damage, vision, keystone and runes included), and an **ordered** draft with source
slot numbers. 75 of 76 games are complete across all three field groups; the
exception is `…_Bracket Round 1_4_3`, whose `Team2Ban4` is the literal string `None` —
the source's placeholder for an unused ban slot. It is emitted as an **absent** slot,
so that game's draft coverage is honestly `partial` rather than a fabricated pick. The
placeholder sits in **both** draft paths — the numbered `PicksAndBansS7` field and the
`ScoreboardGames` ban list — and both filter it: handling only the numbered one minted
a champion entity called `None` and let the unordered fallback emit it.

**IEM Season IX 2015 (pre-herald era)** — already recorded for tickets 03–05 and
re-fetched here through the real fetcher. The re-fetched **rows** are identical to the
committed ones; the **bytes** are not, because a different `fields=` order changes the
body and therefore its hash. The committed cache keeps the original recording, and of
the four re-fetched payloads only the zero-row `PicksAndBansS7` one is committed, as the
evidence for the "no ordered draft in this era" claim below. 19 games, 190 player rows,
13 series.
The source states kills, deaths, assists, CS and gold, plus a partial team-stat row
(no inhibitors, three bans a side), but **no damage, vision, keystone or runes** on any
player. Drafts are **unordered**: `PicksAndBansS7` has no row for this era, so the
draft comes from `ScoreboardGames`' list fields, which are in role order and are
emitted as id-sorted sets. Coverage is `partial` for all three groups, which is the
truth about the era rather than a defect in the build.

## The earliest era has no scoreboard at all

`WCG 2011` (2011-12-08) was queried as the earliest admitted event: all four
game-bearing tables returned **zero rows**. A follow-up probe over every World Cyber
Games event (`Tournament LIKE '%Cyber Games%'`) also returned **zero**, so the absence
is the source's, not the page name's.

This **resolves the spec's Open assumption 1**: the dataset's 2011 floor is real, but
for the earliest events it can only be represented as *"the source has no games here"*,
not as thin games. `event-games.jsonl` now reports WCG 2011 as `empty` — a recorded
query that named the event and came back with nothing — which is exactly the
distinction that file exists for. The 2011 floor stays, and no era boundary moves:
the earliest *games* the source still carries are 2012's IPL 5, not 2011's.

## Divergences found, and what was done

- **`None` as a draft placeholder.** MSI 2023's `Team2Ban4` is `None`, and the same
  list field carries it (`Team2Bans` ends with `None`). Filtered in both paths, so no
  entity is minted and the game's draft coverage is honestly `partial`.
- **IPL 5's series rows disagree with its games.** Crawling IPL 5 (2012) — the earliest
  event that *does* carry games — produced 72 games, 720 player rows and 48 series.
  Those four payloads are committed under `tools/dataset/fixtures/pending/`, which the
  build does not read, so the figures below stay checkable while the event stays out of
  the dataset; ticket 14 decides what to do with them. The crawl found
  but the game↔series team check refused 11 pairings: some are a legacy team name
  (`Counter Logic Gaming` on the game, `CLG Prime` on the series), others are apparent
  cross-match mixups in the source's own `MatchSchedule`. **IPL 5 is not committed
  here**; it is filed as ticket 14 so the full crawl (ticket 10) handles it with a
  decision rather than by accident.
- **Cargo field order is not data.** Re-fetching IEM 2015 with the same columns in a
  different order produced byte-identical rows that `dedupe` reported as a stale
  conflict. Fixed: row comparison is now key-order independent.

## Resumability

The crawl was run in two sittings (WCG 2011 + MSI 2023, then IEM 2015 + the earliest-era
probe) and a third plan resumed without re-requesting anything already cached: the cache
key is derived from the query, so a re-run sends requests only for missing payloads.
