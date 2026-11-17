# 12: The dimensional model, proved on fixtures

**Blocked by:** 05
**Status:** done

## What to build

The star schema that the analyst will actually query, built from the curated records
and proved on fixtures long before the full crawl exists.

Conformed dimensions — event, match, team, player, champion, patch — and three facts
at declared grains: one row per game per side (team statistics), one row per game per
player (player statistics), one row per draft slot (ordered and unordered alike).
Joins use integer surrogate keys; every dimension carries its natural key and display
name, so a fact table can still be read by eye. An explicit unknown member stands in
for "not recorded", so an inner join does not silently drop games from a thin era.
Renames resolve through an alias bridge with validity dates rather than a duplicated
dimension row per alias.

Facts hold measures only. No rates, no averages, no pre-aggregations: the analyst
does the summing, and a model that pre-computes it answers fewer questions.

## Scope

The model's design, its DDL, its per-dimension and per-fact data dictionary, and the
build step from curated fixtures into `data/model/`. The emission format is decided
(spec Open assumption 6, D10): one CSV per dimension and fact, RFC 4180 quoting, UTF-8
without a BOM, header row, stable column order, ISO-8601 UTC dates, unformatted
integers, empty field for absent rather than `0`, and committed DDL in SQLite's
dialect. Do not reopen it.

Leaves for later tickets: building the model over the full committed dataset, and the
analyst-facing documentation.

## Acceptance criteria

- [x] Each fact has a declared grain and a uniqueness test that fails if two rows
      share one grain key.
- [x] Fact row counts reconcile with the curated layer per event: every game, every
      side, every draft slot accounted for, none invented.
- [x] No inner join between a fact and any dimension loses a row: an era with a
      missing value joins to the unknown member instead of vanishing.
- [x] A rename in the fixtures produces one dimension row plus two alias rows with
      dates, and both old and new source strings resolve to that one row.
- [x] Every dimension row carries its natural key and display name; every fact row is
      readable next to its dimensions without decoding a key.
- [x] Facts contain no derived measure — no rate, ratio, average or percentage —
      enforced by a test that fails on an added column matching that shape.
- [ ] The DDL loads the CSVs into a SQL engine and the model loads into a dataframe
      library, both with no preprocessing or type-fixing step. *(SQLite executed;
      the dataframe half is not executed here — see the decision below.)*
- [x] The CSV files follow the agreed canonical form: header, stable column order,
      RFC 4180 quoting, no BOM, ISO-8601 UTC dates, integers unformatted, and an empty
      field wherever a measure was not recorded.
- [x] No generated database file is committed; the CSVs plus DDL are the artifact.
- [x] The data dictionary covers every dimension and fact, including which measures
      can be absent and what the unknown member means.

## Validation

Build seam over fixtures, plus the uniqueness, reconciliation, orphan and
no-derived-measure tests. Covers spec R13 and D10, and delivers R12's analysis
surface early enough to be argued with.

## Decisions made while building

### Shape: eight dimensions, three facts, one bridge

| Table | Grain | Key |
|---|---|---|
| `dim_event` | one event | `event_key` |
| `dim_match` | one series | `match_key` |
| `dim_game` | one game | `game_key` |
| `dim_team` | one canonical team | `team_key` |
| `dim_player` | one canonical player | `player_key` |
| `dim_champion` | one champion | `champion_key` |
| `dim_patch` | one source patch string | `patch_key` |
| `dim_date` | one UTC calendar date | `date_key` |
| `bridge_alias` | one `(kind, alias_string, entity_key)` | `alias_key` |
| `fact_game_side` | one game per side | `(game_key, side)` |
| `fact_player_game` | one game per player | `(game_key, player_key)` |
| `fact_draft_slot` | one draft entry | `(game_key, side, phase, entry_index)` |

`dim_game` is the one dimension R13's list does not name. It earns its place because
the coverage declarations are a fact about a game, not about a side or a player: the
three `coverage` markers and the era must have a row even when the thin era has no
player or draft fact to attach them to. A game with no player rows is still present in
`dim_game`, so "the source recorded nothing here" cannot be mistaken for "the game was
not in the dataset". `dim_date` is included because every fact carries a game date and
time slicing is the first thing an analyst asks of a star schema.

`fact_draft_slot` separates the two ideas an unordered draft conflates. `entry_index`
is the deterministic position within a game, side and phase — the source slot when the
draft is ordered, and the only stable ordinal an unordered set has. `slot` carries the
source's slot number and is **empty** for an unordered draft, so absence of order is
never invented. `is_ordered` says which reading applies. `phase` is `ban` or `pick`.

Facts carry the conformed dimension keys directly (`event_key`, `match_key`,
`date_key`, `patch_key`) beside their grain keys. That is deliberate duplication of
`dim_game`'s context: the common "per event", "per date" and "per patch" questions do
not need a two-hop join through the game dimension, and conformance checks every key
against the dimension it names.

### Surrogate keys: 0 unknown, then 1..N in natural-key order

Every dimension has exactly one unknown member: surrogate key `0`, empty natural key,
display name `Unknown`, empty attributes. A fact joins to it when the curated record
has no value — the fixture case is a game with no series or no patch. A foreign key is
never empty, so an inner join cannot silently drop a row.

