"""Assets의 내장 프로젝트 이름과 메타데이터 키 변환 규칙."""

from __future__ import annotations


PROMPT_IMPORT_PROJECT = "imports"
COMBINED_INTERNAL_PROJECT = "imp/cap"
INTERNAL_FOLDERS = ("captures", PROMPT_IMPORT_PROJECT)


def is_live_project_ref(file_path, media_type="image") -> bool:
    """프로젝트 폴더 원본 이미지(asset:<project>|<path>, 내장 imports·captures·imp/cap 제외) — 같은 이름
    덮어쓰기를 따라가므로 생성 기대 지문을 싣지 않는다. 프런트 isLiveProjectRef 와 같은 규칙(2026-11-10)."""
    if not isinstance(file_path, str) or not file_path.startswith("asset:") or (media_type or "image") != "image":
        return False
    project, separator, _ = file_path[len("asset:"):].partition("|")
    return bool(separator and project) and project not in (COMBINED_INTERNAL_PROJECT, *INTERNAL_FOLDERS)


def real_meta_key(project: str, path: str) -> tuple[str, str]:
    """합본 프로젝트의 표시 경로를 실제 저장 프로젝트·경로로 바꾼다."""
    if project != COMBINED_INTERNAL_PROJECT:
        return project, path
    head, separator, rest = path.partition("/")
    if separator and head in INTERNAL_FOLDERS:
        return head, rest
    return project, path
