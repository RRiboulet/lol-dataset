# 14: Series rows that disagree with their games, in the earliest events

**Blocked by:** 09
**Status:** done

## What to build

A decision, and then the code, for what to do when a `MatchSchedule` row names a
different pair of teams from the games that point at it.

Ticket 09 measured this on IPL 5 (2012), the earliest event that still carries games:
72 games, 720 player rows and 48 series fetched cleanly, but the game↔series team
invariant refused pairings whose teams disagree. Two causes are mixed together:

- **A legacy team name**: the game says `Counter Logic Gaming`, the series row says
  `CLG Prime`. That is an identity alias the registry does not know.
- **Apparent cross-match mixups**: for example a game `Meat Playground vs TSM` whose
  series row names `Singapore Sentinels vs Team Curse Europe`. Here the source's own
  `MatchSchedule` disagrees with its `ScoreboardGames` about which match the game
  belongs to.

Because of this, IPL 5 was deliberately **not** in the committed dataset, and the four
payloads crawled for it (games, players, series, drafts) were not in the fixture cache,
so the build could not fail on them. They sat under
`tools/dataset/fixtures/pending/`, which the build does not read, so this ticket started
from the real bytes rather than a re-crawl. What *is* still committed are two older payloads
recorded for ticket 02 — a `ScoreboardPlayers` query and a `Tournaments` row that name
IPL 5 — which is why `event-games.jsonl` reported the event as `missing` rather than
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

## The decision

**Both: option 1 for the legacy name, option 2 for the mixups.** They are different
facts about the source and they get different handling.

- **The legacy name is an identity fact, not a match fact.** `CLG Prime` and
  `Counter Logic Gaming` denote one team, so the fix belongs in the identity layer:
  `rules/identity-aliases.json` declares `CLG Prime` → `Counter Logic Gaming`. After
  that, the 12 games in those 6 series resolve to the series' team and stay attached;
  nothing about the source's match data had to be bent.
- **The mixups are a match-key fact.** Three pairs of series rows have their `MatchId`s
  swapped, so every game naming them names a series between two other teams. No alias
  can make two matches into one, so the relation is refused rather than repaired: the
  8 games are emitted with **no** `matchId` and counted, and the 6 contradicted series
  rows are **not** emitted, with their own count and reason.

### Why the declared alias needed a new target form

The file's existing entries target a page (team/player) or Riot's numeric id
(champion), because a display string is the thing that changes. That works when the
source's registries carry the entity — and for IPL 5 they do not: that crawl fetched
games, players, series and drafts, not `Teams`/`TeamRedirects`, so no page exists for
either `CLG Prime` or `Counter Logic Gaming` and a `page` target would be a build
failure naming a page nobody recorded.

A declaration therefore gained `aliasOf`: instead of pointing at a page, it states that
one observed source string denotes the same entity as **another observed source string**.
The target resolves through the registries first (so the form also works once a `Teams`
payload exists), and only mints the target string's provisional id when the corpus has
no registry row at all — which is the same id an undeclared observation would have
minted, so the answer never depends on read order. `aliasOf` refuses to chain onto
another declaration for the same reason, and a declaration whose `string` the registry
already states as an identity stays inert behind the registry, as before.

Spec R7 is untouched: the game rows keep `sourceTeam: "Counter Logic Gaming"` and the
series rows keep `sourceTeam: "CLG Prime"` beside the one canonical `teamId`.

### Why the contradicted series are dropped rather than emitted with zero games

