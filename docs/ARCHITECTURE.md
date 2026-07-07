# Content Hub (server) — 설계 구조 설명서

> 이 문서는 `content-hub-server` 의 **코드·시스템 구조**를 한눈에 보여주는 구조 레퍼런스다.
> 기능 사용법은 [기능설명서.md](기능설명서.md), 서버 운영은 [SERVER.md](SERVER.md),
> AI 에게 통째로 붙여넣는 자기완결 브리프는 [AI_CONTEXT.md](AI_CONTEXT.md) 를 본다.
> (원본 [DESIGN.md](DESIGN.md)·[CLAUDE.md](CLAUDE.md) 는 개인용 `content-hub` 시절 명세라
> 일부는 현재 push 모델 이전 내용이다 — 충돌 시 **이 문서와 AI_CONTEXT.md 가 최신**.)
>
> 최종 갱신: 2026-06-19

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

요청은 **미들웨어 → 라우터 → repo(데이터 접근) → db/services** 로 한 방향으로 흐른다.

```
HTTP 요청
   │
   ▼  app/main.py 미들웨어
   ├─ auth_enforcement : 토큰 → request.state.account  (CONTENT_HUB_AUTH=1 일 때 게이트)
   └─ mutation_notify  : 성공한 쓰기(POST/PUT/PATCH/DELETE) 후 WS 'synced' broadcast
   │
   ▼  routers/*.py   — HTTP 경계. 입력 검증(Pydantic) + deps(인증/RBAC) + actor_id 주입
   │
   ▼  repo/*.py      — 데이터 접근 계층. 순수 SQL/직렬화. HTTP 를 모름(테스트·재사용 쉬움)
   │
   ▼  db.py (SQLite/PG)  +  services/*.py (CLI·미디어·동기화·백업·인증)
```

### 4.1 코어 (`backend/app/`)

| 파일 | 역할 |
|---|---|
| `main.py` | FastAPI 앱·미들웨어·lifespan(init_db·고아잡정리·중복병합·creator_uid 백필·계정↔creator 연결·신원캡처·썸네일 사전생성·주기 동기화/백업)·`/media`·SPA 마운트 |
| `db.py` | 스키마 적용·마이그레이션·인덱스·FTS5. `python -m app.db init` 멱등 |
| `pgsupport.py` | PostgreSQL 방언 shim(옵트인 이중 백엔드) |
| `models.py` | 요청/응답 Pydantic 모델 |
| `config.py` | 경로·포트·`CONTENT_HUB_AUTH` 등 환경 설정 |
| `deps.py` | 인증/RBAC FastAPI 의존성(`actor_id`·`require_global_cap`·`require_project_role`·`require_edit_generation`) |
| `rbac.py` | 역할·역량 정의(전역 역할 + 프로젝트 역할) |
| `ws.py` | `ConnectionManager` — 진행률·`synced` broadcast(0.4s 디바운스) |

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
| `assets.py` | Assets 분리창(폴더 마운트·파일메타·파일 코멘트) |
| `sync.py` | 수동 동기화 트리거 |

### 4.3 데이터 접근 (`backend/app/repo/`) — 패키지로 분해

`repo.py` 가 비대해져 모듈로 분리, `__init__.py` 의 re-export 로 `repo.X` API 동일 유지(파사드).

| 모듈 | 담당 |
|---|---|
| `_common.py` | 공용 헬퍼·상수(`new_id`·미디어 캐시 헬퍼·**알림 SQL 조각 `ALERT_COMMENT_JOINS`/`ALERT_COMMENT_PREDICATE`**) |
| `generations.py` | 중심: `list_generations`(키셋·검색)·업서트·재생성·`account_uid` 스코프·**리니지 그래프**(`_derived_depth_batch` 등) |
| `gen_requests.py` | 생성 레시피·claim·fulfill mark |
| `identity.py` | 생성자·신원 해석(`resolve_display_names`)·`link_accounts_to_creators`·`set_account_hf_creator`·`credit_summary`·`list_members` |
| `tags.py` | 일반 태그 + 자동태그(별도 네임스페이스, owner 스코프) |
| `assets.py` | 생성본 코멘트 스레드 + Assets 분리창 파일메타/코멘트 |
| `share.py` | 발행·번들 export/import·병합 |
| `projects.py` | 프로젝트·멤버 |
| `accounts.py` | 가입·인증·승인 |
| `trash.py` | 휴지통(별도 DB 원자 이동·복원·영구삭제) |

