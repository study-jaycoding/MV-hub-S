"""로컬 실행 생성요청(gen-request) 데이터 접근.

모델(project_content_hub_push_model): 허브의 생성/재생성 버튼은 서버에 '요청'만 남기고
placeholder 카드를 즉시 만든다. 요청자의 PC 에이전트가 대기 요청을 가져가 **자기 로컬 CLI**로
실행하고, 완료되면 결과를 그 placeholder 에 채운다. 서버는 실행하지 않는다(=DB·중계만).
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any, Optional

from ._common import new_id
from ..db import get_connection
from ..emailnorm import norm_email
from ..workspace_context import normalize_workspace_context
from . import tags
from .generations import RECOVERY_REQUIRED_NOTE


_AMBIGUOUS_ACTIVE_PHASES = (
    "submitting",
    "running",
    "tracking",
    "verifying",
    "blocked",
)


def sweep_expired_generation_claims(
    account_email: Optional[str] = None,
) -> list[dict[str, Any]]:
    """만료 claim을 안전하게 정리한다.

    claimed는 새 에이전트가 아직 CLI 생성 호출을 시작하지 않았다고 서버가 증명할 수 있으므로
    pending으로 되돌린다. submitting 이후 job_id가 없는 요청은 외부 과금 여부를 알 수 없어
    recovery_required로 격리하며 절대 자동 재큐잉하지 않는다. 흔한 빈 폴에서는 읽기만 한다.
    """
    email = norm_email(account_email) if account_email is not None else None
    account_sql = " AND r.account_email=?" if email is not None else ""
    params: tuple[Any, ...] = (email,) if email is not None else ()
    expiry_sql = (
        "((r.lease_expires_at IS NOT NULL AND r.lease_expires_at < datetime('now')) "
        "OR (r.lease_expires_at IS NULL AND r.updated_at < datetime('now','-30 minutes')))"
    )
    phases = ("claimed", *_AMBIGUOUS_ACTIVE_PHASES)
    placeholders = ",".join("?" for _ in phases)
    select_sql = (
        "SELECT r.id, r.gen_id, r.status FROM gen_request r "
        "JOIN generation g ON g.id=r.gen_id "
        f"WHERE r.status IN ({placeholders}) "
        "AND (g.job_id IS NULL OR g.job_id='') AND "
        f"{expiry_sql}{account_sql} ORDER BY r.updated_at, r.id"
    )
    query_params = (*phases, *params)
    transitions: list[dict[str, Any]] = []
    with get_connection() as conn:
        if not conn.execute(select_sql + " LIMIT 1", query_params).fetchone():
            return []
        conn.execute("BEGIN IMMEDIATE")
        rows = conn.execute(select_sql, query_params).fetchall()
        for row in rows:
            if row["status"] == "claimed":
                cur = conn.execute(
                    "UPDATE gen_request SET status='pending', error=NULL, lease_owner=NULL, "
                    "lease_expires_at=NULL, next_check_at=NULL, updated_at=datetime('now') "
                    "WHERE id=? AND status='claimed'",
                    (row["id"],),
                )
                if cur.rowcount:
                    conn.execute(
                        "UPDATE generation SET status='pending', error=NULL "
                        "WHERE id=? AND status IN ('pending','running') "
                        "AND (job_id IS NULL OR job_id='')",
                        (row["gen_id"],),
                    )
                    transitions.append(
                        {
                            "id": row["id"],
                            "gen_id": row["gen_id"],
                            "from_phase": "claimed",
                            "to_phase": "pending",
                            "action": "requeued",
                        }
                    )
                continue
            cur = conn.execute(
                "UPDATE gen_request SET status='recovery_required', error=?, lease_owner=NULL, "
                "lease_expires_at=NULL, next_check_at=NULL, updated_at=datetime('now') "
                f"WHERE id=? AND status IN ({','.join('?' for _ in _AMBIGUOUS_ACTIVE_PHASES)})",
                (RECOVERY_REQUIRED_NOTE, row["id"], *_AMBIGUOUS_ACTIVE_PHASES),
            )
            if cur.rowcount:
                conn.execute(
                    "UPDATE generation SET status='running', error=? "
                    "WHERE id=? AND status IN ('pending','running') "
                    "AND (job_id IS NULL OR job_id='')",
                    (RECOVERY_REQUIRED_NOTE, row["gen_id"]),
                )
                transitions.append(
                    {
                        "id": row["id"],
                        "gen_id": row["gen_id"],
                        "from_phase": row["status"],
                        "to_phase": "recovery_required",
                        "action": "quarantined",
                    }
                )
    return transitions


def begin_request_submission(
    rid: str,
    account_email: str,
    lease_owner: str,
    submission_fingerprint: Optional[dict[str, Any]] = None,
) -> Optional[dict[str, Any]]:
    """claimed 요청을 CLI 호출 직전 submitting으로 전환한다.

    같은 owner의 응답 유실 재시도는 멱등 성공한다. lease가 만료됐거나 다른 에이전트가 다시
    claim한 요청은 거부해 두 프로세스가 같은 유료 생성을 실행하지 못하게 한다.
    """
    email = norm_email(account_email)
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT r.gen_id, r.status, r.lease_owner, r.lease_expires_at, g.job_id "
            "FROM gen_request r JOIN generation g ON g.id=r.gen_id "
            "WHERE r.id=? AND r.account_email=?",
            (rid, email),
        ).fetchone()
        if (
            not row
            or row["status"] not in ("claimed", "submitting")
            or not lease_owner
            or row["lease_owner"] != lease_owner
            or not row["lease_expires_at"]
            or conn.execute(
                "SELECT ? <= datetime('now')", (row["lease_expires_at"],)
            ).fetchone()[0]
            or row["job_id"] not in (None, "")
        ):
            conn.execute("ROLLBACK")
            return None
        transitioned = row["status"] == "claimed"
        encoded_fingerprint = (
            json.dumps(submission_fingerprint, ensure_ascii=False, sort_keys=True)
            if submission_fingerprint
            else None
        )
        if transitioned:
            if encoded_fingerprint:
                # 재큐 뒤 새 제출은 과거 제출의 시각/지문을 물려받으면 안 된다. 실제 create 직전
                # claimed→submitting 전이에서 이번 제출 ledger를 한 번만 새 값으로 확정한다.
                conn.execute(
                    "UPDATE gen_request SET submission_fingerprint=?, "
                    "submission_started_at=datetime('now'), recovery_probe_status=NULL, "
                    "recovery_probe_at=NULL, recovery_probe_matches=0, "
                    "recovery_probe_job_id=NULL WHERE id=?",
                    (encoded_fingerprint, rid),
                )
            conn.execute(
                "UPDATE gen_request SET status='submitting', error=NULL, "
                "submission_started_at=COALESCE(submission_started_at,datetime('now')), "
                "lease_expires_at=datetime('now','+30 minutes'), updated_at=datetime('now') "
                "WHERE id=? AND status='claimed' AND lease_owner=?",
                (rid, lease_owner),
            )
            conn.execute(
                "UPDATE generation SET status='running', error=NULL "
                "WHERE id=? AND status IN ('pending','running')",
                (row["gen_id"],),
            )
        return {"gen_id": row["gen_id"], "transitioned": transitioned}


def release_claimed_request(
    rid: str,
    account_email: str,
    lease_owner: str,
) -> Optional[str]:
    """CLI를 호출하지 않은 staged claim을 같은 owner가 즉시 pending으로 반환한다.

    begin-submission 전이가 서버에 적용됐지만 응답만 모두 유실된 경우에는 상태가 submitting일 수
    있다. 에이전트는 ACK 없이는 CLI를 호출하지 않으므로 같은 owner의 명시 반환은 두 상태 모두
    안전하다.
    """
    email = norm_email(account_email)
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT gen_id FROM gen_request r WHERE id=? AND account_email=? "
            "AND status IN ('claimed','submitting') AND lease_owner=? "
            "AND NOT EXISTS (SELECT 1 FROM generation g WHERE g.id=r.gen_id "
            "AND g.job_id IS NOT NULL AND g.job_id<>'')",
            (rid, email, lease_owner),
        ).fetchone()
        if not row:
            conn.execute("ROLLBACK")
            return None
        conn.execute(
            "UPDATE gen_request SET status='pending', error=NULL, lease_owner=NULL, "
            "lease_expires_at=NULL, updated_at=datetime('now') WHERE id=?",
            (rid,),
        )
        conn.execute(
            "UPDATE generation SET status='pending', error=NULL "
            "WHERE id=? AND status IN ('pending','running') AND (job_id IS NULL OR job_id='')",
            (row["gen_id"],),
        )
        return str(row["gen_id"])


def mark_request_recovery_required(
    rid: str,
    account_email: str,
) -> Optional[dict[str, Any]]:
    """CLI 호출 뒤 job_id를 확보하지 못한 요청을 즉시 수동 복구 상태로 격리한다."""
    email = norm_email(account_email)
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT r.gen_id, r.status FROM gen_request r JOIN generation g ON g.id=r.gen_id "
            "WHERE r.id=? AND r.account_email=? "
            "AND r.status IN ('submitting','running','recovery_required') "
            "AND (g.job_id IS NULL OR g.job_id='')",
            (rid, email),
        ).fetchone()
        if not row:
            conn.execute("ROLLBACK")
            return None
        transitioned = row["status"] != "recovery_required"
        if transitioned:
            conn.execute(
                "UPDATE gen_request SET status='recovery_required', error=?, lease_owner=NULL, "
                "lease_expires_at=NULL, next_check_at=NULL, recovery_probe_status=NULL, "
                "recovery_probe_at=NULL, recovery_probe_matches=0, recovery_probe_job_id=NULL, "
                "updated_at=datetime('now') "
                "WHERE id=?",
                (RECOVERY_REQUIRED_NOTE, rid),
            )
            conn.execute(
                "UPDATE generation SET status='running', error=? "
                "WHERE id=? AND status IN ('pending','running')",
                (RECOVERY_REQUIRED_NOTE, row["gen_id"]),
            )
        return {"gen_id": str(row["gen_id"]), "transitioned": transitioned}


def get_recovery_request_id_for_generation(
    gen_id: str,
    account_email: str,
) -> Optional[str]:
    """화면의 generation id를 같은 계정의 복구 보류 요청 id로 안전하게 해석한다."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT id FROM gen_request WHERE gen_id=? AND account_email=? "
            "AND status='recovery_required' ORDER BY created_at DESC, id DESC LIMIT 1",
            (gen_id, norm_email(account_email)),
        ).fetchone()
    return str(row["id"]) if row else None


