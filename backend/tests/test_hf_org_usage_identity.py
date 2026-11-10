from app import manage_db
from app.repo import hf_org_usage as repo
from hf_org_usage_fake import world


def link(accounts, actor="user_exact", org="org"):
    with manage_db.get_connection() as conn:
        return repo.reconcile_identity_links(conn, org, {actor}, accounts, repo.now_ms())[actor]


def test_exact_uid_only_and_approved_single_account(world):
    account = dict(email="one@example.test", creator_uid="user_exact", status="approved")
    assert link([account]) == account["email"]
    assert link([dict(account, creator_uid="exact")], org="other") is None
    assert link([dict(account, status="rejected")]) is None
    assert link([account, dict(account, email="two@example.test")]) is None
    assert link([dict(account, creator_uid="acct:one@example.test")], actor="acct:one@example.test") is None
    assert link([dict(account, creator_uid="local")], actor="local") is None


def test_reassignment_conflict_and_organization_separation(world):
    first = dict(email="one@example.test", creator_uid="user_exact", status="approved")
    second = dict(first, email="two@example.test")
    assert link([first]) == first["email"]
    assert link([second]) is None
    assert link([second], org="different") == second["email"]
    with manage_db.get_connection() as conn:
        assert conn.execute("SELECT state FROM hf_org_identity_link WHERE org_id='org'").fetchone()[0] == "conflict"
