# The curated layer — data dictionary

Generated from `data/curated/schema/*.schema.json` and the committed records by
`node tools/dataset/cli.ts dictionary`. **Do not edit by hand**: the dataset suite
regenerates this file and fails when the committed bytes differ, so a schema change
that forgets the dictionary fails the gate rather than leaving a stale table behind.

## How to read this

- One file per section, below, in the order the build emits them (`OUTPUTS` in
  `tools/dataset/build.ts`), with `manifest.json` last.
- **Records** is the row count of the committed file today. It moves when the corpus
  grows; the schema does not.
- **Required `no` means the field can be absent**, and an absent key means the source
  did not state the value. Absence is never `null` and never `0`: a recorded zero is
  `0`, and the two are different answers. The column has three states, because two
  would lie: **always** (the key is in every record), **when present** (the field is
  required inside its object, but an object above it is optional, so a record can still
  lack it by lacking the parent), and **no** (optional within its own object).
- Every schema forbids unknown fields (`additionalProperties: false`), so a field not
  listed in a file's table is a defect, not an extension point.
- Canonical ids are `evt-`, `mt-`, `gm-`, `pg-`, `tm-`, `pl-` and `ch-` followed by 12
  hex characters, derived from the source's own identifiers so a rebuild cannot
  renumber them (spec D3). Every reference carries the display name beside the id, so
  a record reads without a join. The exact pattern for each id column is in its schema.
- Dates are `YYYY-MM-DD`, instants are `YYYY-MM-DDTHH:MM:SSZ` in UTC, files are UTF-8
  with LF line endings, and one JSON object is one line.
- `manifest.json` is a single JSON document rather than a stream of records; its
  section describes the document's shape.

## At a glance

| File | Records | Schema | What it holds |
|---|---|---|---|
| `events.jsonl` | 54 row(s) | `event.schema.json` | Curated event |
| `event-selection.jsonl` | 235 row(s) | `event-selection.schema.json` | Event selection report |
| `event-games.jsonl` | 54 row(s) | `event-games.schema.json` | Per-event game coverage report |
| `event-coverage.jsonl` | 54 row(s) | `event-coverage.schema.json` | Per-event coverage report |
| `era-coverage.jsonl` | 8 row(s) | `era-coverage.schema.json` | Per-era coverage report |
| `games.jsonl` | 3091 row(s) | `game.schema.json` | Curated game |
| `matches.jsonl` | 2068 row(s) | `match.schema.json` | Curated match (series) |
| `series-conflicts.jsonl` | 14 row(s) | `series-conflicts.schema.json` | Series conflict report |
| `player-games.jsonl` | 30910 row(s) | `player-game.schema.json` | Curated player-game |
| `honours.jsonl` | 7 row(s) | `honour.schema.json` | Curated honour |
| `teams.jsonl` | 197 row(s) | `team.schema.json` | Curated team |
| `players.jsonl` | 1140 row(s) | `player.schema.json` | Curated player |
| `champions.jsonl` | 171 row(s) | `champion.schema.json` | Curated champion |
| `aliases.jsonl` | 3791 row(s) | `alias.schema.json` | Curated identity alias |
| `identity-unresolved.jsonl` | 43 row(s) | `identity-unresolved.schema.json` | Unresolved identity report |
| `manifest.json` | 1 document | `manifest.schema.json` | Provenance manifest |

## `events.jsonl` — Curated event

One row of data/curated/events.jsonl: a tournament admitted by the committed event-selection rule in tools/dataset/rules/event-selection.json (spec R1). Contains no build timestamp, because the file must be byte-identical across builds (spec R8).

Schema: `data/curated/schema/event.schema.json`. Fields: 10.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | always | Opaque surrogate key derived from overviewPage (spec D3). Do not parse it: read the row through `name` or `overviewPage`. |
| `name` | string | always | The source's own display name, so the row reads without decoding the ID (spec R12). |
| `overviewPage` | string | always | The source page this event was recorded from, and the input to its canonical ID. |
| `league` | string | always | The source's League string, verbatim. Empty when the source records none, which is possible for an event admitted by a per-event override (see the rule file). |
| `region` | string | always | The source's Region string, verbatim. Not constrained to International here: a per-event override may admit an event on a stated reason (see the rule file). |
| `dateStart` | string | always | Source DateStart as a UTC calendar date. Absent if the source has none, which fails the build rather than emitting an undateable event. |
| `year` | integer | always | UTC calendar year of dateStart, repeated so a reader can group without parsing the date. |
| `selection` | object | always | Which clause of tools/dataset/rules/event-selection.json admitted this event. The reason text lives once, in that file, under this key. |
| `selection.rule` | string | always | one of `admitted`, `override` |
| `selection.key` | string | always | — |

## `event-selection.jsonl` — Event selection report

One row of data/curated/event-selection.jsonl: every source event the build considered, and what the committed rule in tools/dataset/rules/event-selection.json did with it. This is what makes a rejection visible rather than absent — the reason itself is not duplicated here, it lives in the rule file under `rule`/`key`.

