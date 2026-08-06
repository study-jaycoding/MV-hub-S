"""WS 유령 연결 수거 — 프로토콜 ping 비활성(serve.py) 전제의 앱 레벨 살아있음 판정.

FIN 없는 사망(와이파이 단절·절전)으로 하트비트가 끊긴 연결을 서버가 1001 로 닫아
manager._active 에 유령이 쌓이지 않게 한다(코덱스 합의 D5). 텍스트 수신은 무엇이든
살아있음으로 친다(브라우저 "ping"·원격 브리지 하트비트 계약).
"""

from __future__ import annotations

import os
import tempfile
import unittest

from starlette.websockets import WebSocketDisconnect


class WsGhostCollectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        self.old_np = os.environ.get("CONTENT_HUB_NO_PROXY")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        os.environ["CONTENT_HUB_NO_PROXY"] = "1"
        from app import db, repo

        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        from app import main as main_mod

        self.main = main_mod
        self.old_timeout = main_mod._WS_RECV_TIMEOUT_SECONDS
        self.old_ghost = main_mod._WS_GHOST_SECONDS
        from fastapi.testclient import TestClient

        self.client = TestClient(main_mod.app, client=("127.0.0.1", 50000))

    def tearDown(self):
        self.main._WS_RECV_TIMEOUT_SECONDS = self.old_timeout
        self.main._WS_GHOST_SECONDS = self.old_ghost
        from app import db

        self.client.close()
        db.flush_pool()
        for k, v in (("CONTENT_HUB_DB", self.old_db), ("CONTENT_HUB_NO_PROXY", self.old_np)):
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        db.flush_pool()
        self.tmp.cleanup()

    def test_silent_connection_is_closed_with_going_away(self):
        # 하트비트가 전혀 오지 않으면 유령 임계 초과 시 서버가 1001 로 닫는다.
        self.main._WS_RECV_TIMEOUT_SECONDS = 0.05
        self.main._WS_GHOST_SECONDS = 0.1
        with self.client.websocket_connect("/ws") as ws:
            with self.assertRaises(WebSocketDisconnect) as raised:
                ws.receive_text()
        self.assertEqual(raised.exception.code, 1001)

    def test_heartbeat_keeps_connection_alive(self):
        # 텍스트 하트비트가 오는 동안엔 임계가 계속 밀려 닫히지 않는다.
        self.main._WS_RECV_TIMEOUT_SECONDS = 0.05
        self.main._WS_GHOST_SECONDS = 10.0
        with self.client.websocket_connect("/ws") as ws:
            for _ in range(3):
                ws.send_text("ping")
            # 닫혔다면 send 가 실패했을 것 — 정상 종료 경로로 나가면 성공.


if __name__ == "__main__":
    unittest.main()
