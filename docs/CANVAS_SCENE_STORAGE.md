---
updated: 2026-10-07
status: active
---

# 캔버스 씬 저장 계약 (IndexedDB)

기준일: 2026-10-07 · 구현 기준: `feature/scene-save-contract`

작업 기록 — owner: Claude(설계·구현·실측) · reviewer: Codex(구현 계획 검토·적대 코드 리뷰 3회, 마지막 판정 `승인`) ·
status: `검증 중`(코드·시험·실측 완료, 배포 전) · touched_paths: `frontend/src/lib/scene*.ts`,
`frontend/src/lib/useSceneCoordination.ts`, `frontend/src/main.tsx`, `frontend/src/App.tsx`,
`frontend/src/components/scene/SceneBoard.tsx`·`SceneBar.tsx`, `frontend/src/components/settings/CanvasArchiveSection.tsx`

## 왜 바꿨나

캔버스 씬(카드·연결·그룹)은 브라우저 `localStorage` 한 키(`ch.scenes`)에 통째로 들어 있었다. 출처당 한도가
약 500만 글자라 큰 씬이 쌓이면 찼고, 찬 뒤에는 **편집이 조용히 되돌아갔다** — "레퍼런스를 생성 카드에
연결해도 선이 사라진다"는 신고(2026-10-07)의 원인이다. 실측으로 재현했다: 꽉 찬 상태에서 연결선 하나를
더하는 저장이 `QuotaExceededError` 로 실패한다.

그래서 ① 저장 자리를 IndexedDB 로 옮기고 ② 저장이 안 될 때 화면을 되돌리지 않고 알리며 ③ 옛 자료는
사용자 조작 없이 전부 옮긴다(Jay 요구: "지금 찬 것을 큰 데로 옮기고 똑같이 쓸 수 있어야 한다").

## 구조 — 화면 값은 그 자리에서, 확정은 뒤따라

| 이름 | 뜻 |
|---|---|
| 확정본(`confirmed`) | IndexedDB 에 실제로 들어 있는 내용 |
| 밀린 연산(`pending`) | 아직 확정 안 된 내 편집(연산 목록) |
| 화면 값(`working`) | 확정본 + 밀린 연산. **앱이 읽고 쓰는 값** |

쓰기는 화면 값에 동기로 반영되고(`applySceneOp`), 저장은 한 트랜잭션에서 **저장소의 최신 내용을 읽어 그
위에 밀린 연산을 차례로 다시 실행**한 뒤 쓴다(`runStoreTx`). 그래서 늦게 끝난 저장이 그사이의 새 편집을
덮지 않고, 다른 창이 그사이 한 변경도 덮지 않는다. IndexedDB 는 다른 창에 신호를 보내지 않으므로
확정할 때마다 `BroadcastChannel("mvhub-scenes")` 로 알리고, 받은 창은 다시 읽어 화면 값을 다시 계산한다.

저장 자리: DB `mvhub-scenes`, 키는 씬 전체 맵·버전·흡수 기준·이관 세대·충돌 목록. 버킷 키는
`<계정 네임스페이스>::_none`(`scenes.ts` 의 `keyOf`).

### 지키는 규칙(Codex 와 합의 — 깨지면 자료를 잃는다)

1. 동기 반환의 성공은 "화면 값에 반영됨"이다. 저장소 확정과 구분한다.
2. 연산은 순수하다 — id·시각·계정 키·입력은 접수 때 고정하고, 버킷은 새 배열로 갈아 끼운다(재생해도 같은 결과).
3. 한 연산은 확정에 한 번만 들어간다(트랜잭션이 잡은 묶음만 뺀다).
4. 화면 값 = 확정본 + 밀린 연산. 재생에서 던진 연산은 버리되 화면 값에서도 걷어내고 그 작업에 실패로 알린다.
5. 저장·옛 저장소 흡수·다른 창 재조회·충돌 정리·전체 가져오기는 한 줄로 차례대로 돈다.
6. 내구성이 필요한 흐름은 **그 작업의 확정 결과**(`confirmSceneWrite`)와 **확정본에 실제로 들어갔는지**를 함께
   본다 — 생성 제출 전 표식(`App.prepareCanvasGenerationBatch`), 자산 재연결 판정 기억(`sceneAssetRelink.applyFound`),
   DB 백업 복구 보고(`sceneBackup`).
7. 밀린 연산은 끝없이 늘지 않는다. 같은 씬을 잇달아 고치는 연산은 하나로 합치고(`merge` — 인접하고 아직 저장으로
   떠나지 않은 것만), 상한(200)에 닿으면 새 연산을 **거절하고 알린다**. 쌓인 연산을 "지금 내 버킷 통째"로 뭉쳐
   줄이지 않는다 — 재생될 때 다른 창이 확정한 변경을 지운다.
8. DB 미러·복구 판정·계정 귀속은 확정본 기준이다(`listPersistedScenes`·`hasPersistedSceneBucket`). 옛 계정 없는
   버킷(`_none`)의 귀속은 확정된 뒤에만 화면에 보인다.

## 옛 저장소에서 옮기기

