"""생성 호출이 과금 공간을 **자기 봉투에** 박는지 — 전역 선택이 흔들려도 바뀌지 않는다.

배경(Jay 2026-09-11): 힉스필드 CLI 의 워크스페이스 선택은 **전역 상태 한 개**다. 에이전트가 그것을
확인한 뒤 `generate create` 가 실제로 나가기까지의 틈에 허브가 `workspace set` 을 끼워 넣으면, 요청은
B 인데 과금은 A 로 간다. 에이전트의 `workspace_lock` 은 제 프로세스 안 잠금이라 허브는 참여하지 않는다.

★실측으로 확인한 것(CLI 1.1.24, 모델 `nano_banana_2_lite`): `HIGGSFIELD_WORKSPACE_ID` 를 주면
 **전역 선택과 무관하게** 그 공간에서 과금된다. 전역=뻘뻘뻘 / env=R&D 로 1건 만들었더니 R&D 에서만
 1크레딧이 빠지고(5867.48 → 5866.48) 뻘뻘뻘 잔액·거래 내역은 그대로였다. 잡 조회(`generate get`·
 `generate list`)는 공간별이 아니라 계정 단위여서 그대로 두면 된다.

★확인 범위: **정식 `MV_agent` 런처 + CLI 1.1.24** 까지다. 런처는 핀(`hf_cli_version.txt`)과 정확히
 일치하는 CLI 만 에이전트에 넘기고(`:try_cli`), 못 잡으면 `RUN_AGENT=0` 이다.
 ★남는 경계(이번 범위 밖): ①`python agent_push.py` 직접 실행 ②서버가 내려주는 설치용 bat 은 핀을 설치한
  뒤 **실제로 실행될 CLI 버전을 다시 검사하지 않는다**(PATH 앞에 다른 버전이 남으면 그대로 돈다).
 ★핀을 올릴 때는 이 계약(env 가 create 의 과금 공간을 정한다)을 반드시 다시 확인해야 한다.
 CLI 를 바꾸면 에이전트를 재시작해야 한다(버전은 프로세스 수명 캐시).
"""

from __future__ import annotations

import json
import os
import unittest
from unittest.mock import patch

from test_agent_contracts import _load_agent


WS = [
    {"id": "ws-b", "name": "뻘뻘뻘", "is_selected": True},
    {"id": "ws-c", "name": "R&D", "is_selected": False},
]


def _request(workspace: dict) -> dict:
    return {
        "id": "request-1",
        "model": "nano-banana",
        "prompt": "test prompt",
        "params": {},
        "references": [],
        "workspace": workspace,
        "claim_phase": "claimed",
    }


# `_extract_created_id` 는 UUID 모양만 잡 id 로 받는다 — 실측 응답도 ["<uuid>"] 배열이다.
JOB_ID = "12345678-1234-1234-1234-123456789abc"


class _FakeCompleted:
    def __init__(self, stdout: str = '["%s"]' % JOB_ID):
        self.returncode = 0
        self.stdout = stdout
        self.stderr = ""


def _submit_capturing_child_env(agent, request, workspaces, *, on_begin=None):
    """실제 `_submit_one` → 실제 `_run_cli_json` → 가짜 `subprocess.run` 까지 태우고,
    **생성 자식에게 실제로 넘어간 env** 를 돌려준다.

    ★여기가 핵심이다. 시험이 직접 env 를 조립해 가짜 래퍼에 넘기면, 제품 코드에서 env 전달을
     통째로 지워도 시험이 통과한다(코덱스가 메모리 재현으로 잡아냈다). 그래서 제품 경로를 그대로 탄다.
    """
    seen: list[dict] = []

    def fake_subprocess_run(cmd, **kwargs):
        seen.append({"cmd": list(cmd), "env": kwargs.get("env")})
        if "create" in cmd:
            return _FakeCompleted()
        return _FakeCompleted(json.dumps(workspaces))

    def begin(*args, **kwargs):
        if on_begin is not None:
            on_begin()  # 허브가 그 사이 전역을 바꾸는 순간
        return True

    with patch.object(agent, "_allowed_params", return_value=set()), patch.object(
        agent, "_begin_submission", side_effect=begin
    ), patch.object(agent, "_run_cli_command", return_value=None), patch.object(
        agent, "_outbox_add"
    ), patch.object(agent, "_anchor_with_retry", return_value=True), patch.object(
        agent.subprocess, "run", side_effect=fake_subprocess_run
    ):
        result = agent._submit_one(
            "http://hub", "token-1", "hf", "user@example.com", request,
            {}, {}, agent.Lock(), agent.Lock(), "agent-1",
        )
    create = [c for c in seen if "create" in c["cmd"]]
    return result, create


