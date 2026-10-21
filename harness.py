#!/usr/bin/env python3
"""agent-harness: a portable Manager -> Lead -> Worker file bus for any LLM app.

Python 3.8+, standard library only.
"""
import argparse
import datetime
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent
SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
DOT = "·"
ADAPTERS = {
    "claude": [
        ("adapters/claude-code/CLAUDE.md", "CLAUDE.md"),
        ("adapters/claude-code/.claude/settings.example.json", ".claude/settings.example.json"),
    ],
    "codex": [("adapters/codex/AGENTS.md", "AGENTS.md")],
    "gemini": [("adapters/gemini/GEMINI.md", "GEMINI.md")],
    "vscode": [
        ("adapters/vscode/.github/copilot-instructions.md", ".github/copilot-instructions.md"),
        ("adapters/vscode/.cursor/rules/harness.mdc", ".cursor/rules/harness.mdc"),
        ("adapters/vscode/.vscode/tasks.json", ".vscode/tasks.json"),
    ],
}
DETECT = {"claude": "claude", "codex": "codex", "gemini": "gemini", "vscode": None}


def out(text=""):
    try:
        sys.stdout.write(text + "\n")
    except UnicodeEncodeError:
        sys.stdout.write(text.encode("ascii", "replace").decode("ascii") + "\n")
    sys.stdout.flush()


def die(msg, code=2):
    sys.stderr.write("harness: " + msg + "\n")
    sys.exit(code)


def stamp():
    return datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")


def read(p):
    return Path(p).read_text(encoding="utf-8")


