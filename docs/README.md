# MV Hub 개발 문서 안내

Higgsfield CLI 기반 **로컬 우선(Local-first)** 콘텐츠 생성·관리·공유 툴.
현재 작업 상태는 [CURRENT_STATUS.md](CURRENT_STATUS.md)에서 먼저 확인한다.
현행 설계는 [ARCHITECTURE.md](ARCHITECTURE.md)와 [AI_CONTEXT.md](AI_CONTEXT.md)를 참조한다.
[DESIGN.md](DESIGN.md)는 서버가 직접 생성하던 초기 설계의 보존 문서다.

## 1분 안에 현재 상황 파악하기

새 작업을 시작할 때는 아래 세 문서만 순서대로 읽는다.

1. [CURRENT_STATUS.md](CURRENT_STATUS.md) — 마지막으로 검증한 코드와 바로 다음 작업
2. [RISK_REDUCTION_PLAN_2026-08-15.md](RISK_REDUCTION_PLAN_2026-08-15.md) `Gate 0` — 위험 항목의 정확한 상태
3. [ARCHITECTURE.md](ARCHITECTURE.md) — 수정할 기능의 현재 구조와 데이터 흐름

나머지 문서는 필요한 기능의 세부 계약이나 과거 판단 근거를 확인할 때만 연다. 문서 제목에
`설계`, `계획`, `감사`, `시험 결과`가 들어 있어도 자동으로 현재 할 일이나 최신 배포 보증으로
해석하지 않는다.

## 먼저 볼 문서

| 목적 | 기준 문서 |
|---|---|
| 지금 완료된 것과 다음 작업 | [CURRENT_STATUS.md](CURRENT_STATUS.md) |
| 날짜별 상세 기록(회귀·실측·구현 근거) | [status/](status/) 노트 — 진입점은 [status/최근작업_2026-08-24.md](status/최근작업_2026-08-24.md) |
| 프로그램 사용 | [사용설명서.md](사용설명서.md), [기능설명서.md](기능설명서.md) |
| 현재 구조와 데이터 흐름 | [ARCHITECTURE.md](ARCHITECTURE.md), [AI_CONTEXT.md](AI_CONTEXT.md) |
| 로컬·공유 서버 데이터 경계 | [DATA_OWNERSHIP.md](DATA_OWNERSHIP.md), [WORKSPACE_DATA_CONTRACT.md](WORKSPACE_DATA_CONTRACT.md) |
| 신원·권한·실행 모드 | [신원과_모드_가이드.md](신원과_모드_가이드.md) |
| 401 인증 실패·로그인 보존 계약 | [AUTH_FAILURE_SEMANTICS.md](AUTH_FAILURE_SEMANTICS.md) |
| 생성·계정 보고 백그라운드 전송·재시도·마지막 성공 관측 계약 | [TELEMETRY_DRAIN_LIFECYCLE.md](TELEMETRY_DRAIN_LIFECYCLE.md) |
| 공유·최종 상태 보상 계약 | [SHARE_STATE_COMPENSATION.md](SHARE_STATE_COMPENSATION.md) |
| 작업자 PC 오프디스크 백업 설계·완료 조건 | [WORKER_OFFDISK_BACKUP_CONTRACT.md](WORKER_OFFDISK_BACKUP_CONTRACT.md) |
| 현재 위험과 다음 작업 | [RISK_REDUCTION_PLAN_2026-08-15.md](RISK_REDUCTION_PLAN_2026-08-15.md) |
| 캔버스 생성 재시도 계약 | [CANVAS_GENERATION_IDEMPOTENCY.md](CANVAS_GENERATION_IDEMPOTENCY.md) |
| 견적 CLI 동시 실행·취소 계약 | [CLI_ESTIMATE_LIFECYCLE.md](CLI_ESTIMATE_LIFECYCLE.md) |
| 생성 제출 중단·중복 과금 방지 | [GENERATION_SUBMISSION_RECOVERY.md](GENERATION_SUBMISSION_RECOVERY.md) |
| 테스트와 배포 전 검증 | [TESTING.md](TESTING.md), [PREDEPLOY_100_USERS.md](PREDEPLOY_100_USERS.md) |
| 서버 설치·운영·복구 | [SERVER.md](SERVER.md), [SERVER_RECOVERY.md](SERVER_RECOVERY.md) |

