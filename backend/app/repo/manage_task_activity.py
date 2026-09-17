"""작업 목록 전용 메타 병합. 콘텐츠·완료본 저장 경로에는 팩트를 주입하지 않는다."""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from typing import Any, Optional

from .. import manage_db
from ..emailnorm import norm_email
from ..task_activity import latest_task_activity_at

Viewer = tuple[str, str]


def normalize_viewer(viewer: Optional[Viewer]) -> Optional[Viewer]:
    if not viewer or len(viewer) != 2:
        return None
    uid, email = str(viewer[0] or "").strip(), norm_email(viewer[1])
    return (uid, email) if uid and email and "\x00" not in uid + email else None


def task_activity_cache_key(
    *, activity_viewer: Optional[Viewer], activity_read_all: bool,
    preview_owner: Optional[Viewer],
) -> str:
    """헤더·로그에 신원을 노출하지 않는 내부/HTTP 공용 범위 지문."""
    viewer = normalize_viewer(activity_viewer)
    payload = [viewer, bool(viewer and activity_read_all), normalize_viewer(preview_owner)]
    return hashlib.sha256(json.dumps(payload, separators=(",", ":")).encode()).hexdigest()


def _workspace(row) -> tuple[str, Optional[str]]:
    scope = str(row.get("workspace_scope") or "").strip().lower()
    wid = str(row.get("workspace_id") or "").strip() or None
    return ("team", wid) if scope == "team" and wid else (
        ("personal", None) if scope == "personal" else ("unknown", None)
    )


def _fact_owner(fact) -> Optional[Viewer]:
    return normalize_viewer((fact.get("creator_uid"), fact.get("account_email")))


def _fact_is_active_team(fact) -> bool:
    return bool(
        not fact.get("is_deleted") and _workspace(fact)[0] == "team"
        and _fact_owner(fact)
    )


def _fact_is_task_source(fact) -> bool:
    return bool(_fact_is_active_team(fact) and fact.get("project_id")
                and str(fact.get("folder_path") or "").strip())


_CONTENT_SELECT = (
    "SELECT g.id,g.project_id,g.folder_path,g.workspace_scope,g.workspace_id,g.workspace_name,"
    "g.creator_uid,g.job_id,g.status,g.model,g.is_final,g.is_held,g.created_at,g.sort_ts,g.deleted_at,g.task_activity_at,"
    "EXISTS(SELECT 1 FROM share s WHERE s.generation_id=g.id) AS shared FROM generation g "
)


