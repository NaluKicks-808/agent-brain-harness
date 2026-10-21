#!/usr/bin/env bash
# macOS/Linux wrapper: runs harness.py with python3.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
exec python3 "$DIR/harness.py" "$@"
