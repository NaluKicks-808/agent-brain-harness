## The second brain

The brain half of this project is derived from [second-brain-kit](https://github.com/NaluKicks-808/second-brain-kit). It is a compiled wiki of short, cited, interlinked articles on top of a verbatim archive of everything it was built from, with gates that refuse a commit while a link is broken or a fact is written down on only one side.

`CLAUDE.md` is its constitution: every assistant reads it before touching `wiki/` or `raw/`. The example pages (a fictional bike shop) are there so the tools have something to run on. To make the brain yours:

1. Replace the second paragraph of `CLAUDE.md` with one sentence about whose brain this is and what it covers.
2. Delete `wiki/people/sam-rivera.md`, `wiki/projects/riverside-cycle-works.md` and `raw/entries/2026-09-12_shop-visit-notes.md`, and take their lines out of `wiki/_index.md`.
3. Put one real source in `data/`, then tell your assistant: "ingest and absorb the file I just put in data/".
4. Ask it something: "What does my brain know about X?" It searches (`harness find`) rather than reading everything.

Check the install any time: `python tools/lint.py` ends with no errors, and `python tools/find.py bike` returns the example pages.

### What each tool does

All of them live in `tools/` and run with `python tools/<name>.py` (`python3` on macOS and Linux) from the project root. None of them touch the network, except `brain_quiz.py`, which calls a model through a command you choose.

**`lint.py`** is the honesty gate. Broken links, links into the source layer that should be plain text, pages nothing points at, citation anchors that land nowhere, unfinished merges left in a file, a page accidentally pasted into itself, dates in the future, a link whose target exists on your disk and in nobody else's clone, malformed rows in the reminders ledger, a ledger row stamped closed in a way a reader cannot see, a row a script closed before its date, test files that write outside their own folder or that the test runner would never find, two postmortems with the same number, and a top-level folder the README does not explain. It also warns, without blocking, on guess words such as "presumably" or "almost certainly" in newly added wiki prose, on an answered question with no date, and on a skipped postmortem number. A few checks that only make sense once a vault has grown a particular habit sit in a `CONFIG` block at the top of the file and are off by default. It exits non-zero on anything that would make the vault wrong for another reader, which is what the commit hook reads.

**`connect.py`** is the reciprocity gate. It finds every page you newly named this session whose own page you never opened, and refuses to let that sit. It also prints an advisory list of facts you changed that other pages also assert, so a right fact does not stop travelling halfway.

**`find.py`** is retrieval. It searches the compiled wiki, ranks the pages that actually mention your terms, and prints each one's summary plus the matching lines, so most questions are answered without opening a file.

**`deepfind.py`** is the same engine pointed at the full archive instead of the summaries. Reach for it when you need the exact words rather than the gist.

**`critic.py`** is the growth loop. It reads the vault and tells you where it is thin: pages the brain treats as important but has never fleshed out, questions it recorded and never answered, central pages going stale, pages barely connected to anything. It never edits.

**`quote_check.py`** asks one question about every quotation in the wiki: do those words actually appear in the entry the sentence cites? It takes each double-quoted run of four or more words in a sentence that links into `raw/entries/`, and looks for it in the entries that sentence cites. A quote it cannot find is reported with a second verdict saying whether the words are in a different entry, which means the citation points at the wrong source, or in no entry at all. It tolerates formatting and nothing else: curly against straight quotes, emphasis markers, dashes, and the full stop a page puts inside its closing quote, but no stemming and no fuzzy matching, so a reworded quotation is still a finding. A run joined by an ellipsis is split and each piece checked on its own. `--changed` limits it to the wiki files you have edited since the last commit, `--page` to one file, `--json` to a machine-readable dump, and `--all` adds the underscore pages and `log.md`.

It is **advisory and deliberately not wired into the commit gate.** A quotation that cannot be found here is not proof that anything was invented: a brain quotes sources it does not hold, including pages read in a browser, books, and recordings whose entry is a summary rather than a transcript. The tool exits 0 always. Run it after an absorb, read the list, and fix the ones that are wrong on the page itself, under the normal absorb rules, by rereading the source. Nothing here rewrites your prose. An entry marked `private: true` is searched like any other, so a quotation taken from one passes, and it is named by filename only and never quoted back at you.

The example pages that ship with this kit paraphrase their source rather than quoting it, so a first run reports nothing. To watch the tool work, add this line to `wiki/people/sam-rivera.md` and run it again. The citation link at the end matters: the tool only checks quotations in sentences that cite an entry.

```
Sam called the clipboard "the only system that never lies" ([[2026-09-12_shop-visit-notes#^bench-fits-two]]).
```

Those seven words are not in the entry, so the tool reports them. Change the quotation to "the bench only fits two", which is there, and it passes.

**`agenda.py`** prints what is still outstanding, read live from the ledger every time you run it.

**`expire_rows.py`** closes ledger rows whose moment has passed. A time-bound row ("waiting on the 3pm call") can carry its own end as `expires: YYYY-MM-DDTHH:MM` in its last cell, in local time. Once that moment is past, the tool stamps the row `DROPPED <date> via expired` and strikes its title, so the agenda stops stating it as current. It never touches a row without the marker, a second run changes nothing, and `--dry-run` shows what it would close.

**`event_twin.py`** finds two open ledger rows that are really one timed event, worded twice. It only fires on the narrow case it can be sure of: same date, same explicit time, and titles that share most of their words. It reports by default; `--merge` closes the newer of each pair.

**`brain_quiz.py`** is a scored quiz of the brain. You write questions with their right answers and the pages those answers came from in `quiz/questions.jsonl` (copy the empty template `quiz/questions.example.jsonl`). The tool asks a model to answer each question using only the vault and the search tools, has a second call judge the answer against yours, and writes a score and a trend line under `quiz/`. A question whose cited page changed after you last checked it is flagged for a recheck. This is the only tool that calls a model: the commands are pluggable (`--answer-cmd`, `--judge-cmd`) and default to Claude Code in headless mode, and `--dry-run` runs offline. Run it weekly and a falling score tells you the brain got worse before you trust it with something that matters.

**`ledger_merge.py`** is the git merge driver for `wiki/_reminders.md`. When two sessions only added rows at the same spot, it keeps both; any other conflict still stops with markers.

**`safe_commit.sh`** is how a session commits. It takes a message and the list of files you actually edited, waits its turn behind any other session, pulls in whatever they pushed, refuses to proceed over an unfinished merge, runs the gates, commits, and retries the push through races.

### The ideas that make this different from a folder of notes

**Two permanent layers, not one.** Most note systems make you choose between keeping everything, which becomes unsearchable, and keeping a summary, which quietly becomes a curated self-portrait. This keeps both. `raw/entries/` holds the full text of every source forever. `wiki/` holds short compiled articles that cite it. A wiki page can say what a source means in two sentences and link to the exact paragraph it rests on, so the summary is the fast path and the full record is one click away when the stakes are high.

**Search first, so the cost stays flat.** The naive way to answer a question from a knowledge base is to read the index and then read the pages. That gets more expensive every week you use it. Here, every question starts as a search that ranks pages by how much they actually mention the terms and prints the matching lines. A vault ten times the size costs about the same to query.

**Honesty gates that block a commit.** Two scripts stand in front of every commit. One refuses a broken link, an orphan page, a citation anchor that lands nowhere, or a link to a file only your laptop has. The other refuses a one-way fact: if you wrote that two people worked on something and only updated one of their pages, it names the other and stops. A rule in a document gets skipped on the night it matters. A gate does not.

**Several Claude sessions, one folder.** `safe_commit.sh` exists because people run several sessions at once and plain git does not protect you from that. It holds an advisory lock so two commits cannot interleave, and it breaks the lock by itself if the holder dies. It makes you name the files you edited, because staging the whole tree means committing work you never opened and letting the gates bless pages nobody read. When another session pushes first, it replays your commit onto theirs entirely in memory rather than touching a file somebody else has open.

**One agenda.** Anything you ask to be reminded of goes into `wiki/_reminders.md`, keyed to a date, an event or a condition, and that file is the only list. A second list in a project folder is invisible to the brain, so the two drift apart and neither gets trusted. Closed rows stay in place as tombstones so the record of what was dropped survives, and `agenda.py` reads the file live every time, because a session that read it two hours ago is answering from a copy it cannot tell has gone stale.

**Postmortems as a first-class file.** `wiki/_postmortems.md` is not an appendix. Every time the brain gets something wrong and you catch it, it gets an entry answering four questions, and the entry is not finished until a fix is installed in the same session. Most of the checks in the linter exist because something on a page like that needed a mechanism rather than a resolution. A failure you only describe will happen again.
