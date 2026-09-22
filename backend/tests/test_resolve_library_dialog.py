"""Resolve Project Library 연결 창 자동화의 안전 경계를 검증한다."""

from __future__ import annotations

import asyncio
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

from app.routers import assets
from app.services import resolve_library_dialog


class ResolveLibraryDialogTests(unittest.TestCase):
    def test_library_name_is_short_and_removes_windows_path_characters(self):
        name = resolve_library_dialog.library_name_for_project('MUDX:10_ai/본편?*')

        self.assertEqual(name, "MVHub - MUDX_10_ai_본편")
        self.assertLessEqual(len(name), 100)

    def test_requires_resolve_projects_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            with (
                mock.patch.object(resolve_library_dialog.os, "name", "nt"),
                self.assertRaisesRegex(
                    resolve_library_dialog.ResolveLibraryDialogError,
                    "Resolve Projects",
                ),
            ):
                resolve_library_dialog.open_library_connect_dialog(
                    Path(temp), "MUDX"
                )

    def _press(self, root, *, registered, names=None, automation=None, project="뻘뻘뻘"):
        """registered: registered_library_name 이 차례로 돌려줄 값(누르기 전, 누른 뒤).
        names: Resolve API 목록 — 하나면 매번 같은 답, list 면 차례로."""
        automation = automation or {"return_value": {"ok": True, "message": "눌렀음", "process_id": 1}}
        answers = {"side_effect": list(names)} if isinstance(names, list) else {"return_value": names}
        with (
            mock.patch.object(resolve_library_dialog.os, "name", "nt"),
            mock.patch.object(resolve_library_dialog, "_CONFIRM_DELAY_SECONDS", 0),
            mock.patch.object(
                resolve_library_dialog, "registered_library_name", side_effect=list(registered)
            ) as lookup,
            mock.patch.object(
                resolve_library_dialog, "_resolve_disk_library_names", **answers
            ) as api_names,
            mock.patch.object(resolve_library_dialog, "_run_automation", **automation) as run,
        ):
            try:
                return resolve_library_dialog.open_library_connect_dialog(root, project), run, lookup, api_names
            except resolve_library_dialog.ResolveLibraryDialogError as exc:
                return exc, run, lookup, api_names

    def _root(self, temp):
        root = Path(temp)
        (root / "Resolve Projects").mkdir()
        return root

    def test_unregistered_library_is_pressed_and_confirmed_through_resolve(self):
        with tempfile.TemporaryDirectory() as temp:
            root = self._root(temp)
            name = resolve_library_dialog.library_name_for_project("뻘뻘뻘", root)
            result, run, _lookup, api_names = self._press(root, registered=["", ""], names={name})

        run.assert_called_once_with(root, name)
        api_names.assert_called_once()
        self.assertTrue(result["connected"])
        self.assertFalse(result["already_connected"])
        self.assertEqual(result["library_name"], name)
        self.assertEqual(result["library_path"], str(root))

    def test_already_registered_folder_does_not_open_the_dialog(self):
        # 2026-09-22 실측: 해시가 붙기 전 이름으로 이미 등록돼 있었고, 다시 연결하면
        # Resolve 가 "Choose a unique path" 로 거절했다 — 창을 아예 열지 않아야 한다.
        with tempfile.TemporaryDirectory() as temp:
            root = self._root(temp)
            result, run, _lookup, api_names = self._press(root, registered=["MVHub - 뻘뻘뻘"])

        run.assert_not_called()
        api_names.assert_not_called()
        self.assertTrue(result["already_connected"])
        self.assertEqual(result["library_name"], "MVHub - 뻘뻘뻘")
        self.assertIn("이미 연결돼 있습니다", result["message"])

    def test_dialog_closed_but_resolve_did_not_register_is_a_failure(self):
        # Codex P1: Resolve 가 연결 창을 닫고 따로 'Cannot Connect' 창을 띄울 수 있다 —
        # 창이 닫힌 것만으로 성공이라 하지 않는다.
        with tempfile.TemporaryDirectory() as temp:
            root = self._root(temp)
            result, _run, _lookup, _api = self._press(root, registered=["", ""], names={"FUSION"})

        self.assertIsInstance(result, resolve_library_dialog.ResolveLibraryDialogError)
        self.assertIn("등록되지 않았습니다", str(result))

    def test_unknown_resolve_list_is_not_reported_as_connected(self):
        # Codex 2차 P1: 목록을 끝내 못 읽으면 창 닫힘만 믿고 '연결됨'이라 하지 않는다.
        with tempfile.TemporaryDirectory() as temp:
            root = self._root(temp)
            result, run, _lookup, api_names = self._press(root, registered=[None, None], names=None)

        run.assert_called_once()
        self.assertEqual(api_names.call_count, resolve_library_dialog._CONFIRM_ATTEMPTS)
        self.assertIsInstance(result, resolve_library_dialog.ResolveLibraryDialogError)
        self.assertIn("확인하지 못했습니다", str(result))

    def test_late_resolve_list_is_asked_again_before_judging(self):
        # Codex 2차 P1: Connect 직후엔 목록 반영이 늦을 수 있다 — 한 번 못 보고 실패라 하지 않는다.
        with tempfile.TemporaryDirectory() as temp:
            root = self._root(temp)
            name = resolve_library_dialog.library_name_for_project("뻘뻘뻘", root)
            result, _run, _lookup, api_names = self._press(
                root, registered=["", ""], names=[{"FUSION"}, None, {"FUSION", name}]
            )

        self.assertEqual(api_names.call_count, 3)
        self.assertTrue(result["connected"])
        self.assertFalse(result["already_connected"])

    def test_success_is_judged_by_resolve_even_when_the_file_already_shows_our_name(self):
        # Codex 3차 P1: Connect 직후 파일을 바로 쓰는지는 확인 못 했다 — 성공 판정은 API 로만.
        with tempfile.TemporaryDirectory() as temp:
            root = self._root(temp)
            name = resolve_library_dialog.library_name_for_project("뻘뻘뻘", root)
            result, _run, _lookup, api_names = self._press(root, registered=["", name], names={"FUSION"})

        api_names.assert_called()
        self.assertIsInstance(result, resolve_library_dialog.ResolveLibraryDialogError)
        self.assertIn("등록되지 않았습니다", str(result))

    def test_rejection_with_our_own_name_registered_is_still_connected(self):
        # Codex 2차 P1: 거절당했어도 이 폴더가 우리 이름으로 등록돼 있으면 연결된 것이다.
        with tempfile.TemporaryDirectory() as temp:
            root = self._root(temp)
            name = resolve_library_dialog.library_name_for_project("뻘뻘뻘", root)
            refused = resolve_library_dialog.ResolveLibraryDialogError("연결 창이 닫히지 않았습니다.")
            result, _run, _lookup, api_names = self._press(
                root, registered=[None, name], automation={"side_effect": refused}
            )

        api_names.assert_not_called()
        self.assertTrue(result["connected"])
        self.assertTrue(result["already_connected"])
        self.assertEqual(result["library_name"], name)

    def test_rejection_by_an_existing_registration_reports_connected(self):
        # Codex P1: Resolve 가 꺼진 채 누르면 누르기 전에는 모른다. 자동화가 Resolve 를 켜면
        # Resolve 가 등록 파일을 새로 쓰므로, 거절 뒤 다시 보면 이미 등록돼 있음이 드러난다.
        with tempfile.TemporaryDirectory() as temp:
            root = self._root(temp)
            refused = resolve_library_dialog.ResolveLibraryDialogError("연결 창이 닫히지 않았습니다.")
            result, _run, lookup, api_names = self._press(
                root, registered=["", "MVHub - 뻘뻘뻘"], automation={"side_effect": refused}
            )

        self.assertEqual(lookup.call_count, 2)
        api_names.assert_not_called()
        self.assertTrue(result["already_connected"])
        self.assertIn("OK", result["message"])

    def test_rejection_without_a_registration_is_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = self._root(temp)
            refused = resolve_library_dialog.ResolveLibraryDialogError("연결 창이 닫히지 않았습니다.")
            result, _run, _lookup, _api = self._press(
                root, registered=["", ""], automation={"side_effect": refused}
            )

        self.assertIs(result, refused)

    def test_busy_resolve_neither_checks_nor_presses(self):
        # Codex P1: 확인과 연결은 한 임계 구역 — 다른 Resolve 작업 중이면 둘 다 하지 않는다.
        with tempfile.TemporaryDirectory() as temp:
            root = self._root(temp)
            with resolve_library_dialog.resolve_mutation_slot():
                result, run, lookup, _api = self._press(root, registered=[""])

        self.assertIn("다른 작업이 진행 중", str(result))
        lookup.assert_not_called()
        run.assert_not_called()

    def test_library_path_makes_sanitized_name_collision_impossible(self):
        first = resolve_library_dialog.library_name_for_project(
            "A/B", Path(r"Z:\one\@davinci")
        )
        second = resolve_library_dialog.library_name_for_project(
            "A:B", Path(r"Z:\two\@davinci")
        )

        self.assertNotEqual(first, second)
        self.assertLessEqual(len(first), 100)
        self.assertRegex(first, r" - [0-9a-f]{8}$")

    def test_path_and_name_are_passed_by_environment_not_command_text(self):
        payload = {"ok": True, "message": "준비됨", "process_id": 123}
        completed = subprocess.CompletedProcess(
            ["powershell.exe"],
            0,
            stdout=resolve_library_dialog._RESULT_PREFIX
            + json.dumps(payload, ensure_ascii=False)
            + "\n",
            stderr="",
        )
        path = Path(r"Z:\PROJECT_MUDX\10_ai\@davinci")
        with (
            mock.patch.object(resolve_library_dialog, "_resolve_executable", return_value=r"C:\Resolve.exe"),
            mock.patch.object(
                resolve_library_dialog.subprocess, "run", return_value=completed
            ) as run,
        ):
            result = resolve_library_dialog._run_automation(path, "MVHub - MUDX")

        command = run.call_args.args[0]
        env = run.call_args.kwargs["env"]
        self.assertNotIn(str(path), command)
        self.assertNotIn("MVHub - MUDX", command)
        self.assertEqual(env["MVHUB_LIBRARY_PATH"], str(path))
        self.assertEqual(env["MVHUB_LIBRARY_NAME"], "MVHub - MUDX")
        self.assertEqual(env["MVHUB_CLEANUP_ONLY"], "0")
        self.assertEqual(result, payload)

    def test_timeout_runs_owned_dialog_cleanup(self):
        path = Path(r"Z:\PROJECT_MUDX\10_ai\@davinci")
        with (
            mock.patch.object(resolve_library_dialog, "_resolve_executable", return_value=r"C:\Resolve.exe"),
            mock.patch.object(
                resolve_library_dialog.subprocess,
                "run",
                side_effect=[
                    subprocess.TimeoutExpired(["powershell.exe"], 80),
                    subprocess.CompletedProcess(["powershell.exe"], 0, "", ""),
                ],
            ) as run,
            self.assertRaisesRegex(
                resolve_library_dialog.ResolveLibraryDialogError,
                "시간이 초과",
            ),
        ):
            resolve_library_dialog._run_automation(path, "MVHub - MUDX")

        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args_list[1].kwargs["env"]["MVHUB_CLEANUP_ONLY"], "1")

    def test_automation_presses_connect_and_requires_the_dialog_to_close(self):
        # Jay 결정(2026-09-22): 마지막 Connect 까지 앱이 누른다. 대신 성공은 '창이 닫혔다'로만
        # 인정하고, 닫히지 않으면(Resolve 가 거절) 사람이 보도록 그 창을 닫지 않는다.
        script = resolve_library_dialog._POWERSHELL
        press = script.index("Invoke-Element $finalButton")
        wait = script.index("[MVHubResolveNative]::IsWindow($dialogHandle)", press)
        keep_open = script.index("$libraryDialogOpenedByMVHub = $false", wait)
        rejected = script.index("Connect 를 눌렀지만 Resolve 연결 창이 닫히지 않았습니다", keep_open)
        success = script.index('Write-Result $true "Resolve 라이브러리를 연결했습니다."', rejected)

        self.assertLess(script.index("$finalButton = Wait-ById $libraryDialog $FinalButtonId"), press)
        self.assertLess(script.index("if (-not $finalButton.Current.IsEnabled)"), press)
        self.assertLess(press, success)
        self.assertNotIn("최종 Connect 버튼은 사용자가 직접", script)
        # 거절 때는 연결 창을 품은 Project Manager 도 남긴다 — 부모를 닫으면 자식도 닫힌다.
        self.assertIn("$projectManagerOpenedByMVHub = $false", script[wait:rejected])
        # 성공 때 Project Manager 를 닫지 않는다 — Resolve 가 따로 띄운 오류 창을 가릴 수 있다.
        self.assertNotIn("Close-Window $projectManager", script[press:success])

    def test_existing_library_dialog_is_not_reused_or_overwritten(self):
        script = resolve_library_dialog._POWERSHELL

        self.assertIn("$existingLibraryDialog = Find-TopWindow", script)
        self.assertIn("이미 Add Project Library 창이 열려 있습니다", script)
        self.assertNotIn("if ($null -eq $libraryDialog) {", script)

    def test_automation_cleans_up_only_windows_it_opened(self):
        script = resolve_library_dialog._POWERSHELL

        self.assertIn("$libraryDialogOpenedByMVHub = $false", script)
        self.assertIn("if ($libraryDialogOpenedByMVHub) {", script)
        self.assertIn("if ($projectManagerOpenedByMVHub) { Close-Window $projectManager }", script)
        self.assertIn("Close-NativeWindow $folderDialogHandle", script)
        self.assertIn("Find-NativeFolderDialogHandle $libraryDialog", script)
        self.assertIn("Close-NativeWindow $cleanupFolderHandle", script)
        self.assertIn('$env:MVHUB_CLEANUP_ONLY -eq "1"', script)

    def test_windows_paths_are_compared_case_insensitively_after_normalization(self):
        script = resolve_library_dialog._POWERSHELL

        self.assertIn("function Test-SameWindowsPath", script)
        self.assertIn("[System.StringComparison]::OrdinalIgnoreCase", script)
        self.assertIn("Test-SameWindowsPath $location.Current.Name", script)


