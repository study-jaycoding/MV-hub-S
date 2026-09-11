"""워크스페이스 선택 API 폐기 — 허브는 더 이상 CLI 전역 공간을 바꾸지 않는다.

배경(Jay 2026-09-11): 힉스필드 CLI 의 워크스페이스 선택은 **전역 상태 한 개**이고, 허브와 에이전트가
그것을 나눠 썼다. 그래서 ①전환마다 CLI 왕복 1.4초가 들었고 ②에이전트가 확인한 뒤 제출하기까지의 틈에
허브가 끼어들어 **요청은 B 인데 과금은 A** 로 가는 경합이 있었다.

지금 계약:
· 선택은 **앱이 소유**한다(로컬 저장 + 창 간 storage 동기화). 네트워크를 타지 않아 즉시 바뀐다.
· 목록·잔액은 `GET /api/workspaces` 로 읽는다. `is_selected` 는 **'마지막으로 생성한 공간'** 이지
  '사용자가 고른 공간' 이 아니다 — 앱 선택으로 채택하면 안 된다.
· 생성 시점의 CLI 공간은 에이전트가 요청에 박힌 값으로 맞추고, 그 값을 생성 호출의
  `HIGGSFIELD_WORKSPACE_ID` 로 못 박는다([[test_agent_workspace_env_pin]]).

★왜 200 이 아니라 410 인가: 옛 프론트는 이 응답의 목록에서 `is_selected` 를 읽어 앱 선택으로 채택한다.
 조용히 성공시키면 사용자가 방금 고른 공간이 되돌아가고, 그 뒤 생성 요청이 그 공간으로 **작성된다** —
 봉투 고정은 요청에 적힌 대로 정확히 과금하므로 이 오류를 막아 주지 못한다.
 403 은 옛 씬 코드가 성공으로 취급하므로 폐기 응답으로 쓸 수 없다.
"""

from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException

from app.routers import generation as gen_router


class SelectRouteGoneTests(unittest.TestCase):
    def test_select_is_gone_and_never_touches_the_cli(self):
        request = Mock()
        with patch.object(gen_router.cli_bridge, "set_workspace", AsyncMock()) as set_ws, patch.object(
            gen_router.cli_bridge, "list_workspaces", AsyncMock()
        ) as listed:
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(
                    gen_router.select_workspace(
                        gen_router.WorkspaceSelectIn(workspace_id="ws-b"), request
                    )
                )

        self.assertEqual(caught.exception.status_code, 410)
        self.assertIn("새로고침", caught.exception.detail)
        set_ws.assert_not_awaited()  # ★허브는 CLI 전역을 건드리지 않는다
        listed.assert_not_awaited()

    def test_unselect_is_gone_too(self):
        request = Mock()
        with patch.object(gen_router.cli_bridge, "unset_workspace", AsyncMock()) as unset:
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(gen_router.unselect_workspace(request))

        self.assertEqual(caught.exception.status_code, 410)
        unset.assert_not_awaited()

    def test_the_status_code_is_not_403(self):
        """403 은 옛 씬 코드가 '하우스 계정 아님 = 정상' 으로 읽어 성공 처리한다 — 폐기 신호가 못 된다."""
        request = Mock()
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(
                gen_router.select_workspace(
                    gen_router.WorkspaceSelectIn(workspace_id="ws-b"), request
                )
            )
        self.assertNotEqual(caught.exception.status_code, 403)
        self.assertNotEqual(caught.exception.status_code, 200)


class ListingStillWorksTests(unittest.TestCase):
    """읽기는 그대로다 — 앱은 이 목록으로 이름·잔액·사용 가능 여부를 본다."""

    def test_listing_returns_the_cli_rows(self):
        rows = [
            {"id": "ws-b", "name": "뻘뻘뻘", "is_selected": True, "credits": 10},
            {"id": "ws-c", "name": "R&D", "is_selected": False, "credits": 20},
        ]
        with patch.object(gen_router.cli_bridge, "list_workspaces", AsyncMock(return_value=rows)):
            self.assertEqual(asyncio.run(gen_router.list_workspaces()), rows)


if __name__ == "__main__":
    unittest.main()
