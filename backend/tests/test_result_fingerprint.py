"""결과 파일 부분 지문(docs/RESULT_FINGERPRINT.md) — 수집·기록·전송·장부 계약.

네트워크는 가짜 응답만 쓴다(실제 CDN 호출 금지).
"""

import asyncio
import hashlib
import io
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from app import db, manage_db, repo
from app.repo import manage
from app.repo import result_fingerprint as repo_fp
from app.services import result_probe
from app.services.result_probe import HEAD_BYTES, ProbeError, fingerprint_remote
from app.services.telemetry_drain import drain_remote_telemetry

SHA_A = "a" * 64
SHA_B = "b" * 64
ORIGIN = "http://192.168.1.171:8010"


# ── 가짜 응답 ────────────────────────────────────────────────────────────


class _Headers(dict):
    def get(self, key, default=None):
        for k, v in self.items():
            if k.lower() == key.lower():
                return v
        return default


class _Resp:
    def __init__(self, status, headers, body):
        self._status, self.headers, self._body = status, _Headers(headers), io.BytesIO(body)

    def getcode(self):
        return self._status

    def read(self, n=-1):
        return self._body.read(n)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Opener:
    def __init__(self, resp=None, exc=None):
        self.resp, self.exc, self.requests = resp, exc, []

    def open(self, request, timeout=None):
        self.requests.append(request)
        if self.exc:
            raise self.exc
        return self.resp


def _remote(resp=None, exc=None, url="https://cdn.example.com/hf_x.mp4"):
    opener = _Opener(resp, exc)
    with patch.object(result_probe, "assert_public_http_url", lambda u: None):
        return fingerprint_remote(url, opener=opener), opener


class RemoteProbeTests(unittest.TestCase):
    def test_206_gives_total_size_and_head_hash(self):
        body = bytes(range(256)) * 256  # 64KiB
        resp = _Resp(206, {"Content-Range": f"bytes 0-65535/31215028", "Content-Type": "video/mp4"}, body)
        (size, head), opener = _remote(resp)
        self.assertEqual(size, 31215028)
        self.assertEqual(head, hashlib.sha256(body).hexdigest())
        sent = opener.requests[0]
        self.assertEqual(sent.get_header("Range"), f"bytes=0-{HEAD_BYTES - 1}")
        self.assertEqual(sent.get_header("Accept-encoding"), "identity")

    def test_small_file_206_reads_whole_file(self):
        body = b"\x89PNG" + b"x" * 996
        resp = _Resp(206, {"Content-Range": "bytes 0-999/1000", "Content-Type": "image/png"}, body)
        (size, head), _ = _remote(resp)
        self.assertEqual((size, head), (1000, hashlib.sha256(body).hexdigest()))

    def test_200_without_range_support_uses_content_length_and_reads_head_only(self):
        body = b"\x00" * (HEAD_BYTES + 5000)
        resp = _Resp(200, {"Content-Length": str(len(body)), "Content-Type": "video/mp4"}, body)
        (size, head), _ = _remote(resp)
        self.assertEqual(size, len(body))
        self.assertEqual(head, hashlib.sha256(body[:HEAD_BYTES]).hexdigest())

    def test_rejects_contract_violations(self):
        good = b"\x00" * HEAD_BYTES
        cases = {
            "range end mismatch": _Resp(206, {"Content-Range": "bytes 0-1023/5000000"}, good),
            "range not from zero": _Resp(206, {"Content-Range": "bytes 10-65545/5000000"}, good),
            "no content-range": _Resp(206, {}, good),
            "short body": _Resp(206, {"Content-Range": "bytes 0-65535/5000000"}, good[:1000]),
            "200 without length": _Resp(200, {}, good),
            "gzip": _Resp(206, {"Content-Range": "bytes 0-65535/5000000", "Content-Encoding": "gzip"}, good),
            "html error page": _Resp(
                206, {"Content-Range": "bytes 0-65535/5000000", "Content-Type": "video/mp4"},
                b"<!DOCTYPE html>" + b" " * (HEAD_BYTES - 15),
            ),
            "text type": _Resp(206, {"Content-Range": "bytes 0-65535/5000000", "Content-Type": "text/plain"}, good),
            "other status": _Resp(204, {}, b""),
        }
        for name, resp in cases.items():
            with self.subTest(name):
                with self.assertRaises(ProbeError):
                    _remote(resp)

    def test_slow_drip_hits_total_deadline(self):
        class Drip(_Resp):
            def read1(self, n):
                return b"\x00" * 10  # 한 번에 10바이트씩

        ticks = iter(range(0, 10_000, 1))  # 호출마다 1초씩 흐르는 시계
        resp = Drip(206, {"Content-Range": "bytes 0-65535/5000000", "Content-Type": "video/mp4"}, b"")
        with patch.object(result_probe, "assert_public_http_url", lambda u: None):
            with self.assertRaises(ProbeError):
                fingerprint_remote("https://cdn.example.com/x.mp4", opener=_Opener(resp), clock=lambda: next(ticks))

    def test_network_error_and_blocked_url_are_probe_errors(self):
        with self.assertRaises(ProbeError):
            _remote(exc=urllib.error.URLError("down"))
        # 사설망 주소는 요청 전에 막힌다(실제 net_guard).
        with self.assertRaises(ProbeError):
            fingerprint_remote("http://127.0.0.1/x.mp4", opener=_Opener(exc=AssertionError("must not open")))