def list_recovery_probe_requests(
    account_email: str, limit: int = 16
) -> list[dict[str, Any]]:
    """같은 계정 에이전트가 읽기 전용으로 조사할 지문 보유 복구 요청 목록."""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT r.id, r.gen_id, r.submission_fingerprint, r.submission_started_at, "
            "r.recovery_probe_status, r.recovery_probe_job_id, "
            "r.updated_at recovery_required_at FROM gen_request r "
            "JOIN generation g ON g.id=r.gen_id "
            "WHERE r.account_email=? AND r.status='recovery_required' "
            "AND r.submission_fingerprint IS NOT NULL "
            "AND COALESCE(r.recovery_probe_status,'') <> 'multiple' "
            "AND (g.job_id IS NULL OR g.job_id='') "
            "ORDER BY r.updated_at, r.id LIMIT ?",
            (norm_email(account_email), max(1, min(limit, 100))),
        ).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        try:
            fingerprint = json.loads(row["submission_fingerprint"])
        except (TypeError, ValueError):
            continue
        if not isinstance(fingerprint, dict):
            continue
        out.append(
            {
                "id": str(row["id"]),
                "gen_id": str(row["gen_id"]),
                "fingerprint": fingerprint,
                "submission_started_at": row["submission_started_at"],
                "recovery_required_at": row["recovery_required_at"],
                "recovery_probe_status": row["recovery_probe_status"],
                "recovery_probe_job_id": row["recovery_probe_job_id"],
            }
        )
    return out


