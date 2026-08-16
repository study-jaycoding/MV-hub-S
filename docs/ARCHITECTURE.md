# Content Hub (server) — 설계 구조 설명서

> 이 문서는 `content-hub-server` 의 **코드·시스템 구조**를 한눈에 보여주는 구조 레퍼런스다.
> 기능 사용법은 [기능설명서.md](기능설명서.md), 서버 운영은 [SERVER.md](SERVER.md),
> AI 에게 통째로 붙여넣는 자기완결 브리프는 [AI_CONTEXT.md](AI_CONTEXT.md) 를 본다.
> (원본 [DESIGN.md](DESIGN.md)·[CLAUDE.md](CLAUDE.md) 는 개인용 `content-hub` 시절 명세라
> 일부는 현재 push 모델 이전 내용이다 — 충돌 시 **이 문서와 AI_CONTEXT.md 가 최신**.)
>
> 최종 갱신: 2026-08-05

---

## 1. 한 문장 정의

Higgsfield 로 만든 이미지·영상을 팀이 한곳에 모아 **탐색·태깅·검색·공유·재사용·계보추적**하는
풀스택 도구. 백엔드(FastAPI)가 빌드된 프론트(React)를 **같은 오리진**에서 서빙하고,
메타데이터는 SQLite(WAL), 미디어는 디스크에 둔다.

---

## 2. ★가장 중요한 구조 원칙 — "서버는 생성하지 않는다"

```
[jay PC]    자기 Higgsfield CLI ─┐
[oz1 PC]    자기 Higgsfield CLI ─┤── push(메타데이터) ──▶ [서버 = 공유 DB] ──▶ 팀 전원이 브라우저로 공유
[다른 팀원] 자기 Higgsfield CLI ─┘                          (생성 안 함 · 모아서 보여주기만)
```

- **생성·재생성은 전원 각자 로컬 CLI**(자기 크레딧). 서버는 어떤 CLI 에도 의존하지 않는다 → 클라우드로 옮겨도 동작.
- **서버로는 결과물 메타데이터만 push**. 미디어는 Higgsfield CloudFront **공개 URL** 을 그대로 참조(바이트 전송 불필요).
- **Higgsfield 토큰은 각 PC 밖으로 안 나간다**(서버는 자격증명을 저장하지 않음 — 보안 요구).
- 허브의 "생성/재생성" 버튼은 **서버에 요청만 남기고**(gen-request 큐), 그 사람 PC 의 에이전트가 가져가 로컬 CLI 로 실행한다(§7).

---

## 3. 런타임 토폴로지 — 단일 오리진

개발 모드에선 프론트(Vite 5173)·백엔드(FastAPI 8010)가 분리되지만, **서버 모드에선 백엔드가
빌드된 프론트(`frontend/dist`)를 같은 오리진에서 직접 서빙**한다. 프론트는 모든 호출을
상대경로로 하므로 폴더째 실서버에 올려도 코드 무변경, CORS 불필요.

```
[브라우저] ──http──▶ [FastAPI :8010] ──┬─ /            → frontend/dist/index.html (SPA)
                                       ├─ /assets/*    → 빌드된 JS/CSS
                                       ├─ /api/*       → REST (라우터)
                                       ├─ /ws          → 진행률·동기화 push (WebSocket)
                                       └─ /media/*     → 로컬 미디어(샤딩 디렉터리)

[팀원 각 PC] agent_push.py ──http(/api/ingest, /api/gen-requests)──▶ 같은 :8010
```

- **DB**: `backend/data/db/content_hub.db` (SQLite WAL). 휴지통은 별도 DB `content_hub_trash.db`.
- **미디어**: `backend/data/media/<sha[:2]>/<sha>.ext` (2단계 샤딩).
- **포트·인증**: `MV_server.bat` 기본 **8010 + 로그인 ON**(`CONTENT_HUB_AUTH=1`). `serve.py` 가 IPv4/IPv6 듀얼스택.
- ⚠️ **`--reload` 금지** — uvicorn 리로더가 SelectorEventLoop 을 강제해 CLI subprocess 가 깨진다. 백엔드 변경은 **서버 재시작**, 프론트 변경은 `npm run build` + 브라우저 **Ctrl+F5**(dist 즉시 서빙).

---

## 4. 백엔드 계층 구조

요청은 **미들웨어 → 라우터 → usecase(업무 흐름) → repo(데이터 접근)** 로 흐른다.
단순 CRUD는 라우터가 repo를 바로 호출할 수 있지만, 여러 저장소·외부 효과를 묶는 흐름은 usecase가 소유한다.

