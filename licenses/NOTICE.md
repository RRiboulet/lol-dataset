# Coding skills provenance

The twelve coding skills under `.pi/skills/` (`in-your-own-words`,
`blast-radius`, `tdd`, `diagnosing-bugs`, `prove-it-works`,
`idempotent-operations`, `benchmark-checklist`, `show-me-your-work`,
`to-spec`, `to-tickets`, `implement`, `handoff`) were adapted from
<https://github.com/RRiboulet/agent-coding-skills> at commit `25deecd`. They are
maintained here as this repository's own skills; there is no refresh mechanism
and no upstream to track.

That repository adapts material from two MIT-licensed projects. Their license
texts are kept beside this file, and the sources are listed per skill below.

| Upstream | Copyright | Pinned commit | License |
| --- | --- | --- | --- |
| [mattpocock/skills](https://github.com/mattpocock/skills) | © 2026 Matt Pocock | [`4ae2317`](https://github.com/mattpocock/skills/tree/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d) | [MIT](mattpocock-skills.LICENSE) |
| [cursor/plugins `pstack`](https://github.com/cursor/plugins/tree/main/pstack) | © 2026 Lauren Tan | [`6b03002`](https://github.com/cursor/plugins/tree/6b0300214a09fd6029cfb7077043125758cd1fd2/pstack) | [MIT](pstack.LICENSE) |

## Per-skill sources

Paths are relative to each upstream repository at the pinned commit.

| Skill | Sources |
| --- | --- |
| `in-your-own-words` | pstack `skills/in-your-own-words`; Matt `skills/productivity/grilling` |
| `blast-radius` | pstack `skills/blast-radius` |
| `tdd` | Matt `skills/engineering/tdd` (with `tests.md`, `mocking.md`); pstack `skills/tdd` |
| `diagnosing-bugs` | Matt `skills/engineering/diagnosing-bugs` (with `scripts/hitl-loop.template.sh`); pstack `skills/principle-fix-root-causes` |
| `prove-it-works` | pstack `skills/principle-prove-it-works` |
| `idempotent-operations` | pstack `skills/principle-make-operations-idempotent` |
| `benchmark-checklist` | pstack `skills/benchmark-checklist` |
| `show-me-your-work` | pstack `skills/show-me-your-work` (with `scripts/log.sh` and the TSV template) |
| `to-spec` | Matt `skills/engineering/to-spec` |
| `to-tickets` | Matt `skills/engineering/to-tickets` |
| `implement` | Matt `skills/engineering/implement`, `skills/engineering/implement-spec`; pstack `skills/principle-sequence-verifiable-units`, `skills/principle-subtract-before-you-add` |
| `handoff` | Matt `skills/productivity/handoff` |

## What changed on the way in

The skills were edited to fit this repository rather than kept as copies:

- **One review pipeline.** The adapted `review-change` skill was folded into
  `REVIEW_GUIDELINES.md`, which is what `/review` appends and what a
  triage-launched reviewer follows. `prove-it-works` now says plainly that it is
  the author's proof, not a review, and that it never starts a reviewer. A change
  gets one independent review, only when asked, through `/review` or through
  `triage_change` and one approved sub-agent — never both.
- **`show-me-your-work` narrowed** to a big task left unsupervised for a long
  time, and its independent-review step removed: it self-audits, and if a review
  is commissioned the trail goes to that one reviewer.
- **pi invocation syntax.** pi runs a user-invoked skill as `/skill:<name>`, so
  the four entry points and their cross-references spell it that way.
- **Repository specifics.** `implement` defers commits to the `commit` skill and
  worktrees to the `worktree` skill; `prove-it-works` reads the gate from
  `AGENTS.md` (there is no `.agent/quality.yaml`); `handoff` writes under the
  persistent agent dir instead of `/tmp` and is disambiguated from the `subagent`
  tool's context-handoff modes.
- **Executable bits.** `diagnosing-bugs/scripts/hitl-loop.template.sh` and
  `show-me-your-work/scripts/log.sh` are executable here; upstream ships them
  mode 100644 while its own `validate.py` requires the bit, so its quality gate
  fails on a fresh clone.

# Data source attribution

The dataset under `data/`, and the recorded source payloads used as test fixtures,
are derived from **Leaguepedia | League of Legends Esports Wiki**
(<https://lol.fandom.com>), which is licensed **CC BY-SA 3.0**
(<https://www.fandom.com/licensing>). The wiki reports that licence itself in its
`siteinfo` (`rightsinfo`), and this notice states it rather than assumes it.

Attribution starts at the first commit that contains source-derived material —
which is the transcribed field inventory in `docs/specs/` and the recorded payload
fixtures, not the first committed dataset. Reusing the derived data therefore
requires crediting Leaguepedia and sharing derivative work alike.

The committed dataset carries real crawled data for every event the selection rule
admits — all 54 of them, after ticket 16's crawl of every edition the rule admits — each
fetched through `tools/dataset/fetch.ts` and recorded with its query, URL, fetch time and
body hash. Counts are the committed rows (`games.jsonl` / `matches.jsonl`):

| Event | Games | Series |
|---|---|---|
| Worlds Season 1 | 28 | 21 |
| WCG 2011 | 0 | 0 |
| IEM Season 6 World Championship | 44 | 36 |
| Worlds Season 2 | 31 | 19 |
| IPL 5 | 72 | 36 |
| IEM Season 7 World Championship | 41 | 35 |
| Worlds Season 3 | 63 | 48 |
| World Cyber Games 2013 | 0 | 48 |
| IEM Season 8 World Championship | 18 | 13 |
| Worlds 2014 | 78 | 57 |
| IEM Season 9 World Championship | 19 | 13 |
| MSI 2015 | 28 | 18 |
| Worlds 2015 | 73 | 56 |
| IEM Season 10 World Championship | 25 | 13 |
| MSI 2016 | 41 | 33 |
| Worlds 2016 | 77 | 57 |
| IEM Season 11 World Championship | 27 | 13 |
| MSI 2017 | 78 | 61 |
| Rift Rivals 2017 GPL-LJL-OPL | 18 | 18 |
| Rift Rivals 2017 LLN-CLS-CBLOL | 22 | 22 |
| Rift Rivals 2017 NA-EU | 21 | 19 |
| Rift Rivals 2017 LCK-LPL-LMS | 21 | 21 |
| Rift Rivals 2017 LCL-TCL | 19 | 17 |
| Worlds 2017 | 119 | 88 |
| MSI 2018 | 74 | 61 |
| Rift Rivals 2018 SEA-LJL-OPL | 19 | 19 |
| Rift Rivals 2018 LLN-CLS-CBLOL | 21 | 21 |
| Rift Rivals 2018 LCL-TCL-VCS | 19 | 19 |
| Rift Rivals 2018 LCK-LPL-LMS | 20 | 20 |
| Rift Rivals 2018 NA-EU | 13 | 13 |
| Worlds 2018 | 119 | 88 |
| MSI 2019 | 79 | 61 |
| Rift Rivals 2019 NA-EU | 13 | 22 |
| Rift Rivals 2019 LCK-LPL-LMS-VCS | 19 | 19 |
| Worlds 2019 | 120 | 88 |
| Mid-Season Cup 2020 | 25 | 17 |
| Worlds 2020 | 114 | 84 |
| MSI 2021 | 81 | 70 |
| Worlds 2021 | 121 | 87 |
| MSI 2022 | 77 | 72 |
| Worlds 2022 | 127 | 94 |
| MSI 2023 | 76 | 25 |
| Worlds 2023 | 110 | 52 |
| MSI 2024 | 78 | 24 |
| Esports World Cup 2024 | 19 | 7 |
| Worlds 2024 | 106 | 50 |
| First Stand 2025 | 35 | 13 |
| MSI 2025 | 80 | 19 |
| Esports World Cup 2025 | 33 | 18 |
| Worlds 2025 | 84 | 41 |
| First Stand 2026 | 45 | 13 |
| MSI 2026 | 71 | 21 |
| Esports World Cup 2026 | 232 | 122 |
| Worlds 2026 | 98 | 46 |

The crawls also fetched the identity registries wholesale (`Teams`, `TeamRedirects`,
`PlayerRedirects`, `Champions`, `Tournaments`), so the team, player and champion tables are
derived from Leaguepedia pages as well as from scoreboard rows.

Every payload the build read is a Cargo query over one of ten wiki tables —
`Tournaments`, `ScoreboardGames`, `ScoreboardPlayers`, `MatchSchedule`, `PicksAndBansS7`,
`Teams`, `TeamRedirects`, `PlayerRedirects`, `Champions` and `IndividualAchievements` —
cached with its query, URL, fetch time and body hash, and pinned by path in
`data/curated/manifest.json` (287 payloads at the time of writing). Those cached bodies are
the wiki's response bodies, so they are covered by this attribution too, not only the rows
derived from them. The attribution
that travels with the data lives in [`data/ATTRIBUTION.md`](../data/ATTRIBUTION.md), which
restates the CC BY-SA obligations for anyone publishing output built on the dataset; the
analyst-facing guide is [`docs/dataset/using-the-dataset.md`](../docs/dataset/using-the-dataset.md).

The notice grows with the data: an event whose **games** are committed is named here in
the same change that commits them. Recorded payloads that name other events — the
ticket-02 identity probes for IPL 5 and the 2015 season, for example — are covered by
the general attribution above rather than listed one by one; they carry players and
teams, not games, and none of their rows is in the committed dataset.

Riot Games' own material — champion and item data from Data Dragon, anything from
the LoL Esports API — is not covered by that licence and is used under Riot's terms,
not CC BY-SA.
