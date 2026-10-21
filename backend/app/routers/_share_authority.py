"""HTTP identity/authority adapter for the single-connection sharing usecase."""
from types import SimpleNamespace
from fastapi import HTTPException
from .. import deps, rbac
from ..repo.final_moves import FinalMoveActor
from ..usecases.share import ShareCommandError

def _actor(conn, request):
    account = deps.current_account(request)
    if deps.AUTH_ENABLED:
        row = conn.execute("SELECT email,creator_uid,global_role,status FROM account WHERE email=?",
                           ((account or {}).get("email"),)).fetchone()
        if not row or row["status"] != "approved":
            raise HTTPException(401, "로그인이 필요합니다")
        account = dict(row)
    fresh = SimpleNamespace(state=SimpleNamespace(account=account))
    # Receipt identity survives acct: -> provider uid remapping.
    key = "acct:" + account["email"].strip().lower() if account else "local"
    return fresh, key


def _authorize(conn, request, gen, kind=None):
    uid = deps.account_actor_uid(request)
    memberships = {r[0] for r in conn.execute("SELECT project_id FROM project_member WHERE creator_uid=?", (uid,))} if uid else set()
    if kind is None:
        account = deps.current_account(request)
        # Re-publishing reads command-state/receipts before writing the same legacy email-owned row.
        if (deps.AUTH_ENABLED and account and not account.get("creator_uid")
                and gen.get("creator_uid") in deps.account_author_uids(account)):
            return
        if not deps.can_view_generation_with_member_projects(request, gen, memberships):
            raise HTTPException(404, "generation 없음")
        return
    if not deps.AUTH_ENABLED:
        return
    roles = deps.account_global_roles(request)
    owner = uid and gen.get("creator_uid") == uid
    admin = rbac.has_global_cap(roles, "system")
    project = gen.get("project_id")
    row = conn.execute("SELECT project_role FROM project_member WHERE project_id=? AND creator_uid=?", (project, uid)).fetchone()
    supervisor = bool(row and rbac.has_any_project_role(row[0], rbac.SUPERVISOR))
    allowed = (owner or admin) if kind == "publish" else ((owner or admin or supervisor) if kind == "unpublish" else (admin or supervisor if project else owner or admin))
    if not allowed:
        raise HTTPException(403, "공유 상태 변경 권한이 없습니다")



def authority(request):
    def load(conn):
        fresh, key = _actor(conn, request)
        uid = deps.account_actor_uid(fresh)
        account = deps.current_account(fresh)
        return SimpleNamespace(
            actor_id=key, shared_by=deps.actor_id(fresh), finalizer=uid,
            author_uids=(deps.account_author_uids(account) if deps.AUTH_ENABLED else None),
            final_actor=(FinalMoveActor(uid, rbac.has_any_global_role(deps.account_global_roles(fresh), rbac.ADMIN)) if deps.AUTH_ENABLED else None),
            authorize=lambda gen, kind=None: _authorize(conn, fresh, gen, kind),
        )
    return load


def http_call(action, *args, **kwargs):
    try:
        return action(*args, **kwargs)
    except ShareCommandError as exc:
        raise HTTPException(404 if exc.reason == "generation_missing" else 403 if exc.reason == "publish_blocked" else 409, exc.reason) from exc
