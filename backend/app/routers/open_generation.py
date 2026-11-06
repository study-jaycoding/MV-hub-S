"""Local-only, user-initiated navigation with one claim and an account-bound acknowledgement."""
from __future__ import annotations

import asyncio
import hashlib
import html
import json
import os
import re
import secrets
import time
from urllib.parse import parse_qs

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse

from .. import active_account, config, deps
from ..services import app_windows, shared_connection, open_link
from ..services.request_guards import require_loopback_request
from ..ws import manager

router = APIRouter(tags=['open-generation'])
_pending = {}
_last_open = 0.0
_ID = re.compile(r'^[A-Za-z0-9_.:-]{1,200}$')
_MARKER = re.compile(r'^MVHubOpen-[0-9a-f-]{36}$')
ACK_TIMEOUT = 3
FIND_TIMEOUT = 0.6
LIFT_TIMEOUT = 0.2
FOUND_TIMEOUT = 1
PREPARE_TIMEOUT = 2  # Leave room for acknowledgement + lookup + handler focus within 8 seconds.


def _guard(request, *, post=False):
    require_loopback_request(request, '이 PC 에서만 열 수 있습니다')
    values = request.headers.getlist('host')
    # Hub windows opened as localhost:<port> must claim too (2026-11-05 live test: a localhost window was refused).
    if len(values) != 1 or values[0] not in (f'127.0.0.1:{config.PORT}', f'localhost:{config.PORT}'):
        raise HTTPException(403, '이 PC 에서만 열 수 있습니다')
    if 'prefetch' in (request.headers.get('purpose', '') + request.headers.get('sec-purpose', '')).lower():
        raise HTTPException(403, '자동으로 열 수 없습니다')
    if post and (request.headers.get('origin') != f'http://{values[0]}'
                 or request.headers.get('sec-fetch-site') != 'same-origin'):
        raise HTTPException(403, '다른 사이트에서 열 수 없습니다')


def _account(request):
    if config.AUTH_ENABLED:
        account = deps.current_account(request)
        if not account:
            raise HTTPException(401, '로그인이 필요합니다')
        return ('server', account['email'], account.get('password_changed_at')), deps.realtime_scope(account)
    token_digest = hashlib.sha256((shared_connection.token() or '').encode()).hexdigest()
    return (active_account.account_key(), shared_connection.base_url(), token_digest), None


