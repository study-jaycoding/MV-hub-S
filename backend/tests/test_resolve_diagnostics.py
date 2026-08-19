"""Resolve 환경 진단이 설치와 실제 사용 가능 상태를 구분하는지 검증한다."""

from __future__ import annotations

import unittest

from app.services.resolve_diagnostics import build_resolve_diagnostics


def _script(**overrides):
    value = {
        "installed": True,
        "up_to_date": True,
        "all_users_installed": True,
        "path": r"C:\ProgramData\Blackmagic Design\MVHub Clip Exporter.py",
    }
    value.update(overrides)
    return value


def _connection(**overrides):
    value = {
        "status": "ready",
        "connected": True,
        "message": "DaVinci Resolve 연결됨 · 편집 프로젝트",
    }
    value.update(overrides)
    return value


def _environment(**overrides):
    value = {
        "resolve_installations": [
            {
                "path": r"C:\Program Files\Blackmagic Design\DaVinci Resolve",
                "version": "21.0.4",
            }
        ],
        "system_pythons": [
            {
                "scope": "all_users",
                "version": "3.11",
                "bits": 64,
                "path": r"C:\Python311\python.exe",
                "resolve_menu_compatible": True,
            }
        ],
        "api": {
            "existing_module_paths": [r"C:\Resolve API\DaVinciResolveScript.py"],
            "library_path": r"C:\Resolve\fusionscript.dll",
        },
    }
    value.update(overrides)
    return value


class ResolveDiagnosticsTests(unittest.TestCase):
    def test_connected_environment_is_ready(self):
        result = build_resolve_diagnostics(_script(), _connection(), _environment())

        self.assertEqual(result["status"], "ready")
        self.assertIn("자동 연결", result["summary"])
        self.assertTrue(all(check["state"] != "error" for check in result["checks"]))

    def test_menu_ready_is_distinct_from_external_connection(self):
        result = build_resolve_diagnostics(
            _script(),
            _connection(
                status="api_unavailable",
                connected=False,
                message="외부 연결을 사용할 수 없습니다",
            ),
            _environment(),
        )

        self.assertEqual(result["status"], "menu_ready")
        self.assertIn("사용 조건", result["summary"])

    def test_current_user_python_keeps_menu_available_but_warns_about_other_accounts(self):
        result = build_resolve_diagnostics(
            _script(),
            _connection(status="not_running", connected=False, message="Resolve 꺼짐"),
            _environment(
                system_pythons=[
                    {
                        "scope": "current_user",
                        "version": "3.11",
                        "bits": 64,
                        "path": r"C:\Users\me\Python311\python.exe",
                        "resolve_menu_compatible": True,
                    }
                ]
            ),
        )

        self.assertEqual(result["status"], "menu_ready")
        python_check = next(check for check in result["checks"] if check["key"] == "menu_python")
        self.assertEqual(python_check["state"], "warning")
        self.assertTrue(any("모든 사용자용" in item for item in result["recommendations"]))

    def test_missing_compatible_python_requires_action_when_connection_fails(self):
        result = build_resolve_diagnostics(
            _script(),
            _connection(status="not_running", connected=False, message="Resolve 꺼짐"),
            _environment(system_pythons=[]),
        )

        self.assertEqual(result["status"], "action_required")
        python_check = next(check for check in result["checks"] if check["key"] == "menu_python")
        self.assertEqual(python_check["state"], "warning")

    def test_missing_api_files_are_reported_separately(self):
        result = build_resolve_diagnostics(
            _script(),
            _connection(status="module_unavailable", connected=False, message="API 없음"),
            _environment(api={"existing_module_paths": [], "library_path": ""}),
        )

        states = {check["key"]: check["state"] for check in result["checks"]}
        self.assertEqual(states["api_module"], "error")
        self.assertEqual(states["api_library"], "error")


if __name__ == "__main__":
    unittest.main()
