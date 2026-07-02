# Content Hub (server) — AI 컨텍스트 브리프

> **이 파일의 목적**: 코드에 직접 접근하지 못하는 AI(클로드 등)에게 이 프로그램 전체를
> 한 파일로 이해시키기 위한 자기완결 문서. 새 대화에 이 내용을 통째로 붙여넣으면, AI 가
> 저장소를 못 봐도 구조·데이터모델·기능·설계결정을 파악하고 도와줄 수 있다.
> (저장소 안에 더 상세한 `DESIGN.md`, `CLAUDE.md`, `README.md`, `SERVER.md`, `사용설명서.md`, `deploy/` 가 있다.)
>
> **최종 갱신: 2026-06-18** — 푸시 모델(각자 로컬 CLI 생성 + 서버는 공유 DB)·멀티계정 로그인·
> 로컬 실행 큐(gen-request)·크레딧 집계 반영. 이전 "서버가 직접 생성" 모델에서 전환됨.

---

## 0. 한 문단 요약

**Content Hub** 는 Higgsfield 로 만든 이미지/영상을 팀이 한곳에 모아 **탐색·태깅·검색·공유·재사용·
계보 추적**하는 풀스택 콘텐츠 관리 도구다. 백엔드(FastAPI)가 빌드된 프론트(React)를 **같은 오리진**
에서 서빙하고, SQLite(WAL)에 메타데이터를, 디스크에 미디어를 보관한다. `content-hub-server` 는
원본 개인용 `content-hub` 를 **서버화한 클론**(기능 상위집합)이다.

**가장 중요한 운영 모델(§1)**: 서버는 **생성을 하지 않는다.** 팀원 각자가 **자기 PC·자기 힉스필드
CLI**로 생성하고, 결과물 메타데이터만 서버로 **push** 한다. 서버는 그것을 모은 **공유 DB**이며,
허브는 그 DB를 보는 창구다. **힉스필드 토큰은 각자 PC 밖으로 나가지 않는다.**

---

## 1. ★핵심 운영 모델 — "각자 로컬 CLI 생성 + 서버는 공유 DB"

```
[jay PC]    자기 힉스필드 CLI ─┐
[오지짱 PC] 자기 힉스필드 CLI ─┤── push(메타) ──▶ [서버 = 공유 DB] ──▶ 팀 전원이 허브로 공유
[다른팀원]  자기 힉스필드 CLI ─┘                      (생성 안 함, 중계·저장만)
```

- **생성·재생성 = 전원 각자 로컬 CLI**(자기 크레딧). 서버는 어떤 CLI에도 의존하지 않음 → 클라우드로 옮겨도 동작.
- **결과물은 push 로 서버에 적재**. 미디어는 힉스필드 CloudFront **공개 URL** 그대로 참조(인증 없이 200 OK 확인됨) → push 는 메타데이터만, 바이트 전송 불필요(영속이 필요하면 byte-cache는 향후 과제).
- **토큰은 로컬 보관**: 서버는 힉스필드 자격증명을 절대 저장하지 않는다(사용자 보안 요구).
- **허브의 생성/재생성 버튼은 "서버에 요청만" 남긴다** → 그 사람 PC의 **에이전트**가 가져가 로컬 CLI로 실행 → 결과를 placeholder 카드에 채움(§5).
- 과도기 편의: 서버가 jay PC에 떠 있어 jay 결과는 서버측 주기 동기화로도 들어올 수 있으나, 본질은 jay도 로컬→push. "하우스 계정/서버 생성" 개념은 폐기됨.

이 모델의 근거·검증은 메모리 `project_content_hub_push_model` 에 상세 기록.

---

## 2. 기술 스택 · 실행 · 포트

