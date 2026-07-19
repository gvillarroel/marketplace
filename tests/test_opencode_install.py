import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "scripts" / "install-opencode.py"


class OpenCodeInstallTests(unittest.TestCase):
    def test_generates_native_layout_and_preserves_copilot_sources(self):
        copilot_source = ROOT / "plugins" / "agent-foundry" / "skills" / "bench" / "SKILL.md"
        before = copilot_source.read_bytes()
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "opencode"
            subprocess.run([sys.executable, str(INSTALLER), str(target)], check=True)
            self.assertTrue((target / "commands" / "bench.md").is_file())
            self.assertTrue((target / "skills" / "harbor-roster" / "SKILL.md").is_file())
            self.assertTrue((target / "agents" / "team-lead.md").is_file())
            self.assertTrue((target / "agent-foundry" / "bench" / "scout.md").is_file())
            command = (target / "commands" / "bench.md").read_text(encoding="utf-8")
            roster = (target / "skills" / "harbor-roster" / "SKILL.md").read_text(encoding="utf-8")
            agent = (target / "agents" / "team-lead.md").read_text(encoding="utf-8")
            self.assertIn("$ARGUMENTS", command)
            self.assertIn(".opencode/agents/", roster)
            self.assertIn("OPENCODE_CONFIG_DIR", roster)
            self.assertNotIn(".copilot", roster)
            self.assertNotIn(".agent.md", roster)
            self.assertIn("permission:", roster)
            self.assertIn("../../agent-foundry/bench/<id>.md", roster)
            self.assertIn("mode: subagent", agent)
            self.assertIn("  task: allow", agent)
        self.assertEqual(before, copilot_source.read_bytes())

    def test_refuses_unmanaged_content_without_force(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            (target / "skills").mkdir()
            (target / "skills" / "mine.txt").write_text("keep", encoding="utf-8")
            result = subprocess.run([sys.executable, str(INSTALLER), str(target)], capture_output=True, text=True)
            self.assertNotEqual(0, result.returncode)
            self.assertEqual("keep", (target / "skills" / "mine.txt").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
