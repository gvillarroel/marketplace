"""Security and transaction tests shared by both native capture drivers."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
import asciinema_capture_common as COMMON

PUBLISHER_PATH = SCRIPTS / "publish-asciinema-assets.py"
PUBLISHER_SPEC = importlib.util.spec_from_file_location("publish_asciinema_assets", PUBLISHER_PATH)
if PUBLISHER_SPEC is None or PUBLISHER_SPEC.loader is None:
    raise RuntimeError(f"could not load {PUBLISHER_PATH}")
PUBLISHER = importlib.util.module_from_spec(PUBLISHER_SPEC)
sys.modules[PUBLISHER_SPEC.name] = PUBLISHER
PUBLISHER_SPEC.loader.exec_module(PUBLISHER)


class RawPrivacyTests(unittest.TestCase):
    def test_osc_and_dcs_payload_paths_are_never_stripped_before_scan(self) -> None:
        cases = (
            "\x1b]8;;file:///D:/Clients/Secret/file.txt\x1b\\visible\x1b]8;;\x1b\\",
            "\x1b]0;D:\\Clients\\Secret\\file.txt\x07visible",
            "\x1bPprivate=D:\\Clients\\Secret\\file.txt\x1b\\visible",
            "\x9d8;;file:///D:/Clients/Secret/file.txt\x9cvisible",
            "\x90private=D:\\Clients\\Secret\\file.txt\x9cvisible",
            b"\x9d8;;file:///D:/Clients/Secret/file.txt\x9cvisible".decode(
                "utf-8", errors="surrogateescape"
            ),
        )
        for text in cases:
            with self.subTest(text=repr(text)):
                self.assertIn(
                    "non-public absolute Windows or UNC path present",
                    COMMON.privacy_failures(text),
                )

    def test_credentials_are_detected_in_visible_and_control_payload_text(self) -> None:
        fake = "github_pat_FAKEFAKEFAKEFAKEFAKEFAKE1234"
        split = "github_pat_FAKEFAKE\x1b]0;FAKEFAKE\x07FAKEFAKEFAKE1234"
        for text in (fake, f"\x1b]0;{fake}\x07visible", f"\x90{fake}\x9c", split):
            with self.subTest(text=repr(text)):
                self.assertTrue(any("GitHub token" in item for item in COMMON.credential_failures(text)))

    def test_exact_sensitive_parent_value_is_detected_without_echoing_it(self) -> None:
        fake = "not-a-real-secret-value-123456"
        failures = COMMON.credential_failures(f"output {fake}", sensitive_values=(fake,))
        self.assertEqual(
            ["value from a sensitive parent environment variable present in capture"],
            failures,
        )
        self.assertNotIn(fake, "\n".join(failures))

    def test_environment_allowlist_drops_tokens_and_unrelated_parent_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(
            os.environ,
            {
                "GITHUB_TOKEN": "github_pat_FAKEFAKEFAKEFAKEFAKE1234",
                "COPILOT_GITHUB_TOKEN": "ghp_FAKEFAKEFAKEFAKEFAKE1234",
                "AWS_SECRET_ACCESS_KEY": "fake-secret",
                "UNRELATED_PRIVATE_VALUE": "private",
            },
            clear=False,
        ):
            home = Path(directory) / "home"
            home.mkdir()
            executable = Path(sys.executable)
            environment = COMMON.build_child_environment(home, executable)
            for key in (
                "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY",
                "UNRELATED_PRIVATE_VALUE",
            ):
                self.assertNotIn(key, environment)
            self.assertEqual(str(home), environment["COPILOT_HOME"])


class ProvenanceTests(unittest.TestCase):
    def make_plugin(self, root: Path, *, version: str = COMMON.EXPECTED_PLUGIN_VERSION) -> Path:
        plugin = root / "plugin"
        (plugin / "runtime").mkdir(parents=True)
        (plugin / "plugin.json").write_text(json.dumps({
            "name": COMMON.EXPECTED_PLUGIN_NAME,
            "version": version,
        }), encoding="utf-8")
        (plugin / "runtime" / "file.js").write_text("export {};\n", encoding="utf-8")
        return plugin

    def test_digest_is_deterministic_and_copy_must_match(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = self.make_plugin(root / "canonical")
            copied = root / "copy" / "plugin"
            copied.parent.mkdir()
            import shutil
            shutil.copytree(canonical, copied)
            first = COMMON.verify_plugin_copy(copied, canonical)
            second = COMMON.verify_plugin_copy(copied, canonical)
            self.assertEqual(first, second)
            (copied / "runtime" / "file.js").write_text("changed\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "does not match"):
                COMMON.verify_plugin_copy(copied, canonical)

    def test_version_and_symlink_are_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wrong = self.make_plugin(root / "wrong", version="9.9.9")
            with self.assertRaisesRegex(ValueError, "version"):
                COMMON.plugin_provenance(wrong)
            plugin = self.make_plugin(root / "linked")
            target = root / "outside.js"
            target.write_text("outside\n", encoding="utf-8")
            link = plugin / "runtime" / "linked.js"
            try:
                link.symlink_to(target)
            except OSError as error:
                self.fail(f"capture security tests require symlink support: {error}")
            with self.assertRaisesRegex(ValueError, "symlink"):
                COMMON.plugin_provenance(plugin)

    def test_exact_owner_marker_is_required(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root / COMMON.CAPTURE_OWNER_FILE
            marker.write_text(json.dumps({"owner": "owner-1234567890", "root": "project", "schema": 1}), encoding="utf-8")
            self.assertEqual([], COMMON.validate_capture_owner(root, "project", "owner-1234567890"))
            self.assertTrue(COMMON.validate_capture_owner(root, "plugin", "owner-1234567890"))

    def test_canonical_plugin_identity_and_distinct_roots_are_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = self.make_plugin(root / "canonical")
            other = self.make_plugin(root / "other")
            self.assertEqual([], COMMON.validate_canonical_plugin(canonical, canonical))
            self.assertTrue(COMMON.validate_canonical_plugin(other, canonical))
            failures = COMMON.validate_distinct_roots({
                "plugin": canonical,
                "canonical-plugin": canonical,
            })
            self.assertTrue(any("distinct" in failure for failure in failures))


class CastContractTests(unittest.TestCase):
    def provenance(self) -> COMMON.PluginProvenance:
        return COMMON.PluginProvenance(COMMON.EXPECTED_PLUGIN_NAME, COMMON.EXPECTED_PLUGIN_VERSION, "a" * 64, 2)

    def test_c1_controls_are_json_escaped_and_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "capture.cast"
            staged = COMMON.StagedArtifact(target)
            writer = COMMON.CastWriter(
                staged,
                title="title",
                command="command",
                provenance=self.provenance(),
                mode="tour",
                shell="ConPTY",
            )
            writer.output("\x9b31mX\x9b0m")
            writer.close()
            raw = writer.path.read_bytes()
            self.assertNotIn(b"\xc2\x9b", raw)
            self.assertIn(b"\\u009b", raw)
            event = json.loads(writer.path.read_text(encoding="utf-8").splitlines()[1])
            self.assertEqual("\x9b31mX\x9b0m", event[2])
            writer.discard()

    def test_non_finite_event_times_are_rejected(self) -> None:
        for event in ('[NaN,"o","x"]', '[Infinity,"o","x"]', '[-Infinity,"o","x"]'):
            with self.subTest(event=event):
                failures = COMMON.validate_cast_events([event])
                self.assertTrue(failures)

    def test_duplicate_json_keys_are_rejected_before_values_can_be_hidden(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate"):
            COMMON.strict_json_loads('{"title":"D:\\\\private","title":"safe"}')
        with tempfile.TemporaryDirectory() as directory:
            cast = Path(directory) / "duplicate.cast"
            cast.write_text(
                '{"version":3,"title":"D:\\\\private","title":"safe"}\n'
                '[0,"o","safe"]\n',
                encoding="utf-8",
            )
            failures = COMMON.validate_cast_file_security(cast)
            self.assertTrue(any("duplicate" in failure for failure in failures))

    def test_probe_output_is_visibly_staged(self) -> None:
        self.assertEqual([], COMMON.probe_output_failures(Path("work/demo.probe.cast")))
        self.assertTrue(COMMON.probe_output_failures(Path("docs/assets/demo.cast")))
        self.assertTrue(COMMON.probe_output_failures(Path("work/demo.cast")))

    def test_all_capture_outputs_stay_in_work_and_modes_cannot_alias(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            work = root / "work"
            self.assertEqual([], COMMON.capture_output_failures(
                work / "release.cast", work, probe=False,
            ))
            self.assertEqual([], COMMON.capture_output_failures(
                work / "startup.probe.cast", work, probe=True,
            ))
            self.assertTrue(COMMON.capture_output_failures(
                root / "docs" / "assets" / "release.cast", work, probe=False,
            ))
            self.assertTrue(COMMON.capture_output_failures(
                work / "release.cast", work, probe=True,
            ))

    def test_header_binds_exact_provenance_and_mode(self) -> None:
        provenance = self.provenance()
        header = {
            "version": 3,
            "term": {"cols": 100, "rows": 42},
            "timestamp": 1,
            "idle_time_limit": 10.0,
            "command": "redacted",
            "title": "title",
            "env": {"SHELL": "ConPTY"},
            "tags": COMMON.cast_tags(provenance, "tour"),
        }
        self.assertEqual([], COMMON.validate_cast_header_common(
            header,
            expected_title="title",
            expected_command="redacted",
            provenance=provenance,
            mode="tour",
            expected_shell="ConPTY",
        ))
        header["tags"] = COMMON.cast_tags(provenance, "probe")
        self.assertTrue(COMMON.validate_cast_header_common(
            header,
            expected_title="title",
            expected_command="redacted",
            provenance=provenance,
            mode="tour",
            expected_shell="ConPTY",
        ))


class TransactionTests(unittest.TestCase):
    def test_lock_blocks_a_second_publisher(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "asset.cast"
            first = COMMON.ArtifactLock(target)
            try:
                with self.assertRaisesRegex(RuntimeError, "another capture publisher"):
                    COMMON.ArtifactLock(target)
            finally:
                first.close()

    def test_target_change_blocks_single_promotion(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "asset.cast"
            target.write_text("old", encoding="utf-8")
            staged = COMMON.StagedArtifact(target)
            staged.path.write_text("new", encoding="utf-8")
            staged.claim_path()
            target.write_text("tampered", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "changed during capture"):
                staged.promote()
            staged.close()
            self.assertEqual("tampered", target.read_text(encoding="utf-8"))

    def test_failed_staging_construction_releases_its_lock(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.cast"
            target = root / "asset.cast"
            source.write_text("shared", encoding="utf-8")
            os.link(source, target)
            with self.assertRaisesRegex(RuntimeError, "one regular"):
                COMMON.StagedArtifact(target)
            lock = COMMON.ArtifactLock(target)
            lock.close()

    def test_group_publish_succeeds_and_failure_restores_exact_old_set(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            targets = {root / "a": "old-a", root / "b": "old-b", root / "c": "old-c"}
            for target, value in targets.items():
                target.write_text(value, encoding="utf-8")
            stage = root / "stage"
            stage.mkdir()
            staged = {}
            for target in targets:
                candidate = stage / target.name
                candidate.write_text(f"new-{target.name}", encoding="utf-8")
                staged[target] = candidate
            COMMON.publish_artifact_group(staged)
            self.assertEqual(["new-a", "new-b", "new-c"], [path.read_text() for path in targets])

            second_stage = root / "stage-two"
            second_stage.mkdir()
            staged = {}
            for target in targets:
                candidate = second_stage / target.name
                candidate.write_text(f"next-{target.name}", encoding="utf-8")
                staged[target] = candidate
            real_replace = os.replace
            promotions = 0

            def fail_during_second_promotion(source, destination):
                nonlocal promotions
                if Path(source).parent == second_stage:
                    promotions += 1
                    if promotions == 2:
                        raise OSError("injected promotion failure")
                return real_replace(source, destination)

            with mock.patch.object(COMMON.os, "replace", side_effect=fail_during_second_promotion):
                with self.assertRaisesRegex(OSError, "injected"):
                    COMMON.publish_artifact_group(staged)
            self.assertEqual(["new-a", "new-b", "new-c"], [path.read_text() for path in targets])


class PublisherTests(unittest.TestCase):
    def test_only_full_tour_provenance_can_be_published(self) -> None:
        provenance = COMMON.PluginProvenance(COMMON.EXPECTED_PLUGIN_NAME, COMMON.EXPECTED_PLUGIN_VERSION, "b" * 64, 1)
        header = {"tags": COMMON.cast_tags(provenance, "tour")}
        self.assertEqual((COMMON.EXPECTED_PLUGIN_VERSION, "b" * 64), PUBLISHER.parse_provenance(header))
        header["tags"] = COMMON.cast_tags(provenance, "probe")
        with self.assertRaisesRegex(ValueError, "full tour"):
            PUBLISHER.parse_provenance(header)

    def test_trim_rejects_negative_and_non_finite_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "trimmed.cast"
            for value in (-1.0, float("nan"), float("inf")):
                with self.subTest(value=value), self.assertRaisesRegex(ValueError, "finite"):
                    PUBLISHER.write_trimmed_cast({}, [], target, value)

    def test_mp4_box_parser_uses_box_boundaries_not_payload_substrings(self) -> None:
        def box(kind: bytes, payload: bytes = b"") -> bytes:
            return (8 + len(payload)).to_bytes(4, "big") + kind + payload

        data = box(b"ftyp", b"moov in payload") + box(b"moov") + box(b"mdat")
        self.assertEqual([b"ftyp", b"moov", b"mdat"], PUBLISHER.mp4_top_level_boxes(data))
        with self.assertRaisesRegex(ValueError, "truncated"):
            PUBLISHER.mp4_top_level_boxes(data + b"x")


if __name__ == "__main__":
    unittest.main()
