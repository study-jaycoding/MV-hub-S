---
aliases:
  - MV-hub-S 구조 원칙
  - 아키텍처 기준선
tags:
  - mvhub
  - mvhub/구조
  - 기준문서
updated: 2026-08-24
status: 현행 기준
---

# ARCHITECTURE.md — MV-hub-S 구조 원칙

> [!NOTE]
> 이 문서는 **유지보수성 개선의 기준선(baseline)** 이다.
> 목적: "어디에 무슨 코드를 두는가"를 팀이 한 곳에서 합의한다.
> 원칙: **큰 파일을 줄이는 게 목표가 아니라, 관심사(UI·상태·저장·실행·IO)를 섞지 않는 게 목표**다.
>
> 현재 상태는 "목표대로 다 된 상태"가 아니라 **점진적으로 옮겨가는 중**이다.
> 새 코드는 아래 원칙을 따르고, 기존 코드는 손대는 김에 조금씩 정리한다(빅뱅 금지).

리아키텍처 중 데이터 경계를 바꾸기 전에는 아래 두 기준 문서를 함께 확인한다.

- [docs/DATA_OWNERSHIP.md](docs/DATA_OWNERSHIP.md) — 로컬 허브·공유 서버·파일·localStorage 중 어디가 최종 정답인가
- [docs/신원과_모드_가이드.md](docs/신원과_모드_가이드.md) — email·creator_uid·worker_id·generation.id·job_id 사용 규칙

---

## 1. 한눈에 보는 계층

### 프론트엔드 (`frontend/src`)

```
app        화면 조립·라우팅·전역 배선 (App.tsx, main.tsx)
  │  (아래로만 의존)
  ▼
features   화면 단위 묶음 — scene / library / prompt / assets / manage / …
  │        각 feature 안에서 4역할로 나뉜다:
  │          · UI 컴포넌트   화면·이벤트만 (dumb, props 로만 말한다)
  │          · 컨테이너 훅    상태·오케스트레이션 (useXxx)
  │          · domain(순수)  계산만 — React·fetch·localStorage 금지
  │          · api           서버 IO 만
  ▼
shared     여러 feature 가 공유 — ui(공통 컴포넌트) / lib(순수 유틸) / types
```

**의존 방향은 위 → 아래로만.**
- `app → features → shared` (역방향 import 금지)
- `domain(순수) → types` 만. domain 은 React·fetch·localStorage 를 import 하지 않는다.
- **feature 끼리 직접 import 금지** (scene 이 manage 내부를 직접 가져다 쓰지 않는다). 공유가 필요하면 `shared` 로 올린다.

> [!NOTE]
> 지금 실제 폴더는 `components/`의 12개 그룹(`scene`·`assets`·`manage`·`spotlight`·`settings`…)
> + `lib/`(173개 훅·유틸) 형태로, 이미 feature 성격의 그룹이 잡혀 있다. 위 구조는 그걸
> **명시적 규칙으로 굳히는 것**이지 폴더를 대이사하자는 게 아니다. (대이사는 P 단계에서 필요할 때만, 조각으로.)

### 백엔드 (`backend/app`)

```
routers     HTTP 만 — 요청/응답 변환, 인증 통과, usecase 호출          (25개)
  ▼
usecases    업무 흐름 — 여러 repo·부수효과(WS·PM·agent signal)를 하나로 묶는다   (4개)
  ▼
repo        데이터 만 — SQL·트랜잭션 (facade __init__.py 유지, 내부만 분할)   (39개 모듈)
services    asset_tree·cli_bridge·media_cache·thumbs·syncer·resolve_*·
            server_relocation 등 도메인 IO (usecase 가 호출)              (63개)
```

