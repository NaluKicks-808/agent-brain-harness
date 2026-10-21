# wtfhappened: the postmortem skill

For any app that is not Claude Code. Follow this when something breaks or someone catches a mistake. In Claude Code the same text is the `wtfhappened` skill.

Born from a near-miss where a piece of work updated one record but not a second record that depended on it, and a person, not any automated check, caught the gap by asking whether the second one had been updated too. The retrospective that followed became this skill.

Its log has since grown past forty incidents. Four lessons from that log shape this version: fixes that were mechanical (an automated check, a blocking step) held; written rules that relied on someone remembering them broke again within days; the worst misses were repeats that nobody connected to the earlier incident; and once, a real fix was made but never written down, so the next person could not find it.

## When to run

Any time someone catches an error, an omission, or a broken promise in one of their systems, or asks any version of "why did that happen?" Also run it when the system catches its own failure. Skip it for small slips that get fixed on the spot; it is for failures that reveal something about the *system*, not the moment.

## Step 0: has this happened before?

Before answering anything, **name the class**: one sentence describing the failure's general shape with every instance detail stripped out (no tool, file, person, or meeting names). "The Manager said a meeting was not visible after searching only Drive" is an instance; "a search of part of the sources was reported as a search of all of them" is its class. Then search the postmortem log (`wiki/_postmortems.md`) and the rest of the brain by the class, not by the instance's words. Run `python tools/find.py <class words>` (or `agent-brain-harness find <class words>`), and `python tools/deepfind.py` for exact phrases, because a sibling incident shares the shape and almost never the vocabulary. List every sibling you find, with its number and the fix it got.

- **It's a repeat.** Then the headline is "the earlier fix did not hold," and the job is to say why: it was only a written rule; it changed what people or agents read but not what they produce; it lived somewhere the person or agent who failed never looked. The new fix must be a stronger kind than the one that failed.
- **It's new.** Say so, and say where you searched.

If `wiki/_postmortems.md` has no entries yet, say so; this run writes the first.

## The four questions, answered honestly, in order

Work from evidence (the conversation history, logs, file versions, the actual output), not impressions. Blameless toward people, unsparing toward the process.

1. **Why was it caught the way it was?** Who or what noticed: a person, an automated check, luck? If a human was the only check, say so plainly; that is itself a finding. Name the check that *should* have caught it, and whether it exists, exists but was skipped, or does not exist.

2. **How was the mistake actually made?** Reconstruct the concrete sequence: what was produced, where it went, which step was skipped or shortcut, and what the work was optimizing for at the time (speed, momentum, a long to-do list). Name the pattern if one fits (e.g., "log line as tombstone": recording *that* something was learned instead of recording it where it belongs).

3. **What systemic gap allowed it?** Distinguish **an unused system** (the rule or check existed and was skipped; ask why skipping was possible at all) from **a missing system** (nothing covered this handoff). Most gaps live at boundaries: between one project and another, between a draft and the official record, between "noted" and "done." Two traps that keep recurring:
   - **Reading vs producing.** A fix that changes what someone reads leaves what they produce untouched.
   - **The fix must meet the failure where it happens.** A rule added to a document that an agent or teammate has already read, or will never open, does not reach them. A check that runs at the moment of the action reaches everyone.

   End with a **prediction that could prove you wrong**: "If this is the cause, X will (or won't) happen next; if Y happens instead, this diagnosis is wrong." A diagnosis that only explains the past is indistinguishable from a story.

4. **What fixes prevent it from happening again?** Pick the best set of fixes, not a set number: one if one closes the gap, several if the gap genuinely needs several. Prefer, in order: (a) **structural**, making the failure impossible or blocking (an automated check, a required field, a step that cannot be skipped), over (b) **procedural**, a written rule people or agents must follow, over (c) **a reminder or note** (weakest; use it only to back up a or b). Then:
   - **Fix the class, not the instance.** At least one fix must catch the whole class named in Step 0, including the siblings that have not happened yet. A fix that matches this incident's words (a phrase pattern, one tool, one source) is an instance patch: allowed as a backstop, never as the whole fix. Ask of each fix: "would this have caught each sibling in the log?" If the answer is no for all of them, the class is still open.
   - **Route into what exists before adding anything.** A fix that adds a new page, file, list, queue, tracker or board must first name the existing home it checked (the team's agenda, its feature list, its runbook) and say in one line why that home cannot hold it. If an existing home can hold it, the fix is to route there. A new artifact is the most common way a postmortem creates the disorder it was meant to fix.
   - **Prove a structural fix can fail.** Run it against the real case that broke and show it catches it; run it against a sibling case from the log (or a constructed one with different words) and show it catches that too; run it against a normal case and show it passes.
   - **A written rule on its own is on probation.** Say so, and say what would show it failed. If Step 0 found the same written rule already broken once, another written rule is not an acceptable fix.
   - **No check beats a wrong check.** If the failure cannot be detected reliably, write "no automated check, and why" rather than adding a fragile one. Padding the list is how none of the fixes get done.
   - **Name the cost before a big fix.** Small fixes go in now. If the right fix is a large build, or it touches customers, money, outgoing messages, or deletion, describe it, give the rough effort, and ask before starting. Until it is approved, it goes on the task list with a clear trigger for when it happens.
   - Never offer "noted" or "from now on" as the fix.

## The non-negotiable: the fix goes in AND the entry gets written, now

Both happen in this session. A postmortem without a fix is a complaint. A fix without a written entry is invisible to the next person's Step 0.

**If you cannot touch the system that failed** (for example, you are in a chat without access to the files, tools, or settings involved), the fix is the exact change, written out (where it goes, what it says, how to test it), handed to the user and clearly labelled **not yet installed**. Never describe it as done.

## Log it

Add the incident to `wiki/_postmortems.md` as a heading `### #N (YYYY-MM-DD): short title`, where N is one past the highest existing number, checked at the moment of writing. `agent-brain-harness postmortem "short title"` appends that heading with the shape below and the right number. Two entries must never share a number: `tools/lint.py` blocks a duplicate, and pages cite an entry as `[[_postmortems]] #N`. Use this shape, one bold label per line:

- What happened
- The class, and its siblings in the log by number
- Caught by (person / automated check / the system itself / luck)
- Why it was caught that way
- How it was made
- The systemic gap
- The prediction
- Fixes, each with how it was tested (or "not yet installed")
- What is still weak

If the fix changed an automation or any ongoing process, update wherever that process is documented, so the two never drift apart. Anything still owed goes in `wiki/_reminders.md` (the one agenda, never a separate TODO file) with a trigger. Then run `agent-brain-harness close` (lint plus connect) before committing, and commit through `agent-brain-harness commit`.

## Output to the user

- **First line, 15 words or fewer:** the most uncomfortable true sentence (e.g., "the check existed and we skipped it every time").
- Step 0 in two sentences: the class, and which earlier incidents share it (or that none do).
- The four answers in plain language, a short paragraph each.
- What is now in place and how they would know it is working, ending with **Tested by:** (what was actually run, and what result would have shown it wrong) and **Not tested:**.
- At most one question (such as approval for a big fix), with what happens by default if they don't answer.
