#!/usr/bin/env python3
"""Claude Code SessionStart hook: inject this session's harness role card.

Reads HARNESS_ROLE / HARNESS_TITLE (set by `harness launch`). Does nothing in
ordinary Claude Code sessions. Stdlib only.
"""
import json
import os
import sys
from pathlib import Path


def main():
    role = os.environ.get("HARNESS_ROLE", "")
    if role not in ("manager", "lead", "worker"):
        return
    ws = os.environ.get("HARNESS_DIR")
    base = Path(ws) if ws else Path(__file__).resolve().parent.parent
    card = base / "roles" / (role + ".md")
    if not card.is_file():
        return
    title = os.environ.get("HARNESS_TITLE", role)
    text = "You are %s.\n\n%s" % (title, card.read_text(encoding="utf-8"))
    sys.stdout.write(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart",
                                                        "additionalContext": text}}))


if __name__ == "__main__":
    main()
