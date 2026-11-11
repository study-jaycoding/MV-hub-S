"""패널 Resolve 자식 — 입력 JSON 하나를 받고 결과 한 줄을 돌려준다."""
from __future__ import annotations

import json
import sys

from .resolve_bridge import panel_operation
from .resolve_transfer_gate import ResolveTransferGateError, transfer_lease

RESULT_PREFIX = "MVHUB_RESOLVE_PANEL="


def run(payload: dict) -> dict:
    try:
        if payload["operation"] == "current-bin":
            return panel_operation(payload)
        # 부모가 끊겨도 변경 중인 자식이 업데이트 보호를 쥔다.
        with transfer_lease():
            return panel_operation(payload)
    except ResolveTransferGateError as exc:
        return {"state": "unavailable", "details": str(exc)}


def main() -> None:
    print(RESULT_PREFIX + json.dumps(run(json.load(sys.stdin)), ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
