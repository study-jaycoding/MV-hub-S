# 테스트 실행 가이드

테스트용 런처는 파일명 앞에 **`test_`**가 붙는다. 나머지 `MV_server.bat`·`MV_agent.bat` 등은 운영/실사용이다.
평소 개발은 내 PC의 **실시간 개발 모드**를 쓰고, 로그인·권한·빌드 결과까지 최종 확인할 때는
내 PC의 **서버형 테스트 모드**를 쓴다. 최신 운영 DB가 필요하면 서버가 먼저 격리 스냅샷을
준비하고 내 PC가 그 복사본만 내려받는다. 모든 테스트 데이터는 운영(8010)과 분리된다.

★테스트 스냅샷은 **정제된 테스트용 데이터**다(`services/db_scrub.py`): 운영 서명키
(`auth_secret`)·세션 토큰·운영 계정 비밀번호 해시가 제거된다. LAN에 잠시 열리는 서버측
중간 사본에는 로그인 가능한 계정이 하나도 없다. 일회용 코드로 내려받은 최종 로컬 사본에만
테스트 관리자 `test-admin@mvhub.local` / `mvhub-test-1234`가 추가된다. 이 계정은
`127.0.0.1` 테스트에서만 사용하며 운영 계정으로 테스트 서버에 로그인할 수 없는 것이 정상이다.
서버측 8011은 헬스 체크와 스냅샷 다운로드 외의 가입·로그인·일반 API·화면도 모두 닫힌다.

## 개발자 자동 테스트 기준선

백엔드 테스트 의존성은 운영용 `requirements.txt`와 분리된 `requirements-dev.txt`로 설치한다.
이 파일에는 일반 테스트용 `pytest`뿐 아니라 100명 부하 시험의 자원 측정용 `psutil`도 포함된다.

> [!NOTE]
> **venv 위치는 클론마다 다르다.** 아래는 저장소 루트에 `.venv` 를 두는 형태(현재 개발 클론 기준)다.
> 다른 위치를 쓰면 그 Python 실행 파일의 정확한 경로로 바꿔서 실행한다.

```powershell
# 저장소 루트에서 최초 1회
py -3 -m venv .venv
& '.\.venv\Scripts\python.exe' -m pip install -r backend\requirements-dev.txt

# 테스트는 backend 폴더 기준으로 실행한다
$env:CONTENT_HUB_NO_PROXY = '1'
Push-Location backend
try { & '..\.venv\Scripts\python.exe' -m pytest -q -p no:cacheprovider }
finally { Pop-Location }
```

`py` 런처가 없거나 `python` 이 Microsoft Store 별칭으로 연결되면, 설치된 Python 3.11+ 의
정확한 실행 파일 경로로 첫 줄만 실행한다.

프론트엔드는 `frontend` 폴더에서 실행한다.

```powershell
npm.cmd ci
npm.cmd run lint:architecture
npm.cmd test -- --run
npm.cmd run build
```

`lint:architecture`는 P1 단계에서 경고 우선으로 운영한다. 종료 코드는 성공이어도
표시된 경고는 현재 구조 부채이며, 새 경고를 만들지 않는 것을 원칙으로 한다.

자동 테스트는 운영 DB가 아닌 `CONTENT_HUB_DB` 또는 `CONTENT_HUB_DATA` 임시 경로를 사용한다.

### 사전 배포 통합 게이트

프로젝트 루트의 깨끗한 작업 트리에서 아래 명령 하나로 백엔드·프론트 전체 테스트, production build,
SQLite 백업·복원과 100명 부하를 순서대로 실행한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\predeploy_gate.ps1
```

100명 부하는 기본적으로 격리 서버에 논리 CPU 2개와 `below-normal` 우선순위, 최대 RSS 512MB를
적용해 60초씩 2회 실행한다. 다른 조건이 꼭 필요하면 `-LoadServerCpuCores`,
`-LoadServerPriority`, `-LoadMaxRssMb`를 명시하고 결과 JSON에 남은 값을 함께 보고한다.
`-SkipLoad`, `-SkipBackupDrill`, `-AllowDirty` 결과는 빠른 개발 확인용이며 최종 배포 승인 근거로
사용하지 않는다.

## 생성 제출 중단 복구(RL-05)

이 검증은 같은 유료 생성을 자동으로 두 번 제출하지 않는 상태 계약을 확인한다. 먼저 비용이 들지
않는 대상 테스트를 실행하고, 그다음 전체 회귀를 실행한다. PowerShell에서 프로젝트 루트를 기준으로
실행한다.

```powershell
cd backend
python -m pytest -q -p no:cacheprovider `
  tests\test_generation_state_engine.py `
  tests\test_gen_request_usecase.py `
  tests\test_identity_permissions.py `
  tests\test_agent_contracts.py `
  tests\test_operational_health.py

cd ..\frontend
npm.cmd test -- --run `
  tests\generationDisplay.test.ts `
  tests\generationRecoveryApi.test.ts
```

필수 판정은 다음과 같다.

- CLI 호출 전 `claimed` 중단은 만료 뒤 `pending`으로 돌아간다.
- CLI 호출 후 결과가 불명확한 `submitting`은 `recovery_required`로 격리된다.
- 일반 재생성 API와 버튼으로 `recovery_required`를 우회할 수 없다.
- 사용자가 외부 작업이 없음을 명시적으로 확인한 경우에만 다시 `pending`으로 돌릴 수 있다.
- ACK 응답이 유실된 경우 같은 멱등 요청을 재전송하되 유료 CLI를 중복 호출하지 않는다.

대상 테스트가 통과해도 완료는 아니다. 백엔드·프론트 전체 회귀, 프론트 빌드, 업데이트 경로 테스트,
비용이 들지 않는 중단·재시작 DB 드릴과 적대적 리뷰까지 통과해야 한다. 실제 Higgsfield 생성과
실제 제출 중단은 크레딧을 사용할 수 있으므로 사용자 승인 없이 실행하지 않는다. 세부 완료 조건은
[GENERATION_SUBMISSION_RECOVERY.md](GENERATION_SUBMISSION_RECOVERY.md)를 따른다.

비용 없는 중단·재시작 DB 드릴은 프로젝트 루트에서 실행한다.

```powershell
python tools\verify_generation_submission_recovery.py
```

출력의 `database`는 `temporary`, `paid_cli_called`는 `false`, 마지막 `ok`는 `true`여야 한다.