- **백엔드**: Python / FastAPI / Uvicorn. DB 기본 **SQLite(WAL)**, 옵션 **PostgreSQL**(`pgsupport.py` 방언 shim, 옵트인).
- **프론트**: React + TypeScript + Vite. 빌드 산출물(`frontend/dist`)을 백엔드가 직접 서빙.
- **단일 오리진**: 프론트는 상대경로(`/api`·`/ws`·`/media`)만 → 폴더째 올려도 무변경, CORS 불필요.
- **실행**: `MV_server.bat`(프론트 빌드 → 백엔드 기동). 기본 **포트 8010**, **로그인 강제 ON**(`CONTENT_HUB_AUTH=1`, bat 기본값). `serve.py` 가 IPv4 0.0.0.0 + IPv6 ::1 듀얼스택(Windows localhost IPv6 폴백 ~200ms 지연 제거).
- ⚠️ **`--reload` 금지**: CLI subprocess 가 깨진다. 백엔드 변경은 **서버 재시작**으로 반영. 프론트 변경은 `npm run build` 후 브라우저 **Ctrl+F5**(dist 는 즉시 서빙되어 재시작 불필요).
- 미디어: `backend/data/media/<sha[:2]>/<sha>.ext`(2단계 샤딩). DB: `backend/data/db/content_hub.db`. 휴지통: `content_hub_trash.db`(별도).
- 접속: 같은 PC `http://127.0.0.1:8010`(localhost보다 빠름), LAN 팀원 `http://<서버IP>:8010`.

---

## 3. 두 종류의 "로그인" (혼동 주의)

| | 무엇 | 역할 | 저장 위치 |
|---|---|---|---|
| **허브 세션 로그인** | 브라우저 계정(이메일/비번) | 신원·권한·"내 작업" 분리 | 세션 토큰 = 브라우저 localStorage(`ch.auth.token`) + 쿠키(`ch_session`, /media·/ws용) |
| **힉스필드 CLI 인증** | 각 PC의 `higgsfield auth login` | 누구 계정으로 **생성·동기화**되나 | 각 PC `~/.config/higgsfield/credentials.json`(HOME 기준) |

- 둘은 완전 별개. "허브에 oz1로 로그인"해도, 그 PC의 힉스필드 CLI가 jay면 동기화는 jay 것이 된다 — 그래서 push 모델이 필요(§5).
- 힉스필드 CLI는 머신당 1계정(HOME env 리다이렉트로 분리 가능함은 실증). `--token`/env 토큰 주입은 미지원, 브라우저 디바이스 로그인.

---

## 4. 멀티계정 · 신원 · 권한

- **`account`**(로그인) 과 **`creator`**(생성물 작성자) 는 별개 축, `account.creator_uid` 로 연결.
  - 시작·가입 시 `repo.link_accounts_to_creators()`: 소유자(provider_email)=힉스필드 `my_creator_uid`, 그 외=합성 `acct:<email>`.
  - push 첫 적재 때 `set_account_hf_creator` 가 합성 uid 를 **실제 힉스필드 uid**로 교체(그 계정의 자기 작업이 "내 작업"에 잡히게).
- **가입 흐름**: 자동 등록(pending) → 관리자 승인(approved). **첫 계정 = 부트스트랩 관리자**(admin+product_manager, 즉시 approved).
- **"내 작업" 분리**: `GET /api/generations?tab=my` 는 라우터가 `request.state.account.creator_uid` 를 주입 → 그 계정 생성물만. 비로그인(토큰 없음)이면 전체(단독/개발). `tab=team` 은 공유된 것.
- **멤버 목록**: `list_members()` 는 **계정 우선**(생성물 0이어도 멤버·프로젝트 후보로 노출) + 계정 없는 외부 creator(가져온 작업 작성자)도 포함. → 관리자 창의 승인/등급/프로젝트 배정이 신규 계정을 바로 본다.
- **RBAC**(`rbac.py`, `deps.py`): 전역 역할(admin/product_manager/product_director/production_director/member, CSV 복수) + 프로젝트 역할(project_manager/supervisor/editor). 게이트는 `CONTENT_HUB_AUTH=1` 일 때만 강제. `require_global_cap`/`require_project_role` 등.
- 표시이름: 로그인 시 `account.name` 우선(전역 provider.name 아님) — [AccountMenu].

---

## 5. 생성/재생성 흐름 (로컬 실행 큐 = gen-request)

