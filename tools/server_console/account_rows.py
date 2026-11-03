"""서버 관리 창 '계정 정리'의 글자 — 표 칸·판정·확인 창. 화면(Tk)과 떼어 시험한다.

행은 서버 GET /api/admin/account-cleanup 의 계정 하나다. 이 화면만 이메일을 보인다 — 지울 계정을 정확히 고르려면
오타 한 글자까지 봐야 한다(다른 표는 이름만, 관리자 로그인 뒤 서버 PC 에서만 나온다).
"""
from __future__ import annotations

COLUMNS = (("name", "이름", 150), ("email", "이메일", 270), ("state", "상태", 110),
           ("history", "이력", 300), ("verdict", "판정", 90))
STATUS_WORDS = {"approved": "승인", "pending": "대기", "rejected": "차단"}
VERDICT_WORDS = {"deletable": "삭제 가능", "block_first": "먼저 차단", "blocked": "삭제 불가"}
DELETE_OFF = "이번 릴리스에서는 삭제가 꺼져 있습니다"  # 서버 GET 의 delete_enabled 가 거짓이거나 없을 때 — 판정 값은 그대로, 글자만 바뀐다


def page_text(delete_enabled: bool = True) -> str:
    if not delete_enabled:
        return "차단했거나 숨긴 계정만 나옵니다. 이번 릴리스에서는 삭제가 꺼져 있고 차단만 됩니다. 승인 상태인 계정은 [차단]으로 로그인을 막습니다."
    return "차단했거나 숨긴 계정만 나옵니다. 이력이 없는 계정만 지울 수 있고, 승인 상태인 계정은 먼저 차단해야 합니다."


def state_text(row: dict) -> str:
    word = STATUS_WORDS.get(row.get("status"), str(row.get("status")))
    return f"{word} · 숨김" if row.get("hidden") else word


def history_text(row: dict) -> str:
    parts = [f"{r['kind']} {r['count']}" if r.get("count") else str(r.get("kind")) for r in row.get("reasons") or []]
    return " · ".join(parts) or "없음"


def verdict_text(row: dict, delete_enabled: bool = True) -> str:
    if row.get("verdict") == "deletable" and not delete_enabled:
        return "삭제 꺼짐"
    return VERDICT_WORDS.get(row.get("verdict"), "삭제 불가")


def table_values(row: dict, delete_enabled: bool = True) -> tuple[str, str, str, str, str]:
    return (row.get("name") or row["email"], row["email"], state_text(row), history_text(row), verdict_text(row, delete_enabled))


def selection_text(row: dict, delete_enabled: bool = True) -> str:
    who = row.get("name") or row["email"]
    if row.get("verdict") == "block_first":
        if not delete_enabled:
            return f"{who}: 승인 상태라 [차단]으로 로그인을 막습니다. {DELETE_OFF}."
        return f"{who}: 승인 상태라 바로 지우지 않습니다. [차단]으로 로그인을 막은 뒤 지울 수 있습니다."
    if row.get("verdict") != "deletable":
        return f"{who}: {history_text(row)} — 지우지 않습니다. 숨겨 두면 목록에서 가려집니다."
    if not delete_enabled:
        return f"{who}: 이력 없음 — {DELETE_OFF}. 숨겨 두면 목록에서 가려집니다."
    memberships = int(row.get("project_memberships") or 0)
    return f"{who}: 이력 없음" + (f" · 지우면 프로젝트 소속 {memberships}곳에서 빠집니다." if memberships else "")


def delete_confirm_text(row: dict, backup_text: str) -> str:
    memberships = int(row.get("project_memberships") or 0)
    gone = "로그인 계정, 이름 표" + (f", 프로젝트 소속 {memberships}곳" if memberships else "")
    return (f"{row.get('name') or row['email']} ({row['email']})\n\n"
            f"지워지는 것: {gone}\n이력: {history_text(row)}\n{backup_text}\n\n"
            "되돌릴 수 없습니다. 같은 이메일은 다시 가입할 수 있고, 그때는 승인 대기로 들어갑니다.")


def block_confirm_text(row: dict) -> str:
    return (f"{row.get('name') or row['email']} ({row['email']})\n\n"
            "로그인을 막습니다. 지금 켜 둔 앱과 에이전트는 다음 요청부터 끊깁니다.")
