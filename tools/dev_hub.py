"""로컬 허브 전용 화면을 핫 리로드로 보는 두 번째 개발 세션 (사용법: docs/TESTING.md "로컬 허브 화면 개발").

  test_dev_hub.bat 이 부른다 — 8012(test_dev)를 공유 서버로 삼는 AUTH-off 허브와, 그 허브를 프록시하는 Vite 를 띄운다.
  <python> tools/dev_hub.py --port 8013 --vite-port 5273

안전선: 공유 서버는 이 PC 주소만 받는다. 허브 프로세스는 ① 이 PC·CDN·Higgsfield 밖 HTTP 를 죽은 프록시로 보내고 ② 사설망 주소로 바로 붙는
연결을 끊는다(serve 모드). 기동 뒤 공유 주소를 **확인하지 못하면 내리고 실패**한다. CLI 는 허브가 띄우는 별도 프로세스라 ①②의 밖이며, 허브는 CLI 로
조회만 한다(워크스페이스·모델 목록, 빼면 502). 제출은 에이전트만 하고 이 세션은 에이전트를 띄우지 않으므로, 생성 요청은 이 허브 DB 대기열에 머문다.
★NAS 는 막지 않는다 — SMB 는 Windows 가 처리해 ①②의 밖이다. 어셋 창처럼 실제 폴더를 여는 기능은 닿을 수 있다.
★다른 계정으로 로그인하면 8012 의 에이전트가 그 계정을 따라가 그 계정의 대기 요청을 실제로 제출할 수 있다(routers/auth.py `_activate_local_agent`).
★CONTENT_HUB_DB 를 넣지 않는다 — 넣으면 계정별 DB 전환이 꺼진다.
"""
from __future__ import annotations

import argparse
import ipaddress
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

REPO = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(REPO), str(REPO / "tools" / "browser_measure")]

import servers  # noqa: E402 — 격리 환경·대기 함수는 격리 실측 도구의 것을 같이 쓴다
from run_agent_session import open_browser_detached  # noqa: E402

BACKEND = REPO / "backend"
# Higgsfield 는 CLI 조회용, CDN 은 막으면 썸네일 요청이 일꾼을 붙잡아 공유가 25초씩 걸린다(2026-11-01 실측).
NO_PROXY = "127.0.0.1,localhost,.higgsfield.ai,.cloudfront.net"


def hub_env(parent, shared_url: str, port: int, data: Path) -> dict[str, str]:
    """허브 환경 — 부모의 `CONTENT_HUB_*` 없이, 데이터는 data 안에, 위임은 shared_url 로만."""
    parts = urlsplit(shared_url)
    if parts.hostname not in ("127.0.0.1", "localhost") or not parts.port:
        raise ValueError(f"공유 서버는 이 PC 의 주소와 포트만 받는다: {shared_url}")
    data = data.resolve()
    for user_data in ((BACKEND / "data").resolve(), (BACKEND / "data_test").resolve()):
        if data == user_data or user_data in data.parents or data in user_data.parents:
            raise ValueError(f"허브 데이터는 사용자 데이터 폴더 {user_data} 와 겹치면 안 된다: {data}")
    env = servers.isolated_base_env(parent)
    env.update({
        "CONTENT_HUB_DATA": str(data), "CONTENT_HUB_SHARED_URL": shared_url,
        "CONTENT_HUB_AUTH": "0", "CONTENT_HUB_HOST": "127.0.0.1", "CONTENT_HUB_PORT": str(port),
        # 허브 모드의 백그라운드가 8012 데이터에 끼어들지 않게 — 자동 백업 전송·이력 보충을 끈다.
        "CONTENT_HUB_BACKUP_INTERVAL": "0", "CONTENT_HUB_EXTERNAL_RECOVERY": "0",
        "MVHUB_NAMES_READONLY": "1",  # test_dev 와 같다 — 복사 DB 가 실제 NAS 를 가리켜도 번호를 새로 받지 않는다
        "HTTP_PROXY": servers.DEAD_URL, "HTTPS_PROXY": servers.DEAD_URL, "NO_PROXY": NO_PROXY,
        "PYTHONIOENCODING": "utf-8",
    })
    return env


def refuse_lan(address) -> None:
    """이 PC 밖 비공인 주소로 바로 붙는 연결을 끊는다. 공유 서버 WebSocket(`remote_realtime`)은 `proxy=None` 이라 죽은 프록시를 타지 않고,
    `/api/shared-server/url` 은 연결 시험 없이 주소를 저장한다 — 2026-11-02 실측에서 토큰을 실어 LAN 주소로 바로 붙었다."""
    if not isinstance(address, tuple) or not address:
        return  # 네트워크 주소가 아니다(파이프 등)
    try:
        ip = ipaddress.ip_address(str(address[0]).split("%", 1)[0])
    except ValueError:
        # 표준 클라이언트는 IP 로 풀어 넘긴다. sock.connect((이름, 포트)) 만 이름으로 오는데, 여기서 다시 풀면 C 가 푼 실제 목적지와 달라질 수 있어 거절한다.
        raise PermissionError(f"dev hub 는 이름으로 바로 붙지 않는다: {address[0]}") from None
    if not ip.is_loopback and not ip.is_global:
        raise PermissionError(f"dev hub 는 이 PC 밖 사설망에 붙지 않는다: {ip}")


