# 02: Every champion row states its release date

**Blocked by:** 01 (landing order: same data files, no code dependency)
**Status:** ready

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

- [ ] All 171 committed champions carry `releaseDate`, and each value equals the fixture
      row for that champion's Riot id.
- [ ] A fixture row with a coarser precision fails the build with a message naming the
      champion; a fixture pair disagreeing on the date fails with a message naming both
      payloads. Both are tests over fixtures, no network.
- [ ] A champion with no registry row (a minted one, if one ever appears) omits the key,
      and the model writes empty rather than a zero or a sentinel date.
- [ ] The model column is a plain ISO date string, not a `date_key`, and the data
      dictionary says why.
- [ ] The emitted output is byte-identical across two builds; `build --check` and
      `model --check` are clean; no other entity file changes.
- [ ] Both dictionaries are regenerated in the same change.

## Validation

The build seam over the committed payloads plus the two guard tests
(`tools/dataset/test/`), then the invariant/model gate over the committed data. Covers
spec B1, B2, B3 and B13, and decisions D1, D2 and D7.

Landing order: second in the linear chain 01 → 02 → 03 → 04 → 05. The blocking edge is
an ordering decision, not a code dependency: 01 and 02 do not touch each other's code,
but both regenerate `data/curated/manifest.json` and `data/model/`.
