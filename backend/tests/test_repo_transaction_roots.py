"""R6 — transaction-root 계약(신규 BEGIN IMMEDIATE 함수) + 인덱스 마이그레이션.

★풀 ON(운영 기본)으로 검증한다 — conftest 전역은 풀 OFF 라, 같은 스레드가 커넥션을
재사용할 때의 트랜잭션 중첩·잔류(in_transaction 으로 남아 다음 호출을 깨는 것)가
평소 테스트에서 가려진다(코덱스 설계 검토 적발). 이 파일이 그 사각을 고정한다.
"""
from __future__ import annotations

import pytest

from app import db, repo


@pytest.fixture
def pooled_db(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    db.flush_pool()
    monkeypatch.setattr(db, "_POOL_ENABLED", True)  # 운영 기본(풀 ON) 재현
    db.init_db()
    repo.ensure_default_worker()
    try:
        yield
    finally:
        db.flush_pool()  # 같은 스레드 풀 커넥션 회수(Windows 파일 잠금 방지)


def _assert_pool_connection_clean() -> None:
    """직전 호출이 풀 커넥션을 열린 트랜잭션 상태로 남기지 않았는지 확인."""
    with db.get_connection() as conn:
        assert not conn.in_transaction


def test_comment_lock_mutations_are_transaction_root_safe_with_pool(pooled_db):
    """assets-1 — 같은 풀 커넥션으로 연속 호출해도 중첩 오류·잔류 트랜잭션이 없다."""
    cid = repo.add_asset_comment("proj", "a.png", "me", "첫 코멘트")
    _assert_pool_connection_clean()
    repo.edit_asset_comment(cid, "me", "수정")
    _assert_pool_connection_clean()
    # 타인 답글 → 잠금(예외 경로가 ROLLBACK 으로 끝나 커넥션이 깨끗해야 다음 호출이 산다)
    repo.add_asset_comment("proj", "a.png", "other", "답글", parent_id=cid)
    with pytest.raises(PermissionError):
        repo.edit_asset_comment(cid, "me", "잠긴 뒤 수정")
    _assert_pool_connection_clean()
    with pytest.raises(PermissionError):
        repo.delete_asset_comment(cid, "me")
    _assert_pool_connection_clean()
    # 정상 삭제 경로(잠기지 않은 별도 코멘트)
    cid2 = repo.add_asset_comment("proj", "b.png", "me", "둘째")
    repo.delete_asset_comment(cid2, "me")
    _assert_pool_connection_clean()
    with db.get_connection() as conn:
        remaining = conn.execute(
            "SELECT COUNT(*) FROM asset_comment WHERE id=?", (cid2,)
        ).fetchone()[0]
    assert remaining == 0  # COMMIT 실제 반영


def test_project_mutations_are_transaction_root_safe_with_pool(pooled_db):
    """projects-1 — workspace 변경·reorder·삭제 연속 호출(풀 커넥션 재사용) 무결."""
    project = repo.create_project("루트계약")
    _assert_pool_connection_clean()
    gen_id = repo.create_local_generation({"model": "m", "prompt": "p"}, "me")
    repo.assign_to_project([gen_id], project["id"])
    assert repo.set_project_workspace(
        project["id"], {"scope": "team", "id": "ws-1", "name": "팀"}
    )
    _assert_pool_connection_clean()
    repo.reorder_projects([project["id"]])
    _assert_pool_connection_clean()
    assert repo.delete_project(project["id"])
    _assert_pool_connection_clean()
    with db.get_connection() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM project WHERE id=?", (project["id"],)
        ).fetchone()[0] == 0
        # 귀속 생성물은 삭제가 아니라 미분류(1-J 계약)
        row = conn.execute(
            "SELECT project_id FROM generation WHERE id=?", (gen_id,)
        ).fetchone()
    assert row is not None and row["project_id"] is None


def test_relink_asset_path_transaction_root_safe_with_pool(pooled_db):
    """assets-2 — SELECT 포함 임계구역이 풀 커넥션을 깨끗하게 반납한다."""
    repo.set_asset_source("proj", "old.png", "소스명", True, owner_uid="me")
    _assert_pool_connection_clean()
    repo.relink_asset_path("proj", "old.png", "new.png", owner_uid="me")
    _assert_pool_connection_clean()
    meta = repo.get_asset_meta("proj", viewer_uid="me")
    assert meta["new.png"]["is_source"] in (True, 1)
    assert "old.png" not in meta  # 옛 행이 병합·이관됨(COMMIT 반영)


