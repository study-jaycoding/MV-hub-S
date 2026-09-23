---
updated: 2026-09-23
status: draft
---

# 크레딧 할당량 · 사용량 드릴 설계

owner: Claude · reviewer: Codex(적대적 검토 요청) · status: 설계 중
touched_paths: `backend/app/repo/manage_credit_plan.py` · `backend/app/repo/manage_schema.py` ·
`backend/app/repo/manage_member_table.py` · `backend/app/manage_db.py` · `backend/app/routers/manage.py` ·
`backend/app/repo/manage_transactions.py` · `backend/app/repo/identity.py` ·
`frontend/src/components/manage/CreditPoolSection.tsx` · `WorkspaceUsageDashboard.tsx` · `MemberTable.tsx` ·
`frontend/src/lib/creditPlan.ts` · `lib/manageApi.ts` · `lib/usageReport.ts`

> [!WARNING]
> 이 문서가 건드리는 파일 중 다수는 [관리 표 설계](MEMBER_TABLE_DESIGN.md)(status: 검토 요청)의
> **미커밋 변경**과 겹친다. 그 변경을 먼저 검토·커밋해 기준선을 만든 뒤 이 설계를 얹는다(Jay 2026-09-23).

## 1. 무엇을

힉스필드는 워크스페이스 **전체 잔액**만 보여 준다. 그룹에 한도를 줘도 개인은 "내가 얼마를 쓸 수 있는지"를
못 본다. 우리 앱이 그 칸을 채운다 — **내 할당량 · 내 사용량 · 내 남은 양**을 보여 주고, 사용량을
시/일/주/월 · 모델 · 개인 · 그룹 · 프로젝트로 갈라 본다.

Jay 결정(2026-09-23):

| 결정 | 값 |
|---|---|
| 개인 할당량 | **그룹 한도 ÷ 인원이 기본, 사람별 덮어쓰기 가능** |
| 할당량 초과 | **화면 경고만** (실제 강제는 힉스필드 그룹 한도) |
| 정기 충전 | **손 입력 우선, 비면 지금처럼 프로젝트 '매월 예산' 합에서 파생** |
| 미커밋 변경 | Claude 가 검토하고 그 위에서 이어서 작업·커밋 |

## 2. 지금 있는 것 / 없는 것 (2026-09-23 전수 조사)

있다 — 다시 만들지 않는다.

| 이미 되는 것 | 근거 |
|---|---|
| 그룹 한도 · 주기(일/주/월) · 이월 · 소급 금지 재기준화 | [`manage_credit_plan.py`](../backend/app/repo/manage_credit_plan.py) `_group_remaining`·`_carry_in`·`save_settings` |
| 긴급 충전 기록(손 입력)과 이번 충전 달 합계 | 같은 파일 `_topup_summary`·`workspace_credit_topup` |
| 시/분/일/주/월 버킷 집계 | [`manage_db.py`](../backend/app/manage_db.py) `team_timeseries`, `GET /api/manage/team-timeseries?bucket=` |
| 개인(uid)·프로젝트·모델 드릴 | `manage_db._agg_where`, `team-overview`·`team-timeseries`·내보내기 2종 |
| 멤버 행 클릭 → 개인 드릴 | `WorkspaceUsageDashboard.tsx` 멤버 사용량 표 |
| 거래 원장(사용·환불·순사용) | `manage_transactions.ledger_totals` |
| 내보내기 CSV 2종(HF 호환 · 프로젝트 상세) | `usageReport.ts` |

없다 — 이번에 만든다.

| 없는 것 | 왜 필요 |
|---|---|
| **사람 단위 할당량** — `workspace_credit_group_member` 는 (워크스페이스, 이메일, 그룹) 3칸뿐 | 목표의 핵심 |
| **내 남은 양** — 개인은 사용량만 나오고 한도·남은 양이 없다 | 목표의 핵심 |
| **그룹 축 사용량 드릴** — `_agg_where` 에 그룹·이메일 축이 없다 | "그룹별로 묶어 보기" |
| **기간 선택의 전역 적용** — 기간 피커가 막대 차트에만 걸린다. 다른 패널은 전 기간 고정 | "시/일/주/월로 세세하게" |
| **드릴의 전역 적용** — 멤버를 골라도 크레딧 풀·잔액 추이·상단 통계는 안 따라간다 | "멤버를 누르면 그 멤버 것만" |
| **내보내기와 화면의 연동** — `runExport` 가 워크스페이스만 넘긴다(기간·드릴·모델 무시) | 엑셀 시트 연동 |
| **정기 충전 손 입력 칸** | Jay 결정 |

