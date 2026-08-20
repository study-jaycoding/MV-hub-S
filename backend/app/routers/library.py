"""라이브러리 조회 라우터 (Phase 2) — 로컬 탐색·필터.

CLAUDE.md 원칙 1: 내 작업물 탐색은 네트워크를 절대 타지 않는다(전부 로컬 DB).
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from . import _proxy
from .. import rbac, repo
from ..config import AUTH_ENABLED, MEDIA_DIR
from ..deps import (
    account_actor_uid,
    account_global_roles,
    account_scope_uid,
    actor_id,
    can_view_generation_with_member_projects,
    require_view_generation,
)
from ..models import FacetsOut, GenerationOut
from ..services import file_stamp, media_cache, thumbs
from ..services.path_safety import safe_join
from ..services.media_types import IMAGE_EXTENSIONS, VIDEO_EXTENSIONS
from ..services.net_guard import BlockedURLError, assert_public_http_url, guarded_opener

router = APIRouter(prefix="/api", tags=["library"])
log = logging.getLogger("library")


def _overlay_personal_meta(data, request: Request):
    """팀 목록/단건(서버 데이터)에 내 로컬 개인메타를 덧입힌다(2단계).

    (1) 내 카드(creator_uid==my): 로컬 generation 행의 color/tags/auto_tags.
    (2) 남의 카드: 내 로컬 shadow 색(gen_color_overlay) — 남이 만든 카드는 로컬 행이 없어 여기 담긴다.
    개인메타는 서버에 미러하지 않고 로컬 계정DB 에만 둔다(작성자 전용). 각자 로컬이라 색이 서로 안 겹침.
    data 가 리스트(목록)면 in-place 수정 후 반환, dict([단건] 래핑) 호출은 부수효과만 쓴다."""
    rows = data if isinstance(data, list) else None
    if rows is None:
        return data
    my = account_scope_uid(request)
    if not my and _proxy.proxying():
        # AUTH off 프록시(에이전트, MV_agent)는 request.state.account 가 없어 account_scope_uid=None →
        # 내 카드 overlay 가 스킵됐었다. 활성 계정(서버 로그인)으로 '내 카드' 판정.
        from ..active_account import active_uid
        my = active_uid()
    # (1) 내 카드 — 로컬 generation 행의 개인메타(색/태그/auto_tag). creator_uid==my 만.
    #     팀 카드 id 는 서버 UUID(≠ 로컬 id ≠ job_id)라 job_id 로도 앵커를 건다.
    handled: set[int] = set()  # 로컬 개인메타를 실제로 붙인 카드 → g.color 가 진실, shadow 로 안 덮음
    if my:
        anchors: list[str] = []
        for g in rows:
            if isinstance(g, dict) and g.get("creator_uid") == my:
                if g.get("id"):
                    anchors.append(g["id"])
                if g.get("job_id"):
                    anchors.append(g["job_id"])
        meta = repo.personal_meta_by_anchor(anchors, my)
        if meta:
            for g in rows:
                if not isinstance(g, dict) or g.get("creator_uid") != my:
                    continue
                m = meta.get(g.get("id")) or meta.get(g.get("job_id"))
                if m:
                    g["color"] = m["color"]
                    g["tags"] = m["tags"]
                    g["auto_tags"] = m["auto_tags"]
                    handled.add(id(g))  # 지운 색(None)도 진실 → shadow 부활 방지
    # (2) shadow 색·태그(gen_color_overlay/gen_tag_overlay) — 로컬 개인메타를 못 붙인 카드
    #     (남의 카드 + 로컬 행 없는 내 서버 카드). 계정DB 자체가 스코프라 my 없어도 적용.
    #     앵커는 job_id 우선(없으면 id) '한 개'로 통일(쓰기와 동일 규칙).
    if _proxy.proxying():
        sh: list[str] = []
        for g in rows:
            if isinstance(g, dict) and id(g) not in handled:
                a = g.get("job_id") or g.get("id")
                if a:
                    sh.append(a)
        cmap = repo.color_overlay_by_anchors(sh)
        tmap = repo.tags_overlay_by_anchors(sh)
        if cmap or tmap:
            for g in rows:
                if not isinstance(g, dict) or id(g) in handled:
                    continue
                anchor = g.get("job_id") or g.get("id")
                c = cmap.get(anchor)
                if c is not None:
                    g["color"] = c
                t = tmap.get(anchor)
                if t is not None:
                    g["tags"] = t
    return data


def _team_local_filtered(request: Request, want_colors, want_tags, want_auto, limit: int, cursor_ts, cursor_id):
    """팀 탭 개인메타 필터(색/태그/전역태그) — 이들은 로컬 전용(서버 미러 안 함)이라 서버가 못 거른다.
    허브가 해당 필터를 뺀 요청으로 서버 목록을 받아 overlay(내 색·태그+shadow) 후 로컬에서 거른다.
    필터 그룹끼리는 AND, 그룹 안에서는 OR(서버 SQL 과 동일 의미). 무한스크롤(GEN_PAGE)이 조기 종료되지
    않게 limit 개가 찰 때까지 서버 페이지를 이어 받는다(키셋 커서 전진, 안전 상한 MAX_FETCHES)."""
    cset = {c for c in (want_colors or []) if c}
    tset = {t for t in (want_tags or []) if t}
    aset = {a for a in (want_auto or []) if a}
    if not (cset or tset or aset):
        return _overlay_personal_meta(_proxy.proxy_get("/api/generations", request), request)

    def _match(g: dict) -> bool:
        if cset and g.get("color") not in cset:
            return False
        if tset and not (tset & set(g.get("tags") or [])):
            return False
        if aset and not (aset & set(g.get("auto_tags") or [])):
            return False
        return True

    # 색·태그·전역태그 파라미터(개인메타)만 빼고 나머지 필터(tab=team·media_type·folder·search 등)는 유지.
    # ★단수 color/tag 도 제거 — 남으면 서버가 먼저 걸러(개인메타 아닌 서버값 기준) 로컬 필터가 무의미.
    base = [
        (k, v)
        for (k, v) in urllib.parse.parse_qsl(request.url.query, keep_blank_values=True)
        if k not in ("color", "colors", "tag", "tags", "auto_tags", "cursor_ts", "cursor_id", "limit")
    ]
    PAGE = 200  # 서버에서 한 번에 당길 양(프론트 GEN_PAGE 와 동일)
    # 종료는 '서버 소진'(page<PAGE)이 정상 경로 — 정상 팀 규모는 여기서 먼저 끝난다.
    # MAX_FETCHES 는 서버 버그(커서 안 전진 등)로 인한 runaway 만 막는 안전상한(≈12000행).
    # 그보다 큰 팀 + 매우 희소한 필터면 상위 ~12000행 내에서만 필터됨(현실적으로 도달 안 함, Jay 인지).
    MAX_FETCHES = 60
    matches: list = []
    cur_ts, cur_id = cursor_ts, cursor_id
    for _ in range(MAX_FETCHES):
        pairs = list(base) + [("limit", str(PAGE))]
        if cur_ts is not None:
            pairs.append(("cursor_ts", str(cur_ts)))
        if cur_id is not None:
            pairs.append(("cursor_id", str(cur_id)))
        page = _proxy.proxy_json("GET", "/api/generations", raw_query=urllib.parse.urlencode(pairs))
        if not isinstance(page, list) or not page:
            break
        _overlay_personal_meta(page, request)  # 내 색·태그·shadow 덧입힘(in-place)
        matches.extend(g for g in page if isinstance(g, dict) and _match(g))
        if len(matches) >= limit or len(page) < PAGE:
            break  # 충분히 채웠거나 서버 소진
        last = page[-1]
        cur_ts, cur_id = last.get("sort_ts"), last.get("id")
        if cur_ts is None or cur_id is None:
            break
    return matches[:limit]


def _remote_thumb_urls(data) -> list[str]:
    """팀 목록 응답에서 카드 대표 썸네일로 쓰일 원격(http) URL 들을 모은다(순서보존·중복제거).

    프론트(GenerationCard)와 동일 규칙: assets[0] 의 thumbnail_path, 이미지면 file_path 도.
    비디오 file_path(.mp4)는 썸네일 대상이 아니므로 제외(원본 통째 다운로드 방지)."""
    if not isinstance(data, list):
        return []
    seen: dict[str, None] = {}
    for g in data:
        if not isinstance(g, dict):
            continue
        assets = g.get("assets") or []
        if not assets or not isinstance(assets[0], dict):
            continue
        a = assets[0]
        raw = a.get("thumbnail_path") or (
            a.get("file_path") if a.get("type") != "video" else None
        )
        if isinstance(raw, str) and raw.startswith(("http://", "https://")):
            seen.setdefault(raw, None)
    return list(seen.keys())


STAMP_MAX_BYTES = 512 * 1024 * 1024  # 이보다 크면 각인 없이 그냥 흘려보낸다(디스크·시간 보호).


def _new_temp_file(suffix: str) -> Path:
    """빈 임시 파일 경로. mkstemp 가 연 fd 를 반드시 닫는다 — Windows 는 열린 파일을 교체하지
    못해, fd 를 쥔 채로 두면 각인이 '액세스 거부'로 조용히 실패한다."""
    fd, path = tempfile.mkstemp(suffix=suffix or ".bin")
    os.close(fd)
    return Path(path)


def _stamped_download(
    upstream, ctype: str, safe: str, tags: dict[str, str], background: BackgroundTasks
):
    """받은 바이트를 제한된 임시 파일에 담아 각인한 뒤 내려준다.

    Content-Length가 없는 원격 응답도 있으므로 읽는 도중 상한을 직접 검사한다. 상한을 넘으면
    각인만 포기하고, 이미 임시에 받은 앞부분 + upstream 나머지를 이어서 스트리밍한다. 다운로드를
    막지 않으면서도 알 수 없는 크기의 파일이 디스크를 무제한 점유하지 않게 한다.
    """
    suffix = Path(safe).suffix or ""
    tmp = _new_temp_file(suffix)
    overflow = False
    try:
        with tmp.open("wb") as out:
            size = 0
            while True:
                chunk = upstream.read(65536)
                if not chunk:
                    break
                out.write(chunk)
                size += len(chunk)
                if size > STAMP_MAX_BYTES:
                    overflow = True
                    break
        if overflow:
            def _stream_unstamped():
                try:
                    with tmp.open("rb") as prefix:
                        while True:
                            chunk = prefix.read(65536)
                            if not chunk:
                                break
                            yield chunk
                    while True:
                        chunk = upstream.read(65536)
                        if not chunk:
                            break
                        yield chunk
                finally:
                    upstream.close()
                    tmp.unlink(missing_ok=True)

            return StreamingResponse(
                _stream_unstamped(),
                media_type=ctype,
                headers={"Content-Disposition": f'attachment; filename="{safe}"'},
            )
        file_stamp.stamp_file(tmp, tags, suffix)
        upstream.close()
    except Exception:
        upstream.close()
        tmp.unlink(missing_ok=True)
        raise
    background.add_task(lambda: tmp.unlink(missing_ok=True))
    return FileResponse(
        tmp, media_type=ctype, filename=safe,
        headers={"Content-Disposition": f'attachment; filename="{safe}"'},
    )


@router.post("/stamp/read")
async def read_file_stamp(file: UploadFile = File(...)):
    """파일에 새겨진 각인을 읽어 '어느 생성물인지'만 돌려준다.

    캔버스에 끌어다 놓은 파일의 정체를 알아낼 때 쓴다. 나머지 정보(프롬프트·모델·계보)는 이
    열쇠로 기존 조회 API 가 카탈로그에서 가져오므로 여기서는 읽지 않는다.
    각인이 없으면 gen_id=None — '우리 프로그램을 거쳐 나간 파일이 아니다'라는 뜻이다.
    """
    tmp = _new_temp_file(Path(file.filename or "").suffix)
    try:
        size = 0
        with tmp.open("wb") as out:
            while True:
                chunk = await file.read(1 << 20)
                if not chunk:
                    break
                size += len(chunk)
                if size > STAMP_MAX_BYTES:
                    raise HTTPException(status_code=413, detail="파일이 너무 큽니다")
                out.write(chunk)
        stamp = file_stamp.read_stamp(tmp)
    finally:
        tmp.unlink(missing_ok=True)
    return {
        "gen_id": file_stamp.gen_id_of(stamp),
        "job_id": stamp.get(file_stamp.KEY_JOB),
        "hub": stamp.get(file_stamp.KEY_HUB),
    }


@router.get("/download")
def download_media(
    background: BackgroundTasks,
    url: str = Query(...),
    name: str = Query("download"),
    gen_id: Optional[str] = Query(None),
):
    """원격 미디어(cloudfront 등)를 서버가 받아 attachment 로 스트리밍한다.

    원격 URL 은 브라우저의 a[download] 가 무시돼 '다운로드' 대신 새 탭으로 열린다. 같은 오리진
    프록시(이 엔드포인트)로 받으면 Content-Disposition: attachment 로 '진짜 다운로드'(크롬 다운로드
    목록)가 된다. http(s) 만 허용 + 내부 호스트 차단(기본 SSRF 방어). 로컬 보관본(/media·/api)은
    로컬 보관본(/media/...)도 gen_id 가 오면 여기서 각인해 내려준다(각인 경로 일원화)."""
    safe = (name or "download").replace('"', "").replace("\n", "").replace("\r", "")[:120] or "download"

    # 로컬 보관본(byte-cache) — 원격이 아니라 우리 디스크에 있는 파일. 각인해서 사본으로 내려준다.
    if url.startswith("/media/"):
        src = safe_join(MEDIA_DIR, url.removeprefix("/media/"))
        if src is None or not src.exists():
            raise HTTPException(status_code=404, detail="로컬 보관본을 찾을 수 없습니다")
        tags = file_stamp.tags_for_generation(gen_id) if gen_id else {}
        if not tags or src.stat().st_size > STAMP_MAX_BYTES:
            return FileResponse(src, filename=safe)  # 각인 없이 원본 그대로
        suffix = src.suffix or Path(safe).suffix
        tmp = _new_temp_file(suffix)
        shutil.copy2(src, tmp)
        file_stamp.stamp_file(tmp, tags, suffix)
        background.add_task(lambda: tmp.unlink(missing_ok=True))
        return FileResponse(tmp, filename=safe)

    try:
        assert_public_http_url(url)  # http(s) + 내부/사설 대역 차단(SSRF 방어)
    except BlockedURLError as e:
        raise HTTPException(status_code=400, detail=str(e))
    try:
        # User-Agent 부여 — 일부 CDN 이 UA 없는 요청을 403 으로 막는다(브라우저 흉내).
        # 리다이렉트 차단 opener — 3xx 우회(SSRF) 방지.
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (MV-hub media proxy)"})
        opener = guarded_opener()
        upstream = opener.open(req, timeout=60)  # noqa: S310 — http(s)+IP 검증 완료
    except HTTPException:
        raise
    except BlockedURLError as e:
        raise HTTPException(status_code=502, detail=str(e))  # 리다이렉트로 내부망 우회 시도 차단
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"원격 미디어 다운로드 실패: {e}")
    ctype = upstream.headers.get_content_type() or "application/octet-stream"

    # 각인 — 이 파일이 어느 생성물인지 새겨 내보낸다(나중에 캔버스에 끌어다 놓으면 복원된다).
    #  · 스트리밍으로는 각인할 수 없어(끝까지 받아야 컨테이너를 다시 쓴다) 임시 파일에 받는다.
    #  · gen_id 가 없거나(구 프론트) 너무 큰 파일이면 종전대로 스트리밍 — 다운로드는 절대 안 막힌다.
    if gen_id:
        try:
            size = int(upstream.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            size = 0
        if size <= STAMP_MAX_BYTES:
            tags = file_stamp.tags_for_generation(gen_id)
            if tags:
                return _stamped_download(upstream, ctype, safe, tags, background)

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


# ── View 타임라인 '합쳐진 영상' 병합 다운로드 ──────────────────────────────────
# 연결된 생성 영상들을 순서대로 하나의 mp4 로 이어붙인다. 클립마다 코덱·해상도가 다를 수 있어
# 공통 해상도(첫 클립 기준)로 정규화 재인코딩한 뒤 concat demuxer 로 붙인다(오디오 없으면 무음 삽입).
MERGE_MAX_CLIPS = 30
MERGE_IMG_DUR = 3  # 이미지 클립은 3초짜리 정지영상으로 병합(플레이어 재생과 동일)


class MergeReq(BaseModel):
    srcs: list[str]
    name: str = "merged"


async def _resolve_local_media(src: str) -> Optional[tuple[Path, bool]]:
    """미디어 src(/media 경로 또는 http(s) URL)를 로컬 파일 경로로 해석(썸네일과 동일 규칙).
    반환 (path, is_image). 비디오·이미지만 허용, 그 외/미해석은 None."""
    if not isinstance(src, str) or not src:
        return None
    if src.startswith(("http://", "https://")):
        rel = await media_cache.cache_url(src)  # 원격은 로컬로 캐시(SSRF 가드 내장)
        target = thumbs._media_target(rel) if rel else None
    elif src.startswith("/media/"):
        target = thumbs._media_target(src)  # 경로 이탈 차단
    else:
        target = None
    if not target or not target.is_file():
        return None
    ext = target.suffix.lower()
    if ext in VIDEO_EXTENSIONS:
        return target, False
    if ext in IMAGE_EXTENSIONS:
        return target, True
    return None


def _ffprobe_has_audio(ffprobe: Optional[str], path: Path) -> bool:
    if not ffprobe:
        return False
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "a", "-show_entries",
             "stream=index", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, timeout=20,
        ).stdout.strip()
        return bool(out)
    except Exception:  # noqa: BLE001
        return False


def _ffprobe_wh(ffprobe: Optional[str], path: Path) -> Optional[tuple[int, int]]:
    if not ffprobe:
        return None
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=width,height", "-of", "csv=p=0:s=x", str(path)],
            capture_output=True, text=True, timeout=20, check=True,
        ).stdout.strip()
        w, h = out.split("x")[:2]
        return int(w), int(h)
    except Exception:  # noqa: BLE001
        return None


def _merge_clips_sync(items: list[tuple[Path, bool]], workdir: Path) -> Path:
    """클립들(비디오/이미지)을 공통 해상도로 정규화(재인코딩) 후 concat 으로 이어붙여 mp4 반환.
    items = [(path, is_image)]. 이미지는 MERGE_IMG_DUR 초 정지영상으로, 오디오 없으면 무음 삽입.
    블로킹 — 스레드에서 호출."""
    ff = thumbs._ffmpeg_bin()
    if not ff:
        raise RuntimeError("ffmpeg 를 찾을 수 없습니다")
    ffprobe = shutil.which("ffprobe")
    wh = _ffprobe_wh(ffprobe, items[0][0]) or (1280, 720)
    w = max(2, wh[0] - wh[0] % 2)
    h = max(2, wh[1] - wh[1] % 2)
    vf = (
        f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
        f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p"
    )
    enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-movflags", "+faststart"]
    silent = ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"]
    norm: list[Path] = []
    for i, (p, is_image) in enumerate(items):
        out_i = workdir / f"n{i}.mp4"
        if is_image:
            # 정지 이미지 → MERGE_IMG_DUR 초 루프 + 무음.
            cmd = [ff, "-y", "-loglevel", "error", "-loop", "1", "-t", str(MERGE_IMG_DUR), "-i", str(p),
                   *silent, "-vf", vf, "-map", "0:v", "-map", "1:a", "-shortest", *enc, str(out_i)]
        elif _ffprobe_has_audio(ffprobe, p):
            cmd = [ff, "-y", "-loglevel", "error", "-i", str(p), "-vf", vf, "-ar", "44100", "-ac", "2", *enc, str(out_i)]
        else:
            # 오디오 없는 클립엔 무음 트랙을 붙여, 오디오 있는 클립과 concat 시 스트림 수가 맞게 한다.
            cmd = [ff, "-y", "-loglevel", "error", "-i", str(p), *silent,
                   "-vf", vf, "-map", "0:v", "-map", "1:a", "-shortest", *enc, str(out_i)]
        with thumbs._FFMPEG_SEM:  # 동시 ffmpeg 프로세스 수 제한(썸네일과 공용)
            subprocess.run(cmd, check=True, capture_output=True, timeout=300)
        norm.append(out_i)
    listfile = workdir / "list.txt"
    listfile.write_text("".join(f"file '{n.as_posix()}'\n" for n in norm), encoding="utf-8")
    out = workdir / "merged.mp4"
    with thumbs._FFMPEG_SEM:
        subprocess.run(
            [ff, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(listfile),
             "-c", "copy", "-movflags", "+faststart", str(out)],
            check=True, capture_output=True, timeout=300,
        )
    return out


@router.post("/merge")
async def merge_videos(req: MergeReq):
    """연결된 생성물(영상/이미지)들을 순서대로 하나의 mp4 로 병합해 attachment 로 내려준다."""
    if not req.srcs:
        raise HTTPException(status_code=400, detail="병합할 항목이 없습니다")
    if len(req.srcs) > MERGE_MAX_CLIPS:
        # 조용히 잘라내면 일부 빠진 영상을 정상처럼 받게 되므로 명시적으로 거절.
        raise HTTPException(status_code=413, detail=f"한 번에 병합 가능한 항목은 최대 {MERGE_MAX_CLIPS}개입니다")
    items: list[tuple[Path, bool]] = []
    for s in req.srcs:
        r = await _resolve_local_media(s)
        if r:
            items.append(r)
    if not items:
        raise HTTPException(status_code=400, detail="병합할 로컬 미디어를 찾을 수 없습니다")
    workdir = Path(tempfile.mkdtemp(prefix="mvhub_merge_"))
    try:
        out = await asyncio.to_thread(_merge_clips_sync, items, workdir)
    except Exception as e:  # noqa: BLE001
        shutil.rmtree(workdir, ignore_errors=True)
        # 원본 예외(ffmpeg 경로 등)는 로그로만, 클라이언트엔 일반 메시지.
        log.warning("[merge] 병합 실패: %s", e)
        raise HTTPException(status_code=500, detail="영상 병합에 실패했습니다")
    safe = (req.name or "merged").replace('"', "").replace("\n", "").replace("\r", "")[:80] or "merged"
    # 응답 전송이 끝나면 임시 폴더 정리(BackgroundTask).
    return FileResponse(
        out, media_type="video/mp4", filename=f"{safe}.mp4",
        background=BackgroundTask(shutil.rmtree, workdir, ignore_errors=True),
    )


@router.get("/media-thumb")
async def media_thumb(src: str = Query(...), w: int = Query(512, ge=64, le=1024)):
    """생성 미디어 썸네일 — 리사이즈+디스크 캐시(공용 thumbs 헬퍼).
    그리드가 풀해상도 원본(수 MP) 대신 작은 이미지를 디코딩하게 해 렉을 없앤다.

    src:
    - /media/<2>/<sha>.ext  → 로컬 보관 미디어(내 작업물).
    - http(s) URL           → 공유받은(team) 항목은 file_path 가 원격 URL(Higgsfield)이라
                              그대로면 썸네일을 못 거쳐 풀해상도 원본을 디코딩 → 표시 지연.
                              media_cache 로 바이트를 로컬화한 뒤 동일 썸네일을 만든다.
    원격 다운로드·썸네일 생성 실패는 같은 오리진 오류로 끝내 외부 리다이렉트를 만들지 않는다."""
    is_remote = src.startswith(("http://", "https://"))
    if is_remote:
        # 썸네일 생성만을 위한 원격 원본은 bounded 전용 캐시 — 영구 MEDIA_DIR에 무한 누적 금지.
        rel = await media_cache.cache_thumb_source(src)
        if not rel:
            raise HTTPException(status_code=502, detail="원격 미디어를 가져오지 못했습니다")
        target = thumbs._media_target(rel)
    else:
        target = thumbs._media_target(src)
    if not target:
        raise HTTPException(status_code=400, detail="로컬 /media 경로 또는 http(s) URL만 지원")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="파일 없음")
    # PIL/ffmpeg 는 동기 CPU 작업 — async 라우트에서 직접 부르면 캐시 미스마다 이벤트 루프가 멈춘다
    # (prewarm 경로와 동일하게 스레드로 오프로딩). 이미지=리사이즈, 비디오=ffmpeg 첫 프레임 포스터.
    # 비디오 포스터 지원으로 캔버스 레퍼런스 등 <img> 로 그리던 곳(포스터 없는 원격 영상)도 커버된다.
    if target.suffix.lower() in VIDEO_EXTENSIONS:
        cache = await asyncio.to_thread(thumbs.ensure_video_poster, target, w)
    else:
        cache = await asyncio.to_thread(thumbs.ensure_thumb, target, w)
    if not cache:
        if is_remote:
            raise HTTPException(status_code=502, detail="원격 미디어 썸네일 생성 실패")
        raise HTTPException(status_code=415, detail="썸네일 생성 불가")
    thumbs.mark_thumb_used(cache)  # 실서빙 히트만 LRU 갱신(프리워밍 스윕은 제외)
    return FileResponse(
        cache, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=2592000"}
    )


@router.get("/generations", response_model=list[GenerationOut])
def list_generations(
    request: Request,
    background: BackgroundTasks,
    tab: str = Query("my", pattern="^(my|team)$"),
    worker_id: Optional[str] = None,
    color: Optional[str] = None,
    tag: Optional[str] = None,
    share_dir: Optional[str] = Query(None, pattern="^(mine|received)$"),
    local_only: bool = False,
    creator_uid: Optional[str] = None,
    workspace_id: Optional[str] = None,
    project_id: Optional[str] = None,
    folder_path: Optional[str] = None,
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
        # color/tags 는 작성자 전용이라 서버에 미러하지 않는다(개인 메타). 팀 목록은 서버 데이터라
        # '내 카드'의 개인 색·태그가 빠져 있으므로, 허브가 자기 로컬 DB에서 가져와 덧입힌다(A1 오버레이).
        # 색·태그·전역태그는 개인메타(로컬 전용)라 서버가 못 거른다 → 허브가 그 필터 뺀 요청으로 받아
        # overlay(내 색·태그+shadow) 후 로컬 필터. 나머지(media_type·folder 등)는 서버가 그대로 거름.
        if colors or tags or auto_tags:
            data = _team_local_filtered(request, colors, tags, auto_tags, limit, cursor_ts, cursor_id)
        else:
            data = _overlay_personal_meta(_proxy.proxy_get("/api/generations", request), request)
        # 백그라운드 prewarm: 팀 항목 미디어는 원격 URL 이라 첫 표시 때 보는 PC 가 받아 리사이즈 → 느림.
        # 목록을 받자마자 뒤에서 미리 캐시+썸네일링하면 실제 스크롤 시점엔 디스크 캐시 히트로 즉시 뜬다.
        urls = _remote_thumb_urls(data)
        if urls:
            background.add_task(thumbs.prewarm_remote_thumbs, urls)
        return data
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
        workspace_id=workspace_id,
        account_uid=account_uid,
        project_id=project_id,
        folder_path=folder_path,
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
        # list_generations가 이미 같은 generation 행의 id·job_id를 반환한다. 이는
        # finalize_id_map의 ``row["job_id"] or row["id"]`` 규칙과 같으므로 행마다
        # 해석 쿼리를 다시 열 필요가 없다.
        srv_of = {g["id"]: g.get("job_id") or g["id"] for g in result if g.get("shared")}
        if srv_of:
            try:
                counts = _proxy.proxy_json(
                    "POST", "/api/generations/comment-counts",
                    body={"gen_ids": list(srv_of.values())},
                    timeout=5,  # 비핵심 보강 — 서버가 느리거나 다운이면 목록을 60초씩 막지 말고 빨리 포기(로컬값 유지)
                )
                if isinstance(counts, dict):
                    private_counts = repo.private_generation_comment_counts(
                        list(srv_of), actor_id(request)
                    )
                    for g in result:
                        sid = srv_of.get(g["id"])
                        c = counts.get(sid) if sid else None
                        if isinstance(c, dict):
                            g["comment_count"] = int(c.get("comment_count") or 0) + private_counts.get(
                                g["id"], 0
                            )
                            g["has_unread"] = c.get("has_unread", g.get("has_unread"))
            except Exception:  # noqa: BLE001 — 보강 실패는 로컬 값 유지(치명적 아님)
                pass
    # 내 라이브러리도 대표 썸네일이 원격 URL 이면 뒤에서 미리 캐시(팀 탭과 동일) — 첫 스크롤 지연 제거.
    # 이미 캐시된 건 즉시 통과(멱등)라 매 목록 요청 재호출이 싸다.
    own_urls = _remote_thumb_urls(result)
    if own_urls:
        background.add_task(thumbs.prewarm_remote_thumbs, own_urls)
    return result


@router.get("/generations-stats")
def generation_stats(request: Request):
    """패널 파생값(내 실패 수·미확인 코멘트 여부).

    실패 수는 실패 정리 API와 동일한 계정 범위, 미확인 여부는 패널 seen 기록과 동일 신원을 쓴다.
    """
    uid = _account_uid(request)
    local = (
        repo.generation_stats(viewer_id=uid, account_uid=uid)
        if uid
        else repo.generation_stats()
    )
    if not _proxy.proxying():
        return local
    try:
        remote = _proxy.proxy_json("GET", "/api/generations-stats", timeout=5)
    except HTTPException as exc:
        # 인증 오류는 숨기지 않는다. 일시적인 서버 장애만 로컬 실패 수/코멘트 상태로 폴백한다.
        if exc.status_code in (401, 403):
            raise
        return local
    if not isinstance(remote, dict):
        return local
    has_unread = bool(remote.get("has_unread"))
    unread_count = remote.get("unread_count")
    return {
        **local,
        "has_unread": has_unread,
        # 구팀서버는 has_unread만 준다. 롤링 업데이트 동안 최소 1로 안전하게 폴백한다.
        "unread_count": int(unread_count) if unread_count is not None else int(has_unread),
    }


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
            srv = _proxy.proxy_get(f"/api/generations/{gen_id}", request)
            if isinstance(srv, dict):
                _overlay_personal_meta([srv], request)  # 내 카드면 로컬 개인메타 덧입힘(목록과 동일)
            return srv
        raise HTTPException(status_code=404, detail="generation 없음")
    # 비공개는 본인만, 공유된 것만 남이 열람(원칙). 권한 없으면 404(존재 자체를 숨김).
    require_view_generation(request, gen)
    return gen


class GenerationBatchIn(BaseModel):
    gen_ids: list[str]


class GenerationBatchOut(BaseModel):
    items: dict[str, GenerationOut]
    materials: dict[str, list[str]]
    missing: list[str]


@router.post("/generations/batch", response_model=GenerationBatchOut)
def get_generations_batch(body: GenerationBatchIn, request: Request):
    """캔버스용 생성물 상태 + 직접 레퍼런스 부모 일괄 조회.

    단건 GET을 카드 수만큼 호출하던 N+1 요청을 한 번으로 합친다. 로컬에 없는 id도 공유 서버에
    한 번의 배치 요청으로 위임하며, 찾지 못한 id는 missing으로 명시해 클라이언트가 재조회하지 않는다.
    """
    ids = list(dict.fromkeys(str(gen_id).strip() for gen_id in (body.gen_ids or []) if str(gen_id).strip()))
    if len(ids) > 500:
        raise HTTPException(status_code=413, detail="한 번에 조회 가능한 생성물은 최대 500개입니다")
    if not ids:
        return {"items": {}, "materials": {}, "missing": []}

    account_uid = _account_uid(request)
    local_items, local_materials = repo.get_generations_with_materials(ids, account_uid=account_uid)
    # 공유물 권한은 프로젝트 멤버십에만 의존한다. 이전에는 아래 카드 루프의
    # require_view_generation이 shared 카드마다 my_member_projects를 다시 조회했다.
    # 요청 안에서는 멤버십이 변하지 않으므로 필요한 경우 한 번만 집합으로 고정한다.
    member_project_ids: set[str] | None = None
    viewer_uid = account_actor_uid(request) if AUTH_ENABLED else None
    if (
        viewer_uid
        and not rbac.has_global_cap(account_global_roles(request), "read_all")
        and any(
            gen.get("shared") and gen.get("creator_uid") != viewer_uid
            for gen in local_items.values()
        )
    ):
        member_project_ids = set(repo.my_member_projects(viewer_uid))
    visible_items: dict[str, dict] = {}
    visible_materials: dict[str, list[str]] = {}
    for gen_id, gen in local_items.items():
        if not can_view_generation_with_member_projects(request, gen, member_project_ids):
            continue  # 단건 GET과 같은 존재 은닉 — batch에서는 missing으로 합친다.
        visible_items[gen_id] = gen
        visible_materials[gen_id] = local_materials.get(gen_id, [])

    unresolved = [gen_id for gen_id in ids if gen_id not in visible_items]
    if unresolved and _proxy.proxying():
        remote = _proxy.proxy_json(
            "POST",
            "/api/generations/batch",
            body={"gen_ids": unresolved},
            timeout=15,
        )
        if isinstance(remote, dict):
            remote_items = remote.get("items") if isinstance(remote.get("items"), dict) else {}
            _overlay_personal_meta(list(remote_items.values()), request)
            remote_materials = (
                remote.get("materials") if isinstance(remote.get("materials"), dict) else {}
            )
            for requested_id in unresolved:
                gen = remote_items.get(requested_id)
                if isinstance(gen, dict):
                    visible_items[requested_id] = gen
                    parents = remote_materials.get(requested_id)
                    visible_materials[requested_id] = (
                        [str(parent) for parent in parents if parent] if isinstance(parents, list) else []
                    )

    return {
        "items": visible_items,
        "materials": visible_materials,
        "missing": [gen_id for gen_id in ids if gen_id not in visible_items],
    }


@router.get("/facets", response_model=FacetsOut)
def facets(request: Request, tab: str = Query("my", pattern="^(my|team)$")):
    # 컬러/태그 facet — my=내 로컬 생성물 기준, team=서버(팀 공유물) 기준.
    if tab == "team" and _proxy.proxying():
        srv = _proxy.proxy_get("/api/facets", request)
        # 전역 태그(auto_tag)는 로컬 개인 데이터라 서버 facet 엔 없다 → 내 작업 탭과 같은 목록을
        # 보이도록 로컬 owner 의 auto_tags 로 덮어쓴다. (안 그러면 팀 탭에선 안 보이는데 생성하면
        # '이미 있음'으로 뜨는 불일치. 생성·목록·부여 모두 로컬 /api/auto-tags 라 owner 동일.)
        if isinstance(srv, dict):
            # 일반 태그·색·전역태그 모두 개인메타(로컬 전용)라 서버 facet 엔 없다 → 내 로컬 것으로 대체.
            # get_facets 가 이미 내 카드 태그 ∪ shadow 태그(통합 레지스트리)를 준다 → 내작업/팀/캔버스 동일.
            my_facets = repo.get_facets(account_uid=_account_uid(request))
            srv["tags"] = my_facets.get("tags", [])
            srv["colors"] = my_facets.get("colors", [])
            srv["auto_tags"] = repo.list_auto_tags(_tag_owner(request))
        return srv
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
