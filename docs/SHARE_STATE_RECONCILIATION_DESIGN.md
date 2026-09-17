---
updated: 2026-09-17
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
| publish 번들 (`publish.py` 의 `publish_bundle_to_server`, 벌크 포함) | 서버 성공 후 로컬 repo.publish, 실패 시 예외 | 서버 호출 전 대상 전부 원장 등록(한 트랜잭션), 응답 blocked_ids 만 CAS 취소 |
| finalize (`share.py` 의 `finalize`) | 미러 실패 시 서버 back-out 1회성 | back-out 삭제, 원장 수렴. 동반 발행은 합성 의도(아래 §4) |
| unfinalize (`share.py` 의 `unfinalize`) | 미러 실패 시 서버 재-finalize 1회성 | back-out 삭제, 원장 수렴 |
| unpublish (`share.py` 의 `unpublish`) | 보상 없음(예외 전파) | 원장 수렴 (신규 보호) |
| 로컬 publish 라우트 (`share.py` 의 `publish`) | 프록시 분기 없음 — 프록시 모드에서 로컬만 공유되는 API 구멍 | 프록시 모드면 400/의도 차단(UI 는 번들 경로 사용 — 외부 호출자 구멍 봉쇄) |

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
로컬 행 소멸 ──> waiting_local (최대 5회) ──> rejected (last_error_code=local_target_lost|local_target_missing)
(`blocked` 는 상태 집합에 예약만 돼 있고 현재 전이되지 않는다. sync-status 에 노출하지 않는다)
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
  작업 전체에 그 계정 컨텍스트 고정. server_origin ≠ 현재 설정이면 요청하지 않고 claim 을
  release 하며 `share_state_origin_mismatch` 로그만 남긴다(상태 변경 없음 — `authority_changed`/`blocked` 전이는 없다). 토큰은 원장에 저장하지 않음.
- 적용 시 부수효과 멱등 재현: telemetry dirty(_touch_telemetry) + media_preservation 등록
  (shared/final 정책 동일).

## 6. 라우트 응답 의미 (프론트 오해 방지)

- 서버 성공 + 로컬 미러 대기: **200(서버 상태 본문) + 수렴 대기 표시**(응답 필드
  `mirror_pending: true`) — 503 을 주면 프론트가 실패로 표시해 사용자가 또 누른다
  (`useGenerationCardActions.ts` 의 `onUnpublish`). 프론트는 mirror_pending 이면 성공 토스트 + 카드 상태는
  다음 수렴/재조회에 맡김.
- 원장 선기록 실패(서버 미호출): 503 유지 — 진짜 실패.

## 7. 외부 변경 재검사 (경계 명시)

converged 이후 다른 세션의 서버 변경은 이 원장의 책임 밖(서버에 단조 revision 이 없음).
원격 realtime reload 신호는 브라우저 재조회만 유발하고 원장을 재검사하지는 않는다(현재 미구현 — `remote_realtime.py`
는 데이터 없는 reload 신호만 넘기고 reconciler 를 깨우지 않음). 다음 사용자 액션에서 자연 수렴. 완전 보장은 서버 share_state_rev 도입이 필요 — P2 로 기록(배치 10 문서화 대상).

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

## 9. 초기 원장 도입 당시 배포·호환 (과거 기록)

이 절은 보류 축이 없던 초기 도입의 판단이다. 아래 §10의 보류 확장에는 그대로 적용하지 않는다.

- 서버(팀 허브) 무변경. 로컬 허브만 배포.
- 구버전 롤백: 원장 무시(잔존 무해). prepared/pending 잔존 행은 재업그레이드 시 워커가
  서버 관측 기준으로 정리.
- 로컬 publish 라우트의 프록시 차단은 동작 변화(외부 호출자만 영향, UI 무영향) — 커밋 메시지에 명시.

## 10. 공유 검토 보류 확장 (2026-09-17)

- owner: Codex (통합·구현), Claude (선행 설계·독립 리뷰)
- reviewer: Claude
- status: 완료
- updated: 2026-09-17
- touched_paths: 콘텐츠 스키마·마이그레이션·공유 라우트/repo·미러 원장/워커,
  목록/단건/배치 조회·모델, 라이브러리 카드/필터·관련 API/타입/스타일,
  관리 작업 조회/상태 표시, 공통 ConfirmQuestion/useOverlayDismiss·등급/공유 알림 번역,
  관련 테스트·이 문서/현황.
- 승인 범위: 사용자 선택 디자인과 공유 보류 동작의 로컬 구현·격리 검증.
  dev 재시작·운영 데이터 변경·커밋·푸시·배포는 포함하지 않는다. 기존 폴더 열기 미커밋 보존.

### 사용자 확정 UI

