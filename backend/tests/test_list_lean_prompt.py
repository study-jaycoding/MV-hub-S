"""`lean_prompt=1` — 목록 응답의 `prompt`·`display_prompt` 를 빈 글로(2026-10-15, 42회차).

★왜: 공유 탭에서 찾는 조건을 켠 채 컷 카드로 묶으면 화면이 그 조회를 500건씩 끝까지 받는다(프런트 lib/useLocalFolderCards).
 격리 실측 500건 한 쪽이 12.3MB, 그중 86% 가 이 두 칸이었다 — 묶기는 프롬프트를 읽지 않는다.
★경계(Codex 42회차 설계 검토): 인자가 있을 때만 · 원본 행을 고치지 않음 · `lean_params` 와 같이 써도 · 두 반환 경로(직접·위임)와 개인메타 거르기 경로 ·
 커서 둘째 쪽 · 상세·히스토리는 원문 · 함수를 직접 부르면 기본값이 Query(0) 객체라 `== 1` 로 견줘야 한다.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from unittest import mock

import pytest
from fastapi import BackgroundTasks
from fastapi.testclient import TestClient

from app import db, repo
from app.deps import resolve_agent_account
from app.main import app
from app.routers import library
from app.repo import generations_query
from app.routers.library import _blank_list_prompt_text, _lean_list

LONG = "긴 프롬프트 " * 50


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


def _make(prompt: str = LONG, params: dict | None = None) -> str:
    account = resolve_agent_account(None)
    uid = account.get("creator_uid") or repo.get_my_uid()
    return repo.create_local_generation(
        {"prompt": prompt, "model": "nano_banana_pro", "params": params if params is not None else {"prompt": prompt, "seed": 1}},
        "me", creator_uid=uid,
    )


def _row(items, gen_id):
    return next(g for g in items if g["id"] == gen_id)


def test_the_helper_returns_new_rows_and_leaves_the_originals_alone():
    rows = [{"id": "a", "prompt": LONG, "display_prompt": "보이는 글", "model": "m"}, {"id": "b", "prompt": "짧은"}, None]
    out = _blank_list_prompt_text(rows)
    assert out[0] == {"id": "a", "prompt": "", "display_prompt": "", "model": "m"}
    assert out[1] == {"id": "b", "prompt": ""}  # display_prompt 가 없던 행에 칸을 새로 만들지 않는다
    assert out[2] is None
    assert rows[0]["prompt"] == LONG and rows[0]["display_prompt"] == "보이는 글" and rows[1]["prompt"] == "짧은"


def test_with_lean_params_too_both_apply_and_the_original_prompt_survives():
    rows = [{"id": "a", "prompt": LONG, "params": {"prompt": LONG, "seed": 1}}]
    out = _lean_list(rows, 1, 1)
    assert out[0]["prompt"] == "" and out[0]["params"] == {"seed": 1}
    assert rows[0]["prompt"] == LONG  # 원본 행의 프롬프트는 그대로(params 교체는 lean_params 의 원래 동작)


def test_no_flag_keeps_everything(client):
    gid = _make()
    row = _row(client.get("/api/generations?limit=50").json(), gid)
    assert row["prompt"] == LONG and row["params"]["prompt"] == LONG


def test_the_flag_blanks_only_the_prompt_text(client):
    gid = _make()
    plain = _row(client.get("/api/generations?limit=50&lean_params=1").json(), gid)
    lean = _row(client.get("/api/generations?limit=50&lean_params=1&lean_prompt=1").json(), gid)
    assert lean["prompt"] == "" and lean.get("display_prompt") in ("", None)
    assert {k: v for k, v in lean.items() if k not in ("prompt", "display_prompt")} == \
        {k: v for k, v in plain.items() if k not in ("prompt", "display_prompt")}


def test_the_second_page_by_cursor_is_lean_too(client):
    ids = [_make(f"{LONG} {i}") for i in range(3)]
    first = client.get("/api/generations?limit=2&lean_params=1&lean_prompt=1").json()
    last = first[-1]
    second = client.get(
        f"/api/generations?limit=2&lean_params=1&lean_prompt=1&cursor_ts={last['sort_ts']}&cursor_id={last['id']}"
    ).json()
    got = {g["id"] for g in first + second}
    assert set(ids) <= got
    assert all(g["prompt"] == "" for g in first + second)


def test_detail_and_history_keep_the_whole_prompt_after_a_lean_list(client):
    gid = _make()
    client.get("/api/generations?limit=50&lean_params=1&lean_prompt=1")
    assert client.get(f"/api/generations/{gid}").json()["prompt"] == LONG
    assert client.get(f"/api/generations/{gid}/history").json()["target"]["prompt"] == LONG
    with db.get_connection() as conn:
        assert conn.execute("SELECT prompt FROM generation WHERE id=?", (gid,)).fetchone()[0] == LONG


@pytest.mark.parametrize("value", ["2", "-1", "yes"])
def test_a_bad_flag_is_refused(client, value):
    assert client.get(f"/api/generations?limit=50&lean_prompt={value}").status_code == 422


def _team_row():
    return {"id": "t1", "worker_id": "me", "status": "done", "created_at": "2026-10-15 00:00:00",
            "prompt": LONG, "display_prompt": "팀 보이는 글", "params": {"prompt": LONG, "aspect_ratio": "9:16"}}


def _delegating(monkeypatch, seen: list):
    from app.routers import _proxy

    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    monkeypatch.setattr(library._proxy, "proxying", lambda: True, raising=False)

    def proxy_get(path, request):
        seen.append(request.url.query)
        return [_team_row()]

    monkeypatch.setattr(library._proxy, "proxy_get", proxy_get)
    monkeypatch.setattr(library, "_overlay_personal_meta", lambda data, request: data)
    monkeypatch.setattr(library, "_schedule_remote_thumb_prewarm", lambda background, data: None)


def test_the_delegated_team_list_forwards_the_flag_and_obeys_it(client, monkeypatch):
    """위임 허브: 쿼리를 그대로 넘기고(새 팀 서버면 거기서 줄인다), 옛 팀 서버가 원문을 줘도 허브가 줄여서 돌려준다."""
    seen: list = []
    _delegating(monkeypatch, seen)
    kept = client.get("/api/generations?tab=team&limit=50").json()
    assert kept[0]["prompt"] == LONG
    lean = client.get("/api/generations?tab=team&limit=50&lean_params=1&lean_prompt=1").json()
    assert lean[0]["prompt"] == "" and lean[0]["display_prompt"] == "" and lean[0]["params"] == {"aspect_ratio": "9:16"}
    assert "lean_prompt=1" in seen[-1] and "lean_prompt" not in seen[0]


def test_the_personal_meta_filter_path_obeys_it_too(client, monkeypatch):
    """색·태그로 거르는 팀 목록은 허브가 따로 받아 거른다(_team_local_filtered) — 같은 반환 지점에서 줄인다."""
    _delegating(monkeypatch, [])
    monkeypatch.setattr(library, "_team_local_filtered", lambda *args, **kwargs: [_team_row()])
    lean = client.get("/api/generations?tab=team&limit=50&colors=%23ff0000&lean_prompt=1").json()
    assert lean[0]["prompt"] == "" and lean[0]["display_prompt"] == ""
    kept = client.get("/api/generations?tab=team&limit=50&colors=%23ff0000").json()
    assert kept[0]["prompt"] == LONG


class _State:
    pass


class _Request:
    def __init__(self):
        self.state = _State()
        self.state.account = None


def test_a_direct_call_without_the_argument_keeps_the_prompt():
    """함수를 직접 부르면 lean_prompt 의 기본값은 Query(0) 객체다 — `if lean_prompt` 였다면 참으로 읽혀 원문을 비웠다(Codex 42회차)."""
    rows = [{"id": "x", "prompt": LONG, "display_prompt": "보이는 글", "shared": False, "comment_count": 0}]
    with mock.patch.object(library.repo, "list_generations", return_value=rows), \
            mock.patch.object(library._proxy, "proxying", return_value=False):
        result = library.list_generations(_Request(), BackgroundTasks(), tab="my", colors=[], tags=[], auto_tags=[], limit=500)
    assert result[0]["prompt"] == LONG and result[0]["display_prompt"] == "보이는 글"


# ── 83회차 A②: 빈 글을 조회(SELECT) 단계에서 — 다 읽고 보강한 뒤 비우던 것을 처음부터 안 읽는다 ──


def _set(sql, *args):
    with db.get_connection() as conn:
        conn.execute(sql, args)


def test_the_rows_handed_to_enrichment_never_carry_the_prompt_text(client, monkeypatch):
    """lean 이면 보강(_attach_children)에 넘어가는 행의 두 칸이 이미 빈 글이다 — 반환 직전에 비우기만 하면 실패한다."""
    gid = _make()
    _set("UPDATE generation SET display_prompt = ? WHERE id = ?", "보이는 " + LONG, gid)
    seen: list = []
    real = generations_query._attach_children

    def spy(conn, rows, **kwargs):
        seen.extend((row["prompt"], row["display_prompt"]) for row in rows)
        return real(conn, rows, **kwargs)

    monkeypatch.setattr(generations_query, "_attach_children", spy)
    assert client.get("/api/generations?limit=50&lean_params=1&lean_prompt=1").status_code == 200
    assert seen and set(seen) == {("", "")}
    seen.clear()
    client.get("/api/generations?limit=50&lean_params=1")  # 인자가 없으면 지금처럼 원문을 읽는다
    assert (LONG, "보이는 " + LONG) in seen


def _fixture_for_the_comparison():
    """검색(긴 글 = FTS·짧은 글 = LIKE)·태그 검색·태그 거르기·커서·팀 탭이 모두 걸리는 자료."""
    cat = _make("고양이가 창가에 앉아 있다 " + LONG)
    _set("UPDATE generation SET display_prompt = '@고양이 가 창가에' WHERE id = ?", cat)
    dog = _make("강아지 산책")                     # 프롬프트에는 'cat' 이 없다 — 태그로만 찾힌다
    _set("INSERT INTO tag(id, name) VALUES('t-cat', 'cat')")
    _set("INSERT INTO gen_tag(generation_id, tag_id) VALUES(?, 't-cat')", dog)
    plain = _make("아무 것도 아닌 글", params={"seed": 2})
    _set("UPDATE generation SET display_prompt = NULL WHERE id = ?", plain)
    for gid in (cat, dog):
        _set("INSERT INTO share(id, generation_id, shared_by, visibility) VALUES(?, ?, 'me', 'team')", "s-" + gid, gid)
    return cat, dog, plain


@pytest.mark.parametrize("query, expect", [
    ("limit=50", 3),
    ("limit=50&lean_params=1", 3),
    ("limit=2", 2),
    ("limit=50&search=%EA%B3%A0%EC%96%91%EC%9D%B4%EA%B0%80", 1),   # '고양이가' — 3자 이상(FTS)
    ("limit=50&search=%EC%82%B0%EC%B1%85", 1),                     # '산책' — 2자(LIKE)
    ("limit=50&search=cat", 1),                                     # 프롬프트 말고 태그 이름으로 찾힌다
    ("limit=50&tag=cat", 1),
    ("limit=50&tab=team", 2),
    ("limit=50&search=zzqq", 0),
])
def test_lean_answers_exactly_what_blanking_the_full_answer_gave(client, query, expect):
    """바꾸기 전/후 같은 입력: lean 응답 = 원문 응답에서 두 칸만 비운 것(바꾸기 전 lean 이 정확히 그것이었다) — 행·순서·나머지 칸 모두.
    검색은 원문으로 건다 — 빈 글로 검색했다면 lean 쪽이 비어 이 비교가 깨진다."""
    _fixture_for_the_comparison()
    full = client.get(f"/api/generations?{query}").json()
    lean = client.get(f"/api/generations?{query}&lean_prompt=1").json()
    assert len(full) == expect
    assert lean == _blank_list_prompt_text(full)
    if full:  # 커서로 받는 둘째 쪽도 같다
        last = full[-1]
        tail = f"{query}&cursor_ts={last['sort_ts']}&cursor_id={last['id']}"
        assert client.get(f"/api/generations?{tail}&lean_prompt=1").json() == _blank_list_prompt_text(
            client.get(f"/api/generations?{tail}").json()
        )


@pytest.mark.parametrize("kwargs", [
    {"tab": "my"},
    {"tab": "my", "account_uid": "u-nobody"},
    {"tab": "team"},
    {"tab": "team", "team_member_projects": [], "account_uid": "u-nobody"},
    {"tab": "my", "search": "고양이가"},
    {"tab": "my", "search": "산책"},
    {"tab": "my", "search": "cat"},
    {"tab": "my", "tags": ["cat"]},
])
def test_the_repo_projection_matches_blanking_its_full_rows(client, kwargs):
    """repo 를 직접 불러도 같다 — 보는 계정·가시성·검색 조합마다 lean 행 = 원문 행에서 두 칸만 비운 것."""
    _fixture_for_the_comparison()
    assert repo.list_generations(**kwargs, lean_prompt=True) == _blank_list_prompt_text(repo.list_generations(**kwargs))


def test_the_router_hands_the_flag_to_the_repo_only_when_it_is_1():
    """직접 호출(MCP 등)의 기본값은 Query(0) 객체다 — 그것을 참으로 읽어 repo 에 넘기면 상세가 아닌 목록 원문이 빈다."""
    with mock.patch.object(library.repo, "list_generations", return_value=[]) as listed, \
            mock.patch.object(library._proxy, "proxying", return_value=False):
        library.list_generations(_Request(), BackgroundTasks(), tab="my", colors=[], tags=[], auto_tags=[], limit=500)
        assert listed.call_args.kwargs["lean_prompt"] is False
        library.list_generations(_Request(), BackgroundTasks(), tab="my", colors=[], tags=[], auto_tags=[], limit=500, lean_prompt=1)
        assert listed.call_args.kwargs["lean_prompt"] is True
