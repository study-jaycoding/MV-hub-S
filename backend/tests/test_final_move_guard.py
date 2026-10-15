"""Jay 결정 3A(10-15) — 최종본의 프로젝트 귀속을 바꾸는 길에 양쪽 검수자. 판정은 각 쓰기의 같은 트랜잭션 안에서.

설계: docs/status/결정일곱_설계_2026-10-15.md 3A. 임시 DB만 쓴다.
"""

import pytest

from app import db, repo
from app.repo.final_moves import FinalMoveActor

MEMBER = FinalMoveActor(uid="u_me", admin=False)
ADMIN = FinalMoveActor(uid="u_admin", admin=True)


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content.db"))
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    main = repo.create_project("본편")["id"]
    side = repo.create_project("외전")["id"]

    def gen(gid, project=None, final=True, creator="u_me"):
        repo.create_local_generation({"model": "t", "prompt": "p"}, "me", generation_id=gid)
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE generation SET status='done', creator_uid=?, project_id=?, is_final=?, job_id=? WHERE id=?",
                (creator, project, int(final), gid, gid),
            )
        return gid

    yield main, side, gen
    db.flush_pool()


def project_of(gid):
    return repo.get_generation(gid)["project_id"]


def test_member_cannot_move_final_into_or_out_of_project(env):
    main, _side, gen = env
    gen("g1", None)
    gen("g2", main)
    with pytest.raises(repo.FinalMoveDenied) as denied:
        repo.assign_to_project(["g1"], main, final_actor=MEMBER)  # 미분류 최종 → 본편(우회 길)
    assert "본편" in str(denied.value)
    with pytest.raises(repo.FinalMoveDenied):
        repo.assign_to_project(["g2"], None, final_actor=MEMBER)  # 남이 정한 최종을 미분류로 빼내기
    assert (project_of("g1"), project_of("g2")) == (None, main)


def test_destination_supervisor_alone_is_enough_only_from_unassigned(env):
    main, side, gen = env
    gen("g1", None)
    gen("g2", side)
    repo.set_project_roles(main, "u_me", ["supervisor"])
    assert repo.assign_to_project(["g1"], main, final_actor=MEMBER) == 1  # 미분류에서 오면 도착 검수자로 충분
    with pytest.raises(repo.FinalMoveDenied):
        repo.assign_to_project(["g2"], main, final_actor=MEMBER)  # 출발(외전)의 검수자가 아니다
    repo.set_project_roles(side, "u_me", ["supervisor"])
    assert repo.assign_to_project(["g2"], main, final_actor=MEMBER) == 1


def test_admin_non_final_same_project_folder_and_auth_off_pass(env):
    main, side, gen = env
    gen("g1", main)
    gen("g2", None, final=False)
    gen("g3", main)
    assert repo.assign_to_project(["g1"], side, final_actor=ADMIN) == 1
    assert repo.assign_to_project(["g2"], main, final_actor=MEMBER) == 1  # 최종 아님 — 지금대로
    assert repo.assign_to_project(["g3"], main, folder_path="ep01/c010", final_actor=MEMBER) == 1  # 같은 프로젝트 안 폴더 이동
    assert repo.assign_to_project(["g3"], None) == 1  # 판정 없음(AUTH off — 요청자 없음)


def test_one_denied_item_moves_nothing(env):
    main, _side, gen = env
    gen("g1", None, final=False)
    gen("g2", None)
    with pytest.raises(repo.FinalMoveDenied):
        repo.assign_to_project(["g1", "g2"], main, final_actor=MEMBER)
    assert project_of("g1") is None


def test_workspace_batch_that_clears_project_checks_final(env):
    _main, _side, gen = env
    team = repo.create_project("팀 본편", workspace={"scope": "team", "id": "ws1", "name": "팀"})["id"]
    gen("g1", team)
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET workspace_scope='team', workspace_id='ws1', workspace_name='팀' WHERE id='g1'")
    with pytest.raises(repo.FinalMoveDenied):
        repo.set_generation_workspace_batch(["g1"], "remove", {"id": "ws1", "name": "팀"}, final_actor=MEMBER)
    assert project_of("g1") == team
    repo.set_generation_workspace_batch(["g1"], "remove", {"id": "ws1", "name": "팀"}, final_actor=ADMIN)
    assert project_of("g1") is None