## 문서 상태

문서 전체에 하나의 고정 우선순위를 적용하지 않는다. 서로 다른 내용이 보이면 먼저 **무슨 내용을
판단하는지** 구분하고 아래 분야별 기준 문서를 따른다.

| 판단할 내용 | 단일 기준 |
|---|---|
| 지금 완료된 것·다음 작업·검증 결과 | `CURRENT_STATUS` 요약 후 `RISK_REDUCTION_PLAN_2026-08-15` Gate 0 표 |
| 코드 구조·실행 흐름 | `ARCHITECTURE`, `AI_CONTEXT` |
| 데이터 소유권·워크스페이스 귀속 | `DATA_OWNERSHIP`, `WORKSPACE_DATA_CONTRACT` |
| 신원·권한·실행 모드 | `신원과_모드_가이드` |
| 기능별 상태 전이·복구 | 해당 기능의 세부 계약 문서 |
| 설치·서버 운영·테스트 | `SERVER`, `SERVER_RECOVERY`, `TESTING` |

과거 감사·초기 설계·기능 계획 문서는 판단 근거와 이력을 보존하는 자료다. 현행 기준 문서와
충돌하면 과거 문서를 고치는 근거로 사용하고, 과거 문서의 지시를 그대로 구현하지 않는다.

| 구분 | 문서 | 사용 방법 |
|---|---|---|
| **현행 기준** | `ARCHITECTURE`, `AI_CONTEXT`, `DATA_OWNERSHIP`, `WORKSPACE_DATA_CONTRACT`, `신원과_모드_가이드` | 구현 전에 반드시 확인한다. |
| **현재 현황 요약** | `CURRENT_STATUS` | 완료·잔여·검증 상태를 빠르게 확인한다. |
| **현재 작업 목록** | `RISK_REDUCTION_PLAN_2026-08-15` | 위험 상태를 변경하는 단일 출처다. |
| **현재 세부 계약** | `GENERATION_SUBMISSION_RECOVERY`, `CANVAS_GENERATION_IDEMPOTENCY`, `CLI_ESTIMATE_LIFECYCLE`, `AUTH_FAILURE_SEMANTICS`, `TELEMETRY_DRAIN_LIFECYCLE`, `SHARE_STATE_COMPENSATION`, `WORKER_OFFDISK_BACKUP_CONTRACT` | 기능별 상태 전이·복구·검증 기준이다. 완료 여부는 위험 계획의 Gate 0 표를 따른다. |
| **운영 기준** | `SERVER`, `SERVER_RECOVERY`, `TESTING`, `HF_CLI_UPGRADE` | 설치·업데이트·복구·검증 때 사용한다. |
| **기능별 설계** | `PM_DASHBOARD_DESIGN`, `관리대시보드_통합계획`, `CANVAS_MERGE_OPTIMIZATION_PLAN`, `DESIGN_id_unification`, `ROADMAP_SCALE` | 일부 구현·일부 계획이 섞여 있으므로 현행 코드와 대조한다. |
| **검증 기록** | `LOAD_TEST_2026-08-14`, `PREDEPLOY_100_USERS` | 해당 시점의 결과다. 새 배포를 자동 보증하지 않는다. |
| **과거 기록** | `AUDIT_2026-08-15`, `DESIGN` | 문제 발견 이력과 초기 설계 보존용이다. 현재 할 일 목록으로 사용하지 않는다. |

> 문서는 삭제하지 않고 위상만 구분한다. 과거 판단 근거가 사라지면 같은 문제를 다시 분석하거나,
> 이미 해결된 항목을 중복 수정할 수 있기 때문이다.

### 전체 문서 분류

