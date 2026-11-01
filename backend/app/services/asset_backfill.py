"""전송 줄 보충 — 이동 입구가 줄을 못 만든 결과를 일꾼이 찾아 잇는다.

옛 결과(줄·보관본·내용 ID 가 없다)와 서버에서 옮겨진 공유물(허브의 로컬 행이 안 바뀐다)을 다룬다. 줄은 ledger.queue_moved_outputs 로만 만든다.
"""
from __future__ import annotations

import hashlib
import json
import time
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .. import active_account, config, db
from ..repo import asset_sync as ledger
from . import asset_io, shared_connection
from .path_safety import safe_join

SCAN_BATCH = 50
REMOTE_EVERY_S = 60
REMOTE_TIMEOUT_S = 15


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise OSError('asset_server_redirect')  # 인증 머리를 다른 주소로 들고 가지 않는다


_opener = urllib.request.build_opener(_NoRedirect)


def _post(origin: str, token: str, path: str, body: dict):
    """서버에 직접 묻는다 — 묶음 응답은 커질 수 있어 크기를 자르지 않는다. 실패는 던진다."""
    request = urllib.request.Request(origin + path, data=json.dumps(body).encode(), method='POST',
                                     headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    with _opener.open(request, timeout=REMOTE_TIMEOUT_S) as response:
        return json.loads(response.read())


@dataclass
class _Scan:
    context: Optional[tuple] = None
    local_after: int = 0
    local_done: bool = False
    remote_after: int = 0
    remote_at: float = 0.0
    skipped: set = field(default_factory=set)  # 이번 문맥에서 못 고친 asset(파일 없음 등) — 차례를 다시 막지 않게


_scan = _Scan()


def reset() -> None:
    global _scan
    _scan = _Scan()


def _context():
    owner = active_account.active_uid()
    token = shared_connection.token()
    if not owner or not token:
        return None
    return owner, active_account.account_key() or '', shared_connection.base_url(), token


def _still(owner: str, account_key: str, origin: str) -> bool:
    """복사·조회 뒤 문맥이 그대로인가 — 바뀌었으면 옛 문맥의 답을 적용하지 않는다."""
    context = _context()
    return context is not None and context[:3] == (owner, account_key, origin)


def _media_path(file_path: str) -> Optional[Path]:
    if not file_path.startswith('/media/'):
        return None
    path = safe_join(config.MEDIA_DIR, file_path[len('/media/'):])
    return path if path is not None and path.is_file() else None


def _snapshot(path: Path) -> Optional[tuple[Path, str, int, str]]:
    """관리 폴더에 바이트를 고정한다. 트랜잭션 밖에서 부른다 — 큰 영상 복사가 쓰기 잠금을 쥐면 안 된다."""
    kind = asset_io.media_type(path.name)
    if not kind or path.stat().st_size > asset_io.UPLOAD_MAX_BYTES:
        return None
    dest = (config.ASSETS_ROOT / 'imports').resolve()
    dest.mkdir(parents=True, exist_ok=True)
    tmp = dest / ('.snapshot-' + uuid.uuid4().hex + '.part')
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open('rb') as source, tmp.open('xb') as output:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                size += len(chunk)
                if size > asset_io.UPLOAD_MAX_BYTES:
                    return None
                digest.update(chunk)
                output.write(chunk)
        if not size:
            return None
        saved, _ = asset_io.find_or_commit_media(tmp, dest, path.name, digest.hexdigest(), kind, size)
        return saved, digest.hexdigest(), size, kind
    finally:
        tmp.unlink(missing_ok=True)


def _adopt_output(row, owner: str, account_key: str, origin: str) -> bool:
    """내용 ID 나 보관본이 없는 옛 결과를 원장에 올린다. 복사 뒤 그 행이 그대로인지 다시 보고, 등록과 ID 채움을 한 트랜잭션으로 한다."""
    path = _media_path(row['file_path'])
    if path is None:
        return False
    snapshot = _snapshot(path)
    if snapshot is None:
        return False
    saved, digest, size, kind = snapshot
    content = 'sha256:' + digest
    if row['asset_content_id'] and row['asset_content_id'] != content:
        return False  # 기록한 바이트와 다르다 — 지금 파일로 옛 기록을 덮지 않는다
    with db.get_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        if not _still(owner, account_key, origin):
            return True  # 복사 중 계정·서버가 바뀌었다 — 파일 잘못이 아니니 건너뛴 것으로 적지 않는다. 새 문맥이 처음부터 본다
        current = conn.execute(
            'SELECT a.file_path,a.asset_content_id,g.creator_uid,g.deleted_at FROM asset a JOIN generation g ON g.id=a.generation_id WHERE a.id=?',
            (row['asset_id'],)).fetchone()
        if (current is None or current['deleted_at'] or current['creator_uid'] != owner or current['file_path'] != row['file_path']
                or current['asset_content_id'] != row['asset_content_id']):
            return False
        ledger.register_local(conn, path=saved, file_path=row['file_path'], digest=digest, size=size, media_type=kind,
                              owner_uid=owner, project_id='', server_origin=origin, original_name=path.name, account_key=account_key)
        conn.execute('UPDATE asset SET asset_content_id=? WHERE id=? AND asset_content_id IS NULL', (content, row['asset_id']))
    return True


def _local_candidates(conn, owner: str, after: int):
    """프로젝트가 있는 내 로컬 결과를 차례로 — 이미 다 된 행은 줄 함수가 아무것도 안 하므로 거르지 않는다."""
    return conn.execute(
        "SELECT a.rowid seq,g.id gid,g.project_id,a.id asset_id,a.file_path,a.asset_content_id FROM asset a "
        "JOIN generation g ON g.id=a.generation_id LEFT JOIN project p ON p.id=g.project_id "
        "WHERE g.creator_uid=? AND g.deleted_at IS NULL AND COALESCE(g.project_id,'')<>'' AND COALESCE(p.archived,0)=0 "
        "AND a.file_path NOT LIKE 'http%' AND COALESCE(a.source_url,'') NOT LIKE 'http%' AND a.rowid>? "
        "ORDER BY a.rowid LIMIT ?", (owner, after, SCAN_BATCH)).fetchall()


def _needs_adoption(conn, row, owner: str) -> bool:
    if row['asset_id'] in _scan.skipped:
        return False
    if not row['asset_content_id']:
        return True
    return not conn.execute("SELECT 1 FROM asset_location WHERE kind='local' AND state='ready' AND owner_uid=? AND asset_content_id=? LIMIT 1",
                            (owner, row['asset_content_id'])).fetchone()


def _bring_up(row, owner: str, account_key: str, origin: str) -> None:
    with db.get_connection() as conn:
        adopt = _needs_adoption(conn, row, owner)
    if adopt:
        try:
            if not _adopt_output(row, owner, account_key, origin):
                _scan.skipped.add(row['asset_id'])
        except (OSError, ValueError):
            _scan.skipped.add(row['asset_id'])  # 이 파일만 건너뛴다 — 뒤 행을 계속 본다


def scan_local(owner: str, account_key: str, origin: str) -> None:
    """한 번에 한 묶음. 복사가 끝난 뒤 계정·서버가 바뀌었으면 tick 이 문맥을 새로 잡고 처음부터 본다."""
    with db.get_connection() as conn:
        rows = _local_candidates(conn, owner, _scan.local_after)
    if not rows:
        _scan.local_done = True
        return
    for row in rows:
        _bring_up(row, owner, account_key, origin)
        if not _still(owner, account_key, origin):
            return
        with db.get_connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            ledger.queue_moved_outputs(conn, [row['gid']], row['project_id'], (account_key, origin))
        _scan.local_after = row['seq']


def _shared_candidates(conn, owner: str, after: int):
    return conn.execute(
        "SELECT DISTINCT g.rowid seq,g.id gid,COALESCE(g.job_id,g.id) anchor FROM generation g JOIN share s ON s.generation_id=g.id "
        "WHERE g.creator_uid=? AND g.deleted_at IS NULL AND g.rowid>? AND (EXISTS(SELECT 1 FROM asset a WHERE a.generation_id=g.id "
        "AND a.file_path NOT LIKE 'http%' AND COALESCE(a.source_url,'') NOT LIKE 'http%') OR EXISTS(SELECT 1 FROM gen_reference gr "
        "JOIN reference r ON r.id=gr.reference_id WHERE gr.generation_id=g.id AND r.asset_content_id IS NOT NULL "
        "AND r.file_path NOT LIKE 'http%' AND COALESCE(r.source_url,'') NOT LIKE 'http%' AND COALESCE(r.share_url,'') NOT LIKE 'http%')) "
        "ORDER BY g.rowid LIMIT ?", (owner, after, SCAN_BATCH)).fetchall()


def _remote_items(origin: str, token: str, anchors: list[str]) -> dict:
    """허브의 조회는 로컬 행을 먼저 돌려줘 이동을 못 본다. 못 받으면 빈 사전: 프로젝트 해제로 읽지 않는다."""
    try:
        payload = _post(origin, token, '/api/generations/batch', {'gen_ids': anchors})
    except Exception:  # noqa: BLE001 — 다음 차례에 다시 본다
        return {}
    items = payload.get('items') if isinstance(payload, dict) else None
    return items if isinstance(items, dict) else {}


def _link(origin: str, token: str, anchor: str, content: str, file_path: str) -> None:
    try:
        _post(origin, token, '/api/asset-sync/link-output', {'anchor': anchor, 'asset_content_id': content, 'file_path': file_path})
    except Exception:  # noqa: BLE001 — 빈 칸이 남아 있으면 다음 차례에 다시 부른다. 옛 서버의 404 도 같다
        pass


def _blank_records(item: dict) -> list[dict]:
    assets = item.get('assets') or []
    assets = [assets] if isinstance(assets, dict) else assets
    return [record for record in [*assets, *(item.get('references') or [])]
            if isinstance(record, dict) and not record.get('asset_content_id') and record.get('file_path')]


def _link_blanks(item: dict, row, project_id: str, owner: str, origin: str, token: str) -> None:
    """서버 행의 빈 내용 ID — 그 프로젝트 줄이 끝났을 때만 부른다. 입력도 같다(입력 위치도 내용 ID 로 찾는다)."""
    blanks = _blank_records(item)
    if not blanks:
        return
    with db.get_connection() as conn:
        known = {r['file_path']: r['content'] for r in conn.execute(
            "SELECT a.file_path,a.asset_content_id content FROM asset a WHERE a.generation_id=? AND a.asset_content_id IS NOT NULL UNION "
            "SELECT r.file_path,r.asset_content_id FROM gen_reference gr JOIN reference r ON r.id=gr.reference_id "
            "WHERE gr.generation_id=? AND r.asset_content_id IS NOT NULL", (row['gid'], row['gid']))}
        ready = {r[0] for r in conn.execute(
            "SELECT asset_content_id FROM asset_sync_outbox WHERE owner_uid=? AND project_id=? AND server_origin=? AND state='ready'",
            (owner, project_id, origin))}
    for record in blanks:
        content = known.get(record['file_path'])
        if content in ready:
            _link(origin, token, row['anchor'], content, record['file_path'])


def scan_remote(owner: str, account_key: str, origin: str, token: str) -> None:
    with db.get_connection() as conn:
        rows = _shared_candidates(conn, owner, _scan.remote_after)
    if not rows:
        _scan.remote_after = 0  # 한 바퀴를 돌았다 — 다음 차례는 처음부터(서버 이동은 언제든 생긴다)
        return
    _scan.remote_after = rows[-1]['seq']  # 조회 결과와 상관없이 넘어간다 — 한 묶음이 실패해도 차례가 그 자리에 멈추지 않는다
    items = _remote_items(origin, token, [row['anchor'] for row in rows])
    for row in rows:
        item = items.get(row['anchor'])
        project_id = item.get('project_id') if isinstance(item, dict) else None
        if not project_id or not _still(owner, account_key, origin):
            continue
        with db.get_connection() as conn:
            outputs = conn.execute("SELECT id asset_id,file_path,asset_content_id FROM asset WHERE generation_id=? AND file_path NOT LIKE 'http%'",
                                   (row['gid'],)).fetchall()
        for output in outputs:
            _bring_up(output, owner, account_key, origin)
        if not _still(owner, account_key, origin):
            return  # 복사 중 서버가 바뀌었다 — 옛 서버의 프로젝트를 새 서버 줄로 만들지 않는다
        with db.get_connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            ledger.queue_moved_outputs(conn, [row['gid']], project_id, (account_key, origin))
        _link_blanks(item, row, project_id, owner, origin, token)


def tick(now: Optional[float] = None) -> None:
    """일꾼이 돌 때마다 부른다. 로컬 보충은 문맥마다 한 번, 서버 대조는 60초마다 한 묶음."""
    now = time.time() if now is None else now
    with db.pinned_share_operation():
        context = _context()
        if context is None:
            return
        owner, account_key, origin, token = context
        if _scan.context != context[:3]:
            reset()
            _scan.context = context[:3]
        if not _scan.local_done:
            scan_local(owner, account_key, origin)
        if now - _scan.remote_at >= REMOTE_EVERY_S:
            _scan.remote_at = now
            scan_remote(owner, account_key, origin, token)
