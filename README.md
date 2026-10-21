# agent-brain-harness

One setup that gives a project two things: a **team** of AI agents (a Manager who talks to you, Leads who own departments, Workers who do jobs) and a **second brain** (a wiki the team reads before it asks you anything, and writes to when it learns something). The team talks through plain files in `.harness/`, so it works with any LLM app that can read files and run one command.

- Python 3.8+ and the standard library only. No installs. Git is needed for the brain's commit gate.
- macOS, Linux and Windows.
- The protocol is in [PROTOCOL.md](PROTOCOL.md). Role cards are in `core/roles/` and are copied into your project, where you can edit them.
- The brain half is derived from [second-brain-kit](https://github.com/NaluKicks-808/second-brain-kit).

## What you get

- **Team.** `.harness/` with role cards, inboxes, job briefs, handoffs and reports. Commands: `launch`, `spawn`, `send`, `inbox`, `status`.
- **Brain.** `wiki/` (compiled, cited articles), `raw/` and `data/` (the full-text sources), `tools/` (search, lint, reciprocity check, agenda, safe commit), `CLAUDE.md` (the constitution every agent reads first) and a git `pre-commit` gate that refuses a commit while a link is broken or a fact is written on only one side. The bike-shop example pages are fictional; delete them when you add real sources.
- **One init.** `harness init` creates both, runs `git init` (unless a repo exists or you pass `--no-git`), makes one first commit, installs the gate, and writes a `README.md` that explains every folder. `--no-brain` gives the team without the brain. It never overwrites a file you already have: it writes `<name>.harness-new` next to it.

## Install

Stub: the README writer expands this section.

macOS and Linux:
```
curl -fsSL https://raw.githubusercontent.com/NaluKicks-808/agent-brain-harness/main/install.sh | sh
```
Windows (PowerShell):
```
irm https://raw.githubusercontent.com/NaluKicks-808/agent-brain-harness/main/install.ps1 | iex
```
From a clone: `./install.sh` or `.\install.ps1`. Flags: `--yes` (no questions), `--dry-run` (print every action, change nothing), `--uninstall` (removes only what the installer added, keeps your brain). Transcript of a real run: [docs/install-transcript.txt](docs/install-transcript.txt).

## Quickstart

Get this repo anywhere (clone or download). Pick your OS, run one init command, then start the Manager in your app.

### macOS
```
bash launchers/macos/agent-brain-harness.sh init ~/my-project
```
Or double-click `launchers/macos/agent-brain-harness.command` to check your setup. Python 3 and git ship with the Xcode command line tools; `python3 --version` must say 3.8 or newer.

### Linux
```
bash launchers/linux/agent-brain-harness.sh init ~/my-project
```

### Windows (PowerShell)
```
powershell -ExecutionPolicy Bypass -File launchers\windows\agent-brain-harness.ps1 init C:\work\my-project
```
or in cmd: `launchers\windows\agent-brain-harness.cmd init C:\work\my-project`. Install Python from python.org first (tick "Add to PATH") and Git for Windows (it also provides the bash that `harness commit` uses).

You can always skip the wrappers: `python3 harness.py <command>` (`py harness.py ...` on Windows).

### Start the Manager
```
cd my-project
harness launch manager
```
`harness launch manager` starts it in your default app (`claude`). For another app add `--app codex` or `--app gemini`; for VS Code, Cursor, Copilot and chat apps see the table below.

### Daily loop
1. Ask the Manager for what you want. It splits the work into jobs for Leads; Leads spawn Workers.
2. Agents look in the brain first: `harness find <terms>` (exact words: `tools/deepfind.py`). They ask you only what the brain cannot answer.
3. Facts land on their wiki page in the same session. Anything you owe goes in `wiki/_reminders.md`, the one agenda; `harness agenda` prints it. Handoffs, inbox and jobs stay in `.harness/`.
4. Closing ritual before every commit: `harness close` (runs `tools/lint.py` and `tools/connect.py`; nonzero on failure), then `harness commit "message" <files you edited>` (runs `tools/safe_commit.sh`, which needs bash: on Windows it uses Git's).

### All commands
```
harness status                      # team, unread mail, jobs
harness launch lead --dept build    # a Lead (in a new window: add --new-window)
harness spawn worker --job j1 --brief .harness/jobs/j1.md   # Lead's command
harness send --to lead-build "text"
harness inbox manager
harness find bike                   # search the brain
harness agenda                      # what is outstanding
harness close                       # lint + connect
harness commit "msg" wiki/a.md      # gated commit (--all for a whole-tree sweep)
harness doctor                      # python, OS, which apps are on PATH
```
(`harness` here means the launcher or `python3 harness.py`. Each BOOT.md prints the exact command for the agents and, when a brain exists, the open agenda.)

## Per app

| App | How |
|---|---|
| Claude Code | `harness init --app claude`, then `harness launch manager`. See `adapters/claude-code/README.md`. |
| Codex CLI | `harness init --app codex`, then `harness launch manager --app codex`. |
| Gemini CLI | `harness init --app gemini`, then `harness launch manager --app gemini`. Flags unverified (see below). |
| VS Code, Cursor, Copilot | `harness init --app vscode` adds rules and "Harness: Manager/Lead/Worker" tasks that write BOOT.md. Run `harness launch manager --app print`, paste the output into the chat panel. |
| Plain terminal / any CLI LLM | Add an entry to `.harness/harness.json`. See `adapters/terminal/README.md`. |
| Chat-only apps (Claude Desktop, ChatGPT) | You are the courier. See `adapters/chat/project-instructions.md`. |

`harness init` with no `--app` copies adapter files for apps it finds on PATH. Every adapter tells the agent to read `CLAUDE.md` (the constitution) first, then its role card. In a project with a brain, `CLAUDE.md` is the brain's rulebook with a "Harness" section appended; the Claude Code adapter does not add a second `CLAUDE.md`.

## Workspace

```
.harness/
  harness.json          apps and team
  PROTOCOL.md           the file bus rules
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
python3 -m unittest discover -s tests -v          # the harness
python3 scripts/leak_scan.py
# the brain tools, inside a freshly initialised project:
python3 harness.py init /tmp/proj && cd /tmp/proj && python3 -m unittest discover -s tools/tests
```
The tests use a deterministic fake LLM (`tests/mock_llm.py`) for a full Manager, Lead, Worker round trip: the worker writes a wiki fact and a `wiki/_reminders.md` row, the lead runs `harness close`, and the test asserts the gates still pass.

The brain template differs from second-brain-kit in four small ways: `hooks/pre-commit` and `tools/safe_commit.sh` fall back to `python` or `py -3` where `python3` does not work (Windows); `tools/lint.py` exempts `.harness`, `.github`, `.cursor` and `.vscode` from its top-level-folder README check (they depend on the apps you pick); `tools/tests/test_safe_commit.py` copies the folder instead of calling `git ls-files`; one test fixture word changed.

Brain tests that do not run on Windows (skipped with a reason in the code): all of `tools/tests/test_safe_commit.py` that drives `safe_commit.sh` (`SafeCommitCase` and its subclasses: it needs POSIX locking and `/dev/null`). Nothing on Windows has been run locally; the CI job is the first run.

The PowerShell and `agent-brain-harness.cmd` launchers, and `--new-window` on Windows and Linux, are exercised only in CI or by hand, not by the unit tests.

## License

MIT.
