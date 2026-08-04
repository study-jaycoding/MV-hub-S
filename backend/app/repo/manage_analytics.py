"""PM 대시보드 시계열·작업자/프로젝트 매트릭스 읽기 모델."""

from __future__ import annotations

from typing import Any, Optional

from ..db import get_connection
from .identity import resolve_display_names
from .manage_schema import _ensure_schema


def timeseries(
    bucket: str = "day",
    project_id: Optional[str] = None,
    creator_uid: Optional[str] = None,
) -> list[dict[str, Any]]:
    """일/주별 생성 수와 실제값 우선 크레딧 합계를 반환한다."""
    date_format = "%Y-%W" if bucket == "week" else "%Y-%m-%d"
    where = "g.deleted_at IS NULL AND g.created_at IS NOT NULL"
    params: list[Any] = []
    if project_id:
        where += " AND g.project_id = ?"
        params.append(project_id)
    if creator_uid:
        where += " AND g.creator_uid = ?"
        params.append(creator_uid)
    with get_connection() as conn:
        _ensure_schema(conn)
        rows = conn.execute(
            f"""SELECT strftime('{date_format}', g.created_at) AS bucket,
                       COUNT(*) AS count,
                       COALESCE(SUM(COALESCE(m.real_credits, m.est_credits)), 0) AS credits
                FROM generation g
                LEFT JOIN generation_metrics m ON m.gen_id = g.id
                WHERE {where}
                GROUP BY bucket ORDER BY bucket""",
            params,
        ).fetchall()
    return [dict(row) for row in rows]


def matrix() -> dict[str, Any]:
    """작업자 × 프로젝트별 생성·크레딧·공유·완료 집계를 반환한다."""
    with get_connection() as conn:
        _ensure_schema(conn)
        rows = conn.execute(
            """SELECT g.creator_uid AS uid, g.project_id AS pid, COUNT(*) AS count,
                      COALESCE(SUM(COALESCE(m.real_credits, m.est_credits)), 0) AS credits,
                      SUM(CASE WHEN g.is_final = 1 THEN 1 ELSE 0 END) AS final_count,
                      SUM(CASE WHEN EXISTS(
                            SELECT 1 FROM share s WHERE s.generation_id = g.id
                          ) THEN 1 ELSE 0 END) AS shared_count
               FROM generation g
               LEFT JOIN generation_metrics m ON m.gen_id = g.id
               WHERE g.deleted_at IS NULL
               GROUP BY g.creator_uid, g.project_id"""
        ).fetchall()
        creator_uids = sorted({row["uid"] for row in rows if row["uid"]})
        names = resolve_display_names(conn, creator_uids) if creator_uids else {}
        project_names = {
            row["id"]: row["name"]
            for row in conn.execute("SELECT id, name FROM project").fetchall()
        }

    project_order: list[str] = []
    seen: set[str] = set()
    cells: dict[str, dict[str, dict[str, Any]]] = {}
    for row in rows:
        creator_uid = row["uid"] or ""
        project_key = row["pid"] or ""
        cells.setdefault(creator_uid, {})[project_key] = {
            "count": row["count"],
            "credits": row["credits"],
            "shared_count": row["shared_count"] or 0,
            "final_count": row["final_count"] or 0,
        }
        if project_key not in seen:
            seen.add(project_key)
            project_order.append(project_key)
    workers = [{"uid": uid, "name": names.get(uid) or uid} for uid in creator_uids]
    if any((row["uid"] or "") == "" for row in rows):
        workers.append({"uid": "", "name": "미상"})
    projects = [
        {
            "pid": project_id,
            "name": (project_names.get(project_id) if project_id else "미분류")
            or project_id
            or "미분류",
        }
        for project_id in project_order
    ]
    return {"workers": workers, "projects": projects, "cells": cells}


def breakdown(project_id: str) -> dict[str, Any]:
    """프로젝트의 폴더 경로 × 작업자별 생성·공유·완료·크레딧을 반환한다."""
    with get_connection() as conn:
        _ensure_schema(conn)
        raw = conn.execute(
            """SELECT COALESCE(g.folder_path, '') AS folder_path,
                      g.creator_uid AS uid, COUNT(*) AS count,
                      COALESCE(SUM(COALESCE(m.real_credits, m.est_credits)), 0) AS credits,
                      SUM(CASE WHEN g.is_final = 1 THEN 1 ELSE 0 END) AS final_count,
                      SUM(CASE WHEN EXISTS(
                            SELECT 1 FROM share s WHERE s.generation_id = g.id
                          ) THEN 1 ELSE 0 END) AS shared_count
               FROM generation g
               LEFT JOIN generation_metrics m ON m.gen_id = g.id
               WHERE g.deleted_at IS NULL AND g.project_id = ?
               GROUP BY g.folder_path, g.creator_uid""",
            (project_id,),
        ).fetchall()
        creator_uids = sorted({row["uid"] for row in raw if row["uid"]})
        names = resolve_display_names(conn, creator_uids) if creator_uids else {}
    rows = []
    for row in raw:
        folder_path = row["folder_path"] or ""
        segments = [segment for segment in folder_path.split("/") if segment]
        rows.append(
            {
                "folder_path": folder_path,
                "episode": segments[0] if segments else "(미지정)",
                "sequence": segments[1] if len(segments) > 1 else "",
                "uid": row["uid"] or "",
                "name": names.get(row["uid"] or "") or row["uid"] or "미상",
                "count": row["count"],
                "shared_count": row["shared_count"] or 0,
                "final_count": row["final_count"] or 0,
                "credits": row["credits"],
            }
        )
    return {"rows": rows}
