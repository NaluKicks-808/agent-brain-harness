#!/usr/bin/env python3
"""agent-brain-harness installer (the logic behind install.sh and install.ps1).

Python 3.8+, standard library only. Every change is written to a manifest at
~/.agent-brain-harness/manifest.json so --uninstall removes exactly what was installed.

    python3 install.py [--yes] [--dry-run] [--uninstall] [--dir BRAIN] [--source SRC]
                       [--bin DIR] [--claude-hook | --no-claude-hook] [--no-path] [--no-brain]
"""
import argparse
import datetime
import hashlib
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
from pathlib import Path

NAME = "agent-brain-harness"
ALIASES = ("agent-brain-harness", "harness")
MARK = "agent-brain-harness launcher"
BLOCK_BEGIN = "# >>> agent-brain-harness >>>"
BLOCK_END = "# <<< agent-brain-harness <<<"
HOOK_MARK = "role_card_hook.py"
NT = os.name == "nt"
SKIP_DIRS = {".git", "__pycache__", ".DS_Store"}
TOP_SKIP = {"docs", ".github"}  # not needed to run the program; docs/ also holds the install transcript

COLOR = sys.stdout.isatty() and not os.environ.get("NO_COLOR") and not NT


def paint(code, text):
    return "\033[%sm%s\033[0m" % (code, text) if COLOR else text


def say(text=""):
    try:
        sys.stdout.write(text + "\n")
    except UnicodeEncodeError:
        sys.stdout.write(text.encode("ascii", "replace").decode("ascii") + "\n")
    sys.stdout.flush()


class Ctx:
    def __init__(self, a):
        self.a = a
        self.dry = a.dry_run
        self.yes = a.yes
        self.home = Path(os.path.expanduser("~"))
        self.root = self.home / ("." + NAME)
        self.app = self.root / "app"
        self.manifest_path = self.root / "manifest.json"
        self.manifest = self.load_manifest()
        self.changed = False
        self.step_no = 0
        self.steps = 0

    def load_manifest(self):
        try:
            return json.loads(self.manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"version": 1, "app": None, "launchers": [], "rc_blocks": [], "settings": [],
                    "brains": [], "win_path": []}

    def save_manifest(self):
        if self.dry:
            return
        self.root.mkdir(parents=True, exist_ok=True)
        self.manifest_path.write_text(json.dumps(self.manifest, indent=2) + "\n", encoding="utf-8")

    def interactive(self):
        return not self.yes and sys.stdin.isatty()

    def ask(self, question, default, yesno=False):
        """Ask on the terminal; --yes or no terminal gives the default."""
        if yesno:
            shown = "Y/n" if default else "y/N"
        else:
            shown = str(default)
        if not self.interactive():
            say("      %s [%s]: using the default" % (question, shown))
            return default
        try:
            ans = input("      %s [%s]: " % (question, shown)).strip()
        except EOFError:
            ans = ""
        if not ans:
            return default
        if yesno:
            return ans.lower() in ("y", "yes")
        return ans

    def step(self, title):
        self.step_no += 1
        say("")
        say(paint("1", "[%d/%d] %s" % (self.step_no, self.steps, title)))

    def ok(self, text):
        say("      " + paint("32", "ok") + "  " + text)

    def did(self, text):
        self.changed = True
        say("      " + paint("32", "done") + "  " + text)

    def would(self, text):
        self.changed = True
        say("      " + paint("36", "would") + "  " + text)

    def warn(self, text):
        say("      " + paint("33", "note") + "  " + text)

    def fail(self, text, code=1):
        say("      " + paint("31", "stop") + "  " + text)
        sys.exit(code)


# ---------- helpers ----------

def tree_hash(root):
    h = hashlib.sha256()
    for d, dirs, files in os.walk(str(root)):
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS and not (Path(d) == Path(str(root)) and x in TOP_SKIP))
        for f in sorted(files):
            if f in SKIP_DIRS or f.endswith(".pyc"):
                continue
            p = Path(d) / f
            h.update(str(p.relative_to(root)).replace("\\", "/").encode("utf-8") + b"\0")
            h.update(p.read_bytes() + b"\0")
    return h.hexdigest()


