"""read_context(kind='references') 정확히 찾기(docs/status/MVAgent_끌어다넣기_2026-11-12.md 2-4) — 끌어다 붙인 생성물 id·어셋 경로로
핸들을 바로 발급한다. 실제 생성·과금 없음(생성물은 가짜, 어셋은 임시 폴더)."""
import pytest
from fastapi import HTTPException

from app.repo import mcp_v2 as store
from app.routers import mcp_v2 as api
from app.services.asset_tree import AssetTreeSnapshot
from test_mcp_persistent import action, configure, local, prepare  # noqa: F401 - local 은 fixture

assert local


def _gen(gen_id, media=1, scope="personal", workspace_id=None, extra=None):
    assets = [{"id": f"{gen_id}-a{i}", "type": "image", "file_path": f"/media/{gen_id}-{i}.png", "source_url": f"/media/{gen_id}-{i}.png"}
              for i in range(media)]
    return {"id": gen_id, "creator_uid": "owner", "project_id": "p1", "prompt": f"prompt {gen_id}", "workspace_scope": scope,
            "workspace_id": workspace_id, "assets": assets + (extra or [])}


@pytest.fixture
def gens(local, monkeypatch):  # noqa: F811
    configure(local, ["codex", "claude"])
    rows = {}
    def get_generation(gen_id, request):
        row = rows.get(gen_id)
        if isinstance(row, BaseException):
            raise row
        if row is None:
            raise HTTPException(404, "generation 없음")
        return row
    monkeypatch.setattr(api.library, "get_generation", get_generation)
    return rows


def _credential(local, name="codex"):  # noqa: F811
    return store.client_for_secret(api.mcp.digest(local[1][name]["secret"]))


def test_generation_ids_issue_all_media_in_order_for_this_connection_only(local, gens):  # noqa: F811
    gens["g1"] = _gen("g1", media=2, extra=[{"id": "g1-txt", "type": "text", "file_path": "/media/g1.txt"}])
    response = action(local, "read_context", {"kind": "references", "generation_ids": ["g1"], "limit": 20, "search": None, "project_id": None})
    assert response.status_code == 200, response.text
    body = response.json()
    assert [(ref["source_gen_id"], ref["asset_index"], ref["type"]) for ref in body["references"]] == [("g1", 0, "image"), ("g1", 1, "image")]
    assert body["lookups"] == [{"generation_id": "g1", "status": "ok", "count": 2}]
    rid = body["references"][0]["id"]
    assert store.get_reference(_credential(local), rid) is not None
    assert store.get_reference(_credential(local, "claude"), rid) is None  # 다른 연결로는 못 씀
    plan = prepare(local, reference_ids=[rid])
    assert plan["id"]


def test_missing_and_other_workspace_are_both_not_found(local, gens):  # noqa: F811
    gens["mine"] = _gen("mine")
    gens["team"] = _gen("team", scope="team", workspace_id="team-a")
    body = action(local, "read_context", {"kind": "references", "generation_ids": ["gone", "team", "mine"]}).json()
    assert [ref["source_gen_id"] for ref in body["references"]] == ["mine"]
    assert body["lookups"] == [{"generation_id": "gone", "status": "not_found", "count": 0},
                               {"generation_id": "team", "status": "not_found", "count": 0},
                               {"generation_id": "mine", "status": "ok", "count": 1}]


def test_more_than_eight_media_returns_first_eight_with_more(local, gens):  # noqa: F811
    gens["big"] = _gen("big", media=9)
    body = action(local, "read_context", {"kind": "references", "generation_ids": ["big"]}).json()
    assert [ref["asset_index"] for ref in body["references"]] == list(range(8))
    assert body["lookups"] == [{"generation_id": "big", "status": "ok", "count": 8, "more": True}]


def test_server_failure_marks_only_that_line_unknown_and_auth_errors_fail_the_call(local, gens):  # noqa: F811
    gens["ok"] = _gen("ok")
    gens["slow"] = TimeoutError("shared server timed out")
    gens["down"] = HTTPException(502, "bad gateway")
    body = action(local, "read_context", {"kind": "references", "generation_ids": ["slow", "down", "ok"]}).json()
    assert [line["status"] for line in body["lookups"]] == ["unknown", "unknown", "ok"]
    gens["denied"] = HTTPException(403, "no access")
    assert action(local, "read_context", {"kind": "references", "generation_ids": ["ok", "denied"]}).status_code == 403


def test_identity_change_after_lookup_is_403_not_not_found(local, gens, monkeypatch):  # noqa: F811
    gens["g"] = _gen("g")
    changed = []
    real_still = api._still_current
    real_get = api.library.get_generation
    def get_generation(gen_id, request):
        changed.append(gen_id)
        return real_get(gen_id, request)
    def still_current(ctx):
        if changed:
            raise HTTPException(403, "활성 계정 또는 허브가 바뀌었습니다.")
        return real_still(ctx)
    monkeypatch.setattr(api.library, "get_generation", get_generation)
    monkeypatch.setattr(api, "_still_current", still_current)
    response = action(local, "read_context", {"kind": "references", "generation_ids": ["g"]})
    assert response.status_code == 403
    assert store.get_reference(_credential(local), "anything") is None


