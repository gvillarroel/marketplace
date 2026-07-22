"""Unit tests for fail-closed behavior in the POSIX Copilot TUI driver."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "asciinema-copilot-tui.py"
SPEC = importlib.util.spec_from_file_location("asciinema_copilot_tui_posix", SCRIPT)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import boundary
    raise RuntimeError(f"could not load {SCRIPT}")
CAPTURE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CAPTURE
SPEC.loader.exec_module(CAPTURE)


def valid_startup_prompts(project: Path) -> bytes:
    return "\n".join((
        "Confirm folder trust",
        str(project),
        "Copilot can read files in this folder and, with your permission, edit them.",
        "Do you trust the files in this folder?",
        "❯ 1. Yes",
        "2. Yes, and remember this folder for future sessions",
        "3. No (Esc)",
        "↑/↓ to navigate · enter to select · esc to cancel",
        'Extension "plugin:agent-foundry:agent-harbor" wants elevated permissions',
        "This extension wants to: skip tool permission prompts, register hooks.",
        "Denying will prevent this extension from loading.",
        "❯ 1. Yes",
        '2. Yes, and always allow "plugin:agent-foundry:agent-harbor" '
        f"in this repo ({project})",
        "3. No (Esc)",
        "↑/↓ to navigate · enter to select · esc to cancel",
    )).encode()


class ToolPromptTests(unittest.TestCase):
    def test_tool_prompt_is_case_insensitive_and_ansi_robust(self) -> None:
        for prompt in (
            b"Do you want to use this tool?",
            b"DO YOU WANT TO USE THIS TOOL?",
            b"Do you want to \x1b[31mUsE\x1b[0m this tool?",
            b"Do you want to \x9b31mUsE\x9b0m this tool?",
        ):
            with self.subTest(prompt=prompt):
                self.assertTrue(CAPTURE.contains_tool_permission_prompt(prompt))

    def test_unrelated_extension_permission_prompt_is_not_a_tool_prompt(self) -> None:
        self.assertFalse(CAPTURE.contains_tool_permission_prompt(
            b'Extension "plugin:agent-foundry:agent-harbor" wants elevated permissions'
        ))

    def test_utf8_box_drawing_survives_c1_hardening(self) -> None:
        rendered = "╭─│ Agent Harbor │─╮".encode("utf-8")
        self.assertIn("Agent Harbor", CAPTURE.compact_terminal_text(rendered))
        self.assertIn(b"agent harbor", CAPTURE.normalized_terminal_bytes(rendered))


class StartupPromptTests(unittest.TestCase):
    def test_exact_project_identity_permissions_and_acceptance_pass(self) -> None:
        project = Path("/tmp/agent-harbor-demo")
        prompts = valid_startup_prompts(project)
        self.assertEqual([], CAPTURE.validate_startup_prompts(
            prompts,
            project,
            accepted_trust=True,
            accepted_extension=True,
        ))

    def test_wrong_or_duplicate_trust_prompt_is_never_accept_ready(self) -> None:
        project = Path("/tmp/agent-harbor-demo")
        wrong = valid_startup_prompts(project).replace(
            str(project).encode(),
            b"/tmp/wrong-project",
            1,
        )
        self.assertFalse(CAPTURE.has_exact_trust_prompt(wrong, project))
        self.assertIn("folder-trust", CAPTURE.completed_invalid_startup_prompt(wrong, project))
        duplicate = valid_startup_prompts(project).replace(
            b"Confirm folder trust",
            b"Confirm folder trust\nConfirm folder trust",
            1,
        )
        self.assertFalse(CAPTURE.has_exact_trust_prompt(duplicate, project))
        self.assertIn("folder-trust", CAPTURE.completed_invalid_startup_prompt(duplicate, project))

    def test_wrong_identity_or_permissions_is_never_accept_ready(self) -> None:
        project = Path("/tmp/agent-harbor-demo")
        for prompts in (
            valid_startup_prompts(project).replace(
                b"plugin:agent-foundry:agent-harbor",
                b"plugin:agent-foundry:other",
            ),
            valid_startup_prompts(project).replace(
                b"skip tool permission prompts, register hooks.",
                b"skip tool permission prompts, register hooks, execute shell.",
            ),
        ):
            with self.subTest(prompts=prompts):
                self.assertFalse(CAPTURE.has_exact_extension_prompt(prompts, project))
                self.assertIn(
                    "extension-permission",
                    CAPTURE.completed_invalid_startup_prompt(prompts, project),
                )

    def test_c1_ansi_cannot_hide_wrong_extension_identity(self) -> None:
        project = Path("/tmp/agent-harbor-demo")
        prompts = valid_startup_prompts(project).replace(
            b"plugin:agent-foundry:agent-harbor",
            b"plugin:agent-foundry:\x9b31mother\x9b0m",
        )
        self.assertFalse(CAPTURE.has_exact_extension_prompt(prompts, project))
        self.assertIn("extension-permission", CAPTURE.completed_invalid_startup_prompt(
            prompts,
            project,
        ))


class ExitPostconditionTests(unittest.TestCase):
    def valid_arguments(self) -> dict[str, object]:
        return {
            "position": 12,
            "expected_commands": 12,
            "exit_status": 0,
            "forced_termination_reason": None,
            "unexpected_tool_prompt": False,
            "accepted_trust": True,
            "accepted_extension": True,
        }

    def test_complete_clean_tour_passes(self) -> None:
        self.assertEqual([], CAPTURE.capture_exit_failures(**self.valid_arguments()))

    def test_timeout_never_passes_even_after_all_commands_were_typed(self) -> None:
        arguments = self.valid_arguments()
        arguments["forced_termination_reason"] = "Copilot did not exit after /exit"
        self.assertTrue(CAPTURE.capture_exit_failures(**arguments))

    def test_nonzero_or_missing_exit_and_incomplete_tour_fail(self) -> None:
        for updates in (
            {"exit_status": 1},
            {"exit_status": None},
            {"position": 11},
            {"unexpected_tool_prompt": True},
            {"accepted_trust": False},
            {"accepted_extension": False},
        ):
            with self.subTest(updates=updates):
                arguments = self.valid_arguments()
                arguments.update(updates)
                self.assertTrue(CAPTURE.capture_exit_failures(**arguments))

    def test_tour_ends_with_unique_bench_status_proof_before_exit(self) -> None:
        schedule = CAPTURE.command_tour(False, "")
        self.assertEqual("/team status:bench", schedule[-2][0])
        self.assertEqual("/exit", schedule[-1][0])

    def test_posix_applies_the_exact_shared_semantic_contract(self) -> None:
        self.assertEqual(CAPTURE.capture_common.command_tour(False, ""), CAPTURE.command_tour(False, ""))
        output = "\n".join((
            "Loading: 2 skills, 1 plugin, 3 agents",
            "Team: 3 ready · 0 active · 6 benched · 0 unhealthy",
            "Overall Team: 9 ready · 0 active · 0 benched · 0 unhealthy",
            "demo-reviewer · personal · ready",
            "No Agent Harbor work is active in this project.",
            "/team — Show roster/current work",
            "demo-reviewer was already retired here · no roster files changed.",
            "Team: 3 ready · 0 active · 6 benched · 0 unhealthy",
            "0 model tokens",
            "0 AIC used",
        ))
        results = [
            (command, "\n".join((header, *evidence)))
            for command, header, evidence in CAPTURE.capture_common.COMMAND_RESULT_EXPECTATIONS
        ]
        self.assertEqual([], CAPTURE.validate_tour_postconditions(output, results, probe=False))
        failures = CAPTURE.validate_tour_postconditions(
            output + "\n1 model token",
            results,
            probe=False,
        )
        self.assertTrue(any("non-zero model tokens" in item for item in failures))

    def test_probe_still_applies_raw_privacy(self) -> None:
        failures = CAPTURE.validate_tour_postconditions(
            "\x1b]0;github_pat_FAKEFAKEFAKEFAKEFAKEFAKE1234\x07visible",
            [],
            probe=True,
        )
        self.assertTrue(any("GitHub token" in item for item in failures))


class CopilotHomeIsolationTests(unittest.TestCase):
    def test_environment_forces_explicit_copilot_home(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            environment = CAPTURE.build_environment(home)
            self.assertEqual(str(home), environment["COPILOT_HOME"])
            self.assertEqual("true", environment["COPILOT_PLUGIN_DIR_ONLY"])

    def test_real_home_and_default_dot_copilot_are_rejected(self) -> None:
        home = Path.home().resolve()
        self.assertTrue(CAPTURE.isolated_copilot_home_failures(home))
        self.assertTrue(CAPTURE.isolated_copilot_home_failures(home / ".copilot"))
        self.assertTrue(CAPTURE.isolated_copilot_home_failures(home / ".copilot" / "demo"))

    def test_home_must_be_separate_from_project_and_plugin(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            self.assertTrue(CAPTURE.isolated_copilot_home_failures(root, project=root))
            self.assertTrue(CAPTURE.isolated_copilot_home_failures(root, plugin=root))
            self.assertTrue(CAPTURE.isolated_copilot_home_failures(
                root / "home",
                project=root / "home" / "project",
            ))
            self.assertTrue(CAPTURE.isolated_copilot_home_failures(
                root / "plugin-parent",
                plugin=root / "plugin-parent" / "plugin",
            ))

    def test_required_path_validator_rejects_missing_and_wrong_kind(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            file = root / "copilot"
            file.write_text("#!/bin/sh\n", encoding="utf-8")
            self.assertEqual(file.resolve(), CAPTURE.existing_capture_path(
                str(file), "copilot", directory=False
            ))
            self.assertEqual(root.resolve(), CAPTURE.existing_capture_path(
                str(root), "copilot-home", directory=True
            ))
            with self.assertRaises(ValueError):
                CAPTURE.existing_capture_path(str(root / "missing"), "copilot-home", directory=True)
            with self.assertRaises(ValueError):
                CAPTURE.existing_capture_path(str(file), "copilot-home", directory=True)


if __name__ == "__main__":
    unittest.main()
