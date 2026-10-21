import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HARNESS = str(ROOT / "harness.py")


def clean_env():
    env = dict(os.environ)
    for k in ("HARNESS_DIR", "HARNESS_SLUG", "HARNESS_ROLE", "HARNESS_TITLE", "HARNESS_PARENT", "HARNESS_CMD"):
        env.pop(k, None)
    return env


def h(cwd, *args, check=True):
    r = subprocess.run([sys.executable, HARNESS] + list(args), cwd=str(cwd), capture_output=True,
                       text=True, encoding="utf-8", env=clean_env())
    if check and r.returncode != 0:
        raise AssertionError("harness %s failed (%d): %s%s" % (args, r.returncode, r.stdout, r.stderr))
    return r


class HarnessTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.proj = Path(self.tmp.name) / "my project"
        h(ROOT, "init", str(self.proj), "--leads", "research,build")
        self.ws = self.proj / ".harness"

    def tearDown(self):
        self.tmp.cleanup()

    def test_init_layout(self):
        for p in ("harness.json", "roles/manager.md", "roles/lead.md", "roles/worker.md", "PROTOCOL.md",
                  "inbox/manager", "inbox/lead-build", "inbox/lead-research", "jobs", "handoffs", "reports",
                  "sessions", "log.jsonl", "hooks/role_card_hook.py"):
            self.assertTrue((self.ws / p).exists(), p)
        cfg = json.loads((self.ws / "harness.json").read_text(encoding="utf-8"))
        self.assertEqual(cfg["team"]["leads"], ["research", "build"])

    def test_init_adapters_no_overwrite(self):
        (self.proj / "CLAUDE.md").write_text("mine\n", encoding="utf-8")
        h(ROOT, "init", str(self.proj), "--app", "all")
        self.assertEqual((self.proj / "CLAUDE.md").read_text(encoding="utf-8"), "mine\n")
        self.assertTrue((self.proj / "CLAUDE.md.harness-new").is_file())
        for p in ("AGENTS.md", "GEMINI.md", ".cursor/rules/harness.mdc", ".vscode/tasks.json",
                  ".github/copilot-instructions.md", ".claude/settings.example.json"):
            self.assertTrue((self.proj / p).is_file(), p)
        # roles the user edited are kept
        (self.ws / "roles" / "lead.md").write_text("edited\n", encoding="utf-8")
        h(ROOT, "init", str(self.proj))
        self.assertEqual((self.ws / "roles" / "lead.md").read_text(encoding="utf-8"), "edited\n")

    def test_send_inbox_read_move(self):
        h(self.proj, "send", "--from", "lead-build", "--to", "manager", "hello there")
        keep = h(self.proj, "inbox", "manager", "--keep").stdout
        self.assertIn("hello there", keep)
        self.assertEqual(len(list((self.ws / "inbox" / "manager").glob("*.md"))), 1)
        first = h(self.proj, "inbox", "manager").stdout
        self.assertIn("hello there", first)
        self.assertEqual(len(list((self.ws / "inbox" / "manager").glob("*.md"))), 0)
        self.assertEqual(len(list((self.ws / "inbox" / "manager" / "read").glob("*.md"))), 1)
        self.assertIn("no unread", h(self.proj, "inbox", "manager").stdout)

    def test_bad_slug_rejected(self):
        r = h(self.proj, "send", "--to", "../evil", "x", check=False)
        self.assertNotEqual(r.returncode, 0)

    def test_boot_contents(self):
        h(self.proj, "send", "--from", "manager", "--to", "lead-build", "job: j1, go")
        bp = Path(h(self.proj, "boot", "lead", "--dept", "build").stdout.strip())
        text = bp.read_text(encoding="utf-8")
        self.assertTrue(bp.is_absolute())
        self.assertIn("Lead · Build", text)
        self.assertIn("# Role: Lead", text)
        self.assertIn("# Protocol", text)
        self.assertIn("from-manager.md", text)
        self.assertEqual(bp.parts[-3:], ("sessions", "lead-build", "BOOT.md"))

    def test_print_app(self):
        r = h(self.proj, "launch", "manager", "--app", "print")
        self.assertIn("# Role: Manager", r.stdout)

    def test_round_trip_mock(self):
        h(self.proj, "launch", "manager", "--app", "mock", "--headless")
        self.assertIn("job: demo-1", h(self.proj, "inbox", "lead-build", "--keep").stdout)
        h(self.proj, "launch", "lead", "--dept", "build", "--app", "mock", "--headless")
        self.assertTrue((self.ws / "jobs" / "demo-1.md").is_file())
        reps = [p.name for p in (self.ws / "reports").glob("*.md")]
        self.assertTrue(any(n.startswith("worker-demo-1-") for n in reps), reps)
        self.assertTrue(any(n.startswith("lead-build-") for n in reps), reps)
        mgr = h(self.proj, "inbox", "manager").stdout
        self.assertIn("lead summary", mgr)
        self.assertIn("hello from worker-demo-1", mgr)
        self.assertIn("close rc=0", mgr)
        # worker wrote a fact and a ledger row; the brain gates still pass
        self.assertIn("spare tube", (self.proj / "wiki" / "people" / "sam-rivera.md").read_text(encoding="utf-8"))
        self.assertIn("worker-demo-1 spare-tube", (self.proj / "wiki" / "_reminders.md").read_text(encoding="utf-8"))
        self.assertIn("spare-tube", h(self.proj, "agenda").stdout)
        self.assertEqual(h(self.proj, "close", check=False).returncode, 0)
        self.assertIn("manager", h(self.proj, "status").stdout)
        events = [json.loads(l)["event"] for l in (self.ws / "log.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertIn("report", events)

    def test_paths_windows_safe(self):
        names = [p.name for p in self.ws.rglob("*")]
        for n in names:
            self.assertFalse(any(c in n for c in '<>:"|?*'), n)
        h(self.proj, "send", "--to", "manager", "x")
        for p in (self.ws / "inbox" / "manager").glob("*.md"):
            self.assertNotIn(":", p.name)

    def test_launchers_exist(self):
        for p in ("macos/harness.sh", "macos/harness.command", "linux/harness.sh",
                  "windows/harness.ps1", "windows/harness.cmd"):
            self.assertTrue((ROOT / "launchers" / p).is_file(), p)
        if os.name == "posix":
            for p in ("macos/harness.sh", "macos/harness.command", "linux/harness.sh"):
                self.assertTrue(os.access(str(ROOT / "launchers" / p), os.X_OK), p)

    def test_brain_layout(self):
        for p in ("CLAUDE.md", "README.md", ".gitignore", ".gitattributes", "hooks/pre-commit", "tools/lint.py",
                  "tools/find.py", "tools/safe_commit.sh", "tools/tests/test_lint.py", "wiki/_reminders.md",
                  "raw/entries/2026-09-12_shop-visit-notes.md", "data/README.md", "quiz/questions.example.jsonl",
                  ".claude/rules/wiki-writing.md", ".obsidian/graph.json", ".git/hooks/pre-commit"):
            self.assertTrue((self.proj / p).exists(), p)
        self.assertFalse((self.proj / "LICENSE").exists())
        claude = (self.proj / "CLAUDE.md").read_text(encoding="utf-8")
        self.assertIn("# The constitution", claude)
        self.assertIn("## Harness", claude)
        self.assertIn(".harness/roles/", claude)
        readme = (self.proj / "README.md").read_text(encoding="utf-8")
        self.assertIn("`.harness/`", readme)
        self.assertIn("second-brain-kit", readme)
        self.assertNotIn("{{", readme)
        if os.name == "posix":
            self.assertTrue(os.access(str(self.proj / "tools" / "safe_commit.sh"), os.X_OK))
            self.assertTrue(os.access(str(self.proj / ".git" / "hooks" / "pre-commit"), os.X_OK))

    def test_brain_gates_clean_after_init(self):
        r = subprocess.run([sys.executable, "tools/lint.py"], cwd=str(self.proj), capture_output=True,
                           text=True, encoding="utf-8")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("sam-rivera", h(self.proj, "find", "bike").stdout)
        self.assertIn("tune-up", h(self.proj, "agenda").stdout)

    def test_close_fails_on_broken_link(self):
        page = self.proj / "wiki" / "people" / "sam-rivera.md"
        page.write_text(page.read_text(encoding="utf-8") + "\nSee [[no-such-page]].\n", encoding="utf-8")
        r = h(self.proj, "close", check=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("CLOSE FAILED", r.stdout)

    def test_boot_has_brain_and_agenda(self):
        bp = Path(h(self.proj, "boot", "manager").stdout.strip())
        text = bp.read_text(encoding="utf-8")
        self.assertIn("## Brain", text)
        self.assertIn("## Open agenda", text)
        self.assertIn("tune-up", text)

    def test_no_brain(self):
        p = Path(self.tmp.name) / "plain"
        h(ROOT, "init", str(p), "--no-brain")
        self.assertTrue((p / ".harness" / "harness.json").is_file())
        for n in ("wiki", "tools", "hooks", "README.md", ".git"):
            self.assertFalse((p / n).exists(), n)
        r = h(p, "find", "bike", check=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no brain", r.stderr)
        self.assertNotIn("## Open agenda", Path(h(p, "boot", "manager").stdout.strip()).read_text(encoding="utf-8"))

    def test_no_git_and_existing_files_kept(self):
        p = Path(self.tmp.name) / "nogit"
        p.mkdir()
        (p / "README.md").write_text("mine\n", encoding="utf-8")
        h(ROOT, "init", str(p), "--no-git")
        self.assertFalse((p / ".git").exists())
        self.assertEqual((p / "README.md").read_text(encoding="utf-8"), "mine\n")
        self.assertTrue((p / "README.md.harness-new").is_file())

    @unittest.skipUnless(shutil.which("bash") and os.name == "posix", "needs POSIX bash")
    def test_commit_verb(self):
        env = clean_env()
        env.update({"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
                    "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com",
                    "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull})
        page = self.proj / "wiki" / "people" / "sam-rivera.md"
        page.write_text(page.read_text(encoding="utf-8") + "\nSam rides a blue bike.\n", encoding="utf-8")
        r = subprocess.run([sys.executable, HARNESS, "commit", "--all", "test commit"], cwd=str(self.proj),
                           capture_output=True, text=True, encoding="utf-8", env=env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        log = subprocess.run(["git", "log", "--oneline"], cwd=str(self.proj), capture_output=True, text=True, env=env)
        self.assertIn("test commit", log.stdout)

    def test_doctor(self):
        r = h(self.proj, "doctor")
        self.assertIn("python:", r.stdout)
        self.assertIn("mock", r.stdout)

    def test_core_files(self):
        for p in ("README.md", "PROTOCOL.md", "LICENSE", "core/templates/job-brief.md", "core/templates/report.md",
                  "core/templates/handoff.md", "adapters/codex/AGENTS.md", "adapters/gemini/GEMINI.md",
                  "adapters/chat/project-instructions.md", "adapters/terminal/README.md",
                  "adapters/claude-code/README.md", "brain/readme_brain.md", "brain/template/CLAUDE.md", "core/readme_project.md", "scripts/leak_scan.py", ".github/workflows/ci.yml"):
            self.assertTrue((ROOT / p).is_file(), p)
        for r in ("manager", "lead", "worker"):
            n = len((ROOT / "core" / "roles" / (r + ".md")).read_text(encoding="utf-8").splitlines())
            self.assertLessEqual(n, 60, r)

    def test_leak_scan_clean(self):
        r = subprocess.run([sys.executable, str(ROOT / "scripts" / "leak_scan.py")], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_role_hook(self):
        env = clean_env()
        env.update({"HARNESS_ROLE": "worker", "HARNESS_TITLE": "Worker · x", "HARNESS_DIR": str(self.ws)})
        r = subprocess.run([sys.executable, str(self.ws / "hooks" / "role_card_hook.py")], capture_output=True,
                           env=env)
        data = json.loads(r.stdout.decode("utf-8"))
        self.assertIn("Role: Worker", data["hookSpecificOutput"]["additionalContext"])


if __name__ == "__main__":
    unittest.main()
