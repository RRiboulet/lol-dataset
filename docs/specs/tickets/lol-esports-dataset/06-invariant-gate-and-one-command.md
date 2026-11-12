# 06: The invariant gate, and one command that runs everything

**Blocked by:** 04, 05
**Status:** ready

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

- [ ] Each corruption fixture fails the build with a message naming the specific
      record: duplicate game ID, unknown champion reference, player kills not
      summing to team kills, a game with two winners, a negative statistic, and a
      game claiming complete coverage while a required field is absent.
- [ ] A clean dataset passes with no warnings.
- [ ] The validator runs as part of the normal build, not behind an opt-in flag.
- [ ] One documented command runs both the dataset suite and the scaffold suite,
      and is green on the branch.
- [ ] A corruption in one file does not stop the other files' rules from being
      checked in the same run.

## Validation

The corruption fixtures are the test; each asserts its own failure message. Covers
spec R10, and makes R6's coverage claims enforceable.
