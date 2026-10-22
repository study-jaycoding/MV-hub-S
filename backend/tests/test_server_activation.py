"""Only temporary files and fake child processes; no server/update scripts run."""
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest
from test_server_qualification import GIT, cli_fixture, prepare_fixture, fake_probe


@pytest.fixture
def module(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'tools'))
    return importlib.import_module('server_activation')


def compatibility():
    return {'db_schema': {'read_min': 1, 'read_max': 1, 'write_min': 1, 'write_max': 1},
            'reader_protocol': 1, 'writer_protocol': 2, 'supported_components': ['content_core']}


def row():
    return {'key': 'key', 'database_id': 'db', 'status': 'compatible', 'schema_version': 1,
            'minimum_reader_protocol': 1, 'minimum_writer_protocol': 1, 'components': ['content_core']}


class Process:
    pid = 123
    def __init__(self):
        self.stopped = False
    def poll(self):
        return 0 if self.stopped else None
    def terminate(self):
        self.stopped = True
    def wait(self, timeout=None):
        return 0


def prepared(module, tmp_path, monkeypatch, *, legacy_capture=False):
    # These journal/recovery units use a minimal stage; full qualification is tested separately.
    monkeypatch.setattr(module, 'verify_qualification', lambda *a, **kw: None)
    manager = module.ServerActivation(tmp_path, environ={'CONTENT_HUB_PORT': '19871'})
    if not legacy_capture:
        manager.current['compatibility'] = compatibility()
    stage = manager.stages / 'new'
    (stage / '.venv/Scripts').mkdir(parents=True)
    (stage / '.venv/Scripts/python.exe').write_bytes(b'fixture-never-executed')
    descriptor = {'format_version': 1, 'role': 'server', 'build_id': 'new', 'compatibility': compatibility(),
                  'files': {'.venv/Scripts/python.exe': module.digest(stage / '.venv/Scripts/python.exe')}}
    module.atomic_json(stage / 'server-stage.json', descriptor)
    target = {'path': str(stage), 'python': str(stage / '.venv/Scripts/python.exe'), 'build_id': 'new',
              'compatibility': compatibility(), 'manifest_sha256': module.digest(stage / 'server-stage.json')}
    module.atomic_json(manager.request, {'target': target})
    manager.process = Process()
    events = []
    def spawn(current, pending=False):
        durable = module.read_journal(manager.journal_path)
        assert durable['db_mutation_possible'] and durable['business_writes_possible']
        events.append(('spawn', current['build_id'], pending))
        manager.process = Process()
        return manager.process
    monkeypatch.setattr(manager, 'spawn', spawn)
    monkeypatch.setattr(manager, 'wait_ready', lambda *a, **k: {'pid': 123, 'creation_time': 'fixture'})
    monkeypatch.setattr(manager, 'checkpoint', lambda _: [row()])
    return manager, events, stage


def test_stage_switch_commits_identical_bytes_and_archives_journal(module, tmp_path, monkeypatch):
    manager, events, stage = prepared(module, tmp_path, monkeypatch)
    before = module.digest(stage / 'server-stage.json')
    result = manager.apply_request()
    assert result['phase'] == 'committed'
    assert events == [('spawn', 'new', True)]
    assert module.digest(stage / 'server-stage.json') == before
    assert not manager.request.exists()
    assert json.loads(manager.control.read_text())['journal'].endswith(result['run_id'] + '.json')


def test_tampered_prepared_stage_cannot_stop_old_process(module, tmp_path, monkeypatch):
    manager, events, stage = prepared(module, tmp_path, monkeypatch)
    old = manager.process
    (stage / '.venv/Scripts/python.exe').write_bytes(b'changed')
    with pytest.raises(ValueError, match='payload_changed'):
        manager.apply_request()
    assert not old.stopped and not events and not manager.pointer.exists()


@pytest.mark.parametrize('writer,schema,expected', [(1, 1, 'rolled_back'), (3, 1, 'recovery_required'), (1, 2, 'recovery_required')])
def test_new_start_failure_only_rolls_program_back_if_current_db_is_compatible(module, tmp_path, monkeypatch, writer, schema, expected):
    manager, events, _ = prepared(module, tmp_path, monkeypatch)
    count = 0
    def ready(current, **kwargs):
        if current['build_id'] == 'new':
            raise TimeoutError('fixture readiness failure')
        return {'pid': 123}
    def checkpoint(_):
        nonlocal count
        count += 1
        return [{**row(), 'minimum_writer_protocol': writer if count > 1 else 1, 'schema_version': schema if count > 1 else 1}]
    monkeypatch.setattr(manager, 'wait_ready', ready)
    monkeypatch.setattr(manager, 'checkpoint', checkpoint)
    with pytest.raises((TimeoutError, ValueError)):
        manager.apply_request()
    result = module.read_journal(manager.journal_path)
    assert result['phase'] == expected
    assert result['db_mutation_possible'] is True
    if expected == 'recovery_required':
        assert events == [('spawn', 'new', True)]
        assert manager.process.stopped
    else:
        assert events[-1] == ('spawn', 'legacy-source', False)


