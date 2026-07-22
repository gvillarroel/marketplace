"""Adversarial tests for the Windows Copilot TUI capture validator.

Run with:
    work/.venv-capture/Scripts/python.exe -m unittest discover -s tests `
        -p "test_asciinema_copilot_tui_win.py" -v
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "asciinema-copilot-tui-win.py"
SPEC = importlib.util.spec_from_file_location("asciinema_copilot_tui_win", SCRIPT)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import boundary
    raise RuntimeError(f"could not load {SCRIPT}")
CAPTURE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CAPTURE
SPEC.loader.exec_module(CAPTURE)
COMMON = CAPTURE.capture_common


def valid_provenance() -> object:
    return COMMON.PluginProvenance(
        COMMON.EXPECTED_PLUGIN_NAME,
        COMMON.EXPECTED_PLUGIN_VERSION,
        "0" * 64,
        0,
    )


def valid_startup_prompts() -> str:
    return "\n".join((
        "Confirm folder trust",
        r"R:\team-demo",
        "Copilot can read files in this folder and, with your permission, edit them.",
        "Do you trust the files in this folder?",
        "❯ 1. Yes",
        "2. Yes, and remember this folder for future sessions",
        "3. No (Esc)",
        'Extension "plugin:agent-foundry:agent-harbor" wants elevated permissions',
        "This extension wants to: skip tool permission prompts, register hooks.",
        "Denying will prevent this extension from loading.",
        "❯ 1. Yes",
        '2. Yes, and always allow "plugin:agent-foundry:agent-harbor" '
        r"in this repo (C:\team-demo)",
        "3. No (Esc)",
    ))


def valid_tour_text() -> str:
    required = (
        valid_startup_prompts(),
        "Loading: 2 skills, 1 plugin, 3 agents",
        "Team: 3 ready · 0 active · 6 benched · 0 unhealthy",
        "Overall Team: 9 ready · 0 active · 0 benched · 0 unhealthy",
        "demo-reviewer · personal · ready",
        "No Agent Harbor work is active in this project.",
        "/team — Show roster/current work",
        "demo-reviewer was already retired here · no roster files changed.",
        "Session: 0 AIC used",
        "Team: 3 ready · 0 active · 6 benched · 0 unhealthy",
    )
    return "\n".join(required)


def valid_command_results() -> list[tuple[str, str]]:
    return [
        (command, "\n".join((header, *evidence)))
        for command, header, evidence in CAPTURE.COMMAND_RESULT_EXPECTATIONS
    ]


def valid_cast_header(version: str = "1.0.73") -> dict[str, object]:
    return {
        "version": CAPTURE.CAST_VERSION,
        "term": {"cols": CAPTURE.CAST_COLS, "rows": CAPTURE.CAST_ROWS},
        "timestamp": 1_750_000_000,
        "idle_time_limit": CAPTURE.CAST_IDLE_TIME_LIMIT,
        "command": CAPTURE.CAST_COMMAND,
        "title": CAPTURE.canonical_cast_title(version),
        "env": {"SHELL": "ConPTY"},
        "tags": COMMON.cast_tags(valid_provenance(), "tour"),
    }


class ModelTokenValidationTests(unittest.TestCase):
    def test_parses_grouped_and_ungrouped_counts(self) -> None:
        self.assertEqual(
            [0, 0, 1, 1000, 1000, 1000, 1000],
            CAPTURE.parse_model_token_counts(
                "0 model tokens; 0,000 model tokens; 1 model tokens; "
                "1000 model tokens; 1,000 model tokens; 1.000 model tokens; "
                "1_000 model tokens"
            ),
        )

    def test_parser_is_case_insensitive_and_strips_ansi(self) -> None:
        self.assertEqual(
            [1000, 2, 3],
            CAPTURE.parse_model_token_counts(
                "1 000 \x1b[31mMODEL\x1b[0m TOKENS; 2 Model Token; "
                "3 \x9b31mMODEL\x9b0m TOKENS"
            ),
        )

    def test_parser_fails_closed_on_missing_or_malformed_count(self) -> None:
        for text in (
            "unknown model tokens",
            "1,,000 model tokens",
            "1,00 model tokens",
            "1_000.000 model tokens",
        ):
            with self.subTest(text=text), self.assertRaises(ValueError):
                CAPTURE.parse_model_token_counts(text)

    def test_aic_parser_handles_all_grouping_styles_and_ansi(self) -> None:
        self.assertEqual(
            [0, 1000, 1000, 1000, 1000],
            CAPTURE.parse_aic_counts(
                "0 AIC used; 1 000 aic USED; 1,000 AIC used; "
                "1.000 \x1b[36mAIC\x1b[0m used; 1_000 AIC used"
            ),
        )

    def test_tour_rejects_nonzero_aic_hidden_by_ansi_and_case(self) -> None:
        failures = CAPTURE.validate_full_tour(
            valid_tour_text() + "\n1_000 \x1b[31maIc\x1b[0m UsEd"
        )
        self.assertTrue(any("non-zero AIC: 1000" in item for item in failures))

    def test_tour_rejects_comma_grouped_nonzero_count(self) -> None:
        failures = CAPTURE.validate_full_tour(
            valid_tour_text() + "\n0 model tokens\n1,000 model tokens"
        )
        self.assertTrue(any("non-zero model tokens: 1000" in item for item in failures))

    def test_segment_rejects_nonzero_even_with_stale_zero_marker(self) -> None:
        results = valid_command_results()
        command, output = results[1]
        results[1] = (command, output + "\n1,000 model tokens")
        failures = CAPTURE.validate_command_results(results)
        self.assertTrue(any("non-zero model tokens: 1000" in item for item in failures))


class ChronologicalResultValidationTests(unittest.TestCase):
    def test_valid_ordered_tour_passes(self) -> None:
        self.assertEqual([], CAPTURE.validate_command_results(valid_command_results()))

    def test_prior_bench_redraw_cannot_satisfy_bench_list(self) -> None:
        results = valid_command_results()
        prior = CAPTURE.COMMAND_RESULT_EXPECTATIONS[1]
        command = CAPTURE.COMMAND_RESULT_EXPECTATIONS[2][0]
        results[2] = (command, "\n".join((prior[1], *prior[2])))
        failures = CAPTURE.validate_command_results(results)
        self.assertTrue(any("lacks a fresh" in item for item in failures))

    def test_replay_of_initial_team_cannot_satisfy_final_bench_status_query(self) -> None:
        results = valid_command_results()
        initial = CAPTURE.COMMAND_RESULT_EXPECTATIONS[0]
        final_command = CAPTURE.COMMAND_RESULT_EXPECTATIONS[10][0]
        results[10] = (final_command, "\n".join((initial[1], *initial[2])))
        failures = CAPTURE.validate_command_results(results)
        self.assertTrue(any("ordered transition evidence" in item for item in failures))

    def test_reordered_transition_evidence_fails(self) -> None:
        results = valid_command_results()
        command, header, evidence = CAPTURE.COMMAND_RESULT_EXPECTATIONS[1]
        results[1] = (command, "\n".join((header, *reversed(evidence))))
        failures = CAPTURE.validate_command_results(results)
        self.assertTrue(any("ordered transition evidence" in item for item in failures))


class StartupPromptValidationTests(unittest.TestCase):
    def test_exact_prompts_and_acceptance_postconditions_pass(self) -> None:
        self.assertEqual(
            [],
            CAPTURE.validate_startup_prompts(
                valid_startup_prompts(),
                accepted_trust=True,
                accepted_extension=True,
            ),
        )

    def test_ansi_cannot_hide_duplicate_or_wrong_trust_prompt(self) -> None:
        duplicate = valid_startup_prompts().replace(
            "Confirm folder trust",
            "Confirm \x1b[31mfolder\x1b[0m trust\nConfirm folder trust",
            1,
        )
        failures = CAPTURE.validate_startup_prompts(duplicate)
        self.assertTrue(any("exactly one folder-trust" in item for item in failures))

        wrong_path = valid_startup_prompts().replace(
            r"R:\team-demo",
            r"R:/team-demo-home",
            1,
        )
        failures = CAPTURE.validate_startup_prompts(wrong_path)
        self.assertTrue(any("must target exactly" in item for item in failures))

    def test_extension_identity_and_permissions_are_exact(self) -> None:
        wrong_identity = valid_startup_prompts().replace(
            "plugin:agent-foundry:agent-harbor",
            "plugin:agent-foundry:other",
        )
        self.assertTrue(any(
            "unexpected identity" in item
            for item in CAPTURE.validate_startup_prompts(wrong_identity)
        ))
        extra_permission = valid_startup_prompts().replace(
            "skip tool permission prompts, register hooks.",
            "skip tool permission prompts, register hooks, execute shell commands.",
        )
        self.assertTrue(any(
            "unexpected permissions" in item
            for item in CAPTURE.validate_startup_prompts(extra_permission)
        ))

    def test_tool_prompt_is_case_insensitive_after_ansi_stripping(self) -> None:
        output = (
            valid_startup_prompts()
            + "\nDO YOU WANT TO \x1b[35mUsE\x1b[0m THIS TOOL?"
        )
        self.assertTrue(CAPTURE.contains_tool_permission_prompt(output))
        self.assertIn(
            "unexpected tool permission prompt",
            CAPTURE.validate_startup_prompts(output),
        )
        self.assertTrue(CAPTURE.contains_tool_permission_prompt(
            valid_startup_prompts() + "\nDo you want to \x9b31mUSE\x9b0m this tool?"
        ))

    def test_unaccepted_startup_prompt_fails_postconditions(self) -> None:
        failures = CAPTURE.validate_startup_prompts(
            valid_startup_prompts(),
            accepted_trust=False,
            accepted_extension=False,
        )
        self.assertIn("folder-trust prompt was not accepted", failures)
        self.assertIn("extension-permission prompt was not accepted", failures)


class CapturePathValidationTests(unittest.TestCase):
    def test_explicit_path_outside_home_is_private(self) -> None:
        private = Path(r"D:\Clients\SecretProject")
        markers = CAPTURE.private_path_markers(private, public_paths=(private,))
        self.assertIn(str(private.absolute()), markers)
        failures = CAPTURE.validate_full_tour(valid_tour_text() + f"\n{private}", private)
        self.assertIn("private home or workspace path present", failures)

    def test_only_verified_canonical_aliases_are_public(self) -> None:
        public = tuple(CAPTURE.CANONICAL_PUBLIC_CAPTURE_PATHS.values())
        markers = CAPTURE.private_path_markers(*public, public_paths=public)
        for path in public:
            self.assertNotIn(str(path), markers)
        self.assertEqual(
            [],
            CAPTURE.canonical_capture_path_failures(
                CAPTURE.CANONICAL_PUBLIC_CAPTURE_PATHS["plugin"],
                CAPTURE.CANONICAL_PUBLIC_CAPTURE_PATHS["project"],
                CAPTURE.CANONICAL_PUBLIC_CAPTURE_PATHS["copilot-home"],
            ),
        )

    def test_noncanonical_visible_path_is_rejected(self) -> None:
        failures = CAPTURE.canonical_capture_path_failures(
            Path(r"D:\Clients\SecretPlugin"),
            CAPTURE.CANONICAL_PUBLIC_CAPTURE_PATHS["project"],
            CAPTURE.CANONICAL_PUBLIC_CAPTURE_PATHS["copilot-home"],
        )
        self.assertTrue(any("plugin must expand" in item for item in failures))

    def test_capture_arguments_must_use_exact_r_aliases(self) -> None:
        visible = CAPTURE.CANONICAL_VISIBLE_CAPTURE_PATHS
        self.assertEqual([], CAPTURE.visible_capture_path_failures(
            visible["plugin"],
            visible["project"],
            visible["copilot-home"],
        ))
        failures = CAPTURE.visible_capture_path_failures(
            CAPTURE.CANONICAL_PUBLIC_CAPTURE_PATHS["plugin"],
            visible["project"],
            visible["copilot-home"],
        )
        self.assertTrue(any("plugin must use the visible public alias" in item for item in failures))

    def test_ansi_and_mixed_slashes_cannot_hide_absolute_private_path(self) -> None:
        for escaped in ("\x1b[31mSecret\x1b[0m", "\x9b31mSecret\x9b0m"):
            with self.subTest(escaped=escaped):
                output = valid_tour_text() + f"\nD:/Clients\\{escaped}/file.txt"
                self.assertIn(
                    "non-public absolute Windows or UNC path present",
                    CAPTURE.validate_full_tour(output),
                )

    def test_unc_and_public_prefix_collision_are_rejected(self) -> None:
        for path in (r"\\server\share\secret", r"C:\team-demo-secret\file.txt"):
            with self.subTest(path=path):
                self.assertIn(
                    "non-public absolute Windows or UNC path present",
                    CAPTURE.privacy_failures(path),
                )

    def test_exact_public_roots_and_children_allow_mixed_slashes(self) -> None:
        output = "\n".join((
            r"R:/team-demo",
            r"C:\team-demo\subdir/file.txt",
            r"R:\agent-foundry-demo/extensions",
            r"C:/team-demo-home/state.json",
        ))
        public = (
            *CAPTURE.CANONICAL_PUBLIC_CAPTURE_PATHS.values(),
            *CAPTURE.CANONICAL_VISIBLE_CAPTURE_PATHS.values(),
        )
        self.assertEqual([], CAPTURE.privacy_failures(output, public_paths=public))

    def test_checked_in_cast_still_passes_privacy_and_tour_validation(self) -> None:
        lines = (ROOT / "docs" / "assets" / "agent-harbor-commands.cast").read_text(
            encoding="utf-8"
        ).splitlines()
        output = "".join(json.loads(line)[2] for line in lines[1:])
        header = json.loads(lines[0])
        public = (
            *CAPTURE.CANONICAL_PUBLIC_CAPTURE_PATHS.values(),
            *CAPTURE.CANONICAL_VISIBLE_CAPTURE_PATHS.values(),
        )
        failures = CAPTURE.validate_full_tour(
            output,
            SCRIPT,
            *public,
            ROOT / "docs" / "assets" / "agent-harbor-commands.cast",
            public_paths=public,
        )
        self.assertEqual([], failures)
        # The checked-in binary is intentionally regenerated only after source
        # hardening. Header provenance is covered by a synthetic exact fixture.
        self.assertEqual(3, header["version"])


class CastHeaderValidationTests(unittest.TestCase):
    def test_exact_header_passes(self) -> None:
        self.assertEqual([], CAPTURE.validate_cast_header(valid_cast_header(), "1.0.73"))

    def test_every_fixed_header_field_is_fail_closed(self) -> None:
        mutations = {
            "version": lambda header: header.update(version=2),
            "term": lambda header: header.update(term={"cols": 99, "rows": 42}),
            "timestamp": lambda header: header.update(timestamp=True),
            "idle": lambda header: header.update(idle_time_limit=9.0),
            "command": lambda header: header.update(command=r"C:\private\copilot.exe"),
            "title": lambda header: header.update(title="GitHub Copilot CLI latest"),
            "env": lambda header: header.update(env={"SHELL": "ConPTY", "HOME": r"D:\secret"}),
            "extra": lambda header: header.update(hostname="private-host"),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                header = valid_cast_header()
                mutate(header)
                self.assertTrue(CAPTURE.validate_cast_header(header, "1.0.73"))

    def test_header_privacy_runs_after_ansi_stripping(self) -> None:
        header = valid_cast_header()
        header["env"] = {
            "SHELL": "ConPTY",
            "HOME": "D:/Clients/\x1b[31mSecret\x1b[0m",
        }
        failures = CAPTURE.validate_cast_header(header, "1.0.73")
        self.assertIn("non-public absolute Windows or UNC path present", failures)

    def test_header_title_version_must_match_exactly(self) -> None:
        self.assertIn(
            "cast title must contain the exact verified CLI version and capture mode",
            CAPTURE.validate_cast_header(valid_cast_header("1.0.73"), "1.0.74"),
        )


class RenderCastIdentityTests(unittest.TestCase):
    def test_case_alias_cannot_replace_source_cast(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "Evidence.cast"
            source.write_text(
                '{"version":3,"term":{"cols":80,"rows":24}}\n[5.0,"o","ok"]\n',
                encoding="utf-8",
            )
            target = source.with_name("evidence.cast")
            with self.assertRaisesRegex(ValueError, "must not replace"):
                CAPTURE.write_render_cast(source, target)
            self.assertIn('"ok"', source.read_text(encoding="utf-8"))

    def test_hard_link_alias_cannot_replace_source_cast(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.cast"
            alias = Path(directory) / "alias.cast"
            source.write_text(
                '{"version":3,"term":{"cols":80,"rows":24}}\n[5.0,"o","ok"]\n',
                encoding="utf-8",
            )
            os.link(source, alias)
            with self.assertRaisesRegex(ValueError, "must not replace"):
                CAPTURE.write_render_cast(source, alias)
            self.assertIn('"ok"', source.read_text(encoding="utf-8"))

    def test_predictable_legacy_hardlink_is_ignored_and_never_truncated(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.cast"
            target = Path(directory) / "render.cast"
            partial = target.with_name(f".{target.name}.{os.getpid()}.partial")
            original = '{"version":3}\n[5.0,"o","evidence"]\n'
            source.write_text(original, encoding="utf-8")
            os.link(source, partial)
            CAPTURE.write_render_cast(source, target)
            self.assertEqual(original, source.read_text(encoding="utf-8"))
            self.assertTrue(partial.exists(), "an unowned preexisting partial must not be deleted")
            self.assertTrue(target.exists())

    def test_predictable_legacy_symlink_is_ignored_and_never_truncated(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.cast"
            target = Path(directory) / "render.cast"
            partial = target.with_name(f".{target.name}.{os.getpid()}.partial")
            original = '{"version":3}\n[5.0,"o","evidence"]\n'
            source.write_text(original, encoding="utf-8")
            try:
                partial.symlink_to(source)
            except OSError as error:
                self.skipTest(f"symlink creation is unavailable: {error}")
            CAPTURE.write_render_cast(source, target)
            self.assertEqual(original, source.read_text(encoding="utf-8"))
            self.assertTrue(partial.is_symlink(), "an unowned symlink must not be deleted")
            self.assertTrue(target.exists())


class CapturePartialIdentityTests(unittest.TestCase):
    def make_writer(self, directory: str):
        target = Path(directory) / "capture.cast"
        staged = COMMON.StagedArtifact(target)
        writer = COMMON.CastWriter(
            staged,
            title=CAPTURE.canonical_cast_title("1.0.73"),
            command=CAPTURE.CAST_COMMAND,
            provenance=valid_provenance(),
            mode="tour",
            shell="ConPTY",
        )
        return staged, writer

    def test_staging_directory_is_private_and_unpredictable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            staged, writer = self.make_writer(directory)
            self.assertNotIn(str(os.getpid()), staged.directory.name)
            self.assertTrue(staged.directory.name.startswith(".capture.cast.agent-harbor-"))
            writer.discard()

    def test_discard_never_deletes_replacement_it_does_not_own(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            staged, writer = self.make_writer(directory)
            replacement = Path(directory) / "replacement.cast"
            writer.close()
            writer.path.unlink()
            replacement.write_text("replacement", encoding="utf-8")
            os.link(replacement, writer.path)
            writer.discard()
            self.assertEqual("replacement", replacement.read_text(encoding="utf-8"))
            self.assertTrue(writer.path.exists())

    def test_added_hardlink_blocks_promotion_and_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            staged, writer = self.make_writer(directory)
            alias = Path(directory) / "unexpected-link.cast"
            writer.close()
            os.link(writer.path, alias)
            with self.assertRaisesRegex(RuntimeError, "one regular"):
                staged.promote()
            writer.discard()
            self.assertTrue(writer.path.exists())
            self.assertTrue(alias.exists())


if __name__ == "__main__":
    unittest.main()
