"""Assets의 내장 프로젝트 이름과 메타데이터 키 변환 규칙."""

from __future__ import annotations


PROMPT_IMPORT_PROJECT = "imports"
COMBINED_INTERNAL_PROJECT = "imp/cap"
INTERNAL_FOLDERS = ("captures", PROMPT_IMPORT_PROJECT)


def real_meta_key(project: str, path: str) -> tuple[str, str]:
    """합본 프로젝트의 표시 경로를 실제 저장 프로젝트·경로로 바꾼다."""
    if project != COMBINED_INTERNAL_PROJECT:
        return project, path
    head, separator, rest = path.partition("/")
    if separator and head in INTERNAL_FOLDERS:
        return head, rest
    return project, path