def record_recovery_probe_result(
    rid: str,
    account_email: str,
    outcome: str,
    candidate_count: int,
    job_id: str | None = None,
) -> Optional[dict[str, Any]]:
    """읽기 전용 조사 결론만 ledger에 기록한다. job 앵커는 기존 CAS API가 따로 맡는다."""
    if outcome not in {"unique", "multiple", "no_match"}:
        return None
    count = max(0, min(int(candidate_count), 100))
    if (outcome == "unique" and (count != 1 or not job_id)) or (
        outcome == "multiple" and count < 2
    ) or (outcome == "no_match" and count != 0):
        return None
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        current = conn.execute(
            "SELECT recovery_probe_status, COALESCE(recovery_probe_matches,0) matches, "
            "recovery_probe_job_id FROM gen_request WHERE id=? AND account_email=? "
            "AND status='recovery_required' AND EXISTS (SELECT 1 FROM generation g "
            "WHERE g.id=gen_request.gen_id AND (g.job_id IS NULL OR g.job_id=''))",
            (rid, norm_email(account_email)),
        ).fetchone()
        if not current:
            conn.execute("ROLLBACK")
            return None
        # 한 번 찾은 후보 증거를 뒤의 짧은 최신 목록이 지우게 두면 이중 과금 문이 다시 열린다.
        # multiple은 영구 보류, unique는 최초에 저장한 정확한 job_id만 앵커 재시도한다.
        if current["recovery_probe_status"] in {"unique", "multiple"}:
            return {
                "outcome": str(current["recovery_probe_status"]),
                "candidate_count": int(current["matches"]),
                "job_id": current["recovery_probe_job_id"],
            }
        cursor = conn.execute(
            "UPDATE gen_request SET recovery_probe_status=?, recovery_probe_matches=?, "
            "recovery_probe_at=datetime('now'), recovery_probe_job_id=? "
            "WHERE id=? AND account_email=? AND status='recovery_required' "
            "AND EXISTS (SELECT 1 FROM generation g WHERE g.id=gen_request.gen_id "
            "AND (g.job_id IS NULL OR g.job_id=''))",
            (
                outcome,
                count,
                job_id if outcome == "unique" else None,
                rid,
                norm_email(account_email),
            ),
        )
        if cursor.rowcount <= 0:
            conn.execute("ROLLBACK")
            return None
        return {
            "outcome": outcome,
            "candidate_count": count,
            "job_id": job_id if outcome == "unique" else None,
        }


def prepare_recovery_requeue(rid: str, account_email: str) -> dict[str, Any]:
    """최신 자동 조사 결론과 재큐를 한 트랜잭션에서 판정해 후보 발견 레이스를 막는다."""
    email = norm_email(account_email)
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT r.gen_id, r.status, r.submission_fingerprint, r.recovery_probe_status, "
            "COALESCE(r.recovery_probe_matches,0) recovery_probe_matches, "
            "CASE WHEN r.recovery_probe_at >= datetime('now','-2 minutes') THEN 1 ELSE 0 END probe_fresh, "
            "g.job_id FROM gen_request r JOIN generation g ON g.id=r.gen_id "
            "WHERE r.id=? AND r.account_email=?",
            (rid, email),
        ).fetchone()
        if not row:
            conn.execute("ROLLBACK")
            return {"status": "invalid"}
        if row["job_id"]:
            conn.execute("ROLLBACK")
            return {"status": "candidate_found", "gen_id": str(row["gen_id"])}
        if row["status"] != "recovery_required":
            conn.execute("ROLLBACK")
            return {"status": "invalid", "gen_id": str(row["gen_id"])}
        # 새 ledger는 후보가 1개 이상이면 절대 재큐하지 않는다. unique 앵커가 잠시 실패해도
        # 다음 조사에서 이어 붙일 수 있게 보류한다.
        if row["recovery_probe_status"] in {"unique", "multiple"} or row["recovery_probe_matches"] > 0:
            conn.execute("ROLLBACK")
            return {
                "status": "candidate_found",
                "gen_id": str(row["gen_id"]),
                "candidate_count": int(row["recovery_probe_matches"]),
            }
        # 지문 없는 구버전 요청은 조사할 수 없으므로 종전의 명시 확인 동작을 보존한다.
        if row["submission_fingerprint"] and not (
            row["recovery_probe_status"] == "no_match" and row["probe_fresh"]
        ):
            conn.execute("ROLLBACK")
            return {"status": "probe_required", "gen_id": str(row["gen_id"])}
        conn.execute(
            "UPDATE gen_request SET status='pending', error=NULL, provider_status=NULL, "
            "last_checked_at=NULL, next_check_at=NULL, check_failures=0, lease_owner=NULL, "
            "lease_expires_at=NULL, terminal_at=NULL, recovery_probe_status=NULL, "
            "recovery_probe_at=NULL, recovery_probe_matches=0, submission_fingerprint=NULL, "
            "submission_started_at=NULL, recovery_probe_job_id=NULL, updated_at=datetime('now') "
            "WHERE id=?",
            (rid,),
        )
        conn.execute(
            "UPDATE generation SET status='pending', error=NULL "
            "WHERE id=? AND status IN ('pending','running','failed')",
            (row["gen_id"],),
        )
        return {"status": "requeued", "gen_id": str(row["gen_id"])}


def requeue_recovery_request(
    rid: str,
    account_email: str,
) -> Optional[str]:
    """외부 작업이 없음을 사람이 확인한 recovery_required 요청만 명시적으로 재큐잉한다."""
    email = norm_email(account_email)
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT r.gen_id FROM gen_request r JOIN generation g ON g.id=r.gen_id "
            "WHERE r.id=? AND r.account_email=? AND r.status='recovery_required' "
            "AND (g.job_id IS NULL OR g.job_id='')",
            (rid, email),
        ).fetchone()
        if not row:
            conn.execute("ROLLBACK")
            return None
        conn.execute(
            "UPDATE gen_request SET status='pending', error=NULL, provider_status=NULL, "
            "last_checked_at=NULL, next_check_at=NULL, check_failures=0, lease_owner=NULL, "
            "lease_expires_at=NULL, terminal_at=NULL, recovery_probe_status=NULL, "
            "recovery_probe_at=NULL, recovery_probe_matches=0, submission_fingerprint=NULL, "
            "submission_started_at=NULL, recovery_probe_job_id=NULL, updated_at=datetime('now') "
            "WHERE id=?",
            (rid,),
        )
        conn.execute(
            "UPDATE generation SET status='pending', error=NULL "
            "WHERE id=? AND status IN ('pending','running','failed')",
            (row["gen_id"],),
        )
        return str(row["gen_id"])


def gen_recipe(gen_id: str) -> dict[str, Any]:
    """placeholder generation 에서 로컬 CLI 실행에 필요한 레시피를 뽑는다.
    references 의 file_path 는 결과/소스의 원격 URL(공개) — 에이전트가 upload 로 재업로드."""
    with get_connection() as conn:
        g = conn.execute(
            "SELECT model, prompt, params, workspace_scope, workspace_id, workspace_name "
            "FROM generation WHERE id=?",
            (gen_id,),
        ).fetchone()
        if not g:
            return {}
        refs = conn.execute(
            "SELECT r.type type, COALESCE(r.source_url, r.file_path) url, gr.role role "
            "FROM gen_reference gr JOIN reference r ON r.id=gr.reference_id "
            "WHERE gr.generation_id=? "
            "ORDER BY gr.rowid",
            (gen_id,),
        ).fetchall()
    try:
        params = json.loads(g["params"]) if g["params"] else {}
    except (ValueError, TypeError):
        params = {}
    return {
        "model": g["model"],
        "prompt": g["prompt"],
        "params": params,
        "references": [
            {"file_path": r["url"], "type": r["type"], "role": r["role"]} for r in refs
        ],
        "workspace": {
            "scope": g["workspace_scope"] or "unknown",
            "id": g["workspace_id"],
            "name": g["workspace_name"],
        },
    }


