#!/usr/bin/env python3
"""Scan repo text files for personal data. Stdlib only.

Usage: python3 scripts/leak_scan.py [--patterns FILE]

Built-in checks: real-looking emails, phone numbers, home-directory paths with a
real-looking user name, API-key shapes. --patterns FILE adds extra case-insensitive
terms (one per line, '#' comments) from a file that lives OUTSIDE the repo.
Exit 0 = clean, 1 = hits, 2 = usage error.
"""
import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)")
OK_EMAIL_DOMAINS = ("example.com", "example.org", "users.noreply.github.com", "noreply.github.com", "anthropic.com")
PHONE = re.compile(r"(?<![\w.])(?:\+?1[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w.])")
HOME = re.compile(r"(?:/Users/|/home/|[A-Za-z]:(?:\\\\|\\|/)Users(?:\\\\|\\|/))([^/\\\s\"'`)>\]]+)")
OK_NAMES = {"<you>", "you", "runner", "runneradmin", "user", "username", "name", "<name>", "<user>",
            "$user", "%username%", "shared", "public", "default", "$home", "~", "me", "your-name",
            "yourname", "<username>", "{user}", "$(whoami)", "*"}
KEYS = [re.compile(p) for p in (r"\bsk-[A-Za-z0-9_-]{16,}", r"\bgh[opsu]_[A-Za-z0-9]{20,}", r"\bAKIA[0-9A-Z]{16}\b")]
# Public repo URLs the README credits on purpose (repo names only); stripped before the custom-term check.
OK_URL = re.compile(r"github\.com/NaluKicks-808/(?:second-brain-kit|agent-brain-harness|agent-harness)", re.I)
# Ordinary English words that collide with a custom term, allowed only inside the brain template
# (its tools "strike" ledger titles and talk about "fuzzy matching").
OK_WORDS_IN = (("brain/", ("strike", "y match")),)
SKIP_DIRS = {".git", "node_modules", "__pycache__"}
SKIP_SUFFIX = {".png", ".jpg", ".jpeg", ".gif", ".wav", ".mp3", ".ico", ".pdf", ".zip", ".pyc", ".woff", ".woff2"}


def files():
    try:
        r = subprocess.run(["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd=str(ROOT),
                           capture_output=True, check=True)
        names = [n for n in r.stdout.decode("utf-8", "replace").split("\0") if n]
        return [ROOT / n for n in names]
    except (OSError, subprocess.CalledProcessError):
        res = []
        for d, dirs, fs in os.walk(str(ROOT)):
            dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
            res.extend(Path(d) / f for f in fs)
        return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--patterns")
    a = ap.parse_args()
    extra = []
    if a.patterns:
        try:
            lines = Path(a.patterns).read_text(encoding="utf-8").splitlines()
        except OSError as e:
            sys.stderr.write("cannot read patterns file: %s\n" % e)
            return 2
        extra = [l.strip().lower() for l in lines if l.strip() and not l.strip().startswith("#")]
    hits = []
    me = Path(__file__).resolve()
    for p in files():
        if not p.is_file() or p.suffix.lower() in SKIP_SUFFIX or p.resolve() == me:
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        rel = p.relative_to(ROOT)
        for n, line in enumerate(text.splitlines(), 1):
            low = OK_URL.sub("", line).lower()
            for pre, words in OK_WORDS_IN:
                if str(rel).replace("\\", "/").startswith(pre):
                    for w in words:
                        low = low.replace(w, "")
            for m in EMAIL.finditer(line):
                if not m.group(1).lower().endswith(OK_EMAIL_DOMAINS):
                    hits.append((rel, n, "email"))
            if PHONE.search(line):
                hits.append((rel, n, "phone"))
            for m in HOME.finditer(line):
                if m.group(1).lower() not in OK_NAMES:
                    hits.append((rel, n, "home path"))
            for k in KEYS:
                if k.search(line):
                    hits.append((rel, n, "key shape"))
            for t in extra:
                if t in low:
                    hits.append((rel, n, "custom term"))
    for rel, n, kind in sorted(set(hits)):
        print("%s:%d: %s" % (rel, n, kind))
    print("leak_scan: %d hit(s)" % len(set(hits)))
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
