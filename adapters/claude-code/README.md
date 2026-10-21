# Claude Code adapter

`harness init --app claude` copies two files into your project:
- `CLAUDE.md` (a short snippet; an existing file is never overwritten, a `CLAUDE.md.harness-new` is written instead, so merge it by hand).
- `.claude/settings.example.json`: a SessionStart hook that injects the role card by `HARNESS_ROLE`. Copy its `hooks` block into `.claude/settings.json` to enable it. It runs `python3 .harness/hooks/role_card_hook.py` (on Windows use `python` or `py` instead of `python3`).

Launch: `harness launch manager` runs `claude "Read <BOOT.md> and follow it. You are Manager."`. Headless workers run `claude -p` with BOOT.md on stdin.

Headless Claude cannot run shell commands without permission. Decide your own policy and add it to the app entry in `.harness/harness.json`, for example `--permission-mode` (see `claude --help`). The harness does not turn permission checks off for you.

## extras/ (optional)

`extras/hooks` and `extras/mods` are optional Claude Code power-ups copied from a larger private setup: guard hooks (send, secret, archive), nudges, and a "manager console" plugin. They are NOT needed by the harness, they assume Claude Code, and some assume a particular folder layout. Read each file before wiring it into your settings.