**의존 방향:** `routers → usecases → repo/services`.
- `repo` 는 `routers` 를 import 하지 않는다(역방향 금지).
- `services` 는 `routers` 를 import 하지 않는다. 파일 감시·캐시 무효화도 서비스 안에서 끝낸다.
- `usecases` 는 FastAPI(Request/Response) 를 import 하지 않는다 — HTTP 는 router 의 몫.
- `repo/__init__.py` 는 **facade** 다. 바깥은 `from app.repo import X` 만 쓰고, 내부 분할(`repo/generations.py` 등)은 이 파사드 뒤에 숨는다.

> [!NOTE]
> 현재는 일부 router 가 repo 를 직접 호출하며 업무 흐름까지 조립하는 곳이 있다.
> usecases 계층은 그 조립부를 옮겨 담을 자리다. **한 번에 다 옮기지 않는다** — 손대는 라우터부터.

외부 프로그램을 붙드는 서비스 묶음은 계약 문서가 따로 있다. 건드리기 전에 먼저 읽는다.

| 묶음 | 하는 일 | 계약 문서 |
|---|---|---|
| `services/resolve_*` | DaVinci Resolve 전송 큐(접수·준비·반입·중단 복구) | [docs/DESIGN_RESOLVE_QUEUE_V3_2026-08-24.md](docs/DESIGN_RESOLVE_QUEUE_V3_2026-08-24.md) |
| `services/server_relocation.py` | 공유 서버 주소 이사 공지 발행·수신·전환 | [docs/SERVER_RELOCATION.md](docs/SERVER_RELOCATION.md) |
| `services/telemetry_drain*` | 관리 텔레메트리 전송·재시도·마지막 성공 관측 | [docs/TELEMETRY_DRAIN_LIFECYCLE.md](docs/TELEMETRY_DRAIN_LIFECYCLE.md) |
| `services/cli_bridge.py` | Higgsfield CLI 호출 경계(필드 매핑·pin) | [docs/HF_CLI_UPGRADE.md](docs/HF_CLI_UPGRADE.md) |

### 배포형 에이전트 (`agent_push.py`)

- `/api/agent/download`가 이 파일 하나를 팀원 PC에 배포하므로 **단일 파일 + Python 표준 라이브러리만** 유지한다.
- 물리적으로 여러 모듈로 나누려면 먼저 번들 생성·다운로드·업데이트 경로를 함께 설계해야 한다.
- 파일 안에서는 CLI 어댑터, Hub HTTP 계약, outbox, 생성 실행, 스케줄러 경계를 구분한다.
  서버 URL·쿼리·payload 형식은 HTTP 계약 어댑터에 모으고 `test_agent_contracts.py`로 고정한다.
- 생성 스케줄러는 **CLI 제출 워커**와 **원격 진행 작업**을 분리한다. 기본값은 제출 8개,
  원격 추적 64개다. 완료 판정은 목록의 지연·누락에 기대지 않고 작업별
  `higgsfield generate get <job_id>` 직접 조회로 확인한다. 한 사이클에는 기한이 된 작업을
  제한된 수만 조회하되 다음 조회 시각 순으로 골라, 추적 작업이 많아도 특정 작업이 굶지 않게 한다.
- 신규 생성·재생성의 팀 워크스페이스는 **id와 표시 이름이 모두 확인된 경우에만** 제출한다.
  새로고침 때 저장 필터에서 id만 먼저 복원되면 계정의 최신 보고 목록에서 같은 id의 정식 이름을
  채운 뒤 요청한다. 서버도 로그인 계정이 접근 가능한 등록부 ID인지 다시 확인하고 공식 이름으로
  교체한다. 따라서 카드·대시보드에는 위조·임시 이름이나 이름 없는 신규 팀 데이터가 저장되지 않는다.
- 과거 팀 생성물의 이름이 비어 있으면 DB 시작 마이그레이션이 등록부의 **동일 ID** 이름만 보강한다.
  관리 대시보드의 격리 집계 DB에도 같은 등록부 스냅샷을 넘겨 빈 이름만 보강한다. 등록부에 없는
  ID와 이미 이름이 있는 데이터는 추측하거나 덮어쓰지 않는다.

