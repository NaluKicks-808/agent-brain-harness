## Agent harness

This project uses a Manager, Lead, Worker harness (see `.harness/PROTOCOL.md`).

- If the environment variable `HARNESS_ROLE` is set, or your first message says "Read ... BOOT.md and follow it", read that BOOT.md and follow it exactly. It holds your role card and the command to use.
- Otherwise ignore the harness unless the user asks for it.
- Claude Code has native cross-session messaging (SendMessage). You MAY use it, but always also write the file message with `send`.
