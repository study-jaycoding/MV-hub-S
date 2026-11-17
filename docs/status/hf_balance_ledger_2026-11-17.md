---
status: active
updated: 2026-11-17
---

# 힉스필드 잔액 장부 — 남은 크레딧을 관측으로 정확히 기록·계산 (2026-11-17)

owner: Codex(구현 `01a1e878`) · 총괄·설계: Claude(`45eaa469`) · reviewer: 설계·합의·구현에 참여하지 않은 Claude 세션 · status: 구현 중(계약 `0e600ac1` 양측 합의 — Codex `01a1e878`·Claude `dd3bf711` VIBE-AGREE) · updated: 2026-11-17
작업실: `D:\ClaudeCode\work\mvhub-hf-balance-20261117` · 브랜치 `codex/hf-balance-ledger`(dev `ca7bdcdc` 에서 분기, 기록 커밋 `635ca4a9`부터 — dev 는 그 뒤로도 움직이므로 통합 전에 dev 를 이 브랜치에 merge) · `frontend\node_modules` = dev 로 가는 junction(작업실 지우기 전 rmdir)
guard 위치: 검사기 등록 작업장은 dev 뿐이다. 계약 `root` 는 dev 이고, **계약 정본은 통합 때 dev 의 같은 경로(`docs/status/hf_balance_ledger_2026-11-17.md`)로 꺼낸 이 기록**이다. guard 시험 기록(run-test)·integrate 검사는 dev 에 꺼낸 **고정 후보 SHA** 를 대상으로 총괄이 받는다. 작업실에서 Codex 가 돌린 시험은 후보 SHA 와 함께 적는 참고이며 dev 시험 기록으로 치지 않는다. 작업실 자체를 guard 대상으로 등록하지 않는다(등록 확대는 별도 승인 범위).
관계: [1단계](hf_org_usage_2026-11-10.md) = 조직 API 사용 행 수집 · [2단계](hf_org_usage_phase2_2026-11-17.md) = 개인·그룹 '사용'을 API 기준으로. 2단계 기록의 '3단계 = 카드 금액'과는 다른 일이다. 이 기록은 **공간 잔액(Credits left)** 만 다룬다.

## 요청과 결정 (Jay, 2026-11-17 — 재질문 금지)

- "무엇에 얼마를 썼냐는 정확하게 받아오니까 그 기록을 DB 에 저장하고 그 기록을 전제로 얼마가 남았는지 정확하게 계산하자" · "CLI 와 API 를 활용해서 더 정확한 값을 받아오고 정확한 기록을 남기면 된다" · "남은 크레딧 등도 더 정확한 정보로 반영이 되고 기록되어야 한다" → "설계 시작".
- J1 = 화면 잔액은 **확인 잔액·시각만**(예상 잔액 없음) · J2 = 보고 주기 그대로 · J3 = 장부는 서브스페이스 관리 화면·관리자만 · J4 = 손 입력 충전과 후보 대조만(CSV·청구서 수집 제외) · **J5 = B**(수집별 관측을 에이전트·허브에 보존하고 ACK 받아 전부 전달 — "b로 하고") · J6 = A(불변 관측 + 현재 API 성공본으로 다시 분석).

## 근거 (11-17 확인)

- 공식 문서 6쪽(usage-analytics·sub-workspaces·buy-credits·limits·plans-billing·index): 조직 API 는 **사용**(행별 순값·청구·환불·차감)만 주고 잔액·충전·배분·갱신일·**환불 시각**은 주지 않는다.
- CLI `workspace list` 의 `credits` 는 binary32 값으로 보인다(이 PC 실측 `17574.91015625` = 17,574.91, 무료 읽기 명령) → 1/100 반올림 필요, **131,072 이상은 센트 복원이 보장되지 않는다**(Codex 정정, 초안의 167,772 는 틀린 계산). `account status` 는 선택 공간을 2자리로 준다.
- 지금 흐름의 문제(dev 정적 읽기): 관측 시각 없음 → outbox 백오프·거래 재전송으로 **옛 잔액이 새 값을 덮을 수 있음** · 공간 항목의 credits 가 없으면 NULL 덮어쓰기 · 하루 첫·끝 값만 · 보고자 없음 · '보고값' 시각이 UTC 문자열 그대로 잘려 **KST 보다 9시간 늦게 보임** · 콘솔 `unused` 가 None 을 0 으로 · 화면마다 출처가 달라 숫자가 다를 수 있음.

## 합의 1차 반영 (2026-11-17)

Codex `01a1e878`(CHANGES 4)와 별도 Claude `dd3bf711`(CHANGES 중간 5·낮음 4)를 모두 받아들였다 — 경로 3개 추가(`backend/app/services/upload_limits.py`·`backend/app/repo/account_cleanup.py`·`backend/tests/test_account_cleanup.py`), 조건 2개 신설(`delivery_target`·`ingest_guard`), `membership_compatibility`·`precision`·`consistent_display` 보강, 정밀도 규칙·공간 지정 조회 검증·계정 정리 분류를 본문(D6·2절·3절)과 결정에 명시, 아래 표식 사이 본문을 계약 `references` 로 고정, 미결정처럼 읽히던 문장 3곳(D3 J1·D4 J6·결정의 binary32)을 결정문으로 정리, 기준 커밋·guard 위치 문구 정정.

## 합의 2차 반영 (2026-11-17)

별도 Claude `dd3bf711` 은 계약 b2ef7b0e 에 동의(VIBE-AGREE), Codex `01a1e878` 은 2건 지적 — 모두 받아들였다. ① **높음**: 금액 일치만으로 공간 지정 account status 의 대상 공간을 확인할 수 없다(binary32 가 같은 다른 공간 반례). 11-17 실측에서 account status 응답 칸은 `credits`·`email`·`subscription_plan_type` 뿐(공간 식별 없음) → **account status 보완을 없애고 관측은 workspace-list 만**, 정밀도는 크기별 binary32 오차 상한(131,072 이상 binary32 수는 floor(0.5+50·ulp) cents, binary32 가 아니면 미확인)으로. ② **중간**: KEPT 분류는 실제 삭제를 막지 못한다 → reporter_uid 는 UID 이력, reporter_key·outbox account_key 는 EMAIL_HISTORY, 관측만 있는 계정·UID NULL 관측 계정 삭제 거부 시험. 계약 SHA 가 바뀌어 양측 재합의.

<!-- hf-balance-design:begin -->

## 배포 영향 (work 세션 요청 2026-11-17 — Jay: 이 작업이 끝나면 합친 배포 후보와 같이 병합)

| 항목 | 내용 |
|---|---|
| DB 스키마 | **추가만** — 콘텐츠 DB 새 표 `hf_balance_obs`·`hf_balance_outbox`(+색인), 에이전트 `agent_state.db` 새 표 `balance_observation_outbox`. 기존 표 ALTER·재작성·baseline checksum·schema version·protocol·migration 이름표 변경 **없음**(구 검사기는 추가 표를 허용, `schema_compat.py:212`). |
| 공유 서버 동작 | **바뀜** — 새 수신점 `POST /api/ingest/balance-observations`, 새 조회 `GET /api/manage/balances`·`GET /api/manage/console/balance-ledger`, 허브 60초 재전달 작업, `plan_view`·콘솔·회원 표·`credit_summary`·`/api/account/hf`·`/api/manage/workspaces` 응답에 잔액 메타데이터 추가(기존 키·숫자 형식 유지). 조회 GET 은 외부 호출·DB 쓰기 없음. |
| 서버 먼저? | **권장: 서버 먼저 → 앱(허브·에이전트) 릴리스.** 순서가 바뀌어도 깨지지 않게 설계: 새 허브·에이전트가 옛 서버를 만나면 '서버 미지원'으로 관측을 보존·대기(성공 처리 안 함), 옛 에이전트는 새 서버에서 '확인 시각 미상'으로 계속 받음. 단 서버가 먼저여야 관측이 바로 쌓인다. |
| 앱 릴리스 | **필요** — `agent_push.py`(수집 ID·관측 시각·로컬 보존·재전송)와 허브 전달이 바뀐다. 서버만 올리면 기존 에이전트는 옛 방식 그대로. |
| DB 백업 | 서버 업데이트 전 기존 백업 절차(게이트·서버 업데이트 관례)대로. 새 표 생성은 멱등·한 트랜잭션. |
| 되돌리기 | 새 표 삭제·큐 비우기는 되돌리기 절차로 쓰지 않는다. 옛 판은 추가 표를 무시하고 관측을 보존(실제 옛 판으로 시험 — AC12). 옛 판으로 내리면 신선도·부분합·장부 표시만 멈춘다. 다시 올리면 관측표 기준으로 조회. |
| 사본·복원 | 시험·작업실·개인 전송 사본은 새 표와 `hf_status`·상태 outbox 안의 `balance_report` 를 정제, 서버 복원 사본은 관측 보존(AC11). |

## 핵심 설계 (요약)

- **CLI 잔액 = 기준점(관측), API 사용 = 그 사이 출금.** 두 관측 사이 `X = (B2 − B1) + U_created` 는 **잔차**다(현금흐름·충전 확정 아님). 충전·배분·환불은 근거 있는 **후보**로만 표시.
- 관측은 콘텐츠 DB 새 표 `hf_balance_obs` 에 불변으로 쌓고(migration 이름표·기존 표 변경 없음), 에이전트 → 허브 → 서버를 **저장 ACK** 로 이어 전달한다(J5=B).
- 화면은 마지막 정상 관측 잔액 + KST 확인 시각, 미확인 공간은 부분합·미확인 수. 장부(구간 잔차·하루 API 사용·후보)는 관리자 화면 — **화면은 Claude 시안을 Jay 가 본 뒤 구현**.
- 아래 원문: Codex 설계 확정 `01a1e878`(DESIGN-CHANGES → Claude 확인, 공유 노트 `힉스필드잔액장부_설계확정안_v0.2_2026-11-17.md`) + 같은 세션의 구현 계획(J5=B 반영). 일본어로 나온 부분은 같은 세션이 한국어로 다시 쓴 것으로 바꿨다.

## 설계 확정안 D1~D8 (Codex `01a1e878` 원문)

### D1. 관측 기록과 최신 잔액

- 콘텐츠 DB에 `hf_balance_obs`를 추가한다. 새 migration 이름표는 기록하지 않는다.
- 수집별 ID, 공간 ID, 출처, 원 보고값의 십진 표현, 정규화한 정수 cents, CLI 호출 시작·끝, 로컬 허브 최초 수신, 서버 최초 수신, 보고 정밀도·시각 품질·CLI 버전을 저장한다.
- 보고자는 인증된 수신 문맥에서 결정한다. payload의 보고자 주장을 그대로 저장하지 않는다.
- 중복 제거 키는 수집 ID·공간·출처다. 같은 키·같은 내용의 재전송은 성공으로 응답한다. 같은 키의 금액·주체가 다르면 충돌로 거부한다.
- 새 수집은 잔액이 같아도 기록한다. 30분 생략은 저장 규칙에서 제거하고 차트 표시에서만 점을 줄인다.
- 금액은 유한성·타입·허용 범위를 검사한다. bool·NaN·Infinity·잘못된 문자열을 0으로 바꾸지 않는다. 누락·null·무효 금액은 마지막 정상 잔액을 지우지 않는다.
- 정상 시각의 더 새 관측만 최신 잔액 후보를 바꾼다. 늦은 관측은 이력에 남긴다. 동시각에 상충하는 값은 충돌 상태로 표시한다.
- registry `credits`는 구소비처용 호환값으로 유지한다. 새 소비처의 확인 잔액은 공통 관측 조회를 사용한다.
- registry·member의 기존 `last_seen_at` 의미는 유지한다. 잔액에는 별도 `balance_observed_at_ms`, `balance_received_at_ms`, 품질 상태를 제공한다.
- 기존 daily 자료를 정밀 관측으로 소급 생성하지 않는다. 새 관측으로 만드는 일별 첫·끝 값은 수신 순서가 아닌 관측 순서로 계산한다.

### D2. 수집·전달·혼합 판 계약

