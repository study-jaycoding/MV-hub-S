"""Provision the trusted verifier interpreter (hash-pinned psutil) for staged server updates.

The verifier lives at <root>/logs/server-verifier (Git-ignored, same owner as the code the updater
already runs elevated). It is built in place and re-checked at that final path, because a venv embeds
absolute paths and must never be moved. A broken or partial folder is set aside, never deleted.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import subprocess
import sys
import uuid

# Same pin as backend/requirements-dev.txt; the wheel hash lives in server_verifier.lock.txt.
PSUTIL_VERSION = '7.2.2'
LOCK = Path(__file__).resolve().with_name('server_verifier.lock.txt')
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def _plain_path(path: Path) -> None:
    for part in (path, *path.parents):
        try:
            # lstat: stat() follows junctions and would report the target folder, not the link.
            attributes = getattr(part.lstat(), 'st_file_attributes', 0)
        except FileNotFoundError:
            continue
        if part.is_symlink() or attributes & 1024:
            raise ValueError('verifier_path_reparse_forbidden')


def verifier_python(root: Path) -> Path:
    return root / 'logs' / 'server-verifier' / 'Scripts' / 'python.exe'


def check(python: Path, *, run=subprocess.run) -> bool:
    if not python.is_file():
        return False
    try:
        result = run([str(python), '-I', '-c', 'import psutil; print(psutil.__version__)'],
                     capture_output=True, text=True, timeout=120, creationflags=NO_WINDOW)
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0 and result.stdout.strip() == PSUTIL_VERSION


def ensure(root: Path, *, run=subprocess.run, base_python: str | None = None) -> Path:
    root = root.resolve()
    logs = root / 'logs'
    target = logs / 'server-verifier'
    python = verifier_python(root)
    # Check the whole interpreter path before running anything elevated (a junction could point elsewhere).
    _plain_path(python)
    if check(python, run=run):
        return python
    if target.exists() or target.is_symlink():
        target.rename(logs / ('server-verifier.broken-' + uuid.uuid4().hex[:12]))
    logs.mkdir(exist_ok=True)
    steps = ([base_python or sys._base_executable, '-m', 'venv', str(target)],
             [str(python), '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check',
              '--require-hashes', '--only-binary=:all:', '--no-deps', '-r', str(LOCK)])
    for command in steps:
        if command[0] == str(python):
            _plain_path(python)  # the new venv must still be a plain folder before its Python runs
        if run(command, timeout=600, creationflags=NO_WINDOW).returncode != 0:
            raise RuntimeError('verifier_setup_failed')
    _plain_path(python)
    if not check(python, run=run):
        raise RuntimeError('verifier_psutil_check_failed')
    return python


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(ensure(args.root))
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        print('[ERROR] Server verifier Python could not be prepared: ' + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
