"""폴더 카드(공유 & 리뷰 탭) — 하위 폴더별 건수·표지, 팀 공용 대표, 가시성, 프록시 위임."""

from __future__ import annotations

import sqlite3

import pytest
from fastapi import HTTPException, Request

from app import db, db_migrations, deps, repo
from app.repo import folder_cover as folder_cover_repo
from app.routers import folder_cards as cards_router


@pytest.fixture
def catalog(monkeypatch, tmp_path):
    monkeypatch.setenv("CONTENT_HUB_DATA", str(tmp_path))
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content.db"))
    monkeypatch.setenv("CONTENT_HUB_NO_PROXY", "1")
    monkeypatch.setattr(db, "_POOL_ENABLED", False)
    monkeypatch.setattr(deps, "AUTH_ENABLED", True)
    monkeypatch.setattr(cards_router, "AUTH_ENABLED", True)
    monkeypatch.setattr(cards_router._proxy, "proxying", lambda: False)
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    with db.get_connection() as conn:
        for pid in ("member", "other"):
            conn.execute("INSERT INTO project(id, name) VALUES(?, ?)", (pid, pid))
        conn.execute(
            "INSERT INTO project_member(project_id, creator_uid, project_role) "
            "VALUES('member', 'viewer', 'creator')"
        )
    yield
    db.flush_pool()


_clock = iter(range(1, 10_000))


def seed(gen_id, folder, *, project="member", creator="other-user", shared=True,
         deleted=False, workspace=None, ts=None):
    """ts 를 안 주면 넣은 순서가 곧 최신 순서다."""
    with db.get_connection() as conn:
        conn.execute(
            "INSERT INTO generation(id, worker_id, prompt, status, creator_uid, project_id, "
            "folder_path, deleted_at, workspace_scope, workspace_id, sort_ts) "
            "VALUES(?, 'me', 'folder card fixture', 'done', ?, ?, ?, ?, ?, ?, ?)",
            (gen_id, creator, project, folder, "2026-01-01" if deleted else None,
             "team" if workspace else "unknown", workspace, ts if ts is not None else next(_clock)),
        )
        if shared:
            conn.execute(
                "INSERT INTO share(id, generation_id, shared_by, visibility) VALUES(?, ?, 'me', 'team')",
                ("share-" + gen_id, gen_id),
            )


def cards(parent="e035", *, projects=("member",), viewer="viewer", project="member", workspace=None):
    data = repo.folder_cards(
        project, parent, team_member_projects=None if projects is None else list(projects),
        viewer_uid=viewer, workspace_id=workspace,
    )
    return data, {f["path"]: f for f in data["folders"]}


def choose(folder, gen_id, *, projects=("member",), viewer="viewer", project="member"):
    return repo.set_folder_cover(
        project, folder, gen_id, team_member_projects=None if projects is None else list(projects),
        viewer_uid=viewer, set_by=viewer,
    )


def request(*, uid="viewer", role="", method="GET", path="/api/projects/member/folder-cards", query=""):
    req = Request({
        "type": "http", "method": method, "path": path,
        "headers": [], "query_string": query.encode(), "client": ("127.0.0.1", 51000),
    })
    req.state.account = {"email": "viewer@example.test", "creator_uid": uid, "global_role": role}
    return req


