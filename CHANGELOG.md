# Changelog

## Unreleased

Changed:

- **The dimensional model states its winner convention, and `dim_match` is sliceable by event.**
  `fact_game_side.is_winner` is now an **empty field** when the source records no winner, instead of
  a `0` that read exactly like a recorded loss, and a winner id that is neither side is refused by
  the build rather than silently encoded as "no winner". `dim_match` carries `event_key`, so a
  series can be sliced by event without joining through its games, with the unknown member joining
  to the unknown event. The no-derived-measure guard also catches the `kda`, `gpm` and `per_min`
  name shapes, and the data dictionary states both its remaining limit (a naming heuristic, not a
  semantic guarantee) and which dimensions' unknown members can actually be joined to — only
  `match_key` and `patch_key`; the rest are kept for uniformity (ticket 12, review pass).
- A declared alias's `from`/`until` window now bounds every lookup, not only one that is
  already ambiguous: outside the window the string resolves to no entity, so an
  observation mints and reports instead of silently joining the declared entity. An
  inverted window (`from` after `until`) stops the load, naming the declaration (ticket
  15, follow-up to ticket 14).
- An `aliasOf` declaration must now be evidenced by the corpus: a recorded game and the
  series row it names have to put the declared string on one side and its target on the
  same side, because there is no registry row to check the target against. A typo that
  names a team the declared string never meets fails the build instead of only moving the
  detached/contradicted counts; an inert declaration behind a registry identity and a
  string no corpus row uses are not failed for want of evidence (ticket 15).
- The evidence prose for IPL 5's legacy name now matches the bytes: six series rows say
  `CLG Prime`, three say `Counter Logic Gaming`, `from` is the first date the declared
  string is used, and ticket 14 no longer implies the swapped series' scores survive
  under the neighbouring key — both halves of each swap are dropped (ticket 15).
- A game whose `MatchSchedule` row names two other teams is now emitted **without** a
  canonical `matchId` and counted in the build's summary, instead of stopping the build;
  a series row that **every** game naming it contradicts is not emitted at all and is
  counted with its source id. The game↔series team check moved into the invariant gate,
  which refuses any emitted game whose `matchId` names a series between two other teams,
  so the promise "a game never sits in someone else's series" now also covers a
  hand-edited file or a bad merge — what changed is where the source's own contradiction
  lands, not whether it can be committed. IPL 5 2012 is the case that forced the
  decision: three pairs of its series rows have swapped `MatchId`s, so eight games name a
  series between two other teams (ticket 14).
- `tools/dataset/rules/identity-aliases.json` can declare an alias by the source string
  it denotes (`aliasOf`) instead of a page or Riot id, for an entity the corpus has no
  registry row for at all. The target resolves through the registries first, mints the
  target string's provisional id only when nothing answers, and refuses to chain onto
  another declaration, so the resolution never depends on read order.
- `data/curated/schema/game.schema.json`'s `matchId` and the match and event-report
  descriptions state the two new facts: a `matchId` requires a series row naming the
  same two teams, a match may legitimately have zero games, and IPL 5 is no longer an
  example of an event nothing had asked about.
- `build --check` now compares the provenance manifest as well as the entity
  files: it fails when the committed manifest does not name a payload the build
  actually read, when a payload's hash or query changed, or when an entity
  digest belongs to another dataset. One difference is deliberately tolerated —
  a payload's `fetchedAt` — because revalidating the same bytes against the
  source changes the fetch time and not the data. A tampered cache still fails
  first, in the build itself.
- `readPayloads` reads a sidecar strictly instead of silently dropping one it
  cannot parse: a missing body hash, URL, source, fetch time, status or query, a
  fetch time that is not a parseable ISO-8601 instant, or a query field the
  build does not know is a broken cache and stops the build. A payload with no
  sidecar stays legal, which is what a scratch directory built from bodies alone
  is.
- `data/curated/schema/game.schema.json` no longer claims that Riot's ACS fields
  are absent from every recorded row. They were not: the 19 IEM 2015 rows state
  `RiotHash`, and the game record now carries it.