- 새 에이전트는 CLI 호출별 수집 ID와 시작·끝 시각을 만든다. 재전송 때 ID·시각·값을 바꾸지 않는다.
- 관측 시각은 workspace-list 호출의 시작·끝으로 한다(account-status 숫자는 관측으로 쓰지 않음 — D6 합의 2차). 계정 전환·사이클 캐시 무효화 규칙을 유지한다.
- 새 메타데이터는 기존 `account_status` 내부의 버전 있는 선택 필드로 싣는다. 구형 금액·공간 필드는 유지한다.
- G1의 전체 이력 보존을 위해 에이전트는 허브의 명시적 관측 저장 ACK까지 미전달 자료를 보존한다.
- 로컬 허브는 관측과 서버 전달 대상을 같은 콘텐츠 DB 트랜잭션으로 저장한다. 기존 최신 상태 outbox와 별도로 `hf_balance_outbox`를 추가한다.
- 서버에는 관측 전용 수신점을 둔다. 역사 관측 전달은 현재 멤버십·선택 공간·프로젝트 편입을 재적용하지 않는다.
- ACK는 프로토콜 버전과 저장된 관측 ID를 포함한다. 기존 `accepted=true`만으로 이력 전달 완료라고 판정하지 않는다.
- 신규 관측이 들어와도 기존 미전달 행의 백오프·실패 횟수를 초기화하지 않는다. ACK 유실·재시작·중복 전송에도 행이 늘지 않게 한다.
- 구허브·구서버는 기존 상태 보고를 계속 처리한다. 새 ACK가 없으면 ‘이력 전달 미지원/대기’로 남긴다. 자동 삭제·성공 처리는 하지 않는다.
- 구에이전트 보고는 관측 시각 미상으로 구별한다. 수신 시각을 실제 확인 시각으로 표시하지 않으며 정상 시각 관측을 덮지 않는다.
- 미래 시각을 새 수신 시각으로 반복 재생성하지 않는다. 원 시각과 최초 수신을 보존하고 시계 이상을 표시한다.
- 서로 다른 PC의 시계가 맞는다는 보장은 하지 않는다. 시각 비교가 불확실하면 최신성·구간 계산도 불확실 상태로 둔다.
- 저장 실패는 관측 보고 실패로 드러내되 사용자 생성 기능을 차단하지 않는다.

### D3. 화면 잔액

- 기본 숫자는 **마지막 정상 관측 잔액**이다. 확인 시각·출처·정밀도 상태를 함께 제공한다.
- 시각 미상 보고는 ‘N분 전 확인’ 대신 ‘N분 전 수신 · 확인 시각 미상’으로 표시한다.
- 예상 잔액은 기본 범위에서 제외한다.
- 예상 잔액은 구현하지 않는다(J1).
- 2단계 견적을 잔액에서 그대로 차감하지 않는다. 관측 잔액에 이미 반영됐는지 알 수 없는 건은 미확인으로 남긴다.
- 조회 GET은 외부 CLI·API 호출이나 수집 예약을 하지 않는다.

### D4. 잔액 장부와 분류

- 장부는 관측 구간 `(t1,B1) → (t2,B2)`를 기본 단위로 한다. 실제 시작·끝 시각을 보여 준다.
- 해당 구간의 `created_at` 기준 API 순값을 별도 분석값 `U_created`로 계산하고, `X=(B2−B1)+U_created`를 **잔차**로 표시한다.
- 이 분석은 2단계 개인·그룹 합계와 별도다. 2단계의 day 창 합산·금액 재필터 금지 계약을 변경하지 않는다.
- API 자료는 현재 조직의 유효한 day 성공본만 선택한다. exact와 day를 이중 합산하지 않는다. 미수집·중복·mismatch·불완전 범위이면 잔차를 확정 숫자로 내지 않는다.
- 공간이 해당 조직에 속한다는 근거가 부족하면 API 사용 0으로 처리하지 않고 비교 불가로 둔다.
- KST 하루 화면에는 기존 계약의 하루 API 사용량과 실제 관측 범위를 구분해 제공한다. 첫 관측·다음 날 첫 관측을 자정 잔액으로 부르지 않는다.
- 최근 2시간은 최근 자료라는 안내일 뿐, 그 뒤를 정산 완료로 판정하지 않는다.
- 허용치는 두 끝점의 수치 정밀도에서만 산출한다. 관측 수·견적 합·시각 불명을 허용치에 더하지 않는다.
- 잔차가 허용치 안이면 ‘수치 일치’로 표시하되 원인·정산 완료를 보증하지 않는다.
- 배분·충전·환불은 후보 분류다. 복수 후보는 미분류로 남긴다. 손 입력 충전과 맞으면 ‘현재 입력 계획과 일치’라고 표시한다.
- API 버전·계획 revision·조회 시각을 반환한다. API 성공본 교체나 계획 수정으로 과거 분석값이 바뀔 수 있음을 표시한다.
- 새 영속 집계표는 추가하지 않는다. J6=A: 현재 API 성공본으로 재분석하며 과거 입력·판정은 영속 보존하지 않는다.

### D5. 신선도

- 기존 이벤트·600초 목표 주기를 유지한다.
- ‘에이전트 하나면 10분 안’ 대신 마지막 관측 나이·전달 지연·보고 중단을 표시한다.
- 수집 주기와 서버 도착 주기는 구별한다.
- J2의 주기 단축·서버 직접 CLI 수집은 기본 구현에 포함하지 않는다.

### D6. 정밀도

- CLI 금액 정규화는 API 금액 파서와 구별한다. `Decimal(str(v))` 이후 명시한 반올림 방식으로 cents를 만든다.
- `167,772 초과 → precise=0` 규칙은 제거한다. binary32 가정에서 센트 복원이 실패할 수 있는 131,072 경계를 시험에 포함한다.
- 내부 정밀도 계약을 확인하기 전에는 `정확함` 대신 `2자리 보고값`, `workspace-list 보고값`, `정밀도 미확인`처럼 근거 수준을 기록한다.
- **정밀도 규칙(합의 2차 확정):** 관측 출처는 workspace-list 하나다.
  - 금액: `Decimal(str(v))` 를 1/100 로 반올림(ROUND_HALF_UP)해 cents.
  - `|값| < 131072`: `precision_kind='workspace_list_binary32'`·`precision_error_c=0`.
  - `|값| ≥ 131072` 이고 값이 binary32 로 정확히 표현되는 수: `precision_kind='workspace_list_binary32'`·`precision_error_c = floor(0.5 + 50·ulp(|값|))` cents(ulp = 그 크기의 binary32 간격 — 131,072~262,143 은 1, 262,144~524,287 은 2, 524,288~1,048,575 은 3). 근거: 참값(센트)과 binary32 값의 차이 ≤ ulp/2, 반올림 차이 ≤ 0.005 → 정수 센트 차이 ≤ floor(0.5 + 50·ulp).
  - `|값| ≥ 131072` 이고 binary32 로 표현되지 않는 수(CLI 형식이 바뀐 경우): `precision_kind='workspace_list_unknown'`·`precision_error_c=NULL`.
  - 가정: CLI 값이 binary32 표현과 일치한다(11-17 실측 `17574.91015625` 등과 맞음). CLI 내부 형식 자체는 미확인이다.
  - 장부 허용치 = 두 끝점 `precision_error_c` 의 합. **끝점 하나라도 NULL 이면 허용치 NULL, 구간 상태는 `observation_uncertain`.**
- **공간 지정 account status 보완은 하지 않는다(합의 2차).** 11-17 실측에서 `account status --json` 응답 칸은 `credits`·`email`·`subscription_plan_type` 뿐이라 **대상 공간을 독립적으로 확인할 수 없다.** 금액 일치만으로는 binary32 가 같은 다른 공간(예: 205,722.76 과 205,722.77 → 둘 다 205,722.765625)을 걸러내지 못한다(Codex 반례). 앞선 account-status 숫자를 workspace-list 선택 상태에 추측으로 붙이지도 않는다. CLI 가 공간 식별 값을 주게 되면 다시 본다.

### D7. 화면·권한

- 시안을 먼저 확인한다.
- 공유 서버의 계정 메뉴·대시보드·콘솔·회원 표는 동일한 공통 잔액 조회 결과를 사용한다.
- 본인 공간 목록·권한 필터를 유지한다. registry 전체를 계정 메뉴에 내려주지 않는다.
- 로컬 라이브 CLI는 관측 시점이 다를 수 있으므로 출처를 구별한다. 이를 포함해 모든 화면이 동시에 같은 값이라고 주장하지 않는다.
- 시간은 UTC/epoch로 전달하고 `Asia/Seoul`로 표시한다. 상대 시간과 절대 KST 시각을 함께 제공한다.
- 미확인 공간이 있으면 확인된 부분합·미확인 수를 표시한다. 이를 사용하는 할당·사용 파생값도 완전한 총계로 표시하지 않는다.
- 잔액 증가의 이름은 ‘증가 관측’ 또는 서버의 후보 분류로 바꾼다. 이를 충전 확정으로 부르지 않는다.
- 보고자 식별정보는 일반 응답·툴팁·차트에서 제외한다.
- 장부 기본 위치는 서브스페이스 관리 화면, 관리자만이다. 기존 잔액 열람 권한은 유지한다.
- 계정·서버·공간 전환 중 늦게 온 응답은 버린다. 신선도만 바뀐 보고가 라이브러리 전체 갱신을 유발하지 않게 한다.

### D8. 사본·복원·보존

- 시험 스냅샷·작업실·개인 DB 전송 사본에서는 새 관측·전달 큐를 정제한다. 삭제된 페이지 잔류까지 기존 정제 방식으로 확인한다.
- `db_scrub`의 명시 목록·압축 조건과 직접 정제 호출부를 함께 수정한다. `workroom_data`는 이미 공용 정제기를 호출하므로 중복 구현하지 않는다.
- 서버 복구용 DB 세트에는 관측을 보존한다. 관리 DB의 기존 조직 API 복원 정지·임대 무효화는 유지한다. [server_move.py:833](D:/ClaudeCode/MV-hub-S-dev/tools/server_move.py:833)
- 복원 후 자료를 현재 잔액으로 새로 확인한 것처럼 표시하지 않는다. 과거 관측 시각과 복원 정지 상태를 유지한다.
- 자동 삭제는 이번 범위 밖이다.
- 저장량은 생성 건수가 아니라 **보고 PC 수 × 수집 횟수 × 공간 수**로 추정한다. 예를 들어 PC 1대·공간 8개·24시간·10분 주기면 연 약 42만 관측이며, 10대면 약 420만이다. 실제 크기·조회 비용은 격리 자료로 측정한다.


## 구현 계획 (Codex `01a1e878`, J5=B 반영 — 1~4절 원문)


아래 계획은 **Jay 결정 J1~J6을 반영한 3묶음 구현안**입니다. 추가 결정은 필요하지 않습니다. 새 표는 콘텐츠 DB 2개·에이전트 SQLite 1개이며, 기존 표의 구조와 migration 이름표는 바꾸지 않습니다.

구현 위치는 `D:\ClaudeCode\work\mvhub-hf-balance-20261117`, 브랜치는 `codex/hf-balance-ledger`를 제안합니다. 실제 생성 직전에 dev 기준 SHA·기존 변경·지침 정합성을 확인하고 고정합니다. 이번에는 생성하지 않았습니다.

## 1. touched_paths

아래 세 묶음과 공통 문서 배열의 **합집합이 전체 허용 경로**입니다. 새 파일은 별도로 표시했습니다. 구현 중 다른 경로가 필요하면 해당 수정 전에 계약 목록을 갱신합니다.

작업 기록은 `docs/status/hf_balance_ledger_2026-11-17.md`로 정합니다. guard 안내에 따라 **계약을 담는 작업 기록 자체와 `.mvhub-board.txt`는 touched_paths에서 제외**하고 별도로 관리합니다.

### 1묶음 — 저장·수신·내구성 전달·정제

