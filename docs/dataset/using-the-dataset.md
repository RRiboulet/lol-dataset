# Using the League of Legends esports dataset

This dataset is an archive of international League of Legends esports — the League of
Legends World Championship from 2011 onward and the international events around it
(MSI, IEM, IPL, Rift Rivals, the Mid-Season Cup, the Esports World Cup, WCG, First Stand).
It carries **54 events, 3 091 games, 2 068 series and 30 910 player rows** — every edition
the committed selection rule admits.
Regional leagues, national competitions, All-Star and showmatches are deliberately out
of scope; the rule that decides is committed, and every rejection is recorded with its
reason.

Everything here is derived from **Leaguepedia | League of Legends Esports Wiki**
(<https://lol.fandom.com>), which is CC BY-SA 3.0. See
[Licence and attribution](#licence-and-attribution) before publishing anything built on
it.

There are two layers, and they answer different questions:

| Layer | Where | What it is | Reach for it when |
|---|---|---|---|
| Curated | `data/curated/*.jsonl` | One JSON record per line, the source of truth, with the build's reports and its provenance manifest beside it | You need a value's provenance, the source's own strings, an event the rule rejected, or a report about what the corpus does **not** hold |
| Modelled | `data/model/*.csv` + `schema.sql` | A star schema derived from the curated layer: eight dimensions, three facts, one alias bridge | You want to answer a question — join, filter, count, aggregate. This is the analysis surface |

Neither layer is a copy of the wiki's tables: values are normalised into canonical
entities and typed fields, and every record that carries a canonical id carries the
display name beside it so it reads without a join.

## The curated layer

One file per record type, one record per line, in the order the build emits them. The
field-by-field dictionary is
[`curated-data-dictionary.md`](curated-data-dictionary.md) — generated from the JSON
schemas that guard each file (`data/curated/schema/`), so it cannot claim a field the
data does not have — and the row counts are in its "At a glance" table.

| File | Grain | Holds |
|---|---|---|
| `events.jsonl` | one admitted event | The canonical event: name, source page, league, region, start date |
| `event-selection.jsonl` | one considered event | Included **and rejected** events, each with the rule and reason that decided |
| `event-games.jsonl` | one event | How many games and series the corpus carries for it, and whether the source answered at all |
| `event-coverage.jsonl` | one event | How many of the event's games are complete, partial or unavailable in each field group |
| `era-coverage.jsonl` | one declared era | The same counts per era, including eras no game has reached |
| `games.jsonl` | one game | Both sides, the team statistics the source records, the draft, the winner, the coverage markers, the source's own ids |
| `matches.jsonl` | one series (match) | Both sides with their series score, the declared length, the round label, the source id |
| `series-conflicts.jsonl` | one conflicted game **or** series | Games detached from a series that names other teams, and series every game of which contradicts them |
| `player-games.jsonl` | one player in one game | Champion, role, side, and the statistics the source states |
| `teams.jsonl`, `players.jsonl`, `champions.jsonl` | one canonical entity | Canonical id, display name, page, plus a team's short name (`Karmine Corp` → `KC`) and a champion's release date (`2011-12-14`) |
| `honours.jsonl` | one player's distinction at one event | The title as the source words it (`Finals MVP`, `All Pro Team`), the award type, the player, the event, and the team string with the entity it resolves to |
| `aliases.jsonl` | one source string and entity | Every spelling, handle and page that resolves to a canonical entity, with the window the corpus dates |
| `identity-unresolved.jsonl` | one unresolved source string | Strings that mint a provisional entity because no registry row answers |
| `manifest.json` | the dataset | Every payload the build read (path, query, fetch time, sha256) and a digest of every emitted file |

Two conventions matter more than the field list:

- **An absent key means the source did not state the value.** It is never `null` and
  never `0`; a recorded zero is `0`. A 2012 game has no `gold` key on a player row
  because the wiki has no such column for it, and a game with no draft has no `draft`
  key at all rather than five empty lists.
- **Canonical ids are opaque and stable.** `evt-`, `mt-`, `gm-`, `pg-`, `hn-`, `tm-`, `pl-` and
  `ch-` plus 12 hex characters, derived from the source's own identifiers, so a rebuild
  cannot renumber them. The source's string survives beside it (`sourceTeam`,
  `sourcePlayer`, `sourceChampion`, `source.gameId`, `source.matchId`).

### Identity and aliases

A team that renamed, a player who changed handle and a champion Riot renamed each stay
**one** canonical entity. The strings that referred to it accumulate in `aliases.jsonl`
with the dates the corpus saw them, which is why `T1` and `SK Telecom T1` are two alias
rows pointing at one `tm-…` id rather than two teams. Four consequences worth knowing:

- Team and player pages are wiki pages, so the same org spelled two ways in one table is
  a data problem, not two entities. IPL 5's `MatchSchedule` is the measured case: one
  team's name appears two ways, and a legacy alias declaration resolves the second.
- `identity-unresolved.jsonl` (two rows today: `Eliade` and `Insta`, both IPL 5
  players) means a string had no registry row. The entity is real, its id is provisional,
  and the row says why. Treat those ids as usable, not certain.
- The alias bridge in the model carries the same rows, so a join on a wiki page name
  should resolve through `bridge_alias`, never by matching a display name by hand.
- A team's **short name** is a label, not an identity. `KC` is how the source's registry
  abbreviates `Karmine Corp`, and it reads well in a table, but it is not unique:
  measured, `ESC`, `GMB`, `IM` and `RED` each denote two teams in this corpus. Use
  `short` (in `teams.jsonl`, and on `dim_team`) to display a team, never to look one up
  or to group by — that is what `team_id`, the page, or the alias bridge are for. It
  comes from the team's **current** page, so a rebrand does not carry an older
  abbreviation forward (`T1` never reads `SKT`), and a team the registries do not carry
  has none at all.

### Distinctions: who was MVP, and where

`honours.jsonl` carries the tournament distinctions the source states for a player — a
Worlds or MSI finals MVP, an All-Pro team place, Best Coach — for the **tournament**, never
for a regional season (ticket 03; the event rule is the boundary). Its grain is one row per
player per event per title — the same award stated on an event's page and on its
`/Main Event` page is one row, with the page it was stated on kept as provenance — and it joins to `events.jsonl` by `eventId` and to
`players.jsonl` by `playerId`; `team` keeps the source's own string, and `teamId` appears
only when the alias registry resolves it (`SKT T1` → `T1`), because an award is context
rather than evidence that a team existed.

Two things the file deliberately does **not** do. It does not normalise titles: `MVP`,
`Most Valuable Player` and `MSI MVP` are three strings for one idea, and deciding they are
the same is the analyst's judgement. And it does not claim completeness: the source states
a Worlds MVP for some editions and not others (2012, 2013, 2015, 2016 and 2018–2020 have
no row), so "no honour" means "the source states none", not "nobody won".

### Events, selection and series that disagree

`event-selection.jsonl` is not a log: it is the complete decision table for every event
the crawl considered, `included` or `rejected`, with the rule (`region`,
`exclusion`, `year`, `stage-subpage`, `admitted`, …) and the reason in prose. A reader
who wants to know why LCK is not here can answer it from the committed data.

`event-games.jsonl` distinguishes three things a game count alone cannot: an event whose
game queries answered and carried games (`recorded`), one whose queries answered with no
games at all (`recorded` with `games: 0` — World Cyber Games 2013, 48 series and no
scoreboard), and one where every game-bearing query returned zero rows (`empty` — World
Cyber Games 2011).

`series-conflicts.jsonl` records the one place the source contradicts itself: eight IPL 5
games whose `MatchSchedule` row names two other teams. Those games are emitted **without**
a `matchId` — the game is real, the link is refused — and six series rows that every game
naming them contradicts are not emitted at all. Both are counted in the file, so "no
series" on a game means one of three things you can tell apart: the source carried none,
the source carried one that names other teams, or the series was contradicted.

### Provenance: from a value to the bytes it came from

`manifest.json` pins every payload the build read: its path under the cache root, the
query that produced it, its fetch time, and the sha256 of its body. The committed pins
resolve under `tools/dataset/fixtures/raw/`, so a reader can walk from a game's
`source.gameId` to the payload that carried it without leaving the repository:

```bash
# 1. which cached payload carries this game?
payload=$(grep -rl 'IGN ProLeague Season 5_Group D_5' \
  tools/dataset/fixtures/raw/lol-fandom/cargoexport/ScoreboardGames --include='*.json' | head -1)
# 2. its pin in the manifest (paths are relative to the cache root)
jq -r --arg file "${payload#tools/dataset/fixtures/raw/}" \
  '.payloads[] | select(.file == $file) | [.query.tables, .bodySha256, .fetchedAt] | @tsv' \
  data/curated/manifest.json
# ScoreboardGames  477d274e…  2026-11-17T10:24:35.316Z
```

That is the whole provenance chain: the game's `source.gameId` finds the payload, the
payload's `bodySha256` is pinned in the manifest, and the build refuses a payload whose
body no longer hashes to it.

The manifest also carries one digest over the emitted entity files, so a tampered or
half-merged dataset is detectable without rebuilding. The build verifies each payload
against its sidecar hash before using it, and `build --check` re-derives everything and
compares.

## Coverage, eras and what the data cannot answer

Every game carries three coverage markers — `teamStats`, `draft`, `playerStats` — each
`complete`, `partial` or `unavailable`, judged **against the fields that existed when the
game was played**. That last part is the era table
(`tools/dataset/rules/game-eras.json`). A 2015 game is not "missing" Voidgrubs, because
Voidgrubs did not exist until 2024; a 2015 game *is* marked partial because the wiki did
not record its inhibitors. Without the era table those two absences are indistinguishable
and every historical row is equally "partial", which catches nothing.

Eight eras are declared, six have games:

| Era | From | Games | Team stats | Draft | Player stats |
|---|---|---|---|---|---|
| `pre-herald` | 2011-01-01 | 495 | partial | partial | partial |
| `herald` | 2015-11-11 | 0 | — | — | — |
| `elemental-drakes` | 2016-01-14 | 1 325 | partial | partial | partial |
| `hextech-chemtech` | 2021-11-17 | 0 | — | — | — |
| `chemtech-withdrawn` | 2022-01-25 | 204 | complete | complete | complete |
| `chemtech-restored` | 2022-11-16 | 186 | complete | partial | complete |
| `voidgrubs` | 2024-01-10 | 203 | partial | partial | complete |
| `atakhan` | 2025-01-09 | 678 | partial | partial | complete |

The declared-but-empty eras are real rows on purpose: an absent era row would be
indistinguishable from "nobody looked", the same distinction `event-games.jsonl` makes
for events.

What the coverage markers mean in practice, and what the data cannot answer:

- **Team statistics before 2015** are kills, gold, towers, inhibitors, barons and a plain
  dragon count — not a reduced version of the modern field set. Of 3 091 games, 1 749 are
  `partial` and 279 are `unavailable` (Worlds 2011-2013, IEM 2012-2013 and IPL 5 state no
  team statistics at all); a measure the source never recorded is an absent CSV field/JSON
  key, never `0`. The modern eras are partial too: 106 of the 2024-2026 games lack a team
  statistic the wiki did not fill in, which is what the marker is for.
- **Draft order before 2017 does not exist** in the source. 641 games carry an `unordered`
  draft: their picks and bans are complete as *sets*, with `entry_index` preserving a
  stable order and `slot` deliberately empty, because an absent pick-ban order is not
  something to invent. Draft *coverage* is still `complete` where both sides have five
  picks and five bans.
- **Three games had no pick-ban phase.** The 2020 Mid-Season Cup's best-of-five game 1s
  were blind pick, declared in `tools/dataset/rules/game-formats.json`: the same champion
  may stand on both sides and there are no bans. They are marked `draft.blindPick: true`.
- **Per-minute data does not exist here at all** — no timelines, no item timings, no
  skill order. Riot's ACS endpoints that hold fuller per-player payloads need a
  session cookie, which the fetch layer is forbidden to store.
- **Some player measures are era-limited**: 1 750 player rows have no `gold` and 11 300 no
  `vision`, nearly all in the pre-2017 events where the wiki does not record them.
- **43 identities are provisional** and flagged in `identity-unresolved.jsonl`: 38 player
  strings the registry cannot answer for, four team strings (league names the wiki used as
  team names, and the 2026 MSI showmatch squads), and one genuinely ambiguous handle
  (`Lee`, which three players have used). A count of "distinct players" over those rows
  inherits that uncertainty; the report names every candidate.
- **Eight IPL 5 games carry no series**, because the source's series rows contradict the
  games. Their `matchId` is absent, not empty-string, and `series-conflicts.jsonl`
  explains each one.

A question that needs a value which is absent for the era cannot be answered from this
dataset. The right answer is to filter on the coverage marker and say so, not to treat
the absent value as zero — which is precisely what the markers are for.

## The modelled layer

The model is a star schema over the curated layer, rebuilt from it in one command. The
field-by-field dictionary, the unknown-member rule and every measure's absence rule are
in [`data/model/data-dictionary.md`](../../data/model/data-dictionary.md); this section is
the map.

| Table | Kind | Grain | Key |
|---|---|---|---|
| `dim_event` | dimension | one event | `event_key`, natural `event_id` |
| `dim_match` | dimension | one series | `match_key`, natural `match_id` |
| `dim_game` | dimension | one game, with its era and coverage markers | `game_key`, natural `game_id` |
| `dim_team` | dimension | one canonical team | `team_key`, natural `team_id` |
| `dim_player` | dimension | one canonical player | `player_key`, natural `player_id` |
| `dim_champion` | dimension | one canonical champion | `champion_key`, natural `champion_id` |
| `dim_patch` | dimension | one patch string the source states | `patch_key`, natural `patch` |
| `dim_date` | dimension | one UTC calendar date | `date_key`, natural `date` |
| `bridge_alias` | bridge | one `(kind, alias_string, entity_key)` | `alias_key` |
| `fact_game_side` | fact | one game per side | `(game_key, side)` |
| `fact_player_game` | fact | one game per player | `(game_key, player_key)` |
| `fact_draft_slot` | fact | one pick or ban | `(game_key, side, phase, entry_index)` |
| `fact_player_honour` | fact | one player's distinction at one event | `(player_key, event_key, title)` |

Four rules make the model safe to join:

- **Every dimension has an unknown member at key `0`** (empty natural key, display name
  `Unknown`). A fact joins to it when the curated record has no value; a foreign key is
  never empty, so an inner join never silently drops a row from a thin era. Today only
  `match_key` and `patch_key` can reach it.
- **Surrogate keys are build-local**: `1..N` in natural-key order within a build. They
  can move when the dataset grows, so anything you store outside the model should use the
  natural key (the canonical id, the ISO date, the patch string). This is why every
  dimension carries its natural key and display name.
- **Facts carry measures only.** No rate, ratio, average or percentage is pre-computed;
  you do the aggregating, and the build refuses a column whose name looks like a derived
  measure.
- **Facts carry the conformed dimension keys directly** (`event_key`, `match_key`,
  `date_key`, `patch_key`) beside their grain keys, so "per event", "per date" and "per
  patch" need no hop through `dim_game`. The conformance suite checks every key against
  the dimension it names, and that a game's event agrees across all three facts.

A distinction is a fact with no measure: `fact_player_honour` carries the keys (player, event,
and the team when the source's string resolves — `0` when it does not) and the title, so
"count the MVPs" is a `GROUP BY` you write, not a column somebody pre-computed. It is also
the one fact with no `game_key`, which is why the per-game cross-checks skip it.

One date deliberately does **not** join `dim_date`: `dim_champion.release_date` is a dated
attribute of the champion (2009 for the oldest champion in the corpus, 2026 for the
newest). `dim_date` is the calendar of the games the facts describe, and a champion's
release is not one of them — filling it with release dates would add calendar rows no fact
can reach. Read it as a date, join the facts by `champion_key`.

## One game, from the curated record to the fact rows

The two layers, on one real game — Worlds 2023, KT Rolster vs Weibo Gaming on 2023-10-22.
The curated row is what the source states:

```bash
jq -c 'select(.id == "gm-fa39b8216e1f") | {id, eventId, matchId, dateTimeUtc, patch, winnerTeamName,
  sides: [.sides[] | {side, teamName, kills, gold, towers}], coverage, draftFidelity: .draft.fidelity}' \
  data/curated/games.jsonl
```

```json
{"id":"gm-fa39b8216e1f","eventId":"evt-ae98c0ad8d75","matchId":"mt-ea83f49cc1b2",
 "dateTimeUtc":"2023-10-22T10:06:00Z","patch":"13.19","winnerTeamName":"KT Rolster",
 "sides":[{"side":"blue","teamName":"KT Rolster","kills":23,"gold":76480,"towers":9},
          {"side":"red","teamName":"Weibo Gaming","kills":11,"gold":61919,"towers":0}],
 "coverage":{"teamStats":"complete","draft":"complete","playerStats":"complete"},
 "draftFidelity":"ordered"}
```

Ten `player-games.jsonl` rows name `gameId: "gm-fa39b8216e1f"` (five a side), and the
game's draft is 10 picks and 10 bans with slots from the source. In the model the same
game is one `game_key` (3 033 in this build):

```sql
SELECT s.side, t.team_name, s.is_winner, s.kills, s.gold, s.match_key, s.patch_key
FROM fact_game_side AS s
JOIN dim_game AS g ON g.game_key = s.game_key
JOIN dim_team AS t ON t.team_key = s.team_key
WHERE g.game_id = 'gm-fa39b8216e1f';
```

| side | team_name | is_winner | kills | gold | match_key | patch_key |
|---|---|---|---|---|---|---|
| blue | KT Rolster | 1 | 23 | 76480 | 211 | 2 |
| red | Weibo Gaming | 0 | 11 | 61919 | 211 | 2 |

Plus ten `fact_player_game` rows and twenty `fact_draft_slot` rows for the same
`game_key`. The measures are the same values; what the model adds is the keys
(`211` → one series, `2` → patch `13.19`, and the team and player dimensions), so the
same numbers can be sliced without re-reading the nested JSON. Keys are build-local:
`211` is this build's `dim_match` key, `mt-ea83f49cc1b2` is the durable one.

## Worked questions

Load the committed CSVs into an in-memory SQLite once, then run the queries below. This
uses `node:sqlite` and the repository's own CSV parser, so it needs no dependency beyond
the checkout:

```bash
cat > /tmp/model.mjs <<'EOF'
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

const root = process.cwd();
const { parseCsv } = await import(path.join(root, "tools/dataset/model.ts"));
const dir = path.join(root, "data", "model");
const db = new DatabaseSync(":memory:");
db.exec(await readFile(path.join(dir, "schema.sql"), "utf8"));
for (const table of ["dim_event", "dim_match", "dim_game", "dim_team", "dim_player", "dim_champion",
                     "dim_patch", "dim_date", "bridge_alias", "fact_game_side", "fact_player_game", "fact_draft_slot"]) {
  const [header, ...rows] = parseCsv(await readFile(path.join(dir, `${table}.csv`), "utf8"));
  const insert = db.prepare(`INSERT INTO ${table} (${header.join(", ")}) VALUES (${header.map(() => "?").join(", ")})`);
  for (const row of rows) insert.run(...row);
}
for (const sql of process.argv.slice(2)) console.table(db.prepare(sql).all());
EOF
node /tmp/model.mjs "SELECT COUNT(*) AS games FROM dim_game WHERE game_key <> 0"
```

`pandas` and DuckDB read the same files directly — `pd.read_csv("data/model/fact_player_game.csv")`,
`duckdb.sql("SELECT * FROM read_csv_auto('data/model/fact_game_side.csv')")` — with an
empty CSV field becoming a null/NaN, which is exactly what it means. The curated JSONL
loads with `pd.read_json("data/curated/games.jsonl", lines=True)`.

### 1. Who won a team's games at an event?

```sql
SELECT g.game_name, s.side, s.is_winner, s.kills, s.gold
FROM fact_game_side AS s
JOIN dim_game AS g ON g.game_key = s.game_key
JOIN dim_team AS t ON t.team_key = s.team_key
WHERE t.team_name = 'T1' AND g.game_name LIKE 'Worlds 2023%'
ORDER BY g.date_time_utc;
```

Returns 15 rows — T1's games at Worlds 2023, `is_winner` 1 or 0 — the first being
`Worlds 2023 — T1 vs Team Liquid — 2023-10-19`, blue side, won, 15 kills, 67 196 gold.
Note what the query reads: the game's readable label comes from the dimension, the
result and the team statistics from the fact, and nothing needed a join to the curated
layer.

### 2. What did a player pick, game by game, at an event?

```sql
SELECT g.date_time_utc, g.game_name, c.champion_name, f.role
FROM fact_player_game AS f
JOIN dim_player AS p ON p.player_key = f.player_key
JOIN dim_game AS g ON g.game_key = f.game_key
JOIN dim_champion AS c ON c.champion_key = f.champion_key
JOIN dim_event AS e ON e.event_key = f.event_key
WHERE p.player_name = 'Faker' AND e.event_name = 'Worlds 2023'
ORDER BY g.date_time_utc;
```

Returns Faker's 15 games at Worlds 2023 with champion and role: Orianna, Sylas, Azir,
Ahri and Akali, all `Mid`. The champion is a canonical id resolved to its current name,
so a champion Riot renamed still appears under one row here and its old spelling in
`bridge_alias`.

### 3. How complete is each era — and can I compare them?

```sql
SELECT era, COUNT(*) AS games,
       SUM(team_stats_coverage = 'complete') AS team_complete,
       SUM(draft_coverage = 'complete')       AS draft_complete,
       SUM(player_stats_coverage = 'complete') AS player_complete
FROM dim_game WHERE game_key <> 0 GROUP BY era ORDER BY MIN(date_time_utc);
```

Returns the six eras with games: `pre-herald` 495 / 0 / 0 / 0, `elemental-drakes`
1 325 / 316 / 1 172 / 316, `chemtech-withdrawn` 204 / 204 / 204 / 204, `chemtech-restored`
186 / 186 / 185 / 186, `voidgrubs` 203 / 125 / 201 / 203, `atakhan` 678 / 232 / 676 / 678.
**This is the era caveat**: a modern-era row and a pre-2015 row are not comparable on team
statistics or player statistics, because the source never carried those fields for the
early era — and even the modern eras are only partly complete, so the denominators are the
marker counts, not the game counts. Filter on the marker; do not average across the
boundary and present it as a trend.

### 4. Which games have no series, and why?

```sql
SELECT g.game_name FROM dim_game AS g
WHERE g.game_key <> 0
  AND NOT EXISTS (SELECT 1 FROM fact_game_side AS s WHERE s.game_key = g.game_key AND s.match_key <> 0)
ORDER BY g.game_name;
```

Returns the eight IPL 5 games whose series row names other teams — the same reason
appears in `data/curated/series-conflicts.jsonl`, whose rows name both the game's teams
and the series' teams. `match_key = 0` alone does not tell you which of the three cases
applies (no series in the source, a contradicted series, or a series that names other
teams); join to the curated conflict report when the difference matters.

## Rebuilding

The commands below need no network, and are run from the repository root:

```bash
node tools/dataset/cli.ts build --raw tools/dataset/fixtures/raw   # data/curated/
node tools/dataset/cli.ts model                                    # data/model/
node tools/dataset/cli.ts dictionary                               # the curated data dictionary
node tools/check.ts                                                # the whole suite
```

`--check` turns any of them into a verification instead of a write:
`build --raw … --check`, `model --check` and `dictionary --check` compare the committed
bytes with a rebuild and name the first difference. A full clean rebuild also needs the
crawl cache, which is *not* committed:

- `raw/` is the crawl cache and is gitignored. It is filled by
  `node tools/dataset/cli.ts fetch --plan tools/dataset/plans/ticket-16-events.json --raw raw`
  — the plans the crawls used are committed under `tools/dataset/plans/`, so a reader can
  repeat one. A checkout without a cache can still rebuild everything committed here: the
  285 recorded payloads the build read are committed under `tools/dataset/fixtures/raw/`
  (gzipped; 6 MB) and pinned by `data/curated/manifest.json`, which is why
  `build --raw tools/dataset/fixtures/raw` reproduces the dataset byte for byte.
- A **fresh** crawl is the expensive path, and the documentation should not pretend
  otherwise. `tools/dataset/fetch.ts` spaces requests 75 s apart with ±15 s of jitter by
  default, skips anything already cached (the cache key is the query), and resumes from
  where it stopped rather than restarting; a rate-limit response backs off and doubles the
  delay. The 285 payloads behind this dataset are therefore roughly six and a half hours of
  wall-clock at the default spacing, in resumable sittings — not a quick command, and
  deliberately not part of the test suite.
- Nothing in the pipeline needs a credential: no token, cookie or session is stored, and
  the ACS endpoints that would need one are not part of the crawl.

## Licence and attribution

The data is derived from **Leaguepedia | League of Legends Esports Wiki**
(<https://lol.fandom.com>), licensed **CC BY-SA 3.0**
(<https://www.fandom.com/licensing>). The wiki states that licence itself in its
`siteinfo`; the notice records that it was read there rather than assumed.

If you publish anything built on this dataset, the licence requires you to:

- **credit** Leaguepedia and link the licence, in a place a reader of your output can see;
- **indicate what you changed** — this dataset is already a transformation (normalised,
  canonicalised, reconciled), not a copy of the wiki's tables;
- **share derivative work alike** under CC BY-SA 3.0 (or a compatible licence). A chart,
  table or model output that embeds this data is derivative work.

The full attribution, including every event with its committed counts and the Cargo
tables that were read, is in [`licenses/NOTICE.md`](../../licenses/NOTICE.md) and, where the
data lives, in [`data/ATTRIBUTION.md`](../../data/ATTRIBUTION.md). The notice grows with the
data: an event whose games are committed is named there in the same change that commits
them.

Attribution came first, deliberately. It was added in commit `827d63f` (2026-11-12,
*"attribute the source wiki before any of its content is committed"*), before the first
recorded payload or curated row landed, because recorded payloads are source content too.
Riot's own material — Data Dragon champion data, the LoL Esports API — is not covered by
that licence and is not part of this dataset.

## What was never modelled

The model is a recording of what the source states, not an analysis of it. Nothing here
pre-computes:

- **aggregates**: no win rates, standings, career totals, leaderboards or summary tables.
  They are one `GROUP BY` away in your own query, and a pre-computed one answers fewer
  questions.
- **ratings**: no Elo, power rankings or any model output.
- **per-minute or per-item detail**: no timelines, gold graphs, skill order or item
  purchase times; the source payloads this dataset reads do not carry them.
- **rosters over time, contracts, biographies**: a player-games row is a player in a game,
  not a career.
- **regional or national competition**: international events only, by design.
- **a query interface**: this is data and a build, not a service. The model loads into
  SQLite, DuckDB, pandas or a spreadsheet in one step, which is the interface.

If you are looking for one of those layers, it does not exist here — and it is not
missing by accident.
