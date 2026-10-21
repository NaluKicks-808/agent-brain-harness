#!/usr/bin/env python3
"""reply_check.py — a Stop hook. Four checks on Claude's final reply of a turn (staged 2026-09-30).

Checks: require proof for completion claims, receipts for absence claims, action rather
than repeated offers, and a concrete rule change after corrections. Questions, waits,
spending, sending, deletion and private data remain subject to the owner's approval.

HOW. Claude Code sends a JSON object on stdin (documented fields used: transcript_path,
stop_hook_active, last_assistant_message). The reply text comes from last_assistant_message,
because the transcript is written asynchronously and may lag; the turn's tool calls come from the
tail of the transcript, read backwards to the last message owner typed. It blocks at most once per
turn (stop_hook_active) with one short reason covering every check that fired, and fails open:
any error means exit 0 and no output.

SWITCHES. Set a check to False in CHECKS below to turn it off. Measured numbers: README.md.
"""
import json
import os
import re
import sys

CHECKS = {
    'done': True,
    'receipts': True,
    'stall': True,
    'closed': True,
    'voice': True,
}

# Lead and worker replies are checked after the turn. Voice feedback is saved for the
# next prompt so a voice correction does not make the user see the answer twice.
ID_SAFE = re.compile(r'^[0-9A-Za-z-]{8,64}$')
VOICE_TIERS = {'lead': 1300, 'worker': 1300}
VOICE_MIN = 300
VOICE_DENSITY = 8.0
PROSE_WORD = re.compile(r"\b(?:the|a|an|is|are|was|were|I'm|I'll|I've|so that|because|which)\b", re.I)
VOICE_EXEMPT = re.compile(r"```.*?```|^>.*$|\"[^\"\n]{40,}\"|“[^”\n]{40,}”|`[^`\n]*`|\S+/\S+|https?://\S+", re.S | re.M)


def session_tier(session_id):
    if not isinstance(session_id, str) or not ID_SAFE.fullmatch(session_id):
        return 'common'
    config = os.path.expanduser(os.environ.get('CLAUDE_CONFIG_DIR') or '~/.claude')
    try:
        with open(os.path.join(config, 'hooks', 'state', 'role_card_tiers', session_id), encoding='utf-8') as fh:
            return fh.read().strip()
    except OSError:
        return 'common'


def voice_hit(reply, tier):
    cap = VOICE_TIERS.get(tier)
    if not cap or not reply:
        return None
    body = VOICE_EXEMPT.sub(' ', reply)
    words = len(re.findall(r"[A-Za-z']+", body))
    density = 100.0 * len(PROSE_WORD.findall(body)) / max(words, 1)
    too_long = len(body) > cap
    prose = len(body) >= VOICE_MIN and density > VOICE_DENSITY
    if not (too_long or prose):
        return None
    why = []
    if too_long:
        why.append(f'{len(body)} characters outside code and quoted drafts (cap {cap} for a {tier})')
    if prose:
        why.append(f'{density:.0f}% narration words (target under {VOICE_DENSITY:.0f}%)')
    return 'Reply was too wordy: ' + '; '.join(why) + '. Next time, answer first and keep the summary brief.'

# Two wider settings, off by default because each pushes the measured fire rate over 1 reply in 6
# (numbers in README.md):
# - count a commit of the vault itself (safe_commit.sh, a <vault> push) as an outside effect for the
#   strong done-words (verified, working, fixed, installed, live). Adds 97 firings; catches 4 more cases.
DONE_COUNTS_VAULT_COMMITS = False
# - let "I can't …" / "only you can …" fire whenever nothing FAILED this turn, even if Claude read something.
#   Catches 8 of 33 cited cases instead of 1, at about 11 of 20 hand-read firings right; adds 68 firings.
RECEIPTS_CANT_NEEDS_FAILED_ATTEMPT = False

TAIL_CHUNK = 256 * 1024
TAIL_MAX = 24 * 1024 * 1024      # never read more than this much of a transcript

