---
updated: 2026-08-26
status: active
---

# 생성 제출 중단 복구 계약

기준일: 2026-08-16

대상 위험: `RL-05`

현재 상태: **내부 계약 완료 — `1252b52d`; 실제 유료 생성 중단은 외부 검증 잔여**

이 문서는 생성 요청을 Higgsfield CLI에 넘기는 순간 에이전트나 네트워크가 끊겼을 때 같은 작업을
두 번 제출하지 않기 위한 기준이다. 위험 상태의 최종 표시는
[RISK_REDUCTION_PLAN_2026-08-15.md](RISK_REDUCTION_PLAN_2026-08-15.md)의 Gate 0 표를 따른다.

## 1. 쉽게 설명하면

기존에는 에이전트가 요청을 가져간 직후부터 `제출 중`으로 표시했다. 이 상태에서 연결이 끊기면
실제로 Higgsfield에 제출하기 전인지, 제출은 됐지만 `job_id`를 받기 전인지 서버가 구분할 수 없었다.
이를 무조건 다시 실행하면 같은 생성이 두 번 만들어져 크레딧이 이중 소모될 수 있다.

새 계약은 유료 CLI 호출 전과 후를 분리한다.

1. `claimed`: 에이전트가 요청만 확보했다. 아직 유료 생성은 시작하지 않았다.
2. `submitting`: 서버 허가를 받은 뒤 유료 CLI 호출을 시작했다.
3. `running`: `job_id`를 확보해 기존 외부 작업을 추적한다.
4. `recovery_required`: 제출됐는지 확정할 수 없다. 자동으로 다시 실행하지 않는다.

따라서 `claimed`에서 끊기면 안전하게 다시 대기열로 돌릴 수 있지만, `submitting` 이후 `job_id`가
없으면 사람이 확인할 때까지 격리한다.

## 2. 상태 흐름

```text
pending
  │ 에이전트 claim
  ▼
claimed ── 준비 실패/lease 만료 ──▶ pending
  │ begin-submission 서버 ACK
  ▼
submitting
  ├─ job_id 확보 ──▶ running ──▶ tracking/verifying ──▶ done | failed
  └─ 결과 불명확/lease 만료 ──▶ recovery_required
                                      ├─ 기존 job_id 발견 ──▶ 기존 작업 추적 재개
                                      └─ 미제출 확인 ──▶ 명시적 재큐잉
```

### 상태별 자동 처리

| 상태 | 자동 처리 | 자동 재생성 |
|---|---|---|
| `pending` | 다음 에이전트가 claim | 가능 |
| `claimed` | 같은 소유자가 제출을 시작하거나, 만료 시 `pending` 복귀 | 가능 |
| `submitting` + `job_id` 없음 | `recovery_required` 격리 | 금지 |
| `running/tracking/verifying` + `job_id` 있음 | 그 `job_id`만 계속 조회 | 금지 |
| `recovery_required` | 외부 생성 여부 확인 전 유지 | 금지 |
| `done/canceled` | 늦은 응답으로 되돌리지 않음 | 금지 |

핵심 원칙은 **lease 만료가 곧 재생성 허가는 아니라는 것**이다.

## 3. 서버와 에이전트의 책임

### 서버

- claim을 원자적으로 처리해 같은 요청을 두 에이전트가 동시에 가져가지 못하게 한다.
- `submission-stage`와 `agent_id`를 함께 선언한 에이전트에만 유료 claim을 내린다. 둘 중 하나라도
  없으면 요청은 `pending`으로 보존하고, 계정 사용자에게 에이전트 업데이트 안내를 보낸다.
- 새 에이전트에는 `claimed`를 반환하고, `begin-submission`이 성공한 뒤에만 `submitting`으로 바꾼다.
- `claimed` 만료는 `pending`으로 되돌린다.
- 배포 정지 스위치(`generation_deployment_paused`, `GET/PUT /gen-requests/deployment-pause`)가 켜지면
  `POST /gen-requests`·`pending-exists`·`pending` 은 **503 + Retry-After 60** 으로 claim 을 막는다.
  이 창에서는 "`pending` → 다음 에이전트가 claim" 이 성립하지 않는다.
- 유료 호출이 시작된 상태에서 `job_id`가 없으면 `recovery_required`로 격리한다.
- 서버 시작 시 단순히 `job_id`가 없다는 이유로 살아 있는 큐 요청을 실패 처리하지 않는다.
- 복구 전이는 생성 이벤트·운영 로그·상태 점검 수치에 남긴다.

### 에이전트