---

## 2. 두지 말아야 할 곳 (자주 하는 실수)

| 실수 | 대신 |
|---|---|
| 순수 계산 함수에서 `fetch`/`localStorage`/React 훅 사용 | domain 은 인자→값만. IO 는 api/훅으로 밀어낸다 |
| UI 컴포넌트가 직접 서버 호출 | 컨테이너 훅이 호출하고 데이터를 props 로 내린다 |
| feature A 가 feature B 의 내부 파일 import | 공유분은 `shared` 로 승격 |
| repo 안에서 WS 브로드캐스트·PM 집계 | 그건 usecase 의 일 (repo 는 데이터만) |
| 파일이 크다고 상태 소유권을 쪼갬 | **금지** — 레이스만 는다. 아래 §4 참고 |

---

## 3. 경계를 코드로 강제 (P1)

문서만으로는 안 지켜진다. 도구로 "선을 넘으면 경고"를 깐다. **처음엔 warning-first**(빌드 안 깨짐).

- 프론트: **ESLint** `lint:architecture` — `import/no-cycle`, 순수 domain의
  React/API/localStorage 접근 제한. P1은 경고 우선이며 현재 경고를 갚으면서 강화한다.
- 백엔드: pytest AST 경계 검사(`tests/test_architecture_boundaries.py`) —
  `repo → routers/usecases 금지`, `usecases → routers/FastAPI 금지`, 내부 import 순환 금지.

목표는 "새로 짜는 코드가 더 안 섞이게" 막는 것. 기존 위반은 천천히 갚는다.

---

## 4. 하지 말 것 (과설계 경고)

지금 규모(1인 vibe 코딩 + 소수 팀, 라이브 운영)에서 아래는 **이득보다 유지보수 비용이 크다**:

- 전면 DDD·헥사고날 아키텍처 도입
- ORM 전환(현재 raw SQL + 트랜잭션 원자성이 이미 검증됨 — 깨면 위험)
- 전역 상태 라이브러리(Redux/Zustand 등) 일괄 도입
- API 전면 재작성 / 폴더 대이사를 한 번에
- **파일 줄이려고 상태 소유권을 억지로 분리** (레이스·버그 유발)

원칙: **동작 보존이 최우선**(라이브 팀앱). 구조 개선은 "지금 손대는 조각"만, 롤백 가능하게.

---

## 5. 진행 로드맵 (점진, 저위험 → 고위험)

