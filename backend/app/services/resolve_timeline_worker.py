"""타임라인 Resolve 보내기의 자식 프로세스 — 원본 가져오기에 이어 새 타임라인을 짓는다.

표준입력: ``{"manifest": <전송 manifest v2>, "timeline": <검증된 계획>}``
표준출력 한 줄: ``MVHUB_RESOLVE_TIMELINE=<json {"import": 가져오기 결과, "timeline": 타임라인 결과}>``

가져오기와 타임라인 짓기를 **한 프로세스**에서 잇는다 — fusionscript 는 버전이 안 맞으면 프로세스를 죽이므로 백엔드 밖에서
돌리고(resolve_import_worker 와 같은 이유), 방금 가져온 클립을 같은 연결에서 다시 찾는다. 업데이트를 막는 전송 보호
(transfer_lease)는 **가져오기부터 타임라인이 끝날 때까지** 이 자식이 쥔다 — 부모가 죽어도 풀리지 않는다(Codex 설계 검토).
가져오기가 전부 끝나지 않았으면(일부 실패·연결 실패) 타임라인은 만들지 않는다 — 빠진 클립이 있는 타임라인은 '그대로'가 아니다.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from .resolve_import_worker import _journal_unavailable, _run_import
from .resolve_timeline import build_timeline, new_result
from .resolve_transfer_gate import (
    ResolveTransferGateBusy,
    ResolveTransferGateError,
    transfer_lease,
)

RESULT_PREFIX = "MVHUB_RESOLVE_TIMELINE="


def run(payload: dict[str, Any]) -> dict[str, Any]:
    manifest = payload.get("manifest") if isinstance(payload.get("manifest"), dict) else {}
    plan = payload.get("timeline") if isinstance(payload.get("timeline"), dict) else {}
    try:
        with transfer_lease():
            imported = _run_import(manifest)
            if imported.get("status") != "complete":
                timeline = new_result(
                    status="unavailable",
                    error=str(imported.get("error") or "원본을 Resolve 로 다 가져오지 못해 타임라인을 만들지 않았습니다"),
                    error_code="import_incomplete",
                )
            else:
                timeline = build_timeline(manifest, plan)
    except ResolveTransferGateError as exc:
        code = "update_in_progress" if isinstance(exc, ResolveTransferGateBusy) else "transfer_guard_failed"
        imported = {**_journal_unavailable(str(exc)), "error_code": code}
        timeline = new_result(status="unavailable", error=str(exc), error_code=code)
    return {"import": imported, "timeline": timeline}


def main() -> None:
    payload = json.load(sys.stdin)
    # 가져오기·타임라인 짓기는 내부 예외를 결과로 바꿔 항상 dict 를 돌려준다. 프로세스가 죽는 경우만 부모가 종료 코드로 안다.
    print(RESULT_PREFIX + json.dumps(run(payload), ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