# ---------------------------------------------------------------- fix 1: proof of done
OUTSIDE_BASH = re.compile(
    r"\bgit\s+push\b|safe_commit\.sh|\bvercel\s+(?:[\w.=-]+\s+)*?(?:deploy|env\s+(?:add|rm|remove|update)|promote|redeploy)\b"
    r"|\bvercel\s+--prod\b|\blaunchctl\s+(?:load|unload|bootstrap|bootout|kickstart|enable|start)\b|\bcrontab\b(?!\s+-l)"
    r"|\bsupabase\s+(?:db|functions|migration|secrets)|\bpsql\b|apply_migration|execute_sql"
    r"|\bcurl\b[^\n|;&]*(?:-X\s*|--request[\s=]+)['\"]?(?:POST|PUT|PATCH|DELETE)\b",
    re.I)
# A vault commit (safe_commit.sh, or a push of the <vault> repo alone) is an outside effect only for the strong
# claims: on 2026-09-30 "committed and pushed (hash)" after a vault commit was 7 of the 9 wrong firings in 20.
_CONFIG = os.path.expanduser(os.environ.get('CLAUDE_CONFIG_DIR') or '~/.claude')
try:
    _VAULT = json.load(open(os.path.join(_CONFIG, 'harness/config.json'))).get('sourceOfTruthRepo') or ''
except Exception:
    _VAULT = ''
VAULT_ONLY = re.compile(r"safe_commit\.sh" + ("|" + re.escape(os.path.expanduser(_VAULT)) if _VAULT else ''), re.I)
STRONG_DONE = re.compile(
    r"\b(?:deployed|shipped|verified|working|fixed|installed)\b"
    r"|\b(?:is|are|now|went|goes|go|it[’']s|all) live\b|\blive (?:at|on|now|in production)\b",
    re.I)
OUTSIDE_MCP = re.compile(r"send|create|update|delete|deploy|apply|publish|submit|upload|record|complete", re.I)
MCP_READ_PREFIX = re.compile(r"^(?:get|list|search|read|fetch|query|find|tabs)", re.I)   # list_deployments is a read
VERCEL_READ = re.compile(r"\bvercel\s+env\s+ls\b", re.I)
DONE_WORD = re.compile(
    r"\b(?:done|deployed|shipped|verified|working|fixed|sent|installed|pushed)\b"
    r"|\b(?:is|are|now|went|goes|go|it[’']s|all) live\b|\blive (?:at|on|now|in production)\b",
    re.I)
HEADLINE, SIGNOFF = 600, 400      # the claim owner reads: the reply's opening or its last lines
TESTED_LINE = re.compile(r"tested through\s*:|not yet exercised", re.I)

# ---------------------------------------------------------------- fix 2: receipts
# "doesn't exist yet" describes something not built yet, not a claim that a search came back empty;
# those were 5 of the 9 wrong firings in the hand-read of all 17.
ABSENCE = re.compile(
    r"(?:not in the brain|doesn[’']t exist|does not exist|\bno record\b|not anywhere|never reached"
    r"|isn[’']t set up|is not set up|nothing there|isn[’']t installed|is not installed|not installed on)"
    r"(?![\w ]{0,12}\b(?:yet|today|until)\b)",
    re.I)
# "can't" only as a claim about reaching or doing something; "I can't tell you", "only you can decide" and
# "I can't not notice" were most of the wrong firings in the first 20-firing read.
CANT = re.compile(
    r"\bI (?:can[’']t|cannot) (?:reach|access|check|look|see(?! your (?:app|screen|phone|display))|get|open|read|run"
    r"|change|set|push|pull|deploy|install|connect|find|query|call|verify|prove|edit|write|create|fetch|download"
    r"|launch|start|diff|send|test|use|log ?in|sign in|do(?! (?:better|much|anything about|without)))\b"
    r"|\bonly (?:you|owner) can (?:do|paste|add|set|install|run|click|open|tap|turn|give|provide|enable|create|supply|grant|flip)\b",
    re.I)
