"""에셋 대장 도우미 PC 훑기(2026-09-30) — 서버가 NAS 를 못 읽을 때 관리자 PC 가 대신 훑어 올린다.
설계: docs/ASSET_REGISTRY.md §10(Claude 설계 · Codex 합의). 서버 자리(lease)·결과 검증·도우미 흐름을 본다."""

from __future__ import annotations

import asyncio
import hashlib
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.db import get_connection, init_db
from app.mutation_notify import notification_domains
from app.repo import asset_registry as registry
from app.routers import asset_registry as api
from app.services import asset_registry as svc
from app.services import asset_registry_helper as helper_mod
from app.services.upload_limits import UPLOAD_REQUEST_LIMITS

UNC = r"\\nas\share\PROJ"


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _ok(path: str, data: bytes) -> dict:
    return {"p": path, "b": len(data), "m": 1, "s": _sha(data), "st": "ok"}


class _ServerCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        init_db()
        from app.main import app

        cls.client = TestClient(app, client=("127.0.0.1", 50000))  # AUTH off 는 로컬 요청만 받는다

    def setUp(self) -> None:
        self.pid = f"hp-{time.time_ns()}"
        svc.leases._lease = None
        patches = [
            patch.object(api, "ASSET_REGISTRY_HELPER", True),
            patch.object(api, "pm_projects", return_value=[(self.pid, "뻘뻘뻘", r"Z:\PROJ")]),
            patch.object(api, "canonical_unc", return_value=UNC),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(setattr, svc.leases, "_lease", None)

    def lease(self) -> dict:
        res = self.client.post("/api/asset-registry/helper/lease", json={"project_id": self.pid})
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()

    def result(self, lease_id: str, seq: int, files: list[dict], complete: bool = True):
        return self.client.post("/api/asset-registry/helper/result", json={
            "lease_id": lease_id, "seq": seq, "complete": complete, "files": files,
            "stats": {"hashed": len(files), "hashed_bytes": 0, "elapsed_ms": 5}})

    def rows(self) -> dict:
        with get_connection() as conn:
            return {r["path"]: r for r in registry.registry_rows(conn, self.pid)}

    def scan_row(self):
        with get_connection() as conn:
            return {r["project_id"]: r for r in registry.scan_rows(conn)}.get(self.pid)


class HelperServerTests(_ServerCase):
    def test_complete_results_follow_the_same_rules_as_a_server_scan(self) -> None:
        lease = self.lease()
        self.assertEqual(lease["unc"], UNC)
        self.assertEqual(self.result(lease["lease_id"], 1, [_ok("assets/CH/a.png", b"A")]).status_code, 200)
        self.client.post("/api/asset-registry/helper/release", json={"lease_id": lease["lease_id"]})
        rid = self.rows()["assets/CH/a.png"]["registry_asset_id"]
        # 다음 자리에서 이름을 바꾼 결과 → 같은 번호로 이동(서버만 번호를 만든다)
        lease = self.lease()
        self.assertEqual([k["p"] for k in lease["known"]], ["assets/CH/a.png"])  # 안 바뀐 파일을 다시 읽지 않게
        ack = self.result(lease["lease_id"], 1, [_ok("assets/CH/a_final.png", b"A")]).json()
        self.assertEqual(ack["kinds"].get("moved"), 1)
        self.assertEqual(self.rows()["assets/CH/a_final.png"]["registry_asset_id"], rid)
        scan = self.scan_row()
        self.assertEqual((scan["state"], scan["complete"], scan["note"], scan["root"]), ("ok", 1, "도우미 PC", UNC))

    def test_incomplete_result_changes_nothing(self) -> None:
        lease = self.lease()
        self.result(lease["lease_id"], 1, [_ok("assets/CH/a.png", b"A")])
        before = self.scan_row()
        ack = self.result(lease["lease_id"], 2, [], complete=False).json()
        self.assertFalse(ack["applied"])
        self.assertEqual(set(self.rows()), {"assets/CH/a.png"})  # 없어진 것으로 보지 않는다
        self.assertEqual(dict(self.scan_row()), dict(before))  # 마지막 완주 기록도 그대로

    def test_one_scanner_at_a_time_both_ways(self) -> None:
        lease = self.lease()
        self.assertEqual(self.client.post("/api/asset-registry/helper/lease",
                                          json={"project_id": self.pid}).status_code, 409)
        # 도우미가 훑는 동안 서버 훑기(수동·자동 모두 request_scan 을 지난다)도 막힌다
        with patch.object(svc, "ASSET_REGISTRY_ENABLED", True):
            self.assertEqual(self.client.post("/api/asset-registry/scan", json={}).status_code, 409)
        self.assertFalse(svc.controller.request_scan(mode="auto"))
        self.client.post("/api/asset-registry/helper/release", json={"lease_id": lease["lease_id"]})
        self.assertFalse(svc.leases.active())
        # 반대로 서버가 훑는 중이면 자리를 주지 않는다
        with patch.object(svc.controller, "busy", return_value=True):
            self.assertEqual(self.client.post("/api/asset-registry/helper/lease",
                                              json={"project_id": self.pid}).status_code, 409)

    def test_resend_gets_the_same_answer_and_stale_or_changed_sends_are_refused(self) -> None:
        lease = self.lease()
        files = [_ok("assets/CH/a.png", b"A")]
        first = self.result(lease["lease_id"], 1, files).json()
        again = self.result(lease["lease_id"], 1, files)  # 응답이 유실돼 다시 보냄 → 두 번 반영하지 않고 같은 답
        self.assertEqual((again.status_code, again.json()), (200, first))
        self.assertEqual(self.result(lease["lease_id"], 1, [_ok("assets/CH/b.png", b"B")]).status_code, 409)
        self.assertEqual(self.result(lease["lease_id"], 3, files).status_code, 409)  # 순번 건너뜀
        self.assertEqual(set(self.rows()), {"assets/CH/a.png"})

    def test_expired_or_unknown_lease_is_refused(self) -> None:
        lease = self.lease()
        svc.leases._lease["expires"] = time.monotonic() - 1
        self.assertEqual(self.result(lease["lease_id"], 1, [_ok("assets/CH/a.png", b"A")]).status_code, 409)
        self.assertEqual(self.client.post("/api/asset-registry/helper/renew",
                                          json={"lease_id": lease["lease_id"]}).status_code, 409)
        self.assertEqual(self.result("nope", 1, []).status_code, 409)  # 서버가 재시작해 자리를 모른다
        self.assertEqual(self.rows(), {})

    def test_applying_lease_does_not_expire(self) -> None:
        lease = svc.leases.acquire("p", "n", "o", UNC, lambda: False)
        self.assertEqual(svc.leases.begin_apply(lease["id"], "o", 1, "d")[0], "apply")
        svc.leases._lease["expires"] = time.monotonic() - 1
        self.assertTrue(svc.leases.active())  # 반영 중에는 서버 훑기가 끼어들지 못한다
        svc.leases.finish_apply(lease["id"], 1, "d", None)  # 반영 실패 → 순번을 올리지 않는다
        self.assertEqual(svc.leases.begin_apply(lease["id"], "o", 1, "d")[0], "apply")

    def test_files_are_checked_like_the_scanner_would_write_them(self) -> None:
        lease = self.lease()
        bad = [
            {**_ok("../x.png", b"A")}, {**_ok("/abs/x.png", b"A")}, {**_ok("a\\x.png", b"A")},
            {**_ok("C:/x.png", b"A")}, {**_ok("a//x.png", b"A")}, {**_ok(".hidden/x.png", b"A")},
            {**_ok("_tmp/x.png", b"A")}, {**_ok("render/x.png", b"A")}, {**_ok("a/notes.txt", b"A")},
            {**_ok("a/x.png", b"A"), "s": None}, {**_ok("a/x.png", b"A"), "s": "A" * 64},
            {**_ok("a/x.png", b"A"), "b": 0}, {"p": "a/x.png", "b": 1, "m": 1, "s": "f" * 64, "st": "pending"},
            {**_ok("a/x.png", b"A"), "b": True}, {**_ok("a/x.png", b"A"), "st": "done"},
            {**_ok("a/x.png", b"A"), "extra": 1}, {**_ok("a/x.png", b"A"), "m": 1 << 63},
        ]
        for i, f in enumerate(bad):
            res = self.result(lease["lease_id"], 1, [f])
            self.assertEqual(res.status_code, 422, (i, f, res.text))
        dup = self.result(lease["lease_id"], 1, [_ok("a/X.png", b"A"), _ok("a/x.png", b"B")])
        self.assertEqual(dup.status_code, 422)
        huge = self.client.post("/api/asset-registry/helper/result", json={  # SQLite 정수 밖 → 기록 단계 500 대신 422(Codex P2)
            "lease_id": lease["lease_id"], "seq": 1, "complete": True, "files": [],
            "stats": {"hashed_bytes": 1 << 63}})
        self.assertEqual(huge.status_code, 422)
        # render 라는 이름의 **파일**·미판정 파일(지문 없음)은 받는다(자식도 그렇게 쓴다)
        good = [_ok("a/render.png", b"R"), {"p": "a/lock.png", "b": 0, "m": 0, "s": None, "st": "undetermined"}]
        self.assertEqual(self.result(lease["lease_id"], 1, good).status_code, 200)
        self.assertEqual(self.scan_row()["state"], "partial")  # 미판정이 있어 이동·없어짐은 보류

    def test_off_by_default_and_old_names_unchanged(self) -> None:
        with patch.object(api, "ASSET_REGISTRY_HELPER", False):
            self.assertEqual(self.client.get("/api/asset-registry/helper/projects").status_code, 503)
            self.assertEqual(self.client.post("/api/asset-registry/helper/lease",
                                              json={"project_id": self.pid}).status_code, 503)
        with patch.object(api, "canonical_unc", return_value=None):  # 서버가 공유 주소를 모르면 도우미도 못 훑는다
            self.assertEqual(self.client.post("/api/asset-registry/helper/lease",
                                              json={"project_id": self.pid}).status_code, 422)
        self.assertEqual(self.client.post("/api/asset-registry/helper/lease",
                                          json={"project_id": "nope"}).status_code, 404)
        self.assertIn("/api/asset-registry/helper/result", UPLOAD_REQUEST_LIMITS)  # 본문은 파싱 전에 막는다
        for path in ("/api/registry-helper/scan", "/api/asset-registry/helper/result"):
            self.assertEqual(notification_domains("POST", path, 200), ())


class HelperPieceTests(unittest.TestCase):
    def test_server_refusals_stop_everything_or_just_the_project(self) -> None:
        err = helper_mod._error_for
        for code, detail in ((401, ""), (403, ""), (404, "Not Found"), (405, ""), (503, "꺼짐")):
            self.assertIsInstance(err(code, detail), helper_mod._Abort, code)
        for code, detail in ((404, "없는 프로젝트입니다"), (409, "훑는 중"), (413, ""), (422, "x")):
            self.assertIsInstance(err(code, detail), helper_mod._ProjectFail, code)

    def test_result_state_follows_the_last_upload(self) -> None:
        # 큰 파일 보충 뒤 다시 훑어 완주·clean 이 되면 이 PC 결과도 '완료' — 첫 훑기의 '일부 대기'로 남지 않는다(Codex P2)
        h = helper_mod.HelperController()
        h._lease = {"id": "L", "seq": 0}
        scan = registry.RegistryScan(True, [registry.RegistryFile("a/x.png", 1, 1, "f" * 64, "ok")])
        for clean, want in ((False, "partial"), (True, "ok")):
            with patch.object(h, "_call", return_value={"clean": clean, "kinds": {}}):
                h._apply("p", "n", scan, {"files": 1})
            self.assertEqual(h._detail["state"], want)
        h._apply("p", "n", registry.RegistryScan(False, []), {"files": 0, "note": "폴더 읽기 실패"})
        self.assertEqual(h._detail["state"], "failed")

    def test_same_share_only_when_this_pc_maps_the_drive_to_the_server_unc(self) -> None:
        mapping = {r"Z:\PROJ": UNC.upper() + "\\", r"C:\PROJ": r"C:\PROJ", r"Q:\PROJ": None, UNC: UNC}
        with patch.object(helper_mod, "unc_for_drive", side_effect=lambda p: mapping.get(p)):
            self.assertTrue(helper_mod._same_share(r"Z:\PROJ", UNC))  # 대소문자·끝 구분자 무시
            self.assertTrue(helper_mod._same_share(UNC, UNC))
            self.assertFalse(helper_mod._same_share(r"C:\PROJ", r"C:\PROJ"))  # 로컬 디스크는 공유가 아니다
            self.assertFalse(helper_mod._same_share(r"Q:\PROJ", UNC))  # 이 PC 가 모른다
            self.assertFalse(helper_mod._same_share(r"Z:\PROJ", r"\\other\share\PROJ"))


class HelperFlowTests(_ServerCase):
    """도우미 흐름 전체 — 서버 호출은 같은 앱에 보내고(TestClient), 자식 훑기는 진짜로 돈다."""

    def setUp(self) -> None:
        super().setUp()
        self._tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self._tmp.name)
        (self.root / "assets" / "CH").mkdir(parents=True)
        (self.root / "assets" / "CH" / "a.png").write_bytes(b"A" * 40)
        self.addCleanup(self._tmp.cleanup)
        self.helper = helper_mod.HelperController()
        self.token = "tok"

        def fake_call(method, path, body=None, timeout=60, pinned_ok=False):
            if not pinned_ok and helper_mod.shared_connection.token() != self.helper._token:
                raise helper_mod._Abort("로그인이 바뀌어 멈췄습니다")
            res = self.client.request(method, path, json=body)
            if res.status_code >= 400:
                raise helper_mod._error_for(res.status_code, str(res.json().get("detail") or ""))
            return res.json()

        for p in [
            patch.object(api, "canonical_unc", return_value=str(self.root)),  # 시험에선 '공유 주소' = 임시 폴더
            patch.object(helper_mod, "_same_share", return_value=True),
            patch.object(helper_mod.shared_connection, "token", side_effect=lambda: self.token),
            patch.object(helper_mod.shared_connection, "base_url", return_value="http://server"),
            patch.object(self.helper, "_call", side_effect=fake_call),
        ]:
            p.start()
            self.addCleanup(p.stop)

    def run_helper(self) -> dict:
        async def scenario() -> None:
            ok, why = self.helper.begin(None)
            self.assertTrue(ok, why)
            for _ in range(600):
                if not self.helper.busy():
                    break
                await asyncio.sleep(0.05)
        asyncio.run(scenario())
        return self.helper.helper_status()

    def test_helper_scans_this_pc_and_the_server_numbers_it(self) -> None:
        status = self.run_helper()
        self.assertEqual(status["abort"], "")
        self.assertEqual([(r["project_id"], r["state"], r.get("clean")) for r in status["results"]],
                         [(self.pid, "ok", True)])
        self.assertIn("assets/CH/a.png", self.rows())
        self.assertFalse(svc.leases.active())  # 끝나면 자리를 돌려준다
        self.assertEqual(self.scan_row()["note"], "도우미 PC")

    def test_mismatched_share_is_not_scanned_and_the_lease_is_returned(self) -> None:
        with patch.object(helper_mod, "_same_share", return_value=False):
            status = self.run_helper()
        self.assertEqual(status["results"][0]["state"], "failed")
        self.assertIn("공유 주소", status["results"][0]["note"])
        self.assertEqual(self.rows(), {})
        self.assertFalse(svc.leases.active())

    def test_login_change_stops_the_whole_run(self) -> None:
        async def scenario() -> None:
            self.assertTrue(self.helper.begin(None)[0])
            self.token = "someone-else"  # 시작한 뒤 다른 계정으로 로그인
            for _ in range(600):
                if not self.helper.busy():
                    break
                await asyncio.sleep(0.05)
        asyncio.run(scenario())
        status = self.helper.helper_status()
        self.assertIn("로그인", status["abort"])
        self.assertEqual(self.rows(), {})

    def _run_with_hanging_child(self, after_child_starts) -> tuple[dict, float, list]:
        """자식을 60초 자는 프로세스로 바꿔, 도는 도중 after_child_starts() 를 부른 뒤 끝날 때까지 잰다."""
        sleeper = [sys.executable, "-c", "import time; time.sleep(60)"]
        real_popen = subprocess.Popen
        seen: list = []

        def fake_popen(_args, **kw):
            proc = real_popen(sleeper, **kw)
            seen.append(proc)
            return proc

        async def scenario() -> float:
            with patch.object(svc.subprocess, "Popen", side_effect=fake_popen), \
                    patch.object(helper_mod, "RENEW_EVERY_S", 0.2):
                self.assertTrue(self.helper.begin(None)[0])
                for _ in range(200):
                    if seen:
                        break
                    await asyncio.sleep(0.05)
                after_child_starts()
                t0 = time.monotonic()
                for _ in range(400):
                    if not self.helper.busy():
                        break
                    await asyncio.sleep(0.05)
                return time.monotonic() - t0

        took = asyncio.run(scenario())
        return self.helper.helper_status(), took, seen

    def test_login_change_during_a_long_scan_stops_the_child_now(self) -> None:
        # 연장(1분마다)이 로그인 바뀜을 알아차리면 결과를 올릴 때까지 기다리지 않고 자식을 끝낸다(Codex P1)
        status, took, seen = self._run_with_hanging_child(lambda: setattr(self, "token", "someone-else"))
        self.assertLess(took, 10)
        self.assertTrue(seen and seen[0].poll() is not None)
        self.assertIn("로그인", status["abort"])
        self.assertEqual(status["results"][0]["state"], "aborted")
        self.assertEqual(self.rows(), {})
        self.assertFalse(svc.leases.active())  # 자리는 시작 때 토큰으로 돌려준다 — 서버가 10분 동안 막히지 않게(Codex)

    def test_lost_lease_stops_that_project(self) -> None:
        # 서버가 재시작돼 자리를 잃었다 → 연장이 409 → 올려도 거부되니 그 프로젝트를 멈춘다
        status, took, seen = self._run_with_hanging_child(lambda: setattr(svc.leases, "_lease", None))
        self.assertLess(took, 10)
        self.assertTrue(seen and seen[0].poll() is not None)
        self.assertEqual(status["abort"], "")
        self.assertEqual(status["results"][0]["state"], "failed")
        self.assertIn("자리", status["results"][0]["note"])

    def test_server_already_scanning_skips_the_project(self) -> None:
        with patch.object(svc.controller, "busy", return_value=True):
            status = self.run_helper()
        self.assertEqual(status["results"][0]["state"], "failed")
        self.assertEqual(self.rows(), {})


if __name__ == "__main__":
    unittest.main()
