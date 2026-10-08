"""폴더 카드(공유 & 리뷰 탭) — 고른 폴더 바로 아래 폴더마다 건수·표지, 그리고 팀이 같이 보는 '대표'.

대표는 공유 서버 DB(`folder_cover`)가 권위다. 읽을 때마다 '지금 그 폴더 아래에서 이 계정에게 보이는 공유물인가'를
보고, 아니면 최신 것을 표지로 쓴다. 맞지 않는 행을 여기서 지우지 않는다 — 보는 사람마다 가시성이 달라, 내게 안
보인다고 지우면 남의 정상 대표가 사라진다. 보이지 않는 대표의 id·정한 사람은 응답에 싣지 않는다.

건수·폴더 이름·표지는 팀 목록·사이드바 숫자와 같은 범위(`_folder_counts_where`)에서만 만든다.
"""

from __future__ import annotations

from typing import Any, Optional

from ..db import get_connection
from ._common import clean_folder_path
from .generations_query import list_generations
from .projects import _folder_counts_where

__all__ = ["folder_cards", "set_folder_cover"]

_COVER_CHUNK = 500  # 표지 행을 한 번에 받는 개수(SQL 변수 상한 아래)


def _under(path: str) -> tuple[str, list[str]]:
    """그 폴더 자신 + 하위 전부 — 목록의 폴더 조건(`list_generations`)과 같은 식이라 `C001` 이 `C0010` 을 잡지 않는다."""
    escaped = path.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return "(g.folder_path = ? OR g.folder_path LIKE ? ESCAPE '\\')", [path, escaped + "/%"]


def _visible_where(
    project_id: str,
    team_member_projects: Optional[list[str]],
    viewer_uid: Optional[str],
    workspace_id: Optional[str],
    *,
    include_roots: bool = False,
) -> tuple[str, list[Any]]:
    where, args = _folder_counts_where(
        [project_id], shared_only=True,
        team_member_projects=team_member_projects, actor_uid=viewer_uid, include_roots=include_roots,
    )
    if workspace_id:
        # 목록의 공간 필터와 같은 식 — scope 조건이 같은 id 가 남은 비정상 행을 거른다.
        where += " AND g.workspace_scope = 'team' AND g.workspace_id = ?"
        args.append(workspace_id)
    return where, args