- 사용자 후속 요청으로 처음의 가로 2개/취소 버튼 디자인을 대체한다.
  공유 S는 세로 `해제 / 보류 / 최종`, 보류 S는 `해제 / 공유 / 최종`,
  최종 배지는 `해제 / 공유 / 보류`. 각 선택 후 해당 동작 확인 문구와 `Yes / No`로 확정한다.
  No·바깥 클릭·Esc는 변경 없이 닫고 별도 취소 버튼은 없다.
  후속 작은 카드 요청으로 우측 설명은 제거하고 아이콘+상태명 한 줄만 표시한다.
  최소 옵션 높이 30px·간격 4px이며 짧은 카드의 남은 공간만 스크롤하고 글자를 세로로 나누지 않는다.
  사용자 후속 요청에 따라 크기 상한을 제거하고 카드 안쪽 전체를 세 개의 같은 높이 행으로 채운다.
  container 단위로 글자·아이콘·간격도 비례 확대하며 Yes/No는 전체 폭을 1:1로 나누고 높이 28px를 유지한다.
  골드 배지의 별은 중앙 SVG다. 프레임은 바깥 카드의 색 면, 미디어·상태 바·확인창은
  내부 card-clip의 clip-path 하나로 자른다. 안쪽에 border-radius를 중복 적용하지 않는다.
  선택 전후 padding 1px·배치는 고정이며, 선택 시 클립을 2px 더 안으로 잘라 3px 프레임을 드러낸다.
  바깥 반경 14px = 여백 1px + 선택 클립 2px + 안쪽 반경 11px로 모서리 중심을 맞춘다.
  흰색 키보드 포커스 링·Resolve 강조는 기존 별도 표시를 유지한다.
- 등급 화살표는 기존 일반↑공유↑최종, 최종↓공유↓일반을 유지한다.
  보류는 ↓일반(공유 해제), ↑공유(보류 해제)이며 최종으로 바로 건너뛰지 않는다.
- 보류 버튼과 모든 보류 S는 `#c9384a` 바탕·흰 글씨. 기존 라임 S와 골드 최종 스타일 유지.
  카드 테두리는 바꾸지 않는다(다빈치 선택의 빨강 테두리와 별개).
- 상단 S 우클릭: 현재 S 바로 아래에 같은 가로 중심의 **반대 색 S 하나만**.
  라임 선택 시 빨강, 빨강 선택 시 라임을 보여준다. 상태 설명은 접근성 이름/툴팁에 제공한다.
  필터 색 선택은 카드 데이터 변경이 아니다. 기존 워크스페이스 필터와 AND로 적용한다.
- 작업 보드 순서: 생성·보류·공유·완료. 테이블·캘린더도 보류 상태를 표시한다.

### Codex 검토와 합의 후보

- 보류는 공유 사다리에 새 단계를 넣지 않고 공유 내부 검토 플래그로 둔다.
  `generation.is_held INTEGER NOT NULL DEFAULT 0` 한 열 추가. 별도 DB·미디어 다운로드·사유 입력 없음.
  지정자/시각은 기존 감사 이벤트를 활용한다. 구 INSERT는 기본값으로 호환된다.
- 서버가 권위, 로컬은 미러. 보류는 `shared && !is_final`에서만 유효하다.
  미공유·휴지통·미완료·최종에 보류 지정은 거절한다. 최종 지정은 같은 트랜잭션에서
  보류 해제+최종 지정, 공유 해제는 보류도 제거한다. 공유 재발행 번들은 검토 상태를 덮지 않는다.
- `POST /api/generations/{id}/hold`, `/unhold`. 검수 권한은 기존 최종 지정과 같다:
  프로젝트 supervisor/global admin, 프로젝트 미배정은 본인/admin. 기존 공유 해제 접근도 보존한다.
- 기존 계정 쌍 고정·대상 잠금·write-ahead·CAS 미러 재사용. 원장에 nullable
  `desired_held`/`base_held`를 추가하고 과거 NULL은 이 축을 변경/판정하지 않는다는 뜻이다.
  관측값에 `is_held`가 없으면 False로 추측하지 않는다. 미러 None은 기존 보존하되
  미공유 또는 최종 관측이면 무조건 보류를 해제한다. 보류 API의 확인 필드 누락은 업데이트 안내.
- 목록에 선택적 `review_filter=shared|held` 추가. 기존 `shared_only` 계약은 유지한다.
  shared는 라임 S(공유·보류 아님·최종 아님), held는 빨강 S(공유·보류·최종 아님).
  필터 미선택은 공유/보류/최종 모두 유지한다. 페이지를 자르기 전에 서버에서 거른다.
  구서버의 필터 무시/상태 필드 누락을 정상 결과로 위장하지 않는다. Resolve 자동 필터 해제는
  활성 토글만 해제하고 선택 색은 보존한다.