- 앱(메인 화면)은 `bootSceneStore()` 가 끝난 뒤에 뜬다. 분리 창(Assets·관리)은 씬을 쓰지 않아 기다리지 않는다.
- **옛 `localStorage` 는 지우지 않는다.** 업데이트가 열려 있는 캔버스 창을 닫아 주지 않아, 옛 판 창이 계속 거기에
  쓰기 때문이다. 대신 그 변경을 흡수한다(`sceneAbsorb.planAbsorption` — 지난번 본 옛 내용·지금 새 내용·지금 옛
  내용을 견준다. 시각은 쓰지 않는다).
- 이관 표식(`pending`/`committed` + 세대)은 `localStorage` 와 **쿠키** 두 곳에 적는다. 꽉 찬 PC 에서는
  `localStorage` 에 표식 한 줄도 못 쓰기 때문이다.
- 표식이 `committed` 인데 IndexedDB 가 비었으면(사이트 데이터 삭제 등) 옛 내용을 되살리지 않고 빈 상태로 연다 —
  로컬 허브 DB 백업 복구(`sceneBackup`)가 맡는다.
- 저장소를 못 열면 빈 화면으로 진행하지 않고 오류 화면에 머문다(다시 시도 + 옛 자료 원문 내려받기).

## 사용자에게 보이는 것

- **저장이 안 될 때**: 편집은 화면에 남고 저장소가 간격을 늘려 가며 다시 시도한다. 그동안 탭 줄 오른쪽에
  `⚠ 저장 안 됨 — 눌러서 파일로 내려받기` 가 계속 떠 있다(알림 한 줄은 다른 알림에 덮인다).
- **옛 판 창과 같은 씬을 각자 고쳤을 때**: 묻지 않고 옛 창 쪽 내용을 `[옛 창] 이름` 탭으로 살린다(둘 다 남는다).
  같은 씬이 또 엇갈리면 손대지 않은 사본 탭을 최신으로 갈아 끼운다(탭이 끝없이 늘지 않게).
- **설정 → 캔버스 자료**: `전체 내보내기`(아직 확정 안 된 편집까지 싣는다) / `전체 가져오기`(덮지 않는다 — 없는
  씬만 더하고, 같은 씬인데 내용이 다르면 `[사본] 이름` 탭으로 따로 둔다. 같은 파일을 두 번 가져와도 또 생기지 않는다).
  파일 형식 `mvhub-scenes-full` v1. 밖에서 온 씬은 `scenes.readStoredScene` 관문에서 필드·배열 원소까지 모양을 본다.
- 입력 저장은 400ms 디바운스에 **최대 대기 2초**(계속 쳐도 2초 안에 한 번 내보낸다), 창이 가려질 때 바로 내보낸다.
  강제 종료에서는 마지막 몇 초가 남지 않을 수 있다(종전 `localStorage` 는 동기라 이 틈이 더 작았다 — 알려진 한계).

## 검증

- 자동 시험: `frontend/tests/sceneStoreOps.test.ts`(연산 재생·합치기·상한), `sceneStore.test.ts`(이관 표식·충돌 보존),
  `sceneAbsorb.test.ts`, `sceneArchive.test.ts`(내보내기·가져오기·충돌 복구), `sceneSaveStateRender.test.tsx`(실제 훅·탭 줄),
  `sceneInputPersist.test.tsx`(실제 SceneBoard), `sceneUpdateReturn.test.ts`.
- 브라우저 실측(진짜 Chrome·실제 IndexedDB): `frontend/measure/storeProbe.ts` 를 `npx vite build --config
  measure/vite.probe.config.ts` 로 빌드해 `measure-dist` 를 띄우고 `tools/browser_measure/cdp.py` 로 연다. 같은 출처의
  iframe 이 '다른 창' 노릇을 한다.

2026-10-07 실측값(이 PC, 씬 하나 약 15만 글자):

| 항목 | 결과 |
|---|---|
| 옛 저장소가 한 줄도 못 쓰게 꽉 찬 상태(씬 104개)에서 켜기 | 104/104 옮김 · 약 1.7초(한 번뿐) · 표식은 쿠키에만 남음 |
| 그 상태에서 새 씬·편집 | 저장됨 |
| 편집 1회의 화면 멈춤(같은 크기) | 종전 약 57ms → 지금 약 30ms |
| 옛 한도의 3배(씬 305개, 약 1,450만 글자) | 저장됨 · 편집 1회 화면 멈춤 약 80ms |
| 두 창이 같은 순간에 서로 다른 것을 고침 | 둘 다 남고 양쪽 화면에 반영 |
| 다시 켜기 | 약 230ms · 내용 동일 |
| 옛 판 창의 쓰기 | 안 건드린 씬은 가져옴 · 엇갈린 씬은 `[옛 창]` 탭으로 |
| 전체 내보내기(약 44MB) / 같은 파일 다시 가져오기 | 약 70ms / 중복 0 |

## 남은 것

- 저장할 때마다 씬 전체 맵을 통째로 쓴다 — 편집 1회의 화면 멈춤이 전체 크기에 비례한다(위 표). 지금 크기에서는
  종전보다 빠르지만, 수십 MB 로 커지면 씬별 키로 쪼개야 한다.
- 서버 쪽 `scene_backup` 은 여전히 조건 없이 덮는다(씬당 5MB 제한). 조건부 갱신·삭제 표식은 후속.
- `ComfyCard` 가 `genData[genId]` 를 자기 속성인지 확인하지 않고 읽는다(`genId: "toString"` 같은 값에서 예외) —
  이번 변경 이전부터 있던 것으로 Codex 가 P2 로 보고. 미수정.
