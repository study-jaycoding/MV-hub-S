"""호환 Python에서 Resolve에 등록된 Disk 프로젝트 라이브러리 이름만 읽는다.

읽기 전용이다 — 라이브러리를 만들거나 바꾸거나 고르지 않는다. 연결 창을 열기 전에
"이미 등록돼 있나"를 확인하는 데만 쓴다(Resolve는 같은 경로를 두 번 등록하지 못한다).
"""

from __future__ import annotations

import json
from typing import Any

from .resolve_bridge import ResolveBridgeError, _connect_resolve


RESULT_PREFIX = "MVHUB_RESOLVE_LIBRARIES="


def list_disk_library_names() -> dict[str, Any]:
    try:
        resolve = _connect_resolve()
        manager = resolve.GetProjectManager()
        if manager is None:
            return {"status": "failed", "error_code": "manager_unavailable", "names": []}
        names = [
            str(database.get("DbName") or "")
            for database in (manager.GetDatabaseList() or [])
            if str(database.get("DbType") or "").casefold() == "disk"
        ]
        return {"status": "complete", "names": [name for name in names if name]}
    except ResolveBridgeError as exc:
        return {"status": "failed", "error_code": exc.code, "names": []}


def main() -> None:
    print(RESULT_PREFIX + json.dumps(list_disk_library_names(), ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
