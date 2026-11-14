#!/usr/bin/env bash
set -euo pipefail

REPO=/workspace
AGENT_DIR=/home/vscode/.pi/agent

# The Dockerfile sets GH_CONFIG_DIR as an image ENV, but a container built from an
# older image does not have it. Default it here to the same path so a bare
# `mkdir -p "$GH_CONFIG_DIR"` below cannot expand to `mkdir -p ""`, which fails
# under `set -e` and aborts the whole of postCreate before anything else runs.
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-/home/vscode/.pi/gh}"

# The private volume's mount point can arrive root-owned on a first run, and a
# bind mount can arrive owned by a host uid that does not match vscode. Repair
# both before anything below writes into them; with `set -e`, a failed write
# would abort the rest of postCreate (git identity, clipboard, gh config).
sudo chown -R vscode:vscode /home/vscode/.pi "$REPO"

# --- zsh + Powerlevel10k ---
# The common-utils feature creates ~/.zshrc before postCreate runs.
touch ~/.zshrc
grep -qxF 'source /home/vscode/.aliases.zsh' ~/.zshrc || echo 'source /home/vscode/.aliases.zsh' >> ~/.zshrc
grep -qxF 'source /home/vscode/powerlevel10k/powerlevel10k.zsh-theme' ~/.zshrc || echo 'source /home/vscode/powerlevel10k/powerlevel10k.zsh-theme' >> ~/.zshrc
grep -qxF '[[ -f ~/.p10k.zsh ]] && source ~/.p10k.zsh' ~/.zshrc || echo '[[ -f ~/.p10k.zsh ]] && source ~/.p10k.zsh' >> ~/.zshrc

cp "$REPO/.devcontainer/shell/p10k.zsh" /home/vscode/.p10k.zsh

# tmux config: used by pi's tmux-backed subagents.
cp "$REPO/.devcontainer/shell/tmux.conf" /home/vscode/.tmux.conf

# --- pi configuration ---
mkdir -p "$AGENT_DIR/themes"
cp "$REPO/.devcontainer/pi/themes/kokomi-theme.json" "$AGENT_DIR/themes/kokomi-theme.json"

# Select the theme WITHOUT clobbering the rest of the user's settings: the
# previous version wrote settings.json wholesale, which silently discarded
# anything else configured on the machine.
SETTINGS="$AGENT_DIR/settings.json"
if [ -f "$SETTINGS" ] && command -v jq >/dev/null 2>&1; then
  jq --arg t kokomi-theme '.theme = $t' "$SETTINGS" > "$SETTINGS.tmp" \
    && mv "$SETTINGS.tmp" "$SETTINGS" \
    || echo '{"theme": "kokomi-theme"}' > "$SETTINGS"
else
  echo '{"theme": "kokomi-theme"}' > "$SETTINGS"
fi

# --- pi package from the image (pinned) ---
# The image clones RRiboulet/my-agent-setup at the tag in
# .devcontainer/pi-agent-setup.version and labels it. This container only
# declares that baked copy in its own agent settings; it never fetches the
# package. A stale image (repo pin bumped, image not rebuilt) fails here rather
# than silently loading the previous release.
PI_PACKAGE=/opt/pi-packages/my-agent-setup
PI_PACKAGE_TAG_FILE="$PI_PACKAGE/.pi-agent-setup-tag"
EXPECTED_TAG="$(tr -d '[:space:]' < "$REPO/.devcontainer/pi-agent-setup.version")"
if [ ! -d "$PI_PACKAGE" ] || [ ! -f "$PI_PACKAGE_TAG_FILE" ]; then
  echo "postCreate: missing baked pi package at $PI_PACKAGE; rebuild the image" >&2
  exit 1
fi
ACTUAL_TAG="$(tr -d '[:space:]' < "$PI_PACKAGE_TAG_FILE")"
if [ "$ACTUAL_TAG" != "$EXPECTED_TAG" ]; then
  echo "postCreate: image carries $ACTUAL_TAG but this checkout pins $EXPECTED_TAG; rebuild the image (devc rebuild lol-dataset)" >&2
  exit 1
fi

# User-level declaration, absolute so the path does not depend on where the
# agent dir lives. Remove any older git clone entry first: two entries would
# load the same extensions twice, and pi exits on the duplicate tools.
if ! command -v jq >/dev/null 2>&1; then
  echo "postCreate: jq is required to declare the baked pi package" >&2
  exit 1
