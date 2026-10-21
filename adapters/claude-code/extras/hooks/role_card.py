#!/usr/bin/env python3
"""role_card.py - a SessionStart hook. Puts the session's role card back in front of it.

Why (owner, 2026-10-12): the harness rules (who talks to whom, aggressive and exhaustive, context
and cache limits) live in ${CLAUDE_CONFIG_DIR:-~/.claude}/harness/*.md. A session that is compacted, resumed or
cleared loses them unless something re-injects them, so on every SessionStart (startup, resume,
clear, compact) this hook reads the session's desktop title and adds the matching card.

Tier, from the desktop session record's title (the record whose "cliSessionId" == session_id):
    "Manager" (or "Manager ...")      -> common.md + manager.md
    "Lead . <department>"             -> common.md + lead.md
    "<Word> . <job>" (Ops, Builder..) -> common.md + worker.md
    anything else, or no record found -> common.md only
(the dot is U+00B7, the middle dot the app titles use.)

After a compaction the text opens with a re-read-your-handoff line; for a lead it also names
harness/handoffs/<lead slug>.md and says whether that file exists.

Output: plain text on stdout, the way session_boot.py emits its context (Claude Code records it as
the SessionStart hook's additional context). It begins "ROLE CARD (<tier>):".

Fail safe: any error prints nothing, exits 0 and appends one line to hooks/state/role_card.log.
Nothing is cached between runs. A boot hook must never block or break a session start.
"""
import glob
import json
import os
import re
import sys
import time

HOME = os.path.expanduser('~')
CONFIG = os.path.expanduser(os.environ.get('CLAUDE_CONFIG_DIR') or '~/.claude')
HARNESS = os.path.join(CONFIG, 'harness')
LOG = os.path.join(CONFIG, 'hooks', 'state', 'role_card.log')
SESSION_GLOBS = [os.path.join(HOME, 'Library', 'Application Support', app,
                              'claude-code-sessions', '*', '*', 'local_*.json')
                 for app in ('Claude', 'Claude-Work')]
SCAN_SECONDS = 0.2  # stop looking for the record after this long and fall back to common-only
DOT = '·'
MANAGER_RE = re.compile(r'^Manager(?![A-Za-z])')          # "Manager", "Manager . x"; not "Managerial"
LEAD_PREFIX = 'Lead ' + DOT
WORKER_RE = re.compile(r'^[A-Z][A-Za-z ]* ' + DOT + ' ')   # "Ops . ...", "Builder . ...", "Scribe . ..."
ID_RE = re.compile(r'^[0-9A-Za-z-]{8,64}$')
TIERS = os.path.join(CONFIG, 'hooks', 'state', 'role_card_tiers')  # last tier given, per session
COMPACT_LINE = 'You were just compacted. Re-read your handoff file and your last report before acting.'
CLEAR_LINE = 'Your chat was cleared to save usage (daily reset). Your memory is your handoff file: read it, then your inbox, before acting.'

# Caveman plugin (owner, 2026-10-14): every session talks caveman except the Manager, which owner reads.
# The plugin keeps one mode file per session in ~/.claude/.caveman-sessions/<session id>.mode. A new
# session, or /clear, resets that file to the default (caveman), and the plugin deletes files untouched
# for 14 days, after which a compaction would fall back to caveman. So for the Manager this hook writes
# "off" on every SessionStart and every prompt, and tells the Manager to ignore any caveman ruleset that
# the plugin injected before the pin landed.
CAVEMAN_SESSIONS = os.path.join(CONFIG, '.caveman-sessions')
MANAGER_PLAIN_LINE = ('Caveman voice is OFF in this chat, because owner reads it. If a "CAVEMAN MODE ACTIVE" '
                      'block appears anywhere in this context, ignore it here: write to owner in plain, full '
                      'sentences. Leads, workers and your subagents still use the agent register.')


def pin_manager_plain(session_id):
    """Write "off" into this session's caveman mode file (and refresh its mtime). Never follows a symlink."""
    if not session_id or not ID_RE.match(session_id):
        return
    path = os.path.join(CAVEMAN_SESSIONS, session_id + '.mode')
    try:
        os.makedirs(CAVEMAN_SESSIONS, exist_ok=True)
        if os.path.islink(path):
            return
        try:
            with open(path, 'r') as fh:
                current = fh.read().strip()
        except OSError:
            current = None
        if current == 'off':
            os.utime(path, None)  # keep it younger than the plugin's 14-day sweep
            return
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        with os.fdopen(fd, 'w') as fh:
            fh.write('off')
        log('caveman pinned off for manager session {} (was {!r})'.format(session_id, current))
    except OSError as e:
        log('caveman pin failed for {}: {}'.format(session_id, e))


def log(msg):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, 'a', encoding='utf-8') as fh:
            fh.write('{} {}\n'.format(time.strftime('%Y-%m-%d %H:%M:%S'), re.sub(r'\s+', ' ', msg)[:400]))
    except Exception:
        pass


