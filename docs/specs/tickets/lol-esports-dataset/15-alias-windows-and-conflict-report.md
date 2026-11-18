# 15: Alias windows, evidenced targets, and a committed series-conflict report

**Blocked by:** 14
**Status:** done

## What to build

Ticket 14 settled IPL 5's disagreeing series rows, and a review of the merged change
found four defects. None of them changes the decision; each one closes a gap between what
the change claims and what the bytes, the code or `data/curated/` actually say.

| # | Severity | Defect |
|---|---|---|
| B1 | MEDIUM | A declared alias `from`/`until` window is consulted only to break a tie, so a string resolves outside its declared era; an inverted window is accepted. |
| B2 | MEDIUM | An `aliasOf` target that names a team the declared string never meets builds green — only the detached/contradicted counts move. |
| B3 | LOW | The detached games and dropped series exist only in the build's stdout, so a reader of `data/curated/` cannot tell "series contradicted" from "series never fetched". |
| B4 | LOW | Two evidence statements in the decision record contradict the recorded bytes. |

## Scope

`tools/dataset/identity.ts`, `tools/dataset/rules/identity-aliases.json`,
`tools/dataset/games.ts`, `tools/dataset/cli.ts`, the new report's schema and data,
the tests for these behaviours, ticket 14's corrections, `CHANGELOG.md` and `AGENTS.md`.
The model layer (`tools/dataset/model.ts`, `data/model/`) and `manifest.ts` are not in
scope; the committed `data/curated/` is rebuilt from the current fixtures rather than
hand-edited, because ticket 10 is rebuilding it concurrently.

## B1 — a declared era must bound every lookup

`identity.ts`'s `pick()` returns immediately when a string names one candidate, so a
declared `from`/`until` was only ever read when two candidates needed a tie-break. Two
probes showed it: with `until: 2012-11-30`, resolving `CLG Prime` on 2012-12-02 still
returned the alias entity; and `from` after `until` loaded without complaint.

**Fix.** A declared era now filters candidates before `pick()` decides, on the alias and
folded tiers where declarations live. If the filter removes every candidate the lookup
returns no entity, so an observation follows the existing unresolved path (mint, report)
instead of silently joining the declared entity. Registry identities are not bounded by a
declaration: the source's own statement still wins. `loadDeclaredAliases()` refuses a
window whose `until` precedes its `from`, naming the declaration.

## B2 — an `aliasOf` target needs corpus evidence

`aliasOf` exists for a string no registry carries, so there is no page or id to check the
target against. Pointing `CLG Prime` at `TSM` changed only the detached/contradicted
counts and still built. Self-targets and chains were already refused, but nothing tested
them, and nothing checked that the two strings had anything to do with each other.

**Fix.** The build derives the evidence rather than trusting the declaration's prose: a
recorded game and the series row it names must put the declared string on one side and the
target on the same side (the same opponent). IPL 5's `CLG Prime` series rows and their
`Counter Logic Gaming` games satisfy that; a target that never shares a side fails the
build, naming both strings. The check applies to a declaration whose string the corpus
actually uses and whose string the registry does not already state, so an identity-only
fixture set and an inert registry-backed declaration both stay buildable.

Tests now cover a self-target, a chain, a wrong target, the minted-target id, and the
registry-wins case.

## B3 — the conflicts are a committed report, not stdout

The build now returns one `SeriesConflictRecord` per detached game and per contradicted
series, and writes `data/curated/series-conflicts.jsonl` beside the entities. The schema
is `data/curated/schema/series-conflicts.schema.json`, the file is in `OUTPUTS` and so in
the manifest's entity digests, and the rows are sorted and byte-stable like
`event-selection.jsonl` and `event-games.jsonl`.

Each row carries its kind (`detached-game` or `contradicted-series`), the event id and
name, the canonical game and match ids, the source `GameId`/`MatchId`, and both canonical
team pairs sorted by team id. The source strings remain on the game and match rows (spec
R7); the report is what makes the two states distinguishable in the committed data.

Measured on the recorded fixtures: **14 rows — 8 detached games and 6 contradicted
series**, all in IPL 5.

## B4 — the decision record says what the bytes say

`rules/identity-aliases.json` said "all 12 series rows that mention it say `CLG Prime`".
The bytes say six series rows use `CLG Prime` and three use `Counter Logic Gaming` (the
wildcard qualifiers, 2012-11-16 to 2012-11-17). It also called `from` "the first date
either string is used", while the alias table dates `Counter Logic Gaming` from
2012-11-16; `from` is the first date the declared string `CLG Prime` is used, and the
prose now says so. Ticket 14 claimed the contradicted teams' score "is not simply gone
from the corpus", but both rows of every swap are dropped — the score is gone, and the
ticket now says that rather than implying it moved to the neighbouring key.

A test pins the corrected counts: six `CLG Prime` series sides, three `Counter Logic
Gaming` series sides, twelve `Counter Logic Gaming` game sides and no `CLG Prime` game
side.

## Acceptance criteria

- [x] A declared alias era bounds resolution for a single candidate as well as an
      ambiguous one; resolving outside the window yields no entity and follows the
      unresolved path rather than merging silently.
- [x] An inverted declared window stops the build at load, naming the declaration.
- [x] An `aliasOf` target that never shares a series side with the declared string stops
      the build; self-targets and chains are covered by tests, and the registry still wins.
- [x] `data/curated/series-conflicts.jsonl` exists, is schema-validated, sorted,
      byte-stable, in `OUTPUTS`, and in the manifest's entity digests.
- [x] The report carries one row per detached game and per contradicted series (8 + 6),
      with ids, event and both team pairs.
- [x] The evidence prose in `rules/identity-aliases.json` and ticket 14 matches the
      recorded bytes.
- [x] `node tools/check.ts` and `build --check` pass over the rebuild.

## Decisions made while building

- **Evidence is derived from the game↔series link, not from a declaration of source
  rows.** A row list would be another hand-maintained claim; the game and its series row
  are already in the corpus, and requiring the same opponent distinguishes "these strings
  name one side" from "these strings played each other".
- **A declaration no corpus row uses is not failed for want of evidence.** The check
  applies once the declared string is observed, which keeps a fixture set that carries
  only identity or events buildable without pretending its declarations are evidenced.
- **A declaration behind a registry identity stays inert and is not evidence-checked.**
  The registry's own statement wins, so the declaration merges nothing.
- **The report keeps canonical ids beside the source ids.** The source string stays on
  the game/match row (R7), while the report's team pairs are canonical so a reader can
  join to `teams.jsonl` without decoding the source's spelling.
- **`series-conflicts.jsonl` is a new entity file, not a field on `matches.jsonl`.** A
  contradicted series is deliberately not emitted, so it needs a row of its own to exist
  at all; a field on a missing row cannot say anything.

## Validation

- `tools/dataset/test/identity.test.ts` — B1 windows (single candidate, inverted load,
  observation outside the window), B2 self-target/chain/wrong target/minted id/registry
  wins, alongside the existing rename, ambiguity and declaration tests.
- `tools/dataset/test/series-rows.test.ts` — the 14-row report's schema, ordering,
  committed bytes, reconciliation with the emitted games/matches, and the corrected
  6/3/12 source-string counts.
- `tools/dataset/test/games.test.ts` and `test/provenance.test.ts` — byte identity,
  committed currency and the manifest's new entity file.
- `node tools/check.ts` and
  `node tools/dataset/cli.ts build --raw tools/dataset/fixtures/raw --check`.
