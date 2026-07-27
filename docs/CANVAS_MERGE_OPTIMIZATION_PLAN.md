# 캔버스(씬) 병합 전 리뷰·최적화 설계도

> 목적: dev(→ main 병합 대상, 165커밋/89파일/+12,709−824)의 **캔버스 전 기능**을 팀 서버(다중 사용자) 배포 기준으로 **안전하게** 리뷰·최적화한다.
> 대원칙: **"지금 잘 되는 기능을 안 깨뜨린다."** 클로드 설계·통합 + 코덱스 방향/불변식 검토 공동 작성.
> 상태: **결정 확정(2026-07-27)** — 아래 4개 추천안 그대로 채택. 병합 전 안전 작업 착수.

## 결정 확정 (Jay, 2026-07-27)
1. **씬 저장** = 로컬 유지 + **계정별 네임스페이스**(서버 저장은 후순위 별도 작업).
2. **팀서버 Comfy 권한** = **제한 없음(전부 열기)**. API키가 있으면 누구나 실행/저장/설정 가능, UI 숨김 없음. (Jay 결정 2026-07-27: 팀은 신뢰관계, 키가 사실상 게이트.) → comfy 라우터 권한 변경 안 함.
3. **병합 전 리팩터 범위** = **Phase 0~1(특성화 테스트 + 순수 추출)만**. Phase 2+ 는 병합 후.
4. **E2E 도구** = **미도입**. 수동 스모크 체크리스트 + 순수로직 단위테스트로 대체.

---

## 1. 핵심 판단 — 대형 파일 구조개선은 "병합 후"

`SceneBoard.tsx` = **5684줄, 내부 함수 ~180, 훅 ~93**. 상태·refs·키보드·마우스·paste/drop·Comfy 실행·카드 렌더가 강하게 얽혀 있고 **브라우저 상호작용 테스트가 약함**.

| 시점 | 권고 | 이유 |
|---|---|---|
| 병합 **전** 대형 분해 | ❌ 비권장 | drag/휠/paste/undo/async 회귀 위험 큼, 안전망(테스트) 부족 |
| 병합 **전** 개선 | ✅ 저위험만 | 순수함수 추출·중복 파싱 캐시·**팀서버 보안/권한 점검**·수동 스모크 강화 |
| 병합 **후** 구조개선 | ✅ 권장 | Phase 단위로 작게, 매 단계 **동일 동작** 검증 |

→ **결론:** 병합 전엔 "위험 잡기 + 저위험 최적화"만. 5천 줄 분해는 병합 후 단계별로.

---

## 2. 작업 구분

### A. 병합 전 (안전·필수)
1. **특성화(회귀 방지) 안전망 확보** — 지금 동작을 고정(§5).
2. **팀서버 보안/권한 점검** — 다중 사용자에서만 드러나는 위험(§3-C).
3. **저위험 최적화** — 무동작변경 순수 추출·캐시(§3-A/B 중 저위험).
4. **팀서버 아키텍처 결정** — 씬 저장 범위·Comfy 권한(§4).

### B. 병합 후 (점진 구조개선)
- SceneBoard 책임 분해 로드맵 Phase 2~6(§6).

---

## 3. 크로스커팅 점검·최적화 항목

### A. 정확성 / 불변식 (위험 높음, 병합 전 점검)
| 항목 | 근거/현황 | 방향 |
|---|---|---|
| 늦은 비동기 응답(stale) | Comfy 실행엔 `sceneIdRef` 가드 있음. paste/drop/upload 경로는 추가 확인 필요 | 모든 비동기 시작 시 sceneId·content 캡처, 완료 시 현재와 다르면 카드 상태 미반영 |
| refs 경합 | `cardsRef/edgesRef` 즉시 갱신으로 setState 지연 회피 | 추출 시 이 패턴 보존(‘setState만 신뢰’ 금지) |
| 리스너 누수 | `beginDrag` 등 cleanup 구조 존재 | 훅 분리 시 cleanup 소유권 명확히 유지 |
| 배치 저장 순서 | 순차 await 로 대표=마지막 보장(최근 수정) | 회귀 테스트로 고정 |

