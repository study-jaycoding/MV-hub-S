---
updated: 2026-10-21
status: active
---

# Content Hub — 서버 운영 가이드

이 저장소(`MV-hub-S`)를 **서버 PC에 git 클론**해 공유 서버로 운영한다. 작업자 PC는
릴리스 설치본(`release/README.md`)을 쓰고, 서버는 이 클론에서 `update_git.bat` 으로
업데이트한다.

## 핵심 구조 — 단일 오리진

개발 모드에선 프론트(Vite 5173) 와 백엔드(FastAPI 8000) 가 분리돼 Vite 가 `/api`·`/ws`·
`/media` 를 백엔드로 프록시했다. **서버 모드에선 백엔드가 빌드된 프론트(`frontend/dist`)
를 같은 오리진에서 직접 서빙**한다. 프론트는 이미 모든 호출을 상대경로(`/api`,
`ws://location.host/ws`, `/media`)로 하므로 — **이 폴더째 실서버에 올려도 코드 무변경으로
작동**한다. CORS 도 필요 없다(같은 오리진).

```
[브라우저] ──http──> [FastAPI :8010]
                       ├─ /            → frontend/dist/index.html (SPA)
                       ├─ /assets/*    → 빌드된 JS/CSS
                       ├─ /api/*        → REST
                       ├─ /ws           → 진행률 push (WebSocket)
                       └─ /media/*      → 로컬 미디어
```

## 새 supervisor를 사용하는 서버의 정기 업데이트