### 4.4 서비스 (`backend/app/services/`) — 외부 연동·부수효과

| 서비스 | 담당 |
|---|---|
| `cli_bridge.py` | Higgsfield CLI 래퍼(parse_job·list_jobs·list_models·estimate_cost·account status·workspace). ⚠️ Windows 셰임/Proactor 함정. ★CLI 는 `hf_cli_version.txt` 로 pin, 1.x 필드개명은 `x.get(new) or x.get(old)` 폴백(→`HF_CLI_UPGRADE.md`). 서버측 create_job 은 제거됨(push 모델) |
| `syncer.py` | 주기 동기화(과도기: 서버 PC 로컬 결과 흡수) |
| `media_cache.py` | 원격 URL → 로컬 샤딩 캐시 |
| `thumbs.py` | 썸네일 사전생성·리사이즈 |
| `backup.py` | SQLite 온라인 백업 |
| `auth.py` | pbkdf2 비번 해시 + 무상태 HMAC 세션 토큰 |
| `agent_signals.py`·`mcp_ingest.py` | 에이전트·MCP 적재 보조 |
| ~~`jobs.py`~~ | 옛 서버측 잡 큐 — **제거됨**(push 모델 전환. POST /api/generations·/regenerate 라우트도 삭제) |

### 4.5 보조 스크립트 (`backend/`)

- `serve.py` — 듀얼스택 기동 진입점. `schema.sql`·`schema_pg.sql` — DDL.
- `migrate_to_pg.py` — SQLite → PostgreSQL 이관. `backfill_import.py` — 일괄 적재.

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

> `format`·`media`·`download`·`commentTree`·`useClickSeparation` 은 여러 컴포넌트에 복붙돼 있던
> 동일 로직을 통합한 결과물(중복 제거 리팩터). `MediaThumbnail` 도 같은 맥락의 공용 표현 컴포넌트.

### 5.2 화면 컴포넌트 (`components/`)

