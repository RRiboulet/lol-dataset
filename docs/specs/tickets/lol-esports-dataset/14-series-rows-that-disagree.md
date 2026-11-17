# 14: Series rows that disagree with their games, in the earliest events

**Blocked by:** 09
**Status:** ready

## What to build

A decision, and then the code, for what to do when a `MatchSchedule` row names a
different pair of teams from the games that point at it.

Ticket 09 measured this on IPL 5 (2012), the earliest event that still carries games:
72 games, 720 player rows and 48 series fetched cleanly, but the game↔series team
invariant refused **11 pairings**. Two causes are mixed together:

- **A legacy team name**: the game says `Counter Logic Gaming`, the series row says
  `CLG Prime` (9 games). That is an identity alias the registry does not know.
- **Apparent cross-match mixups**: for example a game `Meat Playground vs TSM` whose
  series row names `Singapore Sentinels vs Team Curse Europe`. Here the source's own
  `MatchSchedule` disagrees with its `ScoreboardGames` about which match the game
  belongs to.

Because of this, IPL 5 is deliberately **not** in the committed dataset, and the four
payloads crawled for it (games, players, series, drafts) are not in the fixture cache,
so the build cannot fail on them. What *is* still committed are two older payloads
recorded for ticket 02 — a `ScoreboardPlayers` query and a `Tournaments` row that name
IPL 5 — which is why `event-games.jsonl` reports the event as `missing` rather than
`empty`: those rows never asked for games.

## What has to be decided

The invariant is right to refuse a game attached to a series between two other teams
— the ticket-03 review added it for exactly that reason. What is not yet decided is
which of these is the honest handling:

1. **Fix the name, keep the series.** Declare the legacy alias (`CLG Prime` →
   the CLG entity) in `rules/identity-aliases.json`, and treat only the genuinely
   cross-matched rows as errors. This is a per-name human judgement, which is what
   that file exists for.
2. **Detach the game.** When a series row's teams disagree with a game, emit the game
   *without* a `matchId`, report it in the build's summary, and do not emit the orphan
   series. Keeps the game data and the series score separate rather than inventing a
   relationship.
3. **Refuse the event.** Report the event as unbuildable and leave it out until the
   source is corrected, which is what ticket 09 did for IPL 5.

Option 1 should be tried first and only for the legacy names: the cross-matched rows
cannot be fixed that way, because no alias makes two different matches one match.

## Acceptance criteria

- [ ] Every disagreeing pairing in the recorded IPL 5 payloads is classified as either
      a legacy name or a cross-match mixup, and the classification is committed.
- [ ] Legacy names resolve through declared aliases, with the source string preserved
      on the row (spec R7), rather than by a hard-coded string comparison.
- [ ] Cross-match mixups are handled by the chosen strategy, and the build's summary
      names how many games that affected.
- [ ] IPL 5 builds, validates and passes the invariant gate, or the event is recorded
      as excluded with the reason and the measurement.
- [ ] The behaviour is covered by a fixture built from the recorded payloads, so a
      future crawl cannot regress it silently.

## Validation

Build seam over the recorded IPL 5 payloads, plus the invariant gate. Covers spec R2,
R7 and R10 on the earliest era.