이 절은 이미 `tools/server_supervisor.py`와 staged coordinator를 사용하는 서버용이다.
1358 서버의 최초 전환은 [아래 별도 절](#1358--dev2-최초-전환)을 따른다.
실제 배포는 아래 생성 fence와 [배포 Gate](RISK_REDUCTION_PLAN_2026-08-15.md)의 승인을 함께 따른다.

`update_git.bat`은 서버·개발 git 클론 모두 **관리자 콘솔**에서 실행한다. 비관리자는 SYSTEM 예약 작업을
못 봐 서버를 작업자로 오판할 수 있으므로 역할 판정 전에 거부한다.

판별 선언은 [release/compatibility.json](../release/compatibility.json) 하나를 코드와 함께 커밋한다.
서버는 fetch 뒤 선택한 `origin/main` SHA의 선언을 읽고 같은 SHA에서 stage를 만든다.
현재 선언은 reader 1 / writer 2, DB 읽기·쓰기 범위 1..2,
`schema_compat.py`의 9개 지원 component를 담는다. 지원 목록은 기능 활성화 설정이 아니다.
**rollout·필수 capability·하위 호환성은 Jay·총괄 결정 필요**로 `null`이다.
현재 값은 기존 계약 검증에서 거부되므로 결정·커밋 전에는 서버 업데이트와 기본 릴리스 제작을 진행할 수 없다.
`bridge`는 빈 capability와 `backward_compatible=true`에 대한 구판 전환·혼용 근거가 필요하고,
`enforced`는 `artifact-receipt-v1`을 요구한다. 이 값만으로 1358 워커의 거부 동작을 보장하지 않는다.

1. 고정 폴더 `D:\ClaudeCode\MV-hub-S-release`에서 원격을 갱신하고, 승인된 main SHA와
   `HEAD`·`origin/main`이 같으며 작업 트리가 깨끗한지 확인한다. 불일치나 미커밋 변경이 있으면
   배포 담당자가 먼저 해결한다. 실행 중인 서버 트리에서 소스 검증 영수증을 만들지 않는다.
2. 이 고정 폴더의 `tools\predeploy_gate.ps1`로 선택 SHA를 검증한다. 검증 Python은
   `backend\requirements-dev.txt`의 의존성이 준비된 신뢰할 수 있는 환경을 지정하고,
   백업 복구 시험에는 사용자 DB 원본 대신 준비된 사본을 지정한다. 예시 경로는 실제 준비 위치로 바꾼다.

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\predeploy_gate.ps1 `
     -PythonExe "D:\MVHub-operations\verifier\Scripts\python.exe" `
     -BackupSource "D:\MVHub-operations\backup-copy\content_hub.db" `
     -ReportDirectory "D:\MVHub-operations\receipts"
   ```

   종료 코드 0과 출력된 `validation-<run_id>.json`을 확인한다. 영수증은 `scope=source-only`,
   `status=passed`, `passed=true`, `source_unchanged=true`, `source.dirty=false`여야 하며
   `source.commit`은 선택한 SHA와 같아야 한다. 문서 lint·구조 lint·백엔드 시험·프런트 시험·
   프런트 빌드는 모두 통과해야 한다. 이것은 소스 검증이며 ZIP 배포 자격 영수증은 아니다.
3. 그 JSON 원본을 서버 PC의 **저장소 밖** 로컬 폴더로 복사하고, 복사 전후 `Get-FileHash -Algorithm SHA256`이
   같은지 확인한다. 서버의 별도 검증 Python에는 `psutil`이 준비돼 있어야 한다.
   이번에 만드는 stage의 `.venv`를 검증 Python으로 지정하지 않는다.
4. 서버 PC의 PowerShell에서 두 환경변수를 설정한 뒤, 서버 저장소 루트에서 실행한다.
   Python 경로에는 실행 가능한 파일을, receipt 경로에는 3단계의 원본 JSON을 지정한다.

   ```powershell
   $env:MVHUB_SERVER_SOURCE_RECEIPT = 'D:\MVHub-operations\receipts\validation-<run_id>.json'
   $env:MVHUB_SERVER_VERIFICATION_PYTHON = 'D:\MVHub-operations\verifier\Scripts\python.exe'
   & $env:MVHUB_SERVER_VERIFICATION_PYTHON -E -s -B -c "import psutil"
   if ($LASTEXITCODE -ne 0) { throw '검증 Python 준비 실패' }
   .\update_git.bat
   if ($LASTEXITCODE -ne 0) { throw '서버 업데이트 실패: logs의 준비·전환 기록 확인' }
   ```

루트에 `server-release-compatibility.json`을 만들지 않는다. 비추적 파일도 dirty 검사에 걸린다.
서버 coordinator의 외부 `--compatibility` 인자는 제거됐으며, 선언은 선택 SHA에서만 읽는다.
반면 릴리스 제작의 `-CompatibilityPath` 명시 인자는 유지되고, 생략하면 `ProjectRoot` 아래의
`release\compatibility.json`을 사용한다.

Git archive는 기본적으로 선택 커밋의 `.gitattributes`를 적용한다. 따라서 PowerShell 파일의
CRLF를 포함해 checkout과 같은 바이트를 stage에 담고, `release/compatibility.json`도
`source_files`·receipt의 실제 SHA-256 비교 대상에 포함한다. 줄끝을 무시하는 해시 비교는 하지 않는다.
검증 후 main이 바뀌었거나 환경의 Git 속성 때문에 바이트가 달라지면 준비가 거부된다.
새 선택 SHA의 검증을 다시 받아야 하며 영수증 내용을 손으로 맞추지 않는다.
준비·격리 runtime 검증 후 supervisor가 전환·ready 확인을 마쳐야 성공이다.
실패 시 `logs\server-prepare.json`, 해당 run 기록과 `logs\server-install-journal.json`을 확인하고,
기존 서버 파일이나 DB를 수동 덮어써 복구하지 않는다.

## 1358 → dev2 최초 전환

1358(`c2463e4f`)에서 시작한 `update_git.bat`은 정상 진행 시 pull 전에 복사한 **옛 워커**를 계속 쓴다.
실패했고 워커 파일도 바뀐 경우에만 새 워커로 한 차례 재시도한다.
따라서 첫 전환은 위 staged 경로가 아니며, 옛 워커는 `backend/requirements.txt`의 변경 여부와
누락·미완료 표식으로 의존성 설치를 판단한다. 새 `requirements.lock.txt`만 바뀌었다고 설치된다고
가정하지 않는다. 새 코드의 관리자 사전 검사도 이미 시작된 옛 워커에 소급 적용되지 않는다.

이 절은 전환 경로 안내이며 배포 승인이나 Gate 통과를 대신하지 않는다. 실행 전 다음을 준비한다.

- **관리자 권한으로 연 콘솔**에서 서버 저장소 루트를 확인한다. 서버 트리와 그 조상 경로는 로컬
  디스크에 있어야 하며 UNC·junction·그 밖의 reparse point를 통과하면 안 된다.
- 선택한 배포 커밋, 깨끗한 작업 트리, 필요한 Python·Node와 의존성 설치 조건을 확인한다.
  최초 전환에도 아래 [생성 fence와 서버 우선 순서](#업데이트롤아웃-순서--생성-fence-후-공유-서버-먼저)를 적용한다.
- **실행 직전 최신 DB 세트의 수동 사본**을 별도 보관한다. 콘텐츠·휴지통·관리 DB와 계정별 DB가
  있으면 함께 보존한다. [DB 자동 백업](#db-자동-백업)의 일관 사본 방법을 따르거나 서버·감시 작업을
  정상 중지해 쓰기가 멈춘 상태에서 복사한다. 실행 중인 `.db` 파일만 복사해 WAL 변경을 빠뜨리지 않는다.
  기존 자동 백업만 믿거나 최초 스키마 기준선 생성 전에 자동 사본이 생긴다고 가정하지 않는다.

준비 후 서버 루트에서 `update_git.bat`을 실행한다. 성공 메시지만으로 끝내지 않고 다음을 확인한다.

1. `/api/ready`가 HTTP 200이며 로그인·팀 목록 조회가 정상이다.
2. `logs\server-activation.json`의 `state`가 `normal`이다.
3. 실제 사용 DB 세트의 `schema_meta`를 읽기 전용으로 확인한다.
   `SELECT database_kind, schema_version, minimum_reader_protocol, minimum_writer_protocol FROM schema_meta;`
   결과를 선택한 코드의 지원 범위와 대조한다. 최초 기준선은 버전 1이고 콘텐츠 DB는
   적용된 component에 따라 버전 2가 될 수 있으므로 모든 DB가 같은 숫자여야 한다고 판단하지 않는다.

실패하면 **화면의 마지막 메시지**와 `logs\update.log`의 실패 단계를 보존한다. ready 대기 실패의
실제 기동 예외는 `logs\server_console.log` 마지막 부분에서 확인한다. `Cannot inspect`가 나오면
관리자 권한과 프로세스 조회 가능 여부를 확인한다. 비관리자 콘솔에서 SYSTEM 프로세스의
CommandLine을 읽지 못하는 경우는 가능한 원인이며 이번 리허설에서 재현·확정된 원인은 아니다.

**pull 뒤 의존성 설치·빌드·재시작에서 실패하면 단순 재실행으로 옛 워커의 남은 단계를 이어갈 수 없다.**
옛 ps1은 워커 파일 전체를 복사하므로 새 워커 1회 재시도도, `update_git.bat` 재실행도 새
`tools\run_update_git.ps1`의 staged 경로로 들어간다. 옛 supervisor는 새 잠금을 잡지 않아
`server without its active supervisor`로 거부된다. `MV_server.bat`으로 새 supervisor를 띄워도
현재 선언의 `rollout=null`에서 막힌다. 실패 원인을 보존하고 아래 둘 중 승인된 복구 경로를 따른다.

승인된 복귀가 필요하면 서버의 새 작업을 멈추고 작업 트리가 깨끗한지 확인한 다음,
서버 루트의 관리자 콘솔에서 `git checkout c2463e4f` 후 `restart_server_task.bat`을 실행한다.
**DB는 그대로 둔다.** 다시 ready·로그인·팀 목록을 확인하며, 미커밋 변경이나 다른 DB 비호환이
있으면 강제 checkout·DB 덮어쓰기를 하지 않고 별도 복구 판단을 받는다.
복귀 뒤 원인을 해결하고 다시 올릴 때는 detached HEAD 상태를 끝내도록 **`git checkout main`으로 돌아온 뒤
최초 전환 절차를 처음부터** 수행한다. detached HEAD에서는 옛 워커의 `git pull --ff-only`가 실패한다.

복귀 대신 옛 워커의 남은 단계를 수동 완료하기로 승인했다면, 서버 루트의 관리자 PowerShell에서
`logs\update.log`의 `Using Python`에 나온 **같은 Python 실행 파일·인자**를 사용한다. 아래 `$PythonExe`는
그 실행 파일로 바꾸고, `py.exe -3`처럼 인자가 있었다면 각 Python 명령에 같은 인자도 붙인다.

```powershell
$PythonExe = '<update.log의 Python 실행 파일 절대 경로>'
$env:PYTHONUTF8 = '1'
& $PythonExe -m pip install -r .\backend\requirements.txt
if ($LASTEXITCODE -ne 0) { throw '의존성 설치 실패' }
& $PythonExe -c "import fastapi,uvicorn,pydantic,websockets,multipart,PIL,watchdog"
if ($LASTEXITCODE -ne 0) { throw '의존성 import 실패' }
& $PythonExe .\tools\verify_requirements.py .\backend\requirements.txt
if ($LASTEXITCODE -ne 0) { throw '의존성 버전 확인 실패' }
Push-Location .\frontend
try {
    npm.cmd ci --include=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci 실패' }
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw '프런트 빌드 실패' }
    if (-not (Test-Path .\dist\index.html)) { throw '프런트 산출물 누락' }
} finally { Pop-Location }
.\restart_server_task.bat
if ($LASTEXITCODE -ne 0) { throw '서버 재시작 실패' }
```

각 명령의 종료 코드 0, 의존성 import·버전 확인, `frontend\dist\index.html` 생성을 확인한 다음
위 성공 확인 1~3(ready·로그인·팀 목록, activation 상태, DB 지원 범위)을 다시 확인한다.
DB를 되돌리거나 실패 표식을 임의로 지우지 않는다.

근거는 총괄이 제공한 **1358 서버 DB 사본 격리 리허설 보고**다: dev2 변환 후 compatible·ready 200,
옛 1358 코드로 ready·로그인·팀 목록 200, 다시 dev2 compatible을 확인했다. 이는 해당 사본과 코드의
왕복 호환성 근거이며, `serve.py` 직접 기동이었다. supervisor·예약 작업·옛 워커 전체 전환과
그 이후의 모든 데이터 변경까지 검증한 결과는 아니다.

두 번째 업데이트부터는 새 supervisor와 coordinator를 확인한 뒤 위 **정기 업데이트** 절을 따른다.
선택 커밋의 rollout·capability 결정과 소스 검증 영수증이 필요하며, 현재 미결정인 선언을 자동 승인하지 않는다.

## 업데이트(롤아웃) 순서 — ★생성 fence 후 공유 서버 먼저

경로가 둘이다: **서버 = git 클론에서 `update_git.bat`**, **작업자 = 릴리스 ZIP 배포 후
앱 안 "설정 → 프로그램 업데이트" 버튼**(수동은 `update_release.bat`). 릴리스 제작·게시는
`release/README.md` 참고.

혼합 버전에서 구 에이전트가 이미 받은 유료 생성 요청을 나중에 실행하는 창을 닫기 위해 다음 순서를
반드시 지킨다. 관리자 API 호출에는 로그인으로 받은 관리자 Bearer 토큰을
`$env:MVHUB_ADMIN_TOKEN`에 넣어 둔다(토큰을 문서나 명령 기록에 직접 붙여 넣지 않는다).

> [!IMPORTANT]
> 1·2·5단계의 일시중지와 fence 는 **공유 서버 자신의 생성 큐만** 멈추고 센다. 팀원의 생성 요청은 각 PC 로컬
> 허브의 큐(`/api/gen-requests` 는 서버로 보내지 않는 로컬 경로)에 쌓이고 그 PC 의 에이전트가 처리하므로, 서버의
> 스위치로는 멈추지 않는다(2026-10-01 격리 실측: 서버 503 인 순간 붙어 있는 허브는 201). 팀원 PC 쪽은 ① 앱의
> '프로그램 업데이트'가 진행 중인 생성(레퍼런스를 올리는 중 포함)이 있으면 시작하지 않고 ② 허브와 에이전트가 한
> 패키지로 함께 바뀌며 ③ 제출 직전 허가(begin-submission)가 업데이트 중이면 거절해 보호한다. 다시 열기(5단계) 응답의
> `message` 는 늘 일시중지 문구라 `paused` 값으로 확인한다.

1. 생성 접수·claim 일시중지:

   ```powershell
   Invoke-RestMethod -Method Put -Uri "http://localhost:8010/api/gen-requests/deployment-pause" -Headers @{Authorization="Bearer $env:MVHUB_ADMIN_TOKEN"} -ContentType "application/json" -Body '{"paused":true}'
   ```

2. 서버 PC의 저장소 루트에서 아래 **한 줄**을 한 번 실행하고 종료 코드 `0`과 `[통과]`를 확인:

   ```powershell
   py -3 tools\deploy_fence_check.py
   ```

   기본 위치가 아닌 DB는 `--db "D:\실제경로\content_hub.db"`를 붙인다. 검사는 DB를 읽기 전용으로
   열며, 다음 중 하나라도 만족하지 않으면 배포를 막는 종료 코드 `2`를 반환한다.

   - DB의 `generation_deployment_paused` 스위치가 ON
   - `gen_request.status`가 `done/failed/canceled`가 아닌 행이 0건. 알려지지 않은 새 상태도 안전하게 미종결로 센다.
   - `generation.status`가 `pending/running`인 행이 0건. 요청표와 연결되지 않은 placeholder,
     동기화본, provider 진행 흔적도 빠뜨리지 않고 보수적으로 센다.

   DB 파일·스키마를 읽지 못하면 종료 코드 `3`이다. `2`나 `3`을 무시하고 업데이트하지 않는다.
   일시중지 전에 이미 시작된 `anchor/fulfill/reconcile/fail` 보고는 계속 받아 자연히 종결되지만,
   남은 `pending/blocked/recovery_required`는 자동으로 숨기지 않으므로 원인을 확인해 명시적으로
   종결한 뒤 fence를 다시 실행한다.

3. `update_git.bat`으로 **공유 서버를 먼저** 배포하고 `/api/ready` 200을 확인한다.
4. `release/README.md` 절차로 모든 작업자 PC의 허브·에이전트를 새 릴리스로 전환한다.
5. 생성 접수 재개:

   ```powershell
   Invoke-RestMethod -Method Put -Uri "http://localhost:8010/api/gen-requests/deployment-pause" -Headers @{Authorization="Bearer $env:MVHUB_ADMIN_TOKEN"} -ContentType "application/json" -Body '{"paused":false}'
   ```

스위치는 `app_setting`에 영속되므로 서버 재시작·롤백 뒤에도 자동으로 풀리지 않는다. 에이전트 전환과
준비 상태 확인이 끝난 뒤 반드시 5단계를 실행한다. 새 허브의 배치 쓰기(작업 순서/삭제/담당해제·팀
카드 색/태그)는 구서버 상대로 404/400 폴백 안전망이 있지만, 폴백은 과도기용이지 정상 운영 경로다.

워크스페이스 지정 생성요청: 신 서버는 워크스페이스가 지정된 대기 요청을
capability 를 밝힌 신 에이전트에게만 내려준다. 구 에이전트는 그 요청을 집지 못하고
pending 으로 남으므로, 서버 업데이트 후 **워커 PC(에이전트)도 곧 업데이트**해야
지정 요청이 처리된다(잘못된 워크스페이스에서 실행·과금되는 것을 막기 위한 게이트).

## 서버 시간대 — 운영 현황과 이전 도구의 조건

관리 대시보드의 날짜·시간 집계는 SQLite `'localtime'` 변환으로 **서버 OS 시간대**를
따른다. 팀 표준시는 KST지만, 현재 공유 서버의 UTC 시간대는 Jay 결정으로 유지 중이다
([CURRENT_STATUS.md](CURRENT_STATUS.md)). 이를 KST 집계로 보장한다고 해석하지 않는다.
이전 도구 `tools/server_move_easy.py`의 사전검사는 여전히 KST를 요구한다. 현재 운영 예외가
이 검사를 자동 면제하지 않으므로, 다음 이전 때 시간대·집계 기준을 확인하고 조건을 합의한 뒤 진행한다.

## 실행

```bat
MV_server.bat
```

하는 일: ① 기존 `frontend/dist` 확인 → ② 없을 때만 잠금 파일 기준 `npm ci`와 빌드
→ ③ 백엔드를 `0.0.0.0:8010` 으로 기동(빌드된 dist 서빙). 평소 부팅은 npm 설치나
외부 네트워크에 의존하지 않는다. 일반 크래시는 대기 시간을
늘리며 자동 재기동하고, 빠른 실패 5회면 폭풍을 차단해 작업 스케줄러의 지연 재시도로 넘긴다.

MV_server.bat 은 **팀 서버 기본값**을 켠다: `CONTENT_HUB_AUTH=1`(로그인 필수)·
`CONTENT_HUB_MANAGE=1`(관리 대시보드 on). 끄려면 실행 전 해당 환경변수를 0 으로 설정.

- 같은 PC:        http://localhost:8010
- 같은 네트워크:  http://<이 PC IP>:8010   (IP 는 `ipconfig` 로 확인)

포트/바인딩 변경: `MV_server.bat` 은 `HOST`/`PORT` 환경변수만 본다
(PowerShell: `$env:PORT = '9000'; .\MV_server.bat`). `CONTENT_HUB_HOST`/`CONTENT_HUB_PORT` 는
bat 이 무조건 덮어쓰므로 **`python serve.py` 직접 실행 때만** 유효하다.

### Windows 자동시작과 업데이트

서버 PC에서 최초 한 번 `register_autostart.bat`을 관리자 승인으로 실행한다. 서버·감시·
백업 작업이 SYSTEM 계정으로 등록되며, 현재 검증된 Python·Node 절대 경로는 로그가 아닌
`.mvhub-runtime/`에 저장된다. 구버전의 `logs/scheduled_*.txt`는 첫 실행 때 자동 이전한다.

이후 `update_git.bat`은 잠금 파일 기준 `npm ci`로 필요한 경우에만 프론트를 갱신한다.
`MVHub Server` 예약 작업이 있으면 관리자 승인 후 서버·감시 작업을 안전하게 다시 시작하고
`/api/ready`가 200인지 확인한다. 실패하면 예약 작업의 상태·결과 코드와
`logs/server_console.log` 마지막 부분을 즉시 보여준다. 따라서 등록 후에는
`MV_server.bat`을 별도 창에서 수동 실행하지 않는다.

예약 작업은 SYSTEM 계정으로 돌아 **기계 환경변수만** 받는다. 콘솔 창에서 `set`·`$env:` 로 넣은 값이나 관리자
계정의 사용자 변수는 재부팅·감시 재시작·`update_git` 재시작 때 사라진다. 운영에서 켜는 변수(예: 에셋 대장
`CONTENT_HUB_ASSET_REGISTRY`)는 관리자 PowerShell 에서
`[System.Environment]::SetEnvironmentVariable('<이름>','<값>','Machine')` 으로 넣는다. 이 값은 PC 의 윈도우
설정에 있어 서버 이사 도구가 옮기지 않는다 — 새 PC 에서 다시 넣는다([SERVER_MIGRATION.md](SERVER_MIGRATION.md)).

## 설정 (모두 환경변수, 하드코딩 없음)

> 아래 표는 **운영에서 자주 만지는 것만** 추린 것이다. 전체 `CONTENT_HUB_*` 변수는 70개가
> 넘으며(Comfy `_COMFY_*`, Resolve `_RESOLVE_*`, HTTPS `_SSL_CERTFILE/_SSL_KEYFILE`,
> 백업 복제 `_BACKUP_REPLICA_DIR`, 캐시 상한 `_MEDIA_CACHE_MAX_BYTES`/`_THUMB_*` 등)
> 기본값과 정의는 `backend/app/config.py` 와 각 서비스 모듈 상단이 정답이다.

| 변수 | 기본값 | 용도 |
|------|--------|------|
| `CONTENT_HUB_HOST` | `127.0.0.1`(AUTH off) · `0.0.0.0`(AUTH on 또는 MV_server.bat) | 바인딩 주소 |
| `CONTENT_HUB_PORT` | `8000`(코드) · **MV_server.bat=8010** | 포트 |
| `CONTENT_HUB_DATA` | `backend/data` | DB·미디어·공유 루트 |
| `CONTENT_HUB_FRONTEND_DIST` | `frontend/dist` | 서빙할 빌드 산출물(없으면 API 전용) |
| `CONTENT_HUB_ASSETS_DIR` | `<DATA>/assets` | Assets(구성) 패널 루트 |
| `CONTENT_HUB_WORKER_ID` / `_NAME` | `me` / `나` | 기본 작업자 |
| `CONTENT_HUB_BACKUP_DIR` | `<DATA>/backups` | DB 백업 보관 폴더(실서버: 다른 디스크/NAS 권장) |
| `CONTENT_HUB_BACKUP_INTERVAL` | `86400`(하루) | 백업 주기(초). 0 이하 = 비활성 |
| `CONTENT_HUB_BACKUP_KEEP` | `7` | 백업 보관 개수(회전) |
| `CONTENT_HUB_AUTH` | `0`(코드) · **MV_server.bat=1** | 로그인 인증 enforcement. 1 이면 로그인 필수 |
| `CONTENT_HUB_MANAGE` | `1`(on) | PM/관리 대시보드(상단 보드 아이콘). 0 이면 숨김 |
| `CONTENT_HUB_AUTH_SECRET` | (자동생성) | 토큰 서명 시크릿. 미지정 시 DB에 1회 생성·영속 |
| `CONTENT_HUB_LOG_DIR` | `<DATA>/logs` | JSON 운영 로그 폴더 |
| `CONTENT_HUB_LOG_MAX_BYTES` | `10485760` | 운영 로그 파일 1개의 회전 크기 |
| `CONTENT_HUB_LOG_KEEP` | `5` | 회전 로그 보관 개수 |
| `CONTENT_HUB_METRICS_LOG_INTERVAL` | `60` | CPU·메모리·요청 집계를 로그에 남기는 주기(초), 0=비활성 |
| `CONTENT_HUB_SLOW_REQUEST_MS` | `1000` | 개별 느린 요청을 운영 로그에 기록하는 기준(ms) |
| `CONTENT_HUB_MEDIA_PRESERVATION` | `0`(off) | 기본 URL-only. 특수 설치에서만 1로 영구 보존 opt-in |
| `CONTENT_HUB_PRESERVED_MEDIA_MAX_BYTES` | `53687091200`(50GiB) | opt-in 시 원본 영구 보존 총량 |
| `CONTENT_HUB_MEDIA_PRESERVATION_INTERVAL_SECONDS` | `30` | opt-in 원본 보존 워커 주기(초), 한 주기 최대 2건 |
| `CONTENT_HUB_MEDIA_PRESERVATION_STARTUP_DELAY_SECONDS` | `10` | 서버 시작 뒤 원본 보존 다운로드 시작 유예(초) |
| `CONTENT_HUB_MEDIA_PRESERVATION_MAX_ATTEMPTS` | `5` | 자동 재시도 최대 횟수. 이후 정보창에서 수동 재시도 가능 |
| `CONTENT_HUB_RESTART_LIMIT` | `5` | 빠른 서버 종료를 연속 허용하는 횟수 |
| `CONTENT_HUB_STABLE_SECONDS` | `120` | 이 시간 이상 정상 실행하면 빠른 종료 횟수 초기화 |

## 로그인/계정 승인 보안 (CONTENT_HUB_AUTH=1)

코드 기본은 off 지만 **MV_server.bat 은 `CONTENT_HUB_AUTH=1`(로그인 필수) 로 켜서 기동**한다
(팀 서버 용도). 개인 PC·개발에서 인증 없이 쓰려면 실행 전 `set CONTENT_HUB_AUTH=0`.

켜면:
- 모든 `/api/*`(로그인·헬스 제외)가 **승인된 세션**을 요구(미들웨어가 매 요청 검증).
- **첫 가입 계정 = 관리자(C0)**, 이후 가입은 **승인 대기(pending)** → 관리자가 승인해야 로그인 가능.
- 관리자 작업(멤버 등급·계정 승인)은 **C0/C1 만**(2겹: 미들웨어 + 역할 검증).
- 비밀번호는 pbkdf2-sha256(솔트), 세션은 hmac 서명 토큰(stdlib, 새 의존성 0).
- 프론트: 미로그인 시 로그인/가입 화면이 앱 전체를 가리고, 관리자 창에 계정 승인 섹션이 뜬다.
- **보호 범위**: `/api/*`(인증·헬스 제외) + `/media/*` + `/ws`. 결과물 원본·실시간 채널까지 전부 차단.
  - 인증 전달: API 는 `Authorization: Bearer` 헤더, 미디어·WS 는 **httpOnly 세션 쿠키**(ch_session,
    헤더를 못 붙이는 img 태그·WebSocket 용). 로그인 시 토큰+쿠키 동시 발급, 로그아웃 시 둘 다 폐기.
  - 정적 SPA(로그인 화면)와 로그인·가입·헬스 엔드포인트는 공개(그래야 로그인 화면이 뜬다).

## 미디어 URL-only 정책

Higgsfield 생성물은 DB에 원격 HTTPS URL을 보관한다. 공유·최종 선택은 서버와 작업자
PC의 `media/`에 원본 영상을 자동 저장하지 않는다. 구버전이 보존한 항목도 DB에 남은
`source_url`을 응답에서 우선하며, 이미 받은 파일은 안전을 위해 자동 삭제하지 않는다.

목록을 빠르게 보여주기 위한 썸네일은 각 작업자의 로컬 허브에서 만든다. 원격 이미지와
영상 포스터를 목록 조회 직후 작은 JPEG로 미리 만들며, 썸네일과 썸네일 생성용 원본은
작업자 PC의 용량 상한이 있는 LRU 캐시에만 둔다. 오래된 캐시는 자동 정리되고 비디오 원본
자체는 사전 준비하지 않는다. 공유 서버는 원격 썸네일을 생성·저장하지 않는다.

기존 영구 보존 코드는 특수 설치 호환성을 위해 남아 있지만 기본은 꺼져 있다.
`CONTENT_HUB_MEDIA_PRESERVATION=1`을 명시한 설치에서만 시작 백필·주기 다운로드·수동
`/api/cache-all`이 활성화된다. 일반 배포는 이 값을 설정하지 않는다.

## DB 자동 백업

SQLite 파일 손상·실수 삭제 대비. **SQLite 온라인 백업 API**로 콘텐츠·휴지통·프로젝트
관리 DB를 같은 stamp의 세트로 뜬다(WAL 모드에서 단순 파일복사는 위험 — `-wal` 미반영분 누락).
단, SQLite/WAL은 여러 attached DB 전체의 원자적 동일 시점을 보장하지 않아 별칭별 첫 읽기 사이에
미세한 시점 차와 이동 중 행의 중복·누락 가능성이 있다. 서버 시작 시 1회(최근 백업이
1시간 내면 생략) + 주기 실행, 최근 `BACKUP_KEEP` 개만 회전 보관.

- 수동 백업:   `POST /api/backup`
- 백업 목록:   `GET /api/backups`
- ⚠️ 실서버에선 `CONTENT_HUB_BACKUP_DIR` 를 **다른 디스크/NAS**로 — 같은 디스크면 동반 손실.

### 작업자 PC 백업

로그인한 작업자 허브는 로컬 온라인 백업 뒤 개인 `content + trash` 세트를 영속 outbox에 넣고
공유 서버의 `POST /api/db-backup/sets`로 자동 전송한다. 공유 서버는 세션 계정별
`backend/data/db-backups/<계정>/sets/<backup_set_id>/`에 저장하며, 크기·SHA-256·SQLite
무결성과 정확한 ACK가 모두 맞아야 성공이다. 설정의 `서버에 백업`은 같은 경로를 즉시 실행한다.

공유 서버 디스크는 두 번째 물리 사본이 아니다. `tools/backup_replicate.py`와
`register_autostart.bat`의 `MVHub BackupCopy`를 사용해 서버 자체 백업과 작업자 세트를 NAS·다른
디스크로 한 번 더 복제해야 한다. 자세한 완료 조건은
[WORKER_OFFDISK_BACKUP_CONTRACT.md](WORKER_OFFDISK_BACKUP_CONTRACT.md)를 따른다.

### 백업 복원 훈련

운영 DB를 교체하지 않고 임시 파일에 온라인 백업→복원→무결성·외래키·테이블 행 수 비교를 수행한다.
운영 복구 가능성을 확인할 때는 단일 DB가 아니라 **같은 stamp의 콘텐츠·휴지통·관리 DB 세트**를
검증해야 한다. 이 stamp는 세트 구성 표식이지 DB 간 완전히 동일한 트랜잭션 시점의 증명이 아니다.

```powershell
py -3 tools\verify_backup_restore.py
py -3 tools\verify_backup_restore.py --backup "E:\MVHub-backups\content_hub_20260731_120000.db"
py -3 tools\verify_backup_restore.py --backup-set "E:\MVHub-backups\content_hub_20260731_120000.db"
```

`--backup-set`은 같은 폴더에서 정확히 같은 stamp의 `content_trash_*.db`와 `manage_hub_*.db`를
찾는다. 세 파일 중 하나라도 없으면 아무것도 복원하지 않는다. 성공 JSON에서 다음을 확인한다.

- 최상위 `"ok": true`, `"mode": "database_set"`
- `isolated_server.ready_checks`의 `content`, `trash`, `manage`가 모두 `"ok"`
- `isolated_server.login`이 `"ok"`, `process_stopped`가 `true`
- `files.*.source_unchanged`가 모두 `true`

검사 실패나 핵심 수의 예상 밖 변화가 있으면 그 세트를 운영에 설치하지 말고 이전 완성 세트로 같은
드릴을 다시 실행한다. content와 trash에 같은 generation ID가 함께 남은 경우에만 부팅 정합기가
살아 있는 content 행을 우선하고 trash 중복을 제거한다. 한쪽에만 빠진 행이나 manage 의미 불일치는
드릴만으로 완전 검출할 수 없고 자동 추측 복구도 하지 않는다. 화면·세트 요약을 이전 세트와 대조해
차이가 의심되면 이전 정상 세트를 선택하고 별도 조사한다.

별도 `--restored-dir`을 주지 않으면 복원 사본과 격리 서버 로그는 성공·실패 후 임시 폴더와 함께
삭제된다. `--restored-dir`로 남긴 사본에는 로그인 실측용 임시 account·creator가 각 1건 추가되므로
**운영 DB로 직접 교체하면 안 된다.** 실제 장애 복원은 서버를 중지하고 기존 운영 DB를 별도 보존한
뒤 검증된 원본 백업 3개를 사용한다. 이 도구 자체는 운영 DB와 원본 백업을 자동 교체·수정하지 않는다.

## 운영 상태 확인

- 준비 상태: `GET /api/ready` — 콘텐츠·생성 큐 및 활성화된 관리/휴지통 DB의 핵심
  테이블 읽기까지 성공하면 `ready`, 실패하면 HTTP 503. DB 복원 유지보수 중에는 DB 연결을
  기다리지 않고 즉시 `503 {"status":"maintenance"}`와 `Retry-After: 5`를 반환한다.
- 관리자 지표: `GET /api/admin/runtime` — 요청 p50/p95/p99, 5xx, SQLite 잠금,
  프로세스 CPU·RSS, WebSocket·에이전트 연결, 생성 단계/지연, 최근 백업,
  관리 데이터 전송 대기·실패, 원본 보존 pending/running/partial/failed/capacity 집계,
  작업자 백업 대기·마지막 성공, 외부 복제 상태, DB/WAL·미디어·썸네일 용량.
- 회전 로그: `<DATA>/logs/mvhub-runtime.jsonl` — 60초 집계와 생성 상태 전이,
  5xx·느린 요청을 JSON 한 줄로 기록. 평상시에는 `MV_logs.bat`로 정돈된 로그를 본다.
- 장기 생성 이력: `GET /api/admin/generation-events?generation_id=...` — 회전 로그와 별개로
  DB의 `generation_event`에 요청·작업 ID 확보·검증·완료/실패 전이를 보관한다.
- 중요 변경 감사: `GET /api/admin/audit-events?project_id=...` — 계정 상태/역할,
  프로젝트 생성·변경·삭제/멤버 역할, 일정·예산, 최종 선택 변경을 `audit_event`에 보관한다.

생성 확인 지연, 10분 이상 밀린 관리 데이터, 전송 실패, 원본 보존 일부 실패·실패·용량 부족,
DB 준비 실패는 `WARNING`으로 남는다.
같은 상태를 매분 반복하지 않고 상태가 바뀌거나 30분 이상 계속될 때만 다시 알려 로그 폭주를 막는다.

초기 관리자 비밀번호를 환경변수로 주지 않은 첫 설치는
`<DATA>/bootstrap_admin_password.txt`에만 1회용 비밀번호를 기록한다. 콘솔 로그에는
비밀번호가 나오지 않는다. 로그인 후 비밀번호를 변경하고 이 파일을 삭제한다.

관리자 지표·회전 로그·장기 이력에는 비밀번호·이메일 원문·프롬프트·미디어 URL을 기록하지 않는다.
이메일 기반 임시 신원은 복구 불가능한 지문으로 바꿔 기록한다. 부하 테스트 중에는
`sqlite_locked_total=0`, 애플리케이션 `5xx=0`, 메모리 워밍업 이후 안정 여부를 우선 확인한다.

## 신규 서버 소스 설치 참고

기존 서버의 데이터·계정을 옮기는 절차는 [SERVER_MIGRATION.md](SERVER_MIGRATION.md)가 정본이다.
서버 정지 후 export, DB 세트와 머신별 제외 파일, 검증·복귀 조건을 따른다. 아래 목록은 신규 서버의
소스·런타임 준비 참고이며, 실행 중인 서버 폴더를 그대로 복사하는 이전 절차로 사용하지 않는다.

1. 이 폴더 전체를 서버로 복사(`node_modules`·`dist`·`__pycache__` 제외 — 설치 과정에서 재생성).
2. `pip install -r backend/requirements.txt`, Node 설치.
3. 데이터 경로를 서버 디스크에 맞춰 `CONTENT_HUB_DATA` 지정(권장: 영속 볼륨).
4. Windows는 `register_autostart.bat`으로 설치·기동한다. 수동 구성은
   `npm ci` → `npm run build` → `python serve.py`(IPv4/IPv6 듀얼스택, `--reload` 금지). 직접 uvicorn 이면
   `python -m uvicorn app.main:app --host 0.0.0.0 --port 8010`.
5. 방화벽에서 해당 포트 인바운드 허용.
6. Higgsfield CLI 는 **각 사용자 개인 PC**에서 본인 계정으로 — 서버엔 토큰을 두지 않는다
   (로드맵 보안 원칙). 서버는 데이터 수집(`/sync`)·보관·서빙만 담당.

> ⚠️ Windows 에서 `--reload` 금지: 리로더가 SelectorEventLoop 을 강제해 CLI subprocess 가
> 깨진다(NotImplementedError). 코드 수정 후엔 프로세스를 직접 재기동.
