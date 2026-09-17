---
updated: 2026-09-17
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
| `running/tracking/verifying` + `job_id` 있음 | 그 `job_id`만 계속 조회. 삭제 대상의 정확한 종결 증거가 있으면 §11 예외 적용 | 금지 |
| `recovery_required` | 외부 생성 여부 확인 전 유지 | 금지 |
| `done/canceled` | 늦은 응답으로 되돌리지 않음. 명시적 휴지통 복원의 종결 마커는 §11 예외 적용 | 금지 |

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

## 10. 오류 원인 안내와 복구 판단의 분리 (2026-09-16)

- owner: Codex
- reviewer: Claude Opus (설계 조정·구현 독립 리뷰 후 보완 재검토 승인)
- status: 완료
- touched_paths: `agent_push.py`, `backend/tests/test_agent_contracts.py`, `frontend/src/lib/generationIssue.ts`, `frontend/src/lib/generationDisplay.ts`, `frontend/src/lib/i18n.ts`, `frontend/src/lib/useGenerationCardActions.ts`, 생성 카드·정보창·히스토리·결과 묶음·부분 편집의 오류 표시, 관련 CSS·테스트, 이 문서
- updated: 2026-09-16

### 합의한 표시 계약

| 응답에 명시된 원인 | 카드 제목 (한국어 / English) | 우선 확인 사항 |
|---|---|---|
| 월간 워크스페이스 그룹 한도 | 크레딧 한도 초과 / Credit limit reached | 관리자 한도 조정 또는 한도 초기화 |
| 크레딧 부족 | 크레딧 부족 / Insufficient credits | 해당 계정·워크스페이스 잔액 |
| 위 두 사유가 함께 있음 | 크레딧 제한 확인 / Check credit limits | 잔액과 그룹 한도 모두 |
| 인증 필요·인증 만료 | 로그인 필요 / Sign-in needed | 이 PC의 CLI 로그인 상태 |
| 접근 거부 | 접근 권한 확인 / Check permissions | 계정의 워크스페이스 접근 권한 |
| 유효하지 않은 입력·레퍼런스 | 입력값 확인 / Check inputs | 설정과 레퍼런스 파일 |
| 요청 횟수 제한 | 요청 한도 초과 / Rate limit reached | 잠시 후 요청 상태 확인 |
| 외부 서비스 오류 | 서비스 오류 / Service error | 서비스와 제출 상태 확인 |
| 연결 실패·응답 시간 초과 | 통신 확인 필요 / Check connection | 연결과 제출 상태 확인 |

카드·리스트·캔버스·결과 묶음·히스토리는 같은 표시 함수를 사용한다. 정보창에는 원인과 해결
방법, 접어서 볼 수 있는 오류 원문을 제공한다. 앱의 기존 한국어/영어 설정에 따라 문구를 바꾸고,
에이전트 콘솔에는 짧은 한글/영어 제목과 한국어 조치를 함께 표시한다.

분류는 명시적인 오류 구문만 허용한다. `제출 진단:` 뒤의 진단에서 `— cmd:` 명령 인자를 제외하고,
JSON의 사용자 입력 필드·프롬프트·URL·스택 추적은 분류 근거로 쓰지 않는다. 타임아웃·파싱 실패의
부분 출력은 원인 추정에 쓰지 않는다. 모르는 원인은 기존 중립 실패 안내로 남기며,
`recovery_required`의 기본 표시만 `HF 확인 필요`에서 `제출 확인 필요`로 바꾼다.

### 바꾸지 않는 안전 계약

- **오류 분류는 제출 여부나 과금 여부의 증거가 아니다.** `generate create` 뒤 `job_id`가 없으면
  종전대로 `recovery_required`이며 자동 재실행하지 않는다. 명시적 미제출 확인과 기존 조사 조건을 유지한다.
- DB·API·원본 오류 반환 형식·실행 단계·폴링·재시도 조건은 변경하지 않는다. 과거 기록은 다시
  쓰지 않고 현재 화면에서 해석한다. 성공·취소·NSFW·실제 진행 상태를 오래된 오류로 덮지 않는다.
- 레퍼런스 업로드 캐시 무효화는 실제 오류 본문만 본다. 크레딧·인증·권한 오류에서
  `--mode omni_reference` 인자 때문에 캐시를 지우지 않는다. 실제 레퍼런스 오류의 기존 처리는 유지한다.
  `detail`/`error.detail`, `mediaId` 등 기존 진단 형식을 지원하며, 캐시 검사에서만 스택의 경로 줄을
  건너뛰고 마지막 실제 오류를 검사한다. 원인 표시 분류는 스택 출력의 추정을 계속 포기한다.