def install_lan_guard() -> None:
    sys.addaudithook(lambda event, args: refuse_lan(args[1]) if event == "socket.connect" else None)
    if sys.platform == "win32":  # asyncio 는 IOCP 로 연결해 감사 이벤트가 없다(tools/workroom_backend.py 와 같은 자리)
        from asyncio.windows_events import IocpProactor
        original = IocpProactor.connect

        def connect(self, conn, address):
            refuse_lan(address)
            return original(self, conn, address)
        IocpProactor.connect = connect


def wait_page(url: str, proc: subprocess.Popen, timeout: float = 60) -> bool:
    end = time.time() + timeout
    while time.time() < end and proc.poll() is None:
        try:
            urllib.request.urlopen(url, timeout=2).close()
            return True
        except OSError:  # 아직 뜨는 중
            time.sleep(0.5)
    return False


def run(args: argparse.Namespace) -> int:
    data = args.data.resolve()
    env = hub_env(os.environ, args.shared_url, args.port, data)
    node = shutil.which("node")
    if not node:
        print("[ERROR] node 를 찾지 못했다 — Node.js 를 설치한다")
        return 1
    try:
        servers.get_json(urlsplit(args.shared_url).port, "/api/ready")
    except OSError:
        print(f"[ERROR] 공유 서버 {args.shared_url} 이 응답하지 않는다 — test_dev.bat 을 먼저 켠다")
        return 1
    data.mkdir(parents=True, exist_ok=True)
    log_path = data / "hub.log"
    procs: list[subprocess.Popen] = []
    try:
        hub = subprocess.Popen([sys.executable, __file__, "serve"], cwd=BACKEND, env=env, stdin=subprocess.DEVNULL,
                               stdout=log_path.open("w", encoding="utf-8", errors="replace"), stderr=subprocess.STDOUT)
        procs.append(hub)
        if not servers.wait_ready(args.port, proc=hub):
            print(f"[ERROR] 허브가 준비되지 않았다 — {log_path}")
            return 1
        url = servers.get_json(args.port, "/api/shared-server/status", 10).get("url")
        if url != args.shared_url:
            print(f"[ERROR] 허브가 기억한 공유 서버가 {url} 이다 — 허브 데이터 폴더를 지우면 {args.shared_url} 로 돌아온다")
            return 1
        # 127.0.0.1 만 듣는다 — AUTH-off 허브를 LAN 에 내놓지 않는다.
        vite = subprocess.Popen([node, "node_modules/vite/bin/vite.js", "--config", "vite.hub.config.ts", "--host", "127.0.0.1",
                                 "--port", str(args.vite_port), "--strictPort"], cwd=REPO / "frontend",
                                env={**os.environ, "BACKEND": f"http://127.0.0.1:{args.port}"})
        procs.append(vite)
        if not wait_page(f"http://127.0.0.1:{args.vite_port}", vite):
            print(f"[ERROR] Vite 가 포트 {args.vite_port} 에서 뜨지 않았다")
            return 1
        # localhost 로 연다 — 쿠키는 포트를 가리지 않아 127.0.0.1 이면 5173 의 로그인 쿠키와 섞인다.
        url = f"http://localhost:{args.vite_port}"
        print(f"\n[dev hub] 화면 = {url}   허브 = 127.0.0.1:{args.port}   공유 서버 = {args.shared_url}", flush=True)
        print(f"          데이터 = {data}   로그 = {log_path}", flush=True)
        print("          .tsx/.css 는 저장하면 바로 들어간다. 백엔드(.py)를 고치면 이 창을 다시 켠다.\n", flush=True)
        if os.environ.get("MVHUB_NO_BROWSER") != "1":
            open_browser_detached(url)
        while all(proc.poll() is None for proc in procs):
            time.sleep(1)
        print(f"[ERROR] 허브나 Vite 가 멈췄다 — {log_path}")
        return 1
    finally:
        for proc in procs:
            proc.terminate()


def main() -> int:
    if sys.argv[1:] == ["serve"]:  # 위 run() 이 띄우는 허브 프로세스
        install_lan_guard()
        sys.path.insert(0, str(BACKEND))
        import serve
        serve.cli([])
        return 0
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, required=True, help="허브 포트")
    ap.add_argument("--vite-port", type=int, required=True, help="화면 포트")
    ap.add_argument("--shared-url", default="http://127.0.0.1:8012", help="공유 서버(이 PC 주소만). 기본: test_dev 백엔드")
    ap.add_argument("--data", type=Path, default=BACKEND / "data_hub_dev", help="허브 데이터 폴더")
    try:
        return run(ap.parse_args())
    except ValueError as exc:
        print(f"[ERROR] {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
