"""계정 정리 — 이력 없는 차단·숨김 계정만 지운다(docs/status/계정정리_서버관리창_2026-11-02.md)."""
from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

import pytest

from app import db, deps, main, manage_db, repo
from app.repo import account_cleanup as cleanup, identity, manage
from app.repo.trash import _with_trash, _trash_path

GHOST = "ghost@x.test"
ADMIN = "boss@x.test"


@pytest.fixture
def world(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    monkeypatch.setattr(manage_db, "MANAGE_DB_PATH", tmp_path / "manage_hub.db")
    db.flush_pool()
    monkeypatch.setattr(db, "_POOL_ENABLED", True)  # 운영 기본 — 트랜잭션이 풀 연결에 남지 않는지도 본다
    db.init_db()
    manage_db.init_manage_db(manage_db.MANAGE_DB_PATH)
    repo.ensure_default_worker()
    repo.register(ADMIN, "secret123", "관리자")
    with db.get_connection() as conn:
        manage._ensure_schema(conn)
    try:
        yield tmp_path
    finally:
        db.flush_pool()


def ghost(status="rejected", hidden=False, email=GHOST):
    repo.register(email, "secret123", "유령")
    if status != "pending":
        repo.set_account_status(email, status)
    if hidden:
        repo.set_account_hidden(email, True)
    return repo.get_account(email)


def rows():
    return {row["email"]: row for row in cleanup.list_cleanup_accounts(ADMIN)}


def delete(email=GHOST, **changes):
    account = repo.get_account(email)
    values = {"status": account["status"], "hidden": bool(account["hidden"]), "created_at": account["created_at"]}
    values.update(changes)
    return cleanup.delete_cleanup_account(email, actor_email=ADMIN, actor_uid="acct:" + ADMIN, **values)


def test_signup_only_blocked_account_goes_away_with_its_side_rows(world):
    account = ghost()
    uid = account["creator_uid"]
    with db.get_connection() as conn:
        assert conn.execute("SELECT 1 FROM worker WHERE id=?", (uid,)).fetchone() or True
        conn.execute("INSERT INTO project(id, name, kind) VALUES('p1','P','team')")
        conn.execute("INSERT INTO project_member(project_id, creator_uid, project_role) VALUES('p1',?, 'creator')", (uid,))
        conn.execute("INSERT INTO app_setting(key, value) VALUES(?, '{}')", (f"hf_status:{GHOST}",))
    assert rows()[GHOST]["verdict"] == "deletable"
    assert rows()[GHOST]["project_memberships"] == 1
    assert delete() == {"email": GHOST, "project_memberships": 1}
    assert repo.get_account(GHOST) is None
    with db.get_connection() as conn:
        for sql, value in (("SELECT 1 FROM creator WHERE uid=?", uid), ("SELECT 1 FROM project_member WHERE creator_uid=?", uid),
                           ("SELECT 1 FROM app_setting WHERE key=?", f"hf_status:{GHOST}")):
            assert conn.execute(sql, (value,)).fetchone() is None
        assert GHOST not in str([tuple(r) for r in conn.execute("SELECT * FROM worker").fetchall()])
        audit = conn.execute("SELECT * FROM audit_event WHERE action='account.deleted'").fetchone()
        assert audit is not None and GHOST not in str(tuple(audit))  # 원문 이메일을 남기지 않는다
        assert not conn.in_transaction
    assert repo.get_account(ADMIN) is not None


def test_other_accounts_rows_are_untouched(world):
    other = ghost(email="other@x.test")
    ghost()
    delete()
    assert repo.get_account("other@x.test")["creator_uid"] == other["creator_uid"]


@pytest.mark.parametrize("status,hidden,verdict", [
    ("rejected", False, "deletable"), ("rejected", True, "deletable"), ("pending", True, "deletable"),
    ("approved", True, "block_first"),
])
def test_only_accounts_that_cannot_log_in_are_deletable(world, status, hidden, verdict):
    ghost(status, hidden)
    assert rows()[GHOST]["verdict"] == verdict
    if verdict != "deletable":
        with pytest.raises(cleanup.CleanupRefused):
            delete()
        assert repo.get_account(GHOST) is not None


@pytest.mark.parametrize("status", ["pending", "approved"])
def test_visible_accounts_are_not_listed_and_cannot_be_deleted(world, status):
    ghost(status)
    assert GHOST not in rows()
    with pytest.raises(cleanup.CleanupRefused):
        delete()
    assert repo.get_account(GHOST) is not None


def test_self_system_provider_and_house_are_protected(world, monkeypatch):
    ghost()
    assert cleanup.list_cleanup_accounts(GHOST)[0]["reasons"][0]["kind"] == "자기 계정"
    monkeypatch.setenv("CONTENT_HUB_ADMIN_EMAIL", GHOST)
    assert rows()[GHOST]["reasons"][0]["kind"] == "시스템 계정"
    monkeypatch.delenv("CONTENT_HUB_ADMIN_EMAIL")
    assert rows()[GHOST]["verdict"] == "deletable"
    repo.set_setting("provider_email", GHOST)
    assert rows()[GHOST]["reasons"][0]["kind"] == "서버 힉스필드 계정"
    repo.set_setting("provider_email", "")
    repo.set_setting("my_creator_uid", repo.get_account(GHOST)["creator_uid"])
    assert rows()[GHOST]["reasons"][0]["kind"] == "서버 힉스필드 계정"


def test_default_system_email_is_protected_even_when_env_differs(world, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_ADMIN_EMAIL", "other@x.test")
    ghost(email="admin@millionvolt.com")
    assert rows()["admin@millionvolt.com"]["reasons"][0]["kind"] == "시스템 계정"


def test_real_higgsfield_link_blocks_delete(world):
    ghost()
    with db.get_connection() as conn:
        conn.execute("UPDATE account SET creator_uid='user_real' WHERE email=?", (GHOST,))
    assert rows()[GHOST]["reasons"][0]["kind"] == "힉스필드 연결"
    with pytest.raises(cleanup.CleanupRefused):
        delete()


def test_shared_creator_uid_blocks_delete(world):
    account = ghost()
    ghost(email="twin@x.test")
    with db.get_connection() as conn:
        conn.execute("UPDATE account SET creator_uid=? WHERE email='twin@x.test'", (account["creator_uid"],))
    assert rows()[GHOST]["reasons"][0]["kind"] == "같은 이름표를 쓰는 계정"


def _insert_row(conn, table: str, col: str, value: str) -> None:
    """어떤 표든 한 줄 넣는다 — 시험이 칸 하나하나를 막는지 보려는 것이라 나머지 칸은 채우기만 한다."""
    conn.execute("PRAGMA foreign_keys=OFF")
    conn.execute("PRAGMA ignore_check_constraints=ON")
    cols = conn.execute(f'PRAGMA table_info("{table}")').fetchall()
    names, values = [], []
    for info in cols:
        name, kind, notnull, default, pk = info[1], (info[2] or "").upper(), info[3], info[4], info[5]
        if name == col:
            names.append(name)
            values.append(value)
        elif (notnull or pk) and default is None:
            names.append(name)
            values.append(1 if "INT" in kind or "REAL" in kind else f"filler-{name}")
    marks = ",".join("?" * len(values))
    quoted = ",".join(f'"{n}"' for n in names)
    conn.execute(f'INSERT INTO "{table}"({quoted}) VALUES({marks})', values)
    conn.execute("PRAGMA ignore_check_constraints=OFF")
    conn.execute("PRAGMA foreign_keys=ON")


@pytest.mark.parametrize("table,col", sorted(cleanup.uid_history_columns()))
def test_each_uid_history_column_blocks_delete(world, table, col):
    uid = ghost()["creator_uid"]
    with db.get_connection() as conn:
        if not identity._col_exists(conn, table, col):
            pytest.skip("구버전 칸")
        _insert_row(conn, table, col, uid)
    assert rows()[GHOST]["verdict"] == "blocked"
    with pytest.raises(cleanup.CleanupRefused):
        delete()
    assert repo.get_account(GHOST) is not None


@pytest.mark.parametrize("table,col", sorted(cleanup.EMAIL_HISTORY))
def test_each_email_history_column_blocks_delete_in_any_case(world, table, col):
    ghost()
    with db.get_connection() as conn:
        if not identity._col_exists(conn, table, col):
            pytest.skip("구버전 칸")
        _insert_row(conn, table, col, " " + GHOST.upper())
    assert rows()[GHOST]["verdict"] == "blocked"


def test_blocking_reason_names_the_kind_and_count(world):
    uid = ghost()["creator_uid"]
    with db.get_connection() as conn:
        _insert_row(conn, "generation", "creator_uid", uid)
    assert rows()[GHOST]["reasons"] == [{"kind": "생성물", "count": 1}]


def test_manage_fact_blocks_delete(world):
    ghost()
    with manage_db.get_connection() as conn:
        _insert_row(conn, "team_generation_fact", "account_email", GHOST)
    assert rows()[GHOST]["reasons"] == [{"kind": "생성 보고", "count": 1}]


def test_fact_arriving_after_the_lock_is_taken_still_blocks_delete(world, monkeypatch):
    """생성 보고는 별도 파일이라 삭제 잠금에 안 묶인다 — 잠금을 잡은 뒤 들어온 보고까지 본다(검사가 잠금 밖이면 이 시험이 깨진다)."""
    ghost()
    check = cleanup._assert_no_pending_transfer

    def late_report(conn):
        assert conn.in_transaction
        with manage_db.get_connection() as facts:
            _insert_row(facts, "team_generation_fact", "account_email", GHOST)
        check(conn)

    monkeypatch.setattr(cleanup, "_assert_no_pending_transfer", late_report)
    with pytest.raises(cleanup.CleanupRefused, match="생성 보고"):
        delete()
    assert repo.get_account(GHOST) is not None


def _trash(world_path, payload, creator="acct:a@x.test", row_id="t1"):
    with _with_trash() as conn:
        # job_id 를 채워 둔다 — 비면 attach 의 백필이 payload 를 먼저 해석해 깨진 JSON 시험이 여기까지 못 온다
        conn.execute("INSERT INTO trash.trashed(id, trashed_at, creator_uid, job_id, payload) VALUES(?, datetime('now'), ?, ?, ?)",
                     (row_id, creator, "job-" + row_id, payload))


def test_someone_elses_trashed_generation_with_their_comment_blocks_delete(world):
    uid = ghost()["creator_uid"]
    _trash(world, json.dumps({"generation": {"creator_uid": "acct:a@x.test"}, "comments": [{"author": uid}]}))
    assert rows()[GHOST]["reasons"] == [{"kind": "휴지통", "count": 1}]


def test_trash_finds_json_escaped_identity(world):
    email = '"ab"@x.test'
    repo.register(email, "secret123", "따옴표")
    repo.set_account_status(email, "rejected")
    _trash(world, json.dumps({"comments": [{"author": "acct:" + email}]}, ensure_ascii=False))
    assert rows()[email]["reasons"] == [{"kind": "휴지통", "count": 1}]


def test_unreadable_trash_payload_refuses(world):
    ghost()
    _trash(world, "{not json")
    with pytest.raises(cleanup.CleanupRefused):
        delete()
    assert repo.get_account(GHOST) is not None


def test_trash_change_between_scan_and_lock_refuses_even_with_same_count_and_time(world, monkeypatch):
    """같은 초에 한 건 들어오고 한 건 빠져도(건수·최신 시각이 같아도) 다시 묻는다."""
    uid = ghost()["creator_uid"]
    _trash(world, json.dumps({"x": "다른 사람"}), row_id="old")
    scan = cleanup._trash_history

    def racing_scan(conn, rows_):
        found = scan(conn, rows_)
        other = sqlite3.connect(_trash_path())
        other.execute("UPDATE trashed SET id='new', payload=?", (json.dumps({"comments": [{"author": uid}]}),))
        other.commit()
        other.close()
        return found

    monkeypatch.setattr(cleanup, "_trash_history", racing_scan)
    with pytest.raises(cleanup.CleanupRefused, match="휴지통이 바뀌었습니다"):
        delete()
    assert repo.get_account(GHOST) is not None


def test_stale_confirmation_refuses(world):
    ghost()
    with pytest.raises(cleanup.CleanupRefused, match="계정이 바뀌었습니다"):
        delete(status="pending")
    with pytest.raises(cleanup.CleanupRefused, match="계정이 바뀌었습니다"):
        delete(created_at="2000-01-01 00:00:00")
    with pytest.raises(cleanup.CleanupRefused, match="계정이 바뀌었습니다"):
        delete(hidden=True)
    assert repo.get_account(GHOST) is not None
    with db.get_connection() as conn:
        assert not conn.in_transaction


def test_demoted_requester_cannot_delete(world):
    ghost()
    with db.get_connection() as conn:
        conn.execute("UPDATE account SET global_role='member' WHERE email=?", (ADMIN,))
    with pytest.raises(cleanup.CleanupRefused, match="관리자 권한"):
        delete()


def test_failure_inside_delete_leaves_everything(world, monkeypatch):
    uid = ghost()["creator_uid"]
    monkeypatch.setattr(cleanup, "_record_audit_event", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    with pytest.raises(RuntimeError):
        delete()
    assert repo.get_account(GHOST)["creator_uid"] == uid
    with db.get_connection() as conn:
        assert conn.execute("SELECT 1 FROM creator WHERE uid=?", (uid,)).fetchone()


# ── 칸 분류 — 새 신원 칸은 여기 등록해야 시험이 통과한다(이력·함께 지움·보존·신원 아님) ──
_OWNERISH = re.compile(r"(uid|email|creator|owner|author|actor|assign|member|account|_by$|_by_|recipient|subject|"
                       r"sender|viewer|reader|reviewer|requester|holder|worker_id|user)", re.I)
_SUBJECT = {"account": "email", "creator": "uid", "worker": "id"}
KEPT = {
    ("audit_event", "actor_uid"): "append-only 감사 — 이메일은 지문으로 저장",
    ("generation_event", "actor_uid"): "append-only 장애 이력",
    ("project_planning", "updated_by"): "저장 당시 감사 스냅샷",
    ("workspace_credit_plan", "updated_by"): "저장 당시 감사 스냅샷",
    ("workspace_console", "created_by"): "연결 당시 감사 스냅샷",
    ("credit_txn_alias_merged", "l_owner_uid"): "되돌리기 보관 스냅샷 — 실제 uid 만 들어간다",
    ("credit_txn_alias_merged", "l_account_email"): "되돌리기 보관 스냅샷 — 실제 uid 만 들어간다",
    ("super_admin_session", "subject_uid"): "subject_email 로 이력 처리",
    ("account", "creator_uid"): "지울 계정 본체",
}
NOT_IDENTITY = {
    ("worker", "account_type"): "personal/team 구분",
    ("schema_meta", "minimum_reader_protocol"): "스키마 호환 번호",
    ("workspace_member", "user_role"): "역할 이름",
    ("edit_share", "owner_key"): "무작위 키",
    ("edit_share", "owner_name"): "표시 이름 스냅샷 — owner 로 이력 처리",
    ("gen_request", "lease_owner"): "에이전트 임대 표식",
    ("asset_sync_outbox", "account_key"): "EMAIL_HISTORY",
    ("team_generation_fact", "workspace_name"): "이름 스냅샷",
    ("team_generation_fact", "project_name"): "이름 스냅샷",
    ("team_generation_fact", "creator_name"): "이름 스냅샷",
}
CHECKED_ELSEWHERE = {("team_generation_fact", "account_email"), ("team_generation_fact", "creator_uid"),
                     ("trashed", "creator_uid")}


def _columns(conn, schema="main"):
    tables = conn.execute(f"SELECT name FROM {schema}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()
    for (table,) in tables:
        for info in conn.execute(f'PRAGMA {schema}.table_info("{table}")').fetchall():
            yield table, info[1]


def _unclassified(columns) -> list[str]:
    known = (set(cleanup.uid_history_columns()) | set(cleanup.EMAIL_HISTORY) | set(cleanup.REMOVED_WITH_ACCOUNT)
             | set(KEPT) | set(NOT_IDENTITY) | CHECKED_ELSEWHERE | set(_SUBJECT.items()))
    return [f"{t}.{c}" for t, c in columns if _OWNERISH.search(c) and (t, c) not in known]


def test_every_identity_column_in_every_database_is_classified(world):
    with db.get_connection() as conn:
        missing = _unclassified(_columns(conn))
    with sqlite3.connect(manage_db.MANAGE_DB_PATH) as conn:
        missing += _unclassified(_columns(conn))
    with _with_trash() as conn:
        missing += _unclassified(_columns(conn, "trash"))
    assert missing == []


def test_a_new_identity_column_in_the_trash_db_fails_the_classification(world):
    with _with_trash() as conn:
        conn.execute("ALTER TABLE trash.trashed ADD COLUMN reviewer_uid TEXT")
        assert _unclassified(_columns(conn, "trash")) == ["trashed.reviewer_uid"]


def test_app_setting_keys_with_an_email_are_handled(world):
    """app_setting 은 키에 신원이 들어가는 유일한 표다 — 코드에서 f-키를 쓰는 곳이 hf_status 뿐인지 본다."""
    backend = Path(identity.__file__).resolve().parents[1]
    found = set()
    for path in backend.rglob("*.py"):
        found |= set(re.findall(r'(?:set_setting|get_setting)\(f"([^"{]+)\{', path.read_text(encoding="utf-8")))
    assert found <= {"hf_status:"}, found