> [!IMPORTANT]
> **아래 각 항목에 적힌 모든 테스트 개수는 그 기능을 구현하던 시점의 기록이다.**
> "합격 조건 N개" 뿐 아니라 "전체 회귀에서는 백엔드 N개" 같은 전체 수치도 마찬가지다.
> 테스트는 계속 늘어나므로 지금 실행하면 대부분 그보다 많이 나온다(그 자체는 정상이다).
> 이 숫자를 현재 합격 기준으로 재사용하지 말고, 병합 전에는 **전체 테스트를 다시 실행한
> 결과**로 판단한다.
> 마지막으로 기록된 전체 회귀는 [CURRENT_STATUS.md](CURRENT_STATUS.md) 를 본다.

## Git 업데이트 bootstrap 회귀(RL-25)

서버 Git 클론의 `update_git.bat`은 저장소 안 작업 스크립트가 업데이트 도중 교체돼도 현재 실행이
깨지지 않도록 임시 복사본을 실행한다. 해시 비교는 PowerShell 부가 모듈 자동 로딩에 의존하지 않고
.NET SHA-256을 사용한다.

```powershell
cd backend
py -3 -m pytest `
  tests\test_sparse_checkout_scripts.py `
  tests\test_release_update.py `
  tests\test_verify_requirements.py -q
```

합격 조건은 40개 통과다. 여기에는 빈 `TEMP`, 공백이 있는 설치 경로, 실행 중 작업자 교체,
교체된 새 작업자로 정확히 한 번 재시도, 원래 실패 코드 전달, 임시 작업자 파일 회수가 포함된다.
테스트는 별도 임시 저장소와 가짜 작업자를 사용하므로 현재 클론을 pull하거나 서버를 재시작하지 않는다.

## 견적 CLI 과부하·취소 회귀(RL-08)

```powershell
cd backend
py -3 -m pytest `
  tests\test_cli_bridge_contract.py `
  tests\test_gen_request_usecase.py -q
```

합격 조건은 24개 통과다. 100개 견적을 동시에 요청해도 CLI 실행 구간은 기본 2개 이하여야 하고,
마지막 비용 캐시에는 100개가 모두 있어야 한다. Windows 실측은 테스트 전용 부모가 만든 손자
프로세스를 취소한 뒤 2초 후 생존 마커가 생기지 않는지 확인한다. 실제 Higgsfield CLI와 크레딧은
사용하지 않는다. 서버 종료 테스트는 남은 견적 task가 모두 취소·회수되고 집합이 비는지 확인한다.

## 인증 실패 의미 보존 회귀(RL-09)

업무 API 하나의 `401`이 로그인 전체를 지우지 않는지 확인한다. 같은 토큰의 `/api/auth/me`가
`401`일 때만 확정 만료로 처리한다.

```powershell
cd backend
py -3 -m pytest tests\test_proxy_auth_semantics.py -q

cd ..\frontend
npm.cmd test -- --run tests\httpAuthPolicy.test.ts
```

합격 조건은 백엔드 12개·프론트 5개 통과다. 백엔드에는 실제 TCP 요청, 100개 동시 `401`의
단일 확인, 느린 확인 중 비대기, 재로그인 경쟁 조건이 포함된다. 전체 회귀에서는 백엔드 758개,
프론트 75개 파일·527개가 통과해야 한다. 세부 판단 규칙은
[AUTH_FAILURE_SEMANTICS.md](AUTH_FAILURE_SEMANTICS.md)를 따른다.

격리 브라우저에서는 로그인 후 `작업 공간`과 `공유 & 리뷰`를 전환해 화면이 유지되고 콘솔 오류가
0건인지 확인한다. 이 검증은 실제 공유 서버의 만료 토큰·혼합 버전 업데이트를 대신하지 않는다.

## 텔레메트리 네트워크·로컬 응답 분리 회귀(RL-10)

```powershell
cd backend
py -3 -m pytest `
  tests\test_telemetry_delivery.py `
  tests\test_manage_telemetry.py `
  tests\test_ingest_core.py `
  tests\test_syncer_telemetry.py `
  tests\test_touch_telemetry.py -q
```

`dfaa2672`의 합격 기준은 37개 통과다. 동기 작업자 100개의 예약 합치기, 느린 원격 전송
중 다른 drain의 0.2초 이내 반환, 네트워크 대기 중 SQLite 유지보수 게이트와 새 dirty 쓰기,
동일 밀리초 재변경의 정수 revision CAS, 구버전 DB 마이그레이션, 전송 실패 뒤 상태 해제·재시도,
종료 대기를 확인한다. 이 묶음은 실제 공유 서버가 아니라 제어 가능한
느린 전송 함수를 사용한다. 따라서 실제 운영 공유 서버의 장시간 지연과 혼합 버전은 Gate 6에서
별도로 확인한다. 세부 계약은 [TELEMETRY_DRAIN_LIFECYCLE.md](TELEMETRY_DRAIN_LIFECYCLE.md)를
따른다.

로컬 앱 실측은 `test_dev.bat`을 실행해 `/api/ready`, 작업 공간→공유 & 리뷰→캔버스 전환,
앱 출처의 콘솔 오류 0건, 종료 뒤 5173·8012 포트 반환을 확인한다. 생성 버튼은 누르지 않아도 된다.
운영용 8010 프로세스가 이미 있다면 테스트 종료 뒤에도 그대로 살아 있어야 한다.

## 공유·최종 상태 보상 회귀(RL-11)

```powershell
cd backend
py -3 -m pytest tests\test_share_state_consistency.py -q
```

`18d63560`의 직접 합격 기준은 12개 통과다. 최종 생성물의 공유 해제를 원격 호출 전에 막는지,
명시적인 생성물 부재와 구버전 라우트 부재 `404`를 구분하는지, 원격 최종 해제 뒤 로컬 쓰기 실패를
재시도·재조회·원격 재최종 지정으로 보상하는지 확인한다. 실제 임시 SQLite DB 검증도 포함한다.

관련 공유·프록시·감사 묶음은 62개, 백엔드 전체는 778개가 통과해야 한다. 이 검증은 실제 공유
서버의 서로 다른 두 계정 왕복을 대신하지 않는다. 세부 계약은
[SHARE_STATE_COMPENSATION.md](SHARE_STATE_COMPENSATION.md)를 따른다.

## 텔레메트리 마지막 성공 관측 회귀(RL-12)

