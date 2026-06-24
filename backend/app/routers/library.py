"""라이브러리 조회 라우터 (Phase 2) — 로컬 탐색·필터.

CLAUDE.md 원칙 1: 내 작업물 탐색은 네트워크를 절대 타지 않는다(전부 로컬 DB).
"""

from __future__ import annotations

import ipaddress
import socket
import urllib.parse
import urllib.request
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from . import _proxy
from .. import rbac, repo
from ..config import AUTH_ENABLED
from ..deps import account_global_roles, account_scope_uid, require_view_generation
from ..models import FacetsOut, GenerationOut
from ..services import thumbs

router = APIRouter(prefix="/api", tags=["library"])


def _reject_internal_host(url: str) -> None:
    """SSRF 방어 — 호스트를 **실제 IP 로 해석**해 사설/루프백/링크로컬/예약 대역이면 거부한다.
    문자열 prefix 검사만으론 10진수 IP(2130706433=127.0.0.1)·IPv6·단축형을 못 막으므로 ipaddress 로
    판정한다(클라우드 메타데이터 169.254.169.254·내부망 차단). DNS 리바인딩은 잔여 위험(연결 시점
    재해석) — 내부 도구 수준에서 수용."""
    host = (urllib.parse.urlparse(url).hostname or "").strip().lower()
    if not host:
        raise HTTPException(status_code=400, detail="URL 호스트가 없습니다")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        raise HTTPException(status_code=400, detail="호스트를 해석할 수 없습니다")
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        # IPv4-mapped IPv6(::ffff:127.0.0.1) 도 펼쳐 검사
        if ip.version == 6 and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise HTTPException(status_code=400, detail="내부/사설 호스트 미디어는 받을 수 없습니다")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """리다이렉트 차단 — urlopen 이 3xx 를 따라가 검증 통과 후 내부망으로 우회(SSRF)하는 것을 막는다.
    공개 미디어 CDN(cloudfront 등)은 직접 200 을 주므로 리다이렉트가 필요 없다."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        raise HTTPException(status_code=502, detail="리다이렉트 미디어는 받을 수 없습니다")


@router.get("/download")
def download_media(url: str = Query(...), name: str = Query("download")):
    """원격 미디어(cloudfront 등)를 서버가 받아 attachment 로 스트리밍한다.

    원격 URL 은 브라우저의 a[download] 가 무시돼 '다운로드' 대신 새 탭으로 열린다. 같은 오리진
    프록시(이 엔드포인트)로 받으면 Content-Disposition: attachment 로 '진짜 다운로드'(크롬 다운로드
    목록)가 된다. http(s) 만 허용 + 내부 호스트 차단(기본 SSRF 방어). 로컬 보관본(/media·/api)은
    프론트가 직접 a[download] 로 받으므로 여기로 오지 않는다."""
    low = url.strip().lower()
    if not (low.startswith("http://") or low.startswith("https://")):
        raise HTTPException(status_code=400, detail="http(s) URL 만 받을 수 있습니다")
    _reject_internal_host(url)
    try:
        # User-Agent 부여 — 일부 CDN 이 UA 없는 요청을 403 으로 막는다(브라우저 흉내).
        # 리다이렉트 차단 opener — 3xx 우회(SSRF) 방지.
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (MV-hub media proxy)"})
        opener = urllib.request.build_opener(_NoRedirect)
        upstream = opener.open(req, timeout=60)  # noqa: S310 — http(s)+IP 검증 완료
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"원격 미디어 다운로드 실패: {e}")
    ctype = upstream.headers.get_content_type() or "application/octet-stream"
    # 파일명 위생 — 헤더 인젝션·경로문자 제거.
    safe = (name or "download").replace('"', "").replace("\n", "").replace("\r", "")[:120] or "download"

    def _stream():
        try:
            while True:
                chunk = upstream.read(65536)
                if not chunk:
                    break
                yield chunk
        finally:
            upstream.close()

    return StreamingResponse(
        _stream(),
        media_type=ctype,
        headers={"Content-Disposition": f'attachment; filename="{safe}"'},
    )


@router.get("/media-thumb")
def media_thumb(src: str = Query(...), w: int = Query(512, ge=64, le=1024)):
    """생성 미디어(/media/<2>/<sha>.ext) 썸네일 — 리사이즈+디스크 캐시(공용 thumbs 헬퍼).
    그리드가 풀해상도 원본(수 MP) 대신 작은 이미지를 디코딩하게 해 렉을 없앤다.
    src 는 /media/ 로 시작하는 로컬 경로만(원격 URL·경로 이탈은 거부 → 호출부가 원본으로 폴백)."""
    target = thumbs._media_target(src)
    if not target:
        raise HTTPException(status_code=400, detail="로컬 /media 경로만 지원")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="파일 없음")
    cache = thumbs.ensure_thumb(target, w)
    if not cache:
        raise HTTPException(status_code=415, detail="썸네일 생성 불가(이미지 아님 등)")
    return FileResponse(
        cache, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=2592000"}
    )


@router.get("/generations", response_model=list[GenerationOut])
def list_generations(
    request: Request,
    tab: str = Query("my", pattern="^(my|team)$"),
    worker_id: Optional[str] = None,
    color: Optional[str] = None,
    tag: Optional[str] = None,
    share_dir: Optional[str] = Query(None, pattern="^(mine|received)$"),
    local_only: bool = False,
    creator_uid: Optional[str] = None,
    project_id: Optional[str] = None,
    search: Optional[str] = None,
    include_deleted: bool = False,
    deleted_only: bool = False,
    # 서버사이드 인스턴트 필터(무한 스크롤이 서버에서 거름)
    media_type: Optional[str] = Query(None, pattern="^(image|video|audio)$"),
    colors: list[str] = Query(default=[]),
    tags: list[str] = Query(default=[]),
    auto_tags: list[str] = Query(default=[]),
    shared_only: bool = False,
    comment_only: bool = False,
    final_only: bool = False,
    limit: int = Query(500, ge=1, le=2000),
    # 키셋 커서(직전 페이지 마지막 행) — 무한 스크롤이 다음 묶음을 받을 때 전달. OFFSET 대체.
    cursor_ts: Optional[float] = None,
    cursor_id: Optional[str] = None,
):
    # 로컬 우선: 내 작업(tab=my)은 이 허브 로컬 DB가 정답 → 즉시·서버무관. 팀 공유(tab=team)만
    # 서버 DB로 위임(모두의 발행물이 거기 있음).
    if tab == "team" and _proxy.proxying():
        return _proxy.proxy_get("/api/generations", request)
    # 로그인 계정이면 그 계정의 생성자 uid 로 '내 작업'을 한정(계정별 분리). 비로그인은 전체.
    account_uid = _account_uid(request)
    # Team 탭: 내가 멤버인 프로젝트의 공유물만(read_all=admin/PM/PD 와 단독 모드는 전체).
    team_member_projects = None
    if tab == "team":
        read_all = (not AUTH_ENABLED) or rbac.has_global_cap(
            account_global_roles(request), "read_all"
        )
        if not read_all:
            team_member_projects = repo.my_member_projects(account_uid or "\x00")
    result = repo.list_generations(
        tab=tab,
        team_member_projects=team_member_projects,
        worker_id=worker_id,
        color=color,
        tag=tag,
        share_dir=share_dir,
        local_only=local_only,
        creator_uid=creator_uid,
        account_uid=account_uid,
        project_id=project_id,
        search=search,
        include_deleted=include_deleted,
        deleted_only=deleted_only,
        media_type=media_type,
        colors=colors or None,
        tags=tags or None,
        auto_tags=auto_tags or None,
        shared_only=shared_only,
        comment_only=comment_only,
        final_only=final_only,
        limit=limit,
        cursor_ts=cursor_ts,
        cursor_id=cursor_id,
    )
    # 발행본(서버 공유) 카드의 코멘트 뱃지는 로컬 카운트가 아니라 '서버 스레드' 기준으로 보강한다
    # (팀원이 단 새 코멘트가 카드 C 뱃지에 바로 반영되도록). 공유 표식이 있는 카드만 1회 배치 조회.
    if _proxy.proxying():
        # 서버는 공유본을 번들 앵커(job_id)로 안다 → 로컬 id ↔ server id 변환:
        # 요청은 server id 로 보내고 응답(서버 id 키)을 로컬 id 로 되매핑한다. (로컬 id 로 그대로
        # 위임하면 서버가 못 찾아 공유본 C 뱃지가 항상 0 으로 떴다 — 엔드포인트와 동일한 수정.)
        srv_of = {g["id"]: repo.finalize_id_map(g["id"])[1] for g in result if g.get("shared")}
        if srv_of:
            try:
                counts = _proxy.proxy_json(
                    "POST", "/api/generations/comment-counts",
                    body={"gen_ids": list(srv_of.values())},
                    timeout=5,  # 비핵심 보강 — 서버가 느리거나 다운이면 목록을 60초씩 막지 말고 빨리 포기(로컬값 유지)
                )
                if isinstance(counts, dict):
                    for g in result:
                        sid = srv_of.get(g["id"])
                        c = counts.get(sid) if sid else None
                        if isinstance(c, dict):
                            g["comment_count"] = c.get("comment_count", g.get("comment_count"))
                            g["has_unread"] = c.get("has_unread", g.get("has_unread"))
            except Exception:  # noqa: BLE001 — 보강 실패는 로컬 값 유지(치명적 아님)
                pass
    return result


@router.get("/generations-stats")
def generation_stats(request: Request):
    """전역 파생값(실패 수·미확인 코멘트 여부) — 무한 스크롤 모드에서 클라이언트 전량 로드 대체.
    미확인 여부는 로그인 계정(creator_uid) 기준 — 패널 seen 기록과 동일 신원이어야 알림이 꺼진다."""
    uid = _account_uid(request)
    return repo.generation_stats(viewer_id=uid) if uid else repo.generation_stats()


# ── 휴지통(별도 DB) — 지운 것 검색·복원·영구삭제 ───────────────────────────
def _account_uid(request: Request) -> Optional[str]:
    """deps.account_scope_uid 위임 — '내 작업/내 facet' 쿼리 스코프(미링크 AUTH-on 은 '\\x00')."""
    return account_scope_uid(request)


@router.get("/trash", response_model=list[GenerationOut])
def list_trash(
    request: Request,
    search: Optional[str] = None,
    limit: int = Query(200, ge=1, le=2000),
    offset: int = Query(0, ge=0),
):
    """휴지통 항목 목록(최근 삭제순). 내 휴지통만(다른 사람 삭제물 열람 방지)."""
    return repo.list_trash(
        search=search, limit=limit, offset=offset, account_uid=_account_uid(request)
    )


@router.delete("/trash/{gen_id}")
def purge_trashed_item(gen_id: str, request: Request):
    """휴지통에서 영구 삭제(복원 불가) — 본인 것만."""
    return {"purged": repo.purge_trashed_item(gen_id, account_uid=_account_uid(request))}


@router.get("/generations/{gen_id}", response_model=GenerationOut)
def get_generation(gen_id: str, request: Request):
    account_uid = _account_uid(request)
    gen = repo.get_generation(gen_id, account_uid=account_uid)
    if not gen:
        # 로컬에 없으면 팀(서버) 항목일 수 있음 → 서버로 폴백 조회(로컬우선 + 팀 폴백).
        if _proxy.proxying():
            return _proxy.proxy_get(f"/api/generations/{gen_id}", request)
        raise HTTPException(status_code=404, detail="generation 없음")
    # 비공개는 본인만, 공유된 것만 남이 열람(원칙). 권한 없으면 404(존재 자체를 숨김).
    require_view_generation(request, gen)
    return gen


@router.get("/facets", response_model=FacetsOut)
def facets(request: Request, tab: str = Query("my", pattern="^(my|team)$")):
    # 컬러/태그/자동태그 facet — my=내 로컬 생성물 기준, team=서버(팀 공유물) 기준.
    if tab == "team" and _proxy.proxying():
        return _proxy.proxy_get("/api/facets", request)
    return repo.get_facets(account_uid=_account_uid(request))


# ── 자동 태그(별도 네임스페이스) — 필터 사이드바에서만 관리 ────────────────
class AutoTagIn(BaseModel):
    name: str


def _tag_owner(request: Request) -> Optional[str]:
    """전역 태그(auto_tag) 소유자 = 로그인 계정 creator_uid. 단독(AUTH off)이면 제공자 my_uid 로
    폴백 → 레거시 태그가 그 소유로 이관됐으므로 단독 사용자도 자기 태그를 그대로 본다."""
    uid = _account_uid(request)
    return uid if uid is not None else repo.get_my_uid()


@router.get("/auto-tags")
def list_auto_tags(request: Request):
    return {"auto_tags": repo.list_auto_tags(_tag_owner(request))}


@router.post("/auto-tags")
def create_auto_tag(body: AutoTagIn, request: Request):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="빈 이름")
    created = repo.create_auto_tag(name, _tag_owner(request))
    if not created:
        raise HTTPException(status_code=409, detail=f"이미 있는 전역 태그: {name}")
    return {"ok": True, "name": name}


@router.delete("/auto-tags/{name}")
def delete_auto_tag(name: str, request: Request):
    return {"removed": repo.delete_auto_tag(name, _tag_owner(request))}