```json
[
  "agent_push.py",
  "backend/app/db.py",
  "backend/app/db_hf_balance.py",
  "backend/app/hf_balance_contract.py",
  "backend/app/models.py",
  "backend/app/main.py",
  "backend/app/mutation_notify.py",
  "backend/app/repo/__init__.py",
  "backend/app/repo/identity.py",
  "backend/app/repo/manage_account_reports.py",
  "backend/app/repo/hf_balance.py",
  "backend/app/services/hf_balance_delivery.py",
  "backend/app/usecases/hf_balance.py",
  "backend/app/routers/hf_balance.py",
  "backend/app/routers/ingest.py",
  "backend/app/routers/_telemetry.py",
  "backend/app/routers/sync.py",
  "backend/app/services/db_scrub.py",
  "backend/app/routers/db_transfer.py",
  "tools/workroom_data.py",
  "tools/gen_inventory.py",
  "backend/tests/hf_balance_fixtures.py",
  "backend/tests/test_agent_balance_observations.py",
  "backend/tests/test_hf_balance_repository.py",
  "backend/tests/test_hf_balance_protocol.py",
  "backend/tests/test_hf_balance_delivery.py",
  "backend/tests/test_hf_balance_compatibility.py",
  "backend/tests/test_hf_balance_routes.py",
  "backend/tests/test_agent_account_snapshot.py",
  "backend/tests/test_agent_contracts.py",
  "backend/tests/test_account_report_delivery.py",
  "backend/tests/test_account_report_consistency.py",
  "backend/tests/test_credit_balance_refresh.py",
  "backend/tests/test_identity_registry.py",
  "backend/tests/test_schema_compat.py",
  "backend/tests/test_proxy_ownership.py",
  "backend/tests/test_upload_limits.py",
  "backend/tests/test_mutation_notify.py",
  "backend/tests/test_main_lifespan_cleanup.py",
  "backend/tests/test_test_snapshot.py",
  "backend/tests/test_workroom_data.py",
  "backend/tests/test_server_move.py",
  "backend/tests/test_worker_backup_v3_delivery.py"
]
```

새 파일:

- `db_hf_balance.py`: 추가 표 생성·구조 검사.
- `hf_balance_contract.py`: 순수 Python 금액 정규화·입력 검사·정규 JSON 지문.
- `repo/hf_balance.py`: 관측·전달 큐·공통 잔액 조회 SQL.
- `services/hf_balance_delivery.py`: 전달·ACK 처리·재시도 일정.
- `usecases/hf_balance.py`: 수신 처리와 조회 조립. FastAPI 의존 없음.
- `routers/hf_balance.py`: 관측 수신·공통 잔액·장부 HTTP 경계.
- `hf_balance_fixtures.py`와 `test_*balance*` 파일: 새 시험 자료·시험.

`agent_push.py`는 단일 파일·표준 라이브러리만 유지합니다. 서버의 순수 계약 구현과 에이전트 구현은 같은 고정 입력 자료로 결과를 대조합니다.

### 2묶음 — 공통 조회·기존 소비처·최소 화면 수정

```json
[
  "backend/app/repo/hf_balance.py",
  "backend/app/repo/identity.py",
  "backend/app/repo/manage_credit_plan.py",
  "backend/app/repo/workspace_console.py",
  "backend/app/repo/manage_member_table.py",
  "backend/app/usecases/hf_balance.py",
  "backend/app/routers/hf_balance.py",
  "backend/app/routers/ingest.py",
  "backend/app/routers/manage.py",
  "backend/tests/test_hf_balance_consumers.py",
  "backend/tests/test_hf_balance_routes.py",
  "backend/tests/test_credit_plan.py",
  "backend/tests/test_workspace_console.py",
  "backend/tests/test_manage_member_table.py",
  "backend/tests/test_identity_permissions.py",
  "frontend/src/shared/contracts/hfBalance.ts",
  "frontend/src/lib/hfBalance.ts",
  "frontend/src/lib/format.ts",
  "frontend/src/lib/useSyncStatus.ts",
  "frontend/src/lib/creditPlan.ts",
  "frontend/src/lib/memberTable.ts",
  "frontend/src/lib/workspaceConsole.ts",
  "frontend/src/types.ts",
  "frontend/src/api.ts",
  "frontend/src/components/AccountMenu.tsx",
  "frontend/src/components/manage/CreditPoolSection.tsx",
  "frontend/src/components/manage/MemberTable.tsx",
  "frontend/src/components/manage/console/WorkspaceConsole.tsx",
  "frontend/src/components/manage/console/ConsoleMainParts.tsx",
  "frontend/src/components/manage/console/ConsoleSubView.tsx",
  "frontend/src/components/manage/console/CreditCalendar.tsx",
  "frontend/tests/hfBalance.test.ts",
  "frontend/tests/balanceTime.test.ts",
  "frontend/tests/accountMenuCredits.test.tsx",
  "frontend/tests/creditPlan.test.ts",
  "frontend/tests/memberTable.test.tsx",
  "frontend/tests/workspaceConsole.test.ts",
  "frontend/tests/workspaceConsoleSync.test.tsx",
  "frontend/tests/syncStatus.test.ts"
]
```

새 파일:

- `test_hf_balance_consumers.py`
- `shared/contracts/hfBalance.ts`: 응답 타입만.
- `lib/hfBalance.ts`: HTTP 호출만.
- `hfBalance.test.ts`, `balanceTime.test.ts`

`frontend/src/api.ts`는 기존 `syncStatus`의 인라인 응답 타입도 수정해야 합니다. 현재 계정 보고 필드가 직접 선언되어 있습니다.

### 3묶음 — 장부 계산·관리자 화면

```json
[
  "backend/app/repo/hf_balance.py",
  "backend/app/repo/hf_balance_ledger.py",
  "backend/app/usecases/hf_balance.py",
  "backend/app/routers/hf_balance.py",
  "backend/tests/hf_balance_fixtures.py",
  "backend/tests/test_hf_balance_ledger.py",
  "backend/tests/test_hf_balance_routes.py",
  "backend/tests/test_hf_balance_compatibility.py",
  "frontend/src/shared/contracts/hfBalance.ts",
  "frontend/src/lib/hfBalance.ts",
  "frontend/src/components/manage/console/WorkspaceConsole.tsx",
  "frontend/src/components/manage/console/BalanceLedger.tsx",
  "frontend/src/styles/composition-manage.css",
  "frontend/tests/hfBalanceLedger.test.tsx"
]
```

새 파일:

- `repo/hf_balance_ledger.py`
- `test_hf_balance_ledger.py`
- `console/BalanceLedger.tsx`
- `hfBalanceLedger.test.tsx`

### 공통 문서·생성 목록

```json
[
  "docs/CODE_MAP.md",
  "docs/README.md",
  "docs/CURRENT_STATUS.md",
  "docs/SERVER_RECOVERY.md",
  "docs/inventory/db_tables.md",
  "docs/inventory/endpoints.md",
  "docs/inventory/background_jobs.md",
  "docs/inventory/env_vars.md"
]
```

목록 생성기는 네 파일을 모두 쓰므로 네 경로를 허용합니다. **새 제품 환경변수는 추가하지 않으며**, `env_vars.md`의 내용 변경은 예상하지 않습니다.

다음 파일은 읽고 회귀 시험하되 제품 코드는 변경하지 않습니다.

- `backend/schema.sql`: 새 표 DDL은 `db_hf_balance.py` 한 곳에 둡니다.
- `backend/app/schema_compat.py`, `db_migrations.py`: baseline·기존 백필 계약 유지.
- `backend/app/repo/manage_schema.py`: 기존 outbox 타입·구조 유지.
- `backend/app/repo/hf_org_usage.py`, `manage_db.py`: 1·2단계 집계 계약 유지.
- `tools/server_move.py`, `services/worker_backup.py`, `services/test_snapshot.py`: 기존 연결을 재사용하고 시험으로 확인.
- `AGENTS.md`, `CLAUDE.md`, 역할·guard·배포 정책 파일: 변경 대상 아님.

## 2. 저장 구조

### 공통 원칙

- 관측의 원 금액·수집 시각·수집 주체는 저장 후 수정하지 않습니다.
- 수신 시각·서버 판정은 각 수신자가 처음 저장한 값으로 고정합니다.
- ACK·재시도 상태만 전달 큐에서 갱신합니다.
- 관측표에는 registry·account를 향한 삭제 전파 외래키를 두지 않습니다. 공간·계정 삭제로 관측 이력이 사라지지 않게 합니다.
- 새 표 생성·색인·구조 확인은 한 트랜잭션으로 처리합니다.
- `MANAGE=0`에서는 새 기능·전달 작업을 활성화하지 않습니다.
- 새 표의 구조가 예상과 다르면 임의 복구·덮어쓰기 없이 해당 쓰기를 거부합니다.

### 콘텐츠 DB — 관측

```sql
CREATE TABLE IF NOT EXISTS hf_balance_obs (
    observation_id       TEXT PRIMARY KEY,
    protocol_version     INTEGER NOT NULL CHECK(protocol_version = 1),

    collection_id        TEXT NOT NULL,
    collector_id         TEXT NOT NULL,
    collection_seq       INTEGER NOT NULL CHECK(collection_seq >= 1),

    reporter_key         TEXT NOT NULL,
    reporter_uid         TEXT,

    workspace_id         TEXT NOT NULL,
    source               TEXT NOT NULL
                         CHECK(source IN ('workspace_list')),

    reported_credits     TEXT NOT NULL,
    credits_c            INTEGER NOT NULL
                         CHECK(
                           typeof(credits_c) = 'integer'
                           AND credits_c BETWEEN -9007199254740991
                                             AND 9007199254740991
                         ),

    started_at_ms        INTEGER NOT NULL,
    observed_at_ms       INTEGER NOT NULL,
    local_received_at_ms INTEGER,
    received_at_ms       INTEGER NOT NULL,

    time_quality         TEXT NOT NULL
                         CHECK(time_quality IN (
                           'reported', 'future', 'reversed'
                         )),

    precision_kind       TEXT NOT NULL
                         CHECK(precision_kind IN (
                           'workspace_list_binary32',
                           'workspace_list_unknown'
                         )),
    precision_error_c    INTEGER
                         CHECK(
                           precision_error_c IS NULL
                           OR precision_error_c >= 0
                         ),

    cli_version          TEXT,
    payload_sha256       TEXT NOT NULL,

    UNIQUE(
      reporter_key,
      collector_id,
      collection_seq,
      workspace_id,
      source
    )
);

CREATE INDEX IF NOT EXISTS idx_hf_balance_obs_latest
ON hf_balance_obs(
    workspace_id,
    observed_at_ms DESC,
    observation_id DESC
)
WHERE time_quality = 'reported';

CREATE INDEX IF NOT EXISTS idx_hf_balance_obs_history
ON hf_balance_obs(
    workspace_id,
    observed_at_ms,
    observation_id
);
```

보충:

- `reporter_key`는 수신자가 검증한 계정 키이며 응답에 내보내지 않습니다.
- `reporter_uid`는 당시 신원 스냅샷입니다. `_REMAP_EXEMPT`에 사유를 등록하고 접근 권한 판정에는 사용하지 않습니다.
- **계정 정리 분류(합의 2차):** 실제 이력 검사는 `uid_history_columns()` 와 `EMAIL_HISTORY` 만 읽는다(`account_cleanup.py:107`) — 시험의 KEPT 분류만으로는 삭제를 막지 못한다. 그래서 `hf_balance_obs.reporter_uid` 는 **UID 이력**(uid_history_columns 에 포함 — `_REMAP_EXEMPT` 는 유지해 신원 재연결이 과거 스냅샷을 고치지 않게), `hf_balance_obs.reporter_key`(= 수신자가 확인한 계정의 소문자 정규화 이메일)와 `hf_balance_outbox.account_key` 는 **EMAIL_HISTORY**(기존 `asset_sync_outbox` 와 같은 취급, `account_cleanup.py:58`)로 등록한다. 시험: 관측만 있고 전달 큐가 없는 계정, UID 가 NULL 인 관측만 있는 계정(이메일 키로) 모두 계정 정리가 삭제를 거부한다. `test_account_cleanup.py` 의 전 칸 분류 목록에도 새 칸을 넣는다.
- `collector_id`는 기존 에이전트 상태 DB의 영속 device ID를 재사용합니다. PID를 붙인 실행 인스턴스 ID는 사용하지 않습니다.
- `collection_seq`는 기존 `meta`의 값으로 증가시킵니다. 기존 표의 **열 변경은 없고 행 추가·갱신만** 있습니다.
- `observed_at_ms < started_at_ms`도 원 시각을 보존해야 하므로 DDL에서 삭제·보정하지 않고 `reversed`로 분류합니다.
- 금액은 새 JSON 계약에서 안전하게 표현할 수 있는 정수 범위로 제한합니다. 집계 결과도 응답 전에 범위를 검사하며 초과 시 null·사유를 반환합니다.
- `precision_error_c=0`은 해당 보고 숫자의 정밀도 기준입니다. 실제 과금 시점이나 공급자의 내부 원장 정확성을 보증하지 않습니다.
- 구에이전트에는 수집 ID가 없으므로 **새 수집별 관측을 만들어 내지 않습니다.** 기존 registry 값을 `legacy_snapshot`, `time_basis=received`인 조회 결과로 제공하고 확인 시각은 null로 둡니다.

