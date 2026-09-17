"""관리 작업의 본인 미리보기 — 현재 로컬 DB만 읽고 원격 조회/다운로드하지 않는다."""

from __future__ import annotations

from typing import Any

from ..db import get_connection


def local_task_previews(items: list[dict[str, Any]], owner_uid: str) -> dict[str, dict]:
    """힌트를 소유자와 정확한 작업 위치로 재검증한다. fact ID는 응답 키일 뿐이다.

    로컬 ID가 없어진 경우만 같은 소유자의 유일한 job ID로 복원한다. 모호한 job ID나
    다른 위치는 추측하지 않는다. 응답은 미디어 위치만 포함하며 생성 통계를 바꾸지 않는다.
    """
    if not items or not owner_uid or owner_uid == "\x00":
        return {}
    requested = list(dict.fromkeys(
        str(item[key]) for item in items for key in ("local_gen_id", "job_id") if item.get(key)
    ))
    by_id: dict[str, dict] = {}
    by_job: dict[str, dict[str, dict]] = {}
    with get_connection() as conn:
        for offset in range(0, len(requested), 400):
            ids = requested[offset:offset + 400]
            placeholders = ",".join("?" for _ in ids)
            rows = conn.execute(
                "SELECT g.id, g.job_id, g.project_id, g.folder_path, g.workspace_scope, "
                "g.workspace_id, a.file_path, a.source_url, a.thumbnail_path, a.type "
                "FROM generation g LEFT JOIN asset a ON a.rowid=(SELECT rowid FROM asset "
                "WHERE generation_id=g.id ORDER BY rowid LIMIT 1) "
                f"WHERE g.creator_uid=? AND g.deleted_at IS NULL AND (g.id IN ({placeholders}) "
                f"OR g.job_id IN ({placeholders}))",
                [owner_uid, *ids, *ids],
            ).fetchall()
            for raw in rows:
                row = dict(raw)
                by_id[row["id"]] = row
                if row["job_id"]:
                    by_job.setdefault(row["job_id"], {})[row["id"]] = row
    out: dict[str, dict] = {}
    for item in items:
        row = by_id.get(item.get("local_gen_id"))
        job_id = item.get("job_id")
        if row is not None and job_id and row["job_id"] != job_id:
            continue  # 충돌한 직접 ID를 job 폴백으로 은폐하지 않는다.
        if row is None and job_id:
            candidates = by_job.get(job_id, {})
            if len(candidates) == 1:
                row = next(iter(candidates.values()))
        if row is None or (
            row["workspace_scope"] != "team"
            or row["workspace_id"] != item.get("workspace_id")
            or row["project_id"] != item.get("project_id")
            or row["folder_path"] != item.get("folder_path")
        ):
            continue
        file_path = row["file_path"]
        source = row["source_url"]
        if isinstance(source, str) and source.startswith(("https://", "http://")):
            file_path = source  # URL-only. 이 조회에서 파일을 만들지 않는다.
        thumb = row["thumbnail_path"]
        if not thumb and row["type"] != "video":
            thumb = file_path
        if not file_path and not thumb:
            continue
        out[item["id"]] = {
            "local_gen_id": row["id"], "thumb": thumb,
            "file_path": file_path, "media_type": row["type"],
        }
    return out
