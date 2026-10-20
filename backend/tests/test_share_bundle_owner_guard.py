"""F-A-01 — 공유 서버 publish-bundle 이 '새 앵커 + 남의 결과 URL·작성자' 로 남의 원본을 바꾸지 못한다.

작성자 판정은 id·job_id·URL 로 **실제 고른 행**에, 인증된 발행자 신원(번들의 provider·creator_uid 아님)으로 한다.
호환 계약(최초 acct:→user_ 연결, 자기 재공유, 받은 사본 왕복, 로컬 DEFAULT_WORKER 가져오기)은 그대로다.
임시 DB 만 쓴다.
"""

import asyncio
from types import SimpleNamespace

import pytest

from app import db, deps, repo
from app.routers import publish
from app.routers.publish import PublishBundleIn
from app.usecases import gen_requests as gen_usecases

URL_A = "https://cdn.example/a/result-a.png"
URL_B = "https://cdn.example/b/result-b.png"
URL_OLD = "https://cdn.example/old/result-old.png"
URL_ME = "https://cdn.example/me/result-me.png"
STAMP = "2026-10-05T01:02:03Z"
STAMP_SAVED = "2026-10-05T01:02:03.000000Z"  # normalize_task_activity_at 꼴


@pytest.fixture
def server(monkeypatch, tmp_path):
    def initialize(path):
        db.flush_pool()
        monkeypatch.setenv("CONTENT_HUB_DB", str(path))
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            # A·B 는 실제 uid 에 연결된 계정, C 는 아직 acct: 상태(번들로 첫 연결 전)
            for email, uid in (("a@test", "user_A"), ("b@test", "user_B"), ("c@test", "acct:c@test")):
                conn.execute(
                    "INSERT INTO account(email, name, password_hash, status, creator_uid) "
                    "VALUES(?,?,'x','approved',?)",
                    (email, email[0].upper(), uid),
                )

    initialize(tmp_path / "content.db")
    monkeypatch.setattr(deps, "AUTH_ENABLED", True)
    yield initialize
    db.flush_pool()


def original(gid, job_id, creator, url):
    with db.get_connection() as conn:
        conn.execute(
            "INSERT INTO generation(id, job_id, worker_id, creator_uid, prompt, model, params, status, "
            "created_at, sort_ts) VALUES(?,?,'me',?,'원본','m','{\"k\": \"v\"}','done','2026-10-01 00:00:00',100)",
            (gid, job_id, creator),
        )
        conn.execute(
            "INSERT INTO asset(id, generation_id, type, file_path) VALUES(?,?,'image',?)",
            (gid + "-asset", gid, url),
        )
        conn.execute("INSERT INTO auto_tag(id, name) VALUES(?,?)", (gid + "-auto", gid + "-auto"))
        conn.execute(
            "INSERT INTO gen_auto_tag(generation_id, auto_tag_id) VALUES(?,?)", (gid, gid + "-auto")
        )


def snapshot(gid):
    with db.get_connection() as conn:
        row = dict(conn.execute(
            "SELECT job_id, status, error, params, sort_ts, creator_uid, project_id, folder_path "
            "FROM generation WHERE id=?", (gid,),
        ).fetchone())
        row["assets"] = [tuple(r) for r in conn.execute(
            "SELECT type, file_path, source_url FROM asset WHERE generation_id=?", (gid,))]
        row["auto_tags"] = [r[0] for r in conn.execute(
            "SELECT auto_tag_id FROM gen_auto_tag WHERE generation_id=?", (gid,))]
        row["tags"] = conn.execute("SELECT COUNT(*) FROM gen_tag WHERE generation_id=?", (gid,)).fetchone()[0]
        row["comments"] = conn.execute(
            "SELECT COUNT(*) FROM generation_comment WHERE gen_id=?", (gid,)).fetchone()[0]
        row["shares"] = conn.execute("SELECT COUNT(*) FROM share WHERE generation_id=?", (gid,)).fetchone()[0]
    return row


def location(gid):
    with db.get_connection() as conn:
        return tuple(conn.execute(
            "SELECT project_id, folder_path, task_activity_at FROM generation WHERE id=?", (gid,)).fetchone())


def rows_for(anchor):
    with db.get_connection() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT id, creator_uid FROM generation WHERE id=? OR job_id=?", (anchor, anchor))]


def item(anchor, url, creator=None, **gen):
    g = {"id": anchor, "prompt": "바꿈", "model": "m", "status": "failed", "params": {"evil": 1},
         "sort_ts": 999, "created_at": "2026-10-02 00:00:00", **gen}
    if creator is not None:
        g["creator_uid"] = creator
    return {"generation": g, "asset": {"type": "image", "file_path": url}, "tags": ["evil"],
            "auto_tags": [], "comments": [{"id": "c-" + anchor, "author": "x", "text": "끼움"}]}