- 관리 자동 작업 파생 우선순위는 완료(any final) > 보류(any held) > 공유(any shared) > 생성.
  기존 완료 판정을 보존하며 각 컷의 배지는 실제 상태를 표시한다. PM 상태값 `hold` 추가,
  개인별 재집계도 같은 우선순위. 미공유 팩트는 보류를 추측하지 않는다.
- 선행 Claude 초안의 회색/사유 입력/보류→최종 차단/사이드바 별도 칩은 사용자 요청과 달라
  채택하지 않는다. 위 확정 디자인 및 직접 최종 전환을 우선한다.

### 검증 계획

- 구 스키마의 추가·재적용, 기존 상태 보존, 미공유/최종/휴지통 거절과 권한 분리.
- 보류/복귀/최종/공유 해제 전이 및 동시성, 재발행 시 보류 보존.
- 미러 실패/재시작 수렴/과거 의도 CAS/구서버 필드 누락에서 거짓 성공 방지.
- S 우클릭 단일 반대 버튼 수직 배치·중앙 확인창·취소 무변경·다중 선택/기존 해제 회귀.
- 필터 서버 페이지네이션·공간 권한 AND·늦은 응답 폐기, PM 세 뷰/개인 집계 일치.
- 임시 DB·모의 서버만 사용. 실제 dev 재시작과 운영 상태 변경은 하지 않는다.

### 조건부 검토에 대한 Codex 보완

- 이 확장은 §9와 달리 서버·클라이언트 모두 변경하며 **서버 먼저** 업데이트해야 한다.
  구프런트는 PM `hold`를 미지 상태 이름으로 표시할 수 있고 보드 열이 없으므로 완전한 보류 표시는
  새 클라이언트부터 지원된다. 실제 배포는 이번 작업 범위가 아니다.
- **릴리즈 호환 검토 추가(2026-09-17):** 새 열은 추가형이며 과거 원장의 nullable 보류 축과
  작업 활동 시각은 보존한다. 다만 구조 하위 호환이 보류 사용 후의 단순 구버전 복귀까지 보장하지는 않는다.
  직전 main `6a7430d1`의 원장 워커는 보류 축을 모르므로 진행 중 의도를 잘못 종결하거나
  구버전 상태 변경이 보류 표식을 남길 수 있다. 서버를 먼저, 이어서 작업자 앱을 업데이트한 뒤 보류를 사용한다.
  장애 시 상태 변경을 중단하고 현재 DB와 원장을 보존·백업하며 새 서버 유지 또는 수정판 복구를 우선한다.
  구버전/과거 DB 복원은 최신 작업 유실과 보류 의도를 별도로 검토하고 사용자 승인 후 수행한다.
  이 검토는 코드·마이그레이션·회귀 계약의 읽기 전용 독립 점검이며 운영 DB 복원 검증을 대신하지 않는다.
- 불변식은 repo의 `BEGIN IMMEDIATE` 안에서 공유·생성 완료·휴지통·최종 상태를 재검사해 강제하고,
  미러는 `{shared, final, held}` 세 축을 원장 종결과 **한 트랜잭션**으로 적용한다. 테이블 재작성 없음.
- `desired_held=NULL`은 오직 **이 의도가 보류 축을 주장하지 않는다**는 뜻이다. 과거 원장과
  새 publish(서버의 검토 상태를 유지)는 같은 의미이므로 추가 known 플래그는 필요하지 않다.
  새 finalize/unpublish/unfinalize는 `desired_held=False`를 명시한다. 미러는 값 유무와 관계없이
  최종 또는 미공유 관측이면 보류를 0으로 정규화하므로 hold 뒤 finalize가 덮어도 보류가 남지 않는다.
  관측에 boolean `is_held`가 있으면 의도의 NULL 여부와 무관하게 실제 서버값으로 미러한다.
  `base_held`는 확인한 값만 채우고 미확인은 NULL로 둔다. 종결 판정은 의도에 명시한 축만 비교하며,
  보류 축을 주장했는데 서버 필드가 없으면 성공 종결하지 않고 업데이트 필요 오류로 처리한다.
- 사용자가 후속 요청에서 **보류 카드도 직접 공유 해제 가능**으로 확정했다.
  기존 본인/admin 또는 프로젝트 supervisor 공유 해제 권한을 유지한다. 해제 시 held도 0이며
  다시 공유하면 일반 공유다. 보류→공유(공개 유지)는 기존 검수 권한을 요구한다.
- 목록 필터는 응답 헤더 `X-MVHub-Review-Filter: shared|held`로 적용 여부를 확인한다(빈 배열 포함).
  프록시는 각 페이지에서 헤더를 확인하고 없거나 다르면 409 업데이트 안내. 프런트도 확인한다.
  기존 `shared_only`와 새 `review_filter`가 함께 오면 AND이며 새 필터가 더 좁은 조건이다.