- The provenance record makes a manifest pin usable as a path rather than only as a
  hash: `file` values are relative to the cache root, so the committed ones resolve
  under `tools/dataset/fixtures/raw/` and a reader can follow a game's source
  identifiers to the payload it came from. A re-fetched variant is a pin only while its
  body is in the cache, which makes removing a superseded payload and regenerating the
  manifest the crawl's job instead of letting every fetch accumulate a permanent pin.
  The committed manifest pins the one IEM 2015 scoreboard payload the fixture cache
  holds; the case with two variants is a test that proves row dedupe does not depend on
  field order. The manifest keeps its `format` marker because it is a committed document
  other tools parse, while a sidecar has none because it is a cache-local artifact
  rewritten with its body.
- `AGENTS.md`'s "current state" paragraph now names the dimensional model beside
  the curated layer: the dimensions and facts, the alias bridge, the unknown
  member, the generated DDL and dictionary, the `model` command and its
  `--check`. The earlier bullet above records the curated-layer update this one
  follows; neither claims a README exists.
- `AGENTS.md`'s "current state" paragraph describes what the repository now
  holds — the dataset spec, its ticket series, and the curated event and identity
  layer — instead of claiming there is no dataset yet, which had been untrue
  since the spec landed. Nothing else in the file moved.
- The devcontainer no longer mounts the shared `pi-agent-config` volume. It gets
  a private `lol-dataset-pi-config` volume (migrated from the shared one), the
  image bakes `my-agent-setup` at the pin in
  `.devcontainer/pi-agent-setup.version`, and `postCreate.sh` declares that baked
  path instead of fetching `git:`. Credentials arrive from the host environment,
  so no two containers share sessions, trust, package files or an auth token.
  `sh .devcontainer/check-pi-agent-setup.sh` (also run by CI) fails when the pin,
  the Dockerfile and `postCreate` disagree, and `postCreate` fails when the image
  is older than the checkout's pin. That pin now tracks the latest
  `my-agent-setup` release instead of lagging one behind: it moves to `v1.13.0`,
  which brings the `grilling`/`teach` skills, `bin/pi-agent-dir` and the `devc`
  fixes. A new tag is followed by a bump of
  `.devcontainer/pi-agent-setup.version` and the Dockerfile's
  `ARG PI_AGENT_SETUP_TAG=` in the same commit, then a rebuild.

Added:

- `data/curated/series-conflicts.jsonl`, with
  `data/curated/schema/series-conflicts.schema.json`: one row per game detached from a
  series that names other teams and per series every game naming it contradicts, carrying
  the event, canonical and source ids, and both team pairs. It makes "series contradicted"
  distinguishable from "series never fetched" in the committed data rather than only in a
  build's stdout; the recorded fixtures produce 14 rows (8 detached games, 6 contradicted
  series). The file is in `OUTPUTS` and the manifest's entity digests (ticket 15).
- **IPL 5 2012**, the earliest event the source still carries games for, in the
  committed dataset: 72 games, 720 player rows, 48 series rows of which 42 are emitted.
  Its four recorded payloads moved out of `tools/dataset/fixtures/pending/` (which is
  gone, not kept as a second cache the build ignores) into the fixture cache the build
  reads, so the manifest pins them and a game's source ids lead to its bytes. Team
  statistics are `unavailable` — the 2012 rows state none — drafts are unordered sets
  with three bans a side, and player rows are `partial`: kills, deaths, assists and CS,
  with no gold, damage, vision, keystone or runes. Committed totals go from 205 to 277
  games, 90 to 132 matches and 2,050 to 2,770 player rows.
- The legacy team name IPL 5 spells two ways resolves as one team: `CLG Prime` on the
  six series rows and `Counter Logic Gaming` on the 12 games in them are one canonical
  team, declared in `rules/identity-aliases.json` because that crawl recorded no
  `Teams` payload to anchor a page on. Both source strings stay on their rows (spec
  R7), and the alias row carries `declared` and `observed` evidence with the window the
  corpus used it.
