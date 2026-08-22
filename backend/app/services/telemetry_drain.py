"""PM 텔레메트리 outbox를 원격 서버 또는 격리 로컬 통계 DB로 반영한다.

운영 로컬 허브는 인증된 공유 서버로 push한다. ``CONTENT_HUB_NO_PROXY=1``인 test_dev와
서버 유사 테스트는 운영 서버에 절대 접속하지 않고 같은 테스트 데이터 폴더의
``manage_hub.db``에만 반영한다.
"""

from __future__ import annotations

import json
import os
import threading
from collections import defaultdict
from typing import Any, Callable

from .. import active_account, repo
from ..config import MANAGE_ENABLED
from ..emailnorm import norm_email
from ..manage_db import init_manage_db, upsert_facts
from ..repo import manage as repo_manage

_LOCAL_DRAIN_LOCK = threading.Lock()
_NO_PROXY_TRUE = {"1", "true", "yes", "on"}


def isolated_local_telemetry_enabled() -> bool:
    """운영 서버 전송이 금지된 격리 데이터 폴더인지 동적으로 판정한다."""
    return MANAGE_ENABLED and os.environ.get("CONTENT_HUB_NO_PROXY", "").lower() in _NO_PROXY_TRUE


def _prepare_batch(*, filter_uid: str | None, include_all_creators: bool) -> dict[str, Any]:
    dirty = repo_manage.list_dirty_telemetry(500)
    if not dirty:
        return {"dirty": [], "facts": [], "sent": [], "non_sent": []}

    tomb_rows = [row for row in dirty if row.get("is_tombstone")]
    normal_rows = [row for row in dirty if not row.get("is_tombstone")]
    normal_ids = [row["local_gen_id"] for row in normal_rows]
    facts = repo_manage.build_telemetry_facts(
        gen_ids=normal_ids,
        my_uid=None if include_all_creators else filter_uid,
    ) if normal_ids else []
    built_ids = {fact["local_gen_id"] for fact in facts}

    tomb_facts: list[dict[str, Any]] = []
    sendable_tomb_rows: list[dict[str, Any]] = []
    foreign_tomb_rows: list[dict[str, Any]] = []
    for row in tomb_rows:
        snapshot: dict[str, Any] = {}
        if row.get("tomb_snapshot"):
            try:
                snapshot = json.loads(row["tomb_snapshot"]) or {}
            except (TypeError, ValueError):
                snapshot = {}
        creator_uid = str(
            row.get("tomb_creator_uid") or snapshot.get("creator_uid") or ""
        ).strip()
        # 로컬 DB에는 과거 다른 작업자의 삭제 흔적도 남을 수 있다. 현재 로그인 작업자의
        # 원격 전송에서는 그 항목을 성공 처리해 재시도만 끝내고, 서버 데이터는 건드리지 않는다.
        # 작성자 정보가 없는 옛 항목은 기존 계약대로 현재 작업자 항목으로 전송한다.
        if not include_all_creators and filter_uid and creator_uid and creator_uid != filter_uid:
            foreign_tomb_rows.append(row)
            continue
        sendable_tomb_rows.append(row)
        tomb_facts.append(
            {
                **snapshot,
                "local_gen_id": row["local_gen_id"],
                "job_id": snapshot.get("job_id") or row.get("tomb_job_id"),
                "creator_uid": creator_uid or filter_uid,
                "is_deleted": True,
            }
        )

    sent = [row for row in normal_rows if row["local_gen_id"] in built_ids] + sendable_tomb_rows
    non_sent = (
        [row for row in normal_rows if row["local_gen_id"] not in built_ids]
        + foreign_tomb_rows
    )
    return {
        "dirty": dirty,
        "facts": facts + tomb_facts,
        "sent": sent,
        "non_sent": non_sent,
    }


def _settle(batch: dict[str, Any], skipped_ids: set[str], error: str) -> tuple[int, int]:
    sent = batch["sent"]
    pushed = [row for row in sent if row["local_gen_id"] not in skipped_ids]
    # 실패도 행 그대로 넘긴다(dirty_rev CAS) — 전송 중 재dirty 된 항목엔 백오프를 걸지 않는다.
    failed = [row for row in sent if row["local_gen_id"] in skipped_ids]
    if pushed:
        repo_manage.mark_telemetry_pushed(pushed)
    if failed:
        repo_manage.mark_telemetry_failed(failed, error)
    return len(pushed), len(failed)


