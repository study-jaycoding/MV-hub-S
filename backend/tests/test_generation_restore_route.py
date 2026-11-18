"""휴지통 복구 라우트 — repo.restore_generation 이 같은 이름 잎 모듈(repo/restore_generation.py)에
가려져 TypeError(500)로 실패하던 회귀(2026-11-18, 휴지통복구_500_2026-11-18.md)."""
from app import repo
from app.repo import generations
from app.routers import generation
from test_account_cleanup_auth import GHOST, bearer, client, server, signup_approved, token_for  # noqa: F401


def test_facade_restore_generation_is_the_function_after_app_import():
    import app.main  # noqa: F401 — 앱 전체 import 순서 뒤에도 facade 가 함수여야 한다
    assert repo.restore_generation is generations.restore_generation


def test_owner_restores_trashed_generation(server, monkeypatch):
    monkeypatch.setattr(generation, "AUTH_ENABLED", True)
    signup_approved()
    gid = repo.create_local_generation({"model": "m", "prompt": "restore"}, "me", creator_uid=f"acct:{GHOST}")
    repo.set_status(gid, "done")
    headers = bearer(token_for(GHOST))
    assert client().delete(f"/api/generations/{gid}", headers=headers).json() == {"deleted": True}
    assert [row["id"] for row in repo.list_trash()] == [gid]

    response = client().post(f"/api/generations/{gid}/restore", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json() == {"restored": True}
    assert repo.get_generation(gid)
    assert repo.list_trash() == []


def test_other_account_cannot_restore_someone_elses_trash(server, monkeypatch):
    monkeypatch.setattr(generation, "AUTH_ENABLED", True)
    signup_approved()
    other = "other@x.test"
    signup_approved(other)
    gid = repo.create_local_generation({"model": "m", "prompt": "mine"}, "me", creator_uid=f"acct:{GHOST}")
    repo.set_status(gid, "done")
    assert client().delete(f"/api/generations/{gid}", headers=bearer(token_for(GHOST))).json() == {"deleted": True}

    response = client().post(f"/api/generations/{gid}/restore", headers=bearer(token_for(other)))
    assert response.status_code == 403, response.text
    assert [row["id"] for row in repo.list_trash()] == [gid]  # 남의 복구 시도는 휴지통을 바꾸지 않는다
