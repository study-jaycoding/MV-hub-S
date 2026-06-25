# 설계: id 이중성(uuid ↔ job_id) 통일

> 적대적 리뷰 ① 후속. **설계 문서 — 아직 구현 전.** Phase 0 만 저위험·고가치라 먼저 착수 가능.

## 1. 문제

- 로컬 DB: `generation.id` = uuid, `generation.job_id` = 힉스필드 잡 id.
- 발행(`export_bundle`): 앵커를 `g.job_id or g.id` 로 정함 → 서버의 `generation.id` = job_id(있으면).
- 가져오기(`import`): 수신측이 `id = job_id` 로 INSERT.
- 동기화: 같은 잡을 동기화본으로 넣을 때 `id == job_id` 행을 만든다(`set_job_id`/`upsert_synced`).

→ **한 DB 안에 "uuid인 id"와 "job_id인 id"가 공존.** 그래서:
- `finalize_id_map` / `resolve_and_get` 의 `id=? OR job_id=?` 변환이 곳곳에 필요.
- `LIMIT 1` 이 어느 행을 잡을지 **비결정적**(로컬 행의 job_id 가 수신 행의 id 와 같을 수 있음).
- comment-counts·overlay·library 등에서 srv↔local 되매핑 반복.

이 변환 기계는 잘 짜였지만 **우발적 복잡도**다 — 발행 앵커를 uuid 로 통일하면 통째로 사라진다.

## 2. 목표

생성본 1개당 **로컬·서버에서 동일한 안정적 id(uuid)**. 단 다음을 보존:
- **동기화 멱등성**: 같은 힉스필드 잡을 두 PC 가 각각 동기화해도 한 행으로 수렴.
- **기존 공유 데이터 호환**: 이미 배포된(job_id 앵커) 번들을 받은 쪽이 깨지지 않음.
- 번들 import·계보(history)·코멘트.

## 3. 제안 — uuid 단일 앵커, job_id 는 속성

`generation.id` = uuid 를 **로컬·서버 양쪽의 정식 id** 로 통일. `job_id` 는 **동기화 멱등용 속성**(UNIQUE 인덱스)일 뿐, 절대 식별 앵커로 쓰지 않는다.

| 영역 | 현재 | 변경 |
|---|---|---|
| `export_bundle` 앵커 | `job_id or id` | **`id`(uuid)** + job_id 는 속성으로 동봉 |
| 서버 schema | id=job_id 가능 | `id`=uuid, `job_id` **UNIQUE**(nullable) |
| `import` | `id=job_id` INSERT | `id=번들 uuid` INSERT(재import 멱등=uuid) |
| 동기화 행 생성 | `id==job_id` | **새 uuid id + job_id 속성**. 매칭은 `ON CONFLICT(job_id)` |
| 변환 기계 | finalize_id_map 등 | **제거**(서버·로컬 id 동일이라 평문 id) |

## 4. 마이그레이션 (대공사 핵심)

두 집단을 처리해야 한다:

**(a) 로컬 `id==job_id` 행** (구버전 동기화/가져오기 산물)
- uuid 새로 발급 → `UPDATE generation SET id=uuid` + **모든 FK 재지정**:
  `history(parent_gen_id,child_gen_id)`, `share(generation_id)`, `asset(generation_id)`,
  `gen_reference(generation_id)`, `gen_request(gen_id)`, `generation_comment(gen_id)`,
  `generation_comment_seen`, `gen_tag(generation_id)` …
- `job_id = 옛 id` 로 보존. SQLite 는 ON UPDATE CASCADE 가 없어 **명시 재지정 + 트랜잭션 + 백업** 필수.

**(b) 이미 배포된 번들(서버 job_id 앵커)**
- 수신측 로컬은 job_id 앵커를 참조 중 → 서버 id 를 uuid 로 바꾸면 그들이 깨진다.
- → **호환 윈도우**: import 에서만 `id=? OR job_id=?` 를 한시 유지(구 번들 수용). 신규 export 는 uuid.

## 5. 단계별 롤아웃

