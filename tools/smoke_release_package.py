# -*- coding: utf-8 -*-
"""Verify an MV Hub worker release ZIP with only its bundled runtime.

The probe extracts the archive to a disposable directory, starts ``serve.py``
with the bundled Python and isolated data, checks readiness and the packaged
frontend shell, then terminates only the process tree it created.
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path
from typing import Any


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path, help="MVHub-*.zip package to verify")
    parser.add_argument("--timeout", type=float, default=90.0)
    return parser.parse_args()


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _ready(port: int) -> bool:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/ready", timeout=2
        ) as response:
            payload = json.loads(response.read().decode("utf-8"))
            return response.status == 200 and payload.get("status") == "ready"
    except Exception:  # noqa: BLE001 - refusal is expected while booting
        return False


def _port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.25)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def _safe_extract(package: Path, destination: Path) -> None:
    root = destination.resolve()
    with zipfile.ZipFile(package) as archive:
        for member in archive.infolist():
            target = (destination / member.filename).resolve()
            if target != root and root not in target.parents:
                raise ValueError(f"archive entry escapes destination: {member.filename}")
        archive.extractall(destination)


def _required_file(root: Path, relative: str) -> Path:
    path = root / Path(relative)
    if not path.is_file():
        raise FileNotFoundError(f"package file missing: {relative}")
    return path


def _terminate_process_tree(process: subprocess.Popen[Any]) -> None:
    if process.poll() is not None:
        return
    subprocess.run(
        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
        capture_output=True,
        check=False,
    )
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def main() -> int:
    args = _parse_args()
    package = args.package.resolve()
    result: dict[str, Any] = {
        "package": str(package),
        "archive_ok": False,
        "python": "",
        "cli_version": "",
        "help_exit_0": False,
        "help_no_listener": False,
        "ready_200": False,
        "static_200": False,
        "app_shell": False,
        "port_released": False,
        "temp_removed": False,
        "error": "",
    }
    if os.name != "nt":
        result["error"] = "Windows-only release probe"
        print(json.dumps(result, ensure_ascii=False))
        return 2
    if not package.is_file():
        result["error"] = f"package not found: {package}"
        print(json.dumps(result, ensure_ascii=False))
        return 2

    process: subprocess.Popen[Any] | None = None
    port = _free_port()
    temp_path: Path | None = None
    try:
        with tempfile.TemporaryDirectory(
            prefix="mvhub-release-smoke-", ignore_cleanup_errors=True
        ) as temp:
            temp_path = Path(temp)
            root = temp_path / "package"
            root.mkdir()
            _safe_extract(package, root)
            result["archive_ok"] = True

            python = _required_file(root, r"runtime\python\python.exe")
            serve = _required_file(root, r"backend\serve.py")
            _required_file(root, r"frontend\dist\index.html")
            version_file = _required_file(root, "VERSION.txt")
            cli_pin_file = _required_file(root, "hf_cli_version.txt")
            cli_manifest = _required_file(
                root,
                r"runtime\higgsfield\node_modules\@higgsfield\cli\package.json",
            )

            python_version = subprocess.run(
                [str(python), "--version"],
                capture_output=True,
                text=True,
                timeout=10,
                check=True,
            )
            python_version = (
                python_version.stdout.strip() or python_version.stderr.strip()
            )
            if not python_version.startswith("Python 3."):
                raise RuntimeError(f"unexpected bundled Python: {python_version}")
            result["python"] = python_version

            release_version = version_file.read_text(encoding="utf-8").strip()
            if not release_version:
                raise RuntimeError("VERSION.txt is empty")
            cli_pin = cli_pin_file.read_text(encoding="utf-8").strip()
            cli_package = str(
                json.loads(cli_manifest.read_text(encoding="utf-8")).get("version", "")
            ).strip()
            if not cli_pin or cli_pin != cli_package:
                raise RuntimeError(
                    f"bundled CLI mismatch: pin={cli_pin!r} package={cli_package!r}"
                )
            result["cli_version"] = cli_package

            stdout_path = temp_path / "server.stdout.log"
            stderr_path = temp_path / "server.stderr.log"
            env = os.environ.copy()
            env.update(
                {
                    "CONTENT_HUB_PORT": str(port),
                    "CONTENT_HUB_HOST": "127.0.0.1",
                    "CONTENT_HUB_DATA": str(temp_path / "data"),
                    "CONTENT_HUB_AUTH": "0",
                    "CONTENT_HUB_MANAGE": "0",
                    "CONTENT_HUB_EXTERNAL_RECOVERY": "0",
                    "PYTHONUNBUFFERED": "1",
                }
            )
            help_probe = subprocess.run(
                [str(python), str(serve), "--help"],
                cwd=serve.parent,
                env=env,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            result["help_exit_0"] = (
                help_probe.returncode == 0 and "usage:" in help_probe.stdout.lower()
            )
            result["help_no_listener"] = not _port_open(port)
            if not result["help_exit_0"] or not result["help_no_listener"]:
                raise RuntimeError("packaged serve.py --help opened a server or failed")
            try:
                with stdout_path.open(
                    "w", encoding="utf-8"
                ) as stdout, stderr_path.open("w", encoding="utf-8") as stderr:
                    process = subprocess.Popen(
                        [str(python), str(serve)],
                        cwd=serve.parent,
                        env=env,
                        stdout=stdout,
                        stderr=stderr,
                        creationflags=subprocess.CREATE_NO_WINDOW,
                    )
                    deadline = time.monotonic() + max(5.0, args.timeout)
                    while time.monotonic() < deadline and process.poll() is None:
                        if _ready(port):
                            result["ready_200"] = True
                            break
                        time.sleep(0.5)
                    if not result["ready_200"]:
                        stderr.flush()
                        tail = stderr_path.read_text(
                            encoding="utf-8", errors="replace"
                        )[-2000:]
                        raise RuntimeError(
                            f"packaged server did not become ready: {tail}"
                        )

                    with urllib.request.urlopen(
                        f"http://127.0.0.1:{port}/", timeout=5
                    ) as response:
                        html = response.read().decode("utf-8", errors="replace")
                        result["static_200"] = response.status == 200
                        result["app_shell"] = 'id="root"' in html
                    if not result["static_200"] or not result["app_shell"]:
                        raise RuntimeError("packaged frontend shell verification failed")
            finally:
                if process is not None:
                    _terminate_process_tree(process)
                    process = None
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline and _port_open(port):
                    time.sleep(0.25)
                result["port_released"] = not _port_open(port)
    except Exception as exc:  # noqa: BLE001 - compact release-gate report
        result["error"] = str(exc)
    finally:
        if process is not None:
            _terminate_process_tree(process)
            result["port_released"] = not _port_open(port)

    result["temp_removed"] = temp_path is None or not temp_path.exists()
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    passed = all(
        result[key]
        for key in (
            "archive_ok",
            "python",
            "cli_version",
            "help_exit_0",
            "help_no_listener",
            "ready_200",
            "static_200",
            "app_shell",
            "port_released",
            "temp_removed",
        )
    )
    return 0 if passed and not result["error"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
