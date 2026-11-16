# 05: Drafts, with their fidelity recorded

**Blocked by:** 03
**Status:** done

## What to build

Each game carries its champion draft: bans and picks for both sides, in order where
the source preserved order, as sets where it did not — and the game says which one
it is.

For the ordered era the draft includes the side-switch fact when the source records
it, because a side-switched game otherwise reads as a malformed draft. For the
earlier era the draft is emitted as pick and ban sets with the fidelity marker set
to unordered. Order is never inferred from role order or from list position.

## Scope

The draft structure on the game entity, its schema, the two fidelity modes, and the
draft portion of the coverage record.

Leaves for later tickets: validating draft consistency against player rows beyond
champion membership, and the crawl.

## Acceptance criteria

- [x] An ordered fixture game round-trips its ban and pick slots per side in source
      order, including a game where the sides were switched.
- [x] A pre-2017 fixture game emits unordered sets and the fidelity marker says so.
- [x] A game with no draft data is emitted as explicitly unavailable — not as an
      empty list that reads as "no bans this game".
- [x] Every champion in a draft resolves to a canonical champion entity.
- [x] Reordering source slots changes emitted order only where the fidelity marker
      is ordered.
- [x] A duplicate champion within one side's picks fails the build.

## Decisions made while building

- The ordered source is `PicksAndBansS7`, recorded from the wiki for all 110 Worlds
  2023 fixture games (`Team1Pick1..5`, `Team1Ban1..5`, `SwitchedSides`). Every row in
  that payload states `SwitchedSides = 0`, and the source's switched rows are 2026
  games with no `ScoreboardGames` fixture. A second recorded payload of 20 switched
  rows is committed; the side-switch test carries its source facts onto a real 2023
  row in a scratch copy, so the assertion is about recorded bytes without inventing
  a committed game.
- `ScoreboardGames.Team*Picks`/`Team*Bans` are in **role order**, so they are a set
  under R5: sorted by canonical champion id, with no slot key. The 2015 rows state
  three bans a side, so their `coverage.draft` is honestly `partial`, not `complete`.
- Draft champion strings are identity observations. The recorded champion registry
  names only part of the draft vocabulary, so unmatched picks are minted and reported
  in `identity-unresolved.jsonl` rather than dropped. Draft rows for games the rule
  does not select mint nothing.

## Validation

Build seam, over an ordered fixture and an unordered fixture. Covers spec R5.