### 콘텐츠 DB — 허브 전달 큐

```sql
CREATE TABLE IF NOT EXISTS hf_balance_outbox (
    account_key          TEXT NOT NULL,
    target_key           TEXT NOT NULL,
    observation_id       TEXT NOT NULL
                         REFERENCES hf_balance_obs(observation_id)
                         ON DELETE RESTRICT,

    queued_at_ms         INTEGER NOT NULL,
    state                TEXT NOT NULL DEFAULT 'pending'
                         CHECK(state IN (
                           'pending', 'sending', 'acked',
                           'unsupported', 'conflict'
                         )),

    attempts             INTEGER NOT NULL DEFAULT 0,
    fail_streak          INTEGER NOT NULL DEFAULT 0,
    last_attempt_at_ms   INTEGER,
    next_retry_at_ms     INTEGER NOT NULL DEFAULT 0,

    lease_token          TEXT,
    lease_until_ms       INTEGER,

    acked_at_ms          INTEGER,
    receiver_database_id TEXT,
    last_error_code      TEXT,

    PRIMARY KEY(account_key, target_key, observation_id)
);

CREATE INDEX IF NOT EXISTS idx_hf_balance_outbox_due
ON hf_balance_outbox(
    account_key,
    target_key,
    state,
    next_retry_at_ms,
    queued_at_ms
);
```

- 토큰·비밀번호는 저장하지 않습니다.
- `target_key`는 기존 서버 동일성 판정을 따릅니다. HTTPS 전환을 다른 서버로 오인하거나 저장된 옛 HTTP 주소로 하향 전송하지 않습니다.
- 전송 직전에 현재 계정·연결과 일치하는지 확인합니다. 다른 서버로 자동 재지정하지 않습니다.
- ACK 성공 후에도 행을 삭제하지 않고 `acked`로 보존합니다. 자동 삭제는 이번 범위 밖입니다.
- `unsupported`는 영구 폐기가 아닙니다. 대상별 재확인을 600초로 제한하고 신규 관측이 그 대기를 초기화하지 못하게 합니다.

### 에이전트 `agent_state.db` — 미전달 관측

```sql
CREATE TABLE IF NOT EXISTS balance_observation_outbox (
    server_key           TEXT NOT NULL,
    account_email        TEXT NOT NULL,
    observation_id       TEXT NOT NULL,

    collection_id        TEXT NOT NULL,
    collector_id         TEXT NOT NULL,
    collection_seq       INTEGER NOT NULL,

    payload_json         TEXT NOT NULL,
    payload_sha256       TEXT NOT NULL,
    created_at_ms        INTEGER NOT NULL,

    state                TEXT NOT NULL DEFAULT 'pending'
                         CHECK(state IN (
                           'pending', 'acked',
                           'unsupported', 'conflict'
                         )),
    attempts             INTEGER NOT NULL DEFAULT 0,
    fail_streak          INTEGER NOT NULL DEFAULT 0,
    last_attempt_at_ms   INTEGER,
    next_retry_at_ms     INTEGER NOT NULL DEFAULT 0,

    hub_acked_at_ms       INTEGER,
    receiver_database_id TEXT,
    last_error_code      TEXT,

    PRIMARY KEY(server_key, account_email, observation_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_balance_outbox_due
ON balance_observation_outbox(
    server_key,
    account_email,
    state,
    next_retry_at_ms,
    created_at_ms
);
```

CLI 결과를 받으면 **허브 요청 전에** 저장합니다. 허브 저장 ACK 후에도 행을 삭제하지 않고 `acked`로 남깁니다.

### 기존 표·검사기 영향

기존 표의 `ALTER`, 재작성, baseline checksum 변경, schema version·protocol 상향은 없습니다.

현재 검사기는 추가 표를 허용하지만 모르는 migration은 거부합니다. 따라서 새 DDL을 기존 baseline 정의에 포함하지 않습니다. [schema_compat.py:212](D:/ClaudeCode/MV-hub-S-dev/backend/app/schema_compat.py:212), [schema_compat.py:260](D:/ClaudeCode/MV-hub-S-dev/backend/app/schema_compat.py:260)

`db_hf_balance.py`는 다음을 직접 검사합니다.

- 필수 열·PK·UNIQUE
- 두 색인의 열·정렬·부분 조건
- 초기화 재실행의 멱등성
- 기존 `schema_migrations`·`schema_meta`·`user_version` 불변

새 DDL 위치는 목록 생성기의 수동 DB 위치 표에 등록해야 합니다. [gen_inventory.py:29](D:/ClaudeCode/MV-hub-S-dev/tools/gen_inventory.py:29)

## 3. 프로토콜

### 관측 원문

기존 `account_status`에 다음 선택 필드를 추가합니다. 다른 필드는 유지합니다.

```json
{
  "email": "fixture@example.test",
  "credits": 17574.91,
  "workspaces": [],
  "balance_report": {
    "version": 1,
    "observations": [
      {
        "observation_id": "UUID",
        "collection_id": "UUID",
        "collector_id": "persistent-device-UUID",
        "collection_seq": 123,
        "workspace_id": "workspace-id",
        "source": "workspace_list",
        "started_at_ms": 1794873600000,
        "observed_at_ms": 1794873600450,
        "reported_credits": "17574.91015625",
        "credits_c": 1757491,
        "cli_version": "fixture-version"
      }
    ]
  }
}
```

- `observation_id`는 공간별 표본 ID입니다.
- `collection_id`·`collection_seq`는 CLI 호출별입니다.
- workspace-list의 여러 공간은 같은 호출 시각을 공유합니다.
- 관측은 workspace-list 에서만 만듭니다(`source='workspace_list'`). account-status 숫자는 관측으로 쓰지 않습니다 — 응답에 공간 식별 값이 없어(11-17 실측) 어느 공간 값인지 독립적으로 확인할 수 없기 때문입니다(합의 2차). 정밀도는 D6 의 binary32 규칙으로 정합니다. 위 예시의 `"source"` 는 이 값 하나입니다.
- 문자열 길이·UUID·정수 타입·금액·시각을 검사합니다. bool은 정수로 받지 않습니다.
- `credits_c`는 서버가 다시 계산해 대조합니다. 클라이언트 정밀도·보고자 UID는 신뢰하지 않습니다.
- 지문은 정규화한 불변 필드의 UTF-8 JSON으로 계산합니다. 수신 시각·재시도 정보는 제외합니다.

### 에이전트 → 허브

정상 상태 보고는 기존 `POST /api/ingest`를 유지합니다. 최신 수집 관측을 함께 보내고, 새 `IngestOut.balance_receipt`로 저장 결과를 받습니다.

미전달 역사 관측은 아래 전용 수신점으로 재전송합니다.

```http
POST /api/ingest/balance-observations
```

```json
{
  "version": 1,
  "account_email": "fixture@example.test",
  "observations": []
}
```

정상 ingest에서는 관측 실패가 생성물 적재 성공을 취소하지 않습니다. 저장된 ID만 ACK하고 나머지는 에이전트에 남깁니다.

### 허브 저장 ACK

```json
{
  "version": 1,
  "receiver_kind": "hub",
  "receiver_database_id": "database-UUID",
  "stored": [
    {
      "observation_id": "UUID",
      "payload_sha256": "64-hex",
      "received_at_ms": 1794873600500
    }
  ],
  "conflicts": [],
  "rejected": []
}
```

허브는 다음이 **커밋된 뒤에만** `stored`를 반환합니다.

1. 관측 저장
2. registry 호환 잔액 반영
3. 공유 서버 연결 모드이면 해당 대상의 전달 큐 저장

로컬 단독 모드에서는 서버 전달을 약속하지 않습니다. `receiver_kind=hub` ACK는 **허브 인수 완료**이며 서버 저장 완료와 구별합니다.

### 허브 → 서버

동일 경로를 서버에도 등록합니다.

```http
POST /api/ingest/balance-observations
```

요청은 같은 관측 원문과 허브 최초 수신 시각을 포함합니다. 서버는 인증 계정과 `account_email`을 대조하고 보고자를 결정합니다.

응답은 같은 형식이며 `receiver_kind="server"`입니다. 서버 저장 ACK가 맞아야 허브 큐를 `acked`로 바꿉니다.

- 한 요청 최대 100관측. 초과는 저장·ACK 없이 거부합니다.
- **인증(합의 1차):** 허브 수신점은 기존 ingest 와 같은 로컬 에이전트 키 검사(`ingest.py:84`)와 CLI 계정 = 허브 로그인 계정 검사(`ingest.py:139-152`)를 통과해야 하고, 서버 수신점은 인증된 계정과 `account_email` 이 같아야 합니다. 실패하면 아무것도 저장하지 않고 고정 오류로 거부합니다. payload 의 보고자·UID 는 믿지 않습니다.
- 본문 최대 256KiB(262144바이트), JSON 파싱 전 바이트 제한 — 기존 제한기 `backend/app/services/upload_limits.py` 의 `UPLOAD_REQUEST_LIMITS` 에 새 수신점을 등록해 413 으로 거부합니다(Content-Length 없음·허위 값·나눠 받기 포함).
- 역사 관측 수신은 **현재 멤버십·이름·플랜·선택 공간·프로젝트 편입을 수정하지 않습니다.**
- 서버는 원 관측 시각·허브 수신 시각과 별도로 자기 최초 수신 시각을 저장합니다.
- 서버 수신은 외부 CLI·조직 API를 호출하지 않습니다.

### 중복·충돌·실패

| 조건 | 처리 |
|---|---|
| 같은 ID·같은 불변 내용·같은 보고자 | 기존 행을 반환하고 ACK. 수신 시각 갱신 없음 |
| 같은 ID인데 내용·보고자가 다름 | 원행 보존, 해당 ID만 `conflict` |
| 같은 수집 키인데 다른 ID·다른 내용 | 해당 표본 충돌. 임의 덮어쓰기 없음 |
| 일부 유효·일부 충돌 | 유효 행만 커밋·ACK, 충돌 ID는 별도 반환 |
| 잘못된 버전·요청 모양 | 고정 오류. 성공 ACK 없음 |
| DB 저장 실패·ACK 유실·timeout | 큐 유지, 같은 ID 재시도 |
| 404·405 또는 ACK 버전 부재 | 미지원 상태, 성공 처리하지 않음 |
| ACK에 요청하지 않은 ID·다른 지문 | 잘못된 ACK로 거부 |
| 전송 중 계정·대상 변경 | 이전 대상 ACK로 현재 큐를 정산하지 않음 |

기존 상태 outbox는 `balance_report`를 제외한 상태를 저장·해시합니다. 따라서 관측 시각 때문에 기존 백오프·격리 상태가 초기화되지 않습니다. 현재 코드는 payload 변경 때 이를 초기화합니다. [manage_account_reports.py:36](D:/ClaudeCode/MV-hub-S-dev/backend/app/repo/manage_account_reports.py:36)

### 재시도 일정

- 에이전트: 정상 수집 주기는 유지. 미전달 관측만 별도 재시도하며 CLI를 다시 부르지 않습니다.
- 허브: 기존 telemetry drain에 관측 전달을 연결합니다.
- 새 입력 없이도 재시도하도록 워커 허브에 60초 확인 작업을 추가합니다. CLI 수집 주기 변경은 아닙니다.
- 한 drain에서 최대 100개를 전달합니다. 최신 공간 관측과 오래된 대기 관측 모두 진행하도록 최대 50개씩 배분하고 남는 자리는 재사용합니다.
- 네트워크 중 DB 쓰기 잠금을 유지하지 않습니다.
- 계정·UID·연결·토큰을 고정하고, lease token과 대상이 맞을 때만 ACK를 반영합니다.
- 서버 본체·READ_ONLY·외부 작업 차단·격리 모드에서는 원격 전달 작업을 시작하지 않습니다.
- 종료 시 재시도 생산자를 먼저 멈추고 기존 drain 종료 절차로 회수합니다.

