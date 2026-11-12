# 04: Per-player statistics, and the invariant that ties them to the team

**Blocked by:** 03
**Status:** ready

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

- [ ] A complete fixture game yields ten player rows, five per side, one per role.
- [ ] Player kills and gold sum to the team totals for every complete game.
- [ ] A fixture player row the source left without a damage figure is emitted with
      that value absent, and the game's player coverage is marked partial.
- [ ] Roles come from the played position; a fixture where the source's role column
      disagrees with the pick order resolves to the played position.
- [ ] Items, trinket and summoner spells are emitted as structured references, not
      as free-text blobs.
- [ ] A player appearing twice in one game's payload fails the build, naming the
      game, instead of becoming a duplicated row.

## Validation

Build seam, with the sum invariant asserted over every fixture game claiming
complete player coverage. Covers spec R4 and the player half of R6.