| 단계 | 내용 | 위험 |
|---|---|---|
| **P0** | 이 문서(ARCHITECTURE.md) | 없음 ✅ |
| **P1** | import 경계 검사(ESLint/pytest AST, 경고 우선) | 낮음 ✅ |
| **P2** | SceneBoard 순수 계산 추가 추출 + 테스트 | 낮음 ✅ |
| **P3** | SceneBoard 상태/저장/undo 훅 분리 | 중(민감) ✅ |
| **P4** | SceneBoard Comfy 실행 훅 분리 | 중(async) ✅ |
| **P5** | SpotlightPrompt 제출 흐름 훅 분리 | 낮~중 ✅ |
| **P6** | 백엔드 `gen_requests` usecase 추출 | 중 ✅ |
| **P7·P8** | `repo/manage`·`repo/generations` 내부 분할(파사드 유지) | 중~고 ✅ |
| **P9** | Assets 디스크 IO·계정별 마운트 저장소를 라우터에서 분리 | 중 ✅ |
| **P10** | Assets 개인 메타·팀 코멘트 하위 라우터 분리 | 중 ✅ |
| **P11** | 실패 통계와 실패 정리의 계정 범위 일치 | 낮 ✅ |
| **P12** | DB 경로·물리 삭제 공용부 추출 및 백엔드 import 순환 제거 | 낮~중 ✅ |
| **P13** | PM 다중 작업 담당 해제의 N요청을 배치 트랜잭션으로 통합 | 낮 ✅ |
| **P14** | Assets 다중 색상·태그 저장을 배치 API와 원자 트랜잭션으로 통합 | 낮~중 ✅ |
| **P15** | Assets 다중 소스 지정의 N요청을 지문 선계산+배치 트랜잭션으로 통합 | 낮~중 ✅ |
| **P16** | PM 작업 순서·선택 삭제의 N요청을 권한 선검사+배치 트랜잭션으로 통합 | 중 ✅ |
| **P17** | 라이브러리 다중 색상·태그 HTTP fan-out 제거 및 부분 실패 표시 | 중 ✅ |
| **P18** | PM 다중 프로젝트 작업 조회를 실제 DB 배치로 통합 | 중 ✅ |
| **P19~P22** | Assets·라이브러리·PM 연속 저장의 순서 경쟁과 불필요한 재조회 제거 | 중 ✅ |
| **P23** | 생성물 색상·태그 배치를 로컬·팀 shadow별 실제 트랜잭션으로 통합 | 중 ✅ |
| **P24** | PM 담당자 일괄 배정의 작업→프로젝트 권한 조회를 실제 배치화 | 낮 ✅ |
| **P25** | HF 원본 누락 검토의 신원·상태 반복 조회를 배치화하고 삭제 집계 교정 | 낮~중 ✅ |
| **P26** | 구버전 PromptPart JSON을 프론트 API 경계에서 안전하게 복원하고 재생성 원문 오염 방지 | 낮 ✅ |
| **P27** | 서버형 테스트 pull을 단일 DB에서 검증된 전체 SQLite 번들로 교정 | 중 ✅ |
| **P28** | 공용 미디어 썸네일의 최종 로드 실패를 화면별 fallback으로 일관되게 전환 | 낮 ✅ |
| **P29** | Comfy 실행 스냅샷으로 실행 중 워크플로·파라미터 교체의 낡은 결과 반영 차단 | 중 ✅ |
| **P30** | Comfy 실제 미디어·텍스트 입력 지문으로 실행 중 그래프 변경의 낡은 결과 반영 차단 | 중 ✅ |
| **P31** | 비교 모달 영상의 재생·정지·종료·수동 탐색 동기화를 공용 바인더로 통합 | 낮~중 ✅ |
| **P32** | 렌더 실행 계획 지문으로 실행 중 대상·연결·Comfy 의존 변경의 낡은 후속 생성 차단 | 중 ✅ |
| **P33** | 생성 요청 재료를 공용화하고 실행 중 모델·텍스트·레퍼런스 변경의 혼합 제출 차단 | 중 ✅ |
| **P34** | 캔버스 생성 제출을 작업·씬별로 격리하고 느린 요청의 전체 지연·비활성 씬 결과 오염 차단 | 중 ✅ |
| **P35** | 완료 감시 소유권을 분리하고 500개 초과 배치 조회·조회형 POST의 전체 재로드 순환 제거 | 중 ✅ |
| **P36** | 실시간 변경 출처를 추적해 자기 reload 중복·프록시 판정 분기·씬 백업/최초 WS의 오인 reload 제거 | 중 ✅ |
| **P37** | 라이브러리·Assets·PM 변경 채널을 분리하고 독립 창의 직접 WS·중복 억제·PM 조회 경합 차단 | 중 ✅ |
| **P38** | 공유 서버의 다른 PC 변경을 로컬 허브로 중계하고 프록시 echo·설정 오인 알림·재연결 폭주 차단 | 중 ✅ |

**순서 원칙:** 순수로직 추출 → 테스트 → 상태 분리 → IO 분리 → UI 분리.
(JSX 부터 자르면 props 만 늘고 이득이 없다.)

각 P 단계는 **착수 전 무엇을 바꿀지 짧게 보고**, 조각별 커밋, 언제든 롤백 가능하게.
SceneBoard 를 크게 건드리는 단계(P2~P4)는 **실측 라인을 흔들지 않도록 별도 워크트리/브랜치**에서 진행한다.

