---
updated: 2026-08-20
status: snapshot
---

# P2 소진 계획 코덱스 적대 검토 원문 (2026-08-20, gpt-5.6-sol xhigh)

> P2_CLOSEOUT_PLAN_2026-08-20.md v2 의 근거 문서. 검토 기준 커밋: dev 262c15bd,
> feat/share-reconciliation 9034aaa3, feat/manage-ui 05fa13a0 (이후 dev 12f2be03 에 병합됨).

결론부터 말하면 초안 v1은 그대로 승인할 수 없습니다. A 13건 중 9건만 확정, 4건은 부분 해소입니다. 또한 A~F에 없는 현행 잔여가 다수 있어 현재 상태로는 “알고 있는데 안 고친 것 0”이 성립하지 않습니다.

검토 기준은 다음과 같습니다.

- `DEV` = `D:\ClaudeCode\MV-hub-S-dev` (`dev`, `262c15bd`)
- `R3` = `...\scratchpad\recon-wt` (`9034aaa3`)
- `M8` = `...\scratchpad\manage-wt` (`05fa13a0`)

## 1. A 표 판정

| 항목 | 판정 | 코드 근거와 결론 |
|---|---|---|
| A1 RL-11 보상 | ✅ 확정 | `R3\backend\app\repo\share_state_intents.py:212-253`에서 서버 호출 전 영속 원장을 UPSERT하고, `:630-759`에서 로컬 상태 적용과 원장 종결을 한 트랜잭션·CAS로 묶는다. `R3\backend\app\services\share_state_reconciler.py:101-152,253-326,568-619`가 서버 권위 상태를 다시 관측하고 재시작 후에도 주기적으로 수렴시킨다. `R3\backend\app\routers\share.py:183-234,397-480`도 서버 성공 후 로컬 실패를 `waiting_local`로 남긴다. 따라서 REVIEW의 “재-finalize 1회성 보상” 요구는 3b까지 포함하면 영속 원장으로 완전히 대체된다. B4의 로컬 행 부재 무한 재시도는 별도 위생 문제다. |
| A2 poison 행 | 🔶 부분 | 디코드 불가 행은 `DEV\backend\app\services\account_report_delivery.py:44-59`, `repo\manage_account_reports.py:185-206`에서 dead-letter되고, 행별 전송이라 정상 행을 막지 않는다. 그러나 `DEV\backend\tests\test_account_report_delivery.py:193-210`은 HTTP 409를 명시적으로 “retryable이며 dead-letter 아님”으로 고정한다. REVIEW `:69`의 “디코드 불가·영구 409” 중 영구 409는 남았다. **B 강등:** 항목별 영구 거부 ACK 또는 관리자가 특정 행만 격리하는 경로. 모든 409 일괄 격리는 금지. |
| A3 remap 거래 중복 | ✅ 확정 | `DEV\backend\app\repo\manage_transactions.py:26-35,59-103`이 이메일 기반 안정 ID와 옛 행 이중 대조를 사용한다. `manage_schema.py:473-543`은 기존 중복을 병합·역산·삭제하고 이메일 기반 UNIQUE 인덱스를 만든다. |
| A4 watcher 죽은 핸들 | ✅ 확정 | `DEV\backend\app\services\asset_watcher.py:328-439`의 세대 번호 기반 스케줄링과 `:477-583`의 건강검진·유예·백오프·identity 비교가 삭제/재생성을 감지한다. 재스케줄 시 `:568-575`에서 옛 핸들을 먼저 unschedule한다. |
| A5 watchdog 오진·TOCTOU | ✅ 확정 | `DEV\tools\server_watchdog.py:285-304`는 ready 본문까지 검증하고, `:397-415`는 정확한 실행 경로와 생성 시각을 식별한다. `:500-538`은 kill 직전 PID·CommandLine·CreationDate·포트 소유를 다시 검사하며, `:643-660`은 포트 탈취를 경보 전용으로 처리한다. 단, `MV_agent.bat:178`의 별도 무차별 taskkill은 A5 범위 밖이며 누락 항목이다. |
| A6 `_mark_success` 고착 | ✅ 확정 | `DEV\backend\app\services\worker_backup.py:896-919`의 성공 기록 예외는 자식 프로세스를 비정상 종료시킨다. 부모는 `:1115-1163`, 특히 `:1147-1150`에서 non-zero 종료의 `running` 행을 즉시 pending으로 되돌린다. 재부팅 복구도 `:628-635`에 있다. |
| A7 AUTH-off 1008 | ✅ 확정 | `M8\backend\app\main.py:837-852,875-881`이 인증 실패와 `auth-off-local-only`를 분리한다. `M8\frontend\src\lib\progressSocket.ts:58-80`은 AUTH-off 정책 거부 시 토큰을 지우지 않고, 실제 인증 실패만 로그아웃시킨다. |
| A8 selector 리셋 | ✅ 확정 | `M8\frontend\src\components\ManageWindow.tsx:33-57`은 창에서 선택한 뒤 storage 이벤트를 무시하며, `:123-127`에서 사용자 선택 시 pinned 상태가 된다. 원래의 “소리 없는 리셋”은 닫혔다. 고정 상태를 화면에 표시할지는 별도 UX 결정이다. |
| A9 archived 구분 | ✅ 확정 | `M8\frontend\src\components\manage\TableView.tsx:117,246-249,296`, `KanbanBoard.tsx:71,102-105`, `styles\composition-manage.css:420-427`에서 행/카드 흐림과 “보관됨” 배지를 모두 적용한다. |
| A10 출처 라벨 | 🔶 부분 | 프로젝트 요약은 `M8\frontend\src\components\manage\DashboardView.tsx:399-407`, 텔레메트리 사용량은 `WorkspaceUsageDashboard.tsx:635-643`에 출처가 있다. 그러나 REVIEW `:101`이 요구한 시퀀스 카드에는 `DashboardView.tsx:221-228`처럼 프로젝트 범위만 있고 출처가 없다. **B 강등:** 시퀀스 카드에 라이브러리/폴더 파생 출처 라벨 추가. |
| A11 혼합 배포 과금 창 | 🔶 부분 | `DEV\backend\app\routers\gen_requests.py:84-142,416-476`은 신 서버가 capability와 `agent_id` 없는 구 에이전트의 새 claim을 막는다. 하지만 구 서버에서 이미 `submitting`을 받은 구 에이전트는 `DEV\agent_push.py:1690-1698`처럼 `claim_phase`가 없어 지연 후에도 `generate create`를 실행한다. `repo\gen_requests.py:1145-1203`의 30분 lease와 신 게이트는 기존 claim을 취소하지 못한다. 따라서 REVIEW의 정확한 “격리↔지연 create 30분 창”은 배포 순서 없이 닫히지 않는다. **B/P1 강등:** 생성 일시중지 → 기존 non-terminal/submitting 및 진행 중 provider 작업 0 확인 → 서버/에이전트 전환 순서를 강제하는 rollout fence. `RISK_REDUCTION_PLAN:573-576`도 이 전제를 요구한다. |
| A12 부팅 백업 | 🔶 부분 | `DEV\backend\app\services\worker_backup.py:186-254,430-448`은 값싼 source signature로 동일 세트를 복사 전에 걸러낸다. 반복 부팅의 “비용 후 중복판정”은 해결됐다. 하지만 첫 부팅·변경된 백업은 `:450-469`에서 여전히 전체 복사·비밀 제거·검증·해시를 수행하고, `DEV\backend\app\main.py:333-346`은 이를 readiness 전에 `await asyncio.to_thread(...)`한다. 이벤트 루프는 막지 않지만 서버 준비 완료는 기다린다. **B 강등:** 관리되는 백그라운드 bootstrap 또는 readiness 시간 예산과 실패/종료 추적. |
| A13 동기 SQLite 이벤트 루프 | ✅ 확정 | `DEV\backend\app\services\media_preservation.py:44-60,80-120,139-159`의 저장소 호출은 모두 `to_thread`다. `worker_backup.py:1106-1163`도 복구·due 검사·상태 DB 작업을 `to_thread` 또는 별도 자식 프로세스로 보낸다. 부팅 bootstrap 역시 `main.py:337-338`에서 `to_thread`다. A12의 readiness 대기는 남지만 REVIEW의 이벤트 루프 정지는 닫혔다. |