def publish_as(email, *items):
    request = SimpleNamespace(state=SimpleNamespace(account=repo.get_account(email)))
    return publish.receive_published_bundle(PublishBundleIn(bundle={"generations": list(items)}), request)


def test_publish_new_anchor_same_url_cannot_mutate_other_owner(server):
    original("orig", "job-A", "user_A", URL_A)
    before = snapshot("orig")
    out = publish_as("b@test", item("job-NEW", URL_A, "user_A"))
    assert out["blocked"] == 1 and out["blocked_ids"] == ["job-NEW"]
    assert snapshot("orig") == before  # job_id·상태·옵션·시각·에셋·자동태그·공유 표식 그대로
    assert rows_for("job-NEW") == []


def test_uid_linked_to_another_account_is_not_adopted(server):
    original("orig", "job-A", "user_A", URL_A)
    before = snapshot("orig")
    out = publish_as("c@test", item("job-NEW", URL_A, "user_A"))  # 남(A)에게 연결된 uid 를 주장
    assert out["blocked_ids"] == ["job-NEW"]
    assert repo.get_account("c@test")["creator_uid"] == "acct:c@test"
    assert snapshot("orig") == before


def test_self_reshare_and_own_acct_alias_still_update(server):
    original("orig", "job-A", "user_A", URL_A)
    out = publish_as("a@test", item("job-A", URL_A, "user_A", status="done", params={"k": "v2"}))
    assert out["blocked"] == 0 and out["updated"] == 1
    assert repo.get_generation("orig")["params"]["k"] == "v2"
    # 계정 자신의 acct: 별칭으로 남은 행도 그 계정의 것이다 — 사실만이 아니라 위치·활동 시각 이동도 반영된다
    original("alias", "job-B", "acct:b@test", URL_B)
    main = repo.create_project("본편")["id"]
    side = repo.create_project("외전")["id"]
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET project_id=?, folder_path='ep09/c090', "
                     "task_activity_at='2026-10-01T00:00:00.000000Z' WHERE id='alias'", (side,))
    out = publish_as("b@test", item("job-B", URL_B, "acct:b@test", status="done", project_id=main,
                                    folder_path="ep01/c010", task_activity_at=STAMP))
    assert out["blocked"] == 0
    assert location("alias") == (main, "ep01/c010", STAMP_SAVED)


def test_other_accounts_alias_or_uid_claim_cannot_move_location(server):
    # 내 행이라도 번들이 남(A)의 별칭·uid 를 작성자로 주장하면 위치는 그대로(빈 칸 보강만) — 인증 발행자 신원만 소유자다
    main = repo.create_project("본편")["id"]
    side = repo.create_project("외전")["id"]
    for gid, job, url, claim in (("own1", "job-O1", URL_B + "?1", "acct:a@test"), ("own2", "job-O2", URL_B + "?2", "user_A")):
        original(gid, job, "user_B", url)
        with db.get_connection() as conn:
            conn.execute("UPDATE generation SET project_id=?, folder_path='ep01/c010', task_activity_at=? WHERE id=?",
                         (main, STAMP_SAVED, gid))
        out = publish_as("b@test", item(job, url, claim, status="done", project_id=side, folder_path="ep09/c090",
                                        task_activity_at="2026-10-06T00:00:00Z"))
        assert out["blocked"] == 0
        assert location(gid) == (main, "ep01/c010", STAMP_SAVED)
        assert rows_for(job) == [{"id": gid, "creator_uid": "user_B"}]  # 작성자도 주장값으로 바뀌지 않는다
        # 그 뒤 B 의 정상 재공유는 그대로 반영된다(작성자가 A 로 넘어갔다면 여기서 막혔다)
        out = publish_as("b@test", item(job, url, "user_B", status="done", project_id=side, folder_path="ep09/c090",
                                        task_activity_at="2026-10-06T00:00:00Z"))
        assert out["blocked"] == 0
        assert location(gid) == (side, "ep09/c090", "2026-10-06T00:00:00.000000Z")


def test_received_copy_not_on_server_keeps_its_author(server):
    # 서버에 아직 없는 받은 사본(작성자 A)을 B 가 올리면 새 행으로 받고, 작성자를 발행자로 바꾸지 않는다
    out = publish_as("b@test", item("job-RC", "https://cdn.example/a/received.png", "user_A", status="done"))
    assert (out["blocked"], out["inserted"]) == (0, 1)
    assert [r["creator_uid"] for r in rows_for("job-RC")] == ["user_A"]


