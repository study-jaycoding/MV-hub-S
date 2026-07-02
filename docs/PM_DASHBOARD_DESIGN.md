# PM 대시보드 설계 (Project Management Dashboard)

> ⚠️ **초기 설계 문서** — 착수 시점의 계획이며, 현재 구현과 다를 수 있다.
> 실제 동작은 코드(backend/app/repo/manage.py, frontend/src/components/manage/)를 기준으로 판단할 것.

> 작업자별·프로젝트별 **크레딧 사용량 / 제작시간 / 일정**을 한눈에 보는 관리 뷰.
> 에셋 파트(Assets 분리창)와 동일한 **분리형 모듈** 패턴으로 만든다.

---

## 0. 목표 한 줄
서버의 우리 DB를 그대로 쓰되, "무엇을 만들었나"에서 더 나아가
**"누가 / 어느 프로젝트에 / 크레딧 얼마 / 시간 얼마 / 일정은 어떤가"** 를 본다.

## 1. 핵심 철학 — 떼었다 붙였다 하는 모듈
에셋 파트가 본체 안에 박힌 게 아니라 **버튼 누르면 따로 뜨는 독립 창**인 것처럼,
PM도 똑같이 만든다. 그래서:
- **지금**: 본체 라이브러리와 안 섞인 독립 창. 개별로 개발·운영.
- **나중에 합치기**: 컴포넌트 그대로 본체 탭에 끼우면 됨.
- **나중에 떼기**: 사이드카 테이블 + 라우터 파일 + 버튼 한 줄만 제거 → 본체 무손상.

> 원칙: **코어(generation·project) 테이블은 거의 건드리지 않는다.** 새 기능 데이터는 전부 별도(사이드카) 테이블에 둔다.

---

## 2. 데이터 — 있는 것 / 없는 것 / 채우는 법

### 이미 DB에 있는 것 (집계 축, 공짜)
`generation` 한 줄에 다 있음:
- `worker_id` / `creator_uid` → **작업자**
- `project_id` → **프로젝트** (NULL=미분류)
- `created_at` / `sort_ts` → **시각**
- `model` / `params`(옵션 전부 JSON 통째로) → **무엇을**
- `status` → 상태

→ "누가·어느 프로젝트에·언제·무슨 모델로·몇 건"은 `GROUP BY`만으로 즉시 나온다.

### DB에 없는 것 (이 뷰의 핵심 두 지표)
CLI `generate list`가 **안 주는 것**:
1. **크레딧** — 생성 정보에 안 붙어 옴. 따로 물어봐야 함.
2. **제작시간** — `created_at`만 있고 시작→완료가 없음.

### 어떻게 채우나
**제작시간**: 로컬 생성요청(`gen_request`)의 3지점에 시각을 찍는다.
- 요청 생성 → `requested_at`
- 에이전트가 가져감(claim) → `started_at`
- 완료/실패(mark) → `completed_at`, 소요초 계산

**크레딧**: 두 소스를 같이 쓰는 "실제 우선" 하이브리드.
| 소스 | 명령 | 성격 |
|---|---|---|
| 견적 | `generate cost` | 모델+옵션 기준 예상가(결정적·캐시됨). 잡과 1:1 확실 |
| **실제** | `account transactions` | **실제 차감액**(음수·spend/refund/grant·시각). 단 **잡 id 없음** |

### ★ 채우는 방식 — "생성 시점 기록"이 주력 (검토 확정)
push_agent 가 허브 요청을 `generate create --wait` 로 직접 실행한다(push_agent.py:441-524).
완료까지 블록하므로 **그 순간 에이전트가 크레딧·시간을 다 쥔다** → fulfill 페이로드를
`{job, credits, started_at, completed_at, elapsed}` 로 넓혀 서버가 행에 **즉시 박제**. 매칭 불필요.

| 생성 경로 | 견적 | 실제 크레딧 | 소요시간 |
|---|---|---|---|
| **허브 생성**(fulfill, 에이전트 실행) | ✅ 실행 전 cost | ✅ 직후 transactions | ✅ 스톱워치(489줄 전후 time) |
| **힉스필드 직접**(generate list/ingest) | ✅ params 재계산 | ✅ (모델+시각) 매칭 | ❌ 복원 불가(스톱워치 밖) |
| **과거 이력** | 재계산 | 매칭 | ❌ |