판정 합계는 **✅ 9건 / 🔶 4건 / ❌ 0건**입니다.

추가로 A1과 A7~A10은 각각 `feat/share-reconciliation`, `feat/manage-ui`에만 있고 현재 `dev`에는 들어 있지 않습니다. 따라서 “배치 코드에서 해결”과 “dev에서 해결”을 구분해야 합니다. F1이 실제 병합되기 전에는 REVIEW에 dev 해소로 기록하면 안 됩니다.

## 2. 누락 항목

### 2-1. REVIEW·BACKLOG·Gate 문서에서 누락된 항목

1. **일반 생성 요청 자체 멱등성 완료 기록 누락**

   BACKLOG `:21-23,41`의 핵심 배치 1 성과인데 A에 없다. 실제 구현은 `DEV\backend\app\routers\gen_requests.py:254-273,316-340`, `repo\gen_requests.py:489-586`에 있다. A14로 올려야 한다.

2. **restore finally 제외 기록 누락**

   BACKLOG `:9`에서 이미 해결로 제외했다. `DEV\backend\app\services\restore_runtime_verify.py:213-229`가 종료 오류가 원인 예외를 가리지 않게 한다. A 또는 “검토 후 제외” 목록에 넣어야 전수 장부가 맞다.

3. **HF provider 멱등키 미지원 계약 누락**

   BACKLOG `:21-23,40`은 provider가 공식 멱등키를 지원하기 전까지 자동 유료 재시도를 금지한다. D2 webhook과 다른 문제다. 별도 D 항목으로 “공식 지원 확인 전 recovery_required 유지” 조건을 기록해야 한다.

