#!/usr/bin/env python3
"""secret_guard.py — keeps secret values out of the conversation (fix 10, 2026-09-30).

WHY. Credentials belong in environment settings or ignored local files, never in chat.

WHAT IT DOES. One file, three hook events, chosen by `hook_event_name`:

1. PreToolUse (Bash, Read, Grep). Denies a command that would print a secret value into
   the transcript — reading `.env*` / `*.pem` / `*credentials*` files, dumping the whole
   environment, echoing a variable named like a key, `gh auth token`, `security ... -w`,
   `vercel env pull /dev/stdout`, a database URL with its password typed inline. The
   reason names the safe way to do the same job (`wc -c`, `grep -c`, `test -n`,
   `cut -c1-4`, a python one-liner that prints only the length).
2. PostToolUse (Bash). If a command's output contains a key-shaped string anyway, the
   output Claude sees is replaced with a masked copy (`sk-…(40)`) through the documented
   `updatedToolOutput` field. It only changes what Claude reads; files are untouched.
3. Stop. If Claude's final reply (or text it wrote earlier in the same turn, read from the
   end of the transcript) contains a key-shaped string, it blocks once and tells Claude to
   replace it with a mask and report only the length. It never blocks twice in a row
   (`stop_hook_active`). owner has already seen the reply by then; the block makes Claude
   follow up masked. The real prevention is step 2: Claude never sees the value.

It never prints a secret itself: every message it writes carries only the kind and the length.

FAILS OPEN. Any internal error exits 0 with no output.
"""

from __future__ import annotations

import json
import math
import os
import re
import shlex
import sys

# ---------------------------------------------------------------------------
# Part 1. What a key looks like.
# ---------------------------------------------------------------------------

# (kind, compiled pattern, group holding the secret value, prefix kept in the mask)
_VAL = r"[A-Za-z0-9_\-]"
SHAPES: list[tuple[str, re.Pattern, int, str]] = [
    ("private key block", re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"), 0, "-----BEGIN PRIVATE KEY"),
    ("Anthropic key", re.compile(r"\b(sk-ant-" + _VAL + r"{20,})"), 1, "sk-ant-"),
    ("sk- key", re.compile(r"(?<![A-Za-z0-9_\-])(sk-(?:proj-|svcacct-|live-|or-v1-)?" + _VAL + r"{20,})"), 1, "sk-"),
    ("Stripe secret key", re.compile(r"\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,})"), 1, "sk_"),
    ("GitHub token", re.compile(r"\b(gh[pousr]_[A-Za-z0-9]{30,})"), 1, "gh?_"),
    ("GitHub token", re.compile(r"\b(github_pat_[A-Za-z0-9_]{22,})"), 1, "github_pat_"),
    ("Slack token", re.compile(r"\b(xox[abprs]-[A-Za-z0-9\-]{10,})"), 1, "xox?-"),
    ("AWS access key", re.compile(r"\b(AKIA[0-9A-Z]{16})\b"), 1, "AKIA"),
    ("Google API key", re.compile(r"\b(AIza[0-9A-Za-z_\-]{35})"), 1, "AIza"),
    ("Notion token", re.compile(r"\b((?:secret|ntn)_[A-Za-z0-9]{40,})"), 1, "ntn_"),
    ("Hugging Face token", re.compile(r"\b(hf_[A-Za-z0-9]{30,})"), 1, "hf_"),
    ("Groq key", re.compile(r"\b(gsk_[A-Za-z0-9]{30,})"), 1, "gsk_"),
    ("Resend key", re.compile(r"\b(re_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,})"), 1, "re_"),
    ("SendGrid key", re.compile(r"\b(SG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{20,})"), 1, "SG."),
    ("Canvas token", re.compile(r"(?<![A-Za-z0-9])(\d{4,5}~[A-Za-z0-9]{40,})"), 1, ""),
    ("key in an API header", re.compile(
        r"(?i:x-api-key|api-key|apikey|x-auth-token|x-access-token|authorization)[\"']?\s*[:=]\s*[\"']?"
        r"(?!Bearer\b|Basic\b|\$)([A-Za-z0-9_\-.]{16,})"), 1, ""),
    ("JWT", re.compile(r"\b(eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,})"), 1, "eyJ"),
    ("Bearer token", re.compile(r"\bBearer\s+([A-Za-z0-9._~+/=\-]{20,})"), 1, "Bearer "),
    ("key in a URL", re.compile(
        r"[?&](?:key|token|apikey|api_key|api-key|secret|access_token|auth|password|pass)=([^&\s\"'<>)\]`]{16,})",
        re.I), 1, "key="),
    ("password in a database URL", re.compile(
        r"\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?)://[^:\s/@\"'`]+:([^@\s/\"'`]{4,})@",
        re.I), 1, "://user:"),
    ("app password", re.compile(r"\b([a-z]{4}([ -]?)[a-z]{4}\2[a-z]{4}\2[a-z]{4})\b"), 1, ""),
    ("value after KEY=", re.compile(
        r"\b[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Za-z0-9_]*\s*[=:]\s*[\"']?"
        r"([A-Za-z0-9_\-.+/=]{20,})"), 1, ""),
]

_PLACEHOLDER = re.compile(
    r"xxxx|XXXX|your|YOUR|example|EXAMPLE|placeholder|PLACEHOLDER|redacted|REDACTED|dummy|"
    r"changeme|\*\*\*\*|<|>|\.\.\.|…|0000000|1234567|abcdef1234|fake|FAKE|test-key|sample")
_ENTROPY_KINDS = {"key in a URL", "value after KEY=", "Bearer token", "sk- key", "key in an API header"}
_APP_PW_CONTEXT = re.compile(r"password|passwd|app.?pass|GMAIL|IMAP|SMTP", re.I)
# A bare random-looking token (no prefix, no KEY= before it). Checked in Claude's replies
# only: tool output is full of long IDs Claude needs to read back.
BARE = re.compile(r"(?<![A-Za-z0-9_\-+/=.%~@:])([A-Za-z0-9_\-]{32,})(?![A-Za-z0-9_\-+/=.%~@])")


_WORDS: set | None = None


def _dictionary() -> set:
    """macOS word list, loaded only when a sixteen-letter candidate shows up (rare)."""
    global _WORDS
    if _WORDS is None:
        try:
            with open("/usr/share/dict/words", errors="ignore") as fh:
                _WORDS = {w.strip().lower() for w in fh if 3 <= len(w.strip()) <= 16}
        except OSError:
            _WORDS = set()
    return _WORDS


def _entropy(s: str) -> float:
    if not s:
        return 0.0
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in (s.count(ch) for ch in set(s)))