```powershell
cd backend
py -3 -m pytest `
  tests\test_sync_status.py `
  tests\test_manage_telemetry.py `
  tests\test_telemetry_delivery.py `
  tests\test_operational_health.py -q

cd ..\frontend
npm.cmd test -- --run tests\syncStatus.test.ts
```

`46c6198b`의 합격 기준은 백엔드 38개와 프론트 3개다. 실제 CAS 성공만 마지막 성공 시각을
갱신하고, 같은 생성물의 재dirty·늦은 ACK·전송 없는 큐 정리는 거짓 성공을 만들지 않아야 한다.
프레시 DB의 `/api/sync-status`는 outbox나 상태 테이블을 만들지 않아야 하며, 기존 DB의
`pushed_at`은 최초 마이그레이션에서 UTC ISO 시각으로 보존돼야 한다.

브라우저에서는 로컬 계정 메뉴를 열어 `마지막 성공 …`과 `대기 N건/대기 없음`이 한 줄에 보이는지,
화면 잘림과 앱 출처 콘솔 오류가 없는지 확인한다. 공유 서버 화면은 작업자 로컬 큐가 아니므로 이
상태를 폴링하거나 표시하지 않는다. 이 내부 검증은 실제 공유 서버 장애·복구 왕복을 대신하지 않는다.

## 계정 상태·거래 보고 유실 복구 회귀(RL-13)

```powershell
cd backend
py -3 -m pytest `
  tests\test_account_report_delivery.py `
  tests\test_ingest_core.py `
  tests\test_manage_transactions.py `
  tests\test_sync_status.py -q

cd ..\frontend
npm.cmd test -- --run tests\syncStatus.test.ts
```

`9216ee96`의 직접 합격 기준은 백엔드 19개와 프론트 동기화 상태 7개다. 다음 계약을 확인한다.

- 계정 상태는 계정별 최신 스냅샷만 남고 거래는 안정 키로 중복되지 않는다.
- 동일 보고는 실패 백오프를 초기화하지 않고, 새 모델 정보는 같은 거래에 보강된다.
- 서버가 계정 상태와 거래를 모두 저장한 뒤 명시적 ACK를 반환해야 완료된다.
- 늦은 ACK는 새 revision을 지우지 않고, 404·잘못된 ACK·네트워크 오류는 큐에 남는다.
- 이메일·creator UID가 불명확하면 다른 계정으로 추측하지 않는다.
- 계정 메뉴는 생성과 계정 보고 대기·실패를 구분하고 두 채널 중 최근 실제 성공을 표시한다.

같은 작업 트리에서 백엔드 전체 790개, 프론트 76개 파일·533개, 업데이트 관련 40개,
프론트 아키텍처 검사와 프로덕션 빌드가 통과했다.

실측은 격리 Vite 5173 → 로컬 AUTH-off 8012 → 임시 AUTH-on 공유 서버 8201로 수행한다. 실패 상태에서
계정 메뉴의 `대기 2건`, `생성정보 0건 · 계정/거래 2건`과 실패 경고를 확인한 뒤 정상 신원으로
재시도해 `pushed: 2`, 대기·실패 0건, 계정 보고 마지막 성공 시각과 앱 출처 콘솔 오류 0건을
확인했다. 임시 DB와 테스트 계정만 사용하므로 실제 운영 공유 서버·실제 크레딧 왕복을 대신하지 않는다.

## Assets 파일 응답 보안 회귀(RL-14)

```powershell
cd backend
py -3 -m pytest `
  tests\test_asset_file_responses.py `
  tests\test_asset_services.py `
  tests\test_asset_permissions.py -q
```

`2a4a46f4`의 직접 합격 기준은 백엔드 19개와 허용 확장자 21개 하위 검증이다.

- 지원 이미지·영상·오디오 확장자마다 고정 `Content-Type`이 있어야 한다.
- 허용 파일은 `inline`, `nosniff`, CSP sandbox, 동일 출처 정책을 반환해야 한다.
- `.html`, `.svg`, `.js`, 이중 확장자는 파일이 존재해도 415여야 한다.
- HTML 내용이 `.png` 이름을 가져도 `text/html`로 응답하거나 실행되어서는 안 된다.
- 썸네일은 기존 캐시 정책과 nosniff를 함께 유지하고 ZIP은 attachment 다운로드를 유지해야 한다.

같은 작업 트리에서 백엔드 전체 795개, 프론트 76개 파일·534개, 업데이트 관련 40개,
프론트 아키텍처 검사와 프로덕션 빌드가 통과했다.

실측은 임시 DB와 기존 공개 PNG·HTML 파일을 사용해 8214 포트에서 수행한다. 브라우저에서 PNG가
정상 표시되고 실제 HTTP 응답이 `image/png`, `inline`, `nosniff`, CSP/CORP, `no-cache`인지 확인한다.
같은 프로젝트의 HTML 직접 요청은 415여야 하며, 종료 뒤 8214 포트가 반환돼야 한다.

## 업로드 전체 용량 경계 회귀(RL-15)

```powershell
cd backend
py -3 -m pytest `
  tests\test_upload_limits.py `
  tests\test_temp_sweeper.py `
  tests\test_db_backup_streaming.py `
  tests\test_comfy_router.py `
  tests\test_comfy_save.py `
  tests\test_asset_services.py `
  tests\test_asset_permissions.py -q
```

`5b2cf434`의 관련 회귀 묶음은 위 명령의 백엔드 79개다.

- Assets·Comfy·DB 업로드 본문은 multipart 파싱 전에 제한되어야 한다.
- `Content-Length`가 없거나 실제보다 작아도 수신 바이트가 상한을 넘으면 413이어야 한다.
- 잘못된·음수·상충하는 `Content-Length`는 400이고 정상 경계값은 통과해야 한다.
- 파싱 뒤에는 파일 수·개별 파일·파일 합계를 실제 크기로 다시 검사해야 한다.
- DB import는 전체 파일을 메모리에 읽지 않고 제한된 TEMP 스트림을 사용하며 모든 종료 경로에서
  부분파일을 지워야 한다.
- 제한 로그에는 경로·상태·상한·수신 크기만 남고 파일명·본문·프롬프트·URL은 없어야 한다.

같은 작업 트리에서 백엔드 전체 820개, 프론트 76개 파일·534개, 업데이트 관련 40개,
프론트 아키텍처 검사와 프로덕션 빌드가 통과했다.

