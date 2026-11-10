"""프로젝트 원본 레퍼런스를 같은 이름으로 덮어쓴 뒤의 생성 — 작업자 다시 받기와 격리 시나리오(2026-11-10).

설계·합의: docs/status/레퍼런스덮어쓰기_최신추종_2026-11-10.md
- 유료 CLI 는 부르지 않는다: _run_cli_json 은 모의 응답, 실제 프로세스를 띄우는 _run_with_tree_kill 은 불리면 예외.
  (작업자에 HF_BIN 연결점이 없고, PATH 앞에 가짜를 끼우는 방식은 2026-09-05 실과금 사고로 금지.)
- 허브의 /api/assets/file 은 원본을 디스크에서 그대로 내준다(no-cache) — 시나리오의 _resolve_ref 대역은 그 파일을
  새 임시파일로 복사한다. 임시 허브 DB 는 CONTENT_HUB_DB 로 따로 만든다.
"""
import asyncio
import hashlib
import importlib.util
import os
import shutil
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from app import db, repo
from app.models import PendingRequestOut
from app.repo import gen_requests
from app.usecases.gen_requests import GenRequestCommand, submit_gen_request

LIVE = 'asset:p|refs/hero.png'
CAPTURE = 'asset:captures|cap.png'
URL = 'https://cdn.example.invalid/ref.png'
ROUNDS = 5


def _agent():
    spec = importlib.util.spec_from_file_location('live_refresh_agent', Path(__file__).resolve().parents[2] / 'agent_push.py')
    agent = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(agent)
    return agent


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Hub:
    """원본 파일 몇 개와 다운로드 횟수 — _resolve_ref 대역(받을 때마다 새 임시파일)."""

    def __init__(self, root: Path):
        self.root = root
        self.files: dict[str, Path] = {}
        self.calls: list[str] = []
        self.broken: set[str] = set()

    def put(self, token: str, data: bytes) -> None:
        path = self.files.setdefault(token, self.root / f'src_{len(self.files)}.bin')
        path.write_bytes(data)

    def resolve(self, _server, _token, val):
        self.calls.append(val)
        if val in self.broken or val not in self.files:
            return None, None
        fd, tmp = tempfile.mkstemp(prefix='chref_', dir=self.root)
        os.close(fd)
        shutil.copyfile(self.files[val], tmp)
        return tmp, tmp


def _request(rid: str, *refs: dict) -> dict:
    return {'id': rid, 'model': 'nano-banana', 'prompt': 'test', 'params': {}, 'asset_content_protocol': 1,
            'references': [{'role': f'@Image{n + 1}', 'type': 'image', **ref} for n, ref in enumerate(refs)]}


# ── 다시 받기 경계 ──

def test_project_original_is_fetched_again_per_claim_batch_and_old_batch_keeps_its_copy(tmp_path):
    agent, hub = _agent(), Hub(tmp_path)
    hub.put(LIVE, b'v1')
    hub.put(CAPTURE, b'capture')
    hub.put(URL, b'url')
    with patch.object(agent, '_resolve_ref', hub.resolve):
        # 같은 묶음 안에서는 같은 경로를 한 번만 받는다.
        first = [_request('a', {'file_path': LIVE}, {'file_path': CAPTURE}), _request('b', {'file_path': LIVE}, {'file_path': URL})]
        cache, temps = agent._resolve_refs_for('http://hub', 'token', first, {})
        assert sorted(hub.calls) == sorted([LIVE, CAPTURE, URL]) and len(temps) == 3
        first_batch = dict(cache)
        hub.put(LIVE, b'v2')
        hub.calls.clear()
        cache, temps = agent._resolve_refs_for('http://hub', 'token', [_request('c', {'file_path': LIVE}, {'file_path': CAPTURE},
                                                                                  {'file_path': URL})], cache)
    assert hub.calls == [LIVE] and len(temps) == 1  # 관리 사본·URL 은 지금처럼 다시 안 받는다
    assert Path(cache[LIVE]).read_bytes() == b'v2'
    assert Path(first_batch[LIVE]).read_bytes() == b'v1' and first_batch[LIVE] != cache[LIVE]  # 진행 중 요청의 사본 그대로
    assert cache[CAPTURE] == first_batch[CAPTURE] and cache[URL] == first_batch[URL]


def test_failed_refetch_never_falls_back_to_the_old_copy(tmp_path):
    agent, hub = _agent(), Hub(tmp_path)
    hub.put(LIVE, b'v1')
    with patch.object(agent, '_resolve_ref', hub.resolve):
        cache, _ = agent._resolve_refs_for('http://hub', 'token', [_request('a', {'file_path': LIVE})], {})
        old = cache[LIVE]
        hub.broken.add(LIVE)
        cache, _ = agent._resolve_refs_for('http://hub', 'token', [_request('b', {'file_path': LIVE})], cache)
    assert cache[LIVE] is None and Path(old).read_bytes() == b'v1'
    with patch.object(agent, '_fail') as failed, patch.object(agent, '_allowed_params', return_value=set()), \
            patch.object(agent, '_run_with_tree_kill', side_effect=AssertionError('실제 CLI 프로세스 금지')), \
            patch.object(agent, '_run_cli_json') as paid:
        assert agent._submit_one('http://hub', 'token', 'cli', 'a@example.invalid', _request('b', {'file_path': LIVE}),
                                 dict(cache), {}, agent.Lock(), agent.Lock(), 'agent') is None
    paid.assert_not_called()
    assert '레퍼런스를 가져올 수 없습니다' in failed.call_args.args[3]


