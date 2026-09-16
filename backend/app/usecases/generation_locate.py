"""선택한 생성물을 현재 라이브러리 위치로 찾는다(읽기 전용, 미디어 IO 없음)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .. import repo


def _empty_location() -> dict[str, Any]:
    return {"items": [], "focus_ids": [], "project_id": None, "folder_path": None}


def _pick_location(
    items: list[dict[str, Any]],
    project_id: str | None,
    folder_path: str | None,
) -> dict[str, Any]:
    if not items:
        return _empty_location()
    # 목록과 같은 최신순(NULL sort_ts는 마지막). 값 자체는 정밀도/커서 호환을 위해 보존한다.
    ordered = sorted(
        items,
        key=lambda item: (
            item.get("sort_ts") is not None,
            item.get("sort_ts") or 0,
            item["id"],
        ),
        reverse=True,
    )
    groups: dict[tuple[str | None, str | None], list[dict[str, Any]]] = {}
    for item in ordered:
        key = (item.get("project_id") or None, item.get("folder_path") or None)
        groups.setdefault(key, []).append(item)

    # 복수 선택은 현재 폴더(하위 포함)를 우선. 프로젝트 루트는 그 프로젝트 전체다.
    # 힌트가 없는 전체 라이브러리는 특정 폴더 우선권을 갖지 않는다.
    wanted_project = None if project_id == "none" else project_id
    wanted_folder = folder_path or None
    if len(ordered) > 1 and project_id is not None:
        preferred = [
            item for item in ordered
            if (item.get("project_id") or None) == wanted_project
            and (
                wanted_folder is None
                or (item.get("folder_path") or "") == wanted_folder
                or (item.get("folder_path") or "").startswith(wanted_folder + "/")
            )
        ]
        if preferred:
            return {
                "items": preferred,
                "focus_ids": [item["id"] for item in preferred],
                "project_id": wanted_project,
                "folder_path": wanted_folder,
            }

    # 동률이면 최신 sort_ts/id인 그룹이 먼저 삽입됐으므로 max의 첫 항목 규칙으로 결정적이다.
    (target_project, target_folder), targets = max(groups.items(), key=lambda pair: len(pair[1]))
    return {
        "items": targets,
        "focus_ids": [item["id"] for item in targets],
        "project_id": target_project,
        "folder_path": target_folder,
    }


def locate_generations(
    *,
    tab: str,
    gen_ids: list[str],
    account_uid: str | None,
    team_member_projects: list[str] | None,
    project_id: str | None = None,
    folder_path: str | None = None,
    fetch_team: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    ids = list(dict.fromkeys(gen_id.strip() for gen_id in gen_ids if gen_id.strip()))
    if not ids:
        return _empty_location()
    # 로컬 UUID와 공유 앵커를 동일시하지 않는다. 기존 직접 id > local origin 규칙을 재사용.
    resolved = repo.resolve_generation_meta_batch(ids)
    if tab == "team" and fetch_team is not None:
        server_ids = list(dict.fromkeys(
            (resolved[gen_id].get("job_id") or resolved[gen_id]["id"])
            if gen_id in resolved else gen_id
            for gen_id in ids
        ))
        # 공유 여부/폴더는 서버가 권위다. 로컬 shared나 경로가 있어도 서버 조회를 생략하지 않는다.
        return fetch_team({
            "tab": "team", "gen_ids": server_ids,
            "project_id": project_id, "folder_path": folder_path,
        })

    local_ids = list(dict.fromkeys(resolved[gen_id]["id"] for gen_id in ids if gen_id in resolved))
    items = repo.list_generations(
        tab=tab,
        account_uid=account_uid,
        team_member_projects=team_member_projects,
        generation_ids=local_ids,
        limit=200,
    )
    return _pick_location(items, project_id, folder_path)
