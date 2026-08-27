"""공유 서버 권위 상태와 로컬 미러 사이의 desired-state 원장.

라우트와 다음 배치의 reconciler가 같은 CAS 규율을 쓰도록 write-ahead 등록, claim/lease,
로컬 상태 적용+종결을 이 모듈에 모은다. 원장은 명령 재생 목록이 아니라 서버 관측 뒤 로컬을
수렴시키기 위한 최신 의도 한 행이다.
"""

from __future__ import annotations

import asyncio
import json
import threading
from contextlib import asynccontextmanager, contextmanager
from typing import Any, Iterable, Iterator, Mapping, Optional
from urllib.parse import urlsplit, urlunsplit

from ..config import DEFAULT_WORKER_ID, MEDIA_PRESERVATION_ENABLED
from ..db import get_connection
from ._common import new_id


SHARE_STATE_OPERATION_KINDS = frozenset(
    {"publish", "unpublish", "finalize", "unfinalize", "composite_finalize"}
)
SHARE_STATE_STATUSES = frozenset(
    {
        "prepared",
        "pending",
        "waiting_local",
        "auth_required",
        "converged",
        "superseded",
        "blocked",
        "rejected",
    }
)
SHARE_STATE_TERMINAL_STATUSES = frozenset(
    {"converged", "superseded", "blocked", "rejected"}
)
SHARE_STATE_APPLY_APPLIED = "applied"
SHARE_STATE_APPLY_CAS_LOST = "cas_lost"
SHARE_STATE_APPLY_NO_TARGET = "no_target"
_CLAIMABLE_STATUSES = ("prepared", "pending", "waiting_local", "auth_required")
_UNSET = object()


def normalize_share_server_origin(origin: str) -> str:
    """동일 공유 서버 URL의 대소문자·끝 슬래시·기본 포트 차이를 한 identity로 만든다."""
    raw = str(origin or "").strip().rstrip("/")
    parsed = urlsplit(raw)
    if not parsed.scheme or not parsed.hostname:
        raise ValueError("공유 서버 URL이 올바르지 않습니다")
    scheme = parsed.scheme.lower()
    hostname = parsed.hostname.lower()
    if ":" in hostname and not hostname.startswith("["):
        hostname = f"[{hostname}]"
    port = parsed.port
    if port is not None and not (
        (scheme == "http" and port == 80) or (scheme == "https" and port == 443)
    ):
        hostname = f"{hostname}:{port}"
    path = parsed.path.rstrip("/")
    return urlunsplit((scheme, hostname, path, "", ""))


def share_state_identity_key(
    server_origin: str,
    *,
    server_generation_id: Optional[str] = None,
    job_anchor: Optional[str] = None,
) -> str:
    """프로세스 내 사용자 액션 직렬화에 쓰는 정규 identity 키."""
    remote_id = str(server_generation_id or job_anchor or "").strip()
    if not remote_id:
        raise ValueError("server_generation_id 또는 job_anchor가 필요합니다")
    return f"{normalize_share_server_origin(server_origin)}\0{remote_id}"


_ACTION_LOCK_GUARD = threading.Lock()
_ACTION_LOCKS: dict[str, tuple[threading.RLock, int]] = {}
_ASYNC_ACTION_LOCKS: dict[tuple[int, str], tuple[asyncio.Lock, int]] = {}


