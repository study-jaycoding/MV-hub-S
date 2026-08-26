---
updated: 2026-08-24
status: active
---

# 공유/골드 상태 desired-state reconciliation 설계 v2 (배치 3)

작성: 클로드 초안(2026-08-20) → 코덱스 xhigh 적대 리뷰(P0 6건·P1 3건) → v2 반영.
기준 커밋 299eb853. 상태: **구현 완료 — 이 문서가 현행 계약**
(2026-08-20 `838bdae2` 원장 + `9034aaa3` reconciler, 코덱스 구현·클로드 검토 후 dev 병합.
구현 위치 `backend/app/services/share_state_reconciler.py`, `backend/app/repo/share_state_intents.py`).
리뷰 원문: 세션 scratchpad `batch3_review_codex_out.md`.

## 0. 목표와 원칙

프록시(팀) 모드에서 공유/골드 상태는 "서버=권위, 로컬=미러"다. 현재는 미러 실패 처리가
경로마다 다르고 전부 1회성(비영속)이라, 실패 순간을 놓치면 영구 어긋남이 남는다.

원칙(리뷰 합의):
1. **converge-forward**: 서버가 확정한 사용자 의도는 로컬 장애 때문에 되돌리지 않는다.
2. **blind replay 금지**: 원장은 "명령"이 아니라 "예상 서버 상태 + 로컬 미러 dirty 표식"이다.
   워커는 저장된 의도가 아니라 **서버의 현재 권위 상태를 관측해 로컬에 적용**한다.
   (의도가 낡았으면 superseded 로 닫되, 관측한 서버 상태는 로컬에 반영한다 — 리뷰 P0-3)
3. **write-ahead**: 원장 기록은 서버 호출 **전**(prepared). 기록 실패면 서버를 건드리지 않고
   503. 서버 성공 후 크래시해도 재시작 워커가 서버 관측으로 수렴한다. (리뷰 §2-3)
4. **원자 적용 + CAS**: 로컬 {shared, final} 적용과 원장 종결은 같은 BEGIN IMMEDIATE
   트랜잭션에서, intent_seq 가 현재값일 때만. (리뷰 P0-1)
5. **직렬화**: 같은 생성물(canonical 원격 identity)에 대한 사용자 액션과 reconciler 는
   프로세스 내 per-key asyncio lock + 원장 claim(lease)으로 직렬화. (리뷰 P0-2)

## 1. 범위 (리뷰에서 확정한 미러 지점 전부)

| 경로 | 현재 | v2 |
|---|---|---|
| publish 번들 (publish.py:399-439, 벌크 포함) | 서버 성공 후 로컬 repo.publish, 실패 시 예외 | 서버 호출 전 대상 전부 원장 등록(한 트랜잭션), 응답 blocked_ids 만 CAS 취소 |
| finalize (share.py:305-343) | 미러 실패 시 서버 back-out 1회성 | back-out 삭제, 원장 수렴. 동반 발행은 합성 의도(아래 §4) |
| unfinalize (share.py:95-157) | 미러 실패 시 서버 재-finalize 1회성 | back-out 삭제, 원장 수렴 |
| unpublish (share.py:218-233) | 보상 없음(예외 전파) | 원장 수렴 (신규 보호) |
| 로컬 publish 라우트 (share.py:177) | 프록시 분기 없음 — 프록시 모드에서 로컬만 공유되는 API 구멍 | 프록시 모드면 400/의도 차단(UI 는 번들 경로 사용 — 외부 호출자 구멍 봉쇄) |

## 2. 원장 스키마 (로컬 허브 content DB 전용, 서버·번들·텔레메트리 미포함)

```sql
CREATE TABLE IF NOT EXISTS share_state_intent (
    intent_id            TEXT PRIMARY KEY,
    server_origin        TEXT NOT NULL,          -- 공유 서버 URL 정규화(권위 인스턴스 고정)
    server_generation_id TEXT,                   -- 서버 UUID(mutation 응답 out["id"] 로 보강)
    job_anchor           TEXT,                   -- job_id(로컬 행 재탐색·batch 조회 키)
    local_id             TEXT,                   -- NULL 허용(팀 탭 지연 회수), 매 처리 시 재탐색
    operation_kind       TEXT NOT NULL,          -- publish|unpublish|finalize|unfinalize|composite_finalize
    desired_shared       INTEGER NOT NULL CHECK(desired_shared IN (0,1)),
    desired_final        INTEGER NOT NULL CHECK(desired_final IN (0,1)),
    base_shared          INTEGER NOT NULL CHECK(base_shared IN (0,1)),   -- 합성 부분성공 정책용
    base_final           INTEGER NOT NULL CHECK(base_final IN (0,1)),
    expected_final_by    TEXT,
    intent_seq           INTEGER NOT NULL,
    status               TEXT NOT NULL CHECK(status IN (
        'prepared','pending','waiting_local','auth_required',
        'converged','superseded','blocked','rejected')),
    claim_token          TEXT,
    lease_until          TEXT,
    fail_streak          INTEGER NOT NULL DEFAULT 0,
    next_retry_at        TEXT,
    last_error_code      TEXT,
    observed_state_json  TEXT,                   -- 마지막 서버 관측 {shared,is_final,...}
    observed_at          TEXT,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    last_attempt_at      TEXT,
    CHECK (desired_final=0 OR desired_shared=1),
    CHECK (server_generation_id IS NOT NULL OR job_anchor IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ssi_origin_uuid
    ON share_state_intent(server_origin, server_generation_id)
    WHERE server_generation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ssi_origin_anchor
    ON share_state_intent(server_origin, job_anchor)
    WHERE job_anchor IS NOT NULL AND server_generation_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_ssi_due
    ON share_state_intent(status, next_retry_at);
```

