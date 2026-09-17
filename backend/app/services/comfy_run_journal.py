"""Comfy 미회수 원장의 로컬 I/O. 네트워크·실행 스레드·HTTP를 소유하지 않는다."""

from __future__ import annotations

import copy
import json
import threading
import time
from contextlib import contextmanager
from typing import Any, Iterator

from .. import repo
from ..db_paths import get_db_path

KEY = "comfy_run_journal"
LEGACY_KEY = "comfy_inflight_runs"
CAP = 200
LOCK = threading.Lock()
_JOURNAL_BOOTSTRAPPED: set[tuple[str, bool]] = set()


class JournalError(RuntimeError):
    pass


class JournalFull(JournalError):
    pass


def _load_locked() -> dict[str, Any]:
    raw = repo.get_setting(KEY)
    if not raw:
        return {"v": 1, "legacy_imported": False, "runs": []}
    try:
        value = json.loads(raw)
    except (TypeError, ValueError) as error:
        raise JournalError("Comfy 실행 기록을 읽을 수 없습니다") from error
    if (not isinstance(value, dict) or value.get("v") != 1
            or not isinstance(value.get("runs"), list)
            or any(not isinstance(row, dict) or not isinstance(row.get("job_id"), str)
                   for row in value["runs"])):
        # 알 수 없는/손상된 봉투를 빈 목록으로 덮어쓰면 이미 접수한 실행 증거가 사라진다.
        raise JournalError("Comfy 실행 기록 형식을 확인할 수 없습니다")
    return value


def _write_locked(value: dict[str, Any]) -> None:
    repo.set_setting(KEY, json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def all_downloaded(row: dict[str, Any]) -> bool:
    outputs = row.get("outputs") or []
    count = row.get("media_output_count")
    return bool(row.get("outputs_enumerated") and isinstance(count, int) and count > 0
                and len(outputs) == count and all(item.get("downloaded") for item in outputs))


def _restored_phase(row: dict[str, Any]) -> str:
    phase = row.get("phase")
    if phase == "submitting":
        return "unknown"
    if phase in ("running", "collecting"):
        if phase == "collecting" and not row.get("outputs_enumerated"):
            previous = row.get("prev_phase")
            return previous if previous in ("orphaned", "result_pending") else "orphaned"
        if row.get("terminal_kind") == "success":
            return "collected" if all_downloaded(row) else "result_pending"
        return "orphaned"
    return str(phase or "orphaned")


def _bootstrap_locked(owner: str, auth_enabled: bool) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    # 요청 owner가 아니라 물리 DB+모드 기준. 같은 경로의 live DB 파일 교체는 감지하지 않는다.
    key = (str(get_db_path().resolve()), bool(auth_enabled))
    value = _load_locked()
    if key in _JOURNAL_BOOTSTRAPPED:
        return value, []
    before = copy.deepcopy(value)
    if not value.get("legacy_imported"):
        if not auth_enabled:
            try:
                legacy = json.loads(repo.get_setting(LEGACY_KEY) or "[]")
            except (TypeError, ValueError):
                legacy = []
            seen = {row["job_id"] for row in value["runs"]}
            for old in legacy if isinstance(legacy, list) else []:
                if (not isinstance(old, dict) or not isinstance(old.get("job_id"), str)
                        or not isinstance(old.get("prompt_id"), str)
                        or old.get("target") not in ("local", "cloud") or old["job_id"] in seen):
                    continue
                seen.add(old["job_id"])
                value["runs"].append({
                    "v": 1, "job_id": old["job_id"], "owner": owner,
                    "phase": "orphaned", "prompt_id": old["prompt_id"],
                    "target_kind": old["target"], "created_at": old.get("created_at"),
                    "updated_at": time.time(), "legacy_imported": True,
                    "evidence_incomplete": True, "outputs_enumerated": False,
                    "media_output_count": 0, "outputs": [], "collect_seq": 0,
                })
        # AUTH on 구기록은 owner 증거가 없다. 이관/노출 없이 원본 키를 동결한다.
        value["legacy_imported"] = True
    eligible = []
    value["runs"] = [row for row in value["runs"] if not (
        row.get("terminal_kind") == "success" and row.get("outputs_enumerated")
        and row.get("text_only") and row.get("media_output_count") == 0 and not row.get("outputs"))]
    for row in value["runs"]:
        if row.get("phase") == "running" and not row.get("terminal_kind"):
            eligible.append(copy.deepcopy(row))
        restored = _restored_phase(row)
        if restored != row.get("phase"):
            row["phase"] = restored
            row["updated_at"] = time.time()
    if value != before:
        _write_locked(value)  # 이관과 marker는 같은 한 번의 원자적 UPSERT.
    _JOURNAL_BOOTSTRAPPED.add(key)
    return value, eligible


def bootstrap(owner: str, auth_enabled: bool) -> list[dict[str, Any]]:
    """로컬 상태 복원만. 반환 후보의 원격 취소는 명시 boot router가 락 밖에서 판단한다."""
    with LOCK:
        _, eligible = _bootstrap_locked(owner, auth_enabled)
        return eligible


def read(owner: str, auth_enabled: bool) -> list[dict[str, Any]]:
    with LOCK:
        value, _ = _bootstrap_locked(owner, auth_enabled)
        return copy.deepcopy(value["runs"])


@contextmanager
def edit(owner: str, auth_enabled: bool) -> Iterator[list[dict[str, Any]]]:
    """한 프로세스의 read/check/write를 직렬화. 안에서 실행 락·네트워크 획득 금지."""
    with LOCK:
        value, _ = _bootstrap_locked(owner, auth_enabled)
        before = copy.deepcopy(value["runs"])
        yield value["runs"]
        if value["runs"] != before:
            _write_locked(value)


def admit(record: dict[str, Any], auth_enabled: bool) -> None:
    with edit(record["owner"], auth_enabled) as runs:
        current = next((row for row in runs if row["job_id"] == record["job_id"]), None)
        if current is None and len(runs) >= CAP:
            raise JournalFull("미해결 Comfy 실행 기록이 가득 찼습니다. 설정에서 확인·정리한 뒤 실행하세요")
        if current is not None:
            if current.get("owner") != record["owner"]:
                raise JournalError("Comfy 실행 기록을 확인할 수 없습니다")
            runs.remove(current)
        runs.append(copy.deepcopy(record))