- 에이전트는 계속 표준 라이브러리만 쓰는 단일 파일이다. 분류 사례의 단일 출처는
  [공통 JSON fixture](../frontend/tests/fixtures/generationErrorCases.json)이며 Python/TS 테스트가 함께 읽는다.
  이 fixture는 테스트 전용이며 배포 에이전트의 실행 의존성이 아니다.

### 검증

| 검증 (2026-09-16) | 결과 |
|---|---|
| 프런트 전체 (카드·정보창·히스토리 등 실제 컴포넌트 모의 렌더 포함) | 145개 파일, 1,285개 통과 |
| 에이전트 + 상태엔진·요청 usecase·권한 계약 | 226개 통과 |
| 공통 오류 분류 사례 | Python/TS 동일 fixture 47개 통과 |
| 타입·아키텍처 검사·프로덕션 빌드·공백 검사 | 통과 |
| 실제 브라우저 육안 검사·유료 생성·운영 서버 적용 | 실행하지 않음 |

기존 테스트의 Windows 경로 escape 경고 1개와 기존 프런트 번들 크기 경고는 남아 있다.
둘 다 이 변경 범위의 실패는 아니며 관련 없는 코드를 변경하지 않았다.

Claude 독립 리뷰 후 레퍼런스 캐시 복구 범위와 NSFW 종료 사유 보존을 보완했다. 추가로
한영 분류의 줄바꿈·아포스트로피 차이, 취소 라벨의 단일 출처를 맞췄다. `no_match`는 외부 작업이
절대로 없다는 보장이 아니므로 원인 해결과 직접 미제출 확인을 안내하도록 문구를 정리했다.
보완 코드 재검토에서 **승인·필수 수정 없음**을 받았으며, 완료+옛 복구 단계가 함께 온 경우에도
실패/재실행 패널이 나타나지 않는 회귀 테스트를 포함했다.

새 CLI 오류 표현은 보수적으로 미분류 처리하므로 발견 시 공통 fixture와 양쪽 분류를 함께 보완한다.
부분 편집에서 이미 발생한 오류 문자열은 기존 화면 상태 구조를 유지하여 발생 당시 언어로 남는다.
09-16 구현 단계에는 커밋·푸시·배포와 실제 크레딧 사용·운영 DB 수정은 포함하지 않았다.

### 최종 병합 점검 (2026-09-17)

- 백엔드 전체 **2,747개 + 800 subtests 통과**, Windows 심볼릭 링크 권한 부족 1개 제외.
- 프런트 전체 **145파일/1,285개**, 구조·타입·빌드·공백 검사 통과.
- 임시 DB에서 비용 없는 제출 중단·재시작 드릴 `ok=true`, `paid_cli_called=false`.
- 실제 컴포넌트/CSS의 격리 브라우저에서 한국어/영어 카드 10종(오류 9종+미분류), 목록,
  상세 원인/해결 방법, 원문 접기/펼치기와 가로 넘침 없음을 확인했다. 유료 오류 재현은 하지 않았다.
- 전체 테스트 준비에서 전역 DB/외부 복구 설정 충돌과 빈 임시 DB 미생성을 수정한 뒤 다시 통과했다.
  제품 코드는 변경하지 않았으며 임시 DB 준비의 검사 의미·사용자 DB 격리도 독립 승인받았다.
- 최종 독립 검토의 병합 차단 결함 없음. Jay가 dev 커밋·푸시·main 병합·릴리즈·NAS 게시를 승인했다.
  서버 적용은 제외한다. 실제 릴리즈 버전/해시는 고정 릴리즈 폴더의 게시 보고서를 기준으로 한다.

## 11. 삭제 대상의 추적 종결과 명시적 복원 (2026-09-17)

- owner: Codex
- reviewer: Claude (설계 4차 합의, 독립 코드 리뷰 핵심 계약 승인)
- status: 완료 — 격리 계약 검증, 운영 적용 제외
- touched_paths: `backend/app/repo/_common.py`, `event_journal.py`, `generations.py`, `trash.py`, `backend/app/usecases/gen_requests.py`, `agent_push.py`, 관련 시험·운영 로그 뷰어, 이 문서
- updated: 2026-09-17

### 서로 다른 두 종결 증거

생성물 본체가 사라진 terminal 결과만 추가 판정한다. 살아 있는 생성물의 기존 결과 수거·지연
재조회는 그대로다. 요청 ID·생성물 ID·소유 계정은 같은 트랜잭션 안에서 다시 대조한다.