- 추가 회귀: hold 의도 뒤 finalize/unpublish의 새 의도가 덮어도 held 수렴, 구 원장 NULL 보존,
  명시 보류 관측값 누락 거짓 성공 차단, 사용자가 선택한 보류 공유 해제 정책.

### 후속 최종 카드 전환 설계 (Claude 조건부 승인 보완 반영)

- 선행 Claude 검토는 위 nullable 축·관측 기반 수렴에 승인했고, 남았던 공유 해제 정책은
  사용자 후속 요청으로 해소됐다. 이후 추가된 최종 카드의 3가지 전환을 별도 검토한다.
- `POST /api/generations/{id}/final-review`, body `state: unshared|shared|held`.
  기존 일반 unpublish의 최종 보호를 완화하지 않는다. UI에서 unfinalize 후 hold/unpublish를
  연속 호출하지 않고, 전용 API가 검수 권한 확인 후 하나의 `BEGIN IMMEDIATE`로 최종 해제와
  목표 공유/보류 상태를 함께 반영한다. 잠금 안에서 최종·done·휴지통 상태를 재확인하며
  이미 최종이 아니면 409로 재확인을 요청한다. 이 판정은 서버 트랜잭션에만 두며 허브 미러는
  원장 base 기록용으로만 읽는다. 드리프트(final인데 share 없음)의 경우 unshared는 삭제 0행을
  허용하고 shared/held는 기존 최종 지정처럼 share를 INSERT ON CONFLICT DO NOTHING으로 보강한다.
- 최종을 나가는 세 전환은 모두 기존 supervisor/global admin(미배정은 본인/admin) 권한이다.
  원장은 `final_review` operation에 목표 shared/final/held를 명시하며 별도 schema는 없다.
  프록시는 서버 응답 세 boolean 축 확인 후 CAS 미러, 필드 누락/통신 실패는 원장 관측 수렴.
  라우트 부재 404만 업데이트 안내하며 구서버에 2단계 전환으로 대체하지 않는다.
  기존 `_is_remote_generation_missing`으로 확인한 generation 부재 404는 unshared 목표에 한해
  미공유/최종 아님/보류 아님으로 수렴하고 shared/held 목표는 원래 404를 전파한다.
- 커밋 뒤 실제 변경 축마다 기존 감사 이벤트를 남긴다: generation.unfinalized와
  unshared면 generation.unpublished(share가 있었을 때), held면 generation.held.
  드리프트 복구로 share를 보강한 경우 generation.published도 기록한다.
- 일반 shared/held의 전환은 기존 hold/unhold/unpublish/finalize를 재사용한다.
  최종 지정의 원본 보존 동작·기존 공유 번들·비공유 생성물의 발행 경로는 바꾸지 않는다.
- §7의 이미 종결된 로컬 미러를 다른 PC의 후속 변경이 갱신하지 않는 제한은 held에도 동일하다.
  이번 범위에서는 목록/단건/WS 재조회와 진행 중 원장 수렴을 제공한다.

### 독립 구현 리뷰와 후속 보완

- Claude는 세 축 원자성·권한·CAS·구서버 검사·확인 UX를 승인했고, 혼합 배포의 unfinalize 응답 누락
  P1을 지적했다. 기존 unfinalize에도 세 boolean 검사를 적용해 누락은 503 업데이트 안내와
  미종결 원장으로 남긴다. 필드 누락을 거짓 converged로 닫지 않는다.
- 요청과 다른 서버 관측은 실제값을 미러하되 원장은 superseded로 종결한다. 보류/복귀/최종 이탈의
  호출자는 409 재확인 안내를 받아 잘못된 성공 건수로 세지 않는다.
- 단건 검토 훅도 실제 canFinalize를 전달하며 기존 버튼 권한·서버 권한을 함께 적용한다.
  관리 활동 라벨은 기존 한국어 원문 규칙에 hold를 명시하고, 상태/컷 툴팁의 한영 선택은 유지한다.
- remote_review_state_unsupported의 자동 읽기 재관측은 최대 600초 간격으로 계속한다.
  임의 횟수 후 rejected로 닫으면 서버 적용 여부를 알 수 없는 의도가 영구 누락되므로 채택하지 않았다.
  서버 업데이트 후 자연 수렴하며 원격 변경 명령은 재실행하지 않는다. 사용자 요청 실패에는 업데이트
  안내가 있고 원장에는 last_error_code를 보존한다. 별도 sync-status 오류 노출은 후속 운영 개선 후보다.
- 후속 한정 재검토에서 Claude는 unfinalize 응답 검사·불일치 관측의 superseded/409 처리와
  문서의 재관측 정책을 승인했다(남은 차단 문제 없음). 프런트 권한 전달·관리 라벨 보완은 이
  재검토 범위 밖이며 해당 변경은 별도 자동 회귀 검사로 확인했다.

### 최종 검증과 적용 상태

