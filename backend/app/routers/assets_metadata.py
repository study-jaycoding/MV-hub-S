"""Assets 개인 메타데이터와 팀 코멘트 HTTP API.

파일 탐색·업로드와 달리 메타데이터는 계정 DB, 코멘트는 공유 서버 DB가 정답이다.
이 라우터는 그 데이터 소유권 경계를 유지하고 디스크 파일 처리에는 관여하지 않는다.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any, Iterator, Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from . import _assets_access, _proxy
from .. import active_account, repo
from ..deps import EXPECT_ACCOUNT_HEADER, actor_id, current_account, expected_account_differs
from ..emailnorm import norm_email
from ..repo import asset_comment_drawings
from ..services import comment_strokes
from ..services.asset_paths import (
    COMBINED_INTERNAL_PROJECT,
    INTERNAL_FOLDERS,
    real_meta_key,
)
from ..services.media_types import asset_media_type


router = APIRouter()


class AssetTagsIn(BaseModel):
    project: str
    path: str
    tags: list[str] = Field(default_factory=list)


class AssetTagsBatchItem(BaseModel):
    path: str
    tags: list[str] = Field(default_factory=list)


class AssetTagsBatchIn(BaseModel):
    project: str
    items: list[AssetTagsBatchItem] = Field(default_factory=list)


class AssetTagOpsItem(BaseModel):
    path: str
    add: list[str] = Field(default_factory=list)
    remove: list[str] = Field(default_factory=list)


class AssetTagOpsIn(BaseModel):
    project: str
    items: list[AssetTagOpsItem] = Field(default_factory=list)


class AssetCommentIn(BaseModel):
    project: str
    path: str
    comment: Optional[str] = None


class AssetColorIn(BaseModel):
    project: str
    path: str
    color: Optional[str] = None


class AssetColorsBatchIn(BaseModel):
    project: str
    paths: list[str] = Field(default_factory=list)
    color: Optional[str] = None


@router.get("/meta")
def asset_meta(request: Request, project: str = Query(...)):
    """개인 메타에 공유 서버의 코멘트 개수·읽음 상태만 합성한다."""
    if _assets_access.AUTH_ENABLED:
        _assets_access.require_asset_comment_access(project, request, write=False)
    actor = actor_id(request)
    sources = (
        [(folder, folder + "/") for folder in INTERNAL_FOLDERS]
        if project == COMBINED_INTERNAL_PROJECT
        else [(project, "")]
    )
    local: dict[str, Any] = {}
    for real_project, prefix in sources:
        for path, meta in repo.get_asset_meta(real_project, actor).items():
            local[prefix + path] = meta
    if _proxy.proxying():
        for real_project, prefix in sources:
            try:
                remote = _proxy.proxy_json(
                    "GET",
                    "/api/assets/meta",
                    params={"project": real_project},
                    timeout=5,
                )
            except Exception:  # noqa: BLE001 - 코멘트 뱃지는 부가정보다.
                remote = None
            if not isinstance(remote, dict):
                continue
            # 서버는 내 비공개 코멘트를 모른다 — 뱃지 수에 로컬 비공개를 합산(스레드 목록과 일치).
            private_counts = repo.private_asset_comment_counts(real_project, actor)
            for path in set(remote) | set(private_counts):
                remote_meta = remote.get(path)
                if remote_meta is not None and not isinstance(remote_meta, dict):
                    continue
                key = prefix + path
                slot = local.get(key)
                if slot is None:
                    slot = {
                        "is_source": False,
                        "source_name": None,
                        "tags": [],
                        "comment": None,
                        "color": None,
                        "comment_count": 0,
                        "has_unread": False,
                    }
                    local[key] = slot
                slot["comment_count"] = (remote_meta or {}).get(
                    "comment_count", 0
                ) + private_counts.get(path, 0)
                slot["has_unread"] = (remote_meta or {}).get("has_unread", False)
    return local


class CommentAddIn(BaseModel):
    project: str
    path: str
    text: str
    author: Optional[str] = None
    parent_id: Optional[str] = None
    muted: bool = False  # [구] '내 알림 끄기' — private 로 대체, 구클라 호환용으로만 받는다
    private: bool = False  # 비공개 — 내 로컬 DB 에만 저장, 서버로 절대 안 보냄


class CommentEditIn(BaseModel):
    text: str
    worker_id: Optional[str] = None


class CommentReadIn(BaseModel):
    project: str
    path: str
    worker_id: Optional[str] = None


@router.get("/comments")
def list_comments(
    request: Request,
    project: str = Query(...),
    path: str = Query(...),
):
    project, path = real_meta_key(project, path)
    # 그림 메타(획 본문 없음)를 붙인다 — 서버는 공유분에, 허브는 로컬 비공개분에. 계정 DB·서버 연결은 한 번 잡는다(어셋 그림 §3.2).
    with active_account.pinned_account_scope():
        if _proxy.proxying():
            # 공유 스레드(서버) + 내 비공개(로컬)를 시간순으로 합친다 — 비공개는 서버에 없다.
            with _proxy.pinned_connection((_proxy.base_url(), _proxy.token())):
                shared = _proxy.proxy_json(
                    "GET",
                    "/api/assets/comments",
                    params={"project": project, "path": path},
                )
            mine = asset_comment_drawings.attach_meta(
                repo.list_private_asset_comments(project, path, actor_id(request))
            )
            merged = ([*shared, *mine] if isinstance(shared, list) else mine)
            merged.sort(key=lambda c: (str(c.get("created_at") or ""), str(c.get("id") or "")))
            return merged
        _assets_access.require_asset_comment_access(project, request, write=False)
        return asset_comment_drawings.attach_meta(repo.list_asset_comments(project, path, actor_id(request)))


@router.post("/comments")
def add_comment(body: CommentAddIn, request: Request):
    project, path = real_meta_key(body.project, body.path)
    # ★비공개는 프록시를 타지 않는다 — 내 로컬 DB 에만 남아야 팀에 안 보인다.
    if _proxy.proxying() and not body.private:
        return _proxy.proxy_json(
            "POST",
            "/api/assets/comments",
            body={**body.model_dump(), "project": project, "path": path},
        )
    if body.private and _proxy.is_shared_team_server():
        # 공유 팀 서버 본체엔 비공개를 저장하지 않는다(중앙 DB 유출 차단 — 적대 리뷰 P1).
        raise HTTPException(
            status_code=400, detail="비공개 코멘트는 로컬 허브에서만 저장할 수 있습니다"
        )
    if not body.private:
        _assets_access.require_asset_comment_access(project, request, write=True)
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="빈 코멘트")
    try:
        comment_id = repo.add_asset_comment(
            project,
            path,
            actor_id(request),
            text,
            body.parent_id,
            body.muted,
            body.private,
            # 프록시 모드의 비공개 답글은 부모가 '서버 공개 코멘트'라 로컬에 없는 게
            # 정상(코덱스 재확인 회귀) — 그 경로만 외부 부모 허용.
            allow_external_parent=bool(body.private and _proxy.proxying()),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"id": comment_id}


@router.put("/comments/{comment_id}")
def edit_comment(comment_id: str, body: CommentEditIn, request: Request):
    # 비공개 코멘트는 로컬에만 있다 — 서버로 보내면 404 만 받고 수정이 안 된다.
    if _proxy.proxying() and repo.asset_comment_is_private(comment_id) is not True:
        return _proxy.proxy_json(
            "PUT",
            f"/api/assets/comments/{comment_id}",
            body=body.model_dump(),
        )
    scope = repo.get_asset_comment_scope(comment_id)
    if not scope:
        raise HTTPException(status_code=404, detail="코멘트 없음")
    if not _proxy.proxying():
        _assets_access.require_asset_comment_access(scope["project"], request, write=True)
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="빈 코멘트")
    try:
        repo.edit_asset_comment(comment_id, actor_id(request), text)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}


@router.delete("/comments/{comment_id}")
def delete_comment(comment_id: str, request: Request):
    # 로컬 비공개 답글이 달린 부모는 지우지 못한다(검증 P2 — generation 쪽과 동일 가드).
    if repo.asset_comment_has_private_children(comment_id):
        raise HTTPException(
            status_code=409,
            detail="비공개 답글이 달려 있어 삭제할 수 없습니다 — 비공개 답글을 먼저 지우세요",
        )
    # 비공개 코멘트는 로컬에만 있다(edit 와 같은 분기).
    if _proxy.proxying() and repo.asset_comment_is_private(comment_id) is not True:
        return _proxy.proxy_json("DELETE", f"/api/assets/comments/{comment_id}")
    scope = repo.get_asset_comment_scope(comment_id)
    if not scope:
        raise HTTPException(status_code=404, detail="코멘트 없음")
    if not _proxy.proxying():
        _assets_access.require_asset_comment_access(scope["project"], request, write=True)
    try:
        repo.delete_asset_comment(comment_id, actor_id(request))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return {"ok": True}


@router.post("/comments/read")
def read_comments(body: CommentReadIn, request: Request):
    project, path = real_meta_key(body.project, body.path)
    if _proxy.proxying():
        return _proxy.proxy_json(
            "POST",
            "/api/assets/comments/read",
            body={**body.model_dump(), "project": project, "path": path},
        )
    _assets_access.require_asset_comment_access(project, request, write=False)
    repo.mark_asset_comments_read(actor_id(request), project, path)
    return {"ok": True}


# ── 그림 붙인 코멘트(comments-v2) — docs/status/어셋코멘트그림_설계_2026-11-05.md §3.2 ──
# 옛 글 전용 길(POST /comments)은 그대로 둔다. 이 길은 옛 서버에 없으므로 그림이 조용히 버려지지 않는다(경로 없음 → 409).
_NO_STORE = {"Cache-Control": "private, no-store"}
_STROKES_RELAY_MAX = 320 * 1024  # 획 256KiB + 포장 여유 — 넘으면 일부만 보이지 않고 502
_ACCOUNT_CHANGED = "화면과 허브의 계정·저장 위치가 달라 멈췄습니다 — 쓰던 글·그림은 그대로 있습니다. 새로 고쳐 주세요"


class AssetCommentV2In(BaseModel):
    id: str  # 클라가 정한 uuid — 같은 요청 재시도는 같은 결과
    project: str
    path: str
    text: str
    parent_id: Optional[str] = None  # 1단계 — 답글에는 그림 없음(null 이 아니면 400)
    private: bool = False
    drawings: Optional[list[dict[str, Any]]] = Field(default=None, max_length=comment_strokes.MAX_DRAWINGS)
    # 화면이 뜻한 저장 대상 — 받는 쪽이 장부를 보기 전에 대조한다(지문에는 넣지 않는다)
    expected_target: Optional[str] = None  # "local" | "server"
    expected_server_url: Optional[str] = None
    expected_server_account: Optional[str] = None


def _fail(status: int, code: str, message: str) -> HTTPException:
    """화면이 code 로 나눈다(lib/http.ts 가 message 있는 본문을 HttpError.info 에 보존)."""
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _route_missing(exc: HTTPException) -> bool:
    """서버에 경로 자체가 없음(옛 서버) — FastAPI 기본 404 본문. 업무상 404 와 구분한다."""
    return exc.status_code == 404 and exc.detail == "Not Found"


def _same_url(a: Optional[str], b: Optional[str]) -> bool:
    return (a or "").strip().rstrip("/").lower() == (b or "").strip().rstrip("/").lower()


def _create_here(body: AssetCommentV2In, project: str, path: str,
                 drawings: list[dict[str, Any]], request: Request) -> dict[str, Any]:
    """이 DB 에 쓴다 — 공유는 쓰기 권한(서버·서버 없는 허브), 비공개는 작성자 본인 행이라 따로 보지 않는다."""
    if not body.private:
        _assets_access.require_asset_comment_access(project, request, write=True)
    try:
        return asset_comment_drawings.create_comment_v2(
            project=project, path=path, author=actor_id(request), comment_id=body.id, text=body.text,
            is_private=body.private, drawings=drawings)
    except asset_comment_drawings.AssetCommentDeleted as exc:
        raise _fail(410, "deleted", "이미 지워진 코멘트입니다") from exc
    except comment_strokes.StructureError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except asset_comment_drawings.AssetCommentConflict as exc:
        raise _fail(409, "conflict", f"같은 코멘트 번호로 다른 내용이 이미 있습니다({exc})") from exc


def _on_team_server(body: AssetCommentV2In, project: str, path: str,
                    drawings: list[dict[str, Any]], request: Request) -> dict[str, Any]:
    """공유 서버 본체 — 비공개는 받지 않고, 기대 저장 대상·서버 계정을 인증 계정과 대조한다(주소는 허브가 이미 봤다)."""
    if body.private:
        raise HTTPException(status_code=400, detail="비공개 코멘트는 로컬 허브에서만 저장할 수 있습니다")
    if not body.expected_target or not (body.expected_server_account or "").strip():
        raise HTTPException(status_code=400, detail="저장 대상·서버 계정 기대값이 없습니다")
    email = norm_email((current_account(request) or {}).get("email"))
    expected = norm_email(body.expected_server_account.strip().removeprefix("acct:"))
    if body.expected_target != "server" or not email or expected != email:
        raise _fail(409, "context_changed", _ACCOUNT_CHANGED)
    return _create_here(body, project, path, drawings, request)


@router.post("/comments-v2")
def add_comment_v2(body: AssetCommentV2In, request: Request):
    """글 + 그림(획 목록)을 한 번에 저장. 비공개 = 늘 로컬, 로컬 장부에 있는 id = 처음 장소(로컬)의 결과,
    공유 = 중계 중이면 서버의 같은 경로, 아니면 로컬. 응답 {id, result, drawings:[{id, content_hash}]}."""
    if not comment_strokes.is_uuid(body.id):
        raise HTTPException(status_code=400, detail="bad_comment_id")
    if body.parent_id is not None:
        raise HTTPException(status_code=400, detail="답글에는 그림을 붙일 수 없습니다")
    if not (body.text or "").strip():
        raise HTTPException(status_code=400, detail="빈 코멘트")
    project, path = real_meta_key(body.project, body.path)
    try:
        drawings = comment_strokes.normalize_drawings(body.drawings)
    except comment_strokes.StrokeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if drawings:
        kind = asset_media_type(path)  # 이미지·영상만 — 오디오·그 밖의 파일은 None
        if kind is None:
            raise HTTPException(status_code=400, detail="unsupported_file_type")
        if any(d["kind"] != kind for d in drawings):
            raise HTTPException(status_code=400, detail="kind_mismatch")
    # 서버로 온 요청 — 공유 팀 서버 본체, 또는 허브가 중계한 격리 시험 서버(로그인 켬 + NO_PROXY: 허브는 머리글을 옮기지 않고
    #  본문에 server 기대값을 싣는다). 그 경우는 본문 기대값을 인증 계정과 대조한다.
    if _proxy.is_shared_team_server() or (_assets_access.AUTH_ENABLED and body.expected_target == "server"):
        return _on_team_server(body, project, path, drawings, request)
    with active_account.pinned_account_scope() as key:
        # 허브(로그인 끔) = 고정한 계정 DB 키 · 격리 로컬(로그인 켬 + 중계 끔) = 고정 키가 없어 인증 계정
        owner = (norm_email((current_account(request) or {}).get("email"))
                 if _assets_access.AUTH_ENABLED else norm_email(key))
        if not (request.headers.get(EXPECT_ACCOUNT_HEADER) or "").strip():
            raise HTTPException(status_code=400, detail="기대 계정(X-MVHub-Expect-Account)이 없습니다")
        if expected_account_differs(request, owner):
            raise _fail(409, "context_changed", _ACCOUNT_CHANGED)
        relay = _proxy.proxying()
        connection = (_proxy.base_url(), _proxy.token()) if relay else None
        target = "server" if relay and not body.private else "local"
        if body.expected_target is None:
            raise HTTPException(status_code=400, detail="저장 대상 기대값이 없습니다")
        if body.expected_target != target:
            raise _fail(409, "context_changed", _ACCOUNT_CHANGED)
        if connection is not None and target == "server":
            if not (body.expected_server_url or "").strip():
                raise HTTPException(status_code=400, detail="서버 주소 기대값이 없습니다")
            if not _same_url(body.expected_server_url, connection[0]):
                raise _fail(409, "context_changed", _ACCOUNT_CHANGED)
        # 로컬 장부를 공유 분기보다 먼저 — 처리 장소가 바뀐 재시도를 새 저장으로 만들지 않는다
        state = asset_comment_drawings.local_request_state(body.id)
        if state is not None:
            if not state["exists"]:
                raise _fail(410, "deleted", "이미 지워진 코멘트입니다")
            if relay and not state["private"]:
                raise _fail(409, "stored_local",
                            "서버 연결 전에 이 PC 에만 저장된 코멘트입니다 — 팀에는 보이지 않습니다")
            return _create_here(body, project, path, drawings, request)
        if connection is None or target == "local":
            return _create_here(body, project, path, drawings, request)
        with _proxy.pinned_connection(connection):
            try:
                return _proxy.proxy_json(
                    "POST", "/api/assets/comments-v2",
                    body={**body.model_dump(), "project": project, "path": path},
                )
            except HTTPException as exc:
                if _route_missing(exc):
                    raise _fail(409, "server_update_needed", "팀 서버 업데이트 뒤 그림을 붙일 수 있습니다") from exc
                raise


@contextmanager
def _no_store_errors() -> Iterator[None]:
    """그림 조회는 정상·오류 응답 모두 캐시하지 않는다(403·404·410 이 브라우저에 남아 권한이 바뀐 뒤에도 보이지 않게)."""
    try:
        yield
    except HTTPException as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail,
                            headers={**(exc.headers or {}), **_NO_STORE}) from exc


def _drawing_here(comment_id: str) -> bool:
    """로컬 행이 비공개면 로컬 · 그 밖에 중계 중이면 서버 권위(로컬에 공유 행이 없어도 서버로) · 서버 없음이면 로컬."""
    if not _proxy.proxying():
        return True
    return asset_comment_drawings.comment_privacy(comment_id) is True


def _visible_asset_drawing(comment_id: str, drawing_id: str, request: Request) -> dict[str, Any]:
    """비공개 = 작성자만(아니면 404 — 프로젝트 권한은 보지 않는다) · 공유 = 코멘트 행의 프로젝트 읽기 권한."""
    try:
        comment, drawing = asset_comment_drawings.load_drawing(comment_id, drawing_id)
    except comment_strokes.StructureError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if comment is None or drawing is None:
        raise HTTPException(status_code=404, detail="그림 없음")
    if comment["is_private"]:
        if comment["author"] != actor_id(request):
            raise HTTPException(status_code=404, detail="그림 없음")
    else:
        _assets_access.require_asset_comment_access(comment["project"], request, write=False)
    return drawing


def _relay_path(comment_id: str, drawing_id: str, tail: str = "") -> str:
    return f"/api/assets/comments/{quote(comment_id, safe='')}/drawings/{quote(drawing_id, safe='')}{tail}"


@router.get("/comments/{comment_id}/drawings/{drawing_id}")
def get_asset_comment_drawing(comment_id: str, drawing_id: str, request: Request):
    """그림 1장의 획 목록(목록에는 메타만). 서버 거절을 로컬 사본으로 대신하지 않는다."""
    with _no_store_errors(), active_account.pinned_account_scope():
        if not _drawing_here(comment_id):
            with _proxy.pinned_connection((_proxy.base_url(), _proxy.token())):
                data, content_type = _proxy.proxy_bytes(_relay_path(comment_id, drawing_id),
                                                        max_bytes=_STROKES_RELAY_MAX)
            return Response(content=data, media_type=content_type, headers=_NO_STORE)
        d = _visible_asset_drawing(comment_id, drawing_id, request)
        return JSONResponse({
            "id": d["id"], "comment_id": d["comment_id"], "idx": d["idx"], "kind": d["kind"],
            "width": d["width"], "height": d["height"], "time_sec": d["time_sec"],
            "strokes": json.loads(d["strokes_json"]), "has_thumb": d["thumb_jpg"] is not None,
            "content_hash": d["content_hash"],
        }, headers=_NO_STORE)


@router.get("/comments/{comment_id}/drawings/{drawing_id}/thumb")
def get_asset_comment_drawing_thumb(comment_id: str, drawing_id: str, request: Request):
    """영상 그림의 목록용 미리보기(JPEG). 없으면 404 — 화면은 획만 보인다(thumb 없음은 정상)."""
    with _no_store_errors(), active_account.pinned_account_scope():
        if not _drawing_here(comment_id):
            with _proxy.pinned_connection((_proxy.base_url(), _proxy.token())):
                data, content_type = _proxy.proxy_bytes(_relay_path(comment_id, drawing_id, "/thumb"),
                                                        max_bytes=comment_strokes.MAX_THUMB_BYTES)
            return Response(content=data, media_type=content_type, headers=_NO_STORE)
        d = _visible_asset_drawing(comment_id, drawing_id, request)
        if d["thumb_jpg"] is None:
            raise HTTPException(status_code=404, detail="미리보기 없음")
        return Response(content=d["thumb_jpg"], media_type="image/jpeg", headers=_NO_STORE)


@router.put(
    "/tags",
    dependencies=[Depends(_assets_access.require_local_assets)],
)
def asset_set_tags(body: AssetTagsIn, request: Request):
    project, path = real_meta_key(body.project, body.path)
    repo.set_asset_tags(project, path, body.tags, actor_id(request))
    return {"ok": True}


@router.put(
    "/tags/batch",
    dependencies=[Depends(_assets_access.require_local_assets)],
)
def asset_set_tags_batch(body: AssetTagsBatchIn, request: Request):
    if len(body.items) > 500:
        raise HTTPException(status_code=400, detail="한 번에 최대 500개 파일까지 변경할 수 있습니다")
    items: list[tuple[str, str, list[str]]] = []
    for item in body.items:
        project, path = real_meta_key(body.project, item.path)
        items.append((project, path, item.tags))
    count = repo.set_asset_tags_batch(items, actor_id(request))
    return {"ok": True, "count": count}


@router.put(
    "/tags/ops",
    dependencies=[Depends(_assets_access.require_local_assets)],
)
def asset_apply_tag_ops(body: AssetTagOpsIn, request: Request):
    """태그 더하기·빼기 — 목록 통째(/tags·/tags/batch)와 달리 다른 창이 그사이 더한 태그를 지우지 않는다(서버셋 설계 ③).
    옛 라우트는 옛 창을 위해 그대로 둔다."""
    if len(body.items) > 500:
        raise HTTPException(status_code=400, detail="한 번에 최대 500개 파일까지 변경할 수 있습니다")
    ops = [(*real_meta_key(body.project, item.path), item.add, item.remove) for item in body.items]
    saved = repo.apply_asset_tag_ops(ops, actor_id(request))
    return {"ok": True, "items": [{"path": item.path, "tags": tags} for item, tags in zip(body.items, saved)]}


@router.put(
    "/comment",
    dependencies=[Depends(_assets_access.require_local_assets)],
)
def asset_set_comment(body: AssetCommentIn, request: Request):
    project, path = real_meta_key(body.project, body.path)
    repo.set_asset_comment(project, path, body.comment, actor_id(request))
    return {"ok": True}


@router.put(
    "/color",
    dependencies=[Depends(_assets_access.require_local_assets)],
)
def asset_set_color(body: AssetColorIn, request: Request):
    project, path = real_meta_key(body.project, body.path)
    repo.set_asset_color(project, path, body.color, actor_id(request))
    return {"ok": True}


@router.put(
    "/colors/batch",
    dependencies=[Depends(_assets_access.require_local_assets)],
)
def asset_set_colors_batch(body: AssetColorsBatchIn, request: Request):
    if len(body.paths) > 500:
        raise HTTPException(status_code=400, detail="한 번에 최대 500개 파일까지 변경할 수 있습니다")
    items = [real_meta_key(body.project, path) for path in body.paths]
    count = repo.set_asset_colors_batch(items, body.color, actor_id(request))
    return {"ok": True, "count": count}