실측은 작은 환경변수 상한과 임시 DB·Assets 루트, 8215 포트에서 수행한다. 정상 PNG는 200,
Assets 합계·Comfy 개별·DB·`Content-Length` 없는 청크 초과 요청은 413이어야 한다. 거부 뒤
`/api/ready`가 200이고 저장된 부분파일과 앱 전용 DB 임시파일이 없으며 종료 뒤 8215 포트가
반환돼야 한다. 현재 HTTP ZIP 업로드 API는 없고, 테스트 스냅샷 ZIP 추출 제한은 별도 테스트한다.

## Assets watcher 수명주기 회귀(RL-16)

```powershell
cd backend
py -3 -m pytest `
  tests\test_asset_watcher.py `
  tests\test_asset_tree_cache.py `
  tests\test_asset_services.py `
  tests\test_asset_permissions.py `
  tests\test_project_name_integrity.py `
  tests\test_project_folder_cache.py `
  tests\test_project_budget_period.py -q
```

`bb8b5843`의 집중 합격 기준은 위 명령의 백엔드 48개다.

- 같은 실제 폴더를 여러 등록자가 공유해도 watchdog 핸들은 하나여야 한다.
- 한 등록자만 해제하면 다른 등록자는 계속 감시되고 마지막 등록자 해제 때만 unschedule되어야 한다.
- 같은 등록 ID의 경로가 바뀌면 이전 핸들을 회수하고 새 경로만 알림을 보내야 한다.
- 수동 마운트 교체·삭제, 성공한 자동 프로젝트 이름/보관/렌더 루트 변경·삭제가 등록을 해제해야 한다.
- 실패한 프로젝트 수정은 기존 감시를 끊지 않아야 한다.
- 종료는 timer·pending·등록표를 비우고 Observer 스레드를 끝내며 늦은 이벤트를 무시해야 한다.

같은 작업 트리에서 백엔드 전체 826개·21 subtests, 프론트 76개 파일·534개, 업데이트 관련 40개,
프론트 아키텍처 검사와 프로덕션 빌드가 통과했다.

Windows 실측은 실제 watchdog Observer로 같은 등록의 경로 이동 100회와 같은 폴더 공유 등록 50개를
반복한다. 각각 실제 핸들·emitter가 하나만 유지되고 마지막 해제 뒤 0개, `stop()` 뒤 Observer가
종료되어야 한다. HTTP/WS 실측은 임시 Assets 루트와 8216 포트에서 수동 마운트를 이전 경로→새 경로로
교체한다. 이전 경로 변경은 무알림, 새 경로 변경은 `assets_changed`, 마운트 삭제 뒤 새 경로 변경은
무알림이어야 하며 종료 뒤 포트와 프로세스가 반환되어야 한다.

## Comfy 대형 입력 스트리밍 회귀(RL-17)

```powershell
cd backend
py -3 -m pytest `
  tests\test_comfy_cloud_client.py `
  tests\test_comfy_router.py `
  tests\test_upload_limits.py `
  tests\test_video_convert.py `
  tests\test_temp_sweeper.py `
  tests\test_comfy_save.py -q
```

`d5077be6`의 집중 합격 기준은 위 명령의 백엔드 99개다.

- 요청 spool은 전체 `bytes`로 읽지 않고 1MiB 이하 청크로 앱 전용 TEMP 파일에 복사해야 한다.
- 백그라운드 작업에는 이름·경로·크기만 넘기며, 잡별 파일명 변경이 파일 payload 복사를 만들면 안 된다.
- 로컬 경로 입력·Cloud 영상 변환·Comfy multipart 업로드는 파일 경로를 사용해야 한다.
- 실제 `urllib` 요청은 정확한 `Content-Length`를 보내고 `Transfer-Encoding: chunked` 없이 수신 길이가
  일치해야 한다.
- 정상 주입·업로드/파싱 실패·작업 스레드 시작 실패 뒤 입력과 변환 임시파일을 지워야 한다. 프로세스
  강제 종료 잔재는 24시간 이상 지난 앱 접두 파일만 sweeper가 회수해야 한다.

같은 작업 트리에서 백엔드 전체 834개·21 subtests, 프론트 76개 파일·534개, 업데이트 관련 40개,
프론트 아키텍처 검사와 프로덕션 빌드가 통과했다.

64MiB(67,108,864바이트) 실제 파일 실측은 두 단계다. 스테이징 결과 파일 크기가 원본과 같고 정리
뒤 남지 않아야 하며, Python `tracemalloc` 최대 할당은 2,232,179바이트였다. 로컬 HTTP 서버로 실제
multipart를 보냈을 때 67,109,276바이트를 완전히 받았고 본문 오버헤드는 412바이트, 최대 할당은
4,554,937바이트였다. 이는 Python 전체 `bytes` 사본 제거와 실제 stdlib 전송을 검증하지만 OS 소켓
버퍼를 포함한 전체 프로세스 RSS, 실제 Comfy Cloud·ffmpeg 대형 영상, 긴 대기열의 TEMP 디스크 용량을
대신하지 않는다. 이 세 항목은 운영과 같은 스테이징에서 별도로 확인한다.

## Comfy·Resolve 외부 실행 경계 실측(Gate 6 준비)

Comfy 실행은 실제 계정이나 크레딧을 사용하지 않고도 MV Hub 백엔드부터 외부 HTTP 경계까지
반복 검증할 수 있다. 프로젝트 루트에서 다음 명령을 실행한다.

```powershell
py -3 tools\verify_comfy_live.py
```

도구는 현재 사용자 DB와 실행 중인 개발 서버를 사용하지 않는다. 고유 임시 DB·미디어·TEMP와
별도 포트에 MV Hub를 띄우고, 실제 HTTP 가짜 ComfyUI에 이미지 3개를 업로드한다. 합격 조건은
다음과 같다.

- `cloud_requests=0`, `user_server_touched=false`여야 한다.
- 실행 3개 중 2개는 출력 PNG까지 내려받고 1개는 의도한 노드 오류로 실패해야 한다.
- 설정한 동시 실행 2를 넘지 않고 실제 최대 동시 실행이 2여야 한다.
- 실패한 prompt 하나만 `/queue delete`되고 전체 `/interrupt`는 호출되지 않아야 한다.
- 완료 뒤 앱 TEMP 입력과 `comfy_inflight_runs`가 모두 0이어야 한다.

이 검증은 로컬 Comfy 호환 HTTP 계약, 병렬 제한, 오류 격리와 정리를 확인한다. 실제 Comfy Cloud의
노드 지원 여부·계정 권한·유료 생성 결과는 확인하지 않으므로 배포 직전 실제 워크플로우 1건은
사용자 승인 뒤 별도로 수행한다.

Resolve는 실행 중인 Studio에 최신 MV Hub 스크립트가 설치된 상태에서 다음 명령으로 확인한다.

```powershell
py -3 tools\verify_resolve_live.py
```

도구는 고유한 임시 Resolve 프로젝트만 만들고 원래 프로젝트를 복원한다. `c0015`를 먼저 넣어도
`c0010, c0015`로 자연 정렬되는지, 같은 원본 재가져오기 방지, 두 클립 Render All, 출력 파일과
시퀀스 폴더 생성, 렌더 잡·테스트 프로젝트 정리까지 모두 `ok=true`여야 한다. 사용자가 작업 중인
프로젝트에는 미디어나 타임라인을 추가하지 않는다.

2026-08-19 실측에서는 Comfy 경계 3건(성공 2·의도한 실패 1), 최대 병렬 2, PNG 다운로드,
실패 prompt 한 건만 삭제, `/interrupt`·TEMP·in-flight 잔재 0을 확인했다. Resolve Studio 20.3.2에서는
Importer 0.1.1·Exporter 0.6.2로 자연 정렬·중복 방지·두 출력 렌더·시퀀스 폴더·정리를 모두 통과했다.
이 결과는 실제 유료 Comfy Cloud 노드와 계정 권한을 대신하지 않는다.

같은 작업 트리의 사전 배포 게이트는 백엔드 940개·21 subtests, 프론트 79개 파일·569개,
production build와 SQLite 복원을 통과했다. 2코어·below-normal 100명 시험은 60초씩 2회 실행해
합계 23,025건 모두 200, 2회차 p95 44.40ms·p99 131.84ms, WebSocket·에이전트 롱폴 각 100,
SQLite lock·클라이언트 오류 0, 워밍업 뒤 RSS 증가 1.62%였다. 동시 로그인 p95 7.98초는
PBKDF2 200,000회 보안 검증을 2코어에서 100개 동시에 실행한 값이며 10초 합격 기준 안이다.

## WebSocket 재연결·느린 수신자 회귀(RL-19)

```powershell
cd D:\ClaudeCode\MV-hub-S-dev
$env:PYTHONPATH="backend"
py -3 -m pytest `
  backend\tests\test_realtime_ws.py `
  backend\tests\test_operational_logging_policy.py -q

