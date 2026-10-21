#!/usr/bin/env python3
"""Refuse to send a message as owner unless he has seen its exact text and the thread was read.

Why: owner's rule is "Messages sent as me. Draft them, ping me, and send only on my approval."
A draft once went out before he had seen it, and a follow-up was drafted without reading the thread.

On external send_post, send_message, reply, or forward tools this hook refuses (exit 2) unless:
  1. SEEN: the message text appears in a reply Claude showed owner BEFORE his latest message, or in
     something owner typed himself. Blockquote marks, markdown emphasis, HTML tags, case and spacing
     are ignored when comparing.
  2. READ: when the send names an existing thread (chatId, threadId, messageId), a tool call since
     owner's latest message read that same id, so nothing he or the recipient wrote is missed.
A send to a person by personId alone has no thread id to check, so only rule 1 applies.
Any error inside the hook lets the send through and is logged: a broken guard must not strand owner,
and the log says why it did not check.
"""
import json, os, re, sys, time

CONFIG = os.path.expanduser(os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude")
LOG = os.path.join(CONFIG, "hooks", "state", "send_guard.log")
TEXT_KEYS = ("text", "body", "message", "content", "plainTextBody", "htmlBody", "bodyText")
THREAD_KEYS = ("chatId", "threadId", "messageId")
# Only a read-shaped tool given the thread's id as an argument counts as reading it; a shell command
# that merely mentions the id does not (found on the live check, 2026-10-08).
# "(send card <id>)" is the board naming a card, not a time (false hold 2026-10-16 08:58).
TIMED = re.compile(r"\((?:suggested|send(?! card)|scheduled?)\b|\bschedules? (?:for|at)\b|\bsend (?:at|on)\b", re.I)
READ_TOOL = re.compile(r"read|get_|list|fetch|search", re.I)
# Rows that arrive as "user" but were not typed by the owner.
NOT_OWNER = re.compile(r"^\s*(?:Stop hook feedback:|Base directory for this skill:|<task-notification>"
                      r"|\[SYSTEM NOTIFICATION|<system-reminder>|Caveat:)", re.I)


def log(msg):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a") as fh:
            fh.write("{} {}\n".format(time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


def norm(s):
    s = re.sub(r"<[^>]+>", " ", s or "")
    s = re.sub(r"(?m)^\s*>\s?", "", s)
    s = s.replace("’", "'").replace("“", '"').replace("”", '"')
    s = re.sub(r"[*_`]", "", s)
    return re.sub(r"\s+", " ", s).strip().lower()


def message_text(tool_input):
    for k in TEXT_KEYS:
        v = tool_input.get(k)
        if isinstance(v, str) and v.strip():
            return v
    strings = [v for v in tool_input.values() if isinstance(v, str)]
    return max(strings, key=len) if strings else ""


def _text_of(content):
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text", "") for b in content or []
                     if isinstance(b, dict) and b.get("type") == "text")


def _is_owner(row):
    if row.get("type") != "user" or row.get("isMeta") or row.get("toolUseResult") \
            or row.get("isCompactSummary") or row.get("isSidechain"):
        return False
    c = (row.get("message") or {}).get("content")
    if isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
        return False
    return not NOT_OWNER.match(_text_of(c))


def read_transcript(path):
    rows = []
    with open(path, encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
    return rows


def check(tool_input, rows):
    """'' when the send may go, else the reason it may not."""
    text = norm(message_text(tool_input))
    if not text:
        return ""
    last = max((i for i, r in enumerate(rows) if _is_owner(r)), default=-1)
    seen, typed, reads = [], [], []
    for i, r in enumerate(rows):
        if r.get("isSidechain"):
            continue
        c = (r.get("message") or {}).get("content")
        if _is_owner(r):
            typed.append(norm(_text_of(c)))
        elif r.get("type") == "assistant" and isinstance(c, list):
            for b in c:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text" and i < last:
                    seen.append(norm(b.get("text", "")))
                elif b.get("type") == "tool_use" and i > last and READ_TOOL.search(b.get("name", "")):
                    reads.append({v for v in (b.get("input") or {}).values() if isinstance(v, str)})
    # A send card that carries a time ("suggested: Wed 10-14 mid-morning", "schedules for ...") means
    # Send = schedule it for that time, not send now (owner, 2026-10-13, after a 22:03 send went out
    # the night before its card's suggested time). Only "now" in his words outside the quoted text overrides.
    latest = _text_of((rows[last].get("message") or {}).get("content")) if last >= 0 else ""
    head = latest.split("exactly:", 1)[0]
    if re.search(r"\bSend it\b", head) and TIMED.search(head) and not re.search(r"\bnow\b", head, re.I):
        return ("This send card carries a time, so Send means schedule it for that time, not send now. "
                "Create a one-time scheduled task (scheduled-tasks create_scheduled_task) at that time that "
                "re-reads the thread and sends these exact words, tell owner the time, and remove the card. "
                "Send immediately only if owner says now.")
    if not any(text in s for s in seen + typed):
        return ("owner has not seen this exact text. His rule: \"Messages sent as me. Draft them, ping me, "
                "and send only on my approval.\" Show him the draft word for word in a reply, wait for his "
                "go, then send exactly that.")
    for k in THREAD_KEYS:
        tid = tool_input.get(k)
        if isinstance(tid, str) and tid and not any(tid in r for r in reads):  # exact value, not substring
            return ("This thread ({}={}) was not read since owner's last message. Read it first (for "
                    "Chat: read_team_chat post list with this chatId): he or the recipient may "
                    "have written since the draft.".format(k, tid))
    return ""


def main():
    try:
        d = json.load(sys.stdin)
        if 'ccd_session_mgmt' in str(d.get('tool_name') or ''):
            return 0
        why = check(d.get("tool_input") or {}, read_transcript(d.get("transcript_path") or ""))
    except Exception as e:
        log("error, send allowed unchecked: {!r}".format(e))
        return 0
    if why:
        log("refused {}: {}".format(d.get("tool_name"), why[:120]))
        print("send_guard: " + why, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
