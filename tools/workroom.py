"""Opt-in workroom launcher. No installs, workers, shared browser, or port eviction."""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
CHILD_OPTIONS = "MVHUB_WORKROOM_CHILD_OPTIONS"


def options(argv=None, repo: Path = REPO):
    config = repo / ".mvhub-workroom.json"
    saved = json.loads(config.read_text(encoding="utf-8-sig")) if config.is_file() else {}
    allowed = {"runtime", "backend_port", "frontend_port", "source_db", "python", "no_browser"}
    if not isinstance(saved, dict) or set(saved) - allowed:
        raise ValueError(".mvhub-workroom.json에 지원하지 않는 설정이 있습니다")
    parser = argparse.ArgumentParser(description="MV Hub 비유료 개발 작업실 (기존 서버는 종료하지 않음)")
    parser.add_argument("--runtime", default=saved.get("runtime"))
    parser.add_argument("--backend-port", type=int, default=saved.get("backend_port"))
    parser.add_argument("--frontend-port", type=int, default=saved.get("frontend_port"))
    parser.add_argument("--source-db", default=saved.get("source_db"))
    parser.add_argument("--python", default=saved.get("python", sys.executable))
    parser.add_argument("--no-browser", action="store_true", default=saved.get("no_browser", False))
    args = parser.parse_args(argv)
    if not args.runtime:
        parser.error("--runtime 또는 .mvhub-workroom.json의 runtime이 필요합니다")
    for name in ("backend_port", "frontend_port"):
        value = getattr(args, name)
        if type(value) is not int or not 1024 <= value <= 65535:
            parser.error(f"{name}: 1024~65535 포트를 지정하세요")
    if args.backend_port == args.frontend_port:
        parser.error("백엔드와 화면 포트는 달라야 합니다")
    if type(args.no_browser) is not bool:
        parser.error("no_browser는 true 또는 false여야 합니다")
    if args.python is None:
        parser.error("python: 실행 파일 경로가 필요합니다")
    for name in ("runtime", "source_db", "python"):
        value = getattr(args, name)
        if value is not None:
            if not isinstance(value, str) or not value.strip():
                parser.error(f"{name}: 파일 또는 폴더 경로를 지정하세요")
            path = Path(value)
            setattr(args, name, str((path if path.is_absolute() else repo / path).resolve()))
    return args


def assert_ports_free(ports):
    """Probe both ports before starting anything; never stop their existing owners."""
    sockets = []
    try:
        for port in ports:
            probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sockets.append(probe)
            if os.name == "nt":
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            try:
                probe.bind(("127.0.0.1", port))
            except OSError as exc:
                raise RuntimeError(f"포트 {port}를 사용할 수 없습니다. 기존 프로그램은 종료하지 않았습니다") from exc
    finally:
        for probe in sockets:
            probe.close()


@contextmanager
def runtime_lock(runtime: Path):
    # A named mutex protects first-copy creation too, without writing into an unowned folder.
    if os.name != "nt":
        raise OSError("작업실 실행은 Windows 전용입니다")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
    kernel.CreateMutexW.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    identity = hashlib.sha256(str(runtime.resolve()).casefold().encode()).hexdigest()
    handle = kernel.CreateMutexW(None, False, "Local\\MVHubWorkroom-" + identity)
    error = ctypes.get_last_error()
    if not handle:
        raise ctypes.WinError(error)
    try:
        if error == 183:
            raise RuntimeError("이 작업실 데이터 폴더는 이미 실행 중입니다")
        yield
    finally:
        kernel.CloseHandle(handle)


def wait_ready(url, process, *, timeout=90):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("작업실 서버가 시작 중 종료됐습니다. runtime의 로그를 확인하세요")
        try:
            with opener.open(url, timeout=1) as response:
                if response.status == 200:
                    if not url.endswith("/api/ready") or json.loads(response.read(65536)).get("status") == "ready":
                        return
        except (OSError, ValueError, urllib.error.URLError):
            pass
        time.sleep(.2)
    raise RuntimeError("작업실 서버 준비 시간이 초과됐습니다. runtime의 로그를 확인하세요")


def browser_command(executable, profile, url):
    return [executable, f"--user-data-dir={profile}", f"--app={url}", "--no-first-run",
            "--no-default-browser-check", "--disable-background-mode"]


def write_vite_config(runtime: Path, repo: Path, port: int) -> Path:
    """Mark only this development server; leave the product config and HTML alone."""
    config = runtime / "generated-vite.config.mjs"
    source = json.dumps((repo / "frontend/vite.config.ts").as_posix())
    title = json.dumps(f"<title>[시험실 {port}] MV Hub</title>", ensure_ascii=False)
    badge = json.dumps(f"통합·기능 시험실 · 실제 생성 꺼짐 · {port}", ensure_ascii=False)
    config.write_text(f'''import base from {source};
export default {{
  ...base,
  plugins: [...(base.plugins || []), {{
    name: 'mvhub-workroom-label', apply: 'serve',
    transformIndexHtml(html) {{
      return {{html: html.replace(/<title>[^<]*<\\/title>/i, {title}), tags: [{{
        tag: 'div', attrs: {{id: 'mvhub-workroom-badge',
          style: 'position:fixed;bottom:6px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;max-width:calc(100vw - 24px);box-sizing:border-box;padding:4px 10px;border:1px solid #a3be42;border-radius:99px;background:#182009ee;color:#e3efb4;font:11px/1.4 sans-serif;text-align:center'}},
        children: {badge}, injectTo: 'body'
      }}]}};
    }}
  }}]
}};
''', encoding="utf-8")
    return config


