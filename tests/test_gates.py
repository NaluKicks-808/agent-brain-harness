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
INSTALL = str(ROOT / "install.py")
GIT = shutil.which("git")


def env_for(home=None):
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", NO_COLOR="1", GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com")
    for k in ("HARNESS_DIR", "HARNESS_SLUG", "HARNESS_ROLE", "HARNESS_TITLE", "HARNESS_PARENT", "HARNESS_CMD"):
        env.pop(k, None)
    if home:
        env.update(HOME=str(home), USERPROFILE=str(home))
    return env


def run(cmd, cwd, env=None, check=True):
    r = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, encoding="utf-8", env=env or env_for(),
                       stdin=subprocess.DEVNULL)
    if check and r.returncode != 0:
        raise AssertionError("%s failed (%d): %s%s" % (cmd, r.returncode, r.stdout, r.stderr))
    return r


def h(cwd, *args, check=True, env=None):
    return run([sys.executable, HARNESS] + list(args), cwd, env, check)


@unittest.skipUnless(GIT, "git is needed")
class GateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.repo = self.base / "code"
        self.repo.mkdir()
        run(["git", "init", "-q"], self.repo)
        (self.repo / "tests").mkdir()
        self.test_file = self.repo / "tests" / "test_x.py"
        self.test_file.write_text("import unittest\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n",
                                  encoding="utf-8")
        run(["git", "add", "-A"], self.repo)
        run(["git", "commit", "-qm", "start"], self.repo)
        self.remote = self.base / "remote.git"
        run(["git", "init", "-q", "--bare", str(self.remote)], self.base)
        run(["git", "remote", "add", "origin", str(self.remote)], self.repo)

    def tearDown(self):
        self.tmp.cleanup()

    def hook(self):
        return self.repo / ".git" / "hooks" / "pre-push"

    def test_install_status_uninstall(self):
        self.assertEqual(h(self.repo, "gate", "status", check=False).returncode, 1)
        out = h(self.repo, "gate", "install").stdout
        self.assertIn("created", out)
        self.assertTrue(self.hook().is_file())
        self.assertEqual(h(self.repo, "gate", "status").returncode, 0)
        self.assertIn("same", h(self.repo, "gate", "install").stdout)
        self.assertIn("removed", h(self.repo, "gate", "uninstall").stdout)
        self.assertFalse(self.hook().exists())
        self.assertIn("absent", h(self.repo, "gate", "uninstall").stdout)

    def test_foreign_hook_is_left_alone(self):
        self.hook().write_text("#!/bin/sh\necho mine\n", encoding="utf-8")
        r = h(self.repo, "gate", "install", check=False)
        self.assertEqual(r.returncode, 1)
        self.assertIn("foreign", r.stdout)
        self.assertEqual(self.hook().read_text(encoding="utf-8"), "#!/bin/sh\necho mine\n")
        h(self.repo, "gate", "uninstall", check=False)
        self.assertTrue(self.hook().is_file())

    def test_push_blocked_by_failing_test_then_allowed(self):
        h(self.repo, "gate", "install")
        self.test_file.write_text("import unittest\nclass T(unittest.TestCase):\n    def test_bad(self):\n        self.fail('broken')\n",
                                  encoding="utf-8")
        run(["git", "commit", "-qam", "break it"], self.repo)
        r = run(["git", "push", "-q", "origin", "HEAD:main"], self.repo, check=False)
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("push refused", r.stderr)
        heads = run(["git", "ls-remote", str(self.remote)], self.base).stdout
        self.assertNotIn("refs/heads/main", heads)
        self.test_file.write_text("import unittest\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n",
                                  encoding="utf-8")
        run(["git", "commit", "-qam", "fix it"], self.repo)
        r = run(["git", "push", "-q", "origin", "HEAD:main"], self.repo, check=False)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("refs/heads/main", run(["git", "ls-remote", str(self.remote)], self.base).stdout)

    def test_gate_tests_file_overrides_the_guess(self):
        h(self.repo, "gate", "install")
        (self.repo / ".harness").mkdir()
        (self.repo / ".harness" / "gate-tests").write_text('"%s" -c "import sys; sys.exit(3)"\n' % sys.executable, encoding="utf-8")
        run(["git", "add", "-A"], self.repo)
        run(["git", "commit", "-qm", "gate cmd"], self.repo)
        r = run(["git", "push", "-q", "origin", "HEAD:main"], self.repo, check=False)
        self.assertNotEqual(r.returncode, 0)

    def test_leak_scan_failure_blocks(self):
        h(self.repo, "gate", "install")
        (self.repo / "scripts").mkdir()
        (self.repo / "scripts" / "leak_scan.py").write_text("import sys\nprint('leak')\nsys.exit(1)\n", encoding="utf-8")
        run(["git", "add", "-A"], self.repo)
        run(["git", "commit", "-qm", "scan"], self.repo)
        r = run(["git", "push", "-q", "origin", "HEAD:main"], self.repo, check=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("leak scan", r.stderr)


@unittest.skipUnless(GIT, "git is needed")
class InstallGateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir()
        self.repo = Path(self.tmp.name) / "code"
        self.repo.mkdir()
        run(["git", "init", "-q"], self.repo)
        self.env = env_for(self.home)
        self.hook = self.repo / ".git" / "hooks" / "pre-push"

    def tearDown(self):
        self.tmp.cleanup()

    def install(self, *args):
        base = [sys.executable, INSTALL, "--yes", "--no-path", "--no-claude-hook", "--dir", str(self.home / "brain"),
                "--bin", str(self.home / "bin"), "--gate", str(self.repo)]
        return run(base + list(args), self.home, self.env).stdout

    def test_opt_in_dry_run_rerun_uninstall(self):
        out = self.install("--dry-run")
        self.assertIn("would  create the pre-push gate", out)
        self.assertFalse(self.hook.exists())
        out = self.install()
        self.assertTrue(self.hook.is_file())
        self.assertIn(str(self.hook), (self.home / ".agent-brain-harness" / "manifest.json").read_text(encoding="utf-8").replace("\\\\", "\\"))
        self.assertIn("Nothing to do", self.install())
        out = run([sys.executable, INSTALL, "--uninstall", "--yes"], self.home, self.env).stdout
        self.assertIn("remove the pre-push gate", out)
        self.assertFalse(self.hook.exists())

    def test_without_the_flag_nothing_is_installed(self):
        base = [sys.executable, INSTALL, "--yes", "--no-path", "--no-claude-hook", "--dir", str(self.home / "brain"),
                "--bin", str(self.home / "bin")]
        out = run(base, self.home, self.env).stdout
        self.assertIn("pre-push gate: not installed", out)
        self.assertFalse(self.hook.exists())

    def test_uninstall_keeps_a_gate_the_installer_did_not_put_there(self):
        base = [sys.executable, INSTALL, "--yes", "--no-path", "--no-claude-hook", "--dir", str(self.home / "brain"),
                "--bin", str(self.home / "bin")]
        run(base, self.home, self.env)
        h(self.repo, "gate", "install")
        run([sys.executable, INSTALL, "--uninstall", "--yes"], self.home, self.env)
        self.assertTrue(self.hook.is_file())


class DoctorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir()
        self.env = env_for(self.home)
        self.proj = Path(self.tmp.name) / "proj"
        h(ROOT, "init", str(self.proj), "--leads", "build", env=self.env)

    def tearDown(self):
        self.tmp.cleanup()

    def test_fresh_project_is_healthy(self):
        r = h(self.proj, "doctor", env=self.env)
        for needle in ("roles:", "hooks:", "brain gates:", "pre-push gate:", "pre-commit gate", "reviewer.md", "doctor: all good"):
            self.assertIn(needle, r.stdout)
        self.assertNotIn("FIX", r.stdout)

    def test_missing_role_is_reported_with_a_fix(self):
        (self.proj / ".harness" / "roles" / "reviewer.md").unlink()
        r = h(self.proj, "doctor", check=False, env=self.env)
        self.assertEqual(r.returncode, 1)
        self.assertIn("FIX   roles/reviewer.md is missing", r.stdout)
        self.assertIn("fix: agent-brain-harness init", r.stdout)

    def test_old_lead_card_without_verify_step(self):
        lead = self.proj / ".harness" / "roles" / "lead.md"
        lead.write_text(lead.read_text(encoding="utf-8").replace("Reviewed by", "Checked by"), encoding="utf-8")
        r = h(self.proj, "doctor", check=False, env=self.env)
        self.assertEqual(r.returncode, 1)
        self.assertIn("no verify step", r.stdout)

    @unittest.skipUnless(GIT, "git is needed")
    def test_missing_commit_gate_and_installed_push_gate(self):
        pc = self.proj / ".git" / "hooks" / "pre-commit"
        pc.unlink()
        r = h(self.proj, "doctor", check=False, env=self.env)
        self.assertEqual(r.returncode, 1)
        self.assertIn("pre-commit gate is not installed", r.stdout)
        h(self.proj, "init", str(self.proj), env=self.env)
        h(self.proj, "gate", "install", env=self.env)
        r = h(self.proj, "doctor", env=self.env)
        self.assertIn("ok    installed:", r.stdout)

    def test_bad_default_app(self):
        cfg = self.proj / ".harness" / "harness.json"
        data = json.loads(cfg.read_text(encoding="utf-8"))
        data["default_app"] = "nope"
        cfg.write_text(json.dumps(data), encoding="utf-8")
        r = h(self.proj, "doctor", check=False, env=self.env)
        self.assertEqual(r.returncode, 1)
        self.assertIn("default_app 'nope'", r.stdout)

    def test_outside_a_workspace_still_runs(self):
        r = h(self.home, "doctor", env=self.env)
        self.assertIn("no workspace here", r.stdout)


class EvalGateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.proj = Path(self.tmp.name)
        h(self.proj, "eval-init")
        self.gate = self.proj / "evals" / "eval_gate.py"
        (self.proj / "prompts").mkdir()
        self.prompt = self.proj / "prompts" / "summarize.md"
        self.prompt.write_text("Summarize.\n", encoding="utf-8")
        self.model = self.proj / "model.py"
        self.model.write_text("import sys\nprint(sys.stdin.read())\n", encoding="utf-8")
        self.cfg = {"model_cmd": '"%s" model.py' % sys.executable, "daily_call_cap": 50, "min_score": 0.0}
        self.write_cfg()
        # the example cases include a judge rule; this test has no judge, so use code checks only
        (self.proj / "evals" / "summarizer" / "cases.jsonl").write_text(
            json.dumps({"id": "echo", "prompt": "total $1,240", "checks": [{"type": "contains", "value": "1,240"}]}) + "\n",
            encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def write_cfg(self):
        (self.proj / "evals" / "config.json").write_text(json.dumps(self.cfg), encoding="utf-8")

    def py(self, *args):
        return run([sys.executable, str(self.gate)] + list(args), self.proj, check=False)

    def test_kit_copied_and_never_overwritten(self):
        self.assertTrue((self.proj / "evals" / "paths.json").is_file())
        (self.proj / "evals" / "paths.json").write_text("mine", encoding="utf-8")
        h(self.proj, "eval-init")
        self.assertEqual((self.proj / "evals" / "paths.json").read_text(encoding="utf-8"), "mine")

    def test_red_until_run_then_green_then_red_after_a_change(self):
        r = self.py("check")
        self.assertEqual(r.returncode, 1)
        self.assertIn("never run", r.stdout)
        r = self.py("run", "summarizer")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("1/1 passed", r.stdout)
        self.assertEqual(self.py("check").returncode, 0)
        self.prompt.write_text("Summarize in two lines.\n", encoding="utf-8")
        r = self.py("check")
        self.assertEqual(r.returncode, 1)
        self.assertIn("changed since the last run", r.stdout)

    def test_score_zero_is_red(self):
        (self.proj / "evals" / "summarizer" / "cases.jsonl").write_text(
            json.dumps({"id": "bad", "prompt": "x", "checks": [{"type": "contains", "value": "never-there"}]}) + "\n",
            encoding="utf-8")
        self.py("run", "summarizer")
        r = self.py("check")
        self.assertEqual(r.returncode, 1)
        self.assertIn("below the bar", r.stdout)

    def test_spend_cap_stops_the_run(self):
        self.cfg["daily_call_cap"] = 0
        self.write_cfg()
        self.py("run", "summarizer")
        res = json.loads((self.proj / "evals" / "results" / "summarizer.json").read_text(encoding="utf-8"))
        self.assertEqual(res["score"], 0)
        self.assertIn("call cap", res["failures"][0]["why"])

    def test_pre_push_runs_the_eval_gate(self):
        if not GIT:
            self.skipTest("git is needed")
        run(["git", "init", "-q"], self.proj)
        h(self.proj, "gate", "install")
        run(["git", "add", "-A"], self.proj)
        run(["git", "commit", "-qm", "start"], self.proj)
        remote = Path(self.tmp.name).parent / (Path(self.tmp.name).name + "-remote.git")
        try:
            run(["git", "init", "-q", "--bare", str(remote)], self.proj)
            run(["git", "remote", "add", "origin", str(remote)], self.proj)
            r = run(["git", "push", "-q", "origin", "HEAD:main"], self.proj, check=False)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("eval gate is red", r.stderr)
            self.py("run", "summarizer")
            run(["git", "add", "-A"], self.proj)
            run(["git", "commit", "-qm", "eval result"], self.proj)
            r = run(["git", "push", "-q", "origin", "HEAD:main"], self.proj, check=False)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        finally:
            shutil.rmtree(str(remote), ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
