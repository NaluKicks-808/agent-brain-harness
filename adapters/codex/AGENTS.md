## Agent harness

This project uses a Manager, Lead, Worker harness (see `.harness/PROTOCOL.md`).

- If your first message says "Read ... BOOT.md and follow it", read that file and follow it exactly. It has your role card and the command to run for `send`, `inbox`, `spawn`.
- Otherwise ignore the harness unless the user asks for it.
- Always communicate by writing files into `.harness/inbox/<slug>/` through the `send` command.
