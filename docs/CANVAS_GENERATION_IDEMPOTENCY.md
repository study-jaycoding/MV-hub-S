---
updated: 2026-08-26
status: active
---

# 캔버스 생성 재시도 멱등성 계약

기준일: 2026-08-16

대상 위험: `RL-06`

구현 기준: `dev`의 `df2d1fd5`

## 목적

같은 캔버스 생성 버튼이 네트워크 지연, 더블클릭, 브라우저 재시도, 서버 재시작 때문에 여러 번
전달돼도 **생성 placeholder와 실제 생성 요청을 한 번만 만든다.** 충돌을 일반 서버 오류(500)로
숨기지 않고, 같은 요청이면 기존 생성을 이어가며 다른 요청이면 409로 안전하게 중단한다.

## 권위 키와 상태 흐름

캔버스 시도의 권위 멱등 키는 `account_email + canvas_attempt_id`다. 다음 값도 모두 같아야 같은
요청으로 인정한다.

- `generation_id`
- `scene_id`
- `card_id`
- 생성 종류(`create` 또는 `regenerate`)
- 최초 명령 계약(모델, 프롬프트, 파라미터, 참조, 워크스페이스, 재생성 옵션)

상태는 다음 순서로 이동한다.

```text
preparing 예약 → placeholder 저장·검증 → pending 활성화 → 에이전트 claim 이후 기존 생성 상태 흐름
```

`preparing`은 DB 예약만 잡은 내부 상태다. 이 상태의 요청은 에이전트가 가져가지 않으며 캔버스에도
완료된 연결로 노출하지 않는다. placeholder와 최종 실행 payload가 모두 준비된 뒤에만 `pending`으로
한 번 전환한다.

## 중단·재시도 처리

| 중단 위치 | 다음 요청의 처리 |
|---|---|
| 예약 전 | 새 예약부터 시작 |
| 예약 뒤, placeholder 저장 전 | 같은 예약을 이어서 placeholder 생성 |
| placeholder 저장 뒤, pending 활성화 전 | 소유자·상태·명령을 확인하고 같은 placeholder 활성화 |
| pending 활성화 뒤 | 기존 generation을 그대로 반환, 중복 신호·저널 없음 |
| 두 요청이 동시에 placeholder 저장 시도 | DB 충돌 뒤 권위 예약을 다시 읽고 승자의 generation을 공유 |
| 같은 attempt에 다른 카드·명령 사용 | 자동 합치지 않고 409 충돌 반환 |

서버 재시작 복구도 같은 검사를 사용한다. 재생성은 원본→자식 계보가 실제로 존재해야 하며,
import 직후 종료돼 덮어쓰지 못한 prompt·model·color·auto tag를 최초 명령 계약대로 다시 적용한 뒤
`pending`으로 전환한다.
예외: payload 의 `workspace.scope` 가 `team`·`personal` 이 아니면(미확정) `pending` 으로 되돌리지 않고 generation 을
**`failed`** 로 종결한다(RL-04 fail-closed, `usecases/gen_requests.py` `repair_canvas_generation_links`). 재생성은
사용자가 명시로 한다.

## 지켜야 하는 불변식

1. 같은 계정·attempt에는 `gen_request`가 최대 1건이다.
2. 같은 시도의 `generation`도 최대 1건이다.
3. 에이전트 깨우기와 생성 저널은 pending 활성화에 성공한 요청만 각각 1회 수행한다.
4. 다른 사용자나 다른 카드의 placeholder를 ID만 알고 가져올 수 없다.
5. placeholder 없는 오래된 `preparing` 예약은 10분 뒤 조회 과정에서 정리한다.
6. placeholder가 존재하는 `preparing`은 서버 재시작 정리에서 실패 처리하지 않고 복구 대상으로 보존한다.

## 검증 기록

| 검증 | 결과 |
|---|---|
| 동시 동일 요청 2개 | generation 1건, request 1건, signal 1회, journal 1회 |
| 활성화 직전 강제 중단 후 직접 재시도 | 같은 generation을 pending으로 복구 |
| 활성화 직전 강제 중단 후 서버 재시작 복구 | 같은 generation 연결·활성화 |
| placeholder 없는 예약 | 화면 미노출, 10분 초과 시 정리 |
| 같은 attempt의 변경된 명령·카드 | 새 generation 없이 거절 |
| 재생성 중단 복구 | 같은 자식과 계보 유지, 옵션 복원 |
| 대상 백엔드 | 19개 통과 |
| 대상 프론트 | 1개 파일, 2개 통과 |
| 격리 브라우저 | 로그인·워크스페이스·캔버스 로드, 콘솔 오류 0건 |

실제 유료 Higgsfield 생성은 이 검증에서 실행하지 않았다. 내부 중복 방지 계약은 확인했지만 외부
CLI 왕복과 과금 결과는 Gate 6에서 별도로 검증한다.

## 현재 Gate 상태

`df2d1fd5`에서 구현과 대상 검증을 마쳤고, 전체 Gate를 막던 RL-25도 `ce346560`에서 해결했다.
백엔드 전체 742개, 프론트 전체 522개, 프론트 구조 검사와 프로덕션 빌드가 통과했으므로
`RISK_REDUCTION_PLAN_2026-08-15.md`의 RL-06 상태는 ✅다.
