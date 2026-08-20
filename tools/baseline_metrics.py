# -*- coding: utf-8 -*-
r"""운영/개발 DB 사본의 기준선 지표를 만드는 읽기 전용 CLI.

입력 DB는 사용자가 명시한 사본만 받으며 SQLite URI ``mode=ro``와 ``immutable=1``로
연다. 입력 DB·미디어에는 어떤 변경도 하지 않고, 결과만 ``--out-dir``에 기록한다.

사용 예::

    python tools\baseline_metrics.py --db C:\copies\content_hub.db \
        --trash C:\copies\content_hub_trash.db \
        --manage C:\copies\manage_hub.db \
        --media-dir C:\copies\media --out-dir C:\reports\baseline
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Iterator
from urllib.parse import unquote, urlsplit

# 캐시 규칙을 여기서 복제하지 않는다. 서비스 함수가 바뀌면 이 측정 도구도 같은 규칙을 쓴다.
BACKEND_ROOT = Path(__file__).resolve().parents[1] / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services import media_cache, thumbs  # noqa: E402
from app.services.media_types import IMAGE_EXTENSIONS, VIDEO_EXTENSIONS  # noqa: E402


REPORT_JSON = "baseline_metrics.json"
REPORT_MARKDOWN = "baseline_metrics.md"
ORPHAN_JSON = "orphan_candidates.json"
GHOST_AGE_HOURS = 24
PROGRESS_EVERY = 10_000

TIME_FORMATS = (
    "space_naive",
    "iso_t_z",
    "iso_t_milliseconds_z",
    "epoch_string",
    "unparseable",
    "null_or_empty",
)
TIME_LABELS = {
    "space_naive": "YYYY-MM-DD HH:MM:SS (공백 naive)",
    "iso_t_z": "ISO T+Z",
    "iso_t_milliseconds_z": "T+밀리초Z",
    "epoch_string": "숫자 epoch 문자열",
    "unparseable": "파싱 불가",
    "null_or_empty": "NULL·빈값",
}
ACTIVE_REQUEST_STATES = (
    "preparing",
    "pending",
    "claimed",
    "submitting",
    "running",
    "tracking",
    "verifying",
    "blocked",
    "recovery_required",
)
INCOMPLETE_GENERATION_STATES = ("pending", "running")

_SPACE_NAIVE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")
_ISO_T_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
_ISO_T_FRACTION_Z = re.compile(
    r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d+)Z$"
)
_NUMERIC = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$")

# rg로 schema.sql, manage_schema.py, manage_db.py, repo/trash.py와 미디어 캐시의
# _COLS를 대조한 권위 목록. 동적 스키마 검사도 병행해 이후 추가된 *_path 컬럼을 놓치지 않는다.
REFERENCE_CODE_AUDIT = (
    {
        "source": "content.asset.file_path / thumbnail_path",
        "role": "직접 미디어 참조",
        "evidence": "backend/schema.sql; backend/app/services/media_cache.py::_COLS",
    },
    {
        "source": "content.reference.file_path / thumbnail_path",
        "role": "직접 미디어 참조",
        "evidence": "backend/schema.sql; backend/app/services/media_cache.py::_COLS",
    },
    {
        "source": "content.media_preservation.generation_id -> asset/reference",
        "role": "간접 보존 참조(자체 경로 컬럼 없음)",
        "evidence": "backend/schema.sql; backend/app/services/media_preservation.py",
    },
    {
        "source": "content.gen_request.payload",
        "role": "중첩 references.file_path 등 보수 검사",
        "evidence": "backend/schema.sql; backend/app/usecases/gen_requests.py",
    },
    {
        "source": "content.scene_backup.data",
        "role": "중첩 SceneRef file_path/thumb 보수 검사",
        "evidence": "backend/schema.sql; frontend/src/lib/scenes.ts",
    },
    {
        "source": "trash.trashed.payload.assets/references",
        "role": "휴지통 미디어 참조",
        "evidence": "backend/app/repo/trash.py::_gather",
    },
    {
        "source": "원격 URL 및 실제 원본에서 파생되는 캐시",
        "role": "URL 바이트 캐시·썸네일 원본 캐시·리사이즈 썸네일 참조",
        "evidence": (
            "backend/app/services/media_cache.py::local_rel_for/thumb_source_rel_for; "
            "backend/app/services/thumbs.py::cache_path/THUMB_WIDTHS"
        ),
    },
    {
        "source": "기타 path/*_path 및 알려진 JSON 컬럼",
        "role": "스키마 동적 검사; media-dir 내부 파일로 해석될 때만 참조",
        "evidence": "PRAGMA table_info 전수 검사",
    },
)

JSON_REFERENCE_COLUMNS = {
    "payload",
    "data",
    "params",
    "tomb_snapshot",
}


def _log(message: str) -> None:
    print(f"[baseline] {message}", file=sys.stderr, flush=True)


def open_readonly(path: Path) -> sqlite3.Connection:
    """체크포인트된 SQLite 사본을 파일 생성 가능성이 없는 읽기 전용으로 연다."""
    resolved = path.resolve(strict=True)
    uri = f"{resolved.as_uri()}?mode=ro&immutable=1"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA query_only=ON")
    return conn


def _quote(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def _tables(conn: sqlite3.Connection) -> list[str]:
    return [
        str(row[0])
        for row in conn.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
    ]


def _columns(conn: sqlite3.Connection, table: str) -> dict[str, str]:
    return {
        str(row[1]): str(row[2] or "")
        for row in conn.execute(f"PRAGMA table_info({_quote(table)})")
    }


def _has_table(conn: sqlite3.Connection, table: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        is not None
    )


def _utc_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    value = value.astimezone(timezone.utc)
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def classify_timestamp(value: Any) -> tuple[str, datetime | None]:
    """요구된 여섯 범주 중 하나와 비교 가능한 UTC 시각을 반환한다."""
    if value is None:
        return "null_or_empty", None
    text = str(value).strip()
    if not text:
        return "null_or_empty", None
    try:
        if _SPACE_NAIVE.fullmatch(text):
            parsed = datetime.strptime(text, "%Y-%m-%d %H:%M:%S").replace(
                tzinfo=timezone.utc
            )
            return "space_naive", parsed
        if _ISO_T_Z.fullmatch(text):
            parsed = datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(
                tzinfo=timezone.utc
            )
            return "iso_t_z", parsed
        fraction_match = _ISO_T_FRACTION_Z.fullmatch(text)
        if fraction_match:
            # datetime은 마이크로초까지만 받는다. 나노초 입력도 분류는 유지하고 비교값만 절삭한다.
            fraction = (fraction_match.group(2) + "000000")[:6]
            parsed = datetime.strptime(
                f"{fraction_match.group(1)}.{fraction}Z", "%Y-%m-%dT%H:%M:%S.%fZ"
            ).replace(tzinfo=timezone.utc)
            return "iso_t_milliseconds_z", parsed
        if _NUMERIC.fullmatch(text):
            epoch = float(text)
            if not math.isfinite(epoch):
                raise ValueError("non-finite epoch")
            magnitude = abs(epoch)
            if magnitude >= 1e17:
                epoch /= 1e9
            elif magnitude >= 1e14:
                epoch /= 1e6
            elif magnitude >= 1e11:
                epoch /= 1e3
            parsed = datetime.fromtimestamp(epoch, tz=timezone.utc)
            return "epoch_string", parsed
    except (OverflowError, OSError, ValueError):
        return "unparseable", None
    return "unparseable", None


def _month_bucket(value: Any) -> str:
    category, parsed = classify_timestamp(value)
    if parsed is not None:
        return parsed.strftime("%Y-%m")
    return category


def _empty_time_stats() -> dict[str, dict[str, Any]]:
    return {
        category: {"count": 0, "min_time": None, "max_time": None}
        for category in TIME_FORMATS
    }


def measure_time_column(
    conn: sqlite3.Connection, table: str, column: str, *, sort_column: str | None = None
) -> dict[str, Any]:
    if not _has_table(conn, table):
        return {"available": False, "reason": f"{table} 테이블 없음"}
    columns = _columns(conn, table)
    if column not in columns:
        return {"available": False, "reason": f"{table}.{column} 컬럼 없음"}

    stats = _empty_time_stats()
    total = 0
    for row in conn.execute(f"SELECT {_quote(column)} FROM {_quote(table)}"):
        total += 1
        category, parsed = classify_timestamp(row[0])
        entry = stats[category]
        entry["count"] += 1
        if parsed is not None:
            current_min = entry.pop("_min", None)
            current_max = entry.pop("_max", None)
            entry["_min"] = parsed if current_min is None else min(current_min, parsed)
            entry["_max"] = parsed if current_max is None else max(current_max, parsed)
    for entry in stats.values():
        entry["min_time"] = _utc_iso(entry.pop("_min", None))
        entry["max_time"] = _utc_iso(entry.pop("_max", None))

    result: dict[str, Any] = {
        "available": True,
        "table": table,
        "column": column,
        "total": total,
        "formats": stats,
    }
    if sort_column and sort_column in columns:
        result["sort_ts"] = {
            "column": sort_column,
            "null_count": conn.execute(
                f"SELECT COUNT(*) FROM {_quote(table)} WHERE {_quote(sort_column)} IS NULL"
            ).fetchone()[0],
            "total": total,
        }
    elif sort_column:
        result["sort_ts"] = {"column": sort_column, "available": False}
    return result


def classify_workspace_scope(value: Any) -> str:
    if value is None:
        return "NULL"
    text = str(value).strip().lower()
    if not text:
        return "empty"
    if text in {"team", "personal", "unknown"}:
        return text
    return "other"


def _workspace_id_state(value: Any) -> str:
    if value is None:
        return "NULL"
    if not str(value).strip():
        return "empty"
    return "value"


def _normalized_workspace(scope: Any, workspace_id: Any) -> tuple[str, str | None]:
    scope_text = str(scope or "").strip().lower()
    workspace_id_text = str(workspace_id or "").strip() or None
    if scope_text == "team" and workspace_id_text:
        return "team", workspace_id_text
    if scope_text == "personal":
        return "personal", None
    return "unknown", None


def _counter_dict(counter: Counter[str]) -> dict[str, int]:
    return {key: counter[key] for key in sorted(counter)}


def _team_task_exclusions(conn: sqlite3.Connection) -> dict[str, Any]:
    """현행 _same_workspace 계약상 팀 폴더 작업 gen_count에서 빠지는 행을 센다."""
    generation_columns = _columns(conn, "generation")
    project_columns = _columns(conn, "project") if _has_table(conn, "project") else {}
    required_generation = {
        "project_id",
        "folder_path",
        "workspace_scope",
        "workspace_id",
        "created_at",
    }
    required_project = {"id", "workspace_scope", "workspace_id"}
    if not required_generation.issubset(generation_columns) or not required_project.issubset(
        project_columns
    ):
        return {
            "available": False,
            "reason": "현행 project_id/folder_path/workspace 컬럼 일부 없음",
            "definition": "팀 프로젝트 폴더 작업과 generation의 정규화 workspace 불일치",
        }
    live_clause = "AND g.deleted_at IS NULL" if "deleted_at" in generation_columns else ""
    query = (
        "SELECT g.created_at, g.workspace_scope, g.workspace_id, "
        "p.workspace_scope AS project_scope, p.workspace_id AS project_workspace_id "
        "FROM generation g JOIN project p ON p.id=g.project_id "
        "WHERE g.project_id IS NOT NULL AND TRIM(g.project_id)<>'' "
        "AND g.folder_path IS NOT NULL AND TRIM(g.folder_path)<>'' "
        f"{live_clause}"
    )
    count = 0
    monthly: Counter[str] = Counter()
    reasons: Counter[str] = Counter()
    for row in conn.execute(query):
        project_scope, project_id = _normalized_workspace(
            row["project_scope"], row["project_workspace_id"]
        )
        if project_scope != "team":
            continue
        generation_scope, generation_id = _normalized_workspace(
            row["workspace_scope"], row["workspace_id"]
        )
        if generation_scope == "team" and generation_id == project_id:
            continue
        count += 1
        monthly[_month_bucket(row["created_at"])] += 1
        if generation_scope == "unknown":
            reasons["generation_workspace_unresolved"] += 1
        elif generation_scope == "personal":
            reasons["personal_in_team_project"] += 1
        else:
            reasons["different_team_workspace"] += 1
    return {
        "available": True,
        "definition": (
            "삭제되지 않은 project_id+folder_path generation 중 팀 프로젝트의 정확한 "
            "workspace_id와 일치하지 않아 _same_workspace에서 제외되는 행"
        ),
        "count": count,
        "by_month": _counter_dict(monthly),
        "by_reason": _counter_dict(reasons),
    }


def measure_workspace_distribution(conn: sqlite3.Connection) -> dict[str, Any]:
    if not _has_table(conn, "generation"):
        return {"available": False, "reason": "generation 테이블 없음"}
    columns = _columns(conn, "generation")
    required = {"workspace_scope", "workspace_id", "created_at"}
    if not required.issubset(columns):
        return {"available": False, "reason": "generation workspace 컬럼 일부 없음"}

    scope_counts: Counter[str] = Counter()
    id_state_counts: Counter[str] = Counter()
    exact_workspace_ids: Counter[str] = Counter()
    combinations: Counter[str] = Counter()
    monthly: dict[str, dict[str, Counter[str]]] = defaultdict(
        lambda: {
            "scope_counts": Counter(),
            "workspace_id_state_counts": Counter(),
            "normalized_counts": Counter(),
        }
    )
    unresolved = 0
    unresolved_monthly: Counter[str] = Counter()
    total = 0
    for row in conn.execute(
        "SELECT workspace_scope, workspace_id, created_at FROM generation"
    ):
        total += 1
        scope = classify_workspace_scope(row["workspace_scope"])
        id_state = _workspace_id_state(row["workspace_id"])
        normalized, normalized_id = _normalized_workspace(
            row["workspace_scope"], row["workspace_id"]
        )
        month = _month_bucket(row["created_at"])
        scope_counts[scope] += 1
        id_state_counts[id_state] += 1
        combinations[f"{scope}|workspace_id:{id_state}"] += 1
        if id_state == "value":
            exact_workspace_ids[str(row["workspace_id"]).strip()] += 1
        monthly[month]["scope_counts"][scope] += 1
        monthly[month]["workspace_id_state_counts"][id_state] += 1
        monthly[month]["normalized_counts"][normalized] += 1
        if normalized == "unknown":
            unresolved += 1
            unresolved_monthly[month] += 1

    monthly_out: dict[str, Any] = {}
    for month in sorted(monthly):
        monthly_out[month] = {
            name: _counter_dict(counter) for name, counter in monthly[month].items()
        }
    return {
        "available": True,
        "total": total,
        "scope_counts": _counter_dict(scope_counts),
        "workspace_id_state_counts": _counter_dict(id_state_counts),
        "workspace_id_value_counts": _counter_dict(exact_workspace_ids),
        "scope_workspace_id_combinations": _counter_dict(combinations),
        "by_month": monthly_out,
        "management_unresolved": {
            "definition": (
                "현행 상태 정규화에서 valid team+ID 또는 personal이 아니어서 unknown으로 "
                "취급되는 generation"
            ),
            "count": unresolved,
            "by_month": _counter_dict(unresolved_monthly),
        },
        "management_task_derivation_excluded": _team_task_exclusions(conn),
    }


def measure_ghost_cards(
    conn: sqlite3.Connection, *, now: datetime | None = None
) -> dict[str, Any]:
    if not _has_table(conn, "generation"):
        return {"available": False, "reason": "generation 테이블 없음"}
    columns = _columns(conn, "generation")
    if not {"id", "status", "created_at", "job_id"}.issubset(columns):
        return {"available": False, "reason": "generation 상태 컬럼 일부 없음"}
    has_requests = _has_table(conn, "gen_request") and {"id", "gen_id", "status"}.issubset(
        _columns(conn, "gen_request")
    )
    request_join = "LEFT JOIN gen_request r ON r.gen_id=g.id" if has_requests else ""
    request_fields = (
        ", COUNT(r.id) AS request_count, GROUP_CONCAT(DISTINCT r.status) AS request_statuses"
        if has_requests
        else ", 0 AS request_count, NULL AS request_statuses"
    )
    query = (
        "SELECT g.id, g.status, g.created_at"
        + request_fields
        + " FROM generation g "
        + request_join
        + " WHERE g.status IN ('pending','running') "
        "AND (g.job_id IS NULL OR TRIM(g.job_id)='') GROUP BY g.id"
    )
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    cutoff = current - timedelta(hours=GHOST_AGE_HOURS)
    total = 0
    unclassifiable = 0
    linkage: Counter[str] = Counter()
    generation_statuses: Counter[str] = Counter()
    request_statuses: Counter[str] = Counter()
    monthly: Counter[str] = Counter()
    oldest: datetime | None = None
    newest: datetime | None = None
    for row in conn.execute(query):
        _category, created = classify_timestamp(row["created_at"])
        if created is None:
            unclassifiable += 1
            continue
        if created > cutoff:
            continue
        total += 1
        oldest = created if oldest is None else min(oldest, created)
        newest = created if newest is None else max(newest, created)
        monthly[created.strftime("%Y-%m")] += 1
        generation_statuses[str(row["status"])] += 1
        linked = int(row["request_count"] or 0) > 0
        linkage["linked"] += int(linked)
        linkage["unlinked"] += int(not linked)
        if linked:
            for status in set(str(row["request_statuses"] or "").split(",")) - {""}:
                request_statuses[status] += 1
    return {
        "available": True,
        "age_hours": GHOST_AGE_HOURS,
        "cutoff": _utc_iso(cutoff),
        "definition": (
            "상태엔진의 미완 generation 상태 pending/running + job_id 없음 + 생성 후 24시간 이상"
        ),
        "active_request_state_definition": list(ACTIVE_REQUEST_STATES),
        "incomplete_generation_state_definition": list(INCOMPLETE_GENERATION_STATES),
        "count": total,
        "oldest_created_at": _utc_iso(oldest),
        "newest_created_at": _utc_iso(newest),
        "by_month": _counter_dict(monthly),
        "by_generation_status": _counter_dict(generation_statuses),
        "by_request_linkage": _counter_dict(linkage),
        "by_linked_request_status": _counter_dict(request_statuses),
        "age_unclassifiable_incomplete_rows": unclassifiable,
    }


def _iter_json_strings(value: Any) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from _iter_json_strings(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from _iter_json_strings(item)


def _media_key(value: Any, media_dir: Path) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    relative: str | None = None
    if text.startswith("/media/"):
        parsed = urlsplit(text)
        relative = unquote(parsed.path[len("/media/") :])
    else:
        try:
            candidate = Path(text)
            if candidate.is_absolute():
                relative = candidate.resolve(strict=False).relative_to(media_dir).as_posix()
        except (OSError, ValueError):
            return None
    if relative is None:
        return None
    relative = relative.replace("\\", "/").lstrip("/")
    parts = PurePosixPath(relative).parts
    if not parts or any(part in {"", ".", ".."} for part in parts):
        return None
    return "/".join(parts).casefold()


def _remote_url(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    parsed = urlsplit(text)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
        return None
    return text


def _remote_cache_keys(value: Any, media_dir: Path) -> set[str]:
    """서비스의 URL 규칙으로 영구 캐시와 썸네일 원본 캐시 후보를 계산한다."""
    url = _remote_url(value)
    if url is None:
        return set()
    keys: set[str] = set()
    for rel in (
        media_cache.local_rel_for(url),
        media_cache.thumb_source_rel_for(url),
    ):
        key = _media_key(rel, media_dir)
        if key is not None:
            keys.add(key)
    return keys


def _external_thumb_source(value: Any, media_dir: Path) -> Path | None:
    """media-dir 밖의 DB 절대경로 원본만 반환한다. 내부 원본은 디렉터리 스캔에서 처리한다."""
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.startswith("/media/") or _remote_url(text) is not None:
        return None
    try:
        candidate = Path(text)
        if not candidate.is_absolute():
            return None
        resolved = candidate.resolve(strict=False)
    except OSError:
        return None
    try:
        resolved.relative_to(media_dir)
        return None
    except ValueError:
        return resolved


def _reference_columns(conn: sqlite3.Connection) -> list[tuple[str, str, str]]:
    sources: list[tuple[str, str, str]] = []
    for table in _tables(conn):
        for column in _columns(conn, table):
            lower = column.lower()
            if lower == "path" or lower.endswith("_path"):
                sources.append((table, column, "path"))
            elif lower in JSON_REFERENCE_COLUMNS:
                sources.append((table, column, "json"))
    return sources


def collect_media_references(
    conn: sqlite3.Connection,
    media_dir: Path,
    *,
    database_label: str,
) -> tuple[set[str], set[str], set[Path], list[dict[str, Any]], list[str]]:
    direct_references: set[str] = set()
    cache_references: set[str] = set()
    external_thumb_sources: set[Path] = set()
    inventory: list[dict[str, Any]] = []
    warnings: list[str] = []
    for table, column, kind in _reference_columns(conn):
        matched_values = 0
        remote_url_values = 0
        invalid_json = 0
        query = f"SELECT {_quote(column)} FROM {_quote(table)} WHERE {_quote(column)} IS NOT NULL"
        for row in conn.execute(query):
            raw = row[0]
            values: Iterable[Any] = (raw,)
            if kind == "json":
                try:
                    values = _iter_json_strings(json.loads(str(raw)))
                except (TypeError, ValueError):
                    invalid_json += 1
                    continue
            for value in values:
                key = _media_key(value, media_dir)
                if key is not None:
                    direct_references.add(key)
                    matched_values += 1
                cache_keys = _remote_cache_keys(value, media_dir)
                if cache_keys:
                    cache_references.update(cache_keys)
                    remote_url_values += 1
                external_source = _external_thumb_source(value, media_dir)
                if external_source is not None:
                    external_thumb_sources.add(external_source)
        inventory.append(
            {
                "database": database_label,
                "table": table,
                "column": column,
                "scan_kind": kind,
                "media_path_values": matched_values,
                "remote_url_values": remote_url_values,
                "invalid_json_rows": invalid_json,
            }
        )
        if invalid_json:
            warnings.append(
                f"{database_label}.{table}.{column}: JSON 파싱 불가 {invalid_json}행"
            )
    if _has_table(conn, "media_preservation"):
        inventory.append(
            {
                "database": database_label,
                "table": "media_preservation",
                "column": "generation_id",
                "scan_kind": "indirect_via_generation_asset_reference",
                "media_path_values": 0,
                "invalid_json_rows": 0,
                "rows": conn.execute("SELECT COUNT(*) FROM media_preservation").fetchone()[0],
            }
        )
    return (
        direct_references,
        cache_references,
        external_thumb_sources,
        inventory,
        warnings,
    )


def _empty_category_summary() -> dict[str, dict[str, int]]:
    return {
        category: {"count": 0, "size_bytes": 0}
        for category in (
            "referenced",
            "referenced_cache",
            "thumb_derived",
            "trash_referenced",
            "thumb_orphan",
            "orphan_candidate",
        )
    }


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _require_checkpointed_copy(path: Path, label: str) -> None:
    """immutable 읽기가 무시할 수 있는 hot sidecar가 있으면 조용히 낡은 값을 읽지 않는다."""
    for suffix in ("-wal", "-journal"):
        sidecar = Path(str(path) + suffix)
        try:
            nonempty = sidecar.is_file() and sidecar.stat().st_size > 0
        except OSError as exc:
            raise ValueError(f"{label} DB sidecar 확인 실패: {sidecar}: {exc}") from exc
        if nonempty:
            raise ValueError(
                f"{label} DB 사본에 비어 있지 않은 {suffix} sidecar가 있습니다. "
                "SQLite backup/checkpoint로 단일 파일 사본을 다시 만드세요"
            )


def scan_media_dir(
    media_dir: Path,
    out_dir: Path,
    main_references: set[str],
    main_cache_references: set[str],
    trash_references: set[str],
    trash_cache_references: set[str],
    external_thumb_sources: set[Path],
) -> dict[str, Any]:
    """파일을 한 번씩만 보고 후보 JSON도 즉시 기록한다(파일 목록 메모리 적재 없음)."""
    root = media_dir.resolve(strict=True)
    candidate_path = out_dir / ORPHAN_JSON
    categories = _empty_category_summary()
    unseen_main = set(main_references)
    unseen_trash = set(trash_references)
    trash_all_references = trash_references | trash_cache_references
    derived_thumb_keys: set[str] = set()
    scan_errors: list[str] = []
    scan_error_count = 0
    scanned = 0
    first_candidate = True

    def record_error(path: Path | str, exc: OSError) -> None:
        nonlocal scan_error_count
        scan_error_count += 1
        if len(scan_errors) < 100:
            scan_errors.append(f"{path}: {exc}")

    def add_derived_thumbs(source: Path) -> None:
        if source.suffix.lower() not in IMAGE_EXTENSIONS + VIDEO_EXTENSIONS:
            return
        try:
            for width in thumbs.THUMB_WIDTHS:
                expected = thumbs.cache_path(source, width)
                relative = expected.relative_to(thumbs.THUMB_DIR).as_posix()
                derived_thumb_keys.add(f".thumbs/{relative}".casefold())
        except OSError as exc:
            record_error(source, exc)

    # media-dir 밖 Assets 원본도 같은 .thumbs 폴더를 사용한다. DB가 가리키고 실제 파일이
    # 존재할 때만 서비스 이름 규칙을 적용한다(존재하지 않는 원본은 stat 기반 키를 계산할 수 없음).
    for source in external_thumb_sources:
        try:
            if source.is_file():
                add_derived_thumbs(source)
        except OSError as exc:
            record_error(source, exc)

    def classify(key: str, *, in_thumb_dir: bool) -> str:
        if key in main_references:
            return "referenced"
        if key in main_cache_references:
            return "referenced_cache"
        if key in trash_all_references:
            return "trash_referenced"
        if key in derived_thumb_keys:
            return "thumb_derived"
        if in_thumb_dir:
            return "thumb_orphan"
        return "orphan_candidate"

    def account_file(path: Path, relative: str, size: int, *, in_thumb_dir: bool) -> None:
        nonlocal scanned, first_candidate
        scanned += 1
        key = relative.casefold()
        category = classify(key, in_thumb_dir=in_thumb_dir)
        if category == "orphan_candidate":
            if not first_candidate:
                output.write(",")
            output.write(
                json.dumps(
                    {"path": relative, "size_bytes": size},
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
            )
            first_candidate = False
        categories[category]["count"] += 1
        categories[category]["size_bytes"] += size
        unseen_main.discard(key)
        unseen_trash.discard(key)
        if not in_thumb_dir:
            add_derived_thumbs(path)
        if scanned % PROGRESS_EVERY == 0:
            _log(f"media 파일 {scanned:,}개 검사")

    _log(f"media 스캔 시작: {root}")
    with candidate_path.open("w", encoding="utf-8", newline="\n") as output:
        output.write(
            json.dumps(
                {
                    "schema_version": 1,
                    "media_dir": str(root),
                    "classification": (
                        "DB/JSON 직접 참조, URL 캐시 매핑, 휴지통 참조가 없고 "
                        ".thumbs 파일도 아닌 파일"
                    ),
                },
                ensure_ascii=False,
            )[:-1]
        )
        output.write(',"candidates":[')
        # 1차: .thumbs 이외 파일을 분류하면서 각 실제 원본의 썸네일 키를 계산한다.
        # 썸네일을 나중에 보므로 디렉터리 열거 순서와 무관하게 정확히 판정할 수 있다.
        stack = [root]
        while stack:
            directory = stack.pop()
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        try:
                            if entry.is_dir(follow_symlinks=False):
                                child = Path(entry.path)
                                child_relative = child.relative_to(root).as_posix()
                                if child_relative.casefold() != ".thumbs":
                                    stack.append(child)
                                continue
                            if not entry.is_file(follow_symlinks=False):
                                continue
                            stat = entry.stat(follow_symlinks=False)
                            relative = Path(entry.path).relative_to(root).as_posix()
                        except OSError as exc:
                            record_error(entry.path, exc)
                            continue
                        account_file(
                            Path(entry.path), relative, stat.st_size, in_thumb_dir=False
                        )
            except OSError as exc:
                record_error(directory, exc)

        # 2차: 실제 서비스 규칙으로 원본에서 파생되는 이름인지 확인한다. 파생 불가능한
        # .thumbs 항목은 재생성 캐시라는 낮은 위험도를 반영해 thumb_orphan으로 따로 둔다.
        thumb_root = root / ".thumbs"
        try:
            thumb_root_available = thumb_root.is_dir() and not thumb_root.is_symlink()
        except OSError as exc:
            record_error(thumb_root, exc)
            thumb_root_available = False
        thumb_stack = [thumb_root] if thumb_root_available else []
        while thumb_stack:
            directory = thumb_stack.pop()
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        try:
                            if entry.is_dir(follow_symlinks=False):
                                thumb_stack.append(Path(entry.path))
                                continue
                            if not entry.is_file(follow_symlinks=False):
                                continue
                            stat = entry.stat(follow_symlinks=False)
                            relative = Path(entry.path).relative_to(root).as_posix()
                        except OSError as exc:
                            record_error(entry.path, exc)
                            continue
                        account_file(
                            Path(entry.path), relative, stat.st_size, in_thumb_dir=True
                        )
            except OSError as exc:
                record_error(directory, exc)
        output.write("]}")
    _log(f"media 스캔 완료: {scanned:,}개")
    return {
        "available": True,
        "media_dir": str(root),
        "streaming_scan": True,
        "scanned_files": scanned,
        "categories": categories,
        "category_definitions": {
            "referenced": "content/manage DB 또는 JSON의 로컬 경로가 직접 가리키는 파일",
            "referenced_cache": (
                "content/manage DB 또는 JSON의 원격 URL을 media_cache 서비스 규칙으로 "
                "변환했을 때 대응하는 파일"
            ),
            "thumb_derived": (
                "DB 참조 절대경로 원본 또는 media-dir 실제 원본에서 thumbs 서비스의 "
                "THUMB_WIDTHS/cache_path 규칙으로 파생되는 .thumbs 파일"
            ),
            "trash_referenced": (
                "trash DB/JSON의 직접 로컬 경로 또는 원격 URL 캐시 매핑이 가리키는 파일"
            ),
            "thumb_orphan": (
                ".thumbs 안에 있지만 DB 참조 원본과 media-dir 실제 원본 어느 쪽에서도 "
                "현재 이름을 파생할 수 없는 재생성 가능 파일"
            ),
            "orphan_candidate": (
                "위 참조·파생 범주에 없고 .thumbs 밖에 있는 파일"
            ),
        },
        "orphan_candidates_file": ORPHAN_JSON,
        "referenced_paths_missing_on_disk": len(unseen_main),
        "trash_referenced_paths_missing_on_disk": len(unseen_trash - main_references),
        "scan_error_count": scan_error_count,
        "scan_error_examples": scan_errors,
    }


def _markdown_escape(value: Any) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def _format_bytes(value: int) -> str:
    units = ("B", "KiB", "MiB", "GiB", "TiB")
    amount = float(value)
    for unit in units:
        if abs(amount) < 1024 or unit == units[-1]:
            return f"{amount:.1f} {unit}" if unit != "B" else f"{int(amount)} B"
        amount /= 1024
    return f"{value} B"


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# 읽기 전용 기준선 측정 보고서",
        "",
        f"- 생성 시각(UTC): `{report['generated_at']}`",
        f"- content DB 사본: `{_markdown_escape(report['inputs']['db'])}`",
        f"- trash DB 사본: `{_markdown_escape(report['inputs'].get('trash') or '미제공')}`",
        f"- manage DB 사본: `{_markdown_escape(report['inputs'].get('manage') or '미제공')}`",
        f"- media 경로: `{_markdown_escape(report['inputs'].get('media_dir') or '미제공')}`",
        "- 입력 연결: SQLite URI `mode=ro&immutable=1`, `query_only=ON`",
        "",
        "## 1. 워크스페이스 스코프 분포",
        "",
    ]
    workspace = report["workspace_scope_distribution"]
    if not workspace.get("available"):
        lines.append(f"측정 불가: {workspace.get('reason')}")
    else:
        lines.extend(["| scope | 건수 |", "|---|---:|"])
        for key, count in workspace["scope_counts"].items():
            lines.append(f"| {_markdown_escape(key)} | {count} |")
        lines.extend(["", "| workspace_id 상태 | 건수 |", "|---|---:|"])
        for key, count in workspace["workspace_id_state_counts"].items():
            lines.append(f"| {_markdown_escape(key)} | {count} |")
        if workspace["workspace_id_value_counts"]:
            lines.extend(["", "| workspace_id 값 | 건수 |", "|---|---:|"])
            for key, count in workspace["workspace_id_value_counts"].items():
                lines.append(f"| `{_markdown_escape(key)}` | {count} |")
        unresolved = workspace["management_unresolved"]
        excluded = workspace["management_task_derivation_excluded"]
        lines.extend(
            [
                "",
                f"- 관리 정규화상 unknown: **{unresolved['count']}건**",
                f"- 정의: {unresolved['definition']}",
            ]
        )
        if excluded.get("available"):
            lines.extend(
                [
                    f"- 팀 작업 gen_count 제외: **{excluded['count']}건**",
                    f"- 정의: {excluded['definition']}",
                ]
            )
        else:
            lines.append(f"- 팀 작업 gen_count 제외 측정 불가: {excluded.get('reason')}")
        lines.extend(["", "### 월별 scope", "", "| 월 | scope 분포 |", "|---|---|"])
        for month, values in workspace["by_month"].items():
            detail = ", ".join(
                f"{key}={count}" for key, count in values["scope_counts"].items()
            )
            lines.append(f"| {_markdown_escape(month)} | {_markdown_escape(detail)} |")
        lines.extend(
            [
                "",
                "### 관리 파생 제외 월별",
                "",
                "| 월 | 정규화 unknown | 팀 작업 gen_count 제외 |",
                "|---|---:|---:|",
            ]
        )
        exclusion_months = excluded.get("by_month", {}) if excluded.get("available") else {}
        all_months = sorted(set(unresolved["by_month"]) | set(exclusion_months))
        for month in all_months:
            lines.append(
                f"| {_markdown_escape(month)} | {unresolved['by_month'].get(month, 0)} | "
                f"{exclusion_months.get(month, 0)} |"
            )

    lines.extend(["", "## 2. 시각 포맷 분포", ""])
    for name, dataset in report["timestamp_formats"].items():
        lines.append(f"### `{name}`")
        lines.append("")
        if not dataset.get("available"):
            lines.extend([f"측정 불가: {dataset.get('reason')}", ""])
            continue
        lines.extend(["| 형식 | 건수 | 최소 시기 | 최대 시기 |", "|---|---:|---|---|"])
        for category in TIME_FORMATS:
            entry = dataset["formats"][category]
            lines.append(
                f"| {TIME_LABELS[category]} | {entry['count']} | "
                f"{entry['min_time'] or '-'} | {entry['max_time'] or '-'} |"
            )
        sort_ts = dataset.get("sort_ts")
        if sort_ts and sort_ts.get("available", True):
            lines.append(f"\n`sort_ts IS NULL`: **{sort_ts['null_count']} / {sort_ts['total']}건**")
        lines.append("")

    lines.extend(["## 3. 고아 파일 분류", ""])
    orphan = report["orphan_files"]
    if not orphan.get("available"):
        lines.append(f"측정 불가: {orphan.get('reason')}")
    else:
        lines.extend(["| 분류 | 파일 수 | 총 크기 |", "|---|---:|---:|"])
        for category, values in orphan["categories"].items():
            lines.append(
                f"| {category} | {values['count']} | {_format_bytes(values['size_bytes'])} |"
            )
        lines.extend(["", "분류 정의:", ""])
        for category, definition in orphan.get("category_definitions", {}).items():
            lines.append(f"- `{category}`: {_markdown_escape(definition)}")
        lines.extend(
            [
                "",
                f"- 고아 후보 목록: `{orphan['orphan_candidates_file']}`",
                "- 이 결과는 분류만 하며 삭제 또는 삭제 제안을 포함하지 않습니다.",
                f"- 스캔 오류: {orphan['scan_error_count']}건",
                "",
                "### 경로 참조 원천 전수 목록",
                "",
                "| 원천 | 역할 | 확인 근거 |",
                "|---|---|---|",
            ]
        )
        for item in report["file_reference_audit"]["code_sources"]:
            lines.append(
                f"| {_markdown_escape(item['source'])} | {_markdown_escape(item['role'])} | "
                f"{_markdown_escape(item['evidence'])} |"
            )
        lines.extend(["", "동적 스키마에서 검사한 컬럼:", ""])
        for item in report["file_reference_audit"]["scanned_schema_sources"]:
            lines.append(
                f"- `{item['database']}.{item['table']}.{item['column']}` "
                f"({item['scan_kind']}, media 값 {item['media_path_values']}건, "
                f"원격 URL {item.get('remote_url_values', 0)}건)"
            )

    lines.extend(["", "## 4. 유령 카드", ""])
    ghosts = report["ghost_cards"]
    if not ghosts.get("available"):
        lines.append(f"측정 불가: {ghosts.get('reason')}")
    else:
        lines.extend(
            [
                f"- 후보: **{ghosts['count']}건**",
                f"- 정의: {ghosts['definition']}",
                f"- 가장 오래된 시각: `{ghosts['oldest_created_at'] or '-'}`",
                f"- 가장 최근 후보 시각: `{ghosts['newest_created_at'] or '-'}`",
                f"- gen_request 연결: `{json.dumps(ghosts['by_request_linkage'], ensure_ascii=False)}`",
                f"- 연결 요청 상태: `{json.dumps(ghosts['by_linked_request_status'], ensure_ascii=False)}`",
                f"- 나이 판정 불가 미완행: {ghosts['age_unclassifiable_incomplete_rows']}건",
                "- 상태엔진 요청 활성값: " + ", ".join(ghosts["active_request_state_definition"]),
            ]
        )
    warnings = report.get("warnings") or []
    if warnings:
        lines.extend(["", "## 경고", ""])
        lines.extend(f"- {_markdown_escape(item)}" for item in warnings)
    lines.append("")
    return "\n".join(lines)


def _validate_paths(args: argparse.Namespace) -> tuple[Path, Path | None, Path | None, Path | None, Path]:
    db = args.db.resolve(strict=True)
    if not db.is_file():
        raise ValueError(f"content DB 사본이 파일이 아닙니다: {db}")
    trash = args.trash.resolve(strict=True) if args.trash else None
    manage = args.manage.resolve(strict=True) if args.manage else None
    for label, path in (("trash", trash), ("manage", manage)):
        if path is not None and not path.is_file():
            raise ValueError(f"{label} DB 사본이 파일이 아닙니다: {path}")
    _require_checkpointed_copy(db, "content")
    if trash is not None:
        _require_checkpointed_copy(trash, "trash")
    if manage is not None:
        _require_checkpointed_copy(manage, "manage")
    media = args.media_dir.resolve(strict=True) if args.media_dir else None
    if media is not None and not media.is_dir():
        raise ValueError(f"media-dir가 폴더가 아닙니다: {media}")
    out_dir = args.out_dir.resolve(strict=False)
    if media is not None and _is_within(out_dir, media):
        raise ValueError("--out-dir은 --media-dir 내부일 수 없습니다(스캔 결과 오염 방지)")
    return db, trash, manage, media, out_dir


def build_report(
    db_path: Path,
    trash_path: Path | None,
    manage_path: Path | None,
    media_dir: Path | None,
    out_dir: Path,
) -> dict[str, Any]:
    warnings: list[str] = []
    schema_inventory: list[dict[str, Any]] = []
    with closing(open_readonly(db_path)) as content:
        workspace = measure_workspace_distribution(content)
        timestamps = {
            "generation.created_at": measure_time_column(
                content, "generation", "created_at", sort_column="sort_ts"
            ),
            "credit_txn.created_at": measure_time_column(
                content, "credit_txn", "created_at"
            ),
        }
        ghosts = measure_ghost_cards(content)
        main_references: set[str] = set()
        main_cache_references: set[str] = set()
        external_thumb_sources: set[Path] = set()
        if media_dir is not None:
            (
                main_references,
                main_cache_references,
                external_thumb_sources,
                inventory,
                reference_warnings,
            ) = collect_media_references(content, media_dir, database_label="content")
            schema_inventory.extend(inventory)
            warnings.extend(reference_warnings)

    if manage_path is not None:
        with closing(open_readonly(manage_path)) as manage:
            timestamps["team_generation_fact.created_at"] = measure_time_column(
                manage, "team_generation_fact", "created_at", sort_column="sort_ts"
            )
            if media_dir is not None:
                (
                    refs,
                    cache_refs,
                    thumb_sources,
                    inventory,
                    reference_warnings,
                ) = collect_media_references(manage, media_dir, database_label="manage")
                main_references.update(refs)
                main_cache_references.update(cache_refs)
                external_thumb_sources.update(thumb_sources)
                schema_inventory.extend(inventory)
                warnings.extend(reference_warnings)
    else:
        timestamps["team_generation_fact.created_at"] = {
            "available": False,
            "reason": "--manage 미제공",
        }

    trash_references: set[str] = set()
    trash_cache_references: set[str] = set()
    if trash_path is not None and media_dir is not None:
        with closing(open_readonly(trash_path)) as trash:
            (
                trash_references,
                trash_cache_references,
                trash_thumb_sources,
                inventory,
                reference_warnings,
            ) = collect_media_references(trash, media_dir, database_label="trash")
            external_thumb_sources.update(trash_thumb_sources)
            schema_inventory.extend(inventory)
            warnings.extend(reference_warnings)

    if media_dir is None:
        orphan_files: dict[str, Any] = {
            "available": False,
            "reason": "--media-dir 미제공",
        }
    else:
        orphan_files = scan_media_dir(
            media_dir,
            out_dir,
            main_references,
            main_cache_references,
            trash_references,
            trash_cache_references,
            external_thumb_sources,
        )
        if trash_path is None:
            warnings.append("--trash 미제공: 휴지통 참조 없이 분류함")

    return {
        "schema_version": 1,
        "generated_at": _utc_iso(datetime.now(timezone.utc)),
        "read_only_contract": {
            "sqlite_uri": "mode=ro&immutable=1",
            "query_only": True,
            "input_defaults": False,
            "writes": ["out_dir reports only"],
        },
        "inputs": {
            "db": str(db_path),
            "trash": str(trash_path) if trash_path else None,
            "manage": str(manage_path) if manage_path else None,
            "media_dir": str(media_dir) if media_dir else None,
        },
        "workspace_scope_distribution": workspace,
        "timestamp_formats": timestamps,
        "orphan_files": orphan_files,
        "file_reference_audit": {
            "discovery_method": (
                "rg로 schema.sql/repo/service의 경로 사용처를 대조하고, 실행 시 PRAGMA "
                "table_info로 path/*_path 및 알려진 JSON 컬럼을 전수 검사"
            ),
            "code_sources": list(REFERENCE_CODE_AUDIT),
            "scanned_schema_sources": schema_inventory,
        },
        "ghost_cards": ghosts,
        "warnings": warnings,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="SQLite/미디어 사본 읽기 전용 기준선 측정(보고서만 out-dir에 기록)"
    )
    parser.add_argument("--db", required=True, type=Path, help="content_hub.db 사본")
    parser.add_argument("--trash", type=Path, help="content_hub_trash.db 사본")
    parser.add_argument("--manage", type=Path, help="manage_hub.db 사본")
    parser.add_argument("--media-dir", type=Path, help="복사된 data/media 폴더")
    parser.add_argument("--out-dir", required=True, type=Path, help="보고서 출력 폴더")
    args = parser.parse_args(argv)
    try:
        db, trash, manage, media, out_dir = _validate_paths(args)
        out_dir.mkdir(parents=True, exist_ok=True)
        report = build_report(db, trash, manage, media, out_dir)
        (out_dir / REPORT_JSON).write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        (out_dir / REPORT_MARKDOWN).write_text(
            render_markdown(report), encoding="utf-8"
        )
    except (OSError, sqlite3.Error, ValueError) as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1
    print(f"완료: {out_dir / REPORT_MARKDOWN}")
    print(f"완료: {out_dir / REPORT_JSON}")
    if media is not None:
        print(f"완료: {out_dir / ORPHAN_JSON}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