- 생성물당 최신 의도 1행(원격 identity 기준 UPSERT, intent_seq 원자 증가 — SQL 한 문장).
- 계정 이메일 컬럼 불필요(계정별 DB) — 단 워커 claim 시 account key 캡처(§5).

## 3. 상태 전이

```
prepared ──서버 성공──> pending(관측치 보강) ──로컬 적용+CAS──> converged
   │                        │
   │ 서버 4xx 확정 거절      │ 로컬 적용 실패 ──> waiting_local(backoff)
   └──> rejected            │ 401 ──> auth_required (로그인 복구 시 재개)
                            │ 새 seq 등장 ──> superseded (단, 관측 상태는 로컬 반영)
서버 결과 불명(타임아웃) ──> prepared 유지(워커가 서버 관측 후 판정)
로컬 행 소멸·데이터 모순 ──> blocked (sync-status 노출)
```

- 종결(converged/superseded/rejected/blocked) 마킹·재시도 갱신 전부 `WHERE intent_seq=? AND
  claim_token=?` CAS.

## 4. 합성 publish+finalize (부분 성공 정책 — 서버 무변경 해법)

operation_kind='composite_finalize', base_shared/base_final 저장. 단계:
1. 원장 prepared(base 기록) → 번들 발행 → 발행 확정 표기 → 서버 finalize → pending.
2. 부분 상태(발행됨 + finalize 미확정)에서 중단·크래시 시: 워커가 서버 관측 →
   is_final=1 이면 forward(pending 처리). is_final=0 이고 base_shared=0 이면 **조건부 정리**
   (서버 unpublish 시도 — 사용자 의도의 골드가 좌절된 채 공유만 새는 것 방지, 기존 보상과
   같은 방향이되 이번엔 영속·재시도됨). base_shared=1 이면 공유 유지, final 만 rejected.
3. 조건부 정리 전 재확인: 그 사이 다른 세션이 골드 지정했으면(관측 is_final=1) 정리 금지.

## 5. 실행 주체 — 전용 async reconciler (로컬 허브에서 실행)

- syncer 편승 불가(공유 서버 전용) — **전용 asyncio task** 신설: 시작·종료 수명주기 명시,
  enqueue 시 즉시 깨움(Event) + 30~60s 폴링, 주기당 최대 10건, 서버 상태는
  `POST /api/generations/batch`(id OR job_id 해석 — job_id 단건 GET 404 함정 회피) 1회 조회,
  동기 SQLite·_proxy HTTP 는 to_thread.
- claim: claim_token+lease_until 로 단일 워커 선점. claim 시점에 활성 account key 캡처,
  작업 전체에 그 계정 컨텍스트 고정. server_origin ≠ 현재 설정이면 요청하지 않고
  authority_changed(=blocked 계열)로 중단. 토큰은 원장에 저장하지 않음.
- 적용 시 부수효과 멱등 재현: telemetry dirty(_touch_telemetry) + media_preservation 등록
  (shared/final 정책 동일).

## 6. 라우트 응답 의미 (프론트 오해 방지)

- 서버 성공 + 로컬 미러 대기: **200(서버 상태 본문) + 수렴 대기 표시**(응답 필드
  `mirror_pending: true`) — 503 을 주면 프론트가 실패로 표시해 사용자가 또 누른다
  (useGenerationCardActions.ts:97). 프론트는 mirror_pending 이면 성공 토스트 + 카드 상태는
  다음 수렴/재조회에 맡김.
- 원장 선기록 실패(서버 미호출): 503 유지 — 진짜 실패.

## 7. 외부 변경 재검사 (경계 명시)

converged 이후 다른 세션의 서버 변경은 이 원장의 책임 밖(서버에 단조 revision 이 없음).
원격 realtime reload 신호 수신 시 해당 생성물 재검사(있으면), 그 외는 다음 사용자 액션에서
자연 수렴. 완전 보장은 서버 share_state_rev 도입이 필요 — P2 로 기록(배치 10 문서화 대상).

## 8. 테스트 계약 (구현 전 고정 — 상태 전이표 포함)

기존 7건(v1) + 리뷰 추가 8건:
1. 옛 seq 워커의 늦은 적용이 로컬을 되돌리지 못함(적용+종결 단일 트랜잭션 CAS).
2. finalize 와 unpublish 교차 실행 — 생성물 잠금으로 직렬화, 로컬 {shared,final} 원자 적용.
3. 계정 전환 중 claim — 캡처된 계정 컨텍스트로만 접근, origin 불일치 시 중단.
4. 팀 UUID 카드의 늦은 local_id 등장 — job_anchor 재탐색으로 수렴.
5. publish 번들의 로컬 publish 실패 — 원장 수렴으로 로컬 공유 표식 복구.
6. write-ahead 직후(서버 호출 전) 크래시 — 워커가 서버 관측(변화 없음) 후 rejected 종결,
   로컬 무변경.
7. 합성: 발행과 finalize 사이 크래시 — base_shared=0 이면 조건부 정리, base_shared=1 이면
   공유 유지. 정리 전 관측에서 is_final=1 이면 forward.
8. 서버 상태가 batch 관측 직후 바뀜 — 적용 전 seq CAS 로 낡은 적용 차단(완전 보장은 §7 경계).

## 9. 배포·호환

- 서버(팀 허브) 무변경. 로컬 허브만 배포.
- 구버전 롤백: 원장 무시(잔존 무해). prepared/pending 잔존 행은 재업그레이드 시 워커가
  서버 관측 기준으로 정리.
- 로컬 publish 라우트의 프록시 차단은 동작 변화(외부 호출자만 영향, UI 무영향) — 커밋 메시지에 명시.
