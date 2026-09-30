"""레퍼런스 찾기 × 에셋 대장(2026-09-30) — 대장은 후보일 뿐, 이 PC 에서 열고 판까지 확인한 것만 잇는다.
설계: docs/ASSET_REGISTRY.md. API·알림 경계도 여기서 본다."""

from __future__ import annotations

import hashlib
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.db import get_connection, init_db
from app.mutation_notify import notification_domains
from app.repo import asset_registry as registry
from app.routers import assets

PID = "pid-registry-locate"


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class LocateWithRegistryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        init_db()

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        root = Path(self._tmp.name)
        (root / "imports").mkdir()
        self.proj = root / "PM"
        (self.proj / "assets" / "CH" / "m").mkdir(parents=True)
        self.root = root
        with get_connection() as conn:
            conn.execute("DELETE FROM asset_registry WHERE project_id=?", (PID,))
            conn.execute("DELETE FROM asset_registry_event WHERE project_id=?", (PID,))
            conn.execute("DELETE FROM asset_registry_scan WHERE project_id=?", (PID,))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def put(self, rel: str, data: bytes) -> Path:
        path = self.proj / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def scan(self, complete: bool = True) -> None:
        """이 폴더를 대장에 반영(자식 대신 직접 목록을 만든다)."""
        files = []
        for path in sorted(self.proj.rglob("*.png")):
            st = path.stat()
            files.append(registry.RegistryFile(path.relative_to(self.proj).as_posix(), st.st_size, st.st_mtime_ns,
                                               _sha(path.read_bytes()), "ok"))
        with get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            plan = registry.plan_changes(registry.registry_rows(conn, PID), registry.RegistryScan(True, files))
            registry.apply_plan(conn, PID, plan)
            registry.record_scan(conn, PID, root=str(self.proj), state="ok" if complete else "failed",
                                 complete=complete, clean=complete, files=len(files))

    def locate(self, tokens: list[str], **kw) -> dict:
        dirs = {"PM": self.proj}
        mounts = [{"name": "PM", "path": str(self.proj), "owner": "project", "project_id": PID}]
        with (
            patch.object(assets, "ASSETS_ROOT", self.root),
            patch.object(assets, "_auto_project_mounts", side_effect=lambda _r, _w=None: mounts),
            patch.object(assets, "_owner_mounts", return_value=[]),
            patch.object(assets, "actor_id", return_value="me"),
            patch.object(assets, "_safe_project_dir", side_effect=lambda name, _req: dirs.get(name)),
        ):
            return assets.locate_legacy_assets(assets.LocateIn(tokens=tokens, **kw), SimpleNamespace())

    def test_renamed_file_is_found_from_its_old_path(self) -> None:
        self.put("assets/CH/m/face.png", b"FACE")
        self.scan()
        (self.proj / "assets/CH/m/face.png").rename(self.proj / "assets/CH/m/face_final.png")
        self.scan()  # 대장이 이름 변경을 이동으로 기록
        reply = self.locate(["asset:PM_RnD|CH/m/face.png"])  # 다른 이름·깊이로 등록한 PC 의 옛 참조
        self.assertEqual(len(reply["fixed"]), 1)
        got = reply["fixed"][0]
        self.assertEqual((got["project"], got["path"]), ("PM", "assets/CH/m/face_final.png"))
        self.assertEqual(got["sha256"], _sha(b"FACE"))
        self.assertTrue(got["registry_asset_id"])
        self.assertEqual(reply["missing"], [])

    def test_registry_number_follows_a_move_even_after_an_edit(self) -> None:
        self.put("assets/CH/m/pose.png", b"V1")
        self.scan()
        with get_connection() as conn:
            rid = registry.registry_rows(conn, PID)[0]["registry_asset_id"]
        (self.proj / "assets/CH/m/old").mkdir()
        (self.proj / "assets/CH/m/pose.png").rename(self.proj / "assets/CH/m/old/pose.png")
        self.scan()
        (self.proj / "assets/CH/m/old/pose.png").write_bytes(b"V2-edited")
        self.scan()  # 같은 자리 고침 → 같은 번호의 새 판
        reply = self.locate(
            ["asset:PM|assets/CH/m/pose.png"],
            registry_ids={"asset:PM|assets/CH/m/pose.png": rid},
            fingerprints={"asset:PM|assets/CH/m/pose.png": {"sha256": _sha(b"V1"), "bytes": 2}},  # 넣을 때 판
        )
        self.assertEqual([(f["path"], f["registry_asset_id"]) for f in reply["fixed"]],
                         [("assets/CH/m/old/pose.png", rid)])
        self.assertEqual(reply["fixed"][0]["sha256"], _sha(b"V2-edited"))  # 지금 판을 알려 준다

    def test_open_reference_gets_its_number(self) -> None:
        self.put("assets/CH/m/a.png", b"A")
        self.scan()
        reply = self.locate(["asset:PM|assets/CH/m/a.png"])
        self.assertEqual(reply["open"], ["asset:PM|assets/CH/m/a.png"])
        with get_connection() as conn:
            rid = registry.registry_rows(conn, PID)[0]["registry_asset_id"]
        self.assertEqual(reply["open_ids"], {"asset:PM|assets/CH/m/a.png": rid})

    def test_incomplete_scan_is_not_trusted(self) -> None:
        self.put("assets/CH/m/face.png", b"FACE")
        self.scan()
        (self.proj / "assets/CH/m/face.png").rename(self.proj / "assets/CH/m/renamed.png")
        self.scan(complete=False)  # 마지막 훑기가 완주가 아니다 → 대장을 믿지 않는다(직접 훑기가 맡는다)
        reply = self.locate(["asset:PM|assets/CH/m/face.png"])
        self.assertEqual(reply["fixed"], [])

    def test_stale_registry_version_needs_the_content_to_match(self) -> None:
        self.put("assets/CH/m/x.png", b"OLD")
        self.scan()
        (self.proj / "assets/CH/m/x.png").rename(self.proj / "assets/CH/m/y.png")
        self.scan()
        # 대장이 모르는 사이 같은 크기로 내용이 바뀌었다(시각도 바뀜) → 지문이 달라 대장 후보를 버린다
        path = self.proj / "assets/CH/m/y.png"
        path.write_bytes(b"NEW")
        os.utime(path, ns=(path.stat().st_atime_ns, path.stat().st_mtime_ns + 10_000_000))
        reply = self.locate(["asset:PM|assets/CH/m/x.png"])
        self.assertEqual(reply["fixed"], [])

    def test_copy_without_fingerprint_is_never_linked_by_registry(self) -> None:
        self.put("assets/CH/m/octo.png", b"O")
        self.scan()
        reply = self.locate(["asset:imports|octo.png"])  # 지문도 사본도 없다 → 대장으로도 근거가 없다
        self.assertEqual(reply["fixed"], [])

    def test_copy_with_local_file_links_by_content_through_the_registry(self) -> None:
        self.put("assets/CH/m/octo.png", b"OCTO")
        self.scan()
        (self.root / "imports" / "octo.png").write_bytes(b"OCTO")
        reply = self.locate(["asset:imports|octo.png"])
        self.assertEqual([(f["project"], f["path"]) for f in reply["fixed"]], [("PM", "assets/CH/m/octo.png")])
        self.assertTrue(reply["fixed"][0]["registry_asset_id"])

    def test_without_registry_the_old_way_still_works(self) -> None:
        self.put("assets/CH/m/b.png", b"B")
        with patch.object(assets, "lookup_registry", return_value=None):
            reply = self.locate(["asset:PM_RnD|CH/m/b.png"])
        self.assertEqual([(f["project"], f["path"]) for f in reply["fixed"]], [("PM", "assets/CH/m/b.png")])
        self.assertNotIn("registry_asset_id", reply["fixed"][0])
        self.assertEqual(reply["open_ids"], {})


class RegistryApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        init_db()
        from app.main import app

        cls.client = TestClient(app, client=("127.0.0.1", 50000))  # AUTH off 는 로컬 요청만 받는다

    def test_lookup_answers_and_scan_is_off_by_default(self) -> None:
        with get_connection() as conn:
            conn.execute("DELETE FROM asset_registry WHERE project_id='api-p'")
            conn.execute("BEGIN IMMEDIATE")
            plan = registry.plan_changes([], registry.RegistryScan(True, [
                registry.RegistryFile("CH/a/z.png", 5, 1, "f" * 64, "ok")]))
            registry.apply_plan(conn, "api-p", plan)
        res = self.client.post("/api/asset-registry/lookup",
                               json={"tails": ["a/z.png"], "shas": [{"sha256": "f" * 64, "bytes": 5}]})
        self.assertEqual(res.status_code, 200)
        self.assertEqual([r["path"] for r in res.json()["tails"]["a/z.png"]], ["CH/a/z.png"])
        self.assertEqual(len(res.json()["shas"]["f" * 64]), 1)
        self.assertEqual(self.client.post("/api/asset-registry/scan", json={}).status_code, 503)
        self.assertEqual(self.client.post("/api/asset-registry/lookup", json={"tails": ["x"] * 501}).status_code, 422)

    def test_oversized_inputs_are_rejected_before_work(self) -> None:
        from pydantic import ValidationError

        self.assertEqual(self.client.post("/api/asset-registry/lookup", json={"ids": ["x" * 65]}).status_code, 422)
        self.assertEqual(self.client.post("/api/asset-registry/lookup", json={"tails": ["a/" + "b" * 1100]}).status_code, 422)
        with self.assertRaises(ValidationError):
            assets.LocateIn(tokens=[f"asset:P|{i}.png" for i in range(201)])
        with self.assertRaises(ValidationError):
            assets.LocateIn(tokens=["asset:P|" + "x" * 5000])
        with self.assertRaises(ValidationError):
            assets.LocateIn(tokens=["asset:P|a.png"], registry_ids={"asset:P|a.png": "r" * 65})
        with self.assertRaises(ValidationError):
            assets.LocateIn(tokens=["asset:P|a.png"], registry_ids={"k" * 5000: "r"})
        with self.assertRaises(ValidationError):
            assets.LocateIn(tokens=["asset:P|a.png"], fingerprints={"k" * 5000: {"sha256": "f" * 64, "bytes": 1}})
        with self.assertRaises(ValidationError):
            assets.LocateIn(tokens=["asset:P|a.png"], fingerprints={"asset:P|a.png": {"sha256": "f" * 200, "bytes": 1}})

    def test_registry_calls_do_not_refresh_everyones_library(self) -> None:
        for path in ("/api/asset-registry/lookup", "/api/asset-registry/scan"):
            self.assertEqual(notification_domains("POST", path, 200), ())


if __name__ == "__main__":
    unittest.main()
