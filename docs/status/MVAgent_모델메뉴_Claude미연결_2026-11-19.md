---
status: active
updated: 2026-11-19
---

# MV Agent [모델 ⌄] 메뉴 — Claude 도 '미연결' 한 단어 (2026-11-19)

## 요청

Jay 11-19(그림 1 — 모델 메뉴의 Claude·ChatGPT 줄): "클로드 연결 안되어있을때 밑에 gpt처럼 미연결로 나오게 해야한다."

## 원인

`frontend/src/components/agent-chat/AgentPanel.tsx` `ModelMenu` 회사 줄은 못 쓰는 회사에 노란 알약을 붙인다.
11-16 결정(시안 A)으로 ChatGPT 만 '미연결' 한 단어가 됐고, Claude 는 엔진의 긴 까닭(`e.reason`)을 그대로 보였다.
긴 까닭은 이름을 덮던 문제가 있어 ChatGPT 를 한 단어로 바꾼 것이다.

## 고침

- 두 회사 모두 '미연결' 한 단어로 보인다.
- 까닭 문구는 설정 > 연결 쪽에 그대로 있다(11-16 결정과 같은 방식).
- 시험 `agentChatPanel.test.tsx` 모델 칩 시험에 Claude 를 못 쓸 때 '미연결' 이 보이는지 대조를 더했다.

## 범위 밖 (같은 요청의 다른 부분)

연결 안 된 PC 에서 [연결]을 누르면 Claude Code·Codex 를 설치까지 하고 연결하는 흐름은 따로 설계한다.

```vibe-intent
{
  "schema": 1,
  "id": "mvagent-model-menu-claude-unlinked-20261119",
  "root": "D:/ClaudeCode/MV-hub-S-dev",
  "owner": {"host": "claude", "session": "46356923-b93c-41d7-8cae-e4f4ac5ae43a"},
  "risk": {"level": "minor", "reason": "메뉴 알약 글자 하나 — 연결 판정·모델 선택·대화 경로는 그대로다."},
  "goal": "MV Agent [모델 ⌄] 메뉴에서 못 쓰는 Claude 줄도 ChatGPT 처럼 '미연결' 한 단어로 보인다(긴 까닭 대신).",
  "touched_paths": [
    "frontend/src/components/agent-chat/AgentPanel.tsx",
    "frontend/tests/agentChatPanel.test.tsx"
  ],
  "criteria": [
    {
      "id": "frontend",
      "success": "agentChatPanel 시험(Claude 못 쓸 때 '미연결' 대조 포함)·agentChatConnect 시험 통과",
      "failure": "실패",
      "required": true,
      "verification": ["072cb51464c343e8b8eaf4a91423adb4"]
    }
  ],
  "decisions": [
    {
      "choice": "Claude 도 '미연결' 한 단어",
      "why": "Jay 11-19 요청 · 11-16 ChatGPT 결정(긴 까닭이 이름을 덮음)과 같은 까닭",
      "alternative": "까닭을 줄여 보임 — 까닭마다 길이가 달라 다시 넘친다",
      "revisit": "메뉴에서 바로 고칠 길(연결 단추)을 넣을 때"
    }
  ],
  "evidence": {
    "target": {"kind": "worktree"}
  }
}
```