### B. 성능 핫스팟 (대부분 저위험, 병합 전 일부 가능)
| 항목 | 근거 | 방향 |
|---|---|---|
| 워크플로 JSON 반복 파싱 | `sceneEdges.ts`의 comfyDeclaredKinds·comfyTextDriveKeys·comfyGenMeta 가 렌더/계산 중 반복 `JSON.parse` | content 문자열 기준 파싱 결과 memo/cache(무동작변경, 저위험) |
| 렌더당 재계산 | groupViews·collapsed·edge role 계산이 큰 씬에서 반복 가능 | `useMemo`/순수 selector 로 이동 |
| N+1 조회 | useSceneGenData 는 개선됨. `getGeneration/history` 는 id별 호출 | (병합 후) batch API 검토 |
| object_info | 백엔드 5분 캐시 있음. 로컬 타깃은 전체(수 MB) 대신 개별조회 여지 | 로컬은 `/object_info/{class}`(작음), 클라우드는 전체 유지 |

### C. 팀서버 보안 / 권한 (위험 높음, 병합 전 필수)
| 항목 | 근거 | 방향 |
|---|---|---|
| AUTH off 원격 차단 | main.py 가 AUTH off 원격 바인딩 차단 | 팀 서버는 `CONTENT_HUB_AUTH=1` 고정(배포 체크리스트) |
| 프록시 경계 | `_proxy.py` 로컬 경로 allow-list | 새 라우터마다 proxy ownership 테스트 필수 |
| 계정 스코프 | `deps.py` account/remap 스코프 | `acct:<email>` fallback·실시간 스코프 정합 유지 |
| SSRF/경로 | net_guard·path_safety 존재. Comfy URL 은 예외적 private 허용 | Comfy 는 net_guard 우회 → **권한으로 막아야 함** |
| **Comfy 팀서버 노출** | `/api/comfy/*`(settings·run·status) | owner/admin/loopback 정책 필요(§4-②) |
| Comfy 저장 권한 | save-to-library 의 `require_project_role(..., read_only=True)` | read_only=True 의도 확인 필요(리뷰 항목) |

---

## 4. 팀서버 아키텍처 — Jay 결정 필요

### ① 씬(캔버스) 저장 범위 ★가장 중요
현재 씬은 **브라우저 localStorage** 저장(개인·PC 로컬).
- **A. 로컬 유지(추천, 최소):** 씬=개인 작업 초안. 단 **계정별 네임스페이스**로 분리(같은 브라우저에서 계정 전환 시 안 섞이게). 서버 저장은 별도 기능으로 후순위.
- **B. 서버 저장(큼):** 계정/프로젝트별 서버 보관·공유. 새 저장소·동기화·권한 설계 필요 = 별도 프로젝트급.
- 👉 추천: **A(로컬+계정 네임스페이스)**. B는 팀 공유 요구가 확실할 때 별도 착수.

### ② 팀서버에서 `/api/comfy/*` 허용 범위
Comfy 는 로컬/클라우드 자원 접근 + 크레딧 소모 → 다중 사용자에 그대로 열면 위험.
- 후보: 비활성 / **owner·admin 만** / loopback 만 / 전체 인증 사용자
- 👉 추천: **owner·admin 제한**(또는 운영자만). 최소 권한.

### ③ 병합 전 허용 리팩터 범위
- 👉 추천: **Phase 0~1(특성화 테스트 + 순수 추출)만**. Phase 2+ 는 병합 후.

### ④ 브라우저 E2E 도구 도입 여부
- 👉 추천: **지금은 도입 안 함.** Playwright 는 무겁다. **수동 스모크 체크리스트 + 순수로직 단위테스트 확대**로 대체. 병합 후 필요 시 검토.

---

## 5. 안전 방법론 — 안 깨뜨리는 절차

### 특성화 테스트(착수 전 확보)
| 구분 | 내용 |
|---|---|
| 프론트 자동 | `cd frontend && npx tsc --noEmit && npx vitest run && npx vite build` |
| 백엔드 자동 | `cd backend && python -m pytest` (CONTENT_HUB_MANAGE=1) |
| 브라우저 수동(스모크) | 씬 생성/전환, 카드 추가/삭제, drag, 휠 줌, 중간버튼 팬, 이미지 paste, asset drop, edge 연결, 그룹/접기, undo/redo |
| Comfy 수동 | 파싱, 시드 무작위, 실행, 배치 실행, 내작업 저장, **실행 중 씬 전환** |
| 팀서버 수동 | AUTH on 로그인, 권한별 조회/수정/삭제, 프록시 경로, WebSocket 스코프, /media, /api/download |

### 검증 게이트(매 단계)
tsc·vitest·pytest·build 통과 + 관련 수동 스모크 1회. **하나라도 실패면 해당 단계 즉시 롤백.**

### 롤백 기준
테스트 실패 원인 불명 / 수동 스모크 1개라도 실패 / AUTH·프록시 회귀 / 씬 전환 중 stale 결과 / localStorage 손상 가능성.

