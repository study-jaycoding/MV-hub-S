"""Run only installed helper functions against temporary records; never updater scripts."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import zipfile

import pytest

ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(os.name != 'nt', reason='Windows installed helper')


def ps(tmp_path, code):
    script = tmp_path / 'fixture.ps1'
    script.write_text("$ErrorActionPreference='Stop'\n. '" + str(ROOT / 'update_release_contract.ps1') + "'\n" + code,
                      encoding='utf-8-sig')
    env = {k: v for k, v in os.environ.items() if not k.startswith('MVHUB_ACTIVATION_') and k != 'MVHUB_EXECUTION_NONCE'}
    return subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(script)],
                          capture_output=True, text=True, timeout=20, env=env)


def legacy_install(root):
    files = {name: b'fixture' for name in (
        'MV_agent.bat', 'update_release.bat', 'run_release_update.ps1',
        'update_release_worker.bat', 'run_agent_session.py', 'agent_push.py',
        'backend/serve.py', 'backend/app/main.py', 'frontend/dist/index.html',
        'runtime/node/node.exe', 'runtime/higgsfield/cli.js', 'runtime/python/python.exe',
        'tools/helper.ps1', 'backend/extra/helper.py',
    )}
    files['VERSION.txt'] = b'2026.10.21-1200\r\n'
    for name, raw in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    descriptor = {'format_version': 1, 'role': 'worker', 'version': '2026.10.21-1200',
                  'payload': [{'path': name, 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
                              for name, raw in files.items()]}
    (root / 'build-manifest.json').write_text(json.dumps(descriptor))
    components = [('backend/app', 'dir'), ('frontend/dist', 'dir'), ('runtime/node', 'dir'),
                  ('runtime/higgsfield', 'dir'), ('runtime/python', 'dir'),
                  ('tools', 'dir'), ('backend/extra', 'dir'), ('build-manifest.json', 'file')]
    components += [(name, 'file') for name in files if '/' not in name and name != 'VERSION.txt']
    components.append(('backend/serve.py', 'file'))
    journal = {'token': '1234abcd', 'updated_at': '2026-10-21T12:00:00.0000000Z',
               'components': [{'relative': name.replace('/', '\\'), 'kind': kind,
                               'had_previous': name != 'build-manifest.json', 'old_moved': True, 'swapped': True}
                              for name, kind in components]}
    (root / 'update-journal.json').write_text(json.dumps(journal), encoding='utf-8-sig')
    return journal, descriptor


def test_legacy_committed_install_boots_and_preserves_journal(tmp_path):
    legacy_install(tmp_path)
    before = (tmp_path / 'update-journal.json').read_bytes()
    result = ps(tmp_path, f"Initialize-WorkerActivation -Root '{tmp_path}'")
    assert result.returncode == 0 and result.stdout.startswith('READY:'), result.stderr
    assert (tmp_path / 'update-journal.json').read_bytes() == before
    assert json.loads((tmp_path / '.install-activation.json').read_text())['state'] == 'normal'


@pytest.mark.parametrize('damage', [
    'empty', 'missing_component', 'missing_directory', 'duplicate', 'unsafe_path',
    'wrong_kind', 'not_swapped', 'not_moved', 'string_flag', 'missing_flag',
    'bad_token', 'bad_time', 'non_array', 'unknown_format', 'unknown_field',
])
def test_legacy_incomplete_or_malformed_journal_is_rejected(tmp_path, damage):
    journal, _ = legacy_install(tmp_path)
    if damage == 'empty':
        journal['components'] = []
    elif damage == 'missing_component':
        journal['components'].pop()
    elif damage == 'missing_directory':
        journal['components'].pop(0)
    elif damage == 'duplicate':
        journal['components'].append(dict(journal['components'][0], relative='BACKEND\\APP'))
    elif damage == 'unsafe_path':
        journal['components'][0]['relative'] = '..\\backend\\app'
    elif damage == 'wrong_kind':
        journal['components'][0]['kind'] = 'file'
    elif damage in ('not_swapped', 'not_moved', 'string_flag', 'missing_flag'):
        row = journal['components'][0]
        if damage == 'missing_flag':
            del row['had_previous']
        else:
            row['old_moved' if damage == 'not_moved' else 'swapped'] = 'false' if damage == 'string_flag' else False
    elif damage == 'bad_token':
        journal['token'] = 'ABCDEF12'
    elif damage == 'bad_time':
        journal['updated_at'] = 'not-a-time'
    elif damage == 'non_array':
        journal['components'] = journal['components'][0]
    elif damage == 'unknown_format':
        journal['format_version'] = None
    elif damage == 'unknown_field':
        journal['phase'] = 'committed'
    (tmp_path / 'update-journal.json').write_text(json.dumps(journal))
    before = (tmp_path / 'update-journal.json').read_bytes()
    result = ps(tmp_path, f"Initialize-WorkerActivation -Root '{tmp_path}'")
    assert result.returncode != 0 and 'READY:' not in result.stdout
    assert not (tmp_path / '.install-activation.json').exists()
    assert (tmp_path / 'update-journal.json').read_bytes() == before


@pytest.mark.parametrize('damage', [
    'version', 'payload_hash', 'payload_size', 'missing_payload', 'empty_payload',
    'unsafe_payload', 'duplicate_payload', 'missing_required_payload', 'descriptor_role',
    'descriptor_reparse', 'payload_junction',
])
def test_legacy_version_or_payload_mismatch_is_rejected(tmp_path, damage):
    _, descriptor = legacy_install(tmp_path)
    manifest = tmp_path / 'build-manifest.json'
    if damage == 'version':
        (tmp_path / 'VERSION.txt').write_text('old')
    elif damage == 'payload_hash':
        (tmp_path / 'agent_push.py').write_bytes(b'changed')  # same size, different hash
    elif damage == 'payload_size':
        (tmp_path / 'agent_push.py').write_bytes(b'x')
    elif damage == 'missing_payload':
        (tmp_path / 'agent_push.py').unlink()
    elif damage == 'empty_payload':
        descriptor['payload'] = []
    elif damage == 'unsafe_payload':
        descriptor['payload'][0]['path'] = '../outside'
    elif damage == 'duplicate_payload':
        descriptor['payload'].append(dict(descriptor['payload'][0]))
    elif damage == 'missing_required_payload':
        descriptor['payload'] = [row for row in descriptor['payload'] if row['path'] != 'backend/app/main.py']
    elif damage == 'descriptor_role':
        descriptor['role'] = 'server'
    elif damage == 'descriptor_reparse':
        manifest.unlink()
        junction = subprocess.run(['cmd.exe', '/c', 'mklink', '/J', str(manifest), str(tmp_path / 'tools')], capture_output=True)
        assert junction.returncode == 0
    elif damage == 'payload_junction':
        app = tmp_path / 'backend' / 'app'
        target = tmp_path / 'moved-app'
        app.rename(target)
        junction = subprocess.run(['cmd.exe', '/c', 'mklink', '/J', str(app), str(target)], capture_output=True)
        assert junction.returncode == 0
    if damage != 'descriptor_reparse':
        manifest.write_text(json.dumps(descriptor))
    result = ps(tmp_path, f"Initialize-WorkerActivation -Root '{tmp_path}'")
    assert result.returncode != 0 and 'READY:' not in result.stdout
    assert not (tmp_path / '.install-activation.json').exists()


def test_legacy_journal_left_after_cleanup_failure_can_boot_again(tmp_path):
    legacy_install(tmp_path)
    before = (tmp_path / 'update-journal.json').read_bytes()
    first = ps(tmp_path, f"Initialize-WorkerActivation -Root '{tmp_path}'")
    second = ps(tmp_path, f"Initialize-WorkerActivation -Root '{tmp_path}'")
    assert first.returncode == second.returncode == 0, (first.stderr, second.stderr)
    assert first.stdout == second.stdout and second.stdout.startswith('READY:')
    assert (tmp_path / 'update-journal.json').read_bytes() == before
    (tmp_path / 'agent_push.py').write_bytes(b'changed')
    assert ps(tmp_path, f"Initialize-WorkerActivation -Root '{tmp_path}'").returncode != 0


@pytest.mark.parametrize('phase', ['committed', 'rolled_back'])
def test_terminal_v1_journal_still_allows_normal_boot(tmp_path, phase):
    (tmp_path / 'update-journal.json').write_text(json.dumps({'format_version': 1, 'phase': phase}))
    result = ps(tmp_path, f"Initialize-WorkerActivation -Root '{tmp_path}'")
    assert result.returncode == 0 and result.stdout.startswith('READY:'), result.stderr


def test_normal_boot_and_interrupted_boot_have_distinct_results(tmp_path):
    result = ps(tmp_path, f"Initialize-WorkerActivation -Root '{tmp_path}'")
    assert result.returncode == 0 and result.stdout.startswith('READY:'), result.stderr
    record = json.loads((tmp_path / '.install-activation.json').read_text())
    assert record['state'] == 'normal'
    second = ps(tmp_path, f"Initialize-WorkerActivation -Root '{tmp_path}'")
    assert second.stdout == result.stdout
    assert json.loads((tmp_path / '.install-activation.json').read_text()) == record
    (tmp_path / 'update-journal.json').write_text(json.dumps({'format_version': 1, 'phase': 'starting'}))
    before = (tmp_path / '.install-activation.json').read_bytes()
    result = ps(tmp_path, f"Initialize-WorkerActivation -Root '{tmp_path}'")
    assert result.returncode != 0
    assert (tmp_path / '.install-activation.json').read_bytes() == before


def test_inherited_control_outside_installation_is_not_written(tmp_path):
    external = tmp_path / 'external.json'
    external.write_text('sentinel')
    code = f"$env:MVHUB_ACTIVATION_CONTROL='{external}'; $env:MVHUB_ACTIVATION_ROOT='{tmp_path}'; Initialize-WorkerActivation -Root '{tmp_path}'"
    result = ps(tmp_path, code)
    assert result.returncode != 0 and external.read_text() == 'sentinel'


def test_start_phase_cannot_be_recorded_without_monotonic_db_intent(tmp_path):
    code = f"""