def bundle_item(gid, project):
    return {"generation": {"id": gid, "creator_uid": "u_me", "status": "done", "project_id": project}}


def test_bundle_move_of_final_is_blocked_whole_on_server_receive_only(env):
    main, _side, gen = env
    gen("g1", main)
    gen("g2", None, final=False)
    payload = {"provider": {"uid": "u_me", "name": "나"}, "generations": [bundle_item("g1", None), bundle_item("g2", main)]}
    counts = repo.import_bundle_payload(payload, "me", MEMBER)
    assert counts["blocked"] == 1 and counts["blocked_ids"] == ["g1"]
    assert (project_of("g1"), project_of("g2")) == (main, main)  # 걸린 항목만 통째로 남고, 나머지는 반영된다
    assert repo.import_bundle_item(bundle_item("g1", None), "me", "u_me") != "blocked"  # 로컬 반영 길(요청자 없음)은 판정하지 않는다
    assert project_of("g1") is None


def test_finalize_and_release_refuse_when_project_changed_after_check(env):
    main, side, gen = env
    gen("g1", side, final=False)
    with pytest.raises(repo.FinalProjectChanged):
        repo.finalize_generation_with_share("g1", "me", "u_me", "team", expect_project=main)  # 권한은 본편 기준으로 봤다
    assert not repo.get_generation("g1")["is_final"]
    repo.finalize_generation_with_share("g1", "me", "u_me", "team", expect_project=side)
    assert repo.get_generation("g1")["is_final"]
    with pytest.raises(repo.FinalProjectChanged):
        repo.release_final("g1", expect_project=None)
    with pytest.raises(repo.FinalProjectChanged):
        repo.transition_final_review("g1", "shared", "me", expect_project=main)
    assert repo.get_generation("g1")["is_final"]


def test_local_hub_my_move_of_shared_item_goes_to_server_first_and_403_keeps_local(env, monkeypatch):
    from types import SimpleNamespace

    from fastapi import HTTPException

    from app.models import AssignProjectIn
    from app.routers import projects

    main, _side, gen = env
    gen("g1", main)
    calls = []

    def proxy(method, endpoint, **kwargs):
        calls.append((method, endpoint))
        if method == "GET":
            return {"projects": []}
        raise HTTPException(403, "최종본은 두 프로젝트의 검수자(또는 관리자)만 옮길 수 있습니다 — 본편")

    monkeypatch.setattr(projects, "MANAGE_ENABLED", False)
    monkeypatch.setattr(projects._proxy, "proxying", lambda: True)
    monkeypatch.setattr(projects._proxy, "proxy_json", proxy)
    monkeypatch.setattr(projects.repo, "shared_generation_anchors", lambda ids: ["g1"])
    with pytest.raises(HTTPException) as denied:
        projects.assign_project(AssignProjectIn(generation_ids=["g1"], project_id=None), SimpleNamespace(state=SimpleNamespace(account=None)))
    assert denied.value.status_code == 403
    assert ("POST", "/api/projects/assign") in calls
    assert project_of("g1") == main  # 서버가 거절했으니 로컬도 그대로(전엔 로컬을 먼저 옮기고 서버 실패를 삼켰다)


