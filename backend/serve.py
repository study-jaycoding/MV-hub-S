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

import socket

import uvicorn

from app.config import HOST, PORT


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


def main() -> None:
    sockets = [_make_socket(socket.AF_INET, (HOST, PORT))]
    # localhost(::1) 빠른 접속용 IPv6 루프백. 실패해도(IPv6 비활성/이미 사용중) IPv4 로 계속.
    try:
        sockets.append(_make_socket(socket.AF_INET6, ("::1", PORT)))
        print(f"[serve] 듀얼 스택 기동: IPv4 {HOST}:{PORT} + IPv6 [::1]:{PORT}")
        print(f"[serve] 같은 PC 접속: http://127.0.0.1:{PORT}  또는  http://localhost:{PORT} (둘 다 빠름)")
    except OSError as e:  # noqa: BLE001
        print(f"[serve] IPv6(::1) 바인딩 건너뜀({e}) — IPv4 만 사용. 같은 PC 는 http://127.0.0.1:{PORT} 권장")

    config = uvicorn.Config("app.main:app", host=HOST, port=PORT, log_level="info")
    server = uvicorn.Server(config)
    server.run(sockets=sockets)


if __name__ == "__main__":
    main()