4. **팀탭 비공개 뱃지 집계 종결 누락**

   BACKLOG `:34`의 “viewer별 집계가 맞고 문서화로 종결”이 A~F에 없다.

5. **구 배포본 정리 트랙 누락**

   BACKLOG `:30-32,51`의 `D:\ClaudeCode\MV-hub-S` 실사용 여부 조사·Jay 승인 절차가 C3의 고아 파일 분류와 섞여 사라졌다. 별도 F/E 항목이어야 한다.

6. **Gate 5 시간 기반 실측 누락**

   `RISK_REDUCTION_PLAN:497,606-607,735-736`의 공유 서버 5분 단절·복구와 최신 코드 8시간 스테이징 soak가 E에 명시되지 않았다. E4의 “혼합 버전 연속 실측”만으로는 합격 기준이 불명확하다.

### 2-2. AUDIT 원목록 정규화 전제의 반례

`AUDIT_2026-08-15.md:111-162`에서 다음 항목들은 현재 dev 코드에도 존속하지만 초안 A~F와 Gate 0 표 어디에도 없습니다.

| 우선 | 잔여 항목 | 현재 코드 근거 |
|---|---|---|
| P1 | URL 기반 타 사용자 generation adopt | `DEV\backend\app\repo\generation_sync.py:76-87`이 URL만으로 전역 행을 찾고 creator/account 조건 없이 adopt하며, `:116-140`에서 그 행의 상태·job_id 등을 갱신한다. 타 사용자 행 오염 가능성이 있어 단순 P2가 아니다. |
| P1 | `MV_agent.bat` 무차별 포트 kill | `DEV\MV_agent.bat:174-182`, 특히 `:178`은 지정 포트의 모든 LISTEN PID를 경로 확인 없이 `taskkill`한다. A5 watchdog 강화와 무관하다. |
| P2 | 스레드→이벤트 루프 신호 비안전 | `DEV\backend\app\services\agent_signals.py:22-49`의 `asyncio.Event.set()`과 dict/set 변경을 동기 라우트가 직접 호출한다. 실제 호출자는 `routers\ingest.py:576-590`, `routers\auth.py:142-146,276-282`처럼 threadpool에서 실행되는 `def` 핸들러다. |
| P2 | MCP 백필 workspace 일괄 오귀속 | `routers\ingest.py:200-204,361-373`이 페이지 전체에 현재 요청의 단일 workspace를 적용한다. 과거 잡별 workspace를 보존하지 못한다. |
| P2 | 주기 sync 실패 무음 | `services\syncer.py:231-237`은 CLI 오류를 완전히 삼키고 기타 오류도 `print`만 한다. 운영 상태·구조화 경보에 연결되지 않는다. |
| P2 | `folder_counts` `\x00` fail-open | `repo\projects.py:546-568,584-604`는 sentinel이면 creator 조건 자체를 생략한다. 라우터는 `routers\projects.py:190-215,219-249`에서 이를 내 작업 집계에 사용한다. |
| P2 | `get_my_uid` 비결정적 선택 | `repo\identity.py:56-63`은 후보가 여러 개일 수 있는데 `ORDER BY` 없는 `LIMIT 1`이다. |
| P2 | facet와 기본 목록의 archived 불일치 | 기본 목록은 `repo\generations_query.py:154-161`에서 보관 프로젝트를 제외하지만, `repo\facets.py:13-36`의 색상·태그 쿼리는 보관 프로젝트를 제외하지 않는다. |
| P2 | `/media-thumb` 오픈 리다이렉트 | `routers\library.py:504-520,531-537`은 임의 HTTP(S) `src`의 캐시·생성 실패 시 그대로 RedirectResponse한다. |
| P2 | 썸네일 TOCTOU/500 | `services\thumbs.py:74-89`은 `is_file()` 확인 뒤 `stat()`을 예외 처리 없이 호출한다. 그 사이 파일 교체·삭제가 있으면 요청이 500으로 끝난다. |
| P2 | `.thumbs` 평면 전량 스캔 | `services\thumbs.py:198-220`은 eviction마다 평면 폴더 전체를 `iterdir`하고 정렬한다. |
| P2 | `imp/cap` 합본의 실제 파일 경계 과대 | `routers\assets.py:293-295`는 합본 루트를 `ASSETS_ROOT` 전체로 반환한다. 트리는 `captures/imports`만 표시하지만 `/file`은 `:644-650`에서 합본 루트 아래 임의 상대 경로를 허용한다. |
| P2 | Resolve pending 20개 창 잠식 | `services\resolve_transfer.py:256-295`은 먼저 최신 파일 `paths[:limit]`을 자른 뒤 이미 완료된 manifest를 걸러낸다. 최신 20개가 완료 상태면 더 오래된 실제 pending이 계속 가려진다. |
| P2 | 앱 lifespan cleanup 비보장 | `backend\app\main.py:327-422`는 bare `yield` 뒤에 cleanup을 둔다. `_application_lifespan` 자체에 `try/finally`가 없어 실행 중 예외가 generator에 주입되면 `:388-422`가 보장되지 않는다. 바깥 `lifespan:425-445`는 로깅만 한다. |
| P2 | `hf_cli_version.txt` BOM | `MV_agent.bat:142-150`은 `set /p`와 공백 trim만 하며 UTF-8 BOM은 제거하지 않는다. Python 쪽 일부는 `utf-8-sig`를 쓰지만 실행 BAT의 pin 판정은 별개다. |
| P2 | 프론트 assets 스키마 가드 비대칭 | `frontend\src\components\ThumbnailGrid.tsx:397`, `GenerationCard.tsx:124`, `lib\generationGrid.ts:18-24`에서 `assets` 자체가 없을 때 런타임 오류가 가능하다. |
| P2 | 회색 필터 자동 페이지 연쇄 | `frontend\src\App.tsx:594-599`은 현재 페이지가 전부 가려지면 활성 항목이나 끝을 만날 때까지 연속 `loadMore()`한다. 데이터 분포에 따라 다수 페이지를 자동 순회한다. |