def run(args, repo=REPO):
    from workroom_data import llm_config_hashes, prepare_runtime, runtime_env

    # Discovery uses the original environment; child processes receive only the isolated one.
    sys.path.insert(0, str(repo))
    import run_agent_session as guard

    runtime = Path(args.runtime)
    python = Path(args.python)
    node = shutil.which("node.exe" if os.name == "nt" else "node")
    vite = repo / "frontend/node_modules/vite/bin/vite.js"
    if not python.is_file() or not node or not vite.is_file():
        raise RuntimeError("Python·Node·이 작업실 frontend 의존성을 먼저 준비하세요. 자동 설치하지 않습니다")
    browser = None if args.no_browser else guard._find_app_browser()
    if not args.no_browser and not browser:
        raise RuntimeError("전용 창을 열 Edge 또는 Chrome을 찾지 못했습니다")
    before = llm_config_hashes()
    with runtime_lock(runtime):
        assert_ports_free([args.backend_port, args.frontend_port])
        prepare_runtime(runtime, Path(args.source_db) if args.source_db else None, repo)
        env = runtime_env(runtime, repo, args.backend_port, os.environ)
        env.pop(CHILD_OPTIONS, None)
        env["BACKEND"] = f"http://127.0.0.1:{args.backend_port}"
        vite_config = write_vite_config(runtime, repo, args.frontend_port)
        profile = runtime / "browser"
        # Do not silently hand an existing profile to a different browser engine.
        browser_file = runtime / "browser-executable.txt"
        if browser:
            if browser_file.exists():
                pinned = Path(browser_file.read_text(encoding="utf-8").strip())
                if not pinned.is_file():
                    raise RuntimeError("이 작업실에서 사용하던 브라우저를 찾지 못했습니다")
                browser = (browser[0], str(pinned))
            else:
                browser_file.write_text(browser[1], encoding="utf-8")
            profile.mkdir(exist_ok=True)
        commands = [
            [str(python), "-B", str(repo / "tools/workroom_backend.py"), "--runtime", str(runtime), "--port", str(args.backend_port)],
            [node, str(vite), "--config", str(vite_config), "--host", "127.0.0.1", "--port", str(args.frontend_port), "--strictPort"],
        ]
        processes, logs = [], []
        state = {"repo": str(repo), "runtime": str(runtime), "backend_port": args.backend_port,
                 "frontend_port": args.frontend_port, "status": "starting", "pids": [], "llm_config_before": before}
        state_path = runtime / "launcher-state.json"
        try:
            for index, command in enumerate(commands):
                log = (runtime / ("backend.log" if index == 0 else "frontend.log")).open("ab")
                logs.append(log)
                process = subprocess.Popen(command, cwd=repo if index == 0 else repo / "frontend", env=env,
                                           stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                           creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
                processes.append(process)
                state["pids"].append(process.pid)
                state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
                path = "/api/ready" if index == 0 else "/"
                port = args.backend_port if index == 0 else args.frontend_port
                wait_ready(f"http://127.0.0.1:{port}{path}", process)
            if browser:
                process = subprocess.Popen(browser_command(browser[1], profile, f"http://127.0.0.1:{args.frontend_port}"),
                                           env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                           stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
                processes.append(process)
                state["pids"].append(process.pid)
            state["status"] = "running"
            state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[작업실 · 실제 생성 차단] http://127.0.0.1:{args.frontend_port}", flush=True)
            print("화면 코드는 저장 즉시 반영됩니다. Python 변경은 이 작업실만 다시 실행하세요.", flush=True)
            while True:
                if any(process.poll() is not None for process in processes[:2]):
                    raise RuntimeError("작업실 서버가 종료됐습니다. 로그를 확인하세요")
                if browser and processes[-1].poll() is not None:
                    break
                time.sleep(.3)
        finally:
            for process in reversed(processes):
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
            for log in logs:
                log.close()
            after = llm_config_hashes()
            state.update(status="stopped", llm_config_after=after, llm_config_unchanged=before == after)
            state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
            if before != after:
                print("[주의] 실행 중 사용자 LLM 설정이 변경됐습니다. 되돌리지 않았습니다.", file=sys.stderr)
    return 0


def main(argv=None):
    try:
        child = os.environ.get(CHILD_OPTIONS)
        if child and os.environ.get("MVHUB_SESSION_GUARDED") == "1":
            return run(options(json.loads(child)))
        args = options(argv)
        if os.name != "nt":
            raise OSError("작업실 실행은 Windows 전용입니다")
        # Call only the Job Object primitive, not the old launcher's session replacement or shortcuts.
        sys.path.insert(0, str(REPO))
        from run_agent_session import run_guarded
        resolved = ["--runtime", args.runtime, "--backend-port", str(args.backend_port),
                    "--frontend-port", str(args.frontend_port), "--python", args.python]
        if args.source_db:
            resolved += ["--source-db", args.source_db]
        if args.no_browser:
            resolved += ["--no-browser"]
        os.environ[CHILD_OPTIONS] = json.dumps(resolved, ensure_ascii=False)
        try:
            return run_guarded(REPO / "test_workroom.bat")
        finally:
            os.environ.pop(CHILD_OPTIONS, None)
    except KeyboardInterrupt:
        return 0
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"[작업실 오류] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