def test_interrupted_start_with_unowned_listener_is_never_killed_or_adopted(module, tmp_path, monkeypatch):
    manager, _, _ = prepared(module, tmp_path, monkeypatch)
    value = module.new_journal(manager.journal_path, role='server', previous=manager.current, target={})
    monkeypatch.setattr(module, 'listener_identity', lambda _: {'pid': 999})
    with pytest.raises(ValueError, match='unowned_listener'):
        manager.resume()
    assert module.read_journal(manager.journal_path) == value


def test_ready_pid_and_nonce_must_belong_to_retained_child_handle(module, tmp_path, monkeypatch):
    manager = module.ServerActivation(tmp_path, environ={})
    manager.process = Process()
    executable = tmp_path / 'fake.exe'
    executable.write_bytes(b'never execute')
    monkeypatch.setattr(module, 'listener_identity', lambda _: {'pid': 123, 'created': 'now', 'executable': executable})
    ready = {'status': 'ready', 'runtime': {'process_id': 123, 'execution_nonce': manager.nonce,
                                          'role': 'server', 'build_id': 'legacy-source'}}
    assert manager.identity(ready, manager.current)['pid'] == 123
    ready['runtime']['execution_nonce'] = 'another'
    with pytest.raises(ValueError, match='identity_mismatch'):
        manager.identity(ready, manager.current)


def test_prepare_failure_does_not_touch_running_tree_or_pointer(module, tmp_path, monkeypatch):
    builder = importlib.import_module('server_release_update')
    sentinel = tmp_path / 'backend/app.py'
    sentinel.parent.mkdir()
    sentinel.write_bytes(b'running')
    monkeypatch.setattr(builder.subprocess, 'run', lambda *a, **k: subprocess.CompletedProcess(a, 0, '', ''))
    def fail(*args, **kwargs):
        raise RuntimeError('fixture fetch failure')
    verification_python = tmp_path / 'trusted.exe'
    verification_python.write_bytes(b'never executed')
    with pytest.raises(RuntimeError):
        builder.prepare(tmp_path, verification_python=verification_python, run=fail)
    assert sentinel.read_bytes() == b'running'
    assert not (tmp_path / 'logs/server-current.json').exists()
    assert json.loads((tmp_path / 'logs/server-prepare.json').read_text())['status'] == 'failed'


def test_prepare_logs_missing_declaration_stderr(module, tmp_path, monkeypatch):
    builder = importlib.import_module('server_release_update')
    verifier = tmp_path / 'verifier.exe'
    verifier.write_bytes(b'never executed')
    responses = iter([
        subprocess.CompletedProcess([], 0, '', ''),
        subprocess.CompletedProcess([], 0, 'a' * 40, ''),
        subprocess.CompletedProcess([], 128, b'', b'fatal: declaration missing\nsecond line\n'),
    ])
    monkeypatch.setattr(builder.subprocess, 'run', lambda *a, **k: next(responses))
    with pytest.raises(ValueError, match='^selected_commit_declaration_missing$'):
        builder.prepare(tmp_path, verification_python=verifier, run=lambda *a, **k: None)
    progress = json.loads((tmp_path / 'logs/server-prepare.json').read_text())
    assert progress['status'] == 'failed'
    assert (tmp_path / 'logs' / progress['log']).read_text() == 'fatal: declaration missing second line\n'
    assert not (tmp_path / 'logs/server-update-request.json').exists()