- 백엔드 전체: **3,207개 +815 subtests 통과, 1개 제외**(394.76초). 기존 Windows 심볼릭 링크
  권한 항목을 제외했다. 이 전체 실행 이후 응답 검사·불일치 처리의 후속 수정과 새 회귀 2개를
  포함한 관련 **102개**를 다시 통과했다(20.39초).
- 최초 전체 실행의 server_move 7건은 테스트용 `CONTENT_HUB_DB` 고정 경로와 기존 fixture의
  충돌이었다. 해당 환경변수를 제거하고 임시 `CONTENT_HUB_DATA`만 지정해 관련 26개와 전체
  실행을 재검증했다. 사용자 데이터·운영 서버는 사용하지 않았다.
- 선행 프런트 전체: **160파일/1,447개 통과**, 타입 포함 빌드·아키텍처 검사 통과.
  작은 카드 고정 크기와 큰 카드의 제한된 비례 확대, SVG 별 정렬, 부모 단일 clip과 선택 선의
  단일화는 DOM/CSS 선언 회귀 검사에 포함했다. 기존 번들 크기 경고는 유지된다.
- 사용자 후속 확대 이미지에서 기존 13px 곡률 보정 후에도 모서리 틈이 남은 것을 확인했다.
  기본 border 1px와 inset shadow 2px를 별도로 그리던 구조를 선택 시 단일 3px border로 바꿨다.
  기존 border 자리에는 동일한 padding을 두어 그리드/리스트의 선택 전후 콘텐츠 여백을 보존한다.
  흰색 포커스/라임 외곽 링·Resolve 강조는 변경하지 않았다. 관련 21개와 위 전체 검사를 통과했다.
  이 CSS 후속은 앞선 Claude 상태 동기화 재검토 범위 밖이며 별도 픽셀 확인은 아직 남아 있다.
- 자동 브라우저 연결은 설치된 런타임 모듈 부재로 실패했고 컴퓨터 제어 대안도 모듈을 찾지
  못했다. 따라서 실제 브라우저의 크기별 픽셀·클릭 검증 완료를 주장하지 않는다.
- dev 재시작은 사용자의 기존 요청대로 보류했다. 프런트 변경과 별개로 새 보류/최종 전환 API는
  백엔드 재시작이 필요하다. 실제 팀 사용에는 서버 먼저, 이어서 클라이언트 업데이트가 필요하다.
  커밋·푸시·main 병합·배포·유료 호출·실제 생성물 상태 변경은 하지 않았다.

### 공통 확인 UI·번역·모서리 후속 보완 (2026-09-17)

- owner: Codex, reviewer: Claude, status: 완료. 앞 절의 선행 CSS 검증 상태를 아래 최신 결과로 보완한다.
- Claude 설계와 Codex 보완안의 합의 후 구현했다. 질문/Yes/No는 ConfirmQuestion,
  바깥 클릭/Esc 취소는 useOverlayDismiss로 공통화했다. HistoryBoardNode의 중복 JSX를 제거하고
  작업 공간·히스토리/캔버스·씬 파생본 창이 같은 GenerationConfirmOverlay를 사용한다.
  공유&리뷰는 기존 3개 선택 메뉴를 유지하면서 확인 본문과 취소 처리만 공유한다.
  기존 단일/더블 S 클릭 규칙·콜백·권한은 바꾸지 않았다. Yes 중복 호출은 차단한다.
- 단건 질문·기존 S 툴팁·등급 제목/본문/버튼·공유/최종 결과 및 로컬 동기화 안내를 번역했다.
  단계 제목은 ‘단계 올리기/내리기’, 설명에는 일반·보류 전이를 포함한다. gradeStep은
  선택적 번역 콜백만 받으며 React/i18n에 의존하지 않는다. 콜백 생략 시 한글 계약을 유지한다.
  서버 오류 원문과 사용자 폴더명은 번역하거나 치환하지 않는다.
- 선택 프레임의 덧그린 가상 테두리를 제거하고 위 단일 내부 clip 구조로 변경했다.
  그리드·리스트·Comfy 대기 카드의 모든 콘텐츠를 같은 내부 래퍼로 옮기고 직계 자식 CSS도 맞췄다.
- 최신 프런트 전체 **162파일/1,492개 통과**, 타입 포함 빌드·아키텍처 검사 통과.
  기존 일부 테스트의 React act 경고와 빌드의 큰 번들 경고는 남지만 실패는 없다.
