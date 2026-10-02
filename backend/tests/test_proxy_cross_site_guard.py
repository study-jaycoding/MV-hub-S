"""로컬 허브 일반 프록시는 다른 사이트 페이지가 보낸 쓰기를 저장 토큰으로 중계하지 않는다(2026-10-02 Codex main 검토 P1).

본문 없는 관리자 POST(공지·백업 실행 등)는 외부 페이지의 단순 POST 로도 허브에 닿는다 — 허브가 토큰을 붙여 넘기면
서버는 관리자 요청으로 받는다. 같은 출처 앱 화면·Origin 없는 비브라우저(에이전트·Comfy·Resolve)·이 PC 의 다른 포트는
그대로 중계돼야 한다. 가짜는 위임 판정과 실제 전송 두 곳뿐 — 판정·검사는 제품 코드 그대로 돈다.
"""

from __future__ import annotations

import asyncio
import json
import unittest
from unittest.mock import patch

from starlette.requests import Request

from app.routers import _proxy

PATH = "/api/update-notices/admin/n1/announce"


def _request(method: str, headers: dict[str, str], path: str = PATH, extra: tuple[tuple[str, str], ...] = ()) -> Request:
    return Request({
        "type": "http",
        "method": method,
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [(k.lower().encode(), v.encode()) for k, v in (*headers.items(), *extra)],
        "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", 8767),
        "scheme": "http",
    })


def _run(request: Request):
    forwarded: list[str] = []

    async def fake_forward(req):
        forwarded.append(req.method)
        return "forwarded"

    async def call_next(_req):
        return "local"

    with patch.object(_proxy, "proxying", return_value=True), patch.object(_proxy, "_forward", fake_forward):
        result = asyncio.run(_proxy.data_proxy_middleware(request, call_next))
    return result, forwarded


APP = {"Host": "127.0.0.1:8767", "Origin": "http://127.0.0.1:8767", "Sec-Fetch-Site": "same-origin",
       "Referer": "http://127.0.0.1:8767/"}


class CrossSiteWriteIsNotRelayed(unittest.TestCase):
    def assert_blocked(self, headers: dict[str, str], method: str = "POST"):
        result, forwarded = _run(_request(method, headers))
        self.assertEqual(forwarded, [], f"중계됐다: {headers}")
        self.assertEqual(result.status_code, 403)
        self.assertIn("다른 사이트", json.loads(result.body)["detail"])

    def assert_relayed(self, headers: dict[str, str], method: str = "POST"):
        result, forwarded = _run(_request(method, headers))
        self.assertEqual((result, forwarded), ("forwarded", [method]), f"막혔다: {headers}")

    def test_foreign_page_post_is_blocked(self):
        self.assert_blocked({"Host": "127.0.0.1:8767", "Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"})

    def test_each_browser_signal_alone_blocks(self):
        self.assert_blocked({"Host": "127.0.0.1:8767", "Sec-Fetch-Site": "cross-site"})
        self.assert_blocked({"Host": "127.0.0.1:8767", "Origin": "https://evil.example"})
        self.assert_blocked({"Host": "127.0.0.1:8767", "Origin": "null"})  # 샌드박스 iframe·file://
        self.assert_blocked({"Host": "127.0.0.1:8767", "Referer": "https://evil.example/page"})
        self.assert_blocked({"Host": "evil.example:8767", "Origin": "http://evil.example:8767"})  # DNS 리바인딩

    def test_duplicate_browser_headers_are_blocked(self):
        # 빈 값 + 정상 값처럼 두 줄로 온 헤더는 정상 브라우저가 만들지 않는다 — 빈 줄을 걸러 한 줄로 보지 않는다(Codex)
        for extra in ((("Origin", ""), ("Origin", "http://127.0.0.1:8767")),
                      (("Sec-Fetch-Site", "same-origin"), ("Sec-Fetch-Site", "same-origin"))):
            result, forwarded = _run(_request("POST", {"Host": "127.0.0.1:8767"}, extra=extra))
            self.assertEqual((result.status_code, forwarded), (403, []), extra)

    def test_other_write_methods_are_checked_too(self):
        for method in ("PUT", "PATCH", "DELETE"):
            self.assert_blocked({"Host": "127.0.0.1:8767", "Origin": "https://evil.example"}, method)

    def test_app_window_and_local_clients_are_relayed(self):
        self.assert_relayed(APP)
        self.assert_relayed({**APP, "Host": "localhost:8767", "Origin": "http://localhost:8767"})
        self.assert_relayed({"Host": "127.0.0.1:8767"})  # 에이전트·Resolve·urllib — 브라우저 헤더 없음
        # 이 PC 의 다른 포트(ComfyUI 화면 등) — same-site·loopback
        self.assert_relayed({"Host": "127.0.0.1:8767", "Origin": "http://127.0.0.1:8188", "Sec-Fetch-Site": "same-site"})

    def test_reads_are_not_checked(self):
        # 읽기는 다른 사이트가 응답을 못 읽는다(CORS) — 막으면 정상 동작만 깨질 수 있어 건드리지 않는다
        self.assert_relayed({"Host": "127.0.0.1:8767", "Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"}, "GET")

    def test_local_paths_are_untouched(self):
        result, forwarded = _run(_request("POST", {"Host": "127.0.0.1:8767", "Origin": "https://evil.example"},
                                          path="/api/auth/config"))
        self.assertEqual((result, forwarded), ("local", []))  # 로컬 경로는 각 라우트의 검사를 따른다


if __name__ == "__main__":
    unittest.main()
