"""Disk Project Library 목록과 안전한 프로젝트 전환을 검증한다."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from app.services import (
    resolve_library_list_worker,
    resolve_project_library,
    resolve_project_open_worker,
)


def _make_project(root: Path, relative: str, payload: bytes = b"db") -> Path:
    project_dir = root / "Resolve Projects" / "Users" / "guest" / "Projects" / relative
    project_dir.mkdir(parents=True)
    database = project_dir / "Project.db"
    database.write_bytes(payload)
    return database


class ResolveProjectLibraryTests(unittest.TestCase):
    def test_lists_project_databases_without_exposing_internal_folders(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp:
            root = Path(temp)
            first = _make_project(root, "Project A", b"first")
            second = _make_project(root, "Episodes/Project B", b"second")
            (first.parent / "CacheClip").mkdir()
            (root / "Resolve Projects" / "Settings").mkdir()
            first.touch()
            second.touch()

            projects = resolve_project_library.list_disk_projects(root)

        self.assertEqual({item["name"] for item in projects}, {"Project A", "Project B"})
        by_name = {item["name"]: item for item in projects}
        self.assertEqual(by_name["Project A"]["folder_path"], "")
        self.assertEqual(by_name["Project B"]["folder_path"], "Episodes")
        self.assertEqual(by_name["Project B"]["size"], len(b"second"))

    def test_missing_resolve_projects_folder_is_actionable(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp:
            with self.assertRaisesRegex(
                resolve_project_library.ResolveProjectLibraryError,
                "사용자 프로젝트 폴더",
            ):
                resolve_project_library.list_disk_projects(Path(temp))

    def test_reparse_projects_root_is_rejected(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp:
            root = Path(temp)
            projects = root / "Resolve Projects" / "Users" / "guest" / "Projects"
            projects.mkdir(parents=True)
            with (
                mock.patch.object(
                    resolve_project_library,
                    "_is_reparse_or_symlink",
                    return_value=True,
                ),
                self.assertRaises(resolve_project_library.ResolveProjectLibraryError),
            ):
                resolve_project_library.list_disk_projects(root)

    def test_open_validates_disk_entry_before_calling_resolve(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp:
            root = Path(temp)
            _make_project(root, "Episodes/Project B")
            completed = {
                "status": "complete",
                "project_name": "Project B",
                "already_open": False,
                "message": "열었습니다.",
            }
            with (
                mock.patch.object(resolve_project_library, "registered_library_name", return_value=None),
                mock.patch.object(
                    resolve_project_library,
                    "run_resolve_project_open_isolated",
                    return_value=completed,
                ) as run,
            ):
                result = resolve_project_library.open_disk_project(
                    root,
                    "뻘뻘뻘",
                    "Project B",
                    "Episodes",
                )

        # 등록 파일을 못 읽으면(None) 우리가 연결할 때 쓰는 이름으로 찾는다.
        expected_library_name = resolve_project_library.library_name_for_project(
            "뻘뻘뻘", root
        )
        run.assert_called_once_with(
            {
                "library_name": expected_library_name,
                "project_name": "Project B",
                "folder_parts": ["Episodes"],
            },
            launch_id="",  # Resolve 를 켜지 않은 열기
        )
        self.assertEqual(result["library_name"], expected_library_name)

    def test_open_uses_the_name_resolve_registered_for_this_folder(self):
        # 2026-09-22 실측: Resolve 에는 `MVHub - 뻘뻘뻘`(해시 없는 옛 이름)로 등록돼 있었고,
        # 앱은 해시 붙은 이름만 찾아 "연결되지 않았습니다" → 다시 연결하면 "Choose a unique path".
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp:
            root = Path(temp)
            _make_project(root, "Project B")
            completed = {"status": "complete", "project_name": "Project B", "message": "열었습니다."}
            with (
                mock.patch.object(
                    resolve_project_library, "registered_library_name", return_value="MVHub - 뻘뻘뻘"
                ) as lookup,
                mock.patch.object(
                    resolve_project_library, "run_resolve_project_open_isolated", return_value=completed
                ) as run,
            ):
                result = resolve_project_library.open_disk_project(root, "뻘뻘뻘", "Project B", "")

        lookup.assert_called_once_with(root)
        self.assertEqual(run.call_args.args[0]["library_name"], "MVHub - 뻘뻘뻘")
        self.assertEqual(result["library_name"], "MVHub - 뻘뻘뻘")

    def test_open_rejects_project_not_present_on_disk(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp:
            root = Path(temp)
            _make_project(root, "Project A")
            with (
                mock.patch.object(
                    resolve_project_library,
                    "run_resolve_project_open_isolated",
                ) as run,
                self.assertRaisesRegex(
                    resolve_project_library.ResolveProjectLibraryError,
                    "찾지 못했습니다",
                ),
            ):
                resolve_project_library.open_disk_project(
                    root,
                    "뻘뻘뻘",
                    "Project B",
                    "",
                )

        run.assert_not_called()


class _FakeFolder:
    def __init__(self, clips=(), folders=()):
        self.clips, self.folders = list(clips), list(folders)

    def GetClipList(self):
        return self.clips

    def GetSubFolderList(self):
        return self.folders


class _FakeMediaPool:
    def __init__(self, root: _FakeFolder):
        self.root = root

    def GetRootFolder(self):
        return self.root


class _FakeProject:
    def __init__(self, name: str, *, uid: str = "", timelines: int = 0, clips=(), folders=()):
        self.name = name
        self.uid = uid or f"id-{name}"
        self.timelines = timelines
        self.pool = _FakeMediaPool(_FakeFolder(clips, folders))

    def GetName(self):
        return self.name

    def GetUniqueId(self):
        return self.uid

    def GetTimelineCount(self):
        return self.timelines

    def GetMediaPool(self):
        return self.pool


class _FakeProjectManager:
    def __init__(self):
        self.databases = [
            {"DbType": "Disk", "DbName": "Other"},
            {"DbType": "Disk", "DbName": "MVHub - 뻘뻘뻘"},
        ]
        self.current_database = self.databases[0]
        self.current_project = _FakeProject("Current")
        self.saved = 0
        self.closed: list[str] = []  # CloseProject 가 불렸는지(불리면 안 된다)
        self.selected_database = None
        self.opened_folders: list[str] = []
        self.loaded = ""
        self.events: list[str] = []  # 부른 차례 — 판단·저장이 닫기 바로 앞인지 본다

    def CloseProject(self, project):
        self.closed.append(project.GetUniqueId())
        return True

    def GetDatabaseList(self):
        return self.databases

    def GetCurrentDatabase(self):
        return self.current_database

    def GetCurrentProject(self):
        return self.current_project

    def SaveProject(self):
        self.events.append("save")
        self.saved += 1
        return True

    def SetCurrentDatabase(self, database):
        self.events.append("switch")
        self.selected_database = database
        self.current_database = database
        self.current_project = None  # 21.1 설명서: 열린 프로젝트를 닫는다
        return True

    def GotoRootFolder(self):
        self.events.append("root")
        return True

    def OpenFolder(self, name):
        self.events.append(f"folder:{name}")
        self.opened_folders.append(name)
        return True

    def GetProjectListInCurrentFolder(self):
        self.events.append("list")
        return ["Target"]

    def LoadProject(self, name):
        self.events.append("load")
        self.loaded = name
        return _FakeProject(name)


class ResolveProjectOpenWorkerTests(unittest.TestCase):
    def test_saves_current_project_then_switches_library_and_loads_target(self):
        manager = _FakeProjectManager()
        resolve = mock.Mock()
        resolve.GetProjectManager.return_value = manager

        with mock.patch.object(resolve_project_open_worker, "_connect_resolve", return_value=resolve):
            result = resolve_project_open_worker.open_project(
                {
                    "library_name": "MVHub - 뻘뻘뻘",
                    "project_name": "Target",
                    "folder_parts": ["Episodes"],
                }
            )

        self.assertEqual(result["status"], "complete")
        self.assertEqual(manager.saved, 1)
        self.assertEqual(manager.selected_database["DbName"], "MVHub - 뻘뻘뻘")
        self.assertEqual(manager.opened_folders, ["Episodes"])
        self.assertEqual(manager.loaded, "Target")

    def test_missing_connected_library_does_not_save_or_switch(self):
        manager = _FakeProjectManager()
        resolve = mock.Mock()
        resolve.GetProjectManager.return_value = manager

        with mock.patch.object(resolve_project_open_worker, "_connect_resolve", return_value=resolve):
            result = resolve_project_open_worker.open_project(
                {"library_name": "Missing", "project_name": "Target"}
            )

        self.assertEqual(result["error_code"], "library_not_connected")
        self.assertEqual(manager.saved, 0)
        self.assertIsNone(manager.selected_database)
        self.assertEqual(manager.loaded, "")

    # ── 이름 없는 빈 새 프로젝트(2026-09-22: SaveProject 가 이름 묻는 창을 띄우고 열기가 멈췄다) ──

    def _open_with(self, manager):
        resolve = mock.Mock()
        resolve.GetProjectManager.return_value = manager
        with mock.patch.object(resolve_project_open_worker, "_connect_resolve", return_value=resolve):
            return resolve_project_open_worker.open_project(
                {"library_name": "MVHub - 뻘뻘뻘", "project_name": "Target"}
            )

    def _nothing_changed(self, manager):
        self.assertEqual(manager.saved, 0)
        self.assertEqual(manager.closed, [])
        self.assertIsNone(manager.selected_database)
        self.assertEqual(manager.loaded, "")

    def test_untitled_empty_project_opens_without_asking_saving_or_closing(self):
        # Jay 2026-09-22 — 묻지 않는다(실제 Resolve 로 확인: 저장 창 없이 5.3초에 전환). SaveProject 를 부르면
        # 이름 창이 뜨고, CloseProject 를 부르면 Resolve 가 새 Untitled 를 만들 수 있다(Codex P0) — 둘 다 안 부른다.
        manager = _FakeProjectManager()
        manager.current_project = _FakeProject("Untitled Project", uid="u1")

        result = self._open_with(manager)

        self.assertEqual(result["status"], "complete")
        self.assertEqual(manager.saved, 0)
        self.assertEqual(manager.closed, [])
        self.assertEqual(manager.selected_database["DbName"], "MVHub - 뻘뻘뻘")
        self.assertEqual(manager.loaded, "Target")

    def test_named_empty_project_is_saved_not_closed(self):
        # Codex P0: 타임라인·클립이 없어도 설정을 바꿨을 수 있다 — 이름 있는 프로젝트는 늘 저장한다.
        manager = _FakeProjectManager()
        manager.current_project = _FakeProject("Episode 1", uid="e1")

        result = self._open_with(manager)

        self.assertEqual(result["status"], "complete")
        self.assertEqual(manager.saved, 1)
        self.assertEqual(manager.closed, [])

    def test_untitled_project_with_work_is_neither_saved_nor_closed(self):
        for label, project in (
            ("타임라인", _FakeProject("Untitled Project", uid="u1", timelines=1)),
            ("클립", _FakeProject("Untitled Project", uid="u1", clips=["clip"])),
            ("폴더", _FakeProject("Untitled Project", uid="u1", folders=["bin"])),
        ):
            with self.subTest(label):
                manager = _FakeProjectManager()
                manager.current_project = project
                result = self._open_with(manager)
                self.assertEqual(result["error_code"], "untitled_unsaved")
                self._nothing_changed(manager)

    def test_only_resolves_own_untitled_names_count(self):
        # Codex P1 — 사람이 붙인 'Untitled Project 테스트' 는 이름 있는 프로젝트라 저장한다.
        for name, saved in (("Untitled Project 2", 0), ("Untitled Project 테스트", 1)):
            with self.subTest(name=name):
                manager = _FakeProjectManager()
                manager.current_project = _FakeProject(name)
                self.assertEqual(self._open_with(manager)["status"], "complete")
                self.assertEqual(manager.saved, saved)

    def test_decision_and_save_come_right_before_the_closing_call(self):
        # Codex P1 — 판단·저장과 닫기(다른 라이브러리면 SetCurrentDatabase, 같으면 LoadProject) 사이에 다른 호출이 없다.
        # 그래야 그 사이에 생긴 작업이 버려지거나 저장에서 빠지지 않는다.
        cases = (
            ("빈 새 프로젝트 · 다른 라이브러리", "Untitled Project", False, ["check", "switch", "root", "list", "load"]),
            ("빈 새 프로젝트 · 같은 라이브러리", "Untitled Project", True, ["root", "list", "check", "load"]),
            ("이름 있는 프로젝트 · 다른 라이브러리", "Episode 1", False, ["save", "switch", "root", "list", "load"]),
            ("이름 있는 프로젝트 · 같은 라이브러리", "Episode 1", True, ["root", "list", "save", "load"]),
        )
        for label, name, same_library, expected in cases:
            with self.subTest(label):
                manager = _FakeProjectManager()
                if same_library:
                    manager.current_database = manager.databases[1]
                project = _FakeProject(name)
                project.GetTimelineCount = lambda m=manager: m.events.append("check") or 0
                manager.current_project = project

                result = self._open_with(manager)

                self.assertEqual(result["status"], "complete")
                self.assertEqual(manager.events, expected)

    def test_missing_target_in_the_same_library_saves_nothing(self):
        # 대상을 못 찾으면 닫기에 닿지 않으니 저장도 하지 않는다(판단·저장이 닫기 바로 앞이라 생긴 이점).
        manager = _FakeProjectManager()
        manager.current_database = manager.databases[1]
        manager.current_project = _FakeProject("Episode 1")
        resolve = mock.Mock()
        resolve.GetProjectManager.return_value = manager
        with mock.patch.object(resolve_project_open_worker, "_connect_resolve", return_value=resolve):
            result = resolve_project_open_worker.open_project({"library_name": "MVHub - 뻘뻘뻘", "project_name": "Missing"})

        self.assertEqual(result["error_code"], "project_missing")
        self.assertEqual(manager.saved, 0)
        self.assertEqual(manager.loaded, "")

    def test_emptiness_check_failure_counts_as_not_empty(self):
        manager = _FakeProjectManager()
        broken = _FakeProject("Untitled Project", uid="u1")
        broken.GetTimelineCount = mock.Mock(side_effect=RuntimeError("API 멈춤"))
        manager.current_project = broken

        result = self._open_with(manager)

        self.assertEqual(result["error_code"], "untitled_unsaved")
        self._nothing_changed(manager)

    def test_same_named_current_project_is_reloaded_from_selected_folder(self):
        manager = _FakeProjectManager()
        manager.current_database = manager.databases[1]
        manager.current_project = _FakeProject("Target")
        resolve = mock.Mock()
        resolve.GetProjectManager.return_value = manager

        with mock.patch.object(resolve_project_open_worker, "_connect_resolve", return_value=resolve):
            result = resolve_project_open_worker.open_project(
                {
                    "library_name": "MVHub - 뻘뻘뻘",
                    "project_name": "Target",
                }
            )

        self.assertFalse(result["already_open"])
        self.assertEqual(manager.saved, 1)
        self.assertIsNone(manager.selected_database)
        self.assertEqual(manager.loaded, "Target")


class ResolveLibraryListWorkerTests(unittest.TestCase):
    def test_lists_only_disk_library_names(self):
        manager = _FakeProjectManager()
        manager.databases.append({"DbType": "PostgreSQL", "DbName": "Server"})
        manager.databases.append({"DbType": "Disk", "DbName": ""})
        resolve = mock.Mock()
        resolve.GetProjectManager.return_value = manager

        with mock.patch.object(resolve_library_list_worker, "_connect_resolve", return_value=resolve):
            result = resolve_library_list_worker.list_disk_library_names()

        self.assertEqual(result, {"status": "complete", "names": ["Other", "MVHub - 뻘뻘뻘"]})

    def test_bridge_error_is_reported_not_raised(self):
        error = resolve_library_list_worker.ResolveBridgeError("꺼짐", code="not_running")
        with mock.patch.object(resolve_library_list_worker, "_connect_resolve", side_effect=error):
            result = resolve_library_list_worker.list_disk_library_names()

        self.assertEqual(result, {"status": "failed", "error_code": "not_running", "names": []})


if __name__ == "__main__":
    unittest.main()