- `pending-exists`와 claim 요청 모두에 `submission-stage` 기능과 `agent_id`를 알린다.
- 레퍼런스와 워크스페이스 준비를 먼저 끝낸다.
- 유료 `generate create` 바로 전에 `begin-submission` 승인을 받는다.
- 승인 응답이 없으면 CLI를 호출하지 않고 claim을 반환한다.
- CLI를 호출한 뒤 `job_id`가 없으면 실패·재시도하지 않고 `recovery_required`를 보고한다.
- 이미 제출된 작업은 로컬 outbox와 서버 anchor를 통해 같은 `job_id`로만 복구한다.
- 멱등 보고 4곳(`begin-submission`·`recovery-required`·anchor·미부착 reconcile)은 순단 시 **최대 3회 호출, 실패 뒤 sleep 2회(0.5초·2ⁿ·jitter, 상한 2초 — sleep 합계 약 0.75~1.5초,
  HTTP 요청 시간 별도)** 로 재시도하고 **4xx 는 즉시 중단**한다. anchor 의 200 `applied:false` 는 요청이 종결
  상태면 outbox 에서 제거한다(`_retry_pause`).

## 4. 혼합 버전 업데이트 규칙

서버와 작업자 PC가 동시에 업데이트되지 않을 수 있으므로 다음 호환 계약을 유지한다.

| 조합 | 동작 |
|---|---|
| 새 서버 + 새 에이전트 | `claimed → begin-submission → submitting` 사용 |
| 새 서버 + 구 에이전트 | 유료 claim을 주지 않고 요청을 `pending`으로 보존한다. 사용자에게 에이전트 업데이트를 안내한다. |
| 구 서버 + 새 에이전트 | 응답에 `claim_phase`가 없으면 기존 방식으로 처리한다. 구 서버에는 새 격리 계약이 없으므로 서버 업데이트 전 안전성은 제한적이다. |

운영 적용 순서는 **서버 먼저, 작업자 에이전트 다음**으로 고정한다. 새 서버가 먼저 배포되면 구
에이전트는 유료 실행을 시작하지 못하고, 신 에이전트가 연결되는 즉시 보존된 요청을 이어서 처리한다.
신 에이전트가 구 서버에 먼저 연결되는 조합은 추가 query를 구 서버가 무시하므로 기존 동작을 유지한다.

## 5. 복구 판단 절차

`복구 확인 필요`가 표시되면 즉시 다시 생성하지 않는다.

1. **자동 조사**(에이전트, 매 tracking 사이클 — `agent_push.py` `recovery_probe_pass`): 제출 지문
   (`submission_fingerprint` — 계정·모델·프롬프트·시각 창)으로 Higgsfield 최신 목록을 **읽기 전용**
   (`generate list` 만 호출, `create` 금지)으로 대조한다.
2. 후보가 **정확히 1개**면 사람 확인 없이 그 `job_id`로 자동 anchor 하고 추적한다(유료 호출 없음).
3. 후보가 **여러 개**(`multiple`)면 영구 보류한다 — 자동으로 고르지 않는다.
4. 후보가 **없음**이고 조사 창이 제출 구간을 덮었으면 `no_match` 확정. 이 결과가 **2분 이내**로 fresh 할 때만
   `미제출 확인`(`confirm-not-submitted`)으로 요청을 `pending`에 되돌릴 수 있다. fresh 결과가 없으면
   409 `probe_required`("자동 제출 조사를 요청했습니다"), 후보가 있으면 409 `candidate_found`.
5. 조사 결과는 `gen_request` 의 ledger 컬럼(`backend/schema.sql`)에만 기록된다(이벤트·감사 로그 없음). anchor 와
   재큐잉은 별도 이벤트를 남긴다. 조회 `GET /gen-requests/recovery-probes`; `POST /gen-requests/{rid}/recovery-probe` 는
   **에이전트가 조사 결과를 기록하는 API** 이고, 재조사는 `confirm-not-submitted` 처리 중 `agent_signals` 의
   `recovery-probe` 신호로 에이전트를 깨워 일어난다.

`confirm-not-submitted` API는 4번의 명시적 안전장치다. 자동 조사가 유일 후보를 찾으면 이 API 없이 anchor 되고,
그 외에는 fresh `no_match` 없이는 재큐잉되지 않는다(2026-08-21 `a5fec866` 이후 규칙).

## 6. 코드 위치