def reserve_idempotent_gen_request(
    account_email: str,
    creator_uid: Optional[str],
    kind: str,
    idempotency_key: str,
    contract: dict[str, Any],
) -> dict[str, Any]:
    """일반 생성 의도를 placeholder보다 먼저 예약한다.

    유니크 INSERT 충돌은 같은 계정·키의 기존 예약을 읽어 반환한다. 미리 배정한 gen_id를
    모든 동시 요청이 공유하므로, 요청행뿐 아니라 placeholder도 한 건으로 수렴한다.
    """
    email = norm_email(account_email)
    rid = new_id()
    gen_id = new_id()
    preparing_payload = json.dumps(
        {"_idempotency_contract": contract}, ensure_ascii=False, sort_keys=True
    )
    with get_connection() as conn:
        try:
            conn.execute(
                "INSERT INTO gen_request("
                "id, account_email, creator_uid, gen_id, kind, payload, status, "
                "idempotency_key) VALUES(?,?,?,?,?,?,'preparing',?)",
                (
                    rid,
                    email,
                    creator_uid,
                    gen_id,
                    kind,
                    preparing_payload,
                    idempotency_key,
                ),
            )
        except sqlite3.IntegrityError:
            existing = conn.execute(
                "SELECT id, creator_uid, gen_id, kind, payload, status, idempotency_key "
                "FROM gen_request WHERE account_email=? AND idempotency_key=? LIMIT 1",
                (email, idempotency_key),
            ).fetchone()
            if not existing:
                raise
            result = dict(existing)
            result["created"] = False
            return result
    return {
        "id": rid,
        "creator_uid": creator_uid,
        "gen_id": gen_id,
        "kind": kind,
        "payload": preparing_payload,
        "status": "preparing",
        "idempotency_key": idempotency_key,
        "created": True,
    }


def activate_idempotent_gen_request(
    account_email: str,
    idempotency_key: str,
    gen_id: str,
    payload: dict[str, Any],
    contract: dict[str, Any],
) -> dict[str, Any] | None:
    """placeholder 준비가 끝난 일반 요청 예약을 한 번만 pending으로 활성화한다."""
    encoded_payload = dict(payload)
    encoded_payload["_idempotency_contract"] = contract
    encoded = json.dumps(encoded_payload, ensure_ascii=False, sort_keys=True)
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT id, gen_id, status FROM gen_request "
                "WHERE account_email=? AND idempotency_key=? LIMIT 1",
                (norm_email(account_email), idempotency_key),
            ).fetchone()
            if not row or row["gen_id"] != gen_id:
                conn.execute("ROLLBACK")
                return None
            activated = False
            if row["status"] == "preparing":
                cur = conn.execute(
                    "UPDATE gen_request SET payload=?, status='pending', "
                    "updated_at=datetime('now') WHERE id=? AND status='preparing'",
                    (encoded, row["id"]),
                )
                activated = cur.rowcount > 0
            conn.execute("COMMIT")
            return {
                "id": row["id"],
                "gen_id": row["gen_id"],
                "status": "pending" if activated else row["status"],
                "activated": activated,
            }
        except Exception:
            conn.execute("ROLLBACK")
            raise


def idempotent_placeholder_is_resumable(
    account_email: str,
    creator_uid: Optional[str],
    idempotency_key: str,
    gen_id: str,
    kind: str,
    source_gen_id: Optional[str] = None,
) -> bool:
    """같은 일반 요청 예약의 반쯤 만들어진 placeholder만 이어갈 수 있게 확인한다.
    판정 조건 전체를 JOIN+NOT EXISTS 한 SELECT 로(R6 2-B) — 종전 3~4 SELECT 와 동일
    진리표(코덱스 확정): 요청 preparing 정확 일치·creator(None 이면 생략)·origin=local·
    pending·job_id 없음·타요청 없음(제외키=현재 요청 id)·regenerate 만 lineage."""
    sql = (
        "SELECT 1 FROM gen_request r JOIN generation g ON g.id = r.gen_id "
        "WHERE r.account_email=? AND r.idempotency_key=? AND r.gen_id=? AND r.kind=? "
        "AND r.status='preparing' "
        "AND (? IS NULL OR g.creator_uid=?) "
        "AND g.origin='local' AND g.status='pending' "
        "AND (g.job_id IS NULL OR g.job_id='') "
        "AND NOT EXISTS(SELECT 1 FROM gen_request o WHERE o.gen_id=r.gen_id AND o.id<>r.id) "
    )
    params: list[Any] = [
        norm_email(account_email), idempotency_key, gen_id, kind,
        creator_uid, creator_uid,
    ]
    if kind == "regenerate":
        sql += (
            "AND EXISTS(SELECT 1 FROM history h WHERE h.parent_gen_id=? "
            "AND h.child_gen_id=? AND h.relation='derived') "
        )
        params += [source_gen_id, gen_id]
    with get_connection() as conn:
        return conn.execute(sql + "LIMIT 1", params).fetchone() is not None


def create_gen_request(
    account_email: str,
    creator_uid: Optional[str],
    gen_id: str,
    kind: str,
    payload: dict[str, Any],
    canvas_link: Optional[dict[str, str]] = None,
) -> str:
    """생성요청 1건 등록(placeholder gen 은 호출측에서 이미 만든 상태). 요청 id 반환."""
    rid = new_id()
    with get_connection() as conn:
        link = canvas_link or {}
        conn.execute(
            "INSERT INTO gen_request("
            "id, account_email, creator_uid, gen_id, kind, payload, status, "
            "canvas_attempt_id, canvas_scene_id, canvas_card_id) "
            "VALUES(?,?,?,?,?,?, 'pending',?,?,?)",
            (
                rid,
                norm_email(account_email),
                creator_uid,
                gen_id,
                kind,
                json.dumps(payload, ensure_ascii=False),
                link.get("attempt_id"),
                link.get("scene_id"),
                link.get("card_id"),
            ),
        )
    return rid


