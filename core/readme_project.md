# {{NAME}}

A project that is two things at once: a team of AI agents (a Manager, Leads and Workers that pass plain-file messages) and a second brain (a wiki the agents read before they ask you anything, and write to when they learn something).

## Folders

| Folder | What it is |
|---|---|
| `.harness/` | The team: role cards in `roles/`, mail in `inbox/`, job briefs in `jobs/`, handoffs, reports, the event log. Written by `harness init`. |
| `wiki/` | The brain: compiled, cited, interlinked articles, plus the index, the reminders ledger, the log and the postmortems. |
| `raw/` | Normalized full text of every source, one file per chunk. Cited from the wiki. |
| `data/` | The immutable originals. Large archives stay outside; only small manifests live here. |
| `tools/` | The brain's scripts: `lint.py`, `connect.py`, `find.py`, `deepfind.py`, `agenda.py`, `safe_commit.sh` and the rest, plus `tools/tests/`. |
| `hooks/` | The commit gate, `pre-commit`. `harness init` installs it into `.git/hooks/`. |
| `quiz/` | The brain quiz: an empty question template, and the runs once you have some. |
| `.claude/` | Claude Code settings and the wiki-writing rules, loaded only when a session touches `wiki/` or `raw/`. |
| `.obsidian/` | A graph filter that keeps the source layer out of Obsidian's graph view. |
| `.github/`, `.cursor/`, `.vscode/` | Rules and tasks for GitHub Copilot, Cursor and VS Code, if you picked that adapter. |

## The team

One **Manager** talks to you and hands out jobs. **Leads** own departments. **Workers** do the jobs. They talk through files in `.harness/`; the protocol is in `.harness/PROTOCOL.md`.

```
harness status                      # team, unread mail, jobs
harness launch manager              # start the Manager in your default app
harness launch lead --dept build    # a Lead (new window: add --new-window)
harness send --to lead-build "text"
harness inbox manager
```

`harness` means the launcher script from the agent-brain-harness folder you cloned (or `python3 harness.py`).

## Daily loop

1. Ask the Manager for what you want. It splits the work into jobs and hands them to Leads, and Leads to Workers.
2. Agents look in the brain first: `harness find <terms>` (exact words: `tools/deepfind.py`). They only ask you what the brain cannot answer.
3. Facts they learn land on their wiki page in the same session. Anything you owe or asked to be reminded of goes in `wiki/_reminders.md`; `harness agenda` prints it.
4. Closing ritual before every commit: `harness close` (runs `tools/lint.py` and `tools/connect.py`), then `harness commit "message" <the files you edited>`.

{{BRAIN}}