### 구판 조합

`N=신판`, `O=구판`입니다.

| 에이전트 / 허브 / 서버 | 동작 |
|---|---|
| N / N / N | 두 단계 저장 ACK와 전체 이력 전달 |
| N / N / O | 에이전트는 허브 ACK 후 보존. 허브는 서버 미지원으로 대기 |
| N / O / N | 기존 상태 경로는 동작. 구허브는 이력 ACK를 못 주므로 에이전트가 보존 |
| N / O / O | 기존 숫자 경로만 동작. 새 이력은 에이전트에서 대기 |
| O / N / N | 기존 보고 수용. 관측 시각 미상인 legacy 표시 |
| O / N / O | 기존 상태 전달 유지. 수집별 이력 보장은 없음 |
| O / O / N | 서버의 기존 수신 경로 유지, legacy 표시 |
| O / O / O | 기존 동작 |

구앱은 추가 필드를 무시하고 기존 키를 읽습니다. 신앱은 구서버를 만나면 지원 없음·시각 미상으로 표시합니다. **구앱이 새 신선도·부분합 의미까지 올바르게 표시한다고 보장하지 않습니다.**

## 4. 공통 조회·장부 API·소비처

### 공통 내부 조회

```text
balance_snapshot(conn, workspace_ids, as_of_ms) -> 공간별 BalanceView
```

- 한 콘텐츠 DB 읽기 스냅샷에서 여러 공간을 함께 읽습니다.
- 정상 시각의 최신 관측을 고릅니다.
- 같은 최신 시각에 상충 값이 있으면 충돌을 알리고 임의로 확정하지 않습니다.
- 미래·시계 역행 관측은 이력에 보존하되 정상 최신값을 대체하지 않습니다.
- 정상 관측이 없으면 registry 값을 legacy로 반환합니다.
- `last_seen_at`을 잔액 관측 시각으로 재해석하지 않습니다.
- 서로 다른 PC 시계가 실제로 일치한다는 보장은 하지 않습니다.

### 공통 잔액 HTTP API

```http
GET /api/manage/balances
GET /api/manage/balances?workspace_id=<id>
```

권한:

- 기본 조회는 역할과 관계없이 **본인의 현재 가용 공간만**.
- 특정 공간은 해당 공간 멤버 또는 기존 `read_all` 권한으로 조회.
- 로컬 허브는 공유 서버로 중계.
- AUTH-off 직접 조회는 서버 확인 잔액을 꾸미지 않고 unavailable.
- `MANAGE=0`은 기능 미지원.
- GET은 외부 호출·예약·DB 쓰기 없음.

```json
{
  "balance_protocol": 1,
  "as_of_ms": 1794874200000,
  "balances": [
    {
      "workspace_id": "workspace-id",
      "credits_c": 1757491,
      "credits": 17574.91,
      "observation_id": "UUID",
      "source": "workspace_list",
      "basis": "observed",
      "observed_at_ms": 1794873600450,
      "received_at_ms": 1794873610000,
      "time_basis": "agent",
      "time_quality": "reported",
      "precision_kind": "workspace_list_unknown",
      "precision_error_c": null,
      "age_ms": 599550,
      "stale": false,
      "reason_codes": []
    }
  ]
}
```

`basis`는 `observed | legacy_snapshot | unavailable | conflict`입니다. 보고자·collector ID·이메일·UID는 반환하지 않습니다.

### 장부 API

```http
GET /api/manage/console/balance-ledger
    ?workspace_id=<id>
    &start=2026-11-01
    &end=2026-11-18
    &limit=100
    &cursor=<optional>
```

- 날짜는 KST `[start,end)`.
- 기본 최근 7일, 한 요청 최대 31일.
- `limit` 기본 100, 최대 500.
- 관리자만. AUTH-off 직접 호출은 404로 닫습니다.
- 로컬 허브 중계는 허용하지만 **서버 PC 전용 키 관리 API의 권한·경로와 섞지 않습니다.**
- 관리자 역할·계정 유효성을 확인하고 다른 사람의 actor 자료는 반환하지 않습니다.
- 차트는 실제 관측점의 최솟값·최댓값을 이용해 최대 1,000점으로 줄입니다. 보간 잔액을 실제 관측처럼 만들지 않습니다.
- 긴 관측 공백으로 분석 범위가 31일을 넘으면 그 구간 잔차는 null·사유입니다.

응답 필드:

```text
balance_protocol, workspace_id, timezone
requested_start_ms, requested_end_ms
as_of_ms, content_read_at_ms, manage_read_at_ms
basis_signature
api_state, reason_codes
api_window_versions[]
plan_revision

chart_points[]
  observation_id, observed_at_ms, credits_c, quality

intervals[]
  from_observation_id, to_observation_id
  start_ms, end_ms
  opening_c, closing_c, delta_c
  api_created_net_c
  residual_c
  tolerance_c
  state
  candidate_classification
  candidate_evidence
  reason_codes

daily_api[]
  day, actual_start_ms, actual_end_ms
  net_c, charged_c, refunded_c
  complete, collected_at_ms, window_versions

returned_count, has_more, next_cursor
```


## A. 4절 계산 계약·기존 소비처·부분합

### 계산 계약

- 잔차는 `X = (B2 − B1) + U_created`로 계산합니다.
- 관측 구간 분석에서만 API 행의 `created_at`을 구간으로 자릅니다. 기존 개인·그룹 사용량의 하루 창 합산 계약은 변경하지 않습니다.
- 구간 전체가 유효한 API 성공본으로 덮이지 않으면 잔차는 `null`과 사유를 반환합니다. facts·견적으로 보완하지 않습니다.
- KST 하루 API 사용량과 실제 관측 구간의 잔차는 별도 항목입니다.
- 분류는 `allocation_candidate | topup_candidate | refund_candidate | unclassified`입니다.
- 상태는 `numeric_match | residual_present | api_pending | observation_uncertain | comparison_unavailable`입니다.
- 정산 완료·충전 확정·배분 확정 상태는 만들지 않습니다. 최근 2시간이 지났다는 사실도 확정 근거로 사용하지 않습니다.
- 손 입력 충전과 일치하면 **현재 입력 계획과 일치하는 후보**로 표시하고 계획 revision을 제공합니다.
- 허용치는 두 끝점의 정밀도 오차만 반영합니다. 관측 수·견적·시각 불명 금액을 더하지 않습니다.
- 페이지 사이 API 성공본이나 계획 revision이 바뀌면 `409 analysis_changed`를 반환합니다. 현재 입력으로 처음부터 다시 조회합니다.
- J6=A에 따라 과거 입력 버전을 영속 보존하지 않습니다. 재분석 결과는 달라질 수 있으며 입력 버전·조회 시각을 표시합니다.

### 기존 소비처별 변경

| 소비처 | 변경 |
|---|---|
| `record_account_status` | None 덮어쓰기 방지. 이름·플랜·멤버십 갱신은 유지하고 잔액은 공통 선택 결과 사용. 관측 메타데이터만 바뀐 보고는 라이브러리 변경으로 보지 않음 |
| `plan_view` | `pool.balance`를 공통 값으로 통일하고 `balance_meta` 추가. 새 관측의 `balance_seen_at`은 UTC 관측 시각, legacy는 null. 기존 daily 이력의 출처 명시 |
| `workspace_console` | main·subs·console limits에 같은 잔액 조회 적용. 부분합·미확인 수·오래된 보고 수·파생값의 완전성 추가 |
| member table | `main_balance`·`console_limit`에 잔액 메타데이터 추가. **사람별 `workspace_member.last_seen_at` 의미는 유지** |
| `/api/account/hf` | 현재 본인 멤버십으로 공간을 제한하고 팀 공간별 잔액을 공통 값으로 보강. 기존 최상위 개인 CLI 상태·키는 유지 |
| `/api/manage/workspaces` | 기존 권한·목록 키를 유지하고 공간별 `balance_meta` 추가 |
| `credit_summary` | 팀 풀은 공통 잔액으로 공간마다 한 번 합산. 개인 컨텍스트·계정별 raw 보고와 구별. 알려진 부분합·미확인 수·`total_complete` 추가 |
| `team-overview` | 기존 사용량 금액·출처는 변경하지 않고 회귀 확인 |

### 부분합

다음 메타데이터를 함께 제공합니다.

```text
known_subtotal_c
unknown_workspace_count
legacy_workspace_count
stale_workspace_count
complete
fresh
```

- `complete`: 필요한 공간의 잔액이 모두 알려졌는지 나타냅니다.
- `fresh`: 관측 시각·신선도 조건까지 충족하는지 나타냅니다.
- 기존 숫자 키는 타입 호환을 유지하지만 새 화면은 부분합임을 표시합니다.
- 미확인 값을 0으로 흡수해 전체 잔액처럼 표시하지 않습니다.
- 불완전한 입력에 의존하는 `allocation.spent`·할당액·비율은 확정값으로 그리지 않습니다. 계산 근거가 부족하면 “계산할 수 없음”으로 표시합니다.

## B. 5절 화면

### 백엔드 계약만 먼저 완성할 부분

- 공통 `BalanceView`, 부분합, 전달 상태, 장부 응답.
- 계정 메뉴·plan_view·콘솔·회원 표의 서버 잔액 통일.
- `/sync-status`에 다음 필드 추가:

```text
balance_pending
balance_failed
balance_conflict
balance_unsupported
balance_oldest_pending_at_ms
balance_last_success_at_ms
balance_last_error_code
```

미지원·실패·충돌을 성공이나 대기 0건으로 바꾸지 않습니다. 허브 저장 완료와 서버 전달 완료도 구별합니다.

### 최소 화면 수정

- AccountMenu의 공유 서버 Credits는 공통 확인 잔액을 사용합니다. **예상 잔액은 추가하지 않습니다.**
- `format.ts`에 `formatBalanceTime`을 추가합니다. 기존 `timestampMs`를 재사용하고 절대 시각은 `Asia/Seoul`로 고정합니다.
- 상대 시간과 절대 KST 시각을 함께 제공합니다.
- legacy는 “확인 시각 미상”으로 표시합니다. 수신 시각을 표시할 때는 “수신”이라고 명시합니다.
- 잔액 시각의 `.slice(5,16)` 표시를 제거합니다. 콘솔의 보고 시각 칩(`WorkspaceConsole.tsx:309` 의 `w.last_seen_at.slice(5,16)`)도 같은 헬퍼로 KST 로 바꿉니다(뜻은 '마지막 보고 수신'으로 그대로).
- 부분합·미확인 수를 표시하고, 불완전한 할당·사용 비율 그래프는 숨깁니다.
- `topupSteps`를 `balanceIncreaseSteps`로 바꾸고 문구를 “증가 관측”으로 수정합니다. 호출부·시험도 함께 변경합니다.
- 로컬 라이브 CLI는 별도 출처로 유지하며 서버 확인 시각을 붙이지 않습니다.
- 계정·서버·공간 변경 뒤 도착한 이전 응답은 버립니다.

### Claude 시안 뒤 구현할 부분

`BalanceLedger.tsx`를 서브스페이스 관리 화면에 배치합니다.

- 관리자 표시 판정은 기존 `caps.system`을 재사용하되 `caps.authOff`는 허용하지 않습니다.
- 서버에서도 관리자 권한을 강제합니다.
- 공간·기간 선택, 관측선, 하루 API 사용량, 구간 잔차, 후보 분류·근거를 표시합니다.
- 로딩·미관측·API 미확정·구서버·접속 실패·시각 이상을 구별합니다.
- 계정·서버·공간·기간·권한 변경 시 이전 응답을 폐기합니다.
- 색상 외 상태 문구, 키보드 조작, 표 형태의 수치를 제공합니다.
- 새 차트 의존성은 추가하지 않습니다.
- CSS 변경은 `composition-manage.css`에 둡니다.
- 시안이 API 계약이나 파일 범위를 바꾸면 해당 부분만 계획을 갱신합니다.


## 6. 구현 순서와 시험 명령 (구현 계획 원문을 한국어로 정리)