```
허브 "생성/재생성" 버튼
   │ POST /api/gen-requests  (kind=create|regenerate)
   ▼
서버: placeholder 카드 즉시 생성(status=pending, 요청자 소유) + gen_request 큐잉
      (재생성은 import_generation 으로 placeholder + 'derived' 리니지)
   │
   ▼  GET /api/gen-requests/pending  (요청자 PC의 에이전트가 claim → running)
요청자 PC 에이전트(agent_push.py --watch):
      higgsfield generate create <model> --prompt … --wait [params] [미디어]  ← 자기 로컬 CLI(유료)
      레퍼런스 URL 은 --image 등에 그대로(서버 기존 재생성과 동일, 업로드 불필요)
   │
   ▼  POST /api/gen-requests/{id}/fulfill  (raw 잡 보고)  | 실패 시 /fail
서버: placeholder 에 결과(asset·job_id·status) 채움 + WS broadcast → 카드 done
```

- **버튼·UX는 그대로**, 실행 주체만 "서버 1개 CLI" → "각자 로컬 CLI"로 바뀜. 결과·크레딧·귀속 모두 실행한 사람 것.
- **전제**: 그 사람 에이전트가 `--watch` 로 떠 있어야 동작(안 떠 있으면 "로컬 대기" 카드로 남았다가 켜면 실행). jay 포함.
- 카드 라벨: pending="로컬 대기", running="로컬 생성중" + 툴팁(에이전트 필요 안내) [GenerationCard].
- 옛 서버측 직접 생성 경로(`POST /api/generations`, `/regenerate`, `services/jobs.py` 큐)는 **프론트가 더는 호출 안 함**(무해하게 잔존, 추후 제거 예정).
- ⚠️ 미완: `create` 의 **로컬파일/`asset:` 토큰 레퍼런스**는 타 PC 에이전트에서 resolve 불가(현재 URL·텍스트 레퍼런스만 OK).

---

## 6. push 에이전트 (`agent_push.py`) + 적재(ingest)

`content-hub-server/agent_push.py` — **표준 라이브러리만**(팀원 무설치). 각 PC에서 실행:
```
python agent_push.py --server http://<서버IP>:8010 --email <내이메일> [--watch 30]
# --token <세션토큰> 으로 로그인 생략 가능(자동화/테스트용)
```
- **cycle = ① execute_pending(허브 요청을 내 로컬 CLI로 실행→fulfill) + ② push_once(내 로컬 결과물을 서버로 적재)**.
- push_once: `GET /api/ingest/known-jobs`(서버 보유 job_id) → 로컬 `generate list --json` 중 **새 것만** 추림 → `POST /api/ingest {jobs, creator_uid, account_status}`.
  - **내 힉스필드 uid = 로컬 전체 목록의 최다 user_<id>**(fresh 부분집합만 보면 남의 레퍼런스에 오염되어 잘못 연결되는 실측 버그가 있어, 반드시 전체 기준으로 산출해 명시 전송).
- **`POST /api/ingest`**(`routers/ingest.py`): 허브 세션 인증. 각 잡은 **자기 고유 creator_uid 유지**(uid 없을 때만 내 uid로 보강). 계정이 이미 실제 uid에 연결돼 있으면 **재연결 금지**(오염 방지). `account_status`(크레딧·플랜)를 `app_setting hf_status:<email>` 에 저장.

---

## 7. 크레딧 집계

- 생성정보엔 크레딧 잔액이 없으므로, **에이전트가 push 때 함께 보고한 `account status`** 의 마지막값으로 집계.
- `GET /api/credits`(로그인 필수) → `repo.credit_summary()` = `{total, accounts:[{email,name,credits,plan}]}`.
- 설정창(⚙) **"팀 크레딧"** 섹션에 전체 합계 + 구성원별 표시(실시간 아님, 마지막 보고 기준).

---

## 8. 데이터 모델 (핵심)

SQLite 스키마(`backend/schema.sql` + `db.py` 마이그레이션). PK 는 전부 TEXT(uuid). 정렬은 항상 `sort_ts DESC, id DESC`(키셋).

