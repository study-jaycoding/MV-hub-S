"""로컬 허브와 공유 서버의 공유·최종 상태 보상 경계.

프록시 모드에서는 서버가 권위지만, 같은 생성의 로컬 카드도 즉시 미러한다. 서버 요청과
로컬 SQLite 갱신 사이가 끊겨도 ``is_final => shared`` 불변식과 양쪽 최종 상태가 조용히
갈라지지 않아야 한다.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest import mock

import pytest
from fastapi import HTTPException

from app import db, repo
from app.routers import share


@pytest.fixture
def isolated_content_db(monkeypatch, tmp_path):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    try:
        yield
    finally:
        db.flush_pool()


def _seed_final_generation() -> str:
    gen_id = repo.create_local_generation(
        {"model": "test-model", "prompt": "share consistency"},
        "me",
        generation_id="local-1",
    )
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE generation SET status='done', job_id='server-1' WHERE id=?",
            (gen_id,),
        )
    repo.publish(gen_id, "me", "team")
    repo.set_final(gen_id, True, "me")
    return gen_id


def test_proxy_unpublish_blocks_local_final_before_remote_mutation():
    generation = {"id": "local-1", "job_id": "server-1", "is_final": True, "shared": True}

    with (
        mock.patch.object(share.repo, "resolve_local_id", return_value="local-1"),
        mock.patch.object(share.repo, "get_generation", return_value=generation),
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(share._proxy, "proxy_json") as proxy_json,
        mock.patch.object(share.repo, "unpublish") as local_unpublish,
        pytest.raises(HTTPException) as raised,
    ):
        share.unpublish("server-1", SimpleNamespace())

    assert raised.value.status_code == 409
    assert "먼저 최종 해제" in str(raised.value.detail)
    proxy_json.assert_not_called()
    local_unpublish.assert_not_called()


def test_proxy_unpublish_guard_preserves_real_sqlite_state(isolated_content_db):
    gen_id = _seed_final_generation()

    with (
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(share._proxy, "proxy_json") as proxy_json,
        pytest.raises(HTTPException) as raised,
    ):
        share.unpublish(gen_id, SimpleNamespace())

    assert raised.value.status_code == 409
    proxy_json.assert_not_called()
    saved = repo.get_generation(gen_id)
    assert saved["is_final"] is True
    assert saved["shared"] is True


def test_proxy_unpublish_404_reconciles_nonfinal_local_share():
    generation = {"id": "local-1", "job_id": "server-1", "is_final": False, "shared": True}

    def get_generation(_gen_id):
        return dict(generation)

    def local_unpublish(_gen_id):
        generation["shared"] = False
        return 1

    with (
        mock.patch.object(share.repo, "resolve_local_id", return_value="local-1"),
        mock.patch.object(share.repo, "get_generation", side_effect=get_generation),
        mock.patch.object(share.repo, "finalize_id_map", return_value=("local-1", "server-1")),
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(
            share._proxy,
            "proxy_json",
            side_effect=HTTPException(status_code=404, detail="generation 없음"),
        ) as proxy_json,
        mock.patch.object(share.repo, "unpublish", side_effect=local_unpublish) as unpublish,
        mock.patch.object(share, "_touch_telemetry") as touch,
    ):
        result = share.unpublish("server-1", SimpleNamespace())

    assert result["shared"] is False
    proxy_json.assert_called_once_with("POST", "/api/generations/server-1/unpublish")
    unpublish.assert_called_once_with("local-1")
    touch.assert_called_once_with("local-1")


def test_proxy_unpublish_recovered_local_row_still_respects_final_guard():
    """팀 탭(서버 UUID) 경로 — 로컬 행을 out.job_id 로 되찾은 뒤에도 final 가드를 다시
    거쳐야 한다. 선행 장애로 '로컬만 final'인 어긋남이 있으면 골드 공유 표식을 무음으로
    지우지 않고 409 로 드러낸다."""
    local_final = {"id": "local-1", "job_id": "server-1", "is_final": True, "shared": True}

    def finalize_id_map(gen_id):
        # 서버 UUID 는 로컬 매칭 실패(None), out.job_id('server-1')로는 로컬 행을 찾는다.
        return ("local-1", "server-1") if gen_id == "server-1" else (None, gen_id)

    def get_generation(gen_id):
        # 서버 UUID 로는 로컬 행이 없고(초입 가드 통과), 되찾은 local-1 만 final 로컬 행.
        return local_final if gen_id == "local-1" else None

    with (
        mock.patch.object(share.repo, "resolve_local_id", side_effect=lambda g: g),
        mock.patch.object(share.repo, "get_generation", side_effect=get_generation),
        mock.patch.object(share.repo, "finalize_id_map", side_effect=finalize_id_map),
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(
            share._proxy,
            "proxy_json",
            return_value={"id": "uuid-9", "job_id": "server-1", "shared": False},
        ),
        mock.patch.object(share.repo, "unpublish") as local_unpublish,
        pytest.raises(HTTPException) as raised,
    ):
        share.unpublish("uuid-9", SimpleNamespace())

    assert raised.value.status_code == 409
    local_unpublish.assert_not_called()


def test_proxy_unpublish_unknown_route_404_does_not_change_local_badge():
    generation = {"id": "local-1", "job_id": "server-1", "is_final": False, "shared": True}

    with (
        mock.patch.object(share.repo, "resolve_local_id", return_value="local-1"),
        mock.patch.object(share.repo, "get_generation", return_value=generation),
        mock.patch.object(share.repo, "finalize_id_map", return_value=("local-1", "server-1")),
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(
            share._proxy,
            "proxy_json",
            side_effect=HTTPException(status_code=404, detail="Not Found"),
        ),
        mock.patch.object(share.repo, "unpublish") as local_unpublish,
        mock.patch.object(share, "_touch_telemetry") as touch,
        pytest.raises(HTTPException) as raised,
    ):
        share.unpublish("server-1", SimpleNamespace())

    assert raised.value.status_code == 404
    local_unpublish.assert_not_called()
    touch.assert_not_called()


def test_proxy_unfinalize_404_does_not_guess_local_state():
    generation = {"id": "local-1", "job_id": "server-1", "is_final": True, "shared": True}
    remote_error = HTTPException(status_code=404, detail="generation 없음")

    with (
        mock.patch.object(share.repo, "resolve_local_id", return_value="local-1"),
        mock.patch.object(share.repo, "get_generation", return_value=generation),
        mock.patch.object(share.repo, "finalize_id_map", return_value=("local-1", "server-1")),
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(share._proxy, "proxy_json", side_effect=remote_error),
        mock.patch.object(share.repo, "set_final") as local_set_final,
        mock.patch.object(share, "_touch_telemetry") as touch,
        pytest.raises(HTTPException) as raised,
    ):
        share.unfinalize("server-1", SimpleNamespace())

    assert raised.value is remote_error
    assert generation["is_final"] is True
    local_set_final.assert_not_called()
    touch.assert_not_called()


def test_proxy_unfinalize_updates_real_sqlite_mirror(isolated_content_db):
    gen_id = _seed_final_generation()

    with (
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(
            share._proxy,
            "proxy_json",
            return_value={"id": "server-1", "job_id": "server-1", "is_final": False},
        ),
        mock.patch.object(share, "_touch_telemetry") as touch,
    ):
        share.unfinalize(gen_id, SimpleNamespace())

    saved = repo.get_generation(gen_id)
    assert saved["is_final"] is False
    assert saved["shared"] is True
    touch.assert_called_once_with(gen_id)


def test_proxy_unfinalize_local_retry_succeeds_without_compensation():
    generation = {"id": "local-1", "job_id": "server-1", "is_final": True, "shared": True}
    attempts = 0
    remote_calls: list[str] = []

    def get_generation(_gen_id):
        return dict(generation)

    def set_final(_gen_id, value, *_args):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("database is locked")
        generation["is_final"] = value

    def proxy_json(_method, path, **_kwargs):
        remote_calls.append(path)
        return {"id": "server-1", "job_id": "server-1", "is_final": False}

    with (
        mock.patch.object(share.repo, "resolve_local_id", return_value="local-1"),
        mock.patch.object(share.repo, "get_generation", side_effect=get_generation),
        mock.patch.object(share.repo, "finalize_id_map", return_value=("local-1", "server-1")),
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(share._proxy, "proxy_json", side_effect=proxy_json),
        mock.patch.object(share.repo, "set_final", side_effect=set_final),
        mock.patch.object(share, "_touch_telemetry"),
    ):
        share.unfinalize("server-1", SimpleNamespace())

    assert generation["is_final"] is False
    assert attempts == 2
    assert remote_calls == ["/api/generations/server-1/unfinalize"]


def test_proxy_unfinalize_confirms_commit_after_write_exception():
    generation = {"id": "local-1", "job_id": "server-1", "is_final": True, "shared": True}
    remote_calls: list[str] = []

    def get_generation(_gen_id):
        return dict(generation)

    def set_final(_gen_id, value, *_args):
        # 커밋 뒤 드라이버/연결 종료에서 예외가 난 모호한 결과를 흉내 낸다.
        generation["is_final"] = value
        raise RuntimeError("post-commit connection error")

    def proxy_json(_method, path, **_kwargs):
        remote_calls.append(path)
        return {"id": "server-1", "job_id": "server-1", "is_final": False}

    with (
        mock.patch.object(share.repo, "resolve_local_id", return_value="local-1"),
        mock.patch.object(share.repo, "get_generation", side_effect=get_generation),
        mock.patch.object(share.repo, "finalize_id_map", return_value=("local-1", "server-1")),
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(share._proxy, "proxy_json", side_effect=proxy_json),
        mock.patch.object(share.repo, "set_final", side_effect=set_final),
        mock.patch.object(share, "_touch_telemetry") as touch,
    ):
        result = share.unfinalize("server-1", SimpleNamespace())

    assert result["is_final"] is False
    assert generation["is_final"] is False
    assert remote_calls == ["/api/generations/server-1/unfinalize"]
    touch.assert_called_once_with("local-1")


def test_proxy_unfinalize_skips_local_write_when_already_unfinalized():
    generation = {"id": "local-1", "job_id": "server-1", "is_final": False, "shared": True}

    with (
        mock.patch.object(share.repo, "resolve_local_id", return_value="local-1"),
        mock.patch.object(share.repo, "get_generation", return_value=generation),
        mock.patch.object(share.repo, "finalize_id_map", return_value=("local-1", "server-1")),
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(
            share._proxy,
            "proxy_json",
            return_value={"id": "server-1", "job_id": "server-1", "is_final": False},
        ),
        mock.patch.object(share.repo, "set_final") as local_set_final,
        mock.patch.object(share, "_touch_telemetry"),
    ):
        share.unfinalize("server-1", SimpleNamespace())

    local_set_final.assert_not_called()


def test_proxy_unfinalize_local_failure_restores_remote_final_state():
    generation = {"id": "local-1", "job_id": "server-1", "is_final": True, "shared": True}
    remote_calls: list[str] = []

    def proxy_json(_method, path, **_kwargs):
        remote_calls.append(path)
        return {"id": "server-1", "job_id": "server-1"}

    with (
        mock.patch.object(share.repo, "resolve_local_id", return_value="local-1"),
        mock.patch.object(share.repo, "get_generation", return_value=generation),
        mock.patch.object(share.repo, "finalize_id_map", return_value=("local-1", "server-1")),
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(share._proxy, "proxy_json", side_effect=proxy_json),
        mock.patch.object(
            share.repo,
            "set_final",
            side_effect=RuntimeError("local mirror unavailable"),
        ) as local_set_final,
        mock.patch.object(share, "_touch_telemetry") as touch,
        pytest.raises(HTTPException) as raised,
    ):
        share.unfinalize("server-1", SimpleNamespace())

    assert raised.value.status_code == 503
    assert "서버 변경을 되돌렸습니다" in str(raised.value.detail)
    assert local_set_final.call_count == 2
    assert remote_calls == [
        "/api/generations/server-1/unfinalize",
        "/api/generations/server-1/finalize",
    ]
    touch.assert_not_called()


def test_proxy_unfinalize_reports_when_remote_compensation_also_fails():
    generation = {"id": "local-1", "job_id": "server-1", "is_final": True, "shared": True}
    remote_calls: list[str] = []

    def proxy_json(_method, path, **_kwargs):
        remote_calls.append(path)
        if path.endswith("/finalize"):
            raise HTTPException(status_code=502, detail="server unavailable")
        return {"id": "server-1", "job_id": "server-1", "is_final": False}

    with (
        mock.patch.object(share.repo, "resolve_local_id", return_value="local-1"),
        mock.patch.object(share.repo, "get_generation", return_value=generation),
        mock.patch.object(share.repo, "finalize_id_map", return_value=("local-1", "server-1")),
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(share._proxy, "proxy_json", side_effect=proxy_json),
        mock.patch.object(share.repo, "set_final", side_effect=RuntimeError("local mirror unavailable")),
        mock.patch.object(share, "_touch_telemetry") as touch,
        pytest.raises(HTTPException) as raised,
    ):
        share.unfinalize("server-1", SimpleNamespace())

    assert raised.value.status_code == 502
    assert "상태 동기화에 실패" in str(raised.value.detail)
    assert remote_calls == [
        "/api/generations/server-1/unfinalize",
        "/api/generations/server-1/finalize",
    ]
    touch.assert_not_called()


def test_proxy_unfinalize_preserves_remote_404_without_local_mirror():
    remote_error = HTTPException(status_code=404, detail="generation 없음")

    with (
        mock.patch.object(share.repo, "resolve_local_id", return_value="server-only"),
        mock.patch.object(share.repo, "get_generation", return_value=None),
        mock.patch.object(share.repo, "finalize_id_map", return_value=(None, "server-only")),
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(share._proxy, "proxy_json", side_effect=remote_error),
        mock.patch.object(share.repo, "set_final") as local_set_final,
        pytest.raises(HTTPException) as raised,
    ):
        share.unfinalize("server-only", SimpleNamespace())

    assert raised.value is remote_error
    local_set_final.assert_not_called()
