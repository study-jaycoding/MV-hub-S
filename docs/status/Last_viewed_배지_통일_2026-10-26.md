---
status: active
updated: 2026-10-26
---

# Last viewed 배지 — 모든 탭을 C안(가운데 어두운 칩 + 라임 글자)으로 통일 — 2026-10-26 (Jay 지시)

owner: Claude · reviewer: (Jay 가 검토를 지시할 때 묶음으로 — 화면 모양 한 가지) · status: 완료(dev 커밋 · Jay 화면 확인 남음) · touched_paths: 아래 계약 · updated: 2026-10-26

Jay(워크스페이스 카드·어셋 카드 그림): "워크스페이스나 공유탭이랑 어셋탭이랑 라스트 뷰가 다르게 보이는데 같은 라스트 뷰인데 다르게 표현한 이유가 있나?"
→ 다르게 정한 기록은 없다(코드·git 이력·docs 검색). 생성 탭·캔버스·공유 탭은 `LastViewedBadge`(09-08 확정 — 가운데 흰 글자+눈, 상자 없음),
어셋 탭은 10-21 정리 커밋(`4a5b994b`)에서 따로 들어온 `.asset-last-viewed`(오른쪽 위 라임 글자 알약, 아이콘 없음).
시안 넷(A 지금 · B 라임 글자만 · C 어두운 칩+라임 · D 라임 칩+검은 글자)을 보이고 C 추천 → Jay: "C안으로 모두 적용하자".
09-08 의 '상자 없이 글자+눈만'(힉스필드 방식)을 이 결정이 바꾼다. 가운데·눈 아이콘·호버 때 비켜줌·마지막 확인 카드에서 ▶ 숨김은 그대로.

한 것: `LastViewedBadge` 글자를 `.last-viewed-text` span 으로 · 어셋 탭 네 자리(셀·폴더 카드 컷 띠·표지·표 미리보기)가 그 부품을 쓴다(`.asset-last-viewed` 삭제) ·
어셋 셀·컷·표지 호버 때 비켜줌 · 어셋 셀은 배지가 있으면 ▶ 숨김(`.asset-media:has(...)`) · 작은 칸(컷 띠·표 미리보기)은 글자 감추고 눈만 든 칩.

2차(같은 날 Jay — 칩 그림 둘): "뒤에 검은부분이 밑에 폴더가 있는것과 같은 투명도여야할꺼 같다. 지금은 너무 눈에 띈다." · "아이콘이랑 글이랑 정렬도 안맞다."
→ 칩 바탕·테두리·글자 그림자를 카드 아래 폴더 이름표(`.card-folder`)와 같은 값으로(바탕 68% → `rgba(8,9,12,.34)` + 흰 14% 테두리 + 그림자) ·
정렬은 헤드리스 Chrome 4배 캡처를 픽셀로 쟀다(Segoe UI 13px — Inter 는 이 PC 에 없음): 눈 잉크 가운데 22.38px, 글자 대문자·올림 가운데 22.88 · 소문자 띠 가운데 24.38
→ 글자가 약 1px 낮아 보임. 글자를 1px 올린 뒤 대문자 21.88 · 소문자 23.38 — 눈(22.38)이 그 사이. 실제 썸네일 위 전·후 그림을 보이고 Jay: "바꾼 모양으로 수정".
시험(시험 기록은 계약의 verification): 배지를 보는 시험 다섯 · tsc -b · lint:architecture. 화면 픽셀(:has·호버)은 jsdom 이 못 봐 그림 캡처로만 확인.

```vibe-intent
{
  "schema": 1,
  "id": "last-viewed-badge-unify-20261026",
  "root": "D:/ClaudeCode/MV-hub-S-dev",
  "owner": {"host": "claude", "session": "0c932342-4473-405b-8f54-aa6cf9dfdd75"},
  "risk": {"level": "minor", "reason": "배지의 모양(CSS)과 어셋 탭이 같은 배지 부품을 쓰게 바꾸는 것뿐. 어떤 카드에 배지를 붙일지(기록·저장)는 그대로."},
  "goal": "Last viewed 배지가 모든 탭(생성·공유·캔버스·결과 모아보기·어셋)에서 같은 모양: 카드 가운데 어두운 반투명 칩 + 라임(--accent) 글자 + 눈 아이콘, 마우스를 올리면 비켜줌, 마지막 확인 카드에선 ▶ 숨김. 작은 칸(어셋 폴더 카드의 컷 띠·표 보기 미리보기)은 글자가 안 들어가므로 같은 칩에 눈 아이콘만.",
  "touched_paths": [
    "frontend/src/components/scene/LastViewedBadge.tsx",
    "frontend/src/styles/scene.css",
    "frontend/src/styles/assets.css",
    "frontend/src/components/assets/AssetCell.tsx",
    "frontend/src/components/assets/AssetFolderGrid.tsx",
    "frontend/src/components/assets/AssetFolderTable.tsx",
    "frontend/tests/assetFolderTable.test.tsx",
    "frontend/tests/assetFolderTabs.test.tsx",
    "docs/CODE_MAP.md"
  ],
  "criteria": [
    {
      "id": "same-badge",
      "success": "어셋 탭의 네 자리(셀·폴더 카드 컷 띠·폴더 카드 표지·표 미리보기)가 .asset-last-viewed 대신 LastViewedBadge(.last-viewed-badge)를 쓴다 · 어셋 시험이 그 배지를 찾는다 · .last-viewed-badge 가 어두운 칩+라임 글자 · 어셋 셀·컷·표지 호버 때 비켜줌 · 어셋 셀에서 배지가 있으면 ▶ 숨김 · 작은 칸은 아이콘만",
      "failure": "탭마다 배지 모양이 다름 · 어셋 탭 배지가 사라짐 · 작은 칸에서 글자가 칸 밖으로 넘침",
      "required": true,
      "verification": ["e6ddbb268a2044688dc89a0e28b6a2c7"]
    },
    {
      "id": "regression",
      "success": "배지를 보는 시험(assetFolderTable·assetFolderTabs·resolveSelectionRender·sceneRound7Perf·resolveLibraryUi) · tsc -b · lint:architecture 통과",
      "failure": "기존 Last viewed 표시·대표·Resolve 강조 동작이 깨짐",
      "required": true,
      "verification": ["db2760e9d9944fe6b80160590e7a9249", "0b768ea69a964fd89dbc49c56a274d58", "b3a9f49ed3b044659b7dd57305594baf"]
    }
  ],
  "decisions": [
    {
      "choice": "어셋 탭도 같은 부품(LastViewedBadge)을 쓰고 모양은 scene.css 한 곳에서",
      "why": "모양이 갈린 원인이 따로 만든 표시였다 — 한 부품이면 다시 갈리지 않는다",
      "alternative": "어셋 CSS(.asset-last-viewed)만 같은 값으로 고침",
      "revisit": "어셋 탭만 다른 모양이 필요해지면"
    },
    {
      "choice": "작은 칸(컷 띠 44~54px·표 미리보기 76×39px)은 눈 아이콘만 든 칩",
      "why": "13px 글자 칩은 약 100px 라 칸을 넘는다. 예전 표 미리보기는 8px 글자로 줄였지만 읽기 어려웠다",
      "alternative": "글자를 아주 작게 · 작은 칸엔 배지 없음",
      "revisit": "Jay 가 작은 칸에도 글자를 원하면"
    }
  ],
  "evidence": {"target": {"kind": "worktree"}, "consensus": []}
}
```