- `ScoreboardAssembly.detachedGames` and `.contradictedMatches`, and the CLI summary
  prints both counts with the series ids, so a crawl cannot absorb either silently.
- `tools/dataset/test/series-rows.test.ts`, which derives the classification from the
  recorded payloads on every run: 20 pairings whose source strings disagree, split into
  12 legacy-name games (6 series) and 8 cross-match games (3 reciprocal `MatchId` swaps),
  and asserts that the class decides the handling. Ticket 09's figure of 11 pairings
  (9 + 3) does not reproduce on these bytes; the derived counts are what the test pins.
- A dimensional model at `data/model/`, derived from `data/curated/` and never
  written back: `dim_event`, `dim_match`, `dim_game`, `dim_team`, `dim_player`,
  `dim_champion`, `dim_patch` and `dim_date`; `fact_game_side` at one row per
  game per side, `fact_player_game` at one row per game per player and
  `fact_draft_slot` at one row per draft entry; and `bridge_alias`, which keeps a
  rename as one dimension row with dated source strings instead of a type-2
  duplicate. Every dimension carries a natural key, a display name and an
  unknown member at key 0, so a thin-era fact joins to `Unknown` rather than
  disappearing from an inner join. Facts hold source measures and grain
  attributes only; no rate, average or percentage is computed, and a test fails
  if a column of that shape appears.
- `node tools/dataset/cli.ts model`, which rebuilds `data/model/` from the
  committed curated records, and `model --check`, which compares every generated
  byte. The emitted artifact is one CSV per table plus generated `schema.sql`
  (SQLite dialect, primary keys, natural-key uniqueness and fact foreign keys)
  and `data-dictionary.md` (every column, its absence rule, the unknown member,
  the bridge and the key/sort rules). The format is RFC 4180 quoting with LF
  terminators, UTF-8 without a BOM, a header row, fixed column order, ISO-8601
  dates, unformatted integers and an empty field for an absent value — distinct
  from a recorded `0`. The LF choice is deliberate: `.gitattributes` normalizes
  the repository to LF, so CRLF output would not match a checkout.
- `tools/dataset/test/model.test.ts`, which proves the committed model is exactly
  a rebuild; every grain is unique; row counts reconcile per event and per game
  for sides, player rows and draft slots; every fact foreign key resolves
  (including the unknown member); the T1 rename is one dimension row and two
  dated bridge rows; coverage and draft fidelity survive into `dim_game`; no
  derived-measure column can pass; the CSV quoting round-trips and contains no
  BOM or CR; two builds are byte-identical; and the DDL plus CSVs load into an
  in-memory SQLite database whose inner joins keep every fact row.
- A provenance manifest at `data/curated/manifest.json`, written by the build: every
  cached payload the build read, sorted by cache-relative path, with its table,
  endpoint, recorded query, fetch time, HTTP status and sha256 of the body; plus a
  digest and record count for each emitted entity file and one aggregate
  `entityDigest` over them in the build's `OUTPUTS` order. It is the only place a
  timestamp is allowed, and the entity files are asserted to contain none of them.
- Payload hash verification during the build: a cached payload whose bytes no longer
  match its sidecar stops the build, naming the payload file, the recorded and actual
  hashes, the table, the entity files that table feeds and the row identifiers the
  body carries. Two builds from the same cache remain byte-identical, a restored cache
  changes nothing, and re-fetching the same bytes moves only `fetchedAt` in the
  manifest.
- `games.source.riotHash` on the 19 recorded games whose `ScoreboardGames` row states
  Riot's hash, because spec D7 names it as a source identifier and the field was
  genuinely missing. It is absent where the source states none, which is every 2023
  row.
- `tools/dataset/test/provenance.test.ts`, which audits every emitted record back to
  a recorded payload row pinned in the manifest and covers the manifest shape and
  digest definition, the tamper failure, the body-only payload, `--check`'s four
  cases, the fixed representation of numbers and dates, and the decision below.
