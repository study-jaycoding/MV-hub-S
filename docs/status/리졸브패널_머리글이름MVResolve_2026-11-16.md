---
aliases:
  - 리졸브 패널 머리글 MV Resolve
tags:
  - mvhub
  - mvhub/리졸브
status: active
updated: 2026-11-16
---

# 리졸브 패널 — 머리글 이름 'MV Resolve' (2026-11-16)

> Jay(패널 머리글 'MV Hub 리졸브' 화면을 보이며): "MV Resolve로 이름 바꾸고 회색 리졸브 없애".

owner: Claude(가벼운 일) · reviewer: 없음(글자만 — Jay 지시 '빠르게 고치고 검토는 Jay 지시 때') · status: 구현 중 · touched_paths: 아래 계약 · updated: 2026-11-16

## 바꾸는 것

- 패널 머리줄 왼쪽 굵은 글자 `MV Hub` + 회색 작은 글자 `리졸브` → `MV Resolve` 하나.
- 회색 글자 전용 CSS 한 줄(`.resolve-panel-head > strong span`)은 쓸 곳이 없어지므로 지운다.
- 그대로: 리졸브 미디어 풀의 맨 위 빈 이름 `MV Hub`(코드의 `MEDIA_POOL_ROOT` — 기존 빈과 이어지는 이름), 창 제목 표시줄(리졸브 연동 플러그인 `main.js` 가 정함 — 설치된 플러그인을 다시 깔아야 바뀌어 이번 범위 밖), 안내 문구 속 'MV Hub 창'.

```vibe-intent
{
  "schema": 1,
  "id": "resolve-panel-head-title-mv-resolve-2026-11-16",
  "root": "D:/ClaudeCode/MV-hub-S-dev",
  "owner": {"host": "claude", "session": "f7a93e21-204e-4a3c-805c-28a83855eeea"},
  "risk": {"level": "minor", "reason": "리졸브 패널 머리줄의 보이는 글자 하나와 그 글자 전용 CSS 한 줄 — 동작·API·빈 이름은 그대로"},
  "goal": "ResolvePanelApp 머리줄의 'MV Hub' + 회색 '리졸브' 를 'MV Resolve' 하나로 바꾸고, 쓸 곳이 없어진 회색 글자 CSS 를 지운다. 제외: 미디어 풀 빈 이름 MV Hub·창 제목(플러그인 main.js)·안내 문구.",
  "touched_paths": [
    "frontend/src/components/resolvePanel/ResolvePanelApp.tsx",
    "frontend/src/styles/resolve-panel.css"
  ],
  "criteria": [
    {"id": "build", "success": "프런트 npm run build(타입 검사 포함) 종료 0", "failure": "타입·빌드 오류", "required": true, "verification": ["24e09e77640349fc8cd9aece546f700c"]},
    {"id": "panel-tests", "success": "vitest 의 리졸브 패널 시험(tests/resolvePanelApp.test.tsx·tests/resolvePanelApi.test.ts) 전부 통과", "failure": "기존 시험 실패", "required": true, "verification": ["ad636d5291b84030a9a236cdf74e3ba1"]}
  ],
  "decisions": [
    {"choice": "머리줄 글자만, 미디어 풀 빈 이름 MV Hub 는 그대로", "why": "Jay 가 가리킨 것은 패널 머리글 · 빈 이름을 바꾸면 기존 프로젝트의 빈과 이어지지 않는다", "alternative": "빈 이름·창 제목까지 함께", "revisit": "Jay 가 창 제목·빈 이름도 바꾸라고 할 때"}
  ],
  "evidence": {"target": {"kind": "worktree"}, "consensus": [], "design_sessions": []}
}
```

## 구현·시험

- Claude 가 dev 에서 직접 고침(minor 계약 `ab327cb4`): `ResolvePanelApp.tsx` 머리줄 `<strong>MV Hub <span>{t("리졸브")}</span></strong>` → `<strong>MV Resolve</strong>`, `resolve-panel.css` 의 회색 글자 규칙 한 줄 삭제(이 규칙을 쓰는 곳은 그 span 하나뿐 — 검색 확인). 시험 중 머리글 글자를 확인하는 것은 없음(검색 확인), 번역 사전에 '리졸브' 단독 줄도 없음.
- 시험 기록: panel-tests `ad636d52`(resolvePanelApp·resolvePanelApi) · build `24e09e77`(tsc+vite), 모두 종료 0.
- 화면: 리졸브 안 패널이라 이 세션에서 직접 못 봄 — dev 5173 핫 리로드로 바로 반영(안 바뀌면 패널 새로 고침).
- 같은 때 진행 중인 Codex 작업(정리 한 번에, 계약 `0f586931`)의 touched_paths 와 겹치지 않음(이 두 파일은 그 계약 밖).

## 리뷰

글자만 바꾼 가벼운 일 — 별도 리뷰 없음.
