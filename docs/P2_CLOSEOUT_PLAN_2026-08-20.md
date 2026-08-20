# P2 잔여 전수 소진 계획 v2 (2026-08-20, 클로드 v1 → 코덱스 적대 검토 반영 확정안)

목표 문구 정정(코덱스): "알고 있는데 안 고친 것 0"이 아니라 **"추적되지 않은 알려진 잔여 0"**.
D(조건부 보류)와 E(실측)는 남지만 전부 장부에 조건과 함께 기록된다.
코덱스 검토(A표 파일:줄 전수 대조·AUDIT 반례 17건·B2/B4 설계 함정)는 이 문서에 반영 완료 —
원문은 세션 산출물이라 미보존, 파일:줄 근거는 각 항목에 요약돼 있다.

## A. 이미 해소 확정 — 9건 (문서 종결은 dev 반영 확인 후에만)

A1 RL-11 보상→원장 대체(배치 3)· A3 remap 거래 중복(배치 2)· A4 watcher(배치 7)·
A5 워치독(배치 5)· A6 _mark_success(배치 2)· A7 AUTH-off 1008(배치 8)· A8 셀렉터 리셋(배치 8)·
A9 archived 구분(배치 8)· A13 이벤트 루프 동기 SQLite(배치 4).
+ 장부 보완 2건: 일반 생성 멱등키 완료 기록(배치 1), restore finally "검토 후 제외" 기록.
★A1·A7~A9 는 기능 브랜치에만 있음 — **dev 병합 전에는 REVIEW 에 종결 기록 금지**(코덱스).

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
- P1-5. **원장 위생 상태표** (B4, feat/share-reconciliation): "로컬 없음+서버 missing=종결"
  단일 규칙 금지 — 원격 전용 카드(local 불필요)/로컬 소실(전환·유실 구분)/prepared+base 일치
  (rejected)/서버 존재·로컬만 없음(materialize 기회 보존) 상태표 + 유한 유예 후
  orphaned 터미널 + intent_seq CAS 유지. 설계 합의 후 구현.

### B-P2 배치 1 (백엔드 위생, 코덱스 → 클로드)
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

### B-P2 배치 2 (프론트, 클로드 → 코덱스)
- assets 스키마 가드 비대칭(ThumbnailGrid·GenerationCard·generationGrid) 화이트스크린 방어
- 회색 필터 자동 페이지 연쇄 상한
- 시퀀스 카드 출처 라벨(A10 잔여)

### B2 쿼터 증분 회계 — 설계 선행(코덱스 함정 8건 반영: 초기화 락·크래시 복구·삭제 실패
  시 카운터 불변·외부 변경 drift·bytes_cached 재사용 금지·동시 예약·상한 근처 재검산·
  readiness 재동기화 금지). "시작 전체 계산→준비 전 보수 제한→락 안 확정→주기 교정" 골격.

## C. 측정 선행 (배치 0 — 운영 사본 승인 필요, dev 예행 가능)
- 레거시 workspace 분포 → unknown/personal 백필 판단
- 레거시 시각 포맷 분포 → 시각 보정 3종
- 고아 파일 분류 보고서(배치 11 근거)
- preparing+placeholder 유령 실측(자동 sweep 금지 유지)
- **reducer hotspot 실측** (B6 여기로 이동 — 측정 없이 적용 금지, BACKLOG 원칙)

## D. 조건부 보류 — 조건 문서화로 종결
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
2. 배정 UI 소실 — 복원 vs 폐기 확정
3. 구 배포본(D:\ClaudeCode\MV-hub-S) 조사 트랙 — 실사용 여부 확인 후 처분(별도 승인)
4. 배치 0 측정의 운영 데이터 사본 사용 승인
5. pinned 표시 아이콘 넣을지 (사소 — 기본값: 안 넣음)

## 실행 순서 (코덱스 권장 반영)
1. F1 병합 결정·실행 → 2. B-P1 배치(경계 5건) → 3. 배치 0 측정(병렬 가능) →
4. B-P2 배치 1·2 병렬 → 5. B2 설계→구현 → 6. C 후속 수정 → 7. dev 반영 확인 후
문서 종결 커밋(A 9건+장부 보완+D 조건) → 8. 배치 11 삭제 목록 제시(Jay 승인).