| 역할 | 파일 |
|---|---|
| claim·lease·격리·명시 재큐잉 | `backend/app/repo/gen_requests.py` |
| 업무 흐름·이벤트·실시간 알림 | `backend/app/usecases/gen_requests.py` |
| HTTP 계약 | `backend/app/routers/gen_requests.py`, `backend/app/models.py` |
| 서버 시작 복구 | `backend/app/main.py` → `backend/app/repo/gen_requests.py`(`sweep_expired_generation_claims`), `backend/app/repo/generations.py`(고아 실패 처리) |
| 에이전트 staged 제출·outbox | `agent_push.py` |
| 상태 표시·명시 재실행 UI | `frontend/src/lib/generationDisplay.ts`, `frontend/src/lib/useGenerationCardActions.ts`, `frontend/src/components/InfoPopup.tsx` |
| 상태엔진·권한·에이전트 계약 테스트 | `backend/tests/test_generation_state_engine.py`, `backend/tests/test_gen_request_usecase.py`, `backend/tests/test_identity_permissions.py`, `backend/tests/test_agent_contracts.py` |
| 프론트 계약 테스트 | `frontend/tests/generationDisplay.test.ts`, `frontend/tests/generationRecoveryApi.test.ts` |

## 7. 검증 체크리스트

### 비용이 들지 않는 필수 검증

- 두 에이전트가 동시에 claim해도 한 쪽만 성공한다.
- `claimed` 상태에서 강제 종료하면 만료 뒤 `pending`으로 돌아온다.
- `submitting` 상태에서 강제 종료하고 `job_id`가 없으면 `recovery_required`가 된다.
- 서버를 재시작해도 `pending`, `claimed`, `recovery_required` 요청이 고아 작업 정리에 의해
  임의 실패 처리되지 않는다.
- `begin-submission` ACK가 없으면 에이전트가 CLI를 호출하지 않는다.
- CLI 응답에서 `job_id`를 얻지 못해도 자동 실패·자동 재시도하지 않는다.
- 알려진 `job_id`를 anchor하면 새 생성 없이 기존 추적 흐름으로 복구된다.
- 구 서버·구 에이전트와의 혼합 버전 계약 테스트가 통과한다.

### 외부 통합 검증

- 사용자 승인을 받은 실제 생성 1건으로 제출 → anchor → 직접 조회 → 결과 저장 왕복을 확인한다.
- 테스트용 생성에서 에이전트를 제출 전과 제출 후에 각각 중단해 중복 작업이 생기지 않는지 확인한다.
- 서버 먼저, 에이전트 나중 순서의 업데이트 중에도 요청 유실·중복 제출이 없는지 확인한다.

실제 생성 테스트는 크레딧을 사용하므로 사용자 승인 없이 실행하지 않는다.

구체적인 PowerShell 실행 명령은 [TESTING.md](TESTING.md)의 `생성 제출 중단 복구(RL-05)` 절을
사용한다.

## 8. 완료 검증 기록

검증일: 2026-08-16 · 구현 커밋: `1252b52d`

| 검증 | 결과 |
|---|---|
| RL-05 대상 백엔드 | 98개 통과 |
| RL-05 대상 프론트 | 2개 파일, 3개 통과 |
| 백엔드 전체 | 734개 통과 |
| 프론트 전체 | 74개 파일, 522개 통과 |
| 프론트 아키텍처·프로덕션 빌드 | 통과 |
| 업데이트 경로 | 43개 통과 |
| 비용 없는 중단·재시작 DB 드릴 | `paid_cli_called=false`, `ok=true` |
| 격리 브라우저 | 복구 표시, 일반 재생성 차단, 명시 확인 버튼, 콘솔 경고·오류 0건 확인 |

적대적 리뷰에서는 서버·프론트 양쪽의 일반 재생성 우회, claim 만료 자동 재큐잉, 서버 재시작 고아
실패 처리, 구 에이전트의 알려진 모호한 실패 보고를 확인했다. `recovery_required`를 `pending`으로
돌리는 경로는 같은 계정 사용자의 명시적 `confirm-not-submitted` 동작 하나만 남겼다(리뷰 시점. 이후 §5 의
자동 조사·유일 후보 자동 anchor 가 추가됐다).

## 9. 완료 조건

다음 조건을 모두 만족해야 RL-05를 완료로 표시한다.

1. 대상 상태엔진·에이전트·운영 상태 테스트 통과
2. 백엔드 전체 회귀, 프론트 전체 회귀·빌드 통과
3. 업데이트 경로 테스트 통과
4. 비용이 들지 않는 중단·재시작 DB 드릴 통과
5. 적대적 리뷰에서 자동 재생성 우회 경로가 없음
6. 변경 커밋 완료 — `1252b52d`

실제 유료 생성 중단 실측이 생략되면 그 사실은 외부 검증 잔여 위험으로 별도 표시한다.
