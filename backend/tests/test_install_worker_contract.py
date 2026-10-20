"""Run only installed helper functions against temporary records; never updater scripts."""
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
    return subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-File', str(script)],
                          capture_output=True, text=True, timeout=20, env=env)


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
