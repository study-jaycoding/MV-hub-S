"""요청 의존성 — 인증/권한 헬퍼 (로드맵 §4-6 2겹 차단의 '서버 검증' 층).

미들웨어(main.py)가 토큰을 검증해 request.state.account 를 채운다. 여기 헬퍼는
라우터에서 '관리자만' 같은 추가 권한을 강제한다. AUTH_ENABLED=off 면 모두 통과(개발).
"""

from __future__ import annotations

from typing import Any, Iterable, Optional

from fastapi import HTTPException, Request

from . import rbac
from .config import AUTH_ENABLED, DEFAULT_WORKER_ID
from .emailnorm import norm_email


# 세션 쿠키 이름 — img 태그·WebSocket 처럼 헤더를 못 붙이는 요청용(브라우저 자동 첨부).
SESSION_COOKIE = "ch_session"


def account_actor_uid(request: Request) -> Optional[str]:
    """로그인 계정의 권한/소유권용 uid.

    계정 모드(AUTH on)에서는 절대 DEFAULT_WORKER_ID('me')로 떨어지지 않는다. 실제 Higgsfield
    creator_uid가 아직 없으면 임시 uid(acct:<email>)를 쓰고, 나중에 실제 user_...가 확인되면
    identity.remap_creator_uid가 전 테이블을 리맵한다."""
    acc = current_account(request)
    if not acc:
        return None
    uid = (acc.get("creator_uid") or "").strip()
    if uid:
        return uid
    if AUTH_ENABLED:
        email = norm_email(acc.get("email"))
        if email:
            return f"acct:{email}"
        raise HTTPException(status_code=409, detail="계정 신원(creator_uid)을 확인할 수 없습니다")
    return None


def require_agent_account(request: Request) -> dict:
    """에이전트·텔레메트리·생성요청 공용 신원 폴백(단일 출처).

    인증 세션 계정이 있으면 그대로 사용. AUTH off '로컬 허브'(개인 PC)에선 미들웨어가 account 를
    안 채우므로 활성 계정 이메일과 제공자 uid로 폴백해 로그인 없이도 내 에이전트가
    롱폴·생성요청·텔레메트리를 받게 한다. 활성 계정이 없는 레거시 단독 모드만 `local`을 쓴다.
    AUTH on 에선 401. (ingest._agent_acc·gen_requests._require_account·
    manage._push_acc 3중복을 단일화 — 신원 규칙이 분산되면 한 곳 누락이 권한 버그가 된다.)"""
    return resolve_agent_account(getattr(request.state, "account", None))


def resolve_agent_account(session_account: Optional[dict]) -> dict:
    """require_agent_account 의 **DB 의존부**만 떼어낸 같은 규칙(단일 출처 유지).

    세션 계정은 미들웨어가 이미 request 에 채워 둔 값이라 요청 문맥에서 꺼내면 되지만,
    AUTH off 폴백의 repo.get_my_uid() 는 '지금 활성 계정 DB'를 읽는다. 계정 범위를 캡처한
    override 아래에서 신원을 계산해야 하는 호출부(ingest 의 history 라우트)가 세션 계정만
    미리 뽑아 오고 이 함수를 그 override 안에서 부른다."""
    if session_account:
        return session_account
    if not AUTH_ENABLED:
        from . import active_account, repo  # 지역 import(순환 회피)

        # 계정별 DB가 도입된 뒤에도 고정값 `local`을 반환하면 생성 usecase가
        # data/db/acct/local-.../content_hub.db를 열어 즉시 500이 난다. 현재 override 또는
        # active.json의 실제 이메일을 큐 신원으로 넘겨 DB 경로와 요청 소유 계정을 일치시킨다.
        email = norm_email(active_account.active_email()) or "local"
        return {"email": email, "creator_uid": repo.get_my_uid()}
    raise HTTPException(status_code=401, detail="로그인이 필요합니다")