모두 새 격리 자료로 한다. dev 의 `backend/data_test`, 공유 서버, 실제 CLI·유료 생성은 쓰지 않는다. 작업실 루트·브랜치·기준 SHA 를 먼저 확인하고 시험용 Python 을 고정한다.

```powershell
$python = 'D:\ClaudeCode\MV-hub-S-dev\.venv\Scripts\python.exe'
$env:CONTENT_HUB_NO_PROXY = '1'
$env:CONTENT_HUB_EXTERNAL_RECOVERY = '0'
$env:PYTHONDONTWRITEBYTECODE = '1'
```

**1묶음** — ① 순수 계약·DDL·저장소 ② 에이전트 저장 → 전송 → ACK ③ 허브·서버 수신, 기존 상태 outbox 와 분리 ④ 재시도·계정/연결 고정·종료 처리 ⑤ 정제·복원·구판 호환. backend 폴더에서:

```powershell
& $python -B -m pytest -q -p no:cacheprovider --basetemp '<TEMP 아래 새 batch1 폴더>' tests/test_agent_balance_observations.py tests/test_hf_balance_repository.py tests/test_hf_balance_protocol.py tests/test_hf_balance_delivery.py tests/test_hf_balance_compatibility.py tests/test_hf_balance_routes.py tests/test_agent_account_snapshot.py tests/test_agent_contracts.py tests/test_agent_state_db_lifetime.py tests/test_account_report_delivery.py tests/test_account_report_consistency.py tests/test_credit_balance_refresh.py tests/test_identity_registry.py tests/test_schema_compat.py tests/test_proxy_ownership.py tests/test_upload_limits.py tests/test_mutation_notify.py tests/test_main_lifespan_cleanup.py tests/test_test_snapshot.py tests/test_workroom_data.py tests/test_server_move.py tests/test_worker_backup_v3_delivery.py tests/test_install_db_probe.py tests/test_artifact_qualifier.py tests/test_comfy_canvas_runs_migration.py
if ($LASTEXITCODE -ne 0) { throw 'batch1 실패' }
```

**2묶음** — ① 공통 잔액 조회·기존 소비처 통합 ② 부분합·신선도·기존 숫자 계약 ③ 최소 화면 변경과 구서버 대체 표시.

```powershell
# backend
& $python -B -m pytest -q -p no:cacheprovider --basetemp '<새 batch2 폴더>' tests/test_hf_balance_consumers.py tests/test_hf_balance_routes.py tests/test_credit_plan.py tests/test_workspace_console.py tests/test_manage_member_table.py tests/test_identity_permissions.py tests/test_hf_org_usage_quota.py
if ($LASTEXITCODE -ne 0) { throw 'batch2 backend 실패' }
# frontend
npm.cmd test -- --run tests/hfBalance.test.ts tests/balanceTime.test.ts tests/accountMenuCredits.test.tsx tests/creditPlan.test.ts tests/memberTable.test.tsx tests/workspaceConsole.test.ts tests/workspaceConsoleSync.test.tsx tests/syncStatus.test.ts
if ($LASTEXITCODE -ne 0) { throw 'batch2 frontend 실패' }
npm.cmd run lint:architecture
if ($LASTEXITCODE -ne 0) { throw '구조 검사 실패' }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw '빌드 실패' }
```

**3묶음** — ① API 성공본 읽기·구간 잔차·후보 분류 ② J6=A 재분석·버전 변경 감지 ③ Claude 시안 반영·관리자 화면·권한 시험(**시안을 Jay 가 본 뒤**).

```powershell
# backend
& $python -B -m pytest -q -p no:cacheprovider --basetemp '<새 batch3 폴더>' tests/test_hf_balance_ledger.py tests/test_hf_balance_routes.py tests/test_hf_balance_compatibility.py tests/test_hf_org_usage_comparison.py tests/test_hf_org_usage_quota.py
if ($LASTEXITCODE -ne 0) { throw 'batch3 backend 실패' }
# frontend
npm.cmd test -- --run tests/hfBalanceLedger.test.tsx tests/hfBalance.test.ts tests/workspaceConsoleSync.test.tsx
if ($LASTEXITCODE -ne 0) { throw 'batch3 frontend 실패' }
```

**전체 완료 때** — inventory 재생성 뒤 `--check`·CODE_MAP 확인, backend 전체 1회·frontend 전체 1회·구조 검사·빌드, graft build → check, 고정 후보를 설계·합의·구현에 참여하지 않은 Claude 세션이 독립 리뷰, 고치면 그 조건·영향 시험만 재확인. 시험 기록(run-test)은 통합 때 총괄이 dev 작업 트리에서 받는다.

```powershell
# 저장소 루트
& $python -B tools\gen_inventory.py
if ($LASTEXITCODE -ne 0) { throw '목록 생성 실패' }
& $python -B tools\gen_inventory.py --check
if ($LASTEXITCODE -ne 0) { throw '목록 불일치' }
& $python -B tools\check_code_map.py
if ($LASTEXITCODE -ne 0) { throw '코드 지도 불일치' }
```

총괄 보탬(계약 범위): 구현 계획의 touched_paths 에 화면 새 문구 번역용 `frontend/src/lib/i18n.ts` 와 DB 구성 요소 호환표 `release/compatibility.json`(바꿀 필요가 없으면 그대로)을 더했다.

## 7. 완료 조건과 시험 연결 (조건 원문은 아래 계약)


다음은 **구현할 시험 이름**입니다. 현재 존재하거나 통과했다고 보고하는 목록은 아닙니다. 아래 backend 파일 경로는 모두 `backend/tests/` 기준입니다.

- **AC1 — `amount_validation`**
  - `test_hf_balance_protocol.py::test_amount_validation_missing_null_zero_and_limits`
  - `test_hf_balance_repository.py::test_invalid_balance_preserves_last_valid_value`

- **AC2 — `observation_order`**
  - `test_hf_balance_repository.py::test_delayed_duplicate_and_conflicting_observations`

- **AC3 — `durable_delivery`**
  - `test_agent_balance_observations.py::test_persist_before_send_and_keep_until_matching_ack`
  - `test_hf_balance_delivery.py::test_two_hop_restart_and_lost_ack`
  - `test_hf_balance_delivery.py::test_backlog_does_not_starve_latest_or_oldest`
  - `test_hf_balance_delivery.py::test_retry_without_new_ingest_and_shutdown`

- **AC4 — `time_quality`**
  - `test_hf_balance_repository.py::test_future_reversed_tied_and_legacy_times`
  - `test_hf_balance_protocol.py::test_replay_does_not_refresh_observation_or_receipt`

- **AC5 — `membership_compatibility`**
  - `test_hf_balance_consumers.py::test_membership_refresh_is_independent_of_balance_order`
  - `test_hf_balance_routes.py::test_history_ingest_does_not_reapply_membership`
  - `test_identity_registry.py::test_balance_reporter_snapshot_survives_identity_remap`

- **AC6 — `api_coverage`**
  - `test_hf_balance_ledger.py::test_kst_boundaries_empty_missing_partial_duplicate_and_mismatch`
  - `test_hf_balance_ledger.py::test_phase2_usage_contract_is_unchanged`

- **AC7 — `candidate_classification`**
  - `test_hf_balance_ledger.py::test_late_refund_is_residual_not_topup`
  - `test_hf_balance_ledger.py::test_ambiguous_allocation_stays_candidate`
  - `test_hf_balance_ledger.py::test_manual_topup_match_is_not_execution_proof`

- **AC8 — `precision`**
  - `test_hf_balance_protocol.py::test_decimal_normalization_and_binary32_boundary`
  - `test_agent_balance_observations.py::test_no_account_status_probe_and_workspace_list_only`

- **AC9 — `consistent_display`**
  - `test_hf_balance_consumers.py::test_all_consumers_share_observation_id_amount_and_time`
  - `frontend/tests/balanceTime.test.ts` — `formats KST independently of browser timezone`
  - `frontend/tests/accountMenuCredits.test.tsx` — `discards balances from a previous account or workspace`

- **AC10 — `partial_totals`**
  - `test_hf_balance_consumers.py::test_unknown_subtotals_invalidate_dependent_totals`
  - `frontend/tests/workspaceConsoleSync.test.tsx` — `shows known subtotal and suppresses incomplete allocation gauge`

- **AC11 — `access_and_scrub`**
  - `test_hf_balance_routes.py::test_balance_and_ledger_permissions_and_private_fields`
  - `test_test_snapshot.py::test_balance_scrub_removes_rows_nested_payloads_and_deleted_pages`
  - `test_workroom_data.py::test_workroom_scrubs_balances_without_changing_source`
  - `test_worker_backup_v3_delivery.py::test_personal_backup_scrubs_balance_history`
  - `test_server_move.py::test_server_restore_preserves_balance_history_and_pauses_org_collection`

- **AC12 — `schema_compatibility`**
  - `test_schema_compat.py::test_balance_tables_do_not_change_existing_schema_contract`
  - `test_hf_balance_compatibility.py::test_pinned_legacy_inspector_and_app_reopen_preserve_balances`

- **AC13 — `mixed_versions`**
  - `test_hf_balance_compatibility.py::test_agent_hub_server_version_matrix`
  - `test_agent_balance_observations.py::test_old_success_response_is_not_observation_ack`
  - `frontend/tests/hfBalance.test.ts` — `marks an old server as unsupported without manufacturing a balance`

- **AC14 — `reanalysis_and_limits`**
  - `test_hf_balance_ledger.py::test_reanalysis_changes_with_api_and_plan_versions`
  - `test_hf_balance_ledger.py::test_cursor_rejects_changed_analysis`
  - `test_hf_balance_repository.py::test_latest_lookup_uses_index`
  - `test_hf_balance_ledger.py::test_bounded_rows_chart_and_response_size`

- **합의 1차로 더한 조건·시험**
  - `ingest_guard`: `test_hf_balance_routes.py::test_observation_ingest_rejects_unauthenticated_mismatch_and_bad_agent_key` · `test_hf_balance_protocol.py::test_observation_count_limit` · `test_upload_limits.py::test_balance_observations_body_limit_before_json_parse`(Content-Length 없음·허위 값·나눠 받기)
  - `delivery_target`: `test_hf_balance_delivery.py::test_no_remote_delivery_in_server_readonly_isolated_or_test_dev` · `test_hf_balance_delivery.py::test_delivery_pins_account_target_and_lease_without_downgrade`
  - `membership_compatibility` 보강: `test_mutation_notify.py::test_balance_metadata_only_report_does_not_signal_library_change`
  - `precision` 보강(합의 2차): `test_hf_balance_protocol.py::test_binary32_error_bound_by_magnitude`(131071.99·131072.01·205722.76/205722.77·262144.03·비 binary32 값) · `test_hf_balance_protocol.py::test_null_error_endpoint_marks_interval_uncertain`
  - 계정 정리(합의 2차): `test_account_cleanup.py::test_balance_observation_only_account_is_not_deleted` · `test_account_cleanup.py::test_balance_observation_with_null_uid_blocks_by_email` · 전 칸 분류 목록 통과
  - `consistent_display` 보강: `frontend/tests/workspaceConsoleSync.test.tsx` — `reported-at chip uses KST`

## D. 8절 위험·되돌리기·릴리스 영향

### 주요 위험

| 위험 | 처리 |
|---|---|
| CLI 결과 뒤 저장 실패 | 관측 공백·보고 실패를 드러내고 생성 기능은 막지 않음 |
| PC 시계 차이 | ID·sequence·시각 품질로 구별하되 PC 간 실제 관측 순서를 보장하지 않음 |
| 장기 보존량 증가 | 자동 삭제 없이 크기·색인·조회 비용 측정 |
| 구허브의 raw JSON에 관측 필드 잔류 | 새 표와 함께 `hf_status`·상태 outbox의 `balance_report`도 정제 |
| 정제 실패 | 사본 공개 중단. 원본은 변경하지 않음 |
| 백업 이후 관측 손실 | 백업 복구 시점의 한계로 보고. 복원 자료를 새 확인으로 표시하지 않음 |
| ACK 뒤 과거 백업으로 복원 | 에이전트의 ACK된 원문도 보존하되 자동 복구 완료를 주장하지 않음 |
| API·계획 변경으로 과거 분석 변경 | J6=A에 따라 재분석하고 입력 버전·조회 시각 표시 |
| 종료 중 전달 작업 | 재시도 생산자를 먼저 멈춘 뒤 실행 중 drain 회수 |