def reserve_canvas_gen_request(
    account_email: str,
    creator_uid: Optional[str],
    gen_id: str,
    kind: str,
    canvas_link: dict[str, str],
    contract: dict[str, Any],
) -> dict[str, Any]:
    """캔버스 생성 시도 1건을 placeholder 생성 전에 예약한다.

    gen_request의 (계정, attempt) 유니크 인덱스를 실제 멱등 키로 사용한다. 예약행은
    ``preparing``이라 에이전트가 claim하지 않으며, placeholder와 최종 payload가 모두
    준비된 뒤 :func:`activate_canvas_gen_request`가 ``pending``으로 바꾼다.
    """
    email = norm_email(account_email)
    rid = new_id()
    preparing_payload = json.dumps(
        {"_canvas_contract": contract}, ensure_ascii=False, sort_keys=True
    )
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            existing = conn.execute(
                "SELECT id, creator_uid, gen_id, kind, payload, status, "
                "canvas_attempt_id attempt_id, canvas_scene_id scene_id, "
                "canvas_card_id card_id FROM gen_request "
                "WHERE account_email=? AND canvas_attempt_id=? LIMIT 1",
                (email, canvas_link["attempt_id"]),
            ).fetchone()
            if existing:
                conn.execute("COMMIT")
                result = dict(existing)
                result["created"] = False
                return result
            conn.execute(
                "INSERT INTO gen_request("
                "id, account_email, creator_uid, gen_id, kind, payload, status, "
                "canvas_attempt_id, canvas_scene_id, canvas_card_id) "
                "VALUES(?,?,?,?,?,?,'preparing',?,?,?)",
                (
                    rid,
                    email,
                    creator_uid,
                    gen_id,
                    kind,
                    preparing_payload,
                    canvas_link["attempt_id"],
                    canvas_link["scene_id"],
                    canvas_link["card_id"],
                ),
            )
            conn.execute("COMMIT")
            return {
                "id": rid,
                "creator_uid": creator_uid,
                "gen_id": gen_id,
                "kind": kind,
                "payload": preparing_payload,
                "status": "preparing",
                "attempt_id": canvas_link["attempt_id"],
                "scene_id": canvas_link["scene_id"],
                "card_id": canvas_link["card_id"],
                "created": True,
            }
        except Exception:
            conn.execute("ROLLBACK")
            raise


def activate_canvas_gen_request(
    account_email: str,
    attempt_id: str,
    gen_id: str,
    payload: dict[str, Any],
    contract: dict[str, Any],
) -> dict[str, Any] | None:
    """준비가 끝난 예약을 claim 가능한 pending 요청으로 한 번만 활성화한다."""
    email = norm_email(account_email)
    final_payload = dict(payload)
    # 활성화 뒤 재시도도 처음 요청과 같은 명령인지 확인할 수 있게 내부 계약을 보존한다.
    # 에이전트 claim 응답은 필요한 키만 골라 내보내므로 이 내부 키는 외부 실행에 전달되지 않는다.
    final_payload["_canvas_contract"] = contract
    encoded = json.dumps(final_payload, ensure_ascii=False, sort_keys=True)
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT id, gen_id, status FROM gen_request "
                "WHERE account_email=? AND canvas_attempt_id=? LIMIT 1",
                (email, attempt_id),
            ).fetchone()
            if not row or row["gen_id"] != gen_id:
                conn.execute("ROLLBACK")
                return None
            activated = False
            if row["status"] == "preparing":
                cur = conn.execute(
                    "UPDATE gen_request SET payload=?, status='pending', "
                    "updated_at=datetime('now') WHERE id=? AND status='preparing'",
                    (encoded, row["id"]),
                )
                activated = cur.rowcount > 0
            conn.execute("COMMIT")
            return {
                "id": row["id"],
                "gen_id": row["gen_id"],
                "status": "pending" if activated else row["status"],
                "activated": activated,
            }
        except Exception:
            conn.execute("ROLLBACK")
            raise


def canvas_placeholder_is_resumable(
    account_email: str,
    creator_uid: Optional[str],
    canvas_link: dict[str, str],
    kind: str,
    source_gen_id: Optional[str] = None,
) -> bool:
    """예약과 같은 placeholder를 중단 지점부터 이어도 안전한지 확인한다.
    판정 조건 전체를 한 SELECT 로(R6 2-B) — 일반형과 같은 진리표에 canvas_attempt_id
    일치를 더하고, 타요청 제외키는 현행 그대로 (account_email, canvas_attempt_id) 쌍."""
    email = norm_email(account_email)
    sql = (
        "SELECT 1 FROM gen_request r JOIN generation g ON g.id = r.gen_id "
        "WHERE r.account_email=? AND r.canvas_attempt_id=? AND r.gen_id=? AND r.kind=? "
        "AND r.status='preparing' "
        "AND (? IS NULL OR g.creator_uid=?) "
        "AND g.origin='local' AND g.status='pending' "
        "AND (g.job_id IS NULL OR g.job_id='') "
        "AND NOT EXISTS(SELECT 1 FROM gen_request o WHERE o.gen_id=r.gen_id "
        "AND NOT (o.account_email=? AND o.canvas_attempt_id=?)) "
    )
    params: list[Any] = [
        email, canvas_link["attempt_id"], canvas_link["generation_id"], kind,
        creator_uid, creator_uid,
        email, canvas_link["attempt_id"],
    ]
    if kind == "regenerate":
        sql += (
            "AND EXISTS(SELECT 1 FROM history h WHERE h.parent_gen_id=? "
            "AND h.child_gen_id=? AND h.relation='derived') "
        )
        params += [source_gen_id, canvas_link["generation_id"]]
    with get_connection() as conn:
        return conn.execute(sql + "LIMIT 1", params).fetchone() is not None


def delete_canvas_gen_request_reservation(
    account_email: str,
    attempt_id: str,
    gen_id: str,
) -> bool:
    """준비 실패 시 아직 활성화되지 않은 예약행만 안전하게 제거한다."""
    with get_connection() as conn:
        cur = conn.execute(
            "DELETE FROM gen_request WHERE account_email=? AND canvas_attempt_id=? "
            "AND gen_id=? AND status='preparing'",
            (norm_email(account_email), attempt_id, gen_id),
        )
    return cur.rowcount > 0