def actor_id(request: Request) -> str:
    """현재 요청 행위자의 안정 신원.

    AUTH on: creator_uid 또는 acct:<email>. AUTH off: 단독/레거시 호환용 DEFAULT_WORKER_ID('me').
    name/표시이름은 절대 권한 판단에 쓰지 않는다."""
    return account_actor_uid(request) or DEFAULT_WORKER_ID


def bearer_token(request: Request) -> Optional[str]:
    h = request.headers.get("authorization") or ""
    if h.lower().startswith("bearer "):
        return h[7:].strip() or None
    return None


def session_token(request: Request) -> Optional[str]:
    """요청의 세션 토큰 — Authorization 헤더(우선) 또는 세션 쿠키.
    /media·/ws 는 헤더를 못 붙이므로 쿠키로 인증한다."""
    return bearer_token(request) or request.cookies.get(SESSION_COOKIE)


def current_account(request: Request) -> Optional[dict[str, Any]]:
    return getattr(request.state, "account", None)


def account_scope_uid(request: Request) -> Optional[str]:
    """'내 작업/내 facet/내 생성자' 쿼리를 스코프할 creator_uid. None = 단독 모드(AUTH off, 전체 가시).
    ⚠️ AUTH on 인데 creator_uid 미링크면 불가능 값('\\x00')으로 스코프한다 — None 폴백 시 필터가 풀려
    남의 생성자·컬러·태그·생성물이 전부 노출되는 구멍을 막는다(미링크 계정은 첫 ingest 때 링크됨).
    ★'쿼리 스코프' 전용 — 조건/권한/actor 신원에는 plain creator_uid(None 폴백)를 쓸 것(\\x00 은
    actor 로 쓰면 본인 것에도 안 맞아 깨진다)."""
    acc = current_account(request)
    if not acc:
        return None
    uid = acc.get("creator_uid")
    if AUTH_ENABLED and not uid:
        email = norm_email(acc.get("email"))
        return f"acct:{email}" if email else "\x00"
    return uid


def realtime_scope(acc: Optional[dict[str, Any]]) -> Optional[str]:
    """실시간 WS 채널 스코프 키 — '누가 이 progress/synced 를 받을지'를 로그인 계정(email)으로 정한다.

    ★creator_uid 가 아니라 email 을 쓰는 이유: acct:→user_ 리맵(신원 정합) 중에도 스코프가 안 바뀌어
    열린 WS 가 계속 자기 알림을 받는다(creator_uid 로 스코프하면 리맵 순간 옛 소켓이 미수신).
    또 creator_uid 가 NULL 인 계정끼리 같은 None 버킷을 공유해 progress·result_url 이 섞이던 것도 닫는다.

    AUTH off(단독/로컬 모드) 또는 미로그인 → None(스코프 없음 = 그 모드의 전체). 계정 격리가 없는 모드라 맞다.
    ws.broadcast(None) 은 a==None 소켓(=AUTH off 소켓 전부)에만 가므로 단독 모드의 모든 탭이 받는다."""
    if not AUTH_ENABLED or not acc:
        return None
    email = norm_email(acc.get("email"))
    return f"acct:{email}" if email else None


def account_global_roles(request: Request) -> list[str]:
    """현재 계정이 보유한 전역 역할들(복수). 미들웨어가 채운 account 의 CSV 를 파싱."""
    acc = current_account(request)
    if not acc:
        return []
    return rbac.parse_roles(acc.get("global_role"))


# ── v02 RBAC 권한 게이트 (로드맵 §1-5/§1-6) ────────────────────────────────
# 모든 게이트는 AUTH_ENABLED off 면 통과(차단 비활성, '식별 먼저 차단 나중'). 켜지면 서버가 강제.
# 전역 역할은 복수 보유 가능 → 보유 역할들의 합집합으로 판정.
def require_global(request: Request, *roles: str) -> None:
    """전역 역할 게이트 — 보유 역할 중 roles 와 겹치면 통과. 예: require_global(request, rbac.ADMIN)."""
    if not AUTH_ENABLED:
        return
    if not rbac.has_any_global_role(account_global_roles(request), *roles):
        raise HTTPException(status_code=403, detail="권한이 없습니다")


