---
updated: 2026-08-26
status: review-required
---

# 규모 확장 로드맵 (Scale Roadmap)

> 아키텍처 검토(2026-07-04, 클로드+코덱스)에서 "규모 커지면 할 것"으로 분류된 4항목의 실행 설계.
> **지금 대공사할 항목이 아니다.** 각 항목의 (a)착수 트리거 (b)접근 (c)리스크·순서 (d)지금 저렴한 선행을 고정한다.
> 소규모 내부도구 맥락 — 규모 신호가 오기 전에는 착수하지 않는다(과설계 경계).
>
> **대조 기준**: 본문의 수치는 작성 시점 값이다. 항목별로 아래를 직접 보고 판단한다.
>
> | 항목 | 대조할 코드 |
> |---|---|
> | A. 대형 파일 분리 | 실제 파일 줄 수를 직접 센다(`repo/`·`routers/`·`services/`) |
> | B. id≠job_id 통일 | `repo/id_resolve.py`·`generation_sync.py`·`share.py` — 아래 실측 명령 |
> | C. durable outbox | `repo/manage_telemetry.py`·`services/telemetry_drain.py` |
> | D. 중앙 fact/index | `repo/manage_telemetry.py` 의 `build_telemetry_facts`, `manage_db.py` |

---

## 요약: 지금 vs 나중

| 항목 | 지금 저렴한 선행(해둘 것) | 규모 신호 전엔 손대지 말 것 |
|---|---|---|
| **A. 대형 파일 분리** | 새 코드의 미래 모듈 소속 섹션 정리, `from app import repo` facade 유지, 대형 파일에 새 기능 안 붙이기 | 대규모 파일 이동 전체 |
| **B. id≠job_id 통일** | 변환 지점(아래 정의) 확인 + 신규 추가 금지, 새 API는 `generation.id`만 | 실제 id 마이그레이션 |
| **C. durable outbox** | `/api/ingest` 멱등 테스트 강화, outbox 스키마 초안 문서화 | agent outbox 전면 전환 |
| **D. 중앙 fact/index** | fact 필드 민감도 등급 주석, "검색/통계 캐시(권한 원본 아님)" 문서화 | 비공개 작업 중앙 검색 |

---

## A. 대형 파일 분리

2026-08-05 리아키텍처 브랜치에서 충돌·리뷰 범위 문제가 실제 착수 트리거로 확인되어 1차 분리를 수행했다.

- `generations.py`의 조회·행 보강·facet·계보·ID 해석·CLI 동기화는 `generations_query`·`generation_rows`·`facets`·`history`·`lineage`·`id_resolve`·`generation_sync`로 분리된 상태다. 공용 레퍼런스 쓰기는 `generation_references`가 맡는다.
- `manage.py`의 스키마·텔레메트리·거래 매칭·분석 조회·작업 CRUD를 각각 `manage_schema`·`manage_telemetry`·`manage_transactions`·`manage_analytics`·`manage_tasks`로 분리했다. 기존 `from app.repo import manage` 호출은 파사드로 유지한다.
- `manage.py`는 약 1,600줄에서 분할됐다(현재 `repo/manage.py` 1,079줄 — 2026-08-26 실측). `manage_tasks`는 컷 일괄 조회·관리 허브 소요시간 폴백·담당자 트랜잭션을 함께 소유하며, 기존 파사드 테스트와 브라우저 작업탭 스모크로 경계를 고정한다.
- `routers/assets.py` 분리는 아직 보류다. 파일 시스템·watcher·업로드가 함께 있어 실제 Assets 스모크가 선행되어야 한다.

**(a) 착수 트리거**: 같은 파일에서 작업 충돌 반복 / 신규 기능이 계속 이 파일에 붙어 리뷰 범위 비대 / 수정 시 테스트 영향 예측 곤란 / 신규 개발자 파악 지연.

**(b) 접근** (repo `__init__` re-export 파사드 유지, 무중단):
- `generations.py` → 읽기 계열·계보·ID 해석·`generation_sync`(synced upsert/known-jobs) **완료**, 남은 로컬 쓰기/fulfillment 분리는 최종 감사 후 필요할 때만 진행
- `manage.py` → `manage_schema` · `manage_telemetry` · `manage_transactions` · `manage_analytics` · `manage_tasks` **완료**
- 라우터: `generation.py` → history/comments/media/meta 분리, `assets.py` → mounts/upload/meta/comments 분리

