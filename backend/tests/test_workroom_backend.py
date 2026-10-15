"""Guard tests run in disposable child interpreters: audit hooks cannot be removed."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools" / "workroom_backend.py"


def _child(tmp_path, body):
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    source = f"""
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location('workroom', {str(SCRIPT)!r})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
runtime = pathlib.Path({str(runtime)!r})
outside = pathlib.Path({str(tmp_path / 'outside')!r})
module.install_guard(runtime, 19876)
def blocked(call):
    try:
        call()
    except (module.WorkroomBlocked, __import__('sqlite3').DatabaseError):
        return
    raise AssertionError('Operation escaped guard')
""" + body
    result = subprocess.run([sys.executable, "-I", "-B", "-c", source], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert not (tmp_path / "outside").exists()


def test_guard_file_and_sqlite_boundaries(tmp_path):
    _child(tmp_path, """
import os, sqlite3
(runtime / 'allowed').write_text('ok')
blocked(lambda: outside.write_text('wrong'))
blocked(lambda: os.open(outside, os.O_CREAT | os.O_WRONLY))
blocked(lambda: (runtime / 'allowed').rename(outside))
blocked(lambda: outside.mkdir())
blocked(lambda: sqlite3.connect(outside))
blocked(lambda: sqlite3.connect(outside.as_uri() + '?mode=rwc', uri=True))
with sqlite3.connect(runtime / 'db.sqlite') as conn:
    conn.execute('CREATE TABLE test(value)')
    conn.execute('INSERT INTO test VALUES(1)')
    conn.commit()
    blocked(lambda: conn.execute('ATTACH DATABASE ? AS other', (str(outside),)))
    blocked(lambda: conn.execute("ATTACH DATABASE '" + str(outside).replace("'", "''") + "' AS other"))
    blocked(lambda: conn.execute('VACUUM INTO ?', (str(outside),)))
    blocked(lambda: conn.execute("VACUUM INTO '" + str(outside).replace("'", "''") + "'"))
    conn.execute("VACUUM INTO '" + str(runtime / 'copy.sqlite').replace("'", "''") + "'")
assert (runtime / 'copy.sqlite').exists()
""")


def test_guard_blocks_processes_and_network_but_allows_event_loop(tmp_path):
    _child(tmp_path, """
import asyncio, socket, subprocess, os
blocked(lambda: subprocess.run([sys.executable, '-c', 'pass']))
blocked(lambda: os.system('echo forbidden'))
if hasattr(os, 'startfile'):
    blocked(lambda: os.startfile(str(outside)))
for address in [('127.0.0.1', 8010), ('192.0.2.1', 80), ('::1', 8010)]:
    family = socket.AF_INET6 if ':' in address[0] else socket.AF_INET
    with socket.socket(family) as conn:
        blocked(lambda: conn.connect(address))
blocked(lambda: socket.getaddrinfo('external.invalid', 443))
blocked(lambda: socket.gethostbyname('external.invalid'))
left, right = socket.socketpair()
left.send(b'x')
assert right.recv(1) == b'x'
left.close(); right.close()
async def check():
    with socket.socket() as conn:
        conn.setblocking(False)
        try:
            await asyncio.get_running_loop().sock_connect(conn, ('127.0.0.1', 8010))
        except module.WorkroomBlocked:
            pass
        else:
            raise AssertionError('async connection escaped')
    with socket.socket(type=socket.SOCK_DGRAM) as conn:
        conn.setblocking(False)
        try:
            await asyncio.get_running_loop().sock_sendto(conn, b'x', ('127.0.0.1', 8010))
        except module.WorkroomBlocked:
            pass
        else:
            raise AssertionError('async datagram escaped')
asyncio.run(check())
""")


def test_windows_native_copy_stays_inside_runtime(tmp_path):
    _child(tmp_path, """
import shutil
source = runtime / 'source'
source.write_text('fixture')
blocked(lambda: shutil.copy2(source, outside))
assert not outside.exists()
shutil.copy2(source, runtime / 'copy')
assert (runtime / 'copy').read_text() == 'fixture'
blocked(lambda: shutil.move(source, outside))
assert source.exists()
""")


def test_guard_rejects_existing_junction_escape(tmp_path):
    # symlink creation itself is denied; an existing junction must also resolve out.
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    target = tmp_path / "target"
    target.mkdir()
    if os.name == "nt":
        result = subprocess.run(["cmd", "/c", "mklink", "/J", str(runtime / "link"), str(target)], capture_output=True)
        assert result.returncode == 0
    else:
        (runtime / "link").symlink_to(target, target_is_directory=True)
    source = f"""
import importlib.util, pathlib
s = importlib.util.spec_from_file_location('workroom', {str(SCRIPT)!r})
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
m.install_guard(pathlib.Path({str(runtime)!r}), 19876)
try:
    pathlib.Path({str(runtime / 'link' / 'bad')!r}).write_text('bad')
except m.WorkroomBlocked:
    pass
else:
    raise AssertionError('junction escape')
"""
    result = subprocess.run([sys.executable, "-I", "-B", "-c", source], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert list(target.iterdir()) == []


def test_real_bootstrap_ready_and_dangerous_routes_blocked(tmp_path):
    spec = importlib.util.spec_from_file_location("servers", ROOT / "tools" / "browser_measure" / "servers.py")
    servers = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(servers)
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    env = servers.server_env(os.environ, "H", port, runtime)
    env.update({"PYTHONDONTWRITEBYTECODE": "1", "CONTENT_HUB_ASSET_REGISTRY": "0"})
    log_path = runtime / "backend.log"
    with log_path.open("wb") as log:
        proc = subprocess.Popen([sys.executable, "-B", str(SCRIPT), "--runtime", str(runtime), "--port", str(port)],
            cwd=ROOT / "backend", env=env, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 35
            while time.monotonic() < deadline and proc.poll() is None:
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ready", timeout=1) as response:
                        if json.load(response).get("status") == "ready":
                            break
                except (OSError, urllib.error.URLError):
                    time.sleep(0.2)
            else:
                raise AssertionError(log_path.read_text(encoding="utf-8", errors="replace")[-6000:])
            for path, method in (("/api/gen-requests", "POST"), ("/api/resolve/status", "GET"), ("/api/comfy/run", "POST"), ("/api/models", "GET")):
                request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method)
                try:
                    urllib.request.urlopen(request, timeout=3)
                    raise AssertionError("dangerous route was allowed")
                except urllib.error.HTTPError as exc:
                    assert exc.code == 503
                    assert json.load(exc)["code"] == "workroom_blocked"
            assert (runtime / "db" / "content_hub.db").is_file()
        finally:
            proc.terminate()
            proc.wait(timeout=10)
