import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
PLUGINS = ROOT / "plugins"
RUNTIME = ROOT / "runtime"
PUBLIC = {"bench", "join", "retire", "contract", "list-skills"}
AGENTS = {"team-lead", "repo-cartographer", "crafter"}
BUNDLED = {"scout", "sage", "smith", "probe", "guard", "pilot"}
COMMAND_MARKERS = {
    "bench": ("$ARGUMENTS", "Operation: bench", "Embedded bundled profiles"),
    "join": ("$ARGUMENTS", "Operation: join", "harbor-trusted-skill-sources"),
    "retire": ("$ARGUMENTS", "Operation: retire"),
    "contract": ("$ARGUMENTS", "Run a one-shot player"),
    "list-skills": ("$ARGUMENTS", "harbor-trusted-skill-sources"),
}


def run_installer(name: str, target: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return subprocess.run(
        [sys.executable, str(SCRIPTS / f"install-{name}.py"), str(target), *extra],
        cwd=ROOT,
        capture_output=True,
        text=True,
        env=env,
    )


def frontmatter(path: Path) -> tuple[dict[str, str], str]:
    document = path.read_text(encoding="utf-8")
    match = re.match(r"\A---\r?\n(.*?)\r?\n---\r?\n(.*)\Z", document, re.S)
    if not match:
        raise AssertionError(f"Missing frontmatter: {path}")
    values = {}
    for line in match.group(1).splitlines():
        if ":" in line and not line.startswith((" ", "\t")):
            key, value = line.split(":", 1)
            values[key.strip()] = value.strip()
    return values, match.group(2)


def digest_tree(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def load_opencode_plugin(target: Path) -> dict:
    source = (target / "index.js").read_text(encoding="utf-8")
    decoder = json.JSONDecoder()
    commands, _ = decoder.raw_decode(source, source.index("{") )
    agent_start = source.index("const agents = ") + len("const agents = ")
    agents, _ = decoder.raw_decode(source, agent_start)
    return {"command": commands, "agent": agents}


class CompatibilityTests(unittest.TestCase):
    maxDiff = None

    def test_copilot_sources_and_manifests(self):
        manifests = [json.loads(path.read_text(encoding="utf-8")) for path in PLUGINS.glob("*/plugin.json")]
        self.assertEqual({item["name"] for item in manifests}, {"agent-foundry", "repo-cartographer"})
        for item in manifests:
            self.assertRegex(item["version"], r"^\d+\.\d+\.\d+$")
            self.assertEqual(item["agents"], "agents/")
            self.assertEqual(item["skills"], "skills/")

        skills = list(PLUGINS.glob("*/skills/*/SKILL.md"))
        self.assertEqual({path.parent.name for path in skills}, PUBLIC | {"harbor-roster", "harbor-trusted-skill-sources", "harbor-repository-map"})
        for path in skills:
            values, _ = frontmatter(path)
            self.assertEqual(values["name"], path.parent.name)
            self.assertTrue(values["description"])

        agents = list(PLUGINS.glob("*/agents/*.agent.md"))
        self.assertEqual({frontmatter(path)[0]["name"] for path in agents}, AGENTS)
        bench = list((PLUGINS / "agent-foundry" / "bench").glob("*.agent.md"))
        self.assertEqual({frontmatter(path)[0]["name"] for path in bench}, BUNDLED)

    def test_repository_package_and_generated_runtime_are_current(self):
        manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["name"], "@gvillarroel/agent-harbor")
        self.assertEqual(manifest["main"], "./runtime/opencode/index.js")
        self.assertNotIn("skills", manifest["pi"])
        self.assertEqual(manifest["pi"]["prompts"], ["./runtime/pi/prompts", "./runtime/pi/agents"])
        with tempfile.TemporaryDirectory() as directory:
            for runtime in ("opencode", "pi"):
                generated = Path(directory) / runtime
                result = run_installer(runtime, generated)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(digest_tree(generated), digest_tree(RUNTIME / runtime), runtime)

    def test_every_command_has_complete_cross_runtime_contract(self):
        opencode = load_opencode_plugin(RUNTIME / "opencode")["command"]
        for name, markers in COMMAND_MARKERS.items():
            canonical_values, canonical_body = frontmatter(
                PLUGINS / "agent-foundry" / "skills" / name / "SKILL.md"
            )
            pi_values, pi_body = frontmatter(RUNTIME / "pi" / "prompts" / f"{name}.md")
            self.assertEqual(canonical_values["name"], name)
            self.assertEqual(canonical_values["user-invocable"], "true")
            self.assertEqual(pi_values.get("argument-hint"), canonical_values.get("argument-hint"), name)
            self.assertIn(name, opencode)
            for marker in markers:
                self.assertIn(marker, canonical_body if marker == "$ARGUMENTS" else opencode[name]["template"], name)
                self.assertIn(marker, pi_body, name)

    def test_opencode_bundle_contract_and_real_discovery(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "opencode"
            result = run_installer("opencode", target)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual({p.name for p in target.iterdir()}, {"index.js", "package.json"})
            manifest = json.loads((target / "package.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["name"], "agent-harbor-opencode")
            self.assertEqual(manifest["main"], "./index.js")
            config = load_opencode_plugin(target)
            self.assertEqual(set(config["command"]), PUBLIC)
            self.assertEqual(set(config["agent"]), AGENTS)
            for name, command in config["command"].items():
                self.assertTrue(command["description"], name)
                self.assertNotRegex(command["template"], r"COPILOT_HOME|\.github/agents|\.agent\.md")
            bench = config["command"]["bench"]["template"]
            self.assertIn("OPENCODE_CONFIG_DIR", bench)
            self.assertIn("Embedded bundled profiles", bench)
            self.assertNotIn("../../agent-foundry/bench/<id>.md", bench)
            for name in BUNDLED:
                self.assertIn(f"### {name}", bench)
                self.assertIn(f"name: {name}", bench)
                self.assertIn(f"player: {name}", bench)
            self.assertIn("harbor-trusted-skill-sources owner=agent-foundry revision=3", config["command"]["join"]["template"])
            self.assertIn("Operation: retire", config["command"]["retire"]["template"])
            self.assertIn("task", config["command"]["contract"]["template"])
            self.assertIn("harbor-trusted-skill-sources", config["command"]["list-skills"]["template"])

            executable = shutil.which("opencode")
            if executable:
                installed = subprocess.run(
                    [executable, "plugin", f"file:{ROOT}"],
                    cwd=directory,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(installed.returncode, 0, installed.stderr)
                discovered = subprocess.run(
                    [executable, "debug", "config"], cwd=directory, capture_output=True, text=True
                )
                self.assertEqual(discovered.returncode, 0, discovered.stderr)
                config = json.loads(discovered.stdout)
                self.assertTrue(PUBLIC <= set(config["command"]))
                self.assertTrue(AGENTS <= set(config["agent"]))

    def test_pi_bundle_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "pi"
            result = run_installer("pi", target)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual({p.stem for p in (target / "prompts").glob("*.md")}, PUBLIC)
            self.assertEqual({p.stem for p in (target / "agents").glob("*.md")}, AGENTS)
            self.assertEqual({p.name for p in target.iterdir()}, {"agents", "prompts", "package.json"})
            manifest = json.loads((target / "package.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["name"], "agent-harbor-pi")
            self.assertIn("pi-package", manifest["keywords"])
            self.assertEqual(manifest["pi"]["prompts"], ["./prompts", "./agents"])

            bench = (target / "prompts" / "bench.md").read_text(encoding="utf-8")
            contract = (target / "prompts" / "contract.md").read_text(encoding="utf-8")
            join = (target / "prompts" / "join.md").read_text(encoding="utf-8")
            cartographer = (target / "agents" / "repo-cartographer.md").read_text(encoding="utf-8")
            self.assertIn("PI_CODING_AGENT_DIR", bench)
            self.assertIn("Embedded bundled profiles", bench)
            self.assertNotIn("../../agent-foundry/bench/<id>.md", bench)
            for name in BUNDLED:
                self.assertIn(f"### {name}", bench)
                self.assertIn(f"name: {name}", bench)
                self.assertIn(f"player: {name}", bench)
            self.assertIn("Embedded internal contract", bench)
            self.assertIn("Embedded internal contract", cartographer)
            self.assertIn("pi --no-session -p", contract)
            self.assertNotIn("native `skill` tool", join)
            self.assertIn("harbor-trusted-skill-sources owner=agent-foundry revision=3", join)
            for path in (target / "prompts").glob("*.md"):
                body = path.read_text(encoding="utf-8")
                self.assertNotRegex(body, r"COPILOT_HOME|\.github/agents|\.agent\.md")
            for path in (target / "agents").glob("*.md"):
                values, _ = frontmatter(path)
                self.assertIn("tools", values)

            executable = shutil.which("pi")
            if executable:
                version = subprocess.run([executable, "--version"], capture_output=True, text=True)
                self.assertEqual(version.returncode, 0, version.stderr)
                env = os.environ.copy()
                env["PI_CODING_AGENT_DIR"] = str(Path(directory) / "pi-home")
                installed = subprocess.run(
                    [executable, "install", str(ROOT)], cwd=directory, env=env, capture_output=True, text=True
                )
                self.assertEqual(installed.returncode, 0, installed.stderr)
                listed = subprocess.run([executable, "list"], cwd=ROOT, env=env, capture_output=True, text=True)
                self.assertEqual(listed.returncode, 0, listed.stderr)
                self.assertIn(str(ROOT.resolve()), listed.stdout)

    def test_installers_are_idempotent_and_preserve_copilot(self):
        before = digest_tree(PLUGINS)
        with tempfile.TemporaryDirectory() as directory:
            for runtime in ("opencode", "pi"):
                target = Path(directory) / runtime
                first = run_installer(runtime, target)
                self.assertEqual(first.returncode, 0, first.stderr)
                first_digest = digest_tree(target)
                second = run_installer(runtime, target)
                self.assertEqual(second.returncode, 0, second.stderr)
                self.assertEqual(first_digest, digest_tree(target), runtime)
        self.assertEqual(before, digest_tree(PLUGINS))

    def test_installers_refuse_unmanaged_content(self):
        with tempfile.TemporaryDirectory() as directory:
            for runtime, folder in (("opencode", "skills"), ("pi", "prompts")):
                target = Path(directory) / runtime
                unmanaged = target / folder / "mine.txt"
                unmanaged.parent.mkdir(parents=True)
                unmanaged.write_text("keep", encoding="utf-8")
                result = run_installer(runtime, target)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(unmanaged.read_text(encoding="utf-8"), "keep")

    @unittest.skipUnless(shutil.which("copilot"), "Copilot CLI is not installed")
    def test_copilot_cli_discovers_local_plugins(self):
        result = subprocess.run(
            [
                shutil.which("copilot"),
                "--plugin-dir", str(PLUGINS / "agent-foundry"),
                "--plugin-dir", str(PLUGINS / "repo-cartographer"),
                "plugin", "list",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("agent-foundry", result.stdout)
        self.assertIn("repo-cartographer", result.stdout)


if __name__ == "__main__":
    unittest.main()
