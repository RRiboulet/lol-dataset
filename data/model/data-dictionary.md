# Dimensional model — data dictionary

Generated from `data/curated/` by `node tools/dataset/cli.ts model`. Do not edit by hand.
The curated JSONL is the source of truth; this layer is derived, rebuilt as a whole, and never
written back to the curated files.

## Files, grains and keys

| Table | File | Kind | Grain | Natural key | Surrogate key |
|---|---|---|---|---|---|
| `dim_event` | `dim_event.csv` | dimension | one row per event | `event_id` | `event_key` |
| `dim_match` | `dim_match.csv` | dimension | one row per series (match) | `match_id` | `match_key` |
| `dim_game` | `dim_game.csv` | dimension | one row per game | `game_id` | `game_key` |
| `dim_team` | `dim_team.csv` | dimension | one row per team | `team_id` | `team_key` |
| `dim_player` | `dim_player.csv` | dimension | one row per player | `player_id` | `player_key` |
| `dim_champion` | `dim_champion.csv` | dimension | one row per champion | `champion_id` | `champion_key` |
| `dim_patch` | `dim_patch.csv` | dimension | one row per patch | `patch` | `patch_key` |
| `dim_date` | `dim_date.csv` | dimension | one row per UTC calendar date | `date` | `date_key` |
| `bridge_alias` | `bridge_alias.csv` | bridge | one row per (kind, alias_string, entity_key) | — | `alias_key` |
| `fact_game_side` | `fact_game_side.csv` | fact | one row per game per side | — | — |
| `fact_player_game` | `fact_player_game.csv` | fact | one row per game per player | — | — |
| `fact_draft_slot` | `fact_draft_slot.csv` | fact | one row per game, side, phase and draft position | — | — |
| `fact_player_honour` | `fact_player_honour.csv` | fact | one row per player, event and distinction title | — | — |

## Canonical form

One CSV per table, RFC 4180 field quoting and escaping, UTF-8 without a BOM, one header row,
fixed column order, LF record terminators, ISO-8601 dates (`YYYY-MM-DD`) and UTC instants
(`YYYY-MM-DDTHH:MM:SSZ`), unformatted decimal integers, and an **empty field wherever the source
did not record a value**. An empty field is not `0`: `0` is a recorded zero, and the two mean
different things. A foreign key is never empty — absence is the unknown member's `0`.

LF is deliberate. RFC 4180 also permits CRLF, but this repository normalizes every text file to
LF (`.gitattributes`), so a CRLF artifact would be a committed file that differs from the bytes
the build wrote. SQLite, DuckDB, Python's `csv` module and spreadsheets all read LF.

## Unknown member