@contextmanager
def share_state_action_locks(identity_keys: Iterable[str]) -> Iterator[None]:
    """여러 생성물 액션을 결정적 순서로 잠가 교차 요청과 reconciler의 경합을 막는다.

    현재 mutation 라우트가 FastAPI 동기 핸들러이므로 RLock을 쓴다. 3b async 워커는 한 건의
    claim→관측→적용 작업 전체를 ``asyncio.to_thread``에서 이 컨텍스트로 감싸 같은 잠금을 쓴다.
    """
    keys = sorted({str(key) for key in identity_keys if key})
    held: list[tuple[str, threading.RLock]] = []
    with _ACTION_LOCK_GUARD:
        for key in keys:
            lock, users = _ACTION_LOCKS.get(key, (threading.RLock(), 0))
            _ACTION_LOCKS[key] = (lock, users + 1)
            held.append((key, lock))
    acquired: list[threading.RLock] = []
    try:
        for _, lock in held:
            lock.acquire()
            acquired.append(lock)
        yield
    finally:
        for lock in reversed(acquired):
            lock.release()
        with _ACTION_LOCK_GUARD:
            for key, lock in held:
                current_lock, users = _ACTION_LOCKS.get(key, (lock, 1))
                if current_lock is lock and users <= 1:
                    _ACTION_LOCKS.pop(key, None)
                elif current_lock is lock:
                    _ACTION_LOCKS[key] = (lock, users - 1)


@asynccontextmanager
async def async_share_state_action_locks(identity_keys: Iterable[str]):
    """3b reconciler용 asyncio per-key lock + 동기 mutation 라우트 공통 게이트.

    asyncio task끼리는 ``asyncio.Lock``으로 직렬화하고, 잠금 보유 구간에는 별도 스레드가
    기존 RLock도 함께 잡는다. 따라서 현재 동기 FastAPI mutation과 다음 배치의 async worker가
    같은 identity에서 동시에 서버 관측/적용을 진행하지 않는다.
    """
    keys = sorted({str(key) for key in identity_keys if key})
    loop = asyncio.get_running_loop()
    loop_id = id(loop)
    registered: list[tuple[tuple[int, str], asyncio.Lock]] = []
    with _ACTION_LOCK_GUARD:
        for key in keys:
            registry_key = (loop_id, key)
            lock, users = _ASYNC_ACTION_LOCKS.get(
                registry_key, (asyncio.Lock(), 0)
            )
            _ASYNC_ACTION_LOCKS[registry_key] = (lock, users + 1)
            registered.append((registry_key, lock))

    acquired_async: list[asyncio.Lock] = []
    gate_acquired = threading.Event()
    gate_release = threading.Event()

    def _hold_sync_gate() -> None:
        with share_state_action_locks(keys):
            gate_acquired.set()
            gate_release.wait()

    holder: asyncio.Task[None] | None = None
    cleanup_error: BaseException | None = None
    try:
        for _, lock in registered:
            await lock.acquire()
            acquired_async.append(lock)
        holder = asyncio.create_task(
            asyncio.to_thread(_hold_sync_gate), name="share-state-identity-gate"
        )
        await asyncio.to_thread(gate_acquired.wait)
        yield
    finally:
        gate_release.set()
        if holder is not None:
            try:
                await asyncio.shield(holder)
            except BaseException as exc:  # 취소여도 아래 lock/registry 정리를 먼저 끝낸다.
                cleanup_error = exc
                if isinstance(exc, asyncio.CancelledError):
                    # 게이트 스레드가 RLock을 해제할 때까지 기다려 다음 액션을 막지 않는다.
                    try:
                        await asyncio.shield(holder)
                    except BaseException:
                        pass
        for lock in reversed(acquired_async):
            lock.release()
        with _ACTION_LOCK_GUARD:
            for registry_key, lock in registered:
                current_lock, users = _ASYNC_ACTION_LOCKS.get(registry_key, (lock, 1))
                if current_lock is lock and users <= 1:
                    _ASYNC_ACTION_LOCKS.pop(registry_key, None)
                elif current_lock is lock:
                    _ASYNC_ACTION_LOCKS[registry_key] = (lock, users - 1)
        if cleanup_error is not None:
            raise cleanup_error