따라서 초안 `:7`의 “AUDIT 원목록은 Gate 0로 정규화 완료 — 재조사 불필요”는 반례가 충분하므로 삭제해야 합니다.

## 3. 분류 이의와 설계 리스크

### P1로 먼저 올려야 할 항목

- **A11 잔여 rollout fence:** 금전 중복 위험이다. “배포 순서 주의”가 아니라 배포 전 생성 중지와 non-terminal 0 검증이 실행 가능한 체크리스트/게이트여야 한다.
- **B4 terminalization 설계:** 잘못 닫으면 서버 공유·골드 상태와 로컬 표시의 불일치를 조용히 숨길 수 있다.
- **B7 잠금 키 드리프트:** 공유·해제·골드 변경의 직렬화가 깨지는 상태 경쟁이다.
- **URL cross-owner adopt:** 다른 사용자의 행을 갱신할 수 있는 데이터 경계 문제다.
- **`MV_agent.bat` 포트 kill:** 다른 프로그램을 강제 종료할 수 있다.

### B2 쿼터 증분 회계의 함정

현재 `media_cache.py:169-200`은 실제 디스크 파일을 권위값으로 전량 합산하고, `:203-220`은 새 파일이 이미 생성된 뒤 전역 락 안에서 상한을 검사한다. 단순 `total += bytes_added`로 바꾸면 다음 문제가 생긴다.

