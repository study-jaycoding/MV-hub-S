"""라이브러리 연결 자동화(PowerShell — Resolve 의 Connect 창을 다룬다)를 돌리는 자식 프로세스.

문지기(`python -m app.services.resolve_mutation_guard app.services.resolve_library_connect_worker`)를 거쳐 뜬다 — 자동화가 도는 동안
이 프로세스가 Resolve 변경 문(이름 붙은 뮤텍스)을 쥔다. 허브가 쥐면 허브가 죽을 때 문이 풀려, 남은 PowerShell 과 다른 프로세스의
Resolve 변경이 겹친다. 자동화의 제한 시간(80초)과 뒷정리도 허브가 아니라 이 프로세스가 집행하므로 허브가 죽어도 지켜진다.

입력(stdin): {"path": 라이브러리 폴더, "name": 등록할 이름}. 출력: RESULT_PREFIX + {"ok": true, "result": …} 또는 {"ok": false, "message": …}.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from .resolve_library_dialog import CONNECT_RESULT_PREFIX as RESULT_PREFIX, ResolveLibraryDialogError, _run_automation


def main() -> int:
    payload = json.loads(sys.stdin.read())
    try:
        outcome = {"ok": True, "result": _run_automation(Path(payload["path"]), str(payload["name"]))}
    except ResolveLibraryDialogError as exc:
        outcome = {"ok": False, "message": str(exc)}
    print(RESULT_PREFIX + json.dumps(outcome, ensure_ascii=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