### 되돌리기

- 새 표 삭제·기존 표 재작성·대기열 비우기를 되돌리기 절차로 사용하지 않습니다.
- 구판이 추가 표를 무시하고 관측을 보존하는지 실제 구판으로 시험합니다.
- 구판으로 돌아가면 신선도·정밀도·부분합·장부 표시 보장은 중단됩니다.
- 재업그레이드 후에는 관측표를 기준으로 조회합니다. 구판이 덮은 registry 값을 새 정밀 관측으로 채택하지 않습니다.
- 미전달·ACK된 원문과 전달 기록을 보존합니다.
- 대상 DB의 복구용 사본과 실제 되돌릴 코드 버전을 먼저 고정합니다. 실사용 DB에 임의 복원·삭제를 실행하지 않습니다.

### 앱 릴리스·서버 업데이트 순서

**에이전트 변경은 앱 릴리스가 필요합니다.** 소스나 서버만 바꿔 이미 실행 중인 에이전트가 갱신됐다고 보지 않습니다.

1. 격리 시험·독립 리뷰를 완료한 서버 후보 준비.
2. Jay의 별도 배포 지시에 따라 서버 적용.
3. 신판 앱·로컬 허브 배포.
4. 신판 에이전트 실행으로 수집별 보존 시작.
5. 혼합 판 기간에 지원 상태·미전달 수·마지막 확인 시각 관찰.

### 혼합 판 기간

- 신서버는 구에이전트 보고를 legacy로 계속 수용합니다.
- 신에이전트가 구허브를 만나면 저장 ACK가 없는 관측을 에이전트에 보존합니다.
- 신허브가 구서버를 만나면 서버 미지원 상태로 관측을 보존·대기합니다.
- 구형 `200`·`accepted=true`만으로 관측 전달 완료를 판정하지 않습니다.
- 구앱은 기존 숫자를 읽을 수 있지만 새 신선도·부분합 의미까지 올바르게 표시한다고 보장하지 않습니다.
- 이번 계획은 병합·배포 실행 승인이 아닙니다.

임시 작업실의 guard 차단은 자동 적용으로 간주하지 않습니다. 총괄이 실제 계약 root·세션 bind·적용 범위를 확인하며, 기능 구현 범위에 guard 설정 변경은 포함하지 않습니다.

## E. 9절 확인하지 못한 것

- Claude 화면 시안과 실제 관리 화면 배치.
- 운영 서버 검사기·호환성 시험에 사용할 구앱의 정확한 SHA.
- CLI 내부 숫자 형식(binary32 가정의 근거는 11-17 실측 표본뿐).
- 운영 PC 시계 편차와 실제 수집·전달 지연.
- 수백만 관측의 DB 크기·동시성·조회 성능.
- 혼합 판 8조합·구판 재열기·백업 복원·사본 정제의 실행 결과.
- 임시 작업실의 실제 쓰기 권한·guard 적용·시험 환경.

미실행: 파일·Git·guard 쓰기, CLI·네트워크 호출, 시험·작업실 생성.  
남은 위험: 환불 시각 없는 API를 사용하므로 잔차와 후보 분류를 확정 현금흐름으로 취급하지 않습니다.

<!-- hf-balance-design:end -->

## 계약