def _looks_real(kind: str, value: str) -> bool:
    if _PLACEHOLDER.search(value):
        return False
    if len(set(value)) <= 4:
        return False
    if kind == "password in a database URL":
        return not (value.startswith("$") or value.startswith("[") or value.lower() in {
            "password", "pass", "postgres", "secret", "pwd", "user", "root"})
    if kind == "app password":
        # a Google app password is sixteen random lowercase letters; it counts only next to
        # the words password / GMAIL / IMAP / SMTP (checked by the caller), and prose words
        # like "responsibilities" repeat too many letters to pass the entropy bar
        letters = re.sub(r"[ -]", "", value)
        if len(letters) != 16 or _entropy(letters) < 3.4:
            return False
        groups = re.split(r"[ -]", value) if re.search(r"[ -]", value) else [letters]
        words = _dictionary()
        return not any(g in words for g in groups)
    if kind in _ENTROPY_KINDS:
        has_digit = any(c.isdigit() for c in value)
        has_alpha = any(c.isalpha() for c in value)
        if not (has_digit and has_alpha):
            return False
        if value.startswith(("/", "./", "~")) or "/Users/" in value:
            return False  # a path, not a key
        if re.fullmatch(r"[a-z]+(?:[_\-.][a-z]+)+\d{0,4}", value):
            return False  # snake_case / dotted identifier
        return _entropy(value) >= 3.5
    return True


_ID_PREFIX = re.compile(
    r"^(?:msgbatch|msg|toolu|srvtoolu|req|file|batch|dpl|prj|team|icfg|oac|cus|sub|evt|pi|pm|ch|in|acct|price|"
    r"prod|sess|session|org|user|call|conv|asst|thread|run|vs|ft|chatcmpl|cmpl|ws|wf|job|task|agent|claude|"
    r"page|block|db|img|att|rec|tbl|fld|app|wh|we|sk_test_pub)_")


def _bare_real(v: str, before: str = "") -> bool:
    if v.startswith("AAAA") or re.search(r"ssh-(?:rsa|ed25519|dss)\s*$|ecdsa-sha2-\S+\s*$", before):
        return False  # an SSH public key is meant to be shared
    if _ID_PREFIX.match(v):
        return False  # a record ID (msgbatch_, toolu_, dpl_, prj_ ...), not a key
    if not (re.search(r"[a-z]", v) and re.search(r"[A-Z]", v) and re.search(r"[0-9]", v)):
        return False  # hex IDs, commit hashes, slugs and words are not keys
    if re.search(r"[a-z]{3,}[_\-][a-z]{3,}", v) or re.search(r"(?:[A-Z][a-z]{2,}){3}", v):
        return False  # snake_case or CamelCase identifiers
    return _entropy(v) >= 4.5 and not _PLACEHOLDER.search(v)