# ── 로컬 DB(수집 대상·기록 조건·재동기화 승계·삭제 스냅샷) ─────────────────────


class _DbCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        self.old_manage_path = manage_db.MANAGE_DB_PATH
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        manage_db.MANAGE_DB_PATH = Path(self.tmp.name) / "manage_hub.db"
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            conn.execute("INSERT INTO creator(uid, name) VALUES('u_me','Me') ON CONFLICT(uid) DO NOTHING")
            for gid, uid, status, sort in (
                ("g1", "u_me", "done", 3), ("g2", "u_me", "done", 2), ("g3", "u_other", "done", 4),
                ("g4", "u_me", "failed", 5),
            ):
                conn.execute(
                    "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, creator_uid, job_id) "
                    "VALUES(?, 'me', 'p', ?, '2026-10-01', ?, ?, ?)",
                    (gid, status, sort, uid, "job-" + gid),
                )
                conn.execute(
                    "INSERT INTO asset(id, generation_id, type, file_path) VALUES(?,?, 'video', ?)",
                    ("a-" + gid, gid, f"https://cdn.example.com/hf_{gid}.mp4"),
                )
            manage._ensure_schema(conn)

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        manage_db.MANAGE_DB_PATH = self.old_manage_path
        db.flush_pool()
        self.tmp.cleanup()

    def _asset(self, asset_id):
        with db.get_connection() as conn:
            row = conn.execute("SELECT * FROM asset WHERE id=?", (asset_id,)).fetchone()
        return dict(row) if row else None

    def _dirty_ids(self):
        return [row["local_gen_id"] for row in manage.list_dirty_telemetry()]


