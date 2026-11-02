"""Private server archives and account-pinned local restore."""
from contextlib import contextmanager
import time

from fastapi import APIRouter, HTTPException, Path, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from . import _proxy
from .edit_shares import ACCOUNT_CHANGED, _relay, _viewer
from .. import active_account, config, repo
from ..db import open_transfer_connections
from ..deps import (account_author_uids, batch_view_member_projects,
                    can_view_generation_with_member_projects, current_account, require_agent_account)
from ..emailnorm import norm_email
from ..repo import scene_keeps as keeps
from ..services import trash_transfer

router = APIRouter(prefix='/api/scene-keeps', tags=['scene-keeps'])
KEY_PATTERN = r'^[0-9a-f]{32}$'


class KeepIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default='', max_length=2000)
    project_id: str = Field(default='', max_length=512)
    project_name: str | None = Field(default=None, max_length=512)
    workspace: dict | None = None
    scene_text: str | None = None
    preview: list = Field(default_factory=list)
    node_count: int | None = None  # never trusted; server derives this from scene_text
    overwrite_id: str | None = Field(default=None, pattern=KEY_PATTERN)
    overwrite_revision: int | None = Field(default=None, ge=1, strict=True)
    expect_account: str = Field(default='', max_length=1024)
    data: dict | None = None
    missing_count: int = Field(default=0, ge=0, strict=True)


class RestoreIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str = Field(pattern=KEY_PATTERN)
    revision: int = Field(ge=1, strict=True)


@contextmanager
def _answers():
    try:
        yield
    except keeps.KeepAccountGone as exc:
        raise HTTPException(401, '로그인이 필요합니다') from exc
    except keeps.KeepConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(404, '보관본을 찾을 수 없습니다') from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


def build_envelope(scene_text, request):
    """Read at most 500 results at a time; no DB context survives a network call.

    The requested scene order, rather than database or batch response order, decides
    which records fit. Each alias retains its original scene ID through restoration.
    """
    ids = keeps.scene_generation_ids(scene_text)
    data = {'v': 1, 'scene_text': scene_text, 'generations': []}
    size = len(keeps.encoded(data))
    if size > keeps.DATA_MAX:
        raise ValueError('보관본이 너무 큽니다(8 MiB)')
    missing = max(0, len(ids) - keeps.GEN_MAX)
    wanted = ids[:keeps.GEN_MAX]
    deadline = time.monotonic() + 60
    packed = {}
    admitted = 0
    account = require_agent_account(request)
    account_uid = account.get('creator_uid') or f"acct:{account['email']}"
    for batch in keeps.chunks(wanted):
        local, _materials = repo.get_generations_with_materials(batch, account_uid=account_uid)
        projects = batch_view_member_projects(request, local.values())
        local = {key: item for key, item in local.items()
                 if not item.get('deleted_at') and not item.get('deleted')
                 and can_view_generation_with_member_projects(request, item, projects)}
        absent = [key for key in batch if key not in local]
        remote = {}
        if absent and time.monotonic() < deadline:
            try:
                answer = _proxy.proxy_json('POST', '/api/generations/batch',
                                           body={'gen_ids': absent, 'allow_partial': True},
                                           timeout=max(0.001, deadline - time.monotonic()))
                if isinstance(answer, dict) and isinstance(answer.get('items'), dict):
                    remote = answer['items']
            except HTTPException as exc:
                # Authentication failures invalidate the operation; service outages
                # are accounted for as unavailable results, without extra probes.
                if exc.status_code < 500:
                    raise
        for key in batch:
            admitted += 1
            source = 'local' if key in local else 'server'
            raw = local.get(key) if source == 'local' else remote.get(key)
            if not isinstance(raw, dict) or raw.get('deleted') or raw.get('deleted_at'):
                missing += 1
                continue
            try:
                item = keeps.pack_generation(raw, source, key)
            except (ValueError, TypeError, AttributeError):
                missing += 1
                continue
            old = packed.get(item['id'])
            if old:
                before = len(keeps.encoded(old))
                old['scene_ids'].append(key)
                delta = len(keeps.encoded(old)) - before
            else:
                delta = len(keeps.encoded(item)) + (2 if data['generations'] else 0)
            if size + delta > keeps.DATA_MAX:
                if old:
                    old['scene_ids'].pop()
                missing += 1 + len(wanted) - admitted
                keeps.validate_keep_envelope(data)
                return data, missing
            size += delta
            if not old:
                packed[item['id']] = item
                data['generations'].append(item)
    keeps.validate_keep_envelope(data)
    return data, missing


