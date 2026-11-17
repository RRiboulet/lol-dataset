# 06: The invariant gate, and one command that runs everything

**Blocked by:** 04, 05
**Status:** done

## What to build

A validator that runs after emission and fails the build, naming the offending
record, whenever the dataset violates a structural, referential or arithmetic
invariant. Plus one command that runs the dataset suite **and** the existing
scaffold suite, so "is the repo green" stops being a multi-command question.

The validator is what makes a bad merge or a hand-edit impossible to commit by
accident, so each rule gets a fixture that deliberately breaks it.

## Scope

The validator module and its rule set; corruption fixtures per rule; the single
test command wired into the repository's own conventions. Leaves the validator's
use on real data to the crawl tickets.

## Acceptance criteria

- [x] Each corruption fixture fails the build with a message naming the specific
      record: duplicate game ID, unknown champion reference, player kills not
      summing to team kills, a game with two winners, a negative statistic, and a
      game claiming complete coverage while a required field is absent.
- [x] A clean dataset passes with no warnings.
- [x] The validator runs as part of the normal build, not behind an opt-in flag.
- [x] One documented command runs both the dataset suite and the scaffold suite,
      and is green on the branch.
- [x] A corruption in one file does not stop the other files' rules from being
      checked in the same run.

## Decisions made while building

- The corruption fixtures are applied to a real build's **emitted records**, not to
  payloads. A duplicate game id, a second winner or a negative statistic is already
  refused by `normalize` or by the JSON Schema, so a payload-level fixture would test
  those locks rather than the gate this ticket adds. What the gate uniquely catches is
  a record that satisfies its schema and contradicts the row beside it — exactly what
  a hand-edit to `data/curated/` or a future assembler regression produces.
- `findInvariantViolations` returns every violation and `assertInvariants` throws
  once with all of them, because stopping at the first would hide the rest of the
  files' problems (criterion 5). Each message is prefixed with the record's file and
  id, so the failure names the line to open.
- The rules cover structure the schema cannot express (unique ids, two distinct
  sides, exactly one winner), referential integrity across every file, arithmetic
  (non-negative statistics, player sums against team totals, per-event counts), and
  the coverage claims themselves: `complete` is checked against the era's eligible
  fields, and `unavailable` against the absence of the values it denies. An alias
  must point at an entity of its own kind, a player row must belong to a team its
  game actually fields and to that game's event, a series and a game must share an
  event, one source row cannot become two games, and every emitted event carries an
  included selection row plus one report row.
- A review pass tightened the gate further: `ordered` drafts are checked slot by slot
  rather than by count, `partial`/`unavailable` player claims are cross-checked
  against their rows, a malformed `sides` array is reported instead of throwing, and
  absence is read as `!== undefined` (matching `coverageOf`) so an in-memory
  `undefined` is never mistaken for a stated value.
- The rules are deliberately checked against **both** directions: no false positive on
  the real build (which would block all dataset work), and a fixture per false
  negative. `node tools/check.ts` covers the first on every run.
- `node tools/check.ts` enumerates each suite's `*.test.ts` files rather than passing
  a glob. A glob that matches nothing exits successfully, which would make the one
  command report a green run that tested nothing.

## Validation

The corruption fixtures are the test; each asserts its own failure message. Covers
spec R10, and makes R6's coverage claims enforceable.