Every dimension has exactly one row with surrogate key `0`, an empty natural key and the display
name `Unknown`. A fact joins to it when the curated record has no value — today, a game with no
series or no patch (`match_key`, `patch_key`). An inner join therefore never drops a thin-era row,
and `0` is never mistaken for a real entity. The unknown row's attributes are empty, not zero,
except a foreign key it carries itself, which joins to the target's own unknown member
(`dim_match`'s `event_key` is `0`).

Every dimension keeps its unknown member, including the ones no fact can currently reach at `0`
(`dim_event`, `dim_game`, `dim_date`, `dim_team`, `dim_player`, `dim_champion`): the rule — a
foreign key is never empty, and absence is key `0` — then stays uniform, a reader never learns a
per-dimension special case, and a future fact that can miss one of these values needs no new
convention. The conformance gate refuses `0` in a fact key the curated record always states
(`game_key`, `event_key`, `date_key`, `team_key`, `player_key`, `champion_key`), so the
unreachable members stay unreachable rather than silently absorbable.

## Surrogate keys and ordering

Surrogate keys are `0` for the unknown member and `1..N` for the real rows, assigned in ascending
natural-key order within each build. They are build-local: the natural key (the canonical ID,
ISO date or patch string) is the durable identifier, and every fact is rebuilt in the same run, so
a key can never dangle. The keys can shift between builds — a new event sorting earlier
renumbers everything after it — which is not a defect: an analyst joining across a rebuild, or
storing a key outside the model, uses the natural key, which is the durable handle. Rows are
sorted by that same order; facts are sorted by their declared grain columns, and the bridge by
`kind`, `entity_key`, `alias_string`. No file contains a build timestamp.

## Measures, and the limit of the no-derived-measure guard

Facts carry only measures the source stated — counts and durations. The analyst does the summing,
dividing and averaging. The build refuses a fact column whose **name** looks like a derived
measure: `rate`, `ratio`, `average`, `avg`, `mean`, `percentage`, `percent`, `pct`, `share`,
`kda`, `gpm`, `win_rate`, `win_pct`, and `per_game`, `per_minute`, `per_min` shapes. That guard is
a naming heuristic, not a semantic one: it catches the obvious shapes (`kda`, `gpm`,
`damage_per_min_10`) but cannot tell what a column computes, so a new measure still needs a
reviewer's judgement that it is source-stated and additive. Do not rely on the guard for
correctness.

## Alias bridge

`bridge_alias` carries source strings, not duplicate dimension rows: a renamed team is one
`dim_team` row and several bridge rows, each with `valid_from`/`valid_to` dates where the corpus
dates them. `entity_key` is a foreign key into the dimension named by `kind` (`team`, `player` or
`champion`), so one bridge serves all three. `evidence` is the source's reason for believing the
mapping, joined with semicolons in canonical order. An empty validity date means the corpus does
not date the string, not that it was never used.

## Tables

### `dim_event` — dimension

One row per admitted international event.

**Grain:** one row per event.
**Natural key:** `event_id`.
**Surrogate key:** `event_key`.

| Column | Type | Role | References | Absent / notes |
|---|---|---|---|---|
| `event_key` | INTEGER | surrogate key | — | Build-local surrogate key. 0 is the unknown member; values are assigned 1..N in natural-key order. |
| `event_id` | TEXT | natural key | — | The curated event's canonical ID (`evt-…`). |
| `event_name` | TEXT | attribute | — | The event's display name, so a fact reads without decoding a key. |
| `overview_page` | TEXT | attribute | — | The source page the event was recorded from. |
| `league` | TEXT | attribute | — | The source's league string, verbatim; empty when the source records none. |
| `region` | TEXT | attribute | — | The source's region string, verbatim. |
| `date_start` | TEXT | attribute | — | The event's start date, ISO-8601 (`YYYY-MM-DD`). |
| `year` | INTEGER | attribute | — | UTC calendar year of `date_start`, repeated for grouping. |

### `dim_match` — dimension

One row per series the corpus carries.

**Grain:** one row per series (match).
**Natural key:** `match_id`.
**Surrogate key:** `match_key`.

| Column | Type | Role | References | Absent / notes |
|---|---|---|---|---|
| `match_key` | INTEGER | surrogate key | — | Build-local surrogate key. 0 is the unknown member; values are assigned 1..N in natural-key order. |
| `match_id` | TEXT | natural key | — | The curated match's canonical ID (`mt-…`). |
| `event_key` | INTEGER | foreign key | `dim_event.event_key` | The event the series belongs to, so a series is sliceable by event without joining through its games. |
| `match_name` | TEXT | attribute | — | A readable series label: event, round label and date. |
| `date_time_utc` | TEXT | attribute | — | The series' start instant, ISO-8601 UTC. |
| `best_of` | INTEGER | attribute | — | The series length the source declares. Absent: empty when the source states none. |
| `tab` | TEXT | attribute | — | The source's round label. Absent: empty when the source has none. |
| `is_nullified` | INTEGER | attribute | — | 1 when the source marks the series nullified, else 0. |
| `forfeit` | INTEGER | attribute | — | 1 when the source records a forfeit; empty when it records none. Absent: empty when the source records none. |

### `dim_game` — dimension

One row per game: its identity, era and coverage declarations.

**Grain:** one row per game.
**Natural key:** `game_id`.
**Surrogate key:** `game_key`.

| Column | Type | Role | References | Absent / notes |
|---|---|---|---|---|
| `game_key` | INTEGER | surrogate key | — | Build-local surrogate key. 0 is the unknown member; values are assigned 1..N in natural-key order. |
| `game_id` | TEXT | natural key | — | The curated game's canonical ID (`gm-…`). |
| `game_name` | TEXT | attribute | — | A readable game label: event, the two teams and the date. |
| `date_time_utc` | TEXT | attribute | — | The game's start instant, ISO-8601 UTC. |
| `era` | TEXT | attribute | — | The era id whose field set judged this game's coverage. |
| `team_stats_coverage` | TEXT | attribute | — | The curated `coverage.teamStats` marker: complete, partial or unavailable. |
| `draft_coverage` | TEXT | attribute | — | The curated `coverage.draft` marker. |
| `player_stats_coverage` | TEXT | attribute | — | The curated `coverage.playerStats` marker. |
| `draft_fidelity` | TEXT | attribute | — | `ordered`, `unordered`, or empty when the corpus carries no draft. |
| `draft_switched_sides` | INTEGER | attribute | — | The source's switched-sides flag on an ordered draft; empty when it states none. |

### `dim_team` — dimension

One row per canonical team; renames live in the alias bridge, not here.

**Grain:** one row per team.
**Natural key:** `team_id`.
**Surrogate key:** `team_key`.

| Column | Type | Role | References | Absent / notes |
|---|---|---|---|---|
| `team_key` | INTEGER | surrogate key | — | Build-local surrogate key. 0 is the unknown member; values are assigned 1..N in natural-key order. |
| `team_id` | TEXT | natural key | — | The curated team's canonical ID (`tm-…`). |
| `team_name` | TEXT | attribute | — | The team's current display name. |
| `short` | TEXT | attribute | — | The team's short name as the source's registry states it for the team's current page (`Karmine Corp` -> `KC`). A label, not a key: two teams can share one, so never join on it. Absent: empty when the source states no short name for the team's current page — always the case for a minted team; a rename does not carry an older name's short forward. |
| `overview_page` | TEXT | attribute | — | The team's current wiki page. Absent: empty only for an entity minted from a string no registry carries. |
| `region` | TEXT | attribute | — | The source's region string, verbatim; empty when it records none. |

### `dim_player` — dimension

One row per canonical player; handles and old pages live in the alias bridge.

**Grain:** one row per player.
**Natural key:** `player_id`.
**Surrogate key:** `player_key`.

| Column | Type | Role | References | Absent / notes |
|---|---|---|---|---|
| `player_key` | INTEGER | surrogate key | — | Build-local surrogate key. 0 is the unknown member; values are assigned 1..N in natural-key order. |
| `player_id` | TEXT | natural key | — | The curated player's canonical ID (`pl-…`). |
| `player_name` | TEXT | attribute | — | The player's current handle. |
| `overview_page` | TEXT | attribute | — | The player's wiki page. Absent: empty only for an entity minted from a string no registry carries. |

### `dim_champion` — dimension

One row per canonical champion; retired display names live in the alias bridge.

**Grain:** one row per champion.
**Natural key:** `champion_id`.
**Surrogate key:** `champion_key`.

| Column | Type | Role | References | Absent / notes |
|---|---|---|---|---|
| `champion_key` | INTEGER | surrogate key | — | Build-local surrogate key. 0 is the unknown member; values are assigned 1..N in natural-key order. |
| `champion_id` | TEXT | natural key | — | The curated champion's canonical ID (`ch-…`). |
| `champion_name` | TEXT | attribute | — | The champion's current display name. |
| `riot_key` | INTEGER | attribute | — | Riot's numeric champion id. Absent: empty only for a champion minted from a name no registry carries. |
| `release_date` | TEXT | attribute | — | The day the champion entered the game (`YYYY-MM-DD`), from the registry row that anchors its identity. A dated attribute, not a `date_key`: `dim_date` is the calendar of the games the facts describe, and a champion's release is not one of them. Absent: empty when the source states no release date, which for a minted champion is always. |

### `dim_patch` — dimension

One row per patch string the source states, shared across games.

**Grain:** one row per patch.
**Natural key:** `patch`.
**Surrogate key:** `patch_key`.

| Column | Type | Role | References | Absent / notes |
|---|---|---|---|---|
| `patch_key` | INTEGER | surrogate key | — | Build-local surrogate key. 0 is the unknown member; values are assigned 1..N in natural-key order. |
| `patch` | TEXT | natural key | — | The patch as the source states it, as text; never padded or inferred. |
| `patch_name` | TEXT | attribute | — | A readable label for the patch. |

### `dim_date` — dimension

One row per UTC calendar date on which a modelled game was played.

**Grain:** one row per UTC calendar date.
**Natural key:** `date`.
**Surrogate key:** `date_key`.

| Column | Type | Role | References | Absent / notes |
|---|---|---|---|---|
| `date_key` | INTEGER | surrogate key | — | Build-local surrogate key. 0 is the unknown member; values are assigned 1..N in natural-key order. |
| `date` | TEXT | natural key | — | The calendar date, ISO-8601 (`YYYY-MM-DD`). |
| `date_name` | TEXT | attribute | — | The same ISO date, so a fact reads without decoding the key. |
| `year` | INTEGER | attribute | — | UTC calendar year. |
| `month` | INTEGER | attribute | — | Calendar month, 1–12. |
| `day` | INTEGER | attribute | — | Day of month, 1–31. |

### `bridge_alias` — bridge

Alias bridge: one row per source string and entity, with the window it applied to.

**Grain:** one row per (kind, alias_string, entity_key).
**Surrogate key:** `alias_key`.

| Column | Type | Role | References | Absent / notes |
|---|---|---|---|---|
| `alias_key` | INTEGER | surrogate key | — | Bridge row key, 1..N in the bridge's sort order. |
| `kind` | TEXT | attribute | — | Which dimension `entity_key` points into: team, player or champion. |
| `alias_string` | TEXT | grain key | — | The source string, verbatim. |
| `entity_key` | INTEGER | grain key | — | The dimension row the string denotes; the target table depends on `kind`. |
| `entity_id` | TEXT | attribute | — | The entity's natural key, repeated so the bridge reads without a join. |
| `entity_name` | TEXT | attribute | — | The entity's current display name. |
| `valid_from` | TEXT | attribute | — | First date the corpus or a declared alias is known to have used this string. Absent: empty when the corpus does not date it, not when it was never used. |
| `valid_to` | TEXT | attribute | — | Last date the string is known to have been used. Absent: empty when the corpus does not date it. |
| `evidence` | TEXT | attribute | — | Why the mapping is believed, as semicolon-separated evidence values in canonical order. |

### `fact_game_side` — fact

Team statistics at one row per game per side.

**Grain:** one row per game per side.
**Grain key:** `game_key`, `side`.

| Column | Type | Role | References | Absent / notes |
|---|---|---|---|---|
| `game_key` | INTEGER | foreign key | `dim_game.game_key` | The game this row belongs to. |
| `event_key` | INTEGER | foreign key | `dim_event.event_key` | The event the game belongs to, so facts slice by event without a join through dim_game. |
| `match_key` | INTEGER | foreign key | `dim_match.match_key` | The series the game belongs to; 0 when the corpus carries no series row. Absent: 0 (the unknown member) when the game has no series. |
| `date_key` | INTEGER | foreign key | `dim_date.date_key` | The UTC date the game was played. |
| `patch_key` | INTEGER | foreign key | `dim_patch.patch_key` | The patch the source states for the game; 0 when it states none. Absent: 0 (the unknown member) when the source states no patch. |
| `team_key` | INTEGER | foreign key | `dim_team.team_key` | The team on this side of the game. |
| `side` | TEXT | attribute | — | The source's side for this game: `blue` is Team1 and `red` is Team2. |
| `is_winner` | INTEGER | attribute | — | 1 when this side won the game, 0 when it lost; empty when the source records no winner. Absent: empty when the source records no winner. |
| `duration_seconds` | INTEGER | measure | — | Game length in whole seconds, a game-level measure repeated on both side rows. Absent: empty when the source states no duration. |
| `kills` | INTEGER | measure | — | The source's kills figure for this side. Absent: empty when the source did not record it; 0 is a real zero. |
| `gold` | INTEGER | measure | — | The source's gold figure for this side. Absent: empty when the source did not record it; 0 is a real zero. |
| `towers` | INTEGER | measure | — | The source's towers figure for this side. Absent: empty when the source did not record it; 0 is a real zero. |
| `inhibitors` | INTEGER | measure | — | The source's inhibitors figure for this side. Absent: empty when the source did not record it; 0 is a real zero. |
| `barons` | INTEGER | measure | — | The source's barons figure for this side. Absent: empty when the source did not record it; 0 is a real zero. |
| `dragons` | INTEGER | measure | — | The source's dragons figure for this side. Absent: empty when the source did not record it; 0 is a real zero. |
| `dragons_clouds` | INTEGER | measure | — | The source's dragonsClouds figure for this side. Absent: empty when the source did not record it; 0 is a real zero. |
| `dragons_infernals` | INTEGER | measure | — | The source's dragonsInfernals figure for this side. Absent: empty when the source did not record it; 0 is a real zero. |
| `dragons_mountains` | INTEGER | measure | — | The source's dragonsMountains figure for this side. Absent: empty when the source did not record it; 0 is a real zero. |
| `dragons_oceans` | INTEGER | measure | — | The source's dragonsOceans figure for this side. Absent: empty when the source did not record it; 0 is a real zero. |
| `dragons_hextechs` | INTEGER | measure | — | The source's dragonsHextechs figure for this side. Absent: empty when the source did not record it; 0 is a real zero. |
| `dragons_chemtechs` | INTEGER | measure | — | The source's dragonsChemtechs figure for this side. Absent: empty when the source did not record it; 0 is a real zero. |
| `dragons_elders` | INTEGER | measure | — | The source's dragonsElders figure for this side. Absent: empty when the source did not record it; 0 is a real zero. |
| `rift_heralds` | INTEGER | measure | — | The source's riftHeralds figure for this side. Absent: empty when the source did not record it; 0 is a real zero. |
| `void_grubs` | INTEGER | measure | — | The source's voidGrubs figure for this side. Absent: empty when the source did not record it; 0 is a real zero. |
| `atakhans` | INTEGER | measure | — | The source's atakhans figure for this side. Absent: empty when the source did not record it; 0 is a real zero. |

### `fact_player_game` — fact

Player statistics at one row per game per player.

**Grain:** one row per game per player.
**Grain key:** `game_key`, `player_key`.

| Column | Type | Role | References | Absent / notes |
|---|---|---|---|---|
| `game_key` | INTEGER | foreign key | `dim_game.game_key` | The game this row belongs to. |
| `event_key` | INTEGER | foreign key | `dim_event.event_key` | The event the game belongs to, so facts slice by event without a join through dim_game. |
| `match_key` | INTEGER | foreign key | `dim_match.match_key` | The series the game belongs to; 0 when the corpus carries no series row. Absent: 0 (the unknown member) when the game has no series. |
| `date_key` | INTEGER | foreign key | `dim_date.date_key` | The UTC date the game was played. |
| `patch_key` | INTEGER | foreign key | `dim_patch.patch_key` | The patch the source states for the game; 0 when it states none. Absent: 0 (the unknown member) when the source states no patch. |
| `player_key` | INTEGER | foreign key | `dim_player.player_key` | The player this row describes. |
| `team_key` | INTEGER | foreign key | `dim_team.team_key` | The player's team in this game. |
| `champion_key` | INTEGER | foreign key | `dim_champion.champion_key` | The champion the player played. |
| `side` | TEXT | attribute | — | The side the player's team was on in this game. |
| `role` | TEXT | attribute | — | The position actually played (`IngameRole`), not the source's label when they disagree. |
| `kills` | INTEGER | measure | — | The player's source-stated kills. Absent: empty when the source did not record it; 0 is a real zero. |
| `deaths` | INTEGER | measure | — | The player's source-stated deaths. Absent: empty when the source did not record it; 0 is a real zero. |
| `assists` | INTEGER | measure | — | The player's source-stated assists. Absent: empty when the source did not record it; 0 is a real zero. |
| `cs` | INTEGER | measure | — | The player's source-stated cs. Absent: empty when the source did not record it; 0 is a real zero. |
| `gold` | INTEGER | measure | — | The player's source-stated gold. Absent: empty when the source did not record it; 0 is a real zero. |
| `damage` | INTEGER | measure | — | The player's source-stated damage. Absent: empty when the source did not record it; 0 is a real zero. |
| `vision` | INTEGER | measure | — | The player's source-stated vision. Absent: empty when the source did not record it; 0 is a real zero. |

### `fact_draft_slot` — fact

One row per pick or ban, ordered and unordered drafts alike.

**Grain:** one row per game, side, phase and draft position.
**Grain key:** `game_key`, `side`, `phase`, `entry_index`.

| Column | Type | Role | References | Absent / notes |
|---|---|---|---|---|
| `game_key` | INTEGER | foreign key | `dim_game.game_key` | The game this row belongs to. |
| `event_key` | INTEGER | foreign key | `dim_event.event_key` | The event the game belongs to, so facts slice by event without a join through dim_game. |
| `match_key` | INTEGER | foreign key | `dim_match.match_key` | The series the game belongs to; 0 when the corpus carries no series row. Absent: 0 (the unknown member) when the game has no series. |
| `date_key` | INTEGER | foreign key | `dim_date.date_key` | The UTC date the game was played. |
| `patch_key` | INTEGER | foreign key | `dim_patch.patch_key` | The patch the source states for the game; 0 when it states none. Absent: 0 (the unknown member) when the source states no patch. |
| `side` | TEXT | attribute | — | The side whose draft turn this is, as the source recorded it. |
| `phase` | TEXT | attribute | — | `ban` or `pick`. |
| `entry_index` | INTEGER | attribute | — | Position within this game, side and phase. It equals `slot` for an ordered draft and is the only stable order an unordered draft has. |
| `slot` | INTEGER | attribute | — | The source's slot number, present only when the draft is ordered. Absent: empty for an unordered draft — absent order is never invented. |
| `is_ordered` | INTEGER | attribute | — | 1 when the source kept pick/ban slots, else 0. |
| `champion_key` | INTEGER | foreign key | `dim_champion.champion_key` | The champion picked or banned in this slot. |

### `fact_player_honour` — fact

One row per distinction the source states for a player at a tournament.

**Grain:** one row per player, event and distinction title.
**Grain key:** `player_key`, `event_key`, `title`.

| Column | Type | Role | References | Absent / notes |
|---|---|---|---|---|
| `player_key` | INTEGER | foreign key | `dim_player.player_key` | The player the distinction belongs to. |
| `event_key` | INTEGER | foreign key | `dim_event.event_key` | The tournament the distinction was earned at. |
| `team_key` | INTEGER | foreign key | `dim_team.team_key` | The team the source states for the award, resolved through the alias registry. Absent: 0 (the unknown member) when the source's team string resolves to no team, or states none. |
| `title` | TEXT | attribute | — | The distinction in the source's own words (`Finals MVP`, `All Pro Team`). |
| `type` | TEXT | attribute | — | The source's award type, verbatim. |
| `source_page` | TEXT | attribute | — | The page the award was stated on: the event page or a stage sub-page. |
| `place` | TEXT | attribute | — | The source's place text when it states one. Absent: empty when the source states none, which is the case for every recorded row so far. |
| `place_number` | INTEGER | attribute | — | The source's place as a number when it states one. Absent: empty when the source states none; a stated place of 1 is 1. |