```
HTTP 요청
   │
   ▼  app/main.py 미들웨어
   ├─ auth_enforcement : 토큰 → request.state.account  (CONTENT_HUB_AUTH=1 일 때 게이트)
   └─ mutation_notify  : 성공한 쓰기를 library/assets/manage로 분류해 WS 갱신 신호 전파
   │
   ▼  routers/*.py   — HTTP 경계. 입력 검증(Pydantic) + deps(인증/RBAC) + actor_id 주입
   │
   ▼  usecases/*.py  — 여러 repo·서비스를 묶는 업무 순서와 실패/보상 규칙
   │
   ▼  repo/*.py      — 데이터 접근 계층. 순수 SQL/직렬화. HTTP 를 모름(테스트·재사용 쉬움)
   │
   ▼  db.py (SQLite)  +  services/*.py (CLI·미디어·동기화·백업·인증)
```

### 4.1 코어 (`backend/app/`)

| 파일 | 역할 |
|---|---|
| `main.py` | FastAPI 앱·미들웨어·lifespan(init_db·고아잡정리·중복병합·creator_uid 백필·계정↔creator 연결·신원캡처·썸네일 사전생성·주기 동기화/백업)·`/media`·SPA 마운트 |
| `db.py` | 스키마 적용·마이그레이션·인덱스·FTS5. `python -m app.db init` 멱등 |
| `models.py` | 요청/응답 Pydantic 모델 |
| `config.py` | 경로·포트·`CONTENT_HUB_AUTH` 등 환경 설정 |
| `deps.py` | 인증/RBAC FastAPI 의존성(`actor_id`·`require_global_cap`·`require_project_role`·`require_edit_generation`) |
| `rbac.py` | 역할·역량 정의(전역 역할 + 프로젝트 역할) |
| `mutation_notify.py` | 본 서버·위임 프록시가 공유하는 변경 영역 판정과 요청 출처 헤더 계약 |
| `ws.py` | `ConnectionManager` — 진행률·`synced`·`assets_changed`·`manage_changed` 병합 전파(0.4s 디바운스) |

### 4.2 라우터 (`backend/app/routers/`) — HTTP 경계

| 라우터 | 담당 |
|---|---|
| `library.py` | 목록·검색·통계·facets·휴지통·**미디어 썸네일**·`tab=my` 계정 스코프 |
| `generation.py` | 태그/컬러/소스/코멘트·삭제·복원·Higgsfield 검증·리니지(옛 서버측 생성 경로 잔존·미사용) |
| `gen_requests.py` | **로컬 실행 큐**: 생성요청·pending claim·fulfill·fail |
| `ingest.py` | **push 적재**·known-jobs·`/credits` |
| `share.py` | 발행/가져오기/번들 export·import |
| `projects.py` | 프로젝트 CRUD·멤버·배정·보관 |
| `auth.py` | 로그인·가입·계정 승인 |
| `members.py` | 등급(전역 역할) 관리 |
| `assets.py` / `assets_metadata.py` | Assets 분리창(폴더 마운트·트리·파일 서빙·업로드) / 파일메타·코멘트 |
| `sync.py` | 수동 동기화 트리거·sync-status |
| `publish.py` | 공유 서버 번들 발행 수신(`/share/publish-bundle`)·공유 서버 로그인/토큰 |
| `manage.py` | PM 관리창 API(작업·일정·대시보드·팀 텔레메트리 push·완료본 저장) |
| `comfy.py` | ComfyUI 연결·워크플로 파싱·비동기 실행(`/run`+`/run_status`)·라이브러리 저장 |
| `resolve_integration.py` | DaVinci Resolve 전송·스크립트 설치·수동 가져오기 결과 기록 |
| `release_update.py` | 작업자 릴리스 자동 업데이트(status/start — 로컬 전용) |
| `scenes.py` | 씬 캔버스 DB 미러 백업(PUT/GET /scenes/backup) |
| `db_backup.py` / `db_transfer.py` | DB 백업 스트리밍 / 로컬 DB 내보내기·가져오기·복원(유지보수 게이트) |
| 내부: `_proxy.py` / `_telemetry.py` / `_assets_access.py` | 데이터 소유권 프록시 위임 / 텔레메트리 드레인 스케줄 / Assets 접근 가드 |

### 4.3 유스케이스 (`backend/app/usecases/`)

