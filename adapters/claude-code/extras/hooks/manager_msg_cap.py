#!/usr/bin/env python3
"""Refuse long cross-session messages addressed to the Manager session.
Why: owner (2026-10-14): "messages are still taking up a lot of context". Every lead report lands
in the Manager's context whole, so details belong in an inbox file and the message carries a pointer.
Applies to mcp__ccd_session_mgmt__send_message whose session_id is the Manager. Any error lets it through.
"""
import json, os, sys
CONFIG = os.path.expanduser(os.environ.get('CLAUDE_CONFIG_DIR') or '~/.claude')
# Configure the destination instead of shipping the original account's session id.
try:
    MANAGER = json.load(open(os.path.join(CONFIG, 'harness/config.json'))).get('managerSessionId', '')
except Exception:
    MANAGER = ''
CAP = 50
try:
    p = json.load(sys.stdin)
    ti = p.get("tool_input") or {}
    if not MANAGER or ti.get("session_id") != MANAGER:
        sys.exit(0)
    words = len((ti.get("message") or "").split())
    if words <= CAP:
        sys.exit(0)
    sys.stderr.write(
        f"Message to Manager is {words} words; the cap is {CAP}. Write the full report to "
        "~/.claude/harness/inbox/<YYYY-MM-DD-HHMM>-<your title>.md, then send the Manager at most "
        f"{CAP} words: the verdict (ship / needs owner / break / FYI), the one ask with its default if any, "
        "and the file path. Agent register: no recaps.\n")
    sys.exit(2)
except SystemExit:
    raise
except Exception:
    sys.exit(0)
