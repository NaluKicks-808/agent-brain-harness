#!/usr/bin/env python3
"""Refuse to archive a session until the files it sent owner are visible from here.

Why: a file card can disappear from view when the sending session is archived.
The guard keeps a desktop copy and requires the current session to send the file too.

On mcp__ccd_session_mgmt__archive_session this hook:
  1. finds the target session's transcript (app record -> cliSessionId -> projects/*.jsonl)
  2. lists every file that session sent with SendUserFile and that still exists
  3. makes a dated copy in ~/Desktop/For Owner/ for any file that has none (same content)
  4. refuses (exit 2) unless the CURRENT session has also sent each file (same path or
     same content), so the card survives the archive. Archiving "self" skips step 4.
Any error inside the hook lets the archive through and is logged: a broken guard must
not strand a session, and the log says why it did not check.
"""
import glob, hashlib, json, os, shutil, sys, time

DESKTOP = os.path.expanduser("~/Desktop/For Owner")
CONFIG = os.path.expanduser(os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude")
LOG = os.path.join(CONFIG, "hooks", "state", "archive_guard.log")
APP_DIRS = [os.path.expanduser("~/Library/Application Support/" + app)
            for app in ("Claude", "Claude-Work")]
PROJECT_DIRS = [os.path.join(CONFIG, "projects")]


def log(msg):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a") as fh:
            fh.write("{} {}\n".format(time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


def sha(path, _cache={}):
    path = os.path.realpath(path)
    if path not in _cache:
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        _cache[path] = h.hexdigest()
    return _cache[path]


def find_transcript(session_id):
    for app in APP_DIRS:
        for rec in glob.glob(os.path.join(app, "claude-code-sessions", "*", "*", session_id + ".json")):
            with open(rec) as fh:
                cli = json.load(fh).get("cliSessionId")
            if not cli:
                continue
            for proj in PROJECT_DIRS:
                hits = glob.glob(os.path.join(proj, "*", cli + ".jsonl"))
                if hits:
                    return hits[0]
    return None


def sent_files(transcript):
    out = []
    with open(transcript) as fh:
        for line in fh:
            if '"SendUserFile"' not in line:
                continue
            try:
                content = (json.loads(line).get("message") or {}).get("content")
            except Exception:
                continue
            if not isinstance(content, list):
                continue
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("name") == "SendUserFile":
                    for f in (block.get("input") or {}).get("files") or []:
                        p = os.path.realpath(os.path.expanduser(f))
                        if os.path.isfile(p) and p not in out:
                            out.append(p)
    return out


def desktop_copy(path):
    """Return the Desktop file with the same content, making a dated copy if none exists."""
    size = os.path.getsize(path)
    if os.path.isdir(DESKTOP):
        for name in os.listdir(DESKTOP):
            cand = os.path.join(DESKTOP, name)
            if os.path.isfile(cand) and os.path.getsize(cand) == size and sha(cand) == sha(path):
                return cand, False
    os.makedirs(DESKTOP, exist_ok=True)
    name = os.path.basename(path)
    if not name[:4].isdigit():  # generic names (RESULTS.md) carry their folder so owner can tell them apart
        name = "{}_{}_{}".format(time.strftime("%Y-%m-%d"), os.path.basename(os.path.dirname(path)), name)
    base = name
    dest, n = os.path.join(DESKTOP, base), 2
    while os.path.exists(dest):
        stem, ext = os.path.splitext(base)
        dest, n = os.path.join(DESKTOP, "{}-{}{}".format(stem, n, ext)), n + 1
    shutil.copy2(path, dest)
    return dest, True


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    if data.get("tool_name") != "mcp__ccd_session_mgmt__archive_session":
        return 0
    target = (data.get("tool_input") or {}).get("session_id", "")
    here = data.get("transcript_path") or ""
    try:
        is_self = target == "self"
        transcript = here if is_self else find_transcript(target)
        if not transcript or not os.path.isfile(transcript):
            log("PASS-UNCHECKED target={} (no transcript found)".format(target))
            return 0
        files = sent_files(transcript)
        if not files:
            log("PASS target={} sent no files".format(target))
            return 0
        made = []
        for f in files:
            dest, new = desktop_copy(f)
            if new:
                made.append(dest)
        missing = []
        if not is_self:
            mine = sent_files(here) if os.path.isfile(here) else []
            mine_paths = set(mine)
            mine_hashes = {sha(p) for p in mine}
            missing = [f for f in files if f not in mine_paths and sha(f) not in mine_hashes]
        if made:
            log("COPIED target={} {}".format(target, made))
        if missing:
            lines = ["Archive refused: that session sent owner these files, and archiving it hides their cards.",
                     "Send them from this session first (SendUserFile, with the path in plain words), then archive again:"]
            lines += ["  - " + f for f in missing]
            if made:
                lines.append("Dated copies were just made in ~/Desktop/For Owner/: " + ", ".join(os.path.basename(m) for m in made))
            print("\n".join(lines), file=sys.stderr)
            log("BLOCK target={} missing={}".format(target, missing))
            return 2
        log("PASS target={} files={}".format(target, len(files)))
        return 0
    except Exception as exc:
        log("PASS-ERROR target={} {!r}".format(target, exc))
        return 0


if __name__ == "__main__":
    sys.exit(main())