def test_groups_by_the_folder_right_below_and_counts_everything_under_it(catalog):
    seed("a1", "e035/C0010")
    seed("a2", "e035/C0010/takeB")          # 하위의 하위도 그 컷에 든다
    seed("b1", "e035/C0040")
    seed("own", "e035")                      # 고른 폴더에 직접 든 것 — 어느 카드에도 안 든다
    seed("near", "e0350/C0010")              # 이름이 앞부분만 같은 다른 폴더
    seed("elsewhere", "e001/C0010")
    seed("private", "e035/C0040", shared=False)
    seed("gone", "e035/C0040", deleted=True)
    seed("foreign", "e035/C0040", project="other")

    data, by_path = cards()

    assert data["parent"] == "e035" and data["own_count"] == 1
    assert [f["path"] for f in data["folders"]] == ["e035/C0010", "e035/C0040"]
    assert [f["name"] for f in data["folders"]] == ["C0010", "C0040"]
    assert by_path["e035/C0010"]["count"] == 2 and by_path["e035/C0040"]["count"] == 1
    # 바로 아래 폴더 수 — takeB 하나. 없으면 0(잎 = 폴더 창을 여는 카드)
    assert by_path["e035/C0010"]["subfolders"] == 1 and by_path["e035/C0040"]["subfolders"] == 0
    # 표지는 가장 최근 것이고, 목록 행에서 화면이 쓰는 칸만 싣는다(프롬프트·레퍼런스·태그 … 는 없다 — 15초마다 받는 응답의 크기)
    assert by_path["e035/C0010"]["cover"]["id"] == "a2" and by_path["e035/C0010"]["rep"] is False
    assert by_path["e035/C0010"]["cover"]["folder_path"] == "e035/C0010/takeB"
    assert set(by_path["e035/C0010"]["cover"]) == {
        "id", "project_id", "project_name", "folder_path", "model", "params", "creator_name", "is_mine",
        "created_at", "is_final", "is_held", "assets",
    }
    assert by_path["e035/C0010"]["cover"]["project_name"] == "member"


def test_an_empty_parent_lists_the_top_folders_and_names_that_only_share_a_prefix_stay_apart(catalog):
    seed("a", "e001/c0010")
    seed("b", "e035/C001")
    seed("c", "e035/C0010")
    seed("d", "e035/C0010/takeA")            # 손자 폴더 — 에피소드 카드의 '바로 아래' 수에는 안 든다
    seed("root", None)                       # 폴더 없이 프로젝트에 직접 든 것 — 맨 위에서는 '폴더 밖'으로 센다
    seed("root2", "")

    top, top_by = cards("")
    assert [f["path"] for f in top["folders"]] == ["e001", "e035"] and top["own_count"] == 2
    assert top_by["e035"]["count"] == 3
    # 에피소드 카드의 바로 아래 폴더 수 = 컷 수(C001·C0010 둘 — C0010/takeA 는 C0010 의 것이라 따로 세지 않는다)
    assert top_by["e035"]["subfolders"] == 2 and top_by["e001"]["subfolders"] == 1
    # 폴더를 고르면 폴더 없는 것은 그 범위 밖이다
    assert cards("e035")[0]["own_count"] == 0

    _, cuts = cards("e035")
    assert {path: (f["count"], f["subfolders"]) for path, f in cuts.items()} == {"e035/C001": (1, 0), "e035/C0010": (2, 1)}
    assert cards("e035/C001")[0] == {"parent": "e035/C001", "own_count": 1, "folders": []}


def test_like_wildcards_in_a_folder_name_are_taken_literally(catalog):
    seed("real", "a_b/shot")
    seed("decoy", "aXb/shot")
    seed("pct", "100%/shot")
    seed("pct_decoy", "100x/shot")

    def summary(parent):
        return [(f["path"], f["count"], f["cover"]["id"]) for f in cards(parent)[0]["folders"]]

    assert summary("a_b") == [("a_b/shot", 1, "real")]
    assert summary("100%") == [("100%/shot", 1, "pct")]
    # 대표를 정할 때도 같다 — 글자 하나가 다른 폴더의 것은 받지 않는다
    with pytest.raises(LookupError):
        choose("a_b", "decoy")
    with pytest.raises(LookupError):
        choose("100%", "pct_decoy")
    assert choose("a_b", "real")