class CreateEnvPinTests(unittest.TestCase):
    def test_create_carries_the_verified_workspace_even_if_the_global_selection_moves(self):
        """★핵심 계약 — 검증 뒤 허브가 전역을 바꿔도 생성 봉투의 공간은 검증한 그 값이다.

        `_begin_submission` 이 도는 사이(실측상 여기가 가장 긴 구간이다) 허브가 `workspace set` 으로
        전역을 ws-b 로 되돌린 상황을 흉내 낸다. 옛 구현은 전역에만 기대서 ws-b 로 과금됐다.
        """
        agent = _load_agent()
        live = [
            {"id": "ws-b", "name": "뻘뻘뻘", "is_selected": False},
            {"id": "ws-c", "name": "R&D", "is_selected": True},
        ]

        def hub_switches_away():
            live[0]["is_selected"] = True
            live[1]["is_selected"] = False

        result, create = _submit_capturing_child_env(
            agent,
            _request({"scope": "team", "id": "ws-c", "name": "R&D"}),
            live,
            on_begin=hub_switches_away,
        )

        self.assertEqual(result["job_id"], JOB_ID)
        self.assertEqual(len(create), 1)
        # 전역은 ws-b 로 넘어갔는데 봉투는 ws-c 다 — 이게 이 변경의 전부다.
        self.assertEqual(create[0]["env"]["HIGGSFIELD_WORKSPACE_ID"], "ws-c")

    def test_personal_workspace_is_pinned_by_its_real_id(self):
        """요청·DB 계약은 personal/id:null 그대로지만, CLI 봉투에는 **실제 id** 가 박힌다."""
        agent = _load_agent()
        live = [
            {"id": "personal-1", "name": None, "is_selected": True},
            {"id": "ws-c", "name": "R&D", "is_selected": False},
        ]
        _result, create = _submit_capturing_child_env(
            agent, _request({"scope": "personal", "id": None, "name": None}), live
        )
        self.assertEqual(create[0]["env"]["HIGGSFIELD_WORKSPACE_ID"], "personal-1")

    def test_the_child_env_does_not_leak_into_the_parent_process(self):
        """★부모 os.environ 을 바꾸면 동시에 도는 다른 요청이 그 공간으로 과금된다."""
        agent = _load_agent()
        before = os.environ.get("HIGGSFIELD_WORKSPACE_ID")
        live = [{"id": "ws-c", "name": "R&D", "is_selected": True}]
        _result, create = _submit_capturing_child_env(
            agent, _request({"scope": "team", "id": "ws-c", "name": "R&D"}), live
        )
        self.assertEqual(create[0]["env"]["HIGGSFIELD_WORKSPACE_ID"], "ws-c")
        self.assertEqual(os.environ.get("HIGGSFIELD_WORKSPACE_ID"), before)

    def test_a_stale_parent_value_is_overwritten_by_this_request(self):
        """부모에 옛 값이 남아 있어도 이번 요청의 공간이 이긴다."""
        agent = _load_agent()
        live = [{"id": "ws-c", "name": "R&D", "is_selected": True}]
        with patch.dict(os.environ, {"HIGGSFIELD_WORKSPACE_ID": "ws-stale"}):
            _result, create = _submit_capturing_child_env(
                agent, _request({"scope": "team", "id": "ws-c", "name": "R&D"}), live
            )
        self.assertEqual(create[0]["env"]["HIGGSFIELD_WORKSPACE_ID"], "ws-c")

    def test_two_requests_get_independent_child_envs(self):
        agent = _load_agent()
        pair = [
            ({"id": "ws-b", "name": "뻘뻘뻘", "is_selected": True}, "ws-b"),
            ({"id": "ws-c", "name": "R&D", "is_selected": True}, "ws-c"),
        ]
        seen = []
        for row, expected in pair:
            _result, create = _submit_capturing_child_env(
                agent, _request({"scope": "team", "id": row["id"], "name": row["name"]}), [row]
            )
            seen.append(create[0]["env"]["HIGGSFIELD_WORKSPACE_ID"])
            self.assertEqual(seen[-1], expected)
        self.assertEqual(seen, ["ws-b", "ws-c"])

    def test_a_request_without_a_resolvable_workspace_never_reaches_create(self):
        """★박을 공간을 못 정하면 **생성 자체를 안 한다** — 전역을 추측해 쓰지 않는다."""
        agent = _load_agent()
        live = [{"id": "ws-b", "name": "뻘뻘뻘", "is_selected": True}]
        with patch.object(agent, "_fail") as failed:
            result, create = _submit_capturing_child_env(
                agent, _request({"scope": "team", "id": "ws-gone", "name": "없음"}), live
            )
        self.assertIsNone(result)
        self.assertEqual(create, [])  # generate create 가 아예 안 나갔다
        failed.assert_called_once()