def load_activity_snapshot(conn, project_ids: list[str]) -> dict[str, Any]:
    """현재 프로젝트와 연관 앵커를 함께 읽어 이동 잔존본의 중복을 방지한다."""
    content: dict[str, dict] = {}
    for start in range(0, len(project_ids), 400):
        batch = project_ids[start:start + 400]
        ph = ",".join("?" * len(batch))
        for row in conn.execute(
            _CONTENT_SELECT + f"WHERE g.project_id IN ({ph}) OR g.id IN ("
            f"SELECT tg.gen_id FROM task_generation tg JOIN project_task t ON t.id=tg.task_id "
            f"WHERE t.project_id IN ({ph}))", [*batch, *batch],
        ):
            content[row["id"]] = dict(row)
    facts = manage_db.task_activity_facts(project_ids, content_refs=list(content.values()))
    for field in ("job_id", "id"):
        pairs = sorted({
            (str(f.get("creator_uid") or ""), str(f.get(
                "job_id" if field == "job_id" else "local_gen_id"
            ) or "")) for f in facts
            if f.get("creator_uid") and f.get("job_id" if field == "job_id" else "local_gen_id")
        })
        for start in range(0, len(pairs), 400):
            batch = pairs[start:start + 400]
            values = ",".join("(?,?)" for _ in batch)
            # 앵커를 왼쪽에 두어 generation의 job/id 인덱스를 사용한다. 중복은 ID 맵으로 흡수.
            for row in conn.execute(
                f"WITH wanted(uid,anchor) AS (VALUES {values}) " + _CONTENT_SELECT
                + f"JOIN wanted w ON w.uid=g.creator_uid AND w.anchor=g.{field}",
                [value for pair in batch for value in pair],
            ):
                content[row["id"]] = dict(row)

    facts_by_job: dict[tuple[str, str], list[dict]] = defaultdict(list)
    facts_by_id: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for fact in facts:
        uid = str(fact.get("creator_uid") or "").strip()
        if not uid:
            continue
        if fact.get("job_id"):
            facts_by_job[(uid, str(fact["job_id"]))].append(fact)
        facts_by_id[(uid, str(fact.get("local_gen_id") or ""))].append(fact)

    matches: dict[str, Optional[dict]] = {}
    matched_contents: dict[str, list[str]] = defaultdict(list)
    ambiguous_facts: set[str] = set()
    for cid, row in content.items():
        uid, job = str(row.get("creator_uid") or "").strip(), row.get("job_id")
        candidates = facts_by_job.get((uid, str(job)), []) if uid and job else []
        if not candidates and uid:
            candidates = [f for f in facts_by_id.get((uid, cid), []) if not (
                job and f.get("job_id") and str(job) != str(f["job_id"])
            )]
        # 서로 다른 계정/행이 같은 앵커를 주장하면 어느 쪽의 개인 힌트도 공개하지 않는다.
        match = candidates[0] if len(candidates) == 1 else None
        matches[cid] = match
        if match:
            matched_contents[match["id"]].append(cid)
        elif candidates:
            ambiguous_facts.update(f["id"] for f in candidates)

    sources: dict[str, dict] = {}
    by_content: dict[str, Optional[dict]] = {}
    consumed: set[str] = set()
    wanted = set(project_ids)
    for cid, row in content.items():
        fact = matches.get(cid)
        if row.get("deleted_at"):
            by_content[cid] = None  # 서버의 삭제는 개인 fact의 삭제 증거가 아니다.
            continue
        live_matches = [key for key in matched_contents.get(fact["id"], [])
                        if not content[key].get("deleted_at")] if fact else []
        if len(live_matches) > 1:
            # 중복 콘텐츠 앵커는 기존 콘텐츠를 보존하되 개인 fact/힌트를 결합하지 않는다.
            ambiguous_facts.add(fact["id"])
            fact = None
        record = dict(row)
        record["is_held"] = bool(row.get("shared") and not row.get("is_final") and row.get("is_held"))
        record["_fact"] = fact
        if row.get("shared"):
            if fact:
                consumed.add(fact["id"])
        elif fact:
            consumed.add(fact["id"])
            if not _fact_is_active_team(fact):
                by_content[cid] = None
                continue
            for field in (
                "project_id", "folder_path", "workspace_scope", "workspace_id", "workspace_name",
                "status", "model", "created_at", "sort_ts", "task_activity_at",
            ):
                record[field] = fact.get(field)
            record["is_final"] = False
        else:
            record["is_final"] = False  # 불완전한 레거시 최종 플래그로 공유를 추측하지 않는다.
        by_content[cid] = record
        if record.get("project_id") in wanted:
            sources[cid] = record

    for fact in facts:
        if fact["id"] in consumed or fact["id"] in ambiguous_facts or not _fact_is_task_source(fact):
            continue
        if fact.get("project_id") not in wanted:
            continue
        record = {field: fact.get(field) for field in (
            "project_id", "folder_path", "workspace_scope", "workspace_id", "workspace_name",
            "creator_uid", "job_id", "status", "model", "created_at", "sort_ts", "task_activity_at",
        )}
        record.update(id="fact:" + fact["id"], shared=False, is_final=False, is_held=False, _fact=fact)
        sources[record["id"]] = record
    return {"sources": list(sources.values()), "by_content": by_content}


def folder_sources(snapshot: dict) -> list[dict]:
    result = []
    for row in snapshot["sources"]:
        if not str(row.get("folder_path") or "").strip():
            continue
        observed = latest_task_activity_at(
            row.get("created_at"), row.get("task_activity_at"), row.get("sort_ts")
        )
        result.append({**row, "source_last_seen_at": observed})
    return result


