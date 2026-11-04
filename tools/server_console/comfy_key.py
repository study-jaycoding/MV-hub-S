"""서버 관리 창 'Comfy 키'의 글자 — 상태·안내·확인 창. 화면(Tk)과 떼어 시험한다.

서버 GET /api/admin/comfy-team-key 는 키의 어느 조각도 주지 않는다({has_key, state, revision, updated_at, updated_by}).
이 글자들도 입력한 키를 쓰지 않는다. 계약: docs/status/Comfy팀키_서버배포_2026-11-04.md.
"""
from __future__ import annotations

PAGE_TEXT = ("팀원 PC 의 허브가 Comfy 를 실행할 때 이 키를 받아 씁니다(설정에서 '팀 키'를 고른 PC).\n"
             "키는 이 PC 에서만 풀리는 형태로 저장돼 NAS 백업 사본에서는 읽을 수 없습니다. 서버 PC 를 바꾸면 다시 등록합니다.")
AFTER_TEXT = ("교체하면 진행 중인 실행은 그대로 끝나고, 팀원 PC 는 다음 실행부터(1분 안) 새 키를 씁니다. "
              "삭제하면 팀 키를 쓰던 PC 는 '팀 키 없음'이 됩니다. 회수는 여기 삭제만으로 끝나지 않습니다 — "
              "platform.comfy.org 에서 폐기해야 합니다.")
OLD_SERVER = "서버가 옛 코드라 팀 Comfy 키를 못 씁니다 — 서버 Git 업데이트 뒤에 보입니다"
LOGIN_FIRST = "관리자로 로그인하면 보입니다"


def _when(meta: dict) -> str:
    stamp = str(meta.get("updated_at") or "")
    return stamp.replace("T", " ").rstrip("Z") if stamp else "시각 모름"


def status_text(meta: dict | None) -> str:
    """등록 상태 한 줄 — 키 조각은 절대 넣지 않는다."""
    if not meta:
        return "확인 중"
    state = meta.get("state")
    if state == "undecryptable":
        return "등록된 키를 이 PC 에서 풀 수 없습니다 — 서버 PC 가 바뀌었거나 저장 형식이 다릅니다. 다시 등록하세요(기존 값은 지우지 않았습니다)"
    if state != "ok" or not meta.get("has_key"):
        return "등록된 키 없음 — 팀원 PC 는 '팀 키 없음'으로 실행하지 못합니다"
    who = str(meta.get("updated_by") or "").strip() or "모름"
    return f"등록됨 · {_when(meta)} · {who} · {int(meta.get('revision') or 0)}판"


def can_delete(meta: dict | None) -> bool:
    return bool(meta) and (meta.get("has_key") is True or meta.get("state") == "undecryptable")


def put_confirm_text(meta: dict | None) -> str:
    if meta and meta.get("has_key"):
        return "이미 등록된 키를 새 키로 바꿉니다. 팀원 PC 는 다음 실행부터(1분 안) 새 키를 씁니다.\n옛 키는 platform.comfy.org 에서 따로 폐기하세요."
    return "팀 키를 등록합니다. 설정에서 '팀 키'를 고른 팀원 PC 가 다음 실행부터 이 키를 씁니다."


def delete_confirm_text() -> str:
    return ("팀 키를 서버에서 지웁니다. 팀 키를 쓰던 PC 는 다음 실행부터 '팀 키 없음'으로 실행하지 못합니다.\n"
            "키 자체의 회수는 platform.comfy.org 에서 폐기해야 끝납니다.")


def done_text(action: str, meta: dict | None) -> str:
    if action == "put":
        return f"등록했습니다 — {int((meta or {}).get('revision') or 0)}판"
    if action == "delete":
        return "지웠습니다"
    return ""
