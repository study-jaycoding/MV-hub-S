"""Development accident guard, not an OS sandbox or a hostile-code boundary.

Install before importing the real application. Only this launcher opts in; ordinary
serve.py remains unchanged. Native extensions and deliberately bypassed Python hooks
are outside this guard's guarantees.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import socket
import sqlite3
import sys
import tempfile
import threading
from urllib.parse import unquote, urlsplit
from urllib.request import url2pathname


MESSAGE = "개발 작업방에서는 외부 실행·통신과 작업방 밖의 변경을 차단합니다."


class WorkroomBlocked(PermissionError):
    def __init__(self):
        super().__init__(MESSAGE)


class Guard:
    def __init__(self, runtime: Path, port: int):
        self.runtime = runtime.resolve(strict=True)
        if not self.runtime.is_dir() or not 1024 <= port <= 65535:
            raise ValueError("작업방 폴더와 1024~65535 포트가 필요합니다.")
        self.port = port
        self.local = threading.local()

    def path(self, value):
        if isinstance(value, int):
            # Inherited stdio and descriptors opened after this guard are allowed.
            return
        raw = os.fsdecode(value)
        if raw.startswith(("\\\\", "//")):
            raise WorkroomBlocked()
        try:
            Path(raw).resolve().relative_to(self.runtime)
        except (ValueError, OSError):
            raise WorkroomBlocked() from None

    def database(self, value):
        raw = os.fsdecode(value)
        if raw in (":memory:", ""):
            return
        if raw.startswith("file:"):
            parsed = urlsplit(raw)
            if parsed.netloc:
                raise WorkroomBlocked()
            raw = url2pathname(unquote(parsed.path))
        self.path(raw)

    def address(self, address):
        if getattr(self.local, "socketpair", False):
            return
        if not isinstance(address, tuple) or len(address) < 2:
            raise WorkroomBlocked()
        if address[0] not in ("127.0.0.1", "::1", "localhost") or address[1] != self.port:
            raise WorkroomBlocked()

    def audit(self, event, args):
        if event == "open":
            path, mode, flags = args
            if (mode and any(char in mode for char in "wax+")) or flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
                self.path(path)
        elif event in ("os.remove", "os.rmdir", "os.mkdir", "os.chmod", "os.utime", "os.truncate"):
            self.path(args[0])
            directory_index = {"os.remove": 1, "os.rmdir": 1, "os.mkdir": 2, "os.chmod": 2, "os.utime": 3}.get(event)
            if directory_index is not None and len(args) > directory_index and args[directory_index] not in (None, -1):
                raise WorkroomBlocked()
        elif event in ("os.rename", "os.link", "os.symlink"):
            self.path(args[0])
            self.path(args[1])
            if event == "os.symlink" or any(value not in (None, -1) for value in args[2:]):
                raise WorkroomBlocked()
        elif event in ("_winapi.CopyFile2", "shutil.copyfile", "shutil.copytree", "shutil.copymode", "shutil.copystat", "shutil.move"):
            # Windows copy2 uses CopyFile2 without any Python open event.
            self.path(args[1])
            if event == "shutil.move":
                self.path(args[0])
        elif event == "sqlite3.connect":
            self.database(args[0])
        elif event in ("sqlite3.enable_load_extension", "sqlite3.load_extension"):
            raise WorkroomBlocked()
        elif event in ("subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.startfile", "os.startfile/2", "os.fork", "os.forkpty"):
            raise WorkroomBlocked()
        elif event in ("socket.connect", "socket.bind"):
            self.address(args[1])
        elif event == "socket.sendto":
            self.address(args[-1])
        elif event in ("socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyaddr"):
            if args[0] not in ("127.0.0.1", "::1", "localhost"):
                raise WorkroomBlocked()
        elif event == "ctypes.dlopen" and "fusionscript" in str(args[0]).lower():
            raise WorkroomBlocked()

    def authorize(self, operation, arg1, arg2, dbname, source):
        if operation == sqlite3.SQLITE_PRAGMA and arg1 in ("temp_store_directory", "data_store_directory") and arg2:
            try:
                self.path(arg2)
            except WorkroomBlocked:
                return sqlite3.SQLITE_DENY
        if operation == sqlite3.SQLITE_ATTACH:
            # SQLite does not expose bound ATTACH/VACUUM parameters here.
            # An unknown destination must never become an unchecked native write.
            if arg1 is None:
                return sqlite3.SQLITE_DENY
            try:
                self.database(arg1)
            except WorkroomBlocked:
                return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK


def install_guard(runtime: Path, port: int) -> Guard:
    guard = Guard(runtime, port)
    sys.dont_write_bytecode = True
    original_connect = sqlite3.connect
    def connect(*args, **kwargs):
        connection = original_connect(*args, **kwargs)
        connection.set_authorizer(guard.authorize)
        return connection
    sqlite3.connect = connect
    sqlite3.dbapi2.connect = connect

    original_socketpair = socket.socketpair
    def socketpair(*args, **kwargs):
        # Windows' stdlib fallback creates its own ephemeral loopback listener.
        guard.local.socketpair = True
        try:
            return original_socketpair(*args, **kwargs)
        finally:
            guard.local.socketpair = False
    socket.socketpair = socketpair
    if sys.platform == "win32":
        from asyncio.windows_events import IocpProactor
        original_proactor_connect = IocpProactor.connect
        def proactor_connect(self, conn, address):
            guard.address(address)
            return original_proactor_connect(self, conn, address)
        IocpProactor.connect = proactor_connect
        original_sendto = IocpProactor.sendto
        def proactor_sendto(self, conn, buffer, flags=0, addr=None):
            if addr is not None:
                guard.address(addr)
            return original_sendto(self, conn, buffer, flags, addr)
        IocpProactor.sendto = proactor_sendto
    sys.addaudithook(guard.audit)
    return guard


class WorkroomApp:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "").rstrip("/")
        # The existing catalog has only a per-process memory cache. A fresh
        # process would invoke CLI even for these reads; no offline list exists.
        blocked = (path.startswith(("/api/resolve", "/api/comfy", "/api/models", "/api/cli")) or
                   path in ("/api/account", "/api/workspaces", "/api/workspaces/select", "/api/workspaces/unselect", "/api/cost", "/api/sync") or
                   (path == "/api/gen-requests" and scope.get("method") == "POST") or
                   path.endswith("/begin-submission"))
        if scope["type"] == "http" and blocked:
            await self.reject(send)
            return
        await self.app(scope, receive, send)

    @staticmethod
    async def reject(send):
        body = json.dumps({"detail": MESSAGE, "code": "workroom_blocked"}, ensure_ascii=False).encode()
        await send({"type": "http.response.start", "status": 503,
                    "headers": [(b"content-type", b"application/json; charset=utf-8"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", required=True, type=Path)
    parser.add_argument("--port", required=True, type=int)
    args = parser.parse_args(argv)
    guard = install_guard(args.runtime, args.port)
    # Even an incorrectly inherited launcher path must fail before app import.
    for key, value in os.environ.items():
        if key.startswith("CONTENT_HUB_") and key.endswith(("_DIR", "_DB", "_DATA", "_MEDIA", "_SHARED")) and key != "CONTENT_HUB_FRONTEND_DIST":
            guard.path(value)
    os.environ.update({"CONTENT_HUB_HOST": "127.0.0.1", "CONTENT_HUB_PORT": str(args.port),
                       "CONTENT_HUB_NO_PROXY": "1", "CONTENT_HUB_EXTERNAL_RECOVERY": "0",
                       "CONTENT_HUB_BACKUP_INTERVAL": "0", "CONTENT_HUB_SERVER_SYNC": "0"})
    for required in ("CONTENT_HUB_DATA", "CONTENT_HUB_DB", "CONTENT_HUB_MEDIA", "CONTENT_HUB_ASSETS_DIR"):
        guard.path(os.environ[required])
    temp = guard.runtime / "tmp"
    temp.mkdir(exist_ok=True)
    os.environ.update({"TEMP": str(temp), "TMP": str(temp)})
    tempfile.tempdir = str(temp)
    backend = Path(__file__).resolve().parents[1] / "backend"
    sys.path.insert(0, str(backend))
    import serve
    from app import main as application
    from app.routers import gen_requests
    from fastapi import HTTPException
    async def blocked_generation(*args, **kwargs):
        # Internal callers (including MCP) do not traverse the outer ASGI guard.
        raise HTTPException(503, MESSAGE)
    gen_requests.create_gen_request = blocked_generation
    application.app = WorkroomApp(application.app)
    serve.cli([])


if __name__ == "__main__":
    main()