CHECKED = re.compile(r"\bchecked\s*:", re.I)
READ_TOOLS = {'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookRead', 'ToolSearch'}
READ_MCP = re.compile(r"search|get|list|query|fetch|read|find|explain|status", re.I)
READ_BASH = re.compile(
    r"\b(?:find|deepfind|phone_writes|agenda)\.py\b|\bsqlite3\b|(?:^|[\s;&|(])gh\s|\bgit\s+(?:log|show|grep|fetch|status|diff|ls-files|ls-remote)\b"
    r"|(?:^|[\s;&|(])(?:grep|rg|cat|head|tail|ls|find|sed -n|jq|mdfind|curl|wc|stat|vercel\s+(?:ls|logs|inspect|env ls))\b",
    re.I)

# ---------------------------------------------------------------- fix 4: stall
OFFER = re.compile(
    r"\bsay (?:go|the word|yes)\b|\bwant me to\b|\bshall I\b|\bshould I\b|\blet me know if\b|\bwaiting on you\b"
    r"|\byour call\b|\bor should I\b|\bdo you want (?:me|to)\b|\bwould you like\b|\bif you(?:'d| would)? like,? I\b"
    r"|\bjust say\b|\bgive me the (?:go|word)\b",
    re.I)
AB_CHOICE = re.compile(r"\(a\)[^\n]{0,300}\(b\)", re.I | re.S)
NUMBERED = re.compile(r"^\s*(?:\*\*)?\(?\d\)?[.)]\s", re.M)
CHOICE_CUE = re.compile(r"\?|\boption|\bpick\b|\bchoose\b|\bwhich\b|\bor\b", re.I)
# The harness's own refusal wording. The brief's broader list (permission / denied / blocked by) also
# matched browser navigation failures and a database "permission denied", so it is narrowed to these.
REFUSAL = re.compile(
    r"Permission for this (?:action|command|tool use)? ?was denied|denied by (?:the |a )?(?:built-in )?Claude Code"
    r"|doesn[’']t want to proceed with this tool use|requires approval|not allowed by (?:your |the )?(?:permission|settings)"
    r"|blocked by (?:a |the )?(?:PreToolUse )?hook",
    re.I)
# after a refusal: the reply hands owner the refused step (a command to run, a paste, a Run button)
HANDOFF = re.compile(
    r"(?:\brun\b|\bpress\b|\bpaste\b|\bterminal\b|\bcommand:)[^\n]{0,120}\n+\s*```"
    r"|\bRun button\b|\bpress Run\b|\bfrom (?:a|your) terminal\b"
    r"|\b(?:do|test|run|click|push|press|paste|add|set|open|approve|authorize|install|edit)\b(?: [^.\n]{0,40})? yourself\b"
    r"|\byou(?:[’']ll| will)? (?:need|have) to (?:run|click|paste|press|authorize|approve|push)\b",
    re.I)
ALLOWLIST_ASK = re.compile(r"allowlist|allow ?rule|permissions\.allow", re.I)
# owner's message is a genuine question, or says wait (fix 12) → never push toward action
# fix 12: "can't we / is there no way / why not / why aren't you" is an order; a question about what is
# true, "what do you think", "think with me", "should we", "is X" stays a question.
ORDER_Q = re.compile(
    r"\bcan[’']?t (?:we|you)\b|\bcannot (?:we|you)\b|\bis there no way\b|\bwhy not\b"
    r"|\bwhy (?:aren[’']t|isn[’']t|don[’']t|didn[’']t|won[’']t|haven[’']t|can[’']t) (?:you|it|we|this)\b|\bwhy are you not\b",
    re.I)