아래 표는 `docs`의 Markdown 문서를 빠짐없이 분류한다. PDF는 특정 시점에 만든 외부 배포용
결과물이므로 현재 기술 판단의 기준으로 사용하지 않는다.

| 상태 | 문서 |
|---|---|
| **문서 색인·갱신 규칙** | `README`(이 문서) |
| **현황·작업 기준** | `CURRENT_STATUS`, `RISK_REDUCTION_PLAN_2026-08-15` |
| **날짜별 기록(`status/`)** | `status/최근작업_2026-08-24`, `status/RL_완료목록`, `status/검증기록`, `status/구현완료_RL-02_RL-23`, `status/사전배포검증_2026-08-19`, `status/안정화_2026-08-18` |
| **현행 구조·계약** | `ARCHITECTURE`, `AI_CONTEXT`, `DATA_OWNERSHIP`, `WORKSPACE_DATA_CONTRACT`, `신원과_모드_가이드`, `AUTH_FAILURE_SEMANTICS`, `CANVAS_GENERATION_IDEMPOTENCY`, `CLI_ESTIMATE_LIFECYCLE`, `GENERATION_SUBMISSION_RECOVERY`, `TELEMETRY_DRAIN_LIFECYCLE`, `SHARE_STATE_COMPENSATION` |
| **구현 전 확정 계약** | `WORKER_OFFDISK_BACKUP_CONTRACT` |
| **운영·검증 절차** | `SERVER`, `SERVER_RECOVERY`, `TESTING`, `HF_CLI_UPGRADE` |
| **사용자 안내** | `사용설명서`, `기능설명서` |
| **일부 구현·후속 설계** | `DESIGN_id_unification`, `PM_DASHBOARD_DESIGN`, `관리대시보드_통합계획`, `ROADMAP_SCALE` |
| **완료 작업의 개발 이력** | `CANVAS_MERGE_OPTIMIZATION_PLAN` |
| **시점 고정 검증 기록** | `LOAD_TEST_2026-08-14`, `PREDEPLOY_100_USERS` |
| **과거 기준·감사 보존** | `AUDIT_2026-08-15`, `DESIGN`, `CLAUDE` |
| **외부 설명 자료** | `투자자_소개서` |

`소개서.pdf`, `툴_소개서.pdf`도 외부 설명 자료 스냅샷으로 분류한다.

이 분류가 바뀌면 문서를 이동하거나 삭제하는 대신 이 표와 해당 문서 상단의 상태 안내를 함께
갱신한다.

### 문서별 갱신 책임

같은 내용을 여러 문서에서 각각 확정하지 않는다.

| 변경 내용 | 먼저 고칠 문서 | 함께 맞출 문서 |
|---|---|---|
| 위험 항목 상태·우선순위 | `RISK_REDUCTION_PLAN_2026-08-15` Gate 0 표 | `CURRENT_STATUS` 요약 |
| 구조·데이터 흐름 | `ARCHITECTURE`, `AI_CONTEXT` | 관련 세부 계약 |
| 기능별 상태 전이·안전 규칙 | 해당 세부 계약 | `ARCHITECTURE`, `TESTING` |
| 실제 테스트 결과 | `CURRENT_STATUS` | 관련 위험 항목의 근거 |
| 설치·운영 절차 | `SERVER`, `SERVER_RECOVERY`, `TESTING` | `CURRENT_STATUS`의 잔여 확인 |

`검증 통과`, `완료`, `배포 가능`은 서로 다른 말이다. 자동 테스트만 통과한 작업은 외부 프로그램과
운영 설치본까지 확인하기 전에는 `배포 완료`로 기록하지 않는다.

### 작업 종료 때 문서 확인 순서

1. 위험 상태가 바뀌었다면 `RISK_REDUCTION_PLAN_2026-08-15`의 Gate 0 표를 먼저 수정한다.
2. `CURRENT_STATUS`의 완료 항목·다음 작업·실제 검증 숫자를 맞춘다.
3. 날짜별 상세 기록(회귀 수치·실측 결과·구현 근거)은 `status/`에 **새 노트**로 넣고,
   `CURRENT_STATUS`에는 한 줄 링크만 추가한다. 현황판이 다시 길어지지 않게 한다.