def test_move_to_trash_if_failed_revalidates_inside_lock(pooled_db):
    """R6 2-0(코덱스 승격) — 선별 뒤 done 으로 수렴한 생성물·남의 생성물은 이동하지
    않는다(완료본 오삭제 TOCTOU 차단). 실패 상태만 실제 이동."""
    from app.repo import trash

    failed_id = repo.create_local_generation({"model": "m", "prompt": "f"}, "me")
    repo.set_status(failed_id, "failed")
    done_id = repo.create_local_generation({"model": "m", "prompt": "d"}, "me")
    repo.set_status(done_id, "done")
    with db.get_connection() as conn:
        owner = conn.execute(
            "SELECT creator_uid FROM generation WHERE id=?", (failed_id,)
        ).fetchone()["creator_uid"]

    assert trash.move_to_trash_if_failed(done_id, owner) is False  # 상태 재검증
    assert trash.move_to_trash_if_failed(failed_id, "다른사람") is False  # 소유자 재검증
    _assert_pool_connection_clean()
    with db.get_connection() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM generation WHERE id IN (?,?)", (failed_id, done_id)
        ).fetchone()[0] == 2  # 아무것도 안 옮겨짐

    assert trash.move_to_trash_if_failed(failed_id, owner) is True  # 정상 이동
    _assert_pool_connection_clean()
    with db.get_connection() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM generation WHERE id=?", (failed_id,)
        ).fetchone()[0] == 0
        assert conn.execute(
            "SELECT COUNT(*) FROM generation WHERE id=?", (done_id,)
        ).fetchone()[0] == 1  # 완료본 보존
    assert [item["id"] for item in trash.list_trash()] == [failed_id]


def _seed_stuck_synced(gen_id: str, job_id: str, sort_ts: float = 100.0) -> None:
    with db.get_connection() as conn:
        conn.execute(
            "INSERT INTO generation("
            "id, worker_id, prompt, model, status, created_at, sort_ts, job_id, origin"
            ") VALUES(?, 'me', 'p', 'm', 'running', '1970-01-01 00:01:40', ?, ?, 'synced')",
            (gen_id, sort_ts, job_id),
        )


@pytest.mark.parametrize(
    "case, mutation",
    [
        ("status", "UPDATE generation SET status='done' WHERE id=?"),
        ("job_id", "UPDATE generation SET job_id='job-new' WHERE id=?"),
        ("origin", "UPDATE generation SET origin='local' WHERE id=?"),
        ("time", "UPDATE generation SET sort_ts=300 WHERE id=?"),
        ("deleted", "UPDATE generation SET deleted_at='2026-08-22' WHERE id=?"),
    ],
    ids=("status", "job_id", "origin", "time", "deleted"),
)
def test_move_to_trash_if_stuck_synced_rejects_changed_generation(
    pooled_db,
    case,
    mutation,
):
    """SY-1 — 원격 확인 중 선별 조건이 달라진 카드는 쓰기락 안 재검증에서 보존한다."""
    from app.repo import trash

    gen_id = f"stuck-{case}"
    job_id = f"job-{case}"
    _seed_stuck_synced(gen_id, job_id)
    with db.get_connection() as conn:
        conn.execute(mutation, (gen_id,))

    assert trash.move_to_trash_if_stuck_synced(gen_id, job_id, 200.0) is False
    _assert_pool_connection_clean()
    with db.get_connection() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM generation WHERE id=?", (gen_id,)
        ).fetchone()[0] == 1


def test_move_to_trash_if_stuck_synced_rejects_new_request(pooled_db):
    """SY-1 — 원격 확인 중 gen_request가 연결되면 정상 로컬 요청일 수 있어 보존한다."""
    from app.repo import trash

    gen_id = "stuck-request"
    job_id = "job-request"
    _seed_stuck_synced(gen_id, job_id)
    with db.get_connection() as conn:
        conn.execute(
            "INSERT INTO gen_request(id, account_email, gen_id, kind, status, payload) "
            "VALUES('req-stuck', 'me@example.com', ?, 'create', 'pending', '{}')",
            (gen_id,),
        )

    assert trash.move_to_trash_if_stuck_synced(gen_id, job_id, 200.0) is False
    _assert_pool_connection_clean()
    with db.get_connection() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM generation WHERE id=?", (gen_id,)
        ).fetchone()[0] == 1


