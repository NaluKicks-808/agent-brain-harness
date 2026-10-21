#!/usr/bin/env bash
# Double-click in Finder: opens Terminal and shows status or help. With arguments it just runs them.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
if [ "$#" -eq 0 ]; then
  cd "$HOME" || true
  bash "$DIR/harness.sh" doctor
  echo
  echo "Run: bash \"$DIR/harness.sh\" init <project-folder>"
  echo "Press Return to close."
  read -r _
else
  exec bash "$DIR/harness.sh" "$@"
fi
