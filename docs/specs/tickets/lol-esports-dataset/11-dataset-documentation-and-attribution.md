# 11: Dataset documentation and licence attribution

**Blocked by:** 13
**Status:** done

## What to build

Documentation that lets someone who never read this conversation use the dataset.
It covers **both layers** and says which one to reach for: the curated records as the
source of truth, and the dimensional model as the thing an analyst queries. What each
entity and each dimension means, how identity and aliases work, how coverage is
expressed and why some eras are thinner, how to rebuild from the cache, and what the
licence obligations are for the derived data.

The source is a wiki under a share-alike licence, so attribution is a requirement of
using the data, not a courtesy. It is already in place: attribution landed with the
first committed data in ticket 09. This ticket finishes it — extending the notice
where the full crawl added a source, and documenting the obligations for whoever
uses the dataset — rather than introducing it.

## Scope

Dataset documentation, and the attribution notice as it stands once the crawl is
complete. **Not** the repository's own `README.md`: `AGENTS.md` is explicit that a
README is its own decision and must not arrive as a side effect of another task. If
one is wanted, that is a separate conversation.

## Acceptance criteria

- [x] A reader can rebuild the dataset from the documentation without reading the
      source code.
- [x] The grain and every entity are documented with one worked example.
- [x] A data dictionary covers every file and every field in both layers, saying which
      fields can be absent and what absence means in that place, and what the unknown
      member stands for.
- [x] The coverage model and era caveats are documented, including which questions
      the data cannot answer.
- [x] Attribution for the source data sits where the data lives and in the licence
      notice, covers the complete event list, and satisfies the share-alike terms.
- [x] The documentation says where attribution came from in history, so a reader can
      find the commit that added it.
- [x] The documentation states the rebuild's operational cost honestly: throttled,
      cached, resumable, not a quick command.
- [x] At least three questions a junior analyst would actually ask are answered end
      to end **against the modelled layer**, with a snippet they can run — including one
      that lands on an era caveat, so the coverage markers are exercised rather than
      described.
- [x] The documentation shows which layer answers which kind of question, so nobody
      joins curated records by hand to do what the model already does — or chases a
      measure the model deliberately does not pre-compute.
- [x] The documentation says plainly what was never modelled — no aggregates, no
      ratings, no per-minute data — so nobody goes hunting for a layer that does not
      exist (spec R12).
- [x] No `README.md` is created by this ticket.

## Validation

A reader test: follow the documentation from a clean checkout to a validated build.
Covers the spec's licence and attribution constraint, and R6's semantics for users
rather than machines.

## Decisions made while building

### Three files, each with one job

| File | Who writes it | Why it is there |
|---|---|---|
| `docs/dataset/using-the-dataset.md` | a person | The guide: what the data answers, which layer to reach for, worked questions, rebuild, licence, non-goals |
| `docs/dataset/curated-data-dictionary.md` | generated | Every field of every curated file, from the schemas |
| `data/model/data-dictionary.md` | generated (ticket 12) | The model's fields, grains, keys and the unknown member |
| `data/ATTRIBUTION.md` | a person | The licence obligations, where the data lives |

No `README.md` was created, at the root or anywhere else: `AGENTS.md` says a README is its
own decision, and the guide is linked from `AGENTS.md` instead.

### The curated dictionary is generated, because hand-copying it lies

The model's dictionary was already generated from column metadata. The curated layer had
the same information scattered across fifteen JSON Schemas — every field's type and
`required` list, and prose descriptions on the 120 fields that have them — but only a
reader of JSON Schema could use it. `tools/dataset/dictionary.ts` renders those schemas as
markdown, `node tools/dataset/cli.ts dictionary` writes the file, `--check` compares it,
and `tools/dataset/test/docs.test.ts` regenerates it in-process and fails on any
difference. That is the same bargain as `model --check`: the doc cannot claim a field the
schema does not have, and a new field cannot land undocumented.

Three details that were decided rather than defaulted:

- **Presence has three states, not two.** `always` (the key is in every record), `when
  present` (required inside its object, but an object above it is optional), and `no`
  (optional within its own object). Two states would either claim that a record always has
  `draft.sides[].picks[].championId`, or lose the fact that a pick always names a champion.
- **The file list comes from `OUTPUTS`, not from the schema directory.** A curated file the
  build stops emitting leaves the dictionary in the same change; a schema added for
  something that is not a data file does not sneak in. `manifest.json` is the one addition,
  because it is emitted by the build but is not in `OUTPUTS`.
- **Record counts are included** ("At a glance"), so the dictionary is also where current
  totals live. It therefore changes when the corpus grows, which is intended: `dictionary
  --check` after a crawl is a reminder that the doc is a build artifact, not a snapshot.

### The guide says what the data cannot answer

The coverage section is the part of the documentation that earns its keep. It states the
era table and which eras have games, and then the four consequences a reader will hit:
pre-2016 team statistics are a smaller field set rather than a degraded one; draft order
did not exist before 2017, so 94 games carry `unordered` drafts with `slot` empty; three
Mid-Season Cup games were blind pick, a declared source fact; and 720 player rows have no
gold, 1 120 no vision. It also names the two provisional identities and the eight IPL 5
games whose series is refused. The worked questions include one whose whole point is the
era caveat — "how complete is each era" — so a reader meets the markers before they meet a
wrong average.

### Attribution: where the data lives, and from which commit

`licenses/NOTICE.md` already carried the source, the licence and the complete event list.
Two things were missing, and this ticket added them:

- **`data/ATTRIBUTION.md`**, because a reader who has copied `data/` has not copied
  `licenses/`. It restates the licence, the four obligations (credit, indicate changes,
  share alike, no extra restrictions), names the nine Cargo tables the crawl actually read,
  and points back at the full notice.
- **The event table's labels now use the dataset's own event names** (`WCG 2011`,
  `Worlds 2023`, `MSI 2023`, …) with the fuller title in parentheses, so the notice and the
  corpus can be checked against each other. The test does exactly that: every event in
  `event-coverage.jsonl` must appear exactly once with the committed game and series
  counts, and no row may name an event the corpus does not carry. A crawled event now
  cannot be committed without attribution, because the suite says so.

The history pointer required a fact, not a memory: attribution was added in **`827d63f`**
on 2026-11-12, *"docs(licenses): attribute the source wiki before any of its content is
committed"* — before the first recorded payload, because payloads are source content too.
Both files and the guide name that commit.

### The dataframe half is documented as a limit, not claimed

Ticket 13 proved the CSV load through SQLite and through an independent RFC 4180 reader
(Python's stdlib `csv`), because `pandas`/`polars`/`pyarrow` are not installed and adding
one would be this repository's first data dependency for a test. The guide therefore shows
the `pandas.read_csv` and DuckDB one-liners that a reader with those tools will use, and
the ticket says plainly that they were not executed here. A doc that claims an unexecuted
load works is the kind of claim this repository's gates exist to stop.

### Validation: the reader test

Run from a checkout with no crawl cache, following the guide as written:

```
node tools/dataset/cli.ts build --raw tools/dataset/fixtures/raw   # 377 games, 230 series, 3 770 player rows
node tools/dataset/cli.ts model                                    # 754 side, 3 770 player, 7 144 draft rows
node tools/dataset/cli.ts dictionary                               # 15 files, 231 fields
node tools/dataset/cli.ts build --raw tools/dataset/fixtures/raw --check
node tools/dataset/cli.ts model --check
node tools/dataset/cli.ts dictionary --check
node tools/check.ts
```

The four worked questions were executed against the loaded model and their outputs pasted
into the guide (`T1` at Worlds 2023: 15 games; `Faker`'s picks; the per-era completeness
table; the eight series-less games). Red-before evidence for the two generated/checked
claims: editing one field description in `team.schema.json` fails the dictionary test, and
changing IPL 5's game count in the notice fails the attribution test. Both were reverted.
