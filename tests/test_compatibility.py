import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
PLUGINS = ROOT / "plugins"
RUNTIME = ROOT / "runtime"
PUBLIC = {"bench", "join", "retire", "contract", "list-skills", "manager"}
AGENTS = {"scouts", "repo-cartographer", "crafter"}
BUNDLED = {"scout", "sage", "smith", "probe", "guard", "pilot"}


def env_truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


REQUIRE_CLIS = env_truthy("AGENT_HARBOR_REQUIRE_CLIS")


def find_cli(name: str) -> str | None:
    executable = shutil.which(name)
    if executable is None and REQUIRE_CLIS:
        raise AssertionError(
            f"Required {name!r} CLI is missing while AGENT_HARBOR_REQUIRE_CLIS is enabled"
        )
    return executable


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


def load_opencode_agents(target: Path) -> dict:
    source = (target / "server.js").read_text(encoding="utf-8")
    decoder = json.JSONDecoder()
    start = source.index("const agents = ") + len("const agents = ")
    agents, _ = decoder.raw_decode(source, start)
    return agents


def read_logs(root: Path) -> str:
    return "\n".join(
        path.read_text(encoding="utf-8", errors="replace")
        for path in sorted(root.rglob("*.log"))
    )


def probe_copilot_extension(executable: str, log_dir: Path) -> str:
    """Load the local extension in a real terminal without submitting a prompt."""
    copilot_home = log_dir / "copilot-home"
    copilot_home.mkdir()
    (copilot_home / "config.json").write_text(
        json.dumps({"trustedFolders": [str(ROOT)]}),
        encoding="utf-8",
    )
    probe_env = os.environ.copy()
    probe_env["COPILOT_HOME"] = str(copilot_home)
    arguments = [
        executable,
        "--experimental",
        "--no-remote",
        "--no-auto-update",
        "--log-level",
        "debug",
        "--log-dir",
        str(log_dir),
        "--allow-tool=extension-permission-access(plugin:agent-foundry:agent-foundry)",
        "--plugin-dir",
        str(PLUGINS / "agent-foundry"),
    ]

    if os.name == "nt":
        try:
            from winpty import PtyProcess
        except ImportError as error:
            raise unittest.SkipTest(
                "The opt-in Windows Copilot extension probe needs pywinpty "
                "(run it with `uv run --with pywinpty python -m unittest ...`)"
            ) from error

        process = PtyProcess.spawn(arguments, cwd=str(ROOT), env=probe_env, dimensions=(32, 140))
        drain = lambda: None
        send_input = process.write
        is_alive = process.isalive

        def stop() -> None:
            process.close(force=process.isalive())
            # pywinpty closes its reader-side socket in a daemon thread. Join
            # that thread so the probe exits without leaking socket handles.
            process._thread.join(timeout=2)
            process.fileobj.close()
            process._server.close()

    else:
        import pty

        master, slave = pty.openpty()
        process = subprocess.Popen(
            arguments,
            cwd=ROOT,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            close_fds=True,
            env=probe_env,
        )
        os.close(slave)
        os.set_blocking(master, False)

        def drain() -> None:
            try:
                while os.read(master, 65536):
                    pass
            except (BlockingIOError, OSError):
                pass

        send_input = lambda value: os.write(master, value.encode())
        is_alive = lambda: process.poll() is None

        def stop() -> None:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            os.close(master)

    try:
        deadline = time.monotonic() + 35
        body = ""
        while is_alive() and time.monotonic() < deadline:
            drain()
            body = read_logs(log_dir)
            if "Extension ready:" in body:
                break
            time.sleep(0.1)
        if "Extension ready:" not in body:
            raise AssertionError(f"Copilot extension did not become ready. Logs:\n{body[-4000:]}")

        slash_events = body.count("slash_command_used")
        send_input("/bench list\r")
        deadline = time.monotonic() + 10
        while is_alive() and time.monotonic() < deadline:
            drain()
            body = read_logs(log_dir)
            if body.count("slash_command_used") > slash_events:
                break
            time.sleep(0.1)
        if body.count("slash_command_used") <= slash_events:
            raise AssertionError(f"Copilot did not execute /bench list. Logs:\n{body[-4000:]}")

        send_input("/exit\r")
        deadline = time.monotonic() + 10
        while is_alive() and time.monotonic() < deadline:
            drain()
            time.sleep(0.1)
        return read_logs(log_dir)
    finally:
        stop()


