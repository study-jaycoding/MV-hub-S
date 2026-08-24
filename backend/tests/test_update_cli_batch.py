"""update_cli.bat 계약 — "설치했다고 착각"하지 않는다.

이 업데이터는 pin(hf_cli_version.txt)과 **실제로 실행되는 CLI**가 같을 때만 0을 반환해야
한다. 예전에는 npm 이 실패해도, 설치 후 버전이 그대로여도 항상 0 이라 "맞춰졌다"고 착각했다.

가짜 `higgsfield.cmd`·`npm.cmd` 로만 검증한다 — 실제 CLI·npm·네트워크·유료 호출 없음.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE_BAT = REPO_ROOT / "update_cli.bat"
PIN = "1.1.23"

SYSTEM32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"


@unittest.skipUnless(os.name == "nt", "Windows 전용 런처 계약")
class UpdateCliBatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        (self.repo / "update_cli.bat").write_bytes(SOURCE_BAT.read_bytes())
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.installed = self.bin / "installed_version.txt"
        self.npm_marker = self.root / "npm_called.txt"

    def tearDown(self):
        self.tmp.cleanup()

    # ── 준비 도구 ────────────────────────────────────────────────────────────
    def _write_pin(self, value: str | None) -> None:
        if value is None:
            return
        (self.repo / "hf_cli_version.txt").write_text(value, encoding="utf-8")

    def _fake_cli(self, version: str | None) -> None:
        """version=None 이면 CLI 자체를 설치하지 않은 상태."""
        if version is None:
            return
        self.installed.write_text(version, encoding="ascii")
        (self.bin / "higgsfield.cmd").write_text(
            "@echo off\r\n"
            f'set /p V=<"{self.installed}"\r\n'
            "echo higgsfield %V%\r\n"
            "exit /b 0\r\n",
            encoding="ascii",
        )

    def _fake_npm(self, *, succeeds: bool, installs: str | None) -> None:
        lines = ["@echo off", f'echo called >"{self.npm_marker}"']
        if installs is not None:
            # 설치 성공을 흉내: 버전 파일과 CLI 자체를 만들어 둔다.
            lines.append(f'echo {installs}>"{self.installed}"')
            lines.append(
                f'echo @echo off>"{self.bin / "higgsfield.cmd"}"'
            )
            lines.append(
                f'echo set /p V^=^<"{self.installed}">>"{self.bin / "higgsfield.cmd"}"'
            )
            lines.append(
                f'echo echo higgsfield %%V%%>>"{self.bin / "higgsfield.cmd"}"'
            )
        lines.append("exit /b 0" if succeeds else "exit /b 1")
        (self.bin / "npm.cmd").write_text("\r\n".join(lines) + "\r\n", encoding="ascii")

    def _run(self) -> subprocess.CompletedProcess:
        env = os.environ.copy()
        env["PATH"] = f"{self.bin};{SYSTEM32}"
        return subprocess.run(
            ["cmd", "/c", str(self.repo / "update_cli.bat"), "nopause"],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )

    # ── 계약 ────────────────────────────────────────────────────────────────
    def test_already_pinned_succeeds_without_touching_npm(self):
        """오프라인 내성: 이미 pin 과 같으면 npm·네트워크를 건드리지 않는다."""
        self._write_pin(PIN)
        self._fake_cli(PIN)
        self._fake_npm(succeeds=False, installs=None)
        result = self._run()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(self.npm_marker.exists(), "npm 을 부르지 말았어야 한다")

    def test_install_that_changes_nothing_fails(self):
        """npm 이 0 을 반환해도 실제 버전이 그대로면 실패다."""
        self._write_pin(PIN)
        self._fake_cli("1.1.2")
        self._fake_npm(succeeds=True, installs=None)
        result = self._run()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertTrue(self.npm_marker.exists())

    def test_successful_install_is_verified_and_succeeds(self):
        self._write_pin(PIN)
        self._fake_cli("1.1.2")
        self._fake_npm(succeeds=True, installs=PIN)
        result = self._run()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_failed_install_fails(self):
        self._write_pin(PIN)
        self._fake_cli("1.1.2")
        self._fake_npm(succeeds=False, installs=None)
        result = self._run()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)

    def test_missing_cli_and_no_npm_fails(self):
        self._write_pin(PIN)
        self._fake_cli(None)
        result = self._run()  # npm.cmd 자체가 없음
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)

    def test_missing_pin_refuses_unpinned_install(self):
        """pin 이 없으면 버전 없이 설치하지 않고 실패한다."""
        self._write_pin(None)
        self._fake_cli("1.1.2")
        self._fake_npm(succeeds=True, installs=PIN)
        result = self._run()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertFalse(self.npm_marker.exists(), "pin 없이 설치를 시도하면 안 된다")

    def test_empty_pin_refuses_unpinned_install(self):
        self._write_pin("   \r\n")
        self._fake_cli("1.1.2")
        self._fake_npm(succeeds=True, installs=PIN)
        result = self._run()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertFalse(self.npm_marker.exists())


class UpdateCliSourceTests(unittest.TestCase):
    """.bat 본문은 ASCII 만 — 한글이 들어가면 CP949 PC 에서 파싱이 깨진다."""

    def test_source_is_ascii_only(self):
        raw = SOURCE_BAT.read_bytes()
        try:
            raw.decode("ascii")
        except UnicodeDecodeError as exc:  # pragma: no cover - 실패 시 진단용
            self.fail(f"update_cli.bat 에 비 ASCII 문자가 있다: {exc}")

    def test_never_installs_unpinned(self):
        source = SOURCE_BAT.read_text("ascii")
        self.assertNotIn("@higgsfield/cli\n", source)
        self.assertNotIn("@higgsfield/cli ", source)
        self.assertIn("@higgsfield/cli@%HF_CLI_VERSION%", source)


if __name__ == "__main__":
    unittest.main()
