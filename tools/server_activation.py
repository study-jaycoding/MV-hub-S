"""Stable supervisor's local stage transaction. Never restores database bytes."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import ssl
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
import uuid
from contextlib import contextmanager

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.services.install_journal import atomic_json, advance, new_journal, read_journal, rollback_decision
from install_db_probe import snapshot
from app.services.release_contract import compatibility as release_compatibility, document, digest as is_digest
from qualify_release_artifact import TOOLS as PROBE_TOOLS


# v2: no source-gate receipt; only gated commits reach main (Jay 10-22). v1 records are rejected.
SOURCE_PROFILE = 'server-source-v2'
# Server runtime inputs every stage must carry; checked before building and on every supervisor recheck.
REQUIRED_SOURCE_INPUTS = frozenset({'backend/app/main.py', 'backend/serve.py', 'backend/schema.sql',
                                    'backend/requirements.lock.txt', 'frontend/package.json',
                                    'frontend/package-lock.json', 'hf_cli_version.txt'})
COORDINATOR_TOOLS = ('tools/server_activation.py', 'tools/server_release_update.py')


def qualification_tools(root):
    return {name: digest(local_child(root / name, root)) for name in (*PROBE_TOOLS, *COORDINATOR_TOOLS)}


def stage_python_base(stage):
    values = {}
    for line in (stage / '.venv/pyvenv.cfg').read_text(encoding='utf-8-sig').splitlines():
        if '=' in line:
            key, value = line.split('=', 1)
            if key.strip() in values:
                raise ValueError('stage_venv_configuration_duplicate')
            values[key.strip()] = value.strip()
    home = Path(values.get('home', ''))
    executable = Path(values.get('executable', ''))
    if (not home.is_absolute() or not executable.is_absolute()
            or values.get('include-system-site-packages', '').lower() != 'false'
            or executable.resolve() != (home / 'python.exe').resolve()):
        raise ValueError('stage_venv_base_configuration_mismatch')
    base = local_child(executable, home)
    return {'path': str(base), 'sha256': digest(base)}


def source_inventory(stage):
    """Gate-covered source inputs; dependencies and produced dist are separate payload."""
    result = {}
    for path in stage.rglob('*'):
        name = path.relative_to(stage).as_posix()
        if (not path.is_file() or name == 'server-stage.json' or name.startswith('runtime/')
                or any(p in {'.venv', 'node_modules', 'dist', '__pycache__'} for p in Path(name).parts)
                or any(p.startswith('.') for p in Path(name).parts)):
            continue
        if (re.search(r'\.(py|ps1|bat|ts|tsx|js|cjs|mjs|json|toml|ini|sql|html|css|xml|ya?ml)$', name)
                or Path(name).name in {'requirements.lock.txt', 'hf_cli_version.txt'}):
            local_child(path, stage)
            result[name] = digest(path)
    return result


def require_source_inputs(inputs):
    if not REQUIRED_SOURCE_INPUTS <= inputs.keys() or not all(is_digest(h) for h in inputs.values()):
        raise ValueError('stage_source_inputs_missing')


def server_cli_environment(stage, env):
    # Bind qualification and the SYSTEM child to this stage, not the admin's npm profile.
    cli_dir = str(stage / 'runtime/higgsfield')
    # Empty PATH entries search cwd; remove them from both inspection and the child.
    return {**env, 'PATH': os.pathsep.join(p for p in (cli_dir, *env.get('PATH', '').split(os.pathsep)) if p)}


def inspect_server_cli(stage, server_root, env):
    """Read the Windows npm entry selected by cli_bridge.cli_argv; never run CLI code."""
    env = server_cli_environment(stage, env)
    if os.name != 'nt' or any(env.get(k) for k in ('NODE_OPTIONS', 'NODE_PATH')):
        raise ValueError('unsupported_server_cli_environment')
    # shutil.which uses these ambient Windows options. Reject a different child interpretation.
    if any(env.get(k, '') != os.environ.get(k, '') for k in ('PATHEXT', 'NoDefaultCurrentDirectoryInExePath')):
        raise ValueError('server_cli_search_environment_mismatch')
    search = env.get('PATH', '')
    parts = search.split(os.pathsep)
    if not search or any(not p or not Path(p).is_absolute() or p.startswith(('\\\\', '//')) for p in parts):
        raise ValueError('server_cli_absolute_local_path_required')
    # The service and updater have different cwd; don't allow cwd command shadowing.
    extensions = env.get('PATHEXT', '.COM;.EXE;.BAT;.CMD').split(os.pathsep)
    for folder in {stage / 'backend', server_root / 'backend', Path.cwd()}:
        for stem in ('higgsfield', 'hf', 'node'):
            for suffix in ('', *extensions):
                if (folder / (stem + suffix)).exists():
                    raise ValueError('server_cli_cwd_shadow_unsupported')
    found = shutil.which('higgsfield', path=search) or shutil.which('hf', path=search)
    if not found or Path(found).suffix.lower() not in {'.cmd', '.bat'}:
        raise ValueError('server_cli_npm_shim_required')
    shim = local_child(Path(found), stage / 'runtime/higgsfield')
    package = shim.parent / 'node_modules/@higgsfield/cli/package.json'
    js = shim.parent / 'node_modules/@higgsfield/cli/bin/higgsfield.js'
    binary = package.parent / 'vendor/hf.exe'
    candidates = (shim.parent / 'node.exe', shim.parent.parent / 'node/node.exe',
                  shutil.which('node.exe', path=search))
    node = next((Path(p) for p in candidates if p and Path(p).is_file()), None)
    if node is None or not package.is_file() or not js.is_file() or not binary.is_file():
        raise ValueError('server_cli_entry_missing')
    local_child(node, stage / 'runtime')
    expected = (stage / 'hf_cli_version.txt').read_text(encoding='utf-8-sig').strip()
    metadata = document(package.read_bytes())
    if (not re.fullmatch(r'\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?', expected)
            or metadata.get('name') != '@higgsfield/cli' or metadata.get('version') != expected):
        raise ValueError('server_cli_version_mismatch')
    paths = {'shim': shim, 'package': package, 'javascript': js, 'node': node, 'binary': binary}
    files = {name: {'path': str(local_child(path, path.parent)), 'sha256': digest(path)}
             for name, path in paths.items()}
    return {'profile': 'windows-npm-cli-read-v1', 'version': expected, 'files': files,
            'argv': [files['node']['path'], files['javascript']['path']], 'execution_tested': False}


def verify_qualification(target, stages, descriptor=None, *, environ=None):
    descriptor = descriptor or verify_stage(Path(target['path']), stages, target['manifest_sha256'])
    base = stage_python_base(Path(target['path']))
    if (descriptor.get('python_base') != base or base['path'] != str(Path(sys._base_executable).resolve())
            or base['sha256'] != digest(sys._base_executable)):
        raise ValueError('stage_python_base_mismatch')
    record = local_child(Path(target['qualification_path']), stages.parent / 'server-qualifications')
    if digest(record) != target['qualification_sha256']:
        raise ValueError('stage_qualification_changed')
    value = document(record.read_bytes())
    if (value.get('format_version') != 1 or value.get('scope') != 'server-stage'
            or value.get('status') != 'passed' or value.get('profile') != SOURCE_PROFILE
            or value.get('release_eligible') is not False or value.get('activation_eligible') is not True
            or value.get('build_id') != descriptor['build_id'] or value.get('role') != 'server'
            or value.get('manifest_sha256') != target['manifest_sha256']
            or value.get('source_commit') != descriptor['source_commit']
            or value.get('checks') != {'isolated_runtime': 'passed', 'server_cli_entry': 'passed',
                                       'cleanup': 'passed'}):
        raise ValueError('stage_qualification_mismatch')
    inputs = descriptor['source_files']
    if (inputs != source_inventory(Path(target['path']))
            or any(descriptor['files'].get(name) != hashed for name, hashed in inputs.items())):
        raise ValueError('stage_source_changed')
    require_source_inputs(inputs)
    validate_runtime_proof(value.get('runtime', {}), value.get('tool_sha256', {}), descriptor)
    current_tools = qualification_tools(stages.parent.parent)
    if (value.get('qualification_tools') != current_tools
            or value.get('tool_sha256') != {name: current_tools[name] for name in PROBE_TOOLS}):
        raise ValueError('stage_qualification_tools_changed')
    if value.get('server_cli') != inspect_server_cli(Path(target['path']), stages.parent.parent,
                                                    os.environ if environ is None else environ):
        raise ValueError('server_cli_entry_changed')
    return value


def validate_runtime_proof(proof, hashes, descriptor):
    identity = proof.get('ready', {}).get('runtime', {})
    if (proof.get('fresh_data') is not True or proof.get('temp_removed') is not True
            or proof.get('process_cleanup', {}).get('port_released') is not True
            or proof.get('ready', {}).get('status') != 'ready' or not identity.get('execution_nonce')
            or identity.get('build_id') != descriptor['build_id'] or identity.get('role') != 'server'
            or identity.get('process_id') != proof.get('listener_pid')
            or proof.get('runtime_python_sha256') != descriptor['files'].get('.venv/Scripts/python.exe')
            or not proof.get('databases') or not proof.get('frontend_files')
            or set(hashes) != set(PROBE_TOOLS) or not all(is_digest(h) for h in hashes.values())):
        raise ValueError('stage_runtime_proof_incomplete')


def ready_transport(root, env):
    cert = str(env.get('CONTENT_HUB_SSL_CERTFILE', '')).strip()
    key = str(env.get('CONTENT_HUB_SSL_KEYFILE', '')).strip()
    if bool(cert) != bool(key):
        raise ValueError('incomplete_server_tls_configuration')
    if not cert:
        return 'http', None
    for name, raw in (('CONTENT_HUB_SSL_CERTFILE', cert), ('CONTENT_HUB_SSL_KEYFILE', key)):
        path = Path(raw)
        path = path if path.is_absolute() else root / 'backend' / path
        if not path.is_file():
            raise ValueError('server_tls_file_missing')
        env[name] = str(path.resolve())
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(env['CONTENT_HUB_SSL_CERTFILE'], env['CONTENT_HUB_SSL_KEYFILE'], password='')
    # Trust this explicitly configured certificate, retaining hostname/CERT_REQUIRED.
    context = ssl.create_default_context(cafile=env['CONTENT_HUB_SSL_CERTFILE'])
    return 'https', context


def tls_file_identity(env):
    # Kept only in supervisor memory; private-key fingerprints must never enter records.
    return tuple((name, env.get(name, ''), digest(env[name]) if env.get(name) else None)
                 for name in ('CONTENT_HUB_SSL_CERTFILE', 'CONTENT_HUB_SSL_KEYFILE'))


@contextmanager
def exclusive_lock(path: Path):
    import msvcrt
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as stream:
        if stream.tell() == 0:
            stream.write(b'0')
            stream.flush()
        stream.seek(0)
        msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        try:
            yield
        finally:
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def local_child(path: Path, root: Path) -> Path:
    if not path.is_absolute() or str(path).startswith('\\\\'):
        raise ValueError('local_absolute_stage_required')
    path.resolve().relative_to(root.resolve())
    for part in (path, *path.parents):
        if part.is_symlink() or (part.exists() and getattr(part.stat(), 'st_file_attributes', 0) & 1024):
            raise ValueError('stage_reparse_forbidden')
        if part == root:
            break
    return path.resolve()


def verify_stage(stage: Path, stages: Path, expected: str) -> dict:
    stage = local_child(stage, stages)
    manifest = stage / 'server-stage.json'
    if digest(manifest) != expected:
        raise ValueError('stage_manifest_changed')
    value = json.loads(manifest.read_text(encoding='utf-8'))
    if value.get('format_version') != 1 or value.get('role') != 'server' or not value.get('build_id'):
        raise ValueError('invalid_server_stage')
    declared = value['files']
    actual = {}
    for path in stage.rglob('*'):
        local_child(path, stage)
        if path.is_file() and path.name != 'server-stage.json' and '__pycache__' not in path.parts:
            actual[path.relative_to(stage).as_posix()] = digest(path)
    if actual != declared:
        raise ValueError('stage_payload_changed')
    for name in declared:
        local_child(stage / name, stage)
    return value


def source_identity(root):
    files = []
    for relative in ('backend/app', 'frontend/dist'):
        folder = root / relative
        files.extend(p for p in folder.rglob('*') if p.is_file() and '__pycache__' not in p.parts)
    files.extend(p for p in (root / 'backend/serve.py', root / 'backend/schema.sql', root / 'backend/requirements.lock.txt') if p.is_file())
    rows = []
    for path in sorted(files):
        local_child(path, root)
        rows.append((path.relative_to(root).as_posix(), digest(path)))
    return hashlib.sha256(json.dumps(rows, separators=(',', ':')).encode()).hexdigest()


def legacy_compatibility(root: Path):
    """The source tree's own committed declaration for program-only rollback; (None, None) keeps manual recovery.

    The declaration is outside source_identity, so its bytes must equal Git HEAD (normalized like checkout)."""
    path = root / 'release/compatibility.json'
    # The supervisor may run as SYSTEM over a user-owned clone; trust exactly this root for these two reads.
    git = ['git', '-c', 'safe.directory=' + root.as_posix(), '-C', str(root)]
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    try:
        local_child(path, root)
        raw = path.read_bytes()
        committed = subprocess.run([*git, 'rev-parse', '--verify', 'HEAD:release/compatibility.json'],
                                   capture_output=True, text=True, timeout=30, creationflags=flags)
        working = subprocess.run([*git, 'hash-object', '--path=release/compatibility.json', '--stdin'],
                                 input=raw, capture_output=True, timeout=30, creationflags=flags)
        blobs = [value.decode('ascii', 'replace') if isinstance(value, bytes) else str(value or '')
                 for value in (committed.stdout, working.stdout)]
        if committed.returncode != 0 or working.returncode != 0 or not blobs[0].strip() or blobs[0].strip() != blobs[1].strip():
            return None, None
        value = release_compatibility(document(raw))
    except (OSError, ValueError, subprocess.SubprocessError):
        return None, None
    if (type(value.get('reader_protocol')) is not int or type(value.get('writer_protocol')) is not int
            or not isinstance(value.get('supported_components'), list)):
        return None, None
    return value, hashlib.sha256(raw).hexdigest()


def file_sha256(path: Path):
    try:
        return digest(path)
    except OSError:
        return None


def listener_identity(port: int) -> dict:
    # Local Windows observations only; never sends a signal to an observed PID.
    command = ("$ErrorActionPreference='Stop'; $ids=@(Get-NetTCPConnection -State Listen -LocalPort " + str(int(port)) +
               " | Select-Object -ExpandProperty OwningProcess -Unique); if($ids.Count -ne 1){exit 2}; "
               "$p=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$ids[0]); "
               "@{pid=[int]$p.ProcessId; created=$p.CreationDate.ToUniversalTime().ToString('o'); "
               "executable=$p.ExecutablePath} | ConvertTo-Json -Compress")
    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command],
                            capture_output=True, text=True, timeout=15, check=True,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    return json.loads(result.stdout)


class ServerActivation:
    def __init__(self, root: Path, *, environ=None):
        local_child(root, root)
        self.root = root.resolve()
        self.logs = self.root / 'logs'
        local_child(self.logs, self.root)
        self.stages = self.logs / 'server-stages'
        self.request = self.logs / 'server-update-request.json'
        self.pointer = self.logs / 'server-current.json'
        self.journal_path = self.logs / 'server-install-journal.json'
        self.control = self.logs / 'server-activation.json'
        self.env = dict(os.environ if environ is None else environ)
        self.env.setdefault('CONTENT_HUB_DATA', str(self.root / 'backend/data'))
        self.ready_scheme, self.ready_context = ready_transport(self.root, self.env)
        self._tls_files = tls_file_identity(self.env)
        for key in ('CONTENT_HUB_DATA', 'CONTENT_HUB_DB', 'CONTENT_HUB_MEDIA', 'CONTENT_HUB_SHARED',
                    'CONTENT_HUB_ASSETS_DIR', 'CONTENT_HUB_BACKUP_DIR', 'CONTENT_HUB_BACKUP_REPLICA_DIR', 'CONTENT_HUB_LOG_DIR'):
            if key in self.env:
                path = Path(self.env[key]).expanduser()
                self.env[key] = str((path if path.is_absolute() else self.root / 'backend' / path).resolve())
        self.port = int(self.env.get('CONTENT_HUB_PORT', '8010'))
        self.logs.mkdir(exist_ok=True)
        self.current = self.read_pointer()
        self.nonce = uuid.uuid4().hex
        self.process = None

    def read_pointer(self):
        if not self.pointer.exists():
            identity = source_identity(self.root)
            declared, declared_sha = legacy_compatibility(self.root)
            # A declaration read while the tree was being replaced must not pair with either version.
            if source_identity(self.root) != identity:
                raise ValueError('legacy_source_changed_during_capture')
            return {'path': str(self.root), 'build_id': 'legacy-source', 'python': sys.executable,
                    'compatibility': declared, 'compatibility_sha256': declared_sha, 'source_sha256': identity}
        value = json.loads(self.pointer.read_text(encoding='utf-8'))
        if value.get('path') == str(self.root):
            if value.get('source_sha256') != source_identity(self.root):
                raise ValueError('previous_source_changed')
            return value
        descriptor = verify_stage(Path(value['path']), self.stages, value['manifest_sha256'])
        verify_qualification(value, self.stages, descriptor, environ=self.env)
        if descriptor['build_id'] != value['build_id']:
            raise ValueError('pointer_build_mismatch')
        return value

    def control_state(self, state, journal=None):
        value = {'format_version': 1, 'state': state, 'execution_nonce': self.nonce}
        if journal:
            value.update(run_id=journal['run_id'], journal=str(self.journal_path))
        atomic_json(self.control, value)

    def spawn(self, current, *, pending=False):
        env = {**self.env, 'MVHUB_PROCESS_ROLE': 'server', 'MVHUB_BUILD_ID': current['build_id'],
               'MVHUB_EXECUTION_NONCE': self.nonce, 'MVHUB_ACTIVATION_ROOT': str(self.root),
               'MVHUB_ACTIVATION_CONTROL': str(self.control),
               'CONTENT_HUB_FRONTEND_DIST': str(Path(current['path']) / 'frontend/dist')}
        if current.get('manifest_sha256'):
            env = server_cli_environment(Path(current['path']), env)
        self.control_state('pending' if pending else 'normal')
        python = current['python']
        # A Windows venv launcher spawns another Python. Own the actual server handle.
        if Path(python).name.lower() == 'python.exe' and Path(python).parent.name.lower() == 'scripts':
            env['__PYVENV_LAUNCHER__'] = python
            python = sys._base_executable
        self.process = subprocess.Popen([python, str(Path(current['path']) / 'backend/serve.py')],
                                        cwd=Path(current['path']) / 'backend', env=env)
        return self.process

    def ready(self):
        # Never use proxy environment for this local control observation.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        handlers = [urllib.request.ProxyHandler({}), NoRedirect()]
        if self.ready_context is not None:
            handlers.append(urllib.request.HTTPSHandler(context=self.ready_context))
        opener = urllib.request.build_opener(*handlers)
        with opener.open(f'{self.ready_scheme}://127.0.0.1:{self.port}/api/ready', timeout=2) as response:
            return json.load(response)

    def verify_tls_files(self):
        try:
            unchanged = tls_file_identity(self.env) == self._tls_files
        except OSError:
            unchanged = False
        if not unchanged:
            raise ValueError('server_tls_files_changed')

    def identity(self, ready, current):
        observed = listener_identity(self.port)
        runtime = ready.get('runtime', {})
        if (not self.process or self.process.poll() is not None or ready.get('status') != 'ready' or
                observed['pid'] != self.process.pid or runtime.get('process_id') != self.process.pid or
                runtime.get('execution_nonce') != self.nonce or runtime.get('build_id') != current['build_id'] or
                runtime.get('role') != 'server'):
            raise ValueError('ready_process_identity_mismatch')
        return {'pid': observed['pid'], 'creation_time': observed['created'],
                'executable_sha256': digest(observed['executable'])}

    def wait_ready(self, current, *, drain=False, timeout=90):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                ready = self.ready()
                identity = self.identity(ready, current)
                if not drain:
                    return identity
                runtime = ready['runtime']
                blockers = runtime.get('update_blockers')
                if (runtime.get('admission') == 'blocked' and runtime.get('active_http') == 0 and
                        isinstance(blockers, dict) and set(blockers) == {'generation', 'resolve', 'comfy'} and
                        all(type(n) is int and n == 0 for n in blockers.values())):
                    return identity
            except (OSError, ValueError, KeyError, subprocess.SubprocessError):
                pass
            time.sleep(.5)
        raise TimeoutError('server_ready_or_drain_timeout')

    def stop_owned(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                # Never kill a PID discovered from the port. This is our retained handle.
                self.process.kill()
                self.process.wait(timeout=10)

    def checkpoint(self, run_id):
        output = self.logs / 'install-checkpoints' / (run_id + '-' + uuid.uuid4().hex)
        rows = snapshot(self.root, output, self.env)
        return [{**row, 'checkpoint': str(output.relative_to(self.root) / row['checkpoint'])} for row in rows]

    def archive(self, journal):
        path = self.logs / 'install-journals' / (journal['run_id'] + '.json')
        if path.exists() and read_journal(path) != journal:
            raise ValueError('journal_history_changed')
        atomic_json(path, journal)
        if journal['phase'] == 'committed':
            atomic_json(self.control, {'format_version': 1, 'state': 'activated', 'execution_nonce': self.nonce,
                                      'run_id': journal['run_id'], 'journal': str(path)})

    def recover(self, journal):
        self.stop_owned()
        rows = self.checkpoint(journal['run_id']) if journal['db_mutation_possible'] else []
        if rollback_decision(journal, rows, journal['previous'].get('compatibility')) != 'program_only':
            advance(self.journal_path, journal, 'recovery_required', failure='database_compatibility_unproven')
            raise ValueError('manual_database_recovery_required')
        previous = journal['previous']
        if previous['path'] != str(self.root):
            verify_qualification(previous, self.stages, environ=self.env)
        elif (previous.get('source_sha256') != source_identity(self.root) or
              (previous.get('compatibility_sha256') and
               previous['compatibility_sha256'] != file_sha256(self.root / 'release/compatibility.json'))):
            raise ValueError('previous_source_changed')
        atomic_json(self.pointer, previous)
        self.current = previous
        self.nonce = uuid.uuid4().hex
        journal = advance(self.journal_path, journal, 'failed', db_mutation_possible=True,
                          business_writes_possible=True, recovery_starting=True)
        self.spawn(previous)
        identity = self.wait_ready(previous)
        journal = advance(self.journal_path, journal, 'rolled_back', recovery_process=identity)
        self.archive(journal)
        return journal

    def resume(self):
        if not self.journal_path.exists():
            return
        journal = read_journal(self.journal_path)
        if journal['phase'] in {'committed', 'rolled_back'}:
            self.archive(journal)
            return
        # Stable supervisor has no surviving owned child on a fresh invocation.
        # A live listener is never killed or adopted by PID after a coordinator crash.
        try:
            listener_identity(self.port)
        except subprocess.SubprocessError:
            pass
        else:
            raise ValueError('unowned_listener_requires_operator_stop')
        self.recover(journal)

    def apply_request(self):
        self.verify_tls_files()
        request = json.loads(self.request.read_text(encoding='utf-8'))
        target = request['target']
        verified = verify_stage(Path(target['path']), self.stages, target['manifest_sha256'])
        verify_qualification(target, self.stages, verified, environ=self.env)
        if (target['build_id'] != verified['build_id'] or target['compatibility'] != verified['compatibility'] or
                Path(target['python']) != Path(target['path']) / '.venv/Scripts/python.exe'):
            raise ValueError('request_stage_mismatch')
        journal = new_journal(self.journal_path, role='server', previous=self.current, target=target)
        journal = advance(self.journal_path, journal, 'verified')
        try:
            self.wait_ready(self.current)
            journal = advance(self.journal_path, journal, 'draining')
            self.control_state('draining')
            self.wait_ready(self.current, drain=True)
            self.verify_tls_files()
            self.stop_owned()
            journal = advance(self.journal_path, journal, 'quiesced')
            rows = self.checkpoint(journal['run_id'])
            journal = advance(self.journal_path, journal, 'checkpointed', checkpoints=rows)
            if rollback_decision({**journal, 'db_mutation_possible': True}, rows, target['compatibility']) != 'program_only':
                raise ValueError('target_database_compatibility_unproven')
            verify_stage(Path(target['path']), self.stages, target['manifest_sha256'])
            verify_qualification(target, self.stages, environ=self.env)
            journal = advance(self.journal_path, journal, 'activation_pending')
            atomic_json(self.pointer, target)
            self.nonce = journal['execution_nonce']
            journal = advance(self.journal_path, journal, 'starting', db_mutation_possible=True, business_writes_possible=True)
            self.spawn(target, pending=True)
            identity = self.wait_ready(target)
            journal = advance(self.journal_path, journal, 'ready', process=identity)
            self.control_state('activated', journal)
            journal = advance(self.journal_path, journal, 'committed')
            self.archive(journal)
            self.current = target
            self.request.unlink()
            return journal
        except Exception as exc:
            # Read disk, not a stale local phase, after uncertain write failure.
            journal = read_journal(self.journal_path)
            if journal['phase'] == 'committed':
                self.archive(journal)
                self.current = target
                self.request.unlink(missing_ok=True)
                return journal
            if journal['phase'] in {'prepare', 'verified', 'draining'}:
                self.control_state('normal')
                journal = advance(self.journal_path, journal, 'rolled_back', failure=type(exc).__name__)
                self.archive(journal)
            else:
                self.recover(journal)
            self.request.unlink(missing_ok=True)
            raise