REQUEST = re.compile(r"\b(?:can|could|will|would) you\b|\bplease\b|\blet[’']?s\b|\bgo ahead\b", re.I)
TRUE_Q = re.compile(
    r"\bwhat do you think\b|\bthink with me\b|\bshould we\b|\bthoughts\?|\bwdyt\b"
    r"|,? right\?|\bno\?\s*$"
    r"|(?:^|[.?!\n]\s*)(?:so |and |but |ok(?:ay)?,? )?(?:is|are|was|were|do|does|did|what|why|how|which|who|where|when|has|have)\b[^.?!\n]*\?",
    re.I)
# asking before a large spend is owner's own rule ("If it is expensive, always ask first")
SPEND = re.compile(r"\b(?:[2-9]\d{2}|1[5-9]\d)\s?k\b|\b(?:[2-9]\d{2}|1[5-9]\d),\d{3}\b|\b\d(?:\.\d)?\s?M tokens\b|\b(?:sub)?agents?\b|\bfan[- ]out\b|\bbuilders?\b", re.I)
WAIT = re.compile(r"\b(?:wait|hold (?:on|off)|stop|pause|not yet|don[’']t (?:build|start|do (?:it|that|anything)))\b", re.I)
SENSITIVE = re.compile(
    r"\$\s?\d|\b(?:money|price|pricing|pay|paid|payment|purchase|buy|invoice|charge|refund|billing|subscription"
    r"|send|sending|email|e-mail|text(?:ing)? (?:him|her|them|it|this)|imessage|sms|message (?:him|her|them)|post|publish|submit"
    r"|delete|deletion|remove|wipe|drop table|trash|purge"
    r"|client|customer|caller"
    r"|password|credentials?|access token|connection string|sign[- ]?in|log ?in)\b",
    re.I)
# An ending that already keeps one ask with its default is what fix 13 asks for, so it passes; so does a
# single optional extra offered in one line ("say the word if you want the rest folded in").
DEFAULT_GIVEN = re.compile(
    r"\bI recommend\b|\bmy recommendation\b|\bI[’']d (?:say|go with|suggest|pick|recommend|keep|start)\b|\bby default\b"
    r"|\botherwise I[’']ll\b|\bunless you\b|\bif I don[’']t hear\b|\bdefault(?:s)? (?:is|to)\b",
    re.I)
OPTIONAL_EXTRA = re.compile(r"\b(?:say the word|just say|let me know) if you(?:[’']d)? (?:want|rather|like|prefer)\b", re.I)
ASK_MARK = re.compile(r"\?|\bsay (?:go|the word|yes|which)\b|\bwant me to\b|\byour call\b|\bwaiting on you\b|^\s*(?:\*\*)?\d[.)]\s", re.I | re.M)
STOPWORDS = set('the a an to of and or in on for it is this that with me you i do now next want say go should shall let know if your my be can will'.split())

# ---------------------------------------------------------------- fix 14: closed only when enforced
NOTED = re.compile(
    r"\bfrom now on,? I(?:[’']ll| will)\b|\bI(?:[’']ll| will)\b[^.\n]{0,60}\bfrom now on\b"
    r"|(?:^|[.!?]\s+)(?:\*\*)?from now on\b"
    r"|\bgoing forward,? I(?:[’']ll| will)\b|\bI[’']ll remember\b|\blesson learned\b"
    r"|\bsaved (?:it |this |that )?(?:to|in) (?:memory|my memory)\b|\bsaved to memory\b"
    r"|\bI[’']ve saved (?:a|the|this|that|it|your)\b[^.\n]{0,40}\b(?:rule|memory|lesson|note)\b"
    r"|\bnoted for (?:next time|the future|future)\b|^\s*(?:\*\*)?noted\b[.,—:!]"
    r"|\bwon[’']t happen again\b|\bI won[’']t do that again\b",
    re.I | re.M)