> [!NOTE]
> P0~P38 은 모두 반영됐다. 이후의 성능·안전 작업은 새 P 번호가 아니라 **최적화 라운드 장부**로
> 이어졌다(§7). 구조를 바꾸는 일만 여기에 P 번호로 추가한다.

---

## 6. 동시성·상태 계약 (새 코드가 지켜야 할 하우스 규칙)

최적화 라운드에서 **실제로 버그가 났던 자리**만 규칙으로 굳혔다. 이유까지 읽고 따른다.

| 규칙 | 왜 이렇게 하나 | 어디에 있나 |
|---|---|---|
| 쓰기용 `to_thread` 는 `to_thread_non_abandon` 을 쓴다 | 서버가 종료되거나 요청이 취소돼도 쓰던 작업을 중간에 버리지 않는다. 그냥 `to_thread` 는 취소되면 결과를 버려서 반쯤 쓴 파일·DB 가 남는다 | `services/async_tools.py` |
| 계정 키와 uid 는 **한 락 구간에서 함께** 캡처한다 | 계정 전환 도중에 키는 새 계정, uid 는 옛 계정으로 섞이면 남의 데이터에 쓴다 | `active_account.py:transition_lock`, `routers/*:_capture_account_pin` |
| 동기 라우트는 계정 고정 데코레이터로 감싼다 | 라우트 본문 어디에서 계정을 다시 읽어도 같은 계정이 나와야 한다 | `routers/share.py:_account_scoped_route` |
| 트랜잭션은 transaction-root 에서 `BEGIN IMMEDIATE`, **SELECT 보다 먼저** 연다 | 읽고 나서 잠그면 그 사이에 값이 바뀐다(TOCTOU). 안쪽에서 `get_connection` 을 또 여는 중첩도 금지 | `repo/*` |
| 인증 시크릿 캐시 키에 `pool_epoch` 를 넣는다 | DB 를 복원·교체하면 옛 시크릿으로 통과하는 빈틈이 생긴다 | `db.py:pool_epoch()` |
| 로컬 전용 라우트는 loopback + Host 헤더를 검사한다 | 외부 웹페이지가 브라우저를 통해 내 PC 의 API 를 두드리는 공격(DNS rebinding)을 막는다 | `services/request_guards.py` |
| 프런트의 비동기 갱신은 seq 가드를 둔다 | 느린 응답이 뒤늦게 도착해 최신 화면을 덮어쓰면 안 된다 | `lib/useResolveTransferActions.ts` 등 |
| 경과 시간 측정은 `performance.now()` | 벽시계는 시스템 시간 변경·NTP 보정에 흔들려서 음수 경과가 나온다 | 프런트 공통 |

---

## 7. 최적화 라운드 장부 (종료)

성능·동시성 개선은 P 로드맵과 별도로 **라운드(R1~R14)** 로 돌렸고, 2026-08-24 **수렴 선언으로
종료**했다. 각 라운드의 판정·근거는 `docs/OPT_PLAN*.md` 에 남아 있다.

- 최종 장부: [docs/OPT_PLAN12_2026-08-23.md](docs/OPT_PLAN12_2026-08-23.md) — R13·R14 내역, 수렴 선언, 백로그 실측 판정
- 회귀 기준선(2026-08-24): 백엔드 1,773 · 프런트 666 통과
- 잔여 백로그 1건: 휴지통 교차-WAL 전원손실(구조 재설계급, 보류 확정)

> [!CAUTION]
> 장부에서 **종결·반대로 판정된 항목은 다시 제안하지 않는다.** 같은 후보를 매번 다시 파느라
> 드는 비용이 개선 이득보다 크다는 게 라운드에서 반복 확인된 결론이다. 되살리려면 장부의
> 판정 근거(실측 수치)를 먼저 반박해야 한다.