cd frontend
npm.cmd test -- --run tests\progressSocket.test.ts
```

`1f096796`의 집중 합격 기준은 백엔드 17개와 프론트 4개다.

- 느린 소켓 하나가 2초를 넘겨도 정상 소켓은 먼저 수신하며, 느린 소켓만 제거·종료돼야 한다.
- 동시에 여러 방송이 같은 느린 소켓을 만나도 timeout/failure와 제거 수는 한 번만 증가해야 한다.
- 운영 로그용 WS 스냅샷에 `send_timeouts`·`send_failures`가 보존되되 사용자·소켓 식별자는 없어야 한다.
- 프론트 첫 재연결은 0.8~1.2초 범위에 분산되고 지수 백오프 상한은 15초여야 한다.
- close code 1008은 반복 재접속하지 않고 인증 토큰을 정리한 뒤 로그인 화면과 사용자 알림을 표시해야
  한다.

같은 작업 트리에서 백엔드 전체 837개·21 subtests, 프론트 76개 파일·535개, 프론트 아키텍처 검사와
프로덕션 빌드가 통과했다.

100명·2코어·below-normal 단기 실측은 운영 DB가 아닌 임시 DB와 포트에서 다음처럼 실행했다.

```powershell
cd D:\ClaudeCode\MV-hub-S-dev
py -3 tools\load_test_100.py `
  --users 100 --duration 12 --cycles 1 --generations-per-user 2 `
  --think-min 0.2 --think-max 0.4 --sample-interval 2 `
  --server-cpu-cores 2 --server-priority below-normal `
  --max-p95-ms 1000 --output .\rl19-load.json --quiet
```

로그인 100건과 요청 3,700건이 모두 성공했고, 작업 p95 59.44ms·p99 176.75ms, WS 100개 유지,
WS 오류·send timeout·send failure·SQLite lock 0건, 최대 RSS 198,844,416바이트였다. 임시 계정의
상태를 서버에서 거부로 바꾼 브라우저 실측에서는 다음 재검증 때 1008을 받고 로그인 화면으로
전환됐으며 앱 출처 콘솔 오류는 없었다. 이 결과는 단기 연결 계약 검증이며 공유 서버 5분 단절·복구와
8시간 soak를 대신하지 않는다.

## 워치독 busy·maintenance·사망 판정 회귀(RL-20)

```powershell
cd D:\ClaudeCode\MV-hub-S-dev
$env:PYTHONPATH="backend"
py -3 -m pytest `
  backend\tests\test_server_watchdog_console.py `
  backend\tests\test_server_supervisor.py `
  backend\tests\test_operational_health.py `
  backend\tests\test_db_restore_gate.py -q
```

집중 합격 기준은 21개다.

- `/api/ready`는 유지보수 중 DB readiness를 실행하지 않고 즉시 503·`Retry-After: 5`를 반환한다.
- busy·maintenance는 dead 횟수를 초기화하며 자동 개입하지 않는다. 각각의 장기 임계치에서는 ALERT를
  한 번만 남긴다.
- 시작 유예 중 dead는 세지 않고, 유예 뒤 또는 한 번 정상화된 뒤의 연속 dead만 개입한다.
- HTTP 오류 본문은 허용된 `status`만 최대 4KiB에서 읽으며 임의 메시지·인증정보는 로그에 남기지 않는다.
- 별도 TCP 프로세스의 ready→busy→maintenance→ready는 무개입으로 복구돼야 한다.
- 실제 포트 소유 테스트 프로세스가 hang한 경우 정확한 PID만 dry-run 종료 대상으로 표시돼야 한다.

저사양 100명 단기 실측은 운영 DB가 아닌 임시 DB와 포트에서 다음처럼 실행했다.

```powershell
py -3 tools\load_test_100.py `
  --users 100 --duration 12 --cycles 1 --generations-per-user 2 `
  --think-min 0.2 --think-max 0.4 --sample-interval 2 `
  --server-cpu-cores 2 --server-priority below-normal `
  --max-p95-ms 1000 --output .\rl20-load.json --quiet
