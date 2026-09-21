---
aliases:
  - CODE_MAP
  - 코드 지도
  - 파일 단위 색인
tags:
  - mvhub
  - mvhub/구조
status: active
updated: 2026-09-21
---

# CODE_MAP — 파일 단위 코드 지도

이 문서는 "무엇을 고치려면 어느 파일을 열어야 하나"를 빨리 찾기 위한 **파일 단위 색인**이다.
계층 원칙(무엇을 어디에 두는가)의 정본은 루트 [ARCHITECTURE.md](../ARCHITECTURE.md), 실행 흐름·데이터
모델의 정본은 [docs/ARCHITECTURE.md](ARCHITECTURE.md)다 — 이 문서는 그 둘과 충돌하면 항상 진다.
2026-09-18 전체 점검에서 8개 구역(백엔드 3·프런트 3·스타일·스크립트)을 읽기 전용으로 답사해 만들었다
(조사 기준 `f2d57867`, 줄 수는 그 시점 값이라 어림으로만 본다). 파일을 추가·삭제·이동하면 §6 대로 갱신한다.

> [!NOTE]
> 이 문서는 "구역 지도"·"구조 관찰"만 옮긴 것이다. 수정 후보(발견) 목록은 담지 않는다 — 후보는
> 코드보다 빨리 낡는다. 책임 설명이 조사에서 확인되지 않은 곳은 "미확인"이라고 적었다.

---

## 1. 빠른 찾기