Schema: `data/curated/schema/event-selection.schema.json`. Fields: 8.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | always | Same canonical ID as events.jsonl, so a rejection and an include cannot disagree about identity. |
| `name` | string | always | — |
| `overviewPage` | string | always | — |
| `league` | string | always | Source League verbatim; empty when the source records none. |
| `region` | string | always | Source Region verbatim; empty when the source records none, which is why unknown-region rejection exists. |
| `decision` | string | always | one of `included`, `rejected` |
| `rule` | string | always | Which clause of the committed rule decided this event, in the order the rule is evaluated. one of `override`, `region`, `year`, `exclusion`, `admitted`, `fallback` |
| `key` | string | always | The entry inside that clause: a league key, an exclusion key, or an override marker. |

## `event-games.jsonl` — Per-event game coverage report

One row of data/curated/event-games.jsonl for every selected event, saying whether the corpus carries rows for it. It keeps 'the source has no games for this event' from looking like 'nobody fetched this event': `recorded` means the corpus emits at least one row for this event, a game or a series; `empty` means no rows are emitted while a recorded query to a **game** table (`ScoreboardGames`, `MatchSchedule`) named this event and the source returned none; and `missing` means no recorded query established that. `empty` is a claim about the recorded queries, not about the outside world: the query text is the evidence to check by hand. `games` and `matches` are counts of emitted rows, so a reader can reconcile them against the files.

Schema: `data/curated/schema/event-games.schema.json`. Fields: 6.

| Field | Type | Required | Notes |
|---|---|---|---|
| `eventId` | string | always | — |
| `eventName` | string | always | — |
| `overviewPage` | string | always | — |
| `state` | string | always | `recorded`: the corpus emits at least one row for this event, a game or a series. `empty`: a recorded query to a **game** table (`ScoreboardGames`, `MatchSchedule`) named this event — its page, a stage page under it, or its display name, as a Cargo literal: `Column=...`, `Column IN (...)`, or an anchored `Column LIKE 'prefix%'` (an exact `LIKE` with no wildcard counts too) — and the source returned no rows; measured on World Cyber Games 2013 and 2011. A `ScoreboardPlayers` query cannot establish this: its rows are players, not games, so an event with only such a query is `missing` (measured on IPL 5 before ticket 14 committed its game payloads, when its player probe returned ten rows and no game query had been recorded). `missing`: no recorded query addressed this event's games. one of `recorded`, `empty`, `missing` |
| `games` | integer | always | How many rows this event contributes to games.jsonl. at least 0 |
| `matches` | integer | always | How many rows this event contributes to matches.jsonl. at least 0 |

## `event-coverage.jsonl` — Per-event coverage report

One row of data/curated/event-coverage.jsonl for every selected event: the aggregation of its games' per-game coverage markers (spec R6) into the three field groups the markers name. `coverage.<group>` counts the event's games by marker, so `complete` is a number of games and not a claim about the event; `state` is the worst case over those games — `complete` only when every game is, `unavailable` when none has anything in the group or the event carries no games at all, `partial` otherwise. The build generates this file from the emitted games, and the invariant gate re-counts it against games.jsonl, so an event can never be reported more complete than its games: that is ticket 10's reconciliation criterion. `eras` lists the era-table windows the event's games fall in, so a game-level report can be joined to the era-level one; it is empty exactly when `games` is 0. `games` reconciles with event-games.jsonl and with the rows of games.jsonl.

Schema: `data/curated/schema/event-coverage.schema.json`. Fields: 21.

| Field | Type | Required | Notes |
|---|---|---|---|
| `eventId` | string | always | — |
| `eventName` | string | always | The event's display name, repeated so the row reads without a join (spec R12). |
| `overviewPage` | string | always | The event's source page, so a reader can find the payload that answered for it. |
| `eras` | array of string | always | The distinct era ids among this event's games, sorted; empty when the event carries no games (an `empty` or `missing` event, per event-games.jsonl). |
| `games` | integer | always | How many rows this event contributes to games.jsonl, which is also the number of games each group's counts sum to. at least 0 |
| `coverage` | object | always | The three field groups a game's coverage marker names, aggregated over this event's games. Keys are the ones games.jsonl uses. |
| `coverage.teamStats` | object | always | — |
| `coverage.teamStats.complete` | integer | always | at least 0 |
| `coverage.teamStats.partial` | integer | always | at least 0 |
| `coverage.teamStats.unavailable` | integer | always | at least 0 |
| `coverage.teamStats.state` | string | always | The group's state over the whole event: `complete` only when every game is, `unavailable` when none carries anything or there are no games, `partial` otherwise. one of `complete`, `partial`, `unavailable` |
| `coverage.draft` | object | always | — |
| `coverage.draft.complete` | integer | always | at least 0 |
| `coverage.draft.partial` | integer | always | at least 0 |
| `coverage.draft.unavailable` | integer | always | at least 0 |
| `coverage.draft.state` | string | always | one of `complete`, `partial`, `unavailable` |
| `coverage.playerStats` | object | always | — |
| `coverage.playerStats.complete` | integer | always | at least 0 |
| `coverage.playerStats.partial` | integer | always | at least 0 |
| `coverage.playerStats.unavailable` | integer | always | at least 0 |
| `coverage.playerStats.state` | string | always | one of `complete`, `partial`, `unavailable` |

## `era-coverage.jsonl` — Per-era coverage report