def test_a_folder_that_differs_only_in_letter_case_is_a_different_folder(catalog):
    seed("lower", "e035/C0010")
    seed("upper", "E035/C0010")          # SQL 의 LIKE 는 영문 대소문자를 가리지 않는다
    seed("upper-own", "E035")

    data, by_path = cards("e035")
    assert data["own_count"] == 0
    assert {path: (f["count"], f["cover"]["id"]) for path, f in by_path.items()} == {"e035/C0010": (1, "lower")}
    # 대표를 정할 때도 같다 — 글자만 같은 폴더의 것으로는 못 정한다(받으면 조회가 무시해 '대표 미정'으로 돌아간다)
    with pytest.raises(LookupError):
        choose("e035/C0010", "upper")
    with pytest.raises(LookupError):
        choose("e035", "upper-own")
    assert choose("e035/C0010", "lower")


def test_a_chosen_cover_replaces_the_latest_one_and_stops_counting_once_it_no_longer_belongs(catalog):
    seed("old", "e035/C0040")
    seed("new", "e035/C0040")
    assert cards()[1]["e035/C0040"]["cover"]["id"] == "new"

    assert choose("e035/C0040", "old") == {"folder_path": "e035/C0040", "generation_id": "old"}
    chosen = cards()[1]["e035/C0040"]
    assert chosen["cover"]["id"] == "old" and chosen["rep"] is True and chosen["count"] == 2

    def expect_latest():
        fallback = cards()[1]["e035/C0040"]
        assert fallback["cover"]["id"] == "new" and fallback["rep"] is False

    def run(sql, *args):
        with db.get_connection() as conn:
            conn.execute(sql, args)

    # 지워짐 → 최신으로, 되살리면 대표가 돌아온다(행을 지우지 않았다)
    run("UPDATE generation SET deleted_at = '2026-01-01' WHERE id = 'old'")
    expect_latest()
    run("UPDATE generation SET deleted_at = NULL WHERE id = 'old'")
    assert cards()[1]["e035/C0040"]["rep"] is True
    # 공유 해제
    run("DELETE FROM share WHERE generation_id = 'old'")
    expect_latest()
    run("INSERT INTO share(id, generation_id, shared_by, visibility) VALUES('again', 'old', 'me', 'team')")
    # 다른 폴더로 이동 — 옮겨 간 폴더의 대표가 되지도 않는다
    run("UPDATE generation SET folder_path = 'e035/C0050' WHERE id = 'old'")
    expect_latest()
    assert cards()[1]["e035/C0050"]["rep"] is False
    run("UPDATE generation SET folder_path = 'e035/C0040' WHERE id = 'old'")
    # 다른 프로젝트로 이동
    run("UPDATE generation SET project_id = 'other' WHERE id = 'old'")
    expect_latest()


def test_choosing_again_overwrites_and_a_cover_under_a_subfolder_is_allowed(catalog):
    seed("a", "e035/C0040")
    seed("deep", "e035/C0040/takeB")
    choose("e035/C0040", "a")
    choose("e035/C0040", "deep")
    assert cards()[1]["e035/C0040"]["cover"]["id"] == "deep"
    with db.get_connection() as conn:
        rows = conn.execute("SELECT generation_id, set_by FROM folder_cover").fetchall()
    assert [(r["generation_id"], r["set_by"]) for r in rows] == [("deep", "viewer")]


@pytest.mark.parametrize("gen_id, folder", [
    ("foreign", "e035/C0040"),      # 다른 프로젝트의 것
    ("private", "e035/C0040"),      # 공유 안 된 것
    ("gone", "e035/C0040"),         # 지운 것
    ("sibling", "e035/C0040"),      # 옆 폴더의 것
    ("near", "e035/C004"),          # 이름 앞부분만 같은 폴더
    ("missing", "e035/C0040"),      # 없는 것
    ("ok", ""),                     # 폴더 없음
])
def test_a_cover_must_be_a_visible_shared_item_inside_that_folder(catalog, gen_id, folder):
    seed("ok", "e035/C0040")
    seed("foreign", "e035/C0040", project="other")
    seed("private", "e035/C0040", shared=False)
    seed("gone", "e035/C0040", deleted=True)
    seed("sibling", "e035/C0050")
    seed("near", "e035/C0040")
    with pytest.raises(LookupError):
        choose(folder, gen_id)
    with db.get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) AS c FROM folder_cover").fetchone()["c"] == 0