def test_unlinked_old_author_first_link_stays_compatible(server):
    # 호환 계약: acct: 계정이 아직 누구에게도 연결 안 된 uid 를 실은 번들로 처음 연결된다(publish.py 최초 연결).
    # 번들만 보고 맺은 연결이라 독립 검증된 소유권은 아니다 — 이 시험은 지금 계약을 못 박을 뿐이다.
    original("old", "job-OLD", "user_OLD", URL_OLD)
    out = publish_as("c@test", item("job-OLD", URL_OLD, "user_OLD", status="done", params={"k": "v3"}))
    assert out["blocked"] == 0
    assert repo.get_account("c@test")["creator_uid"] == "user_OLD"
    assert repo.get_generation("old")["params"]["k"] == "v3"


def test_missing_or_legacy_me_author_counts_as_publisher(server):
    original("orig", "job-A", "user_A", URL_A)
    original("me-row", "job-ME", "me", URL_ME)
    before_a, before_me = snapshot("orig"), snapshot("me-row")
    out = publish_as(
        "b@test",
        item("job-N1", URL_A),  # 작성자 없음 → 발행자(B)
        item("job-N2", URL_ME, "me"),  # 옛 'me' → 발행자(B) — 서버의 'me' 행을 URL 로 줍지 않는다
        item("job-A", URL_A),  # 남의 앵커는 작성자를 비워도 막힌다
    )
    assert out["blocked_ids"] == ["job-A"]
    assert snapshot("orig") == before_a and snapshot("me-row") == before_me
    assert [r["creator_uid"] for r in rows_for("job-N1") + rows_for("job-N2")] == ["user_B", "user_B"]


def test_local_default_worker_import_is_not_restricted(server):
    # 로컬 파일 가져오기(발행자 없음)는 이 제한 밖 — 지금처럼 반영한다.
    original("orig", "job-A", "user_A", URL_A)
    counts = repo.import_bundle_payload(
        {"provider": {"uid": "me"}, "generations": [item("job-A", URL_A, "user_A", status="done", params={"k": "local"})]},
        "me",
    )
    assert counts["blocked"] == 0 and counts["updated"] == 1
    assert repo.get_generation("orig")["params"]["k"] == "local"


def test_received_copy_roundtrip_preserves_job_anchor(server):
    from app.routers import share as share_router

    original("orig", "job-A", "user_A", URL_A)
    # 받은 쪽 허브가 서버 행을 로컬 사본으로 만들 때의 번들 꼴(앵커 = job_id || id)
    copy = share_router._remote_generation_item({
        "id": "orig", "job_id": "job-A", "creator_uid": "user_A", "status": "done", "prompt": "원본",
        "assets": [{"type": "image", "file_path": URL_A}],
    })
    assert copy["generation"]["id"] == "job-A"
    assert publish_as("b@test", copy)["blocked_ids"] == ["job-A"]  # 받은 사본을 남이 재공유 — 원본 불변
    assert publish_as("a@test", copy)["blocked"] == 0  # 작성자 본인 재공유는 반영
    assert rows_for("job-A") == [{"id": "orig", "creator_uid": "user_A"}]


def _reference_link_rows(gid):
    with db.get_connection() as conn:
        return [dict(row) for row in conn.execute(
            "SELECT rowid AS source_rowid, role, position FROM gen_reference "
            "WHERE generation_id=? ORDER BY rowid", (gid,))]


def _assert_reference_views(gid, expected_order, expected_positions):
    refs = repo.get_generation(gid)["references"]
    assert [(ref["role"], ref["file_path"]) for ref in refs] == expected_order
    assert {ref["role"]: ref["position"] for ref in refs} == expected_positions
    recipe = repo.gen_recipe(gid)["references"]
    assert [(ref["role"], ref["file_path"]) for ref in recipe] == expected_order


def _add_reference_filler():
    repo.create_local_generation({
        "prompt": "reference rowid gap",
        "references": [{"type": "image", "file_path": f"https://cdn.example/filler/{i}.png"}
                       for i in range(20)],
    }, "me", creator_uid="user_A")
    with db.get_connection() as conn:
        return conn.execute("SELECT MAX(rowid) FROM gen_reference").fetchone()[0]