| 모듈 | 담당 |
|---|---|
| `gen_requests.py` | 생성 요청 create/claim/fulfill/fail/reconcile의 업무 순서. 라우터는 인증·HTTP 변환만 담당 |
| `generation_media_cache.py` | 미디어 보관(⤓ byte-cache) 오케스트레이션 |
| `generation_personal_meta.py` | 팀 카드 개인 메타(색·태그 오버레이) 업무 흐름 |
| `hf_missing.py` | Higgsfield 쪽에 없는 로컬 카드 점검·정리 |

> usecase 는 FastAPI 를 직접 import 하지 않는다(test_architecture_boundaries 가 강제).
> 알려진 예외: `gen_requests.py` 가 진행률 브로드캐스트를 위해 `app.ws` 를 직접 의존한다
> — ws.py 가 FastAPI 타입을 쓰므로 전이적으로는 묶여 있다. 다음 정리 후보(notifier 포트 주입).

### 4.4 데이터 접근 (`backend/app/repo/`) — 패키지로 분해

`repo.py` 가 비대해져 모듈로 분리, `__init__.py` 의 re-export 로 `repo.X` API 동일 유지(파사드).

| 모듈 | 담당 |
|---|---|
| `_common.py` | 공용 헬퍼·상수(`new_id`·미디어 캐시 헬퍼·**알림 SQL 조각 `ALERT_COMMENT_JOINS`/`ALERT_COMMENT_PREDICATE`**) |
| `generations.py` | 생성물 로컬 생성·상태 변경·삭제·재조정의 중심 저장소 |
| `generation_sync.py` / `generation_references.py` | CLI 결과 단건·배치 적재·known job 경계 / 공용 레퍼런스 쓰기 |
| `generations_query.py` / `generation_rows.py` / `facets.py` | 목록·직렬화·조회 응답 보강·facet 집계 |
| `id_resolve.py` | `generation.id`와 외부 `job_id`의 호환 해석 경계 |
| `lineage.py` / `history.py` / `sources.py` | 계보 엣지·가계 조회·소스 검색 |
| `gen_requests.py` | 생성 레시피·claim·fulfill mark |
| `identity.py` | 생성자·신원 해석(`resolve_display_names`)·`link_accounts_to_creators`·`set_account_hf_creator`·`credit_summary`·`list_members` |
| `tags.py` | 일반 태그 + 자동태그(별도 네임스페이스, owner 스코프) |
| `assets.py` | 생성본 코멘트 스레드 + Assets 분리창 파일메타/코멘트 |
| `share.py` | 발행·번들 export/import·병합 |
| `projects.py` | 프로젝트·멤버 |
| `accounts.py` | 가입·인증·승인 |
| `trash.py` | 휴지통(별도 DB 원자 이동·복원·영구삭제) |
| `manage.py` | PM 관리 저장소 호환 파사드와 프로젝트·내보내기·메트릭 경계 |
| `manage_tasks.py` | PM 작업 조회·자동 폴더 작업·담당자 배정·작업 CRUD |
| `manage_schema.py` / `manage_telemetry.py` | 관리 사이드카 스키마·outbox 팩트 전송 상태 |
| `manage_transactions.py` / `manage_analytics.py` | 실제 크레딧 거래 매칭·읽기 전용 분석 집계 |

### 4.5 서비스 (`backend/app/services/`) — 외부 연동·부수효과

