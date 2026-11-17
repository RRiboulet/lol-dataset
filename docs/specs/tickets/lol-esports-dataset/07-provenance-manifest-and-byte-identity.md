# 07: Provenance manifest and a byte-identical rebuild

**Blocked by:** 05
**Status:** done

## What to build

Every emitted record traces to the exact payload bytes it came from, and a rebuild
from the same cache produces byte-identical data.

The manifest names each cached payload with its query identity, fetch time and body
hash, and lists the payload hashes the dataset was built from. It is the only place
a timestamp is allowed, and it is excluded from the byte-identity check. Entity
records carry their source identifiers, so a person can walk any row back to a
source page by hand.

## Scope

The manifest and payload-sidecar format, the source-identifier fields across
entities, and the determinism checks (fixed ordering, fixed number formatting, no
clock in entity files). Leaves the fetcher that fills the cache to its own ticket.

## Acceptance criteria

- [x] Two builds from the same cache produce byte-identical entity files, with the
      manifest as the only permitted difference.
- [x] Every emitted record's source identifiers resolve to a cached payload whose
      recorded hash matches the bytes on disk.
- [x] Deleting the cache and restoring it from the same payloads changes nothing in
      the output.
- [x] No entity file contains a build time, a hostname, or an absolute path.
- [x] Changing one byte of one cached payload is detected and reported against the
      affected records.
- [x] Numbers and dates use one fixed representation across every entity file.

## Decisions made while building

### The manifest: one JSON file, two questions

`data/curated/manifest.json` is written by the build and by nothing else. Its shape is
fixed and its field order is the emitted field order:

```
format          "lol-dataset-provenance/1"
entityDigest    sha256 over the entity digests below, in the build's OUTPUTS order
entities[]      { file, records, sha256 }  — one per emitted file
payloads[]      { file, table, endpoint, bodySha256, fetchedAt?, status?, query? }
```

- **Payloads are sorted by cache-relative path**, so a diff shows an added or removed
  payload in one line. `file` is relative to the cache root on purpose: an absolute
  path would make the manifest depend on where the checkout lives, and the manifest is
  committed.
- **`fetchedAt` is the only timestamp in the dataset.** The entity files never see it,
  and the suite asserts that no entity file contains any recorded fetch time.
- **A payload with no sidecar is legal, and appears without `fetchedAt`, `status` and
  `query`.** A scratch directory a test builds from bodies alone has no provenance to
  betray, and inventing a timestamp for it is exactly the wall-clock the spec forbids.
  The suite covers both shapes. A sidecar that *exists* is now read strictly: unreadable
  JSON, a missing hash, a missing fetch time, a missing status or a malformed query
  fails the build. "No sidecar" and "a sidecar that lies" must not look alike, which is
  what made `readPayloads` stop silently dropping a malformed sidecar.
- **`entityDigest` is defined, not implied**, because "a digest of the files" is
  ambiguous the moment the order changes:

  ```
  entityDigest = sha256( for each entity file, in OUTPUTS registry order:
                           `${file}\t${sha256(body)}\t${records}\n` )
  ```

  `OUTPUTS` in `build.ts` is the single registry, so the order is the same order the
  writer writes and the reader reads; `records` is the JSONL line count, so an empty
  file is 0. The name writes nothing on its own and the digest is recomputed rather
  than trusted, in the suite and by `--check`.
- Rejected: JSONL for the manifest (one record per `(payload, entity)` pair makes
  "which dataset is this" a scan rather than a field), and a manifest per event (the
  dataset is one rebuild, and a per-event digest would have to answer which events a
  payload fed).

### The gate: verified before normalizing

`assertPayloadHashes` runs immediately after `readPayloads`, before a single row is
normalized, so a contradicted payload cannot contribute a value the committed manifest
then pins. The failure names the payload file, the recorded and actual hashes, the
table, the emitted files that table feeds (`TABLE_CONSUMERS`), and the row identifiers
the body carries (`OverviewPage`, `GameId`, `MatchId`, capped at five) when it still
parses. `--check` never bypasses the gate: it builds first, so a tampered cache fails
before a comparison is attempted.

The consumer map is the normalizers' routing table, not a guess. It matters for the
message: "table ScoreboardGames feeds games.jsonl, event-games.jsonl" says which
records to re-read, and a table with no normalizer is an error elsewhere, so there is
no "unknown table" hole.

### `--check`: bytes for entities, pins for the manifest

`--check` compares the entity files byte for byte, as before, and the manifest on
everything that describes the data: `format`, `entityDigest`, every entity digest, and
every payload's `file`, `table`, `endpoint`, `bodySha256`, `status` and `query`.

It deliberately ignores one field: **`fetchedAt`**. Re-fetching the same bytes gives the
same data and a new timestamp, and a data rebuild must not fail because the cache was
revalidated. The committed manifest must still list the payloads the build actually
read, with the hash of the bytes on disk — an added payload, a removed one, a changed
hash or a changed query all fail. A missing manifest fails too: entity files without the
provenance that describes them are half a deliverable.

Rejected: comparing the manifest text (a timestamp-only revalidation would then look
like data drift), and skipping the manifest comparison when the entity files match (a
hand-edited manifest would pass, and it is the artifact that pins the inputs).

### Source identifiers: two gaps weighed, one field added

