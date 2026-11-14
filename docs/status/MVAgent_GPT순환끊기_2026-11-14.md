---
status: active
updated: 2026-11-14
---

# MV Agent GPT 잠금 풀기 후속 — agent_chat_codex ↔ agent_chat_process import 순환 끊기 (2026-11-14)

owner: Claude · reviewer: dev 묶음 검토 때(Jay 결정) · status: 완료(dev 커밋 — 전체 시험은 계측 뒤) · updated: 2026-11-14

## 1. 요청과 사실
- work 세션(local_fca53044) 11-14: `backend/tests/test_architecture_boundaries.py::ArchitectureBoundaryTests::test_backend_internal_import_graph_has_no_cycles` 실패 중 하나가 `app.services.agent_chat_codex -> app.services.agent_chat_process` 순환(GPT 잠금 풀기 `6b2a9414` 뒤). 이 검사는 함수 안 import 도 센다.
- 재현(직접): 위 시험 실패, 순환 쌍 `('app.services.agent_chat_codex', 'app.services.agent_chat_process')`.
- 원인: `agent_chat_codex` 가 `agent_chat_process`(판 확인·로그인 확인·명령·Job)를 쓰고, `agent_chat_process.engine_problem` 이 함수 안에서 `agent_chat_codex.state` 를 부른다. 설계 리뷰 P3-c 의 '서로 import 하지 않게' 를 함수 안 import 로 피했는데 경계 검사는 그것도 센다.

## 2. 고치는 법(동작 그대로)
- `agent_chat_process.engine_problem` 을 지운다. 차례 허용 판정은 이미 두 모듈을 다 쓰는 서비스 `agent_chat.engine_problem` 한 곳에서: Claude = `claude.claude_problem`(그대로), Codex = `codex.state(prefix)["reason"]`.
- 그 함수를 직접 부르던 시험(unlock 4곳·runtime 1곳)은 `chat.engine_problem` 으로, connect 시험의 'Claude 판정은 한 곳' 확인은 `process` 에 판정 함수가 없음을 보는 것으로.

## 3. 시험
- 고치기 전: `test_backend_internal_import_graph_has_no_cycles` 실패(`agent_chat_codex -> agent_chat_process`). 고친 뒤: 통과.
- 시험 기록 `4bbf15c9`: 경계 검사 4개 전부 + Codex 잠금 해제·연결 판정·런타임 Codex 판정·API Codex = 48 passed(-k `ArchitectureBoundaryTests or codex or login_kind or chat_allowed`).
- 남은 것: MV Agent 시험 전체(316개)는 GPU 세션 공식 계측이 끝난 뒤에 돌린다(work 세션 요청 — 계측 중 무거운 시험 금지). 옛 기록 `MVAgent_GPT잠금풀기_2026-11-12.md` 2-4 의 '`agent_chat_process.engine_problem` 은 표식 판정을 부른다' 는 이 수정으로 '`agent_chat.engine_problem` 이 부른다' 로 바뀜.

```vibe-intent
{
  "schema": 1,
  "id": "mvagent-codex-import-cycle-2026-11-14",
  "root": "D:/ClaudeCode/MV-hub-S-dev",
  "owner": {"host": "claude", "session": "4e253e69-1c8b-4f92-80da-34b2f50ce3c0"},
  "risk": {"level": "minor", "reason": "판정 함수를 서비스 쪽으로 옮기기만 — 판정 순서·문구는 그대로(agent_chat_codex.state 를 그대로 부름)"},
  "goal": "agent_chat_codex ↔ agent_chat_process import 순환을 끊어 백엔드 경계 검사를 통과시킨다",
  "touched_paths": ["backend/app/services/agent_chat_process.py", "backend/app/services/agent_chat.py", "backend/tests/test_agent_chat_codex_unlock.py", "backend/tests/test_agent_chat_runtime.py", "backend/tests/test_agent_chat_connect.py"],
  "criteria": [
    {"id": "tests", "success": "경계 검사에서 agent_chat_codex↔agent_chat_process 순환이 없고, Codex 잠금 해제·연결·런타임 판정 시험이 통과", "failure": "순환이 남거나 시험 실패", "required": true, "verification": ["4bbf15c9db314e40bd5aed1d6ac779e4"]}
  ],
  "references": [],
  "decisions": [
    {"choice": "process.engine_problem 을 지우고 서비스 agent_chat.engine_problem 에서 codex.state 를 바로 부른다", "why": "서비스가 이미 두 모듈을 다 쓰고 차례 판정의 입구라 새 의존이 생기지 않는다", "alternative": "agent_chat_codex 가 process 를 안 쓰게 주입", "revisit": "판정 입구를 바꿀 때"}
  ],
  "evidence": {"target": {"kind": "worktree"}}
}
```
