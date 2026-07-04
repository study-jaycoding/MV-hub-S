# 규모 확장 로드맵 (Scale Roadmap)

> 아키텍처 검토(2026-07-04, 클로드+코덱스)에서 "규모 커지면 할 것"으로 분류된 4항목의 실행 설계.
> **지금 대공사할 항목이 아니다.** 각 항목의 (a)착수 트리거 (b)접근 (c)리스크·순서 (d)지금 저렴한 선행을 고정한다.
> 소규모 내부도구 맥락 — 규모 신호가 오기 전에는 착수하지 않는다(과설계 경계).

---

## 요약: 지금 vs 나중

| 항목 | 지금 저렴한 선행(해둘 것) | 규모 신호 전엔 손대지 말 것 |
|---|---|---|
| **A. 대형 파일 분리** | 새 코드의 미래 모듈 소속 섹션 정리, `from app import repo` facade 유지, 대형 파일에 새 기능 안 붙이기 | 대규모 파일 이동 전체 |
| **B. id≠job_id 통일** | `id=? OR job_id=?` 17곳 목록화 + 신규 추가 금지, 새 API는 `generation.id`만 | 실제 id 마이그레이션 |
| **C. durable outbox** | `/api/ingest` 멱등 테스트 강화, outbox 스키마 초안 문서화 | agent outbox 전면 전환 |
| **D. 중앙 fact/index** | fact 필드 민감도 등급 주석, "검색/통계 캐시(권한 원본 아님)" 문서화 | 비공개 작업 중앙 검색 |

---

## A. 대형 파일 분리

현황: `repo/generations.py` 2040줄/61함수, `repo/manage.py` 1277줄/37함수, `routers/assets.py` 1058줄/47함수.

**(a) 착수 트리거**: 같은 파일에서 작업 충돌 반복 / 신규 기능이 계속 이 파일에 붙어 리뷰 범위 비대 / 수정 시 테스트 영향 예측 곤란 / 신규 개발자 파악 지연.

**(b) 접근** (repo `__init__` re-export 파사드 유지, 무중단):
- `generations.py` → `generation_read`(list/get/stats/hydrate/facets) · `generation_write`(create/import/update/delete/restore/status) · `generation_sync`(synced upsert/known-jobs/fulfillment) · `generation_comments` · `generation_history` · `generation_media`
- `manage.py` → `manage_schema` · `manage_telemetry` · `manage_transactions` · `manage_tasks` · `manage_analytics`
- 라우터: `generation.py` → history/comments/media/meta 분리, `assets.py` → mounts/upload/meta/comments 분리

**(c) 리스크·순서**: 순환의존이 핵심 — `trash.py`가 참조하는 `_delete_generation` 등은 먼저 `generation_write`(또는 `generation_core`)로 빼야 함. 순서: **독립 영역(comments/history) 먼저 → sync/write → read/hydrate 마지막**(read는 shared helper가 많음).

**(d) 지금 선행**: 새 함수에 "미래 모듈 소속" 섹션 주석, private helper 용도별 이름 정리, facade import 유지, **대형 파일에 새 기능 추가 자제 리뷰 규칙**.

---

## B. id ≠ job_id 통일

현황: Phase 0(origin 컬럼) 완료. `id=? OR job_id=?` 변환 17곳. (근거: `docs/DESIGN_id_unification.md`)

**(a) 착수 트리거**: 변환 지점이 20~25곳 이상 증가 / 공유·복원·히스토리 id 매핑 버그 반복 / 외부 API·중앙 인덱스가 안정 앵커 요구.

**(b) 접근**:
- Phase 1(레거시 관측): `id<>job_id`·`id=job_id`·`job_id NULL` 분포를 진단 로그로 수집, 변환은 `resolve_generation_id`/`finalize_id_map` 사용처 17곳으로 고정, **신규 직접 SQL 금지**
- Phase 2(uuid 앵커 전환): 외부 입출력은 항상 `generation.id`, `job_id`는 속성/검색키로만, 공유 번들에 `local_id`+`job_id`+`origin` 명시(구버전 호환)
- Phase 3(변환기계 제거): UI/API의 job_id 직접 접근 제거, `id=? OR job_id=?` → `id=?`+명시 조회로 축소, 호환 윈도우 후 fallback 제거

