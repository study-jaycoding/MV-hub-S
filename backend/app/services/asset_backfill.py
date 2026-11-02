"""전송 줄 보충 — 이동 입구가 줄을 못 만든 결과를 일꾼이 찾아 잇는다.

옛 결과·입력(줄·보관본·내용 ID 가 없다)과 서버에서 옮겨진 공유물(허브의 로컬 행이 안 바뀐다)을 다룬다. 줄은 ledger.queue_moved_outputs 로만 만든다.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import time
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .. import active_account, config, db
from ..repo import asset_sync as ledger
from . import asset_io, asset_paths, shared_connection
from .path_safety import safe_join

SCAN_BATCH = 50
REMOTE_EVERY_S = 60
REMOTE_TIMEOUT_S = 15
LOCAL_EVERY_S = 3600  # 한 바퀴를 끝낸 뒤 다시 도는 간격 — 되살린 파일·일시 오류를 앱을 다시 켜지 않아도 잡는다
DISK_RESERVE = 2 * 1024 ** 3  # 사본을 만든 뒤에도 남겨 둘 여유 공간
SNAPSHOT_FOLDER = 'asset-snapshots'  # 어셋 탭에 안 보이는 데이터 폴더 — 지문이 이름이라 폴더를 훑지 않고 같은 내용은 한 벌뿐이다
_COMFY_INPUT = re.compile(r'/api/comfy/inputs/([a-f0-9]{16})/([a-f0-9]{64}\.[a-z0-9]{1,8})')

_stop = threading.Event()
_rescan = threading.Event()


class _Stopped(Exception):
    """앱이 꺼진다 — 이 파일은 건너뛴 것이 아니다. 다음 실행이 이어 본다."""


class _NoRoom(Exception):
    """디스크 여유가 모자란다 — 이 차례를 멈추고 다음 바퀴에 다시 본다."""


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
    epoch: int = -1
    local_after: int = 0
    input_after: int = 0
    local_done: bool = False
    local_done_at: float = 0.0
    remote_after: int = 0
    remote_at: float = 0.0
    skipped: set = field(default_factory=set)  # 이번 바퀴에 못 고친 결과·입력(파일 없음 등) — 차례를 다시 막지 않게


_scan = _Scan()


def reset() -> None:
    global _scan
    _scan = _Scan()


def request_stop() -> None:
    """앱이 꺼진다 — 복사는 조각 하나 안에 멈춘다. 종료 정리의 첫 동작이어야 앞선 정리가 늦어도 큰 파일을 끝까지 안 붙잡는다."""
    _stop.set()


def clear_stop() -> None:
    _stop.clear()


def request_rescan() -> None:
    """다음 차례에 처음부터 다시 돈다 — 도는 차례의 커서·건너뜀을 다른 스레드가 건드리지 않게 표식만 세운다."""
    _rescan.set()


def skipped_count(owner: str, account_key: str, origin: str) -> int:
    """보충이 못 고친 수 — 지금 계정·서버의 차례일 때만. A→B→A 는 이름이 같아도 다른 차례다."""
    scan = _scan
    return len(scan.skipped) if scan.context == (owner, account_key, origin) and scan.epoch == active_account.account_epoch() else 0


def rescanning(owner: str, account_key: str, origin: str) -> bool:
    """다시 보는 중이다 — 건너뛴 수가 아직 최종이 아니라 설정 줄이 끝날 때까지 다시 묻는다."""
    scan = _scan
    return _rescan.is_set() or (scan.context == (owner, account_key, origin) and scan.epoch == active_account.account_epoch() and not scan.local_done)


def _context():
    owner = active_account.active_uid()
    token = shared_connection.token()
    if not owner or not token:
        return None
    return owner, active_account.account_key() or '', shared_connection.base_url(), token


def _still(owner: str, account_key: str, origin: str) -> bool:
    """복사·조회 뒤 문맥이 그대로인가 — 바뀌었으면 옛 문맥의 답을 적용하지 않는다. 차례 안에서는 계정이 고정돼 uid 비교로는 전환이 안 보여 세대를 함께 본다."""
    context = _context()
    return context is not None and context[:3] == (owner, account_key, origin) and active_account.account_epoch() == _scan.epoch


def _local_path(file_path: str) -> Optional[Path]:
    """이 PC 디스크의 결과·입력 주소를 파일 경로로 — 등록 폴더·프로젝트 폴더는 요청 문맥이 있어야 풀리고 끊긴 NAS 를 건드릴 수 있어 None."""
    if file_path.startswith('/media/'):
        return safe_join(config.MEDIA_DIR, file_path[len('/media/'):])
    match = _COMFY_INPUT.fullmatch(file_path)
    if match:
        return safe_join(config.MEDIA_DIR.parent / 'comfy-inputs', match[1] + '/' + match[2])
    if file_path.startswith('asset:') and '|' in file_path:
        project, rel = file_path[len('asset:'):].split('|', 1)
        if project in asset_paths.INTERNAL_FOLDERS:
            return safe_join(config.ASSETS_ROOT / project, rel)
        if project == asset_paths.COMBINED_INTERNAL_PROJECT and rel.partition('/')[0] in asset_paths.INTERNAL_FOLDERS:
            return safe_join(config.ASSETS_ROOT, rel)
    return None


def _in_managed_folder(path: Path) -> bool:
    """captures·imports 안의 파일 — 이미 앱이 관리하는 자리라 사본을 만들면 어셋 탭에 같은 그림이 는다."""
    return any(path.resolve().is_relative_to((config.ASSETS_ROOT / folder).resolve()) for folder in asset_paths.INTERNAL_FOLDERS)


def _read(path: Path, *, copy: bool) -> Optional[tuple[Optional[Path], str, int, str]]:
    """지문을 잰다. copy 면 임시 파일에 바이트를 고정한다 — 검사를 지나기 전에는 임시 파일뿐이라 거절돼도 폴더에 안 남는다.
    트랜잭션 밖에서 부른다(큰 영상 복사가 쓰기 잠금을 쥐면 안 된다). 조각마다 멈춤을 본다 — 멈춘 NAS 읽기 자체는 못 끊는다."""
    kind = asset_io.media_type(path.name)
    total = path.stat().st_size
    if not kind or total > asset_io.UPLOAD_MAX_BYTES:
        return None
    tmp = None
    output = None
    if copy:
        dest = config.MEDIA_DIR.parent / SNAPSHOT_FOLDER
        dest.mkdir(parents=True, exist_ok=True)
        if shutil.disk_usage(dest).free < total + DISK_RESERVE:
            raise _NoRoom()
        tmp = dest / ('.snapshot-' + uuid.uuid4().hex + '.part')
        output = tmp.open('xb')
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open('rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                if _stop.is_set():
                    raise _Stopped()
                size += len(chunk)
                if size > asset_io.UPLOAD_MAX_BYTES:
                    raise ValueError('asset_too_large')
                digest.update(chunk)
                if output:
                    output.write(chunk)
        if not size:
            raise ValueError('asset_empty')
        if output:
            output.close()
            output = None
        return tmp, digest.hexdigest(), size, kind
    except BaseException:
        if output:
            output.close()
        if tmp:
            tmp.unlink(missing_ok=True)
        raise


def _settle(conn, tmp: Path, digest: str, suffix: str, size: int, owner: str) -> Path:
    """검사를 지난 임시 파일을 지문 이름으로 둔다 — 같은 내용이 이미 있으면 그것을 쓴다(폴더를 훑지 않는다). 확장자가 달라도 원장으로 같은 내용을 찾는다."""
    kept = _kept_path(conn, owner, 'sha256:' + digest)
    if kept:
        tmp.unlink(missing_ok=True)
        return kept
    target = tmp.parent / (digest + suffix)
    if target.is_file() and target.stat().st_size == size:
        tmp.unlink(missing_ok=True)
    else:
        os.replace(tmp, target)
    return target


def _adopt_output(row, owner: str, account_key: str, origin: str) -> bool:
    """내용 ID 나 보관본이 없는 옛 결과를 원장에 올린다. 복사 뒤 그 행이 그대로인지 다시 보고, 등록과 ID 채움을 한 트랜잭션으로 한다."""
    path = _local_path(row['file_path'])
    if path is None or not path.is_file():
        return False
    read = _read(path, copy=True)
    if read is None:
        return False
    tmp, digest, size, kind = read
    content = 'sha256:' + digest
    try:
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
            saved = _settle(conn, tmp, digest, path.suffix.lower(), size, owner)
            ledger.register_local(conn, path=saved, file_path=row['file_path'], digest=digest, size=size, media_type=kind,
                                  owner_uid=owner, project_id='', server_origin=origin, original_name=path.name, account_key=account_key)
            conn.execute('UPDATE asset SET asset_content_id=? WHERE id=? AND asset_content_id IS NULL', (content, row['asset_id']))
        return True
    finally:
        tmp.unlink(missing_ok=True)


def _adopt_input(row, owner: str, account_key: str, origin: str) -> bool:
    """옛 입력을 원장에 올린다. 소유 근거는 내 생성물에 연결된 입력 행이다 — 원장에 줄이 없어 라우터의 소유 확인은 쓸 수 없다.
    captures·imports 안의 파일은 그 자리를 보관본으로 쓴다. 같이 쓰는 행은 이 생성물 몫을 복제해 채운다."""
    path = _local_path(row['file_path'])
    if path is None or not path.is_file():
        return False
    managed = _in_managed_folder(path)
    read = _read(path, copy=not managed)
    if read is None:
        return False
    tmp, digest, size, kind = read
    content = 'sha256:' + digest
    try:
        if ((row['asset_content_id'] and row['asset_content_id'] != content) or (row['content_sha'] and row['content_sha'] != digest)
                or (row['content_bytes'] is not None and row['content_bytes'] != size)):
            return False  # 기록한 바이트와 다르다
        with db.get_connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            if not _still(owner, account_key, origin):
                return True
            current = conn.execute(
                f'SELECT r.file_path,r.asset_content_id,r.content_sha,r.content_bytes,g.creator_uid,g.deleted_at,g.project_id,{_LOCAL_INPUT} local_only FROM gen_reference gr '
                'JOIN reference r ON r.id=gr.reference_id JOIN generation g ON g.id=gr.generation_id WHERE gr.generation_id=? AND gr.reference_id=? LIMIT 1',
                (row['gid'], row['reference_id'])).fetchone()
            if (current is None or current['deleted_at'] or current['creator_uid'] != owner or not current['local_only']
                    or any(current[name] != row[name] for name in ('file_path', 'asset_content_id', 'content_sha', 'content_bytes', 'project_id'))):
                return False  # 복사하는 사이 행이 바뀌었다 — 처음 읽은 값으로 판단한 결과를 쓰지 않는다
            saved = path if managed else _settle(conn, tmp, digest, path.suffix.lower(), size, owner)
            ledger.register_local(conn, path=saved, file_path=row['file_path'], digest=digest, size=size, media_type=kind,
                                  owner_uid=owner, project_id='', server_origin=origin, original_name=path.name, account_key=account_key)
            if not row['asset_content_id']:
                reference = ledger.own_reference(conn, row['gid'], row['reference_id'], {owner})
                conn.execute('UPDATE reference SET asset_content_id=? WHERE id=? AND asset_content_id IS NULL', (content, reference))
        return True
    finally:
        if tmp:
            tmp.unlink(missing_ok=True)


_LOCAL_INPUT = ("r.file_path NOT LIKE 'http%' AND COALESCE(r.source_url,'') NOT LIKE 'http%' AND COALESCE(r.share_url,'') NOT LIKE 'http%'")


def _local_candidates(conn, owner: str, after: int):
    """프로젝트가 있는 내 로컬 결과를 차례로 — 이미 다 된 행은 줄 함수가 아무것도 안 하므로 거르지 않는다."""
    return conn.execute(
        "SELECT a.rowid seq,g.id gid,g.project_id,a.id asset_id,a.file_path,a.asset_content_id FROM asset a "
        "JOIN generation g ON g.id=a.generation_id LEFT JOIN project p ON p.id=g.project_id "
        "WHERE g.creator_uid=? AND g.deleted_at IS NULL AND COALESCE(g.project_id,'')<>'' AND COALESCE(p.archived,0)=0 "
        "AND a.file_path NOT LIKE 'http%' AND COALESCE(a.source_url,'') NOT LIKE 'http%' AND a.rowid>? "
        "ORDER BY a.rowid LIMIT ?", (owner, after, SCAN_BATCH)).fetchall()


def _generation_inputs(conn, gid: str):
    """그 생성물의 로컬 입력 — 원격 주소가 있으면 그 주소로 받을 수 있어 건드리지 않는다."""
    return conn.execute(
        f"SELECT g.id gid,g.project_id,r.id reference_id,r.file_path,r.asset_content_id,r.content_sha,r.content_bytes FROM gen_reference gr "
        f"JOIN reference r ON r.id=gr.reference_id JOIN generation g ON g.id=gr.generation_id WHERE gr.generation_id=? AND {_LOCAL_INPUT} "
        "ORDER BY gr.rowid", (gid,)).fetchall()


def _local_input_generations(conn, owner: str, after: int):
    """로컬 입력을 쓰는 내 생성물을 차례로 — 결과가 원격 주소인 생성물도 입력은 여기서 본다."""
    return conn.execute(
        "SELECT MIN(gr.rowid) seq,g.id gid,g.project_id FROM gen_reference gr JOIN reference r ON r.id=gr.reference_id "
        "JOIN generation g ON g.id=gr.generation_id LEFT JOIN project p ON p.id=g.project_id "
        f"WHERE g.creator_uid=? AND g.deleted_at IS NULL AND COALESCE(g.project_id,'')<>'' AND COALESCE(p.archived,0)=0 AND {_LOCAL_INPUT} AND gr.rowid>? "
        "GROUP BY g.id ORDER BY seq LIMIT ?", (owner, after, SCAN_BATCH)).fetchall()


def _kept_path(conn, owner: str, content: str) -> Optional[Path]:
    """보관본이 원장에 있고 파일도 있다 — 원장 ready 만 믿으면 지워진 보관본을 원본이 되살아나도 다시 못 만든다."""
    row = conn.execute("SELECT path FROM asset_location WHERE kind='local' AND state='ready' AND owner_uid=? AND asset_content_id=? LIMIT 1",
                       (owner, content)).fetchone()
    return Path(row['path']) if row and Path(row['path']).is_file() else None


def _queue(gid: str, project_id: str, owner: str, account_key: str, origin: str) -> bool:
    """줄은 쓰기 잠금 안에서 문맥을 다시 본 뒤 만든다 — 잠금을 기다리는 사이 서버가 바뀔 수 있다."""
    with db.get_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        if not _still(owner, account_key, origin):
            return False
        ledger.queue_moved_outputs(conn, [gid], project_id, (account_key, origin))
    return True


def _bring_up(row, owner: str, account_key: str, origin: str) -> bool:
    """파일을 읽으러 갔으면 참(성공·실패 무관) — 그동안 시간이 흘렀다는 뜻이다. 이미 됐거나 건너뛴 행은 바로 거짓이다."""
    key = ('asset', row['asset_id'])
    if key in _scan.skipped:
        return False
    with db.get_connection() as conn:
        if row['asset_content_id'] and _kept_path(conn, owner, row['asset_content_id']):
            return False
    try:
        if _adopt_output(row, owner, account_key, origin):
            return True
    except (OSError, ValueError):
        pass  # 이 파일만 건너뛴다 — 뒤 행을 계속 본다
    _scan.skipped.add(key)
    return True


def _bring_up_input(row, owner: str, account_key: str, origin: str) -> bool:
    key = ('input', row['gid'], row['reference_id'])
    if key in _scan.skipped or _local_path(row['file_path']) is None:
        return False  # 등록 폴더·프로젝트 폴더의 입력은 이 일꾼의 몫이 아니다
    with db.get_connection() as conn:
        if row['asset_content_id'] and _kept_path(conn, owner, row['asset_content_id']):
            return False
    try:
        if _adopt_input(row, owner, account_key, origin):
            return True
    except (OSError, ValueError):
        pass
    _scan.skipped.add(key)
    return True


def scan_local(owner: str, account_key: str, origin: str) -> None:
    """한 번에 한 묶음씩 결과 다음 입력. 복사가 끝난 뒤 계정·서버가 바뀌었으면 tick 이 문맥을 새로 잡고 처음부터 본다."""
    with db.get_connection() as conn:
        rows = _local_candidates(conn, owner, _scan.local_after)
        generations = [] if rows else _local_input_generations(conn, owner, _scan.input_after)
    if not rows and not generations:
        _scan.local_done = True
        return
    for row in rows:
        _bring_up(row, owner, account_key, origin)
        if not _queue(row['gid'], row['project_id'], owner, account_key, origin):
            return
        _scan.local_after = row['seq']
    for generation in generations:
        with db.get_connection() as conn:
            inputs = _generation_inputs(conn, generation['gid'])
        for row in inputs:
            _bring_up_input(row, owner, account_key, origin)
        if not _queue(generation['gid'], generation['project_id'], owner, account_key, origin):
            return
        _scan.input_after = generation['seq']


def _shared_candidates(conn, owner: str, after: int):
    return conn.execute(
        "SELECT DISTINCT g.rowid seq,g.id gid,COALESCE(g.job_id,g.id) anchor FROM generation g JOIN share s ON s.generation_id=g.id "
        "WHERE g.creator_uid=? AND g.deleted_at IS NULL AND g.rowid>? AND (EXISTS(SELECT 1 FROM asset a WHERE a.generation_id=g.id "
        "AND a.file_path NOT LIKE 'http%' AND COALESCE(a.source_url,'') NOT LIKE 'http%') OR EXISTS(SELECT 1 FROM gen_reference gr "
        f"JOIN reference r ON r.id=gr.reference_id WHERE gr.generation_id=g.id AND {_LOCAL_INPUT})) "
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
    for index, row in enumerate(rows):
        item = items.get(row['anchor'])
        project_id = item.get('project_id') if isinstance(item, dict) else None
        if not project_id or not _still(owner, account_key, origin):
            continue
        with db.get_connection() as conn:
            outputs = conn.execute("SELECT id asset_id,file_path,asset_content_id FROM asset WHERE generation_id=? AND file_path NOT LIKE 'http%'",
                                   (row['gid'],)).fetchall()
            inputs = _generation_inputs(conn, row['gid'])
        worked = [_bring_up(output, owner, account_key, origin) for output in outputs]
        worked += [_bring_up_input(reference, owner, account_key, origin) for reference in inputs]
        if not _still(owner, account_key, origin):
            return  # 복사 중 서버가 바뀌었다 — 옛 서버의 프로젝트를 새 서버 줄로 만들지 않는다
        if any(worked):  # 파일을 읽는 동안(실패해도) 서버에서 또 옮겼을 수 있고 남은 행의 답도 낡았다 — 쓰기 잠금 밖에서 한 번에 다시 묻는다. 못 받으면 다음 바퀴에 본다
            items = _remote_items(origin, token, [later['anchor'] for later in rows[index:]])
            item = items.get(row['anchor'])
            if not _still(owner, account_key, origin):
                return
            if not isinstance(item, dict) or item.get('project_id') != project_id:
                continue
        if not _queue(row['gid'], project_id, owner, account_key, origin):
            return
        _link_blanks(item, row, project_id, owner, origin, token)


def _rewind_local() -> None:
    _scan.local_after = _scan.input_after = 0
    _scan.local_done = False
    _scan.skipped.clear()


def missing_files(generation_ids: list[str], project_id: str) -> int:
    """옮겨도 보낼 바이트가 이 PC 에 없는 결과·입력 수 — 이 PC 디스크 주소만 본다. 등록 폴더·네트워크 경로는 세지 않아 끊긴 NAS 가 이동 응답을 붙잡지 않는다."""
    if not generation_ids:
        return 0
    names = {f'g{index}': gid for index, gid in enumerate(generation_ids)}
    placeholders = ','.join(':' + name for name in names)
    chosen = f'(g.id IN ({placeholders}) OR g.job_id IN ({placeholders})) AND g.deleted_at IS NULL'
    with db.get_connection() as conn:
        rows = conn.execute(
            "SELECT g.creator_uid owner,a.file_path,a.asset_content_id content FROM generation g JOIN asset a ON a.generation_id=g.id "
            f"WHERE {chosen} AND a.file_path NOT LIKE 'http%' AND COALESCE(a.source_url,'') NOT LIKE 'http%' "
            "UNION SELECT g.creator_uid,r.file_path,r.asset_content_id FROM gen_reference gr JOIN reference r ON r.id=gr.reference_id "
            f"JOIN generation g ON g.id=gr.generation_id WHERE {chosen} AND {_LOCAL_INPUT}", names).fetchall()
        missing = 0
        for row in rows:
            path = _local_path(row['file_path'])
            if path is None or path.is_file():
                continue
            if row['content'] and _kept_path(conn, row['owner'], row['content']):
                continue
            missing += 1
    return missing


def tick(now: Optional[float] = None) -> None:
    """일꾼이 돌 때마다 부른다. 로컬 보충은 한 바퀴를 끝내면 1시간 뒤에 다시, 서버 대조는 60초마다 한 묶음."""
    now = time.time() if now is None else now
    with db.pinned_share_operation():
        context = _context()
        if context is None:
            return
        owner, account_key, origin, token = context
        epoch = active_account.account_epoch()
        if _scan.context != context[:3] or _scan.epoch != epoch:
            reset()
            _scan.context = context[:3]
            _scan.epoch = epoch
        if _rescan.is_set() or (_scan.local_done and now - _scan.local_done_at >= LOCAL_EVERY_S):
            _rewind_local()  # 되감은 뒤에 표식을 내린다 — 그사이 상태를 물어도 다 끝난 것으로 안 보인다
            _rescan.clear()
        try:
            if not _scan.local_done:
                scan_local(owner, account_key, origin)
                if _scan.local_done:
                    _scan.local_done_at = now
            if now - _scan.remote_at >= REMOTE_EVERY_S:
                _scan.remote_at = now
                scan_remote(owner, account_key, origin, token)
        except _Stopped:
            return
        except _NoRoom:
            _scan.local_done = True  # 이 차례를 멈춘다 — 공간이 생기면 다음 바퀴에 이어진다
            _scan.local_done_at = now
