# 03: Games, with both sides and team statistics

**Blocked by:** 02
**Status:** done

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

- [x] A fixture event yields exactly the games played — no duplicates, no omissions
      — and no game is orphaned from an event.
- [x] Every emitted game has exactly two sides and exactly one winner.
- [x] A fixture game the source left without, say, baron counts is emitted with that
      value absent and its coverage marked partial, not with zeros.
      *Measured instead: barons are present in 2015. What the source does not record
      there is `Inhibitors` and every per-element dragon count, while the dragon
      total is, so the criterion points at those.*
- [x] A fixture game with no patch recorded is emitted with an absent patch and a
      coverage note, not an empty string.
      *No recorded game lacks a patch, so the absence is made in a scratch copy of a
      real payload (`test/games.test.ts`), not invented.*
- [x] Duration and date are emitted in one fixed representation across the fixtures.
- [x] Source identifiers for each game are present wherever the source provided
      them.

## Validation

Build seam, over fixtures spanning one pre-2017 event and one 2017+ event. Covers
spec R2, R3 and the per-game half of R6.

## What the recording actually found

The ticket was written before any game row existed. Three findings changed its shape
and are recorded here rather than left in the diff:

- **World Cyber Games 2013 has no per-game scoreboard at all.** The query for that
  selected event returned zero rows, and so did a `LIKE '2013 World Cyber Games%'`
  probe, so this is the source, not a filter. The empty payload is kept as a fixture:
  it is what separates "the source has no games for this event" (`empty` in
  `event-games.jsonl`) from "nobody fetched this event" (`missing`). The pre-2017
  fixture is **IEM Season IX World Championship 2015** instead, 19 games.
- **`ScoreboardGames` has no `Deaths` and no `Assists` column** for either side (69
  fields, measured with `cargofields`). R3's "deaths" can only be derived from the
  opponent's kills, and executions make that false, so it is not emitted at all.
- **The match layer came with it.** The scope above names the game entity, but every
  game row points at a series and spec D1 makes the match a level of the grain, so
  `MatchSchedule` got a normalizer and `matches.jsonl` exists too: the series score is a
  source fact that counting games cannot recover (a forfeit or a nullified series breaks
  the arithmetic). The games carry a canonical `matchId` only when their series row was
  recorded, so the reference never dangles.
- **The `Patch` column is numerically lossy**: a 2014-07-20 row states `4.1` where the
  patch was 4.10, and `LegacyPatch` repeats it while `PatchSort` is null. The dataset
  therefore carries the digits the source sent, as text, and pads nothing.

Two decisions the source forced, both recorded where they are implemented:
`ScoreboardGames.Team1`/`Team2` are **sides** (a side-swapped series puts a team on
both), while `MatchSchedule.Team1`/`Team2` are only source column positions — a
match carries `sourceOrder`, never a fabricated blue/red side. Coverage is judged
against `tools/dataset/rules/game-eras.json` so a 2015 game is not called `partial`
for want of a void grub that did not exist until patch 14.1.