| 테이블 | 역할 | 주요 컬럼 |
|---|---|---|
| `generation` | 생성 1건(중심) | id, prompt, display_prompt(@칩 보존), model, params(JSON), color, status, created_at, **sort_ts**(정밀 epoch=정렬키), job_id, is_source, source_name, **creator_uid**, project_id, deleted_at, hf_missing, **is_final/final_by/final_at**(골드) |
| `asset` | 결과물 미디어 | generation_id, type(image/video), file_path(/media 또는 원격 URL), thumbnail_path, source_url(원격 원본 보존) |
| `reference`+`gen_reference` | 생성에 쓴 레퍼런스(N:N) | role(@Image1/@Video/@start…), source, file_path, source_url |
| `tag`+`gen_tag` / `auto_tag`+`gen_auto_tag` | 일반 태그 / 자동태그(별도 네임스페이스·사이드바 전용·'무장'시 새 생성 자동적용) | name |
| **`lineage`** | 계보(타입드 엣지) | parent_gen_id → child_gen_id, **relation**('derived'=재생성/가져오기 강한 1부모, 'reference'=@소스 생성 약한 다부모), UNIQUE(parent,child,relation) |
| `share` | 팀 공유 발행 | generation_id, shared_by, visibility |
| `generation_comment`+`_read` | 공유 코멘트 스레드+읽음 | gen_id, author, text, parent_id, muted |
| `project`+`project_member` | 작업 묶음(공유·이동 단위) | name, kind, archived(콜드분리) / project_id, creator_uid, project_role |
| `creator` | 생성자 uid→이름·전역역할 | uid, name, global_role(CSV) |
| `account` | 로그인 계정 | email, password_hash(pbkdf2), status, global_role(CSV), **creator_uid**(생성자 연결), approved_at |
| **`gen_request`** | 로컬 실행 생성요청 큐 | id, account_email, creator_uid, gen_id(placeholder), kind(create/regenerate), payload(JSON 레시피), status(pending/running/done/failed), error |
| `app_setting` | key-value | provider_uid/name/email, my_creator_uid, auth_secret, **hf_status:<email>**(크레딧 보고) |
| `asset_meta`+`asset_comment(_read)` | Assets 분리창 파일별 메타/코멘트 | (project, path) 키 |
| `trashed`(별도 DB) | 휴지통 | id, trashed_at, payload(JSON: 본체+자식 전부) |

⚠️ **마이그레이션 함정**: schema.sql 의 executescript 가 `db.py _migrate` 의 ALTER 보다 **먼저** 실행됨 → 새로 ALTER 되는 컬럼(예: `lineage.relation`)에 거는 인덱스는 schema.sql 이 아니라 `_migrate` 에만 둔다(기존 DB ALTER 순서 보장). 단, **새 테이블**(IF NOT EXISTS)은 schema.sql 에 둬도 안전(기존 DB도 init_db 가 멱등 적용).

---

## 9. 기능 인벤토리

- ✅ **라이브러리**: 무한 스크롤(키셋·content-visibility 가상스크롤), 그리드/리스트, 날짜 그룹.
- ✅ **메타데이터**: 태그·자동태그·컬러(r/g/b 키)·@소스명·코멘트·프로젝트·파일메타.
- ✅ **검색**: prompt+태그 부분일치. SQLite FTS5(trigram, 3자↑), 3자 미만 LIKE 폴백.
- ✅ **벌크**: 마퀴 드래그·Shift/Ctrl·Ctrl+A·날짜그룹 선택 + 일괄 삭제/복원/영구삭제/공유/프로젝트 귀속.
- ✅ **휴지통**: 삭제 즉시 별도 DB로 원자 이동(메인 항상 가벼움) → 검색·복원·영구삭제.
- ✅ **팀 공유**: 발행/가져오기/번들 export·import(JSON)/공유 폴더. 멀티계정 신원·승인·등급.
- ✅ **프로젝트**: 작업 묶음 + 보관(archived 콜드분리).
- ✅ **계보(리니지)**: 재생성·@소스 참조 시 타입드 엣지 기록 + 가시화. **구성탭(트리)** = 원본→파생 가로 트리(LineageBoard): 마퀴 선택·비교·정보·다운로드·재생성·드래그 이동·무한 캔버스(휠 줌·미들클릭 팬)·d 비활성화·l 자동정렬·골드(최종) 강조.
- ✅ **소스 라이브러리**: is_source/source_name + @·# 프롬프트 피커로 재사용.
- ✅ **Assets 분리창**: 임의 폴더 마운트·파일 브라우저·파일별 메타/코멘트(`/?embed=assets`).
- ✅ **크레딧 집계**(§7), **다국어**(ko/en, i18n 반응형), **테마**(강조색·모션 끄기), **관리자 창**(승인·등급·프로젝트).
- 🔸 명시적 리비전 diff·콘텐츠 게시 승인 게이트·외부 DAM 커넥터는 없음.

