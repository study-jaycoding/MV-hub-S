"""완료본 내보내기 '대상 판정' 정책의 단일 출처 (구조-03 1단계 + 성능-08).

판정 규칙은 list_tasks 파생 상태에서 유도한 순수 함수(is_exportable)이며,
프로젝트 전체(finals_to_export)와 단건(final_to_export)이 같은 함수를 쓴다 —
정책 복제 금지. 원자료 조회는 repo(final_export_task_facts/sources)가,
경로·파일명·NAS 안전은 project_folders 가 담당한다(이 모듈은 디스크를 모른다).
"""

from __future__ import annotations

from typing import Any, Iterable, Optional

from ..repo import manage as repo_manage


def is_exportable(task: dict[str, Any], cut: dict[str, Any]) -> bool:
    """이 작업(원자료 facts) 아래의 이 컷이 저장 대상인가 — list_tasks 파생 규칙에서 유도.

    · 컷: is_final 이면서 생성 status='done' 이어야 한다.
    · 폴더 자동 작업: raw status 가 'omit'(수동 생략)만 아니면 된다 — 파생 '완료'는
      최종 컷 존재로 성립하는데, 후보 컷 자체가 최종이므로 자동으로 증명된다.
    · 폴더 없는 수동/시퀀스 작업: 파생이 없으므로 raw status 가 실제 'done' 이어야 한다.
    · archived 는 제외 조건이 아니다(과거 기록으로 넘어간 완료 작업도 저장 대상 유지).
    """
    if not cut.get("is_final") or cut.get("status") != "done":
        return False
    # 레거시 파생 규칙과 같은 truthiness 판정 — 공백뿐인 folder_path(" ")도 레거시처럼
    # 폴더 작업으로 본다(strip 하면 레거시 데이터에서 판정이 갈린다 — 코덱스 P3).
    if task.get("folder_path"):
        return (task.get("status") or "") != "omit"
    return (task.get("status") or "") == "done"


def select_exportable_gen_ids(tasks: Iterable[dict[str, Any]]) -> set[str]:
    """작업 원자료 목록에서 저장 대상 gen_id 집합 — 전체/단건 판정이 공유하는 유일한 정책 적용점."""
    return {
        cut["id"]
        for task in tasks
        for cut in task.get("cuts", [])
        if is_exportable(task, cut)
    }


def finals_to_export(project_id: str) -> list[dict[str, Any]]:
    """프로젝트 전체 저장 대상 — 종전 repo_manage.finals_to_export 와 동일 반환
    [{gen_id, folder_path, file_path, media_type}]."""
    facts = repo_manage.final_export_task_facts(project_id)
    selected = select_exportable_gen_ids(facts)
    if not selected:
        return []
    return repo_manage.final_export_sources(project_id, selected)


def final_to_export(project_id: str, gen_id: str) -> Optional[dict[str, Any]]:
    """단건 판정 — 프로젝트 전수 판정 없이 같은 정책 함수로 이 생성물만 판정한다.
    반환 형태는 finals_to_export 의 한 항목과 동일, 대상이 아니면 None."""
    if not gen_id:
        return None
    facts = repo_manage.final_export_task_facts(project_id, gen_id=gen_id)
    if gen_id not in select_exportable_gen_ids(facts):
        return None
    sources = repo_manage.final_export_sources(project_id, [gen_id])
    return sources[0] if sources else None
