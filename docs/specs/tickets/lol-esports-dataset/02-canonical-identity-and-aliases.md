# 02: Canonical identity and aliases

**Blocked by:** 01
**Status:** ready

## What to build

Every team, player and champion referenced anywhere in the dataset resolves to a
canonical ID, and a source display string that has changed over time resolves to
the same entity it did before. Renames recorded in fixtures — a team that
rebranded, a player who changed handle, a champion Riot renamed — each yield
**one** entity with a dated alias history, not two entities and a duplicate.

A build that adds an earlier event must not renumber existing entities.

## Scope

The identity module, the team/player/champion entity files and their schemas, and
the alias table. Reference resolution rules: exact source identity first, then the
alias table, then a new entity — never a fuzzy match that silently merges two
distinct people.

Leaves for later tickets: joining those entities into games and player rows.

## Acceptance criteria

- [ ] A rename pair in the fixtures resolves to one canonical entity carrying both
      display strings with the era each applied to.
- [ ] The entity's ID does not change when its display name changes.
- [ ] Adding a fabricated earlier event to the fixtures mints new IDs without
      altering existing ones.
- [ ] Two different players with the same display string remain two entities.
- [ ] An unresolved source string creates a new entity and is reported, rather than
      failing the build or being dropped.
- [ ] The alias table round-trips: given a source string and a date, the resolved
      canonical ID is stable.
- [ ] Every emitted reference carries the entity's human-readable display name
      beside its canonical ID, so no row requires decoding an identifier to be read
      (spec R12).

## Validation

Build seam, with fixtures containing each rename case and the duplicate-name case.
Covers spec R7.
