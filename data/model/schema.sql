-- Dimensional model DDL (SQLite dialect).
-- Generated from data/curated/ by `node tools/dataset/cli.ts model`; do not edit by hand.
-- Load the CSVs in this file's table order, or in MODEL_TABLE_ORDER: dimensions first.
-- Empty CSV fields are absent values, not NULL and not zero; 0 in a foreign key is the
-- unknown member. See data-dictionary.md.

PRAGMA foreign_keys = ON;

-- dim_event: One row per admitted international event.
CREATE TABLE dim_event (
  event_key INTEGER,
  event_id TEXT,
  event_name TEXT,
  overview_page TEXT,
  league TEXT,
  region TEXT,
  date_start TEXT,
  year INTEGER,
  PRIMARY KEY (event_key),
  UNIQUE (event_id)
);

-- dim_match: One row per series the corpus carries.
CREATE TABLE dim_match (
  match_key INTEGER,
  match_id TEXT,
  event_key INTEGER REFERENCES dim_event(event_key),
  match_name TEXT,
  date_time_utc TEXT,
  best_of INTEGER,
  tab TEXT,
  is_nullified INTEGER,
  forfeit INTEGER,
  PRIMARY KEY (match_key),
  UNIQUE (match_id)
);

-- dim_game: One row per game: its identity, era and coverage declarations.
CREATE TABLE dim_game (
  game_key INTEGER,
  game_id TEXT,
  game_name TEXT,
  date_time_utc TEXT,
  era TEXT,
  team_stats_coverage TEXT,
  draft_coverage TEXT,
  player_stats_coverage TEXT,
  draft_fidelity TEXT,
  draft_switched_sides INTEGER,
  PRIMARY KEY (game_key),
  UNIQUE (game_id)
);

-- dim_team: One row per canonical team; renames live in the alias bridge, not here.
CREATE TABLE dim_team (
  team_key INTEGER,
  team_id TEXT,
  team_name TEXT,
  short TEXT,
  overview_page TEXT,
  region TEXT,
  PRIMARY KEY (team_key),
  UNIQUE (team_id)
);

-- dim_player: One row per canonical player; handles and old pages live in the alias bridge.
CREATE TABLE dim_player (
  player_key INTEGER,
  player_id TEXT,
  player_name TEXT,
  overview_page TEXT,
  PRIMARY KEY (player_key),
  UNIQUE (player_id)
);

-- dim_champion: One row per canonical champion; retired display names live in the alias bridge.
CREATE TABLE dim_champion (
  champion_key INTEGER,
  champion_id TEXT,
  champion_name TEXT,
  riot_key INTEGER,
  release_date TEXT,
  PRIMARY KEY (champion_key),
  UNIQUE (champion_id)
);

-- dim_patch: One row per patch string the source states, shared across games.
CREATE TABLE dim_patch (
  patch_key INTEGER,
  patch TEXT,
  patch_name TEXT,
  PRIMARY KEY (patch_key),
  UNIQUE (patch)
);

-- dim_date: One row per UTC calendar date on which a modelled game was played.
CREATE TABLE dim_date (
  date_key INTEGER,
  date TEXT,
  date_name TEXT,
  year INTEGER,
  month INTEGER,
  day INTEGER,
  PRIMARY KEY (date_key),
  UNIQUE (date)
);

-- bridge_alias: Alias bridge: one row per source string and entity, with the window it applied to.
CREATE TABLE bridge_alias (
  alias_key INTEGER,
  kind TEXT,
  alias_string TEXT,
  entity_key INTEGER,
  entity_id TEXT,
  entity_name TEXT,
  valid_from TEXT,
  valid_to TEXT,
  evidence TEXT,
  PRIMARY KEY (alias_key),
  UNIQUE (kind, alias_string, entity_key)
);

-- fact_game_side: Team statistics at one row per game per side.
CREATE TABLE fact_game_side (
  game_key INTEGER REFERENCES dim_game(game_key),
  event_key INTEGER REFERENCES dim_event(event_key),
  match_key INTEGER REFERENCES dim_match(match_key),
  date_key INTEGER REFERENCES dim_date(date_key),
  patch_key INTEGER REFERENCES dim_patch(patch_key),
  team_key INTEGER REFERENCES dim_team(team_key),
  side TEXT,
  is_winner INTEGER,
  duration_seconds INTEGER,
  kills INTEGER,
  gold INTEGER,
  towers INTEGER,
  inhibitors INTEGER,
  barons INTEGER,
  dragons INTEGER,
  dragons_clouds INTEGER,
  dragons_infernals INTEGER,
  dragons_mountains INTEGER,
  dragons_oceans INTEGER,
  dragons_hextechs INTEGER,
  dragons_chemtechs INTEGER,
  dragons_elders INTEGER,
  rift_heralds INTEGER,
  void_grubs INTEGER,
  atakhans INTEGER,
  PRIMARY KEY (game_key, side)
);

-- fact_player_game: Player statistics at one row per game per player.
CREATE TABLE fact_player_game (
  game_key INTEGER REFERENCES dim_game(game_key),
  event_key INTEGER REFERENCES dim_event(event_key),
  match_key INTEGER REFERENCES dim_match(match_key),
  date_key INTEGER REFERENCES dim_date(date_key),
  patch_key INTEGER REFERENCES dim_patch(patch_key),
  player_key INTEGER REFERENCES dim_player(player_key),
  team_key INTEGER REFERENCES dim_team(team_key),
  champion_key INTEGER REFERENCES dim_champion(champion_key),
  side TEXT,
  role TEXT,
  kills INTEGER,
  deaths INTEGER,
  assists INTEGER,
  cs INTEGER,
  gold INTEGER,
  damage INTEGER,
  vision INTEGER,
  PRIMARY KEY (game_key, player_key)
);

-- fact_draft_slot: One row per pick or ban, ordered and unordered drafts alike.
CREATE TABLE fact_draft_slot (
  game_key INTEGER REFERENCES dim_game(game_key),
  event_key INTEGER REFERENCES dim_event(event_key),
  match_key INTEGER REFERENCES dim_match(match_key),
  date_key INTEGER REFERENCES dim_date(date_key),
  patch_key INTEGER REFERENCES dim_patch(patch_key),
  side TEXT,
  phase TEXT,
  entry_index INTEGER,
  slot INTEGER,
  is_ordered INTEGER,
  champion_key INTEGER REFERENCES dim_champion(champion_key),
  PRIMARY KEY (game_key, side, phase, entry_index)
);

-- fact_player_honour: One row per distinction the source states for a player at a tournament.
CREATE TABLE fact_player_honour (
  player_key INTEGER REFERENCES dim_player(player_key),
  event_key INTEGER REFERENCES dim_event(event_key),
  team_key INTEGER REFERENCES dim_team(team_key),
  title TEXT,
  type TEXT,
  source_page TEXT,
  place TEXT,
  place_number INTEGER,
  PRIMARY KEY (player_key, event_key, title)
);
