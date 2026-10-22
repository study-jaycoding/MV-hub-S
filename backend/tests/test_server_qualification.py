"""Copy-only tests. Fake build/probe/HTTP processes; no network, servers or database opens."""
import copy
import ast
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import Mock
import zipfile

import pytest

ROOT = Path(os.environ.get('P6_REPOSITORY_ROOT', str(Path(__file__).resolve().parents[2])))
sys.path.insert(0, str(ROOT / 'backend'))
sys.path.insert(0, str(ROOT / 'tools'))
sys.path.insert(0, os.environ.get('P6_SOURCE_DIR', str(ROOT / 'tools')))
activation = importlib.import_module('server_activation')
builder = importlib.import_module('server_release_update')
from app.services.release_contract import json_bytes
from smoke_env import build_smoke_env

GIT = shutil.which('git')
REAL_RUN = subprocess.run


def write_cli(cli, version='1.2.3'):
    package = cli / 'node_modules/@higgsfield/cli'
    (package / 'bin').mkdir(parents=True)
    (cli / 'higgsfield.cmd').write_bytes(b'fixture shim never executed')
    (cli / 'higgsfield.ps1').write_bytes(b'fixture PowerShell shim never executed')
    (cli / 'node.exe').write_bytes(b'fixture node never executed')
    (package / 'package.json').write_bytes(json_bytes({'name': '@higgsfield/cli', 'version': version}))
    (package / 'bin/higgsfield.js').write_bytes(b'fixture js never executed')
    (package / 'vendor').mkdir()
    (package / 'vendor/hf.exe').write_bytes(b'fixture native CLI never executed')


@pytest.fixture(autouse=True)
def cli_fixture(tmp_path, monkeypatch):
    cli = tmp_path / 'fixture-cli'
    write_cli(cli)
    (cli / 'npm.cmd').write_bytes(b'fixture npm never executed')
    monkeypatch.setenv('PATH', str(cli))
    monkeypatch.delenv('NODE_OPTIONS', raising=False)
    monkeypatch.delenv('NODE_PATH', raising=False)
    return cli


def compat():
    return {'protocol_version': 1, 'rollout': 'bridge', 'required_installer_capabilities': [],
            'backward_compatible': True, 'db_schema': {'read_min': 1, 'read_max': 2, 'write_min': 1, 'write_max': 2},
            'reader_protocol': 1, 'writer_protocol': 2, 'supported_components': ['content_core']}


def write_venv_config(stage):
    base=Path(sys._base_executable).resolve()
    (stage/'.venv/pyvenv.cfg').write_text(
        f'home = {base.parent}\ninclude-system-site-packages = false\nexecutable = {base}\n',encoding='utf-8')


def seed_stage(root):
    stage = root / 'logs/server-stages/build1'
    inputs = ['backend/app/main.py', 'backend/serve.py', 'backend/schema.sql', 'backend/requirements.lock.txt',
              'frontend/package.json', 'frontend/package-lock.json', 'tools/predeploy_gate.ps1',
              'tools/validation_result.ps1', 'hf_cli_version.txt']
    for name in inputs + ['.venv/Scripts/python.exe', 'frontend/dist/index.html']:
        path = stage / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'fixture never executed ' + name.encode())
    (stage / 'hf_cli_version.txt').write_bytes(b'1.2.3\n')
    write_cli(stage / 'runtime/higgsfield')
    write_venv_config(stage)
    hashes = {name: activation.digest(stage / name) for name in inputs}
    source = {'commit': 'a' * 40, 'dirty': False, 'sha256': 'b' * 64,
              'file_count': len(hashes), 'files': [{'path': n, 'tracked': True, 'size': (stage/n).stat().st_size, 'sha256': h} for n,h in hashes.items()]}
    receipt = {'format_version': 1, 'scope': 'source-only', 'status': 'passed', 'passed': True,
               'release_eligible': False, 'run_id': 'source-run', 'finished_at': '2026-10-18T00:00:01+00:00',
               'source': source, 'source_after': copy.deepcopy(source), 'source_unchanged': True,
               'cleanup': {'status': 'not_measured'},
               'steps': [{'name': n, 'status': 'passed', 'exit_code': 0} for n in activation.SOURCE_STEPS]
                        + [{'name': 'Isolated load test', 'status': 'skipped', 'exit_code': None}]}
    raw = json_bytes(receipt)
    descriptor = {'format_version': 1, 'role': 'server', 'build_id': 'build1', 'source_commit': 'a' * 40,
                  'source_files': hashes, 'source_receipt_sha256': hashlib.sha256(raw).hexdigest(),
                  'python_base': activation.stage_python_base(stage),
                  'compatibility': compat(), 'files': {p.relative_to(stage).as_posix(): activation.digest(p) for p in stage.rglob('*') if p.is_file()}}
    activation.atomic_json(stage / 'server-stage.json', descriptor)
    target = {'path': str(stage), 'python': str(stage / '.venv/Scripts/python.exe'), 'build_id': 'build1',
              'compatibility': compat(), 'manifest_sha256': activation.digest(stage/'server-stage.json')}
    for name in (*activation.PROBE_TOOLS, *activation.COORDINATOR_TOOLS):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'fixture trusted verifier never executed ' + name.encode())
    verifier = root/'trusted/python.exe';verifier.parent.mkdir();verifier.write_bytes(b'trusted fixture')
    return stage, target, receipt, raw, verifier


def fake_probe(command, **kwargs):
    if command[-1] == 'version':
        node, javascript, _ = command
        cli = Path(javascript).parents[4]
        assert Path(node) == cli / 'node.exe' or Path(node) == cli.parent / 'node/node.exe'
        assert Path(kwargs['env']['HOME']).is_relative_to(kwargs['cwd'])
        assert 'CONTENT_HUB_AUTH_SECRET' not in kwargs['env']
        assert 'NODE_OPTIONS' not in kwargs['env'] and 'NODE_PATH' not in kwargs['env']
        assert kwargs['timeout'] == 60
        pin = json.loads((cli / 'node_modules/@higgsfield/cli/package.json').read_bytes())['version']
        return subprocess.CompletedProcess(command, 0, f'higgsfield {pin}\n'.encode(), b'')
    assert command[1:7] == ['-E', '-s', '-B', '-X', 'utf8', '-u']
    assert 'CONTENT_HUB_AUTH_SECRET' not in kwargs['env']
    assert not Path(command[command.index('--work-root')+1]).exists()
    path = Path(command[command.index('--descriptor')+1])
    descriptor = json.loads(path.read_bytes())
    runtime_python = Path(command[command.index('--runtime-python')+1])
    assert runtime_python != Path(command[0])
    value = {'status':'passed', 'scope':'fresh-data-runtime-probe',
             'descriptor_file_sha256':activation.digest(path),
             'descriptor_sha256':hashlib.sha256(json_bytes(descriptor)).hexdigest(),
             'payload_sha256':hashlib.sha256(json_bytes({r['path'].casefold():r['sha256'] for r in descriptor['payload']})).hexdigest(),
             'tool_sha256':{name: activation.digest(kwargs['cwd'] / name) for name in activation.PROBE_TOOLS},
             'evidence':{'fresh_data':True, 'temp_removed':True, 'frontend_files':1, 'databases':[{'kind':'content'}],
                         'runtime_python_sha256':activation.digest(runtime_python),
                         'process_cleanup':{'port_released':True}, 'listener_pid':123,
                         'ready':{'status':'ready','runtime':{'process_id':123,'execution_nonce':'fixture','build_id':descriptor['build_id'],'role':'server'}}}}
    return subprocess.CompletedProcess(command,0,json_bytes(value),b'')