| 서비스 | 담당 |
|---|---|
| `cli_bridge.py` | Higgsfield CLI 래퍼(parse_job·list_jobs·list_models·estimate_cost·account status·workspace). ⚠️ Windows 셰임/Proactor 함정. ★CLI 는 `hf_cli_version.txt` 로 pin, 1.x 필드개명은 `x.get(new) or x.get(old)` 폴백(→`HF_CLI_UPGRADE.md`). 서버측 create_job 은 제거됨(push 모델) |
| `syncer.py` | 주기 동기화(과도기: 서버 PC 로컬 결과 흡수) |
| `media_cache.py` | 원격 URL → 로컬 샤딩 캐시 |
| `thumbs.py` | 썸네일 사전생성·리사이즈 |
| `backup.py` | 콘텐츠·휴지통·관리 DB의 동일 읽기 시점 SQLite 온라인 백업 세트 |
| `auth.py` | pbkdf2 비번 해시 + 무상태 HMAC 세션 토큰 |
| `agent_signals.py`·`mcp_ingest.py` | 에이전트·MCP 적재 보조 |
| `comfy_client.py` / `comfy_workflow.py` | ComfyUI(로컬·Cloud) HTTP 클라이언트 / 워크플로 슬롯·파라미터 파싱 |
| `resolve_bridge.py` / `resolve_transfer.py` / `resolve_probe.py` / `resolve_status_runner.py` / `resolve_script_installer.py` | Resolve Media Pool 가져오기 / 렌더폴더 전송·manifest / 프로세스 격리 상태 조회 / 스크립트 설치 |
| `release_update.py` | 작업자 릴리스 자동 업데이트 상태·부트스트랩 실행기 |
| `telemetry_drain.py` | PM 텔레메트리 outbox 드레인(백오프·격리 모드) |
| `operational_health.py` / `operational_logging.py` / `runtime_metrics.py` | /api/ready 판정·경보 / JSON 운영 로그·회전 / 요청·자원 메트릭 |
| `backup_verify.py` / `db_scrub.py` / `test_snapshot.py` | 백업 복원 검증 / 개인정보 스크럽 / 테스트 스냅샷 |
| `asset_io.py` / `asset_tree.py` / `asset_mounts.py` / `asset_watcher.py` / `asset_paths.py` | Assets 파일 IO·트리 캐시·마운트·변경 감시·경로 |
| `video_convert.py` / `media_types.py` / `path_safety.py` / `atomic_io.py` / `net_guard.py` | ffmpeg 변환 / 미디어 판별 / 경로 안전 / 원자 쓰기 / SSRF 가드 |
| `remote_realtime.py` / `local_agent_pair.py` / `request_guards.py` / `event_journal.py` / `sqlite_db.py` | 서버 WS 중계 / 에이전트 페어링 / 로컬 요청 가드 / 생성 이벤트 저널 / SQLite 검증 |
| ~~`jobs.py`~~ | 옛 서버측 잡 큐 — **제거됨**(push 모델 전환. POST /api/generations·/regenerate 라우트도 삭제) |

### 4.6 보조 스크립트 (`backend/`)

- `serve.py` — 듀얼스택 기동 진입점. `schema.sql` — SQLite DDL.
- `backfill_import.py` — 일괄 적재. PostgreSQL 런타임과 이관 도구는 현재 제거·미지원.

---

## 5. 프론트엔드 구조 (`frontend/src/`)

```
App.tsx  ─ 최상위 상태·무한스크롤(reload/loadMore)·필터합성(genQuery)·인증 부트스트랩·WS 진행률·캔버스 탭 신호
  │
  ├─ api.ts        타입세이프 클라이언트(create/regenerate→ /api/gen-requests, Bearer, 401→로그인)
  ├─ types.ts      응답 타입
  ├─ lib/          순수 유틸·훅(아래 §5.1)
  └─ components/    화면 컴포넌트(아래 §5.2)
```

### 5.1 공용 유틸·훅 (`lib/`)

| 파일 | 역할 |
|---|---|
| `i18n.ts` / `theme.ts` | 다국어(ko/en) / 강조색·모션·언어 |
| `storage.ts` | `makeStore`(prefix 스토어) + `loadJSON`(안전 파싱) |
| `useFloatingPanel.ts` / `useModels.ts` / `useAccountStatus.ts` | 플로팅 패널·모델 목록·계정 상태 훅 |
| `promptParts.ts` / `prompt.tsx` / `promptEditor.ts` | 프롬프트 파싱·@칩 렌더·편집 |
| `format.ts` | `fmtWhen`(날짜 포맷, 공용) |
| `media.ts` | `thumbOf`(생성본 대표 썸네일 URL, 공용) |
| `download.ts` | `download`·`downloadName`(파일 내려받기, 공용) |
| `commentTree.ts` | `buildCommentTree<T>`(코멘트 부모-자식 트리 계산, 공용) |
| `useClickSeparation.ts` | 단일/더블클릭 220ms 분리 훅 + 언마운트 타이머 정리(공용) |
| `useSpotlightSubmit.ts` | Spotlight 입력 정규화·생성 요청·배치 제출 흐름. `App`은 ref의 `submit` 계약만 사용 |
| `useSceneHistory.ts` | 씬별 커밋 기준선·undo/redo·생성 결과 이력 보정. 화면 상태는 `SceneBoard`가 유지 |
| `useSceneKeyboardShortcuts.ts` / `sceneKeyboard.ts` | 캔버스 단축키 리스너 생명주기 / 입력 대상·키 의도 순수 판정 |
| `useSceneDragSession.ts` / `sceneDragSession.ts` | 전역 드래그 리스너·프레임 합치기 / React 비의존 드래그 세션 생명주기 |
| `useSceneViewport.ts` / `sceneViewport.ts` | 팬·줌·미니맵·카메라 저장·컬링 갱신 / 좌표·프레이밍 순수 계산 |
| `useSceneComfyExecution.ts` | Comfy 단독/배치 실행·중복 방지·씬 전환 중단·실행 표시 수명주기 |
| `sceneComfyExecutor.ts` | 미디어 확보·연결 텍스트·시드 변환 후 Comfy API를 호출하는 React 비의존 경계 |
| `sceneDerive.ts` / `sceneComfySeeds.ts` | 그룹 기하·파생 상태 계산 / 워크플로 시드 변경 순수 함수 |
| `librarySync.ts` | 쓰기 요청 id와 library/assets/manage 응답 영역을 추적해 자기 알림의 중복 reload만 안전하게 생략 |
| `assetBroadcast.ts` / `useManageRealtime.ts` | Assets 창 간 WS 전달 / 독립 PM 창의 직접 WS·숨김 상태 따라잡기 |

