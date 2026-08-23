"""Resolve 가져오기 큐 — manifest v3 코어.

권위 설계: ``docs/DESIGN_RESOLVE_QUEUE_V3_2026-08-24.md``

접수(POST /api/resolve/transfers)는 권한 판정·목적지 고정·v3 manifest 원자 기록까지만
하고 즉시 반환한다. 실제 원본 복사(preparing)와 Resolve 가져오기(importing)는 전담
워커(:mod:`resolve_queue_worker`)가 큐에서 꺼내 수행한다.

v3 는 ``format: "mvhub.resolve-transfer.v3"`` 를 쓴다. 단순 ``version: 3`` 이면 format 만
검사하는 구버전 스캐너가 v3 를 v2 로 오인해 claim 없이 강제 가져오기를 할 수 있다.
기존 v2 manifest 는 이 모듈이 읽지도 고치지도 않는다 — 기존 메뉴 pull 경로 전용이다.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import re
import stat
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

from . import project_folders, resolve_bridge, resolve_lock, resolve_transfer
from .atomic_io import atomic_write_text
from .resolve_transfer import ResolveTransferError


MANIFEST_FORMAT = "mvhub.resolve-transfer.v3"
MANIFEST_VERSION = 3
ATTEMPT_FORMAT = "mvhub.resolve-attempt"
ATTEMPT_VERSION = 1
SOURCE_PAYLOAD_SCHEMA = 1

STATE_QUEUED = "queued"
STATE_PREPARING = "preparing"
STATE_READY = "ready"
STATE_BLOCKED = "blocked"
STATE_IMPORTING = "importing"
STATE_COMPLETE = "complete"
STATE_FAILED = "failed"
STATE_INTERRUPTED = "interrupted"
STATE_RECOVERY_REQUIRED = "recovery_required"
STATE_CANCELLED = "cancelled"

# 명세 §1.2 표의 상태 집합 그대로. (본문은 "9개"라고 적었지만 표에는 cancelled 를 포함해
# 10개가 있고 전이표가 cancelled 를 요구하므로 표를 따른다.)
STATES = frozenset(
    {
        STATE_QUEUED,
        STATE_PREPARING,
        STATE_READY,
        STATE_BLOCKED,
        STATE_IMPORTING,
        STATE_COMPLETE,
        STATE_FAILED,
        STATE_INTERRUPTED,
        STATE_RECOVERY_REQUIRED,
        STATE_CANCELLED,
    }
)
# 큐에 살아 있는(사용자에게 진행 중으로 보이는) 상태.
ACTIVE_STATES = frozenset(
    {STATE_QUEUED, STATE_PREPARING, STATE_READY, STATE_BLOCKED, STATE_IMPORTING}
)
# §1.3 "비종료 상태 → cancelled" — 되돌릴 수 없는 건 이 둘뿐이다.
TERMINAL_STATES = frozenset({STATE_COMPLETE, STATE_CANCELLED})

DISPATCH_AUTO = "auto"
DISPATCH_MANUAL_ONLY = "manual_only"

# 준비 단계 항목 상태 → v2 투영(items[].status).
PREPARE_QUEUED = "queued"
PREPARE_DOWNLOADED = "downloaded"
PREPARE_SKIPPED = "skipped"
PREPARE_ERROR = "error"
_PREPARE_TO_V2 = {
    PREPARE_QUEUED: "pending",
    PREPARE_DOWNLOADED: "downloaded",
    PREPARE_SKIPPED: "skipped",
    PREPARE_ERROR: "error",
}

# 고아 staging Bin 이름(명세 §3.1). 신규 staging 은 추적 가능한 이름을 쓴다.
ORPHAN_BIN_RE = re.compile(r"^__MVHUB_REBUILD_[A-Za-z0-9_]+__$")
# staging Bin 이 남아 있을 수 있는 중간 phase — 여기서 멈춘 attempt 는 recovery_required.
REBUILD_PENDING_PHASES = frozenset(
    {
        "rebuild_staging_created",
        "rebuild_to_staging",
        "rebuild_to_final",
        "rebuild_verified",
    }
)

# 가져오기 항목이 '확정된' 상태들. 나머지는 재시도해도 안전한 누락분이다(§3.3·§3.4).
IMPORT_SETTLED_STATES = frozenset({"imported", "skipped", "recovered_existing"})

DEFAULT_LEASE_SECONDS = 120
# import 가 이만큼을 넘기면 큐 스냅샷에 경고만 붙인다. 자동 kill 은 하지 않는다(§D).
IMPORT_WARN_SECONDS = max(
    60, int(os.environ.get("CONTENT_HUB_RESOLVE_IMPORT_WARN_SECONDS", "300"))
)
_SCAN_FILE_LIMIT = max(20, int(os.environ.get("CONTENT_HUB_RESOLVE_QUEUE_SCAN_LIMIT", "300")))
# 이 허브 프로세스의 실행 식별자 — 재시작하면 바뀌므로 옛 claim 을 구분할 수 있다.
HUB_INSTANCE_ID = uuid.uuid4().hex
_PROCESS_NONCE = uuid.uuid4().hex


class ResolveQueueError(RuntimeError):
    """큐 접수·판독을 진행할 수 없는 오류."""


# ── 시간·식별자 ────────────────────────────────────────────────────────────────
def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _parse_utc(value: str) -> Optional[datetime]:
    try:
        parsed = datetime.fromisoformat(str(value or ""))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def new_attempt_id() -> str:
    return uuid.uuid4().hex


# ── FIFO 접수 순서 키 ──────────────────────────────────────────────────────────
# ``created_at`` 은 초 단위라 같은 초에 들어온 접수들이 동률이 되고, 그때 tie-break 로
# 쓰던 ``transfer_id`` 문자열 정렬은 실제 접수 순서와 아무 상관이 없다. 그래서 빠르게
# 연속 접수하면 큐 순서와 ``ahead`` 가 뒤바뀐다. v3 는 접수 순서의 권위 키로 나노초
# 정수 ``created_at_ns`` 를 따로 기록한다.
_CREATED_NS_GUARD = threading.Lock()
_last_created_ns = 0


def next_created_ns() -> int:
    """접수 순서 키. 같은 프로세스 안에서는 반드시 증가한다.

    Windows 벽시계는 해상도가 거칠어(≈15.6ms) 연속 접수가 같은 값을 받을 수 있으므로,
    직전 값 이하가 나오면 +1 해서 단조성을 강제한다. 서로 다른 프로세스(허브 재시작·
    다른 PC)에서 들어온 접수는 벽시계 해상도까지만 구분되며, 그래도 동률이면 예전처럼
    ``transfer_id`` 로 결정론적으로 갈린다.
    """
    global _last_created_ns
    with _CREATED_NS_GUARD:
        value = time.time_ns()
        if value <= _last_created_ns:
            value = _last_created_ns + 1
        _last_created_ns = value
        return value


def created_at_ns(manifest: dict[str, Any]) -> int:
    """FIFO 정렬용 나노초 키.

    ★하위호환: ``created_at_ns`` 가 없는 기존 v3 manifest 는 초 단위 ``created_at`` 을
    환산해 쓴다. 그러면 옛 기록끼리는 같은 초에서 동률이 되어 예전 규칙(transfer_id)
    으로 갈리고, 새 기록은 항상 자기 나노초로 갈린다.
    """
    raw = manifest.get("created_at_ns")
    try:
        value = int(raw) if not isinstance(raw, bool) else 0
    except (TypeError, ValueError):
        value = 0
    if value > 0:
        return value
    parsed = _parse_utc(str(manifest.get("created_at") or ""))
    if parsed is None:
        return 0
    return int(parsed.timestamp()) * 1_000_000_000 + parsed.microsecond * 1_000


def fifo_key(manifest: dict[str, Any]) -> tuple[int, str]:
    """접수 순서 정렬 키 — ``(created_at_ns, transfer_id)``."""
    return (created_at_ns(manifest), str(manifest.get("transfer_id") or ""))


# ── manifest 판독 ──────────────────────────────────────────────────────────────
def is_v3(manifest: Any) -> bool:
    return isinstance(manifest, dict) and manifest.get("format") == MANIFEST_FORMAT


def queue_block(manifest: dict[str, Any]) -> dict[str, Any]:
    block = manifest.get("queue")
    if not isinstance(block, dict):
        block = {}
        manifest["queue"] = block
    return block


def queue_state(manifest: dict[str, Any]) -> str:
    return str(queue_block(manifest).get("state") or "")


def dispatch_policy(manifest: dict[str, Any]) -> str:
    return str(queue_block(manifest).get("dispatch_policy") or DISPATCH_AUTO)


def manifest_path_of(manifest: dict[str, Any]) -> Path:
    return Path(str(manifest.get("manifest_path") or ""))


def read_manifest(path: Path) -> dict[str, Any]:
    """v3 manifest 한 건을 읽는다. v2·손상 파일은 예외."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ResolveQueueError("전송 기록을 찾을 수 없습니다") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise ResolveQueueError(f"전송 기록을 읽을 수 없습니다: {exc}") from exc
    if not is_v3(data):
        raise ResolveQueueError("MV Hub Resolve 큐(v3) 기록이 아닙니다")
    return data


