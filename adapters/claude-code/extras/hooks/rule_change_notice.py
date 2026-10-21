#!/usr/bin/env python3
"""UserPromptSubmit: show changed rule lines to a running session.
The first prompt records a snapshot; later prompts emit a capped diff if rules changed.
Watches the selected configuration's CLAUDE.md, optional vault rules and standing preferences,
and an optional memoryIndexFile from harness/config.json. Never blocks a prompt.
"""
import difflib
import json
import os
import re
import sys
import time
from pathlib import Path

HOME = Path(os.path.expanduser('~'))


def config_dir() -> Path:
    here = Path(__file__).resolve().parent
    if here.name == 'hooks':
        return here.parent
    env = os.environ.get('CLAUDE_CONFIG_DIR')
    return Path(os.path.expanduser(env)) if env else HOME / '.claude'


_CFG = config_dir()
try:
    _SETTINGS = json.loads((_CFG / 'harness' / 'config.json').read_text())
except Exception:
    _SETTINGS = {}
_VAULT_PATH = _SETTINGS.get('sourceOfTruthRepo') or ''
# Keep the same snapshot/diff logic. Watch this installation and its optional vault.
WATCHED = [(str(_CFG / 'CLAUDE.md'), str(_CFG / 'CLAUDE.md'), None)]
if _VAULT_PATH:
    _VAULT = Path(os.path.expanduser(_VAULT_PATH))
    WATCHED += [
        (str(_VAULT / 'CLAUDE.md'), str(_VAULT / 'CLAUDE.md'), None),
        ('standing preferences', str(_VAULT / 'wiki' / 'standing-preferences.md'),
         '## Standing preferences'),
    ]
# Optional memory index: supply the installing account's actual path.
if _SETTINGS.get('memoryIndexFile'):
    WATCHED.append(('memory index', _SETTINGS['memoryIndexFile'], None))
STATE_DIR = Path(__file__).resolve().parent / 'state'
MAX_LINES = 40


def read(path: str, section) -> str:
    try:
        text = Path(os.path.expanduser(path)).read_text(encoding='utf-8', errors='replace')
    except Exception:
        return ''
    if not section:
        return text
    i = text.find(section)
    if i < 0:
        return ''
    body = text[i:]
    j = body.find('\n## ', len(section))
    return body[:j] if j >= 0 else body


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    if not isinstance(payload, dict):
        return 0
    sid = re.sub(r'[^A-Za-z0-9_-]', '', str(payload.get('session_id') or ''))
    if not sid:
        return 0
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        snap_file = STATE_DIR / f'rules-{sid}.json'
        current = {label: read(path, sec) for label, path, sec in WATCHED}
        if not snap_file.exists():  # a new session: record what it loaded; sweep week-old snapshots
            for old in STATE_DIR.glob('rules-*.json'):
                try:
                    if time.time() - old.stat().st_mtime > 7 * 86400:
                        old.unlink()
                except OSError:
                    pass
            snap_file.write_text(json.dumps(current))
            return 0
        before = json.loads(snap_file.read_text())
        changed = []
        for label, _, _ in WATCHED:
            old, new = before.get(label), current[label]
            if old is None or old == new:  # a label added since the snapshot starts fresh, silently
                continue
            if new == '' and old:  # unreadable now (moved, locked): do not announce a mass deletion
                current[label] = old
                continue
            diff = [l for l in difflib.unified_diff(old.splitlines(), new.splitlines(), lineterm='', n=0)
                    if (l.startswith('+') or l.startswith('-')) and not l.startswith(('+++', '---'))]
            if diff:
                changed.append((label, diff))
        snap_file.write_text(json.dumps(current))
        if not changed:
            return 0
        out = ['RULES CHANGED since this session last looked (hook rule_change_notice.py).',
               'These edits were made after your session loaded its rules. Follow the new text from this message on.']
        budget = MAX_LINES
        for label, diff in changed:
            out.append(f'\n{label}:')
            for l in diff[:budget]:
                out.append('  ' + (l if len(l) <= 300 else l[:297] + '...'))
            if len(diff) > budget:
                out.append(f'  … {len(diff) - budget} more changed line(s); re-read the file.')
            budget = max(5, budget - len(diff))
        print('\n'.join(out))
    except Exception:
        return 0
    return 0


if __name__ == '__main__':
    sys.exit(main())
