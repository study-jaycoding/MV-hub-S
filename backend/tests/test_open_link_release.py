"""Read-only release contract checks. Never execute an installer or release script."""
import ast
from pathlib import Path
import re
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]


def test_release_copies_and_allows_handler_and_windowless_runtime():
    script = (ROOT / 'release/make_release.ps1').read_text(encoding='utf-8-sig')
    for name in ('RootFiles', 'AllowedTopLevel'):
        section = re.search(r'\$' + name + r'\s*=\s*@\((.*?)\)', script, re.S).group(1)
        assert '"open_link.py"' in section
    assert '"runtime/python/pythonw.exe"' in script
    excluded = re.search(r'"/XF"([^\r\n]*)', script).group(1)
    assert 'pythonw.exe' not in excluded
    function = script.split('function Assert-PythonRuntimeTree', 1)[1].split('\nfunction ', 1)[0]
    assert '"pythonw.exe"' in function and "'-I', '-S'" in function
    assert '-WindowStyle Hidden' in function and '$WindowlessProbe.ExitCode' in function


def test_install_health_and_update_include_new_files_without_new_swap_branch():
    source = (ROOT / 'backend/app/services/release_update.py').read_text(encoding='utf-8')
    tree = ast.parse(source)
    health = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_installation_health')
    literals = [n.value for n in ast.walk(health) if isinstance(n, ast.Constant)]
    assert 'open_link.py' in literals and 'pythonw.exe' in literals
    updater = (ROOT / 'update_release_worker.bat').read_text(encoding='utf-8-sig')
    layout = updater.split('function Assert-AppLayout', 1)[1].split('\nfunction ', 1)[0]
    required = re.search(r'\$Required\s*=\s*@\((.*?)\)', layout, re.S).group(1)
    assert '"open_link.py"' not in required  # old packages still have a valid layout
    runtime = updater.split('function Assert-PythonRuntime', 1)[1].split('\nfunction ', 1)[0]
    conditional = runtime.split('if (Test-Path -LiteralPath (Join-Path $PackageRoot "open_link.py") -PathType Leaf) {', 1)[1]
    assert '"pythonw.exe"' in conditional and "'-I', '-S'" in conditional
    assert '$Windowless' not in runtime.split('if (Test-Path', 1)[0]
    assert '-Label "staged" -PackageRoot $ExtractDir' in updater
    assert '-Label "installed" -PackageRoot $ExtractDir' in updater
    swaps = updater.split('function Get-UpdateComponents', 1)[1].split('\nfunction ', 1)[0]
    assert 'Get-ChildItem' in swaps and 'open_link.py' not in swaps
    qualifier = (ROOT / 'tools/qualify_release_artifact.py').read_text(encoding='utf-8')
    native = next(n for n in ast.parse(qualifier).body if isinstance(n, ast.FunctionDef) and n.name == '_check_native_runtime')
    assert isinstance(native.body[1], ast.If) and isinstance(native.body[1].body[0], ast.Return)
    assert '_check_native_runtime(root)' in qualifier


def test_handler_is_standalone_and_import_does_not_register_or_connect():
    tree = ast.parse((ROOT / 'open_link.py').read_text(encoding='utf-8'))
    imports = [n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)]
    assert all(name == '__future__' or name == 'pathlib' or name == 'types' or name == 'ctypes' for name in imports)
    calls = [n for n in tree.body if isinstance(n, ast.Expr) and isinstance(n.value, ast.Call)]
    assert not calls
    launcher = ast.parse((ROOT / 'run_agent_session.py').read_text(encoding='utf-8'))
    top_calls = [ast.unparse(n) for n in launcher.body if isinstance(n, ast.Expr)]
    assert not any('register_open_link(' in text for text in top_calls)


@pytest.mark.parametrize('missing', ['', 'open_link.py', 'runtime/python/pythonw.exe'])
def test_installation_health_requires_complete_native_link(tmp_path, monkeypatch, missing):
    from app.services import release_update
    files = ['MV_agent.bat', 'update_release.bat', 'run_release_update.ps1', 'update_release_worker.bat',
             'run_agent_session.py', 'open_link.py', 'agent_push.py', 'backend/serve.py',
             'backend/app/main.py', 'frontend/dist/index.html', 'runtime/python/python.exe',
             'runtime/python/pythonw.exe', 'runtime/python/python314.dll', 'runtime/node/node.exe',
             'runtime/higgsfield/node_modules/@higgsfield/cli/bin/higgsfield.js']
    for name in files:
        if name != missing:
            path = tmp_path / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'not executable')
    (tmp_path / 'hf_cli_version.txt').write_text('1.2.3')
    (tmp_path / 'runtime/higgsfield/node_modules/@higgsfield/cli/package.json').write_text('{"version":"1.2.3"}')
    monkeypatch.setattr(release_update, '_unfinished_install', lambda root: False)
    def run(argv, **kwargs):
        # This fixture must never execute its fake binaries.
        out = '3.14.0|64' if argv[0].endswith('python.exe') else 'higgsfield 1.2.3'
        return SimpleNamespace(returncode=0, stdout=out, stderr='')
    monkeypatch.setattr(release_update.subprocess, 'run', run)
    assert release_update._installation_health(tmp_path)[0] is (missing != 'runtime/python/pythonw.exe')


@pytest.mark.parametrize('native,pythonw,passes', [(False, False, True), (True, False, False), (True, True, True)])
def test_qualifier_legacy_or_complete_native_package(tmp_path, monkeypatch, native, pythonw, passes):
    monkeypatch.syspath_prepend(str(ROOT / 'tools'))
    import qualify_release_artifact as qualifier
    if native:
        (tmp_path / 'open_link.py').write_text('# fixture')
    if pythonw:
        runtime = tmp_path / 'runtime/python'
        runtime.mkdir(parents=True)
        (runtime / 'pythonw.exe').write_bytes(b'never execute')
    calls = []
    def probe(argv, **kwargs):
        calls.append(argv)
        assert argv[1:3] == ['-I', '-S']
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(qualifier.subprocess, 'run', probe)
    if passes:
        qualifier._check_native_runtime(tmp_path)
    else:
        # 파일이 없으면 다른 필수 파일과 같이 FileNotFoundError(_required_file), 실행 실패면 ContractError — 둘 다 검정 실패다.
        with pytest.raises((FileNotFoundError, qualifier.c.ContractError)):
            qualifier._check_native_runtime(tmp_path)
    assert bool(calls) is (native and pythonw)
