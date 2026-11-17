"""Exercise launcher wiring with fake processes, never a real server or taskkill."""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
import os
import subprocess
import sys
import pytest

from test_server_tls import tls_dir  # noqa: F401
import smoke_server_boot as smoke


def test_smoke_passes_empty_tls_override_to_supervisor(tmp_path, monkeypatch, tls_dir):
    (tls_dir / 'server.pem').write_text('real-machine-setting-must-not-be-used')
    root = tmp_path / 'root'
    dist = root / 'frontend/dist'
    dist.mkdir(parents=True)
    (dist / 'index.html').write_text('fixture')
    monkeypatch.setattr(smoke, 'ROOT', root)
    monkeypatch.setattr(smoke, '_free_port', lambda: 12345)
    ready = iter([True, False])
    monkeypatch.setattr(smoke, '_ready', lambda port: next(ready))
    monkeypatch.setattr(smoke.time, 'sleep', lambda seconds: None)
    seen = []

    def spawn(argv, **kwargs):
        env = kwargs['env']
        directory = Path(env['MVHUB_SERVER_TLS_DIR'])
        assert directory != tls_dir and not directory.exists()
        assert directory.parent == Path(env['CONTENT_HUB_DATA']).parent
        assert env['CONTENT_HUB_AUTH'] == '0'
        assert str(root / 'MV_server.bat') in argv
        seen.append(argv)
        return SimpleNamespace(pid=123, poll=lambda: None, wait=Mock(), kill=Mock())

    monkeypatch.setattr(smoke.subprocess, 'Popen', spawn)
    monkeypatch.setattr(smoke.subprocess, 'run', lambda *a, **kw: SimpleNamespace(returncode=0))
    assert smoke.main() == 0
    assert len(seen) == 1


@pytest.mark.skipif(os.name != 'nt', reason='Windows batch quoting')
def test_launcher_scheme_command_handles_space_paths(tmp_path, tls_dir):
    root = Path(__file__).resolve().parents[2]
    spaced = tmp_path / 'installation with spaces'
    (spaced / 'tools').mkdir(parents=True)
    (spaced / 'tools/server_tls.py').write_bytes((root / 'tools/server_tls.py').read_bytes())
    lines = (root / 'MV_server.bat').read_text().splitlines()
    command = next(line for line in lines if line.startswith('for /f') and 'server_tls.py' in line)
    batch = tmp_path / 'scheme-only.bat'
    batch.write_text('@echo off\nsetlocal\n' + f'set "ROOT={spaced}\\"\nset "PYEXE={sys.executable}"\n'
                     + command + '\necho RESULT=%SERVER_SCHEME%\n', encoding='ascii')
    result = subprocess.run(['cmd.exe', '/d', '/c', str(batch)], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0 and 'RESULT=http' in result.stdout, result.stderr