- 시작 시 기준값을 계산하는 동안 새 다운로드가 겹치지 않도록 초기화 상태와 락이 필요하다.
- 다운로드 완료와 카운터 증가 사이의 프로세스 종료를 복구해야 한다.
- 초과 파일 삭제가 실패하면 카운터만 되돌리면 안 된다. 물리 파일은 여전히 공간을 쓴다.
- 수동 삭제, 이전, 샤딩 마이그레이션, 외부 파일 변경에 따른 증감도 반영해야 한다.
- `bytes_cached`는 작업별 통계이므로 전역 물리 사용량의 권위 원장으로 재사용하면 중복 계산된다.
- 여러 URL의 동시 다운로드가 각각 낡은 잔여 용량을 보고 승인되지 않도록 예약 또는 직렬화가 필요하다.
- 주기 drift 스캔뿐 아니라 상한 근처에서는 보수적 재검산이 필요하다.
- 시작 스캔을 readiness에 다시 동기적으로 얹으면 B2가 A12 문제를 재도입한다.

권장 설계는 “시작 시 전체 계산 → 상태가 준비될 때까지 신규 보존을 보수적으로 제한 → 전역 락 안에서 실제 파일 확정과 증감 → 주기 drift 교정”이다. 성능 개선은 P2지만 잘못 구현한 디스크 상한 우회는 P1급 운영 위험이다.

### B4 원장 위생의 함정

현재 `R3\repo\share_state_intents.py:667-689`은 로컬 행을 찾지 못하면 무조건 `False`, `services\share_state_reconciler.py:298-326`은 이를 다시 `waiting_local`로 만든다. 서버 missing도 `:141-148`에서 단순 `{shared:false, final:false}` 관측으로 바뀐다.

“로컬 없음 + 서버 missing이면 종결” 한 규칙으로는 부족하다.

- `local_id=None`인 원격 전용 카드: 애초에 로컬 미러가 필요 없는 요청일 수 있다.
- `local_id`가 있었는데 사라짐: 계정 DB 전환·동기화 지연·데이터 유실을 구분해야 한다.
- `prepared + 서버 missing + 관측=base`: 서버 호출 전 크래시이므로 rejected로 닫을 수 있다.
- 서버에 행이 존재하지만 로컬만 없음: 즉시 converged로 닫으면 이후 로컬 materialize 기회를 잃는다.
- 유한 유예 후 `orphaned/local_missing` 같은 terminal 상태와 진단 정보를 남겨야 한다.
- terminal 전환은 기존 `intent_seq` CAS를 유지해야 한다.

즉, “원격 카드라 로컬 불필요”와 “원래 있어야 할 로컬이 사라짐”을 스키마에서 구분한 뒤 상태표를 만들어야 한다.

### 기타 분류 이의

