# 04: Per-player statistics, and the invariant that ties them to the team

**Blocked by:** 03
**Status:** done

## What to build

Ten player rows per complete game: player entity, team entity, champion entity,
role, side, kills, deaths, assists, CS, gold, damage to champions, vision score,
items, trinket, summoner spells, keystone and runes. Roles are the role actually
played, not the role the source labels when the two disagree.

For any game whose player coverage is complete, the players' kills and gold sum to
the team totals emitted in ticket 03. That check is why this ticket can trust its
own output.

## Scope

The player-game entity, its schema, and the player-statistics half of the coverage
record. Extends the invariant surface: sums between player rows and team rows.

Leaves for later tickets: ordered drafts, the full invariant gate.

## Acceptance criteria

- [x] A complete fixture game yields ten player rows, five per side, one per role.
- [x] Player kills and gold sum to the team totals for every complete game.
- [x] A fixture player row the source left without a damage figure is emitted with
      that value absent, and the game's player coverage is marked partial.
- [x] Roles come from the played position; a fixture where the source's role column
      disagrees with the pick order resolves to the played position.
- [x] Items, trinket and summoner spells are emitted as structured references, not
      as free-text blobs.
- [x] A player appearing twice in one game's payload fails the build, naming the
      game, instead of becoming a duplicated row.

## Decisions made while building

- `coverage.playerStats` is **presence-based**: complete means ten rows — five per
  side with one played role each — all state every R4 field and reconcile to the
  team totals; partial means structure or a field is missing, and unavailable
  means the corpus carries no player rows. The game's `era` label is still emitted
  separately. The 2015 rows state no damage, vision, keystone or runes and are
  therefore honestly `partial`; a full era-aware player field table is left for a
  later ticket rather than guessed from patch dates.
- A full `ScoreboardPlayers` payload was recorded in one CargoExport request using
  the exact fields from `cargofields`. It covers 171 games, including 42 IEM IX
  events the rule rejects; a row that names a game the rule rejected contributes
  neither a player row nor an identity observation. The earlier identity-only
  payloads carry no GameId and remain as identity evidence, not statistics.
  Without that filter those rejected events minted 15 teams, 76 players, 100
  aliases and 91 unresolved rows; the build now stays at 36 teams, 193 players,
  502 aliases and 165 unresolved rows.
- Role uses `IngameRole` (the played position) over `Role` (the source's label).
  No recorded row disagrees, so the case is tested on a scratch copy.
- The selection filter applies to every identity path: a scoreboard row naming a
  rejected game, a row naming no game whose page is under a rejected event, a game,
  and a series all stop minting once the rule excluded them. A page under a
  *selected* event is kept even when the rule rejected that page as an event of its
  own (`Worlds 2023 Main Event` is a stage subpage, not a separate event). Rows a
  payload carries with no game and a page the rule never considered stay as curated
  identity evidence — ticket 02's rename and duplicate fixtures depend on them.
  The scoreboard dedupe key includes `gameId`, so an overlapping identity-only copy
  can never blank a stat row's game and make the result depend on file order.
- Items, summoner spells and runes are lists of source names; canonical item/spell
  entities are a later concern. A repeated player link in one game — even an
  identical copy — stops the build naming the game; the same row arriving from two
  overlapping payloads still collapses, as overlap is normal for a crawl. A sum
  that disagrees with a team total on a complete game also stops the build.
- A present-but-unparseable `Side`, `DateTime_UTC` or scalar-instead-of-list
  `Items`/`SummonerSpells` stops the build rather than becoming an absence or a
  one-item list. Rows for rejected events are still fully validated before the
  selection filter: fail-loud is preferred to silently ignoring malformed bytes.
  The source's `Side` is cross-checked against the team resolved from the game.

## Validation

Build seam, with the sum invariant asserted over every fixture game claiming
complete player coverage. Covers spec R4 and the player half of R6.
