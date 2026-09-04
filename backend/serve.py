"""듀얼 스택 기동기 — IPv4(0.0.0.0)와 IPv6 루프백(::1)을 동시에 듣는다.

왜 필요한가:
  Windows 의 'localhost' 는 IPv6(::1)를 먼저 시도하고 ~200ms 기다린 뒤 IPv4 로
  폴백한다. 서버가 IPv4(0.0.0.0)만 듣고 있으면 localhost 접속마다 그 폴백 지연이
  붙는다(체감 '로딩 딜레이'의 정체). ::1 도 함께 들으면 localhost 가 즉시 연결된다.

안전성(다른 사람 영향 없음):
  · 기존 IPv4 0.0.0.0 소켓은 그대로 — LAN(192.168.x.x 직접 접속) 팀원은 전혀 안 바뀜.
  · 추가하는 IPv6 소켓은 루프백(::1) 전용 → 네트워크에 새로 노출되는 것 없음(이 PC localhost 만).
  · IPv6 가 비활성이면 바인딩 실패를 무시하고 IPv4 만으로 계속 — 깨지지 않음.

규칙: --reload 는 쓰지 않는다(프로젝트 규칙: CLI subprocess 가 깨짐).
실행:  python serve.py     (포트·호스트는 CONTENT_HUB_HOST/PORT 환경변수)
"""

from __future__ import annotations

import argparse
import os
import signal
import socket
import sys

import uvicorn


