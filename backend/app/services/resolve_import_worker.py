"""크래시 격리가 가능한 DaVinci Resolve 가져오기 작업 프로세스.

fusionscript(C 확장)는 Resolve 버전과 파이썬 버전이 비호환이면 예외 없이
프로세스를 즉시 죽일 수 있다(0xC0000005). Media Pool 가져오기를 백엔드와
분리된 프로세스에서 실행해 서버가 함께 죽지 않게 하고, PC별로 호환되는
파이썬 인터프리터를 골라 실행할 수 있게 한다. 표준입력으로 manifest JSON을
받아 결과 JSON 한 줄을 표준출력으로 돌려준다.

부모는 이 프로세스의 stdout 만 기다리므로 중간 단계를 볼 수 없다. 그래서 자식이
직접 attempt journal(명세 §부속 A)에 자기 PID·시작시각·phase·staging Bin 이름을
원자 기록한다. 부모가 죽어도 부팅 복구기가 이 기록으로 '자식이 아직 살아 있는지',
'고아 임시 Bin 이 남았는지'를 실데이터로 판정할 수 있다.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import resolve_lock
from .atomic_io import atomic_write_text
from .resolve_bridge import (
    import_manifest_to_current_project,
    inspect_manifest_bins,
    set_journal_hook,
)


RESULT_PREFIX = "MVHUB_RESOLVE_IMPORT="
JOURNAL_UNAVAILABLE = "journal_unavailable"
# 표준입력 봉투의 모드 키. manifest 에는 없는 이름이라 기존 '맨 manifest' 입력과 구분된다.
MODE_KEY = "mvhub_mode"
INSPECT_MODE = "inspect_bins"
# ★resolve_queue.attempt_dir 과 같은 규칙이어야 한다. 여기서 resolve_queue 를 import 하면
# repo(DB) 계층까지 자식 프로세스로 끌려오므로 경로 계산만 옮겨 두고, 두 계산이 같은 경로를
# 내는지는 테스트가 지킨다(test_resolve_queue: 자식 journal 경로 계약).
_ATTEMPT_FORMAT = "mvhub.resolve-attempt"
_ATTEMPT_VERSION = 1


def attempt_journal_path(manifest: dict[str, Any]) -> Path | None:
    """이번 attempt 의 journal 경로. v2 manifest(큐 밖 재시도)에는 없다."""
    manifest_root = str(manifest.get("manifest_root") or "")
    transfer_id = str(manifest.get("transfer_id") or "")
    queue = manifest.get("queue") if isinstance(manifest.get("queue"), dict) else {}
    attempt_id = str(queue.get("last_attempt_id") or "")
    if not manifest_root or not transfer_id or not attempt_id:
        return None
    return (
        Path(manifest_root) / ".mvhub" / "attempts" / transfer_id / f"{attempt_id}.json"
    )


class AttemptJournal:
    """자식이 소유하는 attempt journal. 모든 갱신은 원자 교체다."""

    def __init__(self, path: Path, manifest: dict[str, Any]) -> None:
        self.path = path
        queue = manifest.get("queue") if isinstance(manifest.get("queue"), dict) else {}
        claim = queue.get("claim") if isinstance(queue.get("claim"), dict) else {}
        target = manifest.get("resolve_target") or {}
        now = _utc_now()
        self.record: dict[str, Any] = {
            "format": _ATTEMPT_FORMAT,
            "version": _ATTEMPT_VERSION,
            "transfer_id": str(manifest.get("transfer_id") or ""),
            "attempt_id": str(queue.get("last_attempt_id") or ""),
            "claim_token": str(claim.get("token") or ""),
            "claim_epoch": claim.get("epoch") or 0,
            "executor": "push_worker",
            # ★자식 PID 다. 부모 PID 로 착각하면 '부모 사망=인계 가능'으로 오판한다.
            "pid": os.getpid(),
            "executor_pid": os.getpid(),
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

    def write(self) -> None:
        self.record["updated_at"] = _utc_now()
        atomic_write_text(
            self.path,
            json.dumps(self.record, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        )

    def note(self, phase: str, **fields: Any) -> None:
        self.record["phase"] = phase
        for key, value in fields.items():
            if key == "side_effects_started":
                # 한 번 True 면 되돌리지 않는다 — 부수효과 이력은 지워지면 안 된다.
                self.record[key] = bool(self.record.get(key)) or bool(value)
            else:
                self.record[key] = value
        try:
            self.write()
        except OSError:
            pass  # 중간 기록 실패는 가져오기를 멈출 이유가 아니다(첫 기록만 필수).

    def finish(self, result: dict[str, Any]) -> None:
        status = str(result.get("status") or "")
        self.record["result"] = {
            "status": status,
            "imported": int(result.get("imported") or 0),
            "skipped": int(result.get("skipped") or 0),
            "error_count": int(result.get("error_count") or 0),
        }
        self.record["error_code"] = result.get("error_code")
        self.record["error"] = result.get("error")
        self.record["phase"] = "complete" if status == "complete" else "failed"
        try:
            self.write()
        except OSError:
            pass


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _journal_unavailable(message: str) -> dict[str, Any]:
    return {
        "status": "unavailable",
        "error_code": JOURNAL_UNAVAILABLE,
        "project_name": "",
        "target_root": "",
        "total": 0,
        "imported": 0,
        "skipped": 0,
        "error_count": 0,
        "error": message,
        "items": [],
    }


def run(manifest: dict[str, Any]) -> dict[str, Any]:
    path = attempt_journal_path(manifest)
    journal = None
    if path is not None:
        journal = AttemptJournal(path, manifest)
        try:
            # 첫 기록은 Resolve 연결보다 먼저다. 실패하면 Resolve 를 부르지 않는다 —
            # 부수효과를 남길 수 있는데 그 흔적을 적을 곳이 없기 때문이다(§부속 A).
            journal.write()
        except OSError as exc:
            return _journal_unavailable(f"가져오기 기록을 남길 수 없습니다: {exc}")
        set_journal_hook(journal.note)
    try:
        result = import_manifest_to_current_project(manifest)
    finally:
        set_journal_hook(None)
    if journal is not None:
        journal.finish(result)
    return result


def main() -> None:
    payload = json.load(sys.stdin)
    if isinstance(payload, dict) and payload.get(MODE_KEY) == INSPECT_MODE:
        # 실사 조회 모드 — Media Pool 을 읽기만 한다. attempt journal 을 남기지 않는 것이
        # 계약이다: 이 경로에는 부수효과가 없으므로 기록할 '시도'가 없다.
        result = inspect_manifest_bins(payload.get("manifest") or {})
    else:
        # import_manifest_to_current_project 는 내부 예외를 unavailable 결과로 바꿔
        # 항상 dict 를 돌려준다. 프로세스가 죽는 경우만 부모가 종료 코드로 감지한다.
        result = run(payload)
    print(RESULT_PREFIX + json.dumps(result, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
