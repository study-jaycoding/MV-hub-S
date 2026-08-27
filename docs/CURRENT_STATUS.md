---
aliases:
  - 현재 작업 현황
tags:
  - mvhub
  - mvhub/현황
status: active
updated: 2026-08-27
---

# MV Hub 현재 작업 현황

기준일: **2026-08-27** · 코드 기준선: `dev` `472f9622` = 팀 릴리스 **`2026.08.27-1404`** = `origin/main` = `origin/dev`(2026-08-27 14:04 배포, NAS `latest.json` 확인) · 운영 설치본(Jay PC) 업데이트·포스터 재조정 검증 완료, 다른 작업자 PC 는 각자 업데이트 대기

> [!NOTE]
> 이 문서는 긴 기록을 읽기 전에 보는 **한 장짜리 현황판**이다. 날짜별 상세 기록은 아래
> [자세한 기록](#자세한-기록) 의 `status/` 노트로 옮겼다(내용은 그대로 보존).
> 위험 항목의 상태를 바꾸는 단일 기준은
> [RISK_REDUCTION_PLAN_2026-08-15.md](RISK_REDUCTION_PLAN_2026-08-15.md) 의
> `Gate 0 산출물 — 정규화 잔여 목록`이다. 두 문서가 다르면 Gate 0 표를 우선한다.

## 지금 상태

- **개발 기준선은 안정적이다.** 잘못된 데이터 표시·오귀속으로 분류한 미해결 P0는 없다.
- **최적화 라운드 R8~R14 종료**(2026-08-24 수렴 선언) — 더 고칠 것이 남지 않았다는 판정이다.
  새 코드가 지켜야 할 규칙은 [루트 ARCHITECTURE.md](../ARCHITECTURE.md) `§6 동시성·상태 계약`에 있다.
- **Resolve 전송 = 직접 전송이 현행.** 서버 영구 큐 없이 **요청 한 건 안에서 준비·반입·결과 저장**을 끝낸다
  (2026-08-25 `aa0985b9`, -404줄). 브라우저의 짧은 직렬화만 남겨 Resolve API 동시 호출을 막는다.
  직접 전송은 릴리스 `2026.08.25-0847` 부터 배포됐고, 현재 릴리스 `2026.08.27-1404`(`472f9622`)·`origin/dev`·`origin/main`·
  Jay 설치본이 모두 같은 커밋이다(2026-08-27 실측).
  큐 v3(08-23~24)는 **이력**이며 현재 확인된 재도입 계획은 없다. 2026-08-27 에 큐 라우트 3개(`/api/resolve/queue*`)·
  워커 콜백·`/status` 의 v3 재평가·프론트 큐 헬퍼를 **제거**했고, 업데이트 차단은 v3 스캔 대신 진행 중 직접 전송 카운터를
  본다(ARCHITECTURE §7.6). `services/resolve_queue.py` 는 현행이 쓰는 `run_non_abandon` 하나만 남긴 33줄 모듈이다
  (2026-08-27 기준선 정리 — 직접 전송 경로가 닿지 않는 접수·상태 전이·claim·취소·복구·스캔 코드 1,970여 줄과 그 코드
  없이는 못 도는 테스트 57개를 삭제하고 그 안에 섞여 있던 살아있는 계약 2개는 큐 코드 없이 다시 씀, 동작 코드는 옮기거나 바꾸지 않음). 휴면 워커 `resolve_queue_worker.py`(1,127줄)도
  같은 날 삭제. `resolve_lock.py`·`resolve_import_worker.py` 는 남는다(현행 사용: `/locks`·status runner 자식).
  `/resume` 이 하던 v3 manifest 수동 복구 경로는 사라졌다(파일은 보존). 반입 자식의 시간제한 없음은 **의도적 현행 유지**
  (실제 발생 0, ARCHITECTURE §7.6 알려진 한계) — 재설계 제안 없음.
- **휴면 코드 정리(2026-08-27, Claude 스캐너 + Codex 독립 조사 교차).** 기준 = "현행 동작 경로가 닿지 않는 정의만, 동작
  코드는 옮기거나 바꾸지 않음". 백엔드: 모듈 최상위 정의 2,600개 중 호출자 0 인 함수·상수 약 45개(mutation_notify 의
  `should_notify_*` 3종 → `notification_domains` 로 통합됨, share_state 단건 lock·claim, backup·cli_bridge·comfy_client 의
  구형 helper, Resolve Bin 실사 클러스터·큐 v3 복사·바이트락 `FileLock`/`process_liveness`/`terminate_process` 등)와 테스트만
  쓰던 wrapper 12개를 제거. 살아있는 계약을 검사하던 테스트는 현행 API 로 바꿔 유지(`notification_domains`,
  `update_project_identity`, `share_state_action_locks`, `job_id_sync_diff`, 메뉴 Importer 잠금은 Importer 자체 `FileLock`).
  의도적 보존: `_REMAP_EXEMPT`(신원 스키마 감사 규칙)·`clear_task_read_cache`(테스트 격리 seam)·도구(`tools/*.py`)가 쓰는
  복구 검증 함수들. 프런트: 다른 파일·테스트가 전혀 안 쓰는 export 10개(`ProjectPlanningDialog` 컴포넌트 포함)와 테스트만
  쓰던 3개(`hasMediaRefTokens`·`applySceneGenerationResults`·`patchOwnedComfyRun`) 제거. "파일 안에서는 쓰지만 export 만
  불필요한" 선언(약 190개)은 손대지 않음. 미참조 모듈·파일은 양쪽 모두 0. "하위 호환용" 이라 적혀 있던 `unknown_job_ids`·
  `SCRIPT_RELATIVE_DIR` 은 저장소 안(도구·bat·프런트 포함) 호출자 0 을 확인하고 제거했다(저장소 밖 호출자는 없다고 봄 — 필요하면
  한 줄 wrapper 로 복원). 메뉴 Importer 잠금 테스트는 허브 `FileLock` 대신 Importer 자체 `FileLock` 을 보유자로 써서 유지.