- The re-fetched IEM 2015 payload problem is decided rather than deferred: the
  manifest pins the bytes the build read, so two fetches of identical rows with a
  different `fields=` order are both listed, each with its own hash, and the entity
  files do not move. `--check` requires the committed manifest to name every payload
  read, so a new byte variant is a manifest regeneration, not a silent re-pin.

- The first live crawl, for ticket 09: **MSI 2023** (76 games, 760 player rows, 25
  series, 76 ordered drafts; every field group complete) and a re-fetch of **IEM
  Season IX World Championship 2015**, already recorded for tickets 03–05 (19 games,
  190 player rows, 13 series; unordered drafts and no damage, vision, keystone or
  runes — partial, and honestly marked). The committed dataset grows from 129 to 205
  games and from 1,290 to 2,050 player rows, all of that growth from MSI 2023. Both events
  were fetched through `tools/dataset/fetch.ts` at its measured-safe 75 s spacing with
  zero rate-limit refusals, and the queries are committed as plans so the run is
  reproducible.
- The earliest era measured, not assumed: WCG 2011 returns **no per-game scoreboard at
  all** — four game-bearing tables and a probe over every World Cyber Games event all
  came back empty — so the spec's Open assumption 1 is now answered in the spec, the
  attribution notice names every event whose rows are committed, and
  `event-games.jsonl` reports WCG 2011 as `empty` rather than `missing`.
- `event-games.jsonl` reads an anchored `LIKE 'page%'` as a query for that page (a
  substring pattern still names nothing), so a crawl that filters by prefix is
  reported as having asked.
- An invariant gate that runs inside every build, after the schemas: it refuses the
  dataset when a game id repeats, a game's two sides are one team or it has no single
  winner, any reference dangles across the files, a statistic is negative, a player's
  kills or gold do not sum to the team's on a game claiming complete coverage, a
  `complete` marker is not backed by the era's eligible fields, or an `unavailable`
  marker denies values the record carries. Every violation is collected and reported
  in one failure, each prefixed with the record it names, so a corruption in one file
  does not hide the others. It also catches a `team` alias pointing at a champion, a
  player row attached to a team its game does not field or to another event, a game
  and series in different events, one source row emitted twice, an ordered draft whose
  slots were swapped, and a `partial`/`unavailable` player claim contradicted by the
  rows. `tools/dataset/test/invariants.test.ts` breaks each rule on purpose against a
  real build's records.
- `node tools/check.ts`, the one command that answers "is the repo green": it links
  pi's packages when needed and runs the dataset and scaffold suites, failing if
  either does. It enumerates each suite's test files instead of passing a glob, since
  a pattern matching nothing would otherwise report a green run that tested nothing.
- Per-player game rows in `player-games.jsonl`: 1,290 rows over the two fixture
  events, ten per game, with kills, deaths, assists, CS, gold, damage, vision,
  items, trinket, summoner spells, keystone and runes carried as numbers or lists
  rather than free-text blobs. `coverage.playerStats` is presence-based: 110 games
  are complete (five per side, one played role each) and reconcile to the team
  totals emitted in ticket 03, while the 19 IEM 2015 games are partial because the
  source states no damage, vision, keystone or runes and are never invented. A
  repeated player, a broken sum, a duplicated role in a supposedly complete game,
  or a present-but-unparseable side, date or list fails the build naming the game.
  A recorded full `ScoreboardPlayers` payload supplies the statistics; rows naming
  an event the rule rejected contribute neither a player row nor an identity
  observation, including rows that name no game but sit on a rejected event's page,
  and games and series under a rejected event mint no teams either. Identity grows
  to 193 players and 165 unresolved references, which ticket 10's crawl is expected
  to shrink. Player roles are compared case-insensitively, dates must be real
  calendar instants, and the scoreboard dedupe key carries the game id so file order
  cannot decide whether a row is evidence.
