#!/usr/bin/env python3
"""UserPromptSubmit: nudge handoffs before the 300k compaction backstop.
Leads and workers past 200k self-clear after finishing work or before going idle.
Other sessions get a nudge at 75% of the configured window. Any error is silent.
"""
import json, os, re, sys
WINDOW = int(os.environ.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW') or 300000)
NUDGE = int(WINDOW * 0.75)
STEP = 40000
CLEAR_AT = 200000  # self-clear at the next clean boundary
TIERS = os.path.join(os.path.expanduser(os.environ.get('CLAUDE_CONFIG_DIR') or '~/.claude'), 'hooks/state/role_card_tiers')
STATE = os.path.join(os.path.expanduser(os.environ.get('CLAUDE_CONFIG_DIR') or '~/.claude'), 'hooks/state/context_nudge')
try:
    p = json.load(sys.stdin)
    tp, sid = p.get('transcript_path') or '', str(p.get('session_id') or '')
    if not tp or not os.path.isfile(tp) or not sid:
        sys.exit(0)
    with open(tp, 'rb') as fh:
        fh.seek(max(0, os.path.getsize(tp) - 400000))
        tail = fh.read().decode('utf-8', 'ignore')
    m = re.findall(r'"usage":\{"input_tokens":(\d+),"cache_creation_input_tokens":(\d+),"cache_read_input_tokens":(\d+)', tail)
    if not m:
        sys.exit(0)
    ctx = sum(int(x) for x in m[-1])
    tf = os.path.join(TIERS, sid)
    tier = open(tf).read().strip() if os.path.isfile(tf) else ''
    self_clear = tier in ('lead', 'worker')
    if ctx < (CLEAR_AT if self_clear else NUDGE):
        sys.exit(0)
    os.makedirs(STATE, exist_ok=True)
    sf = os.path.join(STATE, sid)
    last = int(open(sf).read()) if os.path.isfile(sf) else 0
    if ctx - last < STEP:
        sys.exit(0)
    open(sf, 'w').write(str(ctx))
    if self_clear:
        msg = (f'CONTEXT {ctx//1000}k (usage diet: clear yourself past {CLEAR_AT//1000}k). When the current job is done '
               'and nothing you own is mid-run: rewrite your handoff file (~/.claude/harness/handoffs/<your slug>.md; '
               'workers: your report file) with state, running jobs, ids, next step; then end the turn by calling '
               'clear_session with session_id "self". The role card and handoff reload you. If mid-job, finish first.')
        print(json.dumps({'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': msg}}))
        sys.exit(0)
    msg = (f'CONTEXT {ctx//1000}k of ~{WINDOW//1000}k auto-compact point. At the next clean break (between steps, '
           'not mid-edit): rewrite your handoff file (~/.claude/harness/handoffs/<your slug>.md; Manager: manager.md) '
           'with state, running jobs, ids, next step. Then continue. Avoid big reads until compacted.')
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': msg}}))
except Exception:
    sys.exit(0)