def seed_tls(tmp_path, monkeypatch):
    cert=tmp_path/'backend/local.crt';cert.parent.mkdir(parents=True,exist_ok=True);cert.write_text('synthetic cert')
    key=cert.with_suffix('.key');key.write_text('mock key')
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    factory=Mock(return_value=context)
    monkeypatch.setattr(ssl,'create_default_context',factory)
    server_context=Mock()
    constructor=Mock(return_value=server_context)
    monkeypatch.setattr(ssl,'SSLContext',constructor)
    return cert,key,context,factory,server_context,constructor


def test_tls_ready_uses_explicit_certificate_and_https_without_disabling_validation(tmp_path, monkeypatch):
    cert,key,context,factory,server_context,constructor=seed_tls(tmp_path,monkeypatch)
    opener=Mock();opener.open.return_value=io.BytesIO(b'{"status":"ready"}')
    monkeypatch.setattr(activation.urllib.request,'build_opener',Mock(return_value=opener))
    manager=activation.ServerActivation(tmp_path,environ={'CONTENT_HUB_SSL_CERTFILE':'local.crt','CONTENT_HUB_SSL_KEYFILE':'local.key'})
    manager.ready()
    assert opener.open.call_args.args[0].startswith('https://127.0.0.1:')
    factory.assert_called_once_with(cafile=str(cert.resolve()))
    assert context.verify_mode==ssl.CERT_REQUIRED and context.check_hostname
    assert manager.env['CONTENT_HUB_SSL_KEYFILE']==str(key.resolve())
    constructor.assert_called_once_with(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain.assert_called_once_with(str(cert.resolve()),str(key.resolve()),password='')


def test_tls_key_chain_must_validate_before_manager_logs_or_process(tmp_path,monkeypatch):
    cert,key,context,factory,server_context,constructor=seed_tls(tmp_path,monkeypatch)
    server_context.load_cert_chain.side_effect=ssl.SSLError('synthetic cert/key mismatch')
    with pytest.raises(ssl.SSLError):
        activation.ServerActivation(tmp_path,environ={'CONTENT_HUB_SSL_CERTFILE':str(cert),'CONTENT_HUB_SSL_KEYFILE':str(key)})
    assert not (tmp_path/'logs').exists()


@pytest.mark.parametrize('damage',['cert_changed','key_changed','cert_missing','key_missing'])
def test_changed_tls_files_are_rejected_before_journal_or_stop(tmp_path,monkeypatch,damage):
    cert,key,context,factory,server_context,constructor=seed_tls(tmp_path,monkeypatch)
    manager=activation.ServerActivation(tmp_path,environ={'CONTENT_HUB_SSL_CERTFILE':str(cert),'CONTENT_HUB_SSL_KEYFILE':str(key)})
    activation.atomic_json(manager.request,{})
    target=cert if damage.startswith('cert') else key
    if damage.endswith('missing'): target.unlink()
    else: target.write_bytes(b'synthetic changed TLS file')
    stopped=Mock();monkeypatch.setattr(manager,'stop_owned',stopped)
    with pytest.raises(ValueError,match='server_tls_files_changed'): manager.apply_request()
    stopped.assert_not_called()
    assert not manager.journal_path.exists()
    assert manager.ready_context is context


def test_changed_tls_immediately_before_stop_retains_old_context_and_process(tmp_path,monkeypatch):
    stage,target,value,raw,verifier=seed_stage(tmp_path)
    target=builder.qualify_stage(tmp_path,stage,target,raw,verifier,probe_run=fake_probe)
    cert,key,context,factory,server_context,constructor=seed_tls(tmp_path,monkeypatch)
    manager=activation.ServerActivation(tmp_path,environ={**os.environ,'CONTENT_HUB_SSL_CERTFILE':str(cert),'CONTENT_HUB_SSL_KEYFILE':str(key)})
    activation.atomic_json(manager.request,{'target':target})
    def ready(current,*,drain=False):
        if drain: key.write_bytes(b'synthetic changed key during drain')
        return {'pid':123}
    monkeypatch.setattr(manager,'wait_ready',ready)
    stopped=Mock();monkeypatch.setattr(manager,'stop_owned',stopped)
    checkpoint=Mock(return_value=[]);monkeypatch.setattr(manager,'checkpoint',checkpoint)
    monkeypatch.setattr(manager,'spawn',Mock(side_effect=AssertionError('unexpected synthetic spawn')))
    with pytest.raises(ValueError,match='server_tls_files_changed'): manager.apply_request()
    stopped.assert_not_called();checkpoint.assert_not_called()
    assert activation.read_journal(manager.journal_path)['phase']=='rolled_back'
    assert manager.ready_context is context


@pytest.mark.parametrize('values',[{'CONTENT_HUB_SSL_CERTFILE':'x'},{'CONTENT_HUB_SSL_KEYFILE':'x'}])
def test_incomplete_tls_rejected_before_logs_or_process(tmp_path,values):
    with pytest.raises(ValueError,match='incomplete_server_tls'):
        activation.ServerActivation(tmp_path,environ=values)
    assert not (tmp_path/'logs').exists()


def test_http_remains_default_and_bad_certificate_fails_closed(tmp_path):
    assert activation.ready_transport(tmp_path,{})==('http',None)
    cert=tmp_path/'bad.pem';cert.write_text('invalid cert')
    with pytest.raises(ssl.SSLError):
        activation.ready_transport(tmp_path,{'CONTENT_HUB_SSL_CERTFILE':str(cert),'CONTENT_HUB_SSL_KEYFILE':str(cert)})


def test_shared_probe_tools_import_has_no_app_or_optional_runtime_startup(tmp_path):
    env=build_smoke_env(os.environ,tmp_path/'import-env',frontend_dist=tmp_path/'dist',
                        python_exe=Path(sys.executable),port=19871)
    code=('import sys; sys.path[:0]=sys.argv[1:]; '
          'import server_activation as a; import qualify_release_artifact as q; '
          'assert a.PROBE_TOOLS is q.TOOLS; '
          'assert not ({"app.config","app.db","app.manage_db","psutil"} & sys.modules.keys()); '
          'print("shared tools imported without app config/DB/psutil")')
    result=subprocess.run([sys.executable,'-E','-s','-B','-X','utf8','-c',code,
                           os.environ.get('P6_SOURCE_DIR',str(ROOT/'tools')),str(ROOT/'tools'),str(ROOT/'backend')],
                          cwd=tmp_path,env=env,capture_output=True,text=True,timeout=15)
    assert result.returncode==0,result.stderr
    assert 'shared tools imported' in result.stdout


def test_source_gate_optional_load_skip_is_not_artifact_eligibility(tmp_path):
    stage,target,receipt,raw,verifier=seed_stage(tmp_path)
    assert activation.validate_source_receipt(receipt,'a'*40,activation.source_inventory(stage))==receipt
    assert receipt['release_eligible'] is False


@pytest.mark.parametrize('damage',['dirty','commit','changed','step_skip','missing_step','file_hash','untracked','duplicate','unknown_inventory'])
def test_bad_source_receipt_or_stage_input_rejected(tmp_path,damage):
    stage,target,value,raw,verifier=seed_stage(tmp_path)
    if damage=='dirty': value['source']['dirty']=True
    elif damage=='commit': value['source']['commit']='c'*40
    elif damage=='changed': value['source_unchanged']=False
    elif damage=='step_skip': value['steps'][0]['status']='skipped'
    elif damage=='missing_step': value['steps'].pop(0)
    elif damage=='file_hash': value['source']['files'][0]['sha256']='f'*64
    elif damage=='untracked': value['source']['files'][0]['tracked']=False
    elif damage=='duplicate': value['steps'].append(copy.deepcopy(value['steps'][0]))
    else: value['source']['file_count']+=1
    value['source_after']=copy.deepcopy(value['source'])
    with pytest.raises(ValueError): activation.validate_source_receipt(value,'a'*40,activation.source_inventory(stage))


def test_probe_receipt_binds_same_stage_and_source_without_self_hash_cycle(tmp_path):
    stage,target,value,raw,verifier=seed_stage(tmp_path)
    before=activation.digest(stage/'server-stage.json')
    result=builder.qualify_stage(tmp_path,stage,target,raw,verifier,probe_run=fake_probe)
    proof=activation.verify_qualification(result,tmp_path/'logs/server-stages')
    assert proof['source_receipt_sha256']==hashlib.sha256(raw).hexdigest()
    assert before==activation.digest(stage/'server-stage.json')
    assert Path(result['qualification_path']).parent!=stage


@pytest.mark.parametrize('damage',['exit','identity','cleanup','descriptor','payload','tool','python','missing_db','stage_change','extra_stage_file'])
def test_probe_failure_never_creates_request_or_passes_qualification(tmp_path,damage):
    stage,target,value,raw,verifier=seed_stage(tmp_path)
    def probe(command,**kwargs):
        result=fake_probe(command,**kwargs)
        if command[-1]=='version': return result
        proof=json.loads(result.stdout)
        if damage=='exit': return subprocess.CompletedProcess(command,1,b'{}',b'')
        if damage=='identity': proof['evidence']['ready']['runtime']['build_id']='wrong'
        if damage=='cleanup': proof['evidence']['process_cleanup']['port_released']=False
        if damage=='descriptor': proof['descriptor_file_sha256']='0'*64
        if damage=='payload': proof['payload_sha256']='0'*64
        if damage=='tool': proof['tool_sha256']={}
        if damage=='python': proof['evidence']['runtime_python_sha256']='0'*64
        if damage=='missing_db': proof['evidence']['databases']=[]
        if damage=='stage_change': (stage/'backend/serve.py').write_bytes(b'changed')
        if damage=='extra_stage_file': (stage/'extra.py').write_bytes(b'changed')
        return subprocess.CompletedProcess(command,0,json_bytes(proof),b'')
    with pytest.raises(ValueError): builder.qualify_stage(tmp_path,stage,target,raw,verifier,probe_run=probe)
    assert not (tmp_path/'logs/server-update-request.json').exists()


def test_supervisor_checks_qualification_before_old_process_or_journal(tmp_path,monkeypatch):
    stage,target,value,raw,verifier=seed_stage(tmp_path)
    manager=activation.ServerActivation(tmp_path,environ={})
    activation.atomic_json(manager.request,{'target':target})
    stopped=Mock();monkeypatch.setattr(manager,'stop_owned',stopped)
    with pytest.raises((ValueError,KeyError)): manager.apply_request()
    stopped.assert_not_called()
    assert not manager.journal_path.exists()


def test_receipt_tampering_is_rejected_on_supervisor_recheck(tmp_path):
    stage,target,value,raw,verifier=seed_stage(tmp_path)
    target=builder.qualify_stage(tmp_path,stage,target,raw,verifier,probe_run=fake_probe)
    Path(target['qualification_path']).write_text('{}')
    with pytest.raises(ValueError,match='qualification_changed'):
        activation.verify_qualification(target,tmp_path/'logs/server-stages')


@pytest.mark.parametrize('damage', ['shim', 'powershell_shim', 'node', 'javascript', 'package', 'binary', 'probe', 'helper', 'activation', 'builder', 'venv', 'venv_config'])
def test_supervisor_rechecks_actual_cli_and_verifier_bytes_before_stopping(tmp_path, monkeypatch, cli_fixture, damage):
    stage,target,value,raw,verifier=seed_stage(tmp_path)
    cli_fixture=stage/'runtime/higgsfield'
    target=builder.qualify_stage(tmp_path,stage,target,raw,verifier,probe_run=fake_probe)
    manager=activation.ServerActivation(tmp_path,environ=dict(os.environ))
    paths={'shim':cli_fixture/'higgsfield.cmd', 'node':cli_fixture/'node.exe',
           'powershell_shim':cli_fixture/'higgsfield.ps1',
           'javascript':cli_fixture/'node_modules/@higgsfield/cli/bin/higgsfield.js',
           'package':cli_fixture/'node_modules/@higgsfield/cli/package.json',
           'binary':cli_fixture/'node_modules/@higgsfield/cli/vendor/hf.exe',
           'probe':tmp_path/'tools/qualify_release_artifact.py',
           'helper':tmp_path/'backend/app/services/isolated_env.py',
           'activation':tmp_path/'tools/server_activation.py', 'builder':tmp_path/'tools/server_release_update.py',
           'venv':stage/'.venv/Scripts/python.exe', 'venv_config':stage/'.venv/pyvenv.cfg'}
    paths[damage].write_bytes(b'changed')
    activation.atomic_json(manager.request,{'target':target})
    stopped=Mock();monkeypatch.setattr(manager,'stop_owned',stopped)
    with pytest.raises(ValueError): manager.apply_request()
    stopped.assert_not_called()
    assert not manager.journal_path.exists()


def test_cli_environment_selected_by_supervisor_ignores_user_path(tmp_path, monkeypatch, cli_fixture):
    stage,target,value,raw,verifier=seed_stage(tmp_path)
    target=builder.qualify_stage(tmp_path,stage,target,raw,verifier,probe_run=fake_probe)
    other=tmp_path/'other-cli'
    import shutil
    shutil.copytree(cli_fixture,other)
    proof=activation.verify_qualification(target,tmp_path/'logs/server-stages',environ={**os.environ,'PATH':str(other)})
    assert proof['server_cli']['files']['shim']['path']==str(stage/'runtime/higgsfield/higgsfield.cmd')


def test_different_supervisor_base_python_is_rejected_before_journal(tmp_path, monkeypatch):
    stage,target,value,raw,verifier=seed_stage(tmp_path)
    target=builder.qualify_stage(tmp_path,stage,target,raw,verifier,probe_run=fake_probe)
    manager=activation.ServerActivation(tmp_path,environ=dict(os.environ))
    other=tmp_path/'other-python.exe';other.write_bytes(b'other interpreter never executed')
    monkeypatch.setattr(sys,'_base_executable',str(other))
    activation.atomic_json(manager.request,{'target':target})
    stopped=Mock();monkeypatch.setattr(manager,'stop_owned',stopped)
    with pytest.raises(ValueError,match='stage_python_base_mismatch'): manager.apply_request()
    stopped.assert_not_called()
    assert not manager.journal_path.exists()


def test_base_python_file_mutation_is_rejected_without_executing_it(tmp_path, monkeypatch):
    base=tmp_path/'fixture-base/python.exe';base.parent.mkdir();base.write_bytes(b'base never executed')
    monkeypatch.setattr(sys,'_base_executable',str(base))
    stage,target,value,raw,verifier=seed_stage(tmp_path)
    target=builder.qualify_stage(tmp_path,stage,target,raw,verifier,probe_run=fake_probe)
    manager=activation.ServerActivation(tmp_path,environ=dict(os.environ))
    base.write_bytes(b'changed base')
    activation.atomic_json(manager.request,{'target':target})
    stopped=Mock();monkeypatch.setattr(manager,'stop_owned',stopped)
    with pytest.raises(ValueError,match='stage_python_base_mismatch'): manager.apply_request()
    stopped.assert_not_called()
    assert not manager.journal_path.exists()


@pytest.mark.parametrize('damage',['home_mismatch','global_site_packages','duplicate'])
def test_venv_base_configuration_is_not_an_unchecked_hint(tmp_path,damage):
    stage,target,value,raw,verifier=seed_stage(tmp_path)
    cfg=stage/'.venv/pyvenv.cfg';text=cfg.read_text()
    if damage=='home_mismatch': text=text.replace(f'home = {Path(sys._base_executable).resolve().parent}',f'home = {tmp_path}')
    elif damage=='global_site_packages': text=text.replace('false','true')
    else: text+='home = duplicate\n'
    cfg.write_text(text)
    with pytest.raises(ValueError): activation.stage_python_base(stage)


@pytest.mark.parametrize('layout', ['sibling', 'hf'])
def test_read_only_cli_resolution_matches_runtime_node_precedence(tmp_path, monkeypatch, cli_fixture, layout):
    stage,target,value,raw,verifier=seed_stage(tmp_path)
    cli_fixture=stage/'runtime/higgsfield'
    monkeypatch.setenv('PATH',str(cli_fixture))
    if layout=='hf':
        (cli_fixture/'higgsfield.cmd').rename(cli_fixture/'hf.cmd')
        expected=cli_fixture/'node.exe'
    else:
        (cli_fixture/'node.exe').unlink()
        expected=cli_fixture.parent/'node/node.exe'
        expected.parent.mkdir(parents=True,exist_ok=True)
        expected.write_bytes(b'fixture alternative node never executed')
    result=activation.inspect_server_cli(stage,tmp_path,os.environ)
    assert result['argv']==[str(expected),str(cli_fixture/'node_modules/@higgsfield/cli/bin/higgsfield.js')]
    assert result['execution_tested'] is False
    # Execute only these pure lookup functions from the real CLI bridge; no app imports or CLI calls.
    import shutil
    tree=ast.parse((ROOT/'backend/app/services/cli_bridge.py').read_text(encoding='utf-8-sig'))
    functions=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in {'cli_path','cli_argv'}]
    namespace={'os':os,'shutil':shutil,'CLIError':RuntimeError,'_CLI_PATH':None,
               '_CLI_JS_REL':str(Path('node_modules/@higgsfield/cli/bin/higgsfield.js'))}
    exec(compile(ast.Module(body=functions,type_ignores=[]),'<pure CLI lookups>','exec'),namespace)
    assert namespace['cli_argv']()==result['argv']