ENFORCER_PATH = re.compile(r"hooks/|\.ingest-tools/|(?:^|/)tests?/|test_[^/]*$|\.py$|\.sh$|CLAUDE\.md$|lint", re.I)
EDIT_TOOLS = {'Edit', 'Write', 'MultiEdit', 'NotebookEdit'}
BASH_WRITES_ENFORCER = re.compile(r"(?:>|tee|sed -i|cp|mv)\s+[^\n|;&]*(?:hooks/|\.ingest-tools/|\.py\b|\.sh\b|CLAUDE\.md)", re.I)


def _tail(text, n=400):
    return text[-n:] if text else ''


def _sentences(text):
    return [s.strip() for s in re.split(r'(?<=[.!?])\s+|\n+', text or '') if s.strip()]


def _words(s):
    return {w for w in re.findall(r"[a-z0-9']+", s.lower()) if w not in STOPWORDS and len(w) > 2}


def _label(match):
    """A safe name for the command that matched: never the matched text itself, which can carry a token
    (curl -H "Authorization: …", vercel --token …)."""
    first = match.split()[0]
    if first.lower() == 'git':
        return 'git push'
    if first.lower() == 'curl':
        return 'curl ' + re.search(r'POST|PUT|PATCH|DELETE', match, re.I).group(0).upper()
    return os.path.basename(first)[:30]


def outside_effect(tools):
    """(label, vault_only) for the first outside-effect call of the turn, or None.
    vault_only is True when every outside effect was a commit or push of the vault itself."""
    found, vault_only = None, True
    for name, inp in tools:
        if name == 'Bash':
            cmd = str((inp or {}).get('command', ''))
            hits = [x.group(0) for x in OUTSIDE_BASH.finditer(cmd)]
            if hits:
                found = found or _label(hits[0])
                commits_only = all(re.match(r"(?i)git\s+push|safe_commit", h) for h in hits)
                vault_only = vault_only and commits_only and bool(VAULT_ONLY.search(cmd))
        elif name.startswith('mcp__'):
            short = name.rsplit('__', 1)[-1]
            if OUTSIDE_MCP.search(short) and not MCP_READ_PREFIX.search(short):
                found = found or short
                vault_only = False
    return (found, vault_only) if found else None


def made_read(tools):
    for name, inp in tools:
        if name in READ_TOOLS:
            return True
        if name.startswith('mcp__') and READ_MCP.search(name.rsplit('__', 1)[-1]):
            return True
        if name == 'Bash' and READ_BASH.search(str((inp or {}).get('command', ''))):
            return True
    return False


def edited_enforcer(tools):
    for name, inp in tools:
        inp = inp or {}
        if name in EDIT_TOOLS and ENFORCER_PATH.search(str(inp.get('file_path') or inp.get('notebook_path') or '')):
            return True
        if name == 'Bash' and BASH_WRITES_ENFORCER.search(str(inp.get('command', ''))):
            return True
    return False


def offer_in_tail(reply):
    tail = _tail(reply)
    m = OFFER.search(tail) or AB_CHOICE.search(tail)
    if m:
        return m.group(0)
    if len(NUMBERED.findall(tail)) >= 2 and CHOICE_CUE.search(tail):
        return 'a numbered list of options'
    return None


def repeated_offer(reply, prev):
    if not prev:
        return None
    prev_offers = [s for s in _sentences(_tail(prev, 600)) if OFFER.search(s)]
    if not prev_offers:
        return None
    for s in _sentences(reply):
        if not OFFER.search(s):
            continue
        a = _words(s)
        for p in prev_offers:
            b = _words(p)
            if len(a) >= 3 and len(b) >= 3 and len(a & b) / min(len(a), len(b)) >= 0.6:
                return s[:120]
    return None


def owner_exempts(user):
    """True when owner's last message was a genuine question or said wait (fix 12)."""
    u = re.sub(r'<([a-zA-Z_-]+)[^>]*>.*?</\1>', ' ', user or '', flags=re.S).strip()
    if WAIT.search(u):
        return True
    if ORDER_Q.search(u):
        return False
    if TRUE_Q.search(u):
        return True
    if REQUEST.search(u):
        return False
    return u.rstrip().endswith('?')


