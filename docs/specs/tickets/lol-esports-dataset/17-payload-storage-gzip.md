# 17: Payloads are stored gzipped, hashed uncompressed

**Blocked by:** 07, 16
**Status:** done

## What to build

The recorded payloads the dataset is built from now hold **three thousand and ninety-one
games instead of three hundred and seventy-seven**, and at the repository's stored format
that cache weighed **95 MB** of pretty-printed third-party JSON — a nine-fold jump in a
repository with no Git LFS and a fixture-weight risk already disclosed in the spec (D6).
This ticket stores the bodies gzip-compressed while keeping every provenance promise the
manifest makes.

## Measured, before the decision

| Form | Size |
|---|---|
| Body as written today (indented JSON) | 95.4 MB |
| Bodies gzipped per file, as committed here | **7.2 MB** |
| Whole tree as one gzip stream (not how it is stored) | 5.8 MB |

`ScoreboardPlayers` is 74 MB of the 95 MB on its own: 30 590 player rows of ~45 fields.
The largest single payload is 4.6 MB raw and 0.29 MB gzipped.

## Acceptance criteria

- [x] A stored body is `<key>.json.gz`; the sidecar is unchanged in name and gains
      `encoding: "gzip"`.
- [x] `bodySha256` remains the hash of the **uncompressed** body — the bytes the source
      returned — so a pin still describes the response, not this repository's storage
      choice. `manifest.json` is otherwise identical: same payloads, same hashes, same
      entity digests.
- [x] The reader accepts a plain `.json` body too, so a test's scratch cache and a
      recording made before this change still build.
- [x] The build's output is **byte-identical** across the change: all fourteen curated
      files unchanged, and the manifest differs only in each payload path's `.gz` suffix
      (verified by rebuilding before and after the conversion and comparing).
- [x] `.gitattributes` marks `*.gz` binary, so git never normalizes line endings inside a
      compressed body.
- [x] The tamper gate still works: a body whose bytes no longer hash to the sidecar's
      `bodySha256` fails the build, naming the payload, the table and its rows — now
      including the case where the compressed file was rewritten without the sidecar.

## Validation

The provenance suite (`provenance.test.ts`), `build --check`, and the before/after rebuild
comparison above.

## Decisions

- **Gzip, not Git LFS.** LFS is not installed in the devcontainer, needs host-side setup,
  and would leave the repository unusable without it. Gzip needs nothing and is understood
  by every tool that might read the fixtures.
- **Per-file streams, not one archive.** A payload is still one file per query, addressed
  by the same key, so the manifest's `file` remains a path a reader can open and the
  cache's resumability (one query, one file) is unchanged. The single-stream form would
  have been 5.8 MB but would put the whole cache behind one key.
- **Hash the uncompressed body.** Hashing the compressed bytes would pin the compressor's
  output (level, header, mtime) rather than the response, and re-compressing the same body
  would look like tampering. The sidecar keeps saying what the source said.
- **Deterministic bytes.** `fetch.ts`/`record.ts` compress with `zlib` level 9 and no
  timestamp in the header, the same function the committed conversion used, so
  re-recording a body produces the same file.
- **Rejected: shrinking the field list.** `ScoreboardPlayers` requests 45 columns of which
  the build uses about half. Dropping the rest would cut the payloads, but the cache key is
  the whole query: every event would be re-fetched into new keys, orphaning the committed
  payloads and spending another ~5 hours of crawl time. The fields are also the only
  record of what the source stated, which is what R9 is for.
