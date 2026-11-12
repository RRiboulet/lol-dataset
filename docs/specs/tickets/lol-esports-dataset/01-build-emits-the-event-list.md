# 01: A build that emits the agreed event list

**Blocked by:** None (can start immediately)
**Status:** ready

## What to build

A command that reads a directory of **recorded** source payloads and writes the
event list, selecting events by a committed rule rather than a hand-maintained
list. Running it twice produces identical bytes, and it never touches the network.

The rule is data in the repository: an event is included when its source region is
international, its event type is admitted by the rule, and it is not listed in the
exclusions. Per-event overrides are allowed but must carry a stated reason.
Someone reading only the repository must be able to compute the same set.

## Scope

Creates the pipeline skeleton the later tickets fill in (fetch, cache, normalize,
assemble, emit, validate), with only the event path wired: the event entity file,
its schema, and the fixture-backed build seam. Recorded payloads for a handful of
events are checked in as fixtures, including one regional-league event used purely
as a rejection case.

The attribution notice for that recorded content lands here, because these fixtures
are the first commits to contain source material — not ticket 09, as originally
planned.

Leaves for later tickets: games, players, drafts, provenance, the real fetch layer,
the full validator, and the actual crawl.

## Acceptance criteria

- [ ] The build emits the event entity file from fixtures, sorted by canonical ID.
- [ ] The committed rule selects the fixture Worlds and MSI events and rejects the
      fixture regional-league event; the rejection is visible, not silent.
- [ ] An override entry changes the selected set, and a reason is mandatory.
- [ ] An event whose region is unknown is rejected rather than guessed.
- [ ] Output validates against the checked-in schema.
- [ ] Two runs over the same fixtures produce byte-identical output.
- [ ] The test suite runs with no network access available.
- [ ] Attribution in `licenses/NOTICE.md` covers the recorded fixtures committed
      here, so no source-derived content lands unattributed.

## Validation

The primary build seam, over event fixtures only. Covers spec R1, and establishes
the determinism and schema mechanics that R8 and R10 later depend on. The dataset
suite is green. Also satisfies the licence constraint at its earliest possible
point — the first committed source material rather than the first committed
dataset.