def rm_readonly(func, path, _exc):
    try:
        os.chmod(path, stat.S_IWRITE)
        func(path)
    except OSError:
        pass


def rmtree(path):
    shutil.rmtree(str(path), onerror=rm_readonly)


def copy_tree(src, dst):
    def ignore(_d, names):
        top = Path(_d) == Path(str(src))
        return [n for n in names if n in SKIP_DIRS or n.endswith(".pyc") or (top and n in TOP_SKIP)]
    shutil.copytree(str(src), str(dst), ignore=ignore)


def which_python_cmd():
    return "python" if NT else "python3"


def shell_rc(home):
    sh = os.path.basename(os.environ.get("SHELL", ""))
    if sh == "zsh":
        return home / ".zshrc"
    if sh == "bash":
        return home / (".bash_profile" if sys.platform == "darwin" else ".bashrc")
    return home / ".profile"


def on_path(d):
    parts = [os.path.normcase(os.path.normpath(p)) for p in os.environ.get("PATH", "").split(os.pathsep) if p]
    return os.path.normcase(os.path.normpath(str(d))) in parts


def short(path, home):
    s = str(path)
    h = str(home)
    return "~" + s[len(h):] if s.startswith(h) else s


# ---------- steps ----------

def step_detect(c):
    c.step("Detect your system")
    c.ok("os: %s %s (%s)" % (platform.system(), platform.release(), platform.machine()))
    c.ok("python: %s at %s" % (platform.python_version(), sys.executable))
    c.ok("home: %s" % c.home)
    if sys.version_info < (3, 8):
        c.fail("Python 3.8 or newer is required (this is %s). Install it from python.org, then rerun." % platform.python_version())
    if c.dry:
        c.ok("dry run: nothing below is changed, every action is only printed")


def step_deps(c):
    c.step("Check what is installed")
    hints = {
        "git": {"darwin": "run: xcode-select --install", "win32": "run: winget install --id Git.Git -e",
                "linux": "run: sudo apt install git   (or: sudo dnf install git)"},
    }
    git = shutil.which("git")
    if git:
        c.ok("git: %s" % git)
    else:
        how = hints["git"].get(sys.platform if sys.platform in hints["git"] else "linux")
        c.fail("git is missing. It is needed for the brain's commit gate. Get it: %s. Then rerun this installer." % how)
    for exe, what, how in (
            ("claude", "Claude Code", "https://claude.com/claude-code"),
            ("codex", "Codex CLI", "npm install -g @openai/codex"),
            ("gemini", "Gemini CLI", "npm install -g @google/gemini-cli"),
            ("node", "Node.js (only for the optional Claude Code console mod and npm-installed CLIs)", "https://nodejs.org")):
        found = shutil.which(exe)
        if found:
            c.ok("%s (optional): %s" % (exe, found))
        else:
            c.warn("%s not found (optional). %s: %s" % (exe, what, how))
    c.warn("no AI app is required to install. You need at least one to use the team: Claude Code, Codex, Gemini, or a chat app.")


def step_brain_dir(c):
    c.step("Choose the folder for your team and second brain")
    default = c.a.dir or str(c.home / "agent-brain")
    ans = c.ask("Brain folder", default)
    brain = Path(os.path.expanduser(str(ans))).resolve()
    if brain.exists() and not brain.is_dir():
        c.fail("%s exists and is not a folder." % brain)
    if brain.is_dir() and any(brain.iterdir()) and not (brain / ".harness" / "harness.json").is_file():
        c.warn("%s already has files. Nothing is overwritten: clashes are written as <name>.harness-new." % brain)
    c.ok("brain folder: %s" % brain)
    return brain


def step_app(c, src):
    c.step("Install the harness program")
    if not (src / "harness.py").is_file():
        c.fail("harness.py not found in %s. Use --source with a checkout of the repository." % src)
    want = tree_hash(src)
    have = tree_hash(c.app) if (c.app / "harness.py").is_file() else None
    c.ok("source: %s" % src)
    if have == want:
        c.ok("already installed at %s, identical" % c.app)
        return
    verb = "update" if have else "copy"
    if c.dry:
        c.would("%s the program into %s" % (verb, c.app))
        return
    if c.app.exists():
        rmtree(c.app)
    c.root.mkdir(parents=True, exist_ok=True)
    copy_tree(src, c.app)
    c.manifest["app"] = str(c.app)
    c.did("%s: program is at %s" % ("updated" if have else "copied", c.app))