def _allowed(record: dict, viewer: Optional[Viewer], read_all: bool) -> bool:
    if record.get("shared"):
        return True
    if viewer is None:
        return False
    return bool(read_all or (record.get("_fact") and _fact_owner(record["_fact"]) == viewer))


def visible_activity_projects(snapshot: dict, workspace_id: str, viewer: Optional[Viewer], read_all: bool) -> set[str]:
    viewer = normalize_viewer(viewer)
    return {
        record["project_id"] for record in snapshot["sources"]
        if _workspace(record) == ("team", workspace_id) and _allowed(record, viewer, read_all)
    }


def project_cuts(
    tasks, per_task_cuts: dict[str, list[dict]], snapshot: dict, *,
    activity_viewer: Optional[Viewer], activity_read_all: bool, preview_owner: Optional[Viewer],
) -> dict[str, list[dict[str, Any]]]:
    """조회자별 투영. 집계용 메타와 공개 미디어를 분리하고 내부 계정값을 제거한다."""
    viewer, owner = normalize_viewer(activity_viewer), normalize_viewer(preview_owner)
    # 호출자의 실수로 다른 사람의 preview_owner가 전달돼도 조회자 본인 외 힌트는 금지한다.
    if owner != viewer:
        owner = None
    folder_index: dict[tuple, list[dict]] = defaultdict(list)
    for record in snapshot["sources"]:
        folder_index[(record.get("project_id"), record.get("folder_path"), *_workspace(record))].append(record)
    result = {}
    for task_row in tasks:
        task = dict(task_row)
        current = per_task_cuts.get(task["id"], [])
        existing = {cut["id"]: cut for cut in current}
        records: dict[str, tuple[dict, dict]] = {}
        for cut in current:
            if task.get("folder_path") and not cut.get("linked"):
                continue  # 폴더 레인은 이동/삭제가 반영된 정규 스냅샷으로 교체한다.
            record = snapshot["by_content"].get(cut["id"], cut)
            if record is None:
                continue
            if "workspace_scope" in record and _workspace(record) != _workspace(task):
                continue
            records[cut["id"]] = (record, cut)
        if task.get("folder_path"):
            key = (task["project_id"], task["folder_path"], *_workspace(task))
            for record in folder_index.get(key, []):
                records[record["id"]] = (record, existing.get(record["id"], {}))
        cuts = []
        for record, original in records.values():
            if not _allowed(record, viewer, activity_read_all):
                continue
            cut = {field: record.get(field) for field in (
                "id", "status", "creator_uid", "model", "is_final", "created_at", "shared",
            )}
            cut["linked"] = original.get("linked", 0)
            shared = bool(record.get("shared"))
            cut["is_held"] = bool(shared and not cut["is_final"] and record.get("is_held"))
            cut["metadata_only"] = not shared
            for field in ("thumb", "file_path", "media_type"):
                cut[field] = original.get(field) if shared else None
            fact = record.get("_fact")
            if fact:
                cut["_activity_metrics"] = (
                    fact.get("real_credits") if fact.get("real_credits") is not None else fact.get("est_credits"),
                    fact.get("elapsed_seconds"),
                )
                if not shared and owner and _fact_owner(fact) == owner:
                    cut["local_gen_id"] = fact.get("local_gen_id")
                    cut["job_id"] = fact.get("job_id")
                    cut["_has_preview_hint"] = True
            # 내부 정렬 값만 유지했다가 반환 직전 제거한다.
            cut["_sort_ts"] = record.get("sort_ts")
            cuts.append(cut)
        cuts.sort(key=lambda cut: (
            -bool(cut["is_final"]), -bool(cut["shared"]),
            -(cut.get("_sort_ts") or 0), cut["id"],
        ))
        for cut in cuts:
            cut.pop("_sort_ts", None)
        result[task["id"]] = cuts
    return result
