"""Prepare a server version beside the running tree and ask its stable supervisor to switch."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile

from server_activation import (atomic_json, digest, local_child, verify_stage, exclusive_lock,
                               require_source_inputs, source_inventory, verify_qualification,
                               validate_runtime_proof, inspect_server_cli, qualification_tools,
                               stage_python_base, PROBE_TOOLS, SOURCE_PROFILE)
from app.services.release_contract import compatibility, document, json_bytes
from smoke_env import build_smoke_env


def run_checked(command, *, cwd, log, env=None):
    with log.open('ab') as output:
        process = subprocess.Popen(command, cwd=cwd, stdout=output, stderr=subprocess.STDOUT, env=env,
                                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        code = process.wait()
    if code:
        raise RuntimeError(f'prepare_step_exit_{code}')


def _run_cli_version(command, *, cwd, env, timeout, creationflags):
    # A descendant can keep a pipe open after Node exits; file output never waits for EOF.
    with tempfile.TemporaryFile(dir=cwd) as output:
        process = subprocess.Popen(command, cwd=cwd, env=env, stdout=output,
                                   stderr=subprocess.DEVNULL, creationflags=creationflags)
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            if os.name == 'nt':
                with contextlib.suppress(OSError, subprocess.SubprocessError):
                    subprocess.run(['taskkill', '/F', '/T', '/PID', str(process.pid)],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   timeout=5, creationflags=creationflags)
            with contextlib.suppress(OSError, subprocess.SubprocessError):
                process.kill()
                process.wait(timeout=5)
            raise ValueError('isolated_stage_cli_version_failed') from exc
        output.seek(0)
        return subprocess.CompletedProcess(command, process.returncode, output.read(), b'')


def qualify_stage(root, stage, target, verification_python, *, probe_run=None):
    """Trusted probe supervisor runs the stage interpreter; no supplied success flags."""
    descriptor = verify_stage(stage, root / 'logs/server-stages', target['manifest_sha256'])
    cli = inspect_server_cli(stage, root, os.environ)
    tool_hashes = qualification_tools(root)
    verifier_hash = digest(verification_python)
    probe_tool = local_child(root / 'tools/qualify_release_artifact.py', root)
    if not probe_tool.is_file():
        raise ValueError('installed_runtime_qualifier_required')
    proof_dir = root / 'logs/server-qualifications'
    proof_dir.mkdir(exist_ok=True)
    probe_descriptor = {'build_id': descriptor['build_id'], 'role': 'server',
                        'compatibility': descriptor['compatibility'],
                        'payload': [{'path': name, 'size': (stage / name).stat().st_size, 'sha256': hashed}
                                    for name, hashed in sorted(descriptor['files'].items())]}
    input_path = proof_dir / (descriptor['build_id'] + '.probe-input.json')
    if input_path.exists():
        raise ValueError('probe_input_already_exists')
    input_path.write_bytes(json_bytes(probe_descriptor))
    input_hash = digest(input_path)
    tool_hash = digest(probe_tool)
    work = root / 'logs/server-probes' / uuid.uuid4().hex
    work.parent.mkdir(exist_ok=True)
    env_root = root / 'logs' / ('server-verifier-env-' + uuid.uuid4().hex)
    env = build_smoke_env(os.environ, env_root, frontend_dist=stage / 'frontend/dist',
                          python_exe=verification_python, port=19871)
    # Metadata alone cannot prove the bundled native CLI can execute; version is offline.
    cli_result = (probe_run or _run_cli_version)(
        [*cli['argv'], 'version'], cwd=env_root, env=env, timeout=60,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    version_text = (cli_result.stdout.decode('utf-8', errors='replace')
                    if isinstance(cli_result.stdout, bytes) else cli_result.stdout)
    reported_version = None
    for line in version_text.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].casefold() == 'higgsfield':
            reported_version = parts[1]
            break
    if cli_result.returncode != 0 or reported_version != cli['version']:
        raise ValueError('isolated_stage_cli_version_failed')
    result = (probe_run or subprocess.run)([str(verification_python), '-E', '-s', '-B', '-X', 'utf8', '-u', str(probe_tool),
                        'probe', '--root', str(stage), '--work-root', str(work),
                        '--descriptor', str(input_path), '--runtime-python', target['python'], '--timeout', '90'],
                       cwd=root, env=env, capture_output=True,
                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode != 0:
        raise ValueError('isolated_stage_probe_failed')
    value = document(result.stdout if isinstance(result.stdout, bytes) else result.stdout.encode('utf-8'))
    expected_payload = hashlib.sha256(json_bytes({name.casefold(): hashed for name, hashed in descriptor['files'].items()})).hexdigest()
    if (value.get('status') != 'passed' or value.get('scope') != 'fresh-data-runtime-probe'
            or value.get('descriptor_file_sha256') != input_hash
            or value.get('descriptor_sha256') != hashlib.sha256(json_bytes(probe_descriptor)).hexdigest()
            or value.get('payload_sha256') != expected_payload or work.exists()
            or digest(input_path) != input_hash or digest(probe_tool) != tool_hash
            or value.get('tool_sha256') != {name: tool_hashes[name] for name in PROBE_TOOLS}
            or qualification_tools(root) != tool_hashes or digest(verification_python) != verifier_hash):
        raise ValueError('isolated_stage_probe_identity_mismatch')
    verify_stage(stage, root / 'logs/server-stages', target['manifest_sha256'])
    validate_runtime_proof(value.get('evidence', {}), value.get('tool_sha256', {}), descriptor)
    record = {'format_version': 1, 'scope': 'server-stage', 'profile': SOURCE_PROFILE, 'status': 'passed',
              'release_eligible': False, 'activation_eligible': True,
              'build_id': descriptor['build_id'], 'role': 'server', 'source_commit': descriptor['source_commit'],
              'manifest_sha256': target['manifest_sha256'],
              'checks': {'isolated_runtime': 'passed', 'server_cli_entry': 'passed', 'cleanup': 'passed'},
              'runtime': value['evidence'], 'tool_sha256': value['tool_sha256'], 'server_cli': cli,
              'qualification_tools': tool_hashes,
              'verification_python': {'path': str(verification_python), 'sha256': verifier_hash}}
    if inspect_server_cli(stage, root, os.environ) != cli:
        raise ValueError('server_cli_entry_changed_during_probe')
    record_path = proof_dir / (descriptor['build_id'] + '.json')
    if record_path.exists():
        raise ValueError('stage_qualification_already_exists')
    atomic_json(record_path, record)
    target = {**target, 'qualification_path': str(record_path), 'qualification_sha256': digest(record_path)}
    verify_qualification(target, root / 'logs/server-stages', descriptor)
    return target


def prepare(root: Path, *, verification_python: Path, run=run_checked, probe_run=None):
    local_child(root, root)
    root = root.resolve()
    verification_python = local_child(verification_python, verification_python.parent)
    if not verification_python.is_file():
        raise ValueError('trusted_verification_python_required')
    logs = root / 'logs'
    local_child(logs, root)
    logs.mkdir(exist_ok=True)
    request = logs / 'server-update-request.json'
    if request.exists():
        raise ValueError('server_update_already_pending')
    status = subprocess.run(['git', '-C', str(root), 'status', '--porcelain', '--untracked-files=normal'],
                            check=True, capture_output=True, text=True)
    if status.stdout.strip():
        raise ValueError('server_source_is_dirty')
    run_id = uuid.uuid4().hex
    stage = logs / 'server-stages' / run_id
    log = logs / ('server-prepare-' + run_id + '.log')
    progress = logs / 'server-prepare.json'
    record = logs / ('server-prepare-' + run_id + '.json')
    def write_progress(status, **extra):
        value = {'format_version': 1, 'run_id': run_id, 'status': status, 'log': log.name,
                 'run_file': record.name, **extra}
        atomic_json(record, value)
        atomic_json(progress, value)
    if progress.exists():
        previous = json.loads(progress.read_text(encoding='utf-8'))
        if previous.get('status') == 'running' and previous.get('run_file'):
            previous['status'] = 'interrupted'
            old_record = local_child(logs / previous['run_file'], logs)
            atomic_json(old_record, previous)
    write_progress('running')
    try:
        run(['git', 'fetch', 'origin', 'main'], cwd=root, log=log)
        result = subprocess.run(['git', '-C', str(root), 'rev-parse', 'origin/main'], check=True, capture_output=True, text=True)
        commit = result.stdout.strip()
        if len(commit) != 40 or any(c not in '0123456789abcdef' for c in commit):
            raise ValueError('invalid_source_revision')
        result = subprocess.run(['git', '-C', str(root), 'show', commit + ':release/compatibility.json'],
                                check=False, capture_output=True)
        if result.returncode != 0:
            with log.open('ab') as output:
                output.write(b' '.join(result.stderr.splitlines()) + b'\n')
            raise ValueError('selected_commit_declaration_missing')
        declared = compatibility(document(result.stdout))
        for field in ('reader_protocol', 'writer_protocol'):
            if type(declared.get(field)) is not int:
                raise ValueError('explicit_server_database_protocol_required')
        if not isinstance(declared.get('supported_components'), list):
            raise ValueError('explicit_server_database_components_required')
        current_path = logs / 'server-current.json'
        journal_path = logs / 'server-install-journal.json'
        if current_path.exists() and journal_path.exists():
            current = json.loads(current_path.read_text(encoding='utf-8'))
            journal = json.loads(journal_path.read_text(encoding='utf-8'))
            if current.get('manifest_sha256') and journal.get('phase') == 'committed' and journal.get('target') == current:
                installed = verify_stage(Path(current['path']), logs / 'server-stages', current['manifest_sha256'])
                verify_qualification(current, logs / 'server-stages', installed)
                if (installed.get('source_commit') == commit and installed.get('compatibility') == declared
                        and 'release/compatibility.json' in installed['source_files']):
                    write_progress('up_to_date')
                    return current['build_id']
        stage.mkdir(parents=True, exist_ok=False)
        archive = stage.parent / (run_id + '.source.zip')
        # Git archive applies the selected tree's attributes, including checkout EOLs.
        run(['git', 'archive', '--format=zip', '--output=' + str(archive), commit,
             'backend/app', 'backend/serve.py', 'backend/schema.sql', 'backend/requirements.lock.txt',
             'hf_cli_version.txt', 'frontend', 'tools', 'release/compatibility.json'], cwd=root, log=log)
        with zipfile.ZipFile(archive) as bundle:
            for entry in bundle.infolist():
                if entry.is_dir():
                    continue
                name = entry.filename
                if '\\' in name or ':' in name or any(part in {'', '.', '..'} for part in name.split('/')):
                    raise ValueError('source_archive_path_invalid')
                path = local_child(stage / name, stage)
                if path.name.startswith('.env') or path.name in {'.npmrc', '.pypirc'} or ((entry.external_attr >> 16) & 0o170000) == 0o120000:
                    raise ValueError('source_archive_environment_or_link_forbidden')
                path.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(entry) as source, path.open('xb') as target:
                    shutil.copyfileobj(source, target)
        if document((stage / 'release/compatibility.json').read_bytes()) != declared:
            raise ValueError('staged_compatibility_mismatch')
        source_files = source_inventory(stage)
        require_source_inputs(source_files)
        env = build_smoke_env(os.environ, logs / ('server-prepare-env-' + run_id),
                              frontend_dist=stage / 'frontend/dist', python_exe=Path(sys.executable), port=19871)
        base_python = {'path': str(Path(sys._base_executable).resolve()), 'sha256': digest(sys._base_executable)}
        run([sys.executable, '-m', 'venv', str(stage / '.venv')], cwd=stage, log=log, env=env)
        python = stage / '.venv/Scripts/python.exe'
        run([str(python), '-m', 'pip', '--isolated', 'install', '--require-hashes', '--only-binary=:all:',
             '-r', str(stage / 'backend/requirements.lock.txt')], cwd=stage, log=log, env=env)
        npm = shutil.which('npm.cmd')
        if not npm:
            raise ValueError('npm_not_found')
        pin = (stage / 'hf_cli_version.txt').read_text(encoding='utf-8-sig').strip()
        if not re.fullmatch(r'\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?', pin):
            raise ValueError('server_cli_version_invalid')
        # npm.cmd prefers its sibling Node, then falls back to PATH.
        node = Path(npm).parent / 'node.exe'
        if not node.is_file():
            found = shutil.which('node.exe')
            if not found:
                raise ValueError('node_not_found')
            node = Path(found)
        node = local_child(node, node.parent)
        env['PATH'] = os.pathsep.join((str(Path(npm).parent), str(node.parent), env['PATH']))
        cli_dir = stage / 'runtime/higgsfield'
        cli_dir.mkdir(parents=True, exist_ok=True)
        # The CLI's postinstall downloads its pinned native binary into the package.
        run([npm, 'install', '--global', '--prefix', str(cli_dir), '--ignore-scripts=false',
             '--no-audit', '--no-fund', '@higgsfield/cli@' + pin], cwd=stage, log=log, env=env)
        shutil.copyfile(node, cli_dir / 'node.exe')
        run([npm, 'ci', '--include=dev', '--no-audit', '--no-fund'], cwd=stage / 'frontend', log=log, env=env)
        run([npm, 'run', 'build'], cwd=stage / 'frontend', log=log, env=env)
        if not all((stage / name).is_file() for name in ('frontend/dist/index.html', 'backend/schema.sql', 'backend/serve.py', 'hf_cli_version.txt')) or not python.is_file():
            raise ValueError('prepared_runtime_missing')
        (stage / 'VERSION.txt').write_text('git-' + commit[:12] + '\n', encoding='utf-8')
        # node_modules is build input only; do not carry it into the executable stage.
        node_modules = local_child(stage / 'frontend/node_modules', stage)
        if node_modules.exists():
            shutil.rmtree(node_modules)
        if any(digest(stage / name) != hashed for name, hashed in source_files.items()):
            raise ValueError('source_inputs_changed_during_build')
        if stage_python_base(stage) != base_python:
            raise ValueError('prepared_python_base_changed')
        files = {p.relative_to(stage).as_posix(): digest(p) for p in stage.rglob('*')
                 if p.is_file() and '__pycache__' not in p.parts}
        descriptor = {'format_version': 1, 'role': 'server', 'build_id': run_id, 'source_commit': commit,
                      'compatibility': declared, 'files': files, 'source_archive_sha256': digest(archive),
                      'source_files': source_files, 'python_base': base_python,
                      'prepare_log': log.name, 'tool_sha256': digest(Path(__file__))}
        atomic_json(stage / 'server-stage.json', descriptor)
        manifest_sha = digest(stage / 'server-stage.json')
        verify_stage(stage, logs / 'server-stages', manifest_sha)
        target = {'path': str(stage), 'python': str(python), 'build_id': run_id,
                  'compatibility': declared, 'manifest_sha256': manifest_sha}
        target = qualify_stage(root, stage, target, verification_python, probe_run=probe_run)
        verify_qualification(target, logs / 'server-stages')
        atomic_json(request, {'format_version': 1, 'run_id': run_id, 'target': target})
        write_progress('prepared')
        return run_id
    except BaseException as exc:
        write_progress('interrupted' if isinstance(exc, KeyboardInterrupt) else 'failed', failure=type(exc).__name__)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--verification-python', type=Path, required=True,
                        help='trusted verifier interpreter with psutil; separate from the prepared server runtime')
    args = parser.parse_args()
    try:
        with exclusive_lock(args.root / 'logs/server-update.lock'):
            run_id = prepare(args.root, verification_python=args.verification_python)
        deadline = time.monotonic() + 300
        journal_path = args.root / 'logs/server-install-journal.json'
        while time.monotonic() < deadline:
            if journal_path.exists():
                value = json.loads(journal_path.read_text(encoding='utf-8'))
                if value.get('target', {}).get('build_id') == run_id:
                    if value['phase'] == 'committed':
                        print('Server stage committed and listener identity verified.')
                        return 0
                    if value['phase'] in {'rolled_back', 'recovery_required', 'failed'}:
                        raise ValueError('server_stage_' + value['phase'])
            time.sleep(1)
        raise TimeoutError('prepared_stage_not_committed_supervisor_bridge_required')
    except Exception as exc:
        print('Server update failed: ' + str(exc) if isinstance(exc, (ValueError, TimeoutError, RuntimeError)) else type(exc).__name__, file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