- 브라우저 도구 연결을 복구해 백엔드/프록시 없는 임시 화면에서 실제 컴포넌트를 검사했다.
  그리드/리스트 × 140/220/420/141.3333px 컨테이너 × CSS zoom 1/1.25/1.5의 **24조합**에서
  선택 전후 카드·클립·썸네일 위치/크기가 같았다. 실제 셀은 컨테이너의 테스트 여백만큼 작다.
  최소/최대 크기 × 공유/보류/최종 **6조합**의 메뉴 3등분·스크롤 없음, 동일 폭 28px Yes/No,
  작업 공간·히스토리 영문 확인창과 한영 등급 안내를 확인했다. 3배 확대 이미지에서 모서리도 확인했다.
  이는 격리 컴포넌트 검증이며 운영 앱/실제 미디어/Windows 디스플레이 DPI 전 조합 검증은 아니다.
- 백엔드·사용자 DB·공유 서버는 이 후속 변경에서 수정/호출하지 않았다. 재시작·커밋·배포 없음.
- Claude 독립 구현 리뷰는 차단 문제 없이 승인했다. 부가적으로 긴 리스트(패널 1090×126px)에서
  폭 기준 확대가 431px 높이까지 넘치는 것을 확인해 메뉴만 size 컨테이너/cqmin(짧은 변)으로 바꿨다.
  같은 브라우저 조건에서 스크롤 높이 126px·3개 행 각 약 39.33px로 재확인했고 집중 64개가 통과했다.
  이 마지막 CSS 변경도 Claude 후속 설계 리뷰에서 승인했다. 임시 확인 화면 3개·브라우저 탭·5180 서버는 정리했다.

## 11. 공유 폴더 상태별 개수 (2026-09-17)

- owner: Codex, reviewer: Claude, status: 완료, updated: 2026-09-17.
- touched_paths: `repo/projects.py`, `routers/projects.py`, `projectApi.ts`, `folderTreeModel.ts`,
  `ProjectSection.tsx`, `FilterSidebar.tsx`, 공통 폴더 배지/스타일·타입·번역·회귀 테스트·이 문서/현황.
- 초기 해석(아래 후속 정정 전): 공유&리뷰 **폴더 행**에 `★1 · R2 · 5`를 표시한다. 세 값은 최종 1·보류 2·일반 공유 5로
  상호 배타적이다. 최종/보류 0건은 생략하고 마지막 일반 공유 숫자는 굵게 표시한다.
  모두 0이면 기존 `-`를 유지한다. 상위 폴더는 하위 포함, 프로젝트/미분류 행의 전체 합계는 그대로 둔다.
- 합의·구현: 기존 `counts`와 함께 `review_counts`를 team 단건/batch에 추가한다.
  정확 경로별 `{final, held, shared}`를 동일 SQL의 COUNT/SUM에서 생성해 스냅샷 불일치를 피한다.
  최종 우선으로 분류하고 share 존재·휴지통 제외·기존 팀 가시성·프로젝트 제한을 보존한다.
  my·invalid tab 정규화·구 클라이언트 숫자 응답은 유지한다. 새 DB/열/마이그레이션은 없다.
- 프런트는 정확 경로를 정규화하고 기존 트리처럼 부모에 한 번만 누적한다. 페이지의 카드만 세지 않는다.
  구서버에서 review_counts가 없으면 전체 합계임을 명시하며 일반 공유 0/전체로 추정하지 않는다.
  상태 변경의 기존 libraryChanged 재조회와 요청 순번 보호를 재사용하고 탭/계정 문맥이 다른 값은 숨긴다.
- 운영 서버·사용자 DB 쓰기·재시작·커밋·배포는 범위 밖이다. 임시 DB와 모의 API로 검증한다.

### 구현·검토·검증 결과

- 기존 총계와 상세를 한 응답/프런트 스냅샷으로 교체한다. 스냅샷 키에는 계정·서버·워크스페이스·탭·
  프로젝트 목록·조회 준비 여부를 포함하고 렌더 시점의 범위와 다르면 숫자를 숨긴다. 응답 순번과 범위가
  일치할 때만 수락한다. 최종/보류/공유 전환의 기존 libraryChanged 이벤트로 함께 갱신한다.
- 상세는 각 값이 0 이상의 안전한 정수이고 합계가 같은 응답의 전체 수량과 일치할 때만 사용한다.
  하나라도 누락/불일치하면 **해당 프로젝트 전체**를 `전체 N / Total N`으로 표시한다. 총계에 없는
  상세 경로는 무시한다. 상세를 임의로 0이나 일반 공유로 보정하지 않는 보수적인 정책이다.
- 초기 FolderReviewCount는 금색 ★, 붉은 R, 굵기 700의 일반 공유 숫자를 표시했다. 한영 툴팁으로 세 값과
  하위 폴더 포함 여부를 설명한다. 캔버스 등 공통 트리의 다른 호출자는 명시적으로 opt-in하지 않아
  기존 숫자 표시가 유지된다. 프로젝트 루트·미분류 합계 역시 기존 의미 그대로다.
- Claude 설계와 Codex 적대적 검토를 합의한 뒤 구현했고, Claude 독립 코드 리뷰에서 차단 문제 없이
  승인받았다. 단일 SQL·기존 권한 동치·정규화/조상 합산·구서버·범위 전환·늦은 응답을 대조했다.
