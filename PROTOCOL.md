# Protocol

The file bus every agent follows. Any LLM app can take part if it can read and write files and run one command.

## Roles
- **Manager** talks to the human, splits work into jobs, sends each job to a lead. Never does worker tasks.
- **Lead** owns one department. Turns a job into worker briefs, spawns workers, checks results, reports up.
- **Worker** does one job inside a stated write boundary and reports to its lead.

## Names
- Slugs: `manager`, `lead-<dept>`, `worker-<job>`.
- Titles: `Manager`, `Lead · <Dept>`, `Worker · <job>`.

## Files (all under `.harness/` in the project)
- `inbox/<slug>/*.md` unread messages. Read ones move to `inbox/<slug>/read/`.
- `jobs/<job-id>.md` the job brief.
- `handoffs/<slug>.md` notes left for the next session of that role.
- `reports/` finished reports. `sessions/<slug>/BOOT.md` your start file. `log.jsonl` event log.

## Commands
Run the harness command shown at the top of your BOOT.md.
- `send --to <slug> "text"` or `send --to <slug> --file F` writes a message. Your slug is the sender.
- `inbox <slug>` prints and marks your unread messages as read. `--keep` leaves them unread.
- `spawn worker --job <id> --brief <file>` (leads) runs a worker and returns its report.
- `status` shows unread counts, jobs, last reports.

## Rules
1. The file message is the floor. Native messaging (if your app has it) is optional extra; always also write the file.
2. Reports are at most 8 bullets: what was done, test or proof tail, what was skipped or uncertain.
3. Stay inside the write boundary in your brief. Never edit another role's files.
4. Do not wait in the foreground for more than about 4 minutes. Run long jobs in the background and check back.
5. Never put secrets in messages, briefs or reports.
6. Ask the human only through the Manager.
