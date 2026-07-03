"""로컬 실행 생성요청(gen-request) 데이터 접근.

모델(project_content_hub_push_model): 허브의 생성/재생성 버튼은 서버에 '요청'만 남기고
placeholder 카드를 즉시 만든다. 요청자의 PC 에이전트가 대기 요청을 가져가 **자기 로컬 CLI**로
실행하고, 완료되면 결과를 그 placeholder 에 채운다. 서버는 실행하지 않는다(=DB·중계만).
"""

from __future__ import annotations

import json
from typing import Any, Optional

from ._common import new_id
from ..db import get_connection


def gen_recipe(gen_id: str) -> dict[str, Any]:
    """placeholder generation 에서 로컬 CLI 실행에 필요한 레시피를 뽑는다.
    references 의 file_path 는 결과/소스의 원격 URL(공개) — 에이전트가 upload 로 재업로드."""
    with get_connection() as conn:
        g = conn.execute(
            "SELECT model, prompt, params FROM generation WHERE id=?", (gen_id,)
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
    }


def create_gen_request(
    account_email: str,
    creator_uid: Optional[str],
    gen_id: str,
    kind: str,
    payload: dict[str, Any],
) -> str:
    """생성요청 1건 등록(placeholder gen 은 호출측에서 이미 만든 상태). 요청 id 반환."""
    rid = new_id()
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO gen_request(id, account_email, creator_uid, gen_id, kind, payload, status) "
            "VALUES(?,?,?,?,?,?, 'pending')",
            (rid, (account_email or "").strip().lower(), creator_uid, gen_id, kind,
             json.dumps(payload, ensure_ascii=False)),
        )
    return rid


def claim_pending_requests(account_email: str, limit: int = 16) -> list[dict[str, Any]]:
    """이 계정의 대기 요청을 가져오면서 running 으로 표시(claim) — 중복 실행 방지.
    limit=16 은 에이전트 병렬도(push_agent _MAX_CONCURRENCY)와 맞춤 — team 플랜 16 병렬 한 번에 claim.
    반환: [{id, gen_id, kind, model, prompt, params, references}]."""
    email = (account_email or "").strip().lower()
    out: list[dict[str, Any]] = []
    with get_connection() as conn:
        # ★원자 claim: 커넥션이 autocommit(isolation_level=None)이라 SELECT→UPDATE 사이에 트랜잭션
        # 경계가 없으면, 같은 계정의 에이전트/폴 둘이 동시에 같은 pending 행을 SELECT→둘 다 running 으로
        # 표시→로컬 CLI 가 두 번 실행돼 크레딧이 이중 소모된다. BEGIN IMMEDIATE 로 즉시 쓰기락을 잡아
        # SELECT+UPDATE 를 한 트랜잭션으로 직렬화한다(둘째 폴은 busy_timeout 대기 후 running 을 보고 건너뜀).
        conn.execute("BEGIN IMMEDIATE")
        # ★stale running 회수 — 에이전트가 claim 후 죽으면(프로세스 종료·보고 유실) running 이
        # 영영 남는다(부팅 정리는 generation 만 다룸). CLI create 타임아웃(900s)+여유를 넘긴
        # running 은 실패로 종결해 카드가 '생성중'에 멈추지 않게 한다. 재큐잉(pending 복귀)은
        # 원본이 실제로 완료됐는데 보고만 유실된 경우 이중 과금이라 하지 않는다 — 사용자가 재시도.
        for stale in conn.execute(
            "SELECT id, gen_id FROM gen_request WHERE account_email=? AND status='running' "
            "AND updated_at < datetime('now','-30 minutes')",
            (email,),
        ).fetchall():
            conn.execute(
                "UPDATE gen_request SET status='failed', "
                "error='에이전트 응답 없음(30분 초과) — 에이전트 상태 확인 후 다시 시도하세요', "
                "updated_at=datetime('now') WHERE id=?",
                (stale["id"],),
            )
            if stale["gen_id"]:
                conn.execute(
                    "UPDATE generation SET status='failed', "
                    "error='에이전트 응답 없음(30분 초과)' WHERE id=? AND status IN ('pending','running')",
                    (stale["gen_id"],),
                )
        rows = conn.execute(
            "SELECT id, gen_id, kind, payload FROM gen_request "
            "WHERE account_email=? AND status='pending' ORDER BY created_at LIMIT ?",
            (email, limit),
        ).fetchall()
        for r in rows:
            conn.execute(
                "UPDATE gen_request SET status='running', updated_at=datetime('now') WHERE id=?",
                (r["id"],),
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
            "UPDATE gen_request SET status=?, error=?, updated_at=datetime('now') WHERE id=?",
            (status, error, rid),
        )