- **공유 서버 이사 공지** 구현·실환경 검증 완료. 관리자 [팀에 공지] → 작업자 알림 → 한 번 눌러 전환.
- **영상 포스터 오염 처방(2026-08-27).** 힉스필드 MCP `show_generations` 의 영상 `results.thumbnailUrl` 은 결과
  포스터가 아니라 **첫 입력 이미지**다(실측). 기동 시 이력 보충이 이를 저장해 7월 시댄스 영상 63건에 레퍼런스 시트가
  포스터로 떴다(주기 동기화는 최신 100건만 CLI 로 되돌려 8월 잡만 정상). 처방 = MCP 변환에서 영상 썸네일 폐기 +
  같은 결과물일 때만 기존 포스터 승계 + 로컬 허브 기동 시 CLI `generate get` 으로 진짜 포스터 재조정(CAS).
  **실기기 검증 완료**: 릴리스 `2026.08.27-1404` 로 Jay PC 를 갱신한 첫 기동에서 `thumbnail_repair_done candidates=75
  replaced=75 cleared=0 skipped=0`(14:14), DB 대조 영상 asset 78건 중 입력 이미지와 같은 썸네일 0·진짜 포스터 75.
  근거·검증은 [status/영상_포스터_오염_2026-08-27.md](status/영상_포스터_오염_2026-08-27.md).
