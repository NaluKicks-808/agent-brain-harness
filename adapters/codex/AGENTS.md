## Agent harness

This project uses a Manager, Lead, Worker harness (see `.harness/PROTOCOL.md`).

- If your first message says "Read ... BOOT.md and follow it", read that file and follow it exactly. It has your role card and the command to run for `send`, `inbox`, `spawn`.
- Otherwise ignore the harness unless the user asks for it.
- If this project has a second brain (a `wiki/` folder), read `CLAUDE.md` (the constitution) first, then your role card.
- Always communicate by writing files into `.harness/inbox/<slug>/` through the `send` command.
- When something breaks or a mistake is caught, follow `.harness/skills/wtfhappened.md` (the postmortem), and log it in `wiki/_postmortems.md`.