---

## 6. SceneBoard 점진 분해 로드맵 (병합 후)

| Phase | 분리 대상 | 후보 훅/파일 | 위험 | 검증 |
|---|---|---|---|---|
| 0 | 현재 동작 고정 | 스모크 문서 + 기존 테스트 | 낮음 | 씬 생성/전환·drag·pan·zoom·paste·drop·undo |
| 1 | 상수/순수 helper | sceneConstants.ts, sceneRefs.ts, sceneMedia.ts | 낮음 | vitest(렌더 구조 불변) |
| 2 | 저장/undo/씬전환 상태 | useSceneBoardState | 중 | persist/undo/sceneIdRef 보존 |
| 3 | 키보드/paste/drop | useSceneKeyboard, useSceneClipboardDrop | 높음 | Delete·Ctrl+Z/C/V/G·paste·drop |
| 4 | 마우스/카메라/드래그 | useScenePointerController | 높음 | marquee·drag·resize·wheel·pan |
| 5 | Comfy 실행/저장 오케스트레이션 | useSceneComfyOrchestration | 높음 | 전환 중 실행·late 무시·배치 순서 |
| 6 | 카드종류별 렌더 분리 | ReferenceCard/TextCard/ComfyCard/GenerationCard … | 중 | 시각 스모크 + 클릭/포트 |

Phase 1은 저위험(병합 전 후보 가능), 2~6은 신중(병합 후).

---

## 7. 역할 분담
- **코덱스:** 불변식 검토, 순수 로직 추출, 테스트 설계, 보안/성능 핫스팟 검증.
- **클로드:** 전체 설계 통합, UI 흐름 보존, 병합 순서 조율, 최종 파일 수정.

---

## 8. Jay 결정 필요(요약)
1. **씬 저장 범위**: 로컬+계정 네임스페이스(추천) vs 서버 저장(별도 프로젝트)
2. **팀서버 Comfy 권한**: owner/admin 제한(추천) vs 전체 인증 vs 비활성
3. **병합 전 리팩터 범위**: Phase 0~1만(추천) vs Phase 2까지
4. **E2E 도구**: 미도입(추천, 수동 스모크로) vs Playwright 도입

---

## 리뷰 진행 기록
- **청크 1 (백엔드 보안/권한)**: 완료. Comfy는 개인 로컬+본인 키 사용이라 서버 공유 위험 없음 → 권한 변경 안 함. 씬 계정 네임스페이스 반영.
- **청크 2 (씬 그래프 순수 로직)**: 완료. 반영 3건(이관 경계 #2·리스트 텍스트 상류 #4·import 방어 #3). 결정: **#6 output 다중입력은 그대로 허용**(채널 이름을 다르게 쓰면 겹칠 일 없음, input/output 의도된 설계).
- **청크 3 (SceneBoard 상태·저장)**: 완료. 코덱스 공동 설계로 5건 반영 — **#3 카드 삭제는 캔버스만(서버 생성물 보존, Jay 결정 ⓑ)**, #4 수동 참조 provenance 보존, #5 이동/정렬 후 연결 참조 순서 재계산(withGenRefs), #6 그룹 유령 멤버 정리, #1 비동기 응답의 씬 오염 가드(파일임포트·캡쳐·comfy parse/save/run). #2 undo-vs-외부저장은 보류(이미 완화).
- **보류(저위험·후속)**:
  - #1 다중 탭+서로 다른 계정 동시 로그인 시 씬 오염 가능(매우 드묾, keyOf 가 매 호출 activeAccount 를 읽음). 필요 시 탭 시작 시 네임스페이스 고정으로.
  - #5 실행계획 내부에서 resolvePortEdges 미적용(현재 호출부가 모두 먼저 적용 → 실버그 아님, 방어적 보강만).
  - #7 arrangeNodes 비정상 grid/좌표 방어. #8 워크플로 JSON 반복 파싱 캐시(무동작변경 최적화).

## 부록 — 리뷰 청크(별도 세션, 병합 전 위험 점검용)
서브시스템 최종 diff 기준. 위험순: ① 백엔드 보안 경계 → ② 씬 그래프 순수 로직 → ③ SceneBoard 상태/저장 → ④ 입력 이벤트 → ⑤ 생성 실행/App 연결 → ⑥ 렌더/UI → ⑦ Assets → ⑧ 계정/DB/휴지통 → ⑨ 미디어 비교 → ⑩ Prompt/Spotlight → ⑪ Comfy 재확인 → ⑫ 검증 매트릭스.