- **캔버스 렌더 노드의 모델 규칙 통일(2026-08-27, `8f6f9cbb`, Jay 결정 B).** 모델 노드가 없는 생성카드는 Render 클릭
  시점의 하단 프롬프트 모델·옵션으로 생성한다(카드 아래 Generate 바와 같은 규칙 — 종전엔 렌더 노드만 건너뛰어
  "모델이 연결된 생성 카드가 없습니다"). 모델 노드가 2개 이상이거나 모델 미설정 노드면 여전히 건너뛰고, 알림에
  `모델 노드 없음 → 하단 모델(이름) N개` 를 표시한다. 폴백은 실행 훅이 클릭 시점에 1회 읽어 comfy 완료 뒤 제출까지
  전달하므로 실행 중 하단 모델을 바꿔도 섞이지 않는다(단, 그 변경은 감지 대상이 아니다).
- **백로그 잔여 1건** — 휴지통 교차-WAL 전원손실(구조 재설계급, 보류 확정). 나머지는 실측으로
  종결하거나 처리했다.
- **부분 해결 위험은 RL-23 하나다.** 실제 다른 물리 장치 복원 훈련 전에는 완료로 올리지 않는다.
- 실제 유료 Comfy Cloud 작업, NAS 물리 복원, 운영 업데이트·자동 재시작을 한 번에 잇는 통합 검증
  (Gate 6)은 아직 남아 있다. 따라서 **운영 배포 완료를 선언한 상태는 아니다.**

### 마지막으로 기록된 전체 회귀 (2026-08-27 실행, `5f7a1853`)

> [!IMPORTANT]
> 아래 숫자는 2026-08-27 `dev` `3fa4e862` 에서 격리 환경(`CONTENT_HUB_NO_PROXY=1`, 임시 DB)으로 실행한 결과다.
> 이후 커밋의 전체 회귀를 자동으로 보증하지 않으며, 새 릴리스 전에는 Gate 6 절차로 다시 확인한다.
> Resolve·이사 공지 행은 2026-08-24 실측 기록이다(Resolve 는 당시 큐 v3 경로 — 직접 전송 경로의 실기기 반입 재실측은 아직 없다;
> 2026-08-27 실측은 반입을 일부러 거부시킨 채 잠금·런처만 확인). 이 PC 는 5173 이 Windows 예약 포트 범위(5141–5240)에
> 들어가 `test_dev.bat` 의 Vite 가 `EACCES` 로 못 뜬다 — 환경 문제(코드 아님). 런처가 `tools/pick_dev_port.ps1` 로 예약 범위를
> 읽어 5173 이 막혀 있으면 `[dev] Port 5173 is reserved by Windows` 를 찍고 3173(다음 3174…)으로 자동 이동한다(더블클릭만으로
> 동작). 고정하고 싶으면 실행 전 `$env:FRONTEND_PORT=…`.

| 검증 | 결과 |
|---|---|
| 백엔드 전체 테스트 | **1,787개 통과 + 46 subtests** (3분 16초, 휴면 코드 정리 뒤 재실행 — 죽은 wrapper 만 검사하던 테스트 제거, 살아있는 계약(placeholder 재개 진리표·cache-all 배치 결과·Comfy 계정별 중복 방지)은 현행 API 로 재작성; 그 전 `resolve_queue.py` 정리에서 −57/+2) |
| 프론트 전체 테스트 | **98개 파일·673개 통과**(휴면 export 정리 뒤 재실행 — 죽은 함수 테스트 5개 제거) · `tsc --noEmit` 통과 · `lint:architecture` 이상 없음 · `build` 성공 |
| Resolve 실기기 반입 | 통과 (2026-08-24, 큐 v3 기준 — 클립 3개, 중복 0, 원상 복원 확인) |
| 업데이트 차단 게이트·카운터 실측 | 통과 (2026-08-27, `3fa4e862`, 격리 서버 8000·`data_test`) — `checking` 상태 파일 → `POST /api/resolve/transfers` **409**, 삭제 후 해제. 40건(1.1GB) 직접 전송 중 `resolve_active=1`·`can_update=false`(Claude 12샘플 중 8, Codex 19샘플 중 15), 종료 후 0. Resolve 대상 불일치로 가져오기 거부(클립 미삽입), 렌더 루트 원상복구 |
| 런처 창 닫기 → 브라우저 유지 | 통과 (2026-08-27, `c243b211` 포함 dev, `test_dev` 포트 3173 사본) — 허브·Vite·에이전트 기동 후 콘솔 X 닫기: 11초 뒤 8012/3173 리스너 0·프로세스 트리 0, Chrome 프로세스 32→37→37 유지. 한계: Chrome 이 이미 켜진 상태(미실행 케이스는 OS 단위 테스트 `test_explicit_breakaway_child_survives_guard_cleanup` 만), 특정 탭은 미식별, 1회 실행. Codex 는 샌드박스 제약으로 단위 테스트(2 passed)·증거 감사만 |
| 공유 서버 이사 실환경 | 통과 (발행 → 수신 → 원클릭 전환 → 위조 거부) |

