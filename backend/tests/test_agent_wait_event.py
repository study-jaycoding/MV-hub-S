"""에이전트 롱폴(`_wait_event`)이 HTTP 오류에서 쉬지 않고 다시 묻지 않는다(2026-11-07 속도 점검 1-4).

허브 활성화 관문이 503(업데이트 전환 중·활성화 기록을 못 읽음)이나 500 을 주면 곧바로 다시 물어도 같다.
쉬지 않으면 대기 바퀴마다 CLI `account status` 와 HTTP 여러 개가 초당 한 번꼴로 돈다. 401 은 재로그인 신호라 바로 돌려준다.
"""

from __future__ import annotations

import io
import unittest
import urllib.error
from unittest.mock import patch

from test_agent_contracts import _load_agent


def _http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("http://127.0.0.1:8010/api/agent/wait", code, "x", {}, io.BytesIO(b""))


class WaitEventBackoffTests(unittest.TestCase):
    def setUp(self):
        self.agent = _load_agent()

    def _wait(self, error: urllib.error.HTTPError):
        with patch.object(self.agent.urllib.request, "urlopen", side_effect=error), \
                patch.object(self.agent.time, "sleep") as sleep:
            result = self.agent._wait_event("http://127.0.0.1:8010", "token")
        return result, sleep

    def test_server_errors_back_off_before_the_next_wait(self):
        for code in (500, 503):
            result, sleep = self._wait(_http_error(code))
            self.assertIsNone(result)
            sleep.assert_called_once_with(3)

    def test_expired_session_returns_reauth_without_sleeping(self):
        result, sleep = self._wait(_http_error(401))
        self.assertEqual(result, "__reauth__")
        sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