- 관련 백엔드 **90개 통과**(12.70초, 신규 20개 포함), 최신 프런트 전체 **163파일/1,510개 통과**
  (16.59초), 타입 포함 빌드·아키텍처 검사·diff 공백 검사 통과. 새 트리/UI 집중 32개도 통과했다.
  기존 빌드의 큰 번들 경고는 남아 있다.
- 백엔드/프록시 없는 격리 브라우저에서 실제 FolderTreeView를 사용해 200/160px 폭, 한영 툴팁,
  0건 생략/빈 폴더, 공유 수량 변경과 부모 누적, 구서버 Total, 작업 공간 숫자 유지와 굵기 700을 확인했다.
  좁을 때 폴더명은 기존 말줄임을 쓰며 수량은 행 안에 들어온다. 운영 앱/전체 DPI 조합 검증은 아니다.
- 새 서버 집계가 필요하므로 실제 적용은 서버 먼저 업데이트한다. 구서버 응답은 추정 없이 전체 수량으로
  표시한다. 사용자 지시에 따라 dev 재시작을 보류했으며 커밋·푸시·배포·실제 상태 변경은 하지 않았다.

### 후속 정정 — 마지막 숫자는 전체 수량 (2026-09-17)

- 사용자가 마지막 숫자는 상태별로 나눈 일반 공유가 아니라 **최종·보류까지 포함한 전체 수량**임을 정정했다.
  현행 표시는 `R1 · 2`(전체 2개 중 보류 1개), `★1 · R1 · 3`(전체 3개 중 최종 1·보류 1)이다.
  앞의 두 값은 전체에 포함되는 보조 정보이며 0일 때 생략한다. 빈 폴더는 기존 `-`를 유지한다.
- FolderReviewCount의 마지막 값과 한영 툴팁을 기존 `total`에 연결했다. ★/R은 0.9em·굵기 400,
  전체 숫자는 기본 크기·굵기 700으로 구분한다. 색과 생성자 필터·하위 폴더 누적은 유지한다.
  내부 `review_counts`의 상호 배타적 세 값과 합계 검증은 그대로이며 DB/API 변경은 없다.
- touched_paths: `FolderReviewCount.tsx`, `project-sidebar.css`, `i18n.ts`, `folderReviewCounts.test.tsx`,
  이 문서·현황. 작은 표시 수정으로 Codex가 자체 검토했으며 별도 독립 리뷰는 수행하지 않았다.
- 집중 **52개**, 프런트 전체 **164파일/1,535개**(15.81초), 타입 포함 빌드·구조 검사 통과.
  기존 큰 번들 경고는 유지된다. 이번 변경의 실제 앱 육안 확인·서버 변경·재시작·커밋·배포는 하지 않았다.

## 12. 생성자 선택과 폴더 수량 연동 (2026-09-17)

- owner: Codex, reviewer: Claude, status: 완료, updated: 2026-09-17.
- touched_paths: `backend/app/repo/projects.py`, `backend/app/routers/projects.py`,
  `frontend/src/lib/projectApi.ts`, `FilterSidebar.tsx`, `sidebar/ProjectSection.tsx`, 관련 테스트·번역·이 문서/현황.
- 요청: 생성자 선택 시 해당 생성자의 폴더별 수량만 표시하고 선택 해제 시 기존 전체 수량으로 돌아간다.
  폴더 구조는 유지하며 해당 생성자의 작업이 없는 폴더는 `-`다. 최종·보류·공유와 초록색 신규 `+N`,
  프로젝트 행·미분류 수량도 같은 선택을 따라야 전체/특정 생성자가 섞이지 않는다.
- 원인: 카드 쿼리는 `filters.creator_uid`를 전달하지만 ProjectSection의 폴더 수량 요청·조회 키와
  team-fresh 요청에는 생성자가 없다. `project.count`·미분류 역시 필터 없는 상위 조회 값이다.
- 검토 원칙: 생성자 선택은 기존 본인 범위/팀 가시성에 **AND**로 추가하는 조회 조건이지 권한 신원이 아니다.
  DB 스키마·원본·저장 상태를 바꾸지 않는다. 선택이 없으면 기존 호출/표시를 유지한다.
  구서버가 선택을 무시한 숫자는 사용하지 않고 안내한다. 생성자/계정/공간 전환 중 이전 숫자는 숨긴다.
- 범위: 기존 프로젝트 목록·폴더 구조·공간 필터 계약은 유지한다. 상태/검색/색상 필터 전체에 대한
  새 사이드바 facet 설계는 포함하지 않는다. 운영 서버·사용자 DB 쓰기·재시작·커밋·배포 없음.
- 변경 전 회귀: 프런트 폴더/신규 배지 관련 41개, 백엔드 집계/가시성/구조 관련 47개 통과.