def _disk_revision(path: Path) -> Optional[int]:
    """디스크에 있는 manifest 의 현재 revision(없거나 읽을 수 없으면 None)."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not is_v3(data):
        return None
    block = data.get("queue")
    try:
        return int((block or {}).get("revision") or 0)
    except (TypeError, ValueError):
        return None


def save_manifest(path: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    """revision 을 1 올리고 같은 디렉터리 temp→fsync→replace 로 원자 교체한다(§1.7).

    호출자는 해당 transfer 의 ``.lock`` 을 보유한 상태여야 한다.

    ★교체 직전 파일의 revision 을 다시 읽어 이 사본이 근거한 값과 같은지 확인한다(CAS).
    락을 제대로 잡았다면 절대 어긋나지 않지만, 어긋났다면 그건 '두 소유자가 같은
    전송을 쓰고 있다'는 뜻이라 조용히 덮어쓰면 앞선 결과(가져오기 성공 기록 등)가
    사라진다. 여기서 멈춰야 유실을 실패로 드러낼 수 있다.
    """
    block = queue_block(manifest)
    try:
        base = int(block.get("revision") or 0)
    except (TypeError, ValueError):
        base = 0
    on_disk = _disk_revision(path)
    if on_disk is not None and on_disk != base:
        raise ResolveQueueError(
            f"다른 작업자가 이 전송을 먼저 갱신했습니다(revision {on_disk} ≠ {base})"
        )
    block["revision"] = base + 1
    refresh_projection(manifest)
    atomic_write_text(
        Path(path),
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    )
    return manifest


# ── 상태 전이 ─────────────────────────────────────────────────────────────────
def set_state(
    manifest: dict[str, Any],
    state: str,
    *,
    error: Optional[dict[str, Any]] = None,
    blocked: Optional[dict[str, Any]] = None,
    resume_state: Optional[str] = None,
    policy: Optional[str] = None,
    clear_claim: bool = False,
) -> dict[str, Any]:
    """권위 상태(queue.state)를 바꾸고 v2 투영 필드까지 맞춘다."""
    if state not in STATES:
        raise ResolveQueueError(f"알 수 없는 큐 상태입니다: {state}")
    block = queue_block(manifest)
    block["state"] = state
    block["state_changed_at"] = _utc_now()
    if policy is not None:
        block["dispatch_policy"] = policy
    if state == STATE_BLOCKED:
        block["blocked"] = blocked
        block["resume_state"] = resume_state or STATE_QUEUED
    else:
        block["blocked"] = None
        block["resume_state"] = resume_state
    if error is not None:
        block["last_error"] = error
    elif state in {STATE_COMPLETE, STATE_READY, STATE_PREPARING}:
        block["last_error"] = None
    if clear_claim:
        block["claim"] = None
    if state in {STATE_FAILED, STATE_CANCELLED}:
        # ★가져오기를 한 번도 못 하고 끝난 전송의 v2 투영이 "pending" 으로 남으면
        # 기존 화면·요약이 '아직 가져오는 중'으로 읽는다. 권위 상태가 끝났으면 투영도
        # 끝내 준다(실제 가져오기 결과가 있으면 그건 이미 pending 이 아니다).
        projection = manifest.get("resolve_import")
        if isinstance(projection, dict) and projection.get("status") == "pending":
            projection["status"] = "failed"
    refresh_projection(manifest)
    return manifest


def refresh_projection(manifest: dict[str, Any]) -> None:
    """v2 호환 투영(§1.4) — 권위는 queue.state 이고 이건 기존 브리지용 표시값이다."""
    items = manifest.get("items")
    if not isinstance(items, list):
        return
    downloaded = skipped = errors = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        prepare = item.get("prepare") if isinstance(item.get("prepare"), dict) else {}
        prepare_state = str(prepare.get("state") or PREPARE_QUEUED)
        item["status"] = _PREPARE_TO_V2.get(prepare_state, "pending")
        item["error"] = prepare.get("error")
        if prepare_state == PREPARE_DOWNLOADED:
            downloaded += 1
        elif prepare_state == PREPARE_SKIPPED:
            skipped += 1
        elif prepare_state == PREPARE_ERROR:
            errors += 1
    manifest["downloaded"] = downloaded
    manifest["skipped"] = skipped
    manifest["error_count"] = errors
    state = queue_state(manifest)
    prepared = downloaded + skipped
    if state == STATE_CANCELLED:
        # 폐기된 전송은 v2 어휘에 'cancelled' 가 없다. 준비분이 있으면 partial, 아니면
        # failed 로 적는다 — "pending" 으로 남으면 영원히 대기 중으로 읽힌다.
        manifest["status"] = "partial" if prepared else "failed"
    elif state in {STATE_QUEUED, STATE_PREPARING} or (not prepared and not errors):
        manifest["status"] = "pending"
    elif errors and prepared:
        manifest["status"] = "partial"
    elif errors:
        manifest["status"] = "failed"
    else:
        manifest["status"] = "complete"


# ── claim / lease ─────────────────────────────────────────────────────────────
def build_claim(
    manifest: dict[str, Any],
    *,
    purpose: str,
    attempt_id: str,
    kind: str = "push_worker",
    lease_seconds: int = DEFAULT_LEASE_SECONDS,
) -> dict[str, Any]:
    """§2.3 claim 블록. epoch 는 transfer 별 단조 증가."""
    block = queue_block(manifest)
    previous = block.get("claim") if isinstance(block.get("claim"), dict) else {}
    try:
        epoch = int(previous.get("epoch") or 0) + 1
    except (TypeError, ValueError):
        epoch = 1
    now = datetime.now(timezone.utc)
    return {
        "token": uuid.uuid4().hex + uuid.uuid4().hex[:8],
        "epoch": epoch,
        "purpose": purpose,
        "owner": {
            "kind": kind,
            "host_id": resolve_lock.host_id(),
            "hub_instance_id": HUB_INSTANCE_ID,
            "process_id": os.getpid(),
            "process_started_at_filetime": resolve_lock.process_started_at_filetime(),
            "process_nonce": _PROCESS_NONCE,
            "executor_pid": 0,
        },
        "attempt_id": attempt_id,
        "acquired_at": now.isoformat(timespec="seconds"),
        "heartbeat_at": now.isoformat(timespec="seconds"),
        "lease_expires_at": (
            now + timedelta(seconds=max(1, lease_seconds))
        ).isoformat(timespec="seconds"),
    }


def claim_disposition(manifest: dict[str, Any]) -> str:
    """``free`` | ``alive`` | ``unknown`` — 기존 claim 소유자의 생존 판정(§2.7)."""
    block = queue_block(manifest)
    claim = block.get("claim")
    if not isinstance(claim, dict) or not claim.get("token"):
        return "free"
    owner = claim.get("owner") if isinstance(claim.get("owner"), dict) else {}
    lease = _parse_utc(str(claim.get("lease_expires_at") or ""))
    expired = lease is None or lease <= datetime.now(timezone.utc)
    if str(owner.get("host_id") or "") != resolve_lock.host_id():
        # 다른 PC 소유. lease 가 살아 있으면 건드리지 않고, 만료돼도 자동 steal 금지.
        return "alive" if not expired else "unknown"
    if str(owner.get("hub_instance_id") or "") == HUB_INSTANCE_ID:
        return "alive"
    liveness = resolve_lock.process_liveness(
        int(owner.get("process_id") or 0),
        str(owner.get("process_started_at_filetime") or ""),
    )
    if liveness == "alive":
        return "alive"
    if liveness == "dead":
        return "free"
    return "unknown" if expired else "alive"


# ── 취소 요청 (§D) ────────────────────────────────────────────────────────────
# 취소는 협력적이다. 아직 아무도 실행하지 않는 건(queued·ready·blocked…)은 API 가 그
# 자리에서 락을 잡고 확정한다. 이미 워커가 락을 쥔 채 실행 중인 건(preparing·importing)
# 은 API 가 manifest 를 쓸 수 없으므로 이 프로세스 안의 요청표에만 남기고, 실행 중인
# 워커가 항목·단계 경계에서 이 표를 보고 스스로 멈춘 뒤 manifest 에 기록한다
# (워커는 같은 허브 프로세스의 asyncio task 라 메모리를 공유한다).
#
# ★허브가 그 사이에 죽으면 요청은 사라진다. 그때는 부팅 복구가 preparing 을 queued 로
# 되돌리므로 사용자가 큐에서 다시 취소하면 된다 — 취소가 '실행된 척' 남는 경우는 없다.
_CANCEL_REQUESTS: dict[str, dict[str, Any]] = {}
_CANCEL_GUARD = threading.Lock()


def request_cancel(
    transfer_id: str, *, force: bool = False, requested_by: str = ""
) -> dict[str, Any]:
    """취소 요청을 등록한다. 이미 있으면 force 만 승격한다(일반 취소 뒤 강제 중단)."""
    key = str(transfer_id or "")
    record = {
        "requested_at": _utc_now(),
        "requested_by": str(requested_by or ""),
        "force": bool(force),
    }
    with _CANCEL_GUARD:
        previous = _CANCEL_REQUESTS.get(key)
        if previous is not None:
            previous["force"] = bool(previous.get("force")) or bool(force)
            return dict(previous)
        _CANCEL_REQUESTS[key] = record
    return dict(record)


def cancel_requested(transfer_id: str) -> Optional[dict[str, Any]]:
    with _CANCEL_GUARD:
        record = _CANCEL_REQUESTS.get(str(transfer_id or ""))
        return dict(record) if record else None


def clear_cancel(transfer_id: str) -> None:
    with _CANCEL_GUARD:
        _CANCEL_REQUESTS.pop(str(transfer_id or ""), None)


def reset_cancel_requests() -> None:
    """프로세스 전역 요청표 비우기(테스트용)."""
    with _CANCEL_GUARD:
        _CANCEL_REQUESTS.clear()


def record_cancel(manifest: dict[str, Any], request: dict[str, Any]) -> None:
    """queue.cancel 에 요청을 남긴다 — 언제·누가·강제였는지가 복구 판단의 근거다."""
    queue_block(manifest)["cancel"] = {
        "requested_at": str(request.get("requested_at") or _utc_now()),
        "requested_by": str(request.get("requested_by") or ""),
        "force": bool(request.get("force")),
    }


# ── 진행 경고 (자동 kill 없음) ────────────────────────────────────────────────
def import_warning(manifest: dict[str, Any]) -> Optional[dict[str, Any]]:
    """importing 이 오래 걸리면 경고만 만든다.

    Resolve 가 모달 대화상자(저장 확인·미디어 재연결)를 띄우면 API 호출이 사용자가
    누를 때까지 돌아오지 않는다. timeout 으로 끊는 것은 Media Pool 재정렬 도중을 끊는
    일이라 금지다(§D). 대신 사용자에게 'Resolve 창을 보라'고 알린다.
    """
    if queue_state(manifest) != STATE_IMPORTING:
        return None
    started = _parse_utc(str(queue_block(manifest).get("state_changed_at") or ""))
    if started is None:
        return None
    elapsed = (datetime.now(timezone.utc) - started).total_seconds()
    if elapsed < IMPORT_WARN_SECONDS:
        return None
    return {
        "code": "import_slow",
        "elapsed_seconds": int(elapsed),
        "since": started.isoformat(timespec="seconds"),
        "message": (
            "Resolve 가져오기가 오래 걸리고 있습니다. Resolve 창에 확인을 기다리는 "
            "대화상자가 떠 있는지 보세요"
        ),
    }


# ── 누락분 계산 (§3.3) ────────────────────────────────────────────────────────
def missing_item_ids(manifest: dict[str, Any]) -> list[str]:
    """준비는 끝났는데 가져오기가 확정되지 않은 항목들.

    같은 Bin·같은 정규화 경로는 브리지가 ``ImportMedia`` 전에 건너뛰므로(§3.4) 이
    목록을 다시 실행해도 중복 클립이 생기지 않는다. 목록 생성만 자동이고, 실제 재실행은
    사용자 확인 뒤에만 한다.
    """
    rows: list[str] = []
    for item in manifest.get("items") or []:
        if not isinstance(item, dict):
            continue
        prepare = item.get("prepare") if isinstance(item.get("prepare"), dict) else {}
        if prepare.get("state") not in {PREPARE_DOWNLOADED, PREPARE_SKIPPED}:
            continue
        imported = item.get("import") if isinstance(item.get("import"), dict) else {}
        if str(imported.get("state") or "") in IMPORT_SETTLED_STATES:
            continue
        rows.append(str(item.get("item_id") or ""))
    return [row for row in rows if row]


def build_recovery(
    manifest: dict[str, Any], *, reason: str, attempt: Optional[dict[str, Any]] = None
) -> dict[str, Any]:
    """interrupted 로 격리할 때 붙이는 누락분 정보(§3.3). drp 백업 경로도 함께 남긴다."""
    missing = missing_item_ids(manifest)
    prepared = int(manifest.get("downloaded") or 0) + int(manifest.get("skipped") or 0)
    return {
        "reason": reason,
        "existing_count": max(0, prepared - len(missing)),
        "missing_count": len(missing),
        "missing_item_ids": missing,
        "drp_path": str((attempt or {}).get("drp_path") or ""),
        "verified_at": _utc_now(),
    }


# ── 경로 ──────────────────────────────────────────────────────────────────────
def path_identity(value: str | Path) -> str:
    """UNC·대소문자 정규화된 경로 식별자. 브리지 dedupe 와 같은 규칙을 쓴다."""
    return resolve_bridge._normal_path(str(value))


def transfer_dir(manifest_root: Path) -> Path:
    return Path(manifest_root) / ".mvhub" / "transfers"


def attempt_dir(manifest_root: Path, transfer_id: str) -> Path:
    return Path(manifest_root) / ".mvhub" / "attempts" / transfer_id


def recovery_path(manifest_root: Path, resolve_project_key: str) -> Path:
    safe_key = re.sub(r"[^A-Za-z0-9_.-]", "_", resolve_project_key or "unknown")[:80]
    return Path(manifest_root) / ".mvhub" / "recovery" / f"{safe_key}.json"


def _root_locking_ok(manifest_root: Path) -> tuple[bool, str]:
    """manifest 루트에서 byte-range 잠금이 되는가(§2.2 self-test).

    POSIX 의 ``fcntl`` 잠금은 프로세스 단위라 같은 프로세스 두 핸들 검사가 원리적으로
    실패한다. 운영(워커)은 Windows 전용이고 POSIX 에서는 드레인 자체가 돌지 않으므로,
    검사를 강제하는 것은 Windows 뿐이다.
    """
    if os.name != "nt":
        return True, ""
    return resolve_lock.root_self_test(Path(manifest_root))


def transfer_lock(manifest: dict[str, Any]) -> resolve_lock.FileLock:
    return resolve_lock.FileLock(
        resolve_lock.transfer_lock_path(
            Path(str(manifest.get("manifest_root") or "")),
            str(manifest.get("transfer_id") or ""),
        )
    )


# ── 접수 ──────────────────────────────────────────────────────────────────────
def _asset_of(gen: dict[str, Any]) -> tuple[Optional[dict[str, Any]], int]:
    assets = gen.get("assets") or []
    for ordinal, asset in enumerate(assets):
        if isinstance(asset, dict):
            return asset, ordinal
    return None, 0


def _build_item(
    index: int, gen: dict[str, Any], source_root: Path
) -> tuple[dict[str, Any], Optional[Path]]:
    gen_id = str(gen.get("id") or "")
    job_id = str(gen.get("job_id") or "")
    folder_path = str(gen.get("folder_path") or "")
    asset, ordinal = _asset_of(gen)
    media_type = str((asset or {}).get("type") or "")
    # 파일명 확장자만 원격 URL 힌트에서 얻는다. URL·토큰 자체는 저장하지 않는다(§1.6).
    source_hint = str((asset or {}).get("source_url") or (asset or {}).get("file_path") or "")
    filename = (
        resolve_transfer._transfer_filename(folder_path, gen_id, source_hint, media_type)
        if gen_id and folder_path and asset
        else ""
    )
    cached_ref = str((asset or {}).get("file_path") or "")
    item: dict[str, Any] = {
        "item_id": f"item-{index:04d}",
        "generation_id": gen_id,
        "folder_path": folder_path,
        "filename": filename,
        "media_type": media_type,
        "local_path": "",
        "status": "pending",
        "error": None,
        "source_ref": {
            "requested_generation_id": gen_id,
            "local_generation_id": gen_id,
            "job_id": job_id,
            "asset_id": str((asset or {}).get("id") or ""),
            "asset_ordinal": ordinal,
            "media_type": media_type,
            "cached_media_ref": cached_ref if cached_ref.startswith("/media/") else None,
        },
        "destination": {"relative_folder": folder_path, "filename": filename},
        "prepare": {
            "state": PREPARE_QUEUED,
            "size": None,
            "sha256": None,
            "error_code": None,
            "error": None,
        },
        "import": {"state": "pending", "media_pool_path": "", "error_code": None},
    }

    reason = code = None
    if gen.get("status") != "done":
        reason, code = "완료된 생성물만 전송할 수 있습니다", "source_changed"
    elif not gen_id:
        reason, code = "생성물 ID가 없습니다", "source_missing"
    elif not folder_path:
        reason, code = "폴더 경로가 없습니다", "destination_changed"
    elif asset is None:
        reason, code = "원본 파일이 없습니다", "source_missing"
    elif media_type not in {"video", "audio", "image"}:
        reason = f"Resolve 전송을 지원하지 않는 형식입니다: {media_type or 'unknown'}"
        code = "source_changed"
    else:
        dest = project_folders.safe_dest(source_root, folder_path, filename)
        if dest is None:
            reason, code = "경로 안전성 위반", "destination_changed"
        else:
            item["local_path"] = str(dest)
            return item, dest
    item["prepare"]["state"] = PREPARE_ERROR
    item["prepare"]["error_code"] = code
    item["prepare"]["error"] = reason
    return item, None


def build_manifest(
    project_id: str,
    generations: list[dict[str, Any]],
    *,
    source_root: Path,
    manifest_root: Path,
    transfer_id: str,
    resolve_target: Optional[dict[str, str]],
    account_scope: dict[str, Any],
) -> dict[str, Any]:
    path = resolve_transfer._manifest_path(manifest_root, transfer_id)
    now = _utc_now()
    items: list[dict[str, Any]] = []
    preparable = 0
    for index, gen in enumerate(generations, 1):
        item, dest = _build_item(index, gen, source_root)
        items.append(item)
        if dest is not None:
            preparable += 1
    if not preparable:
        first = next(
            (item["prepare"]["error"] for item in items if item["prepare"].get("error")),
            "전송할 수 있는 생성물이 없습니다",
        )
        raise ResolveTransferError(str(first))

    manifest: dict[str, Any] = {
        "format": MANIFEST_FORMAT,
        "version": MANIFEST_VERSION,
        "transfer_id": transfer_id,
        "project_id": project_id,
        "project_name": str(generations[0].get("project_name") or ""),
        "source_root": str(source_root),
        "manifest_root": str(manifest_root),
        "manifest_path": str(path),
        "folder_catalog_path": str(resolve_transfer._folder_catalog_path(manifest_root)),
        "folder_paths": [],
        "created_at": now,
        # 접수 순서의 권위 키(v3 전용 필드). created_at 은 v2 투영과 표시용이라 초 단위를
        # 유지하고, FIFO·ahead 판정은 이 나노초 값으로만 한다.
        "created_at_ns": next_created_ns(),
        "completed_at": None,
        "status": "pending",
        "total": len(items),
        "downloaded": 0,
        "skipped": 0,
        "error_count": 0,
        "resolve_target": {
            "project_id": str((resolve_target or {}).get("project_id") or ""),
            "project_name": str((resolve_target or {}).get("project_name") or ""),
        },
        "queue": {
            "state": STATE_QUEUED,
            "revision": 0,
            "state_changed_at": now,
            "dispatch_policy": DISPATCH_AUTO,
            "resume_state": None,
            "claim": None,
            "blocked": None,
            "last_error": None,
            "last_attempt_id": None,
            "cancel": {"requested_at": None, "requested_by": None, "force": False},
        },
        "source_payload": {
            "schema": SOURCE_PAYLOAD_SCHEMA,
            "account_scope": dict(account_scope),
            "destination_contract": {
                "root_kind": "project_render",
                "project_id": project_id,
                "accepted_root": str(source_root),
                "root_identity": path_identity(source_root),
                "path_policy": "safe_join_v1",
                "filename_policy": "generation_sha256_v1",
                "collision_policy": "content_equal_skip_else_fail",
            },
            "reconstruction": {
                "generation_lookup_order": [
                    "local_generation_id",
                    "local_job_id",
                    "scoped_remote_generation_id",
                ],
                "asset_policy": "primary_asset_v1",
                "cdn_credentials": "never_persist",
            },
        },
        "resolve_import": {"status": "pending"},
        "items": items,
    }
    refresh_projection(manifest)
    return manifest


def build_account_scope(
    *, account_key: str, account_email: str, creator_uid: str, server_origin: str
) -> dict[str, Any]:
    """§1.6 계정 재개 정보. 쿼리·fragment·userinfo 를 제거한 origin 만 남긴다."""
    return {
        "kind": "shared_account" if server_origin else "local_account",
        "account_key": account_key or "",
        "account_email": account_email or "",
        "creator_uid_at_accept": creator_uid or "",
        "server_origin": _origin_only(server_origin),
    }


def _origin_only(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    from urllib.parse import urlsplit

    parts = urlsplit(raw)
    if not parts.scheme or not parts.netloc:
        return ""
    host = parts.netloc.rsplit("@", 1)[-1]  # userinfo 제거
    return f"{parts.scheme}://{host}"


def idempotent_transfer_id(project_id: str, key: str) -> str:
    """같은 접수 키에는 항상 같은 transfer_id — 재요청이 두 번째 전송을 만들지 않게.

    ★202 를 보내기 직전에 허브가 죽거나 연결이 끊기면 클라이언트는 접수 성공을 알 수
    없어 같은 요청을 다시 보낸다. 그때 새 ID 를 뽑으면 같은 원본을 두 번 복사·가져오는
    중복 전송이 생긴다. 키가 있으면 ID 자체를 키에서 유도해, 두 번째 요청이 첫 번째
    manifest 를 그대로 찾아 같은 접수증을 받게 한다.
    """
    digest = hashlib.sha256(
        f"{project_id}\x00{key}".encode("utf-8", "replace")
    ).hexdigest()
    return f"idem-{digest[:24]}"


def _ahead_count(manifest: dict[str, Any]) -> int:
    """이 전송보다 FIFO 앞에 있는 '활성' 전송 수.

    ★기록을 마친 **뒤에** 센다. 접수 전에 세면 동시에 들어온 두 요청이 서로를 못 봐
    둘 다 같은 숫자를 보고한다. 그리고 프로젝트의 모든 manifest 루트(현재+기억된)를
    보되 이 프로젝트 것만 센다 — 한 루트에 여러 프로젝트가 섞여 있을 수 있다.
    """
    if queue_state(manifest) not in ACTIVE_STATES:
        return 0  # 이미 끝난 전송(같은 접수 키의 늦은 재요청)은 줄을 서지 않는다.
    project_id = str(manifest.get("project_id") or "")
    transfer_id = str(manifest.get("transfer_id") or "")
    ahead = 0
    for row in scan_projects([project_id], states=ACTIVE_STATES):
        if str(row.get("transfer_id") or "") == transfer_id:
            return ahead
        ahead += 1
    # 목록에서 자기 자신을 못 찾았다면(스캔 상한·경합) 앞을 셌다고 단정하지 않는다.
    return 0


def accept_sync(
    project_id: str,
    generations: list[dict[str, Any]],
    *,
    resolve_target: Optional[dict[str, str]] = None,
    account_scope: Optional[dict[str, Any]] = None,
    transfer_id: Optional[str] = None,
    idempotency_key: str = "",
) -> tuple[dict[str, Any], int, bool]:
    """접수 전용 — 파일 복사·Resolve 조작 없이 v3 manifest 만 원자 기록한다.

    반환은 ``(manifest, 앞 대기 건수, 이미 접수돼 있던 요청인가)``.
    """
    if not project_id:
        raise ResolveTransferError("프로젝트가 지정되지 않았습니다")
    if not generations:
        raise ResolveTransferError("전송할 생성물이 없습니다")
    if any((gen.get("project_id") or "") != project_id for gen in generations):
        raise ResolveTransferError("한 번에 하나의 프로젝트만 전송할 수 있습니다")

    source_root, manifest_root = resolve_transfer.resolve_transfer_roots(project_id)
    # 실제 manifest 가 놓일 루트(대개 NAS)에서 잠금이 되는지 먼저 확인한다(§2.2).
    # 로컬 CONTENT_HUB_DATA 만 검사하면 SMB 가 byte-range 잠금을 주지 않는 팀 공유
    # 폴더에서도 접수가 통과해 이중 드레인 방어선이 없는 채로 큐가 쌓인다.
    ok, detail = _root_locking_ok(manifest_root)
    if not ok:
        raise ResolveTransferError(
            f"이 저장소에서는 Resolve 전송 대기열을 쓸 수 없습니다: {detail}"
        )
    key = str(idempotency_key or "").strip()
    transfer_id = transfer_id or (
        idempotent_transfer_id(project_id, key) if key else resolve_transfer._new_transfer_id()
    )
    manifest = build_manifest(
        project_id,
        generations,
        source_root=source_root,
        manifest_root=manifest_root,
        transfer_id=transfer_id,
        resolve_target=resolve_target,
        account_scope=account_scope or {},
    )
    if key:
        manifest["accept_key"] = key
    path = manifest_path_of(manifest)
    lock = resolve_lock.FileLock(
        resolve_lock.transfer_lock_path(manifest_root, transfer_id)
    )
    try:
        acquired = lock.try_acquire()
    except resolve_lock.ResolveLockUnsupported as exc:
        # 잠금을 신뢰할 수 없는 저장소면 큐를 안전하게 운영할 수 없다. best-effort 로
        # 받아 두면 이중 드레인이 나므로 접수 자체를 거절하고 이유를 알린다.
        raise ResolveTransferError(
            f"이 저장소에서는 Resolve 전송 대기열을 쓸 수 없습니다: {exc}"
        ) from exc
    if not acquired:
        raise ResolveTransferError("같은 전송 ID가 이미 처리 중입니다")
    duplicate = False
    try:
        if path.exists():
            if not key:
                raise ResolveTransferError("같은 전송 ID의 기록이 이미 있습니다")
            # 같은 접수 키의 재요청 — 새로 만들지 않고 첫 접수분을 그대로 돌려준다.
            manifest = read_manifest(path)
            duplicate = True
        else:
            # 교체 성공 뒤에만 성공 응답을 만든다(§1.7 9단계).
            save_manifest(path, manifest)
    finally:
        lock.release()
    # Render 루트를 나중에 옮겨도 이 manifest 를 계속 찾을 수 있게 기억한다.
    remember_manifest_root(project_id, manifest_root)
    return manifest, _ahead_count(manifest), duplicate


async def accept_transfer(
    project_id: str,
    generations: list[dict[str, Any]],
    *,
    resolve_target: Optional[dict[str, str]] = None,
    account_scope: Optional[dict[str, Any]] = None,
    transfer_id: Optional[str] = None,
    idempotency_key: str = "",
) -> tuple[dict[str, Any], int, bool]:
    return await run_non_abandon(
        asyncio.to_thread(
            accept_sync,
            project_id,
            generations,
            resolve_target=resolve_target,
            account_scope=account_scope,
            transfer_id=transfer_id,
            idempotency_key=idempotency_key,
        )
    )


# ── 스캔 ──────────────────────────────────────────────────────────────────────
# 터미널(complete·cancelled) manifest 는 명세상 다시 전이하지 않으므로, 한 번 읽어 본
# 파일은 stat 만으로 건너뛴다. ★터미널만 기억한다 — blocked·failed 처럼 되살아날 수 있는
# 상태를 mtime 기반으로 기억하면 SMB 의 거친 타임스탬프에서 부활을 놓칠 수 있다.
_TERMINAL_MEMO: dict[str, tuple[int, int]] = {}
_TERMINAL_MEMO_GUARD = threading.Lock()
_TERMINAL_MEMO_MAX = 4000


def _memo_key(path: Path) -> str:
    return os.path.normcase(str(path))


def _memoized_terminal(path: Path, stat_result: os.stat_result) -> bool:
    with _TERMINAL_MEMO_GUARD:
        seen = _TERMINAL_MEMO.get(_memo_key(path))
    return seen is not None and seen == (stat_result.st_mtime_ns, stat_result.st_size)


def _memoize_terminal(path: Path, stat_result: os.stat_result) -> None:
    with _TERMINAL_MEMO_GUARD:
        if len(_TERMINAL_MEMO) >= _TERMINAL_MEMO_MAX:
            _TERMINAL_MEMO.clear()
        _TERMINAL_MEMO[_memo_key(path)] = (stat_result.st_mtime_ns, stat_result.st_size)


def reset_scan_memo() -> None:
    with _TERMINAL_MEMO_GUARD:
        _TERMINAL_MEMO.clear()


def _scan_dir(
    manifest_root: Path, *, states: Optional[Iterable[str]] = None
) -> list[dict[str, Any]]:
    """한 프로젝트의 v3 manifest 를 읽는다. v2·손상 파일은 조용히 건너뛴다.

    ★상한은 '고른 항목'에만 건다. 이름순 앞 N개를 먼저 자르면 완료 manifest 가 N개
    쌓인 순간 새 접수분이 영원히 발견되지 않는다(유실 0 위반). 대신 터미널 항목은
    stat 만으로 싸게 걸러 NAS 왕복을 늘리지 않는다.
    """
    wanted = frozenset(states) if states is not None else None
    skip_terminal = wanted is not None and not (wanted & TERMINAL_STATES)
    directory = transfer_dir(manifest_root)
    try:
        entries = sorted(directory.glob("*.json"), key=lambda path: path.name)
    except OSError:
        return []
    if wanted is None:
        # 상태 필터가 없는 요약 조회는 전량 판독이 비싸므로 최신 것부터 상한만큼만 본다.
        entries = entries[-_SCAN_FILE_LIMIT:]
    found: list[dict[str, Any]] = []
    for path in entries:
        try:
            stat_result = path.stat()
            if not stat.S_ISREG(stat_result.st_mode):
                continue
            if skip_terminal and _memoized_terminal(path, stat_result):
                continue
            manifest = read_manifest(path)
        except (OSError, ResolveQueueError):
            continue
        state = queue_state(manifest)
        if state in TERMINAL_STATES:
            _memoize_terminal(path, stat_result)
        if wanted is not None and state not in wanted:
            continue
        found.append(manifest)
        if len(found) >= _SCAN_FILE_LIMIT:
            break
    return found


def _project_roots(project_id: str) -> Optional[tuple[Path, Path]]:
    try:
        return resolve_transfer.resolve_transfer_roots(project_id)
    except (ResolveTransferError, OSError):
        return None


# ── manifest 루트 등록부 (§1.6 destination_changed) ───────────────────────────
# 스캔 위치를 '현재 Render 연결값'으로만 재계산하면 Render 루트를 옮긴 순간 이전 루트의
# manifest 가 통째로 고립된다(대기 중이던 전송이 조용히 사라지고 destination_changed
# 전이도 일어나지 않는다). 접수 때 쓴 루트를 기억해 현재+기억된 루트를 모두 스캔한다.
_ROOT_REGISTRY_FORMAT = "mvhub.resolve-manifest-roots"
_ROOT_REGISTRY_MAX = 8
_ROOT_REGISTRY_GUARD = threading.Lock()


def root_registry_path() -> Path:
    return resolve_lock._resolve_root() / "manifest-roots.json"


def _read_root_registry() -> dict[str, Any]:
    try:
        data = json.loads(root_registry_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict) or data.get("format") != _ROOT_REGISTRY_FORMAT:
        return {}
    projects = data.get("projects")
    return projects if isinstance(projects, dict) else {}


def known_manifest_roots(project_id: str) -> list[Path]:
    """이 프로젝트로 접수한 적이 있는 manifest 루트들(최근 순)."""
    rows = _read_root_registry().get(str(project_id or ""))
    if not isinstance(rows, list):
        return []
    return [Path(str(row)) for row in rows if isinstance(row, str) and row]


def remember_manifest_root(project_id: str, manifest_root: Path) -> None:
    """접수한 루트를 기억한다. 실패해도 접수 자체를 깨지 않는다(다음 접수가 다시 시도)."""
    project_id = str(project_id or "")
    if not project_id:
        return
    wanted = str(manifest_root)
    with _ROOT_REGISTRY_GUARD:
        projects = _read_root_registry()
        rows = [
            row
            for row in (projects.get(project_id) or [])
            if isinstance(row, str) and path_identity(row) != path_identity(wanted)
        ]
        projects[project_id] = [wanted, *rows][:_ROOT_REGISTRY_MAX]
        with contextlib.suppress(OSError):
            atomic_write_text(
                root_registry_path(),
                json.dumps(
                    {
                        "format": _ROOT_REGISTRY_FORMAT,
                        "version": 1,
                        "projects": projects,
                    },
                    ensure_ascii=False,
                    indent=2,
                    sort_keys=True,
                )
                + "\n",
            )


def project_scan_roots(project_id: str) -> list[Path]:
    """현재 Render 연결이 가리키는 루트 + 접수 때 기억해 둔 루트(중복 제거)."""
    roots: list[Path] = []
    current = _project_roots(project_id)
    if current is not None:
        roots.append(current[1])
    roots.extend(known_manifest_roots(project_id))
    unique: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        key = path_identity(root)
        if not key or key in seen:
            continue
        seen.add(key)
        unique.append(root)
    return unique


def scan_projects(
    project_ids: list[str], *, states: Optional[Iterable[str]] = None
) -> list[dict[str, Any]]:
    """등록된 프로젝트들의 v3 큐를 FIFO(created_at_ns, transfer_id) 로 모은다."""
    found: list[dict[str, Any]] = []
    seen_transfers: set[tuple[str, str]] = set()
    for project_id in dict.fromkeys(pid for pid in project_ids if pid):
        for root in project_scan_roots(project_id):
            for manifest in _scan_dir(root, states=states):
                if str(manifest.get("project_id") or "") != project_id:
                    continue
                key = (project_id, str(manifest.get("transfer_id") or ""))
                if key in seen_transfers:
                    continue
                seen_transfers.add(key)
                found.append(manifest)
    found.sort(key=fifo_key)
    return found


def queue_snapshot(project_ids: list[str], *, limit: int = 50) -> list[dict[str, Any]]:
    """GET /api/resolve/queue 응답용 요약. ahead 는 같은 FIFO 안의 앞선 활성 건수."""
    manifests = scan_projects(project_ids)
    active_seen = 0
    rows: list[dict[str, Any]] = []
    for manifest in manifests:
        state = queue_state(manifest)
        block = queue_block(manifest)
        last_error = block.get("last_error") if isinstance(block.get("last_error"), dict) else None
        rows.append(
            {
                "transfer_id": str(manifest.get("transfer_id") or ""),
                "project_id": str(manifest.get("project_id") or ""),
                "project_name": str(manifest.get("project_name") or ""),
                "resolve_target": manifest.get("resolve_target") or {},
                "state": state,
                "dispatch_policy": dispatch_policy(manifest),
                "created_at": str(manifest.get("created_at") or ""),
                "state_changed_at": str(block.get("state_changed_at") or ""),
                "revision": block.get("revision") or 0,
                "total": int(manifest.get("total") or 0),
                "downloaded": int(manifest.get("downloaded") or 0),
                "skipped": int(manifest.get("skipped") or 0),
                "error_count": int(manifest.get("error_count") or 0),
                "ahead": active_seen if state in ACTIVE_STATES else 0,
                "blocked": block.get("blocked"),
                "recovery": manifest.get("recovery"),
                "cancel": block.get("cancel"),
                # 오래 걸리는 가져오기 경고(자동 kill 없음) — UI 가 Resolve 창 확인을 안내한다.
                "warning": import_warning(manifest),
                "error_code": (last_error or {}).get("code"),
                "error": (last_error or {}).get("message"),
            }
        )
        if state in ACTIVE_STATES:
            active_seen += 1
    return rows[: max(1, limit)]


def find_manifest(project_ids: list[str], transfer_id: str) -> dict[str, Any]:
    """transfer_id 로 v3 manifest 한 건을 찾는다(없으면 예외)."""
    wanted = str(transfer_id or "")
    for manifest in scan_projects(project_ids):
        if str(manifest.get("transfer_id") or "") == wanted:
            return manifest
    raise ResolveQueueError("전송 기록을 찾을 수 없습니다")


# ── 사용자 조작: 취소 · 수동 재시도 ───────────────────────────────────────────
CANCEL_IMPORT_NEEDS_FORCE = (
    "Resolve 가져오기가 진행 중입니다. 강제 중단을 선택하면 Resolve 조작을 즉시 끊고 "
    "복구 확인이 필요한 상태로 둡니다"
)


def cancel_sync(
    manifest: dict[str, Any], *, force: bool = False, requested_by: str = ""
) -> dict[str, Any]:
    """취소를 접수한다(§D — 일반 취소는 협력적, 강제 중단은 명시 확인일 때만).

    반환 ``{"state", "applied", "cooperative", "force"}``. ``applied`` 가 False 면
    지금 실행 중인 워커가 항목·단계 경계에서 멈춘 뒤 상태를 확정한다.
    """
    path = manifest_path_of(manifest)
    transfer_id = str(manifest.get("transfer_id") or "")
    state = queue_state(manifest)
    if state in TERMINAL_STATES:
        raise ResolveQueueError("이미 끝난 전송입니다")
    if state == STATE_IMPORTING and not force:
        raise ResolveQueueError(CANCEL_IMPORT_NEEDS_FORCE)
    request = request_cancel(transfer_id, force=force, requested_by=requested_by)
    lock = transfer_lock(manifest)
    try:
        acquired = lock.try_acquire()
    except resolve_lock.ResolveLockUnsupported:
        acquired = False
    if not acquired:
        # 지금 워커가 쥐고 있다 — manifest 는 그 워커만 쓸 수 있으므로 요청표에 맡긴다.
        return {
            "state": state,
            "applied": False,
            "cooperative": True,
            "force": bool(force),
        }
    try:
        current = read_manifest(path)
        state = queue_state(current)
        if state in TERMINAL_STATES:
            clear_cancel(transfer_id)
            return {
                "state": state,
                "applied": False,
                "cooperative": False,
                "force": bool(force),
            }
        record_cancel(current, request)
        if state == STATE_IMPORTING:
            # 락이 비었는데 importing = 소유자가 이미 죽었다. Media Pool 이 어디까지
            # 바뀌었는지 알 수 없으므로 폐기가 아니라 복구 확인으로 보낸다(§D).
            current["recovery"] = build_recovery(
                current,
                reason="force_cancelled_import",
                attempt=latest_attempt(current),
            )
            set_state(
                current,
                STATE_RECOVERY_REQUIRED,
                error={
                    "code": "cancelled",
                    "message": "가져오기를 강제로 중단했습니다. Resolve Bin 상태를 확인하세요",
                },
                policy=DISPATCH_MANUAL_ONLY,
                clear_claim=True,
            )
            new_state = STATE_RECOVERY_REQUIRED
        else:
            set_state(
                current,
                STATE_CANCELLED,
                error={"code": "cancelled", "message": "사용자가 전송을 폐기했습니다"},
                clear_claim=True,
            )
            new_state = STATE_CANCELLED
        save_manifest(path, current)
    finally:
        lock.release()
    clear_cancel(transfer_id)
    return {
        "state": new_state,
        "applied": True,
        "cooperative": False,
        "force": bool(force),
    }


def resume_sync(manifest: dict[str, Any]) -> dict[str, Any]:
    """사용자 확인 뒤의 수동 재시도(§1.3 ``failed``/``interrupted``/``recovery_required``).

    자동 재실행은 여전히 금지다 — 이 함수는 사용자가 버튼을 눌렀을 때만 불린다.
    ``recovery_required`` 는 한 번에 되살리지 않는다. 사용자가 Resolve 에서 Bin·DRP 를
    처리했다는 확인을 받아 ``interrupted`` 까지만 내리고, 누락분 재실행은 한 번 더
    확인받는다(§3.5 버튼 흐름).
    """
    path = manifest_path_of(manifest)
    lock = transfer_lock(manifest)
    if not lock.try_acquire():
        raise ResolveQueueError("지금 처리 중인 전송입니다. 잠시 뒤 다시 시도하세요")
    try:
        current = read_manifest(path)
        state = queue_state(current)
        prepared = int(current.get("downloaded") or 0) + int(current.get("skipped") or 0)
        if state == STATE_RECOVERY_REQUIRED:
            current["recovery"] = build_recovery(
                current, reason="user_verified_bins", attempt=latest_attempt(current)
            )
            set_state(current, STATE_INTERRUPTED, policy=DISPATCH_MANUAL_ONLY)
            target = STATE_INTERRUPTED
        elif state == STATE_INTERRUPTED:
            recovery = build_recovery(
                current, reason="interrupted_import_missing_items", attempt=latest_attempt(current)
            )
            current["recovery"] = recovery
            if not recovery["missing_count"]:
                # 재검사 결과 누락 0개 — 그대로 확정한다(§3.3 4단계).
                current["completed_at"] = _utc_now()
                set_state(current, STATE_COMPLETE, clear_claim=True)
                target = STATE_COMPLETE
            else:
                set_state(current, STATE_READY, policy=DISPATCH_AUTO, clear_claim=True)
                target = STATE_READY
        elif state in {STATE_FAILED, STATE_BLOCKED}:
            target = STATE_READY if prepared else STATE_QUEUED
            set_state(current, target, policy=DISPATCH_AUTO, clear_claim=True)
            queue_block(current)["blocked_retry_count"] = 0
        else:
            raise ResolveQueueError("지금은 다시 시도할 수 없는 상태입니다")
        save_manifest(path, current)
    finally:
        lock.release()
    return {"state": target, "recovery": current.get("recovery")}


# ── attempt journal (§부속 A) ─────────────────────────────────────────────────
def attempt_path(manifest: dict[str, Any], attempt_id: str) -> Path:
    return attempt_dir(
        Path(str(manifest.get("manifest_root") or "")),
        str(manifest.get("transfer_id") or ""),
    ) / f"{attempt_id}.json"


def write_attempt(
    manifest: dict[str, Any],
    attempt: dict[str, Any],
) -> Path:
    path = attempt_path(manifest, str(attempt.get("attempt_id") or ""))
    attempt["updated_at"] = _utc_now()
    atomic_write_text(
        path, json.dumps(attempt, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    )
    return path


def new_attempt(
    manifest: dict[str, Any], *, attempt_id: str, claim: dict[str, Any], executor: str
) -> dict[str, Any]:
    target = manifest.get("resolve_target") or {}
    now = _utc_now()
    return {
        "format": ATTEMPT_FORMAT,
        "version": ATTEMPT_VERSION,
        "transfer_id": str(manifest.get("transfer_id") or ""),
        "attempt_id": attempt_id,
        "claim_token": str(claim.get("token") or ""),
        "claim_epoch": claim.get("epoch") or 0,
        "executor": executor,
        "pid": os.getpid(),
        # 자식이 시작하면 자기 PID·생성시각으로 덮어쓴다. 부모가 만든 이 초기 기록은
        # 아직 실행자가 없다는 뜻이라 0 이어야 한다(생존 판정이 부모를 자식으로 오인 금지).
        "executor_pid": 0,
        "host_id": resolve_lock.host_id(),
        "process_started_at_filetime": resolve_lock.process_started_at_filetime(),
        "started_at": now,
        "updated_at": now,
        "phase": "child_started",
        "side_effects_started": False,
        "resolve_project": {
            "expected_id": str(target.get("project_id") or ""),
            "current_id": "",
            "current_name": "",
        },
        "staging_bin": "",
        "drp_path": "",
        "last_batch": None,
        "result": None,
        "error_code": None,
        "error": None,
    }


def read_attempt(manifest: dict[str, Any], attempt_id: str) -> Optional[dict[str, Any]]:
    """자식이 기록해 둔 attempt journal 한 건을 읽는다(없거나 손상이면 None)."""
    if not attempt_id:
        return None
    try:
        data = json.loads(attempt_path(manifest, attempt_id).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) and data.get("format") == ATTEMPT_FORMAT else None


def executor_liveness(attempt: Optional[dict[str, Any]]) -> str:
    """``none`` | ``alive`` | ``dead`` | ``unknown`` — journal 이 가리키는 자식의 생존(§2.7).

    부모(허브)가 죽어도 Resolve 를 조작하던 자식은 살아 있을 수 있다. 그 상태에서 다른
    실행자가 같은 프로젝트를 가져오면 Media Pool 이 동시에 변형된다. 부모 사망만으로
    인계하지 않도록 자식 PID+생성시각까지 확인한다.
    """
    if not isinstance(attempt, dict):
        return "none"
    # ★``executor_pid`` 만 본다. ``pid`` 는 부모가 초기 기록을 남길 때 자기 PID 를 적는
    # 필드라, 그걸 자식으로 오인하면 PID 재사용 시 멀쩡한 큐를 영원히 붙들 수 있다.
    try:
        pid = int(attempt.get("executor_pid") or 0)
    except (TypeError, ValueError):
        pid = 0
    if pid <= 0 or pid == os.getpid():
        return "none"
    host = str(attempt.get("host_id") or "")
    if host and host != resolve_lock.host_id():
        return "unknown"  # 다른 PC 의 자식은 여기서 판정할 수 없다.
    return resolve_lock.process_liveness(
        pid, str(attempt.get("process_started_at_filetime") or "")
    )


def latest_attempt(manifest: dict[str, Any]) -> Optional[dict[str, Any]]:
    directory = attempt_dir(
        Path(str(manifest.get("manifest_root") or "")),
        str(manifest.get("transfer_id") or ""),
    )
    try:
        paths = sorted(directory.glob("*.json"), key=lambda path: path.stat().st_mtime)
    except OSError:
        return None
    for path in reversed(paths):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(data, dict) and data.get("format") == ATTEMPT_FORMAT:
            return data
    return None


def is_orphan_rebuild_bin(name: str) -> bool:
    return bool(ORPHAN_BIN_RE.fullmatch(str(name or "")))


def orphan_staging_bin(attempt: Optional[dict[str, Any]]) -> str:
    """중단된 attempt 가 남겼을 수 있는 staging Bin 이름(없으면 빈 문자열)."""
    if not isinstance(attempt, dict):
        return ""
    name = str(attempt.get("staging_bin") or "")
    if not name or not is_orphan_rebuild_bin(name):
        return ""
    if str(attempt.get("phase") or "") in REBUILD_PENDING_PHASES:
        return name
    return ""


# ── 준비 파일 무결성 (§3.2) ───────────────────────────────────────────────────
INTEGRITY_MISMATCH = "integrity_mismatch"
_HASH_CHUNK = 1024 * 1024


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        while chunk := handle.read(_HASH_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def verify_prepared_items(manifest: dict[str, Any]) -> int:
    """import 직전 준비 파일이 기록과 같은지 확인한다. 반환=불일치로 떨어뜨린 항목 수.

    복사 때 스트림에서 계산한 ``sha256`` 이 권위다. 매번 전량 재해시하면 대용량 전송에서
    NAS 를 한 번 더 통째로 읽으므로, ``size``+``mtime_ns`` 가 기록과 같으면 그 파일은
    복사 이후 바뀌지 않은 것으로 보고 재해시를 건너뛴다. 크기·시각이 다르면 그때만
    전체 해시로 확정한다. 기록에 sha256 이 없는 옛 항목은 여기서 1회 해시해 채운다.
    """
    dropped = 0
    for item in manifest.get("items") or []:
        if not isinstance(item, dict):
            continue
        prepare = item.get("prepare") if isinstance(item.get("prepare"), dict) else None
        if prepare is None or prepare.get("state") not in {
            PREPARE_DOWNLOADED,
            PREPARE_SKIPPED,
        }:
            continue
        local = Path(str(item.get("local_path") or ""))
        reason = None
        try:
            stat_result = local.stat()
            if not stat.S_ISREG(stat_result.st_mode) or stat_result.st_size <= 0:
                reason = "준비한 원본 파일이 없습니다"
            elif prepare.get("size") is not None and int(prepare["size"]) != stat_result.st_size:
                reason = "준비한 원본 파일의 크기가 달라졌습니다"
            elif not prepare.get("sha256"):
                prepare["sha256"] = file_sha256(local)
                prepare["size"] = stat_result.st_size
                prepare["mtime_ns"] = stat_result.st_mtime_ns
            elif prepare.get("mtime_ns") != stat_result.st_mtime_ns:
                if file_sha256(local) != str(prepare.get("sha256") or ""):
                    reason = "준비한 원본 파일의 내용이 달라졌습니다"
                else:
                    prepare["mtime_ns"] = stat_result.st_mtime_ns
        except OSError as exc:
            reason = f"준비한 원본 파일을 확인할 수 없습니다: {exc}"
        if reason:
            prepare["state"] = PREPARE_ERROR
            prepare["error_code"] = INTEGRITY_MISMATCH
            prepare["error"] = reason
            dropped += 1
    if dropped:
        refresh_projection(manifest)
    return dropped


def prepared_error_codes(manifest: dict[str, Any]) -> list[tuple[str, str]]:
    """준비 단계에서 실패로 남은 항목의 (error_code, error) 목록."""
    rows: list[tuple[str, str]] = []
    for item in manifest.get("items") or []:
        if not isinstance(item, dict):
            continue
        prepare = item.get("prepare") if isinstance(item.get("prepare"), dict) else {}
        if prepare.get("state") == PREPARE_ERROR:
            rows.append(
                (
                    str(prepare.get("error_code") or "unexpected_error"),
                    str(prepare.get("error") or ""),
                )
            )
    return rows


def write_recovery_incident(manifest: dict[str, Any], payload: dict[str, Any]) -> Path:
    target = manifest.get("resolve_target") or {}
    key = str(target.get("project_id") or target.get("project_name") or "unknown")
    path = recovery_path(Path(str(manifest.get("manifest_root") or "")), key)
    body = {
        "format": "mvhub.resolve-recovery",
        "version": 1,
        "resolve_project_key": key,
        "created_at": _utc_now(),
        **payload,
    }
    atomic_write_text(
        path, json.dumps(body, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    )
    return path


# ── 부팅 복구 (§1.3 상태표 · §2.7) ────────────────────────────────────────────
def _recover_one(manifest: dict[str, Any]) -> Optional[str]:
    """한 건을 복구 상태로 전이한다. 반환값은 새 상태(변경 없으면 None)."""
    state = queue_state(manifest)
    if state not in {STATE_QUEUED, STATE_PREPARING, STATE_READY, STATE_IMPORTING}:
        return None
    disposition = claim_disposition(manifest)
    if disposition == "alive":
        return None  # 살아 있는 소유자의 작업은 건드리지 않는다.

    path = manifest_path_of(manifest)
    lock = transfer_lock(manifest)
    try:
        if not lock.try_acquire():
            return None  # OS 락 보유자가 있으면 실행 중이다.
    except resolve_lock.ResolveLockUnsupported:
        return None
    try:
        current = read_manifest(path)
        state = queue_state(current)
        if state not in {STATE_QUEUED, STATE_PREPARING, STATE_READY, STATE_IMPORTING}:
            return None
        attempt = latest_attempt(current) if state == STATE_IMPORTING else None
        if executor_liveness(attempt) == "alive":
            # ★부모(허브)가 죽어도 Resolve 를 조작하던 자식은 살아 있을 수 있다. OS 락은
            # 부모와 함께 풀렸으므로 락만 보고 인계하면 같은 Media Pool 을 둘이 만진다.
            # 상태를 건드리지 않고 이 프로젝트의 드레인을 보류한다(§2.7 자동 steal 금지).
            return "import_executor_alive"
        if disposition == "unknown":
            # 소유자 사망을 확인할 수 없으면 자동 steal 금지 — 격리한다.
            set_state(
                current,
                STATE_RECOVERY_REQUIRED,
                error={
                    "code": "claim_lost",
                    "message": "이전 가져오기 프로세스가 끝났는지 확인할 수 없습니다",
                },
                policy=DISPATCH_MANUAL_ONLY,
            )
            save_manifest(path, current)
            return STATE_RECOVERY_REQUIRED

        if state in {STATE_QUEUED, STATE_PREPARING}:
            # 준비는 목적지 파일 내용 비교로 멱등하므로 안전하게 재큐잉한다.
            set_state(current, STATE_QUEUED, clear_claim=True)
            save_manifest(path, current)
            return STATE_QUEUED
        if state == STATE_READY:
            set_state(current, STATE_READY, clear_claim=True)
            save_manifest(path, current)
            return STATE_READY

        # importing 중단분: 결과를 확정하지 못했으므로 자동 재실행하지 않는다.
        staging = orphan_staging_bin(attempt)
        if staging:
            current["recovery"] = {
                "reason": "orphan_rebuild_bin",
                "staging_bin": staging,
                "drp_path": str((attempt or {}).get("drp_path") or ""),
                "verified_at": _utc_now(),
            }
            write_recovery_incident(
                current,
                {
                    "reason": "orphan_rebuild_bin",
                    "transfer_id": str(current.get("transfer_id") or ""),
                    "staging_bin": staging,
                    "drp_path": str((attempt or {}).get("drp_path") or ""),
                },
            )
            set_state(
                current,
                STATE_RECOVERY_REQUIRED,
                error={
                    "code": "orphan_rebuild_bin",
                    "message": (
                        "Resolve Bin 재정렬이 끝나기 전에 중단된 흔적을 발견했습니다. "
                        f"임시 Bin {staging} 을(를) 확인한 뒤 복구 방법을 선택하세요"
                    ),
                },
                policy=DISPATCH_MANUAL_ONLY,
                clear_claim=True,
            )
            save_manifest(path, current)
            return STATE_RECOVERY_REQUIRED

        # 누락 목록은 자동으로 만든다. 실제 재실행은 사용자 확인 전에는 하지 않는다(§3.3).
        current["recovery"] = build_recovery(
            current, reason="interrupted_import_missing_items", attempt=attempt
        )
        set_state(
            current,
            STATE_INTERRUPTED,
            error={
                "code": "child_crashed",
                "message": "가져오기 도중 결과를 확정하지 못했습니다",
            },
            policy=DISPATCH_MANUAL_ONLY,
            clear_claim=True,
        )
        save_manifest(path, current)
        return STATE_INTERRUPTED
    except ResolveQueueError:
        return None
    finally:
        lock.release()


def import_held_roots(manifests: Iterable[dict[str, Any]]) -> set[str]:
    """살아 있는 자식(executor)이 붙들고 있는 프로젝트 루트 식별자.

    그 프로젝트의 Resolve 가져오기는 이번 바퀴에 시작하지 않는다. 준비(파일 복사)는
    Resolve 를 만지지 않으므로 계속 진행해도 안전하다.
    """
    held: set[str] = set()
    for manifest in manifests:
        if queue_state(manifest) != STATE_IMPORTING:
            continue
        if executor_liveness(latest_attempt(manifest)) == "alive":
            held.add(path_identity(str(manifest.get("manifest_root") or "")))
    return held


def recover_boot(project_ids: list[str]) -> dict[str, int]:
    """부팅 시 1회 — 상태별 처리표(§1.3·§2.7)를 적용한다."""
    counts: dict[str, int] = {}
    for manifest in scan_projects(project_ids):
        try:
            state = _recover_one(manifest)
        except OSError:
            state = None
        if state:
            counts[state] = counts.get(state, 0) + 1
    return counts


# ── 취소되지 않는 실행 단위 ────────────────────────────────────────────────────
async def run_non_abandon(coro):
    """시작한 코루틴 단위를 끝까지 보장한다(취소는 끝난 뒤 전파).

    '가져오기 실행 + manifest 저장'처럼 결과 기록까지가 한 단위인 구간에 쓴다.
    단순 non-abandon to_thread 로는 실행만 살고 저장이 유기될 수 있다.
    """
    worker = asyncio.create_task(coro)
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        while not worker.done():
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.shield(worker)
        if not worker.cancelled():
            with contextlib.suppress(Exception):
                worker.result()
        raise