def step_init(c, brain):
    c.step("Create the team and the second brain")
    if (brain / ".harness" / "harness.json").is_file():
        c.ok("already initialised: %s" % brain)
        _remember_brain(c, brain, created=False)
        return
    cmd = [sys.executable, str(c.app / "harness.py"), "init", str(brain)]
    if c.a.no_brain:
        cmd.append("--no-brain")
    if c.dry:
        c.would("run: %s" % " ".join(cmd))
        return
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    for line in (r.stdout + r.stderr).rstrip().splitlines():
        say("      | " + line)
    if r.returncode != 0:
        c.fail("init failed (exit %d). Nothing else was changed." % r.returncode)
    _remember_brain(c, brain, created=True)
    c.did("created the team (.harness/) and the brain in %s" % brain)


def _remember_brain(c, brain, created):
    for b in c.manifest["brains"]:
        if b["path"] == str(brain):
            return
    c.manifest["brains"].append({"path": str(brain), "created_by_installer": created})


def merge_hook(settings, command):
    """Add our SessionStart hook without touching anything else. Returns True if it changed."""
    hooks = settings.setdefault("hooks", {})
    ss = hooks.setdefault("SessionStart", [])
    for entry in ss:
        for h in entry.get("hooks", []):
            if HOOK_MARK in str(h.get("command", "")):
                return False
    ss.append({"hooks": [{"type": "command", "command": command}]})
    return True


def strip_hook(settings):
    changed = False
    ss = settings.get("hooks", {}).get("SessionStart", [])
    for entry in list(ss):
        keep = [h for h in entry.get("hooks", []) if HOOK_MARK not in str(h.get("command", ""))]
        if len(keep) != len(entry.get("hooks", [])):
            changed = True
            if keep:
                entry["hooks"] = keep
            else:
                ss.remove(entry)
    if changed:
        if not ss:
            settings["hooks"].pop("SessionStart", None)
        if not settings.get("hooks"):
            settings.pop("hooks", None)
    return changed


def step_hooks(c, brain):
    c.step("Wire the hooks")
    gate = brain / ".git" / "hooks" / "pre-commit"
    if c.a.no_brain:
        c.ok("git commit gate: skipped (--no-brain)")
    elif gate.is_file():
        c.ok("git pre-commit gate: installed at %s (blocks a commit while lint fails)" % gate)
    elif c.dry:
        c.ok("git pre-commit gate: init installs it in %s/.git/hooks/" % brain)
    else:
        c.warn("git pre-commit gate: not found in %s" % brain)
    if c.a.claude_hook is None:
        want = c.ask("Add the Claude Code SessionStart role hook to %s? It shows each agent its role card; it does nothing in an ordinary session" % short(brain / ".claude" / "settings.json", c.home), False, yesno=True)
    else:
        want = c.a.claude_hook
    if not want:
        c.ok("Claude Code hook: not added. Skip is fine; add later with: %s install.py --claude-hook" % which_python_cmd())
        return
    settings = brain / ".claude" / "settings.json"
    cmd = "%s .harness/hooks/role_card_hook.py" % which_python_cmd()
    data, existed = {}, settings.is_file()
    if existed:
        try:
            data = json.loads(settings.read_text(encoding="utf-8"))
            assert isinstance(data, dict)
        except (ValueError, AssertionError):
            c.fail("%s is not valid JSON, so it was left alone. Fix or move it, then rerun." % settings)
    if not merge_hook(data, cmd):
        c.ok("Claude Code hook: already in %s" % settings)
        return
    backup = None
    if c.dry:
        c.would("%s %s (backup first)" % ("merge the hook into" if existed else "create", settings))
        return
    if existed:
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = settings.with_name(settings.name + ".bak-" + NAME + "-" + stamp)
        shutil.copy2(str(settings), str(backup))
    settings.parent.mkdir(parents=True, exist_ok=True)
    settings.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    c.manifest["settings"].append({"file": str(settings), "backup": str(backup) if backup else None,
                                   "created": not existed})
    c.did("Claude Code hook %s %s%s" % ("merged into" if existed else "written to", settings,
                                        "; backup: " + backup.name if backup else ""))