@pytest.mark.parametrize('damage', ['version', 'node_options', 'node_path', 'relative_path', 'native', 'cwd_shadow', 'missing_shim', 'missing_node', 'missing_binary'])
def test_unsupported_or_mismatched_cli_configuration_is_rejected(tmp_path, monkeypatch, cli_fixture, damage):
    stage,target,value,raw,verifier=seed_stage(tmp_path)
    cli_fixture=stage/'runtime/higgsfield'
    env=dict(os.environ)
    if damage=='version': (stage/'hf_cli_version.txt').write_text('2.0.0')
    elif damage=='node_options': env['NODE_OPTIONS']='--require fixture'
    elif damage=='node_path': env['NODE_PATH']='fixture'
    elif damage=='relative_path': env['PATH']='.'
    elif damage=='native':
        (cli_fixture/'higgsfield.cmd').unlink()
        (cli_fixture/'higgsfield.exe').write_bytes(b'fixture native never executed')
    elif damage=='missing_shim': (cli_fixture/'higgsfield.cmd').unlink()
    elif damage=='missing_node': (cli_fixture/'node.exe').unlink()
    elif damage=='missing_binary': (cli_fixture/'node_modules/@higgsfield/cli/vendor/hf.exe').unlink()
    else: (stage/'backend/higgsfield.cmd').write_bytes(b'shadow never executed')
    with pytest.raises(ValueError): activation.inspect_server_cli(stage,tmp_path,env)