@pytest.mark.parametrize('ref', [
    {'type': 'video', 'role': '@Video1', 'file_path': 'asset:p|clips/one.mp4', 'expected_asset_content_id': 'sha256:' + _sha(b'old')},
    {'type': 'audio', 'role': '@Audio1', 'file_path': 'asset:p|voice/one.wav', 'expected_asset_content_id': 'sha256:' + _sha(b'old')},
    {'type': 'image', 'file_path': LIVE, 'asset_content_id': 'sha256:' + _sha(b'old')},  # 재생성 레시피(당시 판)
], ids=['video', 'audio', 'regenerate'])
def test_refetched_requests_with_an_expected_version_still_stop_before_paid_call(tmp_path, ref):
    agent, hub = _agent(), Hub(tmp_path)
    hub.put(ref['file_path'], b'old')
    request = _request('r', ref)
    with patch.object(agent, '_resolve_ref', hub.resolve):
        cache, _ = agent._resolve_refs_for('http://hub', 'token', [request], {})
        hub.put(ref['file_path'], b'overwritten')
        cache, _ = agent._resolve_refs_for('http://hub', 'token', [request], cache)
    assert Path(cache[ref['file_path']]).read_bytes() == b'overwritten'
    with patch.object(agent, '_fail') as failed, patch.object(agent, '_allowed_params', return_value=set()), \
            patch.object(agent, '_preserve_reference', return_value=True), \
            patch.object(agent, '_run_with_tree_kill', side_effect=AssertionError('실제 CLI 프로세스 금지')), \
            patch.object(agent, '_run_cli_json') as paid:
        assert agent._submit_one('http://hub', 'token', 'cli', 'a@example.invalid', request,
                                 dict(cache), {}, agent.Lock(), agent.Lock(), 'agent') is None
    paid.assert_not_called()
    reason = failed.call_args.args[3]
    assert Path(ref['file_path'].rsplit('|', 1)[-1]).name in reason and '크레딧은 쓰지 않았습니다' in reason


# ── 격리 시나리오 (임시 허브 DB + 실제 파일 덮어쓰기 + 작업자 다운로드·제출 함수) ──

@pytest.fixture
def content(tmp_path, monkeypatch):
    db.flush_pool()
    path = tmp_path / 'content.db'
    monkeypatch.setenv('CONTENT_HUB_DB', str(path))
    db.init_db(path)
    repo.ensure_default_worker()
    with db.get_connection() as conn:
        conn.execute("INSERT INTO project(id,name) VALUES('p','Project')")
    yield path
    db.flush_pool()


def _create(references) -> str:
    command = GenRequestCommand(kind='create', email='test@example.invalid', creator_uid='user_a', worker_id='me',
        source_gen_id=None, workspace={'scope': 'personal'},
        data={'prompt': 'test', 'model': 'nano-banana', 'project_id': 'p', 'references': references})
    with patch('app.usecases.gen_requests.MANAGE_ENABLED', False), patch('app.usecases.gen_requests.journal_generation_event'):
        return asyncio.run(submit_gen_request(command))['id']


def _claim() -> list[dict]:
    claimed = gen_requests.claim_pending_requests('test@example.invalid', workspace_capable=True, lease_owner='agent',
                                                  submission_stage_capable=True)
    return [{**PendingRequestOut.model_validate(item).model_dump(), 'claim_phase': 'claimed'} for item in claimed]


def _submit(agent, request: dict, cache: dict):
    """작업자 제출 함수 — 유료 CLI 만 모의 응답. CLI 에 넘긴 로컬 파일들의 SHA 를 돌려준다."""
    sent: list[str] = []

    def begin(_server, _token, _rid, _owner, fingerprint):
        with db.get_connection() as conn:
            gen_requests._attach_submission_ref_digests(conn, request['gen_id'], fingerprint)
        return True

    def paid(_cli, *args, **_kwargs):
        sent.extend(_sha(Path(arg).read_bytes()) for arg in args if isinstance(arg, str) and os.path.isfile(arg))
        return ['12345678-1234-1234-1234-123456789abc'], None

    with patch.object(agent, '_allowed_params', return_value=set()), \
            patch.object(agent, '_preserve_reference', return_value=True), \
            patch.object(agent, '_ensure_request_workspace', return_value=('test-workspace', None)), \
            patch.object(agent, '_begin_submission', side_effect=begin), \
            patch.object(agent, '_run_with_tree_kill', side_effect=AssertionError('실제 CLI 프로세스 금지')), \
            patch.object(agent, '_run_cli_json', side_effect=paid) as cli, \
            patch.object(agent, '_fail') as failed, \
            patch.object(agent, '_outbox_add'), patch.object(agent, '_anchor_with_retry', return_value=True):
        result = agent._submit_one('http://hub', 'token', 'cli', 'test@example.invalid', request, cache, {},
                                   agent.Lock(), agent.Lock(), 'agent')
    return result, sent, cli, failed