## 3. 계산 규칙 (이 설계의 핵심)

기호: 그룹 한도 `L`(NULL=무제한), 주기 `P`(day/week/month), 그룹 멤버 `M`명,
사람별 덮어쓰기 `o_i`(NULL=자동), 이번 기간 내 사용 `U_i`.

```
고정분  F   = Σ o_i (덮어쓴 사람들)
자동몫  a   = (L − F) / (자동인 사람 수)      # L−F < 0 이면 0
내 할당 Q_i = o_i  (덮어썼으면)  |  a  (아니면)
내 남음 R_i = Q_i − U_i                      # 음수면 "초과"로 표시
```

- **기간은 그룹 주기 `P` 를 따른다.** 달 경계는 충전 기준일(`topup_day`)을 쓴다 — 그룹 카드와 같은 시계.
- **개인 몫에는 이월이 없다.** 기간이 바뀌면 `U_i` 가 0 부터 다시 센다. 그룹 카드의 이월은 지금 그대로 둔다.
  (이유: 개인 이월을 넣으면 그룹 이동·한도 변경 때마다 사람 수만큼 재기준화가 필요하고, 사람에게 설명할 수
  없는 숫자가 된다. Jay 의 예시도 이번 기간 기준이다.)
- **한도를 올리면 즉시 반영된다.** `Q_i` 는 저장값이 아니라 그때의 `L`·인원·덮어쓰기로 매번 계산한다.
  Jay 예시 검증: `L=4,000`·자동 1명 → `Q=4,000`, `U=4,000` → `R=0`. `L` 을 5,000 으로 올리면 `Q=5,000` → `R=1,000`. ✓
- `L=NULL`(무제한)이면 `Q_i` 도 무제한 — 남은 양 대신 "제한 없음"을 보여 주고 사용량만 센다.
- `F > L` 이면 자동 몫은 0 이고 그룹 카드에 **"덮어쓴 합이 한도를 넘음"** 경고를 띄운다(저장은 막지 않는다).
- 크레딧은 소수다. 어디서도 반올림하지 않고 **표시할 때만 둘째 자리**(`_shown`·`formatCredits`).

## 4. 데이터 모델 변경 (추가만, 마이그레이션 1회)

| 테이블 | 추가 칸 | 뜻 |
|---|---|---|
| `workspace_credit_group_member` | `quota REAL NULL` | 사람별 덮어쓰기. NULL=자동 몫 |
| `workspace_credit_plan` | `recurring_topup REAL NULL` | 정기 충전 손 입력. NULL=프로젝트 '매월 예산' 합에서 파생 |

- 둘 다 `ALTER TABLE ... ADD COLUMN`(기존 행은 NULL=현행 동작) — 구버전 앱·서버와 호환된다.
- `quota` 는 `revision` 낙관적 잠금을 그대로 쓴다(그룹 저장과 같은 트랜잭션).
- `quota` 는 **재기준화 조건이 아니다**(이월을 안 쓰므로 `base_start`·`base_balance` 와 무관).

## 5. API 계약

### 5-1. `GET /api/manage/credit-plan` (읽기 모델 확장)

- 매니저 응답 `groups[]` 각 항목에 추가: `quota_fixed`(고정분 합), `quota_auto`(자동 몫), `quota_over`(고정분이 한도 초과면 true).
- 매니저 응답에 `members[]` 추가: `{email, name, group_id, quota, quota_effective, used_period, remaining, unknown}`.
- 멤버 응답 `my_group` 에 추가: `my_quota`, `my_remaining`, `my_quota_source`('manual'|'auto'|'unlimited').
- `pool` 에 추가: `monthly_topup_source`('manual'|'derived').

### 5-2. `PUT /api/manage/credit-plan/{workspace_id}` (쓰기)

- `members[]` 항목에 `quota` 허용: 숫자(≥0) · `null`(자동으로 되돌림) · **키 없음=기존값 유지**(구버전 앱이 지우지 않게).
- 본문에 `recurring_topup` 허용: 숫자(≥0) · `null`(파생으로 되돌림) · 키 없음=유지.
- 나머지 계약(전체 그룹 되보내기, revision 409)은 그대로.

### 5-3. 사용량 축 확장 — `team-overview` · `team-timeseries` · 내보내기 2종

