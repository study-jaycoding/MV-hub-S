"""Resolve Media Pool 가져오기 — 계층·중복·복원 검증."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.services.resolve_bridge import import_manifest_to_current_project


class FakeClip:
    def __init__(self, path: str):
        self.path = path

    def GetClipProperty(self, key=None):
        props = {"File Path": self.path, "Clip Name": Path(self.path).name}
        return props.get(key, "") if key else props


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

    def SetCurrentFolder(self, folder):
        self.current = folder
        return True

    def AddSubFolder(self, parent, name):
        folder = FakeFolder(name)
        parent.children.append(folder)
        return folder

    def ImportMedia(self, paths):
        clips = [FakeClip(path) for path in paths]
        self.current.clips.extend(clips)
        return clips


class FakeProject:
    def __init__(self, media_pool):
        self.media_pool = media_pool

    def GetName(self):
        return "임시 테스트"

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


class FakeResolve:
    def __init__(self, project_manager):
        self.project_manager = project_manager

    def GetProjectManager(self):
        return self.project_manager


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

    def test_missing_current_project_is_reported_as_unavailable(self):
        resolve = FakeResolve(FakeProjectManager(None))
        result = import_manifest_to_current_project(self._manifest(), resolve=resolve)

        self.assertEqual(result["status"], "unavailable")
        self.assertIn("현재 열려 있는", result["error"])

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