`matches.jsonl` carries series rows whose games the corpus does not contain — IPL 5's
six wildcard-qualifier series have none, because the source has series rows for the
qualifiers and no scoreboard games. So "a match with no games" is an existing state,
and emitting a contradicted row would be *indistinguishable* from it: an analyst would
read "games missing" instead of "this row is contradicted". Dropping it, counting it and
naming it in the classification below says the true thing, and a source correction (or
a future crawl that proves the row's teams) can restore it deliberately. What is lost
is a series score the source attached to a key its own game rows refuse, and because
both halves of every swap are dropped, that score is no longer in the corpus at all:
the games remain, the series row and its score do not. The score is not silently moved
to the neighbouring key, which would be a guess dressed as a join.

### The invariant is tightened, not loosened

A game must still never be *attached* to a series between two other teams. The check
moved from "the assembler throws" to two places that still hold:

- the assembler **detaches** such a game instead of emitting it with a bad `matchId`;
- `invariants.ts` now checks every emitted game's `matchId` against its own sides, so a
  hand-edited `games.jsonl`, a bad merge or an assembler that stopped detaching fails
  the build (R10: invariants are enforced, not documented). `invariants.test.ts` covers
  exactly that.

What changed is where the source's contradiction lands — a reported detachment instead
of a refused event — not whether a game may sit in someone else's series.

## The classification, measured on the recorded bytes

The classification is *derived*, not remembered: pair every IPL 5 game with its series
row, compare the two source strings as sets (a side swap is legitimate), and ask
identity what each string denotes. `tools/dataset/test/series-rows.test.ts` does this
from the committed payloads on every run, so the numbers below cannot drift silently.

| Class | Pairings | Games | Series rows | Cause |
|---|---|---|---|---|
| Legacy name | 12 | 12 | 6 | `CLG Prime` (series) / `Counter Logic Gaming` (games) — one team, two strings |
| Cross-match mixup | 8 | 8 | 6 | three reciprocal `MatchId` swaps between pairs of series rows |

**Ticket 09's figure was 11 pairings (9 legacy + 3 mixups), and it does not reproduce**
on these bytes; 9 + 3 does not add up either. The exact measurement is 20 pairings, and
the split is 12/8. The test asserts the derivation and the counts rather than quoting
this paragraph, so a future crawl that changes the source moves the test, visibly.

The legacy class, in full — 6 series, 12 games, 60 player rows, 2012-11-29 to 2012-12-02:

| Series row | Game rows |
|---|---|
| `…_Group B_1` | `…_Group B_1_1` |
| `…_Group B_4` | `…_Group B_4_1` |
| `…_Group B_5` | `…_Group B_5_1` |
| `…_Loser's Round 4_1` | `…_Loser's Round 4_1_1`, `_2`, `_3` |
| `…_Winner's Round 2_3` | `…_Winner's Round 2_3_1`, `_2`, `_3` |
| `…_Winner's Round 4_2` | `…_Winner's Round 4_2_1`, `_2`, `_3` |

The declaration's evidence is stronger than the six rows: three of the *same event's*
wildcard qualifier series (2012-11-14 to 2012-11-17, four days earlier) already spell the
team `Counter Logic Gaming`, no game row ever says `CLG Prime`, and the two strings never
meet on opposite sides of a game.

The cross-match class, in full — three reciprocal swaps, 6 series, 8 games:

| Series row (teams it names) | Games that name it (teams they played) | The other half of the swap |
|---|---|---|
| `…_Group C_3` (Curse EU vs Sentinels) | `…_Group C_3_1` (TSM vs Meat Playground) | `…_Group C_4` |
| `…_Group C_4` (TSM vs Meat Playground) | `…_Group C_4_1` (Curse EU vs Sentinels) | `…_Group C_3` |
| `…_Group D_3` (Taipei Assassins vs Moscow Five) | `…_Group D_3_1` (Team Curse vs Blackbean) | `…_Group D_4` |
| `…_Group D_4` (Blackbean vs Team Curse) | `…_Group D_4_1` (Taipei Assassins vs Moscow Five) | `…_Group D_3` |
| `…_Loser's Round 1_2` (Azubu Blaze vs Blackbean) | `…_Loser's Round 1_2_1`, `_2` (Curse vs Dynamic) | `…_Loser's Round 1_3` |
| `…_Loser's Round 1_3` (Team Curse vs Team Dynamic) | `…_Loser's Round 1_3_1`, `_2` (Azubu vs Blackbean) | `…_Loser's Round 1_2` |

Each row's teams are exactly the other row's games' teams, which is why this is a swap
rather than six unrelated contradictions — and why "reattach by team pair" was rejected:
it would be a guess dressed as a join, and a team pair can legitimately meet twice in an
event.

## What changed in the build

- `tools/dataset/rules/identity-aliases.json` gains the team declaration (`aliasOf`), and
  `tools/dataset/identity.ts` gains the `aliasOf` target form with its validation.
- `tools/dataset/games.ts` detaches a contradicted game, drops a series every game
  contradicts, and returns both reports on `ScoreboardAssembly`
  (`detachedGames`, `contradictedMatches`); `tools/dataset/cli.ts` prints both counts
  with the series ids.
- `tools/dataset/invariants.ts` refuses an emitted game whose `matchId` names a series
  between two other teams.
- IPL 5's four payloads moved from `fixtures/pending/` to `fixtures/raw/`, so the build
  reads them and the manifest pins them; `fixtures/pending/` is **removed**, not left as
  a second cache the build has to be taught to ignore (spec D6 updated).
- `data/curated/` now carries IPL 5: 277 games (was 205), 132 matches, 2 770 player rows,
  and the event report says `recorded` for `IGN ProLeague Season 5`.

## Acceptance criteria

- [x] Every disagreeing pairing in the recorded IPL 5 payloads is classified as either
      a legacy name or a cross-match mixup, and the classification is committed.
- [x] Legacy names resolve through declared aliases, with the source string preserved
      on the row (spec R7), rather than by a hard-coded string comparison.
- [x] Cross-match mixups are handled by the chosen strategy, and the build's summary
      names how many games that affected (8 games, 6 series rows).
- [x] IPL 5 builds, validates and passes the invariant gate.
- [x] The behaviour is covered by a fixture built from the recorded payloads, so a
      future crawl cannot regress it silently.

## Validation

Build seam over the recorded IPL 5 payloads (`tools/dataset/test/series-rows.test.ts`),
the invariant gate (`tools/dataset/test/invariants.test.ts`), and the CLI's summary
through `build --check`. Covers spec R2, R7 and R10 on the earliest era.