class LocalRecordTests(_DbCase):
    def test_targets_are_mine_done_single_result_newest_first(self):
        ids = [t["generation_id"] for t in repo_fp.probe_targets("u_me", 20)]
        self.assertEqual(ids, ["g1", "g2"])  # 남의 것(g3)·실패(g4) 제외, sort_ts 최신부터
        with db.get_connection() as conn:  # 결과가 2개가 되면 대상에서 빠진다
            conn.execute("INSERT INTO asset(id, generation_id, type, file_path) VALUES('a-g1b','g1','video','x')")
        self.assertEqual([t["generation_id"] for t in repo_fp.probe_targets("u_me", 20)], ["g2"])

    def test_success_records_pair_and_marks_dirty(self):
        target = repo_fp.probe_targets("u_me", 1)[0]
        self.assertTrue(repo_fp.record_probe_success(target, "u_me", 1234, SHA_A))
        row = self._asset("a-g1")
        self.assertEqual((row["result_bytes"], row["result_head_sha"], row["result_fp_sent_to"]), (1234, SHA_A, None))
        self.assertEqual(self._dirty_ids(), ["g1"])
        self.assertEqual([t["generation_id"] for t in repo_fp.probe_targets("u_me", 20)], ["g2"])

    def test_changed_conditions_write_nothing_and_no_dirty(self):
        changes = {
            "deleted": "UPDATE generation SET deleted_at='2026-10-03' WHERE id='g1'",
            "other owner": "UPDATE generation SET creator_uid='u_other' WHERE id='g1'",
            "not done": "UPDATE generation SET status='running' WHERE id='g1'",
            "second result": "INSERT INTO asset(id, generation_id, type, file_path) VALUES('a-g1b','g1','video','x')",
            "original changed": "UPDATE asset SET file_path='https://cdn.example.com/other.mp4' WHERE id='a-g1'",
        }
        for name, sql in changes.items():
            with self.subTest(name):
                self.tearDown()
                self.setUp()
                target = repo_fp.probe_targets("u_me", 1)[0]
                with db.get_connection() as conn:
                    conn.execute(sql)
                self.assertFalse(repo_fp.record_probe_success(target, "u_me", 1234, SHA_A))
                self.assertIsNone(self._asset("a-g1")["result_bytes"])
                self.assertEqual(self._dirty_ids(), [])

    def test_cached_original_keeps_the_same_key(self):
        # 캐시되면 file_path=/media/…, 원본 URL 은 source_url — 키가 같아 기록된다.
        target = repo_fp.probe_targets("u_me", 1)[0]
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE asset SET file_path='/media/ab/x.mp4', source_url='https://cdn.example.com/hf_g1.mp4' "
                "WHERE id='a-g1'"
            )
        self.assertTrue(repo_fp.record_probe_success(target, "u_me", 99, SHA_A))

    def test_three_failures_stop_retrying(self):
        for _ in range(3):
            target = next(t for t in repo_fp.probe_targets("u_me", 20) if t["generation_id"] == "g1")
            self.assertTrue(repo_fp.record_probe_failure(target, "u_me"))
        self.assertEqual([t["generation_id"] for t in repo_fp.probe_targets("u_me", 20)], ["g2"])

    def test_resend_marks_unconfirmed_and_other_server_only(self):
        with db.get_connection() as conn:
            conn.execute("UPDATE asset SET result_bytes=1, result_head_sha=? WHERE id='a-g1'", (SHA_A,))
            conn.execute(
                "UPDATE asset SET result_bytes=2, result_head_sha=?, result_fp_sent_to=? WHERE id='a-g2'",
                (SHA_B, ORIGIN),
            )
            conn.execute("UPDATE asset SET result_bytes=3, result_head_sha=? WHERE id='a-g3'", (SHA_A,))  # 남의 것
        self.assertEqual(repo_fp.mark_resend("u_me", ORIGIN, 200), 1)  # g1(NULL) 만 — g2 는 이 서버가 확인함
        self.assertEqual(self._dirty_ids(), ["g1"])
        self.assertEqual(repo_fp.mark_resend("u_me", "http://new-server:8010", 200), 2)  # 서버가 바뀌면 둘 다

    def test_delivery_only_when_pair_still_matches(self):
        with db.get_connection() as conn:
            conn.execute("UPDATE asset SET result_bytes=1, result_head_sha=? WHERE id='a-g1'", (SHA_A,))
        repo_fp.mark_fp_delivery([("a-g1", 1, SHA_B)], ORIGIN)  # 보낸 뒤 값이 바뀜 → 그대로
        self.assertIsNone(self._asset("a-g1")["result_fp_sent_to"])
        repo_fp.mark_fp_delivery([("a-g1", 1, SHA_A)], ORIGIN)
        self.assertEqual(self._asset("a-g1")["result_fp_sent_to"], ORIGIN)
        repo_fp.mark_fp_delivery([("a-g1", 1, SHA_A)], None)  # 표식 없는 응답 → 확인 지움
        self.assertIsNone(self._asset("a-g1")["result_fp_sent_to"])

    def test_facts_carry_pair_only_for_single_complete_result(self):
        with db.get_connection() as conn:
            conn.execute("UPDATE asset SET result_bytes=7, result_head_sha=? WHERE id='a-g1'", (SHA_A,))
            conn.execute("UPDATE asset SET result_bytes=8 WHERE id='a-g2'")  # 쌍이 불완전
        facts = {f["local_gen_id"]: f for f in manage.build_telemetry_facts(["g1", "g2"], "u_me")}
        self.assertEqual((facts["g1"]["result_bytes"], facts["g1"]["result_head_sha"]), (7, SHA_A))
        self.assertEqual(facts["g1"]["_fp_asset_id"], "a-g1")
        self.assertEqual((facts["g2"]["result_bytes"], facts["g2"]["result_head_sha"]), (None, None))
        with db.get_connection() as conn:
            conn.execute("INSERT INTO asset(id, generation_id, type, file_path) VALUES('a-g1b','g1','video','x')")
        fact = manage.build_telemetry_facts(["g1"], "u_me")[0]
        self.assertEqual((fact["result_bytes"], fact["result_head_sha"], fact["_fp_asset_id"]), (None, None, None))

    def test_resync_keeps_pair_for_same_original_and_drops_for_new(self):
        def sync(url, thumb):
            repo.upsert_synced_generation(
                {
                    "generation": {"id": "job-sync", "prompt": "p", "model": "m", "params": {}, "status": "done",
                                   "created_at": "2026-10-01 00:00:00", "sort_ts": 3, "creator_uid": "u_me"},
                    "asset": {"type": "video", "file_path": url, "thumbnail_url": thumb},
                    "references": [],
                },
                "me",
            )

        sync("https://cdn.example.com/hf_sync.mp4", "https://cdn.example.com/poster-old.jpg")
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE asset SET result_bytes=5, result_head_sha=?, result_probe_fail=1, result_fp_sent_to=? "
                "WHERE generation_id=(SELECT id FROM generation WHERE job_id='job-sync')", (SHA_A, ORIGIN),
            )
        sync("https://cdn.example.com/hf_sync.mp4", "https://cdn.example.com/poster-new.jpg")  # 포스터만 바뀜
        rows = self._rows("job-sync")
        self.assertEqual(len(rows), 1)
        self.assertEqual(
            (rows[0]["result_bytes"], rows[0]["result_head_sha"], rows[0]["result_probe_fail"], rows[0]["result_fp_sent_to"]),
            (5, SHA_A, 1, ORIGIN),
        )
        sync("https://cdn.example.com/hf_sync_other.mp4", None)  # 원본이 다름 → 새 행은 비어 있다
        rows = self._rows("job-sync")
        self.assertEqual(
            (rows[0]["result_bytes"], rows[0]["result_head_sha"], rows[0]["result_probe_fail"], rows[0]["result_fp_sent_to"]),
            (None, None, 0, None),
        )

    def _rows(self, gid):
        # 동기화로 새로 생긴 생성물은 로컬 id 가 새로 붙는다(job id 와 다름) — job id 로도 찾는다.
        with db.get_connection() as conn:
            return [
                dict(r)
                for r in conn.execute(
                    "SELECT a.* FROM asset a JOIN generation g ON g.id=a.generation_id "
                    "WHERE g.id=? OR g.job_id=?",
                    (gid, gid),
                )
            ]


