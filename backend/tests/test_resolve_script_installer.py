"""Resolve 사용자 스크립트 설치 경로·버전·멱등성."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException, Request

from app.routers import resolve_integration
from app.services import resolve_script_installer


class ResolveScriptInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.appdata = self.root / "AppData" / "Roaming"
        self.source = self.root / "MVHub_Clip_Exporter.py"
        self.source.write_text('PLUGIN_VERSION = "1.2.3"\nprint("new")\n', "utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_installs_to_resolve_utility_mv_hub_folder(self):
        result = resolve_script_installer.install_resolve_script(
            appdata=self.appdata, source_path=self.source
        )

        target = Path(result["path"])
        self.assertEqual(
            target.relative_to(self.appdata).as_posix(),
            "Blackmagic Design/DaVinci Resolve/Support/Fusion/Scripts/Utility/MV Hub/MVHub Clip Exporter.py",
        )
        self.assertEqual(target.read_bytes(), self.source.read_bytes())
        self.assertTrue(result["changed"])
        self.assertEqual(result["bundled_version"], "1.2.3")
        self.assertTrue(result["up_to_date"])

    def test_status_before_install_reports_the_expected_target(self):
        result = resolve_script_installer.resolve_script_status(
            appdata=self.appdata, source_path=self.source
        )

        self.assertFalse(result["installed"])
        self.assertFalse(result["up_to_date"])
        self.assertEqual(result["installed_version"], None)
        self.assertEqual(
            Path(result["path"]),
            resolve_script_installer.resolve_script_target(self.appdata),
        )

    def test_same_script_is_idempotent(self):
        resolve_script_installer.install_resolve_script(
            appdata=self.appdata, source_path=self.source
        )

        result = resolve_script_installer.install_resolve_script(
            appdata=self.appdata, source_path=self.source
        )

        self.assertFalse(result["changed"])
        self.assertEqual(result["installed_version"], "1.2.3")

    def test_update_replaces_only_the_managed_script(self):
        target = resolve_script_installer.resolve_script_target(self.appdata)
        target.parent.mkdir(parents=True)
        target.write_text('PLUGIN_VERSION = "0.9.0"\n', "utf-8")
        unrelated = target.parent / "Other Tool.py"
        unrelated.write_text("keep", "utf-8")

        result = resolve_script_installer.install_resolve_script(
            appdata=self.appdata, source_path=self.source
        )

        self.assertEqual(result["previous_version"], "0.9.0")
        self.assertEqual(target.read_bytes(), self.source.read_bytes())
        self.assertEqual(unrelated.read_text("utf-8"), "keep")

    def test_install_api_is_limited_to_the_local_pc(self):
        local_request = Request({"type": "http", "client": ("127.0.0.1", 12345)})
        remote_request = Request({"type": "http", "client": ("192.168.1.50", 12345)})

        resolve_integration._require_local_script_install(local_request)
        with self.assertRaises(HTTPException) as raised:
            resolve_integration._require_local_script_install(remote_request)

        self.assertEqual(raised.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