SAMPLE_DBLIST = (
    "Local Database:C\\Users\\me\\AppData\\Roaming\\Blackmagic Design\\DaVinci Resolve"
    "\\Support\\Resolve Project Library::::DISK\r\n"
    "FUSION:D\\Fusion:*:::DISK\r\n"
    "MVHub - 뻘뻘뻘:\\\\nas\\share\\PROJECT_MUDX\\10_ai\\@davinci::::DISK\r\n"
)


class ResolveRegisteredLibraryTests(unittest.TestCase):
    """dblist.conf 를 경로로 대조한다 — 형식은 2026-09-22 이 PC 의 실제 파일에서 옮겼다."""

    def _lookup(self, root, content=SAMPLE_DBLIST):
        with tempfile.TemporaryDirectory() as temp:
            dblist = Path(temp) / "dblist.conf"
            if content is not None:
                dblist.write_bytes(content.encode("utf-8"))
            with mock.patch.object(resolve_library_dialog, "_dblist_path", return_value=dblist):
                return resolve_library_dialog.registered_library_name(Path(root))

    def test_unc_folder_is_found_by_path_whatever_its_name(self):
        self.assertEqual(self._lookup(r"\\nas\share\PROJECT_MUDX\10_ai\@davinci"), "MVHub - 뻘뻘뻘")

    def test_case_trailing_separator_and_slashes_do_not_matter(self):
        for root in (
            r"\\NAS\SHARE\project_mudx\10_ai\@DAVINCI",
            "\\\\nas\\share\\PROJECT_MUDX\\10_ai\\@davinci\\",
            "//nas/share/PROJECT_MUDX/10_ai/@davinci",
        ):
            with self.subTest(root=root):
                self.assertEqual(self._lookup(root), "MVHub - 뻘뻘뻘")

    def test_drive_letter_colon_is_restored_before_comparing(self):
        self.assertEqual(self._lookup(r"D:\Fusion"), "FUSION")

    def test_unregistered_folder_is_known_absent(self):
        self.assertEqual(self._lookup(r"\\nas\share\OTHER\@davinci"), "")

    def test_missing_or_unreadable_file_is_unknown(self):
        self.assertIsNone(self._lookup(r"D:\Fusion", content=None))
        self.assertIsNone(self._lookup(r"D:\Fusion", content="이건 설정 파일이 아니다\r\n"))

    def test_utf8_bom_does_not_stick_to_the_first_name(self):
        content = "\ufeff" + "FUSION:D\\Fusion:*:::DISK\r\n"
        self.assertEqual(self._lookup(r"D:\Fusion", content), "FUSION")

    def test_a_disk_line_in_an_unknown_shape_makes_the_answer_unknown(self):
        # Codex 2차 P2: 이름에 ':' 가 들었거나 형식이 바뀐 줄이 우리 것일 수 있다 — '미등록'이라 단정 않는다.
        content = SAMPLE_DBLIST + "Odd:Name:C:\\x::::DISK\r\n"
        self.assertIsNone(self._lookup(r"\\nas\share\OTHER\@davinci", content))
        # 알아볼 수 있는 줄에서 찾으면 그대로 답한다.
        self.assertEqual(self._lookup(r"\\nas\share\PROJECT_MUDX\10_ai\@davinci", content), "MVHub - 뻘뻘뻘")

    def test_network_drive_and_unc_forms_of_the_same_folder_match(self):
        # Codex 2차 P1: 네트워크 드라이브(Z:)가 NAS 공유(UNC)에 걸린 PC — 앱이 Z: 로 적어도 찾아야 한다.
        def fake_unc(path):
            return path.replace("Z:", r"\\nas\share", 1) if path[:2].upper() == "Z:" else path

        with mock.patch.object(resolve_library_dialog, "unc_for_drive", side_effect=fake_unc):
            self.assertEqual(self._lookup(r"Z:\PROJECT_MUDX\10_ai\@davinci"), "MVHub - 뻘뻘뻘")
            content = "MVHub - 뻘뻘뻘:Z\\PROJECT_MUDX\\10_ai\\@davinci::::DISK\r\n"
            self.assertEqual(self._lookup(r"\\nas\share\PROJECT_MUDX\10_ai\@davinci", content), "MVHub - 뻘뻘뻘")
        # 드라이브 대응을 모르면(None) 적힌 그대로 견준다 — 종전 동작.
        with mock.patch.object(resolve_library_dialog, "unc_for_drive", return_value=None):
            self.assertEqual(self._lookup(r"\\nas\share\PROJECT_MUDX\10_ai\@davinci"), "MVHub - 뻘뻘뻘")

    def test_non_disk_libraries_are_ignored(self):
        content = SAMPLE_DBLIST + "Server:10.0.0.5:5432:resolve:user:PostgreSQL\r\n"
        self.assertEqual(self._lookup(r"\\nas\share\PROJECT_MUDX\10_ai\@davinci", content), "MVHub - 뻘뻘뻘")
        self.assertEqual(self._lookup("10.0.0.5", content), "")


