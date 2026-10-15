"""Resolve Media Pool 가져오기 — 계층·중복·복원 검증."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from app.services import resolve_bridge
from app.services.resolve_bridge import import_manifest_to_current_project


class FakeClip:
    _next_id = 0

    def __init__(self, path: str):
        type(self)._next_id += 1
        self.unique_id = f"clip-{type(self)._next_id}"
        self.path = path
        self.third_party_metadata = {}

    def GetUniqueId(self):
        return self.unique_id

    def GetClipProperty(self, key=None):
        props = {"File Path": self.path, "Clip Name": Path(self.path).name}
        return props.get(key, "") if key else props

    def GetThirdPartyMetadata(self, key=None):
        return self.third_party_metadata.get(key, "") if key else self.third_party_metadata

    def SetThirdPartyMetadata(self, key, value):
        self.third_party_metadata[key] = value
        return True


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
        # 실제 API 처럼 경로 목록과 clipInfo dict 목록을 모두 받는다.
        clips = [
            FakeClip(path["FilePath"] if isinstance(path, dict) else path)
            for path in paths
        ]
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
        self.save_result = True

    def GetCurrentProject(self):
        return self.project

    def SaveProject(self):
        self.saved += 1
        return self.save_result

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
        first_clip = self._child(episode, "c0010").clips[0]
        self.assertEqual(
            resolve_bridge.parse_mvhub_clip_metadata(
                first_clip.GetThirdPartyMetadata(resolve_bridge.MVHUB_METADATA_KEY)
            ),
            {"generation_id": "g1", "project_id": "p1"},
        )
        self.assertIs(self.pool.current, self.original_folder)
        self.assertEqual(self.manager.saved, 1)

    def test_repeated_import_skips_existing_file_without_resave(self):
        manifest = self._manifest()
        first = import_manifest_to_current_project(manifest, resolve=self.resolve)
        second = import_manifest_to_current_project(manifest, resolve=self.resolve)

        self.assertEqual(first["imported"], 2)
        self.assertEqual((second["imported"], second["skipped"]), (0, 2))
        self.assertEqual(self.manager.saved, 1)

    def test_repeated_import_backfills_missing_metadata_and_saves_once(self):
        manifest = self._manifest()
        import_manifest_to_current_project(manifest, resolve=self.resolve)
        managed = self._child(self.pool.root, "MV Hub")
        project = self._child(managed, "프로젝트_테스트")
        episode = self._child(project, "ep001")
        self._child(episode, "c0010").clips[0].third_party_metadata.clear()

        result = import_manifest_to_current_project(manifest, resolve=self.resolve)

        self.assertEqual((result["imported"], result["skipped"]), (0, 2))
        self.assertEqual(self.manager.saved, 2)

    def test_metadata_only_save_failure_does_not_fail_import(self):
        manifest = self._manifest()
        import_manifest_to_current_project(manifest, resolve=self.resolve)
        managed = self._child(self.pool.root, "MV Hub")
        project = self._child(managed, "프로젝트_테스트")
        episode = self._child(project, "ep001")
        self._child(episode, "c0010").clips[0].third_party_metadata.clear()
        self.manager.save_result = False

        result = import_manifest_to_current_project(manifest, resolve=self.resolve)

        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["error_count"], 0)
        self.assertTrue(result.get("warnings"))

    def test_same_bin_files_are_imported_in_one_batch(self):
        manifest = self._manifest()
        manifest["items"][1]["folder_path"] = "ep001/c0010"

        result = import_manifest_to_current_project(manifest, resolve=self.resolve)

        self.assertEqual(result["status"], "complete")
        self.assertEqual(len(self.pool.import_calls), 1)
        self.assertEqual(len(self.pool.import_calls[0]), 2)

    def test_still_images_are_imported_one_path_per_call(self):
        """스틸은 한 호출에 하나씩 — 번호만 다른 이미지를 함께 넣으면 Resolve 가
        이미지 시퀀스로 합쳐 클립 하나([00-01])로 만든다.
        (가짜 Resolve 엔 시퀀스 인식이 없으니 여기서 보는 건 호출 쪼개기뿐이다.)"""
        manifest = self._manifest()
        manifest["items"][1]["folder_path"] = "ep001/c0010"
        for index, item in enumerate(manifest["items"], 1):
            still = self.root / f"still-{index}.png"
            still.write_bytes(f"png-{index}".encode())
            item["local_path"] = str(still)

        result = import_manifest_to_current_project(manifest, resolve=self.resolve)

        self.assertEqual(result["imported"], 2)
        self.assertEqual([len(call) for call in self.pool.import_calls], [1, 1])

    def test_one_failing_still_does_not_block_the_rest(self):
        """스틸 한 건이 예외를 내도 뒤 항목은 계속 넣는다 — 루프를 끊으면 호출조차
        안 된 채 전부 실패로 집계된다(코덱스 리뷰)."""
        manifest = self._manifest()
        manifest["items"][1]["folder_path"] = "ep001/c0010"
        stills = []
        for index, item in enumerate(manifest["items"], 1):
            still = self.root / f"still-{index}.png"
            still.write_bytes(f"png-{index}".encode())
            item["local_path"] = str(still)
            stills.append(str(still))

        original = self.pool.ImportMedia

        def fail_first(paths):
            if str(paths[0]) == stills[0]:
                raise RuntimeError("Resolve 일시 오류")
            return original(paths)

        self.pool.ImportMedia = fail_first
        result = import_manifest_to_current_project(manifest, resolve=self.resolve)

        # 두 번째 스틸은 들어갔고, 첫 번째만 실패로 남는다(재시도 포함).
        self.assertEqual(result["imported"], 1)
        self.assertEqual(result["error_count"], 1)
        self.assertEqual(result["status"], "partial")

    def test_videos_are_still_imported_in_one_call(self):
        """영상은 시퀀스로 합쳐질 일이 없어 종전대로 묶어 넣는다(대량 전송 성능)."""
        manifest = self._manifest()  # 원본은 .mp4 다
        manifest["items"][1]["folder_path"] = "ep001/c0010"

        result = import_manifest_to_current_project(manifest, resolve=self.resolve)

        self.assertEqual(result["imported"], 2)
        self.assertEqual([len(call) for call in self.pool.import_calls], [2])

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
        self.assertIn("자동 재시도", str(raised.exception))

    def test_fusionscript_dll_load_failure_is_python_incompatibility_not_missing_module(self):
        # 비호환 조합은 SystemError 대신 "DLL load failed while importing fusionscript"
        # ImportError로도 나타난다. 이걸 모듈 부재(복구 설치 안내)로 오진하면 안 된다.
        def raise_dll_import_error(_name):
            error = ImportError(
                "DLL load failed while importing fusionscript: "
                "지정된 모듈을 찾을 수 없습니다."
            )
            error.name = "fusionscript"
            raise error

        with mock.patch.object(
            resolve_bridge.importlib, "import_module", side_effect=raise_dll_import_error
        ):
            with self.assertRaises(resolve_bridge.ResolveBridgeError) as raised:
                resolve_bridge._connect_resolve()

        self.assertEqual(raised.exception.code, "python_incompatible")

    def test_missing_script_module_still_reports_repair_install(self):
        def raise_missing_module(_name):
            raise ModuleNotFoundError(
                "No module named 'DaVinciResolveScript'", name="DaVinciResolveScript"
            )

        with mock.patch.object(
            resolve_bridge.importlib, "import_module", side_effect=raise_missing_module
        ):
            with self.assertRaises(resolve_bridge.ResolveBridgeError) as raised:
                resolve_bridge._connect_resolve()

        self.assertEqual(raised.exception.code, "module_unavailable")
        self.assertIn("복구 설치", str(raised.exception))

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

    def _episode(self):
        return self._child(self._child(self._child(self.pool.root, "MV Hub"), "프로젝트_테스트"), "ep001")

    def _send_one(self, folder_path, name="extra"):
        source = self.root / f"{name}.mp4"
        source.write_bytes(name.encode())
        item = {"generation_id": name, "folder_path": folder_path, "local_path": str(source), "status": "downloaded"}
        return import_manifest_to_current_project(
            {**self._manifest(), "folder_paths": [folder_path], "items": [item]}, resolve=self.resolve
        )

    def test_sending_into_an_existing_bin_does_not_look_up_every_sibling_again(self):
        # 실제 Resolve 21.1.1(시험 프로젝트): 형제 300 이면 클립 1개 보내기 9.5초 — 그중 8.8~9.0초가 이미 있는 Bin 을 모두 다시 찾는 데 갔다.
        #  찾는 수가 형제 수와 무관해야 한다(MV Hub·프로젝트·에피소드·컷 각 1번 = 4).
        import_manifest_to_current_project(self._manifest(), resolve=self.resolve)
        counts = []
        for siblings in (10, 60):
            episode = self._episode()
            while len(episode.children) < siblings:
                episode.children.append(FakeFolder(f"c{len(episode.children) + 1:04d}0"))
            with mock.patch.object(resolve_bridge, "_subfolder", wraps=resolve_bridge._subfolder) as lookups:
                result = self._send_one("ep001/c0010", f"one-{siblings}")
            counts.append((result["status"], result["imported"], lookups.call_count, len(episode.children)))
        self.assertEqual(counts, [("complete", 1, 4, 10), ("complete", 1, 4, 60)])

    def test_case_and_korean_normalization_differences_reuse_the_existing_bin(self):
        import unicodedata
        nfc = "컷0010"
        self._send_one(f"ep001/{nfc}", "first")
        self._send_one(f"EP001/{unicodedata.normalize('NFD', nfc)}", "second")  # 대소문자·자모 분리만 다르다
        project = self._child(self._child(self.pool.root, "MV Hub"), "프로젝트_테스트")
        self.assertEqual([folder.name for folder in project.children], ["ep001"])
        self.assertEqual([(folder.name, len(folder.clips)) for folder in self._episode().children], [(nfc, 2)])

    def test_a_missing_bin_is_still_created_after_the_existing_ones(self):
        import_manifest_to_current_project(self._manifest(), resolve=self.resolve)
        result = self._send_one("ep001/c0030", "third")
        self.assertEqual((result["status"], result["imported"]), ("complete", 1))
        self.assertEqual([folder.name for folder in self._episode().children], ["c0010", "c0020", "c0030"])
        self.assertEqual(self.manager.saved, 2)  # 새 Bin·클립이 들었으니 저장한다

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

    def test_connection_status_names_the_current_library_without_switching(self):
        # Assets 의 Resolve 화면이 '열려 있음'을 판정할 때 쓴다 — 같은 이름이 다른 라이브러리에도 있을 수 있다.
        manager = self.resolve.GetProjectManager()
        manager.GetCurrentDatabase = mock.Mock(return_value={"DbType": "Disk", "DbName": "MVHub - 뻘뻘뻘"})
        manager.SetCurrentDatabase = mock.Mock()
        with mock.patch.object(resolve_bridge, "_connect_resolve", return_value=self.resolve):
            result = resolve_bridge.resolve_connection_status()

        self.assertEqual(result["database_name"], "MVHub - 뻘뻘뻘")
        manager.SetCurrentDatabase.assert_not_called()

        manager.GetCurrentDatabase = mock.Mock(side_effect=RuntimeError("API 멈춤"))
        with mock.patch.object(resolve_bridge, "_connect_resolve", return_value=self.resolve):
            result = resolve_bridge.resolve_connection_status()
        self.assertEqual(result["status"], "ready")  # 라이브러리 이름을 못 읽어도 상태는 그대로
        self.assertEqual(result["database_name"], "")

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

    # ── 가져오는 도중 Resolve 에서 다른 프로젝트를 열었다 ─────────────────────────────────────────────
    # SaveProject 는 '지금 열린' 프로젝트를 저장한다 — 시작한 프로젝트가 아니면 멈추고 저장하지 않는다.
    # 대역(가짜 Resolve)으로만 본다: 바뀐 뒤 옛 Media Pool 객체가 실제로 어떻게 구는지는 재지 않았다.
    def _switch_after(self, owner, method, nth=1):
        """owner.method 가 nth 번째로 돈 직후 다른 프로젝트가 열린 것으로 만든다 — 그 다른 프로젝트를 돌려준다.
        self.calls 에 그 method 가 불린 횟수가 쌓인다(바뀐 뒤에 더 불렸는지 본다)."""
        other = FakeProject(FakeMediaPool())
        other.unique_id = "resolve-project-2"
        real = getattr(owner, method)
        self.calls = []

        def then_switch(*args, **kwargs):
            done = real(*args, **kwargs)
            self.calls.append(method)
            if len(self.calls) >= nth:
                self.manager.project = other
            return done

        setattr(owner, method, then_switch)
        return other

    def _assert_stopped_without_touching(self, result, other, saved):
        self.assertEqual((result["status"], result["error_code"]), ("unavailable", "project_changed"))
        self.assertIn("저장하지 않았습니다", result["error"])
        self.assertEqual(self.manager.saved, saved)
        self.assertEqual((other.media_pool.root.children, other.media_pool.import_calls), ([], []))

    def test_switching_projects_mid_import_stops_before_the_next_batch_and_never_saves(self):
        other = self._switch_after(self.pool, "ImportMedia")  # 첫 묶음을 가져오는 사이에 바꿨다
        result = import_manifest_to_current_project(self._manifest(), resolve=self.resolve)

        self._assert_stopped_without_touching(result, other, saved=0)
        self.assertEqual(len(self.pool.import_calls), 1)  # 둘째 묶음은 부르지 않았다

    def test_switching_projects_during_the_last_batch_skips_the_save(self):
        manifest = self._manifest()
        manifest["items"] = manifest["items"][:1]  # 묶음 하나 — 다음 묶음의 확인이 없어도 저장 직전에 걸린다
        other = self._switch_after(self.pool, "ImportMedia")
        result = import_manifest_to_current_project(manifest, resolve=self.resolve)

        self._assert_stopped_without_touching(result, other, saved=0)

    def test_switching_projects_right_after_the_start_creates_no_more_bins(self):
        other = self._switch_after(self.pool, "AddSubFolder")  # 첫 Bin('MV Hub')을 만드는 사이에 바꿨다
        result = import_manifest_to_current_project(self._manifest(), resolve=self.resolve)

        self._assert_stopped_without_touching(result, other, saved=0)
        project = self._child(self._child(self.pool.root, "MV Hub"), "프로젝트_테스트")
        self.assertEqual((project.children, self.pool.import_calls), ([], []))  # 폴더 구조를 맞추러 들어가지 않았다

    def _reorder_manifests(self):
        """둘째를 가져오면 Bin 순서가 깨져 '백업 → 임시 Bin → 다시 짓기'가 도는 두 manifest."""
        manifest = self._manifest()
        first_item, second_item = manifest["items"]
        first_item["folder_path"], second_item["folder_path"] = "ep001/c0015", "ep001/c0010"
        return (
            {**manifest, "folder_paths": ["ep001/c0015"], "items": [first_item]},
            {**manifest, "folder_paths": ["ep001/c0010"], "items": [second_item]},
        )

    def test_switching_projects_during_the_reorder_backup_stops_before_moving_clips(self):
        first, second = self._reorder_manifests()
        import_manifest_to_current_project(first, resolve=self.resolve)
        other = self._switch_after(self.manager, "ExportProject")  # 백업을 내보내는 사이에 바꿨다
        result = import_manifest_to_current_project(second, resolve=self.resolve)

        # 저장 2번 = 첫 가져오기 + 백업 직전(그때는 아직 시작한 프로젝트였다). 그 뒤로는 저장하지 않는다.
        self._assert_stopped_without_touching(result, other, saved=2)
        self.assertEqual([folder.name for folder in self.pool.root.children], ["MV Hub"])  # 임시 Bin 을 만들지 않았다
        episode = self._child(self._child(self._child(self.pool.root, "MV Hub"), "프로젝트_테스트"), "ep001")
        self.assertEqual([folder.name for folder in episode.children], ["c0015"])  # 새 컷의 Bin 도 만들지 않았다
        self.assertEqual(len(self.pool.import_calls), 1)

    def test_switching_projects_mid_reorder_skips_the_recovery_and_its_save(self):
        first, second = self._reorder_manifests()
        import_manifest_to_current_project(first, resolve=self.resolve)
        other = self._switch_after(self.pool, "MoveClips")  # 클립을 임시 Bin 으로 옮기는 사이에 바꿨다
        result = import_manifest_to_current_project(second, resolve=self.resolve)

        # 다시 짓기(Bin 지우기)도, 되돌리기(클립을 다시 옮기고 저장)도 하지 않는다 — 지금 열린 프로젝트에 하는 일이 된다.
        # 옮기다 만 상태(임시 Bin)는 시작한 프로젝트에 저장되지 않은 채 남고, 백업(.drp)이 있다.
        self._assert_stopped_without_touching(result, other, saved=2)
        self.assertEqual(len(self.pool.import_calls), 1)
        staging = next(folder.name for folder in self.pool.root.children if folder.name.startswith("__MVHUB_REBUILD_"))
        # 남은 임시 Bin 과 백업 자리를 결과가 알려 준다 — '다시 가져오기'만 안내하면 임시 Bin 의 클립을 못 되살린다(Codex 재검토 P1).
        self.assertEqual(result["rebuild_staging_bin"], staging)
        self.assertTrue(Path(result["folder_order_backup"]).is_file())
        for needed in (staging, result["folder_order_backup"], "다시 가져오기 **전에**"):
            self.assertIn(needed, result["error"])

    def _assert_plain_stop(self, result):
        """남긴 것이 없는 멈춤 — 복구 안내가 아니라 보통의 '다시 가져오기' 안내다."""
        self.assertNotIn("rebuild_staging_bin", result)
        self.assertIn("준비된 원본 다시 가져오기를 실행하세요", result["error"])

    def test_switching_projects_while_reading_the_bins_creates_no_new_bin(self):
        manifest = self._manifest()
        import_manifest_to_current_project(manifest, resolve=self.resolve)
        extra = self.root / "source-3.mp4"
        extra.write_bytes(b"video-3")
        third = {"generation_id": "g3", "folder_path": "ep001/c0030", "local_path": str(extra), "status": "downloaded"}
        with mock.patch.object(resolve_bridge, "_scan_actual_tree", wraps=resolve_bridge._scan_actual_tree):
            other = self._switch_after(resolve_bridge, "_scan_actual_tree")  # 순서는 안 깨진다(다시 짓지 않는다) — 구조를 읽는 사이에 바꿨다
            result = import_manifest_to_current_project(
                {**manifest, "folder_paths": ["ep001/c0030"], "items": [third]}, resolve=self.resolve
            )

        self._assert_stopped_without_touching(result, other, saved=1)
        self._assert_plain_stop(result)
        episode = self._child(self._child(self._child(self.pool.root, "MV Hub"), "프로젝트_테스트"), "ep001")
        self.assertEqual([folder.name for folder in episode.children], ["c0010", "c0020"])  # 긴 조회 뒤의 첫 쓰기 앞에서 멈췄다

    def test_switching_projects_between_bins_stops_creating(self):
        other = self._switch_after(self.pool, "AddSubFolder", nth=3)  # MV Hub · 프로젝트 · ep001 까지 만든 뒤에 바꿨다
        result = import_manifest_to_current_project(self._manifest(), resolve=self.resolve)

        self._assert_stopped_without_touching(result, other, saved=0)
        self._assert_plain_stop(result)
        episode = self._child(self._child(self._child(self.pool.root, "MV Hub"), "프로젝트_테스트"), "ep001")
        self.assertEqual((episode.children, len(self.calls)), ([], 3))  # 그 아래 컷 Bin 은 만들지 않았다

    def test_switching_projects_between_bin_preparations_stops(self):
        with mock.patch.object(resolve_bridge, "_destination_folder", wraps=resolve_bridge._destination_folder):
            other = self._switch_after(resolve_bridge, "_destination_folder", nth=2)  # 첫 컷의 Bin 을 준비한 뒤에 바꿨다
            result = import_manifest_to_current_project(self._manifest(), resolve=self.resolve)

        self._assert_stopped_without_touching(result, other, saved=0)
        self.assertEqual(len(self.calls), 2)  # 둘째 컷의 Bin 은 준비하지 않았다(= 관리 뿌리 1 + 첫 컷 1)

    def _two_bin_reorder(self):
        """클립이 든 Bin 둘(c0015·c0020)을 먼저 가져오고, 순서를 깨는 셋째(c0010)의 manifest 를 돌려준다 —
        다시 지을 때 클립 옮기기가 Bin 마다 한 번씩(임시 Bin 으로 2번, 되돌아오며 2번) 돈다."""
        manifest = self._manifest()
        first_item, second_item = manifest["items"]
        first_item["folder_path"], second_item["folder_path"] = "ep001/c0015", "ep001/c0020"
        import_manifest_to_current_project({**manifest, "folder_paths": ["ep001/c0015", "ep001/c0020"]}, resolve=self.resolve)
        extra = self.root / "source-3.mp4"
        extra.write_bytes(b"video-3")
        third = {"generation_id": "g3", "folder_path": "ep001/c0010", "local_path": str(extra), "status": "downloaded"}
        return {**manifest, "folder_paths": ["ep001/c0010"], "items": [third]}

    def _switch_between_clip_moves(self, moves_before_the_switch):
        second = self._two_bin_reorder()
        other = self._switch_after(self.pool, "MoveClips", nth=moves_before_the_switch)
        result = import_manifest_to_current_project(second, resolve=self.resolve)

        self._assert_stopped_without_touching(result, other, saved=2)
        self.assertEqual(len(self.calls), moves_before_the_switch)  # 그다음 Bin 의 클립은 옮기지 않았다
        self.assertIn(result["rebuild_staging_bin"], result["error"])

    def test_switching_projects_between_moves_to_staging_stops_moving(self):
        self._switch_between_clip_moves(1)  # 첫 Bin 의 클립을 임시 Bin 으로 옮긴 뒤

    def test_switching_projects_between_moves_back_stops_moving(self):
        self._switch_between_clip_moves(3)  # 다시 지은 첫 Bin 으로 되돌린 뒤(임시 Bin 으로 2번 + 되돌리기 1번)

    def test_switching_projects_during_the_recovery_stops_moving_clips_back(self):
        second = self._two_bin_reorder()
        self.pool.DeleteFolders = lambda folders: False  # 옛 Bin 을 못 지워 다시 짓기가 실패한다 — 임시 Bin 의 클립 둘을 되돌려야 한다
        other = self._switch_after(self.pool, "MoveClips", nth=3)  # 첫 Bin 의 클립을 되돌린 뒤에 바꿨다
        result = import_manifest_to_current_project(second, resolve=self.resolve)

        self._assert_stopped_without_touching(result, other, saved=2)
        self.assertEqual(len(self.calls), 3)  # 둘째 Bin 의 클립은 되돌리지 않았다(임시 Bin 에 남아 있다 — 결과가 알린다)
        self.assertIn(result["rebuild_staging_bin"], result["error"])

    def test_switching_projects_between_deletes_stops_deleting(self):
        first, second = self._reorder_manifests()
        import_manifest_to_current_project(first, resolve=self.resolve)
        other = self._switch_after(self.pool, "DeleteFolders")  # 옛 Bin 하나를 지운 뒤에 바꿨다
        result = import_manifest_to_current_project(second, resolve=self.resolve)

        self._assert_stopped_without_touching(result, other, saved=2)
        self.assertEqual(len(self.calls), 1)  # 그 위의 Bin 들은 지우지 않았다
        project = self._child(self._child(self.pool.root, "MV Hub"), "프로젝트_테스트")
        self.assertEqual([folder.name for folder in project.children], ["ep001"])
        self.assertIn(result["rebuild_staging_bin"], result["error"])

    def test_switching_projects_before_the_staging_bin_is_deleted_keeps_it(self):
        # 다시 짓기가 끝나 임시 Bin 을 치우는 중 — 지우기 4번(옛 Bin 2 + 임시 Bin 아래 2) 뒤에 바꿨다. 임시 Bin 자체(5번째)는 안 지운다.
        first, second = self._reorder_manifests()
        import_manifest_to_current_project(first, resolve=self.resolve)
        other = self._switch_after(self.pool, "DeleteFolders", nth=4)
        result = import_manifest_to_current_project(second, resolve=self.resolve)

        self._assert_stopped_without_touching(result, other, saved=2)
        self.assertEqual(len(self.calls), 4)
        self.assertTrue(any(folder.name == result["rebuild_staging_bin"] for folder in self.pool.root.children))

    def test_switching_projects_before_the_reorder_backup_skips_its_save(self):
        first, second = self._reorder_manifests()
        import_manifest_to_current_project(first, resolve=self.resolve)
        with mock.patch.object(resolve_bridge, "_scan_actual_tree", wraps=resolve_bridge._scan_actual_tree):
            other = self._switch_after(resolve_bridge, "_scan_actual_tree")  # 지금 Bin 구조를 읽는 사이에 바꿨다
            result = import_manifest_to_current_project(second, resolve=self.resolve)

        self._assert_stopped_without_touching(result, other, saved=1)  # 백업 직전의 저장도 하지 않는다

    def _switch_during_the_recovery(self, deletes_before_the_switch):
        """다시 짓기가 프로젝트와 무관한 까닭으로 실패해 되돌리기가 돈다. 되돌리기의 지우기는 세 번이다
        (임시 Bin 아래의 컷·에피소드 Bin, 그리고 임시 Bin 자체) — 그 가운데 몇 번째 뒤에 프로젝트를 바꿀지."""
        first, second = self._reorder_manifests()
        import_manifest_to_current_project(first, resolve=self.resolve)
        self.pool.MoveClips = lambda clips, target: False
        other = self._switch_after(self.pool, "DeleteFolders", nth=deletes_before_the_switch)
        result = import_manifest_to_current_project(second, resolve=self.resolve)

        self._assert_stopped_without_touching(result, other, saved=2)  # 되돌린 뒤의 저장은 어느 쪽이든 하지 않는다
        self.assertEqual(len(self.calls), deletes_before_the_switch)
        self.assertIn("처음 실패: 클립을 정렬용 공간으로 옮기지 못했습니다", result["error"])  # 왜 되돌리게 됐는지도 남긴다

    def test_switching_projects_during_the_recovery_skips_its_save(self):
        self._switch_during_the_recovery(3)  # 다 지운 뒤에 바꿨다 — 남은 것은 저장뿐이다

    def test_switching_projects_during_the_recovery_keeps_the_staging_bin(self):
        self._switch_during_the_recovery(2)  # 임시 Bin 자체를 지우기 전에 바꿨다 — 그것은 지우지 않는다

    def test_still_current_compares_names_when_ids_are_unreadable(self):
        self.manager.project.unique_id = ""
        resolve_bridge._assert_still_current(self.manager, ("", "임시 테스트"))  # 같은 이름 — 통과
        resolve_bridge._assert_still_current(self.manager, ("resolve-project-1", "임시 테스트"))  # 한쪽 ID 만 없어도 이름으로
        for started in (("", "다른 프로젝트"), ("resolve-project-1", "다른 프로젝트")):
            with self.assertRaises(resolve_bridge.ResolveBridgeError) as ctx:
                resolve_bridge._assert_still_current(self.manager, started)
            self.assertEqual(ctx.exception.code, "project_changed")
        self.manager.project = None  # 프로젝트가 닫혔다
        with self.assertRaises(resolve_bridge.ResolveBridgeError) as ctx:
            resolve_bridge._assert_still_current(self.manager, ("resolve-project-1", "임시 테스트"))
        self.assertEqual(ctx.exception.code, "project_changed")

    def test_unexpected_resolve_api_error_does_not_escape(self):
        class BrokenResolve:
            def GetProjectManager(self):
                raise RuntimeError("API disconnected")

        result = import_manifest_to_current_project(
            self._manifest(), resolve=BrokenResolve()
        )

        self.assertEqual(result["status"], "unavailable")
        self.assertIn("API disconnected", result["error"])


# ── 빠른 Bin 정렬(MoveFolders) — 꼬리만 옮기기·고유 ID 검증·되돌리기·복구 기록 (Codex 설계 v3 승인 2026-10-16) ─────────────


class Crash(BaseException):
    """프로세스가 그 자리에서 죽은 것 — 같은 실행의 되돌리기 코드가 돌지 않는다."""


class MovingMediaPool(FakeMediaPool):
    """MoveFolders 를 흉내 낸다 — 목록 순서대로 대상의 끝에 붙인다. fail[n] 이 있으면 n 번째(1부터) 호출을 그 함수로 바꾼다."""

    def __init__(self):
        super().__init__()
        self.move_calls: list[list[str]] = []
        self.fail = {}

    def do_move(self, folders, target):
        for folder in folders:
            self._parent_of(folder).children.remove(folder)
            target.children.append(folder)
        return True

    def MoveFolders(self, folders, target):
        self.move_calls.append([folder.name for folder in folders])
        hook = self.fail.get(len(self.move_calls))
        return hook(list(folders), target) if hook else self.do_move(folders, target)


class FastBinSortTests(unittest.TestCase):
    VERSION = [21, 1, 1, 8, ""]

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.pool = MovingMediaPool()
        self.manager = FakeProjectManager(FakeProject(self.pool))
        self.resolve = FakeResolve(self.manager)
        self.resolve.GetVersion = lambda: list(self.VERSION)
        patcher = mock.patch.object(
            resolve_bridge, "_MOVE_FOLDERS_TESTED", frozenset({tuple(str(part) for part in self.VERSION)})
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        project = self._add(self._add(self.pool.root, "MV Hub"), "프로젝트_테스트")
        self.episode = self._add(project, "ep001")
        self.episode.clips.append(self._clip("ep-direct"))
        self.existing = {name: self._add(self.episode, name) for name in ("c0020", "c0030", "c0040")}
        self.existing["c0020"].clips.append(self._clip("a"))
        self._add(self.existing["c0030"], "sub").clips.append(self._clip("b"))
        self.saved_before = self.manager.saved
        self.clip_ids_before = self._clip_ids()

    def _clip_ids(self):
        return ([c.unique_id for c in self.existing["c0020"].clips], [c.unique_id for c in self.existing["c0030"].children[0].clips],
                [c.unique_id for c in self.episode.clips])

    @staticmethod
    def _add(parent, name):
        folder = FakeFolder(name)
        parent.children.append(folder)
        return folder

    def _clip(self, name):
        return FakeClip(str(self.root / f"{name}.mp4"))

    def _send(self, *folders):
        items = []
        for index, folder in enumerate(folders or ("ep001/c0010",), 1):
            source = self.root / f"new-{index}-{folder.replace('/', '_')}.mp4"
            source.write_bytes(b"x")
            items.append({"generation_id": f"g{index}", "folder_path": folder, "local_path": str(source), "status": "downloaded"})
        manifest = {
            "project_id": "p1",
            "project_name": "프로젝트/테스트",
            "manifest_root": str(self.root / "@davinci"),
            "folder_paths": [item["folder_path"] for item in items],
            "items": items,
        }
        return import_manifest_to_current_project(manifest, resolve=self.resolve)

    def _current_episode(self):
        # 기존 다시 짓기는 Bin 을 지우고 새로 만든다 — 이름으로 다시 찾는다
        folder = self.pool.root
        for name in ("MV Hub", "프로젝트_테스트", "ep001"):
            folder = next(child for child in folder.children if child.name == name)
        return folder

    def _names(self, folder=None):
        return [child.name for child in (folder or self._current_episode()).children]

    def _records(self):
        return sorted((self.root / "@davinci" / ".mvhub" / "resolve-recovery").glob("*.json"))

    def _staging(self):
        return [folder for folder in self.pool.root.children if folder.name.startswith("__MVHUB_SORT_")]

    def _assert_old_bins_kept(self):
        for name, folder in self.existing.items():
            self.assertIs(next(child for child in self.episode.children if child.name == name), folder)
        self.assertEqual(self._clip_ids(), self.clip_ids_before)  # 같은 클립(고유 ID)이 같은 Bin 에

    def _assert_sorted_and_clean(self, result):
        self.assertEqual(result["status"], "complete")
        self.assertEqual(self._names(), ["c0010", "c0020", "c0030", "c0040"])
        self.assertEqual((self._staging(), self._records()), ([], []))

    # 정상
    def test_front_insert_moves_only_the_tail_and_keeps_the_same_bins_and_clips(self):
        with mock.patch.object(self.pool, "MoveClips", wraps=self.pool.MoveClips) as move_clips:
            result = self._send()
        self._assert_sorted_and_clean(result)
        self._assert_old_bins_kept()
        self.assertEqual(self.pool.move_calls, [["c0020", "c0030", "c0040"], ["c0010", "c0020", "c0030", "c0040"]])
        move_clips.assert_not_called()  # 클립을 옮겨 다시 짓지 않았다
        self.assertTrue(Path(result["folder_order_backup"]).is_file())
        self.assertEqual(len(next(c for c in self.episode.children if c.name == "c0010").clips), 1)

    def test_middle_insert_moves_only_the_bins_after_it(self):
        result = self._send("ep001/c0035")
        self.assertEqual(result["status"], "complete")
        self.assertEqual(self._names(), ["c0020", "c0030", "c0035", "c0040"])
        self.assertEqual(self.pool.move_calls, [["c0040"], ["c0035", "c0040"]])
        self._assert_old_bins_kept()

    def test_two_broken_parents_are_sorted_one_after_another(self):
        other = self._add(self.pool._parent_of(self.episode), "ep002")
        self._add(other, "c0020")
        result = self._send("ep001/c0010", "ep002/c0010")
        self.assertEqual(result["status"], "complete")
        self.assertEqual((self._names(), self._names(other)), (["c0010", "c0020", "c0030", "c0040"], ["c0010", "c0020"]))
        self.assertEqual(len(self.pool.move_calls), 4)
        self.assertEqual((self._staging(), self._records()), ([], []))

    # 자격 없음 — 옮기지 않고 기존 다시 짓기
    def _assert_old_rebuild(self, result):
        self.assertEqual(result["status"], "complete")
        self.assertEqual(self._names(), ["c0010", "c0020", "c0030", "c0040"])
        self.assertEqual((self._staging(), self._records()), ([], []))
        episode = self._current_episode()
        self.assertEqual(sum(len(c.clips) for c in episode.children), 2)  # c0020 의 클립 + 새로 가져온 것
        self.assertEqual((len(episode.clips), len(next(c for c in episode.children if c.name == "c0030").children[0].clips)), (1, 1))

    def test_untested_build_of_the_same_minor_version_uses_the_old_rebuild(self):
        self.resolve.GetVersion = lambda: [21, 1, 1, 9, ""]
        self._assert_old_rebuild(self._send())
        self.assertEqual(self.pool.move_calls, [])

    def test_empty_allow_list_or_unreadable_version_uses_the_old_rebuild(self):
        with mock.patch.object(resolve_bridge, "_MOVE_FOLDERS_TESTED", frozenset()):
            self._assert_old_rebuild(self._send())
        self.assertEqual(self.pool.move_calls, [])

    def test_unreadable_clip_id_or_folder_list_uses_the_old_rebuild(self):
        self.existing["c0020"].clips[0].unique_id = ""
        self._assert_old_rebuild(self._send())
        self.assertEqual(self.pool.move_calls, [])

    def test_folder_list_that_answers_none_is_not_treated_as_empty(self):
        self.existing["c0040"].GetSubFolderList = lambda: None
        self._assert_old_rebuild(self._send())
        self.assertEqual(self.pool.move_calls, [])

    # 실패 → 처음 상태로 돌아간 것을 확인 → 기존 다시 짓기
    def test_first_move_refused_without_moving_falls_back(self):
        self.pool.fail[1] = lambda folders, target: False
        self._assert_old_rebuild(self._send())
        self.assertEqual(len(self.pool.move_calls), 1)

    def test_first_move_partly_done_is_moved_back_then_falls_back(self):
        self.pool.fail[1] = lambda folders, target: (self.pool.do_move(folders[:1], target), False)[1]
        self._assert_old_rebuild(self._send())
        self.assertEqual(self.pool.move_calls[1], ["c0020"])  # 되돌리기

    def test_second_move_in_the_wrong_order_is_undone_then_falls_back(self):
        self.pool.fail[2] = lambda folders, target: self.pool.do_move(list(reversed(folders)), target)
        self._assert_old_rebuild(self._send())

    def test_second_move_partly_done_then_error_is_undone_then_falls_back(self):
        def half(folders, target):
            self.pool.do_move(folders[:2], target)
            raise RuntimeError("API 끊김")
        self.pool.fail[2] = half
        self._assert_old_rebuild(self._send())

    def test_staging_call_failed_without_making_anything_falls_back(self):
        real = self.pool.AddSubFolder

        def add(parent, name):
            if name.startswith("__MVHUB_SORT_"):
                raise RuntimeError("API 끊김")  # 아무것도 만들지 않고 실패
            return real(parent, name)

        self.pool.AddSubFolder = add
        self._assert_old_rebuild(self._send())
        self.assertEqual(self.pool.move_calls, [])

    def test_staging_bin_made_but_the_call_failed_stops_without_guessing(self):
        # 설계 D — 부수효과가 남았으면 추측으로 지우지 않고 멈춘다(Codex 구현 리뷰 P1)
        real = self.pool.AddSubFolder

        def add(parent, name):
            folder = real(parent, name)
            if name.startswith("__MVHUB_SORT_"):
                raise RuntimeError("API 끊김")
            return folder

        self.pool.AddSubFolder = add
        result = self._send()
        self.assertEqual(result["error_code"], "rebuild_recovery_needed")
        self.assertEqual((self.pool.move_calls, self.pool.import_calls, len(self._staging())), ([], [], 1))

    def test_record_update_failure_mid_way_stops_and_keeps_the_last_record(self):
        real, calls = resolve_bridge._write_recovery_record, []

        def flaky(path, record):
            calls.append(record["stage"])
            if len(calls) == 3:  # planned · staging_created · (moved_out 에서 실패)
                raise OSError("디스크 가득")
            return real(path, record)

        with mock.patch.object(resolve_bridge, "_write_recovery_record", side_effect=flaky):
            result = self._send()
        self.assertEqual(result["error_code"], "rebuild_recovery_needed")
        self.assertEqual((len(self.pool.move_calls), self.pool.import_calls), (1, []))  # 되돌리지 않았다
        self.assertEqual(json.loads(self._records()[0].read_text(encoding="utf-8"))["stage"], "staging_created")
        self.assertEqual(self._send()["error_code"], "rebuild_recovery_pending")

    def test_restore_never_deletes_a_bin_it_did_not_make(self):
        def half_then_user_bin(folders, target):
            self.pool.do_move(folders[:2], target)
            self._add(self.episode, "사람이 만든 Bin")  # 비어 있지만 이번에 만든 것이 아니다
            return False

        self.pool.fail[2] = half_then_user_bin
        result = self._send()
        self.assertEqual(result["error_code"], "rebuild_recovery_needed")
        self.assertIn("사람이 만든 Bin", self._names())

    def test_duplicate_clip_ids_are_not_trusted(self):
        self.existing["c0030"].children[0].clips[0].unique_id = self.existing["c0020"].clips[0].unique_id
        self._assert_old_rebuild(self._send())
        self.assertEqual(self.pool.move_calls, [])

    def test_second_parent_failure_keeps_the_first_parent_sorted(self):
        other = self._add(self.pool._parent_of(self.episode), "ep002")
        self._add(other, "c0020")
        self.pool.fail[3] = lambda folders, target: (self.pool.do_move(folders, target), False)[1]  # ep002 빼기: 다 옮기고 거짓
        self.pool.fail[4] = lambda folders, target: False  # 되돌리기 거절
        result = self._send("ep001/c0010", "ep002/c0010")
        self.assertEqual(result["error_code"], "rebuild_recovery_needed")
        self.assertEqual(self._names(), ["c0010", "c0020", "c0030", "c0040"])  # 앞 부모는 끝난 그대로
        self._assert_old_bins_kept()

    def test_unreadable_state_during_restore_stops(self):
        def half_then_unreadable(folders, target):
            self.pool.do_move(folders[:2], target)
            self.existing["c0040"].GetClipList = lambda: None
            return False

        self.pool.fail[2] = half_then_unreadable
        self.assertEqual(self._send()["error_code"], "rebuild_recovery_needed")

    def test_record_that_cannot_be_removed_after_sorting_stops(self):
        real_unlink = Path.unlink

        def unlink(path, *args, **kwargs):
            if path.parent.name == "resolve-recovery":
                raise OSError("잠김")
            return real_unlink(path, *args, **kwargs)

        with mock.patch.object(Path, "unlink", autospec=True, side_effect=unlink):
            result = self._send()
        self.assertEqual(result["error_code"], "rebuild_recovery_needed")
        self.assertEqual(self.pool.import_calls, [])
        self._assert_settles_now_that_the_record_can_be_removed()

    def _assert_settles_now_that_the_record_can_be_removed(self):
        self._assert_sorted_and_clean(self._send())  # (나) 끝난 상태 — 다음 보내기가 풀고 이어 간다

    # 확인이 안 되면 멈춘다 — 가져오기·추가 저장 없음, 기록은 남는다
    def _stop_with_tails_in_staging(self):
        self.pool.fail[1] = lambda folders, target: (self.pool.do_move(folders, target), False)[1]
        self.pool.fail[2] = lambda folders, target: False  # 되돌리기도 거절
        return self._send()

    def test_unconfirmed_restore_stops_everything_and_keeps_the_record(self):
        result = self._stop_with_tails_in_staging()
        self.assertEqual((result["status"], result["error_code"]), ("unavailable", "rebuild_recovery_needed"))
        self.assertTrue(result["rebuild_staging_bin"].startswith("__MVHUB_SORT_"))
        self.assertTrue(Path(result["rebuild_recovery_record"]).is_file())
        self.assertTrue(Path(result["folder_order_backup"]).is_file())
        self.assertEqual(self.pool.import_calls, [])
        self.assertEqual(self.manager.saved, self.saved_before + 1)  # 백업 직전 저장 하나뿐 — 실패 뒤 추가 저장 없음
        self.assertEqual([f.name for f in self._staging()[0].children], ["c0020", "c0030", "c0040"])

    def test_next_send_is_blocked_until_the_bins_are_back_then_continues(self):
        self._stop_with_tails_in_staging()
        self.pool.fail.clear()
        blocked = self._send("ep001/c0050")  # 정렬이 필요 없는 보내기도 막힌다
        self.assertEqual(blocked["error_code"], "rebuild_recovery_pending")
        self.assertNotIn("c0050", self._names())
        self.assertEqual(self.pool.import_calls, [])

        staging = self._staging()[0]  # 사람이 원래 자리로 옮기고 빈 임시 Bin 을 지웠다
        for name in ("c0020", "c0030", "c0040"):
            self.pool.do_move([self.existing[name]], self.episode)
        self.pool.root.children.remove(staging)
        self._assert_sorted_and_clean(self._send())

    def test_unreadable_or_foreign_record_blocks(self):
        self._stop_with_tails_in_staging()
        record = self._records()[0]
        record.write_text("{not json", encoding="utf-8")
        self.assertEqual(self._send()["error_code"], "rebuild_recovery_pending")
        self.manager.project.unique_id = ""  # 프로젝트 ID 를 못 읽으면 기록의 주인을 모른다
        self.assertEqual(self._send()["error_code"], "rebuild_recovery_pending")

    # 프로세스가 죽은 뒤의 다음 보내기 — (가) 처음 상태 · (나) 끝난 상태만 풀린다
    def _move_then_crash(self, folders, target):
        self.pool.do_move(folders, target)
        raise Crash()

    def test_crash_after_moving_out_blocks_until_restored(self):
        self.pool.fail[1] = self._move_then_crash
        with self.assertRaises(Crash):
            self._send()
        self.pool.fail.clear()
        self.assertEqual(self._send()["error_code"], "rebuild_recovery_pending")
        staging = self._staging()[0]
        self.pool.do_move([self.existing[name] for name in ("c0040", "c0020", "c0030")], self.episode)  # 순서는 달라도 된다
        self.pool.root.children.remove(staging)
        self._assert_sorted_and_clean(self._send())

    def test_crash_after_moving_back_settles_once_the_empty_staging_bin_is_gone(self):
        self.pool.fail[2] = self._move_then_crash
        with self.assertRaises(Crash):
            self._send()
        self.pool.fail.clear()
        self.assertEqual(self._send()["error_code"], "rebuild_recovery_pending")  # 빈 임시 Bin 이 남았다
        self.pool.root.children.remove(self._staging()[0])
        self._assert_sorted_and_clean(self._send())  # (나) — 정렬은 이미 끝나 있다
        self.assertEqual(len(self.pool.move_calls), 2)

    def test_crash_then_a_different_empty_bin_in_the_new_bins_place_does_not_settle(self):
        self.pool.fail[2] = self._move_then_crash
        with self.assertRaises(Crash):
            self._send()
        self.pool.fail.clear()
        self.pool.root.children.remove(self._staging()[0])
        index = self._names().index("c0010")
        self.episode.children[index] = FakeFolder("c0010")  # 이름은 같지만 이번에 만든 Bin 이 아니다
        self.assertEqual(self._send()["error_code"], "rebuild_recovery_pending")

    def test_crash_then_an_unexpected_root_bin_does_not_settle(self):
        self.pool.fail[2] = self._move_then_crash
        with self.assertRaises(Crash):
            self._send()
        self.pool.fail.clear()
        self._staging()[0].name = "이름이 바뀐 임시 Bin"  # 지운 줄 알았는데 남아 있다
        self.assertEqual(self._send()["error_code"], "rebuild_recovery_pending")

    def test_crash_after_moving_back_with_something_put_in_the_new_bin_does_not_settle(self):
        self.pool.fail[2] = self._move_then_crash
        with self.assertRaises(Crash):
            self._send()
        self.pool.fail.clear()
        self.pool.root.children.remove(self._staging()[0])
        next(c for c in self.episode.children if c.name == "c0010").clips.append(self._clip("manual"))  # 사람이 새 Bin 에 넣었다
        self.assertEqual(self._send()["error_code"], "rebuild_recovery_pending")

    def test_restore_that_cannot_bring_back_a_clip_stops_instead_of_rebuilding(self):
        def half_and_lose(folders, target):
            self.pool.do_move(folders[:2], target)
            self.existing["c0030"].children[0].clips.clear()  # 이동 중에 손자 Bin 의 클립이 사라졌다
            return False

        self.pool.fail[2] = half_and_lose
        result = self._send()
        self.assertEqual(result["error_code"], "rebuild_recovery_needed")  # 되돌리기 동작은 다 됐지만 처음 상태가 아니다
        self.assertEqual(self.pool.import_calls, [])

    def test_crash_with_a_missing_clip_does_not_settle(self):
        self.pool.fail[1] = self._move_then_crash
        with self.assertRaises(Crash):
            self._send()
        self.pool.fail.clear()
        staging = self._staging()[0]
        self.pool.do_move([self.existing[name] for name in ("c0020", "c0030", "c0040")], self.episode)
        self.pool.root.children.remove(staging)
        self.existing["c0030"].children[0].clips.clear()  # 손자 Bin 의 클립이 빠졌다
        self.assertEqual(self._send()["error_code"], "rebuild_recovery_pending")

    # 쓰기 경계
    def test_record_cannot_be_written_so_nothing_moves(self):
        with mock.patch.object(resolve_bridge, "_write_recovery_record", side_effect=OSError("디스크 가득")):
            result = self._send()
        self.assertEqual(result["error_code"], "rebuild_recovery_needed")
        self.assertEqual((self.pool.move_calls, self._staging(), self.pool.import_calls), ([], [], []))
        self.assertEqual(self._names(), ["c0020", "c0030", "c0040"])

    def test_switching_projects_mid_sort_stops_without_undoing_and_keeps_the_record(self):
        other = FakeProject(FakeMediaPool())
        other.unique_id = "resolve-project-2"

        def then_switch(folders, target):
            self.pool.do_move(folders, target)
            self.manager.project = other
            return True

        self.pool.fail[1] = then_switch
        result = self._send()
        self.assertEqual(result["error_code"], "project_changed")
        self.assertTrue(result["rebuild_staging_bin"].startswith("__MVHUB_SORT_"))
        self.assertTrue(Path(result["rebuild_recovery_record"]).is_file())
        self.assertEqual(len(self.pool.move_calls), 1)  # 되돌리기를 하지 않았다
        self.assertEqual(other.media_pool.root.children, [])


class FastBinSortContractTests(unittest.TestCase):
    def test_fast_sort_stays_off_until_a_build_passes_the_real_resolve_test(self):
        # 시험 프로젝트에서 실기기 시험을 통과한 판만 넣는다(Codex 설계 v3 C). 넣을 때 이 시험도 같은 커밋에서 고친다.
        self.assertEqual(resolve_bridge._MOVE_FOLDERS_TESTED, frozenset())


if __name__ == "__main__":
    unittest.main()
