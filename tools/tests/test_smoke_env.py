"""Regression checks for standalone smoke isolation, without app imports."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from smoke_env import build_smoke_env, validate_smoke_paths
import smoke_server_boot
import smoke_release_package


class SmokeEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mvhub-smoke-env-tests-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.work = self.root / "work with spaces"
        self.work.mkdir()
        self.frontend = self.root / "payload" / "frontend" / "dist"
        self.frontend.mkdir(parents=True)

    def build(self, parent=None):
        return build_smoke_env(
            os.environ if parent is None else parent,
            self.work,
            frontend_dist=self.frontend,
            python_exe=Path(sys.executable),
            port=6099,
        )

    def test_parent_paths_and_runtime_injection_are_not_inherited(self):
        parent = dict(os.environ)
        parent.update(
            {
                "content_hub_db": "OUTSIDE-DB",
                "Content_Hub_Media": "OUTSIDE-MEDIA",
                "CONTENT_HUB_FUTURE_PATH": "OUTSIDE-FUTURE",
                "CONTENT_HUB_FRONTEND_DIST": "OUTSIDE-DIST",
                "PYTHONPATH": "OUTSIDE-PYTHON",
                "PYTHONHOME": "OUTSIDE-HOME",
                "NODE_OPTIONS": "OUTSIDE-NODE",
                "BACKEND": "OUTSIDE-BACKEND",
                "HOST": "0.0.0.0",
            }
        )
        before = parent.copy()
        env = self.build(parent)
        self.assertEqual(parent, before)
        self.assertFalse(any("OUTSIDE" in value for value in env.values()))
        for key in (
            "CONTENT_HUB_DATA", "CONTENT_HUB_DB", "CONTENT_HUB_MEDIA",
            "CONTENT_HUB_SHARED", "CONTENT_HUB_ASSETS_DIR", "CONTENT_HUB_BACKUP_DIR",
            "CONTENT_HUB_SERVER_ALERT_PATH",
            "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
        ):
            self.assertTrue(Path(env[key]).is_relative_to(self.work), key)
        self.assertEqual(Path(env["CONTENT_HUB_FRONTEND_DIST"]), self.frontend)
        for key in ("CONTENT_HUB_AUTH", "CONTENT_HUB_MANAGE", "CONTENT_HUB_EXTERNAL_RECOVERY", "CONTENT_HUB_SERVER_SYNC"):
            self.assertEqual(env[key], "0")
        for key in ("CONTENT_HUB_NO_PROXY", "CONTENT_HUB_READ_ONLY", "CONTENT_HUB_TASK"):
            self.assertEqual(env[key], "1")
        self.assertEqual(env["HOST"], "127.0.0.1")

    def test_all_write_paths_are_checked_before_creating_profile(self):
        env = self.build()
        for key in (
            "CONTENT_HUB_DATA", "CONTENT_HUB_DB", "CONTENT_HUB_MEDIA",
            "CONTENT_HUB_SHARED", "CONTENT_HUB_ASSETS_DIR", "CONTENT_HUB_BACKUP_DIR",
            "CONTENT_HUB_SERVER_ALERT_PATH",
            "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
        ):
            with self.subTest(key=key):
                bad = {**env, key: str(self.root / "work with spaces-sibling" / "data")}
                with self.assertRaisesRegex(ValueError, "outside"):
                    validate_smoke_paths(self.work, bad, allowed_frontend_root=self.frontend)

    def test_an_unrelated_frontend_is_rejected(self):
        env = self.build()
        env["CONTENT_HUB_FRONTEND_DIST"] = str(self.root / "other-dist")
        with self.assertRaisesRegex(ValueError, "outside"):
            validate_smoke_paths(self.work, env, allowed_frontend_root=self.frontend)

    def test_relative_unc_and_device_roots_are_rejected(self):
        for root in (Path("relative"), Path(r"\\server\share\data"), Path(r"\\?\C:\data")):
            with self.subTest(root=str(root)), self.assertRaises(ValueError):
                build_smoke_env({}, root, frontend_dist=self.frontend, python_exe=Path(sys.executable), port=6099)

    @unittest.skipUnless(os.name == "nt", "Windows junction regression")
    def test_junction_cannot_redirect_writes(self):
        outside = self.root / "outside"
        outside.mkdir()
        for name in ("data", "profile"):
            with self.subTest(name=name):
                junction = self.work / name
                made = subprocess.run(
                    ["cmd.exe", "/d", "/c", "mklink", "/J", str(junction), str(outside)],
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(made.returncode, 0, made.stderr.decode(errors="replace"))
                with self.assertRaisesRegex(ValueError, "reparse"):
                    self.build()
                junction.rmdir()
        self.assertEqual(list(outside.iterdir()), [])

    def test_validation_failure_does_not_start_the_server(self):
        checkout = self.root / "checkout"
        (checkout / "frontend" / "dist").mkdir(parents=True)
        (checkout / "frontend" / "dist" / "index.html").write_text("test", encoding="utf-8")
        with patch.object(smoke_server_boot, "ROOT", checkout), patch.object(
            smoke_server_boot, "build_smoke_env", side_effect=ValueError("outside")
        ), patch.object(smoke_server_boot.subprocess, "Popen") as spawn:
            with self.assertRaisesRegex(ValueError, "outside"):
                smoke_server_boot.main()
        spawn.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "Windows release probe")
    def test_package_paths_are_validated_before_running_bundled_python(self):
        package = self.root / "candidate.zip"
        with zipfile.ZipFile(package, "w") as archive:
            for name, body in {
                "runtime/python/python.exe": "not executable",
                "backend/serve.py": "not executable",
                "frontend/dist/index.html": "test",
                "VERSION.txt": "test",
                "hf_cli_version.txt": "test",
                "runtime/higgsfield/node_modules/@higgsfield/cli/package.json": "{}",
            }.items():
                archive.writestr(name, body)
        with patch.object(smoke_release_package, "_parse_args", return_value=Namespace(package=package, timeout=1)), patch.object(
            smoke_release_package, "build_smoke_env", side_effect=ValueError("outside")
        ), patch.object(smoke_release_package.subprocess, "run") as run, patch.object(
            smoke_release_package.subprocess, "Popen"
        ) as spawn, patch("builtins.print"):
            self.assertEqual(smoke_release_package.main(), 1)
        run.assert_not_called()
        spawn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
