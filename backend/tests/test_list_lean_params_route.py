"""`params.prompt` 축약이 **목록 응답에만** 적용되는지 — 라우트를 실제로 태워 본다.

★왜 라우트까지 보나: 축약을 저장소·공통 직렬화에 넣으면 상세·히스토리·재생성·번들·동기화가
 **함께 새어 나간다**(코덱스 조건 3). 경계가 지켜지는지는 헬퍼 단위 시험으로는 못 본다.

★그리고 **옛 프론트 공존**: `lean_params` 를 안 보내면 종전과 똑같아야 한다.
 옛 화면은 아직 목록 행으로 레시피를 만들기 때문이다.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import db, repo
from app.deps import resolve_agent_account
from app.main import app


@pytest.fixture()
def client(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        old = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = str(Path(tmp) / "content_hub.db")
        db.flush_pool()
        try:
            monkeypatch.setattr(db, "_POOL_ENABLED", False)
            db.init_db()
            repo.ensure_default_worker()
            yield TestClient(app, client=("127.0.0.1", 50000))
        finally:
            db.flush_pool()
            if old is None:
                os.environ.pop("CONTENT_HUB_DB", None)
            else:
                os.environ["CONTENT_HUB_DB"] = old


def _make(prompt: str, params: dict | None) -> str:
    account = resolve_agent_account(None)
    uid = account.get("creator_uid") or repo.get_my_uid()
    return repo.create_local_generation(
        {"prompt": prompt, "model": "nano_banana_pro", "params": params}, "me", creator_uid=uid
    )


def _row(items, gen_id):
    return next(g for g in items if g["id"] == gen_id)


def test_the_list_keeps_everything_when_the_client_does_not_ask(client):
    """★옛 프론트 공존 — 인자를 안 보내면 **종전과 똑같다.**"""
    gid = _make("고양이", {"prompt": "고양이", "aspect_ratio": "16:9"})
    items = client.get("/api/generations?limit=50").json()
    assert _row(items, gid)["params"] == {"prompt": "고양이", "aspect_ratio": "16:9"}


def test_the_list_drops_the_duplicate_when_asked(client):
    gid = _make("고양이", {"prompt": "고양이", "aspect_ratio": "16:9"})
    items = client.get("/api/generations?limit=50&lean_params=1").json()
    row = _row(items, gid)
    assert row["params"] == {"aspect_ratio": "16:9"}
    assert row["prompt"] == "고양이"  # 화면이 쓰는 값은 그대로 온다


def test_the_history_response_still_carries_the_whole_params(client):
    """★이 시험이 이 파일의 이유다 — 레시피가 쓰는 값이 여기서 오고, 여기는 **안 줄인다**."""
    gid = _make("새 프롬프트", {"prompt": "옛 프롬프트", "seed": 7})
    client.get("/api/generations?limit=50&lean_params=1")  # 목록을 먼저 축약해 받아도
    target = client.get(f"/api/generations/{gid}/history").json()["target"]
    assert target["params"] == {"prompt": "옛 프롬프트", "seed": 7}


def test_the_detail_response_still_carries_the_whole_params(client):
    gid = _make("고양이", {"prompt": "고양이", "seed": 1})
    client.get("/api/generations?limit=50&lean_params=1")
    detail = client.get(f"/api/generations/{gid}").json()
    assert detail["params"] == {"prompt": "고양이", "seed": 1}


def test_the_stored_row_is_untouched(client):
    """DB 는 건드리지 않는다 — 축약은 응답에서만 일어난다."""
    gid = _make("고양이", {"prompt": "고양이", "seed": 1})
    for _ in range(3):
        client.get("/api/generations?limit=50&lean_params=1")
    with db.get_connection() as conn:
        raw = conn.execute("SELECT params FROM generation WHERE id=?", (gid,)).fetchone()[0]
    assert '"prompt"' in raw


def test_rows_without_a_prompt_key_survive_both_ways(client):
    a = _make("프롬프트만", {"seed": 3})
    b = _make("파라미터 없음", None)
    for query in ("", "&lean_params=1"):
        items = client.get(f"/api/generations?limit=50{query}").json()
        assert _row(items, a)["params"] == {"seed": 3}
        assert _row(items, b)["params"] in (None, {})


def _delegating(monkeypatch, rows):
    """위임(프록시) 허브인 척한다 — 팀 목록은 공유 서버에서 오고 그 경로도 축약 대상이다."""
    from app.routers import _proxy, library

    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    monkeypatch.setattr(library._proxy, "proxying", lambda: True, raising=False)
    monkeypatch.setattr(library._proxy, "proxy_get", lambda path, request: rows)
    monkeypatch.setattr(library, "_overlay_personal_meta", lambda data, request: data)
    monkeypatch.setattr(library, "_schedule_remote_thumb_prewarm", lambda background, data: None)


def test_the_delegated_team_list_obeys_the_same_flag(client, monkeypatch):
    """★위임 경로도 **인자가 있을 때만** 축약한다.

    이 시험이 없으면 '언제나 축약' 변이가 로컬 경로 시험만으로는 잡히지 않는다
    (되돌려 확인에서 실제로 놓쳐서 추가했다).
    """
    def rows():
        # 응답 모델(GenerationOut)이 요구하는 필드까지 채운다 — 가짜는 **바깥 경계에만** 둔다.
        return [{"id": "t1", "worker_id": "me", "status": "done",
                 "created_at": "2026-09-12 00:00:00", "prompt": "팀 고양이",
                 "params": {"prompt": "팀 고양이", "aspect_ratio": "9:16"}}]

    _delegating(monkeypatch, rows())
    kept = client.get("/api/generations?tab=team&limit=50").json()
    assert kept[0]["params"] == {"prompt": "팀 고양이", "aspect_ratio": "9:16"}

    _delegating(monkeypatch, rows())
    lean = client.get("/api/generations?tab=team&limit=50&lean_params=1").json()
    assert lean[0]["params"] == {"aspect_ratio": "9:16"}
    assert lean[0]["prompt"] == "팀 고양이"


@pytest.mark.parametrize("value", ["2", "-1", "yes"])
def test_a_bad_flag_is_refused_rather_than_guessed(client, value):
    """0/1 만 받는다 — 조용히 참으로 해석하면 옛 프론트가 축약본을 받을 수 있다."""
    assert client.get(f"/api/generations?limit=50&lean_params={value}").status_code == 422