One row of data/curated/era-coverage.jsonl for every era the era table (tools/dataset/rules/game-eras.json) declares for team statistics, in the table's own order: the same aggregation of per-game coverage markers as event-coverage.jsonl, but keyed by the era the game was played in (spec D4, R6). Every declared era is present, including the ones no game has reached yet — an absent row would be indistinguishable from 'nobody looked', the distinction event-games.jsonl makes for events. Because a game carries exactly one era, the `games` column sums to the number of rows in games.jsonl, and each group's counts sum to `games`; the invariant gate re-counts both. The window boundaries are the table's, never inferred from the corpus; `from` repeats the boundary so a reader can sort and read this file alone.

Schema: `data/curated/schema/era-coverage.schema.json`. Fields: 20.

| Field | Type | Required | Notes |
|---|---|---|---|
| `era` | string | always | The era id, as games.jsonl states it in `era`. |
| `from` | string | always | First UTC date this era governs, copied from the era table. |
| `games` | integer | always | How many emitted games carry this era. Sums across rows to the number of games in games.jsonl. at least 0 |
| `events` | integer | always | How many distinct events contribute at least one game to this era. at least 0 |
| `coverage` | object | always | The three field groups a game's coverage marker names, aggregated over the games in this era. |
| `coverage.teamStats` | object | always | — |
| `coverage.teamStats.complete` | integer | always | at least 0 |
| `coverage.teamStats.partial` | integer | always | at least 0 |
| `coverage.teamStats.unavailable` | integer | always | at least 0 |
| `coverage.teamStats.state` | string | always | `complete` only when every game in the era is, `unavailable` when the era has no games, `partial` otherwise. one of `complete`, `partial`, `unavailable` |
| `coverage.draft` | object | always | — |
| `coverage.draft.complete` | integer | always | at least 0 |
| `coverage.draft.partial` | integer | always | at least 0 |
| `coverage.draft.unavailable` | integer | always | at least 0 |
| `coverage.draft.state` | string | always | one of `complete`, `partial`, `unavailable` |
| `coverage.playerStats` | object | always | — |
| `coverage.playerStats.complete` | integer | always | at least 0 |
| `coverage.playerStats.partial` | integer | always | at least 0 |
| `coverage.playerStats.unavailable` | integer | always | at least 0 |
| `coverage.playerStats.state` | string | always | one of `complete`, `partial`, `unavailable` |

## `games.jsonl` — Curated game

One row of data/curated/games.jsonl: a single game from a selected event, with its two sides and the team statistics the source records (spec R2, R3). The grain is one game. `sides` is always exactly two entries and `winnerTeamId` is always one of them. A statistic the source did not record is an ABSENT KEY, never 0 and never null — a real 0 (a team that took no dragons) is stated as 0. There is no `deaths` field: the source's ScoreboardGames table has no Deaths column for either side (measured with `cargofields`), so a deaths figure could only be derived from the opponent's kills, and executions make that arithmetically false. `coverage.teamStats` is judged against the era table in tools/dataset/rules/game-eras.json, so a field that did not exist when the game was played (void grubs in 2015, elemental drakes in 2013) neither counts as absent nor marks the game partial. Contains no build timestamp (spec R8). `draft`, when present, carries picks and bans with the source's fidelity: numbered slots when `PicksAndBansS7` recorded them, sorted sets otherwise; `coverage.draft` says `unavailable` when the corpus states no draft at all.