def evaluate(turn):
    """turn = {'user': str, 'tools': [(name, input)], 'errs': [str], 'reply': str, 'prev_final': str}.
    Returns a list of (check, one-sentence instruction)."""
    reply = turn.get('reply') or ''
    tools = turn.get('tools') or []
    user = turn.get('user') or ''
    hits = []

    if CHECKS['done']:
        eff = outside_effect(tools)
        if eff and eff[1] and not DONE_COUNTS_VAULT_COMMITS:
            eff = None
        words = STRONG_DONE if (eff and eff[1]) else DONE_WORD
        m = eff and (words.search(reply[:HEADLINE]) or words.search(reply[-SIGNOFF:]))
        if m and not TESTED_LINE.search(reply):
            hits.append(('done', f'You said "{m.group(0)}" after an outside effect ({eff[0]}). Add two lines: '
                         '"Tested through:" the path you exercised on real input and what result would have shown it wrong; '
                         '"Not tested:" the path owner or the recipient will use, if different. A test count is not proof. '
                         'If only the artifact was checked, write "written, not yet exercised".'))

    if CHECKS['receipts'] and not CHECKED.search(reply):
        # "not there" and "can't" both need a look first: a read or search call this turn. With
        # RECEIPTS_CANT_NEEDS_FAILED_ATTEMPT, "can't" needs a call that actually failed.
        m = ABSENCE.search(reply)
        c = CANT.search(reply)
        read = made_read(tools)
        if m and not read:
            hits.append(('receipts', f'You wrote "{m.group(0)}" without reading or searching anything this turn. '
                         'Look first, then add "Checked:" naming each place you looked and how fresh it was.'))
        elif c and not (turn.get('errs') or []) and (RECEIPTS_CANT_NEEDS_FAILED_ATTEMPT or not read):
            hits.append(('receipts', f'You wrote "{c.group(0)}" and nothing was tried and failed this turn. Make one '
                         'real attempt first, then add "Checked:" naming what you tried and what it returned.'))

    if CHECKS['stall']:
        refused = next((e for e in turn.get('errs') or [] if REFUSAL.search(e or '')), None)
        offer = offer_in_tail(reply) or repeated_offer(reply, turn.get('prev_final') or '')
        if refused and HANDOFF.search(reply) and not ALLOWLIST_ASK.search(reply):
            hits.append(('stall', 'A permission check refused a command this turn. End with one line asking owner to '
                         'approve it: quote the exact command and the allowlist line that would let it through. '
                         'Do not work around the refusal and do not hand him a manual.'))
        elif offer:
            tail = _tail(reply, 600)
            asks = len(ASK_MARK.findall(_tail(reply)))
            compliant = asks <= 1 and (DEFAULT_GIVEN.search(_tail(reply)) or OPTIONAL_EXTRA.search(_tail(reply)))
            if not compliant and not owner_exempts(user) and not SENSITIVE.search(tail) and not SPEND.search(tail) \
                    and not SENSITIVE.search(user[-600:]):
                hits.append(('stall', f'The reply ends on an offer ("{offer[:60]}"). Do the reversible default now, '
                             'or keep exactly one ask with its default.'))

    if CHECKS['closed']:
        m = NOTED.search(reply)
        if m and not edited_enforcer(tools):
            hits.append(('closed', f'You wrote "{m.group(0)}" but edited no hook, lint check, test, script or rule file '
                         'this turn. If this answers a correction from owner, name what now enforces it, or log the '
                         'correction as open on the ledger (wiki/_reminders.md) and say so. If it is not about a '
                         'correction, leave the reply as it is.'))
    return hits


# ---------------------------------------------------------------- transcript tail
def _is_typed_user(d):
    if d.get('type') != 'user' or d.get('isMeta') or d.get('toolUseResult') or d.get('isCompactSummary'):
        return False
    c = (d.get('message') or {}).get('content')
    if isinstance(c, list) and any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in c):
        return False
    return True


