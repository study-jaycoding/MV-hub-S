"""Slack account linking and server-local administration."""
from __future__ import annotations

import asyncio
from contextlib import contextmanager

from fastapi import APIRouter, HTTPException, Request, Response

from .. import active_account, config, deps, rbac, repo
from ..emailnorm import norm_email
from ..services import slack_client as client, slack_link
from ..services.async_tools import to_thread_non_abandon
from ..services.request_guards import require_local_browser_context, require_local_machine_request
from ..services.slack_notify import notifier
from . import _proxy

router = APIRouter(tags=['slack'])


async def _body(request):
    # Secrets and codes must never appear in pydantic's validation echo.
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, '입력 형식이 올바르지 않습니다') from None
    if not isinstance(body, dict):
        raise HTTPException(400, '입력 형식이 올바르지 않습니다')
    return body


@contextmanager
def _account(request):
    if config.AUTH_ENABLED:
        account = deps.current_account(request)
        if not account:
            raise HTTPException(401, '로그인이 필요합니다')
        deps.assert_account_current(account)
        yield account['email'], False
        return
    require_local_browser_context(request, '다른 사이트의 요청이라 막았습니다')
    with active_account.pinned_account_scope() as key:
        email = norm_email(key)
        expected = request.headers.get(deps.EXPECT_ACCOUNT_HEADER, '')
        if not expected or deps.expected_account_differs(request, email):
            raise HTTPException(409, '화면과 허브의 계정이 달라 멈췄습니다. 새로 고쳐 주세요.')
        if not _proxy.proxying():
            raise HTTPException(409, '공유 서버에 로그인해 주세요')
        with _proxy.pinned_connection((_proxy.base_url(), _proxy.token())):
            yield email, True


def _link_request(request, method, path, body=None):
    with _account(request) as (email, relay):
        if relay:
            return _proxy.proxy_json(method, path, body=body)
        try:
            if method == 'GET':
                return slack_link.status(email)
            if method == 'DELETE':
                return slack_link.unlink(email)
            if path.endswith('/start'):
                return slack_link.start(email, body['slack_email'])
            return slack_link.verify(email, body['code'])
        except (slack_link.LinkError, client.SlackError) as exc:
            if isinstance(exc, client.SlackError):
                text = 'Slack 요청을 처리하지 못했습니다. 관리자에게 연결 상태를 확인해 주세요'
            else:
                text = str(exc)
            raise HTTPException(400, text) from None


@router.get('/api/slack/link')
def get_link(request: Request, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    return _link_request(request, 'GET', '/api/slack/link')


@router.post('/api/slack/link/start')
async def start_link(request: Request):
    body = await _body(request)
    value = body.get('slack_email')
    if not isinstance(value, str) or len(value) > 320:
        raise HTTPException(400, 'Slack 이메일을 확인해 주세요')
    return await to_thread_non_abandon(_link_request, request, 'POST', '/api/slack/link/start', {'slack_email': value})


@router.post('/api/slack/link/verify')
async def verify_link(request: Request):
    body = await _body(request)
    code = body.get('code')
    if not isinstance(code, str) or len(code) != 6 or not code.isascii() or not code.isdecimal():
        raise HTTPException(400, '6자리 확인 코드를 입력해 주세요')
    return await to_thread_non_abandon(_link_request, request, 'POST', '/api/slack/link/verify', {'code': code})


@router.delete('/api/slack/link')
def delete_link(request: Request):
    return _link_request(request, 'DELETE', '/api/slack/link')


def _admin(request):
    if not config.AUTH_ENABLED:
        raise HTTPException(404, 'Not Found')
    require_local_machine_request(request, '서버 PC 에서만 쓸 수 있습니다')
    deps.require_admin(request)
    account = deps.current_account(request) or {}
    deps.assert_account_current(account)
    fresh = repo.get_account(account.get('email', '')) or {}
    if not rbac.has_any_global_role(fresh.get('global_role'), rbac.ADMIN):
        raise HTTPException(403, '관리자 권한이 필요합니다')


@router.get('/api/admin/slack')
def admin_get(request: Request):
    _admin(request)
    return client.public_config()


@router.put('/api/admin/slack')
async def admin_put(request: Request):
    await asyncio.to_thread(_admin, request)
    body = await _body(request)
    token, base = body.get('bot_token'), body.get('open_base_url', 'http://127.0.0.1:8010')
    if not isinstance(token, str) or not 1 <= len(token.strip()) <= 512 or not isinstance(base, str):
        raise HTTPException(400, '토큰과 열기 주소를 확인해 주세요')
    if not isinstance(body.get('enabled', True), bool):
        raise HTTPException(400, '켜짐 값이 올바르지 않습니다')
    try:
        answer = await asyncio.to_thread(client._slack_api, 'auth.test', token.strip(), {})
        if not isinstance(answer.get('team_id'), str) or not answer['team_id']:
            raise client.SlackError('unknown')
        def save():
            _admin(request)  # after network and body, immediately before saving
            result = client.save_config(token.strip(), answer['team_id'], base, body.get('enabled', True), (deps.current_account(request) or {}).get('email', ''))
            notifier.kick()
            return result
        return await to_thread_non_abandon(save)
    except client.SlackError:
        raise HTTPException(400, 'Slack 토큰을 확인하지 못했습니다') from None
    except (ValueError, client.comfy_team_key.ProtectError):
        raise HTTPException(400, '토큰을 저장하지 못했습니다. 암호화와 열기 주소를 확인해 주세요') from None


@router.delete('/api/admin/slack')
def admin_delete(request: Request):
    _admin(request)
    client.clear_config()
    return client.public_config()


@router.post('/api/admin/slack/pause')
def admin_pause(request: Request):
    _admin(request)
    client.set_paused(True)
    return client.public_config()


@router.post('/api/admin/slack/resume')
def admin_resume(request: Request):
    _admin(request)
    try:
        client.set_paused(False)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None
    notifier.kick()
    return client.public_config()