```

로그인 100건과 작업 요청 3,706건이 모두 성공했다. 작업 p50 16.17ms·p95 64.69ms·p99 173.56ms,
WS 100개와 장기 폴링 100개 유지, WS·장기 폴링·send timeout·send failure·SQLite lock 오류 0건,
최대 RSS 198,799,360바이트였다. 같은 작업 트리에서 백엔드 전체 845개·21 subtests, 프론트 76개
파일·535개, 프로덕션 빌드와 아키텍처 검사가 통과했다.

이 검증은 워치독의 오판 방지와 단기 부하를 확인한다. 운영 공유 서버의 5분 단절·복구와 8시간
soak를 대신하지 않는다.

## content·trash·manage DB 세트 복원 드릴(RL-21)

같은 시각에 만들어진 백업 3개를 운영 DB와 분리된 폴더에 복원하고, 그 사본만 사용하는 실제
loopback 서버를 띄워 ready·로그인·핵심 데이터 수를 검증한다.

```powershell
cd D:\ClaudeCode\MV-hub-S-dev
$env:PYTHONPATH="backend"
py -3 -m pytest backend\tests\test_backup_restore.py -q
py -3 -m pytest `
  backend\tests\test_backup_restore.py `
  backend\tests\test_backup_atomicity.py `
  backend\tests\test_backup_replicate.py `
  backend\tests\test_db_backup_streaming.py `
  backend\tests\test_db_restore_gate.py `
  backend\tests\test_operational_health.py `
  backend\tests\test_auth_session_cookie.py `
  backend\tests\test_architecture_boundaries.py -q
```

집중 합격 기준은 8개, 관련 회귀는 39개다.

- 대표 `content_hub_<시각>.db`와 정확히 같은 시각의 trash·manage 파일이 모두 있어야 한다.
- 세 파일과 복원 대상 충돌을 먼저 검사하며, 실패 시 부분 복원 파일을 남기지 않는다.
- 공백·한글·`#`가 있는 Windows 경로에서도 SQLite URI가 안전해야 한다.
- 미반영된 비어 있지 않은 `-wal`, 필수 테이블 누락, 무결성·스키마·행 수 불일치를 거부해야 한다.
- 격리 서버의 content·trash·manage ready와 관리자 로그인이 성공하고 핵심 수가 유지돼야 한다.
- 종료 뒤 격리 서버 프로세스가 남지 않고 원본 백업의 해시와 폴더 내용이 바뀌지 않아야 한다.

운영 또는 NAS 백업 세트는 다음 명령으로 별도 확인한다. 이 명령은 실제 크레딧 생성이나 운영 DB
교체를 수행하지 않는다.

```powershell
py -3 tools\verify_backup_restore.py `
  --backup-set "E:\MVHub-backups\content_hub_20260731_120000.db"
```

RL-21 구현 기준에서 집중 8개·관련 39개·전체 백엔드 851개와 21 subtests가 통과했다. 합성 백업
파일을 사용한 실제 Windows CLI·서버 프로세스 드릴도 종료 코드 0, 원본 불변,
`process_stopped=true`로 끝났다. 이는 도구의 복원 계약을 확인하지만 NAS 최신성·예비 PC 전환 시간은
운영 리허설로 따로 측정해야 한다.

## 공유·최종 원본 보존(RL-22)

`2a8dab18` 기준 검증 명령:

```powershell
cd D:\ClaudeCode\MV-hub-S-dev\backend
py -3 -m pytest -q tests\test_media_preservation.py tests\test_generation_media_cache.py tests\test_media_cache.py tests\test_operational_health.py
py -3 -m pytest -q
py -3 -m compileall -q app

cd D:\ClaudeCode\MV-hub-S-dev\frontend
npm.cmd run build
npm.cmd test -- --run
npm.cmd run lint:architecture
```

핵심 계약과 결과:

- 공유·최종 요청은 다운로드 전에 `media_preservation`에 저장되고 같은 생성물은 한 행만 가진다.
- 공유·최종·수동·관리자 요청이 동시에 들어와도 가장 강한 `final` 사유가 남는다. 이 동시성 시험은
  20회 반복 통과했다.
- 업데이트 전 기존 공유·최종 완료본도 시작 시 한 번만 백필되고, 중단된 `running`은 다음 시작에
  `pending`으로 복구된다.
- 같은 원격 URL을 여러 asset/reference가 사용해도 모든 DB 행이 로컬 `/media/` 경로로 바뀐다.
- 50GiB 기본 한도를 넘으면 새 파일만 되돌리고 기존 보존본은 삭제하지 않는다.
- 집중 묶음 31개, 백엔드 전체 862개·21 subtests, 프론트 76개 파일·535개, 프로덕션 빌드와
  아키텍처 검사가 통과했다.
- 격리 서버 `8012`와 Vite `5173`에서 기존 최종본 자동 백필 → `원본 보존 완료`를 확인했다.
  테스트 DB 상태를 `capacity`로 바꿔 `저장공간 한도 도달`과 재시도 버튼을 확인하고, 버튼 실행 뒤
  `완료`로 돌아오는 것을 확인했다. 앱 출처 콘솔 오류는 0건이었다.
- 유료 Higgsfield 생성은 실행하지 않았다. 테스트 프로세스와 5173/8012 포트를 회수했고 운영 포트
  8010에는 개입하지 않았다.

이 검증은 내부 영속 큐·UI·재시작 계약을 확인한다. 실제 CDN URL 장기 만료, 물리 디스크 50GiB
도달, 다른 PC·혼합 버전 공유 서버는 운영 배포 전 별도 실측 대상이다.

## 작업자 PC 오프디스크 백업(RL-23)

현재 작업 트리 기준 검증 명령:

```powershell
cd D:\ClaudeCode\MV-hub-S-dev\backend
py -3 -m pytest -q `
  tests\test_worker_offdisk_backup.py `
  tests\test_backup_replicate.py `
  tests\test_db_restore_gate.py `
  tests\test_operational_health.py `
  tests\test_release_update.py `
  tests\test_upload_limits.py `
  tests\test_proxy_ownership.py
py -3 -m pytest -q

cd D:\ClaudeCode\MV-hub-S-dev\frontend
npm.cmd test -- --run
npm.cmd run lint:architecture
npm.cmd run build
```