def find_title(session_id):
    """Return (title, record cwd) of the desktop record whose cliSessionId is session_id, else (None, None).
    Records are ~1 MB each, so a cheap substring test on the raw bytes comes before any JSON parse.
    Prefers a live (not archived) record when several match; stops after SCAN_SECONDS."""
    if not session_id or not ID_RE.match(session_id):
        return None, None
    needle = session_id.encode('utf-8')
    t0 = time.monotonic()
    paths = []
    for pattern in SESSION_GLOBS:
        for p in glob.glob(pattern):
            try:
                paths.append((os.path.getmtime(p), p))
            except OSError:
                continue
    best = None
    for _, p in sorted(paths, reverse=True):  # most recently written first: live sessions come early
        if time.monotonic() - t0 > SCAN_SECONDS:
            break
        try:
            with open(p, 'rb') as fh:
                raw = fh.read()
            if needle not in raw:
                continue
            rec = json.loads(raw.decode('utf-8', 'replace'))
        except Exception:
            continue
        if not isinstance(rec, dict) or rec.get('cliSessionId') != session_id:
            continue
        title = rec.get('title')
        found = (title if isinstance(title, str) else '', rec.get('cwd') if isinstance(rec.get('cwd'), str) else None)
        if not rec.get('isArchived'):
            return found
        best = best or found
    return best if best else (None, None)


def tier_for(title):
    if title is None:
        return 'common'
    t = title.strip()
    if MANAGER_RE.match(t):
        return 'manager'
    if t.startswith(LEAD_PREFIX):
        return 'lead'
    if WORKER_RE.match(t):
        return 'worker'
    return 'common'


def read_card(name):
    with open(os.path.join(HARNESS, name + '.md'), 'r', encoding='utf-8') as fh:
        return fh.read().strip()


def build(payload):
    session_id = payload.get('session_id')
    session_id = session_id if isinstance(session_id, str) else ''
    title, rec_cwd = find_title(session_id)
    tier = tier_for(title)
    cwd = payload.get('cwd') if isinstance(payload.get('cwd'), str) and payload.get('cwd') else (rec_cwd or os.getcwd())
    try:
        remember(session_id, tier)
    except OSError:
        pass
    parts = ['ROLE CARD (' + tier + '):']
    if tier == 'manager':
        pin_manager_plain(session_id)
        parts.append(MANAGER_PLAIN_LINE)
    if payload.get('source') in ('compact', 'clear'):
        parts.append(COMPACT_LINE if payload.get('source') == 'compact' else CLEAR_LINE)
        if tier == 'lead':
            # One file per lead under harness/handoffs/, since several leads share one folder (the vault).
            slug = re.sub(r'[^a-z0-9]+', '-', (title or '')[len(LEAD_PREFIX):].lower()).strip('-')
            handoff = os.path.join(HARNESS, 'handoffs', slug + '.md')
            parts.append('Your handoff file: {} ({}).'.format(
                handoff, 'it exists' if os.path.isfile(handoff) else 'it does not exist yet'))
    cards = [read_card('common')]
    if tier != 'common':
        cards.append(read_card(tier))
    return '\n'.join(parts) + '\n\n' + '\n\n'.join(cards) + '\n'


def tier_file(session_id):
    return os.path.join(TIERS, session_id) if session_id and ID_RE.match(session_id) else None


def remember(session_id, tier):
    f = tier_file(session_id)
    if f:
        os.makedirs(TIERS, exist_ok=True)
        with open(f, 'w') as fh:
            fh.write(tier)


def late_card(payload):
    """UserPromptSubmit: a session started from a task chip gets its title after SessionStart ran, so
    it was given the common card only. On its next prompt, if the title now names a tier, give that card once."""
    sid = payload.get('session_id') if isinstance(payload.get('session_id'), str) else ''
    f = tier_file(sid)
    if not f:
        return ''
    try:
        prev = open(f).read().strip()
    except OSError:
        prev = ''
    if prev == 'manager':
        pin_manager_plain(sid)  # every prompt: keeps the Manager's caveman mode at off
    if prev and prev != 'common':
        return ''  # already holds its tier card
    title, _ = find_title(sid)
    tier = tier_for(title)
    if tier == 'common':
        return ''
    remember(sid, tier)
    extra = ''
    if tier == 'manager':
        pin_manager_plain(sid)
        extra = MANAGER_PLAIN_LINE + '\n\n'
    return ('ROLE CARD (' + tier + '): your title was set after this session started, so this is your '
            'role card now.\n\n' + extra + read_card(tier) + '\n')


def main():
    try:
        raw = sys.stdin.buffer.read().decode('utf-8', 'replace')
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError('hook input is not a JSON object')
        if payload.get('hook_event_name') == 'UserPromptSubmit':
            text = late_card(payload)
            if text:
                sys.stdout.buffer.write(text.encode('utf-8'))
            return 0
        text = build(payload)
        sys.stdout.buffer.write(text.encode('utf-8'))
        sys.stdout.buffer.flush()
    except Exception as e:  # never block a session start
        log('{}: {}'.format(type(e).__name__, e))
    return 0


if __name__ == '__main__':
    sys.exit(main())