def test_move_to_trash_if_stuck_synced_moves_only_unchanged_candidate(pooled_db):
    """SY-1 — 전 조건이 유지된 경우에만 풀 ON 단일 transaction-root로 이동한다."""
    from app.repo import trash

    gen_id = "stuck-valid"
    job_id = "job-valid"
    _seed_stuck_synced(gen_id, job_id)

    assert trash.move_to_trash_if_stuck_synced(gen_id, job_id, 200.0) is True
    _assert_pool_connection_clean()
    with db.get_connection() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM generation WHERE id=?", (gen_id,)
        ).fetchone()[0] == 0
    assert [item["id"] for item in trash.list_trash()] == [gen_id]


def test_concurrent_first_registration_creates_exactly_one_admin(pooled_db):
    """R6 2-A(코덱스 필수) — 동시 최초 가입 2건에서 관리자(approved+admin)는 정확히
    1명. 같은 이메일 동시 가입은 IntegrityError 가 아니라 ValueError 로 정리된다."""
    import threading

    results: list[dict] = []
    errors: list[Exception] = []
    barrier = threading.Barrier(2)

    def run(email: str) -> None:
        barrier.wait()
        try:
            results.append(repo.register(email, "password123"))
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [
        threading.Thread(target=run, args=(f"user{index}@example.com",))
        for index in range(2)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    assert len(results) == 2
    admins = [r for r in results if r["status"] == "approved"]
    assert len(admins) == 1  # 최초 관리자 정확히 1명(경합에서도)
    assert "admin" in (admins[0].get("global_role") or "")
    pendings = [r for r in results if r["status"] == "pending"]
    assert len(pendings) == 1

    # 같은 이메일 동시 가입 — 한쪽은 성공, 다른 쪽은 ValueError(IntegrityError 금지)
    dup_errors: list[Exception] = []
    dup_results: list[dict] = []
    barrier2 = threading.Barrier(2)

    def run_dup() -> None:
        barrier2.wait()
        try:
            dup_results.append(repo.register("dup@example.com", "password123"))
        except Exception as exc:  # noqa: BLE001
            dup_errors.append(exc)

    threads = [threading.Thread(target=run_dup) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(dup_results) == 1
    assert len(dup_errors) == 1 and isinstance(dup_errors[0], ValueError)


def test_account_status_raw_and_registry_commit_atomically(pooled_db, monkeypatch):
    """R6 2-E — 정상 보고(workspaces=list)는 raw JSON 과 registry 정규화가 전부 적용
    또는 전부 롤백. 불완전 보고는 종전대로 raw-only 저장."""
    from app.repo import identity

    status = {
        "credits": 10,
        "workspaces": [
            {"id": "ws-1", "name": "팀", "user_role": "member", "is_selected": True}
        ],
    }
    # 후반(자동 편입) 실패 → raw 저장까지 함께 롤백돼야 한다(종전엔 raw 만 먼저 남았다)
    import app.repo.project_membership as membership

    def boom(conn, workspace_id, creator_uid):
        raise RuntimeError("편입 실패")

    monkeypatch.setattr(membership, "enroll_uid_into_workspace_projects", boom)
    # creator_uid 가 있어야 enroll 경로에 진입한다
    repo.register("worker@example.com", "password123")
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE account SET creator_uid='user_w1' WHERE email=?",
            ("worker@example.com",),
        )
    with pytest.raises(RuntimeError):
        identity.record_account_status("worker@example.com", status)
    _assert_pool_connection_clean()
    assert repo.get_setting("hf_status:worker@example.com") is None  # raw 도 롤백
    with db.get_connection() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM workspace_member WHERE account_email=?",
            ("worker@example.com",),
        ).fetchone()[0] == 0

    monkeypatch.setattr(
        membership, "enroll_uid_into_workspace_projects", lambda *a, **k: 0
    )
    identity.record_account_status("worker@example.com", status)
    assert repo.get_setting("hf_status:worker@example.com") is not None
    with db.get_connection() as conn:
        assert conn.execute(
            "SELECT is_available FROM workspace_member WHERE account_email=?",
            ("worker@example.com",),
        ).fetchone()[0] == 1

    # 불완전 보고(workspaces 없음) — raw-only 저장, 멤버십 불변(전부 unavailable 금지)
    identity.record_account_status("worker@example.com", {"credits": 5})
    with db.get_connection() as conn:
        assert conn.execute(
            "SELECT is_available FROM workspace_member WHERE account_email=?",
            ("worker@example.com",),
        ).fetchone()[0] == 1


