---
status: active
updated: 2026-10-30
---

# 캔버스 S 공유 시험 36건 실패 — 없어진 Yes 단추를 찾던 시험 — 2026-10-30

owner: Claude(구현 — 세션 0d796f46) · reviewer: 없음(작은 시험 수정) · status: 완료 · touched_paths: 아래 계약 · updated: 2026-10-30

요청: 커밋된 작업 격리 실측에서 `frontend/tests/sceneShareRefresh.test.tsx` 36건이 실패했다. Jay "고쳐라".

## 원인 (실측)

제품 결함이 아니라 **시험이 옛 화면을 보고 있었다.** S 선택 창(`51d649e8`)에서 Yes/No 를 없앴는데, 이 시험의 공통 준비 함수 `mountAndConfirm` 이 여전히 Yes 단추를 찾는다. 그 커밋 때 관련 시험만 돌리고 전체 시험을 돌리지 않아 놓쳤다.

## 고침

`mountAndConfirm` 두 줄 — Yes 단추 대신 S 선택 창의 [공유] 칸(`.s-pick .review-shared`)을 누른다. 창은 body 로 뜨므로 `document.body` 에서 찾는다. 제품 코드는 고치지 않는다.

```vibe-intent
{
  "schema": 1,
  "id": "scene-share-refresh-test-picker-20261030",
  "root": "D:/ClaudeCode/MV-hub-S-dev",
  "owner": {"host": "claude", "session": "0d796f46-f90e-4d40-ab85-e9c1233bf3bb"},
  "risk": {"level": "minor", "reason": "시험 파일의 공통 준비 함수 두 줄. 제품 코드·DB·공유 동작은 그대로"},
  "goal": "sceneShareRefresh.test.tsx 가 S 선택 창의 실제 흐름(S 를 누르고 [공유] 칸을 누름)을 따르게 해 36건 실패를 없앤다. 제품 코드는 바꾸지 않는다.",
  "touched_paths": [
    "frontend/tests/sceneShareRefresh.test.tsx"
  ],
  "criteria": [
    {
      "id": "behavior",
      "success": "sceneShareRefresh.test.tsx 37건 모두 통과 — S 를 눌러 뜬 창의 [공유] 칸으로 onPublish 가 한 번 불린 뒤 새로 고침 시험들이 그대로 돈다",
      "failure": "하나라도 실패 · 시험을 없애거나 건너뛰어 통과",
      "required": true,
      "verification": ["b2b8ae27a53e47d38d5e71012b7b31d3"]
    }
  ],
  "decisions": [
    {
      "choice": "시험의 Yes 찾기를 .s-pick .review-shared 누르기로 바꾼다",
      "why": "지금 사용자가 누르는 칸이 그것이고, 뒤의 onPublish 한 번 검사를 그대로 살린다",
      "alternative": "Yes 를 되살리는 것은 Jay 확정(누르면 바로 적용)에 어긋난다",
      "revisit": "S 선택 창의 칸 이름이 바뀔 때"
    }
  ],
  "evidence": {"target": {"kind": "worktree"}, "consensus": []}
}
```

## 결과 (2026-10-30)

- `frontend/tests/sceneShareRefresh.test.tsx`: `mountAndConfirm` 두 줄. 제품 코드 변경 없음.
- 시험: 이 파일 통과(시험 기록 `b2b8ae27…`, 사본 측정 37건) · 프런트 전체 5,732건 통과·실패 0(고치기 전 36 실패).
- 다시 그러지 않으려고: 화면 흐름을 바꾼 커밋은 관련 시험만이 아니라 프런트 전체 시험까지 돌린다.