Real keys are `1..N`, assigned in ascending natural-key order within each build. They
are **build-local**, not hash-derived. The natural key (the canonical ID, ISO date or
patch string) is the durable identifier, and every fact is derived in the same run, so
a renumbering cannot leave a dangling reference. Hash-derived integers were rejected
because this model is a CSV a person opens first: a 15-digit hash in every fact column
would make the artifact harder to read and buy stability only across rebuilds where
the curated natural keys already provide it. The suite asserts determinism instead:
two builds of the same curated layer are byte-identical.

### The alias bridge, not a type-2 dimension

`bridge_alias` has one row per `(kind, alias_string, entity_key)`, with `valid_from`
and `valid_to` from the curated alias window and an empty date when the corpus does not
date the string. `entity_key` is a foreign key into `dim_team`, `dim_player` or
`dim_champion` according to `kind`, so the one bridge serves all three entity kinds;
the DDL cannot enforce a polymorphic reference, so the conformance suite resolves it
per kind. `evidence` is semicolon-joined in the canonical order. This is what makes the
rename proof work: the renamed team `tm-9a4fde0c4aad` has one `dim_team` row and two
dated bridge rows (`SK Telecom T1` for 2015, `T1` for 2023), and both strings resolve
to that row. A type-2 dimension would have duplicated the key and broken a naive
`COUNT(*)` instead.

### Emission: CSV, DDL and a generated dictionary

The committed artifact is one CSV per table plus `schema.sql` and
`data-dictionary.md` under `data/model/`; no SQLite file is generated or committed.
The format is the spec's open assumption 6, now settled:

- RFC 4180 field quoting and escaping: a field containing a comma, a quote, CR or LF
  (or leading/trailing whitespace) is quoted, and quotes are doubled.
- **LF**, not CRLF, as the record terminator. RFC 4180 permits CRLF, but
  `.gitattributes` normalizes this repository to LF; a CRLF artifact would be a
  committed file that differs from the bytes the build wrote. SQLite, DuckDB, Python
  and spreadsheets read LF.
- UTF-8 without a BOM, one header row, fixed column order, one trailing newline.
- Dates as `YYYY-MM-DD`, instants as `YYYY-MM-DDTHH:MM:SSZ`.
- Integers unformatted (no thousands separators, no exponent), and an **empty field**
  wherever the source recorded no value. `0` is a recorded zero and stays distinct.
- The DDL targets SQLite's dialect and declares the primary keys, the natural-key
  uniqueness and every fact foreign key. It loads the CSVs in table order with
  `PRAGMA foreign_keys = ON`.
- The DDL and the data dictionary are generated from the same column metadata as the
  CSVs, so a column cannot exist in one and be absent from another. The dictionary
  covers every dimension and fact, every measure's absence rule, the unknown member,
  the alias bridge, and the key and sort rules.

`node tools/dataset/cli.ts model` derives `data/model/` from `data/curated/`;
`model --check` compares every generated byte and fails on drift. The model build never
writes to the curated directory.

### Determinism

Rows are sorted by natural key in dimensions, by the declared grain columns in facts,
and by `kind`, `entity_key`, `alias_string` in the bridge. Tables, columns, DDL and
dictionary sections have fixed orders. There is no clock, no locale-sensitive sort and
no timestamp in any file. The suite builds twice and compares every file byte for byte;
the CLI test writes a scratch copy and runs `--check`.

### Conformance, and red before green

`tools/dataset/test/model.test.ts` proves the committed model is exactly a rebuild,
grain uniqueness, per-event and per-game row-count reconciliation, every fact foreign
key (including the unknown member), the rename case, coverage survival, the
no-derived-measure guard, the canonical CSV bytes, determinism, and an in-memory
SQLite load whose inner joins keep every fact row.

`buildModel` runs the same conformance rules before returning, so the command cannot
write a model that the suite would reject. Red-before evidence: with `model.ts` absent
the suite failed at import; with the initial implementation the unknown-member test
failed on a deliberately removed champion and the SQLite test failed on
`REFERENCES table.column` (SQLite wants `REFERENCES table(column)`), which is exactly
the shape the load test exists to catch.

### The one criterion not executed here

The SQL-engine half of the load criterion is executed: the DDL and CSVs are loaded into
an in-memory SQLite database with no preprocessing, foreign keys checked, and row
counts and inner joins reconciled. The dataframe-library half is **not** executed,
because no dataframe library (`pandas`, `polars`, `pyarrow`) is installed in this
container and adding one would violate the ticket's no-new-dependency constraint. The
CSV bytes are standard RFC 4180 with a header, so `pandas.read_csv` and equivalents
read them without a custom reader; the suite's own `parseCsv` proves the quoting and
round-trip. Ticket 13, which builds over the full dataset, is the natural place to run
the dataframe half in an environment that has a library.

### Left for later tickets

Ticket 13 builds this model over the full committed dataset and makes the rebuild part
of the build; it inherits the schema, the key rule, the conformance module and the
`model --check` seam. Ticket 11 documents the layer for an analyst, including which
questions the curated layer answers that the model deliberately does not pre-compute.
No README and no analyst examples were written here.
