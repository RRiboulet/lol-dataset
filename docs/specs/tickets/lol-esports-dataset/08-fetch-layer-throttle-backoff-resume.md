# 08: The fetch layer — throttle, back off, resume

**Blocked by:** 01
**Status:** done

## What to build

A fetcher that can crawl the source without hammering it and without losing work:
one request at a time, a designed interval with jitter, exponential backoff when the
source answers with a rate-limit error, a hard stop after repeated failures, and a
cache keyed by the query so an interrupted crawl resumes where it stopped instead
of starting over.

The measured behaviour that motivates this: the source answered three or four
requests and then refused service for more than a hundred seconds. A tight loop is
not merely impolite here, it does not work.

## Scope

The fetch layer, its cache-key scheme, the sidecar writing consumed by ticket 07,
and its tests against a fake transport and a fake clock. Also a documented manual
command for a real fetch, exercised live in ticket 09. Leaves the crawl plan
itself, which is ticket 10.

## Acceptance criteria

- [x] Requests are issued sequentially at the designed interval; the interval is
      asserted by the fake clock, not by a real sleep.
- [x] A rate-limit response triggers backoff, is retried, and is never silently
      dropped or turned into an empty result.
- [x] Repeated failures stop the run with a clear message naming what to resume.
- [x] A second run over a complete cache issues zero requests.
- [x] An interrupted run resumes and fetches only what is missing, with no
      duplicate cache entries.
- [x] No credential, cookie or token is read from, or written to, the repository.
- [x] The cache key is derived from the query, so reordering the crawl does not
      invalidate work.

## Validation

Fake-transport and fake-clock tests, deliberately with no real network. Covers spec
R11 and the operational half of the spec's Constraints.