def _drain_remote_telemetry(
    push: Callable[[list[dict[str, Any]]], Any],
    *,
    account_key: str | None,
    my_uid: str | None,
) -> dict[str, Any]:
    """명시된 계정 범위 안에서 prepare·push·settle을 모두 끝낸다."""
    token = active_account.set_override(account_key or "")
    try:
        batch = _prepare_batch(filter_uid=my_uid, include_all_creators=False)
        # 현재 계정 소유가 아니거나 로컬 원본이 없어 큐에서만 치우는 행이다. 서버 반영 성공으로
        # 기록하면 마지막 성공 시각이 거짓으로 갱신되므로 관측값에서는 제외한다.
        repo_manage.mark_telemetry_pushed(batch["non_sent"], record_success=False)
        facts = batch["facts"]
        if not facts:
            return {"target": "remote", "upserted": 0, "failed": 0}
        try:
            response = push(facts)
            response = response if isinstance(response, dict) else {}
            if "skipped" in response:
                skipped_ids = set(response.get("skipped") or [])
            else:
                upserted = int(response.get("upserted") or 0)
                skipped_ids = (
                    set() if upserted >= len(facts)
                    else {row["local_gen_id"] for row in batch["sent"]}
                )
            pushed, failed = _settle(
                batch,
                skipped_ids,
                "server skipped (unlinked/foreign)"
                if "skipped" in response
                else f"server upserted {response.get('upserted', 0)}/{len(facts)}",
            )
            return {"target": "remote", "upserted": pushed, "failed": failed}
        except Exception as exc:  # noqa: BLE001 - 오프라인 큐로 남겨 다음 동기화 때 재시도
            rows = list(batch["sent"])
            repo_manage.mark_telemetry_failed(rows, str(exc))
            return {
                "target": "remote",
                "upserted": 0,
                "failed": len(rows),
                "error": str(exc),
            }
    finally:
        active_account.reset_override(token)


def drain_remote_telemetry(
    push: Callable[[list[dict[str, Any]]], Any],
    *,
    my_uid: str | None,
) -> dict[str, Any]:
    """기존 운영 계약대로 현재 로컬 사용자의 팩트를 공유 서버로 전송한다."""
    with active_account.transition_lock:
        account_key = active_account.account_key()
        captured_uid = my_uid
    return _drain_remote_telemetry(
        push,
        account_key=account_key,
        my_uid=captured_uid,
    )


def _drain_isolated_telemetry(
    *,
    account_key: str | None,
    my_uid: str | None,
) -> dict[str, Any]:
    """캡처한 격리 계정 범위에서 로컬 관리 DB 반영을 끝낸다.

    스냅샷에는 여러 작성자가 함께 있을 수 있으므로 account 테이블의 검증된 uid↔email 연결로
    팩트를 나눠 저장한다. 연결이 없거나 중복된 작성자는 임의 귀속하지 않고 대기열에 남긴다.
    """
    token = active_account.set_override(account_key or "")
    try:
        if not isolated_local_telemetry_enabled():
            return {"target": "disabled", "upserted": 0, "failed": 0}

        with _LOCAL_DRAIN_LOCK:
            batch = _prepare_batch(filter_uid=None, include_all_creators=True)
            repo_manage.mark_telemetry_pushed(batch["non_sent"], record_success=False)
            facts: list[dict[str, Any]] = batch["facts"]
            if not facts:
                return {"target": "local", "upserted": 0, "failed": 0}

            init_manage_db()
            uids = sorted({str(fact.get("creator_uid") or "").strip() for fact in facts} - {""})
            email_by_uid = repo_manage.account_emails_by_creator_uids(uids)
            provider = repo.get_provider()
            provider_uid = (
                repo.get_my_uid() or my_uid or provider.get("uid") or ""
            ).strip()
            provider_email = norm_email(provider.get("email"))
            if provider_uid and provider_email and provider_uid not in email_by_uid:
                email_by_uid[provider_uid] = provider_email

            groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
            unresolved: set[str] = set()
            for fact in facts:
                uid = str(fact.get("creator_uid") or "").strip()
                email = email_by_uid.get(uid)
                local_id = str(fact.get("local_gen_id") or "")
                if not uid or not email:
                    if local_id:
                        unresolved.add(local_id)
                    continue
                groups[(email, uid)].append(fact)

            success_ids: set[str] = set()
            failed_ids = set(unresolved)
            errors: list[str] = []
            for (email, uid), items in groups.items():
                try:
                    _count, skipped = upsert_facts(email, uid, items)
                    skipped_set = set(skipped)
                    failed_ids.update(skipped_set)
                    success_ids.update(
                        str(item["local_gen_id"])
                        for item in items
                        if item.get("local_gen_id") and item["local_gen_id"] not in skipped_set
                    )
                except Exception as exc:  # noqa: BLE001 - 성공 그룹은 보존하고 실패 그룹만 재시도
                    errors.append(str(exc))
                    failed_ids.update(
                        str(item["local_gen_id"])
                        for item in items
                        if item.get("local_gen_id")
                    )

            sent_by_id = {row["local_gen_id"]: row for row in batch["sent"]}
            pushed_rows = [sent_by_id[gid] for gid in success_ids if gid in sent_by_id]
            if pushed_rows:
                repo_manage.mark_telemetry_pushed(pushed_rows)
            if failed_ids:
                error = "; ".join(errors) or "local telemetry identity unavailable"
                failed_rows = [sent_by_id.get(gid) or gid for gid in sorted(failed_ids)]
                repo_manage.mark_telemetry_failed(failed_rows, error)
            return {
                "target": "local",
                "upserted": len(pushed_rows),
                "failed": len(failed_ids),
            }
    finally:
        active_account.reset_override(token)


def drain_isolated_telemetry() -> dict[str, Any]:
    """격리 test_dev의 텔레메트리를 최초 계정 범위에 고정해 로컬 반영한다."""
    with active_account.transition_lock:
        account_key = active_account.account_key()
        captured_uid = active_account.active_uid() if account_key else None
    return _drain_isolated_telemetry(
        account_key=account_key,
        my_uid=captured_uid,
    )