- 새 쿼리 파라미터 `group_id` 와 `account_email`.
  - 서버가 `group_id` → 그 그룹의 이메일 집합으로 바꿔 `account_email IN (...)` 로 건다(팩트에 이메일이 있다).
  - 그룹 축은 **매니저(read_all)만**. 멤버는 지금처럼 본인으로 강제된다.
- `by_worker[]` 에 `account_email` 추가 — 지금은 uid 만 줘서 멤버 표·그룹과 이을 키가 없다.
- 기간 파라미터(`date_from`·`date_to`·`time_from`·`time_to`)는 이미 있다. 화면이 안 보내던 것뿐이다.

## 6. 화면

1. **내 크레딧 카드**(멤버·매니저 공통, `CreditPoolSection`): `내 할당량 / 사용 / 남음` 한 줄 + 게이지.
   초과면 색과 문구로 경고(막지 않는다). 무제한이면 "제한 없음"과 사용량만.
2. **관리 표 '크레딧' 시트**: 사람 행에 `할당량` 칸(비우면 자동) 추가. 그룹 행에 고정분 합·자동 몫 표시.
3. **기간 선택을 대시보드 전체에 적용**: 지금 막대 차트에만 걸리는 시/일/주/월 선택이 상단 통계·멤버·프로젝트·
   모델·Yield 에도 걸린다. 기본값은 지금처럼 **전 기간**(동작 보존).
4. **드릴 확장**: 멤버·프로젝트에 **그룹** 축을 더하고, 드릴이 켜지면 크레딧 카드도 그 사람 기준으로 바뀐다.
   잔액 추이는 워크스페이스 값이라 드릴 대상이 아니다 — 대신 드릴 중에는 그 멤버의 **사용 추이**로 바꿔 보여 준다.
5. **내보내기**: 현재 기간·드릴·모델을 CSV 에 그대로 반영한다(지금은 무시된다).

## 7. 먼저 고칠 정합성 (P0 — 숫자가 틀리는 자리)

| # | 문제 | 처방 |
|---|---|---|
| P0-1 | 2026-09-16 배포 전 매칭된 실제 사용액이 **반올림된 채** 남아 있다(재매칭은 `real_credits IS NULL` 만 본다) | 읽기 전용 판별 → 건수 보고 → 승인 후 1회 보정 |
| P0-2 | '이번 주' 경계가 세 곳에서 다르다(`weekday()` 월요일 · `weekday 0','-6 days'` · `strftime('%Y-W%W')`) | 월요일 기준으로 통일 |
| P0-3 | `/api/credits` 팀 합계가 같은 워크스페이스 잔액을 인원수만큼 더한다(현재 화면 미사용) | 워크스페이스 단위로 접어서 합산 |
| P0-4 | `_workspace_credits` 가 "가장 최근 보고"라고 적어 놓고 목록의 **마지막 사람** 값을 쓴다 | 보고 시각 비교로 고침 |
| P0-5 | 모델 라벨식이 두 곳에서 다르다(`NULLIF(model,'')` vs `NULLIF(TRIM(model),'')`) | `TRIM` 쪽으로 통일 |

## 8. 단계와 검증

| 단계 | 내용 | 무엇을 확인하면 성공인가 |
|---|---|---|
| 0 | 미커밋 관리 표 변경 검토·커밋 | 백엔드·프런트 시험 통과, 기준선 커밋 1개 |
| 1 | P0 정합성 | 각 항목마다 되돌려 확인(고친 줄을 되돌리면 시험이 깨진다) |
| 2 | 할당량 저장·계산·API | 새 시험: 자동 몫·덮어쓰기·한도 상향(4,000→5,000 예시)·무제한·고정분 초과·구버전 본문이 `quota` 를 지우지 않음 |
| 3 | 화면(내 카드·관리 표 칸) | 격리 브라우저 실측(헤드리스 + 창 있는 크롬) |
| 4 | 드릴·기간 전역 적용·내보내기 연동 | 같은 조건에서 화면 합계 = CSV 합계 |
| 5 | 실측·문서·기억 | 실제 데이터로 한 사람 값 손 대조 |

## 9. 안 하는 것

- **할당량으로 생성을 막지 않는다**(Jay 결정: 경고만). 실제 강제는 힉스필드 그룹 한도가 한다.
- **개인 이월을 넣지 않는다**(§3 이유).
- **.xlsx 생성기를 만들지 않는다.** 내보내기는 CSV 두 종을 유지하고 필터 연동만 고친다.
- **거래를 생성물에 더 정교하게 잇지 않는다** — 애매하면 보류하는 현행 계약을 유지한다.