def test_prepared_stage_uses_clean_build_environment_and_waits_for_supervisor(module, tmp_path, monkeypatch):
    builder = importlib.import_module('server_release_update')
    verifier, run, calls = prepare_fixture(tmp_path, monkeypatch)
    run_id = builder.prepare(tmp_path, verification_python=verifier, run=run, probe_run=fake_probe)
    request = json.loads((tmp_path / 'logs/server-update-request.json').read_text())
    assert request['target']['build_id'] == run_id
    assert not (tmp_path / 'logs/server-current.json').exists()
    assert any('--require-hashes' in c for c in calls)
    assert json.loads((tmp_path / 'logs' / ('server-prepare-' + run_id + '.json')).read_text())['status'] == 'prepared'
    module.atomic_json(tmp_path / 'logs/server-current.json', request['target'])
    module.atomic_json(tmp_path / 'logs/server-install-journal.json', {'phase': 'committed', 'target': request['target']})
    (tmp_path / 'logs/server-update-request.json').unlink()
    before = len(calls)
    assert builder.prepare(tmp_path, verification_python=verifier, run=run, probe_run=fake_probe) == run_id
    assert calls[before:] == [['git', 'fetch', 'origin', 'main']]
    assert len(list((tmp_path / 'logs/server-stages').iterdir())) == 2  # stage and immutable source ZIP


@pytest.mark.parametrize('phase,code', [('committed', 0), ('rolled_back', 1), ('recovery_required', 1), ('failed', 1)])
def test_coordinator_waits_through_transient_journal_reads(module, tmp_path, monkeypatch, phase, code):
    builder = importlib.import_module('server_release_update')
    monkeypatch.setattr(builder, 'prepare', lambda root, verification_python: 'run1')
    monkeypatch.setattr(builder.time, 'sleep', lambda _: None)
    journal = tmp_path / 'logs/server-install-journal.json'
    module.atomic_json(journal, {'phase': phase, 'target': {'build_id': 'run1'}})
    real, reads = Path.read_text, []
    def flaky(self, *args, **kwargs):
        if self == journal:
            reads.append(self)
            if len(reads) == 1:
                raise PermissionError(5, 'Access is denied')  # the supervisor is replacing it right now
            if len(reads) == 2:
                return '{"phase": '
        return real(self, *args, **kwargs)
    monkeypatch.setattr(Path, 'read_text', flaky)
    monkeypatch.setattr(sys, 'argv', ['server_release_update.py', '--root', str(tmp_path),
                                      '--verification-python', str(tmp_path / 'verifier.exe')])
    assert builder.main() == code
    assert len(reads) == 3


@pytest.mark.parametrize('started', [False, True])
def test_interrupted_transition_resumes_from_disk_without_restoring_database_bytes(module, tmp_path, monkeypatch, started):
    manager, events, _ = prepared(module, tmp_path, monkeypatch)
    value = module.new_journal(manager.journal_path, role='server', previous=manager.current, target={})
    for phase in ('verified', 'draining', 'quiesced', 'checkpointed', 'activation_pending'):
        value = module.advance(manager.journal_path, value, phase, checkpoints=[row()])
    if started:
        value = module.advance(manager.journal_path, value, 'starting', db_mutation_possible=True, business_writes_possible=True)
    manager.process = None
    def no_listener(_):
        raise subprocess.CalledProcessError(2, 'fixture observation')
    monkeypatch.setattr(module, 'listener_identity', no_listener)
    manager.resume()
    assert module.read_journal(manager.journal_path)['phase'] == 'rolled_back'
    assert events == [('spawn', 'legacy-source', False)]


def test_server_process_retains_original_data_secret_and_uses_target_frontend(module, tmp_path, monkeypatch):
    manager = module.ServerActivation(tmp_path, environ={'CONTENT_HUB_DATA': 'owned-data', 'CONTENT_HUB_AUTH_SECRET': 'fixture'})
    calls = []
    monkeypatch.setattr(module.subprocess, 'Popen', lambda *a, **k: calls.append(k) or Process())
    manager.spawn(manager.current)
    env = calls[0]['env']
    assert env['CONTENT_HUB_DATA'] == str(tmp_path / 'backend/owned-data')
    assert env['CONTENT_HUB_AUTH_SECRET'] == 'fixture'
    assert env['CONTENT_HUB_FRONTEND_DIST'] == str(tmp_path / 'frontend/dist')


def legacy_declaration(**changes):
    value = {'protocol_version': 1, 'rollout': 'bridge', 'backward_compatible': True,
             'required_installer_capabilities': [],
             'db_schema': {'read_min': 1, 'read_max': 2, 'write_min': 1, 'write_max': 2},
             'reader_protocol': 1, 'writer_protocol': 2, 'supported_components': ['content_core']}
    value.update(changes)
    return {k: v for k, v in value.items() if v is not None}


