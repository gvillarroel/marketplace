import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "scripts" / "install-pi.py"


class PiInstallTests(unittest.TestCase):
    def test_generates_pi_resources_without_changing_copilot(self):
        source = ROOT / "plugins" / "agent-foundry" / "skills" / "contract" / "SKILL.md"
        before = source.read_bytes()
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "pi"
            subprocess.run([sys.executable, str(INSTALLER), str(target)], check=True)
            self.assertTrue((target / "prompts" / "contract.md").is_file())
            self.assertTrue((target / "skills" / "contract" / "SKILL.md").is_file())
            self.assertTrue((target / "agents" / "team-lead.md").is_file())
            self.assertTrue((target / "agent-foundry" / "bench" / "guard.md").is_file())
            contract = (target / "skills" / "contract" / "SKILL.md").read_text(encoding="utf-8")
            roster = (target / "skills" / "harbor-roster" / "SKILL.md").read_text(encoding="utf-8")
            prompt = (target / "prompts" / "contract.md").read_text(encoding="utf-8")
            bench_prompt = (target / "prompts" / "bench.md").read_text(encoding="utf-8")
            guard = (target / "agent-foundry" / "bench" / "guard.md").read_text(encoding="utf-8")
            self.assertIn("pi --no-session -p", contract)
            self.assertIn("PI_CODING_AGENT_DIR", roster)
            self.assertIn(".pi/agents/", roster)
            self.assertIn("../../agent-foundry/bench/<id>.md", roster)
            self.assertIn("$ARGUMENTS", prompt)
            self.assertIn("Embedded internal contract", bench_prompt)
            self.assertNotIn("Load the `contract` skill", prompt)
            self.assertIn("  owner: agent-foundry", guard)
            self.assertIn("tools: bash,grep,read", guard)
        self.assertEqual(before, source.read_bytes())

    def test_refuses_unmanaged_resources(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            (target / "prompts").mkdir()
            (target / "prompts" / "mine.md").write_text("keep", encoding="utf-8")
            result = subprocess.run([sys.executable, str(INSTALLER), str(target)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((target / "prompts" / "mine.md").read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
