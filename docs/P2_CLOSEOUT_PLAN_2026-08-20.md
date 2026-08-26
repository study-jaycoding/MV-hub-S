---
updated: 2026-08-21
status: archived
---

# P2 잔여 전수 소진 계획 v2 (2026-08-20, 클로드 v1 → 코덱스 적대 검토 반영 확정안)

목표 문구 정정(코덱스): "알고 있는데 안 고친 것 0"이 아니라 **"추적되지 않은 알려진 잔여 0"**.
D(조건부 보류)와 E(실측)는 남지만 전부 장부에 조건과 함께 기록된다.
코덱스 검토(A표 파일:줄 전수 대조·AUDIT 반례 17건·B2/B4 설계 함정)는 이 문서에 반영 완료 —
원문은 세션 산출물이라 미보존, 파일:줄 근거는 각 항목에 요약돼 있다.

## A. 이미 해소 확정 — 9건 ✅종결 (2026-08-20 dev 병합 12f2be03 으로 전부 dev 반영 확인)

A1 RL-11 보상→원장 대체(배치 3)· A3 remap 거래 중복(배치 2)· A4 watcher(배치 7)·
A5 워치독(배치 5)· A6 _mark_success(배치 2)· A7 AUTH-off 1008(배치 8)· A8 셀렉터 리셋(배치 8)·
A9 archived 구분(배치 8)· A13 이벤트 루프 동기 SQLite(배치 4).
+ 장부 보완 2건: 일반 생성 멱등키는 배치 1 완료분(cb872de2 라운드), restore finally 는
  BACKLOG:14 에서 이미 "해결로 제외" — 둘 다 이 장부로 종결 기록.
부분 해소였던 4건의 잔여도 소진: A2 영구 409(W1 dfba06d7)· A10 시퀀스 라벨(d9e8c58b)·
A11 rollout fence(55a878bd)· A12 부팅 백업 백그라운드화(W2 868d6a89).

## B. 지금 고친다

### B-P1 배치 (최우선 — 경계·정합, 코덱스 구현 → 클로드 검토)
- ✅P1-1. **혼합 배포 rollout fence** (2026-08-20, dev 55a878bd — 코덱스 구현·클로드 검토):
  generation_deployment_paused 스위치(관리자 GET/PUT, 접수·pending·claim 503) +
  tools/deploy_fence_check.py(미종결 gen_request·진행 중 generation 0 검사, 종료코드 계약) +
  SERVER.md 배포 절차(일시중지→fence→서버→에이전트→재개).
- ✅P1-2. **URL cross-owner adopt** (55a878bd): 소유자 범위 제한 — incoming creator 정확 일치
  + 이메일 검증된 계정의 acct: 전환 별칭만. 무소유 행은 adopt 대신 새 행(fail-closed).
- ✅P1-3. **MV_agent.bat 포트 kill 정밀화** (55a878bd): tools/stop_local_hub_on_port.ps1 —
  전 PID CommandLine·CreationDate 검증, kill 직전 재확인, 혼합 소유 전체 거부. 구 런처
  (상대경로) 프로세스는 번들 파이썬 경로로 소유권 인정(클로드 리뷰 반영 — 최초 업데이트
  전 PC 멈춤 방지, 판별 6케이스 검증). 실전 수동 검증은 배포 시(E 트랙).
- ✅P1-4. **잠금 키 드리프트** (55a878bd): _stable_proxy_identity_lock — 잠금 후 재매핑이
  잠금 키와 다르면 원장 prepare 전 409 안전 실패(자동 재잠금 대신), 번들은 부분집합 검사.
  ※주: 55a878bd 는 apply --3way 스테이징 특성으로 P1-1~4 가 한 커밋에 합쳐짐(내역은 이 장부가 권위).
