# Attribution and licence for this data

Everything under `data/` — the curated JSONL records and the CSVs derived from them — is
derived from **Leaguepedia | League of Legends Esports Wiki**, <https://lol.fandom.com>,
which is licensed **CC BY-SA 3.0**, <https://www.fandom.com/licensing>.

The same holds for the source payloads the dataset was built from: they are committed
under `tools/dataset/fixtures/raw/` and pinned by `data/curated/manifest.json`, and they
are the wiki's own response bodies, not this project's work.

This file exists so that the attribution travels with the data. The complete notice —
every event with its committed counts, every Cargo table that was read, and the licence
reasoning — is in [`licenses/NOTICE.md`](../licenses/NOTICE.md), and the analyst-facing
guide is [`docs/dataset/using-the-dataset.md`](../docs/dataset/using-the-dataset.md).

## What CC BY-SA 3.0 requires of you

If you use, publish or redistribute this data, or anything built from it:

1. **Credit Leaguepedia** as the source and **link the licence**
   (<https://www.fandom.com/licensing>) somewhere a reader of your output can see.
2. **Say what you changed.** This dataset is already a transformation of the wiki's
   tables: values are normalised, entities are canonicalised, statistics are reconciled
   against team totals, and coverage is declared per game. Your own further work is
   another transformation to indicate.
3. **Share derivative work alike** under CC BY-SA 3.0 or a compatible licence. A table,
   chart, report or model output that embeds these values is derivative work; a dataset
   you redistribute must keep this licence.
4. **Impose no additional restrictions** on what the licence grants.

Riot Games' own material (for example Data Dragon champion data, or anything from the LoL
Esports API) is not covered by that licence and is not part of this dataset.

## What was read from the wiki

The committed dataset was built from Cargo queries over these tables — every payload is
a cached response whose URL, query, fetch time and body hash are in
`data/curated/manifest.json`:

| Cargo table | What it supplied |
|---|---|
| `Tournaments` | The event list the selection rule decides on |
| `ScoreboardGames` | One row per game: both sides, team statistics, winner, duration, patch |
| `ScoreboardPlayers` | One row per player per game: champion, role, items, runes, statistics |
| `MatchSchedule` | Series rows: both sides, scores, best-of, round label |
| `PicksAndBansS7` | Ordered picks and bans, with the source's slot numbers |
| `Teams`, `TeamRedirects` | Team identity and renames |
| `PlayerRedirects` | Player identity and old pages |
| `Champions` | Canonical champion names and Riot's numeric ids |

Every event whose games are committed here is named, with its counts, in
`licenses/NOTICE.md`. The patch boundaries behind
`tools/dataset/rules/game-eras.json` are cited per boundary **in that rule file** — six
to wiki patch pages and one to Riot's own announcement of the Chemtech Drake's
disable — and nothing in the table is inferred from this dataset.

## Where this came from in history

Attribution was added **before** any source content: commit `827d63f` on 2026-11-12,
*"docs(licenses): attribute the source wiki before any of its content is committed"*. The
notice has grown with the data since — a new event's name lands in the same change that
commits its games — and this file was added when the dataset's own documentation was
written. Earlier history is therefore not evidence of an unlicensed period; it is the
order the project chose.
