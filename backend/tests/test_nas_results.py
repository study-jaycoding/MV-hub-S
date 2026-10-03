"""결과물 훑기(docs/NAS_RESULTS.md) — 자식 결과물 모드 · 스냅샷 루트 묶음 · 도우미 올리기 · 잇기 판정."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import tempfile
import time
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import db
from app.db import get_connection, init_db
from app.repo import nas_results as nas_repo
from app.routers import asset_registry as api
from app.services import asset_registry as svc
from app.services import asset_registry_helper as helper_mod
from app.services import asset_registry_scan as child
from app.services import nas_results as link

J1 = "11111111-2222-4333-8444-555555555555"
J2 = "22222222-3333-4444-8555-666666666666"
J3 = "33333333-4444-4555-8666-777777777777"
G1 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
SHA = "c" * 64
UNC = r"\\nas\share\PROJ"


def _chunk(kind: bytes, data: bytes) -> bytes:
    return len(data).to_bytes(4, "big") + kind + data + zlib.crc32(kind + data).to_bytes(4, "big")


def _itxt(key: bytes, text: str, compressed: bool = False) -> bytes:
    return _chunk(b"iTXt", key + b"\0" + (b"\1\0" if compressed else b"\0\0") + b"\0\0" + text.encode())


def _png(*middle: bytes) -> bytes:
    return child._PNG_SIG + _chunk(b"IHDR", b"\0" * 13) + b"".join(middle) + _chunk(b"IEND", b"")


# ── 자식 결과물 모드 ──────────────────────────────────────────────────────


class ChildResultsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name) / "10_ai"
        (self.root / "render" / "e030").mkdir(parents=True)
        (self.root / "assets").mkdir()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def put(self, rel: str, data: bytes) -> bytes:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return data

    def run_child(self) -> tuple[dict, dict[str, dict]]:
        out = Path(self.tmp.name) / "out.jsonl"
        end = child.run({"root": str(self.root), "results": True, "out": str(out), "deadline_s": 60,
                         "rate_bytes": 1 << 30, "dir_rate": 1000, "max_entries": 1000})
        lines = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
        return end, {item["p"]: item for item in lines if item.get("t") == "result"}

    def test_reads_head_and_png_ids_including_render_and_tail_chunks(self) -> None:
        video = self.put("render/e030/hf_x.mp4", os.urandom(200_000))
        png = self.put("assets/a.png", _png(
            _chunk(b"tEXt", b"hf-job-id\0" + J1.encode()),
            _chunk(b"IDAT", b"x" * 300_000),  # 64KiB 너머 — seek 로 건너뛰고 뒤의 각인을 본다
            _itxt(b"mvhub.job_id", J2),
            _itxt(b"mvhub.gen_id", G1.upper()),
        ))
        self.put("_hidden.png", b"x")
        self.put("notes.txt", b"x")
        end, rows = self.run_child()
        self.assertTrue(end["complete"])
        self.assertEqual(set(rows), {"render/e030/hf_x.mp4", "assets/a.png"})  # render 포함·숨김·비미디어 제외
        self.assertEqual(rows["render/e030/hf_x.mp4"]["h"], hashlib.sha256(video[:65536]).hexdigest())
        self.assertEqual(rows["render/e030/hf_x.mp4"]["b"], len(video))
        r = rows["assets/a.png"]
        self.assertEqual((r["st"], r["hf"], r["mj"], r["mg"]), ("ok", J1, J2, G1))
        self.assertEqual(r["h"], hashlib.sha256(png[:65536]).hexdigest())

    def test_broken_chunks_stop_the_walk_and_unsupported_text_is_not_an_id(self) -> None:
        self.put("broken.png", child._PNG_SIG + _chunk(b"IHDR", b"\0" * 13)
                 + (10**9).to_bytes(4, "big") + b"IDAT" + b"x" * 100
                 + _chunk(b"tEXt", b"hf-job-id\0" + J1.encode()))
        self.put("zipped.png", _png(_itxt(b"mvhub.job_id", J2, compressed=True),
                                    _chunk(b"tEXt", b"hf-job-id\0not-a-uuid")))
        self.put("empty.png", b"")
        _end, rows = self.run_child()
        self.assertEqual((rows["broken.png"]["st"], rows["broken.png"]["hf"]), ("ok", None))  # 미관측
        self.assertEqual((rows["zipped.png"]["mj"], rows["zipped.png"]["hf"]), (None, None))
        self.assertEqual((rows["empty.png"]["st"], rows["empty.png"]["h"]), ("undetermined", None))

    def test_duplicate_ids_conflict_and_bad_crc_or_method_are_not_ids(self) -> None:
        bad_crc = _chunk(b"tEXt", b"hf-job-id\0" + J1.encode())
        bad_crc = bad_crc[:-4] + b"\0\0\0\0"
        odd_method = _chunk(b"iTXt", b"mvhub.job_id\0" + b"\0\7" + b"\0\0" + J2.encode())
        self.put("dup.png", _png(_itxt(b"mvhub.job_id", J2), _itxt(b"mvhub.job_id", J3)))
        self.put("same.png", _png(_itxt(b"mvhub.job_id", J2), _itxt(b"mvhub.job_id", J2)))
        self.put("crc.png", _png(bad_crc, _itxt(b"mvhub.gen_id", G1)))
        self.put("method.png", _png(odd_method))
        _end, rows = self.run_child()
        self.assertEqual((rows["dup.png"]["mj"], rows["dup.png"]["x"]), (None, 1))  # 고르지 않는다
        self.assertEqual((rows["same.png"]["mj"], rows["same.png"]["x"]), (J2, 0))
        self.assertEqual((rows["crc.png"]["hf"], rows["crc.png"]["mg"]), (None, G1))  # 깨진 청크만 버리고 걷기는 계속
        self.assertIsNone(rows["method.png"]["mj"])

    def test_missing_root_is_incomplete(self) -> None:
        self.root = Path(self.tmp.name) / "nope"
        end, rows = self.run_child()
        self.assertFalse(end["complete"])
        self.assertEqual(rows, {})


# ── 잇기 판정 ─────────────────────────────────────────────────────────────


def _fact(job: str, *, email: str = "a@x", gen: str = "", size=None, head=None) -> dict:
    return {"job_id": job, "local_gen_id": gen, "account_email": email, "result_bytes": size, "result_head_sha": head}


def _file(path: str, **kw) -> dict:
    row = {"path": path, "status": "ok", "bytes": kw.pop("bytes", 10), "head_sha": kw.pop("head", None)}
    row.update({"hf_job_id": None, "mv_job_id": None, "mv_gen_id": None, **kw})
    return row


class JudgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.index = link.build_index([
            _fact(J1, size=10, head=SHA), _fact(J2, size=10, head=SHA), _fact(J3, gen=G1),
        ])

    def judge(self, row: dict) -> dict:
        return link.judge(row, self.index)

    def test_strong_clues(self) -> None:
        self.assertEqual(self.judge(_file(f"hf_20260729_024300_{J1}.mp4"))["state"], "linked")
        self.assertEqual(self.judge(_file("x.png", hf_job_id=J3))["job_id"], J3)
        # 강 단서끼리 엇갈림 → 충돌
        self.assertEqual(self.judge(_file(f"hf_20260729_024300_{J1}.png", hf_job_id=J3))["state"], "conflict")
        # 장부에 없는 job → '장부에 없음'으로 끝(쌍이 다른 job 과 맞아도 내려가지 않는다)
        absent = "99999999-9999-4999-8999-999999999999"
        got = self.judge(_file("x.png", hf_job_id=absent, head=SHA))
        self.assertEqual((got["state"], got["job_id"]), ("absent", absent))

    def test_candidate_sets_intersect(self) -> None:
        # 쌍만 → J1·J2 두 후보
        got = self.judge(_file("renamed.mp4", head=SHA))
        self.assertEqual((got["state"], got["candidates"]), ("candidates", sorted([J1, J2])))
        # 이름 앞자리 {J1} ∩ 쌍 {J1,J2} → J1
        self.assertEqual(self.judge(_file("prompt start-11111111.mp4", head=SHA))["job_id"], J1)
        # 강 {J3} ∩ 쌍 {J1,J2} → 충돌(약하다고 버리지 않는다)
        self.assertEqual(self.judge(_file("x.mp4", hf_job_id=J3, head=SHA))["state"], "conflict")
        # 단서 없음 → 못 찾음 · 풀리지 않는 gen(job 단서 없음) → 보류
        self.assertEqual(self.judge(_file("e050_c0140_03.mp4"))["state"], "unmatched")
        self.assertEqual(self.judge(_file("x.png", mv_gen_id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"))["state"], "absent")
        self.assertEqual(self.judge(_file("x.png", mv_gen_id=G1))["job_id"], J3)

    def test_unresolved_gen_holds_unless_a_job_clue_speaks(self) -> None:
        unknown_gen = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        # 장부에 없는 각인 gen + 다른 job 들과 맞는 지문 → 지문으로 내려가지 않고 보류
        got = self.judge(_file("renamed.png", mv_gen_id=unknown_gen, head=SHA))
        self.assertEqual((got["state"], got["method"]), ("absent", "mv_gen_id"))
        # job 단서가 있으면 그 job 이 정체를 말한다(서버 카드 id 일 수 있는 gen 은 무시)
        self.assertEqual(self.judge(_file("x.png", mv_job_id=J1, mv_gen_id=unknown_gen))["job_id"], J1)
        # 같은 PNG 에 다른 번호가 있었다 → 충돌
        self.assertEqual(self.judge(_file("x.png", hf_job_id=J1, id_conflict=1))["state"], "conflict")

    def test_owner_ambiguity_and_non_ok_files(self) -> None:
        index = link.build_index([_fact(J1, email="a@x"), _fact(J1, email="b@x")])
        got = link.judge(_file("x.png", hf_job_id=J1), index)
        self.assertEqual((got["state"], got["owner_ambiguous"]), ("linked", True))
        pending = _file("renamed.mp4", head=SHA, status="pending")
        self.assertEqual(self.judge(pending)["state"], "unmatched")  # 값 없는 파일의 쌍은 쓰지 않는다


# ── 스냅샷: 완주만, 시작 루트에 묶음 ─────────────────────────────────────────


class SnapshotTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        with get_connection() as conn:
            conn.execute("INSERT INTO project(id, name, kind, render_root_path) VALUES('p1','P','team',?)",
                         (r"Z:\PROJ\10_ai",))

    def tearDown(self) -> None:
        db.flush_pool()
        if self.old is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old
        db.flush_pool()
        self.tmp.cleanup()

    def rows(self) -> list[dict]:
        with get_connection() as conn:
            return nas_repo.snapshot(conn, "p1", svc.root_key(nas_repo.current_root(conn, "p1")))

    def test_replace_only_when_root_unchanged_and_read_only_for_current_root(self) -> None:
        files = [svc.result_row({"p": "render/a.mp4", "b": 10, "m": 1, "h": SHA, "hf": None, "mj": None, "mg": None,
                                 "st": "ok"})]
        self.assertEqual(svc.apply_results_snapshot("p1", r"Z:\PROJ\10_ai", "server", files)["applied"], True)
        self.assertEqual([r["path"] for r in self.rows()], ["render/a.mp4"])
        # 훑는 사이 루트가 바뀌었다 → 버린다(옛 스냅샷 그대로)
        got = svc.apply_results_snapshot("p1", r"Z:\OTHER", "server", [])
        self.assertEqual(got, {"applied": False, "why": "root_changed"})
        self.assertEqual(len(self.rows()), 1)
        # 지금 루트가 바뀌면 옛 스냅샷은 안 쓴다
        with get_connection() as conn:
            conn.execute("UPDATE project SET render_root_path=? WHERE id='p1'", (r"Z:\OTHER",))
        self.assertEqual(self.rows(), [])

    def test_values_kept_only_for_ok_rows(self) -> None:
        row = svc.result_row({"p": "a.png", "b": 5, "m": 1, "h": SHA, "hf": J1, "mj": None, "mg": None, "st": "pending"})
        self.assertEqual((row["head_sha"], row["hf_job_id"], row["status"]), (None, None, "pending"))


class ControllerHookTests(unittest.TestCase):
    def test_results_follow_the_registry_scan_and_not_after_stop(self) -> None:
        ctl = svc.AssetRegistryController()
        applied = []

        async def fake_scan(pid, name, root, rate, deadline):
            return {"state": self.state, "large": []}

        async def fake_child(job, deadline_s, reader=None):
            self.assertTrue(job["results"])
            return {"t": "end", "complete": True, "read": 1}, [{"path": "a.mp4"}], [], ""

        with patch.object(ctl, "_scan_project", fake_scan), patch.object(ctl, "_run_child", fake_child), \
                patch.object(ctl, "_apply_results", lambda pid, root, files: applied.append((pid, root, files)) or {}):
            self.state = "ok"
            asyncio.run(ctl._project_run("p1", "P", r"Z:\PROJ", 1.0, 10.0))
            self.state = "stopped"
            asyncio.run(ctl._project_run("p2", "P", r"Z:\PROJ", 1.0, 10.0))
        self.assertEqual(applied, [("p1", r"Z:\PROJ", [{"path": "a.mp4"}])])


# ── 도우미 올리기 ─────────────────────────────────────────────────────────


class HelperUploadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        init_db()
        from app.main import app

        cls.client = TestClient(app, client=("127.0.0.1", 50000))

    def setUp(self) -> None:
        self.pid = f"nr-{time.time_ns()}"
        svc.leases._lease = None
        for p in (
            patch.object(svc, "ASSET_REGISTRY_ENABLED", True),
            patch.object(api, "pm_projects", return_value=[(self.pid, "P", UNC)]),
            patch.object(api, "canonical_unc", return_value=UNC),
        ):
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(setattr, svc.leases, "_lease", None)
        svc.repo.set_setting(svc._MODE_KEY, "local")
        svc._mode_cache = None
        self.addCleanup(lambda: (svc.repo.set_setting(svc._MODE_KEY, None), setattr(svc, "_mode_cache", None)))
        with get_connection() as conn:
            conn.execute("INSERT INTO project(id, name, kind, render_root_path) VALUES(?,?, 'team', ?)",
                         (self.pid, "P", UNC))
        self.addCleanup(self._drop)

    def _drop(self) -> None:
        with get_connection() as conn:
            conn.execute("DELETE FROM project WHERE id=?", (self.pid,))
            conn.execute("DELETE FROM nas_result_file WHERE project_id=?", (self.pid,))
            conn.execute("DELETE FROM nas_result_scan WHERE project_id=?", (self.pid,))

    def lease(self) -> str:
        res = self.client.post("/api/asset-registry/helper/lease", json={"project_id": self.pid})
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()["lease_id"]

    def send(self, lease_id: str, seq: int, files: list[dict]):
        return self.client.post("/api/asset-registry/helper/results", json={"lease_id": lease_id, "seq": seq,
                                                                            "files": files})

    def test_render_allowed_snapshot_bound_to_lease_root_and_resend_acked(self) -> None:
        lease_id = self.lease()
        files = [{"p": "render/e030/a.mp4", "b": 10, "m": 1, "h": SHA, "hf": None, "mj": None, "mg": None, "st": "ok"},
                 {"p": "assets/b.png", "b": 3, "m": 1, "h": None, "hf": None, "mj": None, "mg": None,
                  "st": "undetermined"}]
        first = self.send(lease_id, 1, files)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertTrue(first.json()["applied"])
        self.assertEqual(self.send(lease_id, 1, files).json(), first.json())  # 같은 순번·같은 내용 → 같은 답
        with get_connection() as conn:
            rows = nas_repo.snapshot(conn, self.pid, svc.root_key(UNC))
        self.assertEqual(sorted(r["path"] for r in rows), ["assets/b.png", "render/e030/a.mp4"])

    def test_rows_are_checked(self) -> None:
        lease_id = self.lease()
        base = {"p": "a.mp4", "b": 10, "m": 1, "h": SHA, "hf": None, "mj": None, "mg": None, "st": "ok"}
        for bad in ({"p": "../a.mp4"}, {"p": "_x/a.mp4"}, {"p": "a.txt"}, {"h": "XYZ"}, {"hf": "not-uuid"},
                    {"st": "pending"}, {"st": "undetermined", "h": None, "x": 1}, {"x": 2}):
            with self.subTest(bad):
                self.assertEqual(self.send(lease_id, 1, [{**base, **bad}]).status_code, 422)
        self.assertEqual(self.send(lease_id, 1, [base, dict(base)]).status_code, 422)  # 같은 경로 두 번

    def test_old_server_is_skipped_without_stopping_the_helper(self) -> None:
        h = helper_mod.HelperController()
        h._lease = {"id": "L", "seq": 2}

        def old(*_a, **_k):
            raise helper_mod._OldServer("옛 서버")

        with patch.object(h, "_call", old):
            got = h._apply_results("p", UNC, [svc.result_row({"p": "a.mp4", "b": 1, "m": 1, "h": SHA, "st": "ok"})])
        self.assertEqual(got, {"applied": False, "why": "old_server"})
        self.assertEqual((h._lease["seq"], h._abort), (2, ""))


if __name__ == "__main__":
    unittest.main()