def find_secrets(text: str, bare: bool = False) -> list[dict]:
    """Every key-shaped value in `text`: kind, span, length. Never logs the value.
    bare=True also flags long random-looking tokens with no prefix (used on replies)."""
    if not text:
        return []
    hits: list[dict] = []
    taken: list[tuple[int, int]] = []
    for kind, rx, grp, prefix in SHAPES:
        for m in rx.finditer(text):
            s, e = m.span(grp)
            value = m.group(grp)
            if any(s < te and e > ts for ts, te in taken):
                continue
            if not _looks_real(kind, value):
                continue
            if kind == "app password" and not _APP_PW_CONTEXT.search(text[max(0, s - 200):e + 200]):
                continue
            taken.append((s, e))
            hits.append({"kind": kind, "start": s, "end": e, "length": len(value), "prefix": prefix})
    if bare:
        for m in BARE.finditer(text):
            s, e = m.span(1)
            if any(s < te and e > ts for ts, te in taken) or not _bare_real(m.group(1), text[max(0, s - 30):s]):
                continue
            taken.append((s, e))
            hits.append({"kind": "random-looking token", "start": s, "end": e, "length": e - s, "prefix": ""})
    hits.sort(key=lambda h: h["start"])
    return hits


def _mask_for(h: dict, value: str) -> str:
    pre = ""
    for p in ("sk-ant-", "sk-", "sk_", "rk_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_",
              "xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-", "AKIA", "AIza", "secret_", "ntn_", "hf_",
              "gsk_", "re_", "SG.", "eyJ"):
        if value.startswith(p):
            pre = p
            break
    if h["kind"] == "private key block":
        return "-----BEGIN PRIVATE KEY-----(masked)"
    return f"{pre}…({h['length']})"


def mask_text(text: str) -> tuple[str, list[dict]]:
    hits = find_secrets(text)
    if not hits:
        return text, []
    out, last = [], 0
    for h in hits:
        out.append(text[last:h["start"]])
        out.append(_mask_for(h, text[h["start"]:h["end"]]))
        last = h["end"]
    out.append(text[last:])
    return "".join(out), hits


def describe(hits: list[dict]) -> str:
    """'JWT, 212 chars; sk- key, 51 chars' — kinds and lengths only."""
    seen, parts = set(), []
    for h in hits:
        k = (h["kind"], h["length"])
        if k in seen:
            continue
        seen.add(k)
        parts.append(f"{h['kind']}, {h['length']} chars")
    return "; ".join(parts[:4]) + (f" (+{len(parts) - 4} more)" if len(parts) > 4 else "")


# ---------------------------------------------------------------------------
# Part 2. Which shell commands would print one.
# ---------------------------------------------------------------------------

SAFE_WAYS = ("check it without printing it: `wc -c <file>`, `grep -c NAME <file>`, "
             "`test -n \"$NAME\" && echo set`, `cut -d= -f1 <file>` for the names, "
             "`cut -c1-4` to show a masked start, or `python3 -c` that prints only len(). "
             "To pass a value on, pipe or redirect it (`... | vercel env add NAME production`, "
             "`> .env.local`) so it never lands in the transcript.")

_SECRET_PARTS = {"KEY", "APIKEY", "TOKEN", "TOKENS", "SECRET", "SECRETS", "PASSWORD", "PASSWD", "PASS",
                 "PW", "AUTH", "COOKIE", "COOKIES", "DSN", "CREDENTIAL", "CREDENTIALS", "CREDS",
                 "PRIVATE", "JWT", "BEARER", "PAT"}
_DB_PARTS = {"DATABASE", "DB", "POSTGRES", "POSTGRESQL", "PG", "REDIS", "MONGO", "MONGODB", "MYSQL", "KV"}
_LOWER_SINGLE_OK = {"token", "password", "secret", "apikey", "passwd"}


def secret_name(name: str) -> bool:
    parts = [p for p in re.split(r"[_\-]", name) if p]
    if not parts:
        return False
    up = [p.upper() for p in parts]
    if len(parts) == 1 and name.islower():
        return name in _LOWER_SINGLE_OK
    if any(p in _SECRET_PARTS for p in up):
        return True
    if any(p in ("URL", "URI", "CONNECTION", "CONN") for p in up) and any(p in _DB_PARTS for p in up):
        return True
    return False