def _seed_dup(url: str, *, origin: str, job_id=None, extra_asset=None) -> str:
    gen_id = repo.create_local_generation({"model": "m", "prompt": "p"}, "me")
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE generation SET origin=?, job_id=? WHERE id=?",
            (origin, job_id, gen_id),
        )
        conn.execute(
            "INSERT INTO asset(id, generation_id, type, file_path, source_url) "
            "VALUES(?,?,?,?,?)",
            (f"a-{gen_id}", gen_id, "image", url, url),
        )
        if extra_asset:
            conn.execute(
                "INSERT INTO asset(id, generation_id, type, file_path, source_url) "
                "VALUES(?,?,?,?,?)",
                (f"a2-{gen_id}", gen_id, "image", extra_asset, extra_asset),
            )
    return gen_id


def test_reconcile_duplicates_merges_only_well_formed_groups(pooled_db):
    """R6 2-H(코덱스 확정 skip 조건) — 정상 그룹만 병합, 비정형은 무접촉."""
    # 정상: local 1 + synced 2(같은 anchor) → 병합
    ok_local = _seed_dup("http://x/ok.png", origin="local")
    _seed_dup("http://x/ok.png", origin="synced", job_id="job-ok")
    _seed_dup("http://x/ok.png", origin="synced", job_id="job-ok")
    # 비정형 ①: synced 의 job_id 불수렴(종전엔 synced[0] 임의 선택)
    amb_local = _seed_dup("http://x/amb.png", origin="local")
    _seed_dup("http://x/amb.png", origin="synced", job_id="job-a")
    amb_synced2 = _seed_dup("http://x/amb.png", origin="synced", job_id="job-b")
    # 비정형 ②: local 이 이미 다른 잡에 앵커됨
    anchored_local = _seed_dup("http://x/anc.png", origin="local", job_id="job-else")
    anc_synced = _seed_dup("http://x/anc.png", origin="synced", job_id="job-anc")
    # 비정형 ③: 삭제될 synced 만 가진 추가 원격 asset(지우면 유실)
    extra_local = _seed_dup("http://x/ext.png", origin="local")
    ext_synced = _seed_dup(
        "http://x/ext.png", origin="synced", job_id="job-ext",
        extra_asset="http://x/ext-only-on-synced.mp4",
    )

    merged = repo.reconcile_duplicates()
    _assert_pool_connection_clean()

    assert merged == 2  # 정상 그룹의 synced 2건만
    with db.get_connection() as conn:
        def alive(gid):
            return conn.execute(
                "SELECT job_id FROM generation WHERE id=?", (gid,)
            ).fetchone()

        assert alive(ok_local)["job_id"] == "job-ok"  # 권위 anchor 이식
        assert alive(amb_local)["job_id"] is None  # 불수렴 그룹 무접촉
        assert alive(amb_synced2) is not None
        assert alive(anchored_local)["job_id"] == "job-else"  # 기존 앵커 보존
        assert alive(anc_synced) is not None
        assert alive(extra_local) is not None and alive(ext_synced) is not None  # 유실 방지


def _seed_placeholder(email: str, key: str, kind: str = "create"):
    """preparing 요청 + local pending placeholder 를 만든다(재개 가능 기본형)."""
    gen_id = repo.create_local_generation({"model": "m", "prompt": "p"}, "me")
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE generation SET origin='local', status='pending', job_id=NULL WHERE id=?",
            (gen_id,),
        )
        owner = conn.execute(
            "SELECT creator_uid FROM generation WHERE id=?", (gen_id,)
        ).fetchone()["creator_uid"]
        conn.execute(
            "INSERT INTO gen_request(id, account_email, gen_id, kind, status, idempotency_key, payload) "
            "VALUES(?,?,?,?,?,?,?)",
            (f"req-{gen_id}", email, gen_id, kind, "preparing", key, "{}"),
        )
    return gen_id, owner