@pytest.mark.parametrize('empty_path', ['', ';', ';;'])
def test_empty_path_entries_are_removed_from_inspection_and_server_child(tmp_path, monkeypatch, empty_path):
    stage,target,value,raw,verifier=seed_stage(tmp_path)
    target=builder.qualify_stage(tmp_path,stage,target,raw,verifier,probe_run=fake_probe)
    system_path=str(tmp_path/'system-tools')
    env={**os.environ,'PATH':empty_path+system_path+';'}
    proof=activation.verify_qualification(target,tmp_path/'logs/server-stages',environ=env)
    manager=activation.ServerActivation(tmp_path,environ=env)
    popen=Mock();monkeypatch.setattr(activation.subprocess,'Popen',popen)
    manager.spawn(target)
    child=popen.call_args.kwargs['env']
    assert child['PATH'].split(os.pathsep)==[str(stage/'runtime/higgsfield'),system_path]
    assert activation.inspect_server_cli(stage,tmp_path,child)==proof['server_cli']
    assert env['PATH']==empty_path+system_path+';'


@pytest.mark.parametrize('unsafe_path', ['.;', r'\\server\share;', 'relative;;'])
def test_empty_path_filter_does_not_allow_relative_or_remote_search(tmp_path, unsafe_path):
    stage,target,value,raw,verifier=seed_stage(tmp_path)
    with pytest.raises(ValueError,match='absolute_local_path_required'):
        activation.inspect_server_cli(stage,tmp_path,{**os.environ,'PATH':unsafe_path})