_UPSERT_INTENT_SQL = """
INSERT INTO share_state_intent(
    intent_id, server_origin, server_generation_id, job_anchor, local_id,
    operation_kind, desired_shared, desired_final, base_shared, base_final,
    expected_final_by, intent_seq, status, claim_token, lease_until,
    fail_streak, next_retry_at, last_error_code, observed_state_json, observed_at,
    created_at, updated_at, last_attempt_at
)
VALUES(
    COALESCE((
        SELECT intent_id FROM share_state_intent
        WHERE server_origin=? AND (
            (? IS NOT NULL AND server_generation_id=?) OR
            (? IS NOT NULL AND job_anchor=?)
        )
        ORDER BY (server_generation_id IS NOT NULL) DESC, intent_seq DESC
        LIMIT 1
    ), ?),
    ?,?,?,?,?,?,?,?,?,?,?, 'prepared', ?, datetime('now', ?),
    0, NULL, NULL, NULL, NULL, datetime('now'), datetime('now'), NULL
)
ON CONFLICT DO UPDATE SET
    server_generation_id=COALESCE(excluded.server_generation_id, share_state_intent.server_generation_id),
    job_anchor=COALESCE(excluded.job_anchor, share_state_intent.job_anchor),
    local_id=COALESCE(excluded.local_id, share_state_intent.local_id),
    operation_kind=excluded.operation_kind,
    desired_shared=excluded.desired_shared,
    desired_final=excluded.desired_final,
    base_shared=excluded.base_shared,
    base_final=excluded.base_final,
    expected_final_by=excluded.expected_final_by,
    intent_seq=share_state_intent.intent_seq+1,
    status='prepared',
    claim_token=excluded.claim_token,
    lease_until=excluded.lease_until,
    fail_streak=0,
    next_retry_at=NULL,
    last_error_code=NULL,
    observed_state_json=NULL,
    observed_at=NULL,
    updated_at=datetime('now'),
    last_attempt_at=NULL
"""


def _clean_optional(value: Any) -> Optional[str]:
    cleaned = str(value or "").strip()
    return cleaned or None


def _intent_params(
    server_origin: str,
    item: Mapping[str, Any],
    *,
    lease_seconds: int,
) -> tuple[list[Any], str]:
    operation_kind = str(item.get("operation_kind") or "").strip()
    if operation_kind not in SHARE_STATE_OPERATION_KINDS:
        raise ValueError(f"지원하지 않는 원장 작업: {operation_kind}")
    server_generation_id = _clean_optional(item.get("server_generation_id"))
    job_anchor = _clean_optional(item.get("job_anchor"))
    if not server_generation_id and not job_anchor:
        raise ValueError("server_generation_id 또는 job_anchor가 필요합니다")
    desired_shared = bool(item.get("desired_shared"))
    desired_final = bool(item.get("desired_final"))
    if desired_final and not desired_shared:
        raise ValueError("최종 상태는 공유 상태여야 합니다")
    claim_token = new_id()
    candidate_id = new_id()
    modifier = f"+{max(int(lease_seconds), 1)} seconds"
    params = [
        server_origin,
        server_generation_id,
        server_generation_id,
        job_anchor,
        job_anchor,
        candidate_id,
        server_origin,
        server_generation_id,
        job_anchor,
        _clean_optional(item.get("local_id")),
        operation_kind,
        int(desired_shared),
        int(desired_final),
        int(bool(item.get("base_shared"))),
        int(bool(item.get("base_final"))),
        _clean_optional(item.get("expected_final_by")),
        1,
        claim_token,
        modifier,
    ]
    return params, claim_token


