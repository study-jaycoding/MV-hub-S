"""Resolve Media Pool 가져오기 — 계층·중복·복원 검증."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from app.services import resolve_bridge
from app.services.resolve_bridge import import_manifest_to_current_project


class FakeClip:
    def __init__(self, path: str):
        self.path = path

    def GetClipProperty(self, key=None):
        props = {"File Path": self.path, "Clip Name": Path(self.path).name}
        return props.get(key, "") if key else props


class FakeFolder:
    _next_id = 0

    def __init__(self, name: str):
        type(self)._next_id += 1
        self.unique_id = f"folder-{type(self)._next_id}"
        self.name = name
        self.children = []
        self.clips = []

    def GetName(self):
        return self.name

    def GetUniqueId(self):
        return self.unique_id

    def GetSubFolderList(self):
        return self.children

    def GetClipList(self):
        return self.clips


class FakeMediaPool:
    def __init__(self):
        self.root = FakeFolder("Master")
        self.current = self.root
        self.import_calls = []

    def GetRootFolder(self):
        return self.root

    def GetCurrentFolder(self):
        return self.current

    def SetCurrentFolder(self, folder):
        self.current = folder
        return True

    def AddSubFolder(self, parent, name):
        folder = FakeFolder(name)
        parent.children.append(folder)
        return folder

    def _parent_of(self, target, parent=None):
        parent = parent or self.root
        if target in parent.children:
            return parent
        for child in parent.children:
            found = self._parent_of(target, child)
            if found:
                return found
        return None

    def MoveFolders(self, folders, target):
        raise AssertionError("안전한 정렬은 MoveFolders를 호출하면 안 됩니다")

    def MoveClips(self, clips, target):
        for clip in clips:
            source = self._folder_containing_clip(clip)
            if source is None:
                return False
            source.clips.remove(clip)
            target.clips.append(clip)
        return True

    def _folder_containing_clip(self, target, folder=None):
        folder = folder or self.root
        if target in folder.clips:
            return folder
        for child in folder.children:
            found = self._folder_containing_clip(target, child)
            if found:
                return found
        return None

    def DeleteFolders(self, folders):
        for folder in folders:
            parent = self._parent_of(folder)
            if parent is None or folder.children or folder.clips:
                return False
            parent.children.remove(folder)
        return True

    def RefreshFolders(self):
        return True

    def ImportMedia(self, paths):
        self.import_calls.append(list(paths))
        clips = [FakeClip(path) for path in paths]
        self.current.clips.extend(clips)
        return clips


class FakeProject:
    def __init__(self, media_pool):
        self.media_pool = media_pool
        self.unique_id = "resolve-project-1"

    def GetName(self):
        return "임시 테스트"

    def GetUniqueId(self):
        return self.unique_id

    def GetMediaPool(self):
        return self.media_pool


class FakeProjectManager:
    def __init__(self, project):
        self.project = project
        self.saved = 0

    def GetCurrentProject(self):
        return self.project

    def SaveProject(self):
        self.saved += 1
        return True

    def ExportProject(self, _project_name, path, _with_stills):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_bytes(b"fake resolve backup")
        return True


class FakeResolve:
    def __init__(self, project_manager):
        self.project_manager = project_manager
        self.page = "media"
        self.opened_pages = []

    def GetProjectManager(self):
        return self.project_manager

    def GetCurrentPage(self):
        return self.page

    def OpenPage(self, page):
        self.page = page
        self.opened_pages.append(page)
        return True


class NormalPathUncTests(unittest.TestCase):
    """Z:↔UNC 표기 통일 — Resolve 가 UNC 로 기록한 클립과 Z: 로 보낸 원본이 같은 정규형이어야
    dedupe 가 맞고, 성공한 가져오기가 실패·중복으로 보고되지 않는다."""

    def setUp(self):
        resolve_bridge._DRIVE_UNC_CACHE.clear()

    def tearDown(self):
        resolve_bridge._DRIVE_UNC_CACHE.clear()

    def test_mapped_drive_and_unc_normalize_to_same_path(self):
        # 실제 매핑이 있을 수 없는 드라이브 문자(Q:)를 쓴다 — 실존 매핑(Z: 등)은
        # Path.resolve 가 환경에 따라 먼저 실제 UNC 로 바꿔버려 테스트가 기계 의존이 된다.
        with mock.patch.object(
            resolve_bridge, "_drive_unc",
            side_effect=lambda d: r"\\nas\share" if d.lower() == "q:" else None,
        ):
            a = resolve_bridge._normal_path(r"Q:\renders\ep01\cut01.mp4")
            b = resolve_bridge._normal_path(r"\\NAS\share\renders\ep01\cut01.mp4")
        self.assertEqual(a, b)

    def test_local_drive_is_left_alone(self):
        with mock.patch.object(resolve_bridge, "_drive_unc", return_value=None):
            p = resolve_bridge._normal_path(r"D:\media\cut01.mp4")
        self.assertTrue(p.lower().startswith("d:"))


class ResolveBridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.pool = FakeMediaPool()
        self.original_folder = FakeFolder("사용자 폴더")
        self.pool.current = self.original_folder
        self.manager = FakeProjectManager(FakeProject(self.pool))
        self.resolve = FakeResolve(self.manager)

    def tearDown(self):
        self.tmp.cleanup()

    def _manifest(self):
        items = []
        for index, folder in enumerate(("ep001/c0010", "ep001/c0020"), 1):
            source = self.root / f"source-{index}.mp4"
            source.write_bytes(f"video-{index}".encode())
            items.append(
                {
                    "generation_id": f"g{index}",
                    "folder_path": folder,
                    "local_path": str(source),
                    "status": "downloaded",
                }
            )
        return {
            "project_id": "p1",
            "project_name": "프로젝트/테스트",
            "manifest_root": str(self.root / "@davinci"),
            "folder_catalog_path": str(
                self.root / "@davinci" / ".mvhub" / "folder-catalog.json"
            ),
            "folder_paths": [item["folder_path"] for item in items],
            "items": items,
        }

    @staticmethod
    def _child(folder, name):
        return next(child for child in folder.children if child.name == name)

    def test_import_creates_hierarchy_saves_and_restores_current_folder(self):
        result = import_manifest_to_current_project(
            self._manifest(), resolve=self.resolve
        )

        self.assertEqual(result["status"], "complete")
        self.assertEqual((result["imported"], result["skipped"]), (2, 0))
        managed = self._child(self.pool.root, "MV Hub")
        project = self._child(managed, "프로젝트_테스트")
        episode = self._child(project, "ep001")
        self.assertEqual(len(self._child(episode, "c0010").clips), 1)
        self.assertEqual(len(self._child(episode, "c0020").clips), 1)
        self.assertIs(self.pool.current, self.original_folder)
        self.assertEqual(self.manager.saved, 1)

    def test_repeated_import_skips_existing_file_without_resave(self):
        manifest = self._manifest()
        first = import_manifest_to_current_project(manifest, resolve=self.resolve)
        second = import_manifest_to_current_project(manifest, resolve=self.resolve)

        self.assertEqual(first["imported"], 2)
        self.assertEqual((second["imported"], second["skipped"]), (0, 2))
        self.assertEqual(self.manager.saved, 1)

    def test_same_bin_files_are_imported_in_one_batch(self):
        manifest = self._manifest()
        manifest["items"][1]["folder_path"] = "ep001/c0010"

        result = import_manifest_to_current_project(manifest, resolve=self.resolve)

        self.assertEqual(result["status"], "complete")
        self.assertEqual(len(self.pool.import_calls), 1)
        self.assertEqual(len(self.pool.import_calls[0]), 2)

    def test_large_same_bin_import_is_chunked(self):
        manifest = self._manifest()
        template = manifest["items"][0]
        items = []
        for index in range(105):
            source = self.root / f"bulk-{index}.mp4"
            source.write_bytes(f"video-{index}".encode())
            items.append(
                {
                    **template,
                    "generation_id": f"bulk-{index}",
                    "folder_path": "ep001/c0010",
                    "local_path": str(source),
                }
            )
        manifest["items"] = items

        with mock.patch.object(resolve_bridge, "_MEDIA_IMPORT_BATCH_SIZE", 50):
            result = import_manifest_to_current_project(manifest, resolve=self.resolve)

        self.assertEqual(result["imported"], 105)
        self.assertEqual([len(call) for call in self.pool.import_calls], [50, 50, 5])

    def test_missing_batch_items_are_retried_once(self):
        manifest = self._manifest()
        manifest["items"][1]["folder_path"] = "ep001/c0010"
        original_import = self.pool.ImportMedia
        attempts = 0

        def flaky_import(paths):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                self.pool.import_calls.append(list(paths))
                return []
            return original_import(paths)

        self.pool.ImportMedia = flaky_import
        with mock.patch.object(resolve_bridge, "_MEDIA_IMPORT_RETRY_DELAY_SECONDS", 0):
            result = import_manifest_to_current_project(manifest, resolve=self.resolve)

        self.assertEqual(result["status"], "complete")
        self.assertEqual((result["imported"], attempts), (2, 2))

    def test_connect_retries_transient_script_server_failure(self):
        expected = object()

        class FakeModule:
            def __init__(self):
                self.calls = 0

            def scriptapp(self, _name):
                self.calls += 1
                return expected if self.calls == 2 else None

        module = FakeModule()
        with (
            mock.patch.object(resolve_bridge.importlib, "import_module", return_value=module),
            mock.patch.object(resolve_bridge, "_CONNECT_ATTEMPTS", 3),
            mock.patch.object(resolve_bridge, "_CONNECT_RETRY_DELAY_SECONDS", 0),
        ):
            connected = resolve_bridge._connect_resolve()

        self.assertIs(connected, expected)
        self.assertEqual(module.calls, 2)

    def test_api_path_accepts_official_root_or_modules_directory(self):
        api_root = self.root / "Developer" / "Scripting"
        modules = api_root / "Modules"
        modules.mkdir(parents=True)
        (modules / "DaVinciResolveScript.py").write_text("# api", encoding="utf-8")

        with mock.patch.dict(
            resolve_bridge.os.environ,
            {"CONTENT_HUB_RESOLVE_SCRIPT_API": str(api_root)},
            clear=False,
        ):
            found, _library = resolve_bridge._prepare_resolve_api()

        self.assertIn(modules, found)

    def test_running_resolve_connection_failure_explains_local_setting(self):
        class DisconnectedModule:
            @staticmethod
            def scriptapp(_name):
                return None

        with (
            mock.patch.object(
                resolve_bridge.importlib,
                "import_module",
                return_value=DisconnectedModule(),
            ),
            mock.patch.object(resolve_bridge, "_resolve_process_running", return_value=True),
            mock.patch.object(resolve_bridge, "_CONNECT_ATTEMPTS", 1),
        ):
            with self.assertRaises(resolve_bridge.ResolveBridgeError) as raised:
                resolve_bridge._connect_resolve()

        self.assertEqual(raised.exception.code, "api_unavailable")
        self.assertIn("External scripting using", str(raised.exception))
        self.assertIn("Local", str(raised.exception))

    def test_fusionscript_init_failure_explains_python_incompatibility(self):
        # DaVinciResolveScript 임포트 중 fusionscript.dll(C 확장) 초기화가 SystemError로
        # 실패하면(파이썬 버전 비호환), 날것의 영어 대신 원인·해결을 한국어로 안내해야 한다.
        def raise_system_error(_name):
            raise SystemError(
                "initialization of fusionscript failed without raising an exception"
            )

        with mock.patch.object(
            resolve_bridge.importlib, "import_module", side_effect=raise_system_error
        ):
            with self.assertRaises(resolve_bridge.ResolveBridgeError) as raised:
                resolve_bridge._connect_resolve()

        self.assertEqual(raised.exception.code, "python_incompatible")
        self.assertIn("파이썬", str(raised.exception))
        self.assertIn("fusionscript", str(raised.exception))
        self.assertIn("Python 3.14 x64", str(raised.exception))
        self.assertNotIn("3.11 권장", str(raised.exception))

    def test_new_bins_are_created_in_natural_folder_name_order(self):
        manifest = self._manifest()
        manifest["items"][0]["folder_path"] = "ep001/c10"
        manifest["items"][1]["folder_path"] = "ep001/c2"
        manifest["folder_paths"] = ["ep001/c10", "ep001/c2"]

        result = import_manifest_to_current_project(manifest, resolve=self.resolve)

        self.assertEqual(result["status"], "complete")
        managed = self._child(self.pool.root, "MV Hub")
        project = self._child(managed, "프로젝트_테스트")
        episode = self._child(project, "ep001")
        self.assertEqual([folder.name for folder in episode.children], ["c2", "c10"])
        self.assertEqual(
            [item["generation_id"] for item in result["items"]], ["g1", "g2"]
        )

    def test_previous_folder_catalog_does_not_create_unselected_bins(self):
        manifest = self._manifest()
        manifest["items"] = [manifest["items"][0]]
        manifest["folder_paths"] = ["ep001/c0010", "ep999/c9999"]
        catalog_path = Path(manifest["folder_catalog_path"])
        catalog_path.parent.mkdir(parents=True)
        catalog_path.write_text(
            '{"format":"mvhub.resolve-folder-catalog","paths":["ep999/c9999"]}',
            encoding="utf-8",
        )

        result = import_manifest_to_current_project(manifest, resolve=self.resolve)

        self.assertEqual(result["status"], "complete")
        managed = self._child(self.pool.root, "MV Hub")
        project = self._child(managed, "프로젝트_테스트")
        self.assertEqual([folder.name for folder in project.children], ["ep001"])
        episode = self._child(project, "ep001")
        self.assertEqual([folder.name for folder in episode.children], ["c0010"])

    def test_separate_imports_reorder_existing_bins_without_copy_suffixes(self):
        manifest = self._manifest()
        first_item = manifest["items"][0]
        second_item = manifest["items"][1]
        first_item["folder_path"] = "ep001/c0015"
        second_item["folder_path"] = "ep001/c0010"

        first = import_manifest_to_current_project(
            {
                **manifest,
                "folder_paths": ["ep001/c0015"],
                "items": [first_item],
            },
            resolve=self.resolve,
        )
        managed = self._child(self.pool.root, "MV Hub")
        project = self._child(managed, "프로젝트_테스트")
        episode = self._child(project, "ep001")
        old_c0015 = self._child(episode, "c0015")
        self.pool.current = old_c0015
        second = import_manifest_to_current_project(
            {
                **manifest,
                "folder_paths": ["ep001/c0010"],
                "items": [second_item],
            },
            resolve=self.resolve,
        )

        self.assertEqual(
            (first["status"], second["status"]), ("complete", "complete")
        )
        episode = self._child(project, "ep001")
        self.assertEqual([folder.name for folder in episode.children], ["c0010", "c0015"])
        self.assertFalse(any(folder.name.endswith(" copy") for folder in episode.children))
        self.assertEqual(len(self._child(episode, "c0015").clips), 1)
        self.assertEqual(len(self._child(episode, "c0010").clips), 1)
        self.assertTrue(Path(second["folder_order_backup"]).is_file())
        self.assertEqual(self.resolve.opened_pages, [])
        self.assertIs(self.pool.current, self._child(episode, "c0015"))
        self.assertIsNot(self.pool.current, old_c0015)

    def test_missing_current_project_is_reported_as_unavailable(self):
        resolve = FakeResolve(FakeProjectManager(None))
        result = import_manifest_to_current_project(self._manifest(), resolve=resolve)

        self.assertEqual(result["status"], "unavailable")
        self.assertIn("현재 열려 있는", result["error"])

    def test_connection_status_reports_current_project_identity(self):
        with mock.patch.object(resolve_bridge, "_connect_resolve", return_value=self.resolve):
            result = resolve_bridge.resolve_connection_status()

        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["project_id"], "resolve-project-1")
        self.assertEqual(result["project_name"], "임시 테스트")

    def test_changed_project_is_rejected_before_media_pool_changes(self):
        manifest = self._manifest()
        manifest["resolve_target"] = {
            "project_id": "different-project",
            "project_name": "원래 프로젝트",
        }

        result = import_manifest_to_current_project(manifest, resolve=self.resolve)

        self.assertEqual(result["status"], "unavailable")
        self.assertIn("전송 시작 때와 달라졌습니다", result["error"])
        self.assertEqual(self.pool.root.children, [])

    def test_unexpected_resolve_api_error_does_not_escape(self):
        class BrokenResolve:
            def GetProjectManager(self):
                raise RuntimeError("API disconnected")

        result = import_manifest_to_current_project(
            self._manifest(), resolve=BrokenResolve()
        )

        self.assertEqual(result["status"], "unavailable")
        self.assertIn("API disconnected", result["error"])


if __name__ == "__main__":
    unittest.main()
