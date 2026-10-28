"""Repeatable ZIP transport tests; live Nexus/CLI evidence is recorded separately."""

import hashlib
import http.server
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "work"
SCRIPTS = ROOT / "scripts/shared-skills"
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")


@unittest.skipUnless(POWERSHELL, "PowerShell is required for the ZIP transport")
class NexusZipTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        WORK.mkdir(exist_ok=True)
        cls.temporary = tempfile.TemporaryDirectory(prefix="nexus-zip-tests-", dir=WORK)
        cls.directory = Path(cls.temporary.name).resolve()
        assert cls.directory.is_relative_to(WORK.resolve())
        cls.release = cls.directory / "release"
        cls.pack(cls.release)
        cls.pack(cls.directory / "repeated")

        class Handler(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(cls.release), **kwargs)

            def do_GET(self):
                if self.path.startswith("/authenticated/"):
                    if self.headers.get("Authorization") != "Bearer test-fixture":
                        self.send_error(401)
                        return
                    self.path = self.path.removeprefix("/authenticated")
                super().do_GET()

            def log_message(self, *_args):
                pass

        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}/"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        assert cls.directory.is_relative_to(WORK.resolve())
        cls.temporary.cleanup()

    @classmethod
    def pack(cls, destination):
        result = cls.ps(SCRIPTS / "pack-nexus.ps1", "-Destination", destination)
        if result.returncode:
            raise AssertionError(result.stderr)

    @staticmethod
    def ps(script, *args):
        return subprocess.run(
            [POWERSHELL, "-NoProfile", "-File", str(script), *map(str, args)],
            cwd=ROOT, capture_output=True, text=True, timeout=60,
        )

    def expand(self, artifact, target, *, digest=None, url=None, script=None):
        digest = digest or hashlib.sha256((self.release / artifact).read_bytes()).hexdigest()
        return self.ps(
            script or SCRIPTS / "expand-nexus.ps1",
            "-Uri", url or self.base + artifact, "-Sha256", digest,
            "-Destination", self.directory / target,
        )

    def test_reproducible_archives_and_single_authored_skill_library(self):
        self.assertEqual((self.release / "SHA256SUMS").read_bytes(), (self.directory / "repeated/SHA256SUMS").read_bytes())
        self.assertEqual(len(list((ROOT / "plugins/shared-skills-example").rglob("SKILL.md"))), 3)
        with zipfile.ZipFile(self.release / "marketplace.zip") as archive:
            self.assertFalse(any(name.endswith("SKILL.md") for name in archive.namelist()))
            release = json.loads(archive.read("nexus-release.json"))
        for plugin in release["plugins"]:
            self.assertEqual(plugin["sha256"], hashlib.sha256((self.release / plugin["archive"]).read_bytes()).hexdigest())
            with zipfile.ZipFile(self.release / plugin["archive"]) as archive:
                manifest = json.loads(archive.read('.codex-plugin/plugin.json'))
                selected = {path.removeprefix('./') + '/SKILL.md' for path in manifest['skills']}
                self.assertEqual(selected, {name for name in archive.namelist() if name.endswith('/SKILL.md')})

    def assert_payloads(self, destination):
        for name in ("shared-example-a", "shared-example-b"):
            with zipfile.ZipFile(self.release / (name + ".zip")) as archive:
                for entry in archive.namelist():
                    self.assertEqual(archive.read(entry), (destination / "plugins" / name / entry).read_bytes())

    def test_separate_marketplace_and_plugin_archives(self):
        result = self.expand("marketplace.zip", "separate")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_payloads(self.directory / "separate")

    def test_single_bundle_archive(self):
        result = self.expand("marketplace-bundle.zip", "bundle")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_payloads(self.directory / "bundle")

    def test_wrong_hash_does_not_extract(self):
        result = self.expand("marketplace.zip", "bad-hash", digest="0" * 64)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SHA-256 mismatch", result.stderr)
        self.assertFalse((self.directory / "bad-hash").exists())

    def test_existing_destination_is_preserved(self):
        target = self.directory / "existing"
        target.mkdir()
        (target / "sentinel").write_text("keep")
        result = self.expand("marketplace.zip", "existing")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((target / "sentinel").read_text(), "keep")

    def test_path_traversal_is_rejected_before_extraction(self):
        with zipfile.ZipFile(self.release / "traversal.zip", "w") as archive:
            archive.writestr("../escaped.txt", "must not escape")
        result = self.expand("traversal.zip", "traversal")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("escapes the destination", result.stderr)
        self.assertFalse((self.directory / "escaped.txt").exists())
        self.assertFalse((self.directory / "traversal").exists())

    def test_symlink_is_rejected_before_extraction(self):
        with zipfile.ZipFile(self.release / "symlink.zip", "w") as archive:
            entry = zipfile.ZipInfo("link")
            entry.create_system = 3
            entry.external_attr = 0o120777 << 16
            archive.writestr(entry, "../outside")
        result = self.expand("symlink.zip", "symlink")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Symlink entries", result.stderr)
        self.assertFalse((self.directory / "symlink").exists())

    def test_plain_http_is_limited_to_loopback(self):
        result = self.expand("marketplace.zip", "insecure", url="http://example.invalid/marketplace.zip")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("HTTPS is required", result.stderr)

    def test_authentication_headers_apply_to_all_archives(self):
        wrapper = self.directory / "authenticated.ps1"
        wrapper.write_text(
            "param($Uri,$Sha256,$Destination)\n"
            "$headers = @{ Authorization = 'Bearer test-fixture' }\n"
            "& $env:NEXUS_ZIP_TEST_SCRIPT -Uri $Uri -Sha256 $Sha256 -Destination $Destination -Headers $headers\n"
        )
        import os
        from unittest.mock import patch
        with patch.dict(os.environ, {"NEXUS_ZIP_TEST_SCRIPT": str(SCRIPTS / "expand-nexus.ps1")}):
            result = self.expand("marketplace.zip", "authenticated", url=self.base + "authenticated/marketplace.zip", script=wrapper)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_payloads(self.directory / "authenticated")


if __name__ == "__main__":
    unittest.main()