def prepare_fixture(root, monkeypatch, pin='1.2.3'):
    """Real coordinator, fake git/build and common probe subprocess, no executable runs."""
    inputs={name:b'fixture source '+name.encode() for name in
            ('backend/app/main.py','backend/serve.py','backend/schema.sql','backend/requirements.lock.txt',
             'frontend/package.json','frontend/package-lock.json','tools/predeploy_gate.ps1',
             'tools/validation_result.ps1','hf_cli_version.txt')}
    inputs['hf_cli_version.txt']=(pin+'\n').encode()
    inputs['release/compatibility.json']=json_bytes(compat())
    source={'commit':'a'*40,'dirty':False,'sha256':'b'*64,'file_count':len(inputs),
            'files':[{'path':n,'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'tracked':True}
                     for n,raw in inputs.items()]}
    receipt={'format_version':1,'scope':'source-only','status':'passed','passed':True,'release_eligible':False,
             'source':source,'source_after':copy.deepcopy(source),'source_unchanged':True,
             'run_id':'clean-source-fixture','finished_at':'2026-10-18T00:00:01+00:00',
             'steps':[{'name':n,'status':'passed','exit_code':0} for n in activation.SOURCE_STEPS]}
    receipt_path=root/'source-receipt.json';receipt_path.write_bytes(json_bytes(receipt))
    verifier=root/'trusted/python.exe';verifier.parent.mkdir();verifier.write_bytes(b'trusted never executed')
    for name in (*activation.PROBE_TOOLS,*activation.COORDINATOR_TOOLS):
        path=root/name;path.parent.mkdir(parents=True,exist_ok=True)
        path.write_bytes(b'trusted module fixture '+name.encode())
    monkeypatch.setenv('CONTENT_HUB_AUTH_SECRET','fixture secret not forwarded')
    monkeypatch.setenv('CONTENT_HUB_DB',str(root/'outside.db'))
    def git(command,**kwargs):
        assert command[0]=='git'
        if 'show' in command:
            return subprocess.CompletedProcess(command,0,inputs['release/compatibility.json'],b'')
        return subprocess.CompletedProcess(command,0,'a'*40 if 'rev-parse' in command else '', '')
    monkeypatch.setattr(builder.subprocess,'run',git)
    calls=[]
    def run(command,*,cwd,log,env=None):
        calls.append(command)
        if 'archive' in command:
            archive=Path(next(c.split('=',1)[1] for c in command if c.startswith('--output=')))
            with zipfile.ZipFile(archive,'w') as bundle:
                for name,raw in inputs.items(): bundle.writestr(name,raw)
        elif 'venv' in command:
            python=Path(command[-1])/'Scripts/python.exe';python.parent.mkdir(parents=True)
            python.write_bytes(b'stage Python never executed')
            write_venv_config(Path(command[-1]).parent)
        elif 'ci' in command:
            (cwd/'node_modules').mkdir();(cwd/'node_modules/build-only.txt').write_bytes(b'build fixture')
        elif 'build' in command:
            (cwd/'dist').mkdir();(cwd/'dist/index.html').write_bytes(b'<div id="root"></div>')
        elif '--prefix' in command:
            assert command[-1]=='@higgsfield/cli@'+pin
            cli_dir=Path(command[command.index('--prefix')+1])
            write_cli(cli_dir, version=pin)
            (cli_dir/'node.exe').unlink()  # npm installs the package and shims, not Node.
        if env is not None:
            assert 'CONTENT_HUB_AUTH_SECRET' not in env
            assert Path(env['CONTENT_HUB_DB']).is_relative_to(root/'logs')
    return receipt_path,verifier,run,calls


@pytest.mark.parametrize('layout', ['sibling', 'path', 'missing'])
def test_prepare_copies_npm_node_into_stage(tmp_path, monkeypatch, cli_fixture, layout):
    receipt,verifier,run,calls=prepare_fixture(tmp_path,monkeypatch)
    path_dir=tmp_path/'path-node';path_dir.mkdir()
    path_node=path_dir/'node.exe'
    if layout!='missing': path_node.write_bytes(b'fixture PATH node never executed')
    monkeypatch.setenv('PATH',str(cli_fixture)+os.pathsep+str(path_dir))
    if layout!='sibling': (cli_fixture/'node.exe').unlink()
    expected=cli_fixture/'node.exe' if layout=='sibling' else path_node
    def install(command,**kwargs):
        if '--prefix' in command:
            assert Path(command[command.index('--prefix')+1]).is_dir()
            assert Path(shutil.which('node.exe',path=kwargs['env']['PATH']))==expected
        return run(command,**kwargs)
    if layout=='missing':
        with pytest.raises(ValueError,match='node_not_found'):
            builder.prepare(tmp_path,source_receipt=receipt,verification_python=verifier,
                            run=install,probe_run=fake_probe)
        assert not any('--prefix' in c for c in calls)
        assert not (tmp_path/'logs/server-update-request.json').exists()
        return
    builder.prepare(tmp_path,source_receipt=receipt,verification_python=verifier,
                    run=install,probe_run=fake_probe)
    target=json.loads((tmp_path/'logs/server-update-request.json').read_bytes())['target']
    node=Path(target['path'])/'runtime/higgsfield/node.exe'
    assert node.read_bytes()==expected.read_bytes()
    proof=activation.verify_qualification(target,tmp_path/'logs/server-stages')
    assert proof['server_cli']['files']['node']=={'path':str(node),'sha256':activation.digest(expected)}


@pytest.mark.parametrize('old_cli', ['missing', '1.1.26'])
def test_post_1358_next_stage_prepares_pinned_cli_for_admin_and_system(tmp_path, monkeypatch, cli_fixture, old_cli):
    receipt,verifier,run,calls=prepare_fixture(tmp_path,monkeypatch,pin='1.2.2')
    if old_cli=='missing':
        (cli_fixture/'higgsfield.cmd').unlink()
    else:
        (cli_fixture/'node_modules/@higgsfield/cli/package.json').write_bytes(
            json_bytes({'name':'@higgsfield/cli','version':old_cli}))
    old_package=(cli_fixture/'node_modules/@higgsfield/cli/package.json').read_bytes()
    # The first git transition left no stage pointer and did not update the user's CLI.
    (tmp_path/'VERSION.txt').write_text('2026.10.16-1358')
    builder.prepare(tmp_path,source_receipt=receipt,verification_python=verifier,run=run,probe_run=fake_probe)
    target=json.loads((tmp_path/'logs/server-update-request.json').read_bytes())['target']
    stage=Path(target['path'])
    system_env={**os.environ,'PATH':str(tmp_path/'system-only')}
    proof=activation.verify_qualification(target,tmp_path/'logs/server-stages',environ=system_env)
    assert proof['server_cli']['version']=='1.2.2'
    assert proof['server_cli']['files']['shim']['path']==str(stage/'runtime/higgsfield/higgsfield.cmd')
    assert any(c[-1]=='@higgsfield/cli@1.2.2' and '--prefix' in c and '--global' in c
               and '--ignore-scripts=false' in c for c in calls)
    assert (cli_fixture/'node_modules/@higgsfield/cli/package.json').read_bytes()==old_package
    popen=Mock();monkeypatch.setattr(activation.subprocess,'Popen',popen)
    manager=activation.ServerActivation(tmp_path,environ=system_env)
    manager.spawn(target)
    launched_env=popen.call_args.kwargs['env']
    assert activation.inspect_server_cli(stage,tmp_path,launched_env)==proof['server_cli']
    assert Path(shutil.which('higgsfield',path=launched_env['PATH'])).resolve()==stage/'runtime/higgsfield/higgsfield.cmd'
    assert proof['server_cli']['files']['node']['path']==str(stage/'runtime/higgsfield/node.exe')


def test_failed_stage_cli_install_preserves_running_source_and_never_requests_activation(tmp_path, monkeypatch):
    receipt,verifier,run,calls=prepare_fixture(tmp_path,monkeypatch)
    sentinel=tmp_path/'backend/serve.py'
    sentinel.write_bytes(b'legacy running source')
    def fail_install(command,**kwargs):
        if '--prefix' in command:
            raise RuntimeError('fixture CLI install failed')
        return run(command,**kwargs)
    with pytest.raises(RuntimeError,match='fixture CLI install failed'):
        builder.prepare(tmp_path,source_receipt=receipt,verification_python=verifier,
                        run=fail_install,probe_run=fake_probe)
    assert sentinel.read_bytes()==b'legacy running source'
    assert not (tmp_path/'logs/server-update-request.json').exists()
    assert not (tmp_path/'logs/server-current.json').exists()


@pytest.mark.parametrize('failure', ['wrong_version', 'version_prefix', 'first_version',
                                     'banner_version_prefix', 'empty', 'exit', 'broken_node', 'timeout'])
def test_failed_cli_execution_blocks_prepare_without_touching_running_server(tmp_path, monkeypatch, failure):
    receipt,verifier,run,calls=prepare_fixture(tmp_path,monkeypatch)
    sentinel=tmp_path/'backend/serve.py';sentinel.write_bytes(b'old running server')
    probes=[]
    def probe(command,**kwargs):
        probes.append(command)
        if command[-1]!='version': return fake_probe(command,**kwargs)
        fake_probe(command,**kwargs)  # Also enforce isolation and staged executable identity.
        if failure=='broken_node': raise OSError('fixture invalid executable')
        if failure=='timeout': raise subprocess.TimeoutExpired(command,60)
        output={'wrong_version':b'higgsfield 1.2.4', 'version_prefix':b'higgsfield 1.2.30',
                'first_version':b'notice\nhiggsfield 1.2.4\nhiggsfield 1.2.3\n',
                'banner_version_prefix':b'notice\nhiggsfield 1.2.30\n',
                'empty':b'', 'exit':b'higgsfield 1.2.3'}[failure]
        return subprocess.CompletedProcess(command,1 if failure=='exit' else 0,output,b'')
    with pytest.raises((ValueError,OSError,subprocess.TimeoutExpired)):
        builder.prepare(tmp_path,source_receipt=receipt,verification_python=verifier,run=run,probe_run=probe)
    assert len(probes)==1 and probes[0][-1]=='version'
    assert sentinel.read_bytes()==b'old running server'
    assert not (tmp_path/'logs/server-current.json').exists()
    assert not (tmp_path/'logs/server-update-request.json').exists()
    assert json.loads((tmp_path/'logs/server-prepare.json').read_bytes())['status']=='failed'


@pytest.mark.parametrize('suffix', ['', ' (windows-amd64)'])
@pytest.mark.parametrize('prefix', ['', 'startup notice\r\n', 'startup notice\r\n\r\n  '])
def test_cli_version_probe_runs_once_before_runtime_qualification(tmp_path, monkeypatch, suffix, prefix):
    receipt,verifier,run,calls=prepare_fixture(tmp_path,monkeypatch)
    probes=[]
    def probe(command,**kwargs):
        probes.append(command)
        result=fake_probe(command,**kwargs)
        if command[-1]=='version': result.stdout=(prefix+'higgsfield 1.2.3'+suffix+'\r\n').encode()
        return result
    builder.prepare(tmp_path,source_receipt=receipt,verification_python=verifier,run=run,probe_run=probe)
    assert len(probes)==2 and probes[0][-1]=='version' and 'probe' in probes[1]
    target=json.loads((tmp_path/'logs/server-update-request.json').read_bytes())['target']
    assert probes[0]==[str(Path(target['path'])/'runtime/higgsfield/node.exe'),
                       str(Path(target['path'])/'runtime/higgsfield/node_modules/@higgsfield/cli/bin/higgsfield.js'),'version']


def test_default_cli_probe_uses_file_output_and_bounded_tree_cleanup(tmp_path, monkeypatch):
    stage,target,receipt,raw,verifier=seed_stage(tmp_path)
    process=Mock(pid=123456)
    process.wait.side_effect=[subprocess.TimeoutExpired('fixture',60), 0]
    def launch(command, **kwargs):
        assert command[-1]=='version'
        assert kwargs['stdout'] != subprocess.PIPE
        assert Path(kwargs['cwd']).is_relative_to(tmp_path/'logs')
        return process
    monkeypatch.setattr(builder.subprocess,'Popen',launch)
    # Even an unavailable or stuck taskkill must not restore an unbounded wait.
    kill=Mock(side_effect=subprocess.TimeoutExpired('taskkill',5))
    monkeypatch.setattr(builder.subprocess,'run',kill)
    with pytest.raises(ValueError,match='^isolated_stage_cli_version_failed$'):
        builder.qualify_stage(tmp_path,stage,target,raw,verifier)
    assert process.wait.call_args_list[0].kwargs=={'timeout':60}
    assert process.wait.call_args_list[1].kwargs=={'timeout':5}
    process.kill.assert_called_once()
    process.communicate.assert_not_called()
    if os.name=='nt':
        assert kill.call_args.args[0]==['taskkill','/F','/T','/PID','123456']
        assert kill.call_args.kwargs['timeout']==5
    assert not (tmp_path/'logs/server-update-request.json').exists()


@pytest.mark.skipif(os.name!='nt', reason='Windows process-tree timeout regression')
def test_cli_descendant_cannot_hang_prepare_or_touch_running_server(tmp_path):
    import psutil
    # A separate driver bounds the old subprocess.run/communicate deadlock too.
    driver_code=r'''
import sys
from pathlib import Path
import pytest
import test_server_qualification as t
root=Path(sys.argv[1])
with pytest.MonkeyPatch.context() as mp:
    receipt,verifier,run,calls=t.prepare_fixture(root,mp)
    git=t.builder.subprocess.run
    mp.setattr(t.builder.subprocess,'run',lambda command,**kw:
               t.REAL_RUN(command,**kw) if command[0]=='taskkill' else git(command,**kw))
    sentinel=root/'backend/serve.py'
    sentinel.write_bytes(b'old running server')
    pids=root/'cli-pids.txt'
    child_code='import time; time.sleep(60)'
    cli_code=("import os,subprocess,sys,time; from pathlib import Path; "
              f"child=subprocess.Popen([sys.executable,'-c',{child_code!r}]); "
              f"Path({str(pids)!r}).write_text(str(os.getpid())+' '+str(child.pid)); "
              "print('higgsfield 1.2.3',flush=True); time.sleep(60)")
    def probe(command,**kwargs):
        assert command[-1]=='version', 'runtime probe must not start'
        t.fake_probe(command,**kwargs)
        kwargs['timeout']=1
        runner=getattr(t.builder,'_run_cli_version',t.REAL_RUN)
        return runner([sys.executable,'-c',cli_code],**kwargs)
    with pytest.raises(ValueError,match='^isolated_stage_cli_version_failed$'):
        t.builder.prepare(root,source_receipt=receipt,verification_python=verifier,
                          run=run,probe_run=probe)
    assert sentinel.read_bytes()==b'old running server'
    assert not (root/'logs/server-current.json').exists()
    assert not (root/'logs/server-update-request.json').exists()
    assert t.json.loads((root/'logs/server-prepare.json').read_bytes())['status']=='failed'
'''
    with (tmp_path/'driver.log').open('w+b') as output:
        driver=subprocess.Popen([sys.executable,'-B','-c',driver_code,str(tmp_path)],
                                cwd=Path(__file__).parent, stdout=output, stderr=output,
                                creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            try:
                driver.wait(timeout=20)
            except subprocess.TimeoutExpired:
                pytest.fail('CLI descendant held output open beyond the preparation deadline')
            output.seek(0)
            assert driver.returncode==0, output.read().decode('utf-8',errors='replace')
            pids=[int(pid) for pid in (tmp_path/'cli-pids.txt').read_text().split()]
            assert len(pids)==2
            assert not [pid for pid in pids if psutil.pid_exists(pid)]
        finally:
            if driver.poll() is None:
                REAL_RUN(['taskkill','/F','/T','/PID',str(driver.pid)],
                         stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)
                driver.wait(timeout=5)
            pid_file=tmp_path/'cli-pids.txt'
            for pid in (pid_file.read_text().split() if pid_file.exists() else []):
                if psutil.pid_exists(int(pid)):
                    REAL_RUN(['taskkill','/F','/T','/PID',pid],
                             stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)


@pytest.mark.parametrize('pin', ['latest', '1.2.2 & echo unsafe'])
def test_invalid_stage_cli_pin_is_rejected_before_npm_install(tmp_path, monkeypatch, pin):
    receipt,verifier,run,calls=prepare_fixture(tmp_path,monkeypatch,pin=pin)
    with pytest.raises(ValueError,match='server_cli_version_invalid'):
        builder.prepare(tmp_path,source_receipt=receipt,verification_python=verifier,run=run,probe_run=fake_probe)
    assert not any('--prefix' in c for c in calls)
    assert not (tmp_path/'logs/server-update-request.json').exists()


def test_complete_prepare_request_and_supervisor_verified_path(tmp_path, monkeypatch):
    receipt,verifier,run,calls=prepare_fixture(tmp_path,monkeypatch)
    run_id=builder.prepare(tmp_path,source_receipt=receipt,verification_python=verifier,
                           run=run,probe_run=fake_probe)
    request=json.loads((tmp_path/'logs/server-update-request.json').read_bytes())
    target=request['target'];stage=Path(target['path'])
    assert target['build_id']==run_id
    assert not (tmp_path/'logs/server-current.json').exists()
    assert not (stage/'frontend/node_modules').exists()
    assert any('--require-hashes' in c for c in calls)
    assert activation.verify_qualification(target,tmp_path/'logs/server-stages')['activation_eligible'] is True
    manager=activation.ServerActivation(tmp_path,environ=dict(os.environ))
    class Process:
        def __init__(self): self.stopped=False
        def poll(self): return 0 if self.stopped else None
        def terminate(self): self.stopped=True
        def wait(self,timeout=None): return 0
    manager.process=Process();old=manager.process
    phases=[];original_advance=activation.advance
    def advance(path,journal,phase,**changes):
        phases.append(phase)
        return original_advance(path,journal,phase,**changes)
    monkeypatch.setattr(activation,'advance',advance)
    monkeypatch.setattr(manager,'wait_ready',lambda *a,**kw:{'pid':123,'creation_time':'synthetic'})
    row={'key':'fixture','database_id':'fixture-db','status':'compatible','schema_version':1,
         'minimum_reader_protocol':1,'minimum_writer_protocol':1,'components':['content_core']}
    monkeypatch.setattr(manager,'checkpoint',lambda _:[row])
    def spawn(current,*,pending=False):
        assert activation.read_journal(manager.journal_path)['db_mutation_possible']
        manager.process=Process()
    monkeypatch.setattr(manager,'spawn',spawn)
    journal=manager.apply_request()
    assert phases[0]=='verified' and phases[-1]=='committed'
    assert old.stopped and journal['phase']=='committed' and not manager.request.exists()


@pytest.mark.parametrize('damage', ['receipt_commit','required_skip','probe_failure','verifier_mutation','source_mutation'])
def test_prepare_failures_leave_old_tree_and_request_untouched(tmp_path, monkeypatch, damage):
    receipt,verifier,run,calls=prepare_fixture(tmp_path,monkeypatch)
    sentinel=tmp_path/'backend/running.txt';sentinel.write_bytes(b'old service unchanged')
    if damage in {'receipt_commit','required_skip'}:
        value=json.loads(receipt.read_bytes())
        if damage=='receipt_commit': value['source']['commit']='c'*40;value['source_after']=copy.deepcopy(value['source'])
        else: value['steps'][0]['status']='skipped'
        receipt.write_bytes(json_bytes(value))
    def probe(command,**kwargs):
        if damage=='probe_failure': return subprocess.CompletedProcess(command,1,b'{}',b'')
        result=fake_probe(command,**kwargs)
        if damage=='verifier_mutation': verifier.write_bytes(b'changed verifier')
        if damage=='source_mutation': receipt.write_bytes(receipt.read_bytes()+b' ')
        return result
    with pytest.raises(ValueError):
        builder.prepare(tmp_path,source_receipt=receipt,verification_python=verifier,run=run,probe_run=probe)
    if damage in {'receipt_commit','required_skip'}:
        # A receipt for another commit (e.g. origin/main moved after it was chosen) stops before any install.
        assert not any({'venv','pip','ci','build','--prefix'} & set(c) for c in calls), calls
    assert sentinel.read_bytes()==b'old service unchanged'
    assert not (tmp_path/'logs/server-current.json').exists()
    assert not (tmp_path/'logs/server-update-request.json').exists()
    assert json.loads((tmp_path/'logs/server-prepare.json').read_bytes())['status']=='failed'


def real_prepare_fixture(tmp_path, monkeypatch):
    """Local Git history/checkout/fetch; build, probe and service activation stay fake."""
    if not GIT:
        pytest.skip('Git is required')
    monkeypatch.setenv('PATH', str(Path(GIT).parent) + os.pathsep + os.environ['PATH'])
    root = tmp_path / 'repository'
    root.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)

    def git(folder, *args):
        return REAL_RUN([GIT, '-C', str(folder), '-c', 'user.name=Fixture',
                         '-c', 'user.email=fixture@example.invalid', '-c', 'core.autocrlf=false',
                         *args], check=True, capture_output=True, env=env).stdout

    git(root, 'init', '-b', 'main')
    for name in ('backend/app/main.py', 'backend/serve.py', 'backend/schema.sql',
                 'backend/requirements.lock.txt', 'frontend/package.json', 'frontend/package-lock.json',
                 'tools/predeploy_gate.ps1', 'tools/validation_result.ps1',
                 *activation.PROBE_TOOLS, *activation.COORDINATOR_TOOLS):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'fixture never executed\n')
    (root / 'hf_cli_version.txt').write_bytes(b'1.2.3\n')
    (root / '.gitignore').write_bytes(b'logs/\n')
    (root / '.gitattributes').write_bytes(b'* text=auto eol=lf\n')
    (root / 'release').mkdir()
    (root / 'release/compatibility.json').write_bytes(json_bytes(compat()))
    (root / 'frontend/binary.bin').write_bytes(b'\0binary\nunchanged\r\n')
    git(root, 'add', '.')
    git(root, 'commit', '-m', 'Fixture old tree')
    selected = tmp_path / 'selected'
    git(tmp_path, 'clone', str(root), str(selected))
    declared = {**compat(), 'supported_components': ['content_core', 'manage']}
    (selected / 'release/compatibility.json').write_bytes(json_bytes(declared))
    (selected / '.gitattributes').write_bytes(b'* text=auto eol=lf\n*.ps1 text eol=crlf\n')
    (selected / 'frontend/.gitattributes').write_bytes(b'*.json text eol=crlf\n')
    git(selected, 'add', '.')
    git(selected, 'commit', '-m', 'Fixture selected declaration and line endings')
    # A fresh checkout supplies the same physical bytes as the gate machine.
    checkout = tmp_path / 'gate-checkout'
    git(tmp_path, 'clone', str(selected), str(checkout))
    commit = git(selected, 'rev-parse', 'HEAD').decode().strip()
    git(root, 'remote', 'add', 'origin', str(selected))
    source_files = activation.source_inventory(checkout)
    source = {'commit': commit, 'dirty': False, 'sha256': 'b' * 64, 'file_count': len(source_files),
              'files': [{'path': n, 'size': (checkout/n).stat().st_size, 'sha256': h, 'tracked': True}
                        for n, h in source_files.items()]}
    receipt = tmp_path / 'source-receipt.json'
    receipt.write_bytes(json_bytes({'format_version': 1, 'scope': 'source-only', 'status': 'passed',
        'passed': True, 'release_eligible': False, 'source': source, 'source_after': copy.deepcopy(source),
        'source_unchanged': True, 'run_id': 'fixture-real-git', 'finished_at': '2026-10-21T00:00:00+00:00',
        'steps': [{'name': n, 'status': 'passed', 'exit_code': 0} for n in activation.SOURCE_STEPS]}))
    verifier = tmp_path / 'verifier.exe'
    verifier.write_bytes(b'never executed')
    calls = []

    def run(command, *, cwd, log, env=None):
        calls.append(command)
        if command[0] == 'git':
            git(cwd, *command[1:])
        elif 'venv' in command:
            python = Path(command[-1]) / 'Scripts/python.exe'
            python.parent.mkdir(parents=True)
            python.write_bytes(b'never executed')
            write_venv_config(Path(command[-1]).parent)
        elif 'build' in command:
            (cwd / 'dist').mkdir()
            (cwd / 'dist/index.html').write_bytes(b'fixture')
        elif '--prefix' in command:
            pin=(cwd/'hf_cli_version.txt').read_text(encoding='utf-8-sig').strip()
            assert command[-1]=='@higgsfield/cli@'+pin
            cli_dir=Path(command[command.index('--prefix')+1])
            write_cli(cli_dir, version=pin)
            (cli_dir/'node.exe').unlink()  # Node is copied separately by prepare.

    return root, selected, checkout, declared, receipt, verifier, run, calls, git