def test_visibility_matches_the_team_list_for_members_outsiders_and_read_all(catalog):
    seed("member-item", "e035/C0010")                      # 내가 멤버인 프로젝트의 남의 것
    seed("mine-elsewhere", "e035/C0010", project="other", creator="viewer")
    seed("theirs-elsewhere", "e035/C0020", project="other")

    def listed(project, **scope):
        rows = repo.list_generations(tab="team", project_id=project, folder_path="e035", **scope)
        return sorted(row["id"] for row in rows)

    member = dict(team_member_projects=["member"], account_uid="viewer")
    assert listed("member", **member) == ["member-item"]
    assert {p: f["count"] for p, f in cards()[1].items()} == {"e035/C0010": 1}
    # 멤버가 아닌 프로젝트 — 내가 만든 것만
    assert listed("other", **member) == ["mine-elsewhere"]
    assert {p: f["count"] for p, f in cards(project="other")[1].items()} == {"e035/C0010": 1}
    with pytest.raises(LookupError):
        choose("e035/C0020", "theirs-elsewhere", project="other")
    # 멤버 프로젝트도 uid 도 없는 계정 — 아무것도 안 보인다
    assert cards(projects=(), viewer="\x00")[0]["folders"] == []
    # 전체를 보는 계정
    everything = cards(project="other", projects=None)[1]
    assert {p: f["count"] for p, f in everything.items()} == {"e035/C0010": 1, "e035/C0020": 1}
    assert choose("e035/C0020", "theirs-elsewhere", project="other", projects=None)


def test_a_cover_only_some_people_can_see_is_neither_shown_nor_deleted_for_the_rest(catalog):
    seed("hidden-from-outsider", "e035/C0010", project="other")
    seed("outsiders-own", "e035/C0010", project="other", creator="viewer")
    choose("e035/C0010", "hidden-from-outsider", project="other", projects=None)

    outsider = cards(project="other")[1]["e035/C0010"]
    assert outsider["cover"]["id"] == "outsiders-own" and outsider["rep"] is False and outsider["count"] == 1
    admin = cards(project="other", projects=None)[1]["e035/C0010"]
    assert admin["cover"]["id"] == "hidden-from-outsider" and admin["rep"] is True


def test_the_workspace_filter_narrows_counts_and_covers_like_the_list(catalog):
    seed("in-ws", "e035/C0010", workspace="ws-1")
    seed("other-ws", "e035/C0010", workspace="ws-2")
    seed("only-other", "e035/C0020", workspace="ws-2")

    _, filtered = cards(workspace="ws-1")
    assert {p: (f["count"], f["cover"]["id"]) for p, f in filtered.items()} == {"e035/C0010": (1, "in-ws")}
    # 공간 밖의 대표는 그 공간 보기에서 대표로 세지 않는다
    choose("e035/C0010", "other-ws")
    assert cards(workspace="ws-1")[1]["e035/C0010"]["rep"] is False
    assert cards()[1]["e035/C0010"]["cover"]["id"] == "other-ws"


def test_covers_of_an_archived_project_are_still_returned(catalog):
    seed("a", "e035/C0010")
    with db.get_connection() as conn:
        conn.execute("UPDATE project SET archived = 1 WHERE id = 'member'")
    assert cards()[1]["e035/C0010"]["cover"]["id"] == "a"


def test_more_folders_than_one_cover_batch(catalog, monkeypatch):
    monkeypatch.setattr(repo.folder_cover, "_COVER_CHUNK", 2)
    for index in range(5):
        seed(f"g{index}", f"e035/C{index:04d}")
    data, _ = cards()
    assert [f["cover"]["id"] for f in data["folders"]] == ["g0", "g1", "g2", "g3", "g4"]