$JournalPath='{tmp_path / 'journal.json'}'
$script:InstallJournal=@{{format_version=1;run_id='r';phase='activation_pending';updated_at='t';db_mutation_possible=$false;business_writes_possible=$false}}
Write-InstallRecord $JournalPath $script:InstallJournal
try {{ Set-InstallPhase starting; throw 'unexpected success' }} catch {{ if($_ -match 'unexpected success'){{throw}} }}
Set-InstallPhase starting @{{db_mutation_possible=$true;business_writes_possible=$true}}
Set-InstallPhase ready
Set-InstallPhase committed
"""
    result = ps(tmp_path, code)
    assert result.returncode == 0, result.stderr
    assert json.loads((tmp_path / 'journal.json').read_text())['phase'] == 'committed'


def test_component_protocol_and_identity_all_gate_program_rollback(tmp_path):
    code = """
$Compat=[pscustomobject]@{db_schema=@{read_min=1;read_max=1;write_min=1;write_max=1};reader_protocol=1;writer_protocol=2;supported_components=@('content_core')}
$Row=[pscustomobject]@{key='k';database_id='d';status='compatible';schema_version=1;minimum_reader_protocol=1;minimum_writer_protocol=2;components=@('content_core')}
if(-not (Test-PreviousDatabaseCompatibility $Compat @($Row) @($Row))){throw 'expected compatible'}
$Row.components=@('unknown_component')
if(Test-PreviousDatabaseCompatibility $Compat @($Row) @($Row)){throw 'unknown component allowed'}
$Row.components=@('content_core');$Row.minimum_writer_protocol=3
if(Test-PreviousDatabaseCompatibility $Compat @($Row) @($Row)){throw 'future writer allowed'}
"""
    result = ps(tmp_path, code)
    assert result.returncode == 0, result.stderr


def test_installed_descriptor_cannot_be_downgraded_to_legacy_manifest(tmp_path):
    (tmp_path / 'build-manifest.json').write_text('{}')
    result = ps(tmp_path, f"Assert-InstalledCapability -Candidate ([pscustomobject]@{{version='old'}}) -Root '{tmp_path}'")
    assert result.returncode != 0


def test_extracted_payload_is_rechecked_before_and_after_component_swap(tmp_path):
    from release_contract_fixture import qualified_package
    value, raw = qualified_package(tmp_path, '2026.10.18-1200')
    installed = tmp_path / 'installed'
    installed.mkdir()
    with zipfile.ZipFile(tmp_path / value['file']) as archive:
        archive.extractall(installed)
    candidate = tmp_path / 'candidate.json'
    candidate.write_bytes(raw)
    code = f"$Candidate=ConvertFrom-ReleaseJson ([IO.File]::ReadAllBytes('{candidate}')); Assert-InstalledReleasePayload -Root '{installed}' -Candidate $Candidate"
    result = ps(tmp_path, code)
    assert result.returncode == 0, result.stderr
    (installed / 'VERSION.txt').write_text('changed')
    assert ps(tmp_path, code).returncode != 0


@pytest.mark.parametrize('writer,previous_mark,expected', [(1, 'new_committed', 'rolled_back'), (3, 'new_committed', 'recovery_required'), (1, 'recovery_required', 'recovery_required')])
def test_actual_worker_failure_function_uses_current_database_not_old_backup(tmp_path, writer, previous_mark, expected):
    code = f"""