@pytest.mark.parametrize(
    "mutate, expected",
    [
        (None, True),  # 기본형 — 재개 가능
        ("request_gone", False),
        ("wrong_status_generation", False),
        ("origin_synced", False),
        ("job_id_set", False),
        ("other_request", False),
        ("creator_mismatch", False),
    ],
    ids=[
        "base",
        "no-preparing-request",
        "generation-not-pending",
        "origin-synced",
        "job-anchored",
        "other-request-exists",
        "creator-mismatch",
    ],
)
def test_idempotent_placeholder_resume_truth_table(pooled_db, mutate, expected):
    """R6 2-B(코덱스 필수) — 3~4 SELECT→1 SELECT 통합 후에도 판정 진리표 동일."""
    gen_id, owner = _seed_placeholder("w@example.com", "key-1")
    creator = owner
    with db.get_connection() as conn:
        if mutate == "request_gone":
            conn.execute("UPDATE gen_request SET status='pending' WHERE gen_id=?", (gen_id,))
        elif mutate == "wrong_status_generation":
            conn.execute("UPDATE generation SET status='running' WHERE id=?", (gen_id,))
        elif mutate == "origin_synced":
            conn.execute("UPDATE generation SET origin='synced' WHERE id=?", (gen_id,))
        elif mutate == "job_id_set":
            conn.execute("UPDATE generation SET job_id='job-x' WHERE id=?", (gen_id,))
        elif mutate == "other_request":
            conn.execute(
                "INSERT INTO gen_request(id, account_email, gen_id, kind, status, payload) "
                "VALUES('req-other','w@example.com',?,?,'pending','{}')",
                (gen_id, "create"),
            )
        elif mutate == "creator_mismatch":
            creator = "다른사람"
    assert (
        repo.idempotent_placeholder_is_resumable(
            "w@example.com", creator, "key-1", gen_id, "create"
        )
        is expected
    )
    # creator=None 이면 소유자 검사 생략(계약) — creator 불일치 케이스만 True 로 뒤집힘
    if mutate == "creator_mismatch":
        assert repo.idempotent_placeholder_is_resumable(
            "w@example.com", None, "key-1", gen_id, "create"
        ) is True


def test_canvas_placeholder_resume_truth_table(pooled_db):
    """R6 2-B 캔버스 진리표(코덱스 P1) — 특히 같은 이메일의 '일반 요청'(canvas_attempt_id
    =NULL)이 타요청으로 정확히 집계돼야 한다(= 비교의 NULL 구멍 회귀)."""
    gen_id = repo.create_local_generation({"model": "m", "prompt": "p"}, "me")
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE generation SET origin='local', status='pending', job_id=NULL WHERE id=?",
            (gen_id,),
        )
        owner = conn.execute(
            "SELECT creator_uid FROM generation WHERE id=?", (gen_id,)
        ).fetchone()["creator_uid"]
        conn.execute(
            "INSERT INTO gen_request(id, account_email, gen_id, kind, status, canvas_attempt_id, payload) "
            "VALUES('req-canvas','w@example.com',?,?,'preparing','attempt-1','{}')",
            (gen_id, "create"),
        )
    link = {"attempt_id": "attempt-1", "generation_id": gen_id}
    assert repo.canvas_placeholder_is_resumable(
        "w@example.com", owner, link, "create"
    ) is True  # 기본형

    # ★같은 이메일의 일반 요청(NULL attempt) 이 존재 — 타요청이므로 재개 불가여야 한다
    with db.get_connection() as conn:
        conn.execute(
            "INSERT INTO gen_request(id, account_email, gen_id, kind, status, canvas_attempt_id, payload) "
            "VALUES('req-plain','w@example.com',?,?,'pending',NULL,'{}')",
            (gen_id, "create"),
        )
    assert repo.canvas_placeholder_is_resumable(
        "w@example.com", owner, link, "create"
    ) is False
    with db.get_connection() as conn:
        conn.execute("DELETE FROM gen_request WHERE id='req-plain'")
    # 다른 attempt 의 캔버스 요청도 타요청
    with db.get_connection() as conn:
        conn.execute(
            "INSERT INTO gen_request(id, account_email, gen_id, kind, status, canvas_attempt_id, payload) "
            "VALUES('req-other-attempt','w@example.com',?,?,'pending','attempt-2','{}')",
            (gen_id, "create"),
        )
    assert repo.canvas_placeholder_is_resumable(
        "w@example.com", owner, link, "create"
    ) is False


