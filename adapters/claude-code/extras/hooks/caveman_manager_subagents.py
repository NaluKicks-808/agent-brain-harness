#!/usr/bin/env python3
"""caveman_manager_subagents.py - a SubagentStart hook. Gives the Manager's subagents the caveman voice.

Why (owner, 2026-10-14): every session talks caveman except the Manager, which owner reads. The caveman
plugin hands each new subagent its parent's mode, so a subagent of the Manager (mode "off") gets no
caveman rules. Its final report lands in the Manager's context, which is the window owner most needs to
keep small, and nobody but the Manager reads it. This hook fills that one gap.

It emits the caveman ruleset only when all of these hold:
- the parent session's role card tier is "manager" (hooks/state/role_card_tiers/<session id>, written
  by role_card.py), so leads and workers are left to the plugin, which already handles them;
- the parent's caveman mode file says "off" (if it said anything else the plugin already injected);
- the subagent is not a cavecrew agent (those carry their own voice).
The ruleset is the installed caveman plugin's skills/caveman/SKILL.md, read at run time, so a plugin
update reaches it. Files written for owner stay plain prose: the ruleset itself says anything persisted
outside chat is written normally.

Fail safe: any error prints nothing and exits 0, with one line in hooks/state/caveman_manager_subagents.log.
"""
import json
import os
import re
import sys
import time

CONFIG = os.path.expanduser(os.environ.get('CLAUDE_CONFIG_DIR') or '~/.claude')
TIERS = os.path.join(CONFIG, 'hooks', 'state', 'role_card_tiers')
SESSIONS = os.path.join(CONFIG, '.caveman-sessions')
INSTALLED = os.path.join(CONFIG, 'plugins', 'installed_plugins.json')
LOG = os.path.join(CONFIG, 'hooks', 'state', 'caveman_manager_subagents.log')
ID_RE = re.compile(r'^[0-9A-Za-z_-]{8,128}$')
NOTE = ('This subagent was started by the Manager session. Your final report goes to the Manager agent, '
        'not to the owner, so write it in this voice. Anything you save to a file for the owner '
        'is a persisted document: write it in plain, full sentences.')


def log(msg):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, 'a', encoding='utf-8') as fh:
            fh.write('{} {}\n'.format(time.strftime('%Y-%m-%d %H:%M:%S'), re.sub(r'\s+', ' ', msg)[:400]))
    except Exception:
        pass


def read_small(path):
    if os.path.islink(path):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            return fh.read(64).strip()
    except OSError:
        return None


def skill_path():
    with open(INSTALLED, 'r', encoding='utf-8') as fh:
        data = json.load(fh)
    entries = (data.get('plugins') or {}).get('caveman@caveman') or []
    for entry in entries:
        root = entry.get('installPath') if isinstance(entry, dict) else None
        if root:
            p = os.path.join(root, 'skills', 'caveman', 'SKILL.md')
            if os.path.isfile(p):
                return p
    return None


def ruleset():
    p = skill_path()
    if not p:
        return None
    with open(p, 'r', encoding='utf-8') as fh:
        text = fh.read()
    if text.startswith('---'):
        end = text.find('\n---', 3)
        if end != -1:
            text = text[end + 4:]
    return text.strip()


def main():
    try:
        payload = json.loads(sys.stdin.buffer.read().decode('utf-8', 'replace') or '{}')
        if not isinstance(payload, dict):
            return 0
        sid = payload.get('session_id')
        if not isinstance(sid, str) or not ID_RE.match(sid):
            return 0
        agent_type = payload.get('agent_type') if isinstance(payload.get('agent_type'), str) else ''
        if re.search(r'(^|:)cavecrew-', agent_type):
            return 0
        if read_small(os.path.join(TIERS, sid)) != 'manager':
            return 0
        if read_small(os.path.join(SESSIONS, sid + '.mode')) not in ('off', None):
            return 0  # the plugin already gave this subagent its parent's active mode
        rules = ruleset()
        if not rules:
            log('no caveman SKILL.md found; subagent of {} left plain'.format(sid))
            return 0
        text = 'CAVEMAN MODE ACTIVE - mode: caveman\n\n' + NOTE + '\n\n' + rules
        out = {'hookSpecificOutput': {'hookEventName': 'SubagentStart', 'additionalContext': text}}
        sys.stdout.write(json.dumps(out))
    except Exception as e:  # never block a subagent start
        log('{}: {}'.format(type(e).__name__, e))
    return 0


if __name__ == '__main__':
    sys.exit(main())