def require_global_cap(request: Request, cap: str) -> None:
    """전역 역량 게이트 — 보유 역할들의 역량 합집합 기준. 예: cap='approve_signup'."""
    if not AUTH_ENABLED:
        return
    if not rbac.has_global_cap(account_global_roles(request), cap):
        raise HTTPException(status_code=403, detail="권한이 없습니다")


def project_roles_of(request: Request, project_id: str) -> str:
    """현재 계정이 그 프로젝트에서 가진 역할들(CSV, 복수 가능; 멤버 아님→''). creator_uid 로 조회."""
    uid = account_actor_uid(request)
    if not uid:
        return ""
    from .db import get_connection

    with get_connection() as conn:
        row = conn.execute(
            "SELECT project_role FROM project_member WHERE project_id=? AND creator_uid=?",
            (project_id, uid),
        ).fetchone()
    return (row["project_role"] if row else None) or ""


def require_project_role(
    request: Request, project_id: str, *roles: str, read_only: bool = False
) -> None:
    """프로젝트 역할 게이트(§5-3): 그 프로젝트의 보유 역할(복수)이 roles 와 겹치면 통과.

    read_only=True(순수 읽기 호출)일 때만 전역 read_all(admin·PM·PD)도 합집합으로 통과한다.
    검수·최종(finalize)·멤버관리 같은 '쓰기'는 read_only=False(기본) → 프로젝트 역할로만 부여된다.
    (예전엔 요청 roles 가 read 역량을 포함하면 read_all 이 통과해, SUPERVISOR/PM 도 read 를 갖는 탓에
     read_all 사용자가 프로젝트 미배정인데도 finalize 같은 쓰기를 할 수 있었다 — 그 구멍을 막는다.)"""
    if not AUTH_ENABLED:
        return
    if rbac.has_any_project_role(project_roles_of(request, project_id), *roles):
        return
    if read_only and rbac.has_global_cap(account_global_roles(request), "read_all"):
        return
    raise HTTPException(status_code=403, detail="프로젝트 권한이 없습니다")


def require_admin(request: Request) -> None:
    """관리자만(전역 역할에 admin 보유). AUTH off 면 통과(차단 비활성)."""
    if not AUTH_ENABLED:
        return
    if not rbac.has_any_global_role(account_global_roles(request), rbac.ADMIN):
        raise HTTPException(status_code=403, detail="관리자 권한이 필요합니다")


def super_admin_workspace_claims(request: Request) -> Optional[dict[str, Any]]:
    """현재 요청의 10분 슈퍼 관리자 workspace 권한을 검증한다.

    일반 로그인 계정과 별도 헤더 토큰의 계정·uid가 모두 같아야 하며, 발급 뒤 관리자 역할이
    제거된 경우도 즉시 무효가 된다. 서명만 보지 않고 서버 세션 행의 만료·수동 해제도 확인한다.
    """
    account = current_account(request)
    if not account or not rbac.has_any_global_role(account_global_roles(request), rbac.ADMIN):
        return None
    from . import repo  # 지역 import(순환 회피)
    from .services import auth

    token = (request.headers.get(auth.SUPER_ADMIN_HEADER) or "").strip()
    claims = auth.verify_super_admin_token(token)
    if not isinstance(claims, dict):
        return None
    email = norm_email(account.get("email"))
    subject_uid = account_actor_uid(request)
    if (
        not email
        or not subject_uid
        or norm_email(claims.get("e")) != email
        or str(claims.get("sub") or "") != subject_uid
    ):
        return None
    active = repo.active_super_admin_session(
        jti=str(claims["j"]),
        subject_email=email,
        subject_uid=subject_uid,
        token=token,
        scope=auth.SUPER_ADMIN_SCOPE,
    )
    if not active:
        return None
    return {**claims, "expires_at": int(active["expires_at"])}


