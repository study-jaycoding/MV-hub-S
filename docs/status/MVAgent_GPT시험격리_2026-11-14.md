---
status: active
updated: 2026-11-14
---

# MV Agent GPT 잠금 풀기 후속 — 시험이 PC 폴더 구조를 읽지 않게 (2026-11-14)

owner: Claude · reviewer: dev 묶음 검토 때(Jay 결정) · status: 완료(dev 커밋) · updated: 2026-11-14

## 1. 요청과 사실
- work 세션(local_fca53044) 11-14 10:36: GPT 잠금 풀기(`6b2a9414`) 뒤 `backend/tests/test_agent_chat_restore.py` 가 17 failed / 12 passed(고정 사본 `ad9ed419`·dev 작업 트리 둘 다). 시험은 엔진 {claude, codex} 를 기대하는데 claude 만 나옴. 'A 활성화 전 정리' 회귀 목록이라 막혀 있음.
- 재현(직접): 시험 임시 폴더를 Git 저장소 안으로 주면(`--basetemp <git init 한 폴더>\…`) **정확히 17 failed / 12 passed**, `%TEMP%` 면 29 통과.
- 원인: 설계 2-1 의 작업 폴더 검사(`agent_chat_codex.work_problem` — 작업 폴더나 **위 폴더에 `.git`** 이 있으면 Codex 잠금)가 시험 준비 코드에서도 실제 폴더 구조를 읽는다. `D:\ClaudeCode` 자체가 Git 저장소라 그 아래 임시 폴더(예: `work\sq`)면 늘 잠긴다. 제품 동작은 설계대로(독립 리뷰 P3-④에 적힌 한계) — 고칠 것은 시험의 격리.

## 2. 고치는 법(시험만)
- Codex 를 켜 둔 채 다른 것을 시험하는 준비 코드(`test_agent_chat_api.hub`·`test_agent_chat_runtime.runtime`·`test_agent_chat_codex_unlock.isolated` 등)는 `work_problem` 을 None 으로 바꿔 실제 위 폴더를 보지 않게 한다.
- 작업 폴더 검사 자체를 보는 시험(`test_work_instructions_block_enable_and_turn`)만 실제 함수를 되돌려 쓴다.
- 제품 코드는 바꾸지 않는다.

## 3. 시험
- 고치기 전: 임시 폴더를 Git 저장소 안으로 주면 MV Agent 시험 `test_agent_chat*.py` 100 failed / 216 passed(restore 17·manage 16·fork 11·screen_actions 11 등 — 대부분 `hub` 준비 코드를 빌려 씀).
- 고친 뒤(시험 기록, 같은 지문): `%TEMP%` = 316 passed(`ac390bc3`) · Git 저장소 안 `--basetemp` = 316 passed(`34e34a17`).
- 바꾼 곳: `test_agent_chat_api.hub`·`test_agent_chat_runtime.runtime`·`test_engine_problem_checks_login_kind`·`test_agent_chat_codex_unlock.isolated` 에 `work_problem` → None, `test_work_instructions_block_enable_and_turn` 만 실제 함수(`REAL_WORK_PROBLEM`).

```vibe-intent
{
  "schema": 1,
  "id": "mvagent-codex-test-isolation-2026-11-14",
  "root": "D:/ClaudeCode/MV-hub-S-dev",
  "owner": {"host": "claude", "session": "4e253e69-1c8b-4f92-80da-34b2f50ce3c0"},
  "risk": {"level": "minor", "reason": "시험 준비 코드만 — 제품 코드 변경 없음"},
  "goal": "MV Agent 시험이 PC 의 폴더 구조(위 폴더 .git)와 무관하게 돌게 한다",
  "touched_paths": ["backend/tests/test_agent_chat_api.py", "backend/tests/test_agent_chat_runtime.py", "backend/tests/test_agent_chat_codex_unlock.py"],
  "criteria": [
    {"id": "tests", "success": "MV Agent 시험이 %TEMP% 와 Git 저장소 안 임시 폴더 두 곳에서 모두 통과", "failure": "어느 한 곳에서 실패", "required": true, "verification": ["ac390bc3bf3642cea506d95bf50d3a21", "34e34a17d4bf408ebdc300ce4259ccc9"]}
  ],
  "references": [],
  "decisions": [
    {"choice": "시험 준비 코드에서 work_problem 을 끄고, 작업 폴더 검사 시험만 실제 함수를 쓴다", "why": "제품 규칙(위 폴더 .git 이면 잠금)은 설계대로이고 시험만 실제 폴더를 읽어 환경에 따라 깨졌다", "alternative": "제품의 위 폴더 검사를 좁히기", "revisit": "작업 폴더 검사 규칙을 바꿀 때"}
  ],
  "evidence": {"target": {"kind": "worktree"}}
}
```
