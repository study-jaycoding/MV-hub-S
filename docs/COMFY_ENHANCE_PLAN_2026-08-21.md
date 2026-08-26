---
updated: 2026-08-21
status: draft
---

# Comfy 강화 계획 v2 (2026-08-21) — 클로드 초안 → 코덱스 방향검토 반영 합의안

> **상태: 보류 (2026-08-21 Jay 결정).** 구현 미착수. 재개 시 이 문서가 계약의 뼈대.
>
> **인증 프로브 결과(2026-08-21, 가짜 키만 사용 — 진짜 키 미전송):**
> `GET https://api.comfy.org/customers/events` 는
> ① 무인증 → 401 "No Authorization header found"
> ② 가짜 X-API-Key → 401 "No Authorization header found" (**키 헤더를 인식조차 안 함**)
> ③ 가짜 Bearer → 401 "Invalid token" (**Authorization: Bearer JWT 전용**)
> → 우리 백엔드가 가진 Comfy Cloud API 키(X-API-Key)로는 청구 조회 불가.
> **Phase 2(비용 자동 수집)는 Comfy 가 API 키 청구 조회를 열어줄 때까지 조건부 보류.**
> Phase 0+1(실행시간·출처)은 인증 문제 없음 — 재개 시 A범위부터.

합의: 코덱스 4쟁점 B안 전부 채택(초안의 per-generation 비용 저장은 중복합산 결함 — 폐기).
근거는 코덱스 리뷰(파일:줄)에 있음. 이 문서가 구현 계약의 뼈대.

## 핵심 교정 (초안 대비)
1. **비용은 generation 이 아니라 "실행(run)" 단위로 저장.** 한 Comfy 실행이 출력 여러 개 →
   generation 여러 개를 만든다. 비용을 각 generation 에 복사하면 출력 수만큼 뻥튀기된다.
   또 실패·텍스트전용·미저장 실행도 과금될 수 있어 generation 이 아예 없을 수 있다.
   → 신규 테이블: `comfy_run`(실행 1건) / `comfy_run_generation`(실행↔생성물 N:N) /
     `comfy_billing_event`(실행당 비용 이벤트 0~N, event_id 멱등).
   → 기존 real/est_credits 집계는 HF 전용 유지. Comfy 는 provider+unit 로만 그룹집계, 전체 합산 금지.
2. **비용 수집 = durable 비동기 reconciler.** 완료 poll 에서 한 번 더 조회는 슬롯만 오래 점유하고
   비동기 청구 지연을 못 잡는다. 완료 상세에 비용 있으면 즉시 저장, 없으면 영속 큐 등록 →
   별도 reconciler(backoff·재시작복구·watermark, 배치3 원장 패턴 재사용)가 billing feed 를
   cursor 로 동기화. event_id 멱등.
3. **외부 청구 REST 계약 확인이 Phase 2 선행조건.** /jobs/{id}(공식 ComfyUI)는 execution_start/
   end_time·workflow·outputs 만 주고 credits_used/gpu_seconds 는 없음(코덱스 실측). 청구는 다른
   경로(프론트 배포물 단서: `GET /customers/events?page=&limit=`, base URL·인증 X-API-Key 와
   다를 수 있음). → 유료 실행 없이 확인: Jay 계정 Billing/Usage Logs 화면 DevTools Network 캡처
   1회(새로고침만) 로 base·경로·인증·pagination·필드(event_id/job_id/credits_used/gpu_seconds/
   복수여부) 를 마스킹 fixture 로 확보. 이게 없으면 Phase 2 착수 불가.
4. **Phase 0 신설(연결키 부재 해결).** 백엔드는 prompt_id 를 주는데 프론트 실행결과·저장 payload
   가 버린다(sceneComfyExecutor.ts·comfyApi.ts). 실행↔저장 생성물을 잇는 run_id 가 없으면 아무
   것도 귀속 못 한다.

## 필수 안전 (코덱스 지적 위험)
- **HF 거래 매칭 오염 차단**: _match_transactions 는 generator 필터가 없고 거래 model 이 비면
  모델 비교도 통과 → Comfy 생성물이 HF 크레딧에 잘못 붙을 수 있음(현재도 잠재). Phase 0 에서
  매칭 후보를 HF positive filter.
- **Comfy prompt_id 를 generation.job_id 에 넣지 말 것**: HF 삭제검증이 job_id 만 보고 provider
  미확인 → Comfy 가 HF 삭제대상이 됨. 현재 안전한 이유가 job_id=NULL 이라서다. run 연결은 별도.
- **provenance 는 최종 wf(파라미터·미디어 주입 후)에서 추출**, 프론트 원본 아님. 원문 저장 금지
  (프롬프트·로컬경로·커스텀노드 비밀 포함) → canonical hash + 모델/노드타입/seed allowlist 요약만.
  telemetry 로 원문 전송 금지(유출).
- **elapsed_seconds 의미 보존**: 기존 = 프론트 요청→수신. 서버 실행시간은 별도 필드
  (execution_seconds/end_to_end_seconds/timing_source) 로, 덮어쓰지 말 것.
- **MANAGE off 시 _pm 생략**: provenance 가 핵심이면 manage 무관 core 저장 위치 필요.
- **team telemetry/team_generation_fact 에 generator/comfy 비용 차원 없음**: 팀 대시보드까지면 별도 설계.
- **billing event 복수 가능**(GPU + partner node API) → 단일 cost_native 축약 전 실측 계약 필요.

## Phase (수정)
- **Phase 0** — run_id 연결(백엔드 prompt_id→저장까지 전달) + comfy_run 저장구조 + 실행시점
  target(local/cloud) 스냅샷 저장(현재는 현재설정 조회라 사후 변경에 취약) + HF 매칭 positive filter.
- **Phase 1a** — 로컬 서버 실행시간(/history messages) + 최종 wf provenance 요약(hash+모델/노드/seed).
  단위·비용 없음, 즉시 이득.
- **Phase 1b** — 검증된 Cloud job 실행시간 필드(있으면).
- **Phase 2** — (쟁점3 계약 확인 후) billing feed·gpu_seconds·credits_used → comfy_billing_event +
  reconciler + 대시보드 provider 분리 표시. gpu_seconds 는 비용API 종속이라 Phase1→2 로 이동.
- **Phase 3** — 워크스페이스 달러(get_usage_report)·사전 견적(estimate_credits) 별도 패널.

## Jay 결정 필요
1. **범위**: 어디까지? (A: Phase 0+1 만 = 실행시간·출처, 비용 없이 / B: Phase 2 비용까지 /
   C: Phase 3 달러·견적·팀 대시보드까지). 비용(2~3)은 클라우드 쓸 때만 의미(로컬 공짜).
2. **Phase 2 선행**: Jay 가 Comfy 웹 Billing/Usage 화면에서 DevTools Network 캡처 1회 제공
   가능한지(유료 실행 0, 새로고침만). 이게 있어야 청구 REST 계약 확정 → Phase 2 착수.
3. **팀 대시보드 포함 여부**: telemetry/team_generation_fact 에 provider 차원 추가할지.