def require_super_admin_workspace(request: Request) -> dict[str, Any]:
    claims = super_admin_workspace_claims(request)
    if claims:
        return claims
    raise HTTPException(
        status_code=403,
        detail="슈퍼 관리자 권한이 없거나 만료되었습니다. 현재 비밀번호로 다시 인증하세요.",
    )


# ── 생성물 단위 가시성/편집 가드 (원칙: 내 정보 DB 는 나만, 내가 공유해야 남이 열람) ──────
def can_view_generation(request: Request, gen: dict[str, Any]) -> bool:
    """열람 권한 — 비공개는 본인만, 전역 read_all(admin·PM·PD)은 전체, 공유물은 **list(team 탭)와
    동일 경계**(내가 멤버인 프로젝트의 공유물만; 미분류·비멤버 프로젝트 제외).

    ★⑥: 예전엔 shared 면 누구나 통과라, 목록엔 멤버십으로 가려진 공유물을 id 만 알면 단건/코멘트/
    import 로 열람하던 우회가 있었다. 단건 가시성을 list 와 일치시켜 그 간극을 닫는다."""
    return can_view_generation_with_member_projects(request, gen)


def can_view_generation_with_member_projects(
    request: Request, gen: dict[str, Any], member_project_ids: Optional[set[str]] = None
) -> bool:
    """can_view_generation의 배치 조회용 변형.

    ``member_project_ids``가 주어지면 해당 요청에서 이미 계산한 프로젝트 멤버십을 재사용한다.
    None이면 단건 경로와 같이 직접 조회하므로 기존 호출의 동작은 변하지 않는다.
    """
    if not AUTH_ENABLED:
        return True
    uid = account_actor_uid(request)
    if uid and gen.get("creator_uid") == uid:
        return True  # 내 것
    if rbac.has_global_cap(account_global_roles(request), "read_all"):
        return True  # admin·PM·PD 전체
    if gen.get("shared"):
        pid = gen.get("project_id")
        if pid and uid:
            if member_project_ids is not None:
                return pid in member_project_ids
            from . import repo  # 지역 import(순환 회피)

            return pid in set(repo.my_member_projects(uid))
        return False  # 미분류(프로젝트 없음) 공유물은 비멤버에게 안 보임(list 와 동일)
    return False


def batch_view_member_projects(
    request: Request, gens: Iterable[dict[str, Any]]
) -> Optional[set[str]]:
    """배치 가시성 판정용 멤버십 집합 — 필요한 경우에만 1회 조회하는 규칙의 단일 출처.

    로그인 사용자이고 read_all 이 아니며 남의 공유물이 하나라도 있으면
    my_member_projects 를 한 번 읽어 집합으로 반환한다. 그 외에는 None —
    can_view_generation_with_member_projects 가 기존 단건 규칙대로 동작하므로
    판정 결과는 단건 경로와 항상 같다. 여러 생성물을 다루는 라우터가 항목마다
    멤버십을 재조회(N+1)하지 않기 위한 공용 계층이다.
    """
    if not AUTH_ENABLED:
        return None
    uid = account_actor_uid(request)
    if not uid:
        return None
    if rbac.has_global_cap(account_global_roles(request), "read_all"):
        return None
    if not any(gen.get("shared") and gen.get("creator_uid") != uid for gen in gens):
        return None
    from . import repo  # 지역 import(순환 회피)

    return set(repo.my_member_projects(uid))


def require_view_generation(request: Request, gen: dict[str, Any]) -> None:
    """열람 가드 — 권한 없으면 404(존재 자체를 숨김)."""
    if not can_view_generation(request, gen):
        raise HTTPException(status_code=404, detail="generation 없음")


def require_edit_generation(request: Request, gen: dict[str, Any]) -> None:
    """수정/삭제 가드 — 본인 또는 admin(system)만. 공유물이라도 남이 수정 불가."""
    if not AUTH_ENABLED:
        return
    uid = account_actor_uid(request)
    if uid and gen.get("creator_uid") == uid:
        return
    if rbac.has_global_cap(account_global_roles(request), "system"):
        return
    raise HTTPException(status_code=403, detail="수정 권한이 없습니다")
