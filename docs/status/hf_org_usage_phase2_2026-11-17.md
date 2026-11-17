---
aliases:
  - 힉스필드 조직 사용량 2단계 2026-11-17
tags:
  - mvhub
  - mvhub/크레딧
status: active
updated: 2026-11-17
---

# 힉스필드 조직 사용량 2단계 — 개인·그룹 숫자를 API 기준으로 (2026-11-17)

owner: Claude(총괄) · 구현: Codex · reviewer: 구현·설계에 참여하지 않은 Claude 세션 · status: 검토 요청

> Jay 결정(2026-11-17, 재질문 금지 — 시안 https://claude.ai/artifact/NmJhau2k2c6SreQ3RHUHjM): ① 계정 메뉴 사용·남은 몫 = 힉스필드 조직 API 기준 ② '내 사용량' 창 = 요약 타일 4 + 만든 곳 막대 + 건별 목록 ③ 그룹 합계·관리 표·회원 대시보드도 같은 기준으로 함께. 1단계 정본은 [1단계 기록](hf_org_usage_2026-11-10.md).

## 설계 경과

- v0.1 — Claude 설계 역할(하위 에이전트, 읽기만).
- Codex 설계 확정 `01a1e71f-0043-7a30-8550-95578e35c03b`(gpt-6.1-sol·high·read-only): `DESIGN-CHANGES` — 방향 유지, 아래 C1~C10 을 고친 v0.2. A1(charge 포함)·A2(기본 이 공간) 채택, A3(순값 0 = 실패) 수정, A4 의존 제거.
- Claude(총괄) 확인: C1~C10 모두 받아들임. 바꾼 것 하나 — 시험 임시 폴더(basetemp)는 `%TEMP%` 아래 새 폴더(저장소·작업실 안이면 다른 시험이 깨지고 Codex 샌드박스가 만든 폴더는 지울 수 없음).

- C1 높음 — 공용 색인에는 기간 끝 경계·실제/견적 분리가 없어 그대로 옮기면 my_quota 값이 바뀐다 → `[start,end)`·`used_real/used_estimated/estimated_count/unknown_count`, 옛 SQL 과 차등 시험 뒤 제거.
- C2 높음 — `api_from` 하나로는 범위별 기준을 못 정한다 → 공간·사람·시작·끝·창 버전마다 판정.
- C3 높음 — 꼬리 2일 허용이 미수집을 API 0 으로 바꿀 수 있다 → 성공본 0개면 API 아님, 마지막 짧은 꼬리만.
- C4 높음 — 저장 행 전체 NOT EXISTS 는 exact 창 행 때문에 견적을 잘못 없앤다 → 유효 day 성공본 기준.
- C5 높음 — 60분 이전·닫힌 기간 경계에서 조용한 누락 → 60분은 견적 표시 유효시간, 넘으면 미확인 건수.
- C6 높음 — 사람별 facts 대체와 그룹·풀 합계 충돌 → 합계는 `mixed` 허용, 풀에 미연결자 facts 안 더함.
- C7 높음 — 순값 0 = 실패 판정은 무료·취소·전액 환불을 오인 → 오류 보고·전액 환불 건수 분리.
- C8 높음 — 권한은 기존 capability 유지, my-usage 는 관리자도 본인 행만, 소유권 시험 목록에 새 경로.
- C9 중간 — 관리 표 기간·회원 대시보드 범위·만든 곳 분류 설명 정정.
- C10 중간 — 성능·혼합 버전·호환성 완료 조건 보강.

## 설계 확정안 v0.2(Codex 원문, 위 확인 반영)

**방향 변경: `api_from` 단일 판정을 소비 범위별 판정으로 바꾸고, 꼬리 허용·미매칭 견적·혼합 출처 계약을 명시한다.**

- 날짜: 2026-11-17
- 역할: Codex 2단계 설계 검토·확정안 작성, 읽기 전용
- 규모: 큰 일 — 여러 화면의 공유 숫자 계약·개인정보 조회·기간 집계 변경
- 상태: v0.2 변경분에 대한 Claude 확인 후 구현 가능. 구현·독립 리뷰·실측 완료를 뜻하지 않는다.
- 근거: 현재 dev 소스, 지정 1단계 기록, 몫 설계, 선택 시안 HTML. 운영 서버 상태와 실제 API 지연은 미확인.

### 1. 목표

공유 서버가 수집한 힉스필드 조직 사용량을 다음 화면의 사용액 기준으로 사용한다.

1. 계정 메뉴의 사용·남은 몫
2. ‘내 사용량’ 창: 요약 타일 4개·만든 곳 막대·건별 목록
3. 그룹 합계·관리 표의 크레딧 값·회원 대시보드의 내 몫 및 그룹 카드

사용액은 환불을 뺀 API 순값이다. 집계 전 MV 기록은 제한된 시간 동안만 `≈` 견적으로 보완한다. 미수집·식별 실패·연결 실패를 확정 사용액 0으로 표시하지 않는다.

다음 결정은 유지한다.

- 개인 몫은 표시만 하며 생성을 차단하지 않는다.
- 그룹 한도는 인당이며 개인·그룹 이월은 없다.
- 그룹 이동은 사용을 초기화하지 않는다. 현재 소속과 현재 그룹 기간으로 다시 합산한다.
- API 금액을 서버 팩트나 로컬 `real_credits`에 쓰지 않는다.
- API 행은 소비처가 선택한 KST 창으로 합하며 `created_at`으로 다시 자르지 않는다.

### 2. 지금 구조

#### 2.1 조회·권한

- 로컬 허브는 팀 관리 조회를 공유 서버로 중계한다. 일반 서버 위임은 `_proxy` 미들웨어, `my-quota`에는 직접 중계 분기도 있다.
- 공유 서버 연결 실패는 오류로 전달되고, 계정 메뉴는 조회 실패를 확인 불가로 표시한다.
- AUTH-off 직접 조회의 기존 `my-quota` 응답에는 숫자 0이 있으나 `source=unavailable`이다. 따라서 초안의 “0을 반환하는 길이 없다”는 표현은 부정확하다. **화면이 이를 확정 0으로 취급하지 않는 계약**을 유지한다.
- 전체 조회는 endpoint별 기존 capability를 따른다. 관리자라는 단일 역할로 통합하지 않는다.

#### 2.2 팩트 집계

- `my_quota`는 자체 SQL로 `[start,end)`의 실제액·견적액·견적 건수·미상 건수를 계산한다.
- 다른 몫 화면은 `workspace_email_usage`와 `_usage_index/_sum_usage`를 주로 사용한다.
- 현 색인은 날짜×이메일이고 그룹 ID를 사용량의 소유자로 저장하지 않는다.
- 그룹 요약은 **현재 멤버 이메일 집합**으로 과거 사용을 합한다. 이것이 그룹 이동 후 이어 세는 구현 근거다.
- 기존 `test_member_move_counts_current_members_only`는 이동한 사람의 사용이 이전 그룹에서 빠져 현재 그룹에 붙는 것을 확인한다.
- 현재 색인에는 명시적인 끝 경계가 없으므로 그대로 `my_quota` 대체에 사용하지 않는다.

#### 2.3 조직 API

- API 창·행·신원 연결·대조 상태는 관리 DB에 있다.
- day와 exact 창은 함께 저장되며 합산할 때 출처를 선택한다.
- 성공한 빈 창은 유효한 0이다. 성공본 없는 창과는 다르다.
- API 행과 팩트는 관리 DB 한 읽기 스냅샷에서 읽을 수 있다.
- 계정·그룹 배정은 콘텐츠 DB에 있다. 두 DB 전체가 원자적인 한 스냅샷이라고 주장하지 않는다.
- 텔레메트리에 origin·mv_requested가 없어 MV 생성과 사후 동기화의 정확한 구별은 아직 불가능하다.

### 3. 핵심 결정

#### D1. 기존 서버 조회 경로 유지

화면 → 로컬 허브 → 공유 서버 → 저장된 성공본 및 팩트 조회 → 응답 경로를 유지한다.

- 조회 GET은 외부 API 호출·수집 예약·신원 연결 쓰기를 하지 않는다.
- 영속 캐시·로컬 사본 표를 추가하지 않는다.
- 한 요청 안에서는 읽은 자료와 계산 결과를 재사용해 중복 조회를 줄인다.
- 관리 DB는 명시적 읽기 트랜잭션으로 config·창·행·links·팩트를 함께 읽는다.
- 콘텐츠 DB의 계정·현재 배정은 별도 스냅샷으로 읽고 관측 시각을 구분한다.
- 연결·DB 오류는 기존 HTTP 오류 정책을 따른다. 예외를 빈 집합으로 바꿔 합계 0을 만들지 않는다.

#### D2. API 기준과 꼬리 허용

개인·단일 소비 합계의 기준은 `api|facts|unavailable`이다.

`api` 조건은 다음과 같다.

- 현재 조직 설정이 있고 수집 enabled이며 복원 정지 상태가 아니다.
- 요청 범위에 필요한 day 성공본이 유효하다.
- 선택 창 사이 row_id 중복이 없다.
- 범위와 겹치는 저장된 대조에서 해소되지 않은 mismatch·duplicate가 없다.
- 개인 합계이면 D4의 계정 연결이 유효하다.

`TAIL_DAYS=2`는 다음 예외를 적용할 수 있는 날짜 범위이며, 2일치 누락을 자동 허용한다는 뜻이 아니다.

- 범위 시작부터 이어지는 성공본이 최소 하나 있어야 한다.
- 마지막 부분 창의 `actual_start_ms`가 논리 창 시작과 같아야 한다.
- 마지막 부족 구간은 오늘·어제에만 있어야 한다.
- 부족 구간 뒤에 별도 성공 창이 있으면 부분 합산하지 않고 facts로 대체한다.
- 현재 유효 끝 `min(end,now)`과 연속 조회 끝의 차이가 60분을 넘으면 `collection_stale`로 facts 대체한다.
- 오늘 범위에 오늘 성공본이 전혀 없다면 `missing_day`로 facts 대체한다.
- 최초 불완전일, 조직 불일치, 중복·mismatch는 꼬리 예외로 통과시키지 않는다.

정확 창 대조는 1단계와 별개로 새로 수행하지 않는다. 기존 check를 읽되, 이전 matched의 버전이 달라졌으면 최신 대조 통과로 표시하지 않는다. mismatch는 실제 후속 대조가 해소하기 전 유지한다.

facts 사유에는 기존 초안 코드와 함께 `unfinished_day`, `collection_stale`, `tail_gap`을 포함한다. `unavailable`은 인증 주체 없는 직접 로컬 조회 등 계산할 수 없는 경우다.

`coverage_end_ms`는 API **조회 범위 끝**이며 반영 완료 보증 시각이 아니다.

#### D3. 공통 집계와 그룹 이동

공통 집계 입력은 다음을 명시한다.

- 공간 또는 공간 집합
- 개인 계정 또는 현재 멤버 집합
- KST 시작·끝 `[start,end)`
- 동일 요청의 기준 시각과 읽기 자료

`api_from`은 사용하지 않는다. 각 범위에 실제 필요한 창과 신원을 판정한다.

그룹 이동 규칙은 다음과 같다.

1. 현재 배정으로 그룹을 선택한다.
2. 현재 그룹의 주기로 이번 기간을 구한다.
3. 그 기간의 개인 사용을 모두 센다. 이동 시각으로 자르지 않는다.
4. 그 개인 사용은 현재 그룹 합에 들어가고 이전 그룹에서는 빠진다.
5. 그룹 주기가 달라지면 새 그룹 기간으로 다시 계산한다. 이는 이동으로 초기화하는 것이 아니다.
6. 다른 워크스페이스의 사용을 옮겨 붙이지 않는다.

계정 메뉴·설정 멤버 줄·회원 카드·`my-usage(period,this)`는 같은 개인 집계 결과를 사용한다.

facts에서는 다음을 보존한다.

- 실제액이 0이면 견적으로 대체하지 않는다.
- 실제액이 NULL일 때만 견적을 사용한다.
- 실패·대기 견적과 tombstone을 기존처럼 포함한다.
- 날짜 없는 기록, 다른 공간·scope·계정은 기존 조건에 맞춰 제외한다.
- 합산·몫 차감 전에 표시 반올림을 하지 않는다.
- `my_quota`의 기존 비배정 조기 반환과 `pool_total` 동작은 보존한다. 비배정자의 사용 내역은 새 `my-usage`에서 충전 달로 조회한다.

그룹은 현재 멤버 개인 합계로 계산한다. 일부 개인이 facts이면 그룹의 `basis=mixed`와 구성별 출처를 반환한다. 여러 공간 합계도 같은 규칙이다.

API 풀은 해당 공간 전체 API 행을 한 번씩 합한다. 미연결자 facts를 풀에 추가하지 않는다. 혼합 상태에서는 풀과 그룹 합계의 일치를 보장하지 않는다.

#### D4. 개인 신원·권한

개인의 API actor는 다음 조건으로 서버가 결정한다.

- 인증 계정의 실제 `creator_uid`가 존재한다.
- `local`, `acct:` 같은 합성 UID가 아니다.
- 그 UID와 정확히 같은 계정이 하나뿐이며 approved다.
- 현재 조직 연결 표가 conflict이거나 다른 이메일과 충돌하지 않는다.

행이 0개여도 위 조건이 충족되면 유효한 API 0이 가능하다. 따라서 신원 판정은 조회된 행의 actor 목록에만 의존하지 않는다.

기존 `_actor_labels`의 연결 판정을 공용 순수 함수로 추출하고, 관리자 대조와 개인 조회가 함께 사용한다. 표시용 해시 라벨과 신원 판정은 구별한다. 조회 중 링크를 쓰지 않는다.

`my-usage`는 다음을 지킨다.

- 관리자도 본인 행만 받는다.
- 쿼리의 이메일·UID·계정 ID로 조회 주체를 바꿀 수 없다.
- `space=this`는 현재 계정의 공간 멤버십을 검사한다.
- `space=all`도 인증된 본인 actor만 조회한다.
- 기간 기준 공간의 멤버십은 `all`에서도 확인한다.
- actor 이메일만 일치한다고 연결하지 않는다.
- 미연결이면 개인 API 행·만든 곳 내역을 반환하지 않고 facts 사유를 제공한다.
- AUTH-off 직접 로컬은 `unavailable`; 중계 가능한 로컬 허브는 중계를 먼저 한다.

관리 화면의 기존 capability와 기존 일반 멤버의 자기 그룹 합계 열람 범위는 유지한다.

#### D5. 집계 전 견적·중복 방지

금액은 다음과 같이 구별한다.

- `used_real`: 선택한 API 행의 순값
- `used_estimated`: API에 아직 없는 적격 MV 팩트의 임시 금액
- `used`: 둘의 합
- 미상·오래된 미매칭 건수: 금액을 확정할 수 없는 기록

견적 후보는 본인 계정·해당 team 공간·소비 기간 안의 팩트다. API 금액을 다시 팩트 시각으로 자르지 않는다.

추가 조건은 다음과 같다.

- 실패·nsfw 팩트는 API 모드 견적에서 제외한다.
- `job_id`가 없거나 소유자를 안전하게 대조할 수 없으면 금액 대신 미확인 건수로 남긴다.
- 같은 job의 팩트 중복으로 견적을 늘리지 않는다.
- 다른 공간·기간의 유효한 API day 성공본에 같은 job이 있으면 견적을 제거한다.
- 제거할 때 그 API 행을 현재 공간·기간에 옮겨 가산하지 않는다.
- exact 창, 실패한 시도, 다른 조직 행만 존재하는 것으로 견적을 제거하지 않는다.
- API에 같은 job의 서로 다른 row_id가 있으면 API가 제공한 행을 각각 보존한다. 임의 job 단위 금액 중복 제거는 하지 않는다.
- 같은 row_id가 여러 선택 day 창에 있으면 D2의 중복 오류다.
- actor가 충돌하는 job은 임시 금액을 붙이지 않고 미확인으로 남긴다.

60분은 임시 견적 유효시간이다.

- 범위 안의 미매칭 기록을 조사한 뒤 최근 60분 내 적격 기록만 금액 견적으로 표시한다.
- 60분을 넘긴 미매칭 기록은 `overdue_pending_count`와 미확인 안내에 남긴다.
- 최근 닫힌 기간도 같은 검사를 한다. “지난 기간이므로 무조건 견적 0”으로 처리하지 않는다.
- 완전히 확인된 지난 기간은 견적 0이다.

견적의 공간·기간은 팩트 기준 임시 귀속이다. API 행이 도착하면 API의 공간·창으로 확정되며 이동할 수 있다.

API 반영 지연·실제 차감 시점과 팩트 시각 차이는 미확인이다. 따라서 60분 이내 완전 반영을 보장하지 않는다.

#### D6. 기간

- 기준일·일/주/월 계산은 기존 `period_start/period_end`와 소비처 계약을 재사용한다.
- 내부·새 API는 모두 `[start,end)`다.
- 기존 my-quota의 `period_end`는 이미 끝 제외 시각이다. 여기에 하루를 다시 더하지 않는다.
- 기존 날짜형 `cycle_end`처럼 마지막 날 포함 계약을 사용할 때만 한 번 끝 제외 시각으로 변환한다.
- API 행은 선택된 KST day 창에 속한다. `row.created_at`은 표시·정렬에만 사용하고 금액 재필터에 사용하지 않는다.
- `previous`는 현재 기간 시작 직전 날짜가 속한 이전 기간으로 계산한다. 30일 고정 이동을 하지 않는다.
- `space=all`은 선택 공간에서 정한 한 날짜 범위로 모든 본인 공간을 합한다.
- 관리 표의 기존 표시 기간은 유지한다: 배정자는 그룹 기간, 미배정자는 충전 달.
- 메인 관리 표는 서브별 기간을 유지해 합산하고 툴팁에 범위를 표시한다.
- 서브스페이스 주기 사용은 `_alloc_window` 범위를 유지한다.
- 2026-02-01의 불완전 KST 창을 포함하면 `before_api_start`다.

#### D7. 금액·건수·실패

- 개인·그룹 금액에는 charge와 기타 API 행의 순값도 포함한다.
- 생성 수는 `type='generation'`인 행만 센다.
- 환불 합은 `refunded_c`를 그대로 합한다.
- API 순값에 ABS·음수 보정·실패 강제 0 처리를 하지 않는다.
- API 금액은 정수 cents로 합산한 뒤 응답 단위로 변환한다.
- facts 금액은 기존 REAL 계산 정밀도를 보존한다.

실패·환불 표시는 다음으로 구별한다.

- `failed_count`: `error_code`가 있는 생성 행의 수. 의미는 ‘오류 보고 건수’다.
- `fully_refunded_count`: 양의 청구가 전액 환불되고 순값 0인 행의 수
- `failed_refunded_count`: 위 두 조건이 모두 맞는 생성 행의 수

“실패 N건 환불(0)” 문구에는 `failed_refunded_count`만 사용한다. 오류가 있지만 순값이 남아 있으면 그 금액을 유지하고 별도 상태로 표시한다. 실제 API의 전체 status/state 의미는 미확인이다.

API 금액은 서버·로컬 `real_credits`에 기록하지 않는다. 카드 금액은 3단계 범위다.

#### D8. 만든 곳

1b 이전에는 정확한 생성 출처가 아닌 기록 관계를 포함한 근사 분류다.

1. charge → 생성 아닌 차감
2. generation이며 서버 팩트에 같은 job 존재 → MV 기록 있음
3. 나머지 generation에서 surface 없음 → 힉스필드 웹
4. surface `mcp` → MCP
5. surface `claude_code` → Claude Code
6. 그 밖의 surface/type → 기타

시안의 “MV에서 만듦”은 “MV에서 만듦 · 기록 기준”으로 표시하고, 동기화로 가져온 기록도 포함될 수 있다는 설명을 붙인다. surface가 반드시 claude_code일 것이라고 가정하지 않는다.

금액 막대는 API 실제 순값 기준이며 견적은 별도 표시한다. 기타·음수 금액을 숨겨 전체 합계와 맞지 않게 만들지 않는다.

### 4. API 계약

#### 4.1 기존 `my-quota`

`GET /api/manage/credit-plan/my-quota?workspace_id=`

기존 키·타입·몫의 `source`·advisory·비배정·pool_total 계약을 유지한다.

배정된 개인의 사용액 계산에는 D2~D7을 적용하고 다음을 선택적으로 추가한다.

- `basis`
- `basis_reason`
- `as_of_ms`: 서버 조회 기준 시각
- `coverage_end_ms`
- `collected_at_ms`: 사용한 마지막 창의 수집 성공 시각
- `failed_count`
- `failed_refunded_count`
- `refunded`
- `overdue_pending_count`

facts 모드의 기존 숫자는 기존 SQL 결과와 같아야 한다. AUTH-off 직접 로컬의 기존 unavailable 응답은 유지하며 새 화면은 확정 사용액으로 그리지 않는다.

#### 4.2 새 `my-usage`

`GET /api/manage/credit-plan/my-usage?workspace_id=&range=today|week|period|previous&space=this|all`

- workspace ID 길이와 enum을 서버에서 검증한다.
- `workspace_id`는 this의 조회 공간이자 기간 기준 공간이다.
- 기본값은 `range=period`, `space=this`다.
- 개인 신원·멤버십은 D4를 적용한다.
- 기존 quota 라우터에 추가하며 정적 경로 등록 순서를 확인한다.

응답은 다음을 포함한다.

- 요청 범위·선택 공간·기준 공간
- `basis`, 사유와 시각·coverage 정보
- 순사용·환불·생성 수·오류 및 전액 환불 수
- 집계 전 건수·견적액·미상·오래된 미매칭 건수
- 만든 곳별 API 실제 금액
- 건별 목록: 시각·분류·모델·공간·원 상태·오류 코드·청구·환불·순값·pending
- `total_count`, `returned_count`, `truncated`

목록은 최신순 최대 1,000행이며 동률 정렬을 안정적으로 고정한다. **합계와 막대는 제한 전 전체 행**으로 계산한다.

facts이면 대체 사용 합계·사유는 제공할 수 있으나 API 목록·분류·환불을 꾸며 반환하지 않는다. unavailable이면 합계는 null, 목록은 비운다. 프롬프트·parameters·다른 사람의 actor 정보는 반환하지 않는다.

#### 4.3 기존 그룹·관리 표·회원 카드

기존 숫자 키를 유지한다. 출처는 숫자별 또는 범위별 메타데이터로 추가한다.

- 그룹 기간과 충전 달의 출처를 별도로 둔다.
- `my_group`의 본인 사용과 그룹 전체 사용 출처를 구별한다.
- 여러 사람·공간의 합에는 `mixed`를 허용한다.
- 관리 표 복사 과정에서도 출처 메타데이터를 보존한다.
- 풀의 미연결 API 금액은 별도 합계로 설명한다.
- 최상위 시각 하나만으로 모든 기간·사람이 동일하게 검증됐다고 표시하지 않는다.

추가 키는 기존 저장 본문에 섞어 보내지 않는다.

### 5. 화면

#### 5.1 계정 메뉴

- Limit의 남은 몫/몫과 사용 줄은 기존 개인 몫 계약을 유지한다.
- API: “힉스필드 기준”, 수집 시각, 실제로 확인된 실패 환불 정보
- 견적: `≈`, 집계 전 건수
- 미상: 금액과 별도로 미확인 건수
- facts: “MV 생성 기록 기준 · 사유”
- unavailable·오류: “확인 불가”

‘내 사용량 보기’는 새 서버 지원이 확인되면 표시한다. 비배정·무제한이어도 사용할 수 있게 하며, `source`와 사용량 `basis`를 혼동하지 않는다. Credits 잔액 칸은 그대로 둔다.

#### 5.2 내 사용량 창

선택 시안의 구성과 앱의 기존 portal·닫기 패턴을 사용한다.

- 기본: 이번 기간·이 공간
- 기간 4버튼과 이 공간/모든 공간 선택
- 타일 4개: 실제 사용, 환불, 생성 수, 집계 전
- 실제 사용 타일과 별도로 견적·미상 안내
- 만든 곳 막대
- 건별 목록: 실제 환불이 있는 행에 청구액 취소선·순값, pending에 `≈`
- 목록 제한 시 “최근 1,000건 표시 · 합계는 전체” 안내
- facts·신원 미연결·끊김은 사유 안내. API 0 타일로 바꾸지 않는다.

계정·공간·기간·space 변경 시 이전 응답을 버린다. 열기·닫기, Escape, 초점 복귀, 로딩·오류 상태를 기존 UI 패턴으로 처리한다.

#### 5.3 그룹·관리 표·회원 대시보드

- 해당 크레딧 카드·표의 출처와 기간을 표시한다.
- mixed는 “일부 MV 기록 기준”과 대상 수를 표시한다.
- 일반 멤버에게 다른 사람 행을 추가하지 않는다.
- 회원의 내 몫·사용·잔여와 그룹 합계는 공통 집계로 전환한다.
- 기존 생성 기록 분석·프로젝트/모델 차트·거래 장부에는 각각 기존 출처를 유지해 표시한다. 대시보드 전체에 API 출처를 일괄 붙이지 않는다.
- 서브스페이스의 주기 사용도 출처를 표시한다. `used_all`은 기존 팩트 기준임을 구분한다.
- 업데이트 안내 문안은 준비하되 게시·배포는 이번 구현의 자동 동작으로 추가하지 않는다.

### 6. 스키마·성능·릴리스

#### 6.1 스키마

새 표·열·영속 집계표는 추가하지 않는다. 기존 API 수집·팩트 저장 경로는 변경하지 않는다.

이 범위대로 구현하고 하위 호환 시험을 통과하면 `release/compatibility.json`은 유지한다. 스키마 변경이 필요해지면 별도 변경 근거와 호환 영향을 재검토한다.

#### 6.2 성능

- API 행은 요청한 day 창·공간 범위로 제한해 읽는다.
- 사람마다 창·계정·팩트를 반복 조회하지 않는다.
- 관리 표는 한 번 읽은 집계를 사람별로 분배한다.
- pending job 대조는 후보 job 집합에 한정한다. 매번 조직 전체 이력을 Python으로 읽지 않는다.
- API day와 exact 전체 행을 함께 읽어 놓고 반복 처리하지 않는다.
- `idx_hf_org_generation`, `idx_hf_org_workspace_actor`, 팩트 공간·날짜/표현식 색인의 실제 실행 계획을 확인한다. UNIQUE 색인이 모든 조회를 해결한다고 가정하지 않는다.

시험 고정본은 조직 월 6,000행에 여러 사람·8개 공간·과거 창을 포함한다. 관리 표와 메인 합본은 요청 수·SQL 횟수·처리 시간·응답 크기를 측정한다. 성능 수치는 구현 후 실측하며 현재 추정값을 통과 근거로 쓰지 않는다.

#### 6.3 혼합 버전·릴리스

서버를 먼저, 앱을 다음에 반영한다. 실제 병합·배포는 기존 승인·Gate·고정 release 폴더 규칙을 따른다.

| 조합 | 동작 |
|---|---|
| 구 앱 + 새 서버 | 기존 숫자 키로 새 집계를 받는다. 추가 메타데이터는 무시한다. |
| 새 앱 + 구 서버 | basis 없는 응답을 API로 간주하지 않는다. 기존 화면을 유지하고 새 창 진입은 숨긴다. |
| 새 앱 + 구 로컬 허브 + 새 서버 | 새 GET 경로가 기본 서버 위임으로 중계되는지 시험한다. |
| 새 앱 + 새 로컬 허브 + 구 서버 | 404를 0 사용량으로 바꾸지 않는다. 서버 업데이트 필요로 처리한다. |
| 중계 없는 AUTH-off 허브 | unavailable이다. |
| 공유 서버 끊김 | 오류·확인 불가이며 로컬 팩트로 몰래 대체하지 않는다. |

수집 끄기는 새 소비 집계를 facts로 돌리는 기존 제어 수단이다. 조직 성공본이나 금액을 삭제하지 않는다.

### SCOPE

**백엔드**

- `repo/hf_org_usage.py`: 저장된 day 성공본 조회·범위 판정·job 대조
- `usecases/hf_org_usage.py`: 공용 신원 판정 사용, 개인 조회 조합
- `repo/manage_credit_plan.py`: 요청 범위가 명시된 공통 집계·그룹/개인 메타데이터
- `repo/manage_quota.py`: parity 확인 후 자체 SQL 대체
- `manage_db.py`: facts 집계의 실제액·견적액·건수 및 명시적 범위
- `repo/manage_member_table.py`: 직접 팩트 조회 교체·출처 보존
- `repo/workspace_console.py`: 주기 사용 집계 전환, used_all 팩트 경로 유지
- `routers/manage_quota.py`: 새 본인 조회
- `routers/manage.py`: 필요한 응답 조합·기존 권한 유지

**프런트**

- 초안의 계정 메뉴·새 창·조회 모듈·크레딧/관리 표 타입과 화면
- `WorkspaceUsageDashboard.tsx`: API 출처가 기존 팩트 분석 전체로 오인되지 않도록 범위별 문구
- 서브스페이스 주기 사용을 실제 표시하는 console 컴포넌트와 타입
- `memberTable.ts`: 메인 합본의 출처·기간 보존

**시험**

- 새 조직 API 몫·개인 조회·권한·경계·성능 시험
- 기존 my-quota·credit plan·member table·workspace console 회귀
- `test_proxy_ownership.py`의 새 위임 경로 및 별도 중계 통합 시험
- 프런트의 개인 창·메뉴·그룹/관리 표·혼합 버전 시험

**문서**

- `CREDIT_QUOTA_DESIGN.md`에 이번 환불/API 기준 계약 추가
- `CODE_MAP.md`, endpoint 생성 목록
- 별도 2단계 작업 기록에 설계·시험·독립 리뷰 연결
- 1단계 계약 지문은 변경하지 않는다.

**제외**

카드 금액·1b 텔레메트리·생성 차단·거래 매칭 변경·CSV·프로젝트 예산·team-overview/timeseries 재설계·보존 기간·J4·운영 키 등록·수집 제어 실행·병합·배포.

### CRITERIA

1. **API 금액:** charge·generation·기타 행의 순값이 정확히 한 번 합산되고 환불 합이 맞는다. API 값을 팩트에 쓰지 않는다.
2. **facts parity:** 기존 my-quota SQL과 결과가 같다. 실제 0, 견적 0, 실패·대기·삭제분, NULL, 소수 셋째 자리, 날짜 없음, 혼합 시각 문자열, 시작·끝 경계를 포함한다.
3. **그룹 이동:** 동일 주기 이동과 월→주/일 이동에서 현재 그룹 기간의 이동 전 사용도 이어 센다. 이전 그룹에서는 빠진다. API와 facts 양쪽에서 확인한다.
4. **범위 일치:** 같은 스냅샷·공간·개인·기간에서 메뉴·설정 멤버·회원 카드·my-usage 합이 같다. 그룹은 반올림 전 개인 합과 같다. 표시 반올림 차이를 집계 오류로 숨기지 않는다.
5. **관리 표:** 배정자의 그룹 기간, 미배정자의 충전 달, 메인 합본의 서브별 기간을 유지한다.
6. **basis:** 미수집·불완전·중복·mismatch·수집 꺼짐·복원 정지·최초일·신원 충돌에서 올바른 대체 사유가 나온다. mixed를 api로 표시하지 않는다.
7. **꼬리:** 성공본 0개는 API 0이 아니다. 자정 직후 어제 부분+오늘 없음의 짧은 꼬리는 조건부 허용한다. 중간 구멍 뒤 성공 창·60분 넘는 정체·오래된 누락은 대체한다.
8. **견적:** API 도착 전후 한 번만 센다. 다른 공간·기간의 API job은 현재 범위로 이동 가산하지 않는다. exact에만 있는 job은 견적을 제거하지 않는다.
9. **지연 경계:** 60분 초과·기간 경계 생성·최근 닫힌 기간·job 없는 팩트·actor 충돌을 조용히 버리지 않는다.
10. **API 중복:** 동일 row_id의 창 간 중복은 오류다. 다른 row_id가 같은 job을 가리킬 때 금액을 임의로 제거하지 않는다.
11. **개인 권한:** 남의 UID·이메일 인자, 관리자 계정, 미연결·중복 UID, 비승인 계정에서 남의 행이 나오지 않는다. this/all 모두 검사한다.
12. **기존 권한:** read_all·관리 표 권한·credit 권한·일반 멤버 자기 그룹 범위가 유지된다.
13. **중계:** 새 경로 소유권 목록, 실제 토큰 중계, 원격 403/404/502, AUTH-off 순서, 계정 전환 뒤 늦은 응답을 확인한다.
14. **실패·분류:** 무료 0·전액 환불·오류·오류인데 순값이 남은 행·알 수 없는 상태/type/surface를 시험한다.
15. **목록:** 1,000행을 넘겨도 타일·막대는 전체 합이며 목록 절단을 표시한다.
16. **성능:** 6,000행·여러 사람·8개 공간·과거 창 고정본에서 SQL 횟수가 사람 수만큼 증가하지 않는다. 실제 실행 계획·시간·응답 크기를 기록한다.
17. **혼합 버전:** §6.3의 각 조합에서 기존 표시·저장·새 기능 감지가 맞는다.
18. **화면·회귀:** 오류를 0으로 표시하지 않고, 시안 구성·초점·Escape·늦은 응답 폐기와 관련 회귀·목록 검사·빌드가 통과한다.

### 확인 명령

아래는 **구현 후 실행할 명령**이다. 이번 읽기 전용 검토에서는 실행하지 않았다. 새 시험은 해당 파일에 추가한 뒤 실행한다.

짧고 새 경로를 basetemp로 사용한다. 기존 경로를 재사용해 pytest가 이전 내용을 정리하게 하지 않는다.

```powershell
$ErrorActionPreference = 'Stop'
$repoRoot = 'D:\ClaudeCode\MV-hub-S-dev'
$testRoot = (Join-Path $env:TEMP 'pt_hf2_') +
    [guid]::NewGuid().ToString('N').Substring(0, 8)

Set-Location "$repoRoot\backend"
$env:CONTENT_HUB_NO_PROXY = '1'

& ..\.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider `
  --basetemp $testRoot `
  tests\test_hf_org_usage_quota.py `
  tests\test_manage_my_quota.py `
  tests\test_credit_quota.py `
  tests\test_credit_quota_advisory.py `
  tests\test_credit_plan.py `
  tests\test_manage_member_table.py `
  tests\test_workspace_console.py `
  tests\test_hf_org_usage_comparison.py `
  tests\test_hf_org_usage_repository.py `
  tests\test_hf_org_usage_identity.py `
  tests\test_proxy_ownership.py `
  tests\test_schema_compat.py
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Set-Location $repoRoot
& .\.venv\Scripts\python.exe tools\gen_inventory.py --check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& .\.venv\Scripts\python.exe tools\check_code_map.py
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Set-Location "$repoRoot\frontend"
npm.cmd test -- --run `
  tests/myUsageWindow.test.tsx `
  tests/myCreditQuota.test.ts `
  tests/myCreditQuotaHook.test.tsx `
  tests/accountMenuCredits.test.tsx `
  tests/creditPlan.test.ts `
  tests/memberTable.test.tsx
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

npm.cmd run lint:architecture
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

npm.cmd run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

추가로 구현 단계에서 다음을 수행한다.

- 성능·새 중계 시험을 위 시험 묶음에 포함한다.
- 변경된 console·대시보드의 관련 시험을 실행한다.
- graft 사용이 허용되는 환경에서 프로젝트 래퍼로 build/check를 수행한다.
- 독립 리뷰 전 격리 백엔드 전체 시험을 한 번 수행한다.
- 1단계의 환경 실패 3건은 과거 기록이다. 이번 실패를 같은 원인이라고 자동 면제하지 않는다.
- 실사용 `backend/data_test`와 공유 서버를 자동 시험 대상으로 사용하지 않는다.

### 위험과 되돌리기

1. 웹·채팅·환불이 반영되면서 기존 숫자가 바뀐다. 증가·감소 방향은 사람별로 다르므로 일괄 예측하지 않는다.
2. 미연결자·부분 수집 때문에 일부 범위가 facts 또는 mixed일 수 있다. 사유와 범위를 표시한다.
3. API 조회 끝은 반영 완료 보증이 아니다. 긴 지연은 미확인 건수로 드러내며 사용액 0으로 단정하지 않는다.
4. 견적은 API 도착 때 공간·기간이 달라질 수 있다. 확정 귀속은 API가 우선한다.
5. MV 분류에는 동기화 기록이 섞일 수 있다. 정확한 출처는 1b 전까지 미확인이다.
6. 서로 다른 요청 사이에는 수집·배정 변경으로 숫자가 달라질 수 있다. 같은 스냅샷에서의 일치를 시험하며 서로 다른 시점의 화면을 무조건 같다고 보장하지 않는다.
7. 수집 끄기로 facts 전환이 가능하다. 코드 되돌림·실제 운영 제어는 기존 승인 절차를 따른다.

### 사용자 결정 필요

**없음.**

A1·A2는 이번 결정과 시안으로 확정한다. A3는 잘못된 추론을 제거하고, A4는 설계 의존성을 없앤다. 운영 서버 키·수집 상태, API 지연, status/state 전체 의미는 **미확인 사항**이며 구현 시험·운영 확인과 구별한다.

## 3단계 구현·검증 인계 (2026-11-17)

owner: Codex(3단계 구현) · reviewer: 총괄이 배정할 독립 Claude 세션 · status: 검토 요청 · updated: 2026-11-17

작업실은 `D:\ClaudeCode\work\hf-org-usage-p2`, 브랜치는 `codex/hf-org-usage-p2`다. 시작 시 이 설계 문서만 미추적 상태였고 제품 코드 변경은 없었다. 커밋·push·브랜치 전환·stash·guard bind/기록 쓰기는 하지 않았다. 공유 서버·실제 Higgsfield API/CLI·유료 생성·실사용 DB를 사용하지 않았다.

### 구현 범위와 파일

아래 목록은 이 구현의 `touched_paths`다. “새 파일”은 구현 중 추가한 파일이며, 이 작업 기록은 총괄이 미리 제공한 미추적 문서다.

| 파일 | 변경 이유 |
| --- | --- |
| `backend/app/manage_db.py` | 공간·기간이 명시된 팩트 조회 및 기존 SQLite REAL 연산을 보존하는 일괄 집계 |
| `backend/app/hf_org_usage_error.py` (새 파일), `backend/app/services/hf_org_usage_key.py` | 공용 예외형만 의존성 없는 모듈로 이동·기존 키 서비스에서 재노출하여 집계→키→연결→repo import 순환 해소 |
| `backend/app/repo/hf_org_usage.py` | 공용 순수 신원 판정, 읽기 스냅샷, day 연속성·꼬리·중복·대조 판정, 제한된 job 대조·견적·분류 |
| `backend/app/repo/manage_credit_plan.py` | 공통 개인·그룹·풀 집계, 반올림 전 합산, 기간별 출처 메타데이터 |
| `backend/app/repo/manage_quota.py` | 차등 시험 후 자체 SQL을 공통 경로로 교체, 기존 숫자·몫 계약 보존 |
| `backend/app/repo/manage_member_table.py` | 별도 월 팩트 조회를 제거하고 배정자 그룹 기간·미배정자 충전 달 및 출처를 복사 |
| `backend/app/repo/workspace_console.py` | `_alloc_window` 주기 사용을 공통 집계로 전환, `used_all`은 팩트 유지 |
| `backend/app/usecases/hf_org_usage.py` | 관리자 대조와 개인 신원 판정 공유, 본인·기간·공간 조회 조합 |
| `backend/app/routers/manage_quota.py` | 정적 `my-usage` 경로, enum·ID 길이 검증, 중계 우선·본인 멤버십·AUTH-off unavailable |
| `backend/tests/test_hf_org_usage_quota.py` (새 파일) | CRITERIA의 API·facts·범위·신원·중계·목록·성능 고정본 시험 |
| `backend/tests/test_manage_my_quota.py` | 기존 키·숫자 전체 검증을 유지하면서 선택적 메타데이터 추가 허용 |
| `backend/tests/test_manage_edit_conflicts.py` | 조회 시각이 달라지는 새 메타데이터 때문에 상태·원복 전체 비교가 흔들리지 않도록 시험의 관측 시각만 고정 |
| `backend/tests/test_proxy_ownership.py` | 새 서버 소유 GET 경로 등록 |
| `frontend/src/lib/creditUsage.ts` (새 파일) | 숫자 출처·기간·사유의 공통 타입과 표시 |
| `frontend/src/lib/myUsage.ts` (새 파일) | 본인 조회, 계정·공간·기간·space별 늦은 응답 폐기와 404/오류 구별 |
| `frontend/src/components/MyUsageWindow.tsx` (새 파일) | 타일 4개·막대·환불/견적 목록·대체/오류·목록 제한·portal/초점/Escape |
| `frontend/src/components/common/UsageBasis.tsx` (새 파일) | 기간·수집 시각·mixed 출처 표시, 구서버 메타데이터 부재 시 기존 표시 유지 |
| `frontend/src/styles/my-usage.css` (새 파일) | 선택 시안 구성과 반응형 사용량 창 |
| `frontend/src/components/AccountMenu.tsx` | 실제 사용 출처·환불·견적/미상 구별 및 비배정/무제한도 새 창 진입 |
| `frontend/src/lib/myCreditQuota.ts` | 선택적 사용량 메타데이터 타입 |
| `frontend/src/lib/creditPlan.ts`, `frontend/src/lib/workspaceConsole.ts` | 그룹·개인·풀·서브 주기별 메타데이터 타입 |
| `frontend/src/lib/memberTable.ts` | 관리 표 및 메인 합본의 서브별 기간·출처·mixed 대상 수 보존, 저장 본문 분리 |
| `frontend/src/components/manage/CreditPoolSection.tsx` | 본인·그룹·풀 출처 분리 및 미연결 API 금액 표시 |
| `frontend/src/components/manage/MemberTable.tsx` | 개인·그룹·메인 합본·서브 주기 사용의 출처 표시 |
| `frontend/src/components/manage/WorkspaceUsageDashboard.tsx` | 기존 생성 분석·프로젝트/모델 차트의 팩트 출처를 별도로 명시 |
| `frontend/src/components/manage/console/ConsoleSubView.tsx` | 주기·그룹·참가자 사용 출처 표시 |
| `frontend/src/lib/i18n.ts` | 새 한국어 문구의 영어 사전 |
| `frontend/tests/myUsageWindow.test.tsx` (새 파일) | 화면 구성·오류·구버전·응답 경합·초점/Escape·영어 표시 |
| `frontend/tests/accountMenuCredits.test.tsx` | 새 서버 기능 감지·비배정/무제한·전액 환불·미상 표시 |
| `frontend/tests/memberTable.test.tsx` | 출처·서브별 기간 보존 및 실제 개인 표 표시 |
| `frontend/tests/workspaceUsageDashboardFetch.test.tsx` | 본인/그룹 카드 출처와 기존 팩트 분석의 구분 |
| `docs/CREDIT_QUOTA_DESIGN.md` | 환불·API 순값·대체 계약과 게시하지 않은 업데이트 안내 초안 |
| `docs/CODE_MAP.md` | 새 코드 파일 색인 및 계약 링크 |
| `docs/inventory/endpoints.md`, `docs/inventory/db_tables.md` | 생성 목록 갱신. DB 목록 변경은 직접 SQL 조회 파일 목록의 변화이며 스키마 변경이 아님 |
| `docs/status/hf_org_usage_phase2_2026-11-17.md` | 설계·구현·검증·독립 리뷰 인계의 단일 기록 |
| (저장소 밖) Codex 샌드박스 전체 실행 원본·마지막 영향 묶음 출력 | 원본 로그는 문서 폴더에 커밋하지 않는다 — 총괄 세션 스크래치(`hf2design\codex_backend_full.log`·`codex_backend_related.log`)로 옮김. 정식 전체 시험은 샌드박스 밖에서 다시 받는다 |

### CRITERIA 대응

아래 `Q`는 `backend/tests/test_hf_org_usage_quota.py`다. 매개변수형 시험은 각 변형을 함께 실행한다.

| 번호 | 시험 파일::시험 | 확인 범위 |
| --- | --- | --- |
| 1 | `Q::test_api_net_refund_classification_and_no_fact_writes` | charge·generation·기타·음수 순값, 환불, 팩트 불변 |
| 2 | `Q::test_facts_parity_before_replacing_my_quota_sql`; `test_manage_my_quota.py::test_real_estimated_unknown_and_tombstones_follow_existing_fact_scope`; `test_usage_includes_start_and_excludes_end_with_mixed_timestamp_formats` | 옛 SQL 보존 후 엄격한 차등 비교, 0/NULL/실패/삭제/시각·경계·정밀도 |
| 3 | `Q::test_group_move_same_cycle_and_month_to_week_day` | API/facts × 동일 월·월→주·월→일, 이전 그룹 제외 |
| 4 | `Q::test_consumers_same_scope_and_group_move`; `Q::test_facts_group_sums_before_display_rounding`; `Q::test_facts_personal_endpoints_share_legacy_rounding` | 메뉴·설정·회원 카드·내역·관리 표 일치, 0.125 반올림 경계와 반올림 전 그룹 합 |
| 5 | `Q::test_unassigned_member_table_uses_topup_month`; `Q::test_group_move_same_cycle_and_month_to_week_day`; `frontend/tests/memberTable.test.tsx::API metadata survives member accessors and main aggregation with each sub period`; 기존 `test_workspace_console.py` | 배정/미배정 및 서브별 기간·메타데이터 보존 |
| 6 | `Q::test_basis_fallbacks`; `test_identity_never_discloses_other_actor`; `test_tail_midnight_and_first_day`; `test_mixed_pool_and_unassigned_month`; `test_valid_pool_does_not_add_unlinked_member_facts` | 수집·범위·대조·신원별 facts 및 mixed/API 풀 구별 |
| 7 | `Q::test_api_empty_success_is_zero_but_no_success_is_not`; `test_tail_midnight_and_first_day`; `test_basis_fallbacks` | 성공 0행과 미수집 구별, 짧은 자정 꼬리, 중간 구멍·오래된 누락·60분 초과 |
| 8 | `Q::test_pending_arrival_cross_space_period_exact_and_overdue`; `test_pending_conflicting_actor_and_duplicate_jobs`; `test_pending_valid_day_evidence_and_same_owner_deduplication` | API 도착 전후 한 번 합산, 다른 공간/기간·조직·exact·불완전/미래 창·동일 소유 job/actor 중복 처리 |
| 9 | `Q::test_closed_period_pending_boundary_and_previous_calendar`; `test_pending_arrival_cross_space_period_exact_and_overdue`; `test_pending_conflicting_actor_and_duplicate_jobs` | 지난 기간 경계·60분 초과·job 없음·소유 충돌 미확인 |
| 10 | `Q::test_basis_fallbacks[duplicate-duplicate_row]`; `test_duplicate_inside_narrower_group_period`; `test_pending_conflicting_actor_and_duplicate_jobs` | 범위별 row_id 중복 대체, 다른 row_id/동일 job API 금액 보존 |
| 11 | `Q::test_personal_route_validation_and_injected_identity`; `test_identity_never_discloses_other_actor` | 관리자 포함 본인 한정, UID/이메일 인자 무시, this/all, 미연결/중복/비승인/충돌 |
| 12 | `backend/tests/test_credit_quota_advisory.py::QuotaReadRouteTests::test_member_scope_is_checked_even_for_manager`; `test_manage_member_table.py::MemberTableTests::test_route_permission_matches_account_detail_rule`; `test_credit_plan.py::CreditPlanTests::test_member_view_only_own_group`; `test_workspace_console.py::test_permissions` | 기존 capability·일반 멤버 자기 그룹·생성 차단 없음 |
| 13 | `backend/tests/test_proxy_ownership.py`; `Q::test_proxy_actual_token_and_auth_off_order`; `test_old_hub_middleware_relays_new_unknown_route`; `frontend/tests/myUsageWindow.test.tsx::discards late responses on account, workspace, range and space changes` | 소유권, 실제 loopback 토큰 중계·403/404/502·AUTH-off 순서·늦은 응답 폐기 |
| 14 | `Q::test_api_net_refund_classification_and_no_fact_writes` | 무료 0·전액 환불·오류 순값 유지·알 수 없는 type/surface/state |
| 15 | `Q::test_list_limit_full_totals_and_created_at_not_refiltered`; `frontend/tests/myUsageWindow.test.tsx::renders the selected tiles, all source amounts, refunds and pending estimates` | 1,005행 전체 합계·막대, 1,000행 절단, 안정 정렬 |
| 16 | `Q::test_performance_6000_rows_eight_spaces_query_count` | 6,000행·8공간·과거 창, 40명 추가 전후 SQL 고정, 실제 관리 표 8요청·시간·크기·실행 계획 |
| 17 | `Q::test_old_hub_middleware_relays_new_unknown_route`; `test_proxy_actual_token_and_auth_off_order`; `backend/tests/test_schema_compat.py`; 프런트 `accountMenuCredits.test.tsx`, `myUsageWindow.test.tsx`, `memberTable.test.tsx` | 구 앱 숫자/저장 계약, 구 허브 기본 위임, 구서버 기능 감지/404, AUTH-off·끊김 |
| 18 | `frontend/tests/myUsageWindow.test.tsx`; `accountMenuCredits.test.tsx`; `memberTable.test.tsx`; `workspaceUsageDashboardFetch.test.tsx`; console 관련 회귀·빌드·경계/목록 검사 | 자동 UI 시험 수행. 실제 브라우저 시각·키보드 실측은 연결 불가로 미확인이며 자동 초점/Escape 시험과 구별 |

### 검증 실행과 제약

- facts 차등 시험을 먼저 단독 실행해 1개 통과한 뒤 옛 my-quota SQL을 제거했다. 최종 차등 비교는 SQLite REAL 값 자체를 엄격하게 비교한다.
- 백엔드 확인 명령의 12개 시험 파일을 지정 파이썬, `CONTENT_HUB_NO_PROXY=1`, `-p no:cacheprovider`, `%TEMP%\pt_hf2_<새 GUID>`로 실행했다. 최신 결과와 전체 시험 결과는 아래 최종 결과에 기록한다.
- 프런트 확인 명령의 6개 파일 및 console·대시보드 관련 6개 파일: **12파일·154시험 통과**. 사용 명령은 `npm.cmd --prefix D:\ClaudeCode\work\hf-org-usage-p2\frontend test -- --run <위 12개 파일> --configLoader runner --cache=false`다. 메인 합본에서 출처 없는 구서버 부분과 새 API 부분이 섞여도 API로 승격하지 않고 대체 대상 수·구성 범위를 보존한다.
- `npm.cmd --prefix D:\ClaudeCode\work\hf-org-usage-p2\frontend run lint:architecture`: 통과(오류·경고 출력 없음).
- 기본 `npm.cmd --prefix D:\ClaudeCode\work\hf-org-usage-p2\frontend run build`는 TypeScript 완료 후 Vite가 junction의 `node_modules\.vite-temp`에 임시 설정을 쓰려다 `EPERM`으로 실패했다. `run build -- --configLoader runner`로 공유 의존성 쓰기를 피한 빌드는 통과했다. 기존 큰 번들 안내는 남는다.
- `gen_inventory.py`로 목록을 다시 만들었고 `--check`, `check_code_map.py`를 실행했다. 코드 지도 누락/허구 파일은 0이다.
- `powershell -NoProfile -File tools\graft.ps1 build`는 Windows 실행 정책 `UnauthorizedAccess`로 차단됐다. 정책을 우회하지 않았으며 build/check “in sync”는 미확인이다. 이 작업실에는 시작 시 `graft/` 색인이 없었다.
- Aside 스킬의 `aside guide`가 필수 업데이트를 안내했으나 작업실 밖 설치 변경은 하지 않았다. 내장 브라우저는 `The browser access host is unavailable`을 반환했다. 화면 고정본을 준비한 로컬 서버는 종료했고 임시 고정본 파일은 정리했다. 시각 검수를 통과로 기록하지 않는다.
- 자체 검토에서 SQL 정밀도 보존, 현재 계정/배정의 같은 콘텐츠 스냅샷, 좁은 그룹 기간 안의 중복 row, 상충 job 소유자, 미래·비정상 day 창의 견적 제거 방지, 미상만 있는 금액의 `≈` 오표시, 구서버 표시 보존을 보완했다. 보완한 경로는 관련 시험으로 다시 확인했다.
- 최종 수치 대조에서는 API 기록만 있는 신원 연결 계정이 현재 멤버 등록부에서 빠졌어도 미배정 사용 합계에 포함되도록 보완했다. `Q::test_api_only_former_member_is_in_unassigned_total`로 확인했다. 본인 조회의 공간 멤버십·일반 멤버 공개 범위는 넓히지 않는다.
- 중간 시험의 고정본 필수 필드 누락·기대 환불 합 오산·문자 인코딩 오류 및 새 출처 문구에 따른 구버전 화면 회귀는 수정했다. 한국어는 UTF-8로 다시 적용했고 새 화면의 영어 사전 시험도 통과했다.

### 성능 관측

실측 고정본: 월 6,000 API 행, 여러 actor, 8개 공간, 선택 범위 밖 과거 day 창. 한 관리 표에 그룹 배정 40명을 더해도 관리 DB 12회·콘텐츠 DB 57회, **전체 69개 SQL로 동일**했다. 콘텐츠 DB 계측에는 연결 설정 SQL도 포함한다. 메인 합본 소비 방식대로 FastAPI TestClient의 프로세스 내 ASGI GET 8개를 실행하면 관리 96회·콘텐츠 456회, **전체 552개 SQL**이다. 초기 12/96회 보고는 관리 DB만 센 값이었고, 두 DB 계측으로 확인 범위를 보완해 정정했다.

최종 계측 표본 1회에서 repo 조회는 배정 추가 전 0.0396초, 40명 추가 후 0.0477초였다. 실제 단건 HTTP 응답은 51,952바이트, 8요청은 클라이언트 시작·종료를 포함해 0.3821초·66,053바이트였다. 이 수치는 격리 고정본의 관측이며 운영 DB 성능 보증이 아니다.

실제 SQLite 실행 계획에서 actor 조회는 `idx_hf_org_workspace_actor`, job 조회는 `idx_hf_org_generation`을 사용했다. 팩트는 공간 색인(`idx_tgf_workspace_model_created` 또는 `idx_tgf_workspace_created`)을 선택했고, 기간 일괄 합에는 임시 GROUP BY 트리를 사용했다. 이 고정본에서 `idx_tgf_julian`이 선택됐다고 주장하지 않는다. 새 색인·스키마는 추가하지 않았다.

마지막에는 예시 조회뿐 아니라 trace에서 가져온 **실제 snapshot/job SQL**도 EXPLAIN했다. job 조회의 창 우선 계획을 발견해 기존 `idx_hf_org_generation`과 CROSS JOIN으로 후보 job을 먼저 읽도록 고정했다. 실제 최종 계획은 `SEARCH r USING INDEX idx_hf_org_generation (generation_id=?)` → `SEARCH w USING INTEGER PRIMARY KEY`이며, snapshot 행은 `idx_hf_org_workspace_actor (window_id,workspace_id)`를 사용한다. 이 보완 뒤 조직 사용량 파일 48개 전체 통과, 최종 join 순서 보완 뒤 성능·중복·유효 day·공간/기간 대조 4개가 다시 통과했다. 마지막 표본은 단건 0.0319초/40명 추가 후 0.0324초, 8요청 0.2569초였고 SQL·응답 크기는 동일했다.

### 최신 관련 시험 결과

- 확인 명령의 12개 백엔드 파일에 `test_architecture_boundaries.py`를 더한 최종 영향 묶음: **245 통과·0 실패·0 건너뜀, 하위 시험 28 통과**, 75.92초. 이후 새 valid-day/동일 소유자 중복/도착 전후 시험 1개도 통과했다. 총 246개 서로 다른 관련 시험이 현재 기능을 확인한다.
- 공용 예외형 분리 후 `test_hf_org_usage_key_routes.py`, `test_hf_org_usage_collector.py`, `test_hf_org_usage_client.py`: **122 통과·0 실패·0 건너뜀**, 64.74초. 키·수집·클라이언트 경계의 실제 fixture 회귀이며 실제 API는 호출하지 않았다.
- 전체 시험에서 관측 시각 차이로 실패한 충돌/감사 비교 시험은 시계를 fixture에서 고정한 후 `test_manage_edit_conflicts.py` **36개 전체 통과**(15.41초)로 재확인했다. 상태·revision·감사 기록의 전체 비교와 원복 검증은 제거하지 않았다.
- 프런트 관련 **154 통과**, 최종 `lint:architecture` 종료 코드 0, `build -- --configLoader runner` 종료 코드 0. 빌드의 큰 번들 안내는 경고이며 실패가 아니다.
- AUTH-off 직접 응답은 범위·목록 계약을 유지하면서 금액·건수·기간·관측 정보의 미확인 값을 `null`로 명시한다. 이 보완 후 실제 중계/AUTH-off 4개 변형과 프런트 154개를 다시 통과했고, 사유 표시 보완 후 개인 창 10개·빌드·경계 검사도 재확인했다.
- 최신 성능 묶음 안의 재측정은 repo 0.0366초/40명 추가 후 0.0372초, 8요청 0.3104초였다. SQL 69/552 및 응답 크기는 앞 표본과 같았다. 계측 오버헤드가 포함된 임시 고정본 수치다.

### 백엔드 전체 시험 1회 결과

명령은 backend 작업 위치에서 지정 파이썬으로 `-m pytest -q -p no:cacheprovider --basetemp $testRoot tests`를 실행했다. `CONTENT_HUB_NO_PROXY=1`, `PYTHONDONTWRITEBYTECODE=1`이었고, `$testRoot`는 `%TEMP%\pt_hf2_full_83acf951`(새 폴더)였다. **11,341 통과·84 실패·66 오류·4 건너뜀·하위 시험 1,212 통과·경고 5개, 3,480.70초(58분), 종료 코드 1**이다. 실패 수에는 아래 하위 시험 실패 3건도 포함된다.

전체 실행은 자체 검토 보완 전 코드로 시작했고 종료 뒤 필요한 부분을 재확인했다. 원본의 실패 수를 수정 후 통과 수로 바꿔 기록하지 않는다. 전체 재실행은 하지 않았다.

- R1 높음: import 순환 1건 → 공용 예외형 분리로 반영. 최신 `test_architecture_boundaries.py` 통과.
- R2 중간: `test_manage_edit_conflicts.py` 11건 → 같은 상태의 응답을 서로 다른 관측 시각으로 비교하던 시험을 수정. 시각만 고정하고 데이터·revision·감사 기록의 전체 비교를 유지했으며 36개 전체 통과.
- 그 외 환경 및 범위 밖 실패는 아래에 구별했다. **전부 샌드박스 때문이라고 판정하지 않는다.** 1단계의 과거 실패 3건을 이번 면제 근거로 사용하지 않았다.

| 원본 실패 위치 | 수 | 직접 확인한 원인/처리 |
| --- | ---: | --- |
| `test_first_install_bootstrap.py`, `test_release_contract.py` | 실패 21 + 16 | PowerShell `UnauthorizedAccess`·실행 정책 거절. 관련 제품/시험을 고치거나 정책을 우회하지 않음 |
| `test_git_update_admission.py`, `test_server_console.py` updater 2개, `test_sparse_checkout_scripts.py` | 오류 63 + 2 + 1 | 같은 PowerShell fixture 준비의 `SecurityError`/`UnauthorizedAccess` |
| `test_open_link_release.py` | 실패 9 | WinError 5 접근 거절 |
| `test_release_update.py` | 실패 6 | CIM `0x80041003` 접근 거절·프로세스 조회 실패 및 자식 종료/실행 시간 초과 |
| `test_agent_session_guard.py` | 실패 1 | 임시 구형 launcher 대역 3초 시간 초과. 샌드박스 단독 원인인지는 미확인 |
| `test_agent_startup_check.py` | 실패 3 | unreadable PID/handle·taskkill 종료 경로 검증 실패. 실제 OS 권한 경계가 포함되며 제품 수정 안 함 |
| `test_cli_bridge_contract.py`, `test_model_catalog_swr.py` | 실패 1 + 1 | 자식 종료 후 Win32 wait 258(아직 종료 아님) |
| `test_resolve_selection_worker.py`, `test_server_console_control.py`, `test_server_qualification.py`, `test_win_job.py` | 실패 각 1 | 실제 자식 생존/종료/lock 정리 확인 실패·시간 초과. 샌드박스 종료 제한과 구별하지 못한 부분은 미확인 |
| `test_resolve_mutation_gate.py::RunInJobRealProcessTests::test_hub_death_ends_a_reading_child_but_not_a_mutating_one` | 하위 실패 1 | `kill_on_close='0'` 실제 프로세스 경계 |
| `test_win_job.py::ProcessJobTests::test_owner_death_kills_the_tree_without_any_watcher_thread` | 하위 실패 2 | venv·기본 Python 각각 실제 프로세스 종료 경계 |
| `test_server_console_nas_access.py::test_native_token_metadata_and_failed_restore_exit` | 실패 1 | 로그인한 사용자의 Windows 탐색기를 찾지 못함 |
| `test_shared_tls_rehearsal.py::test_shared_tls_rehearsal` | 실패 1 | TLS 동작 확인 뒤 cleanup의 taskkill 접근 거절·CIM 조회 거절 |
| `test_server_console.py::test_real_listener_is_verified_and_intake_changes_end_to_end` | 실패 1 | 임시 포트의 listener 프로세스 확인 실패. 권한 단독 원인은 미확인 |
| `test_backup_v3_local.py::test_consumers_replica_resumes_own_interrupted_deletion[2]` | 실패 1 | 임시 `.KEEP.JSON.tmp` 잔여. 단독 재실행 통과, 전체 실행에서 남은 원인은 미확인 |
| `test_resolve_selection_monitor.py::JobReapTests::test_resume_failure_inside_the_job_that_does_not_die_is_kept_with_its_job_and_asked_once_later` | 실패 1 | 0.3506초로 0.2초 기준 초과. 단독 재실행 통과, 부하/환경의 기여는 미확인 |
| `test_scene_keeps.py::test_keep_and_account_cleanup_leave_no_orphan_in_either_order`, `test_slack_link.py::test_account_deletion_cleans_link_and_queue` | 실패 각 1 | `CleanupRefused: 승인된 적 있는 계정`. 별도 임시 DB 재실행에서도 2건 실패. 해당 제품 코드/보호 정책은 변경하지 않았고 이번 변경 전 기준에서의 독립 재현은 미확인 |

전체 실패의 정확한 매개변수형 시험 이름·stack과 경고는 Codex 샌드박스 전체 실행 원본(저장소 밖으로 옮김)에 있다. 마지막 영향 묶음 출력은 245개 통과와 두 DB 성능 계측을 담는다. 계정 정리 2건은 이 작업실이 dev 의 시험 보정(`d837ef40`, 승인됐던 계정 흉내) 전에서 갈라졌기 때문이다 — dev 를 합친 뒤 다시 확인한다. 별도 원인 확인 4개 시험은 2통과·2실패(4.27초)였다. 건너뜀 4개는 원본 요약 수치이며 개별 사유는 `-rs`로 기록하지 않아 미확인이다.

따라서 **전체 회귀/배포 Gate 통과로 판정하지 않는다.** 현재 관련 백엔드 246개 + 키/수집/클라이언트 122개 + 충돌/감사 36개, 총 404개 서로 다른 관련 시험과 프런트 154개는 통과했다. 독립 리뷰와 실제 브라우저 시각 확인, 환경 의존 전체 회귀의 후속 확인은 총괄 인계 범위다.

### 설계 차이·다음 리뷰

제품 동작의 설계 차이는 없음. 서버 기능 감지용 `usage_supported`를 기존 my-quota에 선택적으로 추가했다. 내부 파일 범위는 공용 예외형 1개를 추가 분리했다. 전체 시험에서 `test_backend_internal_import_graph_has_no_cycles`가 새 집계→키 서비스→공유 연결→repo 순환을 검출해, 오류 코드·클래스 계약을 유지하며 해당 의존성만 끊었다. 스키마·1단계 계약 지문은 바꾸지 않았다. 검증 명령에는 junction 쓰기를 피하는 Vite 옵션을 덧붙였고, 전체 시험은 자체 검토 보완 전 실행본과 보완 후 관련 시험을 구별한다.

독립 리뷰는 아직 수행하지 않았다. 리뷰어는 D2의 연속 창·꼬리·sticky mismatch, D4의 본인 신원/멤버십, D5의 범위 밖 job·상충 소유자와 지연, facts 차등·그룹 반올림 전 합, 메인 합본의 mixed 출처·서브 기간을 우선 확인한다. 실제 브라우저 시각 검수·운영 API 지연·status/state 전체 의미는 미확인이다.

프로젝트 문서: 계약·시험·미확인을 이 문서와 몫 설계에 기록했다. 프로젝트에 종속된 내용이다.
기억: 없음. 별도 개인 설정·기억은 수정하지 않았다.
볼트: 없음. 프로젝트를 지워도 남길 별도 기법 후보에 대한 두 모델 합의를 이번 구현에서 진행하지 않았다.
