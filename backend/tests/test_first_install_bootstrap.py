"""Run extracted installer functions against synthetic bytes, never launch an updater."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess

import pytest

from release_contract_fixture import qualified_package

ROOT = Path(__file__).resolve().parents[2]
HARNESS = Path(__file__).with_name('fixtures') / 'first_install_harness.ps1'
pytestmark = pytest.mark.skipif(os.name != 'nt', reason='Windows installer functions')
SCENARIOS = ('success', 'restart_failed', 'ready_nonce_mismatch', 'unknown_file',
             'existing_db', 'external_data', 'receipt_missing', 'receipt_wrong_artifact',
             'zip_tamper', 'capability_unknown', 'existing_helper', 'stage_failed',
             'late_data', 'bootstrap_tamper', 'contract_missing', 'receipt_reference_missing',
             'worker_receipt_missing', 'existing_install', 'existing_install_custom_port',
             'existing_install_restart_failed')


@pytest.mark.parametrize('scenario', SCENARIOS)
def test_empty_install_requires_qualified_bootstrap_and_verified_startup(tmp_path, scenario):
    from app.services import release_contract as c

    case = tmp_path / 'new worker'
    feed = case / 'feed'
    feed.mkdir(parents=True)
    with sqlite3.connect(case / 'synthetic.db') as db:
        db.execute('create table fixture_evidence(value text)')
        db.execute("insert into fixture_evidence values ('new business data survives')")
    files = {'VERSION.txt': b'fixture1\r\n', 'hf_cli_version.txt': b'1.1.26',
             'runtime/higgsfield/node_modules/@higgsfield/cli/package.json': b'{"version":"1.1.26"}',
             'frontend/dist/index.html': b'fixture',
             'installer-capabilities.json': b'{"format_version":1,"capabilities":["artifact-receipt-v1","install-journal-v1"]}'}
    for name in ('MV_agent.bat', 'update_release.bat', 'run_agent_session.py', 'agent_push.py',
                 'backend/serve.py', 'backend/app/main.py', 'runtime/node/node.exe',
                 'runtime/python/python.exe'):
        files[name] = b'NEVER EXECUTE'
    for name in ('update_release_worker.bat', 'update_release_contract.ps1', 'run_release_update.ps1'):
        files[name] = (ROOT / name).read_bytes()
    candidate, _ = qualified_package(feed, 'fixture1', rollout='enforced', payload=files,
                                    compatibility={'reader_protocol': 1, 'writer_protocol': 1}
                                    if scenario.startswith('existing_install') else None)
    if scenario.startswith('existing_install'):
        target = case / 'target'
        for name, raw in files.items():
            path = target / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        (target / 'VERSION.txt').write_text('old')
        (target / 'MV_agent.bat').write_bytes(b'old launcher NEVER EXECUTE')
        (target / 'build-manifest.json').write_bytes(c.json_bytes({
            'compatibility': candidate['contract']['compatibility']}))
        for name in ('tools/install_db_probe.py', 'backend/app/schema_compat.py',
                     'backend/app/services/backup_verify.py', 'backend/app/services/sqlite_db.py',
                     'backend/app/services/trash_transfer.py'):
            path = target / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'NEVER EXECUTE')
        data = target / 'backend/data/db/content_hub.db'
        data.parent.mkdir(parents=True)
        data.write_bytes((case / 'synthetic.db').read_bytes())
    receipt = feed / candidate['contract']['validation_receipt']['file']
    if scenario == 'receipt_missing':
        receipt.unlink()
    elif scenario == 'receipt_wrong_artifact':
        document = json.loads(receipt.read_bytes())
        document['artifact']['sha256'] = '0' * 64
        receipt.write_bytes(c.json_bytes(document))
        candidate['contract']['validation_receipt']['sha256'] = c.file_sha256(receipt)
    elif scenario == 'zip_tamper':
        with (feed / candidate['file']).open('ab') as stream:
            stream.write(b'altered')
    elif scenario == 'capability_unknown':
        candidate['contract']['compatibility']['required_installer_capabilities'].append('future-required')
    elif scenario == 'contract_missing':
        candidate.pop('contract')
    elif scenario == 'receipt_reference_missing':
        candidate['contract']['validation_receipt'] = None
    (feed / 'latest.json').write_bytes(c.json_bytes(candidate))
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(('CONTENT_HUB_', 'MVHUB_'))}
    environment.pop('PORT', None)
    environment['MVHUB_UPDATE_READY_URL'] = 'http://127.0.0.1:19998/api/ready'
    if scenario == 'existing_install_custom_port':
        environment['PORT'] = '18999'
    process = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-File',
                              str(HARNESS),
                              '-Tree', str(ROOT), '-CaseRoot', str(case), '-Scenario', scenario],
                             capture_output=True, timeout=60, env=environment)
    assert process.returncode == 0, (process.stdout + process.stderr).decode(errors='replace')
    result = json.loads((case / 'result.json').read_text(encoding='utf-8-sig'))
    journal, trace = result['journal'], result['trace']
    assert result['restored_ready_url'] == environment['MVHUB_UPDATE_READY_URL'], result
    if scenario.startswith('existing_install'):
        assert journal['previous_version'] == 'old', result
    if scenario == 'existing_install_restart_failed':
        assert result['error'] == 'Verified package updater failed with exit code 1.', result
        assert journal['phase'] == 'rolled_back' and not journal['fresh_install'], result
        assert trace['undo_calls'] == trace['worker_calls'] == trace['process_starts'] == 1, result
        assert trace['checkpoint_calls'] == 2 and trace['requested_restart'] == '1', result
        assert (case / 'target/VERSION.txt').read_text().strip() == 'old'
        assert (case / 'target/MV_agent.bat').read_bytes() == b'old launcher NEVER EXECUTE'
        assert (case / 'target/backend/data/db/content_hub.db').read_bytes() == (case / 'synthetic.db').read_bytes()
        # The BAT is not executed: verify its nonzero payload exit reaches [ERROR].
        installer = (ROOT / 'release/MVHub_Install.bat').read_text(encoding='ascii')
        failure = installer.split('if not "%INSTALL_EXIT%"=="0" (', 1)[1].split('\n)', 1)[0]
        assert 'echo [ERROR] MV Hub install/update failed.' in failure
        assert 'exit /b %INSTALL_EXIT%' in failure
    elif scenario in ('existing_install', 'existing_install_custom_port'):
        assert result['error'] is None, result
        assert journal['phase'] == 'committed' and not journal['fresh_install'], result
        assert journal['db_mutation_possible'] and journal['business_writes_possible'], result
        assert trace['requested_restart'] == '1', result
        port = environment.get('PORT', '8010')
        assert trace['requested_ready_url'] == trace['observed_ready_url'] == f'http://127.0.0.1:{port}/api/ready', result
        assert trace['worker_calls'] == trace['process_starts'] == trace['checkpoint_calls'] == 1, result
        assert trace['drain_calls'] == trace['stops'] == 1 and trace['ready_calls'] > 0, result
        assert trace['last_state'] == 'complete' and trace['phase_at_complete'] == 'committed', result
        assert (case / 'target/backend/data/db/content_hub.db').read_bytes() == (case / 'synthetic.db').read_bytes()
        assert (case / 'target/VERSION.txt').read_text().strip() == candidate['version']
        assert len(list((case / 'target/.install-journals').glob('*.json'))) == 1
    elif scenario == 'success':
        assert result['error'] is None, result
        assert journal['phase'] == 'committed' and journal['fresh_install'], result
        assert journal['database_set'] == 'verified_empty' and journal['db_mutation_possible'], result
        assert trace['worker_calls'] == trace['process_starts'] == 1 and trace['checkpoint_calls'] == 0, result
        assert trace['requested_restart'] == '1' and result['data_preserved'], result
        assert trace['requested_ready_url'] == trace['observed_ready_url'] == 'http://127.0.0.1:8010/api/ready', result
        assert (case / 'target/backend/data/db/content_hub.db').read_bytes() == (case / 'synthetic.db').read_bytes()
        assert len(list((case / 'target/.install-journals').glob('*.json'))) == 1
    elif scenario in ('restart_failed', 'ready_nonce_mismatch', 'stage_failed', 'late_data', 'bootstrap_tamper'):
        assert result['error'] and journal['phase'] == 'recovery_required' and journal['fresh_install'], result
        assert trace['undo_calls'] == trace['checkpoint_calls'] == 0, result
        started = scenario in ('restart_failed', 'ready_nonce_mismatch')
        assert journal['db_mutation_possible'] == started and trace['process_starts'] == int(started), result
        if scenario == 'ready_nonce_mismatch':
            assert trace['ready_calls'] > 0 and result['data_preserved'], result
            assert (case / 'target/backend/data/db/content_hub.db').read_bytes() == (case / 'synthetic.db').read_bytes()
    else:
        assert result['error'] and journal is None and trace['process_starts'] == 0, result
        assert trace['worker_calls'] == int(scenario == 'worker_receipt_missing'), result
        if scenario == 'existing_helper':
            assert (case / 'target/update_release_contract.ps1').read_bytes() == (ROOT / 'update_release_contract.ps1').read_bytes()
        elif scenario == 'existing_db':
            assert (case / 'target/backend/data/content_hub.db').read_bytes() == (case / 'synthetic.db').read_bytes()
        elif scenario == 'unknown_file':
            assert (case / 'target/unknown.txt').read_text() == 'preserve'
        elif scenario != 'worker_receipt_missing':
            assert not result['target_exists'], result


def test_installer_instructions_match_automatic_startup():
    installer = (ROOT / 'release/MVHub_Install.bat').read_bytes().decode('ascii')
    assert 'existing installations keep manual restart' not in installer
    assert 'First and existing installations start MV Hub and verify readiness.' in installer
    assert 'echo [done] MV Hub is installed and running.' in installer
    assert 'echo        Run:' not in installer
    assert 'To open it later:' in installer


def test_installer_contract_rejects_legacy_db_and_windows_path_aliases(tmp_path):
    names = [directory + database + suffix
             for directory in ('backend/', 'BACKEND/')
             for database in ('content_hub.db', 'content_hub_trash.db')
             for suffix in ('', '-wal', '-shm', '-journal')]
    names += ['backend/content_hub.db.', 'backend./content_hub.db', 'data./fixture',
              'backend /content_hub.db', 'backend/content_hub.db ', 'data /fixture']
    names += ['backend/app/db.py']
    rows = []
    for index, name in enumerate(names):
        folder = tmp_path / str(index)
        folder.mkdir()
        candidate, _ = qualified_package(folder, 'fixture', payload={
            'VERSION.txt': b'fixture', 'hf_cli_version.txt': b'1.1.26', name: b'synthetic only'})
        rows.append({'name': name, 'package': str(folder / candidate['file'])})
    (tmp_path / 'cases.json').write_text(json.dumps(rows), encoding='utf-8')
    script = tmp_path / 'cases.ps1'
    script.write_text("param([string]$Root,[string]$Cases,[string]$Result)\n"
                      "$ErrorActionPreference='Stop'\n. (Join-Path $Root 'update_release_contract.ps1')\n"
                      "$Inputs=Get-Content -LiteralPath $Cases -Raw | ConvertFrom-Json\n"
                      "$Rows=@(foreach($Case in $Inputs){\n"
                      "try{$null=Get-QualifiedRelease -PackagePath $Case.package;$Accepted=$true}\n"
                      "catch{$Accepted=$false}\n@{name=$Case.name;accepted=$Accepted}})\n"
                      "ConvertTo-Json -InputObject $Rows | Set-Content -LiteralPath $Result -Encoding UTF8\n",
                      encoding='utf-8-sig')
    result_path = tmp_path / 'result.json'
    process = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-File', str(script),
                              '-Root', str(ROOT), '-Cases', str(tmp_path / 'cases.json'),
                              '-Result', str(result_path)], capture_output=True, timeout=60)
    assert process.returncode == 0, (process.stdout + process.stderr).decode(errors='replace')
    actual = json.loads(result_path.read_text(encoding='utf-8-sig'))
    assert len(actual) == len(names)
    assert all(row['accepted'] == (row['name'] == 'backend/app/db.py') for row in actual), actual
