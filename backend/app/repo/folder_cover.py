"""폴더 카드(공유 & 리뷰 탭) — 고른 폴더 바로 아래 폴더마다 건수·표지, 그리고 팀이 같이 보는 '대표'.

대표는 공유 서버 DB(`folder_cover`)가 권위다. 읽을 때마다 '지금 그 폴더 아래에서 이 계정에게 보이는 공유물인가'를
보고, 아니면 최신 것을 표지로 쓴다. 맞지 않는 행을 여기서 지우지 않는다 — 보는 사람마다 가시성이 달라, 내게 안
보인다고 지우면 남의 정상 대표가 사라진다. 보이지 않는 대표의 id·정한 사람은 응답에 싣지 않는다.

건수·폴더 이름·표지는 팀 목록·사이드바 숫자와 같은 범위(`_folder_counts_where`)에서만 만든다.

응답 크기(2026-10-13 밤, 배포 전 실측): 카드의 표지에 목록 행 전체(프롬프트·params·레퍼런스 …)를 실으면 장당 약 50KB 라
컷 300개 화면이 14.7MB 였다 — 이 응답은 15초마다 다시 받는다. 표지는 **화면이 쓰는 칸만**(`_COVER_FIELDS`) 싣고,
미리보기(컷 띠·생성물 띠)는 목록 행을 읽지 않고 첫 에셋만 한 번에 읽는다.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from ..db import get_connection
from ._common import clean_folder_path
from ._visibility import team_generation_visibility_clause
from .identity import get_my_uid, resolve_display_names
from .projects import _folder_counts_where

__all__ = ["folder_cards", "set_folder_cover"]

_COVER_CHUNK = 500  # 표지 행을 한 번에 받는 개수(SQL 변수 상한 아래)
_STRIP = 7  # 카드마다 싣는 바로 아래 폴더(컷) 미리보기 수 — 이름순 앞에서부터. 그 뒤는 화면이 `subfolders` 와의 차로 '+N' 을 그린다
_TAKES = 10  # 하위 폴더가 없는 카드(컷)가 싣는 생성물 미리보기 수 — 대표가 있으면 맨 앞, 그 뒤는 최신 순. 그 뒤는 화면이 `count` 와의 차로 '+N'
_WORKERS = 4  # 카드마다 싣는 작업자 수(건수 많은 순)
# 카드의 표지가 싣는 칸 — 목록 행의 값 그대로(가림·이름 해석이 같다). 화면이 쓰는 것만: 그림(assets 첫 장) · 정보 줄(모델·만든 사람·
#  생성일·최종/보류·길이) · 폴더 창을 열 때의 프로젝트. 프런트 `types.FolderCover` 와 같은 목록이다 — 한쪽만 고치지 않는다.
_COVER_FIELDS = (
    "id", "project_id", "project_name", "folder_path", "model", "creator_name", "is_mine", "created_at", "is_final", "is_held",
)


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


def _card_cover(row: dict[str, Any]) -> dict[str, Any]:
    """목록 행 → 카드의 표지. params 는 정보 줄이 읽는 길이(duration)만 남긴다."""
    params = row.get("params")
    return {
        **{key: row.get(key) for key in _COVER_FIELDS},
        "params": {"duration": params["duration"]} if isinstance(params, dict) and "duration" in params else None,
        "assets": (row.get("assets") or [])[:1],
    }


def _covers(
    conn: Any,
    ids: list[str],
    project_id: str,
    team_member_projects: Optional[list[str]],
    viewer_uid: Optional[str],
) -> dict[str, dict[str, Any]]:
    """id → 카드의 표지. 바꾸기 전에는 팀 목록 행(`list_generations(tab='team', project_id=…)`)을 통째로 보강해 읽고
    `_card_cover` 로 줄였다 — 레퍼런스·태그·계보·코멘트 …까지 다 붙인 뒤 버렸다(83회차). 이제 화면이 쓰는 칸만 읽는다. 값은 그때와 같다.

    가시성도 그 목록 조회와 같은 조건이다(지우지 않음 · 공유됨 · 팀 가시성 · 그 프로젝트) — 집계에서 나온 id 라도 다시 본다
    (그 사이 지워지거나 옮겨졌으면 표지가 없고 카드를 싣지 않는다). 보관 프로젝트도 프로젝트를 고른 목록처럼 제외하지 않는다.
    """
    if not ids:
        return {}
    visibility, visibility_args = team_generation_visibility_clause(team_member_projects, viewer_uid)
    rows = [dict(row) for row in conn.execute(
        "SELECT g.id, g.project_id, p.name AS project_name, g.folder_path, g.model, g.created_at, "
        "g.is_final, g.is_held, g.params, g.creator_uid "
        "FROM generation g LEFT JOIN project p ON p.id = g.project_id "
        f"WHERE g.id IN ({','.join('?' for _ in ids)}) AND g.deleted_at IS NULL "
        "AND EXISTS (SELECT 1 FROM share s WHERE s.generation_id = g.id) AND g.project_id = ?"
        + (f" AND {visibility}" if visibility else ""),
        [*ids, project_id, *visibility_args],
    )]
    names = resolve_display_names(conn, {row["creator_uid"] for row in rows})
    my_uid = viewer_uid or get_my_uid()  # 목록 행의 is_mine 과 같은 규칙(generation_rows._attach_children)
    first = _first_assets(conn, [row["id"] for row in rows])
    covers = {}
    for row in rows:
        uid = row["creator_uid"]
        covers[row["id"]] = _card_cover({
            **row,
            "creator_name": names.get(uid),
            "is_mine": (uid == my_uid) if uid else (my_uid is None),
            "is_final": bool(row["is_final"]),
            "is_held": bool(row["is_held"]),
            "params": json.loads(row["params"]) if row["params"] else None,
            "assets": [first[row["id"]]] if row["id"] in first else [],
        })
    return covers


def _first_assets(conn: Any, generation_ids: list[str]) -> dict[str, dict[str, Any]]:
    """생성물마다 첫 에셋 한 장 — 목록 행(`_attach_children`)이 싣는 것과 같은 칸. 미리보기(컷 띠·생성물 띠)용이라 목록 행은 읽지 않는다."""
    first: dict[str, dict[str, Any]] = {}
    for start in range(0, len(generation_ids), _COVER_CHUNK):
        chunk = generation_ids[start:start + _COVER_CHUNK]
        for row in conn.execute(
            "SELECT id, generation_id, type, file_path, thumbnail_path, source_url "
            f"FROM asset WHERE generation_id IN ({','.join('?' for _ in chunk)}) ORDER BY rowid",
            chunk,
        ):
            if row["generation_id"] not in first:
                item = dict(row)
                item["cached"] = bool((item.get("file_path") or "").startswith("/media/"))
                first[row["generation_id"]] = item
    return first


def folder_cards(
    project_id: str,
    parent: Optional[str],
    *,
    team_member_projects: Optional[list[str]],
    viewer_uid: Optional[str],
    workspace_id: Optional[str] = None,
) -> dict[str, Any]:
    """`parent` 바로 아래 폴더마다 {path, name, count, rep, cover}. `parent` 가 비면 프로젝트의 맨 위 폴더들.

    count 는 그 폴더와 하위 전부(폴더 창이 보여 주는 것과 같다). cover 는 목록 행에서 화면이 쓰는 칸만(`_COVER_FIELDS` +
    길이만 남긴 params + 첫 에셋)이고, 유효한 대표가 있으면 그것(rep=True), 없으면 가장 최근 것이다.
    own_count = parent 에 직접 든 것(어느 카드에도 안 든다).
    에피소드 화면용 집계(2026-10-13 — 건수와 **같은 범위**에서 센다. 이 값들이 없는 옛 서버면 화면이 그 표시를 숨긴다):
    video_count = 그 폴더(하위 포함)의 영상 수 · rep_count = 바로 아래 폴더 중 유효한 대표가 있는 수 ·
    last_shared_at/by = 그 폴더에서 가장 늦게 공유된 것의 시각과 만든 사람 이름(표지의 것이 아니다 — 대표를 정해 둔
    폴더의 표지는 최신이 아니다) · children = 바로 아래 폴더의 미리보기(이름순 앞 `_STRIP` 개, 표지는 그림에 필요한 것만) ·
    final_count/held_count = 그 폴더(하위 포함)의 최종·보류 수 — 사이드바 숫자(`folder_review_counts_batch`)와 같은 규칙
    (최종이 먼저 — 둘 다 켜진 옛 행을 두 번 세지 않는다). 일반 공유 수 = count - final_count - held_count.
    컷 화면의 리스트용(2026-10-13 오후): workers = 그 폴더(하위 포함)의 만든 사람별 건수(많은 순 `_WORKERS` 명, 이름을 모르면 null) ·
    takes = **하위 폴더가 없는 카드만** — 그 컷의 생성물 미리보기 `_TAKES` 개(유효한 대표가 맨 앞, 그 뒤 최신 순. 그림 한 장 + 최종/보류 + 만든 사람).
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
            "SELECT g.id, g.folder_path, g.creator_uid, "
            "COALESCE(g.is_final, 0) AS is_final, COALESCE(g.is_held, 0) AS is_held, "
            "EXISTS (SELECT 1 FROM asset a WHERE a.generation_id = g.id AND a.type = 'video') AS is_video, "
            "(SELECT MAX(s.shared_at) FROM share s WHERE s.generation_id = g.id) AS shared_at "
            f"FROM generation g WHERE {where} "
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
        head, _, below = rest.partition("/")
        path = prefix + head
        entry = folders.get(path)
        if entry is None:
            entry = folders[path] = {
                "count": 0, "cover_id": row["id"], "rep": False, "subs": {}, "videos": 0, "last": ("", None), "final": 0, "held": 0,
                "by": {}, "takes": [],
            }
        entry["count"] += 1
        entry["by"][row["creator_uid"]] = entry["by"].get(row["creator_uid"], 0) + 1
        if len(entry["takes"]) < _TAKES:  # 최신 순이라 앞에서부터가 가장 최근 것이다(대표는 아래에서 따로 앞세운다)
            entry["takes"].append(row)
        if row["is_final"]:
            entry["final"] += 1
        elif row["is_held"]:
            entry["held"] += 1
        entry["videos"] += 1 if row["is_video"] else 0
        if (row["shared_at"] or "") > entry["last"][0]:
            entry["last"] = (row["shared_at"], row["creator_uid"])
        if below:  # 그 폴더 바로 아래 폴더(컷) — 화면은 이것이 있는 카드를 '들어가는' 묶음으로 본다(Jay 2026-10-09)
            name = below.split("/", 1)[0]
            sub = entry["subs"].get(name)
            if sub is None:  # 최신 순이라 처음 만난 것이 그 컷의 가장 최근 것이다
                sub = entry["subs"][name] = {"count": 0, "cover_id": row["id"], "rep": False}
            sub["count"] += 1
            if saved.get(f"{path}/{name}") == row["id"]:  # 그 컷 아래에 지금 보이는 공유물일 때만 유효한 대표다(위 카드와 같은 기준)
                sub["cover_id"], sub["rep"] = row["id"], True
        if saved.get(path) == row["id"]:
            entry["cover_id"], entry["rep"] = row["id"], True
            entry["rep_row"] = row

    # 컷(하위 폴더 없음)의 생성물 미리보기 — 대표를 맨 앞에 세우고(최근 것에 없어도 싣는다) `_TAKES` 개로 자른다.
    takes: dict[str, list[Any]] = {}
    for path, entry in folders.items():
        if entry["subs"]:
            continue  # 묶음(에피소드)은 컷 띠(children)를 싣는다
        rep_row = entry.get("rep_row")
        rows_of = ([rep_row] if rep_row is not None else []) + [one for one in entry["takes"] if rep_row is None or one["id"] != rep_row["id"]]
        takes[path] = rows_of[:_TAKES]

    strips = {
        path: sorted(entry["subs"], key=lambda one: (one.casefold(), one))[:_STRIP]
        for path, entry in folders.items()
    }
    # 표지 조회(`_covers`)는 카드의 표지만(카드 수만큼). 미리보기(컷 띠·생성물 띠)는 그림 한 장이면 된다 — 표지처럼 읽으면 컷마다 열 장씩이라
    #  읽는 시간의 대부분이 거기서 나갔다(배포 전 실측: 컷 300 × 12 에서 396ms 중 349ms). 미리보기의 것은 위 집계가 이미 같은 가시성
    #  (`_visible_where` = 목록의 tab=team·그 프로젝트와 같은 조건)으로 거른 것이라 다시 거르지 않는다.
    cover_ids = list(dict.fromkeys(entry["cover_id"] for entry in folders.values()))
    preview_ids = list(dict.fromkeys(
        [folders[path]["subs"][name]["cover_id"] for path, names in strips.items() for name in names]
        + [one["id"] for rows_of in takes.values() for one in rows_of]
    ))
    covers: dict[str, dict[str, Any]] = {}
    with get_connection() as conn:
        for start in range(0, len(cover_ids), _COVER_CHUNK):
            covers.update(_covers(
                conn, cover_ids[start:start + _COVER_CHUNK], project_id, team_member_projects, viewer_uid,
            ))
        # 이름은 목록 행의 creator_name 과 같은 해석기다 — 생성물 띠의 '만든 사람'도 여기서 읽는다(폴더의 모든 만든 사람이 들어 있다).
        names = resolve_display_names(
            conn, {entry["last"][1] for entry in folders.values()} | {uid for entry in folders.values() for uid in entry["by"]},
        )
        previews = _first_assets(conn, preview_ids)

    def preview(generation_id: str) -> dict[str, Any]:
        one = previews.get(generation_id)
        return {"id": generation_id, "assets": [one] if one is not None else []}

    out = []
    for path in sorted(folders, key=lambda one: (one.casefold(), one)):
        entry = folders[path]
        cover = covers.get(entry["cover_id"])
        if cover is None:
            continue  # 집계와 표지 조회 사이에 지워졌거나 옮겨졌다 — 다음 조회에 바로잡힌다
        children = [
            {
                "path": f"{path}/{name}", "name": name, "count": entry["subs"][name]["count"], "rep": entry["subs"][name]["rep"],
                "cover": preview(entry["subs"][name]["cover_id"]),
            }
            for name in strips[path]
        ]
        out.append({
            "path": path, "name": path[len(prefix):], "count": entry["count"],
            "subfolders": len(entry["subs"]), "rep": entry["rep"], "cover": cover,
            "video_count": entry["videos"],
            "rep_count": sum(1 for sub in entry["subs"].values() if sub["rep"]),
            "last_shared_at": entry["last"][0] or None,
            "last_shared_by": names.get(entry["last"][1]) if entry["last"][1] else None,
            "children": children,
            "final_count": entry["final"], "held_count": entry["held"],
            # 이름을 모르는 사람은 이름 없이 건수만(uid 를 내보내지 않는다). 많은 순, 같으면 이름순
            "workers": [
                {"name": name, "count": count}
                for name, count in sorted(
                    ((names.get(uid) if uid else None, count) for uid, count in entry["by"].items()),
                    key=lambda one: (-one[1], one[0] or ""),
                )[:_WORKERS]
            ],
            # 미리보기는 그림만 쓴다. 만든 사람은 목록 행의 creator_name 과 같은 해석기의 값(이름을 모르면 null)
            "takes": [
                {
                    "cover": preview(one["id"]),
                    "final": bool(one["is_final"]), "held": bool(not one["is_final"] and one["is_held"]),
                    "by": (names.get(one["creator_uid"]) if one["creator_uid"] else None) or None,
                }
                for one in takes.get(path, [])
            ],
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