class CompatibilityTests(unittest.TestCase):
    maxDiff = None

    def test_copilot_sources_use_extension_commands_not_public_skills(self):
        foundry = json.loads((PLUGINS / "agent-foundry" / "plugin.json").read_text(encoding="utf-8"))
        cartographer = json.loads((PLUGINS / "repo-cartographer" / "plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(foundry["extensions"], "extensions/")
        self.assertNotIn("commands", foundry)
        self.assertNotIn("skills", foundry)
        self.assertEqual(cartographer["skills"], "skills/")

        self.assertTrue((PLUGINS / "agent-foundry" / "extensions" / "agent-foundry" / "extension.mjs").is_file())
        self.assertTrue((PLUGINS / "agent-foundry" / "runtime" / "commands.mjs").is_file())
        extension = (PLUGINS / "agent-foundry" / "extensions" / "agent-foundry" / "extension.mjs").read_text(
            encoding="utf-8"
        )
        for tool in ("harbor_list_skills", "harbor_contract", "harbor_join"):
            self.assertRegex(
                extension,
                rf'(?s)defineTool\("{tool}".*?skipPermission: true',
                f"{tool} must keep its explicit, extension-scoped permission bypass",
            )
        public_skills = {
            path.parent.name
            for path in (PLUGINS / "agent-foundry" / "skills").glob("*/SKILL.md")
        }
        self.assertTrue(PUBLIC.isdisjoint(public_skills))

        agents = list(PLUGINS.glob("*/agents/*.agent.md"))
        self.assertEqual({frontmatter(path)[0]["name"] for path in agents}, AGENTS)
        bench = list((PLUGINS / "agent-foundry" / "bench").glob("*.agent.md"))
        self.assertEqual({frontmatter(path)[0]["name"] for path in bench}, BUNDLED)

    def test_repository_package_and_generated_runtime_are_current(self):
        manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["name"], "@gvillarroel/agent-harbor")
        self.assertEqual(manifest["main"], "./runtime/opencode/server.js")
        self.assertEqual(manifest["exports"]["./tui"], "./runtime/opencode/tui.js")
        self.assertEqual(manifest["bin"]["agent-harbor"], "./runtime/opencode/cli.mjs")
        self.assertEqual(manifest["pi"]["extensions"], ["./runtime/pi/extensions"])
        self.assertEqual(manifest["pi"]["prompts"], ["./runtime/pi/agents"])

        with tempfile.TemporaryDirectory() as directory:
            for runtime in ("opencode", "pi"):
                generated = Path(directory) / runtime
                result = run_installer(runtime, generated)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(digest_tree(generated), digest_tree(RUNTIME / runtime), runtime)

    def test_shared_core_has_no_model_sdk_and_adapters_register_all_commands(self):
        core = (PLUGINS / "agent-foundry" / "runtime" / "commands.mjs").read_text(encoding="utf-8")
        self.assertNotRegex(core, r"@github/copilot-sdk|@opencode-ai|pi-coding-agent")
        self.assertIn("executeHarborCommand", core)
        self.assertIn("COMMAND_DEFINITIONS", core)

        copilot = (PLUGINS / "agent-foundry" / "extensions" / "agent-foundry" / "extension.mjs").read_text(encoding="utf-8")
        opencode = (PLUGINS / "agent-foundry" / "runtime" / "opencode-tui.mjs").read_text(encoding="utf-8")
        pi = (PLUGINS / "agent-foundry" / "runtime" / "pi-extension.mjs").read_text(encoding="utf-8")
        self.assertIn("joinSession", copilot)
        self.assertIn("registerLayer", opencode)
        self.assertIn("registerCommand", pi)
        for source in (copilot, opencode, pi):
            self.assertIn("executeHarborCommand", source)

    def test_opencode_package_uses_tui_handlers_and_no_prompt_commands(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "opencode"
            result = run_installer("opencode", target)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                {p.name for p in target.iterdir()},
                {"bench", "cli.mjs", "commands.mjs", "opencode-manager-run.mjs", "opencode-server.mjs", "package.json", "server.js", "tui.js"}
                | ({"trusted-sources.json"} if (target / "trusted-sources.json").exists() else set()),
            )
            manifest = json.loads((target / "package.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["exports"], {"./server": "./server.js", "./tui": "./tui.js"})
            self.assertEqual(manifest["engines"]["opencode"], ">=1.18.3")
            agents = load_opencode_agents(target)
            self.assertEqual(set(agents), AGENTS)
            self.assertTrue(all(agent["permission"].get("*") == "deny" for agent in agents.values()))
            self.assertNotIn("config.command", (target / "server.js").read_text(encoding="utf-8"))
            self.assertEqual((target / "commands.mjs").read_bytes(), (PLUGINS / "agent-foundry" / "runtime" / "commands.mjs").read_bytes())
            self.assertEqual((target / "opencode-manager-run.mjs").read_bytes(), (PLUGINS / "agent-foundry" / "runtime" / "opencode-manager-run.mjs").read_bytes())
            self.assertEqual({p.stem.removesuffix(".agent") for p in (target / "bench").glob("*.agent.md")}, BUNDLED)

            executable = find_cli("opencode")
            if executable:
                installed = subprocess.run(
                    [executable, "plugin", f"file:{ROOT}"],
                    cwd=directory,
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                self.assertEqual(installed.returncode, 0, installed.stderr)
                discovered = subprocess.run(
                    [executable, "debug", "config"], cwd=directory, capture_output=True, text=True, timeout=60
                )
                self.assertEqual(discovered.returncode, 0, discovered.stderr)
                config = json.loads(discovered.stdout)
                self.assertTrue(AGENTS <= set(config["agent"]))
                self.assertIn("agent-harbor-manager", config["agent"])
                self.assertTrue(PUBLIC.isdisjoint(set(config.get("command", {}))))

                scouts = subprocess.run(
                    [executable, "debug", "agent", "scouts"],
                    cwd=directory, capture_output=True, text=True, timeout=60,
                )
                self.assertEqual(scouts.returncode, 0, scouts.stderr)
                scout_tools = json.loads(scouts.stdout)["tools"]
                for allowed in ("harbor_list_skills", "harbor_contract", "harbor_join"):
                    self.assertTrue(scout_tools[allowed], allowed)
                for denied in ("bash", "edit", "read", "task"):
                    self.assertFalse(scout_tools.get(denied, False), denied)

                node = shutil.which("node")
                self.assertIsNotNone(node)
                env = os.environ.copy()
                env["OPENCODE_CONFIG_DIR"] = str(Path(directory) / "opencode-home")
                definition = json.dumps({
                    "name": "read-only-reviewer",
                    "description": "Read-only reviewer",
                    "prompt": "Review only.",
                    "tools": ["read", "search"],
                    "skills": [],
                })
                joined = subprocess.run(
                    [node, str(RUNTIME / "opencode" / "cli.mjs"), "--runtime", "opencode", "join", definition],
                    cwd=directory, env=env, capture_output=True, text=True, timeout=30,
                )
                self.assertEqual(joined.returncode, 0, joined.stderr)
                inspected = subprocess.run(
                    [executable, "debug", "agent", "read-only-reviewer", "--pure"],
                    cwd=directory, env=env, capture_output=True, text=True, timeout=60,
                )
                self.assertEqual(inspected.returncode, 0, inspected.stderr)
                tools = json.loads(inspected.stdout)["tools"]
                self.assertTrue(tools["read"])
                self.assertTrue(tools["grep"])
                for denied in ("bash", "glob", "task", "webfetch", "todowrite", "skill", "apply_patch"):
                    self.assertFalse(tools[denied], denied)

    def test_pi_package_uses_extension_handlers_and_no_command_prompts(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "pi"
            result = run_installer("pi", target)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((target / "prompts").exists())
            self.assertEqual({p.stem for p in (target / "agents").glob("*.md")}, AGENTS)
            self.assertTrue((target / "extensions" / "agent-harbor.js").is_file())
            manifest = json.loads((target / "package.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["pi"]["extensions"], ["./extensions"])
            self.assertEqual(manifest["pi"]["prompts"], ["./agents"])
            self.assertEqual(manifest["bin"]["agent-harbor"], "./cli.mjs")
            for path in (target / "agents").glob("*.md"):
                values, _ = frontmatter(path)
                self.assertIn("tools", values)
                self.assertIn("$ARGUMENTS", path.read_text(encoding="utf-8"))

            executable = find_cli("pi")
            if executable:
                env = os.environ.copy()
                env["PI_CODING_AGENT_DIR"] = str(Path(directory) / "pi-home")
                installed = subprocess.run(
                    [executable, "install", str(ROOT)], cwd=directory, env=env, capture_output=True, text=True, timeout=60
                )
                self.assertEqual(installed.returncode, 0, installed.stderr)
                listed = subprocess.run([executable, "list"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)
                self.assertEqual(listed.returncode, 0, listed.stderr)
                self.assertIn(str(ROOT.resolve()), listed.stdout)

                node = shutil.which("node")
                self.assertIsNotNone(node)
                definition = json.dumps({
                    "name": "rpc-reviewer",
                    "description": "RPC reviewer",
                    "prompt": "Review only.",
                    "tools": ["read", "search"],
                    "skills": [],
                })
                joined = subprocess.run(
                    [node, str(RUNTIME / "pi" / "cli.mjs"), "--runtime", "pi", "join", definition],
                    cwd=directory, env=env, capture_output=True, text=True, timeout=30,
                )
                self.assertEqual(joined.returncode, 0, joined.stderr)
                rpc = subprocess.run(
                    [
                        executable, "--mode", "rpc", "--offline", "--no-session",
                        "--approve",
                    ],
                    cwd=directory,
                    env=env,
                    input='{"id":"compat","type":"get_commands"}\n',
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                self.assertEqual(rpc.returncode, 0, rpc.stderr)
                responses = [json.loads(line) for line in rpc.stdout.splitlines() if line.strip().startswith("{")]
                commands = next(item for item in responses if item.get("command") == "get_commands")["data"]["commands"]
                self.assertTrue(PUBLIC <= {item["name"] for item in commands})
                self.assertIn("scouts", {item["name"] for item in commands})
                reviewer = next(item for item in commands if item["name"] == "rpc-reviewer")
                self.assertEqual(reviewer["source"], "prompt")
                self.assertEqual(reviewer["sourceInfo"]["scope"], "project")
                self.assertEqual(Path(reviewer["sourceInfo"]["path"]), Path(directory) / ".pi" / "prompts" / "rpc-reviewer.md")

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
            for runtime, folder in (("opencode", "bench"), ("pi", "extensions")):
                target = Path(directory) / runtime
                unmanaged = target / folder / "mine.txt"
                unmanaged.parent.mkdir(parents=True)
                unmanaged.write_text("keep", encoding="utf-8")
                result = run_installer(runtime, target)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(unmanaged.read_text(encoding="utf-8"), "keep")

    def test_copilot_cli_discovers_local_plugins(self):
        executable = find_cli("copilot")
        if executable is None:
            self.skipTest("Copilot CLI is not installed")
        result = subprocess.run(
            [
                executable,
                "--experimental",
                "--allow-tool=extension-permission-access(unknown)",
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

    def test_copilot_cli_loads_extension_without_a_model_turn(self):
        if not env_truthy("AGENT_HARBOR_LIVE_COPILOT_EXTENSION"):
            self.skipTest("Set AGENT_HARBOR_LIVE_COPILOT_EXTENSION=1 to run the no-model PTY probe")
        executable = find_cli("copilot")
        if executable is None:
            self.skipTest("Copilot CLI is not installed")

        with tempfile.TemporaryDirectory() as directory:
            body = probe_copilot_extension(executable, Path(directory))

        self.assertIn("Extension ready:", body)
        self.assertIn("Received session.resume request:", body)
        self.assertIn("slash_command_used", body)
        for command in PUBLIC:
            self.assertIn(f'"name":"{command}"', body)
        for tool in ("harbor_list_skills", "harbor_contract", "harbor_join"):
            self.assertIn(f'"name":"{tool}"', body)
        self.assertNotIn("denied permission access", body)
        self.assertNotRegex(body, r"Forwarding event .*: user\.message")
        self.assertNotRegex(body, r"Forwarding event .*: assistant\.message")


if __name__ == "__main__":
    unittest.main()