4. 구조나 상태 전이가 바뀐 경우에만 `ARCHITECTURE`와 해당 세부 계약을 수정한다.
5. 과거 감사·계획·시험 기록의 본문은 당시 근거로 보존하고, 필요하면 상단 안내만 보강한다.
6. 로컬 링크 검사와 `git diff --check`를 통과한 뒤 문서 변경을 별도 커밋한다.

## 과거 초기 구현 기록 (Phase 1~5)

> 아래 표는 개발 이력이며 현재 생성 구조를 뜻하지 않는다. 현행 생성은 서버 잡 큐가 아니라
> 각 사용자 PC의 `agent_push.py`와 `/api/gen-requests`가 담당한다.

| Phase | 내용 | 상태 |
|------|------|------|
| 1 | `schema.sql` + `db.py` — SQLite WAL 초기화 | ✅ |
| 2 | FastAPI 골격 + 라이브러리 조회 라우터(필터·검색·패싯) | ✅ |
| 3 | `cli_bridge.py`(검증된 CLI 매핑) + 잡 큐 + WebSocket 진행률 | ✅ |
| 4 | React UI — 썸네일 그리드(가상 스크롤)/필터/생성 모달/팀 작업 탭 | ✅ |
| 5 | publish/import + lineage — **로컬 SQLite 구현** | ✅ (원격 서버 보류) |

> **과거 Phase 5 스코프 컷**: 당시에는 원격 공유 서버를 보류하고 로컬 단일 DB만 구현했다.
> 현재는 공유 서버 + 각 사용자 로컬 허브의 이중 구조이며, 자세한 데이터 흐름은
> [ARCHITECTURE.md](ARCHITECTURE.md)를 기준으로 한다.

## 실행

### 1) 백엔드 (FastAPI, 기본 8000)
```powershell
cd backend
pip install -r requirements.txt
python -m app.db init          # DB 초기화 (WAL) — 최초 1회, 멱등
uvicorn app.main:app          # http://127.0.0.1:8000
```

> ⚠️ **Windows 에서 `--reload` 를 붙이지 마세요.** uvicorn 리로더가 SelectorEventLoop 을
> 강제해 `higgsfield` CLI 호출(asyncio subprocess)이 `NotImplementedError` 로 깨집니다.
> Proactor 이벤트 루프가 필요하므로 `--reload` 없이 실행하고, 코드 변경 시 수동 재시작하세요.

### 2) 프론트엔드 (Vite + React, 5173)
```powershell
cd frontend
npm ci
npm run dev                    # http://localhost:5173
```
> 백엔드 포트를 바꿨다면 `BACKEND=http://127.0.0.1:<port> npm run dev` 로 프록시 재지정.

### 3) 사용
1. 우측 상단 **↺ 동기화** — `higgsfield generate list` 의 실제 생성 이력을 로컬 DB 로 가져옵니다(멱등).
2. 썸네일 그리드에서 탐색 · 좌측 사이드바로 컬러/태그/작업자/상태 필터.
3. 카드 액션: ● 컬러 / # 태그 / ↻ 재생성 / ↗ 공유.
4. **팀 작업** 탭 → ⬇ 가져오기 = 내 워크스페이스로 복제 + lineage 기록.
5. **+ 새 생성** — 프롬프트·모델·레퍼런스 입력 → `/api/gen-requests` 요청 등록 →
   내 PC 에이전트가 로컬 Higgsfield CLI로 제출·추적 → WebSocket으로 카드 갱신.
   팀 공간은 계정 보고에서 id와 이름이 모두 확인된 뒤 요청되어 생성정보에 워크스페이스명이 보존됩니다.
   ⚠️ 실제 Higgsfield 크레딧을 소모합니다.

## 아키텍처 (요약 — 상세 지도는 [ARCHITECTURE.md](ARCHITECTURE.md))

계층: `routers → usecases → repo/services` (경계는 pytest `test_architecture_boundaries.py` 가 강제).

