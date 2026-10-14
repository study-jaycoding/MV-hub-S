"""Comfy [실행] 요청표(run_key) 접수 장부 — 응답을 잃은 뒤 같은 요청이 다시 와도 두 번 실행하지 않는다(Jay 결정 2A, 10-15).

미해결 실행 기록(comfy_run_journal)은 성공·정리 때 지워지므로 중복 방지 장부가 될 수 없다. 같은 계정 DB 의 app_setting 한 키에
`{owner, key, fp, job_id, at}` 를 24시간 둔다. 손상·읽기 실패를 빈 장부로 다루지 않는다(실행을 거절한다).
잠금은 이 모듈의 LOCK 하나 — 안에서 잡 잠금·네트워크를 잡지 않는다(잡 정리 스윕과 순서가 엇갈리지 않게).
"""

from __future__ import annotations

import json
import math
import threading
import time
from typing import Any

from .. import repo

KEY = "comfy_run_keys"
KEEP_SEC = 24 * 3600
CAP = 1000
LOCK = threading.Lock()


class RunKeyError(RuntimeError):
    pass


def _finite_time(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(float(value))
    except OverflowError:
        return False


def _load_locked() -> list[dict[str, Any]]:
    try:
        raw = repo.get_setting(KEY)
    except Exception as error:  # noqa: BLE001 — DB 를 못 읽으면 500 이 아니라 '실행하지 않음'(409)으로
        raise RunKeyError("Comfy 실행 접수 장부를 읽을 수 없습니다") from error
    if not raw:
        return []
    try:
        rows = json.loads(raw)
    except (TypeError, ValueError) as error:
        raise RunKeyError("Comfy 실행 접수 장부를 읽을 수 없습니다") from error
    # 접수 시각도 본다 — 빠지거나 유한한 수가 아니면(NaN·무한·넘치는 정수 포함) '만료'로 지워 같은 키를 새로 실행하게 된다(Codex 2A 리뷰)
    if not isinstance(rows, list) or any(
        not isinstance(row, dict)
        or not all(isinstance(row.get(k), str) for k in ("owner", "key", "fp", "job_id"))
        or not _finite_time(row.get("at"))
        for row in rows
    ):
        raise RunKeyError("Comfy 실행 접수 장부 형식을 확인할 수 없습니다")
    return rows


def claim(owner: str, run_key: str, fingerprint: str, job_id: str) -> tuple[str, str]:
    """같은 (owner, run_key) 가 24시간 안에 있으면 ('same' | 'conflict', 그 job_id), 없으면 적고 ('new', job_id)."""
    with LOCK:
        now = time.time()
        rows = [row for row in _load_locked() if now - float(row["at"]) < KEEP_SEC]
        hit = next((row for row in rows if row["owner"] == owner and row["key"] == run_key), None)
        if hit is not None:
            return ("same" if hit["fp"] == fingerprint else "conflict", hit["job_id"])
        rows.append({"owner": owner, "key": run_key, "fp": fingerprint, "job_id": job_id, "at": now})
        try:
            repo.set_setting(KEY, json.dumps(rows[-CAP:], separators=(",", ":")))
        except Exception as error:  # noqa: BLE001 — 적지 못했으면 실행하지 않는다
            raise RunKeyError("Comfy 실행 접수 장부에 적지 못했습니다") from error
        return ("new", job_id)