class RunnerEnvIsolationTests(unittest.TestCase):
    """래퍼가 env 를 자식에게만 넘기고, 안 주면 종전대로 부모를 상속하는지."""

    def test_ordinary_calls_still_inherit_the_parent_environment(self):
        """★목록·조회에는 override 를 붙이지 않는다 — 잡 조회는 공간별이 아니다(실측)."""
        agent = _load_agent()
        seen: dict = {}

        def fake_run(cmd, **kwargs):
            seen.update(kwargs)
            return _FakeCompleted("[]")

        with patch.object(agent.subprocess, "run", side_effect=fake_run):
            agent._run_cli_json("hf", "workspace", "list")

        self.assertIsNone(seen["env"])  # None = 부모 환경 상속(종전 동작)


class RefusalTests(unittest.TestCase):
    """해석 단계의 거부 — 위 _submit_one 시험과 짝이다."""

    def test_unknown_workspace_yields_no_id(self):
        agent = _load_agent()
        with patch.object(agent, "_run_cli_json") as read, patch.object(agent, "_run_cli_command"):
            resolved, error = agent._ensure_request_workspace("hf", None)
        self.assertIsNone(resolved)
        self.assertIn("워크스페이스 정보가 없습니다", str(error))
        read.assert_not_called()

    def test_missing_workspace_yields_no_id(self):
        agent = _load_agent()
        with patch.object(agent, "_run_cli_json", return_value=(WS, None)):
            resolved, error = agent._ensure_request_workspace(
                "hf", {"scope": "team", "id": "ws-gone", "name": "없음"}
            )
        self.assertIsNone(resolved)
        self.assertIn("찾을 수 없습니다", str(error))

    def test_failed_verification_yields_no_id(self):
        agent = _load_agent()
        not_applied = [
            {"id": "ws-b", "name": "뻘뻘뻘", "is_selected": True},
            {"id": "ws-c", "name": "R&D", "is_selected": False},
        ]
        with patch.object(
            agent, "_run_cli_json", side_effect=[(not_applied, None), (not_applied, None)]
        ), patch.object(agent, "_run_cli_command", return_value=None):
            resolved, error = agent._ensure_request_workspace(
                "hf", {"scope": "team", "id": "ws-c", "name": "R&D"}
            )
        self.assertIsNone(resolved)
        self.assertIn("검증에 실패", str(error))

    def test_a_resolved_id_is_never_empty(self):
        """빈 문자열이 나오면 호출부의 `if not workspace_id` 가 생성을 막아야 한다."""
        agent = _load_agent()
        blank = [{"id": "", "name": None, "is_selected": True}]
        with patch.object(agent, "_run_cli_json", return_value=(blank, None)):
            resolved, error = agent._ensure_request_workspace(
                "hf", {"scope": "personal", "id": None, "name": None}
            )
        self.assertIsNone(resolved)
        self.assertIn("찾을 수 없습니다", str(error))


if __name__ == "__main__":
    unittest.main()