def _page(text, form=''):
    return HTMLResponse('<!doctype html><html lang="ko"><meta charset="utf-8"><title>MV Hub</title><body>'
                        '<p>' + html.escape(text) + '</p>' + form + '</body></html>',
                        headers={'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
                                 'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'"})


async def _open_core(gen_id, comment_id, request, *, native=False):
    global _last_open
    if not _ID.fullmatch(gen_id) or not _ID.fullmatch(comment_id):
        raise HTTPException(400, '열기 주소가 올바르지 않습니다')
    if config.AUTH_ENABLED:
        return {'result': 'unsupported', 'hwnd': 0}
    now = time.monotonic()
    if now - _last_open < 2:
        return {'result': 'busy', 'hwnd': 0}
    _last_open = now
    prepare_deadline = now + PREPARE_TIMEOUT
    try:
        account, scope = await asyncio.wait_for(asyncio.to_thread(_account, request), PREPARE_TIMEOUT)
    except TimeoutError:
        return {'result': 'no_window', 'hwnd': 0}
    open_id = secrets.token_urlsafe(24)
    entry = {'account': account, 'window': None, 'event': asyncio.Event(), 'found': asyncio.Event(),
             'accepted': False, 'active': True, 'ok': False, 'hwnd': 0, 'native': native,
             'expires': prepare_deadline + ACK_TIMEOUT, 'gen_id': gen_id, 'comment_id': comment_id}
    _pending[open_id] = entry
    try:
        try:
            await asyncio.wait_for(manager.broadcast({'type': 'open_generation', 'generation_id': gen_id,
                                     'comment_id': comment_id, 'open_id': open_id}, account_uid=scope),
                                   max(0.001, prepare_deadline - time.monotonic()))
        except TimeoutError:
            return {'result': 'no_window', 'hwnd': 0}
        # An early client may claim during broadcast. Once broadcast finishes,
        # claim/ack and the waiter must share the same full three-second window.
        entry['expires'] = time.monotonic() + ACK_TIMEOUT
        try:
            await asyncio.wait_for(entry['event'].wait(), timeout=max(0, entry['expires'] - time.monotonic()))
        except TimeoutError:
            return {'result': 'no_window', 'hwnd': 0}
        try:
            await asyncio.wait_for(entry['found'].wait(), timeout=FOUND_TIMEOUT)
        except TimeoutError:
            pass  # A successful panel open remains successful without a focus target.
        return {'result': 'opened' if entry['ok'] else 'denied', 'hwnd': entry['hwnd']}
    finally:
        entry['active'] = False
        _pending.pop(open_id, None)


async def _open(gen_id, comment_id, request):
    result = await _open_core(gen_id, comment_id, request)
    if result['result'] == 'busy':
        raise HTTPException(429, '잠시 뒤 다시 눌러 주세요')
    messages = {
        'opened': 'MV hub 에서 열었어요. 이 탭은 닫아도 돼요.',
        'denied': '열지 못했어요. 이 계정에서 볼 수 있는 코멘트인지 확인해 주세요.',
        'no_window': 'MV hub 창이 꺼져 있거나 응답이 없어요',
        'unsupported': '로컬 MV hub 에서 열어 주세요.',
    }
    return _page(messages[result['result']])


@router.post('/api/open/native')
async def open_native(request: Request):
    current = open_link.session
    if config.AUTH_ENABLED or os.environ.get('MVHUB_OPEN_LINK') != '1' or current is None:
        raise HTTPException(404, '지원하지 않는 요청입니다')
    require_loopback_request(request, '이 PC 에서만 열 수 있습니다')
    hosts = request.headers.getlist('host')
    if len(hosts) != 1 or hosts[0] not in (f'127.0.0.1:{config.PORT}', f'localhost:{config.PORT}'):
        raise HTTPException(403, '이 PC 에서만 열 수 있습니다')
    try:
        raw = bytearray()
        async for part in request.stream():
            raw.extend(part)
            if len(raw) > 4096:
                raise ValueError('oversize')
        body = json.loads(raw)
        if any(len(request.headers.getlist(name)) != 1 for name in
               ('x-mvhub-open-time', 'x-mvhub-open-nonce', 'x-mvhub-open-sig')):
            raise ValueError('duplicate headers')
        nonce, admitted = current.authenticate(request.headers, body)
    except (ValueError, TypeError):
        raise HTTPException(401, '열기 요청을 확인하지 못했습니다') from None
    if not admitted:
        # Capacity never recovers under this key: the handler's generic HTTP-error
        # notice asks for a restart. Still sign busy so no unsigned result escapes.
        return JSONResponse(current.response(nonce, 'busy'), status_code=503)
    else:
        result = await _open_core(body['generation_id'], body['comment_id'], request, native=True)
    return current.response(nonce, **result)


@router.get('/api/open/generation/{gen_id}')
async def open_get(gen_id: str, request: Request, c: str = ''):
    _guard(request)
    human = (request.headers.get('sec-fetch-mode') == 'navigate'
             and request.headers.get('sec-fetch-dest') == 'document'
             and request.headers.get('sec-fetch-user') == '?1')
    if not human:
        if not _ID.fullmatch(gen_id) or not _ID.fullmatch(c):
            raise HTTPException(400, '열기 주소가 올바르지 않습니다')
        form = ('<form method="post" action="/api/open/generation/' + html.escape(gen_id, quote=True) + '">'
                '<input type="hidden" name="comment_id" value="' + html.escape(c, quote=True) + '">'
                '<button type="submit">MV hub에서 열기</button></form>')
        return _page('아래 단추를 눌러 MV hub에서 확인하세요.', form)
    return await _open(gen_id, c, request)


@router.post('/api/open/generation/{gen_id}')
async def open_post(gen_id: str, request: Request):
    _guard(request, post=True)
    body = (await request.body()).decode('utf-8', errors='replace')
    if len(body) > 1024:
        raise HTTPException(400, '입력 형식이 올바르지 않습니다')
    return await _open(gen_id, parse_qs(body).get('comment_id', [''])[0], request)


async def _entry(request):
    _guard(request, post=True)
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, '입력 형식이 올바르지 않습니다') from None
    if not isinstance(body, dict):
        raise HTTPException(400, '입력 형식이 올바르지 않습니다')
    entry = _pending.get(body.get('open_id')) if isinstance(body.get('open_id'), str) else None
    account, _ = await asyncio.to_thread(_account, request)
    expected = request.headers.get(deps.EXPECT_ACCOUNT_HEADER)
    owner = account[1] if config.AUTH_ENABLED else account[0]
    if expected and deps.expected_account_differs(request, owner or ''):
        raise HTTPException(409, '화면과 허브의 계정이 다릅니다')
    if not entry or not entry['active'] or entry['expires'] < time.monotonic() or entry['account'] != account:
        raise HTTPException(409, '열기 요청이 끝났거나 계정이 바뀌었습니다')
    window = body.get('window_id')
    if not isinstance(window, str) or not 1 <= len(window) <= 120:
        raise HTTPException(400, '창을 확인하지 못했습니다')
    return entry, body, window


@router.post('/api/open/claim')
async def claim(request: Request):
    entry, body, window = await _entry(request)
    # No await between checking and claiming: all handlers run on the same loop.
    if entry['window'] is not None:
        raise HTTPException(409, '다른 창에서 열고 있습니다')
    entry['window'] = window
    # 남은 받기 시간을 알려 준다 — 화면이 방송을 늦게 처리했어도 허브 기한 안에서만 열게(Codex 리뷰 P2).
    #  방송 중에 온 claim 은 기한이 '방송 끝 + 3초'로 다시 정해지므로 '지금 + 3초'가 넘지 않는 아래 값이다.
    now = time.monotonic()
    return {'ok': True, 'remaining_ms': int(max(0.0, min(entry['expires'], now + ACK_TIMEOUT) - now) * 1000)}


@router.post('/api/open/ack')
async def ack(request: Request):
    entry, body, window = await _entry(request)
    if entry['window'] != window or entry['accepted'] or not isinstance(body.get('ok'), bool):
        raise HTTPException(409, '열기 요청이 일치하지 않습니다')
    entry['ok'] = body['ok']
    entry['accepted'] = True
    entry['marker'] = body.get('marker')
    entry['event'].set()
    # 연 창이 제목을 잠깐 표식으로 바꿔 두었다 — 그 창(앱 창)을 맨 앞으로 올린 뒤 답한다(답을 받으면 창이 제목을 돌려놓는다). Jay 2026-11-05 시안 v4
    marker = entry['marker']
    raised = 0
    try:
        if body['ok'] and isinstance(marker, str) and _MARKER.fullmatch(marker) and os.name == 'nt' \
                and not shared_connection.is_shared_team_server():
            hits = await asyncio.wait_for(asyncio.to_thread(app_windows.find_marked, marker), FIND_TIMEOUT)
            if entry['active']:
                if len(hits) == 1:
                    entry['hwnd'] = hits[0][0]
                selected = hits if not entry['native'] or len(hits) == 1 else []
                # A hung window must not block the hub loop; the worker rechecks
                # lifetime before each call, including after a slow restore.
                await asyncio.wait_for(asyncio.to_thread(app_windows.lift_marked, selected,
                    active=lambda: entry['active'] and not entry['found'].is_set()), LIFT_TIMEOUT)
                raised = len(hits) if not entry['native'] or len(hits) == 1 else 0
    except Exception:  # noqa: BLE001 — focus failures cannot undo opening
        raised = 0
    finally:
        entry['found'].set()
    return {'ok': True, 'raised': raised}
