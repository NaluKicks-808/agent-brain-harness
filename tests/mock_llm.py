#!/usr/bin/env python3
"""Deterministic fake LLM. Reads BOOT text on stdin, acts by role through harness.py."""
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
H = [sys.executable, str(HERE / "harness.py")]
JOB = "demo-1"


def run(*args):
    r = subprocess.run(H + list(args), capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        sys.stderr.write(r.stderr)
        sys.exit(r.returncode)
    return r.stdout


def main():
    sys.stdin.read()
    role = os.environ.get("HARNESS_ROLE", "")
    slug = os.environ.get("HARNESS_SLUG", "")
    ws = Path(os.environ["HARNESS_DIR"])
    if role == "manager":
        jp = ws / "jobs" / (JOB + ".md")
        jp.write_text("# Job: %s\n\n- Goal: say hello\n" % JOB, encoding="utf-8")
        run("send", "--from", "manager", "--to", "lead-build", "job: %s, see %s" % (JOB, jp))
        print("- manager: wrote job %s and sent it to lead-build" % JOB)
    elif role == "lead":
        text = run("inbox", slug)
        m = re.search(r"job:\s*(\S+?),", text)
        if m:
            job = m.group(1)
            run("spawn", "worker", "--job", job, "--brief", str(ws / "jobs" / (job + ".md")), "--app", "mock")
            got = run("inbox", slug)
            run("send", "--to", "manager", "lead summary: worker-%s finished.\n%s" % (job, got.strip()[-300:]))
            print("- lead: spawned worker-%s and reported to manager" % job)
        else:
            print("- lead: no job found")
    elif role == "worker":
        print("- worker: finished job, hello from %s" % slug)
    else:
        print("- unknown role %r" % role)


if __name__ == "__main__":
    main()