## 위험 항목

RL-01 ~ RL-25 중 **RL-23만 부분 해결**이고 나머지는 완료다. 항목별 결과와 근거 커밋은
[status/RL_완료목록.md](status/RL_완료목록.md) 에 있다.

## 그다음 권장 작업

서로 섞지 않고 아래 순서로 각각 설계·구현·회귀·실측·커밋한다.

1. **새 릴리스 배포 — 완료(2026-08-27), 작업자 PC 갱신만 남음**
   팀 릴리스 `2026.08.27-1404`(`472f9622`, sha256 `381c8c…`, hf_cli 1.1.23)를 `MV-hub-S-release` 에서 만들어 NAS
   `Z:\mvutil\MV_hub_S\packages` 에 올렸고, Jay PC 설치본을 업데이트해 재시작·포스터 재조정(75/75)을 확인했다.
   이 릴리스에 새로 실린 것: `c243b211`(런처가 브라우저를 안 닫음)·`fe1efacf`(큐 host_id)·2026-08-27 코드 정리(주석·테스트
   bat 덮어쓰기·run-bat ASCII·업데이트 차단 카운터·큐 라우트 제거)·`test_dev` 예약 포트 자동 회피·캔버스 렌더 노드 하단
   모델 폴백·영상 포스터 오염 처방+기동 재조정·휴면 큐 워커 삭제. Resolve 연동 스크립트 `MVHub_Importer.py` 0.3.0 은
   `0847` 부터 실려 있다. 남은 일: 다른 작업자 PC 가 앱 안 **설정 → 프로그램 업데이트**로 받고, 각자 첫 기동 로그의
   `thumbnail_repair_done` 으로 재조정을 확인한다. 공유 서버에 이미 올라간 잘못된 썸네일은 해당 카드를 다시 공유해야 바뀐다.

2. **RL-23 외부 완료 조건 — 실제 다른 물리 장치 복원 훈련**
   공유 서버의 실제 NAS/다른 디스크 대상을 설정하고, 작업자 세트 하나를 복제한 뒤 그 복제본만으로
   예비 PC에 `content + trash`를 복원한다. 결과와 걸린 시간을 월간 훈련 기록에 남긴다. 상세 조건은
   [WORKER_OFFDISK_BACKUP_CONTRACT.md](WORKER_OFFDISK_BACKUP_CONTRACT.md)를 따른다.

3. **Gate 6 — 실제 외부 프로그램과 릴리스 설치본 통합 검증**
   이미 격리 환경에서 통과한 Higgsfield 1건과 두 계정 공유 왕복을 포함해 Comfy·Resolve, NAS 복제,
   릴리스 업데이트·자동 재시작을 운영과 같은 설치본·순서로 한 번에 재확인한다. 이 단계 전에는
   운영 배포 완료로 표현하지 않는다.

## 운영 배포 전 남은 확인

- 최신 `dev` 격리 환경의 실제 Higgsfield 1건 왕복은 통과했다. 운영 설치본 배포 직후 같은 경로를
  다시 확인