def test_the_route_scopes_like_the_team_list_and_keeps_the_viewer_even_for_read_all(catalog, monkeypatch):
    seed("a", "e035/C0010")
    seen = []
    real = repo.folder_cards

    def spy(pid, parent, **scope):
        seen.append((pid, parent, scope))
        return real(pid, parent, **scope)

    monkeypatch.setattr(repo, "folder_cards", spy)

    member = cards_router.project_folder_cards("member", request(query="parent=e035"), parent="e035")
    assert [f["path"] for f in member["folders"]] == ["e035/C0010"]
    assert seen[-1] == ("member", "e035", {
        "team_member_projects": ["member"], "viewer_uid": "viewer", "workspace_id": None,
    })
    # 전체를 보는 계정도 '보는 계정' 은 그대로 넘어간다 — 남의 개인 메타를 가리는 기준이다
    cards_router.project_folder_cards("member", request(uid="boss", role="admin"), parent="e035", workspace_id=" ws ")
    assert seen[-1][2] == {"team_member_projects": None, "viewer_uid": "boss", "workspace_id": "ws"}
    # 멤버가 아닌 계정에게는 폴더 이름도 건수도 나가지 않는다
    stranger = cards_router.project_folder_cards("member", request(uid="stranger"), parent="e035")
    assert stranger == {"parent": "e035", "own_count": 0, "folders": []}


def test_the_put_route_saves_for_the_actor_and_answers_404_without_saying_why(catalog):
    seed("a", "e035/C0010")
    seed("private", "e035/C0010", shared=False)
    put = request(method="PUT", path="/api/projects/member/folder-cover")

    saved = cards_router.set_project_folder_cover(
        "member", cards_router.FolderCoverIn(folder_path="e035\\C0010/", generation_id="a"), put,
    )
    assert saved == {"folder_path": "e035/C0010", "generation_id": "a"}
    with db.get_connection() as conn:
        assert conn.execute("SELECT set_by FROM folder_cover").fetchone()["set_by"] == "viewer"

    for gen_id, uid in (("private", "viewer"), ("a", "stranger")):
        with pytest.raises(HTTPException) as refused:
            cards_router.set_project_folder_cover(
                "member", cards_router.FolderCoverIn(folder_path="e035/C0010", generation_id=gen_id),
                request(method="PUT", path="/api/projects/member/folder-cover", uid=uid),
            )
        assert refused.value.status_code == 404
    assert cards()[1]["e035/C0010"]["cover"]["id"] == "a"


def test_a_local_hub_hands_both_routes_to_the_shared_server_untouched(catalog, monkeypatch):
    seed("local-only", "e035/C0010")
    calls = []
    monkeypatch.setattr(cards_router._proxy, "proxying", lambda: True)
    monkeypatch.setattr(
        cards_router._proxy, "proxy_get",
        lambda path, req: calls.append(("GET", path, req.url.query)) or {"parent": "e035", "own_count": 0, "folders": []},
    )
    monkeypatch.setattr(
        cards_router._proxy, "proxy_json",
        lambda method, path, **kw: calls.append((method, path, kw)) or {"folder_path": "e035/C0010", "generation_id": "srv"},
    )

    got = cards_router.project_folder_cards("member", request(query="parent=e035&workspace_id=ws"), parent="e035")
    put = cards_router.set_project_folder_cover(
        "member", cards_router.FolderCoverIn(folder_path="e035/C0010", generation_id="srv"),
        request(method="PUT", path="/api/projects/member/folder-cover"),
    )

    assert got["folders"] == [] and put["generation_id"] == "srv"
    assert calls == [
        ("GET", "/api/projects/member/folder-cards", "parent=e035&workspace_id=ws"),
        ("PUT", "/api/projects/member/folder-cover", {"body": {"folder_path": "e035/C0010", "generation_id": "srv"}}),
    ]
    with db.get_connection() as conn:  # 로컬 DB 에는 쓰지 않는다
        assert conn.execute("SELECT COUNT(*) AS c FROM folder_cover").fetchone()["c"] == 0


