# agent-harness

A small, portable way to run a team of AI agents: one **Manager** talks to you and hands out jobs, **Leads** own departments, **Workers** do the jobs. They talk through plain files in a `.harness/` folder, so it works with any LLM app that can read files and run one command.

- Python 3.8+ and the standard library only. No installs.
- macOS, Linux and Windows.
- The protocol is in [PROTOCOL.md](PROTOCOL.md). Role cards are in `core/roles/` and are copied into your project, where you can edit them.

## Quickstart

Get this repo anywhere (clone or download). Pick your OS, then pick your app.

### macOS
```
bash launchers/macos/harness.sh init ~/my-project
```
Or double-click `launchers/macos/harness.command` to check your setup. Python 3 ships with the Xcode command line tools; `python3 --version` must say 3.8 or newer.

### Linux
```
bash launchers/linux/harness.sh init ~/my-project
```

### Windows (PowerShell)
```
powershell -ExecutionPolicy Bypass -File launchers\windows\harness.ps1 init C:\work\my-project
```
or in cmd: `launchers\windows\harness.cmd init C:\work\my-project`. Install Python from python.org first (tick "Add to PATH") or use the `py` launcher.

You can always skip the wrappers: `python3 harness.py <command>` (`py harness.py ...` on Windows).

### Use it
```
cd my-project
harness status                      # team, unread mail, jobs
harness launch manager              # start the Manager in your default app
harness launch lead --dept build    # a Lead (in a new window: add --new-window)
harness spawn worker --job j1 --brief .harness/jobs/j1.md   # Lead's command
harness send --to lead-build "text"
harness inbox manager
harness doctor                      # python, OS, which apps are on PATH
```
(`harness` here means the launcher or `python3 harness.py`. Each BOOT.md prints the exact command for the agents.)

## Per app

| App | How |
|---|---|
| Claude Code | `harness init --app claude`, then `harness launch manager`. See `adapters/claude-code/README.md`. |
| Codex CLI | `harness init --app codex`, then `harness launch manager --app codex`. |
| Gemini CLI | `harness init --app gemini`, then `harness launch manager --app gemini`. Flags unverified (see below). |
| VS Code, Cursor, Copilot | `harness init --app vscode` adds rules and "Harness: Manager/Lead/Worker" tasks that write BOOT.md. Run `harness launch manager --app print`, paste the output into the chat panel. |
| Plain terminal / any CLI LLM | Add an entry to `.harness/harness.json`. See `adapters/terminal/README.md`. |
| Chat-only apps (Claude Desktop, ChatGPT) | You are the courier. See `adapters/chat/project-instructions.md`. |

`harness init` with no `--app` copies adapter files for apps it finds on PATH. It never overwrites an existing file: it writes `<name>.harness-new` next to it so you can merge by hand.

## Workspace

```
.harness/
  harness.json          apps and team
  roles/                role cards (edit freely)
  inbox/<slug>/*.md     unread; read ones move to read/
  jobs/<job-id>.md      job briefs
  handoffs/<slug>.md    notes for the next session
  reports/              saved reports
  sessions/<slug>/BOOT.md
  log.jsonl
```

## Apps config

`.harness/harness.json` lists the apps. Each has an `interactive` command, a `headless` command, and `stdin` (true = BOOT.md is sent on standard input). `{kickoff}` becomes the one-line prompt `Read <BOOT.md> and follow it. You are <title>.` Other placeholders: `{boot}`, `{python}`, `{root}`, `{workspace}`. The special value `"print"` prints BOOT.md for pasting into a chat.

Flag status:
- `claude`: `claude "<prompt>"` and `claude -p` (prompt on stdin) checked against `claude --help`.
- `codex`: `codex "<prompt>"` and `codex exec -` (prompt from stdin) checked against `codex --help` and `codex exec --help`.
- `gemini`: **not verified** (the CLI was not installed when this was written). Check `gemini --help` and edit the entry.
- Headless agents need permission to run the harness command. Add your own permission flags to the app entry; the harness does not disable safety checks for you.
- Tested example for headless Claude Code (lead spawns a worker, both report back):
  `"headless": ["claude", "-p", "--model", "sonnet", "--allowedTools", "Bash(python3:*) Bash(bash:*) Read Write"]`
- A headless session still loads your own global settings for that app (for Claude Code: `~/.claude/CLAUDE.md` and hooks).

## Test

```
python3 -m unittest discover -s tests -v
python3 scripts/leak_scan.py
```
The tests use a deterministic fake LLM (`tests/mock_llm.py`) for a full Manager, Lead, Worker round trip.

The PowerShell and `harness.cmd` launchers, and `--new-window` on Windows and Linux, are exercised only in CI or by hand, not by the unit tests.

## License

MIT.
