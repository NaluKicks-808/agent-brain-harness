#!/usr/bin/env python3
"""Show a saved voice note once, on the session's next prompt."""
import json
import os
import re
import sys


def main():
    try:
        sid = json.load(sys.stdin).get('session_id') or ''
        if not isinstance(sid, str) or not re.fullmatch(r'[0-9A-Za-z-]{8,64}', sid):
            return 0
        config = os.path.expanduser(os.environ.get('CLAUDE_CONFIG_DIR') or '~/.claude')
        note = os.path.join(config, 'hooks', 'state', f'voice-{sid}.txt')
        if not os.path.isfile(note):
            return 0
        with open(note, encoding='utf-8') as fh:
            message = fh.read().strip()
        os.remove(note)
        if message:
            print(json.dumps({'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit',
                'additionalContext': 'Your last reply failed the voice check: ' + message}}))
    except (OSError, ValueError, TypeError):
        return 0
    return 0


if __name__ == '__main__':
    sys.exit(main())