def _make_stdio_crash_proof() -> None:
    """콘솔 인코딩 때문에 print 한 줄이 서버를 죽이지 못하게 한다.

    예약 작업은 stdout 을 logs\\server_console.log 로 돌린다. 그때 Python 은 콘솔이
    아니라 로케일 인코딩(한국어 Windows = cp949)으로 인코딩하는데, cp949 에는
    em dash(—)가 없다. 한글은 되지만 그 한 글자에서 UnicodeEncodeError 가 나고,
    기동 중에 나면 uvicorn 이 'Application startup failed' 로 프로세스를 끝낸다.

    2026-09-04 실서버에서 재현했다 — CONTENT_HUB_EXTERNAL_RECOVERY=0 으로 띄우자
    app/main.py 의 기동 안내 print 하나 때문에 서버가 뜨지 못했다. 같은 문자가
    serve.py(IPv6 바인딩 실패 안내)와 backup·syncer·thumbs·asset_watcher 등
    16곳에 있어, 그 경로를 지나가는 순간 같은 일이 난다.

    로그 문자를 곳곳에서 관리하는 대신 여기서 한 번 errors='replace' 로 바꾼다.
    인코딩 자체는 바꾸지 않으므로 기존 로그 읽기(MV_logs.bat)는 그대로다.
    PYTHONIOENCODING 을 준 호출자(복원 드릴)는 그 인코딩이 유지된다.

    ★ app 을 import 하기 전에 불러야 한다 — import 시점의 print 도 보호 대상이다.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, OSError, ValueError):
            pass  # 파이프·리다이렉트 형태에 따라 지원되지 않을 수 있다(그때는 원래대로).


_make_stdio_crash_proof()

from app.config import HOST, PORT  # noqa: E402 — stdio 보호를 app import 보다 먼저


def _parse_args(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description=(
            "MV Hub backend server. Host and port are configured with "
            "CONTENT_HUB_HOST/CONTENT_HUB_PORT."
        )
    )
    parser.parse_args(argv)


def _make_socket(family: int, addr: tuple) -> socket.socket:
    s = socket.socket(family, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if family == socket.AF_INET6:
        # IPv6 전용으로 격리 — IPv4 0.0.0.0 소켓과 같은 포트를 쓰되 중복 바인딩 충돌 방지.
        s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    s.bind(addr)
    s.listen(2048)
    s.set_inheritable(True)
    return s


def _run_server(server: uvicorn.Server, sockets: list[socket.socket]) -> None:
    """Windows Ctrl+Break 종료를 감독기가 크래시로 오해하지 않게 한다.

    Uvicorn은 실행 중 SIGBREAK를 정상 종료 신호로 처리하지만, 종료가 끝난 뒤 원래
    핸들러로 같은 신호를 다시 올린다. Windows 기본 핸들러는 이때 종료코드 3을 남겨
    감독기가 서버를 재시작한다. 실행 중 처리는 Uvicorn에 맡기고, 마지막 재전파만
    무시한 뒤 원래 핸들러를 복원한다.
    """
    sigbreak = getattr(signal, "SIGBREAK", None)
    previous = None
    if os.name == "nt" and sigbreak is not None:
        previous = signal.getsignal(sigbreak)
        signal.signal(sigbreak, lambda _sig, _frame: None)
    try:
        try:
            server.run(sockets=sockets)
        except KeyboardInterrupt:
            # Python 3.14의 asyncio.Runner는 Uvicorn이 정상 shutdown을 끝낸 뒤에도
            # Ctrl+C를 다시 KeyboardInterrupt로 올릴 수 있다. 서버가 이미 종료 절차를
            # 마친 정상 사용자 종료이므로 불필요한 오류 스택을 남기지 않는다.
            pass
    finally:
        if previous is not None:
            signal.signal(sigbreak, previous)


def main() -> None:
    ssl_certfile = os.environ.get("CONTENT_HUB_SSL_CERTFILE", "").strip() or None
    ssl_keyfile = os.environ.get("CONTENT_HUB_SSL_KEYFILE", "").strip() or None
    if bool(ssl_certfile) != bool(ssl_keyfile):
        raise RuntimeError(
            "HTTPS 사용 시 CONTENT_HUB_SSL_CERTFILE과 CONTENT_HUB_SSL_KEYFILE을 모두 지정해야 합니다."
        )
    scheme = "https" if ssl_certfile else "http"
    access_log = os.environ.get("CONTENT_HUB_ACCESS_LOG", "0").lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    sockets = [_make_socket(socket.AF_INET, (HOST, PORT))]
    # localhost(::1) 빠른 접속용 IPv6 루프백. 실패해도(IPv6 비활성/이미 사용중) IPv4 로 계속.
    try:
        sockets.append(_make_socket(socket.AF_INET6, ("::1", PORT)))
        print(f"[serve] 듀얼 스택 기동: IPv4 {HOST}:{PORT} + IPv6 [::1]:{PORT}")
        print(f"[serve] 같은 PC 접속: {scheme}://127.0.0.1:{PORT}  또는  {scheme}://localhost:{PORT} (둘 다 빠름)")
    except OSError as e:  # noqa: BLE001
        print(f"[serve] IPv6(::1) 바인딩 건너뜀({e}) — IPv4 만 사용. 같은 PC 는 {scheme}://127.0.0.1:{PORT} 권장")

    config = uvicorn.Config(
        "app.main:app",
        host=HOST,
        port=PORT,
        log_level="info",
        # 생성물·코멘트 폴링의 정상 200 로그로 운영 창이 계속 밀리지 않게 한다.
        # 진단할 때만 CONTENT_HUB_ACCESS_LOG=1 로 요청 로그를 다시 켤 수 있다.
        access_log=access_log,
        # 구형 Windows 콘솔에서 ANSI 색상 코드가 글자로 보이는 문제를 막는다.
        use_colors=False,
        # 브라우저가 25초마다 텍스트 ping을 보내고 앱이 45초마다 세션을 재검증한다.
        # Uvicorn의 별도 프로토콜 ping까지 켜면 100명 연결에서 같은 시각에 ping/pong이
        # 몰려 정상 연결도 keepalive timeout(1011)으로 끊길 수 있어 중복 ping을 끈다.
        ws_ping_interval=None,
        ssl_certfile=ssl_certfile,
        ssl_keyfile=ssl_keyfile,
    )
    server = uvicorn.Server(config)
    _run_server(server, sockets)
    # Uvicorn은 lifespan startup 실패도 run()에서 예외를 삼키고 정상 반환할 수 있다.
    # 실제 리스너가 한 번도 시작되지 않았다면 작업 스케줄러·감독기가 성공으로 오해하지
    # 않도록 반드시 비정상 종료코드를 남긴다.
    if not server.started:
        raise SystemExit(1)


def cli(argv: list[str] | None = None) -> None:
    """Validate command-line arguments before opening any listening socket."""
    _parse_args(argv)
    main()


if __name__ == "__main__":
    cli()