def prepare_share_state_intents(
    server_origin: str,
    intents: Iterable[Mapping[str, Any]],
    *,
    lease_seconds: int = 120,
) -> list[dict[str, Any]]:
    """대상 전부를 한 트랜잭션에서 prepared로 UPSERT한다.

    각 UPSERT 한 문장이 기존 identity를 찾고 ``intent_seq=intent_seq+1``까지 수행한다. 새 의도는
    claim token도 교체하므로 옛 라우트/워커의 늦은 CAS가 즉시 무효가 된다.
    """
    origin = normalize_share_server_origin(server_origin)
    items = list(intents)
    if not items:
        return []
    refs: list[dict[str, Any]] = []
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            for item in items:
                server_generation_id = _clean_optional(item.get("server_generation_id"))
                job_anchor = _clean_optional(item.get("job_anchor"))
                if server_generation_id and job_anchor:
                    # UUID-only 팀 카드 의도와 anchor-only 내 카드 의도가 먼저 따로 생긴 뒤
                    # mutation 응답에서 둘의 관계가 밝혀질 수 있다. 이때 두 최신행을 남기지 않고
                    # 더 높은 seq 행 하나로 합친 뒤 아래 단일 UPSERT가 그 seq를 원자 증가시킨다.
                    matches = conn.execute(
                        "SELECT intent_id, intent_seq, updated_at FROM share_state_intent "
                        "WHERE server_origin=? AND (server_generation_id=? OR job_anchor=?) "
                        "ORDER BY intent_seq DESC, updated_at DESC, intent_id",
                        (origin, server_generation_id, job_anchor),
                    ).fetchall()
                    if len(matches) > 1:
                        conn.executemany(
                            "DELETE FROM share_state_intent WHERE intent_id=?",
                            [(row["intent_id"],) for row in matches[1:]],
                        )
                params, claim_token = _intent_params(
                    origin, item, lease_seconds=lease_seconds
                )
                conn.execute(_UPSERT_INTENT_SQL, params)
                row = conn.execute(
                    "SELECT * FROM share_state_intent WHERE claim_token=?",
                    (claim_token,),
                ).fetchone()
                if row is None:
                    raise RuntimeError("원장 prepared 행을 다시 찾지 못했습니다")
                refs.append(dict(row))
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    return refs


def prepare_share_state_intent(
    server_origin: str,
    *,
    server_generation_id: Optional[str] = None,
    job_anchor: Optional[str] = None,
    local_id: Optional[str] = None,
    operation_kind: str,
    desired_shared: bool,
    desired_final: bool,
    base_shared: bool,
    base_final: bool,
    expected_final_by: Optional[str] = None,
    lease_seconds: int = 120,
) -> dict[str, Any]:
    return prepare_share_state_intents(
        server_origin,
        [
            {
                "server_generation_id": server_generation_id,
                "job_anchor": job_anchor,
                "local_id": local_id,
                "operation_kind": operation_kind,
                "desired_shared": desired_shared,
                "desired_final": desired_final,
                "base_shared": base_shared,
                "base_final": base_final,
                "expected_final_by": expected_final_by,
            }
        ],
        lease_seconds=lease_seconds,
    )[0]


def get_share_state_intent(intent_id: str) -> Optional[dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM share_state_intent WHERE intent_id=?", (intent_id,)
        ).fetchone()
    return dict(row) if row else None