_TEMPLATE_SUFFIXES = (".example", ".sample", ".template", ".dist", ".defaults", ".default", ".tmpl", ".schema")
_CODE_EXT = (".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".md", ".go", ".rb", ".sh", ".html",
             ".css", ".txt", ".swift", ".java", ".rs", ".yml", ".yaml", ".toml", ".lock", ".log", ".jsonl", ".d.ts")


def sensitive_path(p: str) -> bool:
    p = p.strip().strip("\"'")
    if not p or p.startswith("-"):
        return False
    if "*" in p and not re.search(r"(^|/)\.env[\w.*-]*$", p):
        return False  # a glob like src/**/*.ts is not a secret file; a `.env*` glob is
    low = p.lower().replace("\\", "/")
    base = low.rsplit("/", 1)[-1]
    if base.endswith(_TEMPLATE_SUFFIXES):
        return False
    if base in (".netrc", "_netrc", ".pgpass", ".git-credentials", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"):
        return True
    if low.endswith(".aws/credentials") or low.endswith(".docker/config.json"):
        return True
    if base == ".env" or base.startswith(".env.") or base == ".envrc" or base.endswith(".env") and base != "venv.env":
        return True
    if base.endswith((".pem", ".key", ".p12", ".pfx")) and not base.endswith(".pub"):
        return True
    if ("credential" in base or "secret" in base) and not base.endswith(_CODE_EXT) and "." in base:
        return True
    return False


PRINTERS = {"cat", "head", "tail", "less", "more", "bat", "batcat", "sed", "grep", "egrep", "fgrep", "rg",
            "ag", "awk", "gawk", "nl", "sort", "uniq", "tac", "column", "jq", "yq", "tr", "cut", "xxd",
            "od", "hexdump", "strings", "tee", "echo", "printf", "paste",
            "fold", "expand", "diff", "comm", "view", "vim", "nano", "open", "base64", "envsubst", "fmt"}
READERS = {"cat", "head", "tail", "less", "more", "bat", "batcat", "sed", "grep", "egrep", "fgrep", "rg",
           "ag", "awk", "gawk", "nl", "sort", "uniq", "tac", "column", "jq", "yq", "tr", "cut", "xxd",
           "od", "hexdump", "strings", "diff", "comm", "view", "vim", "nano", "base64", "envsubst"}
_PATTERN_FIRST = {"grep", "egrep", "fgrep", "rg", "ag", "sed", "awk", "gawk"}
_WRAPPERS = {"sudo", "command", "time", "nohup", "exec", "builtin", "noglob", "xargs"}


def _split_top(cmd: str) -> list[tuple[str, str]]:
    """Split a shell line into (segment, operator-after) at unquoted ; && || | & and newlines.
    Command substitutions $(...) and `...` stay inside their segment."""
    segs, buf, i, n = [], [], 0, len(cmd)
    q = None
    depth = 0
    while i < n:
        c = cmd[i]
        if q == "'":
            buf.append(c)
            if c == "'":
                q = None
            i += 1
            continue
        if c == "\\" and i + 1 < n:
            buf.append(cmd[i:i + 2])
            i += 2
            continue
        if q == '"':
            buf.append(c)
            if c == '"':
                q = None
            elif c == "$" and cmd[i + 1:i + 2] == "(":
                depth += 1
                buf.append("(")
                i += 1
            elif c == ")" and depth:
                depth -= 1
            i += 1
            continue
        if c in "'\"":
            q = c
            buf.append(c)
            i += 1
            continue
        if c == "$" and cmd[i + 1:i + 2] == "(":
            depth += 1
            buf.append("$(")
            i += 2
            continue
        if c == "(" and depth:
            depth += 1
        if c == ")" and depth:
            depth -= 1
            buf.append(c)
            i += 1
            continue
        if depth == 0:
            two = cmd[i:i + 2]
            if two in ("&&", "||"):
                segs.append(("".join(buf), two))
                buf = []
                i += 2
                continue
            if c == "|" and two != "||":
                op = "|&" if two == "|&" else "|"
                segs.append(("".join(buf), "|"))
                buf = []
                i += len(op)
                continue
            if c in ";\n" or (c == "&" and cmd[i + 1:i + 2] != ">" and (i == 0 or cmd[i - 1] not in "<>&")):
                segs.append(("".join(buf), ";"))
                buf = []
                i += 1
                continue
        buf.append(c)
        i += 1
    segs.append(("".join(buf), ""))
    return [(s.strip(), op) for s, op in segs if s.strip()]


_HEREDOC = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")


def _strip_heredocs(cmd: str) -> str:
    lines = cmd.split("\n")
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        m = _HEREDOC.search(line)
        i += 1
        if m:
            tag = m.group(2)
            while i < len(lines) and lines[i].strip() != tag:
                i += 1
            i += 1  # skip the terminator
    return "\n".join(out)


def _strip_subst(seg: str) -> str:
    """Blank out $(...) and backtick bodies: their output feeds a variable or an argument."""
    out, i, n, depth, q = [], 0, len(seg), 0, None
    while i < n:
        c = seg[i]
        if depth == 0 and q != "'" and c == "$" and seg[i + 1:i + 2] == "(":
            depth = 1
            out.append("$(SUBST")
            i += 2
            continue
        if depth:
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
                if depth == 0:
                    out.append(")")
            i += 1
            continue
        if c == "'" and q != '"':
            q = None if q == "'" else "'"
        elif c == '"' and q != "'":
            q = None if q == '"' else '"'
        if c == "`" and q != "'":
            j = seg.find("`", i + 1)
            if j == -1:
                break
            out.append("SUBST")
            i = j + 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _words(seg: str) -> list[str]:
    try:
        return shlex.split(seg, posix=True)
    except ValueError:
        return seg.split()


def _head(words: list[str]) -> tuple[str, list[str]]:
    """The command name after env assignments and wrappers, plus its args."""
    i = 0
    while i < len(words):
        w = words[i]
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w):
            i += 1
            continue
        if w in _WRAPPERS:
            i += 1
            continue
        break
    if i >= len(words):
        return "", []
    name = words[i].rsplit("/", 1)[-1]
    return name, words[i + 1:]