def test_prepare_reads_compatibility_from_selected_commit(tmp_path, monkeypatch):
    root, selected, checkout, declared, receipt, verifier, run, calls, git = real_prepare_fixture(tmp_path, monkeypatch)
    assert json.loads((root/'release/compatibility.json').read_bytes()) != declared
    builder.prepare(root, source_receipt=receipt, verification_python=verifier, run=run, probe_run=fake_probe)
    target = json.loads((root/'logs/server-update-request.json').read_bytes())['target']
    descriptor = json.loads((Path(target['path'])/'server-stage.json').read_bytes())
    assert target['compatibility'] == descriptor['compatibility'] == declared
    assert descriptor['source_commit'] == git(selected, 'rev-parse', 'HEAD').decode().strip()
    assert descriptor['source_files']['release/compatibility.json'] == activation.digest(checkout/'release/compatibility.json')
    assert git(root, 'status', '--porcelain') == b''


def test_windows_checkout_bytes_match_prepared_stage(tmp_path, monkeypatch):
    root, selected, checkout, declared, receipt, verifier, run, calls, git = real_prepare_fixture(tmp_path, monkeypatch)
    builder.prepare(root, source_receipt=receipt, verification_python=verifier, run=run, probe_run=fake_probe)
    stage = Path(json.loads((root/'logs/server-update-request.json').read_bytes())['target']['path'])
    for name in ('tools/predeploy_gate.ps1', 'tools/validation_result.ps1', 'frontend/package.json'):
        assert b'\r\n' in (checkout/name).read_bytes()
        assert (stage/name).read_bytes() == (checkout/name).read_bytes()
    assert (stage/'backend/serve.py').read_bytes() == (checkout/'backend/serve.py').read_bytes()
    assert (stage/'frontend/binary.bin').read_bytes() == (checkout/'frontend/binary.bin').read_bytes()


