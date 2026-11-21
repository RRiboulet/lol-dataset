# 03: A tournament distinction is a curated record

**Blocked by:** 02 (landing order: same data files, no code dependency)
**Status:** done

## What to build

A new curated file, `data/curated/honours.jsonl`, holds one row per player distinction
the source states on an **admitted tournament's** page: Worlds MVP, MSI finals MVP, an
All-Pro team, Best Coach. Decided 2026-11-21: the tournament's distinctions, not the
season's — `LCS/2024 Season/Spring Season` awards are out, and the event rule is the
boundary, so nothing has to filter titles.

The source's table is `IndividualAchievements`, measured live: `Player`, `Link`, `Team`,
`OverviewPage`, `Display`, `Place`, `Place_Number`, `AchievementType`, `Description`.
`AchievementType` has exactly **one** value, `Season Award`, for tournament MVPs and
regional season awards alike, so the distinction is the free-text `Display` and the
dataset must not pretend to a controlled vocabulary. Titles stay as stated
(`Most Valuable Player`, `Finals MVP`, `MSI MVP` — three strings for the same idea).

Two measured wrinkles shape the resolution:

- `Link` is null on exactly the tournament-MVP rows and populated on the regional ones,
  so the player identity has to resolve from `Player`, which is a page name **or** one of
  its aliases — `knight (Zhuo Ding)` denotes the page `Knight (Zhuo Ding)` through
  MediaWiki's first-letter case rule, and the player registry already carries it.
- The award's page can be the event's page or a stage sub-page of it: `2014 Season World
  Championship` and `2024 Season World Championship/Main Event` are the same event.

The crawl gains a fifth per-event query so the rule that decides events decides awards
too. One admitted event's awards — plus one whose awards sit on a stage sub-page — are
recorded as fixtures, and the build reads them exactly as it will read the crawl.

## Scope

- The plan generator's fifth per-event query (`IndividualAchievements`, the same
  `LIKE '<event page>%'` rule, ordered so paging is stable), and the plan test that pins
  a generated query against the committed plan.
- The normalizer, its source type, the identity resolution for the award's player, and
  the curated record type with an `hn-` id derived from the source tuple (event page,
  player page, title, source page) so a re-crawl cannot renumber.
- `honours.jsonl` and `honour.schema.json` in `OUTPUTS` and in the generated curated
  dictionary; the identity emitted set so a player named only by an honour is emitted;
  the invariant gate widened from "every emitted player is named by a player-game row" to
  "…or by an honour row", plus uniqueness and reference checks for the new records; the
  tamper report's table→files map.
- `docs/dataset/using-the-dataset.md`: the file, its grain, its joins.

Leaves for later: the model table (04) and the full 54-event crawl (05). Team strings are
**not** resolved into new entities: the source's string is carried, and the resolved team
id is emitted when the registry already knows it (spec D8).

## Acceptance criteria

- [x] An award stated on an admitted event's page, and one stated on a stage sub-page of
      it, both resolve to that event; an award from a regional season page or a rejected
      event is never queried and never emitted.
- [x] A row carries the player id, the event id, the page the award was stated on, the
      title as stated, the award type, the source's team string, the resolved team id
      when the registry resolves it, and place/place number when stated. The source's
      `Description` is deliberately not carried (see B6): it is markup, not a description.
- [x] Player resolution is proved on the measured cases: a page name; the alias
      `knight (Zhuo Ding)` → `Knight (Zhuo Ding)`; a coach with no player-game row (emitted
      and accepted by the gate); a handle shared by two pages (reported in
      `identity-unresolved.jsonl`, never guessed).
- [x] A team string the registry cannot resolve keeps the string, leaves the team id
      absent, mints no team row, and does not fail the build.
- [x] Reading one payload twice produces one row per award; two awards with different
      titles at the same event and player produce two rows; a second build reproduces the
      same ids.
- [x] The payload is pinned in the manifest, the tamper report names `honours.jsonl` for
      it, and the curated dictionary is regenerated in the same change.
- [x] `build --check` is clean, the test suite needs no network, and two builds are
      byte-identical.

## Validation

S1 (`buildDataset` over the new fixtures, end to end), S3 (the player-resolution table
above), S4 (the plan test), then the invariant gate over the committed data. Covers spec
B6–B10, B12 and B13.

Budget note: recording the fixtures is two Cargo requests at the measured 75s interval,
not a crawl. If the award rows turn out to need a second page, that is one more.

