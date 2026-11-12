# 02: Canonical identity and aliases

**Blocked by:** 01
**Status:** done

## What to build

Every team, player and champion referenced anywhere in the dataset resolves to a
canonical ID, and a source display string that has changed over time resolves to
the same entity it did before. Renames recorded in fixtures — a team that
rebranded, a player who changed handle, a champion Riot renamed — each yield
**one** entity with a dated alias history, not two entities and a duplicate.

A build that adds an earlier event must not renumber existing entities.

## Scope

The identity module, the team/player/champion entity files and their schemas, and
the alias table. Reference resolution rules: exact source identity first, then the
alias table, then a new entity — never a fuzzy match that silently merges two
distinct people.

Leaves for later tickets: joining those entities into games and player rows.

## Acceptance criteria

- [x] A rename pair in the fixtures resolves to one canonical entity carrying both
      display strings with the era each applied to.
- [x] The entity's ID does not change when its display name changes.
- [x] Adding a fabricated earlier event to the fixtures mints new IDs without
      altering existing ones.
- [x] Two different players with the same display string remain two entities.
- [x] An unresolved source string creates a new entity and is reported, rather than
      failing the build or being dropped.
- [x] The alias table round-trips: given a source string and a date, the resolved
      canonical ID is stable.
- [x] Every emitted reference carries the entity's human-readable display name
      beside its canonical ID, so no row requires decoding an identifier to be read
      (spec R12).

## Validation

Build seam, with fixtures containing each rename case and the duplicate-name case.
Covers spec R7.

## What the recordings decided

Measured on the live source while recording the fixtures, because two of the three
rename cases could not be taken on faith:

- **A team rebrand is two pages.** `Teams` carries `SK Telecom T1`
  (`RenamedTo=T1`, page id 196774) and `T1` (page id 294322), so `_pageID` is not an
  identity across a rebrand and the page is the anchor only through the chain. The
  old page also owns the spellings `SK Telecom` and `SKT T1`; the new page owns only
  `T1`, so `TeamRedirects` alone cannot bridge a rebrand — `Teams.RenamedTo` is what
  does.
- **The scoreboard's team string is the page as it was used**, which is why the old
  name is dated: 2015 Worlds rows say `SK Telecom T1`, 2023 Worlds rows say `T1`.
- **Player handles and champion names are rewritten retroactively.** A 2011-06-18 row
  and a 2012-11-29 row already say `Nunu &amp; Willump`, years before Riot renamed the
  champion, and `Wolf (Lee Jae-wan)`'s handle reads `Wolf` in a 2015 row. So a
  handle or champion rename cannot be *dated* from scoreboard rows; their eras come
  from the declared alias file, because the redirect tables carry no dates.
- **There is no champion redirect table** (`Table ChampionRedirects not found`) and
  `Champions.KeyDdragon` is empty for every champion, so Riot's numeric
  `KeyInteger` is the only stable champion identity and a retired champion name has
  to be declared.
- **The wiki's `AllName` casing disagrees with the scoreboard's**: `sOAZ`/`SOAZ`,
  `kujaa`/`Kujaa`, `Yellowstar`/`YellOwStaR`, `DontMashMe`/`Dontmashme`,
  `ZionSpartan`/`Zionspartan`. Case folding is therefore a lookup step (unique or
  error), never a merge.
- **Unresolved means the registry genuinely lacks the string.** Every team, player
  and champion name in the recorded 2011, 2012, 2015 and 2023 international payloads
  resolves, and the whole `ScoreboardPlayers` table's champions are covered by the
  173 rows in `Champions`. The fixture that carries an unresolved string is therefore
  a 2026 Prime League game whose team `The Bandits Prime` has no `Teams` row and no
  `TeamRedirects` name — a recorded case, not an invented one.
- **The source's text is HTML-escaped, and the two kinds of string are kept apart.**
  `Nunu &amp; Willump` is what the champion table *and* the 2011 scoreboard rows say.
  A display name is decoded (`Nunu & Willump`) because R12 asks for the name a reader
  recognises; an alias `string`, a page and a league keep the source's bytes because
  R7 says source strings are preserved verbatim and exact matching runs against them.
  Decoding happens once, so a source string that meant to show `&lt;` still does.
- **The 2011 and 2013 World Cyber Games have no `ScoreboardPlayers` rows at all**,
  although they are admitted events. That is ticket 03's problem, not identity's, and
  it is noted here so the game ticket does not discover it as a surprise.