def _stdout_redirected(words: list[str]) -> bool:
    for j, w in enumerate(words):
        m = re.match(r"^(\d?)(>>?|&>>?|>\|)(.*)$", w)
        if not m:
            continue
        fd, _, target = m.groups()
        if fd not in ("", "1") and not w.startswith("&"):
            continue
        if target.startswith("&"):
            continue  # 1>&2 still reaches the transcript
        if not target and j + 1 < len(words):
            target = words[j + 1]
        if target in ("/dev/stdout", "/dev/tty", "/dev/stderr"):
            continue
        return True
    return False


def _flags(args: list[str]) -> set[str]:
    out = set()
    for a in args:
        if a.startswith("--"):
            out.add(a.split("=", 1)[0])
        elif a.startswith("-") and len(a) > 1 and not a[1].isdigit():
            out.update("-" + ch for ch in a[1:])
    return out


_TAKES_VALUE = {
    "head": {"-n", "-c"}, "tail": {"-n", "-c"}, "cut": {"-d", "-f", "-c", "-b"},
    "grep": {"-e", "-f", "-m", "-A", "-B", "-C", "--max-count", "--regexp", "--file"},
    "rg": {"-e", "-f", "-m", "-A", "-B", "-C", "-g", "--glob", "-t", "--type", "--regexp"},
    "sed": {"-e", "-f"}, "awk": {"-F", "-v", "-f"}, "gawk": {"-F", "-v", "-f"},
}


def _positionals(name: str, args: list[str]) -> list[str]:
    pos, skip_next = [], False
    takes = _TAKES_VALUE.get("grep" if name in ("egrep", "fgrep", "ag") else name, set())
    has_script = any(a in ("-e", "--regexp", "-f", "--file") or a.startswith("--regexp=") for a in args)
    for a in args:
        if skip_next:
            skip_next = False
            continue
        if a.startswith("-") and a != "-":
            if a in takes:
                skip_next = True
            continue
        pos.append(a)
    if name in _PATTERN_FIRST and pos and not has_script:
        pos = pos[1:]  # the first one is the pattern or the script
    return pos


_NAME_ONLY_PAT = re.compile(r"^[\^(]*[A-Za-z0-9_\[\]\\|()^*+?{},-]*=?\)?\$?$")


def _grep_pattern(args: list[str]) -> str:
    for j, a in enumerate(args):
        if a in ("-e", "--regexp") and j + 1 < len(args):
            return args[j + 1]
        if a.startswith("--regexp="):
            return a.split("=", 1)[1]
    pos = [a for a in args if not a.startswith("-")]
    return pos[0] if pos else ""


def _masking_sed(args: list[str]) -> bool:
    """sed 's/=.*/=<set>/' and friends: the substitution swallows everything after = or :."""
    for a in args:
        m = re.match(r"^s(.)(.*?)\1", a)
        if not m:
            continue
        rx = m.group(2)
        i = max(rx.find("="), rx.find(":"))
        if i == -1:
            continue
        tail = rx[i + 1:]
        if re.search(r"\.[*+]|\.\\?\{|\[\^[^\]]*\][*+]", tail) and not re.search(r"[A-Za-z]{2,}", re.sub(
                r"\[\^?[^\]]*\]|\\.", "", tail)):
            return True
    return False