fi
jq --arg pkg "$PI_PACKAGE" '
  .packages = (((.packages // [])
    | map(select((if type == "object" then (.source // "") else . end) | tostring | test("my-agent-setup") | not))) + [$pkg])
' "$SETTINGS" > "$SETTINGS.tmp" && [ -s "$SETTINGS.tmp" ] \
  && mv "$SETTINGS.tmp" "$SETTINGS" \
  || { rm -f "$SETTINGS.tmp"; echo "postCreate: could not record $PI_PACKAGE in $SETTINGS" >&2; exit 1; }

# Project trust makes /workspace/.pi/settings.json effective. Merge, never
# replace: an older volume may trust another path.
TRUST="$AGENT_DIR/trust.json"
if [ -f "$TRUST" ] && ! jq -e . "$TRUST" >/dev/null 2>&1; then
  rm -f "$TRUST"
fi
if [ -f "$TRUST" ]; then
  jq --arg repo "$REPO" '. + {($repo): true}' "$TRUST" > "$TRUST.tmp" && mv "$TRUST.tmp" "$TRUST"
else
  jq -n --arg repo "$REPO" '{($repo): true}' > "$TRUST.tmp" && mv "$TRUST.tmp" "$TRUST"
fi

# Note: extensions and skills live in "$REPO/.pi/" itself (that directory is
# gitignored). Do not link them from "$REPO/extensions" and "$REPO/skills" —
# those paths no longer exist, and "ln -sfn" would drop a dangling symlink
# *inside* the real directories.

# --- git identity ---
# Commit metadata is public the moment a branch is pushed: the author and
# committer addresses and every `Co-authored-by:` trailer live in the commit
# object, so a personal address there can only be removed by rewriting every
# branch and tag — and even then it survives in forks and in GitHub's cached
# commit views. Pin the identity to the GitHub noreply address before any commit
# can be made.
#
# Apply it here because a personal identity does not belong in an image others
# may build, and postCreate re-runs on every container creation. `--global`,
# matching the scope `git commit` reads.
#
# The identity is derived from whoever is authenticated with gh, not baked in as
# a name and address: this repository is shared between two people, and each one
# pushes from their own account. Deriving it keeps every commit attributed to
# the account that pushed it, and keeps the address a GitHub noreply one, which
# is what makes a personal address impossible to leak into public history.
if gh auth status >/dev/null 2>&1 \
  && gh_login=$(gh api user --jq .login 2>/dev/null) \
  && gh_id=$(gh api user --jq .id 2>/dev/null) \
  && [ -n "$gh_login" ] && [ -n "$gh_id" ]; then
  git config --global user.name "$gh_login"
  git config --global user.email "${gh_id}+${gh_login}@users.noreply.github.com"
else
  # Offline or not logged in yet: leave any existing identity alone rather than
  # guessing, and say so, because a commit made now would carry a default one.
  echo "[postCreate] gh is not authenticated (or the API is unreachable); git identity left as-is." >&2
  echo "[postCreate]   run: gh auth login --hostname github.com --git-protocol https --web" >&2
fi

# --- clipboard ---
# The host injects WAYLAND_DISPLAY and DISPLAY into the container, but neither
# socket exists here. pi's clipboard helper then finds no wl-copy/xclip and
# reports the clipboard as unavailable. Install the OSC 52 shim under all three
# names so whichever it tries works, and the outer terminal owns the clipboard.
sudo install -m 0755 "$REPO/.devcontainer/shell/osc52-clipboard" /usr/local/bin/osc52-clipboard
for helper in wl-copy xclip xsel; do
  sudo ln -sf /usr/local/bin/osc52-clipboard "/usr/local/bin/$helper"
done

# --- gh (GitHub CLI) ---
# The token is not in the image and never in git. It arrives as GH_TOKEN from
# the host environment (devcontainer.json), so this container gets the same
# credential as the others without sharing a volume. GH_CONFIG_DIR only holds
# gh's non-secret config on this container's private volume. Creating the
# directory here is all this needs to do; an unauthenticated gh is still useful
# (it reads public repos fine). The volume was chowned above, before the first
# write into it.
mkdir -p "$GH_CONFIG_DIR"

if ! gh auth status >/dev/null 2>&1; then
  cat <<'MSG'

gh is installed but not authenticated. One-time setup, in this terminal:

  gh auth login --hostname github.com --git-protocol https --web

It prints a one-time code and a URL: open the URL, paste the code, approve. The
token is stored by gh in GH_CONFIG_DIR on this container's private volume, so it
survives a rebuild, but the supported path here is GH_TOKEN from the host
environment (`~/.config/devc/env`, sourced by devc). Then run

Nothing else is needed: git's credential helper is configured system-wide in
the Dockerfile, so plain `git push` works in a fresh container without this.
MSG
fi

echo "pi coding-agent ready. Sessions persist in the private lol-dataset-pi-config volume."