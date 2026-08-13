# -*- coding: utf-8 -*-
"""Boot the Windows shared-server launcher against disposable data.

The probe deliberately removes npm/Node from PATH. A valid prebuilt ``dist``
must let MV_server.bat reach /api/ready without package installation or network.
Only the process tree created by this script is terminated.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _ready(port: int) -> bool:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/ready", timeout=2
        ) as response:
            if response.status != 200:
                return False
            body = json.loads(response.read().decode("utf-8"))
            return body.get("status") == "ready"
    except Exception:  # noqa: BLE001 - connection refusal is expected while booting
        return False


def main() -> int:
    if os.name != "nt":
        print("Windows-only smoke probe")
        return 2
    if not (ROOT / "frontend" / "dist" / "index.html").is_file():
        print("frontend/dist is missing; run npm run build before this probe")
        return 2

    port = _free_port()
    with tempfile.TemporaryDirectory(
        prefix="mvhub-server-smoke-", ignore_cleanup_errors=True
    ) as temp:
        temp_path = Path(temp)
        stdout_path = temp_path / "server.stdout.log"
        stderr_path = temp_path / "server.stderr.log"
        env = os.environ.copy()
        env.update(
            {
                "PYEXE": sys.executable,
                "PORT": str(port),
                "CONTENT_HUB_DATA": str(temp_path / "data"),
                "CONTENT_HUB_AUTH": "0",
                "CONTENT_HUB_MANAGE": "0",
                "PATH": os.pathsep.join(
                    filter(
                        None,
                        (
                            str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"),
                            os.environ.get("SystemRoot", r"C:\Windows"),
                        ),
                    )
                ),
            }
        )
        with stdout_path.open("w", encoding="utf-8") as stdout, stderr_path.open(
            "w", encoding="utf-8"
        ) as stderr:
            process = subprocess.Popen(
                ["cmd.exe", "/d", "/c", "call", str(ROOT / "MV_server.bat")],
                cwd=ROOT,
                env=env,
                stdout=stdout,
                stderr=stderr,
            )
            ready = False
            try:
                deadline = time.monotonic() + 45
                while time.monotonic() < deadline and process.poll() is None:
                    if _ready(port):
                        ready = True
                        break
                    time.sleep(0.5)
            finally:
                if process.poll() is None:
                    killed = subprocess.run(
                        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                        capture_output=True,
                        check=False,
                    )
                    if killed.returncode != 0:
                        print(
                            killed.stderr.decode(errors="replace"), file=sys.stderr
                        )
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                # taskkill can return just before SQLite releases its final
                # Windows file handle. Wait for the probe port to close.
                close_deadline = time.monotonic() + 10
                while time.monotonic() < close_deadline and _ready(port):
                    time.sleep(0.25)
                time.sleep(0.5)

        output = stdout_path.read_text(encoding="utf-8", errors="replace")
        errors = stderr_path.read_text(encoding="utf-8", errors="replace")
        print(output[-4000:])
        if errors:
            print(errors[-2000:], file=sys.stderr)
        npm_was_called = "npm ci" in output or "npm install" in output
        print(
            f"smoke ready={ready} port={port} npm_called={npm_was_called} "
            f"data={temp_path / 'data'}"
        )
        return 0 if ready and not npm_was_called else 1


if __name__ == "__main__":
    raise SystemExit(main())