def _is_safe_sink(name: str, args: list[str]) -> bool:
    """A stage that prints no secret: counts, names only, a masking substitution, a length."""
    f = _flags(args)
    joined = " ".join(args)
    if name in ("wc", "test", "[", "md5", "md5sum", "shasum", "sha1sum", "sha256sum", "true", ":"):
        return True
    if name in ("grep", "egrep", "fgrep", "rg"):
        if f & {"-c", "-q", "-l", "-L", "--count", "--quiet", "--files-with-matches", "--files-without-match"}:
            return True
        pat = _grep_pattern(args)
        alts = [a for a in re.split(r"\\?\|", pat) if a]
        if alts and all((re.fullmatch(r"\^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+", a) or re.fullmatch(r"\^[A-Za-z_][A-Za-z0-9_]*=", a)) and not secret_name(a.strip("^=")) for a in alts):
            return True  # only whole, non-secret variable names (^JUDGE_MODEL, ^NOTION_DB_ID=); ^OPENAI is a prefix
        if f & {"-o", "--only-matching"}:
            short = re.sub(r"\.\{[1-8]\}", "", pat)  # a bounded .{6} fingerprint is a mask
            if short and not re.search(r"(?<!\\)\.|\\[Sw]|\[\^", short.rstrip("=)$")):
                return True
            # names only: no wildcard that could run on into a value
            if pat and not re.search(r"(?<!\\)\.|\\[Sw]|\[\^", pat.rstrip("=)$")):
                return True
            if pat and re.search(r"=\)?\$?$", pat) and not re.search(r"\[\^", pat):
                return True
    if name == "cut":
        fm = re.search(r"-f\s*(\S+)", joined)
        cm = re.search(r"-c\s*(\d*)-(\d+)", joined)
        if fm and fm.group(1) == "1":
            return True
        if cm and int(cm.group(2)) <= 8:
            return True
    if name == "head" and re.search(r"-c\s*([1-8])\b", joined):
        return True
    if name in ("awk", "gawk"):
        prog = " ".join(a for a in args if not a.startswith("-"))
        if "length(" in prog or not re.search(r"\$(?:0|[2-9])|print\s*(?:;|\}|$)", prog):
            return True
    if name == "sed" and _masking_sed(args):
        return True
    return False


def _pipeline_leaks(stages: list[list[str]]) -> bool:
    """Does what the first stage prints reach the transcript? It does only if every later
    stage passes it through (cat, tail, tr, ...). A stage that redirects, counts, or consumes
    it (vercel env add, pbcopy, a python script) ends the flow."""
    for k, words in enumerate(stages):
        if _stdout_redirected(words):
            return False
        if k == 0:
            continue
        name, args = _head(words)
        if _is_safe_sink(name, args):
            return False
        if name not in PRINTERS:
            return False
    return True


def _secret_var_refs(seg: str) -> list[str]:
    no_single = re.sub(r"'[^']*'", "''", seg)
    names = []
    for m in re.finditer(r"\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)", no_single):
        name = m.group(1) or m.group(3)
        mod = m.group(2) or ""
        if m.group(0).startswith("${#"):
            continue
        sub = re.match(r"^:(\d+):(\d+)$", mod)
        if sub and int(sub.group(2)) <= 8:
            continue  # ${KEY:0:4} is the masking idiom
        if mod.startswith(":+") or mod.startswith("+"):
            continue  # ${KEY:+set} prints a word, not the value
        if secret_name(name):
            names.append(name)
    return names


def _grep_drops_password(rest: list[list[str]]) -> bool:
    """`security ... -g 2>&1 | grep -E '^(credential-store|class)'` keeps only lines that are not the password."""
    for words in rest:
        n, a = _head(words)
        if n in ("grep", "egrep", "rg") and not ({"-v"} & _flags(a)):
            return not re.search(r"pass|word|\\S|\.\*|\.\+", _grep_pattern(a), re.I)
    return False