**(c) 리스크·순서**: 순환의존이 핵심 — `trash.py`가 참조하는 `_delete_generation` 등은 먼저 `generation_write`(또는 `generation_core`)로 빼야 함. 순서: **독립 영역(comments/history) 먼저 → sync/write → read/hydrate 마지막**(read는 shared helper가 많음).

**(d) 지금 선행**: 새 함수에 "미래 모듈 소속" 섹션 주석, private helper 용도별 이름 정리, facade import 유지, **대형 파일에 새 기능 추가 자제 리뷰 규칙**.

---

## B. id ≠ job_id 통일

현황: Phase 0a·0b(origin 컬럼 + 신규 동기화 행 UUID) 완료.
(설계 근거: `docs/DESIGN_id_unification.md`)

**변환 지점의 정의**: `id` 와 `job_id` **어느 쪽으로 와도 같은 행을 찾는** 조회다.
`job_id IS NULL OR job_id=''` 같은 **상태 검사는 변환 지점이 아니다**.

형태가 셋이라 한 줄 정규식으로 정확히 세지 못한다 — `id=? OR job_id=?` 비교,
`id IN (...) OR job_id IN (...)` 목록, `g.id=x.y OR g.job_id=x.y` 컬럼 조인.
아래로 후보를 좁힌 뒤 **눈으로 확인**한다. 2026-08-26 기준 실제 이중 조회가 있는 곳은
`repo/` 아래 **8개 파일** — `id_resolve`(4) · `share`(3) · `projects`(3) ·
`generation_sync` · `generations_query` · `manage_telemetry` · `share_state_intents` ·
`workspace_assignments`(각 1). `gen_requests` 는 `job_id` 비어있음 검사만 있어 해당하지 않는다.

```powershell
git grep -nE "\bOR\b[^;]{0,40}\bjob_id\b" -- backend/app/repo |
  Select-String -NotMatch "IS NULL|job_id\s*=\s*''"
```

> [!NOTE]
> 2026-08-26 실측: **8개 파일 / 15곳**. 아래 착수 트리거(20~25곳)에는 **아직 못 미친다.**
> 본문에 오래 남아 있던 "17곳"은 근거를 확인할 수 없는 값이었고, 넓은 정규식으로 세면
> `job_id` 비어있음 검사까지 섞여 20곳으로 부풀려진다. 위 정의(어느 쪽으로 와도 같은 행을
> 찾는 조회)에 맞는 것만 세야 한다.

**(a) 착수 트리거**: 변환 지점이 20~25곳 이상 증가 / 공유·복원·히스토리 id 매핑 버그 반복 / 외부 API·중앙 인덱스가 안정 앵커 요구.

**(b) 접근**:
- Phase 1(레거시 관측): `id<>job_id`·`id=job_id`·`job_id NULL` 분포를 진단 로그로 수집, 변환은 `resolve_generation_id`/`finalize_id_map` 사용처로 고정, **신규 직접 SQL 금지**
- Phase 2(uuid 앵커 전환): 외부 입출력은 항상 `generation.id`, `job_id`는 속성/검색키로만, 공유 번들에 `local_id`+`job_id`+`origin` 명시(구버전 호환)
- Phase 3(변환기계 제거): UI/API의 job_id 직접 접근 제거, `id=? OR job_id=?` → `id=?`+명시 조회로 축소, 호환 윈도우 후 fallback 제거

**(c) 리스크·순서**: 가장 위험 = 공유 번들·history edge·trash restore·server/local id 매핑. 진단·테스트 먼저, 데이터 마이그레이션 마지막. **구버전 번들 최소 1릴리스 호환**.

**(d) 지금 선행**: 위 실측 목록을 기준선으로 유지 + 신규 `id OR job_id` 추가 금지, 새 API는 `generation.id`만 받음, `job_id`는 "외부 HF 속성" 주석 통일.

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