핵심 계약과 결과:

- 작업자 `content + trash` 세트는 비밀정보를 제거한 별도 staging과 영속 outbox를 사용한다.
- 서버는 세션 계정별로 역할·크기·SHA-256·SQLite 무결성을 검사하고, 20개 동시 동일 세트 전송도
  한 세트만 공개한다. 작업자는 ACK의 세트 ID와 모든 역할이 일치할 때만 완료한다.
- 중단된 `running`, 로그인 만료, 네트워크 실패, 디스크 쓰기 실패, 손상 파일, 새 작업자↔구버전
  서버, 업데이트 전후 `backend/data` 보존을 회귀로 확인했다.
- 외부 복제는 기존 단일 DB와 새 세트를 모두 다루며 `success`, `disabled`, `failed`, `no_source`를
  구조화 상태로 기록한다. 상태 기록 자체가 실패해도 성공으로 끝내지 않는다.
- 관련 회귀 84개, 백엔드 전체 887개·21 subtests, 프론트 76개 파일·535개, 프로덕션 빌드와
  아키텍처 검사가 통과했다.
- 격리 브라우저에서 `로컬 백업`, 최신 세트 구성, 공유 서버 상태, 재시도 버튼과 앱 출처 콘솔 오류
  0건을 확인했다. 테스트 계정·프로세스와 5173/8012 포트를 회수했다.
- 2코어·below-normal·256MiB 상한의 100명 단기 실측은 요청 2,920건 모두 200, p95 36.68ms,
  p99 231.80ms, WebSocket·장기 폴링 각 100개, 오류·SQLite lock 0건, 최대 RSS
  196,182,016바이트로 통과했다.

이 결과는 내부 전송·복원 계약과 낮은 사양에서의 단기 동작을 확인한다. 실제 NAS/다른 물리 장치에
복제한 작업자 세트로 예비 PC 복원을 수행한 것은 아니므로, 운영 완료 판정에는
[WORKER_OFFDISK_BACKUP_CONTRACT.md](WORKER_OFFDISK_BACKUP_CONTRACT.md)의 마지막 외부 훈련이 필요하다.

## 런처 한눈에 보기

| 파일 | 실행 위치 | 하는 일 |
|---|---|---|
| `test_push-db.bat` | 서버 | live DB를 수정하지 않고 `backend\data_test_push`에 모든 SQLite DB의 일관된 스냅샷을 만든 뒤, 다운로드용 서버(8011)와 일회용 코드를 준비 |
| `test_pull-db.bat` | 내 PC | 서버 창의 일회용 코드를 입력해 콘텐츠·휴지통·팀 통계·계정 DB 번들을 검증하고 `backend\data_test`로 내려받음(미디어 제외) |
| `test_dev.bat` | 내 PC | 테스트 백엔드(8012)·생성 에이전트·Vite(5173)를 실행하고, 브라우저 로그인 계정을 에이전트에 자동 연결 |
| `test_dev_server.bat` | 내 PC | 내려받은 DB로 프론트 빌드와 API를 한 서버(8011)에서 실행해 배포 직전 형태를 확인 |

참고 — 운영(테스트 아님): `MV_server.bat`(공유 서버 8010), `MV_agent.bat`(각 PC 로컬 허브), `update*.bat`.

## 테스트 클론 최초 만들기 (서버에서, git)

테스트 클론은 **`backend frontend tools` 3개**를 sparse-checkout 해야 한다.
`tools/`가 빠지면 `test_push-db.bat`이 쓰는 `tools\refresh_pm_test_data.py`가 없어 DB 복사가 실패한다.
(`setup_clone_git.ps1` 도 신규·기존 클론 양쪽 모두 `backend frontend tools` 를 설정한다 —
회귀 테스트 `backend/tests/test_sparse_checkout_scripts.py` 가 이를 강제.)

```powershell
cd E:\
git clone --filter=blob:none --sparse https://github.com/study-jaycoding/MV-hub-S.git MV-hub-test2
cd E:\MV-hub-test2
git sparse-checkout set backend frontend tools
git checkout dev
```

이후 업데이트는 그 폴더에서 `git pull` 한 줄.

## 로컬 실시간 개발 (내 PC)

평소에는 `test_dev.bat` 하나만 실행한다. 다음 세 가지가 함께 켜지고 브라우저는
`http://127.0.0.1:5173` 하나만 열린다.

1. 격리된 테스트 백엔드 — 8012
2. 로컬 Higgsfield 생성 에이전트
3. Vite 실시간 프론트엔드 — 5173

`.tsx`·`.css` 변경은 저장 즉시 반영된다. 백엔드 `.py` 변경은 생성 CLI 안정성을 위해
자동 재시작하지 않으므로 `test_dev.bat`을 다시 실행한다.

로그인은 브라우저에서 한 번만 한다. `test_dev`가 실행할 때마다 메모리 전용 일회성 연결 키를 만들고,
생성 에이전트는 그 키로 브라우저 로그인 계정을 자동으로 이어받는다. CMD에서 이메일이나 허브 비밀번호를
다시 묻지 않으며 키·세션·비밀번호를 파일에 저장하지 않는다. 서버 DB 전체에는 여러 사람의 결과가 들어
있지만 로그인 계정의 `creator_uid`로 내 작업을 제한하므로 내 결과만 보인다. 브라우저에서 계정을 바꾸면
에이전트도 자동으로 새 계정에 다시 연결된다.

`test_pull-db.bat`에는 서버의 `test_push-db.bat` 창에 표시된 일회용 코드를 입력한다. 운영 관리자
이메일이나 비밀번호는 묻지도 전송하지도 않는다. Windows 콘솔의 입력 echo를 끈 상태에서 실제 문자 대신
`*`만 표시하며 코드 원문을 저장하지 않는다. 코드는 다운로드 응답을 한 번 준비하면 즉시 폐기되며,
임시 서버가 자동 재시작되어도 다시 사용할 수 없다.

최신 운영 DB 모양이 필요할 때는 서버에서 `test_push-db.bat`을 먼저 실행한 뒤, 내 PC에서
`test_pull-db.bat`을 실행한다. 내려받은 DB와 이후 생성 결과는 `backend\data_test`에만 저장되며
운영 DB에는 쓰지 않는다. 단, `test_dev.bat`에서 실행한 생성 요청은 실제 Higgsfield 작업이므로
실제 크레딧을 사용한다.