→ **주력=생성 시점 기록**(허브 생성물, 모호 0). **보조=매칭 백필**(직접/과거분 크레딧만, §3 로직).
소요시간은 허브 생성물 한정 — UI 에 커버리지 표기.

---

## 3. 실제 크레딧 매칭 — 검증으로 확정 (2026-06-27)
거래내역엔 잡 id가 없어 "이 차감 = 이 잡"을 직접 못 잇는다.
→ **(모델 + 시각 최근접)** 으로 짝짓는다. 실제 데이터로 검증한 결과:

| 검증 항목 | 결과 |
|---|---|
| 시각 오차(생성물 있는 거래) | **0.02 ~ 0.28초** |
| 모델 일치율 | **16/16 = 100%** |
| 오판 | **0** (윈도우 강제 시) |

**규칙(필수):** `같은 모델 AND |거래시각 − sort_ts| ≤ 60초` 인 최근접만 귀속.
- 생성물 없는 옛 거래는 엉뚱한 잡에 안 붙고 **"미귀속"** 으로 안전하게 빠짐.
- (윈도우를 빼면 옛 거래가 430초 거리 잡에 끌려가는 사고 발생 → 검증에서 확인)

**숫자 정직성:**
- 계정/모델/기간 **총액 = 거래 합산** → 100% 정확
- 프로젝트/작업 **귀속 = 매칭** → 가진 생성물 기준 정확, 미귀속분은 별도 표기
- `action`(spend/refund/grant) 보존 → 순지출 정확

---

## 4. 구조

### 4-1. 프론트 (= AssetsWindow 쌍둥이)
| | 에셋 파트(본보기) | PM 파트(신규) |
|---|---|---|
| 여는 법 | `?embed=assets` 팝업 | `?embed=manage` 팝업 |
| 진입 버튼 | TopBar | TopBar에 "관리" 한 줄 |
| 코드 청크 | lazy `AssetsWindow` | lazy `ManageWindow` |
| 내용 | `AssetsView` | `ProjectDashboard` |
| 스타일 | `.assets-window` | `.manage-window` (같은 styles.css·칩·라임 액센트) |

참고 구현: `App.tsx` openAssetsWindow / `main.tsx` embed 분기 / `AssetsWindow.tsx`.

### 4-2. 백엔드 (사이드카)
- `routers/manage.py` + `repo/manage.py`, `main.py`에 **플래그 조건부 등록**(on/off).
- 집계 API: 프로젝트/작업/작업자별 크레딧·시간 요약, 추이.

### 4-3. DB (전부 신규 사이드카 테이블 — drop 한 번에 제거)
- `generation_metrics` — 잡별 견적·실제크레딧·requested/started/completed·소요초·매칭상태
- `credit_txn` — `account transactions` 수집(owner_uid·model·credits·action·created_at·matched_gen_id)
- `project_task` (+`task_generation`) — 작업 단위 + 생성물 연결
- `project_planning` — 마감·예산·상태 (코어 `project` 안 건드림)

> 생성물 연결은 `id` 와 `job_id` **둘 다 매칭**(기존 `assign_to_project` 규칙과 동일 — 팀 공유 탭 카드 id가 로컬 job_id라서).

---

## 5. 화면 구성 (허브 컴포넌트 재사용)
1. **요약 카드** — 총 생성수·완료수·실제 크레딧·예산 대비 잔여·총 제작시간·평균·마감초과
2. **프로젝트 표** — 프로젝트별 크레딧·건수·진행률·마감
3. **작업 칸반** — 대기 / 진행 / 검수 / 완료 (담당자 = creator_uid)
4. **작업자별 사용량** — 실제 거래 기반(푸시 모델이라 거래=그 사람 것 → 정확)
5. **추이 차트** — 일/주 단위 크레딧·건수

---

## 6. 진행 순서
1. **백엔드 사이드카** — 신규 테이블 + 거래 수집·매칭 + 집계 API (플래그 off 기본)
2. **메트릭 훅** — gen_request 3지점 타임스탬프 + 거래 push
3. **프론트 분리창** — `ManageWindow` + `?embed=manage` 분기 + TopBar 버튼
4. **대시보드 화면** — 카드→표→칸반→사용량