- **B5 백업:** “코드 주석으로 순서 보장 명문화”라고 쓰면 안 된다. `backup.py:228-260`은 이미 `ATTACH → BEGIN → 각 DB 첫 읽기 → 각 backup()`을 수행하지만 각 별칭의 첫 읽기는 순차적이다. 특히 SQLite 공식 문서도 WAL에서 attached DB 세트 전체의 원자성을 보장하지 않는다고 명시한다. 코드 주석만으로 동일 시점 보장이 증명되지는 않는다는 판단이다. [SQLite ATTACH 공식 문서](https://sqlite.org/lang_attach.html)  
  REVIEW가 문서 수준 위험 수용을 택한다면 “동일 시점 보장”이 아니라 “미세 중복/불일치 가능성과 restore 시 검출·복구 규칙”을 문서화해야 한다.
- **B6 reducer 적용:** BACKLOG `:26-27` 자체가 “실측된 hotspot만”이라고 한다. 측정 결과가 아직 없으므로 B가 아니라 C로 이동해야 한다.
- **B7 위치:** 프론트 C2 배치가 아니다. `share.py:302-310,407-415,518-525`와 `publish.py:459-479`의 백엔드 잠금 문제다. P1 백엔드 배치로 분리해야 한다.
- **B8 pinned 표시:** 원래 기능 결함은 A8에서 해결됐다. 아이콘은 UX 선택이므로 B의 필수 수정이 아니라 D/F 결정 항목이다.
- **D1 외부 보존 tier:** 착수 조건이 “용량 압박·팀 확대”만이면 부족하다. 단일 디스크 고장 시 허용 손실량, 복구 목표와 최종 원본의 중요도도 조건에 포함해야 한다.
- **D4 팩트 기반 작업 탭:** “사용자가 불편을 보고하면”만으로 보류하지 말고, 현재 파생 모델이 잘못된 상태를 만들지 않는다는 데이터 불변식과 우회 절차를 먼저 문서화해야 한다.

### 실행 순서

F1이 모든 작업의 선행 조건은 아닙니다.

- F1 결정/병합이 선행되어야 하는 것: A1·A7~A10의 dev 종결 선언, B4·B7처럼 기능 브랜치 코드를 직접 수정하는 작업.
- F1과 무관하게 지금 가능한 것: B1·B2·B3, AUDIT 누락 수정, dev 예행 측정, 문서 대조.
- 오히려 실제 병합 전 “A 13건 종결 문서 커밋”을 먼저 하면 dev 상태를 거짓으로 기록한다.

권장 순서는 다음입니다.

1. 기능 브랜치 병합 방식 결정 및 실제 반영 여부 확정.
2. A11 rollout fence, B7, B4 설계, cross-owner adopt, 무차별 port kill 등 P1 경계 해결.
3. 읽기 전용 기준선 측정은 위 작업과 병렬 또는 그보다 먼저 실시.
4. A2·A10·A12 잔여와 AUDIT 누락 P2 처리.
5. B2는 회계 불변식과 장애 복구 테스트를 먼저 설계한 뒤 구현.
6. B1·B3 같은 위생 작업.
7. 실제 dev 반영을 확인한 뒤에만 REVIEW/A/D 종결 문서 갱신.
8. 외부 파일·구 배포본 삭제는 마지막에 별도 Jay 승인.

## 4. 총평

현재 초안대로는 **“알고 있는데 안 고친 것 0” 주장이 성립하지 않습니다.**

근거는 다음과 같습니다.

- A 13건 중 4건이 부분 해소다.
- A1과 A7~A10은 아직 dev에 병합되지 않았다.
- REVIEW/BACKLOG/Gate 문서 항목 6개가 장부에서 누락됐다.
- AUDIT 정규화 전제를 뒤집는 현행 코드 잔여가 최소 17개 확인됐다.
- B2·B4는 현재 설명대로 구현하면 새 P1 문제를 만들 수 있다.
- D/E가 남는 이상 정확한 표현은 “알고도 안 고친 것 0”이 아니라 **“추적되지 않은 알려진 잔여 0”**이어야 한다.

초안 v2에서는 A를 9건 확정·4건 부분으로 고치고, 누락 목록과 AUDIT 반례를 B/C/D/E에 모두 배치한 뒤에야 closeout 계획으로 사용할 수 있습니다.

## 5. 작업 완료 보고

1. 변경한 파일: 없음
2. 변경 이유: 요청대로 읽기·보고만 수행했으며 수정·커밋하지 않음
3. 검증 방법: 초안 전문, REVIEW P2 전 항목, Gate 0 및 후속 Gate, BACKLOG, AUDIT 원목록을 세 워크트리 코드와 파일:줄 단위로 정적 대조
4. 남아있는 위험 요소: 테스트·실행 서버·운영 데이터는 요청에 따라 사용하지 않았으므로 실제 부하·배포 순서·물리 복원 결과는 검증하지 않음
5. 다음 권장 작업: 위 판정을 반영한 초안 v2를 먼저 작성하고, P1 경계와 기능 브랜치 병합 상태부터 재검토
