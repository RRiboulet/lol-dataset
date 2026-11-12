# 05: Drafts, with their fidelity recorded

**Blocked by:** 03
**Status:** ready

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

- [ ] An ordered fixture game round-trips its ban and pick slots per side in source
      order, including a game where the sides were switched.
- [ ] A pre-2017 fixture game emits unordered sets and the fidelity marker says so.
- [ ] A game with no draft data is emitted as explicitly unavailable — not as an
      empty list that reads as "no bans this game".
- [ ] Every champion in a draft resolves to a canonical champion entity.
- [ ] Reordering source slots changes emitted order only where the fidelity marker
      is ordered.
- [ ] A duplicate champion within one side's picks fails the build.

## Validation

Build seam, over an ordered fixture and an unordered fixture. Covers spec R5.