---

## 6-1. 현재 프로세스 위험 검토 (확인 완료)
**잡 원본 JSON 최상위 7키만**(created_at·display_name·id·job_set_type·params·result_url·status) —
크레딧·시간 필드 없음 확인. `create --wait` 응답에도 크레딧 없음 → `account transactions` 필수.

기존 흐름(① 생성 실행 claim→create --wait→fulfill ② 자동 push)에 대한 위험:
- 🟢 **안전(격리)**: 사이드카 테이블(코어 무수정)·플래그 off 라우터·`FulfillIn` extra 허용(extra='forbid' 아님 → 신구 에이전트/서버 422 없음)·fulfill CAS 멱등(metrics는 applied=True일 때만 → 이중집계 없음).
- 🟠 **유일한 실질 위험**: 에이전트가 생성(돈 걸린) 경로에서 `account transactions`/`cost`를 부르는 것.
  잡은 이미 크레딧 소모 → 메트릭 수집 실패가 fulfill(결과 보고)을 막으면 유료 결과물 미아.
  **규칙**: 메트릭 수집 try/except 격리, 실패해도 결과는 정상 보고(절대 _fail/블록 금지). per-job 금지 → **사이클당 1회**(push_once의 account status 옆).
- 🟡 **견적은 서버에서**: create_gen_request가 model+params 보유 + estimate_cost 캐시 존재 → 요청시점 서버 박제(에이전트 hot path 무수정).
- 🟡 **거래 dedup 필수**: 거래에 고유 id 없음 → (계정+created_at+credits+action) 복합키/해시로 중복 적재 방지.
- 메트릭 쓰기 삽입점 = `apply_local_fulfillment`(gen_requests.py:129) 트랜잭션 내 generation_metrics INSERT.
- 배포 순서: 서버 먼저 → 에이전트 나중(권장).

## 6-2. ★배포 구조 — 프록시(위임) 모델 (검증 중 발견, 중요)
로컬 허브는 데이터 요청을 **공유 서버로 프록시**한다(_proxy.data_proxy_middleware,
proxying() = AUTH off + shared_server_token 있음). 그래서 `/api/manage/*` 도 공유 서버로
중계된다 → 공유 서버에 manage 코드/플래그가 없으면 404(테스트 중 이 404가 났음).
- `/api/auth/config` 는 **로컬 전용**(프록시 안 함) → manage_enabled(버튼 노출)는 **로컬 허브** 플래그 기준.
- PM 데이터는 **팀 전체** 이므로 **공유 서버**에 있어야 한다.
- ∴ 운영 적용 = **공유 서버**(manage 라우트·데이터·CONTENT_HUB_MANAGE=1) **+ 각 로컬 허브**(새 프론트 버튼·CONTENT_HUB_MANAGE=1, 버튼은 로컬 config 로 뜸) 둘 다 갱신.
- **격리 테스트**: 테스트 DB 의 shared_server_token 을 지우면 프록시 꺼져 로컬에서 PM 직접 처리(run-test.bat 단독 검증). 검증 완료: summary·planning PUT/GET 왕복 정상.

## 6-3. 운영 함정 — serve.py SO_REUSEADDR 포트 스태킹
serve.py 가 SO_REUSEADDR 을 써서 **여러 서버가 같은 포트에 겹쳐 LISTEN** 가능 → 요청이
옛/새 코드로 랜덤 분산(버튼 사라짐·간헐 404). run-server.bat 은 시작 전 포트를 안 죽인다.
run-test.bat 은 시작 전 포트 강제 종료 추가함(MV_agent.bat 과 동일). 운영도 재시작 시 옛 프로세스 종료 필요.

## 7. 주의사항 (검증·코드에서 확인된 함정)
- 매칭은 **윈도우 + 모델 일치 강제** (없으면 오귀속)
- `estimate_cost`는 CLI 실패 시 `{credits:0}` 반환 → **0과 '측정실패'를 NULL로 구분**
- 메트릭 커버리지 = **로컬 요청 생성물 한정** (동기화본은 시간 없음) → UI에 "측정 N/전체 M" 표기
- 시각은 거래·생성물 둘 다 UTC (변환 불필요, 확인됨)