def _lines_backwards(path):
    with open(path, 'rb') as f:
        f.seek(0, 2)
        pos = f.tell()
        read = 0
        buf = b''
        while pos > 0 and read < TAIL_MAX:
            step = min(TAIL_CHUNK, pos)
            pos -= step
            f.seek(pos)
            buf = f.read(step) + buf
            read += step
            lines = buf.split(b'\n')
            buf = lines[0]
            for line in reversed(lines[1:]):
                if line.strip():
                    yield line
        if pos == 0 and buf.strip():
            yield buf


def read_turn(path):
    """Walk the transcript backwards: this turn's tool calls and error results, the message that
    opened the turn, and the previous turn's final reply."""
    turn = {'user': '', 'tools': [], 'errs': [], 'reply': '', 'prev_final': ''}
    if not path or not os.path.exists(path):
        return turn
    stage = 'turn'
    for raw in _lines_backwards(path):
        try:
            d = json.loads(raw)
        except Exception:
            continue
        if d.get('isSidechain'):
            continue
        c = (d.get('message') or {}).get('content')
        if stage == 'turn':
            if d.get('type') == 'assistant' and isinstance(c, list):
                for b in reversed(c):
                    if not isinstance(b, dict):
                        continue
                    if b.get('type') == 'tool_use':
                        turn['tools'].insert(0, (str(b.get('name', '')), b.get('input') or {}))
                    elif b.get('type') == 'text' and b.get('text', '').strip() and not turn['reply']:
                        turn['reply'] = b['text']
            elif d.get('type') == 'user' and isinstance(c, list) and not _is_typed_user(d):
                for b in c:
                    if isinstance(b, dict) and b.get('type') == 'tool_result' and b.get('is_error'):
                        rc = b.get('content')
                        t = rc if isinstance(rc, str) else ' '.join(
                            x.get('text', '') for x in rc or [] if isinstance(x, dict))
                        turn['errs'].append((t or '')[:500])
            elif _is_typed_user(d):
                turn['user'] = c if isinstance(c, str) else '\n'.join(
                    b.get('text', '') for b in c or [] if isinstance(b, dict) and b.get('type') == 'text')
                stage = 'prev'
        elif stage == 'prev':
            if d.get('type') == 'assistant' and isinstance(c, list):
                parts = [b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text']
                if any(p.strip() for p in parts):
                    turn['prev_final'] = '\n'.join(parts)
                    break
            elif _is_typed_user(d):
                break
    return turn


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        if payload.get('stop_hook_active'):
            return 0
        turn = read_turn(payload.get('transcript_path') or '')
        if payload.get('last_assistant_message'):
            turn['reply'] = payload['last_assistant_message']
        sid = payload.get('session_id') or ''
        tier = session_tier(sid)
        hits = [] if tier in ('lead', 'worker') else evaluate(turn)
        if CHECKS.get('voice') and isinstance(sid, str) and ID_SAFE.fullmatch(sid):
            config = os.path.expanduser(os.environ.get('CLAUDE_CONFIG_DIR') or '~/.claude')
            state = os.path.join(config, 'hooks', 'state')
            note = os.path.join(state, f'voice-{sid}.txt')
            voice = voice_hit(turn.get('reply') or '', tier)
            try:
                if voice:
                    os.makedirs(state, exist_ok=True)
                    with open(note, 'w', encoding='utf-8') as fh:
                        fh.write(voice)
                elif os.path.exists(note):
                    os.remove(note)
            except OSError:
                pass
        if not hits:
            return 0
        reason = 'Before ending the turn (reply_check.py): ' + ' '.join(
            f'[{k}] {msg}' for k, msg in hits)
        print(json.dumps({'decision': 'block', 'reason': reason}))
    except Exception:
        return 0
    return 0


if __name__ == '__main__':
    sys.exit(main())
