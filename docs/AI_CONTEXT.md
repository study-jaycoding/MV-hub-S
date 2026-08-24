# Content Hub (server) — AI 컨텍스트 브리프

> **이 파일의 목적**: 코드에 직접 접근하지 못하는 AI(클로드 등)에게 이 프로그램 전체를
> 한 파일로 이해시키기 위한 자기완결 문서. 새 대화에 이 내용을 통째로 붙여넣으면, AI 가
> 저장소를 못 봐도 구조·데이터모델·기능·설계결정을 파악하고 도와줄 수 있다.
> (저장소 안에 더 상세한 `DESIGN.md`, `PROJECT_CHARTER_LEGACY.md`, `README.md`, `SERVER.md`, `사용설명서.md`, `deploy/` 가 있다.
>  현행 작업 규칙은 저장소 루트 `CLAUDE.md`·`AGENTS.md` 다.)
>
> **구조 본문 기준: 2026-07-07** — 푸시 모델(각자 로컬 CLI 생성 + 서버는 공유 DB)·멀티계정 로그인·
> 로컬 실행 큐(gen-request)·크레딧 집계 반영. 이전 "서버가 직접 생성" 모델에서 전환됨.
> ★Higgsfield CLI 는 `hf_cli_version.txt` 로 **버전 pin**(0.2.x→1.x 파괴적 변경 대응). CLI 출력
> 필드를 읽는 코드는 `x.get(new) or x.get(old)` 폴백을 쓴다 — 절차·계약은 `docs/HF_CLI_UPGRADE.md`.
> UI 상단 탭은 **내 작업 / 팀 작업 / 캔버스**(옛 '팀 공유'→'팀 작업', 옛 '구성/계보 트리'→'캔버스').
> **현재 완료·잔여·검증 상태는 [CURRENT_STATUS.md](CURRENT_STATUS.md)를 먼저 확인한다.** 이 본문은
> 구조를 설명하며 최신 작업 상태의 단일 출처가 아니다.

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
- **결과물은 push 로 서버에 적재**. 일반 미디어는 힉스필드 CloudFront **공개 URL**을 참조해
  push 시 메타데이터만 전송한다. 공유·최종 완료본은 영속 큐로 자동 byte-cache하며, 업데이트 전
  기존 공유·최종본도 시작 시 백필한다. 기본 50GiB 한도에서는 기존 보존본을 삭제하지 않고 새
  다운로드만 거절한다. 상태와 수동 재시도는 생성물 정보창에 표시된다.
- **토큰은 로컬 보관**: 서버는 힉스필드 자격증명을 절대 저장하지 않는다(사용자 보안 요구).
- **허브의 생성/재생성 버튼은 "서버에 요청만" 남긴다** → 그 사람 PC의 **에이전트**가 가져가 로컬 CLI로 실행 → 결과를 placeholder 카드에 채움(§5).
- 과도기 편의: 서버가 jay PC에 떠 있어 jay 결과는 서버측 주기 동기화로도 들어올 수 있으나, 본질은 jay도 로컬→push. "하우스 계정/서버 생성" 개념은 폐기됨.

이 모델의 근거·검증은 메모리 `project_content_hub_push_model` 에 상세 기록.

---

## 2. 기술 스택 · 실행 · 포트

- **백엔드**: Python / FastAPI / Uvicorn. DB는 **SQLite(WAL)만 지원**. PostgreSQL 런타임·이관 도구는 제거되어 환경변수로 전환할 수 없다.
- **프론트**: React + TypeScript + Vite. 빌드 산출물(`frontend/dist`)을 백엔드가 직접 서빙.
- **단일 오리진**: 프론트는 상대경로(`/api`·`/ws`·`/media`)만 → 폴더째 올려도 무변경, CORS 불필요.
- **실행**: `MV_server.bat`(기존 프론트 빌드 확인 → 백엔드 기동, dist가 없을 때만 `npm ci`+빌드). 기본 **포트 8010**, **로그인 강제 ON**(`CONTENT_HUB_AUTH=1`, bat 기본값). `serve.py` 가 IPv4 0.0.0.0 + IPv6 ::1 듀얼스택(Windows localhost IPv6 폴백 ~200ms 지연 제거).
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
- 허브 업무 API의 임의 `401`은 세션 만료로 단정하지 않는다. 같은 토큰의 `/api/auth/me`가
  `401`일 때만 현재 토큰을 지우고, 요청별 거부·확인 불가는 `X-MVHub-Auth-State: preserved`로
  브라우저 로그인 상태를 유지한다. 상세 규칙은 [AUTH_FAILURE_SEMANTICS.md](AUTH_FAILURE_SEMANTICS.md)를 따른다.

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
   ▼  GET /api/gen-requests/pending  (새 에이전트가 claim → claimed)
요청자 PC 에이전트(agent_push.py --watch):
      레퍼런스·워크스페이스 준비 → POST /begin-submission ACK → submitting
      제출 워커(기본 8): higgsfield generate create <model> --prompt … [params] [미디어]
      job_id 즉시 anchor → 원격 작업 최대 64개 추적
      기한이 된 작업을 generate get <job_id> 로 직접 권위 확인
      성공 상태 + 결과 URL + 서버의 asset 저장 ACK가 모두 있어야 완료 확정
   │
   ▼  POST /api/gen-requests/{id}/reconcile (완료 확정) | 제출 실패 시 /fail
