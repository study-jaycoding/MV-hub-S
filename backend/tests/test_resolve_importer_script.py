"""Resolve 메뉴용 MVHub Importer 독립 스크립트 검증."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "app"
    / "resources"
    / "resolve"
    / "MVHub_Importer.py"
)


def _load_importer():
    spec = importlib.util.spec_from_file_location("mvhub_importer_test", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


class FakeClip:
    def __init__(self, path: str):
        self.path = path

    def GetClipProperty(self, name=None):
        return self.path if name == "File Path" else {"File Path": self.path}


class FakeFolder:
    def __init__(self, name: str):
        self.name = name
        self.children = []
        self.clips = []

    def GetName(self):
        return self.name

    def GetSubFolderList(self):
        return self.children

    def GetClipList(self):
        return self.clips


class FakeMediaPool:
    def __init__(self):
        self.root = FakeFolder("Master")
        self.current = self.root

    def GetRootFolder(self):
        return self.root

    def GetCurrentFolder(self):
        return self.current

    def AddSubFolder(self, parent, name):
        folder = FakeFolder(name)
        parent.children.append(folder)
        return folder

    def SetCurrentFolder(self, folder):
        self.current = folder
        return True

    def ImportMedia(self, paths):
        clips = [FakeClip(path) for path in paths]
        self.current.clips.extend(clips)
        return clips

    def RefreshFolders(self):
        return None


class FakeProject:
    def __init__(self, media_pool, project_id="resolve-1", name="편집 프로젝트"):
        self.media_pool = media_pool
        self.project_id = project_id
        self.name = name

    def GetMediaPool(self):
        return self.media_pool

    def GetUniqueId(self):
        return self.project_id

    def GetName(self):
        return self.name


class FakeManager:
    def __init__(self, project):
        self.project = project
        self.saved = 0

    def GetCurrentProject(self):
        return self.project

    def SaveProject(self):
        self.saved += 1
        return True


class FakeResolve:
    def __init__(self, manager):
        self.manager = manager

    def GetProjectManager(self):
        return self.manager


class ResolveImporterScriptTests(unittest.TestCase):
    def setUp(self):
        self.importer = _load_importer()
        self.temp = tempfile.TemporaryDirectory()
        self.source = Path(self.temp.name) / "clip.mp4"
        self.source.write_bytes(b"video")
        self.pool = FakeMediaPool()
        self.manager = FakeManager(FakeProject(self.pool))
        self.resolve = FakeResolve(self.manager)

    def tearDown(self):
        self.temp.cleanup()

    def _manifest(self):
        return {
            "project_id": "p1",
            "project_name": "MV 프로젝트",
            "transfer_id": "transfer-1",
            "resolve_target": {
                "project_id": "resolve-1",
                "project_name": "편집 프로젝트",
            },
            "items": [
                {
                    "status": "downloaded",
                    "folder_path": "e001/c0010",
                    "local_path": str(self.source),
                }
            ],
        }

    def test_imports_pending_media_and_records_completion(self):
        calls = []

        def fake_http(method, path, payload=None, bases=None):
            calls.append((method, path, payload, bases))
            if method == "GET":
                return {"items": [self._manifest()]}, "http://127.0.0.1:8010"
            return {"ok": True}, "http://127.0.0.1:8010"

        with mock.patch.object(self.importer, "_http_json", side_effect=fake_http):
            message = self.importer.import_pending(self.resolve)

        mv_hub = self.pool.root.children[0]
        project = mv_hub.children[0]
        episode = project.children[0]
        sequence = episode.children[0]
        self.assertEqual(
            [mv_hub.name, project.name, episode.name, sequence.name],
            ["MV Hub", "MV 프로젝트", "e001", "c0010"],
        )
        self.assertEqual(sequence.clips[0].path, str(self.source))
        self.assertIn("새 원본 1개", message)
        self.assertEqual(calls[-1][2]["status"], "complete")
        self.assertEqual(self.manager.saved, 1)

    def test_different_target_project_is_left_pending(self):
        manifest = self._manifest()
        manifest["resolve_target"]["project_id"] = "another-project"

        def fake_http(method, _path, payload=None, bases=None):
            if method == "GET":
                return {"items": [manifest]}, "http://127.0.0.1:8010"
            self.fail("다른 프로젝트 전송은 완료 처리하면 안 됩니다")

        with mock.patch.object(self.importer, "_http_json", side_effect=fake_http):
            message = self.importer.import_pending(self.resolve)

        self.assertIn("다른 프로젝트 전송은 보류", message)
        self.assertEqual(self.pool.root.children, [])
        self.assertEqual(self.manager.saved, 0)


if __name__ == "__main__":
    unittest.main()