def test_an_old_shared_server_answers_route_missing_and_the_hub_passes_it_on(catalog, monkeypatch):
    def old_server(path, req):
        raise HTTPException(status_code=404, detail="Not Found")

    monkeypatch.setattr(cards_router._proxy, "proxying", lambda: True)
    monkeypatch.setattr(cards_router._proxy, "proxy_get", old_server)
    with pytest.raises(HTTPException) as missing:
        cards_router.project_folder_cards("member", request(), parent="e035")
    assert (missing.value.status_code, missing.value.detail) == (404, "Not Found")


def test_an_existing_database_gets_the_table_and_applying_twice_is_harmless(tmp_path):
    conn = sqlite3.connect(tmp_path / "old.db")
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(db.SCHEMA_PATH.read_text(encoding="utf-8"))
        conn.execute("DROP TABLE folder_cover")
        db_migrations._migrate(conn)
        db_migrations._migrate(conn)
        columns = [row["name"] for row in conn.execute("PRAGMA table_info(folder_cover)")]
    finally:
        conn.close()
    assert columns == ["project_id", "folder_path", "generation_id", "set_by", "set_at"]


def test_episode_cards_carry_the_numbers_and_cut_strip_of_the_episode_screen(catalog):
    """에피소드 화면용 집계 — 건수와 같은 범위에서 센다: 영상 수 · 대표 정한 컷 수 · 마지막 공유(표지의 것이 아니다) · 컷 미리보기."""
    def asset(gen_id, kind):
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO asset(id, generation_id, type, file_path) VALUES(?, ?, ?, ?)",
                ("asset-" + gen_id, gen_id, kind, f"/media/{gen_id}.bin"),
            )

    seed("img", "e020/c0010")
    asset("img", "image")
    seed("vid", "e020/c0010")
    asset("vid", "video")
    seed("take", "e020/c0020/takeB", creator="river")   # 손자 폴더의 것도 그 컷(c0020)에 든다
    asset("take", "video")
    for index in range(3, 10):                           # 컷 아홉 — 미리보기는 이름순 앞 일곱만
        seed(f"cut{index}", f"e020/c00{index}0")
    seed("private", "e020/c0010", shared=False)          # 안 보이는 것은 어느 숫자에도 안 든다
    asset("private", "video")
    seed("elsewhere", "e001/c0010")
    choose("e020/c0010", "img")                          # 컷의 대표
    choose("e020", "img")                                # 에피소드 표지를 옛 것으로 고정 — 마지막 공유는 표지와 따로다
    repo.identity.set_creator_name("river", "리버")
    with db.get_connection() as conn:
        conn.execute("UPDATE share SET shared_at = '2026-10-01 00:00:00'")
        conn.execute("UPDATE share SET shared_at = '2026-10-13 09:00:00' WHERE generation_id = 'take'")

    episode = cards("")[1]["e020"]
    assert (episode["count"], episode["subfolders"], episode["video_count"], episode["rep_count"]) == (10, 9, 2, 1)
    assert episode["cover"]["id"] == "img" and episode["rep"] is True
    assert (episode["last_shared_at"], episode["last_shared_by"]) == ("2026-10-13 09:00:00", "리버")
    strip = episode["children"]
    assert [child["name"] for child in strip] == ["c0010", "c0020", "c0030", "c0040", "c0050", "c0060", "c0070"]
    assert (strip[0]["path"], strip[0]["count"], strip[0]["rep"], strip[0]["cover"]["id"]) == ("e020/c0010", 2, True, "img")
    assert (strip[1]["count"], strip[1]["rep"], strip[1]["cover"]["id"]) == (1, False, "take")
    # 미리보기의 표지는 그림에 필요한 것만 — 목록 행 전체(프롬프트 등)를 컷마다 싣지 않는다
    assert set(strip[1]["cover"]) == {"id", "assets"} and [a["type"] for a in strip[1]["cover"]["assets"]] == ["video"]
    assert cards("")[1]["e001"]["last_shared_by"] is None  # 이름을 모르는 사람은 비운다(uid 를 내보내지 않는다)

    # 컷 단계의 카드에도 같은 칸이 온다 — 하위 폴더가 없으면 0 · 빈 띠
    cut = cards("e020")[1]["e020/c0010"]
    assert (cut["count"], cut["subfolders"], cut["video_count"], cut["rep_count"], cut["children"]) == (2, 0, 1, 0, [])
    nested = cards("e020")[1]["e020/c0020"]
    assert (nested["subfolders"], [child["path"] for child in nested["children"]]) == (1, ["e020/c0020/takeB"])


