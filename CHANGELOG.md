# Changelog

## Unreleased

Changed:

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

- An invariant gate that runs inside every build, after the schemas: it refuses the
  dataset when a game id repeats, a game's two sides are one team or it has no single
  winner, any reference dangles across the files, a statistic is negative, a player's
  kills or gold do not sum to the team's on a game claiming complete coverage, a
  `complete` marker is not backed by the era's eligible fields, or an `unavailable`
  marker denies values the record carries. Every violation is collected and reported
  in one failure, each prefixed with the record it names, so a corruption in one file
  does not hide the others. `tools/dataset/test/invariants.test.ts` breaks each rule
  on purpose against a real build's records.
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
