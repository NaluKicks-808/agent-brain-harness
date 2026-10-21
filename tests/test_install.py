import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INSTALL = str(ROOT / "install.py")


def snapshot(home):
    out = {}
    for d, _dirs, files in os.walk(str(home)):
        for f in files:
            p = Path(d) / f
            out[str(p.relative_to(home))] = p.read_bytes()
    return out


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir()
        self.env = dict(os.environ, HOME=str(self.home), USERPROFILE=str(self.home), SHELL="/bin/zsh",
                        PYTHONDONTWRITEBYTECODE="1", NO_COLOR="1")
        self.bin = self.home / "bin"
        self.brain = self.home / "brain"

    def tearDown(self):
        self.tmp.cleanup()

    def run_install(self, *args):
        base = [sys.executable, INSTALL, "--yes", "--dir", str(self.brain), "--bin", str(self.bin), "--no-path"]
        r = subprocess.run(base + list(args), capture_output=True, text=True, encoding="utf-8", env=self.env,
                           stdin=subprocess.DEVNULL)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return r.stdout

    def run_uninstall(self, *args):
        r = subprocess.run([sys.executable, INSTALL, "--uninstall", "--yes"] + list(args), capture_output=True,
                           text=True, encoding="utf-8", env=self.env, stdin=subprocess.DEVNULL)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return r.stdout

    def test_install_rerun_dryrun_uninstall(self):
        before = snapshot(self.home)
        out = self.run_install("--dry-run", "--claude-hook")
        self.assertIn("would", out)
        self.assertEqual(snapshot(self.home), before, "dry run changed files")

        out = self.run_install("--claude-hook")
        self.assertIn("You're set. Next 3 things:", out)
        app = self.home / ".agent-brain-harness"
        self.assertTrue((app / "app" / "harness.py").is_file())
        self.assertTrue((app / "manifest.json").is_file())
        self.assertTrue((self.brain / ".harness" / "harness.json").is_file())
        self.assertTrue((self.bin / ("agent-brain-harness" + (".cmd" if os.name == "nt" else ""))).is_file())
        settings = json.loads((self.brain / ".claude" / "settings.json").read_text(encoding="utf-8"))
        self.assertIn("role_card_hook.py", json.dumps(settings))
        installed = snapshot(self.home)

        out = self.run_install("--claude-hook")
        self.assertIn("Nothing to do", out)
        self.assertEqual(snapshot(self.home), installed, "rerun changed files")

        out = self.run_install("--dry-run", "--claude-hook")
        self.assertEqual(snapshot(self.home), installed, "dry run on installed home changed files")

        out = self.run_uninstall("--dry-run")
        self.assertEqual(snapshot(self.home), installed, "uninstall dry run changed files")

        self.run_uninstall()
        self.assertFalse((app / "manifest.json").exists())
        self.assertFalse((app / "app").exists())
        self.assertFalse(list(self.bin.glob("*")) if self.bin.exists() else False)
        self.assertTrue((self.brain / "wiki").is_dir(), "the brain must be kept")
        self.assertFalse((self.brain / ".claude" / "settings.json").exists())
        self.assertIn("Nothing to uninstall", self.run_uninstall())

    def test_settings_merge_keeps_other_keys_and_backs_up(self):
        (self.brain / ".claude").mkdir(parents=True)
        mine = {"model": "x", "hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "echo hi"}]}],
                                         "Stop": [{"hooks": [{"type": "command", "command": "echo bye"}]}]}}
        sp = self.brain / ".claude" / "settings.json"
        sp.write_text(json.dumps(mine), encoding="utf-8")
        self.run_install("--claude-hook")
        merged = json.loads(sp.read_text(encoding="utf-8"))
        self.assertEqual(merged["model"], "x")
        self.assertEqual(merged["hooks"]["Stop"], mine["hooks"]["Stop"])
        self.assertEqual(len(merged["hooks"]["SessionStart"]), 2)
        baks = list((self.brain / ".claude").glob("settings.json.bak-*"))
        self.assertEqual(len(baks), 1)
        self.assertEqual(json.loads(baks[0].read_text(encoding="utf-8")), mine)
        self.run_uninstall()
        self.assertEqual(json.loads(sp.read_text(encoding="utf-8")), mine)

    def test_bad_settings_json_is_left_alone(self):
        (self.brain / ".claude").mkdir(parents=True)
        sp = self.brain / ".claude" / "settings.json"
        sp.write_text("{bad", encoding="utf-8")
        r = subprocess.run([sys.executable, INSTALL, "--yes", "--dir", str(self.brain), "--bin", str(self.bin),
                            "--no-path", "--claude-hook"], capture_output=True, text=True, encoding="utf-8",
                           env=self.env, stdin=subprocess.DEVNULL)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(sp.read_text(encoding="utf-8"), "{bad")

    @unittest.skipIf(os.name == "nt", "shell rc PATH block is POSIX only; the Windows registry path is not run in tests")
    def test_path_block_added_and_removed(self):
        rc = self.home / ".zshrc"
        rc.write_text("export FOO=1\n", encoding="utf-8")
        r = subprocess.run([sys.executable, INSTALL, "--yes", "--dir", str(self.brain), "--bin", str(self.bin)],
                           capture_output=True, text=True, encoding="utf-8", env=dict(self.env, PATH="/usr/bin:/bin"),
                           stdin=subprocess.DEVNULL)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("agent-brain-harness >>>", rc.read_text(encoding="utf-8"))
        self.run_uninstall()
        self.assertEqual(rc.read_text(encoding="utf-8"), "export FOO=1\n")

    def test_typed_confirmation_is_required_to_delete_the_brain(self):
        self.run_install()
        self.run_uninstall()  # --yes: never deletes
        self.assertTrue(self.brain.is_dir())


if __name__ == "__main__":
    unittest.main()