def test_reply_to_deleted_parent_is_rejected(pooled_db):
    """코덱스 P1 — 부모 존재·같은 스레드 확인을 잠금 안에서: 삭제된(또는 다른 스레드의)
    부모를 가리키는 고아 답글이 만들어지지 않는다(asset·generation 코멘트 공통)."""
    cid = repo.add_asset_comment("proj", "a.png", "me", "부모")
    repo.delete_asset_comment(cid, "me")
    with pytest.raises(ValueError):
        repo.add_asset_comment("proj", "a.png", "other", "고아 답글", parent_id=cid)
    # 다른 스레드(경로)의 부모를 가리키는 답글도 거부
    cid2 = repo.add_asset_comment("proj", "a.png", "me", "부모2")
    with pytest.raises(ValueError):
        repo.add_asset_comment("proj", "b.png", "other", "경로 불일치", parent_id=cid2)

    gen_id = repo.create_local_generation({"model": "m", "prompt": "p"}, "me")
    gcid = repo.add_generation_comment(gen_id, "me", "부모")
    repo.delete_generation_comment(gcid, "me")
    with pytest.raises(ValueError):
        repo.add_generation_comment(gen_id, "other", "고아 답글", parent_id=gcid)
    _assert_pool_connection_clean()
    with db.get_connection() as conn:
        orphans = conn.execute(
            "SELECT COUNT(*) FROM asset_comment WHERE parent_id IS NOT NULL "
            "AND parent_id NOT IN (SELECT id FROM asset_comment)"
        ).fetchone()[0]
    assert orphans == 0


def test_private_reply_to_server_parent_is_allowed_when_flagged(pooled_db):
    """코덱스 재확인 회귀 — 프록시 모드의 '서버 공개 부모 → 로컬 비공개 답글'은 부모가
    로컬에 없는 게 정상: allow_external_parent 로만 허용, 로컬 부모의 스레드 불일치는
    허용 여부와 무관하게 거부."""
    # 부모가 로컬에 없음 + 허용 플래그 → 저장된다(서버 부모 시나리오)
    cid = repo.add_asset_comment(
        "proj", "a.png", "me", "비공개 답글",
        parent_id="server-only-parent", is_private=True, allow_external_parent=True,
    )
    assert cid
    gen_id = repo.create_local_generation({"model": "m", "prompt": "p"}, "me")
    gcid = repo.add_generation_comment(
        gen_id, "me", "비공개 답글",
        parent_id="server-only-parent", is_private=True, allow_external_parent=True,
    )
    assert gcid
    # 허용 플래그여도 '로컬에 있는 다른 스레드' 부모는 거부(오배선 차단)
    other = repo.add_asset_comment("proj", "other.png", "me", "다른 스레드 부모")
    with pytest.raises(ValueError):
        repo.add_asset_comment(
            "proj", "a.png", "me", "오배선",
            parent_id=other, is_private=True, allow_external_parent=True,
        )
    _assert_pool_connection_clean()


def test_restore_after_purge_returns_false_and_purge_after_restore_keeps_sidecar(pooled_db):
    """코덱스 P1 — restore 는 휴지통 SELECT 전에 잠금: purge 가 먼저면 False(뒤늦은 부활
    없음), restore 가 먼저면 살아난 본체 때문에 sidecar purge 가 정리를 건너뛴다."""
    from app.repo import trash

    gen_id = repo.create_local_generation({"model": "m", "prompt": "p"}, "me")
    repo.set_status(gen_id, "failed")
    assert trash.move_to_trash(gen_id)
    assert trash.purge_trashed_item(gen_id) is True  # 휴지통에서 영구삭제
    assert trash.restore_from_trash(gen_id) is False  # 뒤늦은 부활 없음
    _assert_pool_connection_clean()

    gen_id2 = repo.create_local_generation({"model": "m", "prompt": "p2"}, "me")
    repo.set_status(gen_id2, "failed")
    assert trash.move_to_trash(gen_id2)
    assert trash.restore_from_trash(gen_id2) is True
    from app.repo import manage as manage_repo

    manage_repo.purge_generation_sidecar(gen_id2)  # 본체 생존 → 정리 건너뜀(재검증)
    with db.get_connection() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM generation WHERE id=?", (gen_id2,)
        ).fetchone()[0] == 1