Schema: `data/curated/schema/game.schema.json`. Fields: 57.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | always | Opaque surrogate key derived from the source's GameId (spec D3). Do not parse it: the source ids are carried in `source`. |
| `eventId` | string | always | The event this game belongs to. Always present: a game whose page no selected event covers is not emitted at all. |
| `eventName` | string | always | The event's display name, repeated so the row reads without a join (spec R12). |
| `matchId` | string | no | The series this game belongs to, present only when the corpus also carries that match's MatchSchedule row **and that row names the same two teams**. A game whose series row names two other teams is emitted without it, because the source contradicts itself about the link and the game's own data is not in doubt (measured on IPL 5's swapped `MatchId`s, ticket 14). `source.matchId` is the source's own id and is always present. |
| `overviewPage` | string | always | The source page the game row came from. The source splits an event across stage pages (…/Play-In, …/Main Event), which is why a game is attached to its event by page prefix. |
| `dateTimeUtc` | string | always | The game's start instant in UTC, ISO-8601. One fixed representation across every era (spec R8). |
| `patch` | string | no | The patch as the source states it, as text, and absent when the source records none. The source's column is numeric even though `cargofields` reports String, so it cannot distinguish 4.1 from 4.10: this carries the digits the source sent and never pads or infers them. |
| `durationSeconds` | integer | no | Game length in whole seconds, parsed from the source's exact `Gamelength` (`mm:ss`). Absent when the source states none. The source's `Gamelength_Number` is float minutes and is not used, because it cannot round-trip the seconds. at least 0 |
| `era` | string | always | The id of the era in tools/dataset/rules/game-eras.json that governs this game's date, so the record states which era it is in (spec R6). |
| `coverage` | object | always | Per-field-group presence, machine-readable (spec R6). |
| `coverage.teamStats` | string | always | Judged only over the fields eligible in this game's era. `complete` needs every one of them stated for BOTH sides. `unavailable` needs the whole group empty on both sides. Everything else is `partial` — including one side populated and the other blank, which is the half-empty game that must not read as `unavailable`. Ineligible fields are excluded, so 2015 stays `partial` for its missing inhibitors (a source gap) but is not blamed for void grubs (not invented yet). one of `complete`, `partial`, `unavailable` |
| `coverage.draft` | string | always | `complete` needs five picks on both sides and, unless the game is a declared blind pick (`draft.blindPick`), five bans a side too; ordered drafts must also carry their slots. `partial` means some draft data was stated; `unavailable` means the corpus stated no draft, and no `draft` object is emitted. Absence is never written as five empty lists. one of `complete`, `partial`, `unavailable` |
| `coverage.playerStats` | string | always | Presence-based (ticket 04): `complete` means ten player rows — five per side with one played role each — all state every R4 field and reconcile with the game's team totals; `partial` means structure or fields are missing (2015 has no damage, vision, keystone or runes); `unavailable` means the corpus carries no player rows for this game. The game's `era` is still carried separately. one of `complete`, `partial`, `unavailable` |
| `draft` | object | no | The champion draft of this game (spec R5). Picks and bans are canonical champion references beside the source string. `fidelity` is a fact about the source, never inferred from list position or role order. A champion occurs at most once per side, and once across both sides unless `blindPick` is true — the declared case of a game with no pick-ban phase, where both teams may lock the same champion (measured on the 2020 Mid-Season Cup's game 1s). |
| `draft.fidelity` | string | when present | `ordered` entries carry a `slot` number from PicksAndBansS7; `unordered` entries are a set sorted by champion id, with no slot key. one of `ordered`, `unordered` |
| `draft.switchedSides` | boolean | no | The source's SwitchedSides flag, present only on ordered drafts where the source recorded one. |
| `draft.blindPick` | boolean | no | Present and true only for a game declared in tools/dataset/rules/game-formats.json as played without a pick-ban phase. Such a game states five picks a side and no bans, and the same champion may stand on both sides. Declared, never inferred: a game with no bans and no ordered draft row is indistinguishable from an early-era game whose bans the wiki did not record. |
| `draft.sides` | array of object | when present | — |
| `draft.sides[].side` | string | when present | The game's source position (ScoreboardGames Team1 is blue, Team2 red), not a claim about which side the pick/ban table called Team1. When `switchedSides` is true the source says those positions were swapped; this label is deliberately not rewritten. one of `blue`, `red` |
| `draft.sides[].picks` | array of object | when present | — |
| `draft.sides[].picks[].slot` | integer | no | at least 1 |
| `draft.sides[].picks[].championId` | string | when present | — |
| `draft.sides[].picks[].championName` | string | when present | — |
| `draft.sides[].picks[].sourceChampion` | string | when present | — |
| `draft.sides[].bans` | array of object | when present | — |
| `draft.sides[].bans[].slot` | integer | no | at least 1 |
| `draft.sides[].bans[].championId` | string | when present | — |
| `draft.sides[].bans[].championName` | string | when present | — |
| `draft.sides[].bans[].sourceChampion` | string | when present | — |
| `sides` | array of object | always | Exactly two sides. Blue is the source's Team1 and red its Team2; the source swaps which team is on which side between games of a series, so the side is a position and the team is a reference. |
| `sides[].side` | string | always | one of `blue`, `red` |
| `sides[].teamId` | string | always | The canonical team, resolved through the identity tables so a rename does not split a team in two (spec R7). |
| `sides[].teamName` | string | always | The team's current display name, repeated so the row reads without a join (spec R12). |
| `sides[].sourceTeam` | string | always | The team string the source used for this game, verbatim (spec R7). |
| `sides[].kills` | integer | no | at least 0 |
| `sides[].gold` | number | no | at least 0 |
| `sides[].towers` | integer | no | at least 0 |
| `sides[].inhibitors` | integer | no | at least 0 |
| `sides[].barons` | integer | no | at least 0 |
| `sides[].dragons` | integer | no | Dragons taken, as the source states the total. Never recomputed from the per-element counts: before 2016 the total counts a non-elemental dragon, so the elements do not sum to it. at least 0 |
| `sides[].dragonsClouds` | integer | no | at least 0 |
| `sides[].dragonsInfernals` | integer | no | at least 0 |
| `sides[].dragonsMountains` | integer | no | at least 0 |
| `sides[].dragonsOceans` | integer | no | at least 0 |
| `sides[].dragonsHextechs` | integer | no | at least 0 |
| `sides[].dragonsChemtechs` | integer | no | at least 0 |
| `sides[].dragonsElders` | integer | no | at least 0 |
| `sides[].riftHeralds` | integer | no | at least 0 |
| `sides[].voidGrubs` | integer | no | at least 0 |
| `sides[].atakhans` | integer | no | at least 0 |
| `winnerTeamId` | string | always | The winning team, which is always one of the two sides. The source's WinTeam string is what resolves here; its `Winner` integer must agree with the side it names or the build fails. |
| `winnerTeamName` | string | always | — |
| `source` | object | always | The source's own identifiers, so a row can be walked back to its payload by hand (spec R9, D7). |
| `source.gameId` | string | always | ScoreboardGames.GameId. The source builds it from the page plus the series and game number (`2023 Season World Championship/Play-In_Round 1_1_1`), so it embeds its page and is unique as a bare string in the recorded corpus (measured: 110 unique ids over 110 rows, 19 over 19 in 2015). |
| `source.matchId` | string | always | ScoreboardGames.MatchId — the series id, shared by every game of that series. |
| `source.riotPlatformGameId` | string | no | Riot's platform game id, where the source records one — every recorded row has one. |
| `source.riotHash` | string | no | Riot's own hash of the game record (`ScoreboardGames.RiotHash`), where the source records one: the 2015-era rows carry it and the 2023 rows do not. Carried because spec D7 names it as a source identifier; the numeric `RiotGameId` and the platform letter beside it stay in the payload row, which is committed, rather than being duplicated here. |

## `matches.jsonl` — Curated match (series)

One row of data/curated/matches.jsonl: a best-of series, the middle level of the event -> match -> game grain (spec D1). A match exists because the series score is a source fact that counting games cannot recover — a forfeited or nullified series breaks that arithmetic — so the score lives here and never on a game. `sides` is always exactly two entries in the source's own column order: `sourceOrder` 1 is `MatchSchedule.Team1` and 2 is `Team2`. That is a position on the series row, **not** a game side: the recorded corpus has 52 game rows beside a series whose `Team1` is their `Team2`, so a match claims no blue/red side and only a game does. `isNullified` is always present; `forfeit` appears only when the source states one. The source's `Phase` and `Round` columns are null on every recorded match (measured, 65 of 65), so the round label is the source's `Tab`. A match may have no games: the corpus can carry a series row whose games it does not hold (IPL 5's wildcard qualifiers), so zero games means 'the games are not in this dataset', not 'the series did not happen'. A series row that **every** game naming it contradicts is the opposite case and is not emitted at all — the build reports it instead (IPL 5's three swapped `MatchId` pairs, ticket 14).

Schema: `data/curated/schema/match.schema.json`. Fields: 20.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | always | Opaque surrogate key derived from the source's MatchId (spec D3). The source id is carried in `source`. |
| `eventId` | string | always | — |
| `eventName` | string | always | — |
| `overviewPage` | string | always | The source page the match row came from. |
| `dateTimeUtc` | string | always | — |
| `bestOf` | integer | no | The series length the source declares (measured values: 1, 3 and 5). Absent when the source states none. at least 1 |
| `tab` | string | no | The source's round label (ScoreboardGames-adjacent `Tab`): `Round 1`…`Round 5`, `Quarterfinals`, `Semifinals`, `Finals`, `Group A`, `Qualifiers`. Absent when the source has none. |
| `patch` | string | no | The patch the source states for the series, as text. Same numeric-truncation caveat as the game's `patch`. |
| `forfeit` | boolean | no | Present and true only when the source records `FF`. Measured absent on every recorded match, which is why no forfeit fixture exists yet. |
| `isNullified` | boolean | always | The source's IsNullified as stated: a nullified series is not the same as an unplayed one. |
| `sides` | array of object | always | — |
| `sides[].sourceOrder` | integer | always | The source's column: 1 for `MatchSchedule.Team1`, 2 for `Team2`. A position on the series row, not a game side — never read it as blue/red. one of `1`, `2` |
| `sides[].teamId` | string | always | — |
| `sides[].teamName` | string | always | — |
| `sides[].sourceTeam` | string | always | — |
| `sides[].seriesScore` | integer | no | The series score for this side as the source states it. Absent when the source has no score. at least 0 |
| `winnerTeamId` | string | no | Absent only when the source states no winner. |
| `winnerTeamName` | string | no | — |
| `source` | object | always | — |
| `source.matchId` | string | always | MatchSchedule.MatchId. Like GameId it embeds its page (`2023 Season World Championship/Play-In_Round 1_4`), and it is the same string a game row carries, so a game and its series can be re-joined by hand. |

## `series-conflicts.jsonl` — Series conflict report

One row of data/curated/series-conflicts.jsonl for every game whose `MatchSchedule` row names two other teams, and for every series row that every game naming it contradicts. The two states the build acts on are committed here because a build's stdout is not a dataset: without this file, a reader of `data/curated/` cannot tell a series the source contradicted from a series nobody fetched. A `detached-game` row says the game is still emitted (its own data is not in doubt) but carries no canonical `matchId`; a `contradicted-series` row says the series is not emitted at all. `matchId` is the canonical id of the series the row is about, present on both kinds even though a detached game no longer points at it; `sourceGameId`/`sourceMatchId` are the source's own identifiers, so the report can be checked against the payloads. The two team pairs are canonical ids with display names, sorted by id so a side swap cannot move them; the source strings stay on the game and match rows themselves (spec R7).

Schema: `data/curated/schema/series-conflicts.schema.json`. Fields: 11.

| Field | Type | Required | Notes |
|---|---|---|---|
| `kind` | string | always | `detached-game`: the game is emitted without a canonical `matchId` because its series row names other teams. `contradicted-series`: the series row is not emitted because every game naming it names other teams. one of `detached-game`, `contradicted-series` |
| `eventId` | string | always | The selected event both the game and the series belong to; a game and its series cannot sit in different events. |
| `eventName` | string | always | The event's display name, repeated so the row reads without a join. |
| `gameId` | string,null | always | The canonical id of the detached game, or null on a contradicted-series row (which has no emitted game). |
| `matchId` | string | always | The canonical id of the series the row is about. On a detached-game row this id is deliberately absent from the game record; on a contradicted-series row it is absent from matches.jsonl. |
| `sourceGameId` | string,null | always | The source `GameId` of the detached game, verbatim; null on a contradicted-series row. |
| `sourceMatchId` | string | always | The source `MatchId` of the series row, verbatim, so the row can be found in the recorded `MatchSchedule` payload. |
| `gameTeams` | array,null | always | The detached game's two canonical teams, sorted by `teamId`; null on a contradicted-series row. |
| `matchTeams` | array of object | always | The series row's two canonical teams, sorted by `teamId` — the pair the game's own teams disagree with. |
| `matchTeams[].teamId` | string | always | — |
| `matchTeams[].teamName` | string | always | The team's display name, so the pair reads without a join. |

## `player-games.jsonl` — Curated player-game

One row of data/curated/player-games.jsonl: one player's statistics in one game (spec R4, ticket 04). The grain is game x player; team totals live on the game row and are reconciled with these rows where player coverage is complete. A statistic the source did not state is an ABSENT KEY, never 0 and never null. Role is the position actually played (`IngameRole`), not the source's label when the two disagree. Items, summoner spells and runes are lists of source names, not a serialized blob.

Schema: `data/curated/schema/player-game.schema.json`. Fields: 32.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | always | Opaque surrogate key derived from the game and the player's source link (spec D3). |
| `gameId` | string | always | — |
| `eventId` | string | always | — |
| `eventName` | string | always | — |
| `playerId` | string | always | — |
| `playerName` | string | always | — |
| `sourcePlayer` | string | always | — |
| `teamId` | string | always | — |
| `teamName` | string | always | — |
| `sourceTeam` | string | always | — |
| `championId` | string | always | — |
| `championName` | string | always | — |
| `sourceChampion` | string | always | — |
| `side` | string | always | one of `blue`, `red` |
| `role` | string | always | — |
| `kills` | integer | no | at least 0 |
| `deaths` | integer | no | at least 0 |
| `assists` | integer | no | at least 0 |
| `cs` | integer | no | at least 0 |
| `gold` | number | no | at least 0 |
| `damage` | integer | no | at least 0 |
| `vision` | integer | no | at least 0 |
| `items` | array of string | no | — |
| `trinket` | string | no | — |
| `summonerSpells` | array of string | no | — |
| `keystone` | string | no | — |
| `primaryTree` | string | no | — |
| `secondaryTree` | string | no | — |
| `runes` | array of string | no | — |
| `source` | object | always | — |
| `source.gameId` | string | always | — |
| `source.playerLink` | string | always | — |

## `honours.jsonl` — Curated honour

One row of data/curated/honours.jsonl: a distinction the source states for one player at one admitted tournament (`IndividualAchievements`), such as a Worlds finals MVP or an All-Pro team place. A distinction is a fact about (player, event), so it is its own record rather than a field on either entity. The title and the award type travel verbatim: the source states one type (`Season Award`) for every award, and names the distinction in free text, so the dataset does not pretend to a controlled vocabulary. Contains no build timestamp, so the file is byte-identical across builds (spec R8).

Schema: `data/curated/schema/honour.schema.json`. Fields: 14.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | always | Opaque surrogate key derived from the source tuple that identifies the row (event page, player page, title and the page the award was stated on), so a re-crawl cannot renumber it (spec D3). Do not parse it: read the row through `title` and `playerName`. |
| `eventId` | string | always | The admitted event the award belongs to. The award's own page may be a stage sub-page of that event (`2024 Season World Championship/Main Event`); the record keeps the event it belongs to, so an award never floats free of the corpus's event list. |
| `eventName` | string | always | The event's display name, so the row reads without a join (spec R12). |
| `playerId` | string | always | The player the distinction belongs to. A player named only by an award (a coach, an analyst) is still a player the corpus references, so the entity is emitted in players.jsonl even when no player-game row names them. |
| `playerName` | string | always | The player's current handle, so the row reads without a join. |
| `sourcePlayer` | string | always | The source's own `Player` string, verbatim, so the row walks back to the award table (spec R7). It is a page name or one of its aliases, never the identity. |
| `team` | string | no | The source's `Team` string, verbatim. Absent when the source states none. A team string the registry does not resolve is carried and no entity is minted from it: an award is context, not evidence that a team existed. |
| `teamId` | string | no | The team the corpus knows, when the alias registry resolves the stated string (`SKT T1` -> `T1`). Absent when it does not: the string stays on `team` and the distinction is still emitted. |
| `teamName` | string | no | That team's current display name, so a resolved team reads without a join. |
| `title` | string | always | The distinction as the source words it (`Finals MVP`, `Most Valuable Player`, `All Pro Team`). Never normalised: the corpus keeps the three spellings of the same idea distinct, because deciding they are one is the analyst's judgement, not the build's. |
| `type` | string | always | The source's `AchievementType`, verbatim. One value today (`Season Award`) for tournament MVPs and regional season awards alike, which is why the title, not this field, names the distinction. |
| `sourcePage` | string | always | The page the award was stated on, for provenance: the event's own page or a stage sub-page of it. |
| `place` | string | no | The source's `Place` text when it states one. Absent when the source states none, which is the case for every recorded row so far: the MVP rows state no place, and neither do the All-Pro rows, whose rank lives in the title (`3rd All Pro Team`) rather than here. |
| `placeNumber` | integer | no | The source's `Place_Number` when it states one. Absent when it states none: a stated place of `1` is 1, and no place is not 0. |

## `teams.jsonl` — Curated team

One row of data/curated/teams.jsonl: a team the corpus references, with the display name, short name and region the source states. Its canonical ID is anchored on the root of the source's rename chain (see tools/dataset/identity.ts), so it survives a rebrand; the other strings that denote this team are rows in aliases.jsonl. Contains no build timestamp, so the file is byte-identical across builds (spec R8).

Schema: `data/curated/schema/team.schema.json`. Fields: 5.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | always | Opaque surrogate key derived from the source identity (spec D3). Do not parse it: read the row through `name`. |
| `name` | string | always | The team's current display name as the source states it, so the row reads without decoding the ID (spec R12). |
| `short` | string | no | The team's short name as the source's registry states it (`Karmine Corp` -> `KC`), so an abbreviation an analyst recognises reads without a lookup. Absent when the registry states none for the team's **current** page — always the case for a team minted from a string no registry carries, and in principle also for a registered team whose current name row is blank. A rename does not carry an older name's short forward, because the abbreviation changes with the name. A label, not an identity: measured, `ESC`, `GMB`, `IM` and `RED` each denote two teams in this corpus, so nothing may join, deduplicate or look up by this field. |
| `overviewPage` | string,null | always | The team's current wiki page. Null only when a scoreboard cited a team the source registers no page for: that entity is minted, and reported in identity-unresolved.jsonl, rather than dropped. |
| `region` | string | always | The source's Region string, verbatim. Empty when the source records none — including for a minted entity, whose region nobody recorded. |

## `players.jsonl` — Curated player

One row of data/curated/players.jsonl: a player the corpus references, with the handle the source states. Its canonical ID is anchored on the player's wiki page, which survives a handle change (see tools/dataset/identity.ts); the handles and old pages that also denote the player are rows in aliases.jsonl. Two different players may share a handle — measured: eight entities answer to `Wolf` — and they stay two entities, which is why the ID is the page and not the handle.

Schema: `data/curated/schema/player.schema.json`. Fields: 3.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | always | Opaque surrogate key derived from the player page (spec D3). Do not parse it: read the row through `name`. |
| `name` | string | always | The player's current handle as the source states it, so the row reads without decoding the ID (spec R12). Not unique: it is a display string. |
| `overviewPage` | string,null | always | The player's wiki page. Null only when a scoreboard cited a link the source registers no page for: that entity is minted and reported in identity-unresolved.jsonl rather than dropped. |

## `champions.jsonl` — Curated champion

One row of data/curated/champions.jsonl: a champion the corpus references. Its canonical ID is anchored on Riot's numeric champion id, which a display rename does not change (see tools/dataset/identity.ts); the retired display name, where one is declared, is a row in aliases.jsonl. The name and the release date are carried from the source, HTML entities included (spec R7: source strings are preserved, not rewritten).

Schema: `data/curated/schema/champion.schema.json`. Fields: 4.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | always | Opaque surrogate key derived from Riot's champion id (spec D3). Do not parse it: read the row through `name`. |
| `name` | string | always | The champion's current display name as the source states it, so the row reads without decoding the ID (spec R12). |
| `riotKey` | integer,null | always | Riot's numeric champion id (20 = Nunu). Null only when a scoreboard cited a champion name no registry row carries: that entity is minted and reported in identity-unresolved.jsonl rather than dropped. |
| `releaseDate` | string | no | The day the champion entered the game, as the registry row that anchors its identity states it (`Ahri` -> `2011-12-14`). Absent only when the source states none, which for a champion minted from an unresolved name is always. Day precision only: a coarser source stamp fails the build rather than being rounded, so the dataset never claims a day the source did not. It is a dated attribute, not a date key: nothing joins on it, and the model keeps it beside `champion_name` rather than in `dim_date`. |

## `aliases.jsonl` — Curated identity alias

One row of data/curated/aliases.jsonl: a source string that denotes an entity, with the window the source is known to have used it. This is the table a reader consults to translate a source string — or a value in an older payload — into a canonical ID, and the table a rename pair shows up in as two rows with one entityId. `firstSeen`/`lastSeen` are observed use in the recorded corpus; where the corpus never dates a string, they are the window a declared alias in tools/dataset/rules/identity-aliases.json states. A row may share its `string` with another entity's row: `Wolf` names eight players, and which one answers depends on the date the source used it.

Schema: `data/curated/schema/alias.schema.json`. Fields: 7.

| Field | Type | Required | Notes |
|---|---|---|---|
| `kind` | string | always | Which entity table `entityId` belongs to. one of `team`, `player`, `champion` |
| `string` | string | always | The source string, verbatim — the exact bytes the source used, including its casing and HTML entities (spec R7). |
| `entityId` | string | always | The canonical ID this string denotes. |
| `entityName` | string | always | The entity's current display name, repeated here so an alias row reads without a join (spec R12). |
| `firstSeen` | string,null | always | Earliest UTC date on which a recorded source row used this string for this entity. Null means the corpus does not date it, not that it was never used. |
| `lastSeen` | string,null | always | Latest UTC date on which a recorded source row used this string for this entity. Null means the corpus does not date it. |
| `evidence` | array of string | always | Why this mapping is believed: the source's own registry states it (`registry`), it is an old page in a Teams.RenamedTo chain (`rename`), it is a TeamRedirects/PlayerRedirects AllName (`redirect`), it is a player handle (`handle`), a recorded scoreboard row used it (`observed`), or rules/identity-aliases.json declares it (`declared`). |

## `identity-unresolved.jsonl` — Unresolved identity report

One row of data/curated/identity-unresolved.jsonl: a source string that named no entity the source registers. This is the report that makes resolution visible rather than silent — the same job event-selection.jsonl does for the event rule. `no-source-identity` means the string became a new entity with its ID anchored on the string itself, so a later registry row with that exact name keeps the same ID; `ambiguous` means the string names more than one entity and nothing is minted, because picking one would merge two distinct people. An empty file means every reference in this corpus resolved.

Schema: `data/curated/schema/identity-unresolved.schema.json`. Fields: 8.

| Field | Type | Required | Notes |
|---|---|---|---|
| `kind` | string | always | one of `team`, `player`, `champion` |
| `string` | string | always | The source string, verbatim (spec R7). |
| `name` | string | always | The minted entity's display name — the string itself — so the report reads without decoding an ID (spec R12). For an ambiguous string, the string itself. |
| `id` | string,null | always | The entity minted for this string, or null for an ambiguity, where minting would hide the problem. |
| `firstSeen` | string,null | always | Earliest UTC date on which a recorded source row used this string. |
| `lastSeen` | string,null | always | Latest UTC date on which a recorded source row used this string. |
| `reason` | string | always | Why this string is here: nothing in the source registers it, or several entities answer to it. one of `no-source-identity`, `ambiguous` |
| `candidates` | array of string | always | For `ambiguous`, the canonical IDs the string could mean. Empty for `no-source-identity`. |

## `manifest.json` — Provenance manifest

The shape of data/curated/manifest.json, the build's account of the cached bytes it read and the entity files it emitted (spec D2, D7, R8, R9). This file is the contract: `readManifest` validates a committed manifest against it before comparing anything, and the build validates the manifest it is about to write. `entities` must name every emitted file once, in the build's OUTPUTS order; `payloads` must name every cached payload the build read once, sorted by cache-relative path. `entityDigest` is recomputed from `entities` rather than trusted. `fetchedAt` is the only timestamp in the dataset, and is absent for a body-only payload with no sidecar.

Schema: `data/curated/schema/manifest.schema.json`. Fields: 21.

| Field | Type | Required | Notes |
|---|---|---|---|
| `format` | string | always | The manifest's own format marker, so a reader can refuse a version it does not know. always `lol-dataset-provenance/1` |
| `entityDigest` | string | always | sha256 over `entities` in the build's OUTPUTS order: for each file, `${file}\t${sha256}\t${records}\n`. Recomputed by the reader, never trusted as an opaque string. |
| `entities` | array of object | always | One entry per emitted entity file, in the build's OUTPUTS order (the order the writer writes and the digest is defined on). |
| `entities[].file` | string | always | The emitted file's name, e.g. `events.jsonl`. |
| `entities[].records` | integer | always | Non-empty JSONL lines: the record count, so a reader can sanity-check a file. at least 0 |
| `entities[].sha256` | string | always | sha256 of the emitted file's bytes. |
| `payloads` | array of object | always | One entry per cached payload the build read, sorted by cache-relative path so a diff shows an added or removed payload in one line. |
| `payloads[].file` | string | always | Path relative to the cache root, e.g. `lol-fandom/cargoexport/Tournaments/<key>.json.gz`. Bodies are gzip-compressed; `bodySha256` is the hash of the uncompressed body (the source's bytes), so the pin describes the response rather than this repository's storage choice. |
| `payloads[].table` | string | always | The Cargo table whose directory the payload sits in; this is how the build routed it. |
| `payloads[].endpoint` | string | always | The Cargo endpoint the payload came from. one of `cargoquery`, `cargoexport` |
| `payloads[].bodySha256` | string | always | sha256 of the body bytes on disk, verified against the sidecar when there is one. |
| `payloads[].fetchedAt` | string | no | The sidecar's recorded fetch time, as an ISO-8601 instant. Absent for a body-only payload; the only timestamp in the dataset (spec D8). |
| `payloads[].status` | integer | no | The sidecar's recorded HTTP status. Absent for a body-only payload. at least 100 |
| `payloads[].query` | object | no | The query the sidecar records: what produced these bytes. Absent for a body-only payload. |
| `payloads[].query.endpoint` | string | when present | one of `cargoquery`, `cargoexport` |
| `payloads[].query.tables` | string | when present | — |
| `payloads[].query.fields` | string | when present | — |
| `payloads[].query.where` | string | no | — |
| `payloads[].query.order_by` | string | no | — |
| `payloads[].query.limit` | integer | no | at least 0 |
| `payloads[].query.offset` | integer | no | at least 0 |
