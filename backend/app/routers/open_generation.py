"""Local-only, user-initiated navigation with one claim and an account-bound acknowledgement."""
from __future__ import annotations

import asyncio
import hashlib
import html
import re
import secrets
import time
from urllib.parse import parse_qs

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse

from .. import active_account, config, deps
from ..services import shared_connection
from ..services.request_guards import require_loopback_request
from ..ws import manager

router = APIRouter(tags=['open-generation'])
_pending = {}
_last_open = 0.0
_ID = re.compile(r'^[A-Za-z0-9_.:-]{1,200}$')


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


async def _open(gen_id, comment_id, request):
    global _last_open
    if not _ID.fullmatch(gen_id) or not _ID.fullmatch(comment_id):
        raise HTTPException(400, '열기 주소가 올바르지 않습니다')
    now = time.monotonic()
    if now - _last_open < 2:
        raise HTTPException(429, '잠시 뒤 다시 눌러 주세요')
    _last_open = now
    account, scope = await asyncio.to_thread(_account, request)
    open_id = secrets.token_urlsafe(24)
    entry = {'account': account, 'window': None, 'event': asyncio.Event(), 'ok': False,
             'expires': now + 3, 'gen_id': gen_id, 'comment_id': comment_id}
    _pending[open_id] = entry
    try:
        await manager.broadcast({'type': 'open_generation', 'generation_id': gen_id,
                                 'comment_id': comment_id, 'open_id': open_id}, account_uid=scope)
        try:
            await asyncio.wait_for(entry['event'].wait(), timeout=3)
        except TimeoutError:
            return _page('MV hub 창이 꺼져 있거나 응답이 없어요')
        return _page('MV hub 에서 열었어요. 이 탭은 닫아도 돼요.' if entry['ok'] else
                     '열지 못했어요. 이 계정에서 볼 수 있는 코멘트인지 확인해 주세요.')
    finally:
        _pending.pop(open_id, None)


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
    if not entry or entry['expires'] < time.monotonic() or entry['account'] != account:
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
    return {'ok': True}


@router.post('/api/open/ack')
async def ack(request: Request):
    entry, body, window = await _entry(request)
    if entry['window'] != window or entry['event'].is_set() or not isinstance(body.get('ok'), bool):
        raise HTTPException(409, '열기 요청이 일치하지 않습니다')
    entry['ok'] = body['ok']
    entry['event'].set()
    return {'ok': True}