class ResolveLibraryAssetsRouteTests(unittest.TestCase):
    def test_route_only_accepts_project_root_davinci_folder(self):
        body = assets.ResolveLibraryDialogIn(project="MUDX", dir="work/@davinci")
        with (
            mock.patch.object(assets, "require_loopback_browser_request"),
            self.assertRaises(HTTPException) as raised,
        ):
            asyncio.run(assets.open_resolve_library_connect_dialog(body, mock.Mock()))

        self.assertEqual(raised.exception.status_code, 400)

    def test_route_resolves_davinci_inside_selected_asset_project(self):
        body = assets.ResolveLibraryDialogIn(project="MUDX", dir="@davinci")
        project_root = Path(r"Z:\PROJECT_MUDX\10_ai")
        target = project_root / "@davinci"
        expected = {"ok": True, "message": "준비됨"}
        with (
            mock.patch.object(assets, "require_loopback_browser_request"),
            mock.patch.object(assets, "_safe_project_dir", return_value=project_root),
            mock.patch.object(assets, "_safe_project_resolve", return_value=target) as safe,
            mock.patch.object(
                assets.resolve_library_dialog,
                "open_library_connect_dialog",
                return_value=expected,
            ) as open_dialog,
        ):
            result = asyncio.run(
                assets.open_resolve_library_connect_dialog(body, mock.Mock())
            )

        safe.assert_called_once_with("MUDX", project_root, "@davinci")
        open_dialog.assert_called_once_with(target, "MUDX")
        self.assertEqual(result, expected)

    def test_project_list_route_uses_selected_davinci_root(self):
        target = Path(r"Z:\PROJECT_MUDX\10_ai\@davinci")
        expected = [{"name": "Project A", "folder_path": "", "mtime": 1.0, "size": 2}]
        # 등록 조회는 가짜로 고정한다 — 진짜 dblist.conf 를 읽으면 PC 마다 답이 다르다
        # (이 PC 는 Z: 가 Jay 라이브러리가 걸린 공유라 실제 등록 이름이 나왔다).
        for registered, library_name in (
            (None, resolve_library_dialog.library_name_for_project("뻘뻘뻘", target)),
            ("MVHub - 뻘뻘뻘", "MVHub - 뻘뻘뻘"),  # Resolve 에 실제로 걸린 이름을 화면에 준다
        ):
            with (
                self.subTest(registered=registered),
                mock.patch.object(assets, "_resolve_davinci_root", return_value=target) as resolve_root,
                mock.patch.object(
                    assets.resolve_project_library, "list_disk_projects", return_value=expected
                ) as list_projects,
                mock.patch.object(
                    assets.resolve_library_dialog, "registered_library_name", return_value=registered
                ),
            ):
                result = assets.list_resolve_library_projects(
                    mock.Mock(), project="뻘뻘뻘", dir="@davinci"
                )

                resolve_root.assert_called_once_with("뻘뻘뻘", "@davinci", mock.ANY)
                list_projects.assert_called_once_with(target)
                self.assertEqual(result["projects"], expected)
                self.assertEqual(result["library_name"], library_name)

    def test_project_open_route_normalizes_folder_and_keeps_loopback_guard(self):
        body = assets.ResolveProjectOpenIn(
            project="뻘뻘뻘",
            dir="@davinci",
            name="Project B",
            folder_path=r"Episodes\Part 1",
        )
        request = mock.Mock()
        target = Path(r"Z:\PROJECT_MUDX\10_ai\@davinci")
        expected = {"status": "complete", "message": "열었습니다."}
        with (
            mock.patch.object(assets, "require_loopback_browser_request") as guard,
            mock.patch.object(assets, "_resolve_davinci_root", return_value=target),
            mock.patch.object(
                assets.resolve_project_library,
                "open_disk_project",
                return_value=expected,
            ) as open_project,
        ):
            result = asyncio.run(assets.open_resolve_library_project(body, request))

        guard.assert_called_once_with(
            request, "Resolve 프로젝트 열기는 로컬 MV Hub에서만 사용할 수 있습니다"
        )
        open_project.assert_called_once_with(
            target,
            "뻘뻘뻘",
            "Project B",
            "Episodes/Part 1",
            "",  # Resolve 를 켜지 않았으니 켜기 번호도 없다
        )
        self.assertEqual(result, expected)


if __name__ == "__main__":
    unittest.main()
