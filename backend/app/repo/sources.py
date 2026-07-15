"""소스 카탈로그 — 스포트라이트 @/# 피커용 소스 검색(생성 소스 + 에셋 소스 합성).

generations.py 에서 분리(관심사 분리). 직렬화 공유 헬퍼 _attach_children 은 list_generations 계열과
강하게 묶여 있어 generations.py 에 남겨 두고 import 한다(순환 방지: sources → generations 단방향).
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any, Optional

from ..config import DEFAULT_WORKER_ID
from ..db import get_connection
from ..services.media_types import asset_media_type
from .generation_rows import _attach_children


def _asset_media_type(name: str) -> Optional[str]:
    # 에셋 소스 합성용 — 레퍼런스 타입은 image|video 만(오디오 등 제외)
    return asset_media_type(name)


def _asset_sources(
    conn: sqlite3.Connection,
    query: Optional[str],
    tag: Optional[str],
    project: str,
    directory: Optional[str],
    limit: int,
    owner_uid: str = "",
) -> list[dict[str, Any]]:
    """에셋 파트(asset_meta)의 소스(is_source=1)를 Generation 모양으로 합성.

    현재 에셋 폴더(directory)로 스코프 — 그 폴더 및 하위만. @ 피커에 생성 소스와 함께 노출.
    asset_meta 는 계정별 개인화라 **내(owner_uid) 소스만** 합류한다(남의 소스 안 섞임).
    레퍼런스 값은 'asset:{project}|{path}' 토큰(생성 시 절대 로컬경로로 resolve → CLI 자동 업로드).
    """
    from urllib.parse import quote

    where = ["project = ?", "is_source = 1", "owner_uid = ?"]
    args: list[Any] = [project, owner_uid]
    if directory:
        where.append("(path = ? OR path LIKE ?)")
        args += [directory, directory + "/%"]
    if query:
        where.append("source_name LIKE ?")
        args.append(f"%{query}%")
    sql = (
        "SELECT path, source_name, tags, color FROM asset_meta WHERE "
        + " AND ".join(where)
        + " ORDER BY source_name IS NULL, source_name LIMIT ?"
    )
    args.append(limit)

    out: list[dict[str, Any]] = []
    for r in conn.execute(sql, args).fetchall():
        path = r["path"]
        name = path.split("/")[-1]
        mt = _asset_media_type(name)
        if not mt:  # 오디오 등은 레퍼런스 타입(image|video) 밖 → 제외
            continue
        tags_val = json.loads(r["tags"]) if r["tags"] else []
        if tag and tag not in tags_val:  # # 태그 필터(asset_meta tags 는 JSON 이라 파이썬서 필터)
            continue
        qp = f"project={quote(project)}&path={quote(path)}"
        sid = f"asset:{project}:{path}"
        out.append(
            {
                "id": sid,
                "worker_id": DEFAULT_WORKER_ID,
                "worker_name": None,
                "prompt": r["source_name"] or name,
                "model": None,
                "params": None,
                "color": r["color"],
                "status": "done",
                "created_at": "",
                "tags": tags_val,
                "shared": False,
                "parent_gen_id": None,
                "is_source": True,
                "source_name": r["source_name"] or name.rsplit(".", 1)[0],
                "comment": None,
                "assets": [
                    {
                        "id": sid,
                        "generation_id": sid,
                        "type": mt,
                        "file_path": f"/api/assets/file?{qp}",
                        "thumbnail_path": f"/api/assets/thumb?{qp}&w=512" if mt == "image" else None,
                        "source_url": f"asset:{project}|{path}",
                        "cached": True,
                    }
                ],
                "references": [],
            }
        )
    return out


def search_sources(
    query: Optional[str] = None,
    tag: Optional[str] = None,
    # @/# 피커는 소스를 전량 로드해 클라이언트에서 필터한다 → 60 이면 소스가 그보다 많을 때 뒷부분이
    # 후보에서 누락됐다. 넉넉히 올려 누락을 없앤다(근본적인 서버사이드 검색 전환은 SpotlightPrompt 분해 때).
    limit: int = 1000,
    asset_project: Optional[str] = None,
    asset_dir: Optional[str] = None,
    owner_uid: str = "",
    read_all: bool = False,
    member_projects: Optional[list[str]] = None,
) -> list[dict[str, Any]]:
    """소스 등록된 생성본을 @이름/프롬프트(query) 또는 #태그(tag)로 검색.

    스포트라이트의 @/# 피커가 사용. is_source=1 인 것만.
    asset_project 가 주어지면 에셋 파트 소스(현재 폴더 asset_dir 로 스코프)도 합류한다.
    """
    # 휴지통(soft delete)으로 보낸 소스는 @ 피커에서도 제외 — 카탈로그에서 숨겼는데
    # 재사용 가능하면 안 됨(하드삭제 때와 동일한 가시성 유지).
    where = ["g.is_source = 1", "g.deleted_at IS NULL"]
    args: list[Any] = []
    if owner_uid and not read_all:
        # 가시성 — can_view_generation(deps) 과 동일 경계: 내 것, 또는 **내가 멤버인 프로젝트**의 공유물만.
        # shared 라고 무조건 노출하면 비멤버 프로젝트 소스의 프롬프트·모델·params·URL 이 @ 피커로 샌다
        # (목록/단건은 멤버십으로 가리는데 여기만 뚫려 있던 우회). read_all(admin·PM·PD) 이면 전체.
        mp = [p for p in (member_projects or []) if p]
        if mp:
            pph = ",".join("?" * len(mp))
            where.append(
                f"(g.creator_uid = ? OR (g.project_id IN ({pph}) "
                f"AND EXISTS (SELECT 1 FROM share s WHERE s.generation_id = g.id)))"
            )
            args.append(owner_uid)
            args.extend(mp)
        else:
            where.append("g.creator_uid = ?")  # 멤버인 프로젝트가 없으면 내 것만
            args.append(owner_uid)
    # owner_uid 없음(AUTH off/단독) 또는 read_all → 필터 없이 전체.
    if query:
        where.append("(g.source_name LIKE ? OR g.prompt LIKE ?)")
        args += [f"%{query}%", f"%{query}%"]
    if tag:
        where.append(
            "EXISTS (SELECT 1 FROM gen_tag gt JOIN tag t ON t.id=gt.tag_id "
            "WHERE gt.generation_id=g.id AND t.name = ?)"
        )
        args.append(tag)
    sql = (
        "SELECT g.id, g.worker_id, w.name AS worker_name, g.prompt, g.display_prompt, g.model, "
        "g.params, g.color, g.status, g.created_at, g.is_source, g.source_name, g.comment, g.error "
        "FROM generation g LEFT JOIN worker w ON w.id = g.worker_id "
        "WHERE " + " AND ".join(where) +
        " ORDER BY g.source_name IS NULL, g.source_name, g.created_at DESC LIMIT ?"
    )
    args.append(limit)
    with get_connection() as conn:
        rows = [dict(r) for r in conn.execute(sql, args).fetchall()]
        gen_sources = _attach_children(conn, rows)
        asset_sources = (
            _asset_sources(conn, query, tag, asset_project, asset_dir, limit, owner_uid)
            if asset_project
            else []
        )
    return gen_sources + asset_sources