서버: placeholder 에 결과(asset·job_id·status) 채움 + WS broadcast → 카드 done
```

- **버튼·UX는 그대로**, 실행 주체만 "서버 1개 CLI" → "각자 로컬 CLI"로 바뀜. 결과·크레딧·귀속 모두 실행한 사람 것.
- **전제**: 그 사람 에이전트가 `--watch` 로 떠 있어야 동작한다. 꺼져 있으면 pending 카드로 남고,
  다시 켜면 실행을 이어간다. jay 포함.
- **RL-05 완료(`1252b52d`)**: 유료 CLI 호출 전 `claimed`만 lease 만료 시 재큐잉하고, 호출 후
  `job_id`가 없는 요청은 `recovery_required`로 격리해 자동 재생성하지 않는다. 새 에이전트는
  `submission-stage`, 구 에이전트는 호환 경로를 사용하며 새 서버가 알려진 모호한 실패를 격리한다.
  상세 계약과 외부 검증 잔여는 [GENERATION_SUBMISSION_RECOVERY.md](GENERATION_SUBMISSION_RECOVERY.md)를 따른다.
- pending/running 카드의 미디어 영역은 Higgsfield 로고만 표시한다. 대기·제출·생성·확인·조치 같은
  세부 상태 글씨는 카드 위에 겹치지 않고 툴팁·정보창에서 확인한다 [GenerationCard].
- 팀 생성·재생성은 workspace id와 이름이 모두 확인된 뒤에만 전송한다. 새로고침으로 id만 복원된
  경우 계정의 최신 보고 목록에서 같은 id의 이름을 보완하고, 그 전 요청은 프론트 API 경계에서 막는다.
  서버도 로그인 계정이 접근 가능한 등록부 ID인지 검증한 뒤 공식 이름으로 정규화한다. 시작 시에는
  등록부와 ID가 정확히 일치하는 이름 없는 과거 팀 생성물과 관리 팩트만 보강하고, 나머지는 추측하지 않는다.
- 옛 서버측 직접 생성 경로(`POST /api/generations`, `/regenerate`, `services/jobs.py` 큐)는 **제거됨**(push 모델 전환 완료). 생성은 전원 로컬 CLI + `POST /api/gen-requests`.
- ⚠️ 미완: `create` 의 **로컬파일/`asset:` 토큰 레퍼런스**는 타 PC 에이전트에서 resolve 불가(현재 URL·텍스트 레퍼런스만 OK).

---

## 6. push 에이전트 (`agent_push.py`) + 적재(ingest)

`agent_push.py` — **표준 라이브러리만**. 실운영 진입점은 **`MV_agent.bat` → `run_agent_session.py`**
(Job Object 로 전체 트리 감시 — 창 닫으면 전부 종료). 개발에서 단독 실행:
```
python agent_push.py --server http://<서버IP>:8010 --email <내이메일>
# --watch 의 숫자 값은 호환용(무시) — 롱폴 이벤트 상주 모드라 즉시 반응
# --token <세션토큰> 로그인 생략(자동화/테스트) · --pair-secret 브라우저 로그인 자동 승계
```
- **cycle = ① execute_pending(허브 요청 제출→목록 추적→reconcile) + ② reconcile_pass(재시작 복구) + ③ push_once(내 로컬 결과물을 서버로 적재)**.
- push_once: 로컬 `generate list --json`의 job_id를 `POST /api/ingest/known-jobs`로 보내
  서버가 돌려준 **unknown(신규) + refresh(재확인 필요)** 대상만
  `POST /api/ingest {jobs, creator_uid, account_status}`로 적재한다.
  구버전 서버가 POST를 지원하지 않을 때만 `GET /api/ingest/known-jobs` 전량 응답으로 폴백한다.
  - **내 힉스필드 uid = 로컬 전체 목록의 최다 user_<id>**(fresh 부분집합만 보면 남의 레퍼런스에 오염되어 잘못 연결되는 실측 버그가 있어, 반드시 전체 기준으로 산출해 명시 전송).
- **`POST /api/ingest`**(`routers/ingest.py`): 허브 세션 인증. 각 잡은 **자기 고유 creator_uid 유지**(uid 없을 때만 내 uid로 보강). 계정이 이미 실제 uid에 연결돼 있으면 **재연결 금지**(오염 방지). `account_status`(크레딧·플랜)를 `app_setting hf_status:<email>` 에 저장한다. 생성 텔레메트리와 계정 상태·거래는 서로 다른 영속 outbox에 먼저 기록하고 메인 이벤트 루프의 백그라운드 drain만 예약하므로 일반 적재 응답은 원격 전송을 기다리지 않는다. 계정 보고는 공유 서버 **`POST /api/ingest/account-report`**가 상태·거래를 모두 쓴 뒤 명시적 ACK를 반환하고 현재 revision이 일치할 때만 완료하며, 실패는 백오프로 재시도한다.

---

## 7. 크레딧 집계

- 생성정보엔 크레딧 잔액이 없으므로, **에이전트가 push 때 함께 보고한 `account status`** 의 마지막값으로 집계.
- `GET /api/credits` 는 정의만 남고 프론트 호출처 0건(레거시). 표시 는 **AccountMenu 의 크레딧
  게이지**: 활성 워크스페이스 잔여 ÷ 분모(그 워크스페이스에 배정된 프로젝트들의 예산 한도 합,
  MILLIONVOLT 는 200,000 고정, 폴백 상수). 팀 크레딧 대시보드는 PM 관리창(§9 참조).

---

## 8. 데이터 모델 (핵심)

SQLite 스키마(`backend/schema.sql` + `db.py` 마이그레이션). PK 는 전부 TEXT(uuid). 정렬은 항상 `sort_ts DESC, id DESC`(키셋).

| 테이블 | 역할 | 주요 컬럼 |
|---|---|---|
| `generation` | 생성 1건(중심) | id, prompt, display_prompt(@칩 보존), model, params(JSON), color, status, created_at, **sort_ts**(정밀 epoch=정렬키), job_id, is_source, source_name, **creator_uid**, project_id, deleted_at, hf_missing, **is_final/final_by/final_at**(골드) |
| `asset` | 결과물 미디어 | generation_id, type(image/video), file_path(/media 또는 원격 URL), thumbnail_path, source_url(원격 원본 보존) |
| `media_preservation` | 공유·최종 원본 보존 영속 큐 | generation_id, reason, status, attempts, cached/failed/skipped_count, bytes_cached, 안전한 error_code, next_retry_at |
| `reference`+`gen_reference` | 생성에 쓴 레퍼런스(N:N) | role(@Image1/@Video/@start…), source, file_path, source_url |
| `tag`+`gen_tag` / `auto_tag`+`gen_auto_tag` | 일반 태그 / 자동태그(별도 네임스페이스·사이드바 전용·'무장'시 새 생성 자동적용) | name |
| **`lineage`** | 계보(타입드 엣지) | parent_gen_id → child_gen_id, **relation**('derived'=재생성/가져오기 강한 1부모, 'reference'=@소스 생성 약한 다부모), UNIQUE(parent,child,relation) |
| `share` | 팀 공유 발행 | generation_id, shared_by, visibility |
| `generation_comment`+`_seen` | 공유 코멘트 스레드+코멘트 단위 확인 | gen_id, author, text, parent_id, muted |
| `project`+`project_member` | 작업 묶음(공유·이동 단위) | name, kind, archived(콜드분리) / project_id, creator_uid, project_role |
| `creator` | 생성자 uid→이름·전역역할 | uid, name, global_role(CSV) |
| `account` | 로그인 계정 | email, password_hash(pbkdf2), status, global_role(CSV), **creator_uid**(생성자 연결), approved_at |
| **`gen_request`** | 로컬 실행 생성요청 큐 | id, account_email, creator_uid, gen_id(placeholder), kind(create/regenerate), payload(JSON 레시피), status(pending/claimed/submitting/running/tracking/verifying/recovery_required/done/failed/canceled), lease_owner, lease_expires_at, error |
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
  공유 해제·최종 해제는 원격 확인 뒤 로컬 반영하며, 실패 시 재조회·보상한다. `is_final → shared`
  불변식과 혼합 버전 `404` 판정은 [SHARE_STATE_COMPENSATION.md](SHARE_STATE_COMPENSATION.md)를 따른다.
- ✅ **프로젝트**: 작업 묶음 + 보관(archived 콜드분리).
- ✅ **계보(리니지)**: 재생성·@소스 참조 시 타입드 엣지 기록 + 가시화. **캔버스 탭 · 히스토리 보기** = 원본→파생 가로 트리(`HistoryBoard`): 마퀴 선택·비교·정보·다운로드·재생성·드래그 이동·무한 캔버스(휠 줌·미들클릭 팬)·d 비활성화·l 자동정렬·골드(최종) 강조. 같은 탭의 **씬 캔버스**(`SceneBoard`)는 자유 배치·연결·태그(localStorage).
- ✅ **소스 라이브러리**: is_source/source_name + @·# 프롬프트 피커로 재사용.
- ✅ **Assets 분리창**: 임의 폴더 마운트·파일 브라우저·파일별 메타/코멘트(`/?embed=assets`). 원본 HTTP 응답은 지원 이미지·영상·오디오만 허용하며 고정 MIME·inline·nosniff·CSP sandbox·동일 출처 정책을 사용한다. HTML/SVG/스크립트와 이중 확장자는 415로 차단한다.
- ✅ **크레딧 집계**(§7), **다국어**(ko/en, i18n 반응형), **테마**(강조색·모션 끄기), **관리자 창**(승인·등급·프로젝트).
- ✅ **씬 서버 백업**: 씬 원본은 localStorage, 계정별 로컬 SQLite 로 자동 미러(`/api/scenes/backup`).
- ✅ **ComfyUI 연동**: 캔버스 comfy 카드 — 워크플로 파싱·파라미터 노출·미디어 자동주입·비동기 실행(`routers/comfy.py`).
- ✅ **DaVinci Resolve 연동**: 렌더폴더 전송 + Media Pool 가져오기 + 수동 Importer(`routers/resolve_integration.py`).
- ✅ **PM 관리 대시보드**(분리창): 작업 칸반·일정·완료본 저장·팀 텔레메트리(`routers/manage.py`, manage_hub.db). 로컬 계정 메뉴는 생성 텔레메트리와 계정 보고 큐의 대기·실패를 구분해 표시하고 두 채널 중 가장 최근 실제 반영 성공 시각을 표시한다.
- ✅ **릴리스 자동 업데이트**: 설정 → 프로그램 업데이트(`routers/release_update.py`, 작업자 전용).
- ✅ **로컬 DB 내보내기/가져오기**(교차 PC): `routers/db_transfer.py`(유지보수 게이트로 안전 교체).
- 🔸 명시적 리비전 diff·콘텐츠 게시 승인 게이트·외부 DAM 커넥터는 없음.

---

## 10. 백엔드 모듈 지도 (`backend/app/`)

> ⚠️ 아래는 핵심 요약이다. **전체 지도(라우터 22개·usecases 4개·repo 30모듈·services 40개)는
> [ARCHITECTURE.md](ARCHITECTURE.md) §4** 가 정답 — 여기 없는 모듈(comfy·resolve·manage·
> release_update·scenes·db_transfer 등)은 그쪽을 봐라.

- `main.py` — 앱·**미들웨어(auth_enforcement: 토큰→request.state.account / mutation_notify: 쓰기 후 영역별 WS 알림)**·lifespan(init_db·고아잡 정리·중복병합·레거시 이전·creator_uid 백필·**계정↔creator 연결**·제공자 신원 캡처·썸네일 사전생성·동기화/백업). `/media`·SPA 마운트. `mutation_notify.py`는 본 서버·데이터 프록시가 공유하는 library/assets/manage 판정과 안전한 요청 출처·응답 영역 헤더 계약이다.
- `db.py`(SQLite 스키마·마이그레이션·인덱스·FTS5), `models.py`(Pydantic), `config.py`(경로·포트·AUTH), `deps.py`(인증/RBAC 의존성), `ws.py`(진행률 broadcast), `rbac.py`(역할·역량).
- **routers/**: `library.py`(목록·검색·통계·facets·휴지통·**미디어 썸네일**·**tab=my 계정 스코프**), `generation.py`(옛 서버측 생성·태그/컬러/소스/코멘트·삭제·복원·힉스필드검증·리니지), **`gen_requests.py`(로컬 실행 큐: 생성요청·pending·fulfill·fail)**, **`ingest.py`(push 적재·known-jobs·`/credits`)**, `share.py`, `projects.py`, `auth.py`(로그인·가입·계정승인), `members.py`(등급), `assets.py`(분리창), `sync.py`.
- **repo/**: `generations.py`(중심: list_generations 키셋·검색·업서트·재생성·**account_uid 스코프**·리니지 그래프), **`gen_requests.py`(gen_recipe·claim·fulfill mark)**, `identity.py`(생성자·신원·**link_accounts_to_creators·set_account_hf_creator·credit_summary·list_members**), `tags.py`, `projects.py`, `share.py`, `accounts.py`(가입·인증·승인), `assets.py`, `trash.py`.
- **services/**: `syncer.py`(주기 동기화), `cli_bridge.py`(Higgsfield CLI 래퍼: parse_job·generate list·account status·workspace·**셰임/Proactor 함정**), `media_cache.py`(원격→로컬·샤딩), `thumbs.py`(썸네일), `backup.py`(SQLite 온라인 백업), `worker_backup.py`(작업자 content+trash 세트·영속 outbox·공유 서버 ACK), `auth.py`(pbkdf2 해시·무상태 hmac 토큰). (옛 `jobs.py` 서버측 잡 큐·서버측 create_job 은 push 모델 전환으로 제거됨.)

---

## 11. 프론트엔드 모듈 지도 (`frontend/src/`)

- `App.tsx` — 최상위 상태·reload/loadMore(무한 스크롤)·벌크·필터 합성(genQuery)·인증 부트스트랩·WS 진행률·캔버스 탭 보드 신호·onCreated 리니지 연결.
- `api.ts`(타입세이프 클라이언트: `create`/`regenerate` 는 이제 **`/api/gen-requests`** 호출, `credits`, 인증 Bearer), `types.ts`(응답 타입), `lib/`(`http.ts`(401 세션 만료 의미 판정)·`librarySync.ts`(자기 변경 요청↔library/assets/manage 갱신 상관관계)·`useManageRealtime.ts`(독립 PM 창 직접 WS)·`assetBroadcast.ts`(Assets 창 전달)·`i18n.ts`·`theme.ts`(강조색·모션·언어)·`prompt.tsx`·`promptEditor.ts`·`useModels.ts`).
- **components/**: `ThumbnailGrid`·`GenerationCard`(카드·오버레이·대기/생성 중 로고·상태 툴팁·썸네일·드래그 재사용), `FilterSidebar`·`LibraryToolbar`·`SearchBox`, `SpotlightPrompt`(생성 입력·@/# 피커), **`HistoryBoard`(캔버스 탭 계보 트리)·`HistoryPanel`(가계 패널)·`HistoryMiniTree`**, **`SceneBoard`/`SceneBar`(씬 캔버스)**·`FloatingPrompt`, `AssetsView/AssetsWindow`(분리창), `GenCommentPanel`, `AdminWindow`(승인·등급·프로젝트), `AccountMenu`(아바타·워크스페이스 전환·크레딧 게이지)·`ManageAccount`·**`SettingsPanel`(12개 섹션 — `settings/SettingsSections.tsx`: 강조색·언어·모션·다운로드 위치·과거 가져오기·내 메타데이터·동기화 점검·Resolve·프로그램 업데이트·재점검·단축키·ComfyUI)**, `LoginScreen`, `TopBar`(Assets·PM 보드 버튼 포함), `ManageWindow`+`manage/`(PM 분리창), `InfoPopup`·`MediaPreview`·`CompareModal`·`ShortcutsWindow`·`ProjectAssignMenu`.

---

## 12. 비자명한 설계 결정 / 함정

1. **서버는 생성 안 함**(§1) — 생성은 전원 로컬 CLI + push. 옛 서버측 생성 버튼·엔드포인트·잡 큐는 제거됨.
2. **두 종류 로그인 구분**(§3) — 허브 세션 ≠ 힉스필드 CLI 인증.
3. **계정↔creator 재연결 오염**(실측 버그·수정됨): jay `generate list` 에 섞인 남의 레퍼런스가 "새 잡"으로 잡혀 계정이 잘못 재연결됨 → ①잡 고유 uid 유지 ②이미 실제 uid면 재연결 금지 ③에이전트가 전체목록 최다 uid 명시 전송.
4. **미디어 공개 URL + 공유·최종 자동 보존** — push 는 메타만 전송한다. 공유·최종 완료본은
   `media_preservation` 큐로 자동 byte-cache하고, 개별 `/api/generations/{id}/cache`는 즉시
   재시도, 관리자 `/api/cache-all`은 전체 완료본을 저속 큐에 등록한다. 기본 총량 50GiB를 넘으면
   새 파일만 되돌리고 기존 보존본은 자동 삭제하지 않는다. 일반 미보존 생성물의 URL은 만료될 수 있다.
5. **단일 오리진 / 키셋 페이지네이션 / FTS5 검색 / 휴지통 별도 DB(WAL) / 미디어 샤딩 / 썸네일 사전생성** — (기존 Phase 0~3, 전부 구현·검증). DB 는 SQLite 단일(PG 런타임 제거·차단).
6. **마이그레이션 순서 함정**(§8) — 새 ALTER 컬럼 인덱스는 `_migrate` 에만.
7. **출처 영속화** — 원격 URL(`source_url`) 보존 → 재사용·변형 가능(provenance 최우선).
8. **자동 태그 격리** — 일반 태그와 완전 분리 네임스페이스.
9. **`--reload` 금지 / 서버 재시작 필수**(백엔드 변경). 프론트는 build + Ctrl+F5.
10. **생성은 유료** — 실제 생성 트리거는 크레딧 소모. 개발/테스트 시 주의(사용자 동의 하에만).
11. **구버전 프롬프트 호환** — 일부 옛 `prompt`의 `PromptPart[]` JSON은 프론트 API 경계에서만 엄격히
    복원한다. DB 원문은 보존하고 일반 JSON·손상 배열은 변환하지 않는다.
12. **서버형 테스트 DB 전달** — `test_push-db`의 격리 서버에서만 관리자용 전체 SQLite ZIP을 열고,
    `test_pull-db`는 콘텐츠·휴지통·팀 통계·계정 DB를 모두 검증한 뒤 `data_test`를 원자 교체한다.
13. **미디어 로드 실패 표시** — 공용 `MediaThumbnail`은 이미지 썸네일 실패 시 허용된 화면에서만
    원본 URL로 한 번 재시도하고, 원본·영상까지 실패하면 각 화면의 fallback으로 전환한다.
14. **Comfy 실행 동일성·완료 결과 보존** — 실행 시작 때 워크플로(`content`)·이름·노출 파라미터·
    실제 입력을 스냅샷으로 고정하고 실행별 `runId` 소유권을 기록한다. API 요청이 이미 시작된 뒤
    입력·씬·실행 계획이 바뀌어도 **성공한 이미지·영상은 실행 당시 입력·seed 메타로 라이브러리에
    항상 자동 저장**한다(크레딧 소모 결과는 버리지 않는다 — 씬 전환도 저장을 막지 않음). 단 변경된
    현재 카드에는 옛 outputs·`saved_generation_id`·실패를 연결하지 않고 하류 생성도 중단하며,
    상태 정리(idle/done/failed)는 자기 `runId`를 소유한 실행만 수행한다. 자동 저장만 실패한 경우
    결과 outputs는 카드에 유지하되 저장 연결 표시는 남기지 않는다(`doneOutputsPatch`).
15. **Comfy 그래프 입력 동일성** — superseded 판정은 URL 해소 상태가 아니라 **사용자 입력 정체성
    지문**(엣지/포트 구조·입력 순서·선택 generation/variant·레퍼런스 식별자·연결 텍스트 값·상류
    Comfy `runId`)으로 한다. 상류 pending 생성이 실행 도중 완료돼 URL만 생기는 것은 변경이 아니다.
    자동 저장은 현재 그래프가 아니라 실행 당시 입력·무작위 seed를 출처로 기록한다.
16. **비교 영상 동기화** — 두 비교 모달은 공용 바인더로 재생·정지·종료·수동 탐색을 처리한다.
    탐색 위치는 비율이 아닌 절대 초를 맞추고 짧은 영상은 자기 길이에서 멈춘다. 메타데이터가 늦게
    로드되면 탐색을 보류하며, 프로그램적 seek 이벤트는 다시 전파하지 않아 피드백 루프를 막는다.
17. **렌더 실행 계획 동일성** — 생성·렌더 시작 때 대상 카드와 Comfy 의존관계를 의미 기반 계획으로
    고정한다. 실행 중 체크·렌더 연결·Comfy 의존이 바뀌면 대기 중인 원격 실행과 결과 저장·후속 생성을
    중단한다. 카드 위치나 독립 노드 이동처럼 계획 의미가 같은 편집은 실행을 취소하지 않는다.
18. **생성 입력 동일성** — App의 실제 생성 요청 조립과 캔버스 실행 가드는 `sceneGenerationInputs`의
    공용 순수 규칙을 쓴다. Comfy 실행 중 대상 생성카드의 모델·파라미터·유효 텍스트·레퍼런스 순서가
    바뀌면 이전 Comfy 결과와 섞어 제출하지 않는다. 런타임 출력 URL·상태·썸네일 캐시처럼 결과에 영향
    없는 변화는 지문에서 제외한다. List 경유 배치 overlay는 같은 Comfy의 이전 저장 ref를 교체한다.
19. **생성 제출 격리** — 캔버스 렌더 실행권은 앱 전체가 아닌 씬별로 관리한다. 모델 준비부터 제출까지
    작업마다 독립 진행해 느린 1건이 다른 작업·씬을 막지 않으며, 성공한 placeholder는 전체 배치를
    기다리지 않고 원래 씬에 붙인다. 비활성 씬 결과 반영은 현재 편집 중인 씬의 저장 전 입력을 보존하고,
    대기 중 삭제된 카드·씬은 복원하지 않는다.
20. **완료 감시·재조회 경계** — 현재 씬 생성물은 `useSceneGenData`, 다른 씬의 진행 중 생성물은 App
    watcher가 담당해 같은 id의 중복 폴링과 씬 전환 누락을 함께 막는다. WebSocket은 등록 전 terminal
    상태 경합을 피하면서 알려진 생성물의 상태를 즉시 반영하고, 배치 조회는 서버 상한 500개 단위와
    제한된 동시성을 지킨다. `generations/batch` 같은 읽기용 POST는 라이브러리 변경 `synced`를 방송하지
    않아 조회→전체 reload 순환을 만들지 않는다. 숨겨진 탭의 상태 조회는 화면 복귀 전까지 쉰다.
21. **실시간 변경 상관관계** — 본 서버와 공유 서버 프록시는 같은 `mutation_notify` 계약으로 실제
    라이브러리 변경만 `synced`로 보낸다. 씬 자동 백업·Assets·설정·조회형 POST는 이 채널에서 제외한다.
    실제 변경은 탭별 일회성 요청 id를 되돌려주며, 프론트는 그 id를 포함해 목록 조회가 성공한 경우에만
    자기 알림의 두 번째 전체 reload를 한 번 생략한다. 다른 탭/기기·출처 불명·실패한 조회는 원칙적으로
    reload하며(28의 구버전 조회 반향만 짧게 예외), 외부 변경은 활성 SceneBoard와 사이드바에도 별도
    갱신 신호를 전달한다. WebSocket 최초
    연결은 초기 reload와 합치고, 실제 연결 실패·재연결 때만 누락 보정 조회를 한다.
22. **변경 영역별 실시간 갱신** — 성공한 쓰기는 응답의 `X-MVHub-Mutation-Domains`와 WS에서
    `library`/`assets`/`manage`로 분리한다. Assets·PM 독립 창은 메인 App이 닫혀 있어도 `/ws`를 직접
    구독하며, 같은 요청이 직접 WS와 BroadcastChannel 양쪽으로 와도 요청 출처 조합을 한 번만 처리한다.
    자기 창이 이미 낙관 반영한 성공 요청은 해당 영역 알림만 소비하고, 다른 탭·재연결은 반드시
    재조회한다. 출처 불명 신호는 28의 안전망 규칙을 따른다. 숨겨진 창은 복귀 때 따라잡고 PM
    대시보드는 느린 집계 요청을 겹치지 않는다.
    위임 모드는 로컬 프로세스당 원격 WS 브리지 하나가 공유 서버를 인증 구독해, 다른 PC가 직접 쓴
    `synced`/`assets_changed`/`manage_changed`도 로컬 `/ws`로 즉시 중계한다. 토큰은 URL이 아닌
    헤더로만 보내고 진행률·결과 URL은 중계하지 않는다. 로컬 즉시 알림과 원격 echo는 같은 요청 출처를
    30초간 한 번만 처리하며, 공유 서버 로그인·주소 설정은 데이터 변경 알림에서 제외한다. 30초/포커스
    조회는 WS 장애·구버전 서버의 누락 보정용으로 유지한다.
23. **프로젝트 폴더 트리 열거** — `Render` 트리는 파일을 정렬하지 않고 `os.scandir` 한 번으로 개수만
    세며, 폴더만 이름순으로 정렬한다. Windows junction/symlink는 루트 밖·순환 재귀를 막기 위해
    따라가지 않고 `truncated`로 생략 사실을 표시한다. 폴더 노드 상한에 닿으면 남은 하위 순회를 멈춘다.
24. **사이드바 폴더 배지 집계** — 디스크·가상 폴더 트리의 생성물 개수와 신규 공유 개수는 순수
    `folderTreeModel`에서 경로별 값을 부모 체인에 한 번만 누적한 뒤 노드 경로로 조회한다. 폴더마다 모든
    `folder_path`를 다시 비교하지 않으며, 입력 디스크 트리는 변경하지 않는다.
25. **프로젝트 폴더 초기 확장** — 250개 이하 트리는 기존처럼 모든 부모를 열고, 큰 트리는 표시 예산
    안에서 첫 단계만 열되 마지막 선택 폴더의 조상 체인은 항상 펼친다. 구형 전체 펼침 저장값은 버전 2
    전환 때 한 번 폐기하며 이후 수동 펼침은 계정 브라우저에 계속 저장한다. 초기 확장과 스크롤 임계값
    탐색은 반복문으로 처리하고, 스크롤 여부는 15개를 넘는 즉시 판정을 끝낸다.
26. **Assets 복귀 갱신 단일화** — 실시간 변경 큐와 focus/visibility 안전망은
    `useAssetBroadcastSync`가 함께 소유한다. 숨김 중 변경 또는 예약된 갱신이 있으면 그 경로만 실행하고,
    변경 신호가 없으며 30초가 지난 경우에만 현재 프로젝트 트리를 안전망으로 읽는다. 프로젝트 전환
    직후 focus도 새 조회를 추가하지 않는다.
27. **관리 작업 복귀 갱신 합치기** — 작업 탭의 30초 폴링·visibility 안전망은 300ms 뒤 실제 실행
    직전에 `loading`과 마지막 `loadAll` 시작 시각을 다시 확인한다. 먼저 도착한 실시간 갱신이 있으면
    5초 안의 안전망 `tasks-batch`는 생략하고, WebSocket 변경 신호의 갱신은 유지한다.
28. **구버전 실시간 반향 호환** — 최신 서버는 조회형 POST를 변경 알림에서 제외하는 것이 1차 방어다.
    프론트 HMR만 갱신되고 백엔드를 재시작하지 않은 개발 환경처럼 구버전 서버와 섞이면, bare `synced`가
    조회를 다시 쓰기로 오인해 되돌아올 수 있다. 메인 라이브러리는 bare 신호로 시작한 reload가 진행 중일
    때 기다리고, 성공 직후 1초 안의 반향만 생략한다. 이후의 외부 bare 변경과 실패한 reload는 정상
    재조회한다. 관리 창은 출처 없는 library 신호를 30초 안전망에 맡기고, 출처 있는 `synced` 및
    `manage_changed`는 즉시 반영한다. 이 호환 가드는 최신 서버의 요청 출처 계약을 대체하지 않는다.
29. **동일 동기화 응답의 렌더 경계** — 프로젝트·생성물·facets·부모 관계처럼 API JSON을 React
    state에 반영할 때 내용이 같으면 기존 배열·레코드 참조를 유지하고, 일부만 달라지면 같은 항목의
    참조를 재사용한다. 캔버스 생성물 재조회 트리거는 화면 state가 아니라 최신 요청 우선 ref로 실행해
    응답이 달라질 때만 렌더한다. 실시간 `synced`가 와도 숨은 히스토리 보드와 닫힌 코멘트 패널은
    카운터를 올리지 않는다. 둘은 실제로 열릴 때 mount 조회하므로 신선도를 잃지 않는다.
30. **Assets 동일 응답의 렌더 경계** — Assets의 프로젝트 목록·파일 트리·메타는 캐시와 서버
    재조회 자체를 유지하되, JSON 내용이 같으면 화면 state의 배열·레코드 참조를 보존한다. 따라서
    포커스 안전망이나 실시간 변경 신호가 실제 파일·버전·메타 변경을 찾지 못하면 500개 이상 파일의
    필터·정렬·가상 목록을 다시 계산하지 않는다. 파일 버전이나 중첩 노드가 하나라도 달라지면 해당
    응답은 정상 반영되며, localStorage 캐시 정책과 어셋 버전 표 갱신은 기존대로 유지한다.
31. **관리 작업·폴더 배지의 동일 응답 경계** — 관리 작업표의 실시간·30초 `tasks-batch`는 작업과
    중첩 컷·담당자 내용이 같으면 이전 배열을 유지한다. 사이드바 생성물 변경 알림은 카운터 state를
    먼저 올리지 않고 최신 조회 함수를 직접 실행하며, 폴더 카운트·팀 신규 목록도 실제 값이 달라질 때만
    state를 교체한다. 탭·핀·활성 프로젝트가 바뀐 뒤 도착한 이전 응답은 요청 번호로 폐기한다.
32. **남은 갱신 소비자의 동일 응답 경계** — 통합 관리 대시보드의 요약·작업·멤버 Map·팀 통계·추이,
    완료 탭의 프로젝트·저장 상태, 보이는 히스토리 그래프, 상단 계정 메뉴의 30초 동기화 상태는 API
    내용이 같으면 기존 state 참조를 유지한다. Map은 API JSON 레코드를 조회용으로 변환한 경우에만
    구조 비교하며, 키 집합이나 멤버 값이 달라지면 바뀐 항목만 교체한다.
33. **개인 데이터의 탭별 인증 범위** — 씬·씬 DB 백업·공유 확인 기록은 공유 localStorage의 마지막
    로그인 마커를 매 호출 따라가지 않고, 이 탭에서 인증된 계정을 sessionStorage에 고정해 같은
    브라우저의 서로 다른 계정 탭을 격리한다. 실제 인증 계정이 바뀐 경우에만 범위를 갱신하고, 화면이 옛 범위로 초기화됐다면 한 번
    새로고침한다. 자동 정렬은 외부 편집·손상 데이터의 비유한 좌표와 잘못된 격자·간격·크기를 기본값으로
    정규화하며 원본 노드 객체는 변경하지 않는다.
34. **업로드는 파싱 전·후 이중 제한** — Assets·Comfy·DB 업로드는
    `UploadBodyLimitMiddleware`가 multipart spool 전에 원시 수신 바이트를 제한하고, 라우터가 파싱된
    실제 파일의 수·개별 크기·합계를 다시 검사한다. 제한을 새로 추가하거나 경로를 바꾸면
    `UPLOAD_REQUEST_LIMITS`와 라우터 정책을 함께 갱신한다. DB import는 전체 `bytes`로 읽지 않고 앱
    전용 TEMP 파일에 제한 복사하며 모든 종료 경로에서 정리한다. 현재 ZIP 업로드 API는 없으므로
    테스트 스냅샷 ZIP 추출 계약을 업로드 계약으로 혼동하지 않는다.
35. **Assets watcher는 등록자 수명주기를 따른다** — 수동 마운트는 owner+프로젝트 이름, 자동 프로젝트는
    변하지 않는 project ID, 합본은 실제 하위 폴더별 등록 ID를 사용한다. 같은 실제 폴더를 여러 별칭·
    계정이 열어도 watchdog 핸들은 하나만 유지하고 마지막 등록자가 빠질 때만 해제한다. 성공한 경로·
    이름·보관·렌더 루트 변경과 삭제 뒤 이전 등록을 끊으며, 실패한 변경은 현재 감시를 유지한다. 앱 종료는
    timer·pending·등록표와 Observer를 함께 회수하고 해제 뒤 늦은 이벤트를 무시한다.
36. **Comfy 백그라운드 입력은 파일 경로 하나가 소유한다** — FastAPI 요청 spool은 응답 뒤 닫히므로
    1MiB씩 앱 전용 TEMP 파일에 제한 복사하고 worker에는 `bytes`가 아니라 이름·경로·크기만 넘긴다.
    로컬 복사·Cloud 변환·multipart 업로드는 같은 경로 계약을 유지하고, multipart 본문은 정확한
    `Content-Length`와 재생 가능한 1MiB iterable로 보낸다. 정상 주입·오류·스레드 시작 실패 뒤 즉시
    정리하며 삭제 실패가 성공 결과를 뒤집지 않게 한다. 강제 종료 잔재는 앱 접두 24시간 sweeper가
    보완한다. 대기 작업은 메모리 대신 TEMP 디스크를 사용한다.
37. **실시간 연결은 느린 수신자와 인증 실패를 분리한다** — 서버는 연결 목록만 매니저 잠금 안에서
    복사하고 네트워크 전송은 잠금 밖에서 병렬 수행한다. 같은 소켓의 중첩 전송은 연결별 잠금으로
    직렬화하고 2초를 넘기거나 실패한 연결만 한 번 제거·종료한다. timeout/failure 운영 지표에는 계정·
    소켓 식별자를 넣지 않는다. 프론트는 지수 백오프에 ±20% jitter와 15초 상한을 적용하고, 재연결
    성공 뒤 기존 누락 보정 조회를 실행한다. close code 1008은 반복 재접속하지 않고 인증 토큰을
    정리한 뒤 기존 `flash`·`authRequired` 이벤트로 로그인 화면과 안내를 표시한다.
38. **워치독은 응답 지연과 서버 사망을 같은 실패로 세지 않는다** — `/api/ready`는 DB 유지보수 중
    연결을 기다리지 않고 즉시 `503 maintenance`와 `Retry-After`를 반환한다. HTTP 응답이 있는
    `busy`와 명시적 `maintenance`는 경보만 남기고, 연결 거부·timeout인 `dead`만 연속 횟수에
    포함한다. 시작 유예가 끝났거나 한 번 정상화된 뒤 연속 dead가 임계치에 도달한 경우에만 정확한
    포트 소유 서버 PID를 개입 대상으로 삼는다. 응답 본문의 임의 필드는 운영 로그에 복사하지 않는다.
39. **복구 가능성은 같은 시각의 DB 세트와 실제 격리 서버로 판정한다** — 콘텐츠 하나만 열리는 것은
    복구 완료가 아니다. `content_hub_<시각>.db`와 같은 시각의 trash·manage 파일을 모두 사전 검사하고,
    복원 사본에서 스키마·전체 테이블 행 수·원본 해시를 대조한다. 그 사본만 사용하는 loopback 서버의
    content·trash·manage ready와 임시 관리자 로그인이 성공하고 핵심 수가 유지돼야 한다. 실패 시 이번
    드릴의 부분 파일과 자식 프로세스를 회수한다. `--restored-dir`로 남긴 사본에는 로그인 검증용 임시
    account·creator가 있으므로 운영 DB로 직접 쓰지 않는다.

---

## 13. 남은 과제

- **안정성 백로그**: 현재 위험 상태와 다음 작업은 [RISK_REDUCTION_PLAN_2026-08-15.md](RISK_REDUCTION_PLAN_2026-08-15.md)의 `Gate 0 산출물 — 정규화 잔여 목록`을 단일 기준으로 삼는다. [AUDIT_2026-08-15.md](AUDIT_2026-08-15.md)는 최초 발견 근거를 보존한 과거 기록이다.
- **byte-cache 운영 보강 완료(RL-22)**: 공유·최종 자동 보존, 기존 데이터 백필, 영속 상태,
  재시작 복구, 실패·용량 표시와 수동 재시도, 기본 50GiB 한도를 구현했다. 운영 실측에서는 실제
  장기 CDN 만료와 디스크 한도 도달 시나리오를 계속 확인한다.
- **create 로컬파일/asset: 레퍼런스**: 타 PC 에이전트 resolve 불가(현재 URL·텍스트만). 바이트 업로드 경로 필요.
- (선택) 워크스페이스/크레딧 실시간성, 콘텐츠 게시 승인 게이트.
- 완료된 큰 것들: 옛 서버측 생성 제거 / ComfyUI·Resolve 연동 / PM 대시보드 / 릴리스 자동
  업데이트 / DB 복원 유지보수 게이트 / 이벤트 루프 비블로킹화(§9 인벤토리 참조).

---

## 14. 운영 메모

- 백엔드 변경 → **서버 재시작 필수**. 프론트 변경 → `npm run build` + **Ctrl+F5**(재시작 불필요).
- `MV_server.bat` 기본 = 포트 **8010** + 로그인 **ON**(`CONTENT_HUB_AUTH=1`). 끄려면 bat 에서 0.
- 첫 가입자 = 관리자. 이후 가입자는 pending → 관리자 승인 필요.
- 같은 PC 는 `http://127.0.0.1:8010`, LAN 팀원은 `http://<서버IP>:8010`.
- 메모리 참조: `project_content_hub_push_model`(이번 모델 근거·구현), `project_content_hub_lineage`(계보), `project_content_hub_server`(서버화), `project_content_hub_provenance`(출처 보존).