- **라이브러리**: `ThumbnailGrid`·`GenerationCard`(카드·오버레이·로컬 대기/생성중 라벨·썸네일)·`MediaThumbnail`·`FilterSidebar`·`LibraryToolbar`·`SearchBox`·`TopBar`.
- **생성**: `SpotlightPrompt`(@/# 피커)·`FloatingPrompt`.
- **캔버스 탭**(씬 캔버스 · 히스토리 보기): `SceneBoard`/`SceneBar`(자유 배치 씬 — 카드·연결·태그, localStorage)와 계보 뷰 `HistoryBoard`(원본→파생 가로 트리·무한 캔버스)·`HistoryPanel`(가계 패널)·`HistoryMiniTree`·`CompareModal`.
- **코멘트**: `GenCommentPanel`(생성본 스레드·NEW 알림).
- **계정/관리**: `LoginScreen`·`AccountMenu`·`ManageAccount`·`AdminWindow`(승인·등급·프로젝트)·`SettingsPanel`(강조색·모션·팀 크레딧·언어)·`WorkspaceSelector`.
- **Assets 분리창**: `AssetsWindow`·`AssetsView` + `assets/`(`AssetCell`·`FolderTree`·`MountManager`·`treeUtils`·`exportDrag`).
- **보조**: `InfoPopup`·`MediaPreview`·`ProjectAssignMenu`·`HowItWorks`.

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
   ▼ GET /api/gen-requests/pending  (요청자 PC 에이전트가 claim → running)
요청자 PC 에이전트(agent_push.py --watch):
   │   higgsfield generate create <model> --prompt … --wait  ← 자기 로컬 CLI(유료)
   ▼ POST /api/gen-requests/{id}/fulfill (성공) | /fail (실패)
   ▼ 서버: placeholder 에 결과 채움 + WS broadcast → 카드 done
```

버튼·UX 는 그대로, 실행 주체만 "서버 1개 CLI"→"각자 로컬 CLI". 결과·크레딧·귀속은 실행한 사람 것.

### 7.2 push 적재(ingest)

```
agent_push.py(각 PC) cycle = ① execute_pending(§7.1) + ② push_once
push_once: GET /api/ingest/known-jobs → 로컬 generate list 중 새 잡만 추림
           → POST /api/ingest {jobs, creator_uid, account_status}
서버: 각 잡은 자기 고유 creator_uid 유지(uid 없을 때만 보강). account_status 를 app_setting 에 저장(크레딧).
```

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
- **실시간**: 쓰기 후 미들웨어가 WS `synced` broadcast → 프론트가 그리드/뱃지 갱신.
- **검색**: SQLite FTS5(trigram, 3자↑), 3자 미만 LIKE 폴백.
- **성능**: 키셋 페이지네이션·content-visibility 가상스크롤·썸네일 사전생성·미디어 2단계 샤딩.
- **휴지통**: 삭제 즉시 별도 DB 로 원자 이동(메인 항상 가벼움).

---

## 9. 비자명한 설계 결정 / 함정 (요약)

1. **서버는 생성 안 함** — 전원 로컬 CLI + push(§2). 서버측 생성 엔드포인트는 잔존하나 미사용.
2. **두 로그인 구분** — 허브 세션 ≠ Higgsfield CLI 인증(§8).
3. **계정↔creator 재연결 오염** 방지 — 잡 고유 uid 유지 + 이미 실제 uid 면 재연결 금지 + 에이전트가 전체목록 최다 uid 전송.
4. **미디어 공개 URL** — push 는 메타만(바이트 전송 없음). 단 만료 가능 → byte-cache 는 향후 과제.
5. **단일 오리진 / 키셋 / FTS5 / 휴지통 별도 DB / 미디어 샤딩 / 이중 백엔드(SQLite·PG)**.
6. **마이그레이션 순서 함정**(§6) — 새 ALTER 컬럼 인덱스는 `_migrate` 에만.
7. **출처 영속화**(provenance) — `source_url` 보존으로 재사용·변형 가능(최우선 가치).
8. **자동 태그 격리** — 일반 태그와 완전 분리 네임스페이스.
9. **`--reload` 금지 / 서버 재시작 필수**(백엔드). 프론트는 build + Ctrl+F5.
10. **생성은 유료** — 실제 생성 트리거는 크레딧 소모(테스트 시 주의).

---

## 10. 디렉터리 트리 (요약)

```
content-hub-server/
├─ MV_server.bat            프론트 빌드 → 백엔드 기동(포트 8010, AUTH=1)
├─ agent_push.py             팀원 각 PC 에이전트(표준 라이브러리만)
├─ ARCHITECTURE.md           이 문서(설계 구조)
├─ 기능설명서.md / 사용설명서.md / SERVER.md / AI_CONTEXT.md / README.md / DESIGN.md / CLAUDE.md
├─ deploy/                   nginx.conf · Caddyfile · POSTGRES.md · README.md
├─ backend/
│  ├─ serve.py               듀얼스택 기동
│  ├─ schema.sql / schema_pg.sql   DDL(SQLite / PostgreSQL)
│  ├─ migrate_to_pg.py · backfill_import.py
│  └─ app/
│     ├─ main.py db.py pgsupport.py models.py config.py deps.py rbac.py ws.py
│     ├─ routers/   library generation gen_requests ingest share projects auth members assets sync
│     ├─ repo/      _common generations gen_requests identity tags assets share projects accounts trash
│     └─ services/  cli_bridge syncer media_cache thumbs backup auth agent_signals mcp_ingest jobs
└─ frontend/
   ├─ dist/                  빌드 산출물(백엔드가 서빙)
   └─ src/
      ├─ App.tsx api.ts types.ts main.tsx styles.css
      ├─ lib/         i18n theme storage useFloatingPanel useModels promptParts prompt promptEditor
      │               format media download commentTree useClickSeparation useAccountStatus
      └─ components/  ThumbnailGrid GenerationCard MediaThumbnail FilterSidebar LibraryToolbar SearchBox TopBar
                      SpotlightPrompt FloatingPrompt HistoryBoard HistoryPanel HistoryMiniTree CompareModal
                      SceneBoard SceneBar GenCommentPanel LoginScreen AccountMenu ManageAccount AdminWindow
                      SettingsPanel WorkspaceSelector AssetsWindow AssetsView InfoPopup MediaPreview
                      ProjectAssignMenu HowItWorks  + assets/(AssetCell FolderTree MountManager …)
```