def legacy_clone(root, declaration, monkeypatch):
    """A real Git clone whose committed release/compatibility.json belongs to the running source tree."""
    if not GIT:
        pytest.skip('Git is required')
    monkeypatch.setenv('PATH', str(Path(GIT).parent) + os.pathsep + os.environ.get('PATH', ''))
    path = root / 'release/compatibility.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(json.dumps(declaration).encode())  # one line: no checkout EOL difference
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
    for args in (['init', '-b', 'main'], ['add', 'release/compatibility.json'], ['commit', '-m', 'fixture']):
        subprocess.run([GIT, '-C', str(root), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', *args],
                       check=True, capture_output=True, env=env)
    return path


def start_fails_after_db_check(manager, monkeypatch, *, schema=1):
    count = 0
    def ready(current, **kwargs):
        if current['build_id'] == 'new':
            raise TimeoutError('fixture readiness failure')
        return {'pid': 123}
    def checkpoint(_):
        nonlocal count
        count += 1
        return [{**row(), 'schema_version': schema if count > 1 else 1}]
    monkeypatch.setattr(manager, 'wait_ready', ready)
    monkeypatch.setattr(manager, 'checkpoint', checkpoint)


def test_legacy_source_captures_its_committed_declaration_and_rolls_back(module, tmp_path, monkeypatch):
    path = legacy_clone(tmp_path, legacy_declaration(), monkeypatch)
    manager, events, _ = prepared(module, tmp_path, monkeypatch, legacy_capture=True)
    assert manager.current['compatibility'] == legacy_declaration()
    assert manager.current['compatibility_sha256'] == module.digest(path)
    start_fails_after_db_check(manager, monkeypatch)
    with pytest.raises(TimeoutError):
        manager.apply_request()
    assert module.read_journal(manager.journal_path)['phase'] == 'rolled_back'
    assert events == [('spawn', 'new', True), ('spawn', 'legacy-source', False)]


@pytest.mark.parametrize('damage', ['uncommitted_edit', 'missing_protocol', 'no_declaration', 'incompatible_db'])
def test_unproven_legacy_declaration_or_database_keeps_manual_recovery(module, tmp_path, monkeypatch, damage):
    if damage == 'missing_protocol':
        legacy_clone(tmp_path, legacy_declaration(writer_protocol=None), monkeypatch)
    elif damage != 'no_declaration':
        path = legacy_clone(tmp_path, legacy_declaration(), monkeypatch)
        if damage == 'uncommitted_edit':
            path.write_bytes(json.dumps(legacy_declaration(db_schema={'read_min': 1, 'read_max': 9, 'write_min': 1, 'write_max': 9})).encode())
    manager, events, _ = prepared(module, tmp_path, monkeypatch, legacy_capture=True)
    assert (manager.current['compatibility'] is None) is (damage != 'incompatible_db')
    start_fails_after_db_check(manager, monkeypatch, schema=3 if damage == 'incompatible_db' else 1)
    with pytest.raises(ValueError, match='manual_database_recovery_required'):
        manager.apply_request()
    assert module.read_journal(manager.journal_path)['phase'] == 'recovery_required'
    assert events == [('spawn', 'new', True)]


def test_declaration_changed_after_capture_blocks_program_rollback(module, tmp_path, monkeypatch):
    path = legacy_clone(tmp_path, legacy_declaration(), monkeypatch)
    manager, events, _ = prepared(module, tmp_path, monkeypatch, legacy_capture=True)
    path.write_bytes(path.read_bytes() + b' ')
    start_fails_after_db_check(manager, monkeypatch)
    with pytest.raises(ValueError, match='previous_source_changed'):
        manager.apply_request()
    assert module.read_journal(manager.journal_path)['phase'] != 'rolled_back'
    assert events == [('spawn', 'new', True)]


def test_source_replaced_during_capture_stops_supervisor_start(module, tmp_path, monkeypatch):
    legacy_clone(tmp_path, legacy_declaration(), monkeypatch)
    identities = iter(['before', 'after'])
    monkeypatch.setattr(module, 'source_identity', lambda root: next(identities))
    with pytest.raises(ValueError, match='legacy_source_changed_during_capture'):
        module.ServerActivation(tmp_path, environ={})


def test_existing_pointer_without_compatibility_is_not_backfilled(module, tmp_path, monkeypatch):
    legacy_clone(tmp_path, legacy_declaration(), monkeypatch)
    (tmp_path / 'logs').mkdir()
    module.atomic_json(tmp_path / 'logs/server-current.json',
                       {'path': str(tmp_path), 'build_id': 'legacy-source', 'python': 'python.exe',
                        'compatibility': None, 'source_sha256': module.source_identity(tmp_path)})
    manager = module.ServerActivation(tmp_path, environ={})
    assert manager.current['compatibility'] is None and 'compatibility_sha256' not in manager.current
