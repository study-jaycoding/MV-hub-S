"""Isolated file-release and bootstrap contracts; never uses a live installation."""
from __future__ import annotations

import copy
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.request import Request


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("mcp_file_update_test", HERE / "update.py")
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


def payload(version="2026.10.27.1", features='{"generation_result"}', body=""):
    return (f'MCP_UPDATE_API = 1\nADAPTER_VERSION = "{version}"\nHUB_FEATURES = {features}\n'
            f'_MCP_BUNDLE = globals().get("_MCP_BUNDLE")\n{body}\n').encode()


class UpdateTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="mvhub-mcp-update-test-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.root = self.base / "installation"
        self.bundle = self.root / "tools" / "mcp_adapter"
        self.bundle.mkdir(parents=True)
        (self.bundle / "server.py").write_bytes(payload())
        (self.bundle / "local_setup.py").write_bytes(b"# fixed profile contract\n")
        (self.bundle / "requirements.lock.txt").write_bytes(b"# fixed SDK contract\n")
        (self.bundle / "update.py").write_bytes((HERE / "update.py").read_bytes())
        (self.root / "VERSION.txt").write_text("2026.10.27\n", encoding="utf-8")
        self.source = self.base / "distribution"
        self.release = self.source / "mcp"
        env = patch.dict(os.environ, {"LOCALAPPDATA": str(self.base / "localappdata")})
        env.start()
        self.addCleanup(env.stop)
        self.storage = update.storage_path(self.root)

    def candidate(self, number=1, code=None):
        code = code if code is not None else payload(f"2026.10.27.{number}")
        baseline = {name: (self.bundle / name).read_bytes() for name in update.BASELINE}
        manifest = update.build_manifest(f"{number:040x}", code, baseline)
        return manifest, {"server.py": code}

    def publish(self, number=1, code=None):
        manifest, files = self.candidate(number, code)
        update.publish(self.release, manifest, files, update.pointer_token(self.release))
        return manifest

    def install(self, number=1, code=None):
        manifest = self.publish(number, code)
        return update.install(self.root, str(self.source), update.manifest_digest(manifest))

    def test_manifest_rejects_path_size_hash_and_duplicate_file_attacks(self):
        original, _ = self.candidate()
        for field, values in {
            "path": ["../server.py", "server.py:payload", "C:/server.py", "server\\.py", "local_setup.py"],
            "size": [-1, 0, True, update.MAX_FILE + 1],
            "sha256": ["", "g" * 64, "a" * 63],
        }.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    bad = copy.deepcopy(original)
                    bad["files"][0][field] = value
                    with self.assertRaises(update.Error):
                        update.validate_manifest(bad)
        duplicate = copy.deepcopy(original)
        duplicate["files"].append(copy.deepcopy(duplicate["files"][0]))
        with self.assertRaises(update.Error):
            update.validate_manifest(duplicate)

    def test_static_validation_rejects_old_or_dynamic_contract_without_execution(self):
        baseline = {name: (self.bundle / name).read_bytes() for name in update.BASELINE}
        for code in [b"this is not valid Python!!!", payload().replace(b"MCP_UPDATE_API = 1", b"MCP_UPDATE_API = 0"),
                     payload().replace(b'"2026.10.27.1"', b"get_version()"),
                     payload() + b"\nADAPTER_VERSION = '2026.10.27.2'\n"]:
            with self.subTest(code=code[:50]), self.assertRaises(update.Error):
                update.build_manifest("1" * 40, code, baseline)
        code = payload(body="raise RuntimeError('must not execute during validation')")
        manifest, files = self.candidate(code=code)
        update.stage_version(self.release, manifest, files)
        self.assertEqual(update.read_version(self.release, manifest["commit"])[1], files)

    def test_compatibility_checks_fixed_dependencies_features_and_crlf(self):
        manifest, _ = self.candidate()
        self.assertEqual(update.compatibility(manifest, self.bundle), "")
        for name in update.BASELINE:
            path = self.bundle / name
            original = path.read_bytes()
            path.write_bytes(original.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))
            self.assertEqual(update.compatibility(manifest, self.bundle), "")
            path.write_bytes(original + b"\n# incompatible\n")
            self.assertTrue(update.compatibility(manifest, self.bundle))
            path.write_bytes(original)
        new_features, _ = self.candidate(code=payload(features='{"generation_result", "new_feature"}'))
        self.assertTrue(update.compatibility(new_features, self.bundle))

    def test_version_directory_is_immutable_and_extra_files_are_rejected(self):
        manifest, files = self.candidate()
        update.stage_version(self.release, manifest, files)
        update.stage_version(self.release, manifest, files)
        replacement, changed = self.candidate(code=payload("2026.10.27.2"))
        with self.assertRaises(update.Error):
            update.stage_version(self.release, replacement, changed)
        folder = self.release / "versions" / manifest["commit"]
        self.assertEqual((folder / "server.py").read_bytes(), files["server.py"])
        (folder / "unexpected.txt").write_text("not allowed", encoding="utf-8")
        with self.assertRaises(update.Error):
            update.read_version(self.release, manifest["commit"])

    def test_corruption_selects_bundle_without_changing_pointer(self):
        state = self.install()
        pointer = (self.storage / "published.json").read_bytes()
        Path(state["path"]).write_bytes(b"corrupt")
        selected = update.selection(self.root)
        self.assertEqual(selected["source"], "bundle")
        self.assertTrue(selected["reason"])
        self.assertEqual((self.storage / "published.json").read_bytes(), pointer)

    def test_linked_payload_is_rejected_even_when_its_bytes_match(self):
        manifest, files = self.candidate()
        update.stage_version(self.release, manifest, files)
        original = self.base / "linked-content.py"
        original.write_bytes(files["server.py"])
        target = self.release / "versions" / manifest["commit"] / "server.py"
        target.unlink()
        try:
            target.symlink_to(original)
        except OSError as exc:
            if os.name == "nt" and getattr(exc, "winerror", None) == 1314:
                self.skipTest("This Windows account cannot create symbolic links")
            raise
        with self.assertRaises(update.Error):
            update.read_version(self.release, manifest["commit"])

    def test_partial_download_keeps_previous_installation(self):
        installed = self.install(1)
        pointer = (self.storage / "published.json").read_bytes()
        manifest = self.publish(2)
        original = update._source_read
        def short_read(source, relative, limit):
            data = original(source, relative, limit)
            return data[:-1] if relative.endswith("/server.py") else data
        with patch.object(update, "_source_read", side_effect=short_read), self.assertRaises(update.Error):
            update.install(self.root, str(self.source), update.manifest_digest(manifest))
        self.assertEqual((self.storage / "published.json").read_bytes(), pointer)
        self.assertEqual(update.selection(self.root)["commit"], installed["commit"])

    def test_pointer_replace_failure_keeps_previous_installation(self):
        installed = self.install(1)
        pointer = (self.storage / "published.json").read_bytes()
        manifest = self.publish(2)
        with patch.object(update.os, "replace", side_effect=OSError("injected replace failure")), self.assertRaises(OSError):
            update.install(self.root, str(self.source), update.manifest_digest(manifest))
        self.assertEqual((self.storage / "published.json").read_bytes(), pointer)
        self.assertEqual(update.selection(self.root)["commit"], installed["commit"])
        self.assertFalse(list(self.storage.glob(".pointer-*")))

    def test_stale_confirmation_and_rollbacks_preserve_profiles(self):
        profile = self.base / "profile.bin"
        profile.write_bytes(b"fixture DPAPI bytes")
        one = self.install(1)
        two_manifest = self.publish(2)
        with self.assertRaises(update.Error):
            update.install(self.root, str(self.source), one["manifest_sha256"])
        two = update.install(self.root, str(self.source), update.manifest_digest(two_manifest))
        with self.assertRaises(update.Error):
            update.rollback_install(self.root, one["manifest_sha256"])
        back = update.rollback_install(self.root, two["manifest_sha256"])
        self.assertEqual(back["commit"], one["commit"])
        self.assertEqual(profile.read_bytes(), b"fixture DPAPI bytes")

    def test_first_install_can_roll_back_to_bundle(self):
        one = self.install()
        self.assertTrue(one["rollback_available"])
        restored = update.rollback_install(self.root, one["manifest_sha256"])
        self.assertEqual(restored["source"], "bundle")
        self.assertEqual(update.selection(self.root)["source"], "bundle")

    def test_changed_application_version_or_bundle_invalidates_selected_payload(self):
        self.install()
        version = self.root / "VERSION.txt"
        original = version.read_bytes()
        version.write_bytes(original + b"next")
        self.assertEqual(update.selection(self.root)["source"], "bundle")
        version.write_bytes(original)
        self.assertEqual(update.selection(self.root)["source"], "downloaded")
        script = self.bundle / "server.py"
        script.write_bytes(script.read_bytes() + b"\n# new bundled release\n")
        self.assertEqual(update.selection(self.root)["source"], "bundle")

    def test_storage_is_scoped_to_installation(self):
        self.assertNotEqual(update.storage_path(self.root), update.storage_path(self.base / "another-installation"))

    def test_https_redirect_stays_on_same_secure_origin(self):
        handler = update._SameOrigin()
        request = Request("https://release.example/mcp/published.json")
        for target in ["http://release.example/mcp/published.json", "https://other.example/file",
                       "https://release.example:444/file", "https://user:secret@release.example/file"]:
            with self.subTest(target=target), self.assertRaises(update.Error):
                handler.redirect_request(request, None, 302, "redirect", {}, target)
        redirected = handler.redirect_request(request, None, 302, "redirect", {}, "https://release.example:443/file")
        self.assertEqual(redirected.full_url, "https://release.example:443/file")
        with patch.object(update, "build_opener") as opener, self.assertRaises(update.Error):
            update._source_read("http://release.example", "mcp/published.json", 100)
        opener.assert_not_called()

    def test_unpublished_and_missing_referenced_manifest_are_different(self):
        with self.assertRaises(update.NotPublished):
            update.source_overview(str(self.source))
        manifest = self.publish()
        (self.release / "versions" / manifest["commit"] / "manifest.json").unlink()
        with self.assertRaises(FileNotFoundError):
            update.source_overview(str(self.source))

    def test_another_process_cannot_enter_installation_lock(self):
        script = (
            "import importlib.util,sys\n"
            "from pathlib import Path\n"
            "s=importlib.util.spec_from_file_location('u',sys.argv[1]);u=importlib.util.module_from_spec(s);s.loader.exec_module(u)\n"
            "try:\n"
            " with u.exclusive_lock(Path(sys.argv[2])): print('acquired')\n"
            "except u.Error: print('blocked')\n"
        )
        args = [sys.executable, "-I", "-S", "-c", script, str(HERE / "update.py"), str(self.root / ".update.lock")]
        options = {"capture_output": True, "text": True, "timeout": 10}
        if os.name == "nt":
            options["creationflags"] = 0x08000000
        with update.exclusive_lock(self.root / ".update.lock"):
            blocked = subprocess.run(args, **options)
        self.assertEqual((blocked.returncode, blocked.stdout.strip()), (0, "blocked"), blocked.stderr)
        acquired = subprocess.run(args, **options)
        self.assertEqual((acquired.returncode, acquired.stdout.strip()), (0, "acquired"), acquired.stderr)

    def test_real_bootstrap_passes_bundle_location_and_does_not_retry_executed_failure(self):
        prefix = (HERE / "server.py").read_text("utf-8").split("# Only the bundled SDK", 1)[0]
        bundled = prefix + payload(body="print('BUNDLED')").decode().replace('_MCP_BUNDLE = globals().get("_MCP_BUNDLE")\n', '')
        (self.bundle / "server.py").write_text(bundled, encoding="utf-8")
        candidate = (prefix + payload("2026.10.27.2", body=
                     "print('CANDIDATE:' + str(_MCP_BUNDLE))\nraise RuntimeError('executed failure')").decode()
                     .replace('_MCP_BUNDLE = globals().get("_MCP_BUNDLE")\n', '')).encode()
        selected = self.install(2, candidate)
        options = {"capture_output": True, "text": True, "timeout": 10}
        if os.name == "nt":
            options["creationflags"] = 0x08000000
        result = subprocess.run([sys.executable, "-I", "-S", str(self.bundle / "server.py")], **options)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), "CANDIDATE:" + str(self.bundle))
        self.assertIn("executed failure", result.stderr)
        self.assertNotIn("BUNDLED", result.stdout)
        Path(selected["path"]).write_bytes(b"corrupt before execution")
        fallback = subprocess.run([sys.executable, "-I", "-S", str(self.bundle / "server.py")], **options)
        self.assertEqual(fallback.returncode, 0, fallback.stderr)
        self.assertEqual(fallback.stdout.strip(), "BUNDLED")

    def test_real_bootstrap_preflight_failure_runs_bundle_once(self):
        prefix = (HERE / "server.py").read_text("utf-8").split("# Only the bundled SDK", 1)[0]
        bundled = prefix + payload(body="print('BUNDLED')").decode().replace('_MCP_BUNDLE = globals().get("_MCP_BUNDLE")\n', '')
        (self.bundle / "server.py").write_text(bundled, encoding="utf-8")
        updater = (HERE / "update.py").read_text("utf-8")
        options = {"capture_output": True, "text": True, "timeout": 10, "encoding": "utf-8"}
        if os.name == "nt":
            options["creationflags"] = 0x08000000
        for failure in (
            "def _plain(path):\n    raise OSError('injected early path failure')\n",
            "def selection(root, storage=None):\n    raise OSError('injected selection failure')\n",
            "raise OSError('injected updater import failure')\n",
        ):
            with self.subTest(failure=failure.splitlines()[0]):
                (self.bundle / "update.py").write_text(updater + "\n" + failure, encoding="utf-8")
                result = subprocess.run([sys.executable, "-X", "utf8", "-I", "-S", str(self.bundle / "server.py")], **options)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.splitlines(), ["BUNDLED"])
                self.assertIn("설치본 판을 사용합니다", result.stderr)
                self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
