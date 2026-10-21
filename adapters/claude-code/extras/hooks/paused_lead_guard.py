#!/usr/bin/env python3
"""PreToolUse: refuse messages to paused leads. A message wakes the whole context.
Ids live in harness/paused_sessions.json under the selected Claude configuration.
Use [unpause] only for owner-approved resumption or the agreed real-work wake condition.
Any error allows the message."""
import json, os, sys
try:
    p = json.load(sys.stdin)
    if p.get('tool_name') not in ('mcp__ccd_session_mgmt__send_message', 'SendMessage'):
        sys.exit(0)
    ti = p.get('tool_input') or {}
    target = str(ti.get('session_id') or ti.get('to') or '')
    text = str(ti.get('message') or '')
    paused = json.load(open(os.path.join(os.path.expanduser(os.environ.get('CLAUDE_CONFIG_DIR') or '~/.claude'), 'harness/paused_sessions.json')))
    if target in paused and not target.startswith('_') and not text.lstrip().startswith('[unpause]'):
        print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny',
            'permissionDecisionReason': f'{paused[target]} is paused (paused_sessions.json). Any message wakes it and reloads its whole context. Send nothing. Only if owner unpaused it or real work for it arrived, start the message with "[unpause]".'}}))
except Exception:
    pass
sys.exit(0)
