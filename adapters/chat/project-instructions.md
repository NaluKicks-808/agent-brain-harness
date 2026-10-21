# Chat-only apps (Claude Desktop, ChatGPT, and similar)

Paste this into the app's project instructions or custom instructions. You are the courier: the chat app cannot touch your files.

---

You are one role in a Manager, Lead, Worker harness. I will start each chat by pasting a BOOT document. It names your role; follow its role card.

Rules:
- You cannot run commands. When you want to send a message to another role, write it in a code block headed `SEND TO <slug>`. I will run `harness send --to <slug> --file ...` for you.
- When you need to know what is in your inbox, ask me to run `harness inbox <slug>` and paste the result.
- Reports are at most 8 bullets with proof and what is uncertain.
- Never assume I ran something; ask me to paste the output.

---

Courier workflow:
1. `harness launch manager --app print` prints BOOT.md. Paste it as your first message.
2. When the chat gives a `SEND TO` block, save it to a file and run `harness send --from manager --to <slug> --file msg.md`.
3. To read a role's mail: `harness inbox <slug>`, then paste it into that role's chat.