def test_prepare_rejects_real_untracked_source(tmp_path, monkeypatch):
    root, selected, checkout, declared, receipt, verifier, run, calls, git = real_prepare_fixture(tmp_path, monkeypatch)
    (root/'untracked.txt').write_bytes(b'operator file')
    with pytest.raises(ValueError, match='server_source_is_dirty'):
        builder.prepare(root, source_receipt=receipt, verification_python=verifier, run=run)
    assert not calls
    assert not (root/'logs/server-update-request.json').exists()


@pytest.mark.parametrize('damage', ['missing', 'invalid', 'undecided', 'duplicate_component', 'no_reader', 'no_components'])
def test_missing_or_invalid_commit_declaration_creates_no_request(tmp_path, monkeypatch, damage):
    root, selected, checkout, declared, receipt, verifier, run, calls, git = real_prepare_fixture(tmp_path, monkeypatch)
    path = selected/'release/compatibility.json'
    if damage == 'missing':
        path.unlink()
    elif damage == 'invalid':
        path.write_bytes(b'{invalid')
    else:
        if damage == 'undecided': declared['rollout'] = None
        elif damage == 'duplicate_component': declared['supported_components'] = ['content_core', 'content_core']
        elif damage == 'no_reader': declared.pop('reader_protocol')
        else: declared.pop('supported_components')
        path.write_bytes(json_bytes(declared))
    git(selected, 'add', '.')
    git(selected, 'commit', '-m', 'Fixture invalid declaration')
    expected = '^selected_commit_declaration_missing$' if damage == 'missing' else None
    with pytest.raises(ValueError, match=expected):
        builder.prepare(root, source_receipt=receipt, verification_python=verifier, run=run)
    assert not (root/'logs/server-update-request.json').exists()
    assert not any('archive' in c for c in calls)
    assert not any('venv' in c for c in calls)