def test_cut_cards_carry_recent_takes_and_workers_for_the_list_view(catalog, monkeypatch):
    """컷 화면의 리스트용 — 하위 폴더가 없는 카드는 생성물 미리보기(대표 먼저, 그 뒤 최신 순)를, 모든 카드는 작업자별 건수를 싣는다."""
    def asset(gen_id, kind="video"):
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO asset(id, generation_id, type, file_path) VALUES(?, ?, ?, ?)",
                ("asset-" + gen_id, gen_id, kind, f"/media/{gen_id}.bin"),
            )

    for index in range(12):                                   # 한 컷에 열둘 — 미리보기는 열 개까지
        seed(f"t{index:02d}", "e035/c0010", creator="river" if index % 3 else "ozzy")
        asset(f"t{index:02d}")
    seed("private", "e035/c0010", shared=False)               # 안 보이는 것은 미리보기에도 작업자 수에도 안 든다
    seed("sub", "e035/c0020/takeB", creator="river")          # 하위 폴더가 있는 카드(c0020)는 생성물 미리보기를 싣지 않는다
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET is_final = 1 WHERE id IN ('t11', 't05')")
        conn.execute("UPDATE generation SET is_held = 1 WHERE id IN ('t10', 't05')")  # t05 = 둘 다 켜진 옛 행 → 최종
    repo.identity.set_creator_name("river", "리버")           # ozzy 는 이름을 모른다
    choose("e035/c0010", "t01")                               # 대표 — 최근 열 개 밖이어도 맨 앞에 선다

    cut = cards("e035")[1]["e035/c0010"]
    takes = cut["takes"]
    assert [take["cover"]["id"] for take in takes] == ["t01", "t11", "t10", "t09", "t08", "t07", "t06", "t05", "t04", "t03"]
    assert cut["cover"]["id"] == "t01" and cut["rep"] is True and cut["count"] == 12
    assert [(take["final"], take["held"]) for take in takes[1:3]] == [(True, False), (False, True)]
    assert (takes[7]["final"], takes[7]["held"]) == (True, False)  # 둘 다 켜진 행은 최종으로만
    assert set(takes[0]) == {"cover", "final", "held", "by"} and set(takes[0]["cover"]) == {"id", "assets"}
    assert [a["type"] for a in takes[0]["cover"]["assets"]] == ["video"]
    assert (takes[0]["by"], takes[2]["by"], takes[3]["by"]) == ("리버", "리버", None)  # t01·t10 = river, t09 = ozzy(이름 모름)
    # 카드의 표지 — 정보 줄이 읽는 값은 목록 행 그대로, params 는 길이만 남긴다(프롬프트·그 밖의 params 는 싣지 않는다)
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE generation SET model = 'seedance-2.0', is_final = 1, params = ? WHERE id = 't01'",
            ('{"duration": "6", "aspect_ratio": "16:9", "big": "' + "x" * 5000 + '"}',),
        )
    cover = cards("e035")[1]["e035/c0010"]["cover"]
    listed = repo.list_generations(tab="team", team_member_projects=["member"], account_uid="viewer", project_id="member", generation_ids=["t01"])[0]
    assert cover["params"] == {"duration": "6"} and "prompt" not in cover
    assert {key: cover[key] for key in ("model", "creator_name", "is_mine", "created_at", "is_final", "is_held", "project_name")} == {
        key: listed[key] for key in ("model", "creator_name", "is_mine", "created_at", "is_final", "is_held", "project_name")
    }
    assert (cover["model"], cover["creator_name"], cover["is_final"]) == ("seedance-2.0", "리버", True)
    assert cover["assets"] == listed["assets"][:1] and takes[0]["cover"]["assets"] == listed["assets"][:1]  # 미리보기의 그림도 목록 행의 것과 같다
    # 목록 행으로 읽는 것은 카드의 표지뿐이다 — 미리보기(생성물 띠 열 장)까지 목록 행으로 읽으면 읽는 시간의 대부분이 거기서 나간다
    asked = []
    real = folder_cover_repo.list_generations
    monkeypatch.setattr(folder_cover_repo, "list_generations", lambda **kw: asked.append(sorted(kw["generation_ids"])) or real(**kw))
    cards("e035")
    monkeypatch.setattr(folder_cover_repo, "list_generations", real)
    assert asked == [["sub", "t01"]]
    # 작업자별 건수 — 많은 순, 이름을 모르면 이름 없이(uid 를 내보내지 않는다)
    assert cut["workers"] == [{"name": "리버", "count": 8}, {"name": None, "count": 4}]

    nested = cards("e035")[1]["e035/c0020"]
    assert (nested["subfolders"], nested["takes"], nested["workers"]) == (1, [], [{"name": "리버", "count": 1}])
    episode = cards("")[1]["e035"]                            # 묶음(에피소드) — 컷 띠를 싣고 생성물 미리보기는 없다
    assert (episode["takes"], episode["workers"]) == ([], [{"name": "리버", "count": 9}, {"name": None, "count": 4}])
    # 작업자는 많은 순 네 명까지
    for index, who in enumerate(("a", "b", "b", "c", "d", "e")):
        seed(f"w{index}", "e040/c0010", creator=who)
    crowd = cards("e040")[1]["e040/c0010"]["workers"]
    assert (len(crowd), crowd[0]["count"], sum(one["count"] for one in crowd)) == (4, 2, 5)
    # 대표가 없으면 최신 순 그대로
    with db.get_connection() as conn:
        conn.execute("DELETE FROM folder_cover")
    assert [take["cover"]["id"] for take in cards("e035")[1]["e035/c0010"]["takes"]][:3] == ["t11", "t10", "t09"]