> `format`·`media`·`download`·`commentTree`·`useClickSeparation` 은 여러 컴포넌트에 복붙돼 있던
> 동일 로직을 통합한 결과물(중복 제거 리팩터). `MediaThumbnail` 도 같은 맥락의 공용 표현 컴포넌트.

### 5.2 화면 컴포넌트 (`components/`)

- **라이브러리**: `ThumbnailGrid`·`GenerationCard`(카드·오버레이·대기/생성 중 로고·상태 툴팁·썸네일)·`MediaThumbnail`·`FilterSidebar`·`LibraryToolbar`·`SearchBox`·`TopBar`.
- **생성**: `SpotlightPrompt`(@/# 피커)·`FloatingPrompt`.
- **캔버스 탭**(씬 캔버스 · 히스토리 보기): `SceneBoard`는 카드 상태·선택·노드별 포인터 판정·렌더 조립을 소유한다. 저장/undo, Comfy 실행, 단축키, 드래그 세션, 팬·줌은 전용 훅에 위임한다. 계보 뷰는 `HistoryBoard`·`HistoryPanel`·`HistoryMiniTree`·`CompareModal`이 담당한다.
- **코멘트**: `GenCommentPanel`(생성본 스레드·NEW 알림).
- **계정/관리**: `LoginScreen`·`AccountMenu`(워크스페이스 전환·크레딧 게이지 — 분모는 프로젝트 예산 합)·`ManageAccount`·`AdminWindow`(승인·등급·프로젝트)·`SettingsPanel`(강조색·언어·모션·다운로드 위치·과거 가져오기·내 메타데이터·동기화 점검·DaVinci Resolve·프로그램 업데이트·생성물 재점검·단축키·ComfyUI 연결 — `settings/SettingsSections.tsx`).
- **Assets 분리창**: `AssetsWindow`·`AssetsView` + `assets/`(`AssetCell`·`FolderTree`·`MountManager`·`treeUtils`·`exportDrag`·`useAssetBroadcastSync`). 메인 창 없이도 WS를 직접 구독한다.
- **PM 분리창**: `ManageWindow` + `manage/`(`DashboardView`·`WorkBoard`·`ExportView`). 전용 실시간 신호를 활성 탭의 한 번짜리 재조회로 합친다.
- **보조**: `InfoPopup`·`MediaPreview`·`ProjectAssignMenu`·`ShortcutsWindow`.

---

## 6. 데이터 모델

PK 는 전부 TEXT(uuid). 목록 정렬은 항상 `sort_ts DESC, id DESC`(키셋 페이지네이션).

| 테이블 | 역할 | 핵심 컬럼 |
|---|---|---|
| `generation` | 생성 1건(중심) | id, prompt, display_prompt(@칩 보존), model, params(JSON), color, status, **sort_ts**(정밀 epoch=정렬키), job_id, is_source, source_name, **creator_uid**, project_id, deleted_at, hf_missing, **is_final/final_by/final_at**(골드) |
| `asset` | 결과물 미디어 | generation_id, type(image/video), file_path(/media 또는 원격 URL), thumbnail_path, **source_url**(원격 원본 보존) |
| `reference`+`gen_reference` | 생성에 쓴 레퍼런스(N:N) | role(@Image1/@Video/@start…), source, file_path, source_url |
| `tag`+`gen_tag` / `auto_tag`+`gen_auto_tag` | 일반 태그 / 자동태그(별도 네임스페이스·owner 스코프·'무장' 시 새 생성 자동적용) | name |
| **`lineage`** | 계보(타입드 엣지) | parent_gen_id → child_gen_id, **relation**: `derived`(재생성/가져오기, 강한 1부모) · `reference`(@소스 생성, 약한 다부모). UNIQUE(parent,child,relation) |
| `share` | 팀 공유 발행 | generation_id, shared_by, visibility |
| `generation_comment`(+`_read`,+`_seen`) | 공유 코멘트 스레드 + 읽음/확인 | gen_id, author, text, parent_id |
| `project`+`project_member` | 작업 묶음(공유·이동 단위) | name, kind, archived / project_id, creator_uid, project_role |
| `creator` | 생성자 uid→이름·전역역할 | uid, name, global_role(CSV) |
| `account` | 로그인 계정 | email, password_hash(pbkdf2), status, global_role(CSV), **creator_uid**, approved_at |
| **`gen_request`** | 로컬 실행 생성요청 큐 | account_email, creator_uid, gen_id(placeholder), kind(create/regenerate), payload(레시피 JSON), status, error |
| **`generation_event`** | 장기 생성 상태 이력(append-only 운용) | generation/request/job id, event, from/to phase, provider_status, reason_code |
| **`audit_event`** | 중요 관리자·프로젝트 변경 감사 기록 | action, actor uid, target/project id, 변경 필드와 허용된 짧은 메타 |
| `app_setting` | key-value | provider_uid/name/email, my_creator_uid, auth_secret, **hf_status:\<email\>**(크레딧 보고) |
| `asset_meta`+`asset_comment`(+`_read`) | Assets 분리창 파일별 메타/코멘트 | (project, path) 키, owner_uid 개인화 |
| `trashed`(별도 DB) | 휴지통 | id, trashed_at, payload(본체+자식 전부) |

> ⚠️ **마이그레이션 순서 함정**: `schema.sql` 의 executescript 가 `db.py _migrate` 의 ALTER 보다
> **먼저** 실행된다 → 새로 ALTER 되는 컬럼(예 `lineage.relation`)에 거는 인덱스는 `_migrate` 에만 둔다.
> 새 테이블(IF NOT EXISTS)은 schema.sql 에 둬도 멱등이라 안전.

---

## 7. 핵심 흐름

### 7.1 생성/재생성 (로컬 실행 큐 = gen-request)

```
허브 "생성/재생성" 버튼
   │ POST /api/gen-requests (kind=create|regenerate)
   ▼ 서버: placeholder 카드 즉시 생성(status=pending, 요청자 소유) + 큐잉
   │       (재생성은 placeholder + 'derived' 리니지까지)
   ▼ GET /api/gen-requests/pending  (새 에이전트: claim → claimed)
요청자 PC 에이전트(agent_push.py --watch):
   │   레퍼런스·워크스페이스 준비
   │   POST /begin-submission ACK → submitting
   │   제출 워커(기본 8): higgsfield generate create <model> --prompt …  ← 자기 로컬 CLI(유료)
   │   job_id 즉시 anchor → 원격 작업 최대 64개 추적
   │   기한이 된 작업을 generate get <job_id> 로 직접 권위 확인
   │   성공 상태 + 결과 URL + 서버의 asset 저장 ACK가 모두 있어야 완료 확정
   ▼ POST /api/gen-requests/{id}/reconcile (완료 확정) | /fail (제출 실패)
   ▼ 서버: placeholder 에 결과 채움 + WS broadcast → 카드 done/failed
```

`generate list` 는 로컬 히스토리 적재(§7.2)에 사용한다. 생성 요청의 완료 판정에는 쓰지 않는다.
목록 반영이 늦거나 작업이 목록에서 빠져도 이미 제출한 유료 작업의 `job_id` 추적은 유지되며,
에이전트 재시작 뒤에는 로컬 추적 파일·서버 reconcile 후보로 복구한다.

CLI 호출 전 `claimed`는 lease 만료 시 안전하게 대기열로 돌아갈 수 있다. CLI 호출 후 `job_id`가
없는 `submitting`은 외부 과금 여부를 확정할 수 없으므로 자동 재실행하지 않고
`recovery_required`로 격리한다. 상태 전이·혼합 버전·운영 복구 절차는
[GENERATION_SUBMISSION_RECOVERY.md](GENERATION_SUBMISSION_RECOVERY.md)를 따른다. RL-05는
`1252b52d`에서 내부 계약·전체 회귀·비용 없는 중단 드릴·격리 브라우저 실측을 완료했다.
실제 유료 생성 중단과 혼합 PC 업데이트는 외부 통합 검증으로 남긴다.

팀 워크스페이스 생성은 id와 표시 이름이 모두 준비된 뒤에만 제출한다. 브라우저 저장 필터에서
id만 먼저 복원된 경우 `AccountMenu`가 계정 에이전트의 최신 워크스페이스 보고와 같은 id를 찾아
정식 이름을 보완한다. 이 보완 전에는 프론트 API 경계가 생성·재생성을 차단한다. 서버는 로그인
계정이 접근 가능한 등록부 ID인지 다시 확인하고 공식 이름으로 교체하므로 직접 API 호출도 우회할 수 없다.
기존 데이터는 시작 마이그레이션이 등록부와 ID가 정확히 일치하고 이름이 빈 팀 생성물만 보강한다.
격리된 관리 집계 DB도 콘텐츠 DB와 직접 조인하지 않고 같은 등록부 스냅샷을 받아 빈 이름만 보강한다.

버튼·UX 는 그대로, 실행 주체만 "서버 1개 CLI"→"각자 로컬 CLI". 결과·크레딧·귀속은 실행한 사람 것.

### 7.2 push 적재(ingest)

```
agent_push.py(각 PC) cycle = ① execute_pending(§7.1) + ② reconcile_pass(재시작·순단 복구) + ③ push_once
push_once: 로컬 generate list → POST /api/ingest/known-jobs {job_ids}
           → 서버가 unknown(신규)·refresh(재확인 필요) job_id 만 반환
           → POST /api/ingest {jobs, creator_uid, account_status}
서버: 각 잡은 자기 고유 creator_uid 유지(uid 없을 때만 보강). account_status 를 app_setting 에 저장(크레딧).
```

구버전 서버가 POST 차집합 계약을 지원하지 않을 때만 `GET /api/ingest/known-jobs` 전량 응답으로
폴백한다. 운영 기본 경로는 로컬 job_id만 보내는 POST라서 서버 데이터가 커져도 왕복 크기가 제한된다.

> 내 Higgsfield uid 는 **로컬 전체 목록의 최다 user_\<id\>** 로 산출해 명시 전송한다(fresh 부분집합만
> 보면 남의 레퍼런스에 오염돼 잘못 연결되는 실측 버그 회피).

### 7.3 계보(리니지) 가시화

- 재생성 → `derived` 엣지(강한 1부모), @소스 참조 생성 → `reference` 엣지(약한 다부모).
- **캔버스 탭 · 히스토리 보기**(`HistoryBoard`)가 원본→파생 가로 트리로 그린다. 형제 정렬을 위해 각 노드의 derived 체인 깊이를 `_derived_depth_batch` 가 레벨별 일괄 조회로 계산(N+1 회피).

### 7.4 생성본 코멘트 알림(미확인 뱃지)

- **코멘트 단위 seen 모델**(`generation_comment_seen`). 미확인=알림 규칙은 `_common` 의
  `ALERT_COMMENT_JOINS` + `ALERT_COMMENT_PREDICATE` 한 곳에서 정의 → 카드 뱃지·전역 통계·패널 NEW 세 경로가 항상 일치.
- 알림 대상: ① 내가 만든 생성물에 달린 코멘트, 또는 ② 내 코멘트에 달린 답글만(내 글 제외).

---

## 8. 횡단 관심사

- **두 종류 로그인 구분**: ① 허브 세션(브라우저 계정, 신원·권한) ② Higgsfield CLI 인증(각 PC, 생성 주체). 완전 별개.
- **멀티계정 신원**: `account`(로그인) 과 `creator`(작성자)는 별개 축, `account.creator_uid` 로 연결. 첫 가입자=부트스트랩 관리자, 이후 pending→승인.
- **RBAC**: 전역 역할(admin/product_manager/product_director/production_director/member, CSV 복수) + 프로젝트 역할(project_manager/supervisor/editor). `CONTENT_HUB_AUTH=1` 일 때만 게이트.
- **개인화 vs 공유**: 컬러·태그·소스명·파일메타는 계정별 개인 소유(owner_uid). 코멘트 스레드·공유여부·프롬프트·소스는 공유.
- **표시이름 단일 해석**: `resolve_display_names`(creator.name → account.name → email) 읽기 시점에만.
- **실시간**: 성공한 쓰기는 `library`→`synced`, `assets`→`assets_changed`, `manage`→`manage_changed`로 분리한다. 요청 id·영역 응답 헤더로 자기 알림 재조회를 생략하며 독립 Assets/PM 창은 자체 WS를 가진다.
- **검색**: SQLite FTS5(trigram, 3자↑), 3자 미만 LIKE 폴백.
- **성능**: 키셋 페이지네이션·content-visibility 가상스크롤·썸네일 사전생성·미디어 2단계 샤딩.
- **휴지통**: 삭제 즉시 별도 DB 로 원자 이동(메인 항상 가벼움).
- **운영 관측 2계층**: 회전 JSON 로그는 현재 상황을 빠르게 보고, `generation_event`/`audit_event`는
  로그 회전 뒤에도 생성 전이와 중요 변경을 재구성한다. DB 트리거가 모든 상태 변경을 같은
  트랜잭션에서 포착하고 usecase가 의미 이벤트를 보강한다. 프롬프트·결과 URL·비밀번호는 넣지 않는다.

---

## 9. 비자명한 설계 결정 / 함정 (요약)

1. **서버는 생성 안 함** — 전원 로컬 CLI + push(§2). 옛 서버측 직접 생성 엔드포인트와 잡 큐는 제거됐다.
2. **두 로그인 구분** — 허브 세션 ≠ Higgsfield CLI 인증(§8).
3. **계정↔creator 재연결 오염** 방지 — 잡 고유 uid 유지 + 이미 실제 uid 면 재연결 금지 + 에이전트가 전체목록 최다 uid 전송.
4. **미디어 공개 URL + 선택 보존** — 일반 생성물은 Higgsfield 원격 URL을 참조해 push 시 바이트를
   전송하지 않는다. 최종(골드) 지정본은 백그라운드에서 자동 byte-cache(best-effort)하고,
   개별 `/api/generations/{id}/cache`·전체 `/api/cache-all` 보관도 지원한다. 아직 보관하지 않은
   일반 생성물의 원격 URL은 만료될 수 있다.
5. **단일 오리진 / 키셋 / FTS5 / 휴지통 별도 DB(WAL) / 미디어 샤딩**. DB 는 SQLite 단일(§4.6).
6. **마이그레이션 순서 함정**(§6) — 새 ALTER 컬럼 인덱스는 `_migrate` 에만.
7. **출처 영속화**(provenance) — `source_url` 보존으로 재사용·변형 가능(최우선 가치).
8. **자동 태그 격리** — 일반 태그와 완전 분리 네임스페이스.
9. **`--reload` 금지 / 서버 재시작 필수**(백엔드). 프론트는 build + Ctrl+F5.
10. **생성은 유료** — 실제 생성 트리거는 크레딧 소모(테스트 시 주의).

---

## 10. 디렉터리 트리 (요약)

```
MV-hub-S/
├─ MV_server.bat / MV_agent.bat / MV_watchdog.bat / MV_logs.bat   서버·작업자·워치독·로그 런처
├─ register_autostart.bat / update_git.bat / update_release.bat   자동시작 등록 / 업데이트(서버·작업자)
├─ agent_push.py / run_agent_session.py                           push 에이전트 / Job Object 감시 런처
├─ docs/                     ARCHITECTURE(이 문서)·SERVER·SERVER_RECOVERY·TESTING·설명서들
├─ deploy/  release/  tools/ 배포 설정 / 릴리스 패키징 / 운영·점검 스크립트(워치독·백업복제·등록부정리)
├─ backend/
│  ├─ serve.py               듀얼스택 기동
│  ├─ schema.sql             DDL(SQLite)
│  └─ app/
│     ├─ main.py db.py db_migrations.py models.py config.py deps.py rbac.py ws.py manage_db.py
│     ├─ routers/   §4.2 의 22개 + 내부(_proxy·_telemetry·_assets_access)
│     ├─ usecases/  gen_requests generation_media_cache generation_personal_meta hf_missing
│     ├─ repo/      §4.4 의 30개 모듈(파사드 __init__)
│     ├─ services/  §4.5 의 40개
│     └─ resources/resolve/  MVHub_Importer.py 등 Resolve 배포 스크립트
└─ frontend/
   ├─ dist/                  빌드 산출물(백엔드가 서빙)
   └─ src/
      ├─ App.tsx api.ts types.ts main.tsx
      ├─ lib/         160+ 훅·유틸(§5.1)
      └─ components/  12개 서브폴더 — scene/ assets/ manage/ spotlight/ settings/ history/
                      sidebar/ app/ generation/ compare/ common/ admin/ + 최상위 창·패널들
```