def _regenerate_reference_copy(gid, monkeypatch):
    monkeypatch.setattr(gen_usecases, "MANAGE_ENABLED", False)
    monkeypatch.setattr(gen_usecases, "journal_generation_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(gen_usecases.agent_signals, "signal", lambda *args, **kwargs: None)
    command = gen_usecases.GenRequestCommand(
        kind="regenerate", email="a@test", creator_uid="user_A", worker_id="me",
        source_gen_id=gid, workspace={"scope": "personal"},
    )
    return asyncio.run(gen_usecases.submit_gen_request(command))["id"]


@pytest.mark.parametrize("operation", ["regenerate", "roundtrip"])
@pytest.mark.parametrize("positions,ordered_indices", [
    pytest.param([None, 10], [0, 1], id="mixed"),
    pytest.param([None, 1], [0, 1], id="mixed-tie"),
    pytest.param([None, None], [0, 1], id="all-null"),
    pytest.param([10, 3], [1, 0], id="all-explicit"),
    pytest.param(None, [0, 1], id="all-missing"),
])
def test_reference_order_survives_source_copy(server, monkeypatch, tmp_path, operation, positions, ordered_indices):
    source_item = item("order-source", "https://cdn.example/order/result.png", "user_A",
                       status="done", model="nano-banana", params={}, workspace_scope="personal")
    source_item["references"] = [
        {"type": "image", "file_path": f"https://cdn.example/order/ref-{i}.png", "role": f"@Image{i + 1}"}
        for i in range(2)
    ]
    if positions is not None:
        for ref, position in zip(source_item["references"], positions):
            ref["position"] = position
    assert publish_as("a@test", source_item)["inserted"] == 1
    parent = rows_for("order-source")[0]["id"]
    source_rows = _reference_link_rows(parent)
    source_positions = {row["role"]: row["position"] for row in source_rows}
    supplied_positions = list(range(2)) if positions is None else positions
    assert source_positions == {f"@Image{i + 1}": position for i, position in enumerate(supplied_positions)}
    expected_order = [(source_item["references"][i]["role"], source_item["references"][i]["file_path"])
                      for i in ordered_indices]
    _assert_reference_views(parent, expected_order, source_positions)

    mixed = any(row["position"] is None for row in source_rows) and any(
        row["position"] is not None for row in source_rows)
    copy_positions = {row["role"]: row["source_rowid"] if mixed and row["position"] is None else row["position"]
                      for row in source_rows}
    if positions == [None, 10]:
        assert source_rows[0]["source_rowid"] < 10
    if positions == [None, 1]:
        assert source_rows[0]["source_rowid"] == 1

    # 부모가 낮은 rowid를 얻은 다음에 간격을 만든다. 먼저 filler를 넣으면 혼합 반례가 사라진다.
    largest_key = max((value for value in copy_positions.values() if value is not None), default=0)
    assert _add_reference_filler() > largest_key
    if operation == "regenerate":
        child = _regenerate_reference_copy(parent, monkeypatch)
        assert min(row["source_rowid"] for row in _reference_link_rows(child)) > largest_key
        _assert_reference_views(child, expected_order, copy_positions)
        assert _reference_link_rows(parent) == source_rows
        return

    bundle = repo.export_bundle(gen_ids=[parent])
    exported = bundle["generations"][0]
    assert [(ref["role"], ref["file_path"]) for ref in exported["references"]] == expected_order
    assert {ref["role"]: ref["position"] for ref in exported["references"]} == copy_positions
    assert _reference_link_rows(parent) == source_rows

    # 별도 임시 DB의 높은 rowid에서도 실제 인증 수신과 재생성을 거친다.
    server(tmp_path / "receiver.db")
    assert _add_reference_filler() > largest_key
    assert publish_as("a@test", exported)["inserted"] == 1
    received = rows_for("order-source")[0]["id"]
    received_rows = _reference_link_rows(received)
    assert min(row["source_rowid"] for row in received_rows) > largest_key
    _assert_reference_views(received, expected_order, copy_positions)
    child = _regenerate_reference_copy(received, monkeypatch)
    _assert_reference_views(child, expected_order, copy_positions)
    assert _reference_link_rows(received) == received_rows


def test_reference_order_export_detects_mixed_per_generation(server):
    source_items = []
    for anchor, positions in (("batch-null", [None, None]), ("batch-explicit", [10, 3])):
        source_item = item(anchor, f"https://cdn.example/{anchor}/result.png", "user_A",
                           status="done", model="nano-banana", params={}, workspace_scope="personal")
        source_item["references"] = [
            {"type": "image", "file_path": f"https://cdn.example/{anchor}/ref-{i}.png",
             "role": f"@Image{i + 1}", "position": position}
            for i, position in enumerate(positions)
        ]
        source_items.append(source_item)
    assert publish_as("a@test", *source_items)["inserted"] == 2
    gids = {source_item["generation"]["id"]: rows_for(source_item["generation"]["id"])[0]["id"]
            for source_item in source_items}
    before_rows = {anchor: _reference_link_rows(gid) for anchor, gid in gids.items()}
    bundle = repo.export_bundle(gen_ids=list(gids.values()))
    by_anchor = {entry["generation"]["id"]: entry for entry in bundle["generations"]}
    for source_item in source_items:
        anchor = source_item["generation"]["id"]
        refs = by_anchor[anchor]["references"]
        assert {ref["role"]: ref["position"] for ref in refs} == {
            ref["role"]: ref["position"] for ref in source_item["references"]}
        expected_indices = [0, 1] if anchor == "batch-null" else [1, 0]
        assert [ref["role"] for ref in refs] == [f"@Image{i + 1}" for i in expected_indices]
        assert _reference_link_rows(gids[anchor]) == before_rows[anchor]
