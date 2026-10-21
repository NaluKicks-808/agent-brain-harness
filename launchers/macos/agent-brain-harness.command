#!/usr/bin/env bash
# Double-click in Finder: opens Terminal and shows status or help. With arguments it just runs them.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
if [ "$#" -eq 0 ]; then
  cd "$HOME" || true
  bash "$DIR/agent-brain-harness.sh" doctor
  echo
  echo "Run: bash \"$DIR/agent-brain-harness.sh\" init <project-folder>"
  echo "Press Return to close."
  read -r _
else
  exec bash "$DIR/agent-brain-harness.sh" "$@"
fi
