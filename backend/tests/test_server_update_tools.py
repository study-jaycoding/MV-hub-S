"""Server update helper: verifier interpreter provisioning (temporary files only)."""
import importlib
import os
from pathlib import Path
import re
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))
verifier = importlib.import_module('server_verifier')


def test_verifier_pin_matches_dev_requirements_and_is_hash_locked():
    dev = (ROOT / 'backend/requirements-dev.txt').read_text(encoding='utf-8')
    lock = verifier.LOCK.read_text(encoding='utf-8')
    assert re.search(r'^psutil==' + re.escape(verifier.PSUTIL_VERSION) + r'$', dev, re.M)
    assert re.search(r'^psutil==' + re.escape(verifier.PSUTIL_VERSION) + r' --hash=sha256:[0-9a-f]{64}$', lock, re.M)


class FakeRun:
    """Records commands; 'venv' creates the interpreter file, the version probe answers from state."""
    def __init__(self, root, *, installed_version=None, pip_code=0, final_version=verifier.PSUTIL_VERSION):
        self.python = verifier.verifier_python(root)
        self.version = installed_version
        self.pip_code = pip_code
        self.final_version = final_version
        self.commands = []

    def __call__(self, command, **kwargs):
        self.commands.append(command)
        if '-c' in command:
            return subprocess.CompletedProcess(command, 0 if self.version else 1, (self.version or '') + '\n', '')
        if 'venv' in command:
            self.python.parent.mkdir(parents=True)
            self.python.write_bytes(b'fixture interpreter never executed')
            return subprocess.CompletedProcess(command, 0)
        if 'pip' in command:
            if self.pip_code == 0:
                self.version = self.final_version
            return subprocess.CompletedProcess(command, self.pip_code)
        raise AssertionError(command)


def test_working_verifier_is_reused_without_installing(tmp_path):
    run = FakeRun(tmp_path, installed_version=verifier.PSUTIL_VERSION)
    run.python.parent.mkdir(parents=True)
    run.python.write_bytes(b'existing')
    assert verifier.ensure(tmp_path, run=run) == run.python
    assert all('-c' in command for command in run.commands)


def test_missing_verifier_is_built_in_place_with_hash_locked_psutil(tmp_path):
    run = FakeRun(tmp_path)
    assert verifier.ensure(tmp_path, run=run, base_python='base-python') == run.python
    venv, pip = [c for c in run.commands if '-c' not in c]
    assert venv == ['base-python', '-m', 'venv', str(tmp_path / 'logs/server-verifier')]
    assert pip[:3] == [str(run.python), '-m', 'pip']
    assert {'--isolated', '--require-hashes', '--only-binary=:all:', '--no-deps'} <= set(pip)
    assert pip[-2:] == ['-r', str(verifier.LOCK)]
    assert '-c' in run.commands[-1]  # re-checked at the final path


@pytest.mark.parametrize('installed', ['0.0.1', None])
def test_broken_or_wrong_verifier_is_set_aside_not_deleted(tmp_path, installed):
    target = tmp_path / 'logs/server-verifier'
    (target / 'Scripts').mkdir(parents=True)
    (target / 'Scripts/python.exe').write_bytes(b'old')
    (target / 'marker.txt').write_bytes(b'keep me')
    run = FakeRun(tmp_path, installed_version=installed)
    # The old folder is moved before the fake venv recreates Scripts/python.exe at the same path.
    verifier.ensure(tmp_path, run=run, base_python='base-python')
    broken = [p for p in (tmp_path / 'logs').iterdir() if p.name.startswith('server-verifier.broken-')]
    assert len(broken) == 1 and (broken[0] / 'marker.txt').read_bytes() == b'keep me'
    assert run.python.read_bytes() == b'fixture interpreter never executed'


@pytest.mark.parametrize('pip_code,final_version,error', [(1, verifier.PSUTIL_VERSION, 'verifier_setup_failed'),
                                                          (0, '9.9.9', 'verifier_psutil_check_failed')])
def test_failed_install_or_final_check_stops(tmp_path, pip_code, final_version, error):
    run = FakeRun(tmp_path, pip_code=pip_code, final_version=final_version)
    with pytest.raises(RuntimeError, match=error):
        verifier.ensure(tmp_path, run=run, base_python='base-python')
    # The partial folder is set aside on the next run instead of being trusted.
    run2 = FakeRun(tmp_path)
    assert verifier.ensure(tmp_path, run=run2, base_python='base-python') == run2.python
    assert any(p.name.startswith('server-verifier.broken-') for p in (tmp_path / 'logs').iterdir())


@pytest.mark.skipif(os.name != 'nt', reason='Windows junction')
@pytest.mark.parametrize('link', ['server-verifier', 'server-verifier/Scripts'])
def test_redirected_verifier_path_never_runs_a_python(tmp_path, link):
    outside = tmp_path / 'outside'
    (outside / 'Scripts').mkdir(parents=True)
    (outside / 'Scripts/python.exe').write_bytes(b'foreign interpreter')
    source = outside if link == 'server-verifier' else outside / 'Scripts'
    junction = tmp_path / 'root/logs' / link
    junction.parent.mkdir(parents=True)
    subprocess.run(['cmd', '/d', '/c', 'mklink', '/J', str(junction), str(source)], check=True, capture_output=True)
    run = FakeRun(tmp_path / 'root', installed_version=verifier.PSUTIL_VERSION)
    with pytest.raises(ValueError, match='reparse'):
        verifier.ensure(tmp_path / 'root', run=run)
    assert run.commands == []


@pytest.mark.skipif(os.environ.get('MVHUB_VERIFIER_NETWORK_TEST') != '1', reason='opt-in: downloads the pinned wheel')
def test_real_verifier_install_matches_the_lock(tmp_path):
    python = verifier.ensure(tmp_path)
    assert verifier.check(python)