- Champion drafts on every game: `draft` carries bans and picks with the source's
  fidelity — numbered slots and the `SwitchedSides` flag from two recorded
  `PicksAndBansS7` payloads for the 2023 fixture, and sorted sets from
  `ScoreboardGames` list fields for 2015 — while `coverage.draft` says `partial`
  for the three-ban 2015 rows and `unavailable` when the corpus states no draft at
  all. Source order is never inferred from role order or list position; a champion
  repeated anywhere in a game's picks or bans stops the build. Draft picks are
  identity observations; a recorded full champion registry now gives all 173
  champions Riot-anchored IDs instead of minting string-anchored placeholders, and
  drafts from events the rule rejects mint nothing. Identical rows from overlapping
  payloads collapse instead of failing as stale, an empty ordered row cannot hide
  list picks, and unknown slot numbers or side-switch values stop the build. The
  side-switch case is tested from recorded bytes on a scratch copy because the
  source's switched rows belong to an event with no game fixture.
- The dataset's game and match layers: `games.jsonl` with both sides and the team
  statistics the source records, `matches.jsonl` with the series score counting
  games cannot recover, and `event-games.jsonl` saying per selected event whether
  the corpus carries games for it, whether a query came back empty, or whether
  nobody asked. Two events are recorded — Worlds 2023 (110 games, complete team
  statistics) and IEM Season IX World Championship 2015 (19 games, thin) — plus a
  query for World Cyber Games 2013 that the source answered with zero rows, kept
  because "the source has no games here" and "nobody fetched this" must not look
  alike. An absent statistic is an absent key, never `0`; a real `0` stays `0`.
- Era-aware coverage in `tools/dataset/rules/game-eras.json`: named eras from 2011
  to 2025 with the fields that could exist in each, each boundary citing the patch
  page it was read from, so a 2015 game is not marked partial for want of a void
  grub that arrived in patch 14.1. `games.test.ts` checks the recorded data against
  the table from the other side.
- The devcontainer's review-triage policy is committed rather than living only on
  the private volume: `.devcontainer/pi/review-triage.json` holds the judge and
  the four `opencode-go` reviewers, and `postCreate.sh` installs it when the
  agent dir has none, never over an existing file, so an edit made in a running
  container survives a rebuild. `postCreate.sh` also refreshes pi's model
  catalogues, because the policy's judge is newer than the list pi ships with and
  a fresh volume could not resolve it; a host without network or provider keys
  still gets a usable container, with a warning naming the missing judge instead
  of a triage that silently falls back to its most expensive profile.
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
- A fetch layer that can be left running. It issues one request at a time at a
  designed interval with jitter, backs off exponentially when the source says
  `ratelimited`, and stops the run after repeated failures with a message naming
  the query and cache key to resume from. The reason for the care is measured,
  not assumed: the source refused after three or four Cargo requests for more than
  a hundred seconds, and it refused with **HTTP 200** and an error body — so a
  response is cached only after it is classified as Cargo rows, never because it
  arrived with a 200. The cache key comes from the canonical query, so reordering
  the plan or killing the process costs nothing already fetched, and a body plus
  sidecar are renamed into place body-first so an interruption cannot leave a
  payload whose provenance is a lie. `cli.ts fetch` takes an explicit plan for
  now; the crawler that generates one is a later ticket.
