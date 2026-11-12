# 11: Dataset documentation and licence attribution

**Blocked by:** 13
**Status:** ready

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

- [ ] A reader can rebuild the dataset from the documentation without reading the
      source code.
- [ ] The grain and every entity are documented with one worked example.
- [ ] A data dictionary covers every file and every field in both layers, saying which
      fields can be absent and what absence means in that place, and what the unknown
      member stands for.
- [ ] The coverage model and era caveats are documented, including which questions
      the data cannot answer.
- [ ] Attribution for the source data sits where the data lives and in the licence
      notice, covers the complete event list, and satisfies the share-alike terms.
- [ ] The documentation says where attribution came from in history, so a reader can
      find the commit that added it.
- [ ] The documentation states the rebuild's operational cost honestly: throttled,
      cached, resumable, not a quick command.
- [ ] At least three questions a junior analyst would actually ask are answered end
      to end **against the modelled layer**, with a snippet they can run — including one
      that lands on an era caveat, so the coverage markers are exercised rather than
      described.
- [ ] The documentation shows which layer answers which kind of question, so nobody
      joins curated records by hand to do what the model already does — or chases a
      measure the model deliberately does not pre-compute.
- [ ] The documentation says plainly what was never modelled — no aggregates, no
      ratings, no per-minute data — so nobody goes hunting for a layer that does not
      exist (spec R12).
- [ ] No `README.md` is created by this ticket.

## Validation

A reader test: follow the documentation from a clean checkout to a validated build.
Covers the spec's licence and attribution constraint, and R6's semantics for users
rather than machines.