> ⚠️ **정정(코드 재검토 후)**: 아래 Phase 0 은 당초 '저위험'으로 적었으나 실제론 그렇지 않다.
> `id==job_id` 는 단순 코딩 관습이 아니라 **"동기화본 vs 로컬본" 판별자로 load-bearing** 하다:
> - `reconcile_duplicates`(generations.py:829-830): `synced = job_id==id`, `local = job_id!=id`.
> - `set_job_id`/`apply_local_fulfillment` dup 탐지: `WHERE id=job_id`.
> 따라서 동기화 행을 uuid 로 바꾸려면 이 판별을 **명시 마커(origin)** 로 교체하는 선행 단계가
> 필요하고, 그건 중복방지(가시적·데이터 영향) 경로라 레이스 테스트가 필수다.

- **Phase 0a ✅완료**: 명시 컬럼 `origin('synced'|'local')` 추가 + 백필(`id==job_id` ⟺ synced).
  reconcile/set_job_id/apply_local_fulfillment 의 판별을 `id==job_id` → `origin='synced'` 로 교체
  (동작 동치 — 테스트 PASS). 동기화/로컬 구분이 id 값과 **분리**됨.
- **Phase 0b ✅완료**: `upsert_synced` 의 INSERT 가 동기화/번들수신 행을 `uuid id + job_id 속성`으로
  생성(더는 `id==job_id` 아님). 멱등 매칭=`job_id` 컬럼, 번들 계보=`_find_id_by_job(job_id)→uuid`.
  **새 데이터는 id 이중성 없음.** 레거시 `id==job_id` 행은 update 분기로 그대로 호환.
  (검증: 단일DB 4시나리오 + 번들 export→import 라운드트립 계보 PASS.) `job_id` UNIQUE 인덱스는
  전이 중 중복 허용 레이스와 충돌해 보류(현 동작은 origin 기반 사후 reconcile 로 충분).
- **남음 — Phase 1~3**: 레거시 `id==job_id` 행을 uuid 로 마이그레이션(FK 재지정·백업) → export/import
  앵커를 uuid 로 → `finalize_id_map` 등 변환기계 제거. 변환기계는 레거시 호환 위해 그때까지 유지.
- **Phase 1**: 백필 마이그레이션 — 레거시 `id==job_id` 행을 uuid id 로 재작성 + FK 재지정(트랜잭션·백업). 로컬·서버 동시 또는 호환 윈도우로.
- **Phase 2**: export/import/finalize 앵커를 uuid 로 전환. import 의 `id=? OR job_id=?` 만 구 번들 호환으로 플래그 뒤에 유지.
- **Phase 3**: 변환 기계(finalize_id_map job_id 분기·overlay 키잉·comment-counts 되매핑 등) 제거.

## 6. 리스크 / 롤백

- FK 재지정은 **트랜잭션 + 사전 백업**(`/api/backup`) 필수. 실패 시 복원.
- 서버·로컬 **락스텝** 또는 호환 윈도우 필요.
- 이미 배포된 번들 → import 호환 심(작고 영구) 수용.
- 비결정성은 현재 `resolve_and_get` 가 완화 중이라 **당장 깨지진 않음** → 서두를 필요 없음, 안전하게 단계 진행.

## 7. 권장

**Phase 0 먼저** — 새 데이터의 이중성 발생을 멈추는 저위험 변경이라 독립 배포·측정 후, Phase 1~3(실제 정리)은 마이그레이션·테스트를 충분히 준비해 착수. Phase 0 의 핵심 변경점은 `upsert_synced_generation` / `set_job_id` 가 동기화 행을 `id==job_id` 대신 `새 uuid + job_id 속성`으로 만들도록 하는 것.

## 8. Phase 0 영향 파일(착수 시)

- `backend/app/repo/generations.py`: `upsert_synced_generation`(동기화 행 id 생성), `set_job_id`(이미 BEGIN IMMEDIATE 적용됨).
- `backend/schema.sql` / `db.py _migrate`: `job_id` UNIQUE 인덱스.
- 검증: 같은 job_id 두 번 동기화 → 한 행(uuid)으로 수렴, 로컬 생성+동기화 충돌 → 중복 없음.