def check_bash(command: str) -> str | None:
    """Return a one-line reason when the command would print a secret, else None."""
    if not command or not command.strip():
        return None
    cmd = _strip_heredocs(command)

    # A database URL with its password typed inline.
    for h in find_secrets(cmd):
        if h["kind"] == "password in a database URL":
            return ("This command types a database password inline (password in a database URL, "
                    f"{h['length']} chars). Load it from the environment instead: "
                    "`set -a; source .env.local; set +a; psql \"$DATABASE_URL\"`.")

    segs = _split_top(cmd)
    # group into pipelines
    pipelines, cur = [], []
    for seg, op in segs:
        cur.append(seg)
        if op != "|":
            pipelines.append(cur)
            cur = []
    if cur:
        pipelines.append(cur)

    for pipe in pipelines:
        stages = [_words(_strip_subst(s)) for s in pipe]
        raw_stages = [_strip_subst(s) for s in pipe]
        leaks = _pipeline_leaks(stages) if stages and stages[-1] else False
        for idx, (words, raw) in enumerate(zip(stages, raw_stages)):
            name, args = _head(words)
            if not name:
                continue
            downstream = [stages[idx]] + stages[idx + 1:]
            out_leaks = _pipeline_leaks(downstream)
            f = _flags(args)
            joined = " ".join(args)

            # 1. reading a secret file
            if name in READERS and not (name == "sed" and "-i" in f):
                paths = [p for p in _positionals(name, args) if sensitive_path(p)]
                if paths and out_leaks and not _is_safe_sink(name, args):
                    base = paths[0].rstrip("/").rsplit("/", 1)[-1]
                    return (f"`{name}` would print the contents of {base}, which holds secret values, into "
                            f"the transcript. Instead, {SAFE_WAYS}")

            # 2. dumping the environment
            dump = False
            if name == "printenv":
                pos = [a for a in args if not a.startswith("-")]
                dump = not pos or any(secret_name(a) for a in pos)
            elif name == "env":
                rest = [a for a in args if not a.startswith("-") and "=" not in a]
                dump = not rest and not f & {"-u", "-i"} or (not rest and bool(f & {"-u", "-i"}) and
                                                             not re.search(r"-u\s+\S+\s+\S", joined))
            elif name in ("set", "export", "declare", "typeset"):
                if not args:
                    dump = name in ("set", "export")
                elif args in (["-p"], ["-x"], ["-px"], ["-xp"]) and name in ("export", "declare", "typeset"):
                    dump = True
            if dump and out_leaks:
                nxt = stages[idx + 1] if idx + 1 < len(stages) else None
                if nxt:
                    nname, nargs = _head(nxt)
                    if nname in ("grep", "egrep", "fgrep", "rg"):
                        pat = " ".join(a for a in nargs if not a.startswith("-"))
                        if not re.search(r"(?<![A-Za-z])(?:KEY|TOKEN|SECRET|PASS|PASSWORD|AUTH|COOKIE|DSN|CRED\w*|"
                                         r"PRIVATE|DATABASE_URL)(?![A-Za-z])", pat, re.I):
                            continue  # filtered to non-secret names
                return ("That would print every environment variable, secret values included, into the "
                        "transcript. List only the names (`env | cut -d= -f1`) or test one "
                        "(`test -n \"$NAME\" && echo set`). Instead, " + SAFE_WAYS)

            # 3. echo / printf of a variable named like a key
            if name in ("echo", "printf", "print") and out_leaks:
                refs = _secret_var_refs(raw)
                if refs:
                    return (f"`{name}` would print ${refs[0]} into the transcript. Report only its length "
                            "(`echo ${#" + refs[0] + "}`) or a masked start (`echo ${" + refs[0] +
                            ":0:4}`). Instead, " + SAFE_WAYS)

            # 4. commands whose whole job is to print a credential
            if name == "vercel" and args[:2] == ["env", "pull"] and any(
                    a in ("/dev/stdout", "-", "/dev/tty") for a in args[2:]):
                return ("`vercel env pull` to stdout prints every secret into the transcript. Pull to the "
                        "gitignored file (`vercel env pull .env.local`) and inspect names with "
                        "`cut -d= -f1 .env.local`.")
            if name == "security" and args[:1] and args[0] in ("find-generic-password", "find-internet-password") \
                    and f & {"-w", "-g"} and out_leaks and not _grep_drops_password(stages[idx + 1:]):
                return ("`security ... -w` prints the credential-store password into the transcript. Capture it "
                        "into a variable (`KEY=$(security find-generic-password -w -s NAME)`) or pipe it to "
                        "the command that needs it. Instead, " + SAFE_WAYS)
            if name == "gh" and args[:2] == ["auth", "token"] and out_leaks:
                return ("`gh auth token` prints the GitHub token into the transcript. Use it inline "
                        "(`GH_TOKEN=$(gh auth token) cmd`) or check it exists with `gh auth status`.")
            if name == "gh" and args[:2] == ["auth", "status"] and f & {"-t", "--show-token"}:
                return "`gh auth status --show-token` prints the token. Run `gh auth status` without it."
            if name == "op" and args[:1] == ["read"] and out_leaks:
                return ("`op read` prints the secret into the transcript. Capture it into a variable or "
                        "pipe it to the command that needs it.")
    return None