- ✅P1-5. **원장 위생 상태표** (2026-08-20 — 클로드 설계·코덱스 구현·클로드 검토):
  apply 반환 3값화(applied/cas_lost/no_target). 원격 전용 행=서버 관측 즉시 종결
  (일치 converged·prepared+base rejected·불일치 superseded), 기존 local_id 유실=5회
  유예 후 rejected(코덱스 이의 채택 — 서버 공유 상태 상시 sync 부재로 행 부활 기회 보존),
  CAS 경합은 실패 카운트 없이 분리. 스키마 무변경·전 전이 CAS 유지. list_due 리터럴 정리.

### ✅B-P2 배치 1 (2026-08-20 완료 — W1 dfba06d7 8건·W2 868d6a89 10건, 코덱스 구현·클로드 검토·병합, 전 회귀 1145 통과)
- 영구 409 행별 dead-letter 경로(A2 잔여 — 일괄 격리 금지, 항목별 ACK/관리 격리)
- 부팅 백업 bootstrap 백그라운드화 또는 readiness 예산(A12 잔여)
- agent_signals 스레드→루프 신호 call_soon_threadsafe 화
- ingest MCP 백필 workspace 페이지 일괄 오귀속(잡별 보존)
- syncer 실패 무음(print) → 구조화 경보 연결
- folder_counts \x00 fail-open → fail-closed 정합
- get_my_uid ORDER BY 결정화 / facets archived 불일치 / media-thumb 오픈 리다이렉트 차단
- thumbs TOCTOU 500 + .thumbs 평면 전량 스캔 / imp/cap 합본 base 경계 축소
- resolve pending 20개 창 잠식(완료 필터 후 자르기) / lifespan try/finally 보장
- hf_cli_version.txt BOM 가드 / ensure_ingested_tracked 데드 코드 제거
- 테스트 기본 DB 숨은 의존 3건
- 세트 백업 문서화: "동일 시점 보장" 아니라 **미세 불일치 가능성+restore 검출·복구 규칙** 명문화

### ✅B-P2 배치 2 (2026-08-20 완료 — d9e8c58b, 클로드 구현)
- assets 스키마 가드 비대칭(ThumbnailGrid·GenerationCard·generationGrid) 화이트스크린 방어
- 회색 필터 자동 페이지 연쇄 상한
- 시퀀스 카드 출처 라벨(A10 잔여)

### ✅B2 쿼터 증분 회계 (2026-08-20 완료 — 클로드 설계·코덱스 구현·클로드 검토, 전 회귀 1150 통과)
최초 사용 시 1회 전체 스캔 → 락 안 증분(finalize +, unlink 성공 후만 −) → 상한 95% 이상
판정 직전 보수 전체 재검산 → 일일 sweeper 권위 재계산. bytes_cached 재사용 금지 유지.
문서화된 한계: 단일 프로세스 범위(다중 프로세스 배포 시 별도 설계), 크래시 과소계상은
95% 재검산·일일 재계산까지 유계. **이로써 B 그룹(지금 고칠 것) 전체 소진.**

## C. 측정 선행 (배치 0) — ✅서버 본측정 완료(2026-08-21, test_push/pull-db 스냅샷 239건 기준)
- 레거시 workspace 분포 — **✅측정**: team 181 / unknown 58(7월 집중 45→8월 10), 워크스페이스 단일
  팀뿐, 관리 집계 제외 0건 → 자동 백필 불요 판단(58건은 `#+` 수동 등록 규모). Jay 결정만 남음
- 레거시 시각 포맷 분포 — **✅종결**: 3테이블 모두 테이블 내 단일 포맷 100%, 파싱불가·NULL·
  sort_ts NULL 전부 0 → 시각 보정 3종은 **보정 대상 자체가 없음**
- 고아 파일 분류 — **✅종결**: 로컬 교집합 246 중 **242가 서버 참조로 구제**, 최종 진짜 고아
  **4개/0.3MiB** → 배치 11 고아 삭제는 실익 소멸로 폐기(쿼터 자동관리로 충분)
