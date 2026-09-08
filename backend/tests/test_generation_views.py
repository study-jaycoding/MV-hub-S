"""마지막으로 본 생성물 표시 — 저장 계약과 Codex 적대 검토가 짚은 함정들을 고정한다.

고정하는 것:
  · 씬을 두 번 가져와 card_id 가 겹쳐도 씬끼리 섞이지 않는다(복합키).
  · 휴지통에 가면 감춰지고 복원하면 저절로 돌아온다(FK CASCADE 였다면 영영 사라졌다).
  · 로컬에 없는 생성물(팀 항목)은 저장한 척하지 않고 분명히 거절한다.
  · 최신 판정이 시각이 아니라 순번이다(같은 초에 두 번 열어도 순서가 선다).
  · 배지 이동이 다른 창의 라이브러리 재조회를 부르지 않는다.
  · 조회 경로가 /generations/{gen_id} 에 잡아먹히지 않는다.
"""

from __future__ import annotations

import os
import tempfile
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import db, repo
from app.config import DEFAULT_WORKER_ID
from app.db import get_connection
from app.main import app
from app.mutation_notify import DOMAIN_LIBRARY, notification_domains

UID = "user_viewer"


@pytest.fixture()
def client(monkeypatch):
    """빈 임시 DB + TestClient. AUTH off 라 actor_id 는 기본 작업자('me')다."""
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


def _make_gen(gen_id: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO generation (id, worker_id, prompt, status, created_at) "
            "VALUES (?,?,?, 'done', datetime('now'))",
            (gen_id, DEFAULT_WORKER_ID, "테스트"),
        )


def _new_gen() -> str:
    gen_id = f"g_{uuid.uuid4().hex[:10]}"
    _make_gen(gen_id)
    return gen_id


# ── 복합키 ──────────────────────────────────────────────────────────────────
def test_same_card_id_in_two_scenes_does_not_collide(client):
    """importScene 은 씬 id 만 새로 만들고 카드는 그대로 가져온다 → card_id 가 겹친다."""
    a, b = _new_gen(), _new_gen()
    repo.record_generation_view(UID, a, scene_id="scene-1", card_id="card-x")
    repo.record_generation_view(UID, b, scene_id="scene-2", card_id="card-x")

    assert repo.list_generation_views(UID, scene_id="scene-1")["card"]["card-x"] == a
    assert repo.list_generation_views(UID, scene_id="scene-2")["card"]["card-x"] == b


def test_same_card_is_overwritten_not_appended(client):
    """한 묶음은 마지막 하나만 기억한다."""
    a, b = _new_gen(), _new_gen()
    repo.record_generation_view(UID, a, scene_id="s", card_id="c")
    repo.record_generation_view(UID, b, scene_id="s", card_id="c")
    view = repo.list_generation_views(UID, scene_id="s")
    assert view["card"] == {"c": b}


# ── 캔버스 배지 판정 ────────────────────────────────────────────────────────
def test_last_card_is_newest_by_sequence_not_clock(client):
    """같은 초에 여러 번 열려도 순번으로 순서가 선다(viewed_at 정렬이면 흔들린다)."""
    first, second = _new_gen(), _new_gen()
    repo.record_generation_view(UID, first, scene_id="s", card_id="c1")
    repo.record_generation_view(UID, second, scene_id="s", card_id="c2")
    assert repo.list_generation_views(UID, scene_id="s")["last_card_id"] == "c2"

    # 앞 카드를 다시 보면 그쪽이 최신이 된다.
    repo.record_generation_view(UID, first, scene_id="s", card_id="c1")
    assert repo.list_generation_views(UID, scene_id="s")["last_card_id"] == "c1"


def test_clock_going_backwards_does_not_change_last_card(client):
    """viewed_at 을 억지로 뒤집어도 순번이 이긴다 — 시각 정렬로 잘못 바뀌면 이 테스트가 잡는다."""
    first, second = _new_gen(), _new_gen()
    repo.record_generation_view(UID, first, scene_id="s", card_id="c1")
    repo.record_generation_view(UID, second, scene_id="s", card_id="c2")
    with get_connection() as conn:
        # 먼저 본 c1 의 시각을 미래로, 나중에 본 c2 를 과거로 — 시계 역행을 흉내낸다.
        conn.execute("UPDATE generation_view SET viewed_at='2099-01-01 00:00:00' WHERE card_id='c1'")
        conn.execute("UPDATE generation_view SET viewed_at='2000-01-01 00:00:00' WHERE card_id='c2'")
    assert repo.list_generation_views(UID, scene_id="s")["last_card_id"] == "c2"


def test_outside_canvas_view_does_not_move_canvas_badge(client):
    """캔버스 밖(목록·히스토리) 열람은 캔버스 배지를 움직이지 않는다 — 사용자 확정."""
    on_card, in_library = _new_gen(), _new_gen()
    repo.record_generation_view(UID, on_card, scene_id="s", card_id="c")
    repo.record_generation_view(UID, in_library)  # scene_id='' card_id=''

    assert repo.list_generation_views(UID, scene_id="s")["last_card_id"] == "c"
    assert repo.list_generation_views(UID)["card"] == {"": in_library}