@router.post('')
def save_scene_keep(body: KeepIn, request: Request):
    with _answers():
        if config.AUTH_ENABLED:
            owner, *_ = _viewer(request)
            if not body.expect_account.strip() or norm_email(body.expect_account.removeprefix('acct:')) != owner:
                raise HTTPException(409, ACCOUNT_CHANGED)
            return keeps.save_keep(owner, body.model_dump(), current_account(request))
        with _relay(request, write=True) as owner:
            epoch = active_account.account_epoch()
            # Ignore any browser-supplied envelope, count or account identity.
            data, missing = build_envelope(body.scene_text, request)
            payload = body.model_dump(exclude={'scene_text', 'data', 'missing_count', 'expect_account', 'node_count'})
            payload.update(data=data, missing_count=missing, expect_account=owner)
            keeps.validate_metadata(payload)
            if epoch != active_account.account_epoch():
                raise HTTPException(409, ACCOUNT_CHANGED)
            return _proxy.proxy_json('POST', '/api/scene-keeps', body=payload)


@router.get('')
def list_scene_keeps(request: Request):
    if config.AUTH_ENABLED:
        owner, *_ = _viewer(request)
        return keeps.list_keeps(owner)
    with _relay(request, write=False):
        return _proxy.proxy_json('GET', '/api/scene-keeps')


@router.post('/restore')
def restore_scene_keep(body: RestoreIn, request: Request):
    if config.AUTH_ENABLED:
        raise HTTPException(409, '이 PC 의 앱에서 열어 주세요')
    with _answers(), _relay(request, write=True):
        epoch = active_account.account_epoch()
        data = _proxy.proxy_json('GET', f'/api/scene-keeps/{body.id}/envelope', params={'revision': body.revision})
        keeps.validate_keep_envelope(data)
        deadline = time.monotonic() + 60
        with active_account.transition_lock:
            if epoch != active_account.account_epoch():
                raise HTTPException(409, ACCOUNT_CHANGED)
            author_uids = account_author_uids(require_agent_account(request))
            # A fresh account DB cannot infer its creator from local results yet.
            # _relay pins this UID together with the account, even during download.
            pinned_uid = active_account.active_uid()
            if pinned_uid:
                author_uids.add(pinned_uid)
        planned = keeps.plan_trash_restores(data['generations'], author_uids)
        for item, candidate in zip(data['generations'], planned):
            if time.monotonic() >= deadline:
                break
            if candidate is None:
                continue
            # The pin selects the DB; the lock and epoch prevent writing after a switch.
            # Recheck each candidate because another keep may have restored its job.
            with active_account.transition_lock:
                if epoch != active_account.account_epoch():
                    raise HTTPException(409, ACCOUNT_CHANGED)
                if time.monotonic() >= deadline:
                    break
                # Finish a previous request before retrying an admitted item.
                # Select first so an in-progress delete is not newly admitted.
                _settle_trash_transfer()
                try:
                    current = keeps.plan_trash_restores([item], author_uids)[0]
                    if current is not None:
                        if time.monotonic() >= deadline:
                            break
                        repo.restore_from_trash(current, account_uid=None)
                except Exception:
                    # Even an ordinary SQLite error can follow a durable B1 commit.
                    # Do not continue writing until both journals are quiescent.
                    _settle_trash_transfer()
        with active_account.transition_lock:
            if epoch != active_account.account_epoch():
                raise HTTPException(409, ACCOUNT_CHANGED)
            _settle_trash_transfer()
            return keeps.restore_keep(data, author_uids)


def _settle_trash_transfer():
    try:
        if keeps.has_pending_transfer():
            trash_transfer.reconcile(open_transfer_connections)
            if keeps.has_pending_transfer():
                raise RuntimeError('unfinished trash transfer')
    except Exception as exc:
        raise HTTPException(409, '잠시 뒤 다시 열어 주세요') from exc


@router.get('/{id}/envelope')
def get_scene_keep_envelope(request: Request, id: str = Path(pattern=KEY_PATTERN), revision: int = Query(ge=1)):
    if not config.AUTH_ENABLED:
        raise HTTPException(404, 'Not Found')
    owner, *_ = _viewer(request)
    with _answers():
        return keeps.get_keep(owner, id, revision)


@router.get('/{id}')
def get_scene_keep(request: Request, id: str = Path(pattern=KEY_PATTERN)):
    with _answers():
        if config.AUTH_ENABLED:
            owner, *_ = _viewer(request)
            return keeps.get_keep(owner, id)
        with _relay(request, write=False):
            return _proxy.proxy_json('GET', f'/api/scene-keeps/{id}')


@router.delete('/{id}')
def delete_scene_keep(request: Request, id: str = Path(pattern=KEY_PATTERN), revision: int = Query(ge=1)):
    with _answers():
        if config.AUTH_ENABLED:
            owner, *_ = _viewer(request)
            return keeps.delete_keep(owner, id, revision)
        with _relay(request, write=True):
            return _proxy.proxy_json('DELETE', f'/api/scene-keeps/{id}', params={'revision': revision})