def _recorded_sha(path: str) -> list[str]:
    with db.get_connection() as conn:
        return [row[0] for row in conn.execute('SELECT content_sha FROM reference WHERE file_path=? ORDER BY rowid', (path,))]


@pytest.mark.parametrize('stale_cid', [False, True], ids=['fresh-ref', 'stale-cid-ref'])
def test_scenario_overwrite_then_generate_sends_and_records_the_new_bytes(content, tmp_path, stale_cid):
    """①(넣기 → 같은 이름 덮어쓰기 → 생성)·③(옛 cid 가 박힌 원본 참조로 생성) 각 5회."""
    agent, hub = _agent(), Hub(tmp_path)
    cache: dict = {}
    for n in range(ROUNDS):
        before, after = f'before {n}'.encode(), f'after overwrite {n}'.encode()
        hub.put(LIVE, before)
        ref = {'file_path': LIVE, 'type': 'image', 'role': '@Image1'}
        if stale_cid:
            ref['asset_content_id'] = 'sha256:' + _sha(before)
        hub.put(LIVE, after)  # 카드에 넣은 뒤 같은 이름으로 덮어썼다
        gid = _create([ref])
        claimed = _claim()
        assert [item['references'][0].get('expected_asset_content_id') for item in claimed] == [None]
        with patch.object(agent, '_resolve_ref', hub.resolve):
            cache, _ = agent._resolve_refs_for('http://hub', 'token', claimed, cache)
        result, sent, cli, failed = _submit(agent, claimed[0], dict(cache))
        assert result, failed.call_args
        assert sent == [_sha(after)]
        assert _recorded_sha(LIVE)[-1] == _sha(after)
        assert gid


def test_scenario_overwrite_while_first_batch_is_running(content, tmp_path):
    """② 첫 묶음 진행 중에 덮어쓰고 다음 요청 — 다음 묶음은 새 파일, 첫 묶음 사본은 그대로. 5회."""
    agent, hub = _agent(), Hub(tmp_path)
    cache: dict = {}
    for n in range(ROUNDS):
        first_bytes, second_bytes = f'first {n}'.encode(), f'second {n}'.encode()
        hub.put(LIVE, first_bytes)
        _create([{'file_path': LIVE, 'type': 'image', 'role': '@Image1'}])
        with patch.object(agent, '_resolve_ref', hub.resolve):
            cache, _ = agent._resolve_refs_for('http://hub', 'token', first := _claim(), cache)
        first_batch = dict(cache)
        hub.put(LIVE, second_bytes)  # 첫 요청이 아직 제출 중
        _create([{'file_path': LIVE, 'type': 'image', 'role': '@Image1', 'asset_content_id': 'sha256:' + _sha(first_bytes)}])
        with patch.object(agent, '_resolve_ref', hub.resolve):
            cache, _ = agent._resolve_refs_for('http://hub', 'token', second := _claim(), cache)
        _, sent_second, _, _ = _submit(agent, second[0], dict(cache))
        _, sent_first, _, _ = _submit(agent, first[0], first_batch)
        assert sent_second == [_sha(second_bytes)]
        assert sent_first == [_sha(first_bytes)] and Path(first_batch[LIVE]).read_bytes() == first_bytes


def test_scenario_fixed_capture_with_different_bytes_still_stops_before_paid_call(content, tmp_path):
    """④ 캡처(고정 사본) 참조의 내용이 고를 때와 다르면 과금 전에 멈춘다. 5회."""
    agent, hub = _agent(), Hub(tmp_path)
    cache: dict = {}
    for n in range(ROUNDS):
        chosen, actual = f'chosen {n}'.encode(), f'other {n}'.encode()
        hub.put(CAPTURE, actual)
        _create([{'file_path': CAPTURE, 'type': 'image', 'role': '@Image1', 'asset_content_id': 'sha256:' + _sha(chosen)}])
        claimed = _claim()
        assert claimed[0]['references'][0]['expected_asset_content_id'] == 'sha256:' + _sha(chosen)
        cache.pop(CAPTURE, None)  # 회차마다 다른 파일 — 관리 사본은 캐시를 재사용하므로 새로 받게 비운다
        with patch.object(agent, '_resolve_ref', hub.resolve):
            cache, _ = agent._resolve_refs_for('http://hub', 'token', claimed, cache)
        result, sent, cli, failed = _submit(agent, claimed[0], dict(cache))
        assert result is None and sent == []
        cli.assert_not_called()
        assert '크레딧은 쓰지 않았습니다' in failed.call_args.args[3]