**(c) 리스크·순서**: 가장 위험 = 공유 번들·history edge·trash restore·server/local id 매핑. 진단·테스트 먼저, 데이터 마이그레이션 마지막. **구버전 번들 최소 1릴리스 호환**.

**(d) 지금 선행**: 17곳 목록 문서화 + 신규 `id OR job_id` 추가 금지, 새 API는 `generation.id`만 받음, `job_id`는 "외부 HF 속성" 주석 통일.

---

## C. durable outbox 동기화

현황: `cli_bridge.list_jobs` size=100(CLI 상한, 페이지네이션 없음) → syncer가 매주기 최신 100 전량 재조회, 100-window 밖은 `gap_warning`만.

**(a) 착수 트리거**: 운영에서 `gap_warning` 자주 뜸 / 생성량 많아 100 window 밖 밀림 / "생성했는데 허브에 안 보임" 보고 / agent 껐다 켠 사이 완료 누락 반복.

**(b) 접근** (최소 변경):
- agent가 로컬 실행 완료 직후 `outbox`에 job 원본 JSON 먼저 기록 → 서버 `/api/ingest` 성공 ack 받으면 제거 → 재시작 시 재전송. 기존 `list --size 100` syncer는 **보조 reconciliation로 유지**.
- 저장: agent는 표준 라이브러리만 → 내장 `sqlite3` 추천(원자성·중복키·재시도 상태 관리 용이). JSONL은 crash 중간쓰기·중복제거·ack삭제가 번거로움.
- outbox 키: `job_id` unique + `status`/`attempts`/`last_error`/`created_at`/`payload_json`

**(c) 리스크·순서**: 중복 ingest는 이미 멱등이어야 함(먼저 테스트 강화). outbox→ingest→ack 순서 깨지면 무한 재시도/조기 삭제. 순서: **outbox 저장만 추가 → 재시작 재전송 → ack 삭제 → gap_warning 의존 축소**.

**(d) 지금 선행**: `/api/ingest` 멱등 테스트 강화, agent "전송 성공 기준" 문서화, outbox 스키마 초안만 문서화.

---

## D. 중앙 fact/index

현황: 계정별 DB 분리라 교차계정 조회 불가. `telemetry_outbox → manage_hub.db`로 팀 fact 부분 존재.

**(a) 착수 트리거**: PM/관리자가 "전체 계정/팀 결과물 검색" 요구 / 계정별 DB 순회 운영작업 발생 / 전사 통계가 현 fact로 부족 / 서버 공유물 검색 느려짐.

**(b) 접근**: 기존 telemetry fact 확장. 중앙 fact엔 **민감 원문 최소화** — `account_email`·`creator_uid`·`creator_name`·`local_gen_id`·`job_id`·`project_id`·`folder_path`·`model`·`status`·`sort_ts`·`is_shared`·`is_deleted`. prompt 전문은 별도 정책(기본 요약/옵트인). 권한: admin/PM=전체, member=본인+참여프로젝트+shared, **비공유 로컬 작업의 프롬프트·미디어 URL은 중앙에 안 넣음**.

**(c) 리스크·순서**: 중앙 fact가 커질수록 "로컬우선/선택발행" 원칙 침식 위험. 공유/관리 메타만 인덱싱, 비공개 전문 검색은 동의 없이 금지. 순서: **telemetry fact 보강 → 권한 필터 API → 검색 인덱스 → UI**.

**(d) 지금 선행**: fact 필드 민감도 등급 주석, "중앙 fact = 검색/통계 캐시이지 권한 판정 원본 아님" 문서화, fact push 누락·tombstone 테스트 유지.

---

## 원칙 (이 로드맵 착수 시 지킬 것)

- 4항목 모두 **규모 신호(트리거)가 실제로 관측된 뒤** 착수한다. 예측 착수(과설계) 금지.
- 각 항목은 **저렴한 선행**만 지금 해두어 나중 착수 비용을 낮춘다.
- 데이터 마이그레이션·agent 배포 전환은 항상 **진단·테스트·호환 윈도우** 뒤에.
- 중앙화(D)는 "로컬 우선·선택 발행" 근본 원칙을 침식하지 않는 선에서만.