### 설계 합의

- Claude 최초안은 프로젝트 목록 조회까지 생성자를 전달하는 방식이었다. Codex는 기존 App/목록 상태를
  바꾸지 않고 선택 시에만 폴더 batch 응답에 프로젝트/미분류 합계를 함께 반환하는 좁은 보완안을 제시했다.
  Claude는 공용 WHERE 확장·프록시 전달·본인/선택 생성자 분리 조건을 포함해 합의했다.
- 요청은 `creator_uid`, 응답 적용 확인값은 `creator_filter_uid`의 정확한 UID다. 선택 없는 응답은
  기존 그대로이며 프록시는 확인값을 만들어 붙이지 않는다. 구서버가 선택을 무시하면 숫자는 숨기고 안내한다.
- 선택 시 단일 SQL의 정확 폴더 그룹에서 `counts`, 팀 `review_counts`, `project_counts`, `unassigned_count`를
  만든다. NULL/빈 폴더도 프로젝트 합계에는 포함하되 폴더 배지에는 포함하지 않는다. NULL 프로젝트는
  미분류로 합산한다. 프로젝트 목록이 비어 있어도 미분류 조회는 가능하다. 조회 권한과 UID 조건은 AND다.
- fresh 응답에 작성자 UID만 추가하고 클라이언트가 선택에 맞춰 +N/모두 확인을 함께 거른다.
  미지원 필드 누락이면 선택 중 신규 배지를 숨기되, 알려진 NULL 작성자는 단순히 제외한다.
  신규 조회의 단일 비행 키에 계정/서버/공간 문맥을 넣어 다른 문맥의 진행 중 요청을 공유하지 않는다.
- CreatorSection의 기존 자동 선택 해제 규칙과 다른 카드 필터의 사이드바 적용은 변경하지 않는다.

### 구현 및 검증

- 생성자 선택을 FilterSidebar → ProjectSection → folder-counts API까지 전달하고 기존 조회 스냅샷 키에
  포함했다. 프로젝트·미분류는 같은 응답에서 교체하며 폴더 미지정 생성물도 프로젝트 합계에 포함한다.
  펼친 보관함의 프로젝트 행도 선택 중에는 batch에 포함해 필터 없는 숫자를 보여주지 않는다.
- 응답 에코 불일치는 409 업데이트 안내, 합계/숫자 필드 누락·음수·비정수·폴더합보다 작은 프로젝트합은
  502 조회 실패 안내로 처리한다. 전체값/0으로 바꾸지 않으며 수량 대신 `—`와 재조회 버튼을 제공한다.
  실제 0건 응답은 정상 수량 0/폴더 `-`로 표시한다. 선택 해제는 기존 전체 수량으로 돌아간다.
- 신규 목록도 조회 범위 키를 붙인 스냅샷으로 보관하며 생성자 전환 중 이전 배지를 숨긴다.
  +N과 모두 확인 대상은 동일 필터 목록이다. 선택되지 않은 사람의 확인 기록을 같이 변경하지 않는다.
- 수정 전 새 API 회귀는 6개 중 5개가 실패해 전달/확인값/문맥 합류 문제를 재현했다. 수정 후 새 API·
  실제 React 사이드바 집중 **31개 통과**. 클릭 선택/해제·늦은 성공/오류·재조회·빈 프로젝트·보관함·
  신규 작성자 필드 누락/NULL·모두 확인 대상을 포함한다.
- 전체 프런트 **164파일/1,531개 통과**(16.20초), 관련 백엔드 **86개 통과**(11.90초, 신규 30개 포함),
  타입 포함 빌드·구조 검사·diff 공백 검사 통과. 기존 큰 번들 경고는 유지된다.
- 임시 DB/모의 응답만 사용했다. 격리 브라우저의 실제 FilterSidebar/ProjectSection/CreatorSection에서
  작업자 A/B 선택과 해제, 0건 폴더 `-`, 폴더·프로젝트·미분류 동시 전환, 한영 구서버 안내를 확인했다.
  210px 패널에서 숫자와 안내가 표시됨을 확인했으며 운영 앱/실제 서버 연결 검증은 아니다.
- Claude 독립 코드 리뷰는 차단 문제 없이 승인했다. 기존 batch 100개 상한은 유지한다. 선택 중
  펼친 보관함까지 합쳐 상한을 넘으면 일부 숫자를 추정하지 않고 조회 실패를 안내하는 제한이 남는다.
  사용자 요청 없는 상한 확대·부분 집계는 하지 않는다.
- 임시 확인 파일 3개와 탭·5180 테스트 서버는 정리했다. 사용자 지시대로 dev 재시작과 실제 서버 적용,
  커밋·푸시·배포는 하지 않았다. 실제 사용에는 앱/공유 서버 업데이트가 필요하다.
