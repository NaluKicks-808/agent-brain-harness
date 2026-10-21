## Agent harness

This project uses a Manager, Lead, Worker harness (see `.harness/PROTOCOL.md`).

- If the environment variable `HARNESS_ROLE` is set, or your first message says "Read ... BOOT.md and follow it", read that BOOT.md and follow it exactly. It holds your role card and the command to use.
- Otherwise ignore the harness unless the user asks for it.
- If this project has a second brain (a `wiki/` folder), read `CLAUDE.md` (the constitution) first, then your role card.
- Claude Code has native cross-session messaging (SendMessage). You MAY use it, but always also write the file message with `send`.
- When something breaks or a mistake is caught, run the `wtfhappened` skill (or follow `.harness/skills/wtfhappened.md`), and log it in `wiki/_postmortems.md`.