def transition_share_state_intent(
    intent_id: str,
    intent_seq: int,
    claim_token: str,
    status: str,
    *,
    server_generation_id: Any = _UNSET,
    job_anchor: Any = _UNSET,
    local_id: Any = _UNSET,
    observed_state: Any = _UNSET,
    next_retry_at: Any = _UNSET,
    last_error_code: Any = _UNSET,
    increment_fail_streak: bool = False,
) -> bool:
    """현재 seq+claim 소유자만 상태와 관측치를 바꾸는 단일 UPDATE CAS."""
    if status not in SHARE_STATE_STATUSES:
        raise ValueError(f"지원하지 않는 원장 상태: {status}")
    assignments = ["status=?", "updated_at=datetime('now')", "last_attempt_at=datetime('now')"]
    params: list[Any] = [status]
    optional = (
        ("server_generation_id", server_generation_id),
        ("job_anchor", job_anchor),
        ("local_id", local_id),
        ("next_retry_at", next_retry_at),
        ("last_error_code", last_error_code),
    )
    for column, value in optional:
        if value is not _UNSET:
            assignments.append(f"{column}=?")
            params.append(_clean_optional(value))
    if observed_state is not _UNSET:
        assignments.extend(["observed_state_json=?", "observed_at=datetime('now')"])
        params.append(
            json.dumps(observed_state, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            if observed_state is not None
            else None
        )
    if increment_fail_streak:
        assignments.append("fail_streak=fail_streak+1")
    if status in SHARE_STATE_TERMINAL_STATUSES:
        assignments.extend(["claim_token=NULL", "lease_until=NULL", "next_retry_at=NULL"])
    elif status in {"waiting_local", "auth_required"}:
        assignments.extend(["claim_token=NULL", "lease_until=NULL"])
    params.extend([intent_id, int(intent_seq), claim_token])
    with get_connection() as conn:
        cursor = conn.execute(
            f"UPDATE share_state_intent SET {', '.join(assignments)} "
            "WHERE intent_id=? AND intent_seq=? AND claim_token=?",
            params,
        )
        return cursor.rowcount == 1


def mark_share_state_intent_waiting_local(
    intent_id: str,
    intent_seq: int,
    claim_token: str,
    *,
    error_code: str = "local_mirror_failed",
    next_retry_at: Optional[str] = None,
) -> bool:
    return transition_share_state_intent(
        intent_id,
        intent_seq,
        claim_token,
        "waiting_local",
        next_retry_at=next_retry_at,
        last_error_code=error_code,
        increment_fail_streak=True,
    )


def claim_due_share_state_intents(
    claim_token: str,
    *,
    limit: int = 10,
    lease_seconds: int = 120,
    now: Optional[str] = None,
    server_origin: Optional[str] = None,
) -> list[dict[str, Any]]:
    """due 조회와 여러 행 claim을 한 BEGIN IMMEDIATE 트랜잭션에서 수행한다.

    server_origin 을 주면 그 권위 서버의 행만 claim 한다(R5 2-A) — 종전엔 다른 서버의
    오래된 due 행이 batch 창(limit)을 채워 현재 서버 행이 굶고, 사이클마다 무의미한
    claim/release 가 반복됐다. 다른 서버 행은 건드리지 않으므로 서버를 다시 전환하면
    그대로 재개된다."""
    due_at = now or "9999-12-31 23:59:59"
    modifier = f"+{max(int(lease_seconds), 1)} seconds"
    origin = normalize_share_server_origin(server_origin) if server_origin else None
    origin_clause = "AND server_origin=? " if origin is not None else ""
    origin_params = (origin,) if origin is not None else ()
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            if now is None:
                rows = conn.execute(
                    "SELECT intent_id, intent_seq FROM share_state_intent "
                    "WHERE status IN (?,?,?,?) "
                    f"{origin_clause}"
                    "AND (next_retry_at IS NULL OR next_retry_at<=datetime('now')) "
                    "AND (claim_token IS NULL OR lease_until IS NULL OR lease_until<=datetime('now')) "
                    "ORDER BY COALESCE(next_retry_at, created_at), intent_seq LIMIT ?",
                    (*_CLAIMABLE_STATUSES, *origin_params, max(int(limit), 1)),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT intent_id, intent_seq FROM share_state_intent "
                    "WHERE status IN (?,?,?,?) "
                    f"{origin_clause}"
                    "AND (next_retry_at IS NULL OR next_retry_at<=?) "
                    "AND (claim_token IS NULL OR lease_until IS NULL OR lease_until<=?) "
                    "ORDER BY COALESCE(next_retry_at, created_at), intent_seq LIMIT ?",
                    (*_CLAIMABLE_STATUSES, *origin_params, due_at, due_at, max(int(limit), 1)),
                ).fetchall()
            for row in rows:
                if now is None:
                    conn.execute(
                        "UPDATE share_state_intent SET claim_token=?, "
                        "lease_until=datetime('now', ?), updated_at=datetime('now') "
                        "WHERE intent_id=? AND intent_seq=?",
                        (claim_token, modifier, row["intent_id"], row["intent_seq"]),
                    )
                else:
                    conn.execute(
                        "UPDATE share_state_intent SET claim_token=?, "
                        "lease_until=datetime(?, ?), updated_at=datetime('now') "
                        "WHERE intent_id=? AND intent_seq=?",
                        (claim_token, now, modifier, row["intent_id"], row["intent_seq"]),
                    )
            # 최종 SELECT 에도 origin 조건(코덱스) — 같은 claim_token 을 재사용하는
            # worker 가 과거에 잡아둔 다른 origin 행이 섞여 나오지 않게 한다.
            claimed = conn.execute(
                "SELECT * FROM share_state_intent WHERE claim_token=? "
                f"{origin_clause}"
                "ORDER BY COALESCE(next_retry_at, created_at), intent_seq",
                (claim_token, *origin_params),
            ).fetchall()
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    return [dict(row) for row in claimed]


def renew_share_state_intent_lease(
    intent_id: str,
    intent_seq: int,
    claim_token: str,
    *, lease_seconds: int = 120,
) -> bool:
    modifier = f"+{max(int(lease_seconds), 1)} seconds"
    with get_connection() as conn:
        cursor = conn.execute(
            "UPDATE share_state_intent SET lease_until=datetime('now', ?), updated_at=datetime('now') "
            "WHERE intent_id=? AND intent_seq=? AND claim_token=?",
            (modifier, intent_id, int(intent_seq), claim_token),
        )
        return cursor.rowcount == 1


def release_share_state_intent_claim(
    intent_id: str, intent_seq: int, claim_token: str
) -> bool:
    with get_connection() as conn:
        cursor = conn.execute(
            "UPDATE share_state_intent SET claim_token=NULL, lease_until=NULL, updated_at=datetime('now') "
            "WHERE intent_id=? AND intent_seq=? AND claim_token=?",
            (intent_id, int(intent_seq), claim_token),
        )
        return cursor.rowcount == 1


def apply_share_state_intent_local(
    intent_id: str,
    intent_seq: int,
    claim_token: str,
    *,
    local_id: Optional[str] = None,
    shared: bool,
    is_final: bool,
    final_by: Optional[str] = None,
    shared_by: Optional[str] = None,
    preservation_reason: Optional[str] = None,
    status: str = "converged",
    observed_state: Optional[Mapping[str, Any]] = None,
) -> str:
    """로컬 ``{shared, final}`` 적용과 원장 상태 전이를 한 트랜잭션 CAS로 수행한다.

    CAS가 먼저 확인된 뒤 BEGIN IMMEDIATE가 끝날 때까지 새 seq UPSERT가 들어올 수 없다. 따라서
    옛 워커는 로컬을 한 줄도 바꾸지 못하고, 적용 중 예외가 나면 원장 전이까지 함께 롤백된다.
    반환값으로 정상 적용, CAS 경합 패배, 로컬 대상 부재를 구분한다.
    """
    if is_final and not shared:
        raise ValueError("최종 상태는 공유 상태여야 합니다")
    if preservation_reason not in {None, "shared", "final"}:
        raise ValueError("지원하지 않는 미디어 보존 사유입니다")
    if status not in SHARE_STATE_STATUSES:
        raise ValueError(f"지원하지 않는 원장 상태: {status}")
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            intent = conn.execute(
                "SELECT * FROM share_state_intent "
                "WHERE intent_id=? AND intent_seq=? AND claim_token=?",
                (intent_id, int(intent_seq), claim_token),
            ).fetchone()
            if intent is None:
                conn.execute("ROLLBACK")
                return SHARE_STATE_APPLY_CAS_LOST
            target = None
            requested_local_id = _clean_optional(local_id) or intent["local_id"]
            if requested_local_id:
                target = conn.execute(
                    "SELECT id, worker_id FROM generation WHERE id=?",
                    (requested_local_id,),
                ).fetchone()
            if target is None:
                anchors = [
                    value
                    for value in (intent["job_anchor"], intent["server_generation_id"])
                    if value
                ]
                for anchor in anchors:
                    target = conn.execute(
                        "SELECT id, worker_id FROM generation WHERE id=? OR job_id=? "
                        "ORDER BY (id=?) DESC, (origin='local') DESC LIMIT 1",
                        (anchor, anchor, anchor),
                    ).fetchone()
                    if target is not None:
                        break
            if target is None:
                conn.execute("ROLLBACK")
                return SHARE_STATE_APPLY_NO_TARGET

            target_id = target["id"]
            if shared:
                sid = new_id()
                owner = shared_by or target["worker_id"] or DEFAULT_WORKER_ID
                conn.execute(
                    "INSERT INTO share(id, generation_id, shared_by, visibility) "
                    "VALUES(?,?,?,'team') ON CONFLICT(generation_id) DO NOTHING",
                    (sid, target_id, owner),
                )
            else:
                conn.execute("DELETE FROM share WHERE generation_id=?", (target_id,))
            if is_final:
                conn.execute(
                    "UPDATE generation SET is_final=1, final_by=?, final_at=datetime('now') WHERE id=?",
                    (final_by, target_id),
                )
            else:
                conn.execute(
                    "UPDATE generation SET is_final=0, final_by=NULL, final_at=NULL WHERE id=?",
                    (target_id,),
                )
            if preservation_reason and MEDIA_PRESERVATION_ENABLED:
                # 공유/최종 표식과 보존 요청도 같은 트랜잭션에 둔다. 원장만 converged인데
                # media_preservation 등록이 빠지는 부분 성공을 만들지 않는다.
                conn.execute(
                    "INSERT INTO media_preservation(generation_id,reason,status) "
                    "VALUES(?,?,'pending') "
                    "ON CONFLICT(generation_id) DO UPDATE SET "
                    "reason=CASE "
                    "WHEN (CASE excluded.reason WHEN 'shared' THEN 1 WHEN 'final' THEN 4 ELSE 0 END) > "
                    "(CASE media_preservation.reason "
                    "WHEN 'shared' THEN 1 WHEN 'admin' THEN 2 WHEN 'manual' THEN 3 "
                    "WHEN 'final' THEN 4 ELSE 0 END) "
                    "THEN excluded.reason ELSE media_preservation.reason END, "
                    "updated_at=datetime('now')",
                    (target_id, preservation_reason),
                )

            assignments = [
                "local_id=?",
                "status=?",
                "updated_at=datetime('now')",
                "last_attempt_at=datetime('now')",
                "last_error_code=NULL",
            ]
            params: list[Any] = [target_id, status]
            if observed_state is not None:
                assignments.extend(["observed_state_json=?", "observed_at=datetime('now')"])
                params.append(
                    json.dumps(
                        dict(observed_state),
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    )
                )
            if status in SHARE_STATE_TERMINAL_STATUSES:
                assignments.extend(["claim_token=NULL", "lease_until=NULL", "next_retry_at=NULL"])
            params.extend([intent_id, int(intent_seq), claim_token])
            cursor = conn.execute(
                f"UPDATE share_state_intent SET {', '.join(assignments)} "
                "WHERE intent_id=? AND intent_seq=? AND claim_token=?",
                params,
            )
            if cursor.rowcount != 1:
                conn.execute("ROLLBACK")
                return SHARE_STATE_APPLY_CAS_LOST
            conn.execute("COMMIT")
            return SHARE_STATE_APPLY_APPLIED
        except Exception:
            conn.execute("ROLLBACK")
            raise