- preparing+placeholder 유령 — **✅측정**: 0건
- **reducer hotspot 실측** — ✅종결(2026-08-21, 코덱스 Profiler 실측): BACKLOG 후보
  ProjectManagerPanel·MountManager 는 주기 재조회 없음(hotspot 불가), DashboardView 요약부는 기적용.
  **WorkspaceUsageDashboard 만 hotspot 확정**(fresh-ref 5커밋/170렌더/14.4ms vs reconcile
  4/102/8.0ms) → workspaces·overview·trend 3상태에 reconcile 적용, 재실측으로 4/102/8.3ms 수렴 검증.
  **이로써 C(측정 선행) 전체 소진.**

## D. 조건부 보류 — ✅조건 문서화로 종결 (이 장부의 아래 조건 목록이 종결 기록이다)
- 외부 보존 tier (조건 보강: 용량 압박·팀 확대 + **단일 디스크 고장 허용 손실량·복구 목표**)
- provider webhook (조건: HF 지원 확인)
- **HF 멱등키 미지원 계약**: 공식 지원 확인 전 자동 유료 재시도 금지·recovery_required 유지
- scenecard job_id 앵커 (기존 재평가 조건 유지)
- 작업 탭 팩트 기반 이전 (보류 전에 **현 파생 모델의 데이터 불변식+우회 절차 문서화** 선행)
- 팀탭 비공개 뱃지 viewer별 집계 — 문서화 종결 기록
- ManageWindow pinned 표시 아이콘 — UX 선택(F로)

## E. 실측 트랙 (코드로 못 닫음 — 조건 명기)
RL-23 물리 복원 / NAS watcher / 유료 Comfy 실행·취소·재시작 / 운영 업데이트·혼합 버전 연속 /
**공유 서버 5분 단절·복구 + 8시간 soak (Gate 5 — 합격 기준 명시)** / Resolve CF-PC01

## F. Jay 결정
1. 두 기능 브랜치 dev 병합 (A1·A7~A9 종결 기록과 P1-4·P1-5 작업 기반의 선행 조건)
2. 배정 UI 소실 — ✅폐기 확정(2026-08-21 Jay, B안). 프론트 고아 코드 제거·백엔드는 휴면 유지
   (DB 파괴 회피+혼재기간 404 회피). "내 작업"은 실제 컷 자동 파생만. 잔여 데드코드로
   .dash-due·.planned-*(예정 생성자, 별개 기능)와 stateReconciliation 샘플 데이터는 보고만 하고 유지
3. 구 배포본 조사 트랙 — ✅부분 종결(2026-08-21): D:\ClaudeCode\MV-hub-S=**Jay 실사용
   클라이언트 확정 → 정리 대상 영구 제외**. D:\MV-hub-S(6/30 배포판 사본, 1.2GiB)=Jay 확인 후
   **D:\_TRASH_MV-hub-S_20260821 로 격리 이동 완료(2026-08-21)** — 2주 유예(~09-04) 후 문제없으면 삭제.
   배치 11 고아 삭제(246개/821MiB)는 조건부 보류 — 실서버 DB 대조 전 삭제 금지 + 쿼터가 자동 관리라 실익 낮음
4. 배치 0 측정의 운영 데이터 사본 사용 승인
5. pinned 표시 아이콘 넣을지 (사소 — 기본값: 안 넣음)

## 실행 순서 (코덱스 권장 반영)
1. F1 병합 결정·실행 → 2. B-P1 배치(경계 5건) → 3. 배치 0 측정(병렬 가능) →
4. B-P2 배치 1·2 병렬 → 5. B2 설계→구현 → 6. C 후속 수정 → 7. dev 반영 확인 후
문서 종결 커밋(A 9건+장부 보완+D 조건) → 8. 배치 11 삭제 목록 제시(Jay 승인).