```
backend/
  schema.sql              # DDL (WAL/FK)
  app/
    db.py / db_migrations.py  # 커넥션 풀(스레드별)·유지보수 게이트 / 멱등 마이그레이션
    config.py / models.py     # 환경변수 설정 / Pydantic 요청·응답
    main.py                   # 앱 팩토리·미들웨어·lifespan·/ws
    routers/   (22개)         # library·generation·gen_requests·ingest·share·publish·sync·
                              # projects·members·manage·assets(+metadata)·comfy·
                              # resolve_integration·release_update·scenes·auth·db_backup·
                              # db_transfer + 내부(_proxy·_telemetry·_assets_access)
    usecases/  (4개)          # gen_requests·generation_media_cache·generation_personal_meta·hf_missing
    repo/      (30개 모듈)     # 데이터 접근 — generations·share·projects·identity·manage·trash 등
    services/  (40개)          # cli_bridge·media_cache·syncer·thumbs·backup·comfy_*·resolve_*·
                              # telemetry_drain·operational_*·release_update·asset_* 등
frontend/
  src/
    api.ts, types.ts      # 타입 안전 클라이언트 + WS
    App.tsx               # 상태·WS·액션 오케스트레이션
    components/           # 12개 서브폴더(scene·assets·manage·spotlight·settings·…)
    lib/                  # 160+ 훅·유틸
```

## 기술 노트 (검증됨)

- **WAL + FK**: WAL 은 DB 파일에 영속되지만 `foreign_keys` 는 커넥션마다 꺼진 채
  시작하므로 `db.py` 커넥션 팩토리에서 매번 `PRAGMA foreign_keys=ON` 을 적용한다.
  (CASCADE 동작 실측 확인)
- **Windows CLI 함정**: `higgsfield` 는 npm 셰임 `higgsfield.CMD`. PATH 이름이 아니라
  `shutil.which()` 절대경로로 실행해야 한다. subprocess 는 **Proactor 이벤트 루프**가
  필요하다 — `main.py` 가 import 시점에 Proactor 정책을 박아두지만, **uvicorn `--reload`
  는 SelectorEventLoop 을 강제해 여전히 깨진다**(`NotImplementedError`). 그래서 백엔드는
  `--reload` 없이 실행한다(실측 확인).
- **출처 영속화(byte-cache)**: 소스·결과물이 Higgsfield 원격 URL(계정 귀속·만료 가능)에만
  있으면 재사용이 깨진다. 공유·최종 완료본은 영속 큐로 자동 보존하고, 업데이트 전 기존 항목도
  시작 시 백필한다. 개별 `⤓ 보관`(`/api/generations/{id}/cache`)은 즉시 재시도하고 관리자
  `/api/cache-all`은 완료본 전체를 저속 큐에 등록한다. 바이트는 `media/`로 내려받고 `file_path`를
  `/media/..`로 전환하며 원본 URL은 `source_url`에 보존한다. 기본 50GiB 한도에서는 기존 보존본을
  삭제하지 않고 새 초과 파일만 되돌린다(실측 확인).
- **CLI 필드 매핑**: `generate list --json` 실제 출력으로 검증(★CLI 1.x 대응, `docs/HF_CLI_UPGRADE.md`) —
  `id→PK`, `job_set_type|job_type→model`(1.x 개명, 폴백), `result_url`(확장자로 image/video),
  `created_at`(epoch 또는 1.x ISO문자열→파싱), `params.prompt`, `params.medias[]→reference`
  (1.x 도 출력 params 는 `medias` 유지). CLI 버전은 `hf_cli_version.txt` 로 pin.
- **진행률**: higgsfield 는 퍼센트가 아니라 상태 전이를 주므로 가짜 진행바 대신
  coarse 상태(pending/running/done/failed)를 WS 로 push한다. 생성 완료는 `generate list`가 아니라
  저장한 job_id의 `generate get` 직접 응답, 결과 URL, 서버 asset 저장 ACK를 모두 확인해 확정한다.
