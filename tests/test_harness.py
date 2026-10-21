import json
import os
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

    def test_doctor(self):
        r = h(self.proj, "doctor")
        self.assertIn("python:", r.stdout)
        self.assertIn("mock", r.stdout)

    def test_core_files(self):
        for p in ("README.md", "PROTOCOL.md", "LICENSE", "core/templates/job-brief.md", "core/templates/report.md",
                  "core/templates/handoff.md", "adapters/codex/AGENTS.md", "adapters/gemini/GEMINI.md",
                  "adapters/chat/project-instructions.md", "adapters/terminal/README.md",
                  "adapters/claude-code/README.md", "scripts/leak_scan.py", ".github/workflows/ci.yml"):
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