def write_launcher(c, path, py):
    """Returns 'same', 'created', 'updated' or 'foreign' (someone else's file with that name)."""
    if NT:
        text = "@echo off\r\nrem %s\r\n\"%s\" \"%s\" %%*\r\n" % (MARK, py, c.app / "harness.py")
    else:
        text = ("#!/bin/sh\n# %s\nPY=\"%s\"\n[ -x \"$PY\" ] || PY=python3\nexec \"$PY\" \"%s\" \"$@\"\n"
                % (MARK, py, c.app / "harness.py"))
    if path.is_file():
        old = path.read_text(encoding="utf-8", errors="replace")
        if MARK not in old:
            return "foreign"
        if old == text:
            return "same"
    status = "updated" if path.is_file() else "created"
    if not c.dry:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(str(path), "w", encoding="utf-8", newline="") as f:
            f.write(text)
        if not NT:
            os.chmod(str(path), 0o755)
    return status


def step_launcher(c):
    c.step("Put the launcher on your PATH")
    bindir = Path(c.a.bin) if c.a.bin else (c.root / "bin" if NT else c.home / ".local" / "bin")
    want = c.ask("Install the `%s` command in %s" % (NAME, short(bindir, c.home)), True, yesno=True)
    if not want:
        c.ok("launcher: skipped. Run it by hand: %s %s" % (which_python_cmd(), c.app / "harness.py"))
        return None
    for name in ALIASES:
        path = bindir / (name + (".cmd" if NT else ""))
        res = write_launcher(c, path, sys.executable)
        if res == "foreign":
            c.warn("%s already exists and is not ours, left alone" % path)
        elif res == "same":
            c.ok("launcher %s: already there" % path)
        else:
            (c.would if c.dry else c.did)("%s launcher %s" % ({"created": "create", "updated": "update"}[res] if c.dry else res, path))
            if not c.dry and str(path) not in c.manifest["launchers"]:
                c.manifest["launchers"].append(str(path))
    if on_path(bindir):
        c.ok("%s is already on your PATH" % bindir)
    elif c.a.no_path:
        c.warn("--no-path: your PATH is not edited. Add %s to it yourself." % bindir)
    elif NT:
        add_win_path(c, bindir)
    else:
        add_rc_block(c, bindir)
    return bindir


def add_rc_block(c, bindir):
    rc = shell_rc(c.home)
    rel = ("$HOME" + str(bindir)[len(str(c.home)):]) if str(bindir).startswith(str(c.home)) else str(bindir)
    block = "%s\nexport PATH=\"%s:$PATH\"\n%s\n" % (BLOCK_BEGIN, rel, BLOCK_END)
    old = rc.read_text(encoding="utf-8", errors="replace") if rc.is_file() else ""
    if BLOCK_BEGIN in old:
        c.ok("PATH line already in %s" % rc)
        return
    if not c.ask("%s is not on your PATH. Add it to %s" % (short(bindir, c.home), short(rc, c.home)), True, yesno=True):
        c.warn("PATH not changed. Add this yourself: export PATH=\"%s:$PATH\"" % bindir)
        return
    if c.dry:
        c.would("append a marked PATH block to %s" % rc)
        return
    with open(str(rc), "a", encoding="utf-8", newline="\n") as f:
        f.write(("\n" if old and not old.endswith("\n") else "") + block)
    c.manifest["rc_blocks"].append({"file": str(rc)})
    c.did("added a marked PATH block to %s (open a new terminal to use it)" % rc)