class DrainSettlementTests(_DbCase):
    def setUp(self):
        super().setUp()
        with db.get_connection() as conn:
            conn.execute("UPDATE asset SET result_bytes=11, result_head_sha=? WHERE id='a-g1'", (SHA_A,))
        manage.mark_telemetry_dirty(["g1"])

    def _drain(self, response, *, now_origin=ORIGIN):
        sent = []

        def push(items):
            sent.extend(items)
            return response

        drain_remote_telemetry(push, my_uid="u_me", target_origin=ORIGIN, current_origin=lambda: now_origin)
        return sent

    def test_payload_has_pair_but_no_private_keys(self):
        sent = self._drain({"upserted": 1, "skipped": [], "result_fingerprint": 1})
        self.assertEqual(len(sent), 1)
        self.assertEqual((sent[0]["result_bytes"], sent[0]["result_head_sha"]), (11, SHA_A))
        self.assertFalse([k for k in sent[0] if k.startswith("_")])
        self.assertEqual(self._asset("a-g1")["result_fp_sent_to"], ORIGIN)

    def test_old_server_response_does_not_confirm(self):
        self._drain({"upserted": 1, "skipped": []})
        self.assertIsNone(self._asset("a-g1")["result_fp_sent_to"])

    def test_server_change_during_push_is_ignored(self):
        self._drain({"upserted": 1, "skipped": [], "result_fingerprint": 1}, now_origin="http://other:8010")
        self.assertIsNone(self._asset("a-g1")["result_fp_sent_to"])

    def test_skipped_item_is_not_confirmed(self):
        self._drain({"upserted": 0, "skipped": ["g1"], "result_fingerprint": 1})
        self.assertIsNone(self._asset("a-g1")["result_fp_sent_to"])

    def test_asset_replaced_during_push_is_not_confirmed(self):
        def push(items):
            with db.get_connection() as conn:  # 보내는 사이 결과가 새 파일로 바뀜
                conn.execute("UPDATE asset SET result_bytes=12, result_head_sha=? WHERE id='a-g1'", (SHA_B,))
            return {"upserted": 1, "skipped": [], "result_fingerprint": 1}

        drain_remote_telemetry(push, my_uid="u_me", target_origin=ORIGIN, current_origin=lambda: ORIGIN)
        self.assertIsNone(self._asset("a-g1")["result_fp_sent_to"])