def get_canvas_generation_link(account_email: str, attempt_id: str) -> Optional[dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT canvas_attempt_id attempt_id, canvas_scene_id scene_id, "
            "canvas_card_id card_id, gen_id generation_id, status request_status, created_at "
            "FROM gen_request WHERE account_email=? AND canvas_attempt_id=? "
            "AND status<>'preparing' "
            "ORDER BY created_at DESC, id DESC LIMIT 1",
            (norm_email(account_email), attempt_id),
        ).fetchone()
    return dict(row) if row else None


def resolve_canvas_generation_links(
    account_email: str, attempt_ids: list[str]
) -> list[dict[str, Any]]:
    ids = list(dict.fromkeys(attempt_ids))[:200]
    if not ids:
        return []
    placeholders = ",".join("?" for _ in ids)
    with get_connection() as conn:
        # 예약만 남고 placeholder가 만들어지지 않은 장기 중단 흔적은 확정 연결이 아니다.
        # 클라이언트의 2분 복구 유예보다 넉넉히 둔 뒤 정리해 영구 찌꺼기를 막는다.
        conn.execute(
            "DELETE FROM gen_request WHERE account_email=? AND status='preparing' "
            "AND created_at < datetime('now','-10 minutes') "
            "AND NOT EXISTS(SELECT 1 FROM generation g WHERE g.id=gen_request.gen_id)",
            (norm_email(account_email),),
        )
        rows = conn.execute(
            "SELECT canvas_attempt_id attempt_id, canvas_scene_id scene_id, "
            "canvas_card_id card_id, gen_id generation_id, status request_status, created_at "
            f"FROM gen_request WHERE account_email=? AND canvas_attempt_id IN ({placeholders}) "
            "AND status<>'preparing' "
            "ORDER BY created_at, id",
            [norm_email(account_email), *ids],
        ).fetchall()
    return [dict(row) for row in rows]


def list_canvas_generation_candidates(
    account_email: str,
    limit: int = 30,
    owner_uid: str = "",
    creator_uid: str = "",
) -> list[str]:
    """수동 복구 후보 = 어느 카드에도 안 담긴 내 생성물(진짜 고아).

    owner_uid 를 주면 카드 소속표(scene_card_generation)에 이미 담긴 것도 뺀다. 씬을 열 때
    소속이 자동으로 합쳐지므로(sceneCardLinks), 그렇게 채워진 것까지 목록에 남으면 이미
    카드에 잘 있는 생성물이 '빠진 것'처럼 보여 사용자가 중복으로 또 붙이게 된다.
    """
    request_sql = (
        "SELECT r.gen_id, r.created_at sort_at, r.id sort_id "
        "FROM gen_request r JOIN generation g ON g.id=r.gen_id "
        "WHERE r.account_email=? AND r.kind='create' AND r.canvas_attempt_id IS NULL "
        "AND g.deleted_at IS NULL"
    )
    args: list[Any] = [norm_email(account_email)]
    if owner_uid:
        request_sql += (
            " AND NOT EXISTS (SELECT 1 FROM scene_card_generation s "
            "WHERE s.owner_uid=? AND s.generation_id=r.gen_id AND s.removed_at IS NULL)"
        )
        args.append(owner_uid)
    parts = [request_sql]
    synced_owner = creator_uid or owner_uid
    if owner_uid and synced_owner:
        # history/list에서 들어온 순수 synced 행은 요청표가 없다. creator_uid로 본인 소유를
        # 증명하고, 개인 카드 소속표에 아직 없는 행만 같은 수동 복구 목록에 합친다.
        parts.append(
            "SELECT g.id gen_id, g.created_at sort_at, g.id sort_id FROM generation g "
            "WHERE g.origin='synced' AND g.creator_uid=? AND g.deleted_at IS NULL "
            "AND NOT EXISTS (SELECT 1 FROM gen_request r WHERE r.gen_id=g.id) "
            "AND NOT EXISTS (SELECT 1 FROM scene_card_generation s "
            "WHERE s.owner_uid=? AND s.generation_id=g.id AND s.removed_at IS NULL)"
        )
        args.extend((synced_owner, owner_uid))
    sql = "SELECT gen_id FROM (" + " UNION ALL ".join(parts) + ") "
    sql += "ORDER BY sort_at DESC, sort_id DESC LIMIT ?"
    args.append(max(1, min(limit, 100)))
    with get_connection() as conn:
        rows = conn.execute(sql, args).fetchall()
    return list(dict.fromkeys(str(row["gen_id"]) for row in rows if row["gen_id"]))


def claim_canvas_generation_candidate(
    account_email: str,
    generation_id: str,
    scene_id: str,
    card_id: str,
    owner_uid: str = "",
    creator_uid: str = "",
) -> bool:
    attempt_id = "manual_" + uuid.uuid4().hex
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        cursor = conn.execute(
            "UPDATE gen_request SET canvas_attempt_id=?, canvas_scene_id=?, canvas_card_id=?, "
            "updated_at=datetime('now') WHERE id=("
            "SELECT id FROM gen_request WHERE account_email=? AND gen_id=? "
            "AND canvas_attempt_id IS NULL ORDER BY created_at DESC, id DESC LIMIT 1)",
            (attempt_id, scene_id, card_id, norm_email(account_email), generation_id),
        )
        if cursor.rowcount > 0:
            return True

        synced_owner = creator_uid or owner_uid
        if not owner_uid or not synced_owner:
            conn.execute("ROLLBACK")
            return False
        owned = conn.execute(
            "SELECT 1 FROM generation g WHERE g.id=? AND g.origin='synced' "
            "AND g.creator_uid=? AND g.deleted_at IS NULL "
            "AND NOT EXISTS (SELECT 1 FROM gen_request r WHERE r.gen_id=g.id) "
            "AND NOT EXISTS (SELECT 1 FROM scene_card_generation s WHERE s.owner_uid=? "
            "AND s.generation_id=g.id AND s.removed_at IS NULL)",
            (generation_id, synced_owner, owner_uid),
        ).fetchone()
        if not owned:
            conn.execute("ROLLBACK")
            return False
        # gen_request가 없는 행에 가짜 요청을 만들지 않는다. generation 기반 개인 소속표에
        # attempt 앵커를 함께 심어 재조회·다른 브라우저에서도 claim 완료를 알 수 있게 한다.
        cursor = conn.execute(
            "INSERT INTO scene_card_generation"
            "(owner_uid,scene_id,card_id,generation_id,canvas_attempt_id,removed_at) "
            "VALUES(?,?,?,?,?,NULL) ON CONFLICT(owner_uid,scene_id,card_id,generation_id) "
            "DO UPDATE SET canvas_attempt_id=excluded.canvas_attempt_id, removed_at=NULL",
            (owner_uid, scene_id, card_id, generation_id, attempt_id),
        )
        return cursor.rowcount > 0