def add_win_path(c, bindir):
    # Not run locally (no Windows here); first CI run on windows-latest is the test.
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment", 0, winreg.KEY_READ | winreg.KEY_WRITE)
        try:
            cur, kind = winreg.QueryValueEx(key, "Path")
        except FileNotFoundError:
            cur, kind = "", winreg.REG_EXPAND_SZ
        if str(bindir).lower() in [p.strip().lower() for p in cur.split(";")]:
            c.ok("%s is already in your user PATH" % bindir)
            return
        if not c.ask("%s is not on your PATH. Add it to your user PATH" % bindir, True, yesno=True):
            c.warn("PATH not changed. Add %s yourself." % bindir)
            return
        if c.dry:
            c.would("add %s to the user PATH" % bindir)
            return
        winreg.SetValueEx(key, "Path", 0, kind, (cur.rstrip(";") + ";" if cur else "") + str(bindir))
        c.manifest["win_path"].append(str(bindir))
        c.did("added %s to your user PATH (open a new terminal to use it)" % bindir)
    except Exception as e:  # winreg missing, locked key, etc.
        c.warn("could not edit PATH (%s). Add %s yourself." % (e, bindir))


def step_finish(c, brain, bindir):
    c.step("Finish")
    if c.dry:
        say("      dry run complete: nothing was changed.")
    elif not c.changed:
        say("      " + paint("32", "Nothing to do: already installed and up to date."))
    if c.changed or not c.manifest_path.is_file():
        c.save_manifest()
    if not c.dry:
        c.ok("manifest: %s (uninstall reads it)" % c.manifest_path)
    cmd = NAME if (bindir and (on_path(bindir) or c.dry)) else (
        str(bindir / (NAME + (".cmd" if NT else ""))) if bindir else "%s %s" % (which_python_cmd(), c.app / "harness.py"))
    say("")
    say(paint("1", "After a real install, next 3 things:" if c.dry else "You're set. Next 3 things:"))
    say("  1. Start the Manager:      cd \"%s\" && %s launch manager" % (brain, cmd))
    say("     (new terminal first if the command is not found; other apps: add --app codex or --app gemini)")
    say("  2. Ask it for something. It hands jobs to Leads and Workers, and looks in the brain before it asks you.")
    say("  3. Make the brain yours: replace the fictional bike-shop pages in wiki/ and raw/, then run: %s close" % cmd)
    say("")
    if not c.dry:
        say("Undo everything: python3 %s --uninstall   (your brain folder is kept unless you type its name to delete it)" % (c.app / "install.py"))


# ---------- uninstall ----------

