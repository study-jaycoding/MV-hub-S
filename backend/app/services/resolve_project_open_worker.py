"""호환 Python에서 Resolve 프로젝트를 여는 격리 작업 프로세스."""

from __future__ import annotations

import json
import re
import sys
from typing import Any

from .resolve_bridge import ResolveBridgeError, _connect_resolve


RESULT_PREFIX = "MVHUB_RESOLVE_PROJECT_OPEN="


def _same_database(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return str(left.get("DbType") or "").casefold() == str(
        right.get("DbType") or ""
    ).casefold() and str(left.get("DbName") or "") == str(right.get("DbName") or "")


def _failure(message: str, code: str) -> dict[str, Any]:
    return {"status": "failed", "error_code": code, "error": message}


# Resolve 가 켜질 때 여는 이름 없는 새 프로젝트('Untitled Project' — 2026-09-22 실측, 뒤 번호는 추정). 이것에
# SaveProject 를 부르면 Resolve 가 이름을 묻는 창을 띄운 채 False 를 돌려준다(실측). 이름 전체가 맞을 때만 본다 —
# 'Untitled Project 테스트' 처럼 사람이 붙인 이름은 이름 있는 프로젝트다(Codex P1). 빗나가면 예전처럼
# SaveProject → 이름 창으로 멈춘다(작업 손실은 없다).
_UNTITLED_NAME = re.compile(r"Untitled Project(?: \d+)?")


def _untitled_state(project: Any) -> tuple[bool, bool]:
    """(이름 없는 새 프로젝트인가, 비어 있는가). API 가 실패하면 '비어 있지 않다'로 본다(안전 쪽)."""
    try:
        if not _UNTITLED_NAME.fullmatch(str(project.GetName() or "")):
            return False, False
    except Exception:  # noqa: BLE001
        return False, False
    try:
        if int(project.GetTimelineCount() or 0) > 0:
            return True, False
        media_pool = project.GetMediaPool()
        root = media_pool.GetRootFolder() if media_pool else None
        if root is None:
            return True, False
        return True, not list(root.GetClipList() or []) and not list(root.GetSubFolderList() or [])
    except Exception:  # noqa: BLE001
        return True, False


def _release_current(manager: Any) -> dict[str, Any] | None:
    """열린 프로젝트를 닫는 호출(SetCurrentDatabase·LoadProject) **바로 앞**에서 정리한다. 계속해도 되면 None.

    판단·저장과 닫기 사이에 새 작업이 끼지 않게 닫기 직전에만 한다(Codex P1). 이름 있는 프로젝트는 저장한다.
    이름 없는 **빈** 새 프로젝트(Resolve 가 켜질 때 여는 것 — 타임라인·클립·폴더 0)는 묻지 않고 저장만 건너뛴다
    (Jay 2026-09-22 — 실제 Resolve 로 확인: 저장 창 없이 5.3초에 전환). 작업이 든 이름 없는 프로젝트는 멈춘다.
    이미 닫혔으면(None) 할 일이 없다. CloseProject 는 부르지 않는다 — 닫으면 Resolve 가 새 Untitled 를 만들 수 있다
    (Codex P0).
    """
    project = manager.GetCurrentProject()
    if project is None:
        return None
    untitled, empty = _untitled_state(project)
    if not untitled:
        if not bool(manager.SaveProject()):
            return _failure("현재 Resolve 프로젝트를 저장하지 못해 프로젝트 전환을 중단했습니다.", "save_failed")
        return None
    if not empty:
        return _failure(
            "Resolve 에 이름 없는 새 프로젝트가 열려 있고 작업이 들어 있습니다. "
            "Resolve 에서 이름을 붙여 저장한 뒤 다시 누르세요.",
            "untitled_unsaved",
        )
    return None


def open_project(payload: dict[str, Any]) -> dict[str, Any]:
    library_name = str(payload.get("library_name") or "").strip()
    project_name = str(payload.get("project_name") or "").strip()
    folder_parts = [str(part) for part in payload.get("folder_parts") or [] if str(part)]
    if not library_name or not project_name:
        return _failure("Resolve 라이브러리와 프로젝트 이름이 필요합니다.", "invalid_request")

    try:
        resolve = _connect_resolve()
        manager = resolve.GetProjectManager()
        if manager is None:
            return _failure("Resolve Project Manager를 열 수 없습니다.", "manager_unavailable")

        databases = list(manager.GetDatabaseList() or [])
        target_database = next(
            (
                database
                for database in databases
                if str(database.get("DbType") or "").casefold() == "disk"
                and str(database.get("DbName") or "") == library_name
            ),
            None,
        )
        if target_database is None:
            return _failure(
                "이 프로젝트의 라이브러리가 Resolve에 연결되지 않았습니다. "
                "먼저 라이브러리 연결을 완료하세요.",
                "library_not_connected",
            )

        current_database = dict(manager.GetCurrentDatabase() or {})
        if not _same_database(current_database, target_database):
            # SetCurrentDatabase 가 열린 프로젝트를 닫는다(21.1 설명서) — 그 바로 앞에서 정리한다.
            if stopped := _release_current(manager):
                return stopped
            if not bool(manager.SetCurrentDatabase(target_database)):
                return _failure(
                    "Resolve 프로젝트 라이브러리로 전환하지 못했습니다.",
                    "database_switch_failed",
                )

        if not bool(manager.GotoRootFolder()):
            return _failure("Resolve 프로젝트 루트로 이동하지 못했습니다.", "root_failed")
        for folder in folder_parts:
            if not bool(manager.OpenFolder(folder)):
                return _failure(
                    f"Resolve 프로젝트 폴더를 열지 못했습니다: {folder}",
                    "folder_open_failed",
                )

        available = {str(name) for name in manager.GetProjectListInCurrentFolder() or []}
        if project_name not in available:
            return _failure(
                "Resolve 라이브러리에서 선택한 프로젝트를 찾지 못했습니다.",
                "project_missing",
            )
        # 같은 라이브러리면 LoadProject 가 열린 프로젝트를 갈아 끼운다 — 그 바로 앞에서 정리한다
        # (라이브러리를 바꿨으면 이미 닫혀 None 이라 할 일이 없다).
        if stopped := _release_current(manager):
            return stopped
        loaded = manager.LoadProject(project_name)
        if loaded is None:
            return _failure("Resolve 프로젝트를 열지 못했습니다.", "load_failed")
        return {
            "status": "complete",
            "project_name": project_name,
            "already_open": False,
            "message": f"{project_name} 프로젝트를 열었습니다.",
        }
    except ResolveBridgeError as exc:
        return _failure(str(exc), exc.code)
    except Exception as exc:  # noqa: BLE001 - 외부 API 실패를 결과 구조로 전달한다.
        return _failure(f"Resolve 프로젝트 열기 중 오류가 발생했습니다: {exc}", "open_failed")


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        payload = {}
    result = open_project(payload if isinstance(payload, dict) else {})
    print(RESULT_PREFIX + json.dumps(result, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