Landing order: third in the linear chain 01 → 02 → 03 → 04 → 05. The blocking edge is an
ordering decision, not a code dependency: this ticket could be built on its own, but it
regenerates `data/curated/manifest.json`, the curated dictionary and the fixtures, which
01 and 02 already moved.

## Outcome

Built over two recorded payloads — `2016 Mid-Season Invitational` (six rows: the MVP and
five All-Pro places) and `2024 Season World Championship/Main Event` (one finals MVP) —
which emit **7 rows**, and one full build (§the fixtures) is the reviewable evidence for
every decision below.

- **The page→event join is the repo's one rule, not a copy.** `eventForPage` (moved into
  `pages.ts`, so the scoreboard assembly and the distinctions share it) applies
  `pageUnderEvent` — qualifier segments are not the event — and the longest match wins, so
  overlapping event names cannot steal each other's rows. A page under no admitted event is
  **dropped and counted**, not absorbed and not fatal: the crawl asks by prefix, so a
  qualifier page under an admitted event arrives legitimately and B8 keeps it out. The
  build prints the count (`honours: N row(s), M page(s) outside the admitted events`), the
  way a silently empty crawl must not pass for "the source states no awards".
- **Players resolve from `Player`, because `Link` is null on every recorded row.** A page
  name resolves as itself, and a handle through the registry (`xiaohu` → `Xiaohu`,
  `mlxg` → `Mlxg`). A player named only by an award is observed like any other reference,
  so the entity is emitted and an unknown one is reported: tested with a made-up coach, who
  lands in `players.jsonl` and `identity-unresolved.jsonl`.
- **A team string is context, never an entity.** `SKT T1` resolves to `T1` through the
  alias registry; a string nothing carries stays on the row with no `teamId` and **mints
  nothing** — the first implementation observed the string (copying the player path) and
  the test caught a team invented from an award, so the observation was removed. A string
  that names several teams resolves to none of them (the ambiguity guard), because the row
  still reads without it.
- **`Description` is not carried**, and the spec says why: it is `-` or roster wikitext,
  not a description. The plan therefore does not ask for the column, so the fixture payloads
  and the crawl plan describe the same query.
- **The crawl gained a fifth per-event query** (`IndividualAchievements`, same prefix rule,
  ordered by `Player`), and `plan.test.ts` now asserts the generated plan is the committed
  one plus exactly that table — every committed query still has to match byte for byte, or
  the fixture's cache key would move.
- **The invariant gate widened by one clause**, as the spec required: a player named by an
  honour counts as referenced, so a coach is legal while an orphan entity still is not;
  distinctions also get unique-id and event/player/team reference checks.
- **Five tests** (`honours.test.ts`) cover the resolved shape, the schema, the
  out-of-scope award, the coach, the unresolvable team, and the folded duplicate.

Left for ticket 04: the model fact. Left for ticket 05: the 54-event crawl.

### Review follow-up (same branch)

One review read the change; every finding below was fixed in a second commit rather than
argued away, because each is the kind that returns in ticket 05:

- **The page→event rule was a third copy** and weaker than the two it duplicated: it did
  not exclude qualifier pages and it picked the first match instead of the longest. Now
  shared through `pages.ts`, with the outside-the-event case counted (`honoursOutside`).
- **`plan.test.ts` could not catch a field-list drift** in the new query, because the
  committed plan predates the table. It now compares the generated query against the
  recorded payload's own sidecar — the committed record of what was fetched.
- **The award id included the source page**, so the same award on an event's page and on
  its `/Main Event` page was two rows against a documented grain of one. The id is now
  (event, player, title); the page stays as provenance.
- **`IndividualAchievements` feeds `teams.jsonl`** (a resolved team an honour names is a
  reference) and the tamper map did not say so; added.
- **The identity block registered `Player` as a handle alias** — a dead path on the
  recorded rows, and a false alias if a row ever states both a `Link` and someone else's
  handle. Removed.
- **The normalizer's conflict message** read "file X and file X disagree" for two rows in
  one payload; it now distinguishes a same-payload contradiction.
- **Text that outran the code**: `Description` was said to be "measured on the recorded
  rows" (it was measured live; the query no longer fetches it), the schema's `place`
  example claimed an All-Pro rank the rows do not state, the NOTICE payload count was off
  by one, and the guide's id-prefix list omitted `hn-`.