| 하고 싶은 일 | 프런트 진입 파일 | 백엔드 진입 파일 | 비고 |
|---|---|---|---|
| 라이브러리 카드 표시 문구·상태 라벨 바꾸기 | `components/GenerationCard.tsx`, `lib/generationDisplay.ts` | — | 상태 라벨은 순수 프런트 판정 |
| 새 API 엔드포인트 추가하기 | `api.ts` | `routers/_proxy.py`(경로 소유권) + 해당 도메인 라우터. **새 라우터 파일이면 `main.py` 의 `include_router()` 등록도** | 로컬 전용 경로는 `_proxy._LOCAL_PREFIXES/_LOCAL_EXACT` 갱신 + `backend/tests/test_proxy_ownership.py` 골든 스냅샷도 같이 고쳐야 함(§5-c) |
| 캔버스(씬) 단축키 바꾸기 | `lib/useSceneKeyboardShortcuts.ts`, `lib/sceneKeyboard.ts` | — | |
| 생성 제출 흐름(프롬프트→요청→CLI) | `components/spotlight/useSpotlightSubmit.ts`, `lib/spotlightSubmit.ts` | `routers/gen_requests.py`, `usecases/gen_requests.py`, `repo/gen_requests.py` | 실제 CLI 제출·추적·완료 판정은 작업자 PC 의 `agent_push.py` 가 한다 — 서버 쪽만 봐서는 흐름이 끝까지 안 보인다 |
| 팀 공유·검토(공유/최종/보류) | `lib/useGenerationShareActions.ts`, `components/generation/GenerationReviewOverlay.tsx` | `routers/share.py`, `repo/share.py`, `services/share_state_reconciler.py` | |
| PM 대시보드 숫자·크레딧 표기 | `components/manage/WorkspaceUsageDashboard.tsx`, `lib/formatCredits.ts` | `repo/manage_credit_plan.py`, `routers/manage.py` | 크레딧은 소수 보존(반올림 금지) |
| 어셋/생성물 썸네일 | `components/MediaThumbnail.tsx` | `services/thumbs.py`, `routers/library.py`(media-thumb) | |
| ComfyUI 실행(로컬/Cloud) | `lib/useSceneComfyExecution.ts`, `components/scene/cards/ComfyCard.tsx` | `routers/comfy.py`, `services/comfy_client.py` | |
| DaVinci Resolve 전송 | `lib/useResolveTransferActions.ts` | `routers/resolve_integration.py`, `services/resolve_transfer.py` | |
| 앱 자동 업데이트·릴리스 절차 | `lib/releaseUpdate.ts` | `routers/release_update.py`, `services/release_update.py` | 배포 스크립트는 §4 |
| DB 백업·복원 | — | `routers/db_backup.py`, `routers/db_transfer.py`, `services/backup.py` | |
| 계정 전환·워크스페이스 전환 | `components/AccountMenu.tsx`, `lib/useHubAuth.ts` | `active_account.py`, `routers/auth.py` | |
| 실시간 갱신(WebSocket) | `lib/progressSocket.ts` | `ws.py`, `mutation_notify.py` | |
| 문구 번역(i18n) 추가·수정 | `lib/i18n.ts` | — | 한국어 원문이 키. `t()` 는 서버가 준 문구도 런타임에 받으므로, 원문이 소스에 없다는 이유만으로 영문 키를 지우지 않는다 |
| 화면별 CSS 파일 찾기 | `styles/*.css`(§3.4 표) | — | |
| 라이브러리 필터·정렬·뷰 상태 | `lib/useLibraryFilters.ts`, `components/LibraryToolbar.tsx` | `routers/library.py` | |
| 태그 편집(색/일반 태그) | `components/TagEditor.tsx`, `lib/generationTags.ts` | `routers/generation.py`(HTTP 경계·권한·프록시, 단건과 배치), `repo/tags.py` | 에셋 쪽 색·태그는 `routers/assets_metadata.py` |
| 휴지통(삭제·복원) | `lib/useGenerationTrashActions.ts` | `routers/generation.py`(삭제·복원), `routers/library.py`(`/api/trash` 목록·영구 삭제), `repo/trash.py`(별도 DB) | |
| 로그인/가입/계정 승인 | `components/LoginScreen.tsx`(서버 본체 AUTH 로그인), `components/ServerLoginScreen.tsx`(로컬 허브의 팀 서버 로그인 게이트·서버 주소 변경), `lib/useHubAuth.ts` | `routers/auth.py`, `services/auth.py`, `routers/publish.py`(`/api/shared-server/*`), `services/shared_connection.py` | 로컬 허브는 팀 서버 세션이 없으면 라이브러리 대신 게이트를 띄운다 |
| 창을 Esc/✕ 로 닫는 규칙 | `lib/useEscapeClose.ts`(공용 — 리스너 1회 등록+콜백 ref), `lib/useAppNavigation.ts`(관리자 창·미리보기는 브라우저 history 로 여닫음) | — | 코멘트 패널·Host 콘솔은 Esc 로 안 닫힌다(설계). 회귀 시험 `frontend/tests/escapeCloseNesting.test.tsx` |
| Assets 파일 탐색기(마운트·트리·업로드) | `components/AssetsView.tsx` | `routers/assets.py`, `services/asset_tree.py` | |
| 프로젝트 CRUD·멤버·역할 | `components/manage/ProjectManagerPanel.tsx` | `routers/projects.py`, `repo/projects.py` | |
| 작업(Task) 칸반/테이블/캘린더 | `components/manage/WorkBoard.tsx` | `routers/manage.py`, `repo/manage_tasks.py` | 소요시간 표기는 `lib/format.ts` 의 `fmtElapsed` 하나다(`1d2h3m4s`, 초를 버리지 않음, 하루 이상은 `1d1h` — Jay 확정 2026-09-18). PM 창 5곳과 정보 팝업(`InfoPopup`)의 '생성 시간'이 모두 이 함수를 쓴다. 새 뷰도 이 함수를 쓴다 |
| 크레딧 풀·그룹 한도 설정 | `components/manage/CreditPoolSection.tsx`, `CreditPlanFields.tsx` | `routers/manage.py`(`/api/manage/credit-plan*` — 권한·API 계약), `repo/manage_credit_plan.py` | |
| 관리 표(멤버·그룹·프로젝트 참여를 표에서 고치기) | `components/manage/MemberTable.tsx`, `lib/memberTable.ts` | `routers/manage.py`(`GET /api/manage/member-table`), `repo/manage_member_table.py` | 표에는 자기만의 쓰기 API 가 없다 — 칸마다 기존 API(`PUT credit-plan`·`PATCH/DELETE projects/{pid}/members`). 그룹 저장은 **받은 그룹을 전부** 되보내야 한다(빠진 그룹은 서버가 지운다). 가입·등급 칸은 서버의 마지막 admin 보호가 들어갈 때까지 보기만. 설계 `docs/MEMBER_TABLE_DESIGN.md` |
| 알림 센터(코멘트·업데이트 공지) | `components/NotificationCenter.tsx` | `routers/notifications.py`, `routers/update_notices.py` | |
| 부분 수정(마스크 편집 캔버스) | `components/edit/PartialEditModal.tsx` | — | 제출은 기존 생성 요청 경로 재사용(위 '생성 제출 흐름' 행 — `agent_push.py` 까지). `PartialEditHost`는 커스텀 이벤트로만 열림(§3.5) |
| 생성물 비교(Compare) | `components/CompareModal.tsx`, `VideoCompareModal.tsx` | — | |
| 히스토리 보드(계보 그래프) | `components/HistoryBoard.tsx` | `routers/generation.py`(`/history`·`/history-tree`), `repo/history.py`, `repo/lineage.py` | |
| 스포트라이트 프롬프트 도크(@/# 피커) | `components/SpotlightPrompt.tsx`, `components/spotlight/SpotlightMentionPicker.tsx` | — | |
| 씬 캔버스에 카드 종류 추가 | `lib/sceneNodeCatalog.ts`, `components/scene/cards/` | — | |
| 씬 저장·undo/redo | `lib/scenes.ts`, `lib/useSceneHistory.ts` | `repo/scenes_backup.py`, `routers/scenes.py` | |
| 공유 서버 주소 이전(서버 이사) | — | `services/server_relocation.py` | 스크립트: `server_move_export.bat`/`server_move_import.bat`/`tools/server_move.py` |
| 서버 자동시작·워치독·복구 | — | — | `MV_watchdog.bat`, `tools/server_watchdog.py`, `tools/server_supervisor.py`, `restart_server_task.ps1`(⚠ 진입 bat 는 실행금지 — §4) |
| Higgsfield CLI 버전 핀 교체 | — | — | `hf_cli_version.txt`, `update_cli.bat`, `tools/hf_cli_check_update.py` |
| 배포 전 검증(predeploy gate) | — | — | `tools/predeploy_gate.ps1` |
| DB 스키마·마이그레이션 | — | `backend/schema.sql`, `db_migrations.py`, `db.py` | 새 컬럼·인덱스는 생성 순서가 중요하다(구형 DB 전환 경로). PM 사이드카 테이블은 `repo/manage_schema.py` 가 **같은 콘텐츠 DB 안에** 만들고, 팀 텔레메트리만 `manage_db.py` 가 별도 `manage_hub.db` 에, 휴지통은 `repo/trash.py` 가 ATTACH 한 DB 에 만든다. **테이블별 DB·정의 파일·쓰는/읽는 모듈: [inventory/db_tables.md](inventory/db_tables.md)**(생성 문서) |
| 환경변수(설정 스위치)가 무엇이 있고 기본값이 뭔가 | `vite.config.ts` | `config.py` 가 중심이지만 40여 파일이 직접 읽는다 | **전체 목록: [inventory/env_vars.md](inventory/env_vars.md)**(생성 문서 — 이름·기본값·직접 읽는 파일·설정하는 스크립트) |
| 실행 모드·권한·프록시(서버/로컬 허브/격리 테스트) | — | `deps.py`, `routers/_proxy.py`, `rbac.py` | 모드별 차이의 정본은 [DATA_OWNERSHIP.md](DATA_OWNERSHIP.md) §2·[신원과_모드_가이드.md](신원과_모드_가이드.md) §4·[AI_CONTEXT.md](AI_CONTEXT.md) §2. **엔드포인트 전체와 경로별 프록시 분류(로컬 예외/기본 중계): [inventory/endpoints.md](inventory/endpoints.md)**(생성 문서) |
| 백그라운드 주기 작업·기동/종료 | — | `main.py`(lifespan 이 기동·회수), `services/backup.py`·`syncer.py`·`temp_sweeper.py`·`media_preservation.py`·`share_state_reconciler.py`·`worker_backup.py`·`remote_realtime.py`·`resolve_selection_monitor.py` | 작업별 계약 문서: [TELEMETRY_DRAIN_LIFECYCLE.md](TELEMETRY_DRAIN_LIFECYCLE.md)·[WORKER_OFFDISK_BACKUP_CONTRACT.md](WORKER_OFFDISK_BACKUP_CONTRACT.md). **기동 때 무엇이 어떤 조건(실행 모드)에서 시작되나·응답 뒤 작업·에이전트 상주 루프: [inventory/background_jobs.md](inventory/background_jobs.md)**(생성 문서) |
| 작업자 에이전트 배포·계약 | — | `agent_push.py`, `routers/ingest.py`(`/api/agent/*` 배포·롱폴), `routers/gen_requests.py` | 계약 고정 시험 `backend/tests/test_agent_contracts.py` |
| DB 복구·복원 훈련 | — | `routers/db_transfer.py`, `services/backup_verify.py`, `services/restore_runtime_verify.py` | 도구 `tools/verify_backup_restore.py` |
| 이 파일을 고치면 어떤 시험을 돌리나 | `git grep -l <파일이름(확장자 빼고)> -- frontend/tests frontend/src` | `git grep -l <모듈이름> -- backend/tests` | 또는 `powershell -NoProfile -File tools\graft.ps1 callers <심볼>` — 시험 파일도 호출처로 나온다. 시험↔기능 색인 문서는 없다 |

---

## 2. 백엔드

### 2.1 최상위 (`backend/app/*.py`)

`__init__.py`는 표에서 뺀다.

| 파일 | 한 줄 책임 | 비고 |
|---|---|---|
| `active_account.py` | 계정별 로컬 DB '활성 계정' 포인터(머신 레벨, DB 바깥) + 전환 락 | 약 180줄 |
| `config.py` | 경로·플래그·포트 상수 + 레거시 미디어 폴더 1회 이전 | |
| `db.py` | SQLite 연결 풀·초기화·유지보수 게이트·`pool_epoch` | 약 425줄 |
| `db_account_dbs.py` | 계정 DB 순수 헬퍼(기본 작업자 시드·레거시 소유자 판별·sqlite 일관 복사) | |
| `db_migrations.py` | schema.sql 전후 멱등 구조 보강(`_pre_migrate`/`_migrate`) | 약 900줄. 1회성·상시 보강이 시간순으로 섞여 있음(§5) |
| `db_paths.py` | SQLite 파일 위치 결정 단일 출처 | |
| `deps.py` | 요청 의존성 — 토큰·계정·역할·가시성 게이트 | 약 314줄 |
| `emailnorm.py` | 이메일 정규화 단일 정의 | |
| `generation_result.py` | CLI 파싱 결과 → 저장 필드 변환 순수 규칙 | |
| `list_gzip.py` | 생성물 목록 응답만 gzip 압축하는 미들웨어 | |
| `main.py` | FastAPI 앱 + lifespan(부팅 마이그레이션·주기작업 기동/회수) + 미들웨어 5종 + health/ready/admin 라우트 + `/ws` + SPA fallback | 약 1,340줄 |
| `manage_db.py` | 매니징 전용 DB(`manage_hub.db`) 스키마·팩트 upsert·팀 집계 조회 | 약 1,060줄 |
| `models.py` | Pydantic 요청/응답 스키마 48종 | 약 512줄 |
| `mutation_notify.py` | 변경 알림 HTTP 계약(도메인 판정·출처 파싱) | |
| `rbac.py` | 전역 4역할 + 프로젝트 3역할 매트릭스(순수 상수·매핑) | |
| `static_files.py` | 해시 자산 immutable 캐시 헤더 | |
| `task_activity.py` | 작업 보관 배치 시각 규칙(순수) | |
| `workspace_context.py` | 워크스페이스 컨텍스트 저장·전송 규격(순수) | |
| `ws.py` | WebSocket 연결 관리·브로드캐스트·디바운스 | 약 473줄 |

### 2.2 routers (`backend/app/routers/`)

라우트 수는 라우트 데코레이터를 소스 구조(AST)로 센 291개 엔드포인트 기준이다(main.py 10개 포함). "프록시 위임"은
`_proxy.proxying()` 호출 횟수(B1 실측, 11파일 95곳)다 — 이 라우터 코드가 로컬 허브 실행모드에서
팀 서버로 데이터를 위임하는 지점 수를 뜻하며, 0곳은 로컬 전용 데이터이거나 로컬·서버 겸용 코드가
서버 실행모드에서 자체 처리함을 뜻한다(추측 아님, 소유 판정을 대신하지 않는다).

**공용 기반(라우트 없음, 라우터들이 쓰는 인프라)**

| 파일 | 한 줄 책임 | 주 진입점 |
|---|---|---|
| `_proxy.py`(753줄) | 로컬 허브 → 팀 서버 HTTP 중계·경로 소유권 판정·미디어 스트림 폴백 | `proxying()`·`proxy_json()`·`proxy_get()`·`raw_request()`·`is_local_path()`·`data_proxy_middleware` |
| `_telemetry.py`(232줄) | PM 텔레메트리 outbox 를 실행 모드에 맞게 drain·스케줄 | `touch_generation_telemetry()`·`schedule_telemetry_drain()` |
| `_assets_access.py`(49줄) | Assets/코멘트 라우트의 로컬·권한 게이트 3종 | `require_mount_manager`·`require_local_assets`·`require_asset_comment_access` |

**생성물(라이브러리·메타·공유)**

| 파일 | URL·라우트 수 | 한 줄 책임 | 프록시 위임 |
|---|---|---|---|
| `library.py`(1178줄) | `GET /api/generations`·`/api/trash`·`/api/download`·`/api/media-thumb`·`POST /api/generations/batch`·`/locate` (15) | 목록·단건·배치·휴지통·다운로드·썸네일·머지, 팀 응답에 로컬 개인메타 오버레이 | 10곳 |
| `generation.py`(1314줄) | `PUT /generations/{id}/tags·color·source·comment`·`PUT /generations/workspace/batch` 등 (40) | 태그·색·소스·코멘트·히스토리·워크스페이스 배치·캐시 | 25곳 |
| `generation_views.py`(57줄) | `GET·PUT /api/generation-views` (2) | "마지막으로 크게 본" 배지 읽기/쓰기 | 0곳 |
| `share.py`(1009줄) | `POST /generations/{id}/{publish\|finalize\|final-review\|hold…}` (9) | publish/unpublish/finalize/hold — 원장 intent prepare → 서버 왕복 → 로컬 미러 | 9곳 |
| `publish.py`(1341줄) | `POST /api/publish-to-shared[/folder]`·`/api/share/publish-bundle`·`/api/shared-server/*` (14) | 로컬 허브 ↔ 공유 서버 세션(로그인·가입·승격·이사) + 서버측 번들 수신 입구 겸용 | 2곳 |
| `notifications.py`(34줄) | `GET /api/notifications/comments` (2) | 코멘트 알림 목록·전체 읽음 | 0곳 |

**생성 요청(에이전트 계약)**

| 파일 | URL·라우트 수 | 한 줄 책임 | 프록시 위임 |
|---|---|---|---|
| `gen_requests.py`(857줄) | `POST /api/gen-requests`·`/{rid}/{anchor\|fulfill\|fail\|reconcile}`·`GET /pending` (22) | 에이전트↔허브 생성요청 계약: 접수·클레임·앵커·fulfill·fail·reconcile | 0곳(로컬 전용 계약) |
| `ingest.py`(797줄) | `POST /api/ingest[/mcp\|/account-report]`·`GET /api/agent/{download\|run-bat\|wait\|status}` (16) | CLI 결과·계정 보고·MCP 적재 입구 + 에이전트 배포·롱폴 | 1곳 |
| `sync.py`(48줄) | `POST /api/sync`·`GET /api/sync-status` (2) | CLI `generate list` 수동 당김 + 텔레메트리 outbox 상태 | 0곳 |

**조직(계정·프로젝트·PM)**

| 파일 | URL·라우트 수 | 한 줄 책임 | 프록시 위임 |
|---|---|---|---|
| `auth.py`(513줄) | `POST /api/auth/{login\|access\|register}`·`PATCH /accounts/{email}/*` (16) | 가입·로그인·세션쿠키·계정 승인/역할/숨김 + 10분 super-admin 승격 | 0곳(로컬·서버 겸용 코드) |
| `members.py`(65줄) | `GET /api/members`·`PATCH /members/{uid}/global-roles` (2) | 전역 멤버 목록·전역역할 변경 | 0곳 |
| `projects.py`(622줄) | `GET /api/projects`·`POST /assign`·`GET /{pid}/folder-counts` 등 (17) | 프로젝트 CRUD·배정·멤버 역할·폴더 카운트 | 19곳 |
| `manage.py`(1814줄) | `POST /telemetry/push`·`GET /team-overview`·`GET /tasks[-batch]`·`POST /save-finals` (42) | PM 대시보드: 텔레메트리 수신·팀 집계·크레딧 플랜·작업 CRUD·골드 저장 | 11곳. 서로 무관한 5개 도메인이 한 파일(§5) |
| `update_notices.py`(174줄) | `GET /api/update-notices`·`POST /admin/register` (7) | 릴리스 공지 등록·고정·공표·읽음 | 0곳(쓰기는 서버 Admin 역할 게이트로 제한 — 프록시 위임과는 다른 종류의 서버 제약) |

**로컬 PC 기능(이 PC 에서만)**

| 파일 | URL·라우트 수 | 한 줄 책임 | 프록시 위임 |
|---|---|---|---|
| `assets.py`(1222줄) | `GET /api/assets/{tree\|file\|thumb}`·`POST /upload\|capture\|clipboard-copy` (18) | 마운트·폴더 트리·파일/썸네일 서빙·업로드·캡처·zip·탐색기 열기 | 0곳 |
| `assets_metadata.py`(313줄) | `GET /api/assets/meta`·`PUT /tags[/batch]`·`/color[s/batch]`·`POST /comments` (11, `assets.py`에 마운트) | Assets 의 개인 태그·색·코멘트(계정 DB) 와 팀 코멘트(서버 DB) 경계 | 9곳 |
| `comfy.py`(1654줄) | `POST /api/comfy/{run\|parse\|save-to-library}`·`GET /run_status\|/unresolved-runs` (11) | ComfyUI(로컬·Cloud) 연결·그래프 파싱·비동기 실행·미회수 결과 수거 | 0곳 |
| `resolve_integration.py`(351줄) | `POST /api/resolve/transfers`·`GET /api/resolve/{status\|script\|locks}` (10) | DaVinci Resolve 스크립트 설치·연결 진단·전송 접수/재시도 | 1곳 |
| `release_update.py`(131줄) | `GET /api/release-update/status`·`POST /start` (3) | 작업자 PC 앱 업데이트 상태·시작(로컬 요청만) | 0곳 |
| `console.py`(142줄) | `GET /api/console/summary`·`POST /close-app` (2) | cmd 창 정보(버전·CLI·로그 tail)·앱 종료 | 0곳 |
| `scenes.py`(86줄) | `GET·PUT /api/scenes/{backup\|cards}` (4) | 브라우저 localStorage 씬·카드링크의 DB 미러 동기화 | 0곳 |

**DB 이전·백업**

| 파일 | URL·라우트 수 | 한 줄 책임 | 프록시 위임 |
|---|---|---|---|
| `db_transfer.py`(977줄) | `GET /api/db/export`·`POST /import\|/server-backup\|/server-restore` (9) | 로컬 DB export/import, 서버 백업 업로드·연속성, 서버 복원 | 4곳 |
| `db_backup.py`(685줄) | `POST /api/db-backup[/sets]`·`GET /latest[-set]` (7) | 계정별 백업/백업세트 저장·회전·목록·다운로드(**서버측 수신 전용**) | 0곳(업로드를 받는 쪽이라 위임할 필요가 없음) |

### 2.3 usecases (`backend/app/usecases/`)

| 파일 | 한 줄 책임 | 주 진입점 | 호출자 |
|---|---|---|---|
| `gen_requests.py`(1551줄) | 생성요청 전 생애 흐름(제출·클레임·앵커·fulfill·fail·reconcile·견적) | `submit_gen_request` 외 15개 | `routers/gen_requests.py`·`main.py` |
| `generation_media_cache.py`(200줄) | 원격 미디어 byte-cache 흐름(부분 성공 정산) | `cache_generation_media` | `routers/generation.py`·`services/media_preservation.py`(역방향 간선, §5) |
| `generation_personal_meta.py`(175줄) | 색·태그 배치 저장(로컬/팀 shadow 분리) | `set_tags_batch`·`set_colors_batch` | `routers/generation.py` |
| `hf_missing.py`(129줄) | HF 원본 누락분 휴지통 이동 흐름 | `trash_missing_generations` | `routers/generation.py` |
| `generation_locate.py`(118줄) | 선택 생성물의 현재 라이브러리 위치 해석(읽기 전용) | `locate_generations` | `routers/library.py` |

### 2.4 repo (`backend/app/repo/`, 44파일 — `__init__.py` 는 `from .X import *` 전량 re-export 파사드)

**생성물 코어 — 읽기·쓰기·행 보강**

| 파일 | 약 줄 | 한 줄 책임 | 주 진입점 |
|---|---:|---|---|
| `_common.py` | 111 | 공용 상수·헬퍼(`new_id`, `clean_folder_path`, `GEN_BASE_JOINS`) | 모듈 상수 직접 import |
| `_visibility.py` | 60 | 팀 가시성·알림 가시성 SQL 조각의 단일 출처 | `team_generation_visibility_clause` |
| `generation_rows.py` | 270 | 조회 결과에 asset/ref/tag/공유/계보/코멘트뱃지 붙이기 + 단건·배치 페치 | `_attach_children`·`_fetch_generation`(내부 전용) |
| `generations_query.py` | 474 | 목록·단건·통계·코멘트수·메트릭(읽기 전용) | `repo.list_generations`·`get_generation`·`generation_stats` |
| `generations.py` | 1090 | 로컬 생성·상태 전이·재조정·색/태그/최종·삭제(쓰기) | `repo.create_local_generation`·`set_status`·`delete_generation` |
| `generation_delete.py` | 37 | generation 본체+자식행 물리 삭제 저수준 1함수 | `delete_generation_rows` |
| `generation_references.py` | 39 | reference upsert/link 공용 쓰기 헬퍼(비공개) | `_upsert_reference`·`_link_reference` |
| `generation_sync.py` | 499 | CLI 결과 → 로컬 generation 동기화(단건/배치), known-job 경계 | `repo.upsert_synced_generation`·`apply_synced_jobs` |
| `facets.py` | 82 | 필터 사이드바 facet(컬러·태그·자동태그·워커) | `repo.get_facets` |
| `sources.py` | 170 | 스포트라이트 @/# 피커의 소스 검색 | `repo.search_sources` |
| `assets.py` | 756 | 분리창 파일 메타 + 에셋 코멘트·생성본 코멘트 두 스레드 전체 | `repo.get_asset_meta`·`list_generation_comments`(33개) |

**생성 요청 원장·감사**

| 파일 | 약 줄 | 한 줄 책임 | 주 진입점 |
|---|---:|---|---|
| `gen_requests.py` | 1494 | 생성요청 예약(preparing)→활성화→claim→추적→복구조사→재큐 | `repo.reserve_*`·`activate_*`·`claim_*` |
| `event_journal.py` | 194 | 장기 보관 생성 상태 이력 + 감사 기록 | `repo.record_generation_event`·`record_audit_event` |
| `history_import_audit.py` | 132 | 계정별 과거 이력 gap·자동 보충 감사 상태 | `repo.get_history_import_audit` |

**계보**

| 파일 | 약 줄 | 한 줄 책임 | 주 진입점 |
|---|---:|---|---|
| `lineage.py` | 265 | 부모/자식 엣지 기록·제거, 전이축소, 깊이 | `repo.add_history_edge`·`record_derived_parents` |
| `history.py` | 221 | 가계 조회 공개 API(체인·그래프) | `repo.get_history`·`get_history_graph` |

**신원·계정·권한(repo 부분 — 최상위 파일은 §2.1)**

| 파일 | 약 줄 | 한 줄 책임 | 주 진입점 |
|---|---:|---|---|
| `identity.py` | 1212 | worker·app_setting·creator·provider 신원 + 워크스페이스 등록부·멤버·크레딧 요약 | `repo.get_my_uid`·`list_members`·`list_workspace_options` |
| `accounts.py` | 281 | 로그인 계정 CRUD·인증·전역역할·숨김 | `repo.register`·`authenticate` |
| `super_admin_sessions.py` | 106 | 10분 슈퍼관리자 세션 발급·조회·회수 | `repo.issue_super_admin_session` |
| `project_membership.py` | 108 | 워크스페이스 자기보고 → 프로젝트 멤버 자동편입/수동제외 | `enroll_workspace_members_into_project` |

**공유·발행·원본보존**

| 파일 | 약 줄 | 한 줄 책임 | 주 진입점 |
|---|---:|---|---|
| `share.py` | 745 | publish/unpublish·최종(골드)·보류 전이·번들 export/import | `repo.publish`·`export_bundle` |
| `share_state_intents.py` | 698 | 서버 권위 상태 ↔ 로컬 미러 desired-state 원장(write-ahead) | `repo.prepare_share_state_intents`·`claim_due_share_state_intents` |
| `media_preservation.py` | 215 | 공유·최종 생성물 원본 보존 작업 상태(claim/finish/재시도) | `repo.request_media_preservation` |
| `release_update_notices.py` | 203 | 릴리스 공지 upsert·고정·발표·읽음 | `repo.upsert_release_update_notice` |

**개인 메타·앵커·캔버스 부속**

| 파일 | 약 줄 | 한 줄 책임 | 주 진입점 |
|---|---:|---|---|
| `id_resolve.py` | 311 | 로컬 id ↔ 서버 앵커(job_id) 정규화 + 색/태그 오버레이 | `repo.resolve_local_id`·`personal_meta_by_anchor` |
| `personal_meta_transactions.py` | 53 | 개인 메타 로컬행 + 팀 shadow 를 한 트랜잭션으로 쓰는 경계 | `apply_generation_personal_meta_writes` |
| `tags.py` | 287 | 태그/자동태그(별도 네임스페이스) 생성·설정·배치·전역삭제 | `repo.set_tags`·`create_auto_tag` |
| `generation_views.py` | 121 | "마지막으로 크게 본" 개인 표시 | `repo.record_generation_view` |
| `scene_cards.py` | 140 | 캔버스 카드 ↔ 생성물 소속 사실 | `repo.list_scene_card_links` |
| `scenes_backup.py` | 130 | 캔버스 씬 localStorage 의 DB 미러 | `repo.list_scene_backups` |

**프로젝트·워크스페이스(repo 부분)**

| 파일 | 약 줄 | 한 줄 책임 | 주 진입점 |
|---|---:|---|---|
| `projects.py` | 961 | 프로젝트 CRUD·정렬·귀속·멤버·역할 + 폴더/검토 카운트 집계 | `repo.list_projects`·`folder_counts*` |
| `workspace_assignments.py` | 312 | 생성물의 워크스페이스 귀속 수동 보정(계획·배치 적용) | `repo.plan_generation_workspace_batch` |

**휴지통**

| 파일 | 약 줄 | 한 줄 책임 | 주 진입점 |
|---|---:|---|---|
| `trash.py` | 854 | 삭제 generation 을 별도 DB(`content_hub_trash.db`)로 원자 이동·복원·목록·정리 | `repo.move_to_trash*`·`restore_from_trash` |

**PM 대시보드 사이드카(repo 부분, `CONTENT_HUB_MANAGE` 게이트)**

| 파일 | 약 줄 | 한 줄 책임 | 주 진입점 |
|---|---:|---|---|
| `manage.py` | 1023 | PM 파사드 — 폴더·대시보드 요약·기획·완료본 export·생성물 링크 | `manage.dashboard_summary`·`link_generations` |
| `manage_tasks.py` | 1297 | 작업 조회·자동 폴더 작업·담당자 배정·CRUD·순서·배치삭제 | `manage.list_tasks`·`sync_folder_tasks` |
| `manage_schema.py` | 733 | 사이드카 테이블·멱등 마이그레이션 경계(모든 manage 모듈이 먼저 부름) | `ensure_manage_schema` |
| `manage_credit_plan.py` | 756 | 크레딧 풀·그룹 한도·긴급충전·기간 계산 + 대시보드 읽기 모델 | `manage_credit_plan.get_settings`·`plan_view` |
| `manage_member_table.py` | 133 | 관리 표 읽기 — 계정(이메일) 한 줄에 그룹·프로젝트 역할·HF 플랜·사용량 조인. **쓰기 없음**. uid 없는·어긋난 계정은 `project_lock` | `member_table` |
| `manage_transactions.py` | 483 | 계정 크레딧 거래 적재 + 생성물 근접 매칭 | `manage_transactions.record_transactions` |
| `manage_telemetry.py` | 395 | 로컬 텔레메트리 outbox 저장·조회·전송 정산 | `manage_telemetry.mark_telemetry_dirty*` |
| `manage_account_reports.py` | 310 | 계정 상태·거래 보고의 내구성 outbox(재시도·409·dead-letter) | `manage_account_reports.queue_account_reports` |
| `manage_analytics.py` | 132 | 시계열·작업자/프로젝트 매트릭스 읽기 모델 | `manage_analytics.timeseries`·`matrix`·`breakdown` |
| `manage_task_activity.py` | 268 | 작업 목록 전용 메타 병합(뷰어 정규화·캐시키·폴더 소스·컷) | `manage_task_activity.load_activity_snapshot` |
| `manage_task_previews.py` | 71 | 작업의 본인 미리보기(로컬 DB만 읽음) — 파사드가 유일하게 이름 지정 import | `repo.local_task_previews` |

### 2.5 services (`backend/app/services/`, 66파일) + resources (`backend/app/resources/resolve/`, 2파일)

**공용 기반(leaf — repo·routers 를 모른다)**

| 파일 | 한 줄 책임 | 주 진입점 |
|---|---|---|
| `atomic_io.py` | 같은 폴더 tmp→`os.replace` 원자 텍스트 쓰기 | `active_account`·`db_backup`·서비스 7곳 |
| `async_tools.py` | `to_thread_non_abandon`(§6 계약) | 라우터 9곳 + 서비스 7곳 |
| `path_safety.py` | `safe_join`·`path_comparison_key`(traversal 차단) | `main`·`_proxy`·`assets`·`library`·`manage` |
| `net_guard.py` | SSRF: `assert_public_http_url`·`guarded_opener`·TLS strict 해제 | `library`·`manage`·`publish`·`comfy_client`·`media_cache` |
| `request_guards.py` | 로컬 전용 라우트 출처 가드 3종(§6) | `main`·라우터 10곳 |
| `operational_logging.py` | JSON 회전 로그 + 비밀값 redact + `log_event` | `main`·라우터 6곳·서비스 9곳 |
| `sqlite_db.py` | 허브 DB 형식·무결성 검증(`validate_hub_db`) + 읽기 전용 SQLite URI(`read_only_uri` — `f"file:{path}?mode=ro"` 로 손수 조립하지 않는다: 경로의 `#`·`%` 에서 깨진다. 안에서 `Path.resolve()` 도 쓰지 않는다: 네트워크 드라이브를 UNC 로 바꿔 SQLite 가 거부한다) | `db_backup`·`db_transfer`·`backup*`·`worker_backup`·`test_snapshot` |
| `media_types.py` | 이미지/영상/오디오 확장자 상수 + 판정 | 서비스 7곳·`assets`·`library`·`repo/sources` |
| `asset_paths.py` | Assets 내장 프로젝트명·메타키 변환 | `assets_metadata` |
| `read_utf8_sig_first_line.py` | BOM 허용 첫 줄 읽기 + CLI 진입점 | `main`·`console`·`ingest`·`release_update` |
| `shared_connection.py` | 공유 서버 주소·설정 키 단일 출처 | `_proxy`·`publish` |
| `event_journal.py` | 장기 이력/감사 기록 어댑터(실패해도 본업 안 막음) | repo facade·라우터 8곳 |

**인증·세션**

| 파일 | 한 줄 책임 | 주 진입점 |
|---|---|---|
| `auth.py` | pbkdf2 비밀번호 해시 + HMAC 무상태 세션 토큰 | `deps`·`main`·`routers/auth`·`repo/accounts` |
| `local_agent_pair.py` | test_dev 전용 브라우저↔로컬 에이전트 세션 페어링(운영은 no-op) | `routers/auth`·`ingest` |

**Higgsfield CLI · 동기화 · 에이전트**

| 파일 | 한 줄 책임 | 주 진입점 |
|---|---|---|
| `cli_bridge.py`(1129줄) | `higgsfield` CLI asyncio subprocess 경계·필드 매핑·모델/비용 캐시 | `main`·`generation`·`ingest`·`manage`·`sync`·usecases |
| `syncer.py` | 주기 `generate list` 끌어오기 + 유령 카드 정리 + WS push | `main`·`generation`·`ingest`·`sync` |
| `mcp_ingest.py` | MCP `show_generations` → CLI list 형태 변환 | `ingest`·`history_autofill`·`backfill_import` |
| `higgsfield_history.py` | MCP 커서 기반 과거 이력 페이지 조회(HTTP/SSE) | `history_autofill` |
| `history_autofill.py` | 이력 보충 오케스트레이션(gap·쿨다운·startup audit·잠금) | `main`·`ingest`(hook 주입) |
| `agent_signals.py` | 계정별 롱폴 이벤트 레지스트리(`/api/agent/wait`) | `main`·`auth`·`gen_requests`·`ingest`·`publish` |

**미디어 · 썸네일 · 각인**

| 파일 | 한 줄 책임 | 주 진입점 |
|---|---|---|
| `media_cache.py`(721줄) | 원격 미디어 로컬 캐시·출처 보존·LRU/쿼터·썸네일 소스 캐시 | `main`·`library`·`manage`·repo·usecase |
| `media_preservation.py` | 공유·최종본 원본 보존 백그라운드 처리기 | `main`·`generation`·`share`·repo |
| `thumbs.py` | 썸네일/비디오 포스터 생성·디스크 캐시·prewarm·eviction | `main`·`library` |
| `thumbnail_repair.py` | MCP 가 잘못 박은 영상 포스터를 기동 시 1회 교정 | `main` |
| `file_stamp.py` | 내보내는 파일에 gen_id/job_id/hub 각인(재인코딩 없음) | `library`·`manage` |
| `video_convert.py` | Comfy Cloud 호환 MP4 재인코딩 + `find_ffmpeg`(ffmpeg 위치의 단일 조회 — `CONTENT_HUB_FFMPEG` 우선) | `comfy`·`thumbs`·`file_stamp` |
| `temp_sweeper.py` | 주기 임시 잔재 청소(.part/.tmp/comfy input) | `main` |

**Assets(파일 탐색기)**

| 파일 | 한 줄 책임 | 주 진입점 |
|---|---|---|
| `asset_io.py` | 청크 업로드 저장·지문·중복 탐색·충돌 없는 확정 | `routers/assets` |
| `asset_mounts.py` | 계정별 마운트 JSON 저장소(파일 잠금 + 원자 저장) | `routers/assets` |
| `asset_tree.py`(302줄) | 폴더 트리 재귀 탐색 + TTL 캐시 + 무효화 | `routers/assets` |
| `asset_watcher.py`(881줄) | watchdog 감시 → 캐시 무효화 + `assets_changed` WS 브로드캐스트 | `main`·`projects` |
| `project_folders.py` | 프로젝트 Render 루트 상태·폴더 트리 TTL 캐시·탐색기 열기 | `manage`·`asset_tree` |

**ComfyUI**

| 파일 | 한 줄 책임 | 주 진입점 |
|---|---|---|
| `comfy_client.py`(658줄) | Comfy 로컬/Cloud HTTP(urllib) — 제출·폴링·/view 스트리밍 | `routers/comfy` |
| `comfy_workflow.py` | API 포맷 워크플로 파싱(파라미터/미디어 슬롯 감지) | `routers/comfy` |
| `comfy_run_journal.py` | 미회수 실행 원장 로컬 I/O(네트워크 미소유) | `routers/comfy` |

**DaVinci Resolve(16파일 + 리소스 2)**

| 파일 | 한 줄 책임 | 주 진입점 |
|---|---|---|
| `resolve_transfer.py`(784줄) | 생성물 원본을 `Render/<folder>` 로 모으고 manifest 기록 | `resolve_integration`·`release_update`·`selection_monitor` |
| `resolve_bridge.py`(1325줄) | Media Pool 조작 계층 — 상대 import 0(자식 프로세스 겸용, §5-a) | `probe`·`import_worker`·`status_runner`·`selection_worker`·`diagnostics` |
| `resolve_status_runner.py` | fusionscript 작업을 자식 프로세스로 격리·인터프리터 폴백 | `resolve_integration`·`diagnostics`·`selection_monitor` |
| `resolve_probe.py` | 연결 상태 검사 자식 프로세스 진입점(`-m`, §2.6) | `resolve_status_runner` |
| `resolve_import_worker.py` | 가져오기 자식 프로세스 진입점(§2.6) + `AttemptJournal` | `resolve_status_runner` |
| `resolve_selection_monitor.py`(543줄) | 선택 감시 자식의 수명·WS 전달·일시정지 컨텍스트 | `main`·`resolve_integration` |
| `resolve_selection_worker.py` | Media Pool 선택을 읽는 장기 자식(JSONL 1줄, §2.6) | `resolve_selection_monitor` |
| `resolve_queue.py`(33줄) | 큐 v3 잔재 중 남은 `run_non_abandon` 하나뿐 | `resolve_integration`·`selection_monitor` |
| `resolve_lock.py` | 기기 락 파일 경로·host_id·프로세스 생성시각 | `resolve_integration` |
| `resolve_transfer_gate.py` | 릴리스 업데이트 ↔ 전송 프로세스 간 상호 배제(핸들 락) | `resolve_integration`·`import_worker`·`resolve_transfer` |
| `resolve_diagnostics.py` | 설치·Python·API·연결을 분리해 읽기 전용 진단 | `resolve_integration` |
| `resolve_script_installer.py` | Scripts 메뉴에 Exporter/Importer 설치(원자 교체·백업) | `resolve_integration`·`diagnostics` |
| `resolve_python_registry.py` | 레지스트리에서 설치된 64비트 Python 조사 | `diagnostics`·`status_runner` |
| `resolve_python_installer.py` | 호환 Python 없는 PC 용 반자동 설치(고정 SHA256) | `resolve_integration` |
| [`resources/resolve/MVHub_Clip_Exporter.py`](../backend/app/resources/resolve/MVHub_Clip_Exporter.py)(1205줄) | Resolve 메뉴 독립 스크립트 — 타임라인 구간을 Render Queue 로(§2.6) | Resolve Workspace>Scripts |
| `resources/resolve/MVHub_Importer.py`(718줄) | Resolve 메뉴 독립 스크립트 — 허브 manifest 를 Media Pool 로(§2.6) | Resolve Workspace>Scripts |

**백업 · 복원 · DB 이동**

| 파일 | 한 줄 책임 | 주 진입점 |
|---|---|---|
| `backup.py`(522줄) | DB 세트 자동 백업(ATTACH 다중 DB 온라인 스냅샷)·회전·주기 워커 | `main`·`db_transfer`·`operational_health` |
| `backup_verify.py` | 백업 복원 훈련(별도 파일 복원 후 무결성·FK·행수) | `restore_runtime_verify`·tools |
| `restore_runtime_verify.py` | 복원 사본으로 격리 서버 기동·로그인·행수 검증 | tools 전용(`server_move`·`verify_backup_restore`) |
| `worker_backup.py`(1329줄) | 작업자 개인 DB 백업 세트의 공유 서버 자동 전달(별도 프로세스, §2.6) | `main`·`comfy`·`db_transfer` |
| `db_scrub.py` | 전송/테스트 스냅샷용 비밀값 정제 프로파일 2종 | `db_transfer`·`test_snapshot`·`worker_backup` |
| `test_snapshot.py` | 서버형 테스트용 다중 SQLite 스냅샷 ZIP 생성·검증·설치 | `main`·`db_transfer`·tools |

**공유 서버 · 발행 · 텔레메트리**

| 파일 | 한 줄 책임 | 주 진입점 |
|---|---|---|
| `share_state_reconciler.py`(707줄) | 서버 권위 상태를 로컬 공유/골드 미러에 수렴시키는 워커 | `main`·`publish`·`share` |
| `telemetry_drain.py` | PM 텔레메트리 outbox → 원격 서버 또는 격리 로컬 DB | `_telemetry`·`generation`·`manage`·`projects` |
| `account_report_delivery.py` | 계정 상태·크레딧 거래 outbox 행별 전송·ACK 정산 | `_telemetry` |
| `remote_realtime.py` | 공유 서버 WS 신호를 로컬 허브 WS 로 중계(데이터 없는 reload 만) | `main` |
| `server_relocation.py` | 서버 이사 공지 읽기/발행 — 자식 프로세스 스크립트 겸용(§2.6) | `main`·`publish` |

**운영 · 업데이트 · 입구 제한**

| 파일 | 한 줄 책임 | 주 진입점 |
|---|---|---|
| `operational_health.py` | 운영 진단 집계 + `OperationalAlertTracker`(반복 억제) | `main`·`release_update` |
| `runtime_metrics.py` | 요청 지연·RSS(ctypes PSAPI)·디스크 TTL 스냅샷 | `main`·`db` |
| `release_update.py`(699줄) | 작업자 릴리스 설치본 자기 업데이트 상태·게이트·실행기 | `comfy`·`console`·`gen_requests`·`resolve_integration` |
| `upload_limits.py` | 업로드 파일 수/크기/본문 상한 + ASGI 미들웨어 | `main`·`comfy`·`db_backup`·`db_transfer` |

**기타**

| 파일 | 한 줄 책임 | 주 진입점 |
|---|---|---|
| `final_export.py` | 완료 탭 저장 '대상 판정' 순수 정책 단일 출처 — 종류 `final`(최종) · `shared`(공유 중·최종 아님, 보류 포함). 두 집합은 겹치지 않는다 | `manage` |

### 2.6 숨은 진입점

- `python -m app.services.resolve_probe` — Resolve 연결 상태 검사 자식 프로세스(`resolve_status_runner.py` 가 기동)
- `python -m app.services.resolve_import_worker` — Resolve 가져오기 자식 프로세스
- `resolve_selection_worker.py` — Media Pool 선택 감시 장기 자식(`resolve_selection_monitor.py` 가 기동, JSONL 1줄 IPC)
- `resolve_bridge.py` — **상대 import 금지**(부모·자식 양쪽에서 로드됨). import 한 줄만 추가해도 자식 실행이 깨진다
- `server_relocation.py <source>` — 자식 프로세스 스크립트 겸용, 최상단 상대 import 금지
- `worker_backup.py` 의 `_main`(별도 프로세스) — 작업자 개인 DB 백업 세트 전달
- `resources/resolve/MVHub_Clip_Exporter.py`·`MVHub_Importer.py` — Resolve Workspace›Scripts 메뉴에서만 진입(외부 무의존)
- `read_utf8_sig_first_line.py` — `print()` 가 자식 프로세스 IPC 채널로 쓰이는 모듈 중 하나(§5 참고)

프런트엔드 쪽 숨은 진입점(`?embed=`, 커스텀 이벤트)은 §3.5 참고.

### 2.7 `backend/` 바로 밑의 실행 스크립트 (`backend/app` 밖)

| 파일 | 한 줄 책임 | 주의 |
|---|---|---|
| `backend/serve.py` | **서버 기동기** — IPv4(0.0.0.0)와 IPv6 루프백(::1)을 함께 듣는다(Windows `localhost` 의 IPv6 우선 폴백 지연 제거). 호스트·포트는 `app.config` 의 `HOST`/`PORT` 상수를 받아 쓰고, SSL 인증서·접근 로그 환경변수만 여기서 직접 읽는다. `app` import 전에 stdout 을 `errors="replace"` 로 바꿔 cp949 로그에서 em dash 한 글자가 기동을 죽이는 것을 막는다 | `--reload` 금지. 워치독·supervisor·`stop_local_hub_on_port.ps1` 이 이 프로세스를 대상으로 삼는다 |
| `backend/reset_db.py` | ⚠ **DB 완전 초기화**(content·trash·계정별 DB·`active.json`). 기본은 점검(dry-run), `--yes` 일 때만 백업 후 삭제 | 사용자 데이터를 지운다 — 검증용으로 돌리지 않는다. 허브/서버를 멈춘 뒤에만 |
| `backend/backfill_import.py` | 과거 이력 전체 백필 — MCP 로 덤프해 둔 JSON 을 `cli_bridge.parse_job` → `repo.upsert_synced_generation` 으로 멱등 import(허브 본체와 분리된 독립 도구) | `--dry-run` 있음. 실제 DB 에 쓴다 |
| `backend/cleanup_orphan_creators.py` | 계정 없는 외부 생성자('팀원')와 그 생성물 점검·귀속 전환. 표준 라이브러리만 | 기본 점검만, `--apply` 일 때만 변경. 공유 서버 PC 에서 실행 |
| `backend/schema.sql` | 콘텐츠 DB 의 기본 스키마(테이블 전체 목록은 [inventory/db_tables.md](inventory/db_tables.md)) | 이후 변경은 `db_migrations.py` |

---

## 3. 프런트엔드

### 3.1 최상위 (`frontend/src/`)

| 파일 | 한 줄 책임 | 비고 |
|---|---|---|
| `App.tsx` | 화면 조립·탭/필터 상태·데이터 로딩·씬 생성 오케스트레이션·모든 액션 훅 배선 | 약 2,331줄. 핵심: `submitGenJobs`·`generateCards`·`onPromptCreated`·`trayBinding` |
| `api.ts` | 타입 안전 API 클라이언트(`/api` 프록시), 100여 메서드 | 약 859줄 |
| `types.ts` | 백엔드 모델과 1:1 타입 56개 | 약 513줄 |
| `main.tsx` | 부트스트랩 — `?embed=` 로 App/AssetsWindow/ManageWindow 분기, 테마 선적용 | §3.5 |
| `styles.css` | `styles/*.css` 12개 @import 목록만 | |
| `vite-env.d.ts` | Vite 타입 참조 1줄 | |

### 3.2 components (`frontend/src/components/`, 147파일)

#### 씬 캔버스 보드 셸(`scene/` 최상위, 5파일)

| 파일 | 한 줄 책임 | 주 진입점 |
|---|---|---|
| `scene/SceneBoard.tsx` | 캔버스 전체 소유 — 카드·엣지·그룹 state, 드래그/마퀴/가위/줌, undo, comfy 실행, 렌더링 | 약 4,452줄. `SceneBoard({...55 props})`·`actionRef` |
| `scene/SceneBar.tsx`(286줄) | 씬 탭 바 — 전환·추가·이름변경·삭제·드래그 순서변경·우클릭 메뉴 | `SceneBar` |
| `scene/SceneMinimap.tsx`(184줄) | 우상단 네비게이터 — 카드 축소도·뷰포트 박스, 클릭/드래그 이동 | `SceneMinimap` |
| `scene/sceneColors.ts`(10줄) | `CARD_W/CARD_H`·`GROUP_COLORS` 상수(순환 import 회피용 분리) | 상수 3개 |
| `scene/LastViewedBadge.tsx`(25줄) | "Last viewed" 유리 칩 1개 | `LastViewedBadge()` |

#### 카드 본문(`scene/cards/`, 12파일 — 셸은 SceneBoard 소유)

| 파일 | 한 줄 책임 | 주 진입점 |
|---|---|---|
| `cards/GenerationCard.tsx`(336줄) | 생성 카드 본문 — HistoryBoardNode 위임 + 배치바·태그편집·복구버튼 | `GenerationCard` |
| `cards/ComfyCard.tsx`(556줄) | Comfy 노드 본문 — 워크플로 로드·파라미터 인라인 컨트롤·실행바·출력 썸네일 | `ComfyCard` |
| `cards/ListCard.tsx`(272줄) | 리스트(동종 수집기) — 생성물 행 / 텍스트 행 / 레퍼런스 썸네일 3분기 | `ListCard` |
| `cards/RenderCard.tsx`(195줄) | 렌더(배치 생성) — 체크박스 달린 생성물 행 + Render 실행바 | `RenderCard` |
| `cards/TextCard.tsx`(186줄) | 텍스트 노드 — textarea 편집(캐럿 복원) + @토큰 인라인 미리보기 | `TextCard` |
| `cards/ReferenceCard.tsx`(126줄) | 레퍼런스 카드 — 썸네일 격자·정보/미리보기 | `ReferenceCard` |
| `cards/HeadCard.tsx`(121줄) | 제목(Head) 노드 — 글씨 크기·색 팝오버 | `HeadCard` |
| `cards/SetCard.tsx`(100줄) | Set 노드 — 폴더 드롭 + 태그 텍스트 | `SetCard` |
| `cards/ViewCard.tsx`(82줄) | View 노드 — 합쳐진 영상 미리보기·텍스트 모달 진입 | `ViewCard` |
| `cards/ModelCard.tsx`(73줄) | 모델 노드 — 저장된 모델·파라미터 표시, 그룹 차단 표시 | `ModelCard` |
| `cards/InputCard.tsx`(68줄) | Input(무선 수신) — output 채널 선택 | `InputCard` |
| `cards/OutputCard.tsx`(52줄) | Output(무선 발신) — 채널 이름 발행 | `OutputCard` |

#### 캔버스 팝업·모달(`scene/`, 6파일)

| 파일 | 한 줄 책임 | 주 진입점 |
|---|---|---|
| `scene/SceneVariantPopup.tsx`(563줄) | 결과 모아보기 팝업 — 다중선택·대표지정·액션바·드래그 재사용 | `SceneVariantPopup` |
| `scene/ViewTimeline.tsx`(419줄) | View 연속재생 플레이어 — 클립 이어보기·스크럽·전체화면·병합 다운로드 | `ViewTimeline` |
| `scene/SceneComfyModal.tsx`(202줄) | Comfy 워크플로 JSON 로드 + 노출 파라미터 체크리스트 | `SceneComfyModal` |
| `scene/SceneWorkspaceMenu.tsx`(177줄) | 씬 탭 우클릭 메뉴 — 이름 변경 + 워크스페이스 지정 | `SceneWorkspaceMenu` |
| `scene/SceneModelModal.tsx`(136줄) | 모델 노드 설정 모달 — SpotlightOptionsBar 재사용 | `SceneModelModal` |
| `scene/ViewSequencePreview.tsx`(73줄) | View 카드 안 호버 연속재생 미리보기 | `ViewSequencePreview` |

#### 하단 프롬프트 도크(`spotlight/` + `SpotlightPrompt.tsx`, 10파일)

| 파일 | 한 줄 책임 | 주 진입점 |
|---|---|---|
| `SpotlightPrompt.tsx`(1,376줄) | 프롬프트 도크 본체 — contentEditable 편집, @/# 피커, 트레이·씬 카드 양방향 바인딩 | `SpotlightPrompt`(forwardRef)·`SpotlightPromptHandle` |
| `spotlight/SpotlightOptionsBar.tsx`(447줄) | 모델·타입·파라미터 칩/드롭다운/고급 옵션 | `SpotlightOptionsBar` |
| `spotlight/useSpotlightSubmit.ts`(293줄) | 제출 1건 — 검증·body 조립·배치 병렬 create·캔버스 링크 정산·히스토리 저장 | `useSpotlightSubmit`·`SPOTLIGHT_MAX_COUNT` |
| `spotlight/ServerConsolePanel.tsx`(297줄) | 상태줄 + Host 콘솔 창(버전·CLI·로그 꼬리·앱 종료) | `ServerConsolePanel`·`LogTail` |
| `spotlight/SpotlightRefTray.tsx`(226줄) | 확장(+) 레퍼런스 트레이 — 드롭·순서변경·역할 배지 | `SpotlightRefTray` |
| `spotlight/SpotlightMentionPicker.tsx`(152줄) | @/# 피커 목록(트레이 항목 + 소스 + 태그) | `SpotlightMentionPicker` |
| `spotlight/SpotlightPromptRow.tsx`(92줄) | 프롬프트 입력 행(순수 프레젠테이션) | `SpotlightPromptRow` |
| `spotlight/SpotlightOptionIcon.tsx`(85줄) | 옵션 이름 → SVG 아이콘 매핑 | `SpotlightOptionIcon` |
| `spotlight/SpotlightGenerateControls.tsx`(77줄) | 배치 수·비용·생성 버튼 줄 | `SpotlightGenerateControls` |
| `spotlight/SpotlightRefRoleMenu.tsx`(45줄) | 트레이 우클릭 역할 메뉴(포털) | `SpotlightRefRoleMenu` |

#### 라이브러리(생성물 그리드) 화면(최상위 + `generation/`, 18파일)

| 파일 | 한 줄 책임 | 주 진입점 |
|---|---|---|
| `ThumbnailGrid.tsx`(681줄) | 생성물 카드 가상 그리드 · 마퀴/키보드 선택 · 날짜 그룹 | `ThumbnailGrid` |
| `GenerationCard.tsx`(683줄) | 카드 1장(그리드/리스트 두 모드) · 호버 영상 · 드래그 | `GenerationCard`(memo) — 캔버스의 `scene/cards/GenerationCard.tsx` 와 이름만 같은 별개 파일(§5-b) |
| `MediaThumbnail.tsx`(157줄) | 영상 포스터/이미지/포스터 없는 영상 3분기 통합 표현 | `MediaThumbnail`(10곳 재사용) |
| `LibraryToolbar.tsx`(296줄) | 타입 필터·검토 필터·크기 슬라이더·리스트/그리드 토글·태그 패널 | `LibraryToolbar` |
| `FilterSidebar.tsx`(232줄) | 좌측 필터(프로젝트/컬러/자동태그/생성자/공유) 껍데기 | `FilterSidebar` |
| `SearchBox.tsx`(58줄) | 디바운스 검색 입력 | `SearchBox` |
| `TopBar.tsx`(150줄) | 상단바(로고·탭·동기화·검색·Assets·계정) | `TopBar` |
| `app/SelectionActionBar.tsx`(216줄) | 선택바 2종(`BoardSelectionActionBar`·`LibrarySelectionActionBar`) | 위 2개 |
| `app/AppOverlays.tsx`(113줄) | App 이 띄우는 오버레이 모음(미리보기·정보·비교…) 배선 | `AppOverlays` |
| `generation/GenerationCardStatusBar.tsx`(154줄) | 카드 하단 S/T/C 상태줄 + 태그 에디터 호스팅 | 〃 |
| `generation/GenerationCardIcons.tsx`(57줄) | 카드용 SVG 4종 | `ModelIcon` 외 |
| `generation/GenerationThumbOverlay.tsx`(122줄) | 썸네일 호버 오버레이(정보·미리보기·다운로드) | 〃 |
| `generation/GenerationConfirmOverlay.tsx`(33줄) | 공유/최종 확인 오버레이 | 〃 |
| `generation/GenerationReviewOverlay.tsx`(48줄) | 검토(공유/보류/반려) 확인 오버레이 | 〃 |
| `generation/ConfirmQuestion.tsx`(25줄) | 생성물 확인용 Yes/No 조각(중복 제출 방지 포함). 확인 UI 는 이것 말고도 `admin-confirm-*`·`GradeStepModal` 계보가 있다(§5-e) | 〃 |
| `TagEditor.tsx`(335줄) | 인라인 태그 에디터(칩·전역 태그·다중선택 적용 — 다중 선택에는 이 카드가 이미 가진 태그도 넘긴다) | `TagEditor` |
| `GradeStepModal.tsx`(37줄) | 등급 S 다중선택 확인 모달 | `GradeStepModal` |
| `GenCommentPanel.tsx`(123줄) | 생성물 코멘트 패널(seq 가드 보유 — §6 계약) | `GenCommentPanel` |

#### 계정·알림·설정·관리자 창(최상위 + `settings/` + `admin/`, 17파일)

| 파일 | 한 줄 책임 | 주 진입점 |
|---|---|---|
| `AccountMenu.tsx`(502줄) | 계정·워크스페이스 드롭다운(포털) | `AccountMenu` |
| `ManageAccount.tsx`(228줄) | 내 계정 플로팅 창(정보·표시이름) | `ManageAccount` |
| `NotificationCenter.tsx`(631줄) | 벨 + 알림 패널(코멘트·릴리스 공지 병합, 포털) | `NotificationCenter` |
| `SettingsPanel.tsx`(670줄) | 설정 플로팅 창 껍데기 + 생성물 점검/백필 | `SettingsPanel` |
| `settings/SettingsSections.tsx`(611줄) | 설정 4개 절(외형·다운로드 위치·메타 연속성·Resolve) | 4개 export |
| `settings/SettingsGroup.tsx`(164줄) | 설정 그룹 → 옆으로 펼치는 플라이아웃(포털·직접 위치계산) | `SettingsGroup` |
| `settings/SettingsDescription.tsx`(29줄) | 설명문 + `<details>` 더보기 | 〃 |
| `settings/ComfyConnectionSection.tsx`(178줄) | Comfy 연결 설정·확인 | 〃 |
| `settings/ComfyUnresolvedRunsSection.tsx`(51줄) | 미해결 Comfy 실행 목록 + 결과 회수·로컬 재저장·기록 정리 | 〃 |
| `ShortcutsWindow.tsx`(130줄) | 단축키 재지정 창 | `ShortcutsWindow` |
| `AdminWindow.tsx`(610줄) | 관리자 창(탭 호스트) + 권한 상승 확인 + 서버 이전 공지 | `AdminWindow` |
| `admin/ApprovalTab.tsx`(143줄) | 계정 승인·숨김·비번 초기화 표 | 〃 |
| `admin/MemberRolesTab.tsx`(82줄) | 전역 역할 표 | 〃 |
| `admin/RolePickers.tsx`(70줄) | 전역/프로젝트 역할 선택기 + 정렬 랭크 | 〃 |
| `admin/ProjectRenderTree.tsx`(29줄) | 프로젝트 렌더 폴더 트리 표시 | 〃 |
| `LoginScreen.tsx`(92줄) / `ServerLoginScreen.tsx`(230줄) | 로컬 AUTH 로그인 / 팀 서버 로그인·가입 | 각 컴포넌트 |

#### 공용 부품(`common/`, 11파일)

| 파일 | 한 줄 책임 | 쓰는 곳 수(실측) |
|---|---|---:|
| `FolderTreeView.tsx`(248줄) | 공통 폴더 트리(재귀 행·드롭·우클릭) | 8 |
| `CommentPanel.tsx`(301줄) | 코멘트 패널 UI(에셋·생성 공용) | 4 |
| `TagFilterPanel.tsx`(204줄) | 태그 필터 플로팅 패널 | 4 |
| `LibraryWorkspaceFilter.tsx`(241줄) | 워크스페이스 칩 필터 | 3 |
| `ViewControls.tsx`(106줄) | 크기 슬라이더 + 리스트/그리드 토글 | 4 |
| `ColorFilterDots.tsx`(69줄) | 색 점 필터 + 색 상수표 | 7 |
| `WorkspaceMark.tsx`(49줄) | 워크스페이스 색 표식(id 해시 색상) | 4 |
| `InlinePromptRefs.tsx`(70줄) | 프롬프트의 `@소스`를 썸네일 칩으로 | 3 |
| `ResizableSidebar.tsx`(105줄) | 폭 조절 사이드바 껍데기 | 2 |
| `FolderReviewCount.tsx`(18줄) | 폴더 검토 카운트 배지 | 1(`FolderTreeView` 전용 — 공용 폴더에 있지만 실제 공용 아님, §5-b) |
| `ViewIcons.tsx`(39줄) | 리스트/그리드 SVG · 작업 탭 "보관 기록" 아이콘(`ArchiveHistoryIcon` — 상자+시곗바늘) | 2(`ViewControls`·`manage/WorkBoard`) |

#### 미디어 보기·비교·부분수정(최상위 + `compare/` + `edit/`, 9파일)

| 파일 | 한 줄 책임 | 주 진입점 |
|---|---|---|
| `MediaPreview.tsx`(280줄) | 이미지/영상 미리보기 플로팅 창. 원본이 오는 동안 연 곳이 넘긴 썸네일(`PreviewItem.thumb`)을 그림은 바탕·영상은 표지로 깐다 | `MediaPreview`·`fitPreviewBox` |
| `InfoPopup.tsx`(548줄) | 생성 정보 팝업(드래그 이동·프롬프트·레퍼런스·오류). 크기가 바뀔 때마다 화면 아래로 넘치지 않게 올린다(끌어 옮긴 뒤에는 그대로). ★높이는 `offsetHeight` 로 — 열리는 애니메이션(scale 0.98) 중의 `getBoundingClientRect` 는 2% 작다 | `InfoPopup` |
| `CompareModal.tsx`(397줄) | 생성본 N개 비교(프롬프트 diff + 창 이동/리사이즈/최대화 + A/B 와이프) | `CompareModal` |
| `VideoCompareModal.tsx`(250줄) | 생성정보 없는 미디어 N개 비교(+ 같은 A/B 와이프) | `VideoCompareModal` — 이름과 달리 이미지도 다룸(§5-b) |
| `compare/CompareGenerationColumn.tsx`(209줄) | 비교 모달의 한 열(미디어·파라미터) | 〃 |
| `compare/CompareSourceLightbox.tsx`(29줄) | 비교 모달 위 원본 라이트박스 | 〃 |
| `edit/PartialEditModal.tsx`(965줄) | 부분 수정 캔버스(펜·도형·마스크·A/B) | `PartialEditModal` |
| `edit/PartialEditHost.tsx`(47줄) | `partialEdit` 이벤트 → 최신 Generation 조회 → 모달 개방 | `PartialEditHost`(§3.5 숨은 진입점) |
| `FloatingPrompt.tsx`(104줄) | `window.prompt` 대체 플로팅 입력 | `FloatingPrompt` |

#### Assets(구성) 화면(`assets/` + `sidebar/` + 최상위, 27파일)

| 파일 | 한 줄 책임 |
|---|---|
| `AssetsView.tsx`(932줄) | Assets 뷰 본체 — 가상 그리드·마퀴 선택·드롭 임포트·플로팅 패널 오케스트레이션 |
| `AssetsWindow.tsx`(27줄) | `?embed=assets` 분리 창 껍데기(§3.5) |
| `assets/AssetCell.tsx`(454줄) | 셀 1개(썸네일·호버 오버레이·상태줄) memo |
| `assets/AssetsCrumbBar.tsx`(216줄) · `AssetsSidebar.tsx`(62줄) · `FolderTree.tsx`(69줄) | 경로 빵부스러기 / 좌측 패널 / 폴더 트리(`common/FolderTreeView.tsx` 와 다른 에셋 전용 트리, §5-b) |
| `assets/AssetSortMenu.tsx`(95줄) · `MountManager.tsx`(205줄) | 정렬 드롭다운 / 외부 폴더 등록 창 |
| `assets/assetsViewModel.ts`(247줄) · `treeUtils.ts`(97줄) · `exportDrag.ts`(27줄) · `assetRefreshPolicy.ts`(26줄) | 순수 계산(필터·정렬·트리·OS 드래그·복귀 갱신 정책) |
| `assets/useAssetViewData.ts`·`useAssetMetaActions.ts`·`useAssetCommentActions.ts`·`useAssetFilterActions.ts`·`useAssetSelectionPersistence.ts`·`useAssetViewPersistence.ts`·`useAssetBroadcastSync.ts`·`useAssetDropImport.ts`·`useAssetProjectData.ts`·`useAssetViewerIdentity.ts`(10개, 806줄) | 컨테이너 훅 — 뷰 데이터·메타 저장·코멘트·필터·선택 영속·뷰 영속·브로드캐스트·드롭임포트·프로젝트 데이터·뷰어 신원(파일명 순서와 1:1) |
| `sidebar/ProjectSection.tsx`(930줄) | 프로젝트·폴더 사이드바(트리 파생·폴더 컨텍스트 메뉴·보관함) |
| `sidebar/CanvasFolderSidebar.tsx`(66줄) · `CreatorSection.tsx`(71줄) | 캔버스용 슬림 사이드바 / 생성자 필터 절 |
| `ProjectAssignMenu.tsx`(223줄) | 선택 결과물 → 프로젝트 담기 드롭다운(`useMenuPlacement` 유일 사용자) |
| `FolderIcon.tsx`(34줄) | 폴더 아이콘 SVG |

#### 히스토리 보드(`history/` + 최상위, 7파일)

| 파일 | 한 줄 책임 |
|---|---|
| `HistoryBoard.tsx`(669줄) | 가계 그래프 보드 — 팬/줌·선택·수동 배치 |
| `history/HistoryBoardNode.tsx`(307줄) · `HistoryRefNode.tsx`(40줄) · `HistoryBoardEdges.tsx`(91줄) | 노드 / 레퍼런스 노드 / 엣지 |
| `history/useHistoryGraph.ts`(39줄) · `useHistoryManualPositions.ts`(55줄) · `useHistoryBoardShortcuts.ts`(45줄) | 그래프 조회 / 수동 좌표 / 단축키 |

#### PM 대시보드(`manage/` + 최상위, 25파일)

| 파일 | 한 줄 책임 | 주 진입점 |
|---|---|---|
| `ManageWindow.tsx`(147줄) | `?embed=manage` 분리 창 + 탭 호스트(§3.5) | `ManageWindow` |
| `manage/DashboardView.tsx`(601줄) | 통합 대시보드(프로젝트 요약 + 에피소드/시퀀스 트리) | `DashboardView` |
| `manage/WorkspaceUsageDashboard.tsx`(1008줄) | 워크스페이스 사용 현황 · 머리글(＋프로젝트 · 관리 표 아이콘 · 보고서 내려받기 메뉴)(크레딧 링·추이 차트·멤버/모델 표) | `WorkspaceUsageDashboard`·`HoverMetric` |
| `manage/CreditPoolSection.tsx`(399줄) · `CreditPlanFields.tsx`(508줄) | 크레딧 풀 표시 / 그룹·충전 편집 창 | 각 절 |
| `manage/MemberTable.tsx`(264줄) | **관리 표** — 계정 한 줄에 등급·크레딧 그룹·프로젝트 참여·보고된 사실. 칸을 고치면 기존 API 로 즉시 저장(직렬 큐 → 큐가 비면 재조회). 설계 `docs/MEMBER_TABLE_DESIGN.md` | `MemberTable` |
| `manage/WorkBoard.tsx`(892줄) | 작업 탭 컨테이너 — 병합·필터·핸들러 주입. 머리글 오른쪽 = 검색 상자 · 보관 기록(아이콘) · 내 작업만 · 보기 전환 | `WorkBoard` |
| `manage/WorkFilterBar.tsx`(280줄) | 노션식 칩 필터 바(칩 · +필터) + 머리글에 놓이는 검색 상자 `WorkSearchBox` | 〃 |
| `manage/KanbanBoard.tsx`(179줄 — 폴더 자동 작업은 상태가 컷에서 파생되므로 끌 수 없다, 수동 작업만 끌기) · `TableView.tsx`(351줄) · `CalendarView.tsx`(206줄) · `MonthlyTaskCalendar.tsx`(190줄) | 작업 뷰 4종(프레젠테이션 전용, `WorkViewProps` 주입) — 소요시간 포맷터가 뷰마다 다름(§5-b) | 〃 |
| `manage/CutThumbs.tsx`(105줄) · `ColorTag.tsx`(35줄) | 컷 썸네일 / 색 라벨 | |
| `manage/ExportView.tsx`(279줄) | 완료 탭 — **공유 저장 · 최종 저장(골드)**. 위 = 판 하나(프로젝트·저장 위치 → 종류별 건수 → 단추) · 아래 = 저장 대상(종류 배지) ∣ 저장 이력(렌더 폴더 아래 경로만). 설계 `docs/EXPORT_SYNC_DESIGN.md` | |
| `manage/ProjectManagerPanel.tsx`(708줄) | 프로젝트 관리 오버레이(생성·편집·역할·보관·순서) | |
| `manage/ProjectMembersPanel.tsx`(236줄) · `ProjectPlanningDialog.tsx`(92줄) | 프로젝트 멤버 / 일정·예산 대화상자 | |
| `manage/ProjectDateRangePicker.tsx`(156줄) · `UsagePeriodPicker.tsx`(204줄) | 손으로 짠 달력 2종 | |
| `manage/types.ts`(314줄) | PM 타입 단일 출처(`WorkViewProps`·`Task`·`ManageSummary`…) | |
| `manage/manageColors.ts`(37줄) · `personalWork.ts`(78줄) · `taskPreviews.ts`(78줄) · `projectUsageHierarchy.ts`(121줄) · `usageSource.ts`(29줄) | 순수 계산(색 라벨·개인 작업 축소·미리보기 후보·에피소드/시퀀스 계층·출처 표기) | |

### 3.3 lib (`frontend/src/lib/`, 212파일 — 하위 디렉터리 없이 평평함)

역할 표기: `훅`=React import 있음 · `순수`=인자→값(React·fetch·localStorage·브라우저 전역 없음) · `브라우저`=React 는 안 쓰지만 창·문서·소켓·BroadcastChannel·리스너·타이머를 만진다(부작용 있음) · `store`=모듈 수준
가변 상태+구독 · `api`=HTTP IO · `저장`=localStorage IO.

**1. HTTP·API 계층(13)**

| 파일 | 역할 | 한 줄 책임 |
|---|---|---|
| `http.ts` | api | 토큰 보관 + 공용 `fetch` 래퍼 + `HttpError`(상태코드 보존) + 구서버 판별 |
| `url.ts` | 순수 | 경로 인코딩·쿼리 조립 |
| `batching.ts` | 순수 | 서버 배치 상한(500) 분할 |
| `assetUrls.ts` | 순수 | 에셋 트리·파일·썸네일·코멘트 URL 생성 |
| `assetsApi.ts` | api | 에셋 트리/메타/색·태그/마운트/DB 백업·복원 HTTP |
| `authApi.ts` | api | 로그인·계정 관리 HTTP |
| `comfyApi.ts` | api | Comfy 파싱·실행·저장·미회수 실행 HTTP |
| `manageApi.ts` | api | PM 대시보드·크레딧 플랜·작업 HTTP(+구서버 폴백) |
| `projectApi.ts` | api | 프로젝트·멤버·폴더·team-fresh HTTP(+요청 합류) |
| `sharedApi.ts` | api | 공유 서버 로그인·발행·주소 이사 HTTP |
| `updateNotices.ts` | api | 업데이트 공지 목록·확인·관리자 등록 HTTP |
| `releaseUpdate.ts` | api+store | 릴리스 업데이트 실행·폴링 문구·차단 사유 |
| `resolveTransfer.ts` | api | DaVinci Resolve 전송·진단·스크립트 설치 HTTP |

**2. 실시간·변경 전파·응답 정합(11)**

| 파일 | 역할 | 한 줄 책임 |
|---|---|---|
| `appEvents.ts` | 브라우저 | 전역 커스텀 이벤트·BroadcastChannel 이름 사전 + 발행 |
| `librarySync.ts` | store | 내 변경 id 추적 → WS 동기화 신호의 자기-echo/중복 reload 판정 |
| `libraryBroadcast.ts` | store | 생성물 변경을 창 간 즉시 통지(탭 id 로 자기창 제외) |
| `assetBroadcast.ts` | 브라우저 | Assets 창 간 `BroadcastChannel` 메시지 래퍼(WS 아님) |
| `progressSocket.ts` | 브라우저+api | 진행률 WS 연결·재접속 지연 계산 |
| `useManageRealtime.ts` | 훅 | 관리 창의 실시간 재조회 배선 |
| `manageRefreshPolicy.ts` | 순수 | 관리 창 안전망 재조회 여부 판정 |
| `useCustomEvent.ts` | 훅 | `ch:*` window 이벤트 구독(핸들러 ref 고정) |
| `mutationQueue.ts` | 순수 | 직렬/최신만/키별 변경 큐 3종 |
| `serialTaskQueue.ts` | 순수 | 화면 안 막는 1건씩 실행 큐 |
| `stateReconciliation.ts` | 순수 | 응답 JSON 구조 비교로 state 참조 유지(리렌더 억제) |

**3. 저장·localStorage(8)**

| 파일 | 역할 | 한 줄 책임 |
|---|---|---|
| `storage.ts` | 저장 | localStorage JSON/문자열 안전 읽기·쓰기 + prefix Store |
| `storageKeys.ts` | 순수 | localStorage 키 상수 사전 |
| `accountScope.ts` | 저장 | "지금 어느 계정 범위인가"(탭별) 네임스페이스 |
| `personalSettings.ts` | 저장 | 계정 전환 시 개인 설정 키 일괄 제거 |
| `deactivated.ts` | 저장 | 생성물·에셋·폴더 비활성(회색) 로컬 표시 |
| `theme.ts` | 저장 | 강조색 CSS 변수 파생·적용 + 언어·모션 설정 |
| `shortcuts.ts` | 저장 | 사용자 지정 단축키 레지스트리·충돌 판정 |
| `downloadDir.ts` | 저장 | File System Access 다운로드 폴더 핸들 |

**4. 계정·인증·워크스페이스(13)**

| 파일 | 역할 | 한 줄 책임 |
|---|---|---|
| `useHubAuth.ts` | 훅 | 로컬 허브·공유 서버 로그인 상태 통합 |
| `accountIdentity.ts` | 순수 | 계정 표시명·역할·시스템 계정 판정 |
| `useAccountStatus.ts` | 훅 | 하단 상태줄용 계정·CLI 연결·크레딧 |
| `workspaceContext.ts` | 저장 | 현재 워크스페이스 컨텍스트 보관·조정 |
| `workspaceCommand.ts` | 순수 | `#+`/`#-` 워크스페이스 명령 파싱 |
| `workspaceOptionsCache.ts` | store | 워크스페이스 목록 모듈 캐시 |
| `libraryWorkspaceScope.ts` | 순수 | 라이브러리 워크스페이스 필터 키·매칭 |
| `manageWorkspaceScope.ts` | 저장 | 관리·에셋 창이 따라갈 workspace id 안전 추출 |
| `useWorkspaceFilterOptions.ts` | 훅 | 툴바 워크스페이스 필터 목록 |
| `useManageCaps.ts` | 훅 | 이 사용자의 프로젝트 관리 역량 판정 |
| `useSyncStatus.ts` | 훅 | 텔레메트리·계정 보고 outbox 의 push 상태를 30초마다 폴링 |
| `useSpotlightAgentStatus.ts` | 훅 | 허브/에이전트 연결 점 상태 폴링 |
| `useGenerationWorkspaceActions.ts` | 훅 | 생성물 워크스페이스 이동 액션 |

**5. 모델 카탈로그·정책·비용(6)**

| 파일 | 역할 | 한 줄 책임 |
|---|---|---|
| `useModels.ts` | 훅 | 모델 목록·파라미터 제약·기본값·예상 크레딧 |
| `modelCatalog.ts` | store | job_set_type → 표시명 단일 사전(+폴백) |
| `modelCatalogCache.ts` | store | `/api/models` TTL 60초 + single-flight |
| `modelPolicy.ts` | store | 그룹 허용 모델 정책 구독·조회·캐시 |
| `modelPolicyCore.ts` | 순수 | 정책 키 계산·상태 전이·차단 문구(도메인) |
| `aspectAuto.ts` | 브라우저 | `aspect_ratio:"auto"` 를 모델별 실제 비율로 해석 |

**6. 생성 라이브러리 — 데이터·필터·진행(11)**

| 파일 | 역할 | 한 줄 책임 |
|---|---|---|
| `useGenerationLibraryData.ts` | 훅 | 목록 로드·페이징·seq 가드·동기화 판정(§6 계약 지점) |
| `useLibraryFilters.ts` | 훅 | 필터·뷰 상태(localStorage 백업) + 파생 쿼리 |
| `useLibraryPersistence.ts` | 훅 | 필터 저장 포맷·키·마이그레이션 |
| `libraryRequestPlan.ts` | 순수 | 목록·메타 조회를 같은 순간에 시작 |
| `appGenerationQuery.ts` | 순수 | 필터 → 서버 쿼리 객체·캐시 키 |
| `useLibraryCreators.ts` | 훅 | 생성자(작성자) 목록 조회 |
| `useGenerationAutoRefresh.ts` | 훅 | 활성 잡·team 탭 폴링 + 복귀 재조회(5초 가드) |
| `useGenerationProgress.ts` | 훅 | WS progress 한 건을 카드에 반영 |
| `resolveLibraryLocation.ts` | 순수 | "이 생성물이 몇 페이지에 있나" 위치 질의·병합 |
| `mediaTypes.ts` | 순수 | 미디어 필터 옵션 상수 |
| `appConstants.ts` | 순수 | 빈 facets·단축키 색 매핑 상수 |

**7. 생성 라이브러리 — 표시·판정(순수)(11)**

| 파일 | 역할 | 한 줄 책임 |
|---|---|---|
| `generationDisplay.ts` | 순수 | 상태 라벨·실패 사유 문구·날짜 포맷·공유 가능 판정 |
| `generationIssue.ts` | 순수 | 오류 문자열 → 표시용 사유 코드 분류 |
| `generationReview.ts` | 순수 | 공유&리뷰 필터·액션 노출 규칙 |
| `generationGrid.ts` | 순수 | 날짜 묶음 선택 토글·미리보기 대상 |
| `generationTags.ts` | 순수 | 태그 목록 정규화·일괄 추가/제거 계산 |
| `generationPrompt.ts` | 순수 | 구버전 직렬화 프롬프트 복원(API 경계) |
| `generationColorState.ts` | 순수 | 컬러 저장 오류 종류·다음 선택 색 |
| `gridVirtualRows.ts` | 순수 | 생성물 배열 → 가상 스크롤 행 모델 + 방향키 이동 |
| `dateGroups.ts` | 순수 | UTC 문자열/epoch → 로컬 날짜 그룹 키·라벨 |
| `gradeStep.ts` | 순수 | 등급 기반 다중선택 상태머신 |
| `useGradeStep.ts` | 훅 | 등급 선택 액션 배선 |

**8. 생성 라이브러리 — 액션 훅(전부 App.tsx 가 단일 호출자)(13)**

| 파일 | 역할 | 한 줄 책임 |
|---|---|---|
| `useGenerationCardActions.ts` | 훅 | 카드 재생성·복구 재실행·최종·삭제 등 주 액션 |
| `useGenerationTagActions.ts` | 훅 | 태그 추가/삭제(변경 큐 경유) |
| `useGenerationAutoTagActions.ts` | 훅 | 자동 태그 생성·삭제·선택 + `#+` 워크스페이스 칩 등록 |
| `useGenerationTrashActions.ts` | 훅 | 휴지통 이동·복구·영구삭제 |
| `useGenerationShareActions.ts` | 훅 | 팀 공유·미러 대기 안내 |
| `useGenerationProjectActions.ts` | 훅 | 프로젝트·폴더 담기 |
| `useGenerationFilterActions.ts` | 훅 | 색·태그 필터 토글, 태그 전역 삭제 |
| `useGenerationKeyboardActions.ts` | 훅 | 그리드 단축키(색·비활성 등) |
| `useGenerationUtilityActions.ts` | 훅 | 일괄 다운로드·히스토리·창 열기 |
| `useGenerationSelection.ts` | 훅 | 그리드 선택 집합·바깥 클릭 해제 |
| `usePromptCreatedActions.ts` | 훅 | 프롬프트로 생성 직후 후처리 |
| `bulkGenerationActions.ts` | 순수 | 일괄 실행기(`runGenerationBulk` — 주입받은 비동기 작업을 돌려 실패 수 집계, `runGenerationTrash` — 휴지통 전용: 공유 중 409 를 '건너뜀'으로 따로 센다) + 결과·확인 문구 |
| `shareMirrorPending.ts` | 순수 | 공유 미러 대기 안내 래핑 |

**9. 씬·캔버스 — 데이터·저장·복구(9)**

| 파일 | 역할 | 한 줄 책임 |
|---|---|---|
| `scenes.ts` | 저장+store | 씬(카드·연결·카메라) localStorage 데이터 계층 + 내보내기/가져오기 |
| `sceneBackup.ts` | api+store | 씬 localStorage → DB 단방향 미러·복구 |
| `sceneCardLinks.ts` | api+store | 카드 소속(담긴 생성물) 로컬 DB 기록·서버 병합 |
| `sceneUndoStore.ts` | store | 씬별 undo/redo 히스토리(언마운트 생존) |
| `sceneGenDataStore.ts` | store | genId → 생성물 캐시(언마운트 생존) |
| `sceneRecentDoneStore.ts` | store | '방금 생성됨' glow 상태(언마운트 생존, 버전 구독) |
| `sceneWorkspace.ts` | 순수 | 씬별 워크스페이스 지정·탭 순서 이동(연산 기반) |
| `canvasGenerationRecovery.ts` | 순수 | create-first 링크(attempt_id) 생성·정착·재조정 |
| `canvasDetached.ts` | 순수 | 카드에서 떨어진 생성물 판정 |

**10. 씬·캔버스 — 순수 계산(14)**

| 파일 | 역할 | 한 줄 책임 |
|---|---|---|
| `sceneEdges.ts` | 순수 | 연결 기하·그래프·실행 계획·Comfy 출력·엣지 역할 — 캔버스 계산 중심 | 약 1,380줄. 씬 구역의 실질적 병목(§5) |
| `sceneDerive.ts` | 순수 | 그룹 사각형·참조 정합·빈 그룹 제거 |
| `sceneInteractions.ts` | 순수 | 스냅·리사이즈·복사/붙여넣기·드롭 분류·그룹 재배정 |
| `sceneViewport.ts` | 순수 | 카메라 줌·팬·프레이밍 계산 |
| `sceneLayout.ts` | 순수 | 선택 노드 자동 정렬(열 분해) |
| `sceneAutoConnect.ts` | 순수 | `c` 자동 연결 계획 |
| `sceneKeyboard.ts` | 순수 | 캔버스 키 의도(전체 선택 포함)·Escape 우선순위 |
| `sceneNodeCatalog.ts` | 순수 | 새로 만들 수 있는 노드 단일 카탈로그 |
| `sceneMedia.ts` | 순수 | 씬 레퍼런스 썸네일·미디어 종류 |
| `sceneSet.ts` | 순수 | Set 노드 태그 파싱·폴더 드래그 페이로드 |
| `sceneGroupSelection.ts` | 순수 | 그룹 클릭/드래그 대상 계산 |
| `sceneDragSession.ts` | 순수 | 전역 드래그 리스너 + rAF 합치기(환경 주입) |
| `marquee.ts` | 순수 | 러버밴드 사각형·적중 판정(생성·에셋 공용) |
| `recipeScene.ts` | 순수 | 생성물 → "어떻게 만들었나" 씬 변환 |

**11. 씬·캔버스 — 컨테이너 훅(15)**

| 파일 | 역할 | 한 줄 책임 |
|---|---|---|
| `useSceneCoordination.ts` | 훅 | 씬 목록·CRUD·백업·소속 병합 배선(App.tsx 추출) |
| `useSceneGenData.ts` | 훅 | genId→생성물 바인딩·폴링·계보·색 원장 |
| `useSceneViewport.ts` | 훅 | 카메라 상태·휠/드래그 배선·저장 지연 |
| `useSceneCardMove.ts` | 훅 | 카드 드래그 이동·그룹 재배정·이탈 |
| `useSceneGroupMove.ts` | 훅 | 그룹 드래그 이동 |
| `useSceneCardResize.ts` | 훅 | 카드 리사이즈 드래그 |
| `useSceneMarqueeSelection.ts` | 훅 | 캔버스 마퀴 선택 |
| `useSceneDragSession.ts` | 훅 | `createSceneDragSession` 에 window/rAF 주입 |
| `useSceneHistory.ts` | 훅 | 씬 undo/redo 조작 |
| `useSceneKeyboardShortcuts.ts` | 훅 | 캔버스 단축키 배선 |
| `useSceneClipboardDrop.ts` | 훅 | 붙여넣기·파일/에셋 드롭 처리 |
| `useSceneColorActions.ts` | 훅 | 캔버스 카드 색 변경(범위 티켓) |
| `useSceneCompletionWatcher.ts` | 훅 | App 레벨 '방금 생성' 완료 상시 감시 |
| `useGenerationViewsSynced.ts` | 훅 | Last viewed 배지 구독 + 서버 동기 |
| `generationViews.ts` | store+api | Last viewed 배지 원천(직렬 PUT·stale 재조회) |

**12. Comfy 실행 + 캔버스 생성 제출(9)**

| 파일 | 역할 | 한 줄 책임 |
|---|---|---|
| `useSceneComfyExecution.ts` | 훅 | Comfy 단독/배치 실행 오케스트레이션·소유권·결과 저장 | 약 856줄 |
| `sceneComfyExecutor.ts` | api | 한 번의 Comfy 실행 경계(스냅샷 최신성·superseded) |
| `sceneComfyInputs.ts` | 순수 | Comfy 노드 입력(미디어·연결텍스트) 수집·지문 |
| `sceneComfySeeds.ts` | 순수 | 배치 복사본 seed 무작위화 |
| `sceneComfyRunningStore.ts` | store | Comfy '생성중' 표시(언마운트 생존, 버전 구독) |
| `comfyRunState.ts` | 순수 | 배치 실행 판정 상태기계·동시성 리미터 |
| `useComfyUnresolvedRuns.ts` | 훅 | 미회수 실행 목록 조회·해제 |
| `sceneGenerationInputs.ts` | 순수 | 캔버스 생성 요청 재료 + 실행 중 변경 감지 지문 |
| `sceneGenerationSubmission.ts` | 순수 | 캔버스 생성 배치 제출 경계(작업·씬 격리) |

**13. 어셋·폴더 트리·팀 신규(8)**

| 파일 | 역할 | 한 줄 책임 |
|---|---|---|
| `assetVersions.ts` | store+저장 | 에셋 파일 '버전'(mtime+크기) 전역 표 + 구독 |
| `assetVersionRefresh.ts` | 브라우저+api | 프로젝트별 1-in-flight 버전 갱신 실행기(API 조회) + 포커스·가시성 복귀 리스너 |
| `assetVirtualRows.ts` | 순수 | 에셋 그리드 행 모델(인덱스판) |
| `folderTreeModel.ts` | 순수 | 폴더 경로 정규화 + 개수 트리 구성 |
| `projectFolderTree.ts` | 저장 | 프로젝트 폴더 캐시·펼침 상태 |
| `folderContextMenu.ts` | 순수 | 폴더 우클릭 메뉴 규칙·위치 클램프 |
| `teamSeen.ts` | store+저장 | 공유&리뷰 '새로 들어옴' 항목별 확인(ack) 모델 |
| `stateGlow.ts` | store+저장 | 내가 방금 공유·보류·최종으로 바꾼 카드의 빛 — 쓰기 지점은 `armStateGlow(후보 id)` 만, `ThumbnailGrid` 가 재조회에서 상태가 달라진 후보를 기록하고 **새로 선택된** 카드를 확인 처리. ★이전 상태 비교는 탭별(로컬 행↔서버 행의 미러 지연), 저장 키는 `job_id` 앵커 |
| `spotlightAssetRefs.ts` | 저장 | 에셋 드래그 페이로드 읽기/쓰기(창간) |

**14. 프롬프트·스포트라이트(14)**

| 파일 | 역할 | 한 줄 책임 |
|---|---|---|
| `promptEditor.ts` | 저장+DOM | contentEditable 칩·토큰 DOM 조작 + 프롬프트 파트 직렬화 + 입력 이력 | 약 589줄 |
| `promptParts.ts` | 순수 | display_prompt + references → 순서 보존 파트 |
| `seedancePrompt.ts` | 순수 | Seedance 토큰 종류·역할·인덱스 맵·정규화 |
| `seedanceRoleEditor.ts` | 순수+DOM | Seedance 이미지 역할 편집(캐럿 복원) |
| `useSeedanceRoleMenu.ts` | 훅 | 역할 변경 메뉴 배선 |
| `spotlightPromptConfig.ts` | 순수 | 옵션 표시·정렬·변형(variant) 규칙 |
| `spotlightPromptKeyboard.ts` | 순수 | Enter 동작 판정 |
| `spotlightSubmit.ts` | 순수 | 제출 본문 조립·배치 정규화 |
| `useSpotlightTray.ts` | 훅 | 레퍼런스 트레이 + 캔버스 카드 양방향 바인딩 |
| `useSpotlightTokenWrap.ts` | 훅 | 미디어 토큰 → 색 알약 정규화 |
| `useSpotlightMentionSources.ts` | 훅 | `@` 멘션 소스 목록 |
| `usePromptDock.ts` | 훅 | 프롬프트 도킹 위치·단축키 |
| `prompt.tsx` | 훅(ctx) | `window.prompt` 대체 플로팅 입력 컨텍스트(lib 유일 `.tsx`) |
| `dragTypes.ts` | 순수 | DataTransfer 타입 상수 |

**15. 관리·PM·크레딧·사용량(7)**

| 파일 | 역할 | 한 줄 책임 |
|---|---|---|
| `creditPlan.ts` | 순수 | 크레딧 풀·그룹 한도·이월·잔액 추이 타입 + 설정 초안 검증 | 약 415줄 |
| `memberTable.ts` | 순수 | 관리 표 응답 타입 · 그룹 한 줄 저장 본문(`groupAssignBody` — 받은 그룹 전부 재전송·허용 모델 키 생략) · 역할 낙관 반영 | 약 83줄 |
| `projectPlanning.ts` | 순수 | 프로젝트 예산 기간·입력 검증 |
| `usageReport.ts` | 순수 | 사용량 CSV(주입 방지 포함)·출력 종류 집계 |
| `usagePeriod.ts` | 순수 | 기간 범위·추이 버킷 채우기·라벨 |
| `usagePagination.ts` | 순수 | 사용량 표 페이지 분할 |
| `usageModelIndex.ts` | 순수 | 모델 행을 키별 1회 인덱싱 |
| `formatCredits.ts` | 순수 | 크레딧 소수 보존 표시·반올림 |

**16. DaVinci Resolve(5)**

| 파일 | 역할 | 한 줄 책임 |
|---|---|---|
| `resolveSelection.ts` | 순수 | Resolve 선택 → 씬·카드 역추적 |
| `resolveSelectionSettings.ts` | 저장+훅 | '선택 따라가기' 설정 구독 |
| `useResolveTransferActions.ts` | 훅 | 전송 실행·재시도 액션(직렬 큐) |
| `useResolveLibraryFollow.ts` | 훅 | Resolve 선택에 라이브러리 페이지 따라가기 |
| `sourceLocationFeedback.ts` | api | 원본 위치 열기 실패 보고 |

**17. 미디어·다운로드·비교·히스토리(9)**

| 파일 | 역할 | 한 줄 책임 |
|---|---|---|
| `media.ts` | 순수+브라우저(+훅 1) | 썸네일 URL·미디어 종류·DataTransfer 파일 판정 |
| `download.ts` | api | 다운로드 공용(허브 각인 → 직접 → 프록시 → 새 탭 폴백) |
| `compareDiff.ts` | 순수 | 비교 모달의 프롬프트·파라미터 차이 계산 |
| `compareWindow.ts` | 순수 | 비교 창 이동·크기·뷰포트 맞춤 |
| `synchronizedVideos.ts` | 브라우저 | 비교 영상 재생·탐색 동기화 바인더 |
| `popupWindows.ts` | 브라우저 | 임베드 창(에셋·관리) `window.open()`·재활성화 |
| `historyGraphLayout.ts` | 순수 | 계보 보드 노드 배치·간선·하이라이트 추적 |
| `useHistoryBoardState.ts` | 훅 | 계보 보드 상태(App.tsx 추출) |
| `appWindow.ts` | 브라우저+저장 | 앱 전용 창(`?appwin=1`) 감지 |

**18. 코멘트·알림·토스트(7)**

| 파일 | 역할 | 한 줄 책임 |
|---|---|---|
| `commentTree.ts` | 순수 | 코멘트 부모→답글 트리 |
| `commentBadgeTargets.ts` | 순수 | 배지 폴링 대상·변화 판정 |
| `useCommentBadgePoll.ts` | 훅 | 코멘트 배지 주기 폴링(+stale 방어) |
| `notificationCenter.ts` | 순수+저장 | 알림 탭·릴리스 공지 병합·읽음·배지 수 |
| `flash.ts` | 순수 | 전역 토스트 디스패치(lib 하위용) |
| `useAppToast.ts` | 훅 | 토스트 상태·타이머 |
| `useAppNavigation.ts` | 훅 | 탭·창 네비게이션 상태 |

**19. UI 공용 훅·소품(11)**

| 파일 | 역할 | 한 줄 책임 |
|---|---|---|
| `useEscapeClose.ts` | 훅 | Esc 로 닫기(lib 최다 공용 훅). 창 안의 자식 대화상자는 `(onClose, open, true, true)` = capture+consume 으로 먼저 소비해야 바깥 창이 같이 닫히지 않는다 |
| `useOverlayDismiss.ts` | 훅 | 오버레이 바깥 클릭/Esc 통합 해제 |
| `useOutsideMouseDown.ts` | 훅 | 바깥 mousedown 감지 |
| `useOutsideDragSelect.ts` | 훅 | 빈 곳 드래그 선택 시작 위임 |
| `useClickSeparation.ts` | 훅 | 단일/더블 클릭 분리 |
| `useDebouncedCallback.ts` | 훅 | 디바운스 콜백(run/cancel) |
| `useFloatingPanel.ts` | 훅 | 떠 있는 패널 위치·드래그·클램프 |
| `useMenuPlacement.ts` | 훅 | 메뉴 배치 계산을 DOM 에 부착·재측정 |
| `menuPlacement.ts` | 순수 | 잘리는 조상 안에서 메뉴 방향·높이 계산 |
| `windowDrag.ts` | 브라우저 | window mouse/pointer 드래그 리스너 add/remove 4벌 |
| `useDisabledGenerations.ts` / `useDisabledFolders.ts` | 훅(2파일) | 비활성 집합 구독 |

**20. 소품·i18n(3)**

| 파일 | 역할 | 한 줄 책임 |
|---|---|---|
| `i18n.ts` | store | 한국어 원문 키 → EN 사전(325키) + 언어 구독 | 약 441줄 |
| `format.ts` | 순수 | SQLite UTC 문자열 → ms·로컬 표시 |
| `setUtils.ts` | 순수 | Set 토글·제거·단일화 |

**21. 테스트(14)**

순수 모듈 198개 중 테스트가 닿은 파일은 13개(6.6%)뿐이다: `assetUrls.test.ts` ·
`canvasDetached.test.ts` · `generationDisplay.test.ts` · `generationViews.test.ts` ·
`manageWorkspaceScope.test.ts` · `progressSocket.test.ts` · `releaseUpdate.test.ts` ·
`sceneDerive.test.ts` · `sceneMedia.test.ts` · `sceneNodeCatalog.test.ts` ·
`spotlightPromptConfig.test.ts` · `usageModelIndex.test.ts` · `useGenerationProgress.test.ts` ·
`workspaceCommand.test.ts`.

### 3.4 styles (`frontend/src/styles/`, 12파일)

담당 화면은 클래스 접두어와 실제 컴포넌트의 className 대조(S1 조사)로 추정했다. 한 파일이 여러
화면을 겸하는 경우가 있다(§5-d).

| 파일 | 약 줄 | 담당 화면 |
|---|---:|---|
| `base.css` | 104 | 전역 변수(`:root` 24개)·리셋 — 화면 특정 아님 |
| `app-shell.css` | 796 | 최상위 앱 셸(`TopBar`·상단 메뉴) |
| `generations.css` | 856 | 라이브러리 그리드·카드(`ThumbnailGrid`·`GenerationCard`). ★**끝없이 도는 CSS 애니메이션은 합성 가능한 속성(transform·opacity)만** — `background-position`·`box-shadow` 를 무한으로 움직이면 요소 하나만 화면에 있어도 브라우저가 매 프레임 다시 그려 가만히 둔 탭이 CPU 를 계속 쓴다(골드 광택 실측: 0장 1% · 1장 24~38% of one core). 팀 탭 새 항목 글로우(`.card.fresh`)도 같은 이유로 **멈춘 빛**이다(box-shadow 무한: 1장 42~49% · 19장 86~124% → 정지 2~3%. opacity 층으로 바꿔도 절반이 남았다 — 끝없이 도는 한 합성 비용은 남는다). ★**부드러운 무한 애니메이션은 opacity·transform 이어도 비싸다**(화면에 하나만 있어도 페이지를 초당 60번 새로 합친다 — '생성 중' 로고 1장 17%). 그래서 장식은 멈추고 '진행 중' 표시만 계단식 `steps(4)`(17% → 3%)로 남긴다. 계약 시험 = `frontend/tests/idleCssAnimations.test.ts`(모든 CSS 의 `infinite` 는 같은 선언에 `steps(` — 예외는 재서 비용이 없던 11px 알림 스피너 선언 하나). 전수 조사 기록 = `docs/status/브라우저실측_2026-09-19.md` "부하 전수 조사" |
| `scene.css` | 1513 | 씬 캔버스(`scene/`) — 비슷한 이름의 클래스가 많다(§5-b) |
| `prompt-dock.css` | 566 | 스포트라이트 프롬프트 도크(`SpotlightPrompt`·`spotlight/`) |
| `history.css` | 216 | 히스토리 보드(계보 그래프). 최종 노드는 `content-visibility` 가 풀려 있어 화면 밖에서도 그린다 — 여기에 무한 애니메이션을 두지 않는다 |
| `assets.css` | 817 | Assets 분리창(`AssetsView`·`assets/`) |
| `project-sidebar.css` | 318 | 프로젝트 사이드바(`sidebar/ProjectSection`) |
| `composition-manage.css` | 1098 | 관리(PM)창 구성·대시보드 화면. 옛 합성보드·옛 통계 위젯(도넛·퍼널 등)의 규칙은 2026-09-18 에 걷어냈다. 남은 휴면 규칙은 §5-d |
| `admin-auth-compare.css` | 682 | 로그인·관리자 창·계정 비교 화면 |
| `partial-edit.css` | 327 | 부분 수정 캔버스(`edit/PartialEditModal`) |
| `resolve-library.css` | 22 | Resolve 관련 라이브러리 표시(소규모) |

### 3.5 숨은 진입점

- **`?embed=` 별도 앱 트리** — `main.tsx` 가 쿼리스트링으로 `App` / `AssetsWindow`(`?embed=assets`) /
  `ManageWindow`(`?embed=manage`) 를 분기해서 마운트한다. 메인 `App.tsx` JSX·import 그래프만 보면
  이 두 창의 존재를 놓친다. 둘 다 메인 창 없이도 WS 를 직접 구독한다.
- **`edit/PartialEditHost.tsx`** — JSX·import 로 열리지 않는다. `InfoPopup` 이 쏘는 커스텀 이벤트
  `partialEdit` 을 구독해서만 열린다.

---

## 4. 스크립트·도구·릴리스

⚠ 표시는 루트 [`CLAUDE.md`](../CLAUDE.md)(안전선)가 명시적으로 "검증용으로 실행 금지" 또는
"테스트 명령이 아니다"라고 적은 파일이다. `graft.ps1` 은 금지는 아니지만 반드시 래퍼로만 호출한다
(직접 부르면 `ELECTRON_RUN_AS_NODE` 로 죽는다).

**워커 PC 로컬 실행 — 팀원이 매번 더블클릭**

| 파일 | 한 줄 책임 | 호출 사슬 |
|---|---|---|
| [`MV_agent.bat`](../MV_agent.bat)(437줄) | 워커 PC 원클릭: 로컬허브 기동+CLI핀 선택+에이전트 실행+앱창모드 | → `tools/stop_local_hub_on_port.ps1`, `run_agent_session.py` |
| `run_agent_session.py`(1291줄) | Win32 Job Object 로 프로세스트리 가둠, 앱창 감시/포커스, 바탕화면 바로가기 | 단독(ctypes 만) |
| `run_py.bat`(22줄) | 파이썬 실행파일 찾아 스크립트 실행하는 범용 헬퍼 | 다수 스크립트가 이걸 호출 |

**공유서버 실행·감독 — 서버 PC, 상시**

| 파일 | 한 줄 책임 | 호출 사슬 |
|---|---|---|
| `MV_server.bat`(85줄) | 공유서버(단일DB, `CONTENT_HUB_AUTH=1`) 프론트 빌드 확인 후 supervisor 기동 | → `tools/server_supervisor.py` |
| `MV_watchdog.bat`(50줄) | 워치독 재시작 루프 | → `tools/server_watchdog.py` |
| `tools/server_supervisor.py`(99줄) | serve.py 크래시 감독, 지수백오프, storm 시 ALERT | |
| `tools/server_watchdog.py`(792줄) | `/api/ready` 폴링, 행(hang) 감지 시 serve.py 만 kill | → `tools/rotate_text_log.py` |
| `tools/stop_local_hub_on_port.ps1`(195줄) | 포트 점유 프로세스가 이 설치의 serve.py 인지 절대경로/토큰 검증 후 종료 | |

**서버 자동시작·복구 — 서버 PC, 최초 1회 또는 장애 시**

| 파일 | 한 줄 책임 | 호출 사슬 |
|---|---|---|
| `register_autostart.bat`(198줄) ⚠실행금지 | 최초 1회 관리자승격→NAS경로 질문→예약작업 3개 등록→즉시 기동 | → `task_launch.bat`, `restart_server_task.bat` |
| `task_launch.bat`(50줄) | 예약작업이 부르는 실행기: 로그회전+`CONTENT_HUB_TASK=1`+SYSTEM PATH 보정 | → `MV_server.bat` 등, `tools/backup_replicate.py`, `run_py.bat` |
| `restart_server_task.bat`(23줄) ⚠실행금지 | 관리자 승격 후 `.ps1` 호출 | → `restart_server_task.ps1` |
| `restart_server_task.ps1`(202줄) | 예약작업 정지→고아 프로세스 정리→포트 소유자 검증→재시작→ready 확인 | |

**Git 코드 업데이트(서버/개발 클론) — 배포 담당, 배포 시**

| 파일 | 한 줄 책임 | 호출 사슬 |
|---|---|---|
| `update_git.bat`(1줄) | `run_update_git.ps1` 1줄 호출 | → `tools/run_update_git.ps1` |
| `tools/run_update_git.ps1`(99줄) | worker.bat 를 TEMP 로 복사해 격리 실행(자기교체 생존)+실패시 1회 재시도 | → `tools/update_git_worker.bat` |
| `tools/update_git_worker.bat`(289줄) | 실제 git pull+backend deps+frontend build+등록서버면 재시작까지 | → `tools/repair_package_lock.py`, `tools/verify_requirements.py`, `restart_server_task.bat` |
| `tools/repair_package_lock.py`(62줄) | npm 버전차이로 재정렬된 package-lock.json 을 HEAD 와 의미상 같을 때만 복원 | |
| `setup_clone_git.bat`(31줄)/`setup_clone_git.ps1`(165줄) | 최초 설치: winget 으로 git/node/python 설치+sparse clone+빌드+CLI 설치 | |

**릴리스(zip) 업데이트 — 작업자 PC, 배포 담당이 밀 때**

| 파일 | 한 줄 책임 | 호출 사슬 |
|---|---|---|
| `update_release.bat`(1줄) ⚠배포전용 | `run_release_update.ps1` 1줄 호출 | → `run_release_update.ps1` |
| `run_release_update.ps1`(82줄) ⚠배포전용 | worker.bat 를 TEMP 로 복사해 격리 실행, 종료코드 보존 | → `update_release_worker.bat` |
| `update_release_worker.bat`(1274줄) ⚠배포전용 | 자기 안 마커 뒤 PS1 페이로드를 분리 추출해 실행 — Prepare→Commit 2단계 업데이트 트랜잭션, 잠금(exit17)·Resolve전송중(exit18) 특수코드, 실패시 롤백 | 격리 실행(자기 자신을 덮어써도 생존) |
| `update_cli.bat`(112줄) | Higgsfield CLI 를 `hf_cli_version.txt` 핀에 정확히 맞춤(설치/검증) | 수동 — 어느 체인도 호출하지 않음 |

**릴리스 제작·설치(관리자 PC 전용) — 배포 담당, 배포 시**

| 파일 | 한 줄 책임 | 호출 사슬 |
|---|---|---|
| `release/make_release.bat`(21줄) ⚠배포전용 | `.ps1` 1줄 호출 래퍼. 고정 폴더 `MV-hub-S-release` 제약은 이 배치가 아니라 배포 절차(루트 `CLAUDE.md` 안전선)에 있다 | → `release/make_release.ps1` |
| `release/make_release.ps1`(694줄) ⚠배포전용 | zip 제작: 런타임 동봉, CLI pin==번들 버전 대조, 금지파일 검사, 압축해제 실행검증, NAS 자동복사 | |
| `release/select_release.ps1`(129줄) | 과거 zip 을 `latest.json` 으로 재선택(롤백), 백업 남김 | |
| `release/MVHub_Install.bat`(355줄) | 워커 최초설치/업데이트 설치기, 자체 임베드 PS1, 바탕화면 바로가기 호출 | → `run_agent_session.py --ensure-shortcut` |
| `release/publish_target.txt.example`(1줄) | 배포 폴더 경로 예시 | |
| `release/README.md` | 릴리스 스크립트 사용법 설명(문서) | |

**개발·격리시험 런처 — 개발자, 매일**

| 파일 | 한 줄 책임 | 호출 사슬 |
|---|---|---|
| `test_dev.bat`(117줄) | Vite+격리백엔드(8012) 원클릭 개발, 페어링 시크릿 발급 | → `MV_agent.bat`(후단), `tools/pick_dev_port.ps1`, `tools/replace_dev_session.ps1` |
| `test_dev_server.bat`(65줄) | 격리DB(`data_test`) 로 빌드된 프론트+단일서버 최종시험(8011) | → `MV_server.bat` |
| `test_pull-db.bat`(61줄) | 서버가 발행한 스냅샷을 1회용 코드로 내려받아 `data_test` 채움 | → `tools/refresh_pm_test_data.py` |
| `test_push-db.bat`(112줄) | 라이브 DB 를 읽기전용 원본으로 스냅샷 발행 서버(8011) 기동 | → `tools/refresh_pm_test_data.py` |
| `tools/pick_dev_port.ps1`(46줄) | Windows 예약 포트대역 회피, 첫 사용가능 후보 반환 | |
| `tools/replace_dev_session.ps1`(126줄) | 이전 dev 세션만(프로세스 계보 검증) 안전 종료 | |
| `tools/refresh_pm_test_data.py` | 스냅샷 압축/해제·scrub(개인정보 제거) | → backend `db_scrub`·`test_snapshot` |
| `tools/seed_manage_multi_user_test_data.py`(193줄) | 브라우저 다중사용자 실측용 팀 사용량 팩트 apply/clean(data_test 한정) | |

**서버 이전·재해복구 — 배포 담당, 이사·복구 시**

| 파일 | 한 줄 책임 | 호출 사슬 |
|---|---|---|
| `server_move_export.bat`(24줄)/`server_move_import.bat`(26줄) | `run_py.bat` 경유 `server_move.py export\|import` 얇은 래퍼 | → `tools/server_move.py` |
| `tools/server_move.py`(1147줄) | DB 세트 export/import, 머신전용 상태 제외, `--backup-set` NAS 복구 | → backend `services/backup_verify.py`, `tools/account_paths.py` |
| `tools/account_paths.py`(12줄) | `backend.app.active_account.slug` 를 tools 스크립트에서 쓰기 위한 sys.path 셋업 | |

**백업·복원 — 서버 PC, 상시(스케줄러) / 검증 시 수동**

| 파일 | 한 줄 책임 | 호출 사슬 |
|---|---|---|
| `tools/backup_replicate.py`(437줄) | 서버 자동백업+팀원 업로드백업을 UNC 경로로 매일 복제(폴더당 30개 보존) | → `tools/rotate_text_log.py` |
| `tools/rotate_text_log.py`(48줄) | 핸들 열리기 전 텍스트 로그 세대 회전 | 다수 스크립트 공용 |
| `tools/verify_backup_restore.py`(134줄) | 백업→복원 실측 훈련(운영DB 비접촉) | → backend `backup_verify`·`restore_runtime_verify` |
| `tools/cleanup_workspace_registry.py`(119줄) | 워크스페이스 등록부 유령행 미리보기/`--apply` 삭제 | |

**Higgsfield CLI 핀 관리 — 배포 담당, 버전 올릴 때**

| 파일 | 한 줄 책임 | 호출 사슬 |
|---|---|---|
| `hf_cli_version.txt`(1줄, 현재 `1.1.25`) | 고정버전 단일 소스 | `MV_agent.bat`·업데이트/릴리스 스크립트 전부 참조 |
| `tools/hf_cli_check_update.py`(100줄) | 최신버전 유무+문서 diff 예고편(네트워크 GitHub) | |
| `tools/hf_cli_contract_smoke.py`(260줄) | 설치 후 실제 CLI JSON 출력 계약 스모크(무료, 생성 없음) | |

**배포전 검증·부하·지구력 — 배포 담당, 배포 직전**

| 파일 | 한 줄 책임 | 호출 사슬 |
|---|---|---|
| `tools/predeploy_gate.ps1`(238줄) | 문서린트+아키텍처린트+테스트+빌드+백업훈련+부하시험을 순서대로, 실패시 즉시 중단 | → 프론트 npm 스크립트들, `tools/verify_backup_restore.py`, `tools/load_test_100.py` |
| `tools/deploy_fence_check.py`(158줄) | 배포 직전 생성 파이프라인이 완전히 비었는지 판정(종료코드 0/2/3) | |
| `tools/load_test_100.py`(1620줄) | 100명 격리 부하시험(로그인/WS/에이전트 롱폴/읽기쓰기). 서버 환경은 부모 셸의 `CONTENT_HUB_*` 를 버리고 다시 짠다 — `NO_PROXY=0`(공유 서버 본체 경로를 잰다)·`EXTERNAL_RECOVERY=0`(기동 때 실제 CLI 를 안 부른다) | `endurance_probe.py`·`run_https_soak.ps1`·`predeploy_gate.ps1` 이 재사용 |
| `tools/run_https_soak.ps1`(334줄) | HTTPS 로 30분 자격시험+8시간 지구력 소크 오케스트레이션 | → `tools/load_test_100.py` |
| `tools/endurance_probe.py`(1370줄) | 시간의존 안정성 격리 프로브(load_test_100 함수 직접 import 재사용) | |
| `tools/baseline_metrics.py`(1277줄) | 운영 DB 사본(읽기전용 URI)의 기준선 지표+orphan 후보 산출 | → backend `media_cache`·`thumbs` |
| `tools/smoke_release_package.py`(262줄) | 릴리스 zip 실제 압축해제+동봉런타임으로 부팅 검증(문서화됨) | |
| `tools/smoke_server_boot.py`(131줄) | node/npm 제거 상태에서 라이브 체크아웃 `MV_server.bat` 부팅만 검증 | → `MV_server.bat` |

**실경계 검증(라이브, 무료) — 개발자, 필요할 때**

| 파일 | 한 줄 책임 |
|---|---|
| `tools/verify_comfy_live.py`(582줄) | MV Hub↔ComfyUI 실제 HTTP 왕복(가짜 Comfy 서버, 실비용 없음) |
| `tools/verify_resolve_live.py`(339줄) | 실행중 DaVinci Resolve 왕복 검증(임시 프로젝트만 생성/삭제) |
| `tools/verify_generation_submission_recovery.py`(223줄) | 생성 제출 중단·재시작 훈련(CLI 미호출, 임시 SQLite) |
| `tools/preflight_task_workspace.py`(227줄) | RL-02 작업 워크스페이스 이관 검증(운영DB 안전 복사본에서만) |
| `tools/verify_requirements.py`(62줄) | `requirements.txt` 의 `name==version` 핀만 실제 설치와 비교 |

**운영 로그·코드 탐색·문서 린트**

| 파일 | 한 줄 책임 |
|---|---|
| `MV_logs.bat`(9줄) | `run_py.bat` 경유 `tools/log_viewer.py` 실행 |
| `tools/log_viewer.py`(313줄) | 구조화 운영로그(jsonl)를 사람이 읽기 쉬운 한 줄로 |
| `tools/graft.ps1`(72줄) | graft CLI 래퍼(`callers`/`grep`/`blast`/`skeleton`) — 항상 이 래퍼로만 호출 |
| `tools/lint_docs.ps1`(272줄) | 문서 규칙 검사(`npm run lint:docs` 가 호출) |
| `tools/check_code_map.py` | 이 문서와 저장소의 양방향 대조(없는 파일 이름·빠진 파일) — 수동 실행, 게이트 미연결(§6) |
| `tools/browser_measure/servers.py` | **격리 브라우저 실측용 서버 두 대**(H=AUTH off 허브·S=AUTH on+일회용 관리자) 기동·종료. 시험 DB 를 읽기 전용 backup 으로 복사 → 공유 서버 토큰·주소와 프로젝트의 실제 폴더 경로(`project_folder_link`·`render_root_path`) 제거 → 부모 셸의 `CONTENT_HUB_*` 를 전부 버린 환경(`server_env`) + CLI 를 뺀 PATH → 기동 뒤 격리를 **확인 못 하면 스스로 내림**. `stop` 은 자기가 띄운 것만 종료하고 복사본을 지운다. 안전 장치 시험 `backend/tests/test_browser_measure_isolation.py`. 절차 = [TESTING.md](TESTING.md) "격리 브라우저 실측". ⚠ 도구가 없애는 것은 Assets **자동 마운트**뿐이다 — 손으로 폴더를 등록하면 실제 폴더에 쓴다(운영 규칙으로 금지) |
| `tools/browser_measure/cdp.py` | 헤드리스 Chrome/Edge 를 DevTools 프로토콜로 모는 드라이버(venv 의 `websockets` 만). 콘솔·실패 응답·**모든 비-GET 요청**·네이티브 대화상자를 모은다(`confirm()` 을 처리하지 않으면 모든 명령이 멈춘다) |
| `tools/browser_measure/walk.py` | 실측 단계 러너(동작→상태 조사→이벤트 회수, 단계별 JSON) + 로그인·선택자 도우미. 판정은 `ok`/`stale`(대상 없음 = 시나리오가 낡음)/`failed`(제품 확인). **기본 모드의 결과에는 자유 문장을 남기지 않는다**(수치·클래스·이벤트 종류와 **라우트 틀**·고정 어휘 `reason`만 — 실제 경로의 동적 조각에는 이름이 실리므로 `docs/inventory/endpoints.md` 의 틀로 바꾸고 틀에 없으면 `/api/{…}` 로 줄인다. 원문은 verbose, 이메일은 `%40` 꼴까지 가림). 생성 요청 수(`gen_requests`)는 가리기 전 원문에서 센다. → `cdp.py`, `docs/inventory/endpoints.md` |
| `tools/browser_measure/smoke.py` | 핵심 화면 41단계 시나리오(보기·검색·카드 단축키·미리보기·다중 선택·탭·도크·**처음 연 창의 Esc 1회**·분리 창). 종료 코드 0 통과 · 1 제품 확인 필요(실패·`/api/gen-requests` 요청 발생) · 2 시나리오만 낡음. `--shots`·`--verbose` 는 선택. 유료·외부 실행 단추는 누르지 않는다. → `walk.py` |
| `tools/gen_inventory.py` | 코드에서 뽑는 목록 `docs/inventory/*.md`(엔드포인트·환경변수·DB 테이블·백그라운드 작업) 생성기. 표준 라이브러리만·앱 import 없음. `--check` = 어긋남만 확인. 낡으면 `backend/tests/test_docs_inventory_fresh.py` 가 실패한다(§6) |

**에이전트 코어**

| 파일 | 한 줄 책임 |
|---|---|
| `agent_push.py`(3883줄, 단일파일·표준lib만) | 워커 PC 생성 에이전트: CLI 어댑터, Hub HTTP 계약, outbox, create-first 제출/재조정, 스케줄러(제출8/추적64) — `/api/agent/download` 가 이 파일 그대로 배포하므로 단일 파일 유지가 제약 |

**배포 리버스 프록시(옵션, Phase2, review-required)**

| 파일 | 한 줄 책임 |
|---|---|
| `deploy/Caddyfile`(29줄)/`deploy/nginx.conf`(70줄) | 미디어(`/media`) 분리서빙+API/WS 프록시 설정 예시 — 실행경로 미연결, 옛 경로명(`content-hub-server`) 잔존(§5) |
| `deploy/README.md`/`deploy/POSTGRES.md` | 프록시 트레이드오프 설명 / PostgreSQL 전환 보류 설계기록(현재 코드가 차단) |

---

## 5. 함정 지도

### (a) 중복처럼 보이지만 합치면 안 되는 것

| 위치 | 왜 정당한가 |
|---|---|
| `services/resolve_bridge.py` ↔ `services/resolve_transfer.py` (`_natural_name_key` 등) | `resolve_bridge.py` 는 상대 import 가 한 줄도 없다 — `python -m app.services.resolve_probe`/`resolve_import_worker` 자식이 repo·config 를 안 끌고 로드하기 위한 고립이다. 합치면 자식이 무거운 의존을 끌어온다 |
| `services/server_relocation.py` 의 `_atomic_write_text` 래퍼 | 같은 이유(자식 프로세스 스크립트 실행 시 패키지 없음) — 구현을 복사하지 않고 지연 import 로 `atomic_io` 하나만 쓴다(이미 올바른 형태) |
| `services/comfy_client.py` `_NoRedirect` ↔ `services/net_guard.py` `_NoRedirect` | 이름만 같고 동작이 반대다 — comfy 쪽은 3xx 를 올려 서명 URL 을 수동 검증(`return None`), net_guard 쪽은 3xx 자체를 차단(`raise BlockedURLError`). 합치면 Comfy Cloud 의 302 스토리지 리다이렉트가 막힌다(§(b) 참고) |
| `_utc_now` 4벌(`release_update.py`·`resolve_import_worker.py`·`resolve_transfer.py`·`worker_backup.py`) | 2종 변형이다 — `timespec="seconds"` 유무가 갈린다(manifest·journal 은 초 단위, 상태 파일은 마이크로초). 통일하면 기존 파일과 문자열 비교가 어긋난다 |
| `repo/gen_requests.py` 일반축(`o.id<>r.id`) ↔ 캔버스축(NULL-safe 비교) "다른 요청이 이 gen 을 쓰고 있나" 가드 | 형태는 다르지만 유니크 인덱스를 고려하면 효과는 같아 보인다(등가성은 시험으로 확인되지 않음 — 추정) |
| `frontend/src/lib/sceneDragSession.ts` 의 `SceneDragEnvironment` 주입 인터페이스 | 구현이 하나뿐이라 "야그니"로 보이지만, `frontend/tests/sceneDragSession.test.ts` 가 가짜 환경(`addListener`·`requestFrame`·`cancelFrame`)을 주입해 시험하는 DI 이음새다. 인라인화하면 그 시험이 설 자리가 사라진다 |
| 씬(`scene/`)·스포트라이트(`spotlight/`) 사이의 근사 중복(삽입 위치 계산·드래그 세션·바깥클릭+Esc·가시성 폴러) | 알고리즘은 같지만 feature 경계(ARCHITECTURE §2 "feature 끼리 직접 import 금지") 때문에 각자 복제됐다 — **합칠 자리는 `shared`/`lib` 이지 서로를 참조하는 게 아니다** |
| S2 — `restart_server_task.ps1`(`Test-MvHubServerCommandLine`) ↔ `tools/stop_local_hub_on_port.ps1`(`BundledPythonPath` 레거시 폴백 추가) | 포트 소유권 판정 로직이 거의 같지만, `stop_local_hub_on_port.ps1` 에만 있는 레거시 폴백의 존재 이유가 확인되지 않았다 — **합치기 전에 그 폴백이 지키는 것부터 확인**(안전장치로 확정된 것은 아니고, 확인이 필요하다는 뜻) |

### (b) 이름이 같은데 동작이 다른 것 / 이름이 헷갈리는 쌍

- `components/GenerationCard.tsx`(라이브러리, 683줄) ↔ `components/scene/cards/GenerationCard.tsx`(캔버스, 336줄) — 완전히 다른 파일. grep 할 때 경로까지 봐야 한다.
- `common/FolderTreeView.tsx`(공용) ↔ `assets/FolderTree.tsx`(에셋 전용) ↔ `admin/ProjectRenderTree.tsx` — 이름이 세 갈래로 비슷하다.
- `CompareModal.tsx` ↔ `VideoCompareModal.tsx` — 후자는 이름과 달리 이미지도 다룬다.
- CSS 클래스는 **접두어가 같다고 같은 부품이 아니다.** 2026-09-18 정리 때 `scene-listnode-text`(안 쓰임)와 `scene-listrow-text`(쓰임), `scene-comfynode-run`(안 쓰임)과 `scene-comfynode-status s-running`(쓰임)이 한 글자 차이로 섞여 있었다 — "접두어로 grep 해서 쓰이니까 안심"이 통하지 않는다. 클래스가 쓰이는지는 **전체 이름**으로 확인하고, 규칙을 지울 때는 선택자 전부가 죽었는지(`:not(.x)` 는 x 가 없어도 일치한다) 본다.
- `lib/` 의 이름 규칙이 4가지로 섞여 있다: "이름 + use이름"(`menuPlacement`/`useMenuPlacement`, `sceneDragSession`/`useSceneDragSession`, `gradeStep`/`useGradeStep`), "이름 + 이름Core"(`modelPolicy`/`modelPolicyCore`), "이름 + 이름Cache"(`modelCatalog`/`modelCatalogCache`), "이름Store"(`sceneGenDataStore` 등). 어느 쪽이 순수이고 어느 쪽이 IO 인지 이름만으로 안 갈린다.
- `SpotlightRefRoleMenu`(spotlight) 의 `startReorder` ↔ `SceneBoard.tsx` 의 `startReorder` — 같은 이름, 다른 파일의 다른 구현.
- `repo/manage.py`·`repo/manage_tasks.py`·`routers/manage.py`·`manage_db.py`(최상위) — 전부 "manage" 접두인데 계층이 다르다(라우터/repo 파사드/작업 CRUD/PM 전용 DB).

### (c) "호출자처럼 보이지만 아닌 것"

| 위치 | 함정 |
|---|---|
| `backend/tests/test_proxy_ownership.py` | 로컬/서버 경로 소유권의 골든 스냅샷(경로 문자열 목록)이다. B1 조사에서 **죽은 라우트 4개가 전부 이 목록에 남아 있어** "호출자 있음"으로 오인시켰다. 새 라우트를 추가·삭제할 때 이 파일도 함께 갱신해야 하며, 이 파일에 이름이 있다고 그 라우트가 실제로 쓰인다는 뜻은 아니다 |
| 여러 줄에 걸친 메서드 호출(`comfyApi` 다음 줄에 `.settings()`) | 한 줄 단위 grep 으로 `comfyApi.settings` 를 찾으면 **0건**이 나온다. 2026-09-18 점검에서 살아 있는 api 메서드 2개(`comfyApi.settings`·`updateNoticeApi.seen`)가 이 때문에 "무호출"로 오판됐다. "안 쓰인다"를 확정하려면 줄바꿈을 허용하는 검색(`\.\s*name\s*\(`, multiline)으로 다시 본다 |
| `frontend/eslint.config.js` 의 `settings["import/resolver"].typescript` | `eslint-import-resolver-typescript` 패키지는 이 관례적 문자열 키로만 로드된다 — 패키지명 grep 으로는 안 잡힌다 |
| `repo/manage_credit_plan.py` 안의 `manage_db` 지연 import(`_usage_index`) | 함수 안에서 import 하므로 정적 grep·graft 로는 이 의존이 안 보인다. "이 모듈은 `manage_db` 를 안 쓴다"고 오판하기 쉽다 |

### (d) 호출자가 없어 보여도 결정으로 남겨 둔 것

코드만 보면 "죽은 코드"지만 **지우기 전에 결정 기록을 먼저 읽어야 하는 것**이다. 결정을 뒤집는 것은 Jay 의 몫이다.

| 위치 | 남긴 결정 |
|---|---|
| `routers/manage.py` 의 작업 담당 배정 3라우트(`/tasks/{tid}/assignees/{uid}`·`/tasks/assignees/bulk`) + `repo/manage_tasks.py` 의 배정 쓰기 3함수 | 2026-08-21 Jay 확정(B안): 프런트 고아 코드만 제거하고 **백엔드는 휴면 유지**(DB 파괴 회피 + 혼재 버전 기간의 404 회피). [P2_CLOSEOUT_PLAN_2026-08-20.md](P2_CLOSEOUT_PLAN_2026-08-20.md) F절 |
| `styles/` 의 `.planned-*`·`.dash-due`, 그리고 산 선택자와 한 규칙에 섞여 있는 `.manage-empty-row`·`.lib-expand` | 앞의 둘은 같은 결정의 "보고만 하고 유지". [OPT_PLAN2_2026-08-21.md](OPT_PLAN2_2026-08-21.md) 의 "CSS·휴면 셀렉터 삭제 금지"는 2026-09-18 Jay 지시("주석 처리 → 실측 재확인 → 정리")로 **죽은 규칙 309개에 한해** 재개·집행됐고([status/전체점검_2026-09-18.md](status/전체점검_2026-09-18.md)), 이 둘은 그때도 남겼다. 뒤의 둘은 규칙을 통째로 지우면 산 선택자까지 사라지는 자리다 |
| `routers/manage.py` 의 `/api/manage/{timeseries,matrix,breakdown}` + `repo/manage_analytics.py`, `routers/auth.py` 의 `/api/auth/super-admin/status` | 현행 프런트는 부르지 않지만 **공유 서버는 구버전 앱의 호출도 받는다.** 서버 접근 로그로 호출자가 없음을 확인하기 전에는 지우지 않는다(2026-09-18 점검, Codex 검토) |
| `lib/useModels.ts` 의 빈 `NUMERIC_RANGE` 와 그 분기 | 주석이 "현재 항목 없음 … 범용 메커니즘은 유지"라고 명시한다 |
| `generation.py` 의 `POST /api/workspaces/select`·`/unselect` | 참조가 없어도 **의도된 410 묘비**다(옛 프런트가 200·403 을 성공으로 읽는다) |

### (e) 접근 규약이 여러 개인 곳

- **`backend/app/repo/` 파사드 vs `manage_*` 모듈 통째 import.** `repo/__init__.py` 는 `from .X import *` 로 28개 모듈을 재노출하고 바깥은 `from app.repo import X` 만 쓴다. 그런데 `repo/manage*.py` 10개 모듈은 파사드 밖에 있어 바깥이 `from app.repo import manage`/`manage_tasks` 처럼 **모듈을 통째로** import 한다. `manage_task_previews.py` 만 파사드에서 이름 지정 import(`local_task_previews`)라 셋째 규약까지 있다.
- **"키별 잠금"이 한 폴더(`services/`) 안에 3가지 해법으로 있다.** refcount+pop(`media_cache`·`thumbs`·`resolve_transfer`), `setdefault` 후 영구 보존(`asset_tree`·`project_folders`), 이벤트 루프별 `WeakKeyDictionary`(`cli_bridge`). 새 동시성 코드를 어느 쪽으로 맞춰야 하는지 코드에 근거가 없다.
- **확인 대화상자·팝오버가 세 계보로 갈려 있다(프런트).** `generation/ConfirmQuestion`(`.cs-final-*`) / `admin-confirm-*`(5곳 손구현) / `gradestep-*`(1곳). 팝오버도 `lib/useMenuPlacement`(1곳) / `SettingsGroup` 자체 구현 / `AccountMenu`·`NotificationCenter` 의 간이 포털 계산으로 셋. 어느 계보에 붙일지 판단에 시간이 든다.
- **로깅 경로가 둘이다(services).** 구조화 `log_event`(10개 파일)와 맨 `print()`(`asset_watcher`·`syncer`·`backup`·`thumbs`). `print` 중 일부(`resolve_probe`·`resolve_import_worker`·`resolve_selection_worker`·`server_relocation`·`read_utf8_sig_first_line`)는 **자식 프로세스의 IPC 채널**이라 로거로 바꾸면 안 된다 — 그 구별이 코드에서 바로 안 보인다.
- **저장 모드가 4가지(`live`/`deferUser`/`persistUser`/`persistDerived`, `SceneBoard.applyCards`)인데 이를 우회하는 직접 `persist()` 호출이 아직 10곳 넘게 남아 있다.** 어느 편집이 undo 스택에 쌓이는지 호출부마다 확인해야 한다.
- **"파이썬 실행파일 찾기"가 스크립트마다 3가지 변종(4단계/3단계/2단계)으로 8개 이상 파일에 흩어져 있다**(`run_py.bat`·`MV_agent.bat`·`MV_watchdog.bat`·`MV_server.bat`·`test_push-db.bat`·`test_pull-db.bat`·`tools/update_git_worker.bat` 등). 새 후보 경로를 넣으려면 이 파일들을 다 찾아 고쳐야 한다.

---

## 6. 이 문서를 최신으로 유지하는 법

- 파일을 추가·삭제·이동하면 해당 표의 그 한 줄만 고친다. 표 전체를 다시 만들지 않는다.
- 고친 뒤 `python tools/check_code_map.py` 로 양방향 대조를 한다 — 문서에 적힌 파일 이름이 전부 실제로
  있는지, 코드 파일이 전부 문서에 실려 있는지. 배포 게이트에는 묶지 않았다(수동 도구).
- 라우트를 추가·삭제하면 §2.2 의 해당 라우터 행(라우트 수)과 §1(관련 있으면)을 함께 고친다.
- **손으로 쓰면 낡는 목록은 이 문서에 적지 않고 코드에서 뽑는다** — [inventory/](inventory/) 의 네 문서(엔드포인트·환경변수·
  DB 테이블·백그라운드 작업). 엔드포인트·환경변수·테이블·백그라운드 시작점을 바꾸면
  `backend/tests/test_docs_inventory_fresh.py` 가 떨어진다. 그때 저장소 루트에서 `python tools/gen_inventory.py` 를 돌리고
  바뀐 `docs/inventory/` 를 문서 커밋으로 올린다. 생성 문서는 손으로 고치지 않는다(다음 생성 때 사라진다).
  `CREATE TABLE` 을 새 파일에 두면 생성 자체가 실패한다 — 도구의 `DB_FAMILY` 표에 그 테이블이 사는 DB 를 추가한다.
- 수정 후보·버그 발견·리팩터 제안은 이 문서에 넣지 않는다 — 그런 목록은 며칠이면 낡고, 이 문서는
  "파일이 어디 있나"만 답하면 된다. 후보는 별도 리뷰 문서에 남긴다.
- 큰 구조 변경(폴더 대이사·계층 이동)은 루트 `ARCHITECTURE.md` 를 먼저 갱신한 뒤 이 문서를 따라 고친다.