```vibe-intent
{
  "schema": 1,
  "id": "hf-balance-ledger-20261117",
  "root": "D:/ClaudeCode/MV-hub-S-dev",
  "owner": {"host": "codex", "session": "01a1e878-0bec-7e51-bede-59f8f7b43295"},
  "risk": {"level": "major", "reason": "콘텐츠 DB 새 표 2개와 에이전트 로컬 표, 에이전트→허브→서버 관측 전달 프로토콜·ACK·백그라운드 재시도, 공유 잔액 숫자 계약(계정 메뉴·대시보드·콘솔·회원 표·credit_summary), 사본 정제·복원 경로를 바꾸고 에이전트 변경은 앱 릴리스가 필요하다."},
  "goal": "힉스필드 공간 잔액(Credits left)을 CLI 관측으로 빠짐없이 기록하고(수집별 ID·관측 시각·정밀도, 에이전트·허브에 보존해 저장 ACK 로 서버까지 전달 — Jay J5=B), 모든 화면이 같은 '마지막 정상 관측 잔액 + KST 확인 시각'을 쓰게 하며(예상 잔액 없음 J1), 미확인 공간은 부분합·미확인 수로 드러내고, 관리자 장부에서 두 관측 사이 잔액 변화와 API 사용의 잔차·후보 분류(충전·배분·환불 '후보', 확정 아님)를 보인다(J3·J4·J6=A). 세부 규칙은 이 기록의 설계 확정안 D1~D8 과 구현 계획 1~6절이 정본이다. 제외: 생성 차단, 힉스필드 웹 화면 긁기·비공개 주소, Content 권한, 2단계 개인·그룹 사용량 계산 변경, 카드 금액, 충전 청구서 자동 수집·CSV 올리기, 보고 주기 변경·서버 직접 CLI 수집(J2), 예상 잔액(J1), 과거 분석 결과 고정 보존(J6=B), 자동 삭제, 공유 서버 업데이트·앱 릴리스(Jay 지시 때), 장부 화면은 Claude 시안을 Jay 가 확인하기 전 구현하지 않음.",
  "touched_paths": [
    "agent_push.py",
    "backend/app/db.py",
    "backend/app/db_hf_balance.py",
    "backend/app/hf_balance_contract.py",
    "backend/app/models.py",
    "backend/app/main.py",
    "backend/app/mutation_notify.py",
    "backend/app/repo/__init__.py",
    "backend/app/repo/identity.py",
    "backend/app/repo/manage_account_reports.py",
    "backend/app/repo/hf_balance.py",
    "backend/app/repo/hf_balance_ledger.py",
    "backend/app/repo/manage_credit_plan.py",
    "backend/app/repo/workspace_console.py",
    "backend/app/repo/manage_member_table.py",
    "backend/app/services/hf_balance_delivery.py",
    "backend/app/services/db_scrub.py",
    "backend/app/services/upload_limits.py",
    "backend/app/repo/account_cleanup.py",
    "backend/app/usecases/hf_balance.py",
    "backend/app/routers/hf_balance.py",
    "backend/app/routers/ingest.py",
    "backend/app/routers/_telemetry.py",
    "backend/app/routers/sync.py",
    "backend/app/routers/db_transfer.py",
    "backend/app/routers/manage.py",
    "tools/workroom_data.py",
    "tools/gen_inventory.py",
    "release/compatibility.json",
    "backend/tests/hf_balance_fixtures.py",
    "backend/tests/test_agent_balance_observations.py",
    "backend/tests/test_hf_balance_repository.py",
    "backend/tests/test_hf_balance_protocol.py",
    "backend/tests/test_hf_balance_delivery.py",
    "backend/tests/test_hf_balance_compatibility.py",
    "backend/tests/test_hf_balance_routes.py",
    "backend/tests/test_hf_balance_consumers.py",
    "backend/tests/test_hf_balance_ledger.py",
    "backend/tests/test_agent_account_snapshot.py",
    "backend/tests/test_agent_contracts.py",
    "backend/tests/test_account_report_delivery.py",
    "backend/tests/test_account_report_consistency.py",
    "backend/tests/test_credit_balance_refresh.py",
    "backend/tests/test_identity_registry.py",
    "backend/tests/test_identity_permissions.py",
    "backend/tests/test_schema_compat.py",
    "backend/tests/test_proxy_ownership.py",
    "backend/tests/test_upload_limits.py",
    "backend/tests/test_mutation_notify.py",
    "backend/tests/test_main_lifespan_cleanup.py",
    "backend/tests/test_test_snapshot.py",
    "backend/tests/test_workroom_data.py",
    "backend/tests/test_server_move.py",
    "backend/tests/test_worker_backup_v3_delivery.py",
    "backend/tests/test_credit_plan.py",
    "backend/tests/test_workspace_console.py",
    "backend/tests/test_manage_member_table.py",
    "backend/tests/test_account_cleanup.py",
    "frontend/src/shared/contracts/hfBalance.ts",
    "frontend/src/lib/hfBalance.ts",
    "frontend/src/lib/format.ts",
    "frontend/src/lib/useSyncStatus.ts",
    "frontend/src/lib/creditPlan.ts",
    "frontend/src/lib/memberTable.ts",
    "frontend/src/lib/workspaceConsole.ts",
    "frontend/src/lib/i18n.ts",
    "frontend/src/types.ts",
    "frontend/src/api.ts",
    "frontend/src/components/AccountMenu.tsx",
    "frontend/src/components/manage/CreditPoolSection.tsx",
    "frontend/src/components/manage/MemberTable.tsx",
    "frontend/src/components/manage/console/WorkspaceConsole.tsx",
    "frontend/src/components/manage/console/ConsoleMainParts.tsx",
    "frontend/src/components/manage/console/ConsoleSubView.tsx",
    "frontend/src/components/manage/console/CreditCalendar.tsx",
    "frontend/src/components/manage/console/BalanceLedger.tsx",
    "frontend/src/styles/composition-manage.css",
    "frontend/tests/hfBalance.test.ts",
    "frontend/tests/balanceTime.test.ts",
    "frontend/tests/accountMenuCredits.test.tsx",
    "frontend/tests/creditPlan.test.ts",
    "frontend/tests/memberTable.test.tsx",
    "frontend/tests/workspaceConsole.test.ts",
    "frontend/tests/workspaceConsoleSync.test.tsx",
    "frontend/tests/syncStatus.test.ts",
    "frontend/tests/hfBalanceLedger.test.tsx",
    "docs/CODE_MAP.md",
    "docs/README.md",
    "docs/CURRENT_STATUS.md",
    "docs/SERVER_RECOVERY.md",
    "docs/inventory/db_tables.md",
    "docs/inventory/endpoints.md",
    "docs/inventory/background_jobs.md",
    "docs/inventory/env_vars.md"
  ],
  "criteria": [
    {"id": "amount_validation", "success": "유효 금액은 정수 cents로 저장하고 0을 보존한다. 누락·null·무효 금액은 마지막 정상 잔액을 지우지 않는다.", "failure": "무효 금액을 0으로 바꾸거나 기존 잔액을 NULL로 지우거나 bool·NaN·Infinity·범위 밖 금액을 저장한다.", "required": true, "verification": []},
    {"id": "observation_order", "success": "늦게 도착한 옛 관측은 이력에만 남는다. 같은 ID·내용의 재시도는 한 행이며 내용 충돌은 원행을 보존한다.", "failure": "지연·중복·충돌 보고가 최신 정상값을 덮거나 이력을 중복 생성한다.", "required": true, "verification": []},
    {"id": "durable_delivery", "success": "저장 후 중단·통신 장애·ACK 유실·재시작 뒤에도 모든 미전달 관측이 원 ID·값·시각으로 전달되고 최신 관측과 오래된 대기가 모두 진행한다.", "failure": "최신 한 행만 남거나 저장 ACK 없이 성공 처리하거나 대기 관측이 영구 정체된다.", "required": true, "verification": []},
    {"id": "time_quality", "success": "미래·역행·동시각 충돌·legacy 보고를 구별한다. 재시도로 관측·최초 수신 시각을 바꾸지 않으며 시각 이상이 정상 최신값을 대체하지 않는다.", "failure": "옛 보고를 재수신 때마다 새 관측으로 만들거나 시각 이상을 정상 확인으로 표시한다.", "required": true, "verification": []},
    {"id": "membership_compatibility", "success": "현재 상태 보고의 이름·플랜·멤버십·자동 편입·사람별 최근 확인 의미를 유지한다. 역사 관측 전달은 현재 멤버십을 변경하지 않는다. 관측 정보만 바뀐 상태 보고는 라이브러리 변경 신호를 내지 않는다. 계정 정리는 hf_balance_obs.reporter_uid 를 UID 이력, reporter_key(정규화 이메일)·hf_balance_outbox.account_key 를 EMAIL 이력으로 세어, 관측만 있고 전달 큐가 없는 계정과 UID 가 NULL 인 관측만 있는 계정의 삭제를 거부한다.", "failure": "잔액 순서 검사로 정상 상태 갱신을 막거나 역사 재전송으로 접근 상태·선택 공간·프로젝트 편입을 되돌리거나, 관측 시각만 바뀐 보고마다 목록 전체 갱신 신호가 나거나, 계정 정리 전 칸 분류 시험이 새 칸 때문에 실패하거나 관측 이력 있는 계정을 '이력 없음'으로 지운다.", "required": true, "verification": []},
    {"id": "ingest_guard", "success": "관측 수신점(허브·서버)은 인증 없음·로그인 계정과 account_email 불일치·로컬 에이전트 키 불일치 요청을 거부하고 아무것도 저장하지 않으며 payload 의 보고자·UID 를 믿지 않는다. 최대 100관측·262144바이트를 허용하고, 관측 수 초과는 저장·ACK 없이 거부하며, 바이트 초과는 JSON 파싱 전에 413 으로 거부한다(Content-Length 없음·허위 값·나눠 받기 포함).", "failure": "인증되지 않았거나 다른 계정의 관측을 저장해 확인 잔액으로 쓰거나, 상한을 넘긴 자료를 저장·ACK 하거나, 본문 전체를 파싱한 뒤 크기를 검사한다.", "required": true, "verification": []},
    {"id": "delivery_target", "success": "서버 본체·READ_ONLY·외부 작업 차단·격리·test_dev(NO_PROXY) 모드에서는 원격 관측 전달을 시작하지 않는다. 전송은 큐에 고정한 계정·대상 서버·lease 와 현재 연결이 같을 때만 하며 다른 서버로 바꾸거나 저장된 HTTP 주소로 내려 보내지 않고, 이전 대상의 ACK 로 현재 큐를 정산하지 않는다.", "failure": "격리·test_dev 허브가 실사용 서버로 보내거나, 다른 계정 토큰·다른 서버·낮은 보안 주소로 관측을 보내거나, 이전 대상 ACK 로 큐를 정산한다.", "required": true, "verification": []},
    {"id": "api_coverage", "success": "KST 경계·성공한 빈 창·미수집·불완전·중복·mismatch·exact/day를 구별한다. 구간 전체가 확인되지 않으면 잔차를 null과 사유로 제공한다.", "failure": "부분 수집을 0이나 완전한 하루로 표시하거나 exact/day를 이중 합산하거나 기존 개인·그룹 사용량 계약을 바꾼다.", "required": true, "verification": []},
    {"id": "candidate_classification", "success": "늦은 환불·충전과 사용 동시 발생·복수 배분 후보·손 입력 변경에서 X를 잔차로 유지하고 분류는 근거 있는 후보로만 제공한다.", "failure": "금액·시각 유사성이나 2시간 경과만으로 충전·배분·환불·정산 완료를 확정한다.", "required": true, "verification": []},
    {"id": "precision", "success": "관측은 workspace-list 값만 쓰고 Decimal(str(v)) 을 1/100 반올림한 cents 로 저장한다. |값|<131072 이면 workspace_list_binary32·오차 0, 그 이상이고 binary32 로 정확히 표현되는 수면 workspace_list_binary32·오차 floor(0.5+50·ulp) cents, binary32 가 아닌 수면 workspace_list_unknown·오차 NULL 이다. 끝점 하나라도 오차 NULL 이면 장부 허용치 NULL·상태 observation_uncertain 이다. account status 숫자는 어느 공간의 관측으로도 저장하지 않으며 수집이 CLI 전역 선택 공간을 바꾸지 않는다.", "failure": "167772 경계를 쓰거나 모든 큰 값에 고정 ±0.01 을 적용하거나, 크기별 binary32 오차 상한을 틀리게 계산하거나, account status 숫자를 공간 관측(정확한 값)으로 저장하거나, 오차 NULL 끝점으로 수치 일치를 판정하거나, CLI 전역 공간을 변경한다.", "required": true, "verification": []},
    {"id": "consistent_display", "success": "같은 서버 관측 ID의 모든 대상 화면 잔액·시각이 일치하고 UTC 브라우저에서도 KST로 표시한다(콘솔 보고 시각 칩 포함). 문맥 변경 뒤 이전 응답은 버린다.", "failure": "UTC 문자열을 잘라 표시하거나 서로 다른 출처 값을 같은 확인 잔액처럼 표시하거나 이전 계정·공간 응답을 적용한다.", "required": true, "verification": []},
    {"id": "partial_totals", "success": "미확인 공간이 있는 합계는 알려진 부분합·미확인 수·완전성을 제공하고 불완전한 파생값은 확정 표시하지 않는다.", "failure": "None을 0으로 흡수해 전체 잔액·사용·할당·비율을 확정 표시한다.", "required": true, "verification": []},
    {"id": "access_and_scrub", "success": "잔액 조회는 멤버십·기존 read_all 범위를 지키고 장부는 실제 관리자만 조회한다. 보고자 정보는 응답에서 제외하며 모든 지정 사본에서 새 표·중첩 관측 필드를 정제한다.", "failure": "권한 우회로 자료가 노출되거나 사본에 관측·전달 정보가 남거나 정제 과정에서 원본을 변경한다.", "required": true, "verification": []},
    {"id": "schema_compatibility", "success": "새 표 생성은 멱등이며 기존 표 구조·migration·checksum·protocol은 불변이다. 고정 구검사기·구판 재열기가 통과하고 관측을 보존한다.", "failure": "unknown_migration·checksum 오류·기존 구조 변경·관측 손실 또는 구판 재열기 뒤 거짓 최신성 표시가 발생한다.", "required": true, "verification": []},
    {"id": "mixed_versions", "success": "에이전트·허브·서버 신구 8조합과 신구 앱에서 기존 기능을 유지하고 미지원 상태를 명시한다. 구형 성공 응답만으로 관측 ACK를 처리하지 않는다.", "failure": "미지원·연결 실패를 저장 성공·확정 0·새 확인 시각으로 바꾸거나 미전달 관측을 폐기한다.", "required": true, "verification": []},
    {"id": "reanalysis_and_limits", "success": "현재 API 성공본·계획 revision으로 재분석하고 입력 버전을 표시한다. 페이지 중 입력 변경을 감지하며 색인·기간·행 수·응답 크기 제한을 지킨다.", "failure": "과거 결과 불변을 거짓 보장하거나 서로 다른 입력 버전을 섞거나 전체 이력을 무제한 전송한다.", "required": true, "verification": []},
    {"id": "regression_build", "success": "backend 전체·frontend 전체 시험, 구조 검사, 빌드, gen_inventory --check, check_code_map 이 통과한다.", "failure": "하나라도 실패하거나 목록·코드 지도가 낡는다.", "required": true, "verification": []}
  ],
  "references": [{"path": "docs/status/hf_balance_ledger_2026-11-17.md", "begin": "<!-- hf-balance-design:begin -->", "end": "<!-- hf-balance-design:end -->", "sha256": "942ffb57716be2622b7bf6abcaeded0ed8b9c26ec15172fe34bfc6e13831b189"}],
  "decisions": [
    {"choice": "잔액은 CLI 관측을 기준점, 조직 API 사용은 그 사이 출금으로 보고 두 관측 사이 차이를 '잔차'로만 표시한다", "why": "공식 API 는 잔액·충전·배분·환불 시각을 주지 않아 사용만으로 잔액을 계산하면 충전·갱신·늦은 환불 때 틀어진다(공식 문서 6쪽, Codex C1)", "alternative": "API 사용 누적으로 잔액 직접 계산 — 입금 쪽을 몰라 틀어짐", "revisit": "힉스필드가 잔액·거래 원장 API 를 공개할 때"},
    {"choice": "수집별 관측을 에이전트·허브에 보존하고 저장 ACK 로 서버까지 전달한다(J5=B)", "why": "Jay 가 서버 장애 중 관측까지 빠짐없이 남기는 B 를 골랐다(2026-11-17)", "alternative": "A+ 도착한 관측만 기록·최신 1행 outbox 유지 — 장애 중 중간 관측 손실", "revisit": "관측 보존량·전달 부하가 문제될 때"},
    {"choice": "관측 표는 콘텐츠 DB(workspace_registry 옆)에 추가 표로, migration 이름표·기존 표 변경 없이", "why": "관측 저장과 registry 호환값 갱신을 한 트랜잭션으로 하고, 서버 업데이트 검사기가 모르는 migration 은 거부하지만 추가 표는 허용한다(schema_compat.py:212, Codex C9)", "alternative": "관리 DB(API 행 옆) — 장부 조회는 쉽지만 registry 와 원자성 없음", "revisit": "두 DB 가 합쳐지거나 검사기 갱신 길이 생길 때"},
    {"choice": "화면은 확인 잔액·KST 시각만, 예상 잔액은 넣지 않는다(J1)", "why": "확인 잔액에 이미 반영된 MV 생성을 또 뺄 위험이 있다(Codex C2), Jay 결정", "alternative": "≈ 예상 잔액 보조값", "revisit": "관측 뒤 차감 시점 계약을 확인할 근거가 생길 때"},
    {"choice": "과거 장부는 불변 관측 + 현재 API 성공본으로 다시 분석하고 입력 버전을 표시한다(J6=A)", "why": "API 성공본은 환불로 교체되고 손 입력 계획도 바뀐다. 과거 결과 고정은 입력 이력 보존 설계가 따로 필요하다(Codex C8)", "alternative": "당시 입력·판정까지 보존(J6=B)", "revisit": "감사용 고정 장부가 필요해질 때"},
    {"choice": "관측은 workspace-list 만 쓰고, 정밀도 오차는 binary32 간격으로 정한다 — |값|<131072 은 0, 그 이상 binary32 수는 floor(0.5+50·ulp) cents, binary32 가 아닌 수는 NULL(미확인). account status 공간 지정 보완은 하지 않는다", "why": "workspace list 실측값이 binary32 표현과 일치하지만 CLI 내부 형식은 미확인이다. account status 응답에는 공간 식별 값이 없어(11-17 실측: credits·email·subscription_plan_type) 금액 일치만으로는 binary32 가 같은 다른 공간을 걸러내지 못한다(합의 2차 Codex 반례 205,722.76/205,722.77)", "alternative": "공간 지정 account status 로 2자리 보완 — 대상 공간을 독립 확인할 수 없어 잘못된 공간 값을 정확한 값으로 저장할 수 있음", "revisit": "CLI 가 정확한 십진 잔액이나 공간 식별 값을 줄 때"},
    {"choice": "계정 정리에서 hf_balance_obs.reporter_uid 는 UID 이력(_REMAP_EXEMPT 유지), reporter_key(정규화 이메일)·hf_balance_outbox.account_key 는 EMAIL_HISTORY 로 등록한다", "why": "계정 정리 전 칸 분류 시험이 분류 안 된 칸을 실패시키고(합의 1차 Claude dd3bf711), 실제 삭제 차단은 uid_history_columns()·EMAIL_HISTORY 만 읽어 KEPT 분류로는 관측 이력이 삭제를 막지 못한다(account_cleanup.py:107, 합의 2차 Codex)", "alternative": "보존 스냅샷(KEPT)만 — 관측만 있는 계정이 '이력 없음'으로 지워질 수 있음", "revisit": "계정 정리 분류 체계가 바뀔 때"},
    {"choice": "장부 화면(BalanceLedger)은 Claude 시안을 Jay 가 확인한 뒤 구현한다", "why": "새 화면은 모의 이미지 먼저(Jay 규칙)", "alternative": "백엔드 계약대로 바로 화면 구현", "revisit": "Jay 가 시안 없이 진행하라고 할 때"}
  ],
  "evidence": {
    "target": {"kind": "worktree"},
    "consensus": [
      {"host": "codex", "session": "01a1e878-0bec-7e51-bede-59f8f7b43295", "transcript": "C:/Users/FX-PC06/.codex/sessions/2026/11/17/rollout-2026-11-17T16-45-44-01a1e878-0bec-7e51-bede-59f8f7b43295.jsonl"},
      {"host": "claude", "session": "dd3bf711-97fa-494f-9c12-8233f0effa61", "transcript": "C:/Users/FX-PC06/.claude/projects/D--ClaudeCode/dd3bf711-97fa-494f-9c12-8233f0effa61.jsonl"}
    ],
    "design_sessions": [{"host": "claude", "session": "45eaa469-b035-4eed-bb7c-cdd50c1888d7"}]
  }
}
```
