"""프로젝트 멤버 조회 3경로의 공용 이름·정렬·조회 비용 계약."""

from contextlib import contextmanager
from unittest.mock import patch

import pytest

from app import db, rbac
from app.repo import identity, projects


@pytest.fixture
def member_database(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "members.db"))
    db.flush_pool()
    db.init_db()
    # uid 순서와 표시이름 순서를 다르게, 동명이인은 역순으로 삽입한다.
    members = [
        ("user_creator", "  Creator  ", "Ignored", "creator@example.test", "Creator"),
        ("user_account", " \t ", "  Account  ", "account@example.test", "Account"),
        ("user_empty", "", " Empty fallback ", "empty@example.test", "Empty fallback"),
        ("user_email", None, None, "mail-only@example.test", "mail-only"),
        ("user_account_only", None, "Account only", "only@example.test", "Account only"),
        ("user_twin_b", "Twin", None, None, "Twin"),
        ("user_twin_a", "Twin", None, None, "Twin"),
        ("user_unnamed", " \t ", None, None, None),
        ("user_null", None, None, None, None),
        ("user_no_identity_rows", None, None, None, None),
    ]
    roles = " supervisor ,creator,supervisor,invalid "
    with db.get_connection() as conn:
        conn.executemany(
            "INSERT INTO project(id,name) VALUES(?,?)",
            [(pid, pid) for pid in ("visible", "hidden", "empty")],
        )
        for uid, creator_name, account_name, email, _expected in members:
            if uid not in {"user_account_only", "user_no_identity_rows"}:
                conn.execute("INSERT INTO creator(uid,name) VALUES(?,?)", (uid, creator_name))
            if email is not None:
                conn.execute(
                    "INSERT INTO account(email,name,password_hash,creator_uid) VALUES(?,?,?,?)",
                    (email, account_name, "synthetic-not-a-password", uid),
                )
            conn.execute(
                "INSERT INTO project_member(project_id,creator_uid,project_role) VALUES('visible',?,?)",
                (uid, roles),
            )
        conn.execute("INSERT INTO creator(uid,name) VALUES('hidden_uid','Hidden')")
        conn.execute(
            "INSERT INTO project_member(project_id,creator_uid,project_role) VALUES('hidden','hidden_uid','project_manager')"
        )
    expected = [
        {"uid": uid, "roles": rbac.parse_project_roles(roles), "name": name}
        for uid, _creator, _account, _email, name in members
    ]
    expected.sort(key=lambda member: (member["name"] is None, member["name"] or "", member["uid"]))
    try:
        yield expected
    finally:
        db.flush_pool()


def _read_visible(kind):
    if kind == "single":
        return projects.list_project_members("visible")
    if kind == "all":
        return projects.list_all_project_members()["visible"]
    return projects.list_project_members_for_projects(["visible"])["visible"]


@pytest.mark.parametrize("kind", ["single", "all", "visible"])
def test_all_paths_use_canonical_names_roles_and_nulls_last_order(member_database, kind):
    actual = _read_visible(kind)
    assert actual == member_database
    assert all(member["name"] != member["uid"] for member in actual)
    assert all("@" not in (member["name"] or "") for member in actual)


@pytest.mark.parametrize("kind", ["single", "all", "visible"])
def test_name_change_is_resolved_again_without_a_member_cache(member_database, kind):
    _read_visible(kind)
    with db.get_connection() as conn:
        conn.execute("UPDATE creator SET name='  A new name  ' WHERE uid='user_email'")
    actual = _read_visible(kind)
    assert actual[0]["uid"] == "user_email"
    assert actual[0]["name"] == "A new name"


def test_project_filter_and_empty_project_contracts_are_preserved(member_database):
    visible = projects.list_project_members_for_projects(["empty", "visible", "visible", "", "missing"])
    assert list(visible) == ["empty", "visible", "missing"]
    assert visible["empty"] == visible["missing"] == []
    assert visible["visible"] == member_database
    assert "hidden" not in visible
    assert projects.list_project_members("empty") == []
    assert projects.list_project_members("missing") == []
    assert set(projects.list_all_project_members()) == {"visible", "hidden"}


def test_empty_project_ids_do_not_open_a_connection():
    with patch.object(projects, "get_connection", side_effect=AssertionError("Unexpected connection")):
        assert projects.list_project_members_for_projects([]) == {}
        assert projects.list_project_members_for_projects(["", ""]) == {}


@pytest.mark.parametrize("kind", ["single", "all", "visible"])
def test_nonempty_member_reads_use_one_resolver_and_three_selects(member_database, kind):
    # 많은 프로젝트가 있어도 이름 해석은 프로젝트별 재조회가 아닌 고정 2쿼리다.
    with db.get_connection() as conn:
        for index in range(30):
            pid = f"extra-{index:02}"
            conn.execute("INSERT INTO project(id,name) VALUES(?,?)", (pid, pid))
            conn.execute(
                "INSERT INTO project_member(project_id,creator_uid,project_role) VALUES(?,'user_email','creator')",
                (pid,),
            )
    statements = []
    connection_count = []
    original_connection = projects.get_connection

    @contextmanager
    def traced_connection():
        connection_count.append(1)
        with original_connection() as conn:
            conn.set_trace_callback(statements.append)
            try:
                yield conn
            finally:
                conn.set_trace_callback(None)

    with patch.object(projects, "get_connection", side_effect=traced_connection), patch.object(
        identity, "resolve_display_names", wraps=identity.resolve_display_names
    ) as resolver:
        if kind == "visible":
            result = projects.list_project_members_for_projects(
                ["visible", "empty", *[f"extra-{index:02}" for index in range(30)]]
            )
            assert len(result) == 32
        else:
            _read_visible(kind)
    selects = [sql for sql in statements if sql.lstrip().upper().startswith("SELECT")]
    assert len(connection_count) == 1
    assert resolver.call_count == 1
    assert len(selects) == 3, selects