The audit walked every emitted record against the recorded payloads
(`tools/dataset/test/provenance.test.ts`, "every emitted record resolves …"). What
already worked:

| File | Identifier | Resolves to |
|---|---|---|
| `events.jsonl`, `event-selection.jsonl`, `event-games.jsonl` | `overviewPage` | the `Tournaments` row |
| `games.jsonl` | `source.gameId` (+ `matchId`, `riotPlatformGameId`) | the `ScoreboardGames` row |
| `matches.jsonl` | `source.matchId` (+ each side's `sourceTeam`) | the `MatchSchedule` row |
| `player-games.jsonl` | `source.gameId` + `source.playerLink` | the `ScoreboardPlayers` row |
| `champions.jsonl` | `riotKey` | the `Champions` row (`KeyInteger`) |
| `teams.jsonl`, `players.jsonl` | `overviewPage`, when the source has one | `Teams` / `PlayerRedirects` |
| aliases, unresolved | `string` + `evidence` + `firstSeen`/`lastSeen` | the payload columns, or the declared rule |

Two gaps were real and are covered rather than papered over:

- **Teams and players with no page** (29 teams, 146 players) are minted from an observed
  string. They have no page to carry, and their way back is the alias row that names
  that string and the evidence that produced it — the bridge already exists and the
  test now requires it, so an entity cannot be minted without one. No field was added:
  a `source` blob repeating the string would duplicate `name` and still need the alias
  row to say where the string was read.
- **`games.source.riotHash` was genuinely missing.** Spec D7 names "Riot's platform game
  id and hash where present"; the game row carried the platform id and dropped the hash.
  The 19 IEM 2015 rows state `RiotHash` (`5ed2bacdb2469753`) and the 205 rows of 2023 do
  not, so the field is optional and only present where the source states it. The schema
  description that claimed both ACS fields are "absent on every recorded row" was
  measurably wrong and is corrected. `RiotGameId` and `RiotPlatformId` were **not**
  added: D7 names the hash, the hash is the pin, and the committed payload row remains
  the place a reader gets the numeric id from — duplicating every Riot column into the
  game file would be the reflex this ticket warns against.

`identity-unresolved.jsonl` deliberately still has no path to an entity: an unresolved
reference is the record that *no* entity answers to it, and its `string` is what the
source said.

### The inherited decision: both IEM 2015 payloads are canonical

Ticket 09 re-fetched IEM 2015 with the same rows and a different `fields=` order, so the
same data arrived as different bytes under a different cache key. The decision: **the
manifest pins the bytes the build read, not a preferred fetch.** Both payloads are
listed, each with its own hash, and the entity files do not move because row dedupe is
key-order independent.

- No "canonical variant" flag, no preferred hash, no choice of one file over the other.
  A flag would need a rule for which variant wins, and every rule ("the first fetched",
  "the one on disk", "the one named in the fixtures") is either the same as listing both
  or a way to hide a second payload the build actually read.
- `--check` therefore requires the committed manifest to name the payloads the build
  actually read. If the cache gains the second variant, `--check` reports the payload
  the committed manifest does not list — which is the honest outcome: the build read new
  bytes, so the manifest must be regenerated (and the entity files turn out identical).
- The test builds exactly that case: it re-records the IEM `ScoreboardGames` payload with
  its columns reversed (a different query, key and body hash), asserts the entity files
  are byte-identical to the one-variant build, asserts both payloads are listed with
  different hashes, and asserts `--check` reports the missing pin.

### Fixed representation

`JSON.stringify` already gives one representation (no `1.0`, no exponent, no `-0`, no
whitespace drift), and the suite now asserts it as an artifact: every line of every
entity file round-trips through `JSON.parse`/`JSON.stringify` unchanged. Dates are
checked by *field*, not by shape: an ISO-shaped string is only allowed in
`dateStart`, `dateTimeUtc`, `firstSeen` or `lastSeen`, so a future `builtAt` would fail
the test even if it looked like data. No entity file may contain the repository path,
the fixture path, the host name, or a string starting with `/` or a drive letter.

## Validation

- `tools/dataset/test/provenance.test.ts` — manifest contents and order, the digest
  definition recomputed by hand, the committed manifest matching a rebuild, absence of
  fetch times in entity files, the representation rules, two-build byte identity, the
  delete-and-restore cache, a revalidation that moves only `fetchedAt`, the tamper
  failure message, the body-only payload, `--check`'s four cases, the source-identifier
  audit over every record, and the inherited double-fetch decision.
- Tests that used to edit a fixture body without touching its sidecar now re-record it
  through `savePayloadBody` in `test/helpers.ts`. That is not a loosened gate: a fixture
  edit *is* a different recorded payload, so the hash that claims to describe it has to
  move with it, and the tamper test is the case where it does not.

Red before the implementation, captured by disabling each piece in turn:

- tamper gate removed → `one changed byte …` fails with "Missing expected rejection";
- manifest comparison removed from `check` → the `--check` test fails (a dropped pin
  passes when it must fail);
- `data/curated/manifest.json` moved away → the manifest test fails with `ENOENT`;
- `riotHash` emission removed → the audit fails with `actual: undefined, expected:
  '5ed2bacdb2469753'`.

Covers spec R8 and R9.