| 증거 | 응답 | 변경 범위 |
|---|---|---|
| 현재 휴지통 행의 정확한 `job_id` 일치 | `target_retired` | 해당 non-terminal 요청 하나를 `canceled`로 종결하고 최초 종결 마커 보관 |
| 본체·휴지통 모두 없고 정확한 gen/rid/job 앵커 이벤트 존재 | `stale_tracker_released` | 그 job의 에이전트 추적만 해제. 현재 도메인 행·이벤트 변경 없음 |
| 둘 다 증명하지 못함 | `rejected` | 도메인 행·이벤트 변경 없음 |

휴지통에 다른 job이 있으면 과거 앵커로 우회하지 않는다. 새 두 응답의 `applied`와
`asset_saved`는 항상 false다. 에이전트는 HTTP200이고 `released_job_id`가 자신이 보고한
job과 같을 때만 해당 추적을 해제한다. 성공 결과 저장 ACK와는 구분한다.
실제 `request_status`를 재조회해 반환하므로 이미 done/failed/canceled인 요청을 강제로 취소하지 않는다.

`provider_terminal` 마커는 해당 요청을 이번에 종결한 경우에만 처음 기록하며, 다른 요청의
마커·손상된 기존 마커도 덮어쓰지 않는다. 원격 제공자의 새 URL을 자산으로 저장하지 않는다.
`generation_target_retired`·`generation_tracker_released`·`generation_target_unverified` 운영 로그로
판정을 관측하며, historical/rejected 경로는 관측 목적으로 DB 이벤트를 새로 쓰지 않는다.

### 명시적 휴지통 복원

마커의 rid/gen/job, `canceled` 상태와 전용 종결 사유, 다른 활성 요청 부재가 모두 맞을 때만
생성물과 해당 요청을 함께 변경한다. 가드 실패 시 둘 다 이 분기에서 변경하지 않는다.
기존 삭제 마커보다 이 종결 마커를 우선한다.

- 실패 종결: 실패 상태로 복원한다.
- 성공 종결 + 이미 보유한 사용 가능 자산: 완료 상태로 복원한다.
- 성공 종결 + 보유 자산 없음: 요청 verifying/생성물 running으로 복원하여 기존 job을 다시 수거한다.
  새 유료 제출은 하지 않는다. `/media/` 자산은 로컬 파일 존재도 확인하며, 보유 원격 URL은 유지한다.

### 행동 변경과 남은 한계

- 의도적 변경은 둘이다. 대상이 없는 non-terminal 요청의 success+자산 없음은 종전의
  not_ready/요청 갱신에서 rejected/무변화로 바뀐다. 휴지통 same-job 종결은 해당 rid 하나를 canceled로 만든다.
  초기 32개 설계 모델만으로 이 구현 경계를 검증한 것으로 주장하지 않는다.
- 초기 설계의 모든 경로 바이트 동일 주장과 request_status 고정 canceled 표기는 철회했다.
  도메인 무변화와 별개로 휴지통 연결 시 스키마 보장·레거시 job_id 백필은 수행될 수 있다.
- 영구삭제 뒤 남은 tracking 정리(기존 부팅 reconcile 책임), 구 에이전트의 추적 슬롯 점유,
  `_safe_code` 밖 job ID의 앵커 false-negative, 기존 done 처리의 gen_id 단위 UPDATE는 이번에 해결하지 않는다.
- ATTACH된 두 WAL 파일의 프로세스 크래시 시 물리적 원자성은 보장하지 않는다.
- 로컬 파일이 사라진 done 생성물도 해당 non-terminal 요청 마커가 있으면 복원 때 verifying으로
  내려갈 수 있다. 재수거 후보는 기존 `origin='local'` 조건에 한정된다.
- 실패 종결 사유는 기존 서버 오류와 같은 한국어 고정 문구다. 프런트 번역 범위를 새로 넓히지 않는다.
- retire의 소유권 근거는 살아 있는 `gen_request.account_email`이며 휴지통 creator_uid와의
  추가 교차 검증은 하지 않는다. 둘이 손상돼 불일치하는 데이터까지 방어한다고 주장하지 않는다.

신규106개·관련441개+6 subtests를 격리 환경에서 검증하고 Claude 코드 승인을 받았다.
후속 운영 로그 표시 3종과 회귀 보강은 E3 138개·기존 로그 48개, 총186개를 통과했다.
핵심 제품6파일은 독립 승인본과 같고, 통합 담당자가 표시3줄·시험 변경과8파일 해시를 대조했다.
상세 근거는 [종합 점검 장부](PROGRAM_AUDIT_2026-09-17.md)에 둔다.
실제 유료 생성·운영 DB·설치본에는 적용하지 않았다.
