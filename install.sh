#!/bin/sh
# agent-brain-harness installer for macOS and Linux.
#   curl -fsSL https://raw.githubusercontent.com/NaluKicks-808/agent-brain-harness/main/install.sh | sh
#   git clone https://github.com/NaluKicks-808/agent-brain-harness && cd agent-brain-harness && ./install.sh
# Flags (pass after "sh -s --" when piping): --yes --dry-run --uninstall --dir PATH --no-path
#   --claude-hook | --no-claude-hook --no-brain
# This file only finds Python 3.8+ and the source, then hands over to install.py.
set -eu

REPO="${AGENT_BRAIN_HARNESS_REPO:-https://github.com/NaluKicks-808/agent-brain-harness.git}"
REF="${AGENT_BRAIN_HARNESS_REF:-main}"

say() { printf '%s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

# 1. a Python that is 3.8 or newer
PY=""
for cand in python3 python; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import sys; sys.exit(sys.version_info < (3, 8))' 2>/dev/null; then
    PY="$cand"; break
  fi
done
if [ -z "$PY" ]; then
  case "$(uname -s)" in
    Darwin) how="run: xcode-select --install   (or install Python from python.org)" ;;
    *) how="run: sudo apt install python3   (or: sudo dnf install python3)" ;;
  esac
  die "Python 3.8 or newer is missing. Get it: $how. Then rerun this installer."
fi

# 2. the source: the folder this script is in (a clone), or a fresh shallow clone of the repo
SRC=""; TMP=""
case "$0" in
  */*) HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || HERE="" ;;
  *) HERE="" ;;
esac
if [ -n "$HERE" ] && [ -f "$HERE/harness.py" ] && [ -f "$HERE/install.py" ]; then
  SRC="$HERE"
else
  command -v git >/dev/null 2>&1 || die "git is missing, and it is needed to download the harness. Get it: $( [ "$(uname -s)" = Darwin ] && echo 'run: xcode-select --install' || echo 'run: sudo apt install git   (or: sudo dnf install git)' ). Then rerun."
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/agent-brain-harness.XXXXXX")
  trap 'rm -rf "$TMP"' EXIT INT TERM
  say "Downloading $REPO ($REF) ..."
  git clone -q --depth 1 --branch "$REF" "$REPO" "$TMP/src" || die "could not download $REPO"
  SRC="$TMP/src"
fi

# 3. when piped (curl | sh) stdin is the script, so questions go to the terminal if there is one
if [ ! -t 0 ] && ( : </dev/tty ) 2>/dev/null; then
  "$PY" "$SRC/install.py" --source "$SRC" "$@" </dev/tty
else
  "$PY" "$SRC/install.py" --source "$SRC" "$@"
fi