- 최신 `dev` 격리 서버의 두 계정 publish → 조회 → unpublish 왕복은 통과했다. 운영 공유 서버의
  실제 계정·혼합 버전 배포에서도 같은 결과와 감사 이력을 재확인
- 실제 Comfy 워크플로우 실행과 Resolve의 실제 가져오기·내보내기(격리·실기기 반입은 통과)
- 실제 NAS 백업 복제의 최신성·오프디스크 복사와 예비 PC 복구 시간 측정
- 운영 설치본의 업데이트 → 자동 재시작 → ready → 로그인 → 주요 화면 확인

상세 합격 조건은 위험 계획의 `Gate 6 — 외부 통합과 병합·배포 검증`을 따른다.

## 자세한 기록

| 기록 | 내용 |
|---|---|
| [status/최근작업_2026-08-24.md](status/최근작업_2026-08-24.md) | 최적화 R8~R14, Resolve 큐, 서버 이사, 백로그 정리 |
| [status/영상_포스터_오염_2026-08-27.md](status/영상_포스터_오염_2026-08-27.md) | MCP thumbnailUrl=입력 이미지 실측, 처방 3건, 릴리스 `1404` 실기기 재조정 75/75 완료 |
| [status/RL_완료목록.md](status/RL_완료목록.md) | RL-01~RL-25 결과와 근거 커밋 |
| [status/검증기록.md](status/검증기록.md) | 항목별 회귀·부하·브라우저·릴리즈 실측 기록 |
| [status/구현완료_RL-02_RL-23.md](status/구현완료_RL-02_RL-23.md) | RL-02 워크스페이스 스냅샷·RL-23 오프디스크 백업 상세 |
| [status/사전배포검증_2026-08-19.md](status/사전배포검증_2026-08-19.md) | 사전 배포 적대 검증 |
| [status/안정화_2026-08-18.md](status/안정화_2026-08-18.md) | 추가 안정화 |
| [status/코드대조_2026-08-26.md](status/코드대조_2026-08-26.md) | 기준선 `8133c625` 코드↔문서 전수 대조(29개)·Claude/Codex 교차검증·finding ledger |

## 문서 사용 순서

1. **현재 판단:** 이 문서
2. **위험 상태와 다음 작업:** [RISK_REDUCTION_PLAN_2026-08-15.md](RISK_REDUCTION_PLAN_2026-08-15.md)
3. **코드를 어디에 둘지:** [루트 ARCHITECTURE.md](../ARCHITECTURE.md) — 계층·경계·동시성 규칙
4. **현재 구조·데이터 흐름:** [docs/ARCHITECTURE.md](ARCHITECTURE.md), [AI_CONTEXT.md](AI_CONTEXT.md)
5. **데이터·권한 계약:** [DATA_OWNERSHIP.md](DATA_OWNERSHIP.md),
   [WORKSPACE_DATA_CONTRACT.md](WORKSPACE_DATA_CONTRACT.md),
   [신원과_모드_가이드.md](신원과_모드_가이드.md)
6. **운영·복구·테스트:** [SERVER.md](SERVER.md), [SERVER_RECOVERY.md](SERVER_RECOVERY.md),
   [TESTING.md](TESTING.md)
7. **과거 발견 근거:** [AUDIT_2026-08-15.md](AUDIT_2026-08-15.md)

## 갱신 규칙

- 위험 상태는 Gate 0 표에서 먼저 바꾼 뒤 이 문서의 요약을 맞춘다.
- 테스트 숫자는 전체 회귀를 실제로 다시 실행했을 때만 갱신한다.
- 브랜치의 앞선 커밋 수처럼 매번 변하는 숫자는 문서에 고정하지 않는다.
- 외부 실측을 하지 않았다면 `검증 완료`나 `배포 가능`으로 표현하지 않는다.
- **이 문서는 요약만 유지한다.** 날짜별 상세 기록이 생기면 `status/` 에 새 노트로 넣고 여기에는
  한 줄 링크만 추가한다(이 문서가 다시 길어지지 않게).