def test_cards_count_final_and_held_like_the_sidebar_numbers(catalog):
    """모아보기 카드의 검토 줄 — 그 폴더(하위 포함)의 최종·보류 수. 사이드바 숫자와 같은 규칙: 최종이 먼저다."""
    for gen_id, folder in (("plain", "e035/c0010"), ("fin", "e035/c0010"), ("both", "e035/c0010"),
                           ("held", "e035/c0010/takeB"), ("next", "e035/c0020")):
        seed(gen_id, folder)
    seed("hidden", "e035/c0010", shared=False)           # 안 보이는 것은 세지 않는다
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET is_final = 1 WHERE id IN ('fin', 'both', 'hidden')")
        conn.execute("UPDATE generation SET is_held = 1 WHERE id IN ('held', 'both')")  # both = 둘 다 켜진 옛 행 → 최종으로 한 번만

    cut = cards("e035")[1]["e035/c0010"]
    assert (cut["count"], cut["final_count"], cut["held_count"]) == (4, 2, 1)  # 손자 폴더(takeB)의 보류도 든다
    plain = cards("e035")[1]["e035/c0020"]
    assert (plain["count"], plain["final_count"], plain["held_count"]) == (1, 0, 0)
    episode = cards("")[1]["e035"]
    assert (episode["count"], episode["final_count"], episode["held_count"]) == (5, 2, 1)
    # 사이드바가 쓰는 숫자(폴더마다 따로)를 그 폴더 아래로 더한 값과 같다
    side = repo.projects.folder_review_counts_batch(["member"], team_member_projects=["member"], actor_uid="viewer")["member"]
    under = [counts for path, counts in side.items() if path == "e035/c0010" or path.startswith("e035/c0010/")]
    assert (sum(c["total"] for c in under), sum(c["final"] for c in under), sum(c["held"] for c in under)) == (4, 2, 1)