$Body=([IO.File]::ReadAllText('{ROOT / 'update_release_worker.bat'}')).Split(@('### MVHUB_UPDATE_POWERSHELL ###'),[StringSplitOptions]::None)[-1]
$Tokens=$null;$Errors=$null
$Tree=[System.Management.Automation.Language.Parser]::ParseInput($Body,[ref]$Tokens,[ref]$Errors)
if($Errors){{throw 'parse failure'}}
$Function=$Tree.FindAll({{param($Node) $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'Finalize-FailedInstall'}},$true)[0]
Invoke-Expression $Function.Extent.Text
$JournalPath='{tmp_path / 'journal.json'}';$TargetDir='{tmp_path}'
$Compat=@{{db_schema=@{{read_min=1;read_max=1;write_min=1;write_max=1}};reader_protocol=1;writer_protocol=2;supported_components=@('content_core')}}
$Row=[pscustomobject]@{{key='k';database_id='d';status='compatible';schema_version=1;minimum_reader_protocol=1;minimum_writer_protocol={writer};components=@('content_core')}}
$script:InstallJournal=@{{format_version=1;run_id='r';phase='starting';updated_at='t';db_mutation_possible=$true;business_writes_possible=$true;previous=@{{compatibility=$Compat}};previous_version='old';checkpoints=@($Row)}}
$script:RecoveryState='{previous_mark}';$script:HadRecoveryAssets=$false;$script:InheritedRecovery=$false;$script:ProcessesStopped=$true
$script:Calls=@()
function Stop-MvHubProcesses {{ $script:Calls+='stop' }}
function Invoke-InstallCheckpoint {{ $script:Calls+='inspect-current'; return @($Row) }}
function Undo-ComponentSwaps {{ $script:Calls+='restore-program'; return ,@() }}
function Commit-VersionMarker {{ $script:Calls+='version' }}
Write-InstallRecord $JournalPath $script:InstallJournal
Finalize-FailedInstall
ConvertTo-Json -InputObject @($script:Calls) | Set-Content -LiteralPath '{tmp_path / 'calls.json'}'
"""
    result = ps(tmp_path, code)
    assert result.returncode == 0, result.stderr
    assert json.loads((tmp_path / 'journal.json').read_text())['phase'] == expected
    calls = json.loads((tmp_path / 'calls.json').read_text(encoding='utf-8-sig'))
    assert calls[:2] == ([] if previous_mark == 'recovery_required' else ['stop', 'inspect-current'])
    assert ('restore-program' in calls) == (expected == 'rolled_back')