def check_read(file_path: str) -> str | None:
    if file_path and sensitive_path(file_path):
        base = file_path.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
        return (f"Reading {base} would put its secret values into the transcript. List the variable names "
                f"with `cut -d= -f1 {file_path!s}` in Bash, or {SAFE_WAYS}")
    return None


def check_grep_tool(tool_input: dict) -> str | None:
    mode = tool_input.get("output_mode") or "files_with_matches"
    if mode != "content":
        return None
    for key in ("path", "glob"):
        v = tool_input.get(key) or ""
        if v and sensitive_path(v):
            return ("Grep in content mode on a secrets file would print the values. Use "
                    "output_mode \"count\" or \"files_with_matches\", or " + SAFE_WAYS)
    return None


# ---------------------------------------------------------------------------
# Part 3. The hook.
# ---------------------------------------------------------------------------

TAIL_BYTES = 1_500_000


def turn_texts(path: str) -> list[str]:
    """Every assistant text block since owner's last prompt, read from the end of the
    transcript. `last_assistant_message` is the final reply; a key typed between tool calls
    earlier in the same turn lives only here. The doc warns the file can lag, so this is
    a second look, never the only one."""
    if not path:
        return []
    path = os.path.expanduser(path)
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            fh.seek(max(0, size - TAIL_BYTES))
            lines = fh.read().decode("utf-8", "ignore").split("\n")
    except OSError:
        return []
    out = []
    for line in reversed(lines):
        if '"type":"user"' not in line and '"type": "user"' not in line and '"assistant"' not in line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        content = (d.get("message") or {}).get("content")
        if d.get("type") == "user":
            if isinstance(content, str) or (isinstance(content, list) and not any(
                    isinstance(b, dict) and b.get("type") == "tool_result" for b in content)):
                break  # owner's prompt: the turn starts here
            continue
        if d.get("type") == "assistant" and isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get("type") == "text" and b.get("text"):
                    out.append(b["text"])
    return out


STOP_REASON = ("Your reply contains a key-shaped value ({what}). Replace it with a mask such as "
               "sk-…(40) and report only its length. If owner needs the value, tell him which file or "
               "Vercel env var holds it instead of printing it.")


def handle(payload: dict) -> tuple[dict | None, int]:
    event = payload.get("hook_event_name") or ""
    tool = payload.get("tool_name") or ""
    ti = payload.get("tool_input") or {}

    if event == "PreToolUse":
        reason = None
        if tool == "Bash":
            reason = check_bash(ti.get("command") or "")
        elif tool == "Read":
            reason = check_read(ti.get("file_path") or "")
        elif tool == "Grep":
            reason = check_grep_tool(ti)
        if reason:
            return ({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                            "permissionDecision": "deny",
                                            "permissionDecisionReason": "secret_guard: " + reason}}, 0)
        return None, 0

    if event == "PostToolUse" and tool == "Bash":
        resp = payload.get("tool_response")
        if not isinstance(resp, dict):
            return None, 0
        new, total = dict(resp), []
        for field in ("stdout", "stderr"):
            v = resp.get(field)
            if isinstance(v, str) and v:
                masked, hits = mask_text(v)
                if hits:
                    new[field] = masked
                    total += hits
        if not total:
            return None, 0
        return ({"hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "updatedToolOutput": new,
            "additionalContext": (f"secret_guard masked {len(total)} key-shaped value(s) in this output "
                                  f"({describe(total)}). The masks show only length; the real values are "
                                  "unchanged on disk. Do not print or ask for them."),
        }}, 0)

    if event == "Stop":
        if payload.get("stop_hook_active"):
            return None, 0
        hits = find_secrets(payload.get("last_assistant_message") or "", bare=True)
        if not hits:
            for t in turn_texts(payload.get("transcript_path") or ""):
                hits = find_secrets(t, bare=True)
                if hits:
                    break
        if hits:
            return ({"decision": "block", "reason": STOP_REASON.format(what=describe(hits))}, 0)
        return None, 0

    return None, 0


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            return 0
        out, code = handle(payload)
        if out is not None:
            sys.stdout.write(json.dumps(out))
        return code
    except Exception:
        return 0  # fail open: never break a session over this guard


if __name__ == "__main__":
    sys.exit(main())