def folder_cards(
    project_id: str,
    parent: Optional[str],
    *,
    team_member_projects: Optional[list[str]],
    viewer_uid: Optional[str],
    workspace_id: Optional[str] = None,
) -> dict[str, Any]:
    """`parent` 바로 아래 폴더마다 {path, name, count, rep, cover}. `parent` 가 비면 프로젝트의 맨 위 폴더들.

    count 는 그 폴더와 하위 전부(폴더 창이 보여 주는 것과 같다). cover 는 목록 행과 같은 모양이고, 유효한
    대표가 있으면 그것(rep=True), 없으면 가장 최근 것이다. own_count = parent 에 직접 든 것(어느 카드에도 안 든다).
    team_member_projects=None 은 전체 공유물(read_all·단독)이지만 viewer_uid 는 그래도 넘긴다 — 표지 행의
    개인 메타 가림은 조회 범위와 별개다.
    """
    parent_path = clean_folder_path(parent) or ""
    prefix = parent_path + "/" if parent_path else ""
    # 프로젝트의 맨 위(parent 없음)에서는 폴더 없이 든 것도 센다(own_count) — 빼면 그 생성물이 어느 카드에도 없이 조용히 사라진다.
    where, args = _visible_where(
        project_id, team_member_projects, viewer_uid, workspace_id, include_roots=not parent_path,
    )
    if parent_path:
        under, under_args = _under(parent_path)
        where += f" AND {under}"
        args += under_args
    with get_connection() as conn:
        rows = conn.execute(
            f"SELECT g.id, g.folder_path FROM generation g WHERE {where} "
            "ORDER BY g.sort_ts DESC, g.id DESC",
            args,
        ).fetchall()
        saved = {
            row["folder_path"]: row["generation_id"]
            for row in conn.execute(
                "SELECT folder_path, generation_id FROM folder_cover WHERE project_id = ?",
                (project_id,),
            )
        }

    own_count = 0
    folders: dict[str, dict[str, Any]] = {}
    for row in rows:  # 최신 순 — 폴더마다 처음 만난 것이 가장 최근 것이다
        folder = row["folder_path"] or ""  # 폴더 없음 = 프로젝트 맨 위에 직접 든 것
        if folder != parent_path and not folder.startswith(prefix):
            continue  # SQL 의 LIKE 는 영문 대소문자를 가리지 않는다 — 글자만 같은 다른 폴더(E035/…)를 이 폴더 카드로 합치지 않는다
        rest = folder[len(prefix):]
        if not rest:
            own_count += 1
            continue
        path = prefix + rest.split("/", 1)[0]
        entry = folders.get(path)
        if entry is None:
            entry = folders[path] = {"count": 0, "cover_id": row["id"], "rep": False}
        entry["count"] += 1
        if saved.get(path) == row["id"]:
            entry["cover_id"], entry["rep"] = row["id"], True

    cover_ids = [entry["cover_id"] for entry in folders.values()]
    covers: dict[str, dict[str, Any]] = {}
    for start in range(0, len(cover_ids), _COVER_CHUNK):
        chunk = cover_ids[start:start + _COVER_CHUNK]
        # project_id 를 같이 준다 — 빼면 보관(archived) 프로젝트가 목록의 기본 제외 조건에 걸려 표지가 사라진다.
        for cover in list_generations(
            tab="team", team_member_projects=team_member_projects, account_uid=viewer_uid,
            project_id=project_id, generation_ids=chunk, limit=len(chunk),
        ):
            covers[cover["id"]] = cover

    out = []
    for path in sorted(folders, key=lambda one: (one.casefold(), one)):
        entry = folders[path]
        cover = covers.get(entry["cover_id"])
        if cover is None:
            continue  # 집계와 표지 조회 사이에 지워졌거나 옮겨졌다 — 다음 조회에 바로잡힌다
        out.append({
            "path": path, "name": path[len(prefix):], "count": entry["count"],
            "rep": entry["rep"], "cover": cover,
        })
    return {"parent": parent_path, "own_count": own_count, "folders": out}


def set_folder_cover(
    project_id: str,
    folder_path: str,
    generation_id: str,
    *,
    team_member_projects: Optional[list[str]],
    viewer_uid: Optional[str],
    set_by: Optional[str],
) -> dict[str, str]:
    """그 폴더의 대표를 정한다 — 이 계정이 팀 목록에서 볼 수 있고 그 폴더(하위 포함)에 든 공유물만.

    조건에 안 맞으면 LookupError(다른 프로젝트·비공유·지운 것·못 보는 것·폴더 밖을 구분해 알려 주지 않는다).
    두 사람이 동시에 정하면 서버가 뒤에 처리한 쪽이 남는다.
    """
    path = clean_folder_path(folder_path)
    if not path:
        raise LookupError("folder")
    where, args = _visible_where(project_id, team_member_projects, viewer_uid, None)
    under, under_args = _under(path)
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")  # 확인과 저장을 한 쓰기 구간으로 — 그 사이 옮겨지거나 공유 해제되지 않게
        found = conn.execute(
            f"SELECT g.folder_path FROM generation g WHERE g.id = ? AND {where} AND {under}",
            [generation_id, *args, *under_args],
        ).fetchone()
        # SQL 의 LIKE 는 영문 대소문자를 가리지 않는다 — 글자만 같은 다른 폴더(E035/…)의 것을 이 폴더의 대표로 받지 않는다(조회와 같은 기준).
        if not found or not (found["folder_path"] == path or found["folder_path"].startswith(path + "/")):
            raise LookupError("generation")
        conn.execute(
            "INSERT INTO folder_cover(project_id, folder_path, generation_id, set_by, set_at) "
            "VALUES(?, ?, ?, ?, datetime('now')) "
            "ON CONFLICT(project_id, folder_path) DO UPDATE SET "
            "generation_id = excluded.generation_id, set_by = excluded.set_by, set_at = excluded.set_at",
            (project_id, path, generation_id, set_by),
        )
    return {"folder_path": path, "generation_id": generation_id}
