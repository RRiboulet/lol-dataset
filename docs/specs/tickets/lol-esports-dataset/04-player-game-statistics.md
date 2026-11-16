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

- `coverage.playerStats` is **presence-based**: complete means ten rows all state
  every R4 field, partial means at least one field is missing, and unavailable
  means the corpus carries no player rows. The game's `era` label is still emitted
  separately. The 2015 rows state no damage, vision, keystone or runes and are
  therefore honestly `partial`; a full era-aware player field table is left for a
  later ticket rather than guessed from patch dates.
- A full `ScoreboardPlayers` payload was recorded in one CargoExport request using
  the exact fields from `cargofields`. It covers 171 games, including 42 IEM IX
  events the rule rejects; only player rows joining an emitted game become rows or
  identity observations. The earlier identity-only payloads remain as identity
  evidence and are not reread as statistics.
- Role uses `IngameRole` (the played position) over `Role` (the source's label).
  No recorded row disagrees, so the case is tested on a scratch copy.
- Items, summoner spells and runes are lists of source names; canonical item/spell
  entities are a later concern. A repeated player link in one game, or a sum that
  disagrees with a team total on a complete game, stops the build naming the game.

## Validation

Build seam, with the sum invariant asserted over every fixture game claiming
complete player coverage. Covers spec R4 and the player half of R6.
