# 02: Every champion row states its release date

**Blocked by:** 01 (landing order: same data files, no code dependency)
**Status:** done

## What to build

`data/curated/champions.jsonl` gains a `releaseDate`: the day the champion entered the
game, as the registry row that already anchors the champion's identity states it, so
`Ahri` reads `2011-12-14`. **No request is needed**: the committed `Champions` payloads
are already fetched with `Name,KeyInteger,ReleaseDate`, all 217 of their rows carry a
value, and every one of the 171 curated champions has a non-null registry row. The
normalizer simply never read the column.

Two guards come with it, because the empty case and the disagreeing case are the two
ways a date becomes a lie:

1. **Precision.** The source states how precisely it knows the date
   (`ReleaseDate__precision`, measured `1` — day — on every row today). A row whose
   precision is coarser fails the build naming the champion, rather than the dataset
   claiming a day the source does not.
2. **Agreement.** Two registry rows that carry the same Riot champion id must agree on
   the date; if they do not, the build fails and names both payloads, the way it already
   fails on two display names for one id.

The date is a dated **attribute** of the champion dimension, not a foreign key into
`dim_date`: `dim_date` is the calendar of the games the facts describe, and putting
2009–2026 release dates in it would add rows no fact can reach (spec D7).

## Scope

- `champions.jsonl`, its schema and the regenerated curated dictionary.
- The champion normalizer, the source and curated champion record types, and the two
  guards above with their messages.
- The model's `dim_champion` gains the column, with the generated DDL and model
  dictionary.
- `docs/dataset/using-the-dataset.md`: the column, and why the dimension does not join
  to `dim_date`.

Leaves for later: champion statistics, lore, skins, price, kit — the date is the whole
of this ticket. No new payload, no crawl.

## Acceptance criteria

- [x] All 171 committed champions carry `releaseDate`, and each value equals the fixture
      row for that champion's Riot id.
- [x] A fixture row with a coarser precision fails the build with a message naming the
      champion; a fixture pair disagreeing on the date fails with a message naming both
      payloads. Both are tests over fixtures, no network.
- [x] A champion with no registry row (a minted one, if one ever appears) omits the key,
      and the model writes empty rather than a zero or a sentinel date.
- [x] The model column is a plain ISO date string, not a `date_key`, and the data
      dictionary says why.
- [x] The emitted output is byte-identical across two builds; `build --check` and
      `model --check` are clean; no other entity file changes.
- [x] Both dictionaries are regenerated in the same change.

## Validation

The build seam over the committed payloads plus the two guard tests
(`tools/dataset/test/`), then the invariant/model gate over the committed data. Covers
spec B1, B2, B3 and B13, and decisions D1, D2 and D7.

Landing order: second in the linear chain 01 → 02 → 03 → 04 → 05. The blocking edge is
an ordering decision, not a code dependency: 01 and 02 do not touch each other's code,
but both regenerate `data/curated/manifest.json` and `data/model/`.

That prediction held, and is worth recording because the same conflict returns for 03–05.
Rebasing this ticket onto the merged 01 hit four conflicts, exactly one of them a prose
decision:

- `CHANGELOG.md` — two `Added:` blocks under `Unreleased`; both bullets kept.
- `docs/dataset/using-the-dataset.md` — both branches extended the same entity-file row;
  the row now names both attributes.
- `tools/dataset/test/model.test.ts` — both added a dimension test at the same anchor;
  both kept, team first.
- `data/curated/manifest.json` — generated, so it was taken from the base and rebuilt; no
  hand-merge was possible or needed. The build, the model and the dictionaries were
  regenerated after the rebase, and only the manifest actually moved.

## Outcome

The column needed no crawl, and the guards are all reachable from the recorded payloads:

- **171 of 171 champions carry a date**, each equal to its registry row (compared against
  the payloads, not against a rebuild of the same code). The corpus spans **2009-02-21**
  (shared by the 17 launch champions) to **2026-06-24**, and `Ahri` reads `2011-12-14`.
- **Seven tests**, one file (`tools/dataset/test/champions.test.ts`): the fixture-wide
  value check, and one per way the date could lie — precision, disagreement, unreadable
  value, and a well-shaped day that does not exist — plus two cases about what absence
  means: a payload that does not ask for the column is silent rather than disagreeing,
  and a minted champion carries no date in either layer. Each negative case is a scratch
  copy of the recorded payloads with one field changed, and the narrow pull is found by
  content (a strict subset of another payload's champions) rather than by row count, so a
  re-record cannot turn a case into a no-op.
- **Two guards the ticket did not spell out** came out of writing them, both the same
  class of lie as B2's: a `ReleaseDate` the source states but no parser can read fails
  instead of becoming an absent key, and a value that passes a shape check without being
  a day — `0000-00-00`, `2010-02-31`, `2010-13-01`, an instant — fails too. The calendar
  check is a round trip through `Date.UTC`, not a regex.
- **The precision marker is checked before the value**, because a coarser stamp arrives in
  a shape this schema cannot hold (`2011-12`): judging the value first reports a parse
  error for what is really a precision refusal, which names the wrong defect.
- **An absence is not a disagreement.** A payload that omits `ReleaseDate` is silent about
  it, so the stated value travels (as `Teams.Short` already does) and only two *stated*
  days that differ stop the build. The symmetric risk — every `Champions` query
  re-recorded without the column — would produce dateless rows rather than a failure, so
  the fixture-wide test asserts the column is stated at all.
- **`dim_champion.release_date` is an attribute, not a `date_key`** (spec D7), and the
  guide says so beside the model, because "join the date dimension" is the first thing a
  star-schema reader will try.