---

## 10. 백엔드 모듈 지도 (`backend/app/`)

- `main.py` — 앱·**미들웨어(auth_enforcement: 토큰→request.state.account / mutation_notify: 쓰기 후 WS 알림)**·lifespan(init_db·고아잡 정리·중복병합·레거시 이전·creator_uid 백필·**계정↔creator 연결**·제공자 신원 캡처·썸네일 사전생성·동기화/백업). `/media`·SPA 마운트.
- `db.py`(스키마·마이그레이션·인덱스·FTS5), `pgsupport.py`(PG 방언 shim), `models.py`(Pydantic), `config.py`(경로·포트·AUTH), `deps.py`(인증/RBAC 의존성), `ws.py`(진행률 broadcast), `rbac.py`(역할·역량).
- **routers/**: `library.py`(목록·검색·통계·facets·휴지통·**미디어 썸네일**·**tab=my 계정 스코프**), `generation.py`(옛 서버측 생성·태그/컬러/소스/코멘트·삭제·복원·힉스필드검증·리니지), **`gen_requests.py`(로컬 실행 큐: 생성요청·pending·fulfill·fail)**, **`ingest.py`(push 적재·known-jobs·`/credits`)**, `share.py`, `projects.py`, `auth.py`(로그인·가입·계정승인), `members.py`(등급), `assets.py`(분리창), `sync.py`.
- **repo/**: `generations.py`(중심: list_generations 키셋·검색·업서트·재생성·**account_uid 스코프**·리니지 그래프), **`gen_requests.py`(gen_recipe·claim·fulfill mark)**, `identity.py`(생성자·신원·**link_accounts_to_creators·set_account_hf_creator·credit_summary·list_members**), `tags.py`, `projects.py`, `share.py`, `accounts.py`(가입·인증·승인), `assets.py`, `trash.py`.
- **services/**: `jobs.py`(옛 서버측 잡 큐, 현재 미사용 경로), `syncer.py`(주기 동기화), `cli_bridge.py`(Higgsfield CLI 래퍼: parse_job·create_job·generate list·account status·workspace·**셰임/Proactor 함정**), `media_cache.py`(원격→로컬·샤딩), `thumbs.py`(썸네일), `backup.py`(SQLite 온라인 백업), `auth.py`(pbkdf2 해시·무상태 hmac 토큰).

---

## 11. 프론트엔드 모듈 지도 (`frontend/src/`)

- `App.tsx` — 최상위 상태·reload/loadMore(무한 스크롤)·벌크·필터 합성(genQuery)·인증 부트스트랩·WS 진행률·구성탭 보드 신호·onCreated 리니지 연결.
- `api.ts`(타입세이프 클라이언트: `create`/`regenerate` 는 이제 **`/api/gen-requests`** 호출, `credits`, 인증 Bearer, 401→로그인), `types.ts`(응답 타입), `lib/`(`i18n.ts`·`theme.ts`(강조색·모션·언어)·`prompt.tsx`·`promptEditor.ts`·`useModels.ts`).
- **components/**: `ThumbnailGrid`·`GenerationCard`(카드·오버레이·**로컬 대기/생성중 라벨**·썸네일·드래그 재사용), `FilterSidebar`·`LibraryToolbar`·`SearchBox`, `SpotlightPrompt`(생성 입력·@/# 피커), **`LineageBoard`(구성탭 계보 트리)·`LineagePanel`(가계 패널)**, `CompositionBoard`·`FloatingPrompt`, `AssetsView/AssetsWindow`(분리창), `GenCommentPanel`, `AdminWindow`(승인·등급·프로젝트), `AccountMenu`(아바타·워크스페이스·표시이름)·`ManageAccount`·**`SettingsPanel`(강조색·모션·팀 크레딧·언어·전체 가져오기)**, `LoginScreen`, `TopBar`, `InfoPopup`·`MediaPreview`·`CompareModal`·`HowItWorks`·`WorkspaceSelector`·`ProjectAssignMenu`.

---

## 12. 비자명한 설계 결정 / 함정

1. **서버는 생성 안 함**(§1) — 생성은 전원 로컬 CLI + push. 서버측 생성 버튼/엔드포인트는 잔존하나 미사용.
2. **두 종류 로그인 구분**(§3) — 허브 세션 ≠ 힉스필드 CLI 인증.
3. **계정↔creator 재연결 오염**(실측 버그·수정됨): jay `generate list` 에 섞인 남의 레퍼런스가 "새 잡"으로 잡혀 계정이 잘못 재연결됨 → ①잡 고유 uid 유지 ②이미 실제 uid면 재연결 금지 ③에이전트가 전체목록 최다 uid 명시 전송.
4. **미디어 공개 URL** — 힉스필드 CloudFront 결과 URL 은 인증 없이 열림 → push 는 메타만. 단 만료 가능 → byte-cache 는 향후.
5. **단일 오리진 / 키셋 페이지네이션 / FTS5 검색 / 휴지통 별도 DB / 미디어 샤딩 / 썸네일 사전생성 / 이중 백엔드(SQLite·PG)** — (기존 Phase 0~3, 전부 구현·검증).
6. **마이그레이션 순서 함정**(§8) — 새 ALTER 컬럼 인덱스는 `_migrate` 에만.
7. **출처 영속화** — 원격 URL(`source_url`) 보존 → 재사용·변형 가능(provenance 최우선).
8. **자동 태그 격리** — 일반 태그와 완전 분리 네임스페이스.
9. **`--reload` 금지 / 서버 재시작 필수**(백엔드 변경). 프론트는 build + Ctrl+F5.
10. **생성은 유료** — 실제 생성 트리거는 크레딧 소모. 개발/테스트 시 주의(사용자 동의 하에만).

---

## 13. 남은 과제

- **byte-cache**: CloudFront URL 만료 대비 미디어 영구 보존(별도 저장·동기화 서브시스템, 규모 큼 → 후순위).
- **옛 서버측 생성 제거**: `POST /api/generations`·`/regenerate`·`services/jobs.py` 큐(현재 미사용·무해라 보류).
- **create 로컬파일/asset: 레퍼런스**: 타 PC 에이전트 resolve 불가(현재 URL·텍스트만). 바이트 업로드 경로 필요.
- (선택) 워크스페이스/크레딧 실시간성, 콘텐츠 게시 승인 게이트.

---

## 14. 운영 메모

- 백엔드 변경 → **서버 재시작 필수**. 프론트 변경 → `npm run build` + **Ctrl+F5**(재시작 불필요).
- `MV_server.bat` 기본 = 포트 **8010** + 로그인 **ON**(`CONTENT_HUB_AUTH=1`). 끄려면 bat 에서 0.
- 첫 가입자 = 관리자. 이후 가입자는 pending → 관리자 승인 필요.
- 같은 PC 는 `http://127.0.0.1:8010`, LAN 팀원은 `http://<서버IP>:8010`.
- 메모리 참조: `project_content_hub_push_model`(이번 모델 근거·구현), `project_content_hub_lineage`(계보), `project_content_hub_server`(서버화), `project_content_hub_provenance`(출처 보존).