def write(p, text):
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(str(p), "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def check_slug(s, what="name"):
    if not s or not SLUG_RE.match(s):
        die("bad %s %r (use letters, digits, . _ - only)" % (what, s))
    return s


# ---------- workspace ----------

def find_ws(start=None):
    env = os.environ.get("HARNESS_DIR")
    if env and Path(env).is_dir():
        return Path(env).resolve()
    cur = Path(start or os.getcwd()).resolve()
    for d in [cur] + list(cur.parents):
        if (d / ".harness" / "harness.json").is_file():
            return d / ".harness"
    die("no .harness workspace found; run: harness init")


def load_cfg(ws):
    try:
        return json.loads(read(ws / "harness.json"))
    except (OSError, ValueError) as e:
        die("cannot read harness.json: %s" % e)


def log(ws, event, **kw):
    rec = {"time": datetime.datetime.now().isoformat(timespec="seconds"), "event": event}
    rec.update(kw)
    with open(str(ws / "log.jsonl"), "a", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(rec) + "\n")


def identity(role, dept=None, job=None):
    if role == "manager":
        return "manager", "Manager"
    if role == "lead":
        d = check_slug(dept or "general", "dept")
        return "lead-" + d, "Lead %s %s" % (DOT, d.capitalize())
    if role == "worker":
        j = check_slug(job, "job")
        return "worker-" + j, "Worker %s %s" % (DOT, j)
    die("unknown role %r" % role)


def harness_cmd():
    return '"%s" "%s"' % (sys.executable, SRC / "harness.py")


def role_card(ws, role):
    p = ws / "roles" / (role + ".md")
    if not p.is_file():
        p = SRC / "core" / "roles" / (role + ".md")
    return read(p)


def unread(ws, slug):
    d = ws / "inbox" / slug
    if not d.is_dir():
        return []
    return sorted(p for p in d.iterdir() if p.is_file() and p.suffix == ".md")


# ---------- init ----------

def copy_noclobber(src, dst):
    """Copy src to dst. If dst exists and differs, write dst + .harness-new."""
    src, dst = Path(src), Path(dst)
    data = src.read_bytes()
    if dst.exists():
        if dst.read_bytes() == data:
            return "same"
        new = dst.with_name(dst.name + ".harness-new")
        new.write_bytes(data)
        return "new:" + str(new)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(data)
    return "created"


GITIGNORE_BLOCK = """
# agent-harness: machine-local state (the briefs, handoffs and roles in .harness/ stay tracked)
.harness/inbox/
.harness/sessions/
.harness/reports/
.harness/log.jsonl
"""
BRAIN_SKIP = {"CLAUDE.md", ".gitignore"}


def write_noclobber(text, dst):
    """Like copy_noclobber, but the source is a string."""
    dst = Path(dst)
    data = text.encode("utf-8")
    if dst.exists():
        if dst.read_bytes() == data:
            return "same"
        new = dst.with_name(dst.name + ".harness-new")
        new.write_bytes(data)
        return "new:" + str(new)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(data)
    return "created"


def copy_keepmode(src, dst):
    res = copy_noclobber(src, dst)
    if res == "created":
        shutil.copymode(str(src), str(dst))
    return res


def brain_files():
    base = SRC / "brain" / "template"
    for d, dirs, fs in os.walk(str(base)):
        dirs[:] = sorted(x for x in dirs if x != "__pycache__")
        for f in sorted(fs):
            if not f.endswith(".pyc"):
                p = Path(d) / f
                yield p, p.relative_to(base)


def harness_section():
    body = read(SRC / "adapters" / "claude-code" / "CLAUDE.md").split("\n", 1)[1]
    return ("\n## Harness\n" + body.rstrip("\n") + "\n\n"
            "Role cards live in `.harness/roles/`. Read this file (the constitution) first, then your role card.\n")


def project_readme(name):
    return (read(SRC / "core" / "readme_project.md").replace("{{NAME}}", name)
            .replace("{{BRAIN}}", read(SRC / "brain" / "readme_brain.md").rstrip("\n")))


def install_hook(root):
    """Install hooks/pre-commit where git looks for it. Returns a status string."""
    src = root / "hooks" / "pre-commit"
    if not src.is_file() or not shutil.which("git"):
        return "skipped"
    r = subprocess.run(["git", "rev-parse", "--git-path", "hooks/pre-commit"], cwd=str(root),
                       capture_output=True, text=True)
    if r.returncode != 0 or not r.stdout.strip():
        return "skipped (git would not say where hooks live)"
    dst = Path(r.stdout.strip())
    if not dst.is_absolute():
        dst = root / dst
    res = copy_noclobber(src, dst)
    if res == "created":
        os.chmod(str(dst), 0o755)
        return "installed at %s" % dst
    if res == "same":
        return "already installed"
    return "a different pre-commit hook exists; wrote %s" % res[4:]


def initial_commit(root):
    """A brand-new repo gets one commit so lint does not report every page as untracked."""
    try:
        subprocess.run(["git", "add", "-A"], cwd=str(root), check=True, capture_output=True)
        have = subprocess.run(["git", "config", "user.email"], cwd=str(root), capture_output=True, text=True)
        ident = [] if have.stdout.strip() else ["-c", "user.name=harness", "-c", "user.email=harness@example.com"]
        subprocess.run(["git"] + ident + ["commit", "-q", "-m", "harness init: team and second brain"],
                       cwd=str(root), check=True, capture_output=True)
    except (OSError, subprocess.CalledProcessError) as e:
        sys.stderr.write("harness: initial commit skipped (%s). Run: git add -A && git commit -m start\n" % e)


def init_brain(root, git):
    created = 0
    for src, rel in brain_files():
        if str(rel).replace("\\", "/") in BRAIN_SKIP:
            continue
        res = copy_keepmode(src, root / rel)
        if res == "created":
            created += 1
        elif res.startswith("new:"):
            out("exists, wrote %s" % res[4:])
    for rel, text in (("CLAUDE.md", read(SRC / "brain" / "template" / "CLAUDE.md").rstrip("\n") + "\n" + harness_section()),
                      (".gitignore", read(SRC / "brain" / "template" / ".gitignore").rstrip("\n") + "\n" + GITIGNORE_BLOCK),
                      ("README.md", project_readme(root.name))):
        res = write_noclobber(text, root / rel)
        if res.startswith("new:"):
            out("exists, wrote %s" % res[4:])
    status = "no git (--no-git)"
    if git:
        if not shutil.which("git"):
            status = "git not found on PATH; install git, then run: git init"
        else:
            fresh = not (root / ".git").exists()
            if fresh:
                subprocess.run(["git", "init", "-q"], cwd=str(root), check=False)
                initial_commit(root)
            status = install_hook(root)
            if not fresh:
                status += "; existing repo: commit the new files before running lint (harness commit --all \"add brain\")"
    out("brain: %d files created; commit gate: %s" % (created, status))


def cmd_init(a):
    root = Path(a.dir or ".").resolve()
    root.mkdir(parents=True, exist_ok=True)
    ws = root / ".harness"
    cfg = json.loads(read(SRC / "core" / "harness.example.json"))
    leads = [check_slug(x.strip(), "lead") for x in a.leads.split(",") if x.strip()] if a.leads else cfg["team"]["leads"]
    cfg["team"]["leads"] = leads
    for d in ["inbox/manager", "jobs", "handoffs", "reports", "sessions", "hooks", "templates", "roles"]:
        (ws / d).mkdir(parents=True, exist_ok=True)
    for l in leads:
        (ws / "inbox" / ("lead-" + l)).mkdir(parents=True, exist_ok=True)
    if not (ws / "harness.json").exists():
        write(ws / "harness.json", json.dumps(cfg, indent=2) + "\n")
    for r in ("manager", "lead", "worker"):
        copy_noclobber(SRC / "core" / "roles" / (r + ".md"), ws / "roles" / (r + ".md"))
    for t in (SRC / "core" / "templates").iterdir():
        copy_noclobber(t, ws / "templates" / t.name)
    copy_noclobber(SRC / "PROTOCOL.md", ws / "PROTOCOL.md")
    copy_noclobber(SRC / "adapters" / "claude-code" / "role_card_hook.py", ws / "hooks" / "role_card_hook.py")
    (ws / "log.jsonl").touch()
    apps = []
    if a.app == "all":
        apps = list(ADAPTERS)
    elif a.app:
        apps = [x.strip() for x in a.app.split(",") if x.strip()]
    else:
        for k, exe in DETECT.items():
            if exe and shutil.which(exe):
                apps.append(k)
        if shutil.which("code") or shutil.which("cursor"):
            apps.append("vscode")
    brain = not a.no_brain
    for k in apps:
        if k not in ADAPTERS:
            die("unknown app %r (claude, codex, gemini, vscode, all)" % k)
        for s, d in ADAPTERS[k]:
            if brain and d == "CLAUDE.md":
                continue  # the brain constitution gets the Harness section instead
            res = copy_noclobber(SRC / s, root / d)
            if res.startswith("new:"):
                out("exists, wrote %s" % res[4:])
    if brain:
        init_brain(root, not a.no_git)
    log(ws, "init", leads=leads, apps=apps, brain=brain)
    out("workspace: %s" % ws)
    out("adapters: %s" % (", ".join(apps) if apps else "none detected (use --app)"))
    out("next: %s launch manager" % harness_cmd())


# ---------- messaging ----------

def deliver(ws, frm, to, body):
    check_slug(frm, "from")
    check_slug(to, "to")
    d = ws / "inbox" / to
    d.mkdir(parents=True, exist_ok=True)
    name = "%s-from-%s.md" % (stamp(), frm)
    head = "---\nfrom: %s\nto: %s\ntime: %s\n---\n" % (frm, to, datetime.datetime.now().isoformat(timespec="seconds"))
    write(d / name, head + body.rstrip("\n") + "\n")
    log(ws, "send", frm=frm, to=to, file=name)
    return d / name


def cmd_send(a):
    ws = find_ws()
    frm = a.sender or os.environ.get("HARNESS_SLUG") or "user"
    if a.file:
        body = read(a.file)
    elif a.text:
        body = " ".join(a.text)
    else:
        body = sys.stdin.read()
    if not body.strip():
        die("empty message")
    p = deliver(ws, frm, a.to, body)
    out("sent: %s" % p)


def cmd_inbox(a):
    ws = find_ws()
    check_slug(a.slug, "slug")
    msgs = unread(ws, a.slug)
    if not msgs:
        out("(no unread messages for %s)" % a.slug)
        return
    rd = ws / "inbox" / a.slug / "read"
    for m in msgs:
        out("=== %s ===" % m.name)
        out(read(m).rstrip("\n"))
        out()
        if not a.keep:
            rd.mkdir(parents=True, exist_ok=True)
            os.replace(str(m), str(rd / m.name))
    log(ws, "inbox", slug=a.slug, count=len(msgs), kept=bool(a.keep))


# ---------- boot / launch ----------

def has_brain(root):
    return (root / "tools" / "agenda.py").is_file() and (root / "wiki").is_dir()


def agenda_text(root, limit=20):
    r = subprocess.run([sys.executable, str(root / "tools" / "agenda.py")], cwd=str(root),
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    lines = (r.stdout or r.stderr or "(no output)").rstrip().splitlines()
    if len(lines) > limit:
        lines = lines[:limit] + ["... (%d more lines: run `agenda`)" % (len(lines) - limit)]
    return "\n".join(lines)


def make_boot(ws, role, dept=None, job=None, brief=None):
    slug, title = identity(role, dept, job)
    parts = ["# BOOT: %s\n" % title,
             "You are **%s** (slug `%s`, role `%s`).\n" % (title, slug, role),
             "Workspace: `%s`" % ws,
             "Harness command: `%s`" % harness_cmd(),
             "Use that command for every `send`, `inbox`, `spawn`, `status` call below.\n",
             "## Role card\n", role_card(ws, role).rstrip(), "\n## Protocol\n"]
    pp = ws / "PROTOCOL.md"
    parts.append(read(pp if pp.is_file() else SRC / "PROTOCOL.md").rstrip())
    h = ws / "handoffs" / (slug + ".md")
    parts.append("\n## Handoff\n")
    parts.append(read(h).rstrip() if h.is_file() else "(none)")
    if brief:
        parts.append("\n## Job brief\n")
        parts.append(read(brief).rstrip())
    if has_brain(ws.parent):
        parts.append("\n## Open agenda (from `wiki/_reminders.md`, via `agenda`)\n")
        parts.append(agenda_text(ws.parent))
    parts.append("\n## Unread inbox (not yet marked read; run `inbox %s` to read them)\n" % slug)
    msgs = unread(ws, slug)
    parts.extend("- " + m.name for m in msgs) if msgs else parts.append("(empty)")
    bp = ws / "sessions" / slug / "BOOT.md"
    write(bp, "\n".join(parts) + "\n")
    return bp, slug, title


def cmd_boot(a):
    ws = find_ws()
    bp, _, _ = make_boot(ws, a.role, a.dept, a.job, a.brief)
    out(str(bp))


def fill(argv, mapping):
    res = []
    for x in argv:
        for k, v in mapping.items():
            x = x.replace("{" + k + "}", v)
        res.append(x)
    return res


def resolve_exe(argv):
    exe = argv[0]
    if os.path.isabs(exe) and os.path.exists(exe):
        return argv
    found = shutil.which(exe)
    if not found:
        die("app executable %r not found on PATH (run: harness doctor)" % exe)
    return [found] + argv[1:]


def open_window(ws_root, role_args, slug):
    """Open a new terminal running 'launch' without --new-window. Returns True if opened."""
    base = [sys.executable, str(SRC / "harness.py"), "launch"] + role_args
    env_dir = os.environ.get("HARNESS_DIR") or ""
    if sys.platform == "darwin":
        inner = "cd %s && HARNESS_DIR=%s %s" % (shlex.quote(str(ws_root)), shlex.quote(str(env_dir or find_ws())),
                                                " ".join(shlex.quote(x) for x in base))
        inner = inner.replace("\\", "\\\\").replace('"', '\\"')
        subprocess.Popen(["osascript", "-e", 'tell application "Terminal" to do script "%s"' % inner,
                          "-e", 'tell application "Terminal" to activate'])
        return True
    if os.name == "nt":
        ps = "Set-Location -LiteralPath '%s'; $env:HARNESS_DIR='%s'; & %s" % (
            str(ws_root).replace("'", "''"), str(find_ws()).replace("'", "''"),
            " ".join("'" + x.replace("'", "''") + "'" for x in base))
        subprocess.Popen(["cmd.exe", "/c", "start", "powershell", "-NoExit", "-Command", ps])
        return True
    cmdline = "cd %s && HARNESS_DIR=%s %s" % (shlex.quote(str(ws_root)), shlex.quote(str(find_ws())),
                                              " ".join(shlex.quote(x) for x in base))
    sh = ["bash", "-lc", cmdline + "; exec bash"]
    for term, flag in (("x-terminal-emulator", "-e"), ("gnome-terminal", "--"), ("konsole", "-e")):
        if shutil.which(term):
            subprocess.Popen([shutil.which(term), flag] + sh)
            return True
    if shutil.which("tmux"):
        if os.environ.get("TMUX"):
            subprocess.call(["tmux", "new-window", "-n", slug, cmdline])
        else:
            subprocess.call(["tmux", "new-session", "-d", "-s", slug, cmdline])
            out("started tmux session %s (attach with: tmux attach -t %s)" % (slug, slug))
        return True
    return False


def run_launch(a, role, dept=None, job=None):
    ws = find_ws()
    cfg = load_cfg(ws)
    brief = a.brief if getattr(a, "brief", None) else None
    if brief and not Path(brief).is_file():
        die("brief file not found: %s" % brief)
    if brief:
        brief = str(Path(brief).resolve())
    bp, slug, title = make_boot(ws, role, dept, job, brief)
    name = a.app or cfg.get("default_app")
    app = cfg.get("apps", {}).get(name)
    if not app:
        die("unknown app %r (see harness.json)" % name)
    root = ws.parent
    if role == "worker":
        parent = getattr(a, "parent", None) or os.environ.get("HARNESS_SLUG") or "manager"
    else:
        parent = "manager" if role == "lead" else None
    env = dict(os.environ)
    env.update({"HARNESS_TITLE": title, "HARNESS_ROLE": role, "HARNESS_DIR": str(ws),
                "HARNESS_SLUG": slug, "HARNESS_CMD": harness_cmd()})
    if parent:
        env["HARNESS_PARENT"] = parent
    kick = "Read %s and follow it. You are %s." % (bp, title)
    mapping = {"kickoff": kick, "python": sys.executable, "root": str(SRC), "boot": str(bp), "workspace": str(ws)}
    headless = bool(a.headless)
    if getattr(a, "new_window", False) and not headless:
        ra = [role] + (["--dept", dept] if dept else []) + (["--job", job] if job else []) + ["--app", name]
        if brief:
            ra += ["--brief", brief]
        if open_window(root, ra, slug):
            log(ws, "window", slug=slug, app=name)
            return 0
        sys.stderr.write("harness: no terminal found; falling back to headless\n")
        headless = True
    if not headless:
        spec = app.get("interactive")
        if spec == "print":
            out(read(bp))
            return 0
        if not spec:
            die("app %r has no interactive command (use --headless)" % name)
        argv = resolve_exe(fill(spec, mapping))
        log(ws, "launch", slug=slug, app=name, mode="interactive")
        return subprocess.call(argv, cwd=str(root), env=env)
    spec = app.get("headless")
    if not spec or spec == "print":
        die("app %r has no headless command" % name)
    argv = resolve_exe(fill(spec, mapping))
    boot_text = read(bp)
    log(ws, "launch", slug=slug, app=name, mode="headless")
    if app.get("stdin", True):
        res = subprocess.run(argv, input=boot_text.encode("utf-8"), stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, cwd=str(root), env=env)
    else:
        res = subprocess.run(argv + [kick], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, cwd=str(root), env=env)
    text = res.stdout.decode("utf-8", "replace")
    rp = ws / "reports" / ("%s-%s.md" % (slug, stamp()))
    write(rp, text)
    if res.stderr:
        sys.stderr.write(res.stderr.decode("utf-8", "replace"))
    if parent:
        deliver(ws, slug, parent, "Report from %s (exit %d). Saved at %s\n\n%s" % (title, res.returncode, rp, text))
    log(ws, "report", slug=slug, file=rp.name, code=res.returncode)
    out("report: %s" % rp)
    return res.returncode


def cmd_launch(a):
    return run_launch(a, a.role, a.dept, a.job)


def cmd_spawn(a):
    a.role = "worker"
    a.headless = not a.window
    a.new_window = bool(a.window)
    a.dept = None
    return run_launch(a, "worker", None, a.job)


# ---------- status / doctor ----------

def cmd_status(a):
    ws = find_ws()
    cfg = load_cfg(ws)
    out("workspace: %s" % ws)
    out("default app: %s" % cfg.get("default_app"))
    out("inboxes (unread):")
    inbox = ws / "inbox"
    for d in sorted(p for p in inbox.iterdir() if p.is_dir()):
        out("  %-24s %d" % (d.name, len(unread(ws, d.name))))
    jobs = sorted((ws / "jobs").glob("*.md"))
    out("jobs: %s" % (", ".join(j.stem for j in jobs) if jobs else "(none)"))
    reps = sorted((ws / "reports").glob("*.md"))[-5:]
    out("last reports: %s" % (", ".join(r.name for r in reps) if reps else "(none)"))


def cmd_doctor(a):
    out("python: %s" % sys.version.split()[0])
    out("os: %s (%s)" % (sys.platform, os.name))
    if sys.version_info < (3, 8):
        out("WARNING: python 3.8+ required")
    try:
        ws = find_ws()
        cfg = load_cfg(ws)
    except SystemExit:
        cfg = json.loads(read(SRC / "core" / "harness.example.json"))
        out("(no workspace here; checking example config)")
    for name, app in sorted(cfg.get("apps", {}).items()):
        spec = app.get("headless") or app.get("interactive")
        if spec == "print":
            out("  %-8s built in" % name)
            continue
        exe = spec[0]
        if exe.startswith("{"):
            found = sys.executable
        else:
            found = shutil.which(exe)
        out("  %-8s %s" % (name, found or "NOT on PATH"))


# ---------- brain verbs ----------

def brain_root():
    root = find_ws().parent
    if not has_brain(root):
        die("no brain here (tools/agenda.py or wiki/ missing). Run init without --no-brain.")
    return root


def run_tool(root, script, args=()):
    return subprocess.call([sys.executable, str(root / "tools" / script)] + list(args), cwd=str(root))


def cmd_find(a):
    return run_tool(brain_root(), "find.py", a.terms)


def cmd_agenda(a):
    return run_tool(brain_root(), "agenda.py")


def cmd_close(a):
    """The closing ritual: lint, then connect. Same rules as hooks/pre-commit."""
    root = brain_root()
    env = dict(os.environ)
    rc = 0
    res = subprocess.run([sys.executable, str(root / "tools" / "lint.py")], cwd=str(root), env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out(res.stdout.decode("utf-8", "replace").rstrip("\n"))
    if res.returncode != 0:
        out("\nCLOSE FAILED: lint.py exited %d. Fix the lines above." % res.returncode)
        rc = 1
    res = subprocess.run([sys.executable, str(root / "tools" / "connect.py")], cwd=str(root), env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    text = res.stdout.decode("utf-8", "replace")
    out(text.rstrip("\n"))
    gap = re.search(r"^  GAP ", text, re.M)
    crash = re.search(r"^Traceback \(most recent call last\):", text, re.M) or (
        res.returncode != 0 and not re.search(r"^  (GAP|NEW) ", text, re.M))
    if crash:
        out("\nCLOSE FAILED: connect.py crashed (exit %d)." % res.returncode)
        rc = 1
    elif gap:
        out("\nCLOSE FAILED: connect.py found GAP lines. Open each target page and write the fact from its side.")
        rc = 1
    if rc == 0:
        out("\nclose: lint and connect clean.")
    return rc


def find_bash():
    """bash for safe_commit.sh. On Windows, Git's bash (never WSL's System32 bash.exe)."""
    if os.name != "nt":
        return shutil.which("bash")
    cands = []
    g = shutil.which("git")
    if g:
        top = Path(g).resolve().parent.parent
        cands += [top / "bin" / "bash.exe", top / "usr" / "bin" / "bash.exe"]
    for env in ("ProgramFiles", "ProgramFiles(x86)", "LocalAppData"):
        base = os.environ.get(env)
        if base:
            cands += [Path(base) / "Git" / "bin" / "bash.exe", Path(base) / "Programs" / "Git" / "bin" / "bash.exe"]
    for c in cands:
        if c.is_file():
            return str(c)
    return None


def cmd_commit(a):
    root = brain_root()
    bash = find_bash()
    if not bash:
        die("bash not found. tools/safe_commit.sh needs it. On Windows install Git for Windows (it includes bash).")
    if not a.files and not a.all:
        die("name the files you edited: commit \"msg\" <files> (or --all for a whole-tree sweep)")
    argv = [bash, "tools/safe_commit.sh"] + (["--all"] if a.all else []) + [a.message] + list(a.files)
    return subprocess.call(argv, cwd=str(root))


def build_parser():
    p = argparse.ArgumentParser(prog="harness", description="Manager -> Lead -> Worker file bus for any LLM app.")
    sub = p.add_subparsers(dest="cmd")
    s = sub.add_parser("init", help="create .harness workspace")
    s.add_argument("dir", nargs="?")
    s.add_argument("--leads")
    s.add_argument("--app", help="claude,codex,gemini,vscode or all")
    s.add_argument("--no-brain", action="store_true", help="harness only, no second brain")
    s.add_argument("--no-git", action="store_true", help="do not run git init or install the commit gate")
    s.set_defaults(fn=cmd_init)
    s = sub.add_parser("boot", help="write BOOT.md, print its path")
    s.add_argument("role", choices=["manager", "lead", "worker"])
    s.add_argument("--dept")
    s.add_argument("--job")
    s.add_argument("--brief")
    s.set_defaults(fn=cmd_boot)
    s = sub.add_parser("launch", help="boot, then run the app")
    s.add_argument("role", choices=["manager", "lead", "worker"])
    s.add_argument("--dept")
    s.add_argument("--job")
    s.add_argument("--app")
    s.add_argument("--headless", action="store_true")
    s.add_argument("--new-window", action="store_true")
    s.add_argument("--brief")
    s.add_argument("--parent")
    s.set_defaults(fn=cmd_launch)
    s = sub.add_parser("spawn", help="lead: start a worker")
    s.add_argument("what", choices=["worker"])
    s.add_argument("--job", required=True)
    s.add_argument("--brief", required=True)
    s.add_argument("--app")
    s.add_argument("--parent")
    s.add_argument("--window", action="store_true")
    s.set_defaults(fn=cmd_spawn)
    s = sub.add_parser("send", help="write a message to an inbox")
    s.add_argument("--from", dest="sender")
    s.add_argument("--to", required=True)
    s.add_argument("--file")
    s.add_argument("text", nargs="*")
    s.set_defaults(fn=cmd_send)
    s = sub.add_parser("inbox", help="print unread messages and mark them read")
    s.add_argument("slug")
    s.add_argument("--keep", action="store_true")
    s.set_defaults(fn=cmd_inbox)
    s = sub.add_parser("find", help="search the brain (tools/find.py)")
    s.add_argument("terms", nargs="+")
    s.set_defaults(fn=cmd_find)
    s = sub.add_parser("agenda", help="print the open agenda (tools/agenda.py)")
    s.set_defaults(fn=cmd_agenda)
    s = sub.add_parser("close", help="closing ritual: lint + connect; nonzero on failure")
    s.set_defaults(fn=cmd_close)
    s = sub.add_parser("commit", help="commit through tools/safe_commit.sh")
    s.add_argument("--all", action="store_true")
    s.add_argument("message")
    s.add_argument("files", nargs="*")
    s.set_defaults(fn=cmd_commit)
    s = sub.add_parser("status")
    s.set_defaults(fn=cmd_status)
    s = sub.add_parser("doctor")
    s.set_defaults(fn=cmd_doctor)
    return p


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    p = build_parser()
    a = p.parse_args(argv)
    if not getattr(a, "fn", None):
        p.print_help()
        return 2
    return a.fn(a) or 0


if __name__ == "__main__":
    sys.exit(main())