def test_checkout_line_endings_are_not_ignored_by_receipt(tmp_path, monkeypatch):
    root, selected, checkout, declared, receipt, verifier, run, calls, git = real_prepare_fixture(tmp_path, monkeypatch)
    proof = json.loads(receipt.read_bytes())
    for row in proof['source']['files']:
        if row['path'] == 'tools/predeploy_gate.ps1':
            lf_bytes = (checkout/row['path']).read_bytes().replace(b'\r\n', b'\n')
            row['sha256'] = hashlib.sha256(lf_bytes).hexdigest()
    proof['source_after'] = copy.deepcopy(proof['source'])
    receipt.write_bytes(json_bytes(proof))
    with pytest.raises(ValueError, match='source_gate_stage_bytes_mismatch'):
        builder.prepare(root, source_receipt=receipt, verification_python=verifier, run=run)
    assert not (root/'logs/server-update-request.json').exists()
    assert not any('venv' in c for c in calls)


def test_selected_declaration_is_bound_to_source_receipt(tmp_path, monkeypatch):
    root, selected, checkout, declared, receipt, verifier, run, calls, git = real_prepare_fixture(tmp_path, monkeypatch)
    proof = json.loads(receipt.read_bytes())
    for row in proof['source']['files']:
        if row['path'] == 'release/compatibility.json':
            row['sha256'] = activation.digest(root/'release/compatibility.json')
    proof['source_after'] = copy.deepcopy(proof['source'])
    receipt.write_bytes(json_bytes(proof))
    with pytest.raises(ValueError, match='source_gate_stage_bytes_mismatch'):
        builder.prepare(root, source_receipt=receipt, verification_python=verifier, run=run)
    assert not (root/'logs/server-update-request.json').exists()
    assert not any('venv' in c for c in calls)


def test_archive_declaration_must_match_selected_commit(tmp_path, monkeypatch):
    receipt, verifier, run, calls = prepare_fixture(tmp_path, monkeypatch)

    def altered_archive(command, **kwargs):
        run(command, **kwargs)
        if 'archive' in command:
            path = Path(next(c.split('=', 1)[1] for c in command if c.startswith('--output=')))
            with zipfile.ZipFile(path) as archive:
                entries = {name: archive.read(name) for name in archive.namelist()}
            entries['release/compatibility.json'] = json_bytes({**compat(), 'supported_components': ['manage']})
            with zipfile.ZipFile(path, 'w') as archive:
                for name, raw in entries.items():
                    archive.writestr(name, raw)

    with pytest.raises(ValueError, match='staged_compatibility_mismatch'):
        builder.prepare(tmp_path, source_receipt=receipt, verification_python=verifier, run=altered_archive)
    assert not (tmp_path/'logs/server-update-request.json').exists()
    assert not any('venv' in c for c in calls)
