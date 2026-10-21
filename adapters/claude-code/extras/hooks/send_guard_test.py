#!/usr/bin/env python3
"""Self-contained tests for send_guard.py. Run: python3 hooks/send_guard_test.py."""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import send_guard as g

CHAT = "thread-example-1"
DRAFT = "Please send the updated document. Thank you."
results = []


def case(name, got, want):
    ok = got == want
    results.append(ok)
    print("{} {}".format("PASS" if ok else "FAIL", name))


def owner(text):
    return {"type": "user", "message": {"role": "user", "content": text}}


def said(text):
    return {"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}


def called(name, inp):
    return {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": name, "input": inp}]}}


def result():
    return {"type": "user", "message": {"content": [{"type": "tool_result", "content": "ok"}]}}


def hook(rows, tool_input):
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")
    p = subprocess.run([sys.executable, os.path.join(HERE, "send_guard.py")],
                       input=json.dumps({"tool_name": "mcp__x__send_post", "tool_input": tool_input,
                                         "transcript_path": fh.name}),
                       capture_output=True, text=True)
    os.unlink(fh.name)
    return p.returncode


# 1. An unseen draft must be refused, using only synthetic transcript rows.
case("unseen draft refused", hook([owner("send an update")], {"chatId": CHAT, "text": DRAFT}), 2)

shown = said("Here is the correction:\n\n> " + DRAFT + "\n\nSend it?")
# 2. Shown, owner said go, thread read after his go -> allowed.
case("shown, approved, thread read -> sent",
     hook([shown, owner("yes send it"), called("read_team_chat", {"chatId": CHAT}), result()],
          {"chatId": CHAT, "text": DRAFT}), 0)
# 3. Shown and approved, but the thread was not read this turn -> refused.
case("shown, approved, thread not read -> refused",
     hook([shown, owner("yes send it")], {"chatId": CHAT, "text": DRAFT}), 2)
# 4. Thread read only BEFORE owner's last message does not count.
case("thread read before his message only -> refused",
     hook([called("read_team_chat", {"chatId": CHAT}), result(), shown, owner("yes")],
          {"chatId": CHAT, "text": DRAFT}), 2)
# 5. Text changed after he saw it -> refused.
case("text edited after he saw it -> refused",
     hook([shown, owner("go"), called("read_team_chat", {"chatId": CHAT})],
          {"chatId": CHAT, "text": DRAFT + " Also, can you call me?"}), 2)
# 6. owner dictated the words himself -> allowed.
case("owner typed the words himself -> sent",
     hook([owner("message casey: " + DRAFT), called("read_team_chat", {"chatId": CHAT})],
          {"chatId": CHAT, "text": DRAFT}), 0)
# 7. Draft shown only in the same turn (after his last message) -> refused: he never saw it.
case("draft shown after his last message -> refused",
     hook([owner("ask casey"), shown, called("read_team_chat", {"chatId": CHAT})],
          {"chatId": CHAT, "text": DRAFT}), 2)
# 8. Stop-hook feedback is not owner approving.
case("hook feedback is not owner's go -> refused",
     hook([owner("ask casey"), shown, owner("Stop hook feedback: something"),
           called("read_team_chat", {"chatId": CHAT})], {"chatId": CHAT, "text": DRAFT}), 2)
# 9. A shell command that mentions the chat id is not a read.
case("id mentioned in a shell command only -> refused",
     hook([shown, owner("go"), called("Bash", {"command": "echo " + CHAT})],
          {"chatId": CHAT, "text": DRAFT}), 2)
# 10. A broken transcript path lets the send through (logged), never strands owner.
p = subprocess.run([sys.executable, os.path.join(HERE, "send_guard.py")],
                   input=json.dumps({"tool_name": "x", "tool_input": {"text": DRAFT},
                                     "transcript_path": "/nonexistent.jsonl"}),
                   capture_output=True, text=True)
case("unreadable transcript -> allowed and logged", p.returncode, 0)

print("{}/{} passed".format(sum(results), len(results)))
sys.exit(0 if all(results) else 1)
