# 03: Games, with both sides and team statistics

**Blocked by:** 02
**Status:** ready

## What to build

For a selected event, every game it played appears exactly once, identified
stably, attached to its event and to two team entities, with its date in UTC, its
patch where the source has one, its duration, its winner, and the per-side team
statistics: kills, deaths, gold, towers, inhibitors, dragons by elemental type,
barons, rift heralds, void grubs, atakhans.

A game whose source did not record a statistic says so. It never reports zero for
a value nobody recorded, and it never reports itself fully covered when it is not.

## Scope

The game entity, its schema, the join from event to game to team, and the per-game
coverage record for the team-statistics group. Also records the source identifiers
for each game so it can be walked back to its source page.

Leaves for later tickets: player rows, drafts, the manifest, and the crawl.

## Acceptance criteria

- [ ] A fixture event yields exactly the games played — no duplicates, no omissions
      — and no game is orphaned from an event.
- [ ] Every emitted game has exactly two sides and exactly one winner.
- [ ] A fixture game the source left without, say, baron counts is emitted with that
      value absent and its coverage marked partial, not with zeros.
- [ ] A fixture game with no patch recorded is emitted with an absent patch and a
      coverage note, not an empty string.
- [ ] Duration and date are emitted in one fixed representation across the fixtures.
- [ ] Source identifiers for each game are present wherever the source provided
      them.

## Validation

Build seam, over fixtures spanning one pre-2017 event and one 2017+ event. Covers
spec R2, R3 and the per-game half of R6.