def test_scene_id_and_card_id_must_come_together(client):
    """한쪽만 오면 다른 씬의 같은 카드와 섞인다."""
    gen_id = _new_gen()
    with pytest.raises(ValueError):
        repo.record_generation_view(UID, gen_id, scene_id="s")
    with pytest.raises(ValueError):
        repo.record_generation_view(UID, gen_id, card_id="c")


# ── 휴지통 ──────────────────────────────────────────────────────────────────
def test_trashed_generation_hides_badge_and_restore_brings_it_back(client):
    """FK ON DELETE CASCADE 였다면 휴지통에 넣는 순간 행이 죽어 복원해도 안 돌아온다."""
    gen_id = _new_gen()
    repo.record_generation_view(UID, gen_id, scene_id="s", card_id="c")
    assert repo.list_generation_views(UID, scene_id="s")["card"] == {"c": gen_id}

    assert repo.move_to_trash(gen_id) is True
    assert repo.list_generation_views(UID, scene_id="s")["card"] == {}
    assert repo.list_generation_views(UID, scene_id="s")["last_card_id"] is None

    assert repo.restore_from_trash(gen_id) is True
    assert repo.list_generation_views(UID, scene_id="s")["card"] == {"c": gen_id}


# ── 팀 항목 ─────────────────────────────────────────────────────────────────
def test_unknown_generation_is_refused_not_silently_dropped(client):
    """팀 탭에서 본 남의 생성물은 로컬에 행이 없다 — 저장한 척하지 않는다."""
    assert repo.record_generation_view(UID, "server-uuid-not-here", scene_id="s", card_id="c") is None
    assert repo.list_generation_views(UID, scene_id="s")["card"] == {}


def test_api_reports_not_recorded_for_unknown_generation(client):
    r = client.put("/api/generation-views", json={"generation_id": "nope", "scene_id": "s", "card_id": "c"})
    assert r.status_code == 200
    assert r.json()["recorded"] is False


# ── Share & Review(팀) 칸 ───────────────────────────────────────────────────
def test_team_scope_records_without_local_row(client):
    """팀 탭 항목은 로컬에 행이 없는 게 정상 — 실재 검사 없이 기록되고 JOIN 없이 조회된다."""
    assert repo.record_generation_view(UID, "server-uuid-1", scene_id=repo.TEAM_SCOPE) is not None
    assert repo.list_generation_views(UID, scene_id=repo.TEAM_SCOPE)["card"] == {"": "server-uuid-1"}


def test_team_and_workspace_scopes_are_independent(client):
    """Workspace('') 와 Share & Review(@team) 는 각자 하나씩 기억한다 — 사용자 확정."""
    mine = _new_gen()
    repo.record_generation_view(UID, mine)
    repo.record_generation_view(UID, "server-uuid-2", scene_id=repo.TEAM_SCOPE)
    assert repo.list_generation_views(UID)["card"] == {"": mine}
    assert repo.list_generation_views(UID, scene_id=repo.TEAM_SCOPE)["card"] == {"": "server-uuid-2"}


def test_team_scope_rejects_card_id(client):
    """팀 칸은 캔버스가 아니다 — card_id 가 오면 규칙 위반."""
    with pytest.raises(ValueError):
        repo.record_generation_view(UID, "server-uuid-3", scene_id=repo.TEAM_SCOPE, card_id="c")


def test_workspace_scope_still_requires_local_row(client):
    """팀 칸을 열었다고 Workspace 칸의 안전장치(로컬 실재)가 풀리면 안 된다."""
    assert repo.record_generation_view(UID, "server-uuid-4") is None


def test_api_team_scope_round_trip_and_bad_card(client):
    """API 로 팀 칸 PUT→GET. Workspace 칸은 비어 있어야 하고, 팀 칸에 card_id 가 오면 400."""
    body = {"generation_id": "server-uuid-9", "scene_id": repo.TEAM_SCOPE, "card_id": ""}
    r = client.put("/api/generation-views", json=body)
    assert r.status_code == 200 and r.json()["recorded"] is True
    got = client.get("/api/generation-views", params={"scene_id": repo.TEAM_SCOPE}).json()
    assert got["card"] == {"": "server-uuid-9"}
    assert client.get("/api/generation-views").json()["card"] == {}
    bad = client.put("/api/generation-views", json={**body, "card_id": "c"})
    assert bad.status_code == 400


# ── 라우팅·알림 ─────────────────────────────────────────────────────────────
def test_get_route_is_not_swallowed_by_generation_detail(client):
    """/api/generations/{gen_id} 와 겹치지 않는 고정 경로여야 한다."""
    r = client.get("/api/generation-views", params={"scene_id": "s"})
    assert r.status_code == 200
    assert set(r.json()) == {"scene_id", "card", "last_card_id"}


def test_recording_a_view_is_not_a_library_change(client):
    """배지가 움직일 때마다 다른 창이 목록을 다시 읽으면 안 된다."""
    assert DOMAIN_LIBRARY not in notification_domains("PUT", "/api/generation-views", 200)


def test_api_round_trip(client):
    gen_id = _new_gen()
    r = client.put(
        "/api/generation-views",
        json={"generation_id": gen_id, "scene_id": "s1", "card_id": "c1"},
    )
    assert r.status_code == 200 and r.json()["recorded"] is True
    got = client.get("/api/generation-views", params={"scene_id": "s1"}).json()
    assert got["card"] == {"c1": gen_id}
    assert got["last_card_id"] == "c1"
