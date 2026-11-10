---
status: active
updated: 2026-11-10
---

# 힉스필드 조직 사용량 1단계 — 관리자 대조 — 2026-11-10

owner: 구현 Codex(`01a1c44e-9a49-72e1-93b6-52bd87d63b36`, 작업실 `D:\ClaudeCode\work\mvhub-hf-org-usage-20261110` · 브랜치 `codex/hf-org-usage` · 기준 dev `869ed363`) · 총괄·설계: Claude(세션 `8bdc8dff-5ef4-4f02-9e56-c1dab088d39e`) · reviewer: 설계 Codex `01a1c3e2-958f-7b12-940c-7044af7dc570`(합의), 독립 리뷰는 구현·설계·합의에 안 낀 별도 Claude 세션 · status: 설계 중 · touched_paths: 아래 계약 · updated: 2026-11-10

## 요청과 결정 (Jay, 2026-11-10)

- 질문: MCP 로 생성하면 힉스필드 크레딧은 줄어드는데 MV 의 '우리에게 할당된 크레딧'(개인·그룹 몫)에 반영이 안 된다 · 힉스필드 웹에서 만든 gpt 2.6 그림이 MV 에 안 보인다.
- 조사 결론: 몫은 서버 `team_generation_fact` 중 팀 공간·공간 id·내 이메일인 생성 기록만 센다(`repo/manage_quota.py:84-98`). 설치본 연결(8010) MCP 생성은 앱과 같이 잡히지만, dev 연결(8012, `test_dev.bat:41-45` NO_PROXY)은 공유 서버로 안 가고, 힉스필드에서 가져온 동기화본은 공간이 'unknown' 이라 빠진다. 거래 짝짓기는 공간을 안 본다(`repo/manage_transactions.py:361-368`) — 11-09 Kling 수정 8cr 이 실제 R&D 차감인데 MV 엔 MUD 로 붙었다.
- Jay: "힉스필드도 많이 사용되고 있어서 더 정확하게 측정이 되어야 한다" → 힉스필드 Enterprise **공식 조직 사용량 API**(`GET https://fnf-api-gw.higgsfield.ai/fnf/v1/organization/generation_usage_report`, 조직 Owner 가 만든 Usage 키, 문서 <https://higgsfield.ai/enterprise-help-center/manage-account/usage-analytics>)를 쓰기로. "코덱스랑 같이 검토 진행" → 설계 합의. "진행"(J1 허락) · "완료까지 진행"(1단계 구현·시험·독립 리뷰·dev 통합 — 운영 서버 업데이트·키 등록은 Jay).
- **J1 허락**: 조직 사용 내역을 전부 저장하고 MV 와의 관계를 표시로 구분한다. 보존 기간·J3(채팅 등 charge 를 개인 몫에)·J4(미가입자 이메일 표시)는 미정 — 1단계는 미연결 actor 를 해시로만 보이고 자동 삭제 규칙을 넣지 않는다.

## 실측 근거 (Jay 키·Jay 터미널 직접 입력, 읽기만, 키 저장 없음)

- 0단계(11-01~11-10T05:59Z): HTTP 200 · 3,124줄 · 8개 공간 · 순 41,256.65cr(환불 뺀 값) · 웹 앱 1,821 / claude_code 911 / mcp 381 · 실패 82(content_moderated 47·ip_detected 17·provider_error 16) · 생성 ID = MV job id(6/6, 금액 동일) · Jay 본인 공간별 합계 = 힉스필드 거래 내역과 같음.
- 0b: 창은 created_at 기준·가산적(A=[11-01,11-05)+B=[11-05,11-10) = U, 줄·순·청구·환불 모두 같음, 같은 id 금액도 같음) · 같은 창 재조회 동일 · 미래 ending_at 수용 · actor.user_id = MV creator_uid(278/278) · [07-01,07-31) 6,073줄 전부 MILLION VOLT(같은 조직) · 실패는 같은 줄에서 전액 환불(75/75) · charge = type 'charge', generation_id 없음 · MV 가 만든 생성도 surface=claude_code(surface 로 MV 생성 판정 불가) · organization_id 길이 36 문자열·모든 창 같음. 미확인: 반영 지연·응답 시간·31일 넘는 정산·재분류.

## 설계 (Claude 설계 v0.1→v0.4, Codex `01a1c3e2` 2·3·4·5·6차 검토 → 4차·6차 `합의 가능`, 7차 구현 계획)

<!-- hf-org-usage-design:begin -->
- 범위: 1단계 = **관리자 대조만**. 개인 몫·그룹·관리 표·대시보드·카드·텔레메트리·거래 수집 경로는 바꾸지 않는다. 앱(frontend)·agent_push 변경 없음.
- 키: 조직 키 전용 설정을 **관리 DB 의 전용 표**에 DPAPI(machine, UI 금지)로 암호화·revision·undecryptable 상태·메타만 공개(slack_client·comfy_team_key 패턴 재사용, 저장 위치만 관리 DB — 임대·revision·성공본 교체를 한 트랜잭션에서 검사하려고). 관리자 API 는 AUTH on + 서버 PC 요청만 + 관리자 재확인(`routers/slack.py:101-110`) · 본문 크기 제한·고정 오류(입력 반사 없음)·외부 호출 리다이렉트 금지. 로컬 허브는 이 경로를 중계하지 않고 자기 404(`routers/_proxy.py` `_LOCAL_PREFIXES`). 시험은 가짜 키·루프백 가짜 서버만, 운영 설정으로 임의 호스트에 키를 보내는 기능 없음.
- 실행 조건 3갈래: `env_ok` = 공유 서버(`services/shared_connection.py:77`)·MANAGE·not READ_ONLY(`config.py:100`)·EXTERNAL_RECOVERY_ENABLED(`config.py:89`) / `collect_ok` = env_ok + 관리자 enabled + 키 유효 + 복원 정지 없음 + 임대 소유 / 키 확인 = env_ok + 서버 PC 관리자(enabled 등 선행조건 없음, 성공이 수집을 켜지 않음). 모든 외부 호출 직전에 검사. 수동 복사본은 enabled·임대로 자동 차단되지 않음 → SERVER_RECOVERY 에 외부 호출 차단 또는 키 정제 명시.
- 임대: 관리 DB 한 줄(소유자·fence·만료). 페이지 요청 직전 확인, **임대 확인과 성공본 교체는 같은 `BEGIN IMMEDIATE`**. 동시 요청 1, 전역 토큰 버킷 30회/분(키 확인·수동 새로고침·재시도 포함).
- 창: 저장 단위 = KST 하루 [전날 15:00Z, 당일 15:00Z). 오늘 창은 기본 10분(환경변수로 조정, 목표 주기이지 완료 보장 아님)·최근 7일 1시간·보존일 순환·기간 정확 창 대조(31일 이하일 때만). 논리 창 키 고정(now 로 새 창 안 만듦), 실제 조회 범위는 수집 시작 때 고정해 모든 쪽에 같게. 최초 채우기는 2026-02-01 부터 낮은 우선순위, 2026-01-31T15Z~02-01T15Z 하루는 미완전. 410 = 그 창 처음부터(제한) · 429 = Retry-After · 5xx = 지수 대기·상한 · 401/403 = 멈춤·상태. 같은 커서 반복·쪽 수·응답 크기·전체 시간 상한 넘으면 미완료.
- 교체: 페이지는 TEMP 스테이징(HTTP 를 기다리는 동안 쓰기 잠금 없음) → 모든 쪽 성공 + 검증 + 조직·키 revision·enabled·복원 정지·임대 fence 재확인 때만 그 창의 행·실제 범위·버전·성공 시각을 한 트랜잭션으로 교체. 실패·인증 오류는 성공본을 지우거나 0 으로 바꾸지 않음. 최근 시도 상태와 성공본 상태 분리. 키 교체·삭제·켜기·끄기·복원 정지는 revision 증가(0 으로 안 되돌림). 다른 조직 키로의 교체는 거부.
- 저장(관리 DB 새 표, migration 이름표 기록 없음 — `docs/CODE_MAP.md:1456` 옛 검사기는 모르는 표는 허용): config·collector(임대·예산·커서)·window·row·identity_link·check. row = row_id·type·created_at·workspace_id·workspace_name·actor_user_id·actor_email·model·model_name·credits_c·charged_c·refunded_c(1/100 정수)·status·state·error_code·generation_id·original_generation_id·output_type·surface. 키 (window_id, row_id), generation_id 는 인덱스. parameters·projects·actor 이름·chat_id·client_name·cli_version·error_message·원문 응답 저장 안 함. 금액은 1/100 로 정확히 표현되는 유한 소수만(아니면 그 창 실패), float 경유 금지, ABS·0 보정 금지.
- 합산: 기간 안 모든 하루 창(기간 시작~조회 기준 시각까지 지난 날 + 오늘)에 완전한 성공본이 있을 때만 하루 합산. 성공한 빈 창 ≠ 미수집. 누락·창 사이 같은 row_id 중복이면 0·중복 제거 없이 'API 미확정'. 정확 창 대조는 row_id 집합·행별 청구·환불·순·actor·공간까지, 불일치면 재조회 확인, 대체 중엔 같은 출처·버전. 정확 창 대조 결과는 참여한 하루 창별 성공본 버전과 정확 창 버전에 연결한다. 관련 버전이 바뀌면 이전 대조를 최신 검증으로 표시하지 않는다. 불일치로 중단한 하루 합산은 재대조 통과 전 자동 복귀하지 않는다. 해당 기간의 정확 창 성공본을 사용할 수 없으면 API 금액은 null 과 사유로 제공한다. 한 읽기 스냅샷에서 합산. 31일 넘는 기간은 하루 합산만(정확 대조 없음 표시).
- 신원: 연결 표 키 (org_id, actor_user_id). 자동 연결 = 그 actor_user_id 와 정확히 같은 creator_uid 가 승인된 MV 계정 하나에만 연결돼 있고 충돌 없음(`repo/identity.py:411` 우회 금지). 이메일은 보조, 이름·`local`·`acct:`·`user_` 접두사 변환 금지, 충돌은 미연결. 수동 재연결 UI 없음. 미연결 actor 는 해시로 표시(J4 전).
- MV 관계(1단계 3분류, 조회 때 계산): 서버 팩트에 그 job_id 있음(EXISTS — 금액 늘리지 않음) / 현재 서버에 보고된 MV 기록 없음('MV 밖'으로 단정 안 함) / 생성 아닌 차감(type='charge'). 'MV 에서 생성 확인 vs 동기화' 5분류는 텔레메트리 origin·mv_requested 가 필요해 **1b**(근거 = gen_request 와 job_id 의 앵커·완료·실패 연결 `repo/generations.py:542,608,655`).
- 대조 API(관리자, 저장된 성공본만 읽음, GET 은 외부 호출·예약 안 함): KST 시작일 포함·끝 제외 기간(기본 이번 KST 달). 공간별: API 순·청구·환불·생성 건수(charge 제외) / 서버 팩트 합(real 없으면 est, 추정 건수 표시) / CLI 거래 원장 합(credit_txn 의 사용·환불만, 다른 action 은 따로 건수) / 차이(오류 아님 — 생성일 기준 vs 거래일 기준) / MV 관계 3분류 / 사람별(연결 계정·미연결 해시) / 실패 코드별 / 출처·마지막 확인 시각·완전성. 미등록·삭제 공간도 합계에 남김. API 총액을 못 내면 null + 사유(기존 값을 대신 넣지 않음).
- 사본·복원·계정: 시험·작업실 사본은 키·새 표 비움(정제 실패 시 사본 공개 중단), 서버 복원 사본은 보존하되 disabled·복원 정지·임대 초기화(`services/db_scrub.py`, `tools/server_move.py`, `tools/workroom_data.py`). 계정 정리 판정에 조직 사용·연결 이력 포함(`repo/account_cleanup.py:204,298`).
- 관리 창: 새 메뉴 '힉스필드 키'(Comfy 키·Slack 옆) — 키 등록/교체·키 확인·수집 켜기/끄기·키 지우기(이력 보존)·상태 줄 + 대조 표(기간 선택). HTTP 는 작업 스레드, 결과는 기존 큐, 늦은 응답·세션 바뀐 응답 버림, 키 입력 칸은 보낸 뒤 비움.
<!-- hf-org-usage-design:end -->

```vibe-intent
{
  "schema": 1,
  "id": "hf-org-usage-phase1-20261110",
  "root": "D:/ClaudeCode/MV-hub-S-dev",
  "owner": {"host": "codex", "session": "01a1c44e-9a49-72e1-93b6-52bd87d63b36"},
  "risk": {"level": "major", "reason": "공유 서버 관리 DB 에 새 표·비밀 키 보관·외부 API 를 부르는 백그라운드 수집기·서버 관리 창 메뉴를 더하고, 사본 정제·복원·계정 정리 경로를 바꾼다."},
  "goal": "힉스필드 Enterprise 조직 사용량 API(Usage 키)로 팀 전체 사용 내역을 공유 서버 관리 DB 에 KST 하루 창 단위로 정확히 모으고, 서버 관리 창 '힉스필드 키' 메뉴에서 키 관리·수집 제어·기간별 대조(API 순사용 vs 서버 생성 팩트 vs CLI 거래 원장, MV 관계 3분류, 사람별, 실패 코드별, 완전성·마지막 확인 시각)를 관리자만 보게 한다. 세부 규칙은 이 기록의 hf-org-usage-design 구간이 정본이다. 제외: 개인 몫·그룹·관리 표·대시보드·카드 숫자 전환(2·3단계), 텔레메트리 origin·mv_requested 와 MV 관계 5분류(1b), 앱(frontend)·agent_push 변경, Content 권한, 그룹·한도·하위 공간 배정 읽기(API 없음), 수동 신원 재연결 UI, 보존 기간 자동 삭제, 다른 조직 키로의 전환 절차, 운영 공유 서버 업데이트·키 등록(Jay).",
  "touched_paths": [
    "backend/app/db_hf_org_usage.py",
    "backend/app/manage_db.py",
    "backend/app/config.py",
    "backend/app/main.py",
    "backend/app/repo/hf_org_usage.py",
    "backend/app/repo/account_cleanup.py",
    "backend/app/services/hf_org_usage_key.py",
    "backend/app/services/hf_org_usage_client.py",
    "backend/app/services/hf_org_usage_collector.py",
    "backend/app/services/db_scrub.py",
    "backend/app/usecases/hf_org_usage.py",
    "backend/app/routers/hf_org_usage.py",
    "backend/app/routers/_proxy.py",
    "backend/app/routers/db_transfer.py",
    "tools/server_move.py",
    "tools/workroom_data.py",
    "tools/server_console/hf_org_usage.py",
    "tools/server_console/server_api.py",
    "tools/server_console/ui.py",
    "tools/gen_inventory.py",
    "backend/tests/hf_org_usage_fake.py",
    "backend/tests/test_hf_org_usage_key_routes.py",
    "backend/tests/test_hf_org_usage_client.py",
    "backend/tests/test_hf_org_usage_repository.py",
    "backend/tests/test_hf_org_usage_collector.py",
    "backend/tests/test_hf_org_usage_comparison.py",
    "backend/tests/test_hf_org_usage_identity.py",
    "backend/tests/test_server_console_hf_org_usage.py",
    "backend/tests/test_account_cleanup.py",
    "backend/tests/test_schema_compat.py",
    "backend/tests/test_test_snapshot.py",
    "backend/tests/test_workroom_data.py",
    "backend/tests/test_server_move.py",
    "docs/CODE_MAP.md",
    "docs/SERVER.md",
    "docs/SERVER_RECOVERY.md",
    "docs/inventory/endpoints.md",
    "docs/inventory/env_vars.md",
    "docs/inventory/db_tables.md",
    "docs/inventory/background_jobs.md"
  ],
  "criteria": [
    {"id": "secret_boundary", "success": "서버 PC 의 현재 승인된 관리자만 키를 등록·확인·삭제하고, 응답·로그·오류·시험 사본·내보내기 DB 에서 가짜 비밀값이 검출되지 않으며 로컬 허브는 관리 경로를 중계하지 않는다.", "failure": "권한 우회, 키 반사·유출, 정제 실패 사본 공개, 허브 중계 중 하나라도 발생한다.", "required": true, "verification": []},
    {"id": "execution_gate", "success": "env_ok·collect_ok·키 확인 조건이 분리되어 test_dev(NO_PROXY)·READ_ONLY·외부 복구 차단·복원 정지·disabled 에서 외부 수집을 하지 않고, 키 확인 성공이 수집을 자동으로 켜지 않는다.", "failure": "금지 조건에서 외부 호출이 일어나거나 키 확인·조회가 수집을 켠다.", "required": true, "verification": []},
    {"id": "atomic_snapshot", "success": "완결된 창만 행·실제 범위·버전과 함께 한 트랜잭션으로 교체되고, 임대 fence·조직·키 revision·enabled 가 바뀐 작업 결과는 버려지며 실패가 성공본을 지우지 않는다.", "failure": "부분 결과 노출, 성공본 손실, 오래된 작업의 반영이 하나라도 발생한다.", "required": true, "verification": []},
    {"id": "bounded_collection", "success": "모든 요청(키 확인·수동 새로고침·재시도 포함)이 공통 30회/분·동시 1 을 지키고 410·429·5xx·401/403·반복 커서·상한 규칙대로 끝나며 과거 순환이 진행되고 지연이 보인다.", "failure": "예산·동시성 우회, 중복 수집, 무한 재시도, 과거 순환의 무기한 정체가 발생한다.", "required": true, "verification": []},
    {"id": "comparison_contract", "success": "KST 경계·1/100 정수 금액·빈 창과 미수집·누락·중복·정확 창 불일치·31일 초과를 구분하고, 세 비교값의 출처·시점·완전성을 표시하며 API 를 못 내면 null + 사유를 준다.", "failure": "불완전 값을 0·정확값으로 표시하거나 하루·정확 창을 이중 합산하거나 float 오차가 생긴다.", "required": true, "verification": []},
    {"id": "identity_and_relation", "success": "정확한 creator_uid 단일 일치만 자동 연결하고, MV 관계 3분류가 금액을 늘리지 않으며 미연결 actor·삭제·미등록 공간 금액도 합계에 남고 조직 이력이 있는 계정은 계정 정리에서 '이력 없음'이 되지 않는다.", "failure": "이메일만으로 연결, 권한·등록부 자동 변경, 신원 충돌 은폐, 이력 있는 계정의 잘못된 삭제가 발생한다.", "required": true, "verification": []},
    {"id": "restore_compatibility", "success": "시험·작업실 사본은 키·새 표가 비고, 서버 복원 사본은 disabled·복원 정지·임대 초기화로 수집하지 않으며, 새 표가 있는 관리 DB 가 기존 호환성 검사와 migration 이름표 목록을 그대로 통과한다.", "failure": "복원 사본 자동 수집, 새 이력·키 유출, 기존 DB 거부, migration 이름표 추가가 발생한다.", "required": true, "verification": []},
    {"id": "console_workflow", "success": "관리 창 '힉스필드 키' 메뉴가 가짜 서버로 키 등록·확인·삭제·수집 켜기/끄기·기간 대조의 정상·실패·지연 흐름을 처리하고 늦은 응답·세션 바뀐 응답을 버리며 키 입력 칸을 비운다.", "failure": "창 멈춤, 키 노출, 잘못된 기간 결과 표시, 실행되지 않은 동작의 성공 표시가 발생한다.", "required": true, "verification": []},
    {"id": "phase1_isolation", "success": "기존 개인 몫·그룹·관리 표·대시보드·카드·생성 팩트·거래 수집·텔레메트리 결과와 계약이 바뀌지 않고, 관련 기존 회귀 시험이 통과한다.", "failure": "기존 소비처 금액·권한·텔레메트리 계약이 의도 없이 바뀌거나 관련 회귀 시험이 실패한다.", "required": true, "verification": []},
    {"id": "docs_inventory", "success": "gen_inventory --check·check_code_map 이 통과하고 SERVER.md·SERVER_RECOVERY.md 에 키 등록·수집 켜기·이사/복원 때 재등록과 수동 복사본 외부 호출 차단 절차가 적혀 있다.", "failure": "목록·코드 지도가 낡았거나 운영 절차 문서가 빠진다.", "required": true, "verification": []}
  ],
  "decisions": [
    {"choice": "조직 사용량 API 를 1단계에서는 관리자 대조에만 쓴다", "why": "창 의미·신원 연결·지연을 실제 운영 값으로 확인하기 전에 몫·카드 숫자를 바꾸면 되돌리기 어렵다(Codex 4차 합의 범위)", "alternative": "바로 개인 몫 전환 — 0b 미확인 항목(지연·늦은 정산)과 J3·J4 미정 때문에 보류", "revisit": "1단계 대조에서 공간·사람별 값이 안정적으로 맞고 J3·J4 가 정해질 때(2단계)"},
    {"choice": "키·수집 상태를 관리 DB 전용 표에 둔다(콘텐츠 DB app_setting 아님)", "why": "임대·키 revision·성공본 교체를 같은 트랜잭션에서 검사해야 오래된 작업이 새 성공본을 덮지 않는다(Codex 7차)", "alternative": "Slack 처럼 app_setting 한 값 — 두 DB 를 오가 원자성 보장 불가", "revisit": "관리 DB 와 콘텐츠 DB 가 합쳐지거나 키 저장 공통 모듈이 생길 때"},
    {"choice": "저장 단위 = KST 하루 창, 기간 값은 하루 합 + 정확 창 대조", "why": "0b 에서 창이 created_at 기준·가산적으로 확인됐고 몫 기간이 모두 KST 하루의 합집합이다", "alternative": "기간별 정확 창만 — 소비처 기간마다 따로 받아 요청·저장이 늘고 31일 초과를 못 다룸", "revisit": "늦은 정산·재분류로 하루 합과 정확 창 불일치가 반복될 때"},
    {"choice": "새 표만 만들고 migration 이름표는 기록하지 않는다", "why": "서버 update_git 의 옛 검사기는 모르는 표는 허용하지만 모르는 migration 은 거부한다(docs/CODE_MAP.md:1456, scene_keep 선례)", "alternative": "migration 컴포넌트 등록 — 서버 업데이트가 막힘", "revisit": "서버 루트 검사 도구를 갱신하는 길이 생길 때"},
    {"choice": "MV 관계는 1단계 3분류, 5분류는 1b", "why": "MV 생성 여부를 surface 로 못 가르고(0b) 서버 팩트에 origin·요청 근거 칸이 없어 텔레메트리 계약 변경이 필요하다", "alternative": "surface 로 추정 — MV 생성도 claude_code 로 찍혀 오분류", "revisit": "1b 에서 텔레메트리에 origin·mv_requested 를 더할 때"}
  ],
  "references": [
    {"path": "docs/status/hf_org_usage_2026-11-10.md", "begin": "<!-- hf-org-usage-design:begin -->", "end": "<!-- hf-org-usage-design:end -->", "sha256": "10655f24772d78dff84a2fa85a5a1d007baa4daf94515ce8b3f03b48ff261db8"}
  ],
  "evidence": {
    "target": {"kind": "worktree"},
    "consensus": [
      {"host": "codex", "session": "01a1c3e2-958f-7b12-940c-7044af7dc570", "transcript": "C:/Users/FX-PC06/.codex/sessions/2026/11/10/rollout-2026-11-10T14-16-09-01a1c3e2-958f-7b12-940c-7044af7dc570.jsonl"},
      {"host": "claude", "session": "1a0cd9b2-9180-43d7-a43f-3f7afe341dc9", "transcript": "C:/Users/FX-PC06/.claude/projects/D--ClaudeCode/1a0cd9b2-9180-43d7-a43f-3f7afe341dc9.jsonl"}
    ],
    "design_sessions": [
      {"host": "claude", "session": "8bdc8dff-5ef4-4f02-9e56-c1dab088d39e"}
    ]
  }
}
```

## 진행 기록

- 11-10 구현(Codex `01a1c44e`, workspace-write): 36개 파일(새 16 + 수정 20), 계약 밖 0. 첫 판은 조직 API 봉투 규격이 기록에 없어 클라이언트를 `protocol_unconfirmed` 로 막아 둠(추측 전송 안 함) → 총괄이 공식 문서 추출본·0b 성공 스크립트를 넘겨 완성. Codex 샌드박스 안 관련 시험 14파일 302 통과·13 하위시험(`--basetemp` 새 경로).
- 11-10 총괄 확인(샌드박스 밖): `gen_inventory.py` 재생성(endpoints 462·env_vars 160·db_tables 124·background_jobs 99) → `--check` 통과 · `check_code_map` 빠짐 0. 관리 창 페이지를 가짜 값으로 실제 코드 렌더(투명 창 + PrintWindow, 스크래치 `render_hforg.py`) → 흰 입력칸·주 단추·잘리는 열 4건 고침(Codex) → 다시 찍어 확인. 머리글 일부(서버 생성 기록·생성 아닌 차감)는 좁아 잘림 — 남은 작은 다듬기.
- 11-10 백엔드 전체 시험(작업실, BelowNormal, 48분): 9,422 통과 · 27 실패 · 3 건너뜀. 실패 분류: `test_export_names_v2` 25 = 시험 임시 폴더를 긴 스크래치 경로에 둬서 Windows 259자 한도 초과(짧은 `--basetemp D:\ClaudeCode\work\pt_*` 로 다시 돌려 25 통과) · `test_agent_chat_runtime`(korean_stdin·event_flood) 2 + `test_cli_windows_shim` 자식 종료 1 = **깨끗한 dev `869ed363` 사본(`git archive` backend·tools)에서 같은 환경으로 돌려도 똑같이 실패** → 이 변경과 무관한 기존 환경 실패(이번 변경은 agent_chat·cli_bridge 를 안 건드림).
- 11-10 커밋 `d8141746`(코드)·`40490ced`(문서) → 최신 dev 병합 `1b88425c`(충돌 없음, 관련 302 통과·목록·코드 지도 통과).
- 11-10 독립 리뷰 1차(별도 Claude `dbdb4761-c750-4dff-9827-4a6a4b539cf5`, claude -p Read·Grep·Glob 만, 구현·설계·합의 세션과 분리, 대상 `1b88425c` 지문 `f9decd42…`): **P1 1**(실패 창 1분마다 끝없는 재시도·실패 창이 높은 우선순위 유지로 오늘 창·키 확인 정체·하루 창 사이 중복 row_id 면 정확 대조 무한 재조회) · **P2 9**(최초 채우기 중 오늘 창 정체·지연 안 보임 / 쓰기 잠금 안 무거운 대조 / 오늘 낀 기간 정확 대조 엇갈림 / 실패 기록 예외로 수집 스레드 죽음 / 요청 차선 35초 < HTTP 시간 / 401·403 뒤 키 확인으로 자동 재개 / 관리 창 기간 바꾸면 키 작업 결과 버림 / 오류 코드 대부분 '요청 실패' / CLI 원장 부호 가정). P2-6 은 총괄 결정 = 엄격(인증 멈춤 → enabled=0·pause_code='auth', 키 확인은 enabled 안 바꿈, 수집 켜기로만). P2-9 는 실데이터 사본 둘에서 spend ≤ 0·refund ≥ 0 확인(release: refund +30·spend −1,054 / data_test: refund +252·spend −6,455·0 3·grant +16·deduct −11) → 가정 유지, 부호 이상 행만 제외·건수 표시.
- 11-10 고침(Codex `01a1c44e`): `1dd99097`(코드·시험 14파일)·`d32e4fdf`(SERVER.md·db_tables 목록) — 관련 410 통과(밖), 목록·코드 지도 통과, 관리 창 다시 찍어 확인. 최신 dev 다시 병합 `e173bfb4`(생성 목록 endpoints.md 만 충돌 → gen_inventory 로 재생성). 후보 지문 `d99592565885534535282323a32f583e83ac54e465eb47fa89abf5569b8baaa6`.

- 11-10 설계 v0.1~v0.4·0단계·0b: 공유 노트 `C:\Users\FX-PC06\AppData\Roaming\Claude\side-session-notes\local_fca53044-0ef0-4425-aa20-86a47bfc52f0\힉스필드조직API_설계초안_v0.{2,3,4}_2026-11-10.md`(이 기록의 설계 구간으로 옮김).
- 11-10 계약 합의: SHA `5b53a348c55d62ebb3415ad3c20d075fee783f529d3a9e8769fd17cb7b773687` — Codex `01a1c3e2` 9차(8차 'root 를 작업실로'는 9차에서 철회 — 검사기 등록 작업장은 dev 하나뿐), Claude 별도 읽기 전용 세션 `1a0cd9b2`(claude -p, Read·Grep·Glob 만). 구현 참고(Claude 합의 세션): `tools/workroom_data.py:39` 가 db_scrub 를 app 없이 파일째 읽음 → 새 정제 코드는 모듈 맨 위 app import 금지 · 새 정제는 `scrub_test_snapshot_db` 안에(실패 시 예외) · `test_proxy_ownership.py:170` 이 새 경로의 `_LOCAL_PREFIXES` 누락을 잡음 · `config.py` 의 EXTERNAL_RECOVERY_ENABLED 정의는 93줄(설계 인용 89줄은 주석 머리).
- 11-10 작업실 생성(dev `869ed363`). dev 의 운영 지침 파일(CLAUDE.md·AGENTS.md·AGENT_WORKFLOW.md·WORKROOMS.md)은 미커밋 개정(`dev-centered-2026-10-27-r1`)이 있다 — 기반 정책 표식 `2026-10-15-r14` 는 같다. 개정판 운영을 따르고 파일은 건드리지 않는다.
