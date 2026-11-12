# Changelog

## Unreleased

Added:

- Agent scaffold copied from `RRiboulet/my-agent-setup`: the devcontainer, the
  pi extensions, skills and templates, `bin/devc`, and the test suite that
  guards them. No dataset yet, and no `README.md` yet by design.
- The dataset's first spec, and the eleven tracer-bullet tickets that implement
  it. It fixes what one row means, how teams and players keep one identity
  across sixteen years of renames, why the data is committed as JSONL with a
  schema, and how provenance is recorded. Completeness is era-aware by
  decision: the data starts in 2011 and each game records which field groups
  its era actually holds, instead of pretending every field exists from 2011.
  Still no data and no ingestion code.
- A dimensional model in scope, for the analyst rather than the pipeline: conformed
  dimensions and three facts at declared grains, unknown members instead of dropped
  joins, and no pre-computed measures — the aggregating stays with the analyst. The
  curated records remain the source of truth underneath it.
- Attribution and licence terms for the data the project is built on: the source
  wiki is CC BY-SA 3.0, and the notice states which commits first carry
  source-derived material, so no derived content is ever committed unattributed.
- The dataset's first code: an offline `build` that turns **recorded** Leaguepedia
  payloads into `data/curated/events.jsonl`, plus a `event-selection.jsonl` report
  that shows every rejection and which clause caused it. Events are selected by a
  committed rule in `tools/dataset/rules/event-selection.json` — international
  region, the admitted leagues, a 2011 era floor, and stated exclusions for
  All-Star, national-team events, IEM's regional stops, an event's stage pages and
  qualifiers — with per-event overrides that must carry a reason. Output is
  schema-validated, sorted by canonical ID and byte-identical across runs, and the
  suite needs no network. The recorded payload fixtures and the licence notice
  covering them ship here, as the first committed source-derived material; the raw
  cache itself stays gitignored, and `--raw` points the build at the fixtures until
  the real crawl fills it.

Maintenance:

- The devcontainer now installs the scaffold's pi package on creation, so the
  extensions and skills come from the upstream clone on the pi-config volume
  instead of only from the copy in this repository. `.pi/settings.json`
  excludes the local `extensions/**` and `skills/**` from discovery to match:
  with the package installed, loading both copies registers every extension
  twice.