def test_finalize_route_answers_409_when_project_moved_after_permission_check(env, monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import Mock

    from fastapi import HTTPException

    from app.routers import share

    main, side, gen = env
    gen("g1", side, final=False)
    original = repo.get_generation
    monkeypatch.setattr(share._proxy, "proxying", lambda: False)
    monkeypatch.setattr(share, "require_project_role", Mock())  # 권한 확인은 통과(그때 본 귀속 = 본편)
    monkeypatch.setattr(share, "_touch_telemetry", Mock())
    monkeypatch.setattr(share, "journal_audit_event", Mock())
    monkeypatch.setattr(share.repo, "get_generation", lambda gid, *a: {**original(gid), "project_id": main})
    with pytest.raises(HTTPException) as changed:
        share.finalize("g1", SimpleNamespace(state=SimpleNamespace(account=None)), Mock())
    assert changed.value.status_code == 409
    assert not original("g1")["is_final"]

def test_local_hub_rejects_mixed_selection_locally_before_moving_on_server(env, monkeypatch):
    # 옮길 수 있는 공유 카드 + 이 프로젝트 공간에 담을 수 없는 카드를 함께 고르면 서버에 보내기 전에 400 — 서버만 옮겨진 채 남지 않게(Codex 3A 리뷰 P1)
    from types import SimpleNamespace

    from fastapi import HTTPException

    from app.models import AssignProjectIn
    from app.routers import projects

    _main, _side, gen = env
    team = repo.create_project("팀 본편", workspace={"scope": "team", "id": "ws1", "name": "팀"})["id"]
    gen("g1", None, final=False)
    gen("g2", None, final=False)
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET workspace_scope='team', workspace_id='ws2', workspace_name='다른 팀' WHERE id='g2'")
    calls = []

    def proxy(method, endpoint, **kwargs):
        calls.append((method, endpoint))
        return {"projects": []} if method == "GET" else {"updated": 1}

    monkeypatch.setattr(projects, "MANAGE_ENABLED", False)
    monkeypatch.setattr(projects._proxy, "proxying", lambda: True)
    monkeypatch.setattr(projects._proxy, "proxy_json", proxy)
    monkeypatch.setattr(projects.repo, "shared_generation_anchors", lambda ids: ["g1"])
    with pytest.raises(HTTPException) as refused:
        projects.assign_project(AssignProjectIn(generation_ids=["g1", "g2"], project_id=team), SimpleNamespace(state=SimpleNamespace(account=None)))
    assert refused.value.status_code == 400
    assert ("POST", "/api/projects/assign") not in calls
    assert (project_of("g1"), project_of("g2")) == (None, None)


def test_bundle_receive_judges_with_identity_linked_in_the_same_request(env, monkeypatch):
    # 이 요청에서 acct:→user_ 로 신원이 연결되면 프로젝트 역할도 새 신원으로 옮겨진다 — 판정도 새 신원으로(Codex 3A 리뷰 P2)
    from types import SimpleNamespace

    from app import deps
    from app.routers import publish
    from app.routers.publish import PublishBundleIn

    main, _side, gen = env
    gen("g1", main, creator="user_new")
    repo.set_project_roles(main, "user_new", ["supervisor"])  # 연결 뒤의 역할(옛 acct: 신원에는 없다)
    monkeypatch.setattr(deps, "AUTH_ENABLED", True)
    monkeypatch.setattr(publish.repo, "uid_owner_email", lambda uid: None)
    monkeypatch.setattr(publish.repo, "set_account_hf_creator", lambda email, uid: True)
    monkeypatch.setattr(publish.repo, "get_account", lambda email: {"email": email, "creator_uid": "user_new", "name": "나", "global_role": ""})
    request = SimpleNamespace(state=SimpleNamespace(account={"email": "a@test", "creator_uid": "acct:a@test", "name": "나", "global_role": ""}))
    bundle = {"generations": [{"generation": {"id": "g1", "creator_uid": "user_new", "status": "done", "project_id": None}}]}
    out = publish.receive_published_bundle(PublishBundleIn(bundle=bundle), request)
    assert out["blocked"] == 0
    assert project_of("g1") is None

def test_local_db_failure_after_server_move_reports_server_only_move(env, monkeypatch):
    # 서버가 옮긴 뒤 로컬 DB 가 실패해도(잠금 등) 500 이 아니라 '서버만 옮겨짐' 409(Codex 3A 재검토 P2)
    import sqlite3
    from types import SimpleNamespace

    from fastapi import HTTPException

    from app.models import AssignProjectIn
    from app.routers import projects

    main, _side, gen = env
    gen("g1", None, final=False)
    real = repo.assign_to_project

    def flaky(*args, **kwargs):
        if kwargs.get("check_only"):
            return real(*args, **kwargs)
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(projects, "MANAGE_ENABLED", False)
    monkeypatch.setattr(projects._proxy, "proxying", lambda: True)
    monkeypatch.setattr(projects._proxy, "proxy_json", lambda method, endpoint, **kw: {"projects": []} if method == "GET" else {"updated": 1})
    monkeypatch.setattr(projects.repo, "shared_generation_anchors", lambda ids: ["g1"])
    monkeypatch.setattr(projects.repo, "assign_to_project", flaky)
    with pytest.raises(HTTPException) as moved:
        projects.assign_project(AssignProjectIn(generation_ids=["g1"], project_id=main), SimpleNamespace(state=SimpleNamespace(account=None)))
    assert (moved.value.status_code, moved.value.detail) == (409, projects.SERVER_ONLY_MOVED)