class DrainOriginTests(unittest.TestCase):
    def test_push_goes_to_the_captured_origin(self):
        from app.routers import _proxy, _telemetry

        addresses = iter(["http://A:8010", "http://B:8010", "http://A:8010"])
        seen = {}

        def fake_drain(push, *, my_uid, target_origin, current_origin):
            push([{"local_gen_id": "g1"}])  # 이 사이 설정 주소가 B 로 바뀌어도
            seen["target"] = target_origin

        def fake_proxy_json(method, path, *, body=None, base=None, **_):
            seen["base"] = base
            return {}

        with patch.object(_telemetry, "MANAGE_ENABLED", True), patch.object(
            _proxy, "proxying", lambda: True
        ), patch.object(_proxy, "base_url", lambda: next(addresses)), patch.object(
            _proxy, "proxy_json", fake_proxy_json
        ), patch.object(_telemetry, "drain_remote_telemetry", fake_drain), patch.object(
            _telemetry, "drain_remote_account_reports", lambda *a, **k: None
        ), patch.object(_telemetry.repo, "get_my_uid", lambda: "u_me"):
            _telemetry._drain_once()
        self.assertEqual(seen, {"base": "http://A:8010", "target": "http://A:8010"})


class TombstoneSnapshotTests(_DbCase):
    def test_delete_snapshot_carries_pair(self):
        with db.get_connection() as conn:
            conn.execute("UPDATE asset SET result_bytes=21, result_head_sha=? WHERE id='a-g1'", (SHA_A,))
        from app import config
        from app.repo import trash

        with patch.object(config, "MANAGE_ENABLED", True):
            self.assertTrue(trash.move_to_trash("g1"))
        rows = [r for r in manage.list_dirty_telemetry() if r["local_gen_id"] == "g1"]
        self.assertTrue(rows and rows[0]["is_tombstone"])
        import json

        snap = json.loads(rows[0]["tomb_snapshot"])
        self.assertEqual((snap["result_bytes"], snap["result_head_sha"]), (21, SHA_A))


# ── 서버 장부(upsert) ─────────────────────────────────────────────────────


class LedgerUpsertTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_path = manage_db.MANAGE_DB_PATH
        manage_db.MANAGE_DB_PATH = Path(self.tmp.name) / "manage_hub.db"
        manage_db.init_manage_db()

    def tearDown(self):
        manage_db.MANAGE_DB_PATH = self.old_path
        self.tmp.cleanup()

    def _push(self, gid, job="job-1", **extra):
        item = {"local_gen_id": gid, "job_id": job, "creator_uid": "u_me", "status": "done", **extra}
        return manage_db.upsert_facts("me@example.com", "u_me", [item])

    def _pairs(self):
        with manage_db.get_connection() as conn:
            return {
                r["local_gen_id"]: (r["result_bytes"], r["result_head_sha"])
                for r in conn.execute("SELECT local_gen_id, result_bytes, result_head_sha FROM team_generation_fact")
            }

    def test_complete_pair_replaces_and_missing_pair_keeps(self):
        self._push("g1", result_bytes=10, result_head_sha=SHA_A)
        self.assertEqual(self._pairs(), {"g1": (10, SHA_A)})
        self._push("g1")  # 옛 클라이언트 — 쌍 없음
        self.assertEqual(self._pairs(), {"g1": (10, SHA_A)})
        self._push("g1", result_bytes=20, result_head_sha=SHA_B)  # 마지막으로 받은 유효한 쌍
        self.assertEqual(self._pairs(), {"g1": (20, SHA_B)})

    def test_half_or_invalid_pair_is_dropped(self):
        self._push("g1", result_bytes=10, result_head_sha=SHA_A)
        for bad in (
            {"result_bytes": 30},
            {"result_head_sha": SHA_B},
            {"result_bytes": True, "result_head_sha": SHA_B},
            {"result_bytes": -1, "result_head_sha": SHA_B},
            {"result_bytes": "30", "result_head_sha": SHA_B},
            {"result_bytes": 30, "result_head_sha": "XYZ"},
            {"result_bytes": 30, "result_head_sha": SHA_B.upper()},
            {"result_bytes": 2**63, "result_head_sha": SHA_B},  # SQLite 범위 밖 — 배치를 깨지 않고 버림
            {"result_bytes": 30, "result_head_sha": SHA_B + "\n"},
        ):
            with self.subTest(bad):
                self._push("g1", **bad)
                self.assertEqual(self._pairs(), {"g1": (10, SHA_A)})

    def test_job_dedupe_carries_single_pair_and_skips_conflict(self):
        self._push("g-old", result_bytes=10, result_head_sha=SHA_A)
        self._push("g-new")  # 같은 job, 다른 로컬 id, 쌍 없음 → 지워질 행의 쌍 승계
        self.assertEqual(self._pairs(), {"g-new": (10, SHA_A)})
        self._push("g-newer", result_bytes=20, result_head_sha=SHA_B)  # 들어온 완전한 쌍이 우선
        self.assertEqual(self._pairs(), {"g-newer": (20, SHA_B)})

    def _insert_raw(self, gid, size, head, job="job-c"):
        with manage_db.get_connection() as conn:
            conn.execute(
                "INSERT INTO team_generation_fact(id, account_email, creator_uid, local_gen_id, job_id, "
                "result_bytes, result_head_sha) VALUES(?, 'me@example.com', 'u_me', ?, ?, ?, ?)",
                ("row-" + gid, gid, job, size, head),
            )

    def test_conflicting_pairs_are_cleared_not_chosen(self):
        self._insert_raw("gA", 10, SHA_A)
        self._insert_raw("gB", 20, SHA_B)
        self._push("gC", job="job-c")  # 쌍 없이 같은 job → 두 종류 → 고르지 않고 비움
        self.assertEqual(self._pairs(), {"gC": (None, None)})

    def test_conflict_also_clears_same_local_row(self):
        self._insert_raw("gA", 10, SHA_A)
        self._insert_raw("gB", 20, SHA_B)
        self._push("gA", job="job-c")  # 같은 local id 행도 자기 쌍을 남기지 않는다
        self.assertEqual(self._pairs(), {"gA": (None, None)})

    def test_tombstone_keeps_existing_pair_and_new_tombstone_uses_snapshot(self):
        self._push("g1", result_bytes=10, result_head_sha=SHA_A)
        self._push("g1", is_deleted=True, result_bytes=99, result_head_sha=SHA_B)
        self.assertEqual(self._pairs(), {"g1": (10, SHA_A)})
        self._push("g2", job="job-2", is_deleted=True, result_bytes=5, result_head_sha=SHA_B)
        self.assertEqual(self._pairs()["g2"], (5, SHA_B))

    def test_push_endpoint_model_accepts_loose_values_without_422(self):
        from app.routers.manage import TelemetryFactIn

        item = TelemetryFactIn(local_gen_id="g1", result_bytes="junk", result_head_sha=123)
        self.assertEqual(manage_db.fingerprint_pair(item.model_dump()), (None, None))


class CycleTests(_DbCase):
    def test_cycle_records_fails_and_schedules_drain(self):
        calls = []
        probe = result_probe.PeriodicResultProbe()
        probe._on_dirty = lambda: calls.append(1)

        def fake(target):
            if target["generation_id"] == "g2":
                raise ProbeError("down")
            return 77, SHA_A

        with patch.object(result_probe, "fingerprint_target", fake), patch.object(
            result_probe.repo, "get_my_uid", lambda: "u_me"
        ), patch.object(result_probe.shared_connection, "base_url", lambda: ORIGIN):
            result = asyncio.run(probe.run_cycle())
        self.assertEqual(result, {"recorded": 1, "failed": 1, "resent": 1})  # 첫 회차는 재전송도 1번
        self.assertEqual(calls, [1])
        self.assertEqual(self._asset("a-g1")["result_bytes"], 77)
        self.assertEqual(self._asset("a-g2")["result_probe_fail"], 1)

    def test_cycle_rests_when_logged_out(self):
        probe = result_probe.PeriodicResultProbe()
        with patch.object(result_probe.repo, "get_my_uid", lambda: None):
            self.assertEqual(asyncio.run(probe.run_cycle()), {"recorded": 0, "failed": 0, "resent": 0})


if __name__ == "__main__":
    unittest.main()