def uninstall(c):
    c.steps = 6
    m = c.manifest
    say(paint("1", "agent-brain-harness uninstall") + ("   [dry run: nothing is changed]" if c.dry else ""))
    if not c.manifest_path.is_file():
        say("")
        say("Nothing to uninstall: no manifest at %s." % c.manifest_path)
        return 0
    c.step("Remove launchers")
    for p in list(m["launchers"]):
        p = Path(p)
        if p.is_file() and MARK in p.read_text(encoding="utf-8", errors="replace"):
            if c.dry:
                c.would("remove %s" % p)
            else:
                p.unlink()
                c.did("removed %s" % p)
                for d in (p.parent, p.parent.parent):  # only if empty; rmdir refuses otherwise
                    try:
                        if d == p.parent or d.name == ".local":
                            d.rmdir()
                    except OSError:
                        pass
        else:
            c.ok("%s already gone" % p)
    c.step("Remove PATH edits")
    for rb in m["rc_blocks"]:
        rc = Path(rb["file"])
        if not rc.is_file():
            c.ok("%s already gone" % rc)
            continue
        text = rc.read_text(encoding="utf-8", errors="replace")
        a, b = text.find(BLOCK_BEGIN), text.find(BLOCK_END)
        if a < 0 or b < a:
            c.ok("no marked block left in %s" % rc)
            continue
        end = b + len(BLOCK_END)
        if text[end:end + 1] == "\n":
            end += 1
        if c.dry:
            c.would("remove the marked block from %s" % rc)
        else:
            new = (text[:a].rstrip("\n") + "\n" + text[end:]) if text[:a].strip() or text[end:].strip() else ""
            if new.strip():
                rc.write_text(new, encoding="utf-8")
                c.did("removed the marked block from %s" % rc)
            else:
                rc.unlink()
                c.did("removed %s (it held only our block)" % rc)
    for d in m.get("win_path", []):
        try:
            import winreg
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment", 0, winreg.KEY_READ | winreg.KEY_WRITE)
            cur, kind = winreg.QueryValueEx(key, "Path")
            parts = [p for p in cur.split(";") if p.strip().lower() != d.lower()]
            if c.dry:
                c.would("remove %s from the user PATH" % d)
            else:
                winreg.SetValueEx(key, "Path", 0, kind, ";".join(parts))
                c.did("removed %s from the user PATH" % d)
        except Exception as e:
            c.warn("could not edit PATH (%s). Remove %s yourself." % (e, d))
    if not m["rc_blocks"] and not m.get("win_path"):
        c.ok("none were made")
    c.step("Remove the Claude Code hook")
    for s in m["settings"]:
        f = Path(s["file"])
        if not f.is_file():
            c.ok("%s already gone" % f)
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except ValueError:
            c.warn("%s is not valid JSON now; left alone" % f)
            continue
        if not strip_hook(data):
            c.ok("no hook of ours left in %s" % f)
            continue
        if c.dry:
            c.would("remove our hook from %s" % f)
        elif s.get("created") and not data:
            f.unlink()
            c.did("removed %s (we created it and it is now empty)" % f)
        else:
            f.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
            c.did("removed our hook from %s (your other settings untouched; backup kept: %s)" % (f, s.get("backup") or "none"))
    if not m["settings"]:
        c.ok("none was added")
    c.step("Remove the program")
    if c.app.is_dir():
        if c.dry:
            c.would("remove %s" % c.app)
        else:
            rmtree(c.app)
            c.did("removed %s" % c.app)
    else:
        c.ok("already gone")
    c.step("Your brain folders")
    for b in m["brains"]:
        p = Path(b["path"])
        if not p.is_dir():
            c.ok("%s already gone" % p)
            continue
        c.ok("kept: %s" % p)
        if c.interactive() and not c.dry:
            say("      To DELETE it permanently (all notes, history and .git) type its folder name, %r. Anything else keeps it." % p.name)
            try:
                typed = input("      > ").strip()
            except EOFError:
                typed = ""
            if typed == p.name:
                rmtree(p)
                c.did("deleted %s" % p)
            else:
                c.ok("kept")
    if not m["brains"]:
        c.ok("none recorded")
    c.step("Remove the manifest")
    if c.dry:
        c.would("remove %s" % c.manifest_path)
    else:
        c.manifest_path.unlink()
        try:
            c.root.rmdir()
        except OSError:
            pass
        c.did("removed %s" % c.manifest_path)
    say("")
    say("Uninstalled." if not c.dry else "Dry run complete: nothing was changed.")
    return 0


# ---------- main ----------

def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    p = argparse.ArgumentParser(prog="install", description="Install agent-brain-harness (team + second brain).")
    p.add_argument("--yes", "-y", action="store_true", help="no questions, take every default")
    p.add_argument("--dry-run", action="store_true", help="print every action, change nothing")
    p.add_argument("--uninstall", action="store_true", help="remove what this installer installed (keeps your brain)")
    p.add_argument("--dir", help="brain folder (default ~/agent-brain)")
    p.add_argument("--source", help="folder holding harness.py (default: the folder this script is in)")
    p.add_argument("--bin", help="where to put the launcher (default ~/.local/bin)")
    p.add_argument("--no-path", action="store_true", help="install the launcher but never edit your PATH or shell rc")
    p.add_argument("--no-brain", action="store_true", help="team only, no second brain")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--claude-hook", dest="claude_hook", action="store_true", default=None)
    g.add_argument("--no-claude-hook", dest="claude_hook", action="store_false")
    a = p.parse_args(argv)
    c = Ctx(a)
    if a.uninstall:
        return uninstall(c)
    c.steps = 8
    src = Path(a.source).resolve() if a.source else Path(__file__).resolve().parent
    say(paint("1", "agent-brain-harness installer") + ("   [dry run: nothing is changed]" if c.dry else ""))
    say("One setup: a Manager/Lead/Worker team plus a second brain they read first.")
    if not c.interactive() and not a.yes:
        say("No terminal to ask on: every question takes its default (same as --yes).")
    step_detect(c)
    step_deps(c)
    brain = step_brain_dir(c)
    step_app(c, src)
    step_init(c, brain)
    step_hooks(c, brain)
    bindir = step_launcher(c)
    step_finish(c, brain, bindir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
