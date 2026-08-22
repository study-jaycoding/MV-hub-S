"""생성물 개인 메타 배치 저장 흐름.

라우터의 FastAPI 요청/예외와 저장소 SQL 사이에서 로컬 id 해석, 팀 카드 shadow 분기,
서버 카드 재확인, 실제 배치 저장을 조립한다. 권한 판정과 서버 배치 조회는 콜백으로 받아
usecase가 FastAPI에 의존하지 않게 유지한다.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Optional

from .. import repo


CanEdit = Callable[[dict[str, Any]], bool]
FetchServerCards = Callable[[list[str]], dict[str, dict[str, Any]]]


@dataclass(frozen=True)
class BatchMutationResult:
    succeeded: list[str]
    failed: list[str]


def _resolve_targets(
    requested_ids: list[str],
    *,
    proxying: bool,
    my_uid: Optional[str],
    allow_shadow: bool,
    can_edit: CanEdit,
    fetch_server_cards: FetchServerCards,
) -> tuple[dict[str, str], dict[str, str]]:
    """요청 id를 로컬 generation id 또는 팀 shadow anchor로 분류한다."""
    unique_ids = list(dict.fromkeys(requested_ids or []))
    local_refs = repo.resolve_generation_meta_batch(unique_ids)
    local_targets: dict[str, str] = {}
    shadow_targets: dict[str, str] = {}
    # 값=True면 서버 응답의 job_id로 로컬 행을 되찾는다. 이미 로컬에서 남의 행으로 판정된
    # 카드는 단건 경로와 동일하게 재해석하지 않고 서버 anchor에 shadow를 저장한다.
    needs_server: dict[str, bool] = {}

    def is_other(ref: dict[str, Any]) -> bool:
        creator_uid = ref.get("creator_uid")
        return bool(proxying and creator_uid and creator_uid != my_uid)

    for requested_id in unique_ids:
        ref = local_refs.get(requested_id)
        if ref:
            if allow_shadow and is_other(ref):
                needs_server[requested_id] = False
            elif can_edit(ref):
                local_targets[requested_id] = ref["id"]
        elif proxying:
            needs_server[requested_id] = True

    server_cards = fetch_server_cards(list(needs_server)) if needs_server else {}

    reclaim_job_ids = [
        server_cards[requested_id].get("job_id")
        for requested_id, should_reclaim in needs_server.items()
        if should_reclaim
        and requested_id in server_cards
        and server_cards[requested_id].get("job_id")
    ]
    reclaimed = repo.resolve_generation_meta_batch(reclaim_job_ids) if reclaim_job_ids else {}

    for requested_id, should_reclaim in needs_server.items():
        server_card = server_cards.get(requested_id)
        if server_card is None:
            continue
        job_id = server_card.get("job_id")
        ref = reclaimed.get(job_id) if should_reclaim and job_id else None
        if ref:
            if allow_shadow and is_other(ref):
                shadow_targets[requested_id] = (
                    job_id or server_card.get("id") or requested_id
                )
            elif can_edit(ref):
                local_targets[requested_id] = ref["id"]
        elif allow_shadow:
            shadow_targets[requested_id] = (
                job_id or server_card.get("id") or requested_id
            )

    return local_targets, shadow_targets


def set_tags_batch(
    items: list[tuple[str, list[str]]],
    *,
    auto: bool,
    proxying: bool,
    my_uid: Optional[str],
    can_edit: CanEdit,
    fetch_server_cards: FetchServerCards,
) -> BatchMutationResult:
    """일반/자동 태그를 로컬과 팀 shadow 경계에 맞춰 실제 배치 저장한다."""
    local_targets, shadow_targets = _resolve_targets(
        [requested_id for requested_id, _ in items],
        proxying=proxying,
        my_uid=my_uid,
        allow_shadow=not auto,
        can_edit=can_edit,
        fetch_server_cards=fetch_server_cards,
    )
    local_items: list[tuple[str, list[str]]] = []
    shadow_items: list[tuple[str, list[str]]] = []
    succeeded: list[str] = []
    failed: list[str] = []
    for requested_id, tags in items:
        local_id = local_targets.get(requested_id)
        shadow_anchor = shadow_targets.get(requested_id)
        if local_id:
            local_items.append((local_id, tags))
            succeeded.append(requested_id)
        elif shadow_anchor:
            shadow_items.append((shadow_anchor, tags))
            succeeded.append(requested_id)
        else:
            failed.append(requested_id)

    if auto:
        repo.set_generation_auto_tags_batch(local_items)
    else:
        repo.apply_generation_personal_meta_writes(
            local_items,
            shadow_items,
            local_writer=repo.set_generation_tags_batch,
            shadow_writer=repo.set_tag_overlays_batch,
        )
    return BatchMutationResult(succeeded, failed)


def set_colors_batch(
    items: list[tuple[str, Optional[str]]],
    *,
    proxying: bool,
    my_uid: Optional[str],
    can_edit: CanEdit,
    fetch_server_cards: FetchServerCards,
) -> BatchMutationResult:
    """색상을 로컬 generation과 팀 shadow 경계에 맞춰 실제 배치 저장한다."""
    local_targets, shadow_targets = _resolve_targets(
        [requested_id for requested_id, _ in items],
        proxying=proxying,
        my_uid=my_uid,
        allow_shadow=True,
        can_edit=can_edit,
        fetch_server_cards=fetch_server_cards,
    )
    local_items: list[tuple[str, Optional[str]]] = []
    shadow_items: list[tuple[str, Optional[str]]] = []
    succeeded: list[str] = []
    failed: list[str] = []
    for requested_id, color in items:
        local_id = local_targets.get(requested_id)
        shadow_anchor = shadow_targets.get(requested_id)
        if local_id:
            local_items.append((local_id, color))
            succeeded.append(requested_id)
        elif shadow_anchor:
            shadow_items.append((shadow_anchor, color))
            succeeded.append(requested_id)
        else:
            failed.append(requested_id)

    repo.apply_generation_personal_meta_writes(
        local_items,
        shadow_items,
        local_writer=repo.set_generation_colors_batch,
        shadow_writer=repo.set_color_overlays_batch,
    )
    return BatchMutationResult(succeeded, failed)