def test_reconcile_group_locked_skips_remaining_malformed_shapes(pooled_db):
    """R6 2-H 잔여 skip 조건(코덱스 P2) — 중복<2·local≠1·synced 없음."""
    from app.repo import generations as generations_repo

    # 중복<2 (재검증에서 해소된 그룹)
    only = _seed_dup("http://x/one.png", origin="local")
    with db.get_connection() as conn:
        assert generations_repo._reconcile_duplicate_group_locked(conn, "http://x/one.png") == 0
    # local 2개(≠1)
    _seed_dup("http://x/two-local.png", origin="local")
    _seed_dup("http://x/two-local.png", origin="local")
    _seed_dup("http://x/two-local.png", origin="synced", job_id="j")
    with db.get_connection() as conn:
        assert generations_repo._reconcile_duplicate_group_locked(conn, "http://x/two-local.png") == 0
    # synced 없음
    _seed_dup("http://x/no-sync.png", origin="local")
    _seed_dup("http://x/no-sync.png", origin="local")
    with db.get_connection() as conn:
        assert generations_repo._reconcile_duplicate_group_locked(conn, "http://x/no-sync.png") == 0
    assert only  # 사용 표시


def test_ensure_admin_account_and_purge_are_pool_safe(pooled_db):
    """코덱스 P2 — 풀 ON 사각 보강: ensure_admin_account·purge_generation_sidecar."""
    from app.repo import manage as manage_repo

    assert repo.ensure_admin_account("boot@example.com", "password123") is True
    assert repo.ensure_admin_account("boot@example.com", "password123") is False  # 보존
    _assert_pool_connection_clean()
    manage_repo.purge_generation_sidecar("no-such-gen")
    _assert_pool_connection_clean()


def test_regenerate_resume_requires_derived_lineage(pooled_db):
    gen_id, owner = _seed_placeholder("w@example.com", "key-r", kind="regenerate")
    source_id = repo.create_local_generation({"model": "m", "prompt": "src"}, "me")
    assert repo.idempotent_placeholder_is_resumable(
        "w@example.com", owner, "key-r", gen_id, "regenerate", source_id
    ) is False  # lineage 없음
    with db.get_connection() as conn:
        conn.execute(
            "INSERT INTO history(parent_gen_id, child_gen_id, relation) VALUES(?,?,'derived')",
            (source_id, gen_id),
        )
    assert repo.idempotent_placeholder_is_resumable(
        "w@example.com", owner, "key-r", gen_id, "regenerate", source_id
    ) is True


def test_new_indexes_exist_on_fresh_and_migrated_db(pooled_db):
    """1-G/1-K/1-L — 신규 DB(schema)와 기존 DB(_migrate 재실행) 양쪽에서 인덱스 보장."""
    expected = {
        "idx_account_creator_uid",
        "idx_scene_card_gen_owner_generation_active",
        "idx_ssi_claim_token",
    }

    def index_names() -> set[str]:
        with db.get_connection() as conn:
            return {
                r["name"]
                for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='index'"
                ).fetchall()
            }

    assert expected <= index_names()  # 신규 DB(schema.sql 경로)
    with db.get_connection() as conn:
        for name in expected:
            conn.execute(f"DROP INDEX {name}")  # 레거시 DB(인덱스 없던 시절) 재현
    assert not (expected & index_names())
    # ★_migrate 단독 실행으로 증명(코덱스 P2) — init_db 는 schema.sql 이 먼저 복원해
    # 마이그레이션 경로를 독립 증명하지 못한다.
    from app import db_migrations

    with db.get_connection() as conn:
        db_migrations._migrate_share_state_intent(conn)
        db_migrations._migrate(conn)
    assert expected <= index_names()
    # 실측 근거 고정: creator_uid 해석이 SCAN 이 아니라 인덱스 탐색이어야 한다
    with db.get_connection() as conn:
        plan = " ".join(
            r["detail"]
            for r in conn.execute(
                "EXPLAIN QUERY PLAN SELECT email FROM account WHERE creator_uid IN (?,?)",
                ("u1", "u2"),
            ).fetchall()
        )
    assert "idx_account_creator_uid" in plan