def repair_orphaned_canvas_generation(
    account_email: str,
    creator_uid: Optional[str],
    canvas_link: dict[str, str],
    payload: dict[str, Any],
) -> bool:
    """placeholder 저장 뒤 요청행 저장 전에 프로세스가 끝난 극소 구간을 복구한다.

    generation 소유자·상태·origin을 한 쓰기 트랜잭션 안에서 재확인하고, 요청행이 전혀 없는
    진짜 orphan만 큐에 넣는다. 다른 계정의 id를 안다고 가져갈 수 없다.
    """
    rid = new_id()
    email = norm_email(account_email)
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            existing = conn.execute(
                "SELECT id, gen_id, kind, payload, status, canvas_scene_id scene_id, "
                "canvas_card_id card_id FROM gen_request "
                "WHERE account_email=? AND canvas_attempt_id=?",
                (email, canvas_link["attempt_id"]),
            ).fetchone()
            if existing and existing["status"] != "preparing":
                exact_existing = bool(
                    existing["gen_id"] == canvas_link["generation_id"]
                    and existing["scene_id"] == canvas_link["scene_id"]
                    and existing["card_id"] == canvas_link["card_id"]
                )
                if exact_existing:
                    conn.execute("COMMIT")
                    return True
                conn.execute("ROLLBACK")
                return False
            generation = conn.execute(
                "SELECT creator_uid, origin, status, job_id FROM generation WHERE id=?",
                (canvas_link["generation_id"],),
            ).fetchone()
            owned_orphan = bool(
                generation
                and generation["creator_uid"] == creator_uid
                and generation["origin"] == "local"
                and generation["status"] == "pending"
                and not generation["job_id"]
                and not conn.execute(
                    "SELECT 1 FROM gen_request WHERE gen_id=? "
                    "AND NOT (account_email=? AND canvas_attempt_id=?) LIMIT 1",
                    (
                        canvas_link["generation_id"],
                        email,
                        canvas_link["attempt_id"],
                    ),
                ).fetchone()
            )
            if not owned_orphan:
                conn.execute("ROLLBACK")
                return False
            if existing:
                exact_reservation = bool(
                    existing["gen_id"] == canvas_link["generation_id"]
                    and existing["scene_id"] == canvas_link["scene_id"]
                    and existing["card_id"] == canvas_link["card_id"]
                )
                if not exact_reservation:
                    conn.execute("ROLLBACK")
                    return False
                try:
                    preparing = json.loads(existing["payload"] or "{}")
                except (TypeError, ValueError):
                    preparing = {}
                contract = preparing.get("_canvas_contract")
                final_payload = dict(payload)
                if contract:
                    final_payload["_canvas_contract"] = contract
                    final_payload["source_gen_id"] = contract.get("source_gen_id")
                else:
                    final_payload.setdefault("source_gen_id", None)
                if existing["kind"] == "regenerate":
                    source_gen_id = final_payload.get("source_gen_id")
                    lineage = conn.execute(
                        "SELECT 1 FROM history WHERE parent_gen_id=? AND child_gen_id=? "
                        "AND relation='derived' LIMIT 1",
                        (source_gen_id, canvas_link["generation_id"]),
                    ).fetchone()
                    if not lineage:
                        conn.execute("ROLLBACK")
                        return False
                    # import_generation 직후, 옵션 덮어쓰기 전에 종료된 경우도 최초 명령대로
                    # 복구한다. 이 보정과 pending 활성화를 같은 쓰기 트랜잭션에 둔다.
                    regenerate = (contract or {}).get("regenerate") or {}
                    color = regenerate.get("color")
                    prompt = regenerate.get("prompt")
                    model = regenerate.get("model")
                    if color is not None:
                        conn.execute(
                            "UPDATE generation SET color=? WHERE id=?",
                            (color, canvas_link["generation_id"]),
                        )
                    if prompt or model:
                        conn.execute(
                            "UPDATE generation SET prompt=COALESCE(?,prompt), "
                            "model=COALESCE(?,model), "
                            "display_prompt=CASE WHEN ? IS NOT NULL "
                            "THEN NULL ELSE display_prompt END WHERE id=?",
                            (prompt, model, prompt, canvas_link["generation_id"]),
                        )
                        if prompt:
                            final_payload["prompt"] = prompt
                        if model:
                            final_payload["model"] = model
                    if regenerate.get("auto_tags"):
                        tags._set_auto_tags(
                            conn,
                            canvas_link["generation_id"],
                            regenerate["auto_tags"],
                        )
                conn.execute(
                    "UPDATE gen_request SET payload=?, status='pending', "
                    "updated_at=datetime('now') WHERE id=? AND status='preparing'",
                    (
                        json.dumps(final_payload, ensure_ascii=False, sort_keys=True),
                        existing["id"],
                    ),
                )
                conn.execute("COMMIT")
                return True
            conn.execute(
                "INSERT INTO gen_request("
                "id, account_email, creator_uid, gen_id, kind, payload, status, "
                "canvas_attempt_id, canvas_scene_id, canvas_card_id) "
                "VALUES(?,?,?,?,?,?, 'pending',?,?,?)",
                (
                    rid,
                    email,
                    creator_uid,
                    canvas_link["generation_id"],
                    "create",
                    json.dumps(payload, ensure_ascii=False),
                    canvas_link["attempt_id"],
                    canvas_link["scene_id"],
                    canvas_link["card_id"],
                ),
            )
            conn.execute("COMMIT")
            return True
        except Exception:
            conn.execute("ROLLBACK")
            raise


def has_pending_requests(
    account_email: str,
    *,
    workspace_capable: bool = False,
) -> bool:
    """쓰기 상태를 바꾸지 않고 이 계정에서 실행 가능한 대기 요청 존재만 확인한다."""
    ws_gate = (
        "" if workspace_capable else
        " AND NOT (json_valid(payload) AND "
        "lower(coalesce(json_extract(payload, '$.workspace.scope'), '')) IN ('team','personal'))"
    )
    with get_connection() as conn:
        row = conn.execute(
            "SELECT 1 FROM gen_request "
            f"WHERE account_email=? AND status='pending'{ws_gate} LIMIT 1",
            (norm_email(account_email),),
        ).fetchone()
    return row is not None


