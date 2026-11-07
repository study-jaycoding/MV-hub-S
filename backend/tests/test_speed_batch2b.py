"""속도 점검 묶음 2-B(2026-11-07) — 백엔드 남은 항목의 계약 시험.

2-12(중첩 연결)는 test_db_nested_transaction.py 에 따로 있다.
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import sys
import threading
import urllib.error
from email.message import Message
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import pytest
from starlette.requests import Request

from app import db, manage_db, repo
from app.repo import identity, manage, manage_tasks
from app.routers import _proxy, comfy, ingest, library
from app.services import release_update, remote_realtime, runtime_activation
from app.ws import ConnectionManager


# ── 2-5 작업 표 활동 대조 공유 ────────────────────────────────────────────────

@pytest.fixture
def task_world(tmp_path, monkeypatch):
    # 실제 앱처럼 풀을 켠다 — 시험 기본(풀 끔)은 요청마다 연결을 닫아 마지막 닫힘이 -wal 을 비우고 수정 시각을
    # 바꾼다. 그러면 같은 DB 인데 표식이 달라 보여 '조회자 사이 공유'가 시각에 따라 깨진다(dev 에서 재현).
    monkeypatch.setattr(db, "_POOL_ENABLED", True)
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content.db"))
    db.flush_pool()
    monkeypatch.setattr(manage_db, "MANAGE_DB_PATH", tmp_path / "manage.db")
    monkeypatch.setattr(manage_tasks, "_TASK_READ_CACHE_TTL", 5.0)
    db.init_db()
    repo.ensure_default_worker()
    manage_db.init_manage_db()
    manage_tasks.clear_task_read_cache()
    with db.get_connection() as conn:
        manage._ensure_schema(conn)
        for pid, wid in (("p1", "ws-a"), ("p2", "ws-b")):
            conn.execute(
                "INSERT INTO project(id,name,kind,workspace_scope,workspace_id,workspace_name) "
                "VALUES(?,?,'team','team',?,?)", (pid, pid, wid, wid),
            )
        for uid in ("u1", "u2"):
            conn.execute("INSERT INTO creator(uid,name) VALUES(?,?)", (uid, uid))
    yield
    manage_tasks.clear_task_read_cache()
    db.flush_pool()


def _fact(gid="local-1", uid="u1", **fields):
    item = dict(local_gen_id=gid, job_id="job-" + gid, creator_uid=uid, project_id="p1",
                folder_path="ep001/c0010", workspace_scope="team", workspace_id="ws-a", workspace_name="A",
                status="done", model="model", created_at="2026-11-07T00:00:00+00:00", sort_ts=10,
                real_credits=3, elapsed_seconds=6)
    item.update(fields)
    manage_db.upsert_facts(uid + "@example.test", uid, [item])


def _count_snapshots(monkeypatch):
    calls = []
    real = manage_tasks.load_activity_snapshot

    def counted(conn, project_ids):
        calls.append(tuple(project_ids))
        return real(conn, project_ids)

    monkeypatch.setattr(manage_tasks, "load_activity_snapshot", counted)
    return calls


def _projects(viewer):
    rows = manage.task_projects_for_workspace("ws-a", include_historical=True, include_activity=True,
                                              activity_viewer=(viewer, viewer + "@example.test"))
    return {row["id"] for row in rows}


def test_two_viewers_share_one_activity_snapshot_but_keep_their_own_view(task_world, monkeypatch):
    _fact(project_id="p2")
    _projects("u1")  # 데우기 — 첫 계산 중 관리 DB 의 -wal 이 처음 생겨 표식이 바뀌면 저장하지 않는다(규칙대로)
    manage_tasks.clear_task_read_cache()
    calls = _count_snapshots(monkeypatch)
    assert "p2" in _projects("u1")  # 자기 과거 기록은 보인다
    assert "p2" not in _projects("u2")  # 남의 비공유 기록은 안 보인다(조회자별 투영 그대로)
    assert len(calls) == 1  # 무거운 대조는 한 번


def test_a_db_change_recomputes_the_snapshot(task_world, monkeypatch):
    _fact(project_id="p2")
    _projects("u1")  # 데우기(위와 같은 이유)
    manage_tasks.clear_task_read_cache()
    calls = _count_snapshots(monkeypatch)
    _projects("u1")
    _fact(gid="local-2", project_id="p2")  # 텔레메트리 쓰기 — 표식이 바뀐다
    _projects("u1")
    assert len(calls) == 2


def test_a_change_during_the_computation_is_not_stored(task_world, monkeypatch):
    stamps = iter([("a",), ("b",), ("a",), ("a",)])
    monkeypatch.setattr(manage_tasks, "_task_cache_stamp", lambda: next(stamps))
    calls = []
    monkeypatch.setattr(manage_tasks, "load_activity_snapshot", lambda conn, ids: calls.append(ids) or {"n": len(calls)})
    assert manage_tasks._activity_snapshot(None, ["p1"]) == {"n": 1}  # 계산 전 a·뒤 b — 저장 안 함
    assert manage_tasks._activity_snapshot(None, ["p1"]) == {"n": 2}  # 그래서 다시 계산(이번엔 저장)
    assert len(calls) == 2


def test_the_snapshot_expires_after_ten_seconds(task_world, monkeypatch):
    clock = SimpleNamespace(now=100.0)
    monkeypatch.setattr(manage_tasks, "time", SimpleNamespace(monotonic=lambda: clock.now))
    monkeypatch.setattr(manage_tasks, "_task_cache_stamp", lambda: ("same",))
    calls = []
    monkeypatch.setattr(manage_tasks, "load_activity_snapshot", lambda conn, ids: calls.append(ids) or {})
    manage_tasks._activity_snapshot(None, ["p1"])
    clock.now += 9.0
    manage_tasks._activity_snapshot(None, ["p1"])
    assert len(calls) == 1
    clock.now += 2.0
    manage_tasks._activity_snapshot(None, ["p1"])
    assert len(calls) == 2


# ── 2-6·2-13 허브 중계 ────────────────────────────────────────────────────────

def _request(path, *, method="GET", headers=()):
    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    return Request({
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
        "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": b"",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers],
        "client": ("127.0.0.1", 1234), "server": ("127.0.0.1", 8010),
    }, receive)


class _Upstream:
    def __init__(self, status, body, headers):
        self.status = status
        self._body = body
        self.headers = Message()
        for key, value in headers.items():
            self.headers[key] = value

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _settings_off_loop(seen):
    def base():
        seen.append(threading.current_thread() is threading.main_thread())
        return "http://server.test"
    return base


def test_forward_passes_conditional_and_encoding_headers_and_relays_them_back():
    gz = b"\x1f\x8b-compressed-bytes"
    captured = {}
    seen = []

    def opener(req, timeout):
        captured["req"] = req
        return _Upstream(200, gz, {"Content-Type": "application/json", "ETag": 'W/"t1"', "Content-Encoding": "gzip",
                                   "Vary": "Accept-Encoding", "Cache-Control": "private, no-cache"})

    request = _request("/api/manage/projects/p1/tasks",
                       headers=[("If-None-Match", 'W/"t0"'), ("Accept-Encoding", "gzip, deflate")])
    with (mock.patch.object(_proxy, "base_url", side_effect=_settings_off_loop(seen)),
          mock.patch.object(_proxy, "token", return_value="tok"),
          mock.patch.object(_proxy, "_open", side_effect=opener)):
        response = asyncio.run(_proxy._forward(request))
    sent = captured["req"]
    assert sent.get_header("If-none-match") == 'W/"t0"'
    assert sent.get_header("Accept-encoding") == "gzip, deflate"
    assert response.body == gz  # 바이트 그대로 — 허브는 풀지 않는다
    assert response.headers["content-encoding"] == "gzip"
    assert response.headers["etag"] == 'W/"t1"'
    assert response.headers["vary"] == "Accept-Encoding"
    assert response.headers["cache-control"] == "private, no-cache"
    assert seen == [False]  # 설정 DB 읽기는 이벤트 루프 밖(2-13)


def test_forward_relays_a_304_with_its_etag():
    def opener(req, timeout):
        headers = Message()
        headers["ETag"] = 'W/"t1"'
        raise urllib.error.HTTPError(req.full_url, 304, "Not Modified", headers, io.BytesIO(b""))

    with (mock.patch.object(_proxy, "base_url", return_value="http://server.test"),
          mock.patch.object(_proxy, "token", return_value=None),
          mock.patch.object(_proxy, "_open", side_effect=opener)):
        response = asyncio.run(_proxy._forward(_request("/api/manage/projects/p1/tasks",
                                                        headers=[("If-None-Match", 'W/"t1"')])))
    assert response.status_code == 304
    assert response.headers["etag"] == 'W/"t1"'
    assert response.body == b""


def test_forward_read_failure_does_not_leave_gzip_headers_on_the_502():
    class Broken(_Upstream):
        def read(self):
            raise TimeoutError("read timed out")

    def opener(req, timeout):
        return Broken(200, b"", {"Content-Type": "application/json", "Content-Encoding": "gzip", "ETag": 'W/"t1"'})

    with (mock.patch.object(_proxy, "base_url", return_value="http://server.test"),
          mock.patch.object(_proxy, "token", return_value=None),
          mock.patch.object(_proxy, "_open", side_effect=opener)):
        response = asyncio.run(_proxy._forward(_request("/api/manage/projects/p1/tasks",
                                                        headers=[("Accept-Encoding", "gzip")])))
    assert response.status_code == 502
    assert "content-encoding" not in response.headers  # 평문 오류 본문을 브라우저가 풀 수 있어야 한다
    assert "etag" not in response.headers
    assert json.loads(response.body)["detail"].startswith("공유 서버 연결 실패")


def test_forward_without_those_headers_sends_none():
    captured = {}

    def opener(req, timeout):
        captured["req"] = req
        return _Upstream(200, b"{}", {"Content-Type": "application/json"})

    with (mock.patch.object(_proxy, "base_url", return_value="http://server.test"),
          mock.patch.object(_proxy, "token", return_value=None),
          mock.patch.object(_proxy, "_open", side_effect=opener)):
        response = asyncio.run(_proxy._forward(_request("/api/manage/x")))
    assert captured["req"].get_header("If-none-match") is None
    assert captured["req"].get_header("Accept-encoding") is None
    assert "content-encoding" not in response.headers


def test_forward_stream_reads_settings_off_the_loop():
    seen = []

    def opener(req, timeout):
        upstream = _Upstream(200, b"", {"Content-Type": "video/mp4"})
        upstream.read = lambda *_a: b""
        upstream.close = lambda: None
        return upstream

    with (mock.patch.object(_proxy, "base_url", side_effect=_settings_off_loop(seen)),
          mock.patch.object(_proxy, "token", return_value=None),
          mock.patch.object(_proxy, "_open", side_effect=opener)):
        asyncio.run(_proxy._forward_stream(_request("/media/a.mp4", method="HEAD")))
    assert seen == [False]


def test_remote_realtime_reads_its_config_off_the_loop():
    seen = []

    def provider():
        seen.append(threading.current_thread() is threading.main_thread())
        return None

    bridge = remote_realtime.RemoteRealtimeBridge(provider, lambda event: None)
    assert asyncio.run(bridge._config_now()) is None
    assert seen == [False]


def test_a_blocked_config_read_does_not_stop_the_loop():
    release = threading.Event()

    def provider():
        release.wait(2)
        return None

    async def scenario():
        bridge = remote_realtime.RemoteRealtimeBridge(provider, lambda event: None)
        reading = asyncio.ensure_future(bridge._config_now())
        ticks = 0
        for _ in range(5):
            await asyncio.sleep(0.01)
            ticks += 1  # 설정 읽기가 막혀 있는 동안에도 루프가 돈다
        release.set()
        await reading
        return ticks

    assert asyncio.run(scenario()) == 5


# ── 2-9 알림 종 건강 검사 기억 ─────────────────────────────────────────────────

@pytest.fixture
def install_root(tmp_path, monkeypatch):
    root = tmp_path / "install"
    root.mkdir()
    (root / "agent_push.py").write_text("x", encoding="utf-8")
    monkeypatch.setattr(release_update, "_HEALTH_OK", {})
    monkeypatch.setattr(release_update, "_unfinished_install", lambda _root: False)
    return root


def test_health_is_remembered_while_the_install_files_stay_the_same(install_root, monkeypatch):
    health = mock.Mock(return_value=(True, ""))
    monkeypatch.setattr(release_update, "_installation_health", health)
    assert release_update._installation_health_cached(install_root, "1.0") == (True, "")
    assert release_update._installation_health_cached(install_root, "1.0") == (True, "")
    assert health.call_count == 1
    (install_root / "agent_push.py").write_text("changed", encoding="utf-8")  # 설치 파일이 바뀌었다
    release_update._installation_health_cached(install_root, "1.0")
    assert health.call_count == 2


def test_damage_is_never_remembered(install_root, monkeypatch):
    health = mock.Mock(return_value=(False, "damaged"))
    monkeypatch.setattr(release_update, "_installation_health", health)
    assert release_update._installation_health_cached(install_root)[0] is False
    assert release_update._installation_health_cached(install_root)[0] is False
    assert health.call_count == 2


def test_health_memory_expires_after_thirty_minutes(install_root, monkeypatch):
    clock = SimpleNamespace(now=1000.0)
    monkeypatch.setattr(release_update, "time", SimpleNamespace(monotonic=lambda: clock.now, sleep=lambda _s: None))
    health = mock.Mock(return_value=(True, ""))
    monkeypatch.setattr(release_update, "_installation_health", health)
    release_update._installation_health_cached(install_root)
    clock.now += 1799
    release_update._installation_health_cached(install_root)
    assert health.call_count == 1
    clock.now += 2
    release_update._installation_health_cached(install_root)
    assert health.call_count == 2


def test_an_unfinished_install_is_checked_every_time(install_root, monkeypatch):
    monkeypatch.setattr(release_update, "_unfinished_install", lambda _root: True)
    health = mock.Mock(return_value=(False, "journal"))
    monkeypatch.setattr(release_update, "_installation_health", health)
    release_update._installation_health_cached(install_root)
    release_update._installation_health_cached(install_root)
    assert health.call_count == 2


def test_candidate_verdict_only_uses_the_memory_when_asked(install_root, monkeypatch):
    health = mock.Mock(return_value=(True, ""))
    monkeypatch.setattr(release_update, "_installation_health", health)
    cand = {"version": "2026.11.07-1200", "higgsfield_cli_version": "1.0"}
    release_update._candidate_verdict(install_root, cand)
    release_update._candidate_verdict(install_root, cand)  # 업데이트 시작 경로 — 늘 새로
    assert health.call_count == 2
    release_update._candidate_verdict(install_root, cand, cached=True)
    release_update._candidate_verdict(install_root, cand, cached=True)
    assert health.call_count == 3


def test_get_status_refresh_runs_the_health_check_once(tmp_path, monkeypatch):
    root = tmp_path / "synthetic-install"
    root.mkdir()
    (root / "VERSION.txt").write_text("1.0.0", encoding="utf-8")
    (root / "INSTALL_SOURCE.txt").write_text(str(tmp_path / "unused"), encoding="utf-8")
    (root / "update_release.bat").write_text("not executable test data", encoding="utf-8")
    monkeypatch.setattr(release_update, "AUTH_ENABLED", False)
    monkeypatch.setattr(release_update, "UPDATE_STATE_BASE", tmp_path / "state")
    monkeypatch.setattr(release_update, "_START_LOCK", threading.Lock())
    monkeypatch.setattr(release_update, "_HEALTH_OK", {})
    monkeypatch.setattr(release_update, "fetch_latest",
                        mock.Mock(return_value={"version": "1.0.0", "higgsfield_cli_version": "test"}))
    monkeypatch.setattr(release_update, "_installed_candidate", lambda *_a: None)
    health = mock.Mock(return_value=(True, ""))
    monkeypatch.setattr(release_update, "_installation_health", health)
    for _ in range(3):  # 알림 종 60초 주기
        assert release_update.get_status(root=root, refresh=True)["state"] == "up_to_date"
    assert health.call_count == 1


# ── 2-10 활성화 판정 기억 ─────────────────────────────────────────────────────

@pytest.fixture
def activation(tmp_path, monkeypatch):
    root = tmp_path / "install"
    (root / "sub").mkdir(parents=True)
    control = root / "sub" / "control.json"
    monkeypatch.setenv("MVHUB_ACTIVATION_ROOT", str(root))
    monkeypatch.setenv("MVHUB_ACTIVATION_CONTROL", str(control))
    monkeypatch.setenv("MVHUB_EXECUTION_NONCE", "nonce-1")
    monkeypatch.setattr(runtime_activation, "_MEMO", None)
    reads = []
    real = runtime_activation._read
    monkeypatch.setattr(runtime_activation, "_read", lambda path: reads.append(Path(path).name) or real(path))
    return SimpleNamespace(root=root, control=control, reads=reads)


def _write(path, state, **extra):
    path.write_text(json.dumps({"format_version": 1, "execution_nonce": "nonce-1", "state": state, **extra}),
                    encoding="utf-8")


def test_normal_is_remembered_until_the_control_file_changes(activation):
    _write(activation.control, "normal")
    assert [runtime_activation.admission_state() for _ in range(5)] == ["normal"] * 5
    assert len(activation.reads) == 2  # 첫 판정만 '표식 → 검사 → 표식'으로 두 번 읽는다
    _write(activation.control, "draining")
    assert runtime_activation.admission_state() == "blocked"


def test_blocked_is_never_remembered(activation):
    _write(activation.control, "draining")
    for _ in range(3):
        assert runtime_activation.admission_state() == "blocked"
    assert len(activation.reads) == 3


def test_activated_watches_the_journal_too(activation):
    journal = activation.root / "sub" / "journal.json"
    journal.write_text(json.dumps({"run_id": "r1", "execution_nonce": "nonce-1", "phase": "ready",
                                   "business_writes_possible": True, "db_mutation_possible": True}), encoding="utf-8")
    _write(activation.control, "activated", journal=str(journal), run_id="r1")
    assert runtime_activation.admission_state() == "activated"
    assert runtime_activation.admission_state() == "activated"
    reads = len(activation.reads)
    journal.write_text(json.dumps({"run_id": "r1", "execution_nonce": "nonce-1", "phase": "rolled_back_pending",
                                   "business_writes_possible": True, "db_mutation_possible": True}), encoding="utf-8")
    assert runtime_activation.admission_state() == "blocked"
    assert len(activation.reads) > reads


def test_a_swap_during_the_check_is_not_remembered(activation):
    _write(activation.control, "normal")
    real = runtime_activation._read
    swapped = []

    def read_then_swap(path):
        value = real(path)
        if not swapped:
            swapped.append(True)
            _write(activation.control, "draining")  # 읽은 직후 활성화 도구가 바꿨다
        return value

    with mock.patch.object(runtime_activation, "_read", side_effect=read_then_swap):
        assert runtime_activation.admission_state() == "blocked"  # 더 늦게 본 판정
    assert runtime_activation._MEMO is None
    assert runtime_activation.admission_state() == "blocked"


@pytest.mark.skipif(sys.platform != "win32", reason="연결점(junction)은 Windows 전용")
def test_an_ancestor_swapped_for_a_junction_drops_the_memory(activation):
    import _winapi

    _write(activation.control, "normal")
    assert runtime_activation.admission_state() == "normal"
    assert runtime_activation.admission_state() == "normal"  # 기억이 섰다
    moved = activation.root / "moved"
    (activation.root / "sub").rename(moved)
    _winapi.CreateJunction(str(moved), str(activation.root / "sub"))  # 같은 파일이 연결점 너머에 그대로 있다
    try:
        # 판정 자체는 전체 검사의 몫이다(연결점 조상에 대한 판정은 이번 변경 전과 같다) — 기억이 그것을 가리지 않는다.
        expected, _journal = runtime_activation._admission_full()
        before = len(activation.reads)
        assert runtime_activation.admission_state() == expected
        assert len(activation.reads) > before  # 말단 파일은 그대로지만 조상 lstat 이 달라 기억을 쓰지 않았다
    finally:
        os.rmdir(activation.root / "sub")  # 연결점만 지운다(대상 폴더는 남는다)


# ── 2-14 팀 탭 개인메타 필터의 페이지 키우기 ───────────────────────────────────

def _team_request(query: str) -> Request:
    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    return Request({"type": "http", "method": "GET", "path": "/api/generations", "query_string": query.encode(),
                    "headers": [], "client": ("127.0.0.1", 1), "server": ("t", 80), "scheme": "http"}, receive)


def _server(total: int, red_every: int):
    rows = [{"id": f"g{i}", "sort_ts": total - i, "color": "red" if i % red_every == 0 else None} for i in range(total)]
    limits = []

    def proxy_json(method, path, raw_query="", **_kw):
        query = dict(pair.split("=", 1) for pair in raw_query.split("&") if pair)
        limit = int(query["limit"])
        limits.append(limit)
        start = 0
        if "cursor_id" in query:
            start = next(i for i, row in enumerate(rows) if row["id"] == query["cursor_id"]) + 1
        return [dict(row) for row in rows[start:start + limit]]

    return proxy_json, limits


def test_sparse_filter_grows_the_page_up_to_800(monkeypatch):
    proxy_json, limits = _server(total=6000, red_every=1000)
    monkeypatch.setattr(library._proxy, "proxy_json", proxy_json)
    monkeypatch.setattr(library, "_overlay_personal_meta", lambda data, request: data)
    got = library._team_local_filtered_for_account(_team_request("tab=team&colors=red"), ["red"], [], [], [],
                                                   200, None, None)
    assert [row["id"] for row in got] == [f"g{i}" for i in range(0, 6000, 1000)]
    assert limits == [200, 400, 800, 800, 800, 800, 800, 800, 800]  # 30번 → 9번
    assert max(limits) <= 800


def test_dense_filter_still_stops_at_the_first_page(monkeypatch):
    proxy_json, limits = _server(total=6000, red_every=1)
    monkeypatch.setattr(library._proxy, "proxy_json", proxy_json)
    monkeypatch.setattr(library, "_overlay_personal_meta", lambda data, request: data)
    got = library._team_local_filtered_for_account(_team_request("tab=team&colors=red"), ["red"], [], [], [],
                                                   200, None, None)
    assert len(got) == 200 and limits == [200]


def test_exhaustion_is_judged_against_the_page_actually_asked(monkeypatch):
    proxy_json, limits = _server(total=700, red_every=10000)  # 200 + 400 + 100(마지막 회차 800 요청)
    monkeypatch.setattr(library._proxy, "proxy_json", proxy_json)
    monkeypatch.setattr(library, "_overlay_personal_meta", lambda data, request: data)
    library._team_local_filtered_for_account(_team_request("tab=team&colors=red"), ["red"], [], [], [],
                                             200, None, None)
    assert limits == [200, 400, 800]


# ── 2-15 Comfy 결과 저장 신호 ─────────────────────────────────────────────────

def test_threadsafe_notify_hops_onto_the_bound_loop():
    manager = ConnectionManager()
    called = []
    manager.notify_mutation = lambda account_uid=None, *a, **k: called.append(
        (account_uid, threading.current_thread() is threading.main_thread()))

    async def scenario():
        manager.bind_loop(asyncio.get_running_loop())
        worker = threading.Thread(target=manager.notify_mutation_threadsafe, args=("acct:a@x",))
        worker.start()
        worker.join()
        await asyncio.sleep(0.01)

    asyncio.run(scenario())
    assert called == [("acct:a@x", True)]  # 스레드에서 불러도 루프(메인 스레드)에서 돈다


def test_threadsafe_notify_without_a_loop_is_skipped():
    manager = ConnectionManager()
    manager.notify_mutation = mock.Mock()
    manager.notify_mutation_threadsafe("acct:a@x")
    manager.notify_mutation.assert_not_called()


def _canvas_run(outputs):
    return {"state": "running", "attempt_id": "att-1", "job_id": "job-1", "context": {"asset_project_id": None},
            "outputs": [{"kind": "image", "state": "ready", "output_key": key, "metadata": {"rel": key}}
                        for key in outputs]}


def _identity(auth_enabled=True):
    return comfy._ComfyIdentity(("a@x", None), "a@x", "user_a", "dev-1", "scope", {}, auth_enabled)


@pytest.fixture
def canvas_save(monkeypatch):
    monkeypatch.setattr(comfy.canvas_runs, "set_state", lambda *_a: None)
    monkeypatch.setattr(comfy.canvas_runs, "settle", lambda attempt_id, *_a: {"attempt_id": attempt_id})
    monkeypatch.setattr(comfy, "_ack_canvas_journal", lambda *_a: None)
    monkeypatch.setattr(comfy, "_preflight_local_output", lambda *_a: None)
    notify = mock.Mock()
    monkeypatch.setattr(comfy.manager, "notify_mutation_threadsafe", notify)
    return notify


def test_a_new_canvas_save_notifies_the_owner_scope(canvas_save, monkeypatch):
    monkeypatch.setattr(comfy.comfy_save, "save_output", lambda **_k: {"existed": False, "generation_id": "g1"})
    comfy._save_canvas_run(_canvas_run(["comfy/a.png"]), _identity(), None)
    canvas_save.assert_called_once_with("acct:a@x")


def test_auth_off_canvas_save_notifies_everyone_on_this_hub(canvas_save, monkeypatch):
    monkeypatch.setattr(comfy.comfy_save, "save_output", lambda **_k: {"existed": False, "generation_id": "g1"})
    comfy._save_canvas_run(_canvas_run(["comfy/a.png"]), _identity(auth_enabled=False), None)
    canvas_save.assert_called_once_with(None)


def test_nothing_new_saved_sends_nothing(canvas_save, monkeypatch):
    monkeypatch.setattr(comfy.comfy_save, "save_output", lambda **_k: {"existed": True, "generation_id": "g1"})
    comfy._save_canvas_run(_canvas_run(["comfy/a.png"]), _identity(), None)
    canvas_save.assert_not_called()


def test_a_partial_save_that_ends_in_an_error_still_notifies(canvas_save, monkeypatch):
    results = iter([{"existed": False, "generation_id": "g1"}, OSError("disk")])

    def save_output(**_k):
        result = next(results)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(comfy.comfy_save, "save_output", save_output)
    with pytest.raises(OSError):
        comfy._save_canvas_run(_canvas_run(["comfy/a.png", "comfy/b.png"]), _identity(), None)
    canvas_save.assert_called_once_with("acct:a@x")


def test_a_failed_cleanup_after_a_new_save_still_notifies(canvas_save, monkeypatch):
    monkeypatch.setattr(comfy.comfy_save, "save_output", lambda **_k: {"existed": False, "generation_id": "g1"})

    def settle_fails(*_a):
        raise OSError("journal locked")

    monkeypatch.setattr(comfy.canvas_runs, "settle", settle_fails)
    with pytest.raises(OSError):
        comfy._save_canvas_run(_canvas_run(["comfy/a.png"]), _identity(), None)
    canvas_save.assert_called_once_with("acct:a@x")  # 다시 시도하면 '이미 저장됨'이라 신호를 낼 기회가 없다


# ── 2-4 바뀐 것 없는 계정 보고 ────────────────────────────────────────────────

WS = {"id": "ws-1", "name": "Team", "plan_type": "team", "credits": 100, "user_role": "member", "is_selected": True}


@pytest.fixture
def account_db(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content.db"))
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    yield
    db.flush_pool()


def test_the_same_report_again_is_not_a_visible_change(account_db):
    status = {"email": "a@x", "workspaces": [WS]}
    assert identity.record_account_status("a@x", status) is True  # 처음
    assert identity.record_account_status("a@x", status) is False  # 똑같은 보고
    assert identity.record_account_status("a@x", {"email": "a@x", "workspaces": [{**WS, "credits": 90}]}) is True


def test_restoring_a_shared_value_another_account_changed_is_a_change(account_db):
    a = {"email": "a@x", "workspaces": [WS]}
    identity.record_account_status("a@x", a)
    identity.record_account_status("b@x", {"email": "b@x", "workspaces": [{**WS, "credits": 80}]})
    assert identity.record_account_status("a@x", a) is True  # 원문은 같지만 공유 등록부 80 → 100


def test_a_new_project_enrollment_is_a_change(account_db):
    status = {"email": "a@x", "workspaces": [WS]}
    repo.register("a@x", "password123")
    with db.get_connection() as conn:
        conn.execute("UPDATE account SET creator_uid='user_a' WHERE email='a@x'")
    identity.record_account_status("a@x", status)
    assert identity.record_account_status("a@x", status) is False
    with db.get_connection() as conn:
        conn.execute("INSERT INTO project(id,name,kind,workspace_scope,workspace_id,workspace_name,archived) "
                     "VALUES('p-new','N','team','team','ws-1','Team',0)")
    assert identity.record_account_status("a@x", status) is True  # 새 프로젝트에 자동 편입
    assert identity.record_account_status("a@x", status) is False


def test_an_old_style_report_compares_the_raw_text(account_db):
    assert identity.record_account_status("a@x", {"credits": 5}) is True
    assert identity.record_account_status("a@x", {"credits": 5}) is False


def test_an_old_style_report_compares_inside_the_write_lock(account_db, tmp_path):
    """다른 쓰기가 끼어든 뒤의 같은 원문 재저장은 '바뀜'이다 — 비교와 저장이 한 잠금 안이어야 그 쓰기를 본다."""
    import sqlite3

    x = {"credits": 5}
    identity.record_account_status("a@x", x)
    other = sqlite3.connect(str(tmp_path / "content.db"), isolation_level=None)
    other.execute("BEGIN IMMEDIATE")  # 다른 저장이 잠금을 쥔 채 Y 를 쓰는 중
    other.execute("UPDATE app_setting SET value=? WHERE key='hf_status:a@x'", (json.dumps({"credits": 9}),))
    result = {}
    worker = threading.Thread(target=lambda: result.setdefault("changed", identity.record_account_status("a@x", x)))
    worker.start()
    worker.join(0.5)  # 잠금에 막혀 기다린다(잠금 없이 읽으면 이미 옛 X 를 읽었다)
    other.execute("COMMIT")
    other.close()
    worker.join(10)
    assert result["changed"] is True  # Y → X 로 되돌렸다
    assert json.loads(repo.get_setting("hf_status:a@x")) == x


def _report_route(monkeypatch, status):
    monkeypatch.setattr(ingest, "MANAGE_ENABLED", True)
    monkeypatch.setattr(ingest, "AUTH_ENABLED", True)
    monkeypatch.setattr(ingest, "_agent_write_acc", lambda request: {"email": "a@x", "creator_uid": "user_a"})
    monkeypatch.setattr("app.repo.manage.record_transactions",
                        lambda *_a: {"stored": 0, "rejected": 0, "inserted": 0, "matched": 0})
    request = SimpleNamespace(state=SimpleNamespace())
    ingest.ingest_account_report(ingest.AccountReportIn(account_status=status), request)
    return getattr(request.state, "library_unchanged", False)


def test_route_marks_only_an_unchanged_report_quiet(account_db, monkeypatch):
    status = {"email": "a@x", "workspaces": [WS]}
    assert _report_route(monkeypatch, status) is False  # 처음 — synced
    assert _report_route(monkeypatch, status) is True  # 똑같은 보고 — synced 없음
    assert _report_route(monkeypatch, {"email": "a@x", "workspaces": [{**WS, "credits": 1}]}) is False
