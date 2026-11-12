#!/usr/bin/env bash
set -euo pipefail

REPO=/workspace
AGENT_DIR=/home/vscode/.pi/agent

# The Dockerfile sets GH_CONFIG_DIR as an image ENV, but a container built from an
# older image does not have it. Default it here to the same path so a bare
# `mkdir -p "$GH_CONFIG_DIR"` below cannot expand to `mkdir -p ""`, which fails
# under `set -e` and aborts the whole of postCreate before anything else runs.
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-/home/vscode/.pi/gh}"

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

# --- pi package: this repo's extensions and skills ---
# User-level, so the declaration goes into "$SETTINGS" — on the pi-config volume,
# which is what makes it survive a rebuild. A rebuild re-runs this script, so the
# install is also what repairs a wiped or freshly created volume; re-running is
# idempotent and reconciles the clone to the tracked ref, picking up fixes.
#
# --no-approve because postCreate has no TTY to answer a project-trust prompt.
# Never fatal: a creation with no network must not abort the rest of this script
# (git identity, clipboard shim, gh config); pi loads the package on the next
# start or /reload once the declaration is there.
if command -v pi >/dev/null 2>&1; then
  pi install --no-approve git:github.com/RRiboulet/my-agent-setup \
    || echo '[postCreate] warning: could not install the pi package; extensions/skills will be missing until it succeeds' >&2
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
# The token is not in the image and never in git. It lives in the pi-config volume
# via GH_CONFIG_DIR (set in the Dockerfile), which is what makes one `gh auth login`
# last across rebuilds. Creating the directory here is all this needs to do; an
# unauthenticated gh is still useful (it reads public repos fine).
# sudo, and after the chown below: on a first-run volume the mount point inherits
# the image's root ownership, so a plain `mkdir -p` as vscode fails and `set -e`
# aborts postCreate before the chown that would have fixed it.

sudo chown -R vscode:vscode /home/vscode/.pi "$REPO"
mkdir -p "$GH_CONFIG_DIR"

if ! gh auth status >/dev/null 2>&1; then
  cat <<'MSG'

gh is installed but not authenticated. One-time setup, in this terminal:

  gh auth login --hostname github.com --git-protocol https --web

It prints a one-time code and a URL: open the URL, paste the code, approve. The
token lands in the pi-config volume, so it survives a rebuild. Then run

Nothing else is needed: git's credential helper is configured system-wide in
the Dockerfile, so plain `git push` works in a fresh container without this.
MSG
fi

echo "pi coding-agent ready. Sessions persist in the pi-agent-config volume."