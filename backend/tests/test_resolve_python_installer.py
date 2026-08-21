"""Python 반자동 설치 도우미 — 캐시·해시 검증·실행 인자 검증."""

from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from app.services import resolve_python_installer


def _fake_installer_bytes() -> bytes:
    return b"fake-python-installer"


def _fake_sha256() -> str:
    return hashlib.sha256(_fake_installer_bytes()).hexdigest()


class ResolvePythonInstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = Path(self.tmp.name) / "python-installer.exe"

    def tearDown(self):
        self.tmp.cleanup()

    def test_valid_cached_installer_launches_without_download(self):
        self.cache.write_bytes(_fake_installer_bytes())
        with (
            mock.patch.object(
                resolve_python_installer, "_installer_cache_path", return_value=self.cache
            ),
            mock.patch.object(
                resolve_python_installer, "_INSTALLER_SHA256", _fake_sha256()
            ),
            mock.patch.object(resolve_python_installer, "_download_installer") as download,
            mock.patch.object(resolve_python_installer, "_launch_installer") as launch,
        ):
            result = resolve_python_installer.start_python_installer()

        download.assert_not_called()
        launch.assert_called_once_with(self.cache)
        self.assertTrue(result["ok"])
        self.assertIn("UAC", result["message"])
        self.assertIn("Resolve 진단", result["message"])

    def test_corrupt_cached_installer_is_redownloaded(self):
        self.cache.write_bytes(b"corrupted")
        with (
            mock.patch.object(
                resolve_python_installer, "_installer_cache_path", return_value=self.cache
            ),
            mock.patch.object(
                resolve_python_installer, "_INSTALLER_SHA256", _fake_sha256()
            ),
            mock.patch.object(resolve_python_installer, "_download_installer") as download,
            mock.patch.object(resolve_python_installer, "_launch_installer"),
        ):
            resolve_python_installer.start_python_installer()

        download.assert_called_once_with(self.cache)

    def test_downloaded_hash_mismatch_removes_file_and_reports(self):
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            @staticmethod
            def read(_size):
                FakeResponse.chunks = getattr(FakeResponse, "chunks", [b"tampered", b""])
                return FakeResponse.chunks.pop(0)

        with (
            mock.patch.object(
                resolve_python_installer, "urlopen", return_value=FakeResponse()
            ),
            mock.patch.object(
                resolve_python_installer, "_INSTALLER_SHA256", _fake_sha256()
            ),
        ):
            with self.assertRaises(resolve_python_installer.ResolvePythonInstallError) as raised:
                resolve_python_installer._download_installer(self.cache)

        self.assertIn("일치하지 않습니다", str(raised.exception))
        self.assertFalse(self.cache.exists())
        self.assertFalse(self.cache.with_name(self.cache.name + ".part").exists())

    def test_download_failure_reports_network_guidance(self):
        with mock.patch.object(
            resolve_python_installer, "urlopen", side_effect=OSError("no network")
        ):
            with self.assertRaises(resolve_python_installer.ResolvePythonInstallError) as raised:
                resolve_python_installer._download_installer(self.cache)

        self.assertIn("인터넷 연결", str(raised.exception))

    def test_launch_uses_passive_all_users_arguments(self):
        # 반자동 계약: 질문 없는 진행(/passive) + 모든 사용자 설치(InstallAllUsers=1).
        self.assertIn("/passive", resolve_python_installer._INSTALLER_ARGUMENTS)
        self.assertIn("InstallAllUsers=1", resolve_python_installer._INSTALLER_ARGUMENTS)
        with mock.patch.object(resolve_python_installer.os, "startfile", create=True) as start:
            resolve_python_installer._launch_installer(self.cache)

        start.assert_called_once_with(
            str(self.cache), arguments=resolve_python_installer._INSTALLER_ARGUMENTS
        )


if __name__ == "__main__":
    unittest.main()