- Canonical identity for teams, players and champions, with the source's own rename
  history behind it: `data/curated/teams.jsonl`, `players.jsonl`,
  `champions.jsonl`, an `aliases.jsonl` table and an `identity-unresolved.jsonl`
  report, each with a JSON Schema, all emitted and validated by the same build that
  emits events. What a canonical ID is derived from is measured per entity kind
  rather than assumed, because this is the decision the spec says will outlive the
  scrapers: a team is anchored on the root of its `RenamedTo` chain, since a rebrand
  is a *new page* (measured: SK Telecom T1 and T1 are two pages, one identity); a
  player on their wiki page, since handle changes and disambiguated duplicates leave
  redirect rows behind; a champion on Riot's numeric champion id, since the wiki
  rewrites retired champion names retroactively and has no champion redirect table.
  A rename therefore never mints a second entity, and adding an earlier event never
  renumbers an existing one. Aliases carry the era the source used the string —
  observed from game dates, or declared in `tools/dataset/rules/identity-aliases.json`
  where the source records nothing — so a reader can ask who a 2015 string was. The
  wiki stores its text HTML-escaped, so the two kinds of string are kept apart on
  purpose: a display name is decoded (`Nunu & Willump` on the champion record and on
  every alias's `entityName`), while an alias `string` keeps the source's own bytes
  (`Nunu &amp; Willump`), because that is what exact matching runs against. Two
  different players who share a display string stay two entities: the bare string is
  reported as ambiguous with its candidates instead of being merged, and a string the
  source registers nothing for becomes a new entity that is reported, so it is never
  dropped or silently invented as a page. The payload cache now names the Cargo table
  as a directory, because a recorded body does not say which table it came from and
  routing by row shape would feed one stage's rows to another's parser; the recorded
  fixtures moved accordingly and the committed event files are unchanged.

Fixed:

- **`model --check` fails on a model file the build does not emit.** It compared only the files the
  rebuild produces, so a stray file left in `data/model/` by an older build still printed
  "committed model matches a rebuild". It now enumerates the directory and names anything the build
  does not emit, as well as any emitted file that is missing. Found by the independent review of the
  dimensional model, and reproduced before the fix.
- **The model no longer trusts curated rows the invariant gate never saw.** `model` read the curated
  JSONL directly, so a hand-edited player row whose `eventId` disagreed with its game's was accepted
  and the facts then contradicted each other while every per-fact check passed self-consistently.
  The build now validates at the seam the curated fields the model relies on — non-empty ids,
  resolvable references, a winner that is one of the two sides, a player row's event matching its
  game — and the conformance gate asserts cross-fact consistency: one `game_key` presents one
  `event_key` across all three facts, and a player row's team and side must be one of the game's two
  sides, naming the game and the disagreeing events when they are not. Found by the independent
  review of the dimensional model, and reproduced before the fix.

Maintenance:

- **The single-query form of the manual fetch command is accepted again, and stays
  as strict as a plan file.** `tools/dataset/cli.ts` has always documented
  `fetch --raw raw --query '{"endpoint":"cargoexport",…}'`, but `parsePlan` only
  took an array or `{"queries":[…]}` and rejected that exact line with "expected a
  non-empty array of queries" — so the first documented way to make a real fetch
  failed before it reached the network, which is the command ticket 09 will use.
  A bare query object is now a plan of one, because a hand-typed flag has no list
  to put it in; a file keeps both envelope forms. It goes through the same
  `planQuery` check, so the typo guard that keeps a dropped `orderBy` from
  silently re-keying the cache still applies, and the error names the flag rather
  than an index (`--query: unknown query field "orderBy"`). Found by the
  independent review of the fetch layer, and the failing command is now a test.

Maintenance:

- **A subagent launch no longer names an extension copy this project excluded.** The
  child used to be started with `--extension .pi/extensions/subagent/index.ts` *and*
  with discovery on, and since `.pi/settings.json` here excludes the local extension
  tree on purpose (the installed package supplies it), the two copies collided: pi
  exits when one flag is registered twice, so every run reported "Child Pi exited
  before reporting a result" with nothing about extensions, in a worktree and in the
  main checkout alike. `resolveChildExtensionPath` now reads the child project's
  settings and names the copy *this* process is already running when that project
  excludes its own, which is the package's copy and the same file discovery loads, so
  pi sees one resolved path; a project that does not exclude its tree still gets its
  own copy named, and an untrusted cwd still gets the fallback. Fixed upstream first
  (`my-agent-setup` #139, corrected by #140 so a delegated project always gets a copy
  that exists rather than a launch that defers) and synced here.

- The devcontainer now installs the scaffold's pi package on creation, so the
  extensions and skills come from the upstream clone on the pi-config volume
  instead of only from the copy in this repository. `.pi/settings.json`
  excludes the local `extensions/**` and `skills/**` from discovery to match:
  with the package installed, loading both copies registers every extension
  twice.
