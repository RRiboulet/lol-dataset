# 07: Provenance manifest and a byte-identical rebuild

**Blocked by:** 05
**Status:** ready

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

- [ ] Two builds from the same cache produce byte-identical entity files, with the
      manifest as the only permitted difference.
- [ ] Every emitted record's source identifiers resolve to a cached payload whose
      recorded hash matches the bytes on disk.
- [ ] Deleting the cache and restoring it from the same payloads changes nothing in
      the output.
- [ ] No entity file contains a build time, a hostname, or an absolute path.
- [ ] Changing one byte of one cached payload is detected and reported against the
      affected records.
- [ ] Numbers and dates use one fixed representation across every entity file.

## Validation

Build seam plus a two-build comparison, and a payload-tampering fixture. Covers
spec R8 and R9.
