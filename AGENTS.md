# Agent Notes

`lol-dataset` is a complete dataset of the League of Legends World Championship,
from the first tournament through the one being played right now (2026). It is
the first step of a larger project, so the shape of the data matters more than
speed: expect schema decisions to outlive the scrapers that fill them.

**Current state: the agent scaffold only.** There is no dataset yet and no
`README.md` on purpose. The devcontainer, pi extensions, skills and templates
are in place so that project-specific structure can be added on top without
redoing the environment. Do not invent a schema, a scraper or a README as a
side effect of an unrelated task; those are their own changes.

The scaffold — `.devcontainer/`, `.pi/extensions/`, `.pi/skills/`, `bin/devc`,
`package.json`, this file, `REVIEW_GUIDELINES.md` — is copied from
[`RRiboulet/my-agent-setup`](https://github.com/RRiboulet/my-agent-setup),
which is where it is maintained. The skills carry rules written for that
repository; they apply here too, and the differences are noted in place below.
Improvements belong upstream first, so the two copies do not drift.

## Branches

Two long-lived branches, and everything else hangs off them:

| Branch | What lands on it |
|---|---|
| `dev` | all work in flight. Every feature branch starts here. |
| `main` | releases only. Nothing is built here; it is what a tag points at. |

**Start a feature branch from `dev`, never from `main` and never from another
feature branch.** Branch names name the change, not the session:
`worlds-2026-schedule`, `fix-changelog-unreleased-structure`.

A branch merges into `dev` through a pull request. `dev` merges into `main` at
release time (see "Releases"). `main` is therefore always releasable, and a
half-finished change is never one merge away from a tag.

### Check your base before you commit

Two checks, and **both are needed**, because the two ways of getting this wrong
look different:

```bash
git fetch origin
git merge-base --is-ancestor dev HEAD    # 0 = base is right, 1 = it is not
git log --oneline dev..HEAD              # should list ONLY this change's commits
```

The ancestor check catches the mistake that actually happens: branching off
`main`, or off a `dev` that had fallen behind. In that case `git log dev..HEAD`
prints **nothing** — HEAD simply has nothing `dev` lacks — so a check based only
on that log reports a clean branch that is quietly based on the wrong commit.
The log is the second half: once the ancestor check fails, it tells you *what* is
in the way.

| Situation | `git log dev..HEAD` | `merge-base --is-ancestor` |
|---|---|---|
| branched off `main`, which is behind `dev` | empty — **misses it** | **fails** — catches it |
| foreign commits stacked on `dev` | lists them | passes — correct, base is right |
| correct branch off `dev` | only my commits | passes |

`git fetch` first is not a detail. The check is only as good as the ref it
compares against, and a stale local `dev` will happily list other PRs' commits
as yours — the same false alarm as the bug it is meant to catch, and just as
likely to be ignored.

A branch legitimately based on **another unmerged feature branch** still shows
foreign commits, and neither check can tell that apart from a mistake. Subtract
the base branch explicitly (`git log dev..feature-a`) or rebase onto `dev` first.

### Why a branch per change

`CHANGELOG.md`'s `Unreleased` section is shared ground. Two changes in flight
both add a `Maintenance` bullet there, so parallel branches conflict on merge
even when their code does not. A branch keeps one change's tests, files and
changelog entry together, and makes each one independently verifiable: check it
out in a worktree and run the suite before assuming it stands alone.

## Pull requests

Branches reach GitHub through `gh`, which is baked into the devcontainer image
(`.devcontainer/Dockerfile`) rather than installed at runtime, so a rebuild does
not silently drop it. The token lives in the `pi-agent-config` volume via
`GH_CONFIG_DIR=/home/vscode/.pi/gh`, which is what makes one `gh auth login` last
across rebuilds — `/home/vscode` itself is container-local and is discarded.

One-time setup, run by the human (it needs a browser):

```bash
gh auth login --hostname github.com --git-protocol https --web
```

That is the whole setup. `git push` then works with no credential in
`.git/config`, because the Dockerfile registers gh as git's credential helper
system-wide — deliberately, not via `gh auth setup-git`, which writes to
`~/.gitconfig` on the container-local overlay and is discarded on rebuild. The
token would survive that; the helper would not, and push would break silently.

Check *where* the token lives before trusting a login: `gh auth status` prints the
path, and that path decides whether it survives.

## The workflow

Once authenticated:

1. Work on a branch (see "Branches"), committing as the `.pi/skills/commit/`
   skill directs.
2. `git push -u origin <branch>`
3. `gh pr create --base dev --fill` — the explicit `--base dev` is required:
   this repository's **default branch is `main`**, and `gh pr create` with no
   `--base` opens the pull request against that default, so the unqualified
   command silently targets `main` — which takes releases only. A branch cut
   from `dev` then drags every change merged since the last release into `main`
   with it, because the squash replays the whole branch. `--fill` uses the
   commits for title and body; check the title it produced, since `--fill` falls
   back to the branch name when it cannot read a single commit. Always say in the
   body what a reviewer should check and what you verified.
4. `gh pr merge --squash --delete-branch`. `--delete-branch` is not optional
   politeness: a squash merge does not put the branch tip in `dev`'s history, so
   a later `git branch -d <branch>` fails with "not fully merged" and needs `-D`.
   Letting gh delete both the local and the remote branch avoids both.
5. Bring `dev` up to date: `git checkout dev && git pull --ff-only`.

Tags are cut from `main`, never from a feature branch.

Never put a token in `.git/config`, in the Dockerfile, or in a file in the repo.
If authentication is needed mid-session, stop and ask rather than improvising.

Note the consequence for step 1 of any changelog work: after a squash merge the
branch's individual commits no longer exist in `main`, so release notes are
written from PR titles and bodies, not from `git log`.

## Releases

A release is the only thing that moves `main`. Everything since the last tag
accumulates on `dev`; `main` is brought forward and tagged.

1. On `dev`, update `CHANGELOG.md`: retitle `## Unreleased` to
   `## vX.Y.Z — <today's date>`, and add a fresh empty `## Unreleased` above it.
   Nothing else in the file moves. `.pi/skills/update-changelog/` has the detail,
   and `changelog-structure.test.ts` enforces the shape.
2. Commit that, push `dev`, and open a pull request **`dev` → `main`**. This is
   the one merge that is not a squash: a release wants its history, and `main`'s
   commits should be the real ones. Use "Rebase and merge" or "Merge commit",
   never "Squash".
3. `gh pr merge <n> --merge` — **do not pass `--delete-branch`.** The head of
   this pull request is `dev`, so that flag would delete the long-lived
   integration branch. This is the one merge where the head branch must
   survive.
4. Tag the merge commit on `main` and push the tag:
   `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`.
5. Fast-forward `dev` to the release merge, so the new tag is reachable from
   `dev`:

   ```bash
   git checkout dev && git merge --ff-only main && git push origin dev
   ```

   Skipping this leaves the tag on `main` only, and `git describe --tags` on
   `dev` then reports the *previous* release — which is the baseline
   `.pi/skills/update-changelog/` reads, so the next release re-reads work that
   already shipped. It never stops being necessary on its own: every release
   mints a fresh merge commit that `dev` does not otherwise contain.

Versions are git tags. `package.json` also carries a `pi` manifest listing the
extension entry points and skills, which is what lets this repository be
installed into another project as a pi package.

## Extensions

Pi extensions live in `./.pi/extensions` and skills in `./.pi/skills`. When
working in this repo, add or update them there.

Codemode is enabled for this repo (see `.pi/settings.json`: `defaultTools`
includes `+codemode`, `codemode.mode` is `on`). Prefer codemode to batch
independent tool calls, run several calls in parallel, and filter large
output before it reaches the model; use the direct tools (`read`, `edit`,
`write`, `bash`) for one-off, single-step work where a script adds no value.
`.pi/settings.json` is committed here, unlike upstream: a fresh clone should be
configured the same way.

Adding a new extension or skill means adding it to the `pi` manifest in
`package.json` as well: it lives in a dot-prefixed directory, which package
discovery will not glob, so an unlisted extension installs nowhere.
`.pi/extensions/subagent/test/package-manifest.test.ts` fails if the manifest and
the tree disagree.

Linked worktrees for independent tasks live under `.worktrees/` at the repo root
(see `.pi/skills/worktree/`); that directory is gitignored and shared refs mean
branch names must be unique across worktrees.

You can consult pi for reference — the installed `@earendil-works/pi-coding-agent`
docs at `/usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/` are the
source of truth for the API this code targets — but do not modify pi itself.

## Coding skills

Twelve skills adapted from
[RRiboulet/agent-coding-skills](https://github.com/RRiboulet/agent-coding-skills)
cover the coding loop. They carry this repo's rules in their bodies, and
`licenses/NOTICE.md` records the MIT provenance. They are advertised by their
descriptions, so load one when its trigger applies rather than waiting to be
told:

- Trivial, unambiguous edit: make it, then check it. No ceremony.
- Non-trivial or ambiguous request: `in-your-own-words` before building.
- A change crossing a module, service, API, schema or config boundary:
  `blast-radius`.
- A bug, failing test, CI failure, crash, flake or regression: `diagnosing-bugs`.
- New or changed behavior with a testable seam: `tdd`.
- Retries, queues, webhooks, jobs, migrations or setup scripts:
  `idempotent-operations`.
- Producing or acting on a performance number: `benchmark-checklist`.
- A **big task left unsupervised for a long time** — hours of work the user did
  not watch and will judge afterwards: `show-me-your-work`. Not for ordinary
  sessions.
- Before saying work is done: `prove-it-works`.

Only the user starts the four user-invoked entry points, which pi spells
`/skill:<name>`: `/skill:to-spec`, `/skill:to-tickets`, `/skill:implement`,
`/skill:handoff`. Suggest them when they fit; never start them yourself.

Three repo rules win over those skill bodies, and the skills say so in place:

- **Commits** follow the `commit` skill (branch and base checks), not
  `implement`'s looser "commit on the current branch".
- **Worktrees** live under `.worktrees/` per the `worktree` skill.
- **Reviews** follow the next section: one per change, only when asked, and
  `prove-it-works` never starts one. `implement` therefore ends at proof, not at
  a review.

## Subagent tools

The five management tools — `subagent_status`, `subagent_cancel`,
`subagent_interrupt`, `subagent_resume`, `subagent_clean` — are **not declared**
in this repo's sessions: `defaultTools: ["+tool_search", "+codemode"]` in
`.pi/settings.json` puts them behind `tool_search` so their descriptions and
schemas stop riding along on every request. `subagent` itself stays declared.

So reach them in two steps:

1. `tool_search` for the tool you want.
2. Then call it, e.g. `subagent_status({ id })`.

There is no blocking wait, so collecting a result means polling
`subagent_status` — `subagent_status({ compact: true })` is the cheap
one-line-per-run form, and the single-run path is the one that returns output.

## Reviews: one per change, and only when asked

There is **one** review pipeline, and it starts only on request. `prove-it-works`
is how the author proves and reports a change; it is not a review and it never
commissions one. Do not run a review because a change feels non-trivial, because
a skill suggested it, or because `/review` and `/triage` both exist.

When the user asks for a review, pick exactly one door:

- **`/review`** when they want to drive it interactively (PR, branch, commit,
  folder, uncommitted). `/review` appends `REVIEW_GUIDELINES.md`, which carries
  the Spec / Correctness / Standards method and this repo's rules.
- **`triage_change` (or `/triage`) and one sub-agent** when they want an
  independent read without staying in the loop. Triage is
  **recommendation-only**: it measures the diff, asks the judge, and returns a
  plan; it never launches anything.

Never do both for the same change, and never start a second reviewer because the
first found little. The sub-agent must not spawn further reviewers.

**Always ask the user before launching a review subagent**, even when triage
recommends one. A recommendation is not an instruction, and a question that
merely *sounds* like it invites a review is not approval either: starting a
reviewer spends real tokens and runs an independent process, so it is the user's
call every time. Propose the lens and model, then wait for a yes.

When the user does approve one, the reviewer's `provider`, `model` and
`thinking` come from the `candidates` in `~/.pi/agent/review-triage.json`. Never
hand-pick a model outside that list: if a lens needs a model the config lacks,
add it to the config first. Which model sits in which capability band is a human
judgement, not the agent's.

A `show-me-your-work` trail does not get its own reviewer. If a review is
commissioned, hand the trail to that one reviewer alongside the diff.

## Tests

```bash
bash .pi/extensions/subagent/test/setup-deps.sh              # once: link pi's packages
node --test .pi/extensions/subagent/test/*.test.ts
node --test tools/dataset/test/*.test.ts                 # dataset: recorded fixtures, no network
(cd .pi/extensions/opencode-go-provider && node --test)  # provider package tests (separate tree)
```

Run it with `bash` (or `sh`), not as `./setup-deps.sh` — see "Line endings"
below. Node runs the TypeScript directly; there is no build step. See
`.pi/extensions/subagent/test/README.md` for what is and is not covered.

#### Typechecking: deliberately none

There is no `tsconfig.json` and no `tsc` in the tree, and this is on purpose.
`node --test` strips types without checking them, so a type error can survive
the suite — a known, accepted cost. Adding a typechecker would mean pulling in
the repo's first npm compiler dependency and reconciling the asymmetry between
pi's jiti loader and node's strip-only loader (TypeScript parameter properties
are one example). The bug class a typechecker catches is covered by the suite's
load guards instead. Inherited from `my-agent-setup`, which records the decision
at TODO-914d99f8.

## Line endings

`.gitattributes` sets `* text=auto eol=lf`, so git *normalizes* CRLF away on
comparison. Two consequences that `git status` cannot surface:

- A file whose blob is LF may still be **CRLF in your working tree** if it was
  checked out before `.gitattributes` existed. It shows as clean, yet bash
  fails on it (`$'\r': command not found`, `set: pipefail: invalid option`).
- `git add` does not fix an already-CRLF blob retroactively for files the
  attribute did not apply to when they were first committed.

If a shell script fails inexplicably, check it before trusting `git status`:

```bash
grep -qU $'\r' <file> && echo "CRLF in working tree"
```

Repair the whole tree with:

```bash
git add --renormalize .
git ls-files -z | xargs -0 rm -f && git checkout-index -a -f   # re-checkout applies eol=lf
```

Keep shell files LF. The devcontainer bakes them in verbatim, and a trailing
`\r` ends up inside sourced paths (`~/.aliases.zsh^M`).