def claim_pending_requests(
    account_email: str,
    limit: int = 16,
    *,
    workspace_capable: bool = False,
    lease_owner: Optional[str] = None,
    submission_stage_capable: bool = False,
    sweep_expired: bool = True,
) -> list[dict[str, Any]]:
    """이 계정의 대기 요청을 원자적으로 claim한다.

    신 에이전트(submission_stage_capable)는 CLI 호출 전임을 증명할 수 있는 claimed 상태로 받고,
    구 에이전트는 호환을 위해 기존 submitting 상태로 받는다. limit는 호출자가 현재 제출 가능한
    수만큼 전달한다.
    반환: [{id, gen_id, kind, model, prompt, params, references}].

    workspace_capable: 에이전트가 제출 전 워크스페이스 전환·검증을 할 수 있는지(?capability=workspace).
    False(구 에이전트)면 워크스페이스가 지정된(team/personal) 요청은 건너뛴다 — 구 에이전트는
    지정을 무시하고 현재 CLI 워크스페이스에서 실행해 다른 팀 크레딧으로 과금될 수 있다.
    건너뛴 요청은 pending 으로 남아 에이전트 업데이트 후 처리된다(SERVER.md 롤아웃 예외 참고).

    lease_owner: 요청을 선점한 에이전트 인스턴스. 제출 도중 에이전트가 끊긴 요청을 구분한다.
    sweep_expired: 직접 호출자의 안전망. usecase는 전이 알림을 위해 먼저 별도 sweep하고 False로 호출한다.
    """
    email = norm_email(account_email)
    out: list[dict[str, Any]] = []
    if sweep_expired:
        sweep_expired_generation_claims(email)
    # 비-capable(구) 에이전트는 워크스페이스 지정(team/personal) 요청을 SQL 에서 제외하고
    # 고른다 — Python 측 상한 스캔이면 지정 요청이 상한 이상 쌓였을 때 뒤의 일반 요청이
    # 영구히 굶는다. 손상된 payload(json_valid 실패)는 기존 파싱 실패와 동일하게 일반
    # 요청(unknown) 취급. capable 에이전트는 전부 claim 가능.
    ws_gate = (
        "" if workspace_capable else
        " AND NOT (json_valid(payload) AND "
        "lower(coalesce(json_extract(payload, '$.workspace.scope'), '')) IN ('team','personal'))"
    )
    with get_connection() as conn:
        # 빈 폴은 가장 흔한 경로다. 먼저 읽기로 claim 가능한 pending 존재만 확인해, 0건이면
        # BEGIN IMMEDIATE(전역 쓰기락)를 잡지 않고 끝낸다. 이 읽기와 실제 claim 사이의 레이스는
        # 무해하다 — 새 요청을 못 본 경우에도 다음 폴에서 claim한다.
        has_pending = conn.execute(
            "SELECT 1 FROM gen_request "
            f"WHERE account_email=? AND status='pending'{ws_gate} LIMIT 1",
            (email,),
        ).fetchone()
        if not has_pending:
            return []
        # ★원자 claim: 커넥션이 autocommit(isolation_level=None)이라 SELECT→UPDATE 사이에 트랜잭션
        # 경계가 없으면, 같은 계정의 에이전트/폴 둘이 동시에 같은 pending 행을 SELECT→둘 다 running 으로
        # 표시→로컬 CLI 가 두 번 실행돼 크레딧이 이중 소모된다. BEGIN IMMEDIATE 로 즉시 쓰기락을 잡아
        # SELECT+UPDATE 를 한 트랜잭션으로 직렬화한다(둘째 폴은 busy_timeout 대기 후 running 을 보고 건너뜀).
        conn.execute("BEGIN IMMEDIATE")
        rows = conn.execute(
            "SELECT id, gen_id, kind, payload FROM gen_request "
            f"WHERE account_email=? AND status='pending'{ws_gate} "
            "ORDER BY created_at, rowid LIMIT ?",
            (email, limit),
        ).fetchall()
        claim_phase = "claimed" if submission_stage_capable and lease_owner else "submitting"
        for r in rows:
            conn.execute(
                "UPDATE gen_request SET status=?, error=NULL, lease_owner=?, "
                "lease_expires_at=datetime('now','+30 minutes'), updated_at=datetime('now') WHERE id=?",
                (claim_phase, lease_owner, r["id"]),
            )
    # payload 파싱은 트랜잭션(쓰기락) 밖에서 — 락 보유 시간을 SELECT+UPDATE 만으로 최소화.
    for r in rows:
        try:
            p = json.loads(r["payload"]) if r["payload"] else {}
        except (ValueError, TypeError):
            p = {}
        out.append(
            {
                "id": r["id"],
                "gen_id": r["gen_id"],
                "kind": r["kind"],
                "model": p.get("model"),
                "prompt": p.get("prompt"),
                "params": p.get("params") or {},
                "references": p.get("references") or [],
                "workspace": normalize_workspace_context(p.get("workspace")),
                "claim_phase": claim_phase,
            }
        )
    return out


def get_gen_request(rid: str) -> Optional[dict[str, Any]]:
    with get_connection() as conn:
        r = conn.execute("SELECT * FROM gen_request WHERE id=?", (rid,)).fetchone()
    return dict(r) if r else None


def mark_request(rid: str, status: str, error: Optional[str] = None) -> None:
    with get_connection() as conn:
        conn.execute(
            "UPDATE gen_request SET status=?, error=?, "
            "terminal_at=CASE WHEN ? IN ('done','failed','canceled') THEN datetime('now') ELSE terminal_at END, "
            "updated_at=datetime('now') WHERE id=?",
            (status, error, status, rid),
        )


def record_request_check(
    rid: str,
    provider_status: Optional[str],
    *,
    phase: str,
    error: Optional[str] = None,
    check_failed: bool = False,
    next_seconds: int = 30,
) -> bool:
    """권위 조회 결과와 다음 확인 시각을 기록한다. terminal 요청은 절대 되돌리지 않는다."""
    if phase not in {"tracking", "verifying", "blocked"}:
        phase = "verifying"
    with get_connection() as conn:
        cur = conn.execute(
            "UPDATE gen_request SET status=?, provider_status=?, error=?, "
            "last_checked_at=datetime('now'), "
            "next_check_at=datetime('now', ?), "
            "check_failures=CASE WHEN ? THEN check_failures+1 ELSE 0 END, "
            "lease_expires_at=datetime('now','+5 minutes'), updated_at=datetime('now') "
            "WHERE id=? AND status NOT IN ('done','failed','canceled')",
            (phase, provider_status, error, f"+{max(1, next_seconds)} seconds", int(check_failed), rid),
        )
    return cur.rowcount > 0