기존 버전에서 프론트엔드와 백엔드·에이전트를 따로 실행해 둔 경우에는 두 창을 모두 닫고
새 `test_dev.bat`을 실행한다. 5173 또는 8012가 이미 사용 중이면 새 런처는 중복 생성
에이전트를 만들지 않고 안내 후 종료한다.

현재 버전은 `test_dev.bat`으로 열린 CMD 창을 닫으면 그 세션이 시작한 로컬 허브·Vite·생성
에이전트도 함께 종료한다. 다시 실행할 때 이전 세션의 포트나 에이전트가 남지 않아야 한다.

## 최신 서버 DB로 배포 직전 확인

다음 순서를 그대로 따른다.

1. **서버** 테스트 클론에서 `test_push-db.bat`을 실행하고 창을 열어 둔다.
   - live DB는 읽기만 하고 `backend\data_test_push`에 일관된 복사본을 만든다.
   - 복사본만 제공하는 임시 서버가 서버 PC의 8011 포트에서 실행된다.
   - 창에 표시된 `ONE-TIME DOWNLOAD CODE`를 개발 PC로 전달한다.
2. **내 PC**에서 `test_pull-db.bat`을 실행한다.
   - 전달받은 일회용 코드를 입력하면 서버의 8011에서 모든 SQLite DB 번들을 내려받는다.
   - 경로·크기·CRC·SQLite 무결성을 모두 통과해야 설치하며 기존 `backend\data_test`는 자동 보관한다.
   - 다운로드가 끝나면 서버의 `test_push-db.bat` 창은 종료해도 된다.
   - 코드가 소비된 뒤 전송이 끊겼다면 서버에서 `test_push-db.bat`을 다시 실행해 새 코드를 만든다.
3. **내 PC**에서 `test_dev_server.bat`을 실행한다.
   - 프론트엔드를 실제 배포 방식으로 빌드하고 UI와 API를 한 서버로 실행한다.
   - 준비가 끝나면 `http://127.0.0.1:8011`이 자동으로 열린다.

서버의 8011과 내 PC의 8011은 서로 다른 컴퓨터의 포트라 충돌하지 않는다. 운영 서버 8010과
live DB는 이 과정에서 수정되지 않는다. `test_dev_server.bat`은 Vite 실시간 반영과 생성 에이전트를
실행하지 않으므로, 코드를 수정하면서 확인하거나 실제 생성을 시험할 때는 `test_dev.bat`을 사용한다.

두 테스트 런처는 `CONTENT_HUB_NO_PROXY=1`과 서버측 CLI 동기화 비활성화를 강제한다. 복사 DB에
남아 있는 공유 서버 토큰 때문에 테스트 요청이 운영 서버로 잘못 전달되는 것을 막기 위한 설정이다.

## 머지 전 체크리스트

1. `CONTENT_HUB_NO_PROXY=1` 격리 환경에서 **백엔드·프런트 전체 자동 테스트** 통과
2. 프런트 production build(`npm.cmd run build`, 타입체크 포함)와 `npm.cmd run lint:architecture` 통과
3. 서버 테스트(`CONTENT_HUB_AUTH=1`) — 로그인·역할 권한, 백엔드 컴파일과 격리 서버 기동 smoke 확인
4. `dev` 작업 트리가 깨끗하고 병합 대상 커밋이 확정됐는지 확인
5. DB 스키마가 기존 데이터와 하위 호환인지 확인(필요하면 마이그레이션·롤백 계획 기록)
6. 기존 `main` 보다 생성·공유·업데이트 경로가 악화되지 않았는지 확인
7. 위 1~6 은 `RISK_REDUCTION_PLAN_2026-08-15.md` 의 **`Gate 6-A` 필수 조건**에 대응한다.
   게이트 원문을 다시 확인해 빠진 조건이 없는지 대조하고, 통과한 뒤에도
   **Jay 가 명시적으로 "병합"이라고 지시한 경우에만** `git push origin HEAD:main` 으로 반영한다.

## 100명 격리 부하 테스트

운영 DB가 아닌 임시 DB와 임시 포트에서 서버를 자동 기동해 로그인·WebSocket·에이전트
롱폴·목록·검색·짧은 쓰기·미디어를 함께 검증한다. 종료하면 임시 데이터와 서버도 정리된다.

```powershell
python tools\load_test_100.py --users 100 --duration 60 --cycles 2 --generations-per-user 20 --output load-result.json
```

자동 통과 기준:

- 워크로드 5xx·전송 실패 0
- `sqlite_locked_total=0`
- 전체 p95 500ms 이하
- 100명 동시 로그인 p95 10초 이하
- WebSocket 100개 연결
- 에이전트 롱폴 90개 이상 동시 대기
- 시험 중 주기 표본에서도 WebSocket 100개·에이전트 연결 계정 90개 이상 유지
- 첫 전체 연결 사이클 이후 2차 사이클 RSS 증가 20% 이하

짧은 테스트 통과 후 운영 서버와 같은 사양의 스테이징 PC에서 8시간 지속 테스트를 실행한다.
현재 기준의 100명·저사양·TLS 실측값은 [2026-08-14 지속 시험 결과](LOAD_TEST_2026-08-14.md)에 기록했다.

```powershell
python tools\load_test_100.py --users 100 --duration 14400 --cycles 2 `
  --server-cpu-cores 4 --server-priority below-normal `
  --sample-interval 30 --max-rss-mb 512 --output soak-result.json
```

`--server-cpu-cores`는 격리 서버 프로세스만 지정한 논리 CPU 수로 제한한다. `--max-rss-mb`는
메모리를 강제로 자르는 옵션이 아니라, 시험 중 한 번이라도 상한을 넘으면 실패로 판정하는 기준이다.
HTTPS/WSS까지 확인할 때는 시험 인증서와 키를 `--tls-certfile`, `--tls-keyfile`, `--tls-ca-file`에
지정한다. 장기 시험의 지연시간은 전체 요청 수를 정확히 세면서 고정 크기 무작위 표본으로 계산해,
시험 도구 자체의 메모리가 실행 시간에 비례해 증가하지 않게 한다.

> 주의: 8011 포트가 이미 사용 중이면 `test_push-db.bat`과 `test_dev_server.bat`은 기존 프로세스를
> 강제 종료하지 않고 안내 후 종료한다. 같은 PC에서 이전 8011 테스트 창을 닫은 뒤 다시 실행한다.