@pytest.mark.parametrize("args", [
    {"kind": "generations", "generation_ids": ["g"]},
    {"kind": "references", "generation_ids": ["g"], "asset_paths": ["a.png"], "asset_project": "x"},
    {"kind": "references", "generation_ids": ["g"], "search": "x"},
    {"kind": "references", "generation_ids": ["g"], "project_id": "p1"},
    {"kind": "references", "generation_ids": ["g"], "folder_path": "e001"},
    {"kind": "references", "generation_ids": ["g"], "media_type": "image"},
    {"kind": "references", "generation_ids": ["g"], "asset_project": "x"},
    {"kind": "references", "generation_ids": ["g", "g"]},
    {"kind": "references", "generation_ids": [f"g{i}" for i in range(9)]},
    {"kind": "references", "generation_ids": []},
    {"kind": "references", "generation_ids": ["bad id"]},
    {"kind": "references", "asset_paths": ["a.png"]},
    {"kind": "references", "asset_paths": ["a.png"], "asset_project": "x", "search": "a"},
    {"kind": "references", "asset_paths": ["a.png"], "asset_project": "x", "offset": 0},
    {"kind": "references", "asset_paths": ["a\nb.png"], "asset_project": "x"},
    {"kind": "references", "asset_paths": ["x" * 1001], "asset_project": "x"},
])
def test_exact_mode_validation(local, gens, args):  # noqa: F811
    assert action(local, "read_context", args).status_code == 422


@pytest.fixture
def asset_folder(local, tmp_path, monkeypatch):  # noqa: F811
    configure(local)
    folder = tmp_path / "authorized-assets"
    (folder / "sub").mkdir(parents=True)
    (folder / "a.png").write_bytes(b"a")
    (folder / "sub" / "b.png").write_bytes(b"b")
    (folder / "notes.txt").write_text("not media")
    monkeypatch.setattr(api.assets, "_owner_mounts", lambda owner: [{"name": "my-assets"}])
    monkeypatch.setattr(api.assets, "_mount_dir", lambda name, owner: folder if name == "my-assets" else None)
    monkeypatch.setattr(api.assets, "_auto_project_mounts", lambda *args: [])
    monkeypatch.setattr(api.assets.asset_watcher, "watch", lambda *args, **kwargs: None)
    return folder


def test_asset_paths_issue_handles_and_complete_scan_says_not_found(local, asset_folder):  # noqa: F811
    response = action(local, "read_context", {"kind": "references", "asset_project": "my-assets",
                                              "asset_paths": ["sub/b.png", "missing.png", "notes.txt", "a.png"]})
    assert response.status_code == 200, response.text
    body = response.json()
    assert [(ref["path"], ref["project"]) for ref in body["references"]] == [("sub/b.png", "my-assets"), ("a.png", "my-assets")]
    assert [(line["path"], line["status"]) for line in body["lookups"]] == [
        ("sub/b.png", "ok"), ("missing.png", "not_found"), ("notes.txt", "not_found"), ("a.png", "ok")]
    # 판이 바뀌면 계획 실행이 409 — 같은 정확히 찾기로 새 핸들을 다시 받는다
    rid = body["references"][1]["id"]
    plan = prepare(local, reference_ids=[rid])
    (asset_folder / "a.png").write_bytes(b"changed-version")
    assert action(local, "execute_generation_plan", {"plan_id": plan["id"]}).status_code == 409
    again = action(local, "read_context", {"kind": "references", "asset_project": "my-assets", "asset_paths": ["a.png"]}).json()
    assert again["references"][0]["id"] != rid
    assert prepare(local, reference_ids=[again["references"][0]["id"]])["id"]


def test_incomplete_scan_says_unknown(local, asset_folder, monkeypatch):  # noqa: F811
    real = api._asset_tree_snapshot
    def partial(ctx, ws, project):
        directory, snapshot = real(ctx, ws, project)
        children = [*snapshot.children, {"type": "image", "path": "noversion.png", "name": "noversion.png"},
                    {"type": "text", "path": "doc.txt", "name": "doc.txt", "version": "1-1"}]
        return directory, AssetTreeSnapshot(children=children, scanned=True, truncated=True)
    monkeypatch.setattr(api, "_asset_tree_snapshot", partial)
    body = action(local, "read_context", {"kind": "references", "asset_project": "my-assets",
                                          "asset_paths": ["a.png", "missing.png", "noversion.png", "doc.txt"]}).json()
    assert [(line["path"], line["status"]) for line in body["lookups"]] == [  # 다 못 읽었으면 없음·판 없음은 unknown, 미디어가 아닌 파일만 확실히 없음
        ("a.png", "ok"), ("missing.png", "unknown"), ("noversion.png", "unknown"), ("doc.txt", "not_found")]


def test_permission_rechecked_before_issuing(local, asset_folder, monkeypatch):  # noqa: F811
    real = api._authorize_asset_project
    calls = []
    def authorize(ctx, ws, project):
        calls.append(project)
        if len(calls) > 1:  # 스냅샷을 읽은 뒤 발급 전 — 그 사이 권한이 빠짐
            raise HTTPException(404, "허용된 에셋 폴더가 아닙니다.")
        return real(ctx, ws, project)
    monkeypatch.setattr(api, "_authorize_asset_project", authorize)
    response = action(local, "read_context", {"kind": "references", "asset_project": "my-assets", "asset_paths": ["a.png"]})
    assert response.status_code == 404
    assert len(calls) == 2


def test_existing_reference_search_has_no_lookups(local, asset_folder):  # noqa: F811
    body = action(local, "read_context", {"kind": "references", "asset_project": "my-assets", "limit": 20}).json()
    assert "lookups" not in body and len(body["references"]) == 2
