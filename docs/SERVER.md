---
updated: 2026-10-23
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

`update_git.bat`은 서버·개발 git 클론 모두 **관리자 권한**으로 돈다. 탐색기에서 더블클릭하면 UAC 확인 창이
한 번 뜨고, 승인하면 관리자 창에서 진행한 뒤 끝에 한 번 멈춰 결과를 보여 준다(취소하면 아무것도 하지 않고 끝난다).
비관리자는 SYSTEM 예약 작업을 못 봐 서버를 작업자로 오판할 수 있으므로, 잠금·역할 판정·git 전에 승격한다.

판별 선언은 [release/compatibility.json](../release/compatibility.json) 하나를 코드와 함께 커밋한다.
서버는 fetch 뒤 선택한 `origin/main` SHA의 선언을 읽고 같은 SHA에서 stage를 만든다.
현재 선언은 reader 1 / writer 2, DB 읽기·쓰기 범위 1..2,
`schema_compat.py`의 9개 지원 component를 담는다. 지원 목록은 기능 활성화 설정이 아니다.
첫 판은 **`rollout="bridge"`(전환판), `required_installer_capabilities=[]`,
`backward_compatible=true`**로 선언한다. 이는 계약 검사를 통과하는 선언이며 배포 승인이나
모든 DB의 역방향 호환성 검증 완료를 뜻하지 않는다. 현재 근거와 남은 확인은 아래 최초 전환 절에 적는다.
전환판이 설치된 작업자 PC를 기준으로 다음 판부터 `enforced`와 `artifact-receipt-v1` 요구로 전환한다.
1358 워커는 새 계약을 검사하지 않으므로 이 선언만으로 거부 동작을 보장하지 않는다.

1. **게이트를 통과한 SHA 만 main 에 올린다.** main 에 올리기 전 후보 SHA 로 `tools\predeploy_gate.ps1`
   (문서 lint·구조 lint·백엔드 시험·프런트 시험·프런트 빌드·백업 복구 연습·부하)을 생략 옵션 없이 돌려
   `PREDEPLOY GATE PASSED` 를 확인한다. 서버는 검사 기록(도장)을 따로 확인하지 않으므로 이 순서가 유일한 시험 관문이다
   (2026-10-22 Jay 결정 — [기록](status/서버업데이트_도장제거_2026-10-22.md)). 검증 Python 은
   `backend\requirements-dev.txt`의 의존성이 준비된 환경을, 백업 복구 시험에는 사용자 DB 원본 대신 준비된 사본을
   지정한다. 예시 경로는 실제 준비 위치로 바꾼다.

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\predeploy_gate.ps1 `
     -PythonExe "D:\MVHub-operations\verifier\Scripts\python.exe" `
     -BackupSource "D:\MVHub-operations\backup-copy\content_hub.db" `
     -ReportDirectory "D:\MVHub-operations\receipts"
   ```

2. 서버 PC에서 저장소 루트의 `update_git.bat`을 **탐색기에서 더블클릭**하고 UAC 에서 '예'를 누른다.
   업데이터가 검증 Python(`logs\server-verifier`)을 확인·준비하고, coordinator 가 `origin/main` 을 받아 그 커밋으로
   별도 stage 를 만들고 격리 기동으로 확인한 뒤 supervisor 가 바꿔 끼운다. 준비 단계에서 실패하면 실행 중인 서버와
   DB 를 전환하지 않고 이유를 보여 주며 멈춘다. NAS·설정 파일·검사 기록은 필요 없다.
   바꿔 끼우는 동안 서버가 멈추는 시간은 이 PC 실측 약 30초다(그중 약 24초는 옛 서버를 멈춘 뒤 stage 를 다시 검사하는
   시간). 새 판이 기동 중 죽으면 준비 확인 한도(90초) 뒤 이전 판으로 돌아가 약 2분 뒤 다시 응답한다(2026-10-23 실측).
   전환이 실패하면 supervisor 콘솔(`logs\server_console.log`)에 `update failed: ValueError (<코드>)` 처럼 원인 코드가 남는다.
   업데이트 창은 진행 중 `[시:분:초] [n/6] 단계`(새 코드 받기 → 파이썬 패키지 → Higgsfield CLI → 화면 빌드 → 새 판 시험 기동 →
   서버 바꿔 끼우기)를 보여 주고, 끝에 한 번 **완료** 또는 **실패(종료 코드 N)** 를 크게 띄운다. 판정은 coordinator 의 종료 코드만
   쓴다 — 0 은 이번 실행의 새 판이 커밋됐거나 이미 최신이라는 뜻이고, 그 밖은 실패다(원인은 위에 coordinator 가 찍은 줄,
   서버 상태는 단정하지 않는다). 진행 줄은 창이 coordinator 를 띄운 뒤 생긴 실행별 준비 기록의 번호 하나만 보여 준다(이번 실행의 준비 번호를
   직접 받지 못해, 같은 순간 손으로 따로 돌린 coordinator 가 보일 수는 있다 — 결과 줄은 종료 코드라 영향 없음). 1초 안에 끝나면
   진행 줄 없이 결과 줄만 나온다. 창을 눌러도 멈추지 않게 결과 줄을 찍을 때까지 빠른 편집(QuickEdit)을 끄고 그 뒤 되돌린다.
   표시는 coordinator·supervisor 가 이미 쓰는 파일을 읽기만 하며, 업데이트 흐름과 종료 코드는 바꾸지 않는다
   ([기록](status/설치속도_압축풀기_2026-10-23.md)).

검증 Python 은 첫 실행 때 `logs\server-verifier` 에 자동으로 만들어진다(`tools/server_verifier.lock.txt` 의 해시 고정
psutil, 인터넷 필요). 깨졌거나 판이 다르면 그 폴더를 `server-verifier.broken-<id>` 로 옮겨 두고 다시 만든다.
stage 의 `.venv` 는 검증 Python 으로 쓰지 않는다.

stage 의 `.venv` 는 준비 단계(`prepare`)를 실행한 Python 으로 만들어진다 — `update_git.bat` 경로에서는 `run_py.bat` 이 고른
서버 Python(지금 공유 서버는 **CPython 3.12 Windows x64**)이다. 그 venv 는
`backend/requirements.lock.txt` 의 지문으로만 설치된다. 잠금에는 배포판 3.14 와 서버 3.12 휠 지문이 함께 있어야 한다 —
3.12 지문이 없으면 준비가 `prepare_step_exit_1`(로그 `THESE PACKAGES DO NOT MATCH THE HASHES`)로 멈춘다(2026-10-23,
[기록](status/서버파이썬312_잠금지문_2026-10-23.md)). 서버에 다른 Python 을 따로 깔면 `update_git_worker.bat`(py -3)과
`run_py.bat`(where python)이 서로 다른 Python 을 고를 수 있으니 먼저 확인한다.

고급: 환경변수 `MVHUB_SERVER_VERIFICATION_PYTHON`(psutil 이 있는 Python)을 지정하고 실행하면 그 값이 우선한다.
승격 창에는 이 값과 `MVHUB_NO_PAUSE=1` 만 인자로 명시 전달된다(따옴표·`%`·`!`·줄바꿈·끝 역슬래시가 든 값은 거부).

**도장 확인을 뺀 판(2026-10-22)을 서버에 처음 들일 때** — supervisor 의 stage 자격 형식이 `server-source-v2` 로 바뀌어
이번 한 번은 관리자 콘솔에서 수동 반입한다: `logs\server-current.json` 이 **없는지** 먼저 확인(있으면 옛 v1 stage 를
가리킬 수 있어 새 supervisor 가 거부한다 — 멈추고 판단) → `git fetch origin` → 승인 SHA 확인·`git log HEAD..<SHA>` →
`git merge --ff-only <SHA>` → `npm.cmd --prefix frontend run build` → `restart_server_task.bat`(운영 단계, 검증용 실행
금지) → ready·activation 확인. 그다음부터 위 2번 더블클릭으로 업데이트한다.

**소스 트리 실행(legacy-source) 서버의 첫 staged 전환** — 최초 전환 뒤 서버는 저장소 트리에서 직접 돈다(`/api/ready`
의 `runtime.build_id = legacy-source`). supervisor 는 시작할 때 그 트리의 `release/compatibility.json` 이 Git HEAD 판과
같고 프로토콜·구성요소를 명시하면 그것을 '이전 판 호환 근거'로 기록한다(앞뒤 소스 지문 확인, 선언 해시 기록).
그래서 첫 staged 전환에서 새 판이 기동에 실패해도 DB 가 그 선언 범위 안이면 이전 프로그램으로 자동 복귀한다.
이 기록은 supervisor 코드에 들어 있으므로 이 판을 받은 뒤 **통제된 재시작을 한 번** 해야 적용된다.

**supervisor 코드는 루트에 있다 — `update_git.bat` 으로 바뀌지 않는다.** supervisor·coordinator
(`tools/server_supervisor.py`·`tools/server_activation.py`·`tools/server_release_update.py`·
`backend/app/services/install_journal.py`·`tools/install_db_probe.py`)는 저장소 루트에서 돌고(`server_supervisor.py` 의 ROOT 는
파일 위치), `update_git.bat` 서버 역할은 루트를 바꾸지 않는다(새 판은 `logs\server-stages` 에만 만든다). 그래서 이 코드의
고침은 **루트에 수동 반입**해야 적용된다. 첫 사례: staged 전환이 `journal_changed` 로 매번 이전 판으로 돌아가던 것
([기록](status/서버전환_기록모양_2026-10-23.md)). 반입은 staged 자격 검사를 거치지 않고 실행 중 소스 트리 서버를
새 main 으로 바꾸는 배포다. 관리자 PowerShell 에서, 2~5단계 동안 공유 서버가 멈추니 팀원에게 생성·업로드를 끝내 달라고
먼저 알린 뒤 진행한다.

1. **읽기만 확인(하나라도 다르면 멈추고 보고)**: `logs\server-install-journal.json` 의 `phase` 가 `rolled_back` ·
   `logs\server-update-request.json` 없음 · `logs\server-current.json` 의 `path` = 루트, `build_id` = `legacy-source`,
   그 내용이 journal 의 `previous` 와 같음 · `git status` 깨끗 · 루트 `HEAD` 가 예상 기준 커밋 ·
   `git diff --name-only HEAD <SHA>` 에서 `backend/app` 아래는 이번에 고친 파일만, `frontend/` 변경 없음,
   `backend/requirements.txt` 변경 없음(루트 서버의 의존성은 이 파일로 설치된다). `backend/requirements.lock.txt` 는
   stage 준비에서만 쓰며, 바뀌었다면 바뀐 줄이 지문(`--hash=`)·주석 줄뿐이어야 한다(판은 requirements.txt 와 같아야
   하고 시험이 확인한다).
   `failed` 에서 루트를 바꾸면 재시작 때 `resume → recover` 가 바뀐 루트로 막힌다.
2. **자동 재기동을 막고 실제로 멈춘다**: `Disable-ScheduledTask` 로 `MVHub Watchdog`·`MVHub Server` 를 끄고
   `Stop-ScheduledTask` → 이 루트의 `server_supervisor.py`·`server_watchdog.py` 프로세스를 트리째 종료
   (`restart_server_task.ps1` 의 종료 규칙과 같다) → 그 프로세스가 하나도 남지 않았고 8010 을 듣는 프로세스가 없음을
   확인 → 멈춘 뒤 1의 journal·요청 파일·현재 기록 조건을 다시 확인. supervisor 를 켜 둔 채 바꾸면 그사이 서버가 죽었을 때
   supervisor 가 바뀌는 중인 루트에서 다시 띄운다. 여기까지 실패하면 끈 작업만 원래대로 켜고 서버를 다시 시작한다.
3. `git fetch origin` → `git merge --ff-only <SHA>`. (1의 조건이면 의존성 설치·프런트 빌드는 필요 없다.)
4. ff 가 성공했을 때만 `logs\server-current.json` 을 **지우지 않고** `server-current.before-intake-<날짜>.json` 으로 이름을
   바꿔 보존한다 — 옛 소스 지문 기록이라 그대로 두면 supervisor 가 `previous_source_changed` 로 시작을 거부한다.
   journal·`install-checkpoints` 는 그대로 둔다.
5. `Enable-ScheduledTask` 로 두 작업을 다시 켜고(꺼진 작업은 `Start-ScheduledTask` 로 켜지지 않는다)
   `restart_server_task.bat`(운영 단계) → 제한 시간 안에 `/api/ready` 가 `runtime.build_id = legacy-source`·
   `admission = normal` 이 되는지 확인. 재시작이 실패하거나 그 값이 아니면 두 작업을 다시 끄고 이 루트의 프로세스를
   멈춘 채 보고한다(루트가 이미 바뀌었으므로 자동 재기동에 맡기지 않는다).
6. 남은 이전 stage 는 재사용하지 않는다(요청 파일은 실패 때 이미 지워졌다). 이어서 `update_git.bat` 더블클릭으로
   새 stage 를 준비·전환해 staged 경로를 확인한다.

실패 처리: ff 가 실패했을 때는 `git rev-parse HEAD` 와 `git status --porcelain --untracked-files=normal` 이 **둘 다
성공**해 `HEAD` 가 이전과 같고 작업 트리가 깨끗함을 확인한 경우에만 4단계를 건너뛰고 5단계로 다시 켠다. 확인할 수 없거나
루트가 바뀐 뒤 실패하면 꺼 둔 채 보고한다.

**검사 도구 밖의 루트 코드만 바뀐 경우(서버를 멈추지 않는 반입)** — 예: 업데이트 창 `tools/run_update_git.ps1`. 서버가 stage 로
돌 때 서버는 stage 의 코드로 돌고, supervisor 는 아래 경고의 검사 도구 지문과 자기 파일만 루트에서 쓴다. 그래서 그 파일들이
안 바뀌면 루트를 앞감기해도 실행 중 서버·supervisor·복구에 영향이 없다. 관리자 PowerShell 에서: 루트 `HEAD` 가 예상 커밋이고
`git status --porcelain --untracked-files=normal` 이 비었는지 확인 → `git fetch origin` → `git log --oneline HEAD..<SHA>` 가
예상한 커밋뿐인지 확인 → `git diff --name-only HEAD <SHA>` 에 `tools/server_activation.py`·`tools/server_release_update.py`·
`tools/server_supervisor.py`·`qualify_release_artifact.TOOLS` 의 파일·`backend/app/` 아래 파일(supervisor 가 journal·DB 사본에
불러온다)이 없는지 확인(있으면 멈추고 위 반입 절차로) → `git merge --ff-only <SHA>` → 작업 폴더가 다시 깨끗한지 확인. 재시작은 필요 없다.

> [!WARNING]
> 서버가 stage 로 돌기 시작한 뒤에는 supervisor 가 시작할 때마다 현재 stage 의 자격을 루트의 검사 도구 지문
> (`tools/server_activation.py`·`tools/server_release_update.py`·`qualify_release_artifact.TOOLS`)과 대조한다. 그 뒤 이 파일들을
> 수동 반입으로 바꾸면 supervisor 가 `stage_qualification_tools_changed` 로 **시작하지 못하고**, 이전 stage 로의 복구도
> 같은 이유로 실패한다. 이런 반입은 서버가 소스 트리(legacy)로 돌 때만 한다.
그래도 `recovery_required`(선언이 없거나 HEAD 와 다르거나 DB 가 범위 밖)이면 서버는 멈춘 채로 남는다 —
journal·`install-checkpoints`·DB 를 그대로 두고 별도 복구 판단을 받는다. 아래 '1358 → dev2 최초 전환'의 되돌리기 절은
이 경우의 절차가 아니며, 사전 DB 사본은 보관용이지 덮어쓰기 복구에 쓰지 않는다.

**준비 단계의 전제(staged CLI):** 준비는 stage 안 `runtime\higgsfield`에 `hf_cli_version.txt`의 핀 버전
Higgsfield CLI를 `npm install --global --prefix`로 새로 설치하고 Node를 함께 복사한다. 그래서 관리자 콘솔의
PATH에 `npm.cmd`와 `node.exe`가 있어야 하고, 서버 PC가 `registry.npmjs.org`와 CLI 설치 스크립트가 내려받는
`github.com`에 닿아야 한다(격리 실행이라 프록시 설정·`.npmrc`는 쓰지 않는다 — 프록시로만 나가는 망에서는
준비가 실패하고 실행 중 서버는 그대로 남는다). 관리자·SYSTEM의 전역 CLI는 서버가 더 이상 쓰지 않는다 —
관리자 검증과 SYSTEM 서버 실행 모두 stage의 CLI를 쓴다.

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
`server without its active supervisor`로 거부된다. 현재 `bridge` 선언은 계약 검사를 통과하지만,
`MV_server.bat`으로 새 supervisor를 띄우는 것만으로 옛 워커의 남은 단계를 이어가지는 않는다.
실패 원인을 보존하고 아래 둘 중 승인된 복구 경로를 따른다.

승인된 복귀가 필요하면 서버의 새 작업을 멈추고 작업 트리가 깨끗한지 확인한 다음, 서버 루트의
관리자 PowerShell에서 1358 소스로 되돌리고 **그 소스로 의존성·프런트를 다시 만든 뒤** 재시작한다.
`frontend\dist`는 Git 밖이라 checkout으로 돌아오지 않고, 1358의 `MV_server.bat`은 `dist\index.html`이
있으면 빌드를 건너뛰므로 다시 만들지 않으면 1358 백엔드에 dev2 화면이 서빙된다.
`$PythonExe`는 위와 같이 `logs\update.log`의 `Using Python` 실행 파일이다.

```powershell
git checkout c2463e4f
if ($LASTEXITCODE -ne 0) { throw 'checkout 실패' }
& $PythonExe -m pip install -r .\backend\requirements.txt
if ($LASTEXITCODE -ne 0) { throw '의존성 설치 실패' }
Push-Location .\frontend
try {
    npm.cmd ci --include=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci 실패' }
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw '프런트 빌드 실패' }
} finally { Pop-Location }
$env:CONTENT_HUB_NO_PAUSE = '1'
.\restart_server_task.bat
if ($LASTEXITCODE -ne 0) { throw '서버 재시작 실패' }
```

**DB는 그대로 둔다**(dev2가 바꾼 DB를 1358이 읽고 쓰는 것은 격리 리허설로 확인 — 아래 근거). 다시
ready·로그인·팀 목록을 확인하며, 미커밋 변경이나 다른 DB 비호환이 있으면 강제 checkout·DB 덮어쓰기를
하지 않고 별도 복구 판단을 받는다.

복귀 뒤 원인을 해결하고 **다시 올릴 때는 `update_git.bat`을 쓰지 않는다.** 첫 pull이 이미 로컬
`main`을 dev2로 옮겨 두었으므로 `git checkout main`은 새 `update_git.bat`을 꺼내 오고, 새 진입점
(`tools\run_update_git.ps1`)은 실행 중인 1358 supervisor가 새 잠금을 갖지 않아
`server without its active supervisor`로 거부한다. 재시도는 `git checkout main`(detached HEAD 종료)
뒤 **아래 '옛 워커의 남은 단계 수동 완료' 명령을 그대로** 실행하고, 성공 확인 1~3을 다시 본다.

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
$env:CONTENT_HUB_NO_PAUSE = '1'
.\restart_server_task.bat
if ($LASTEXITCODE -ne 0) { throw '서버 재시작 실패' }
```

각 명령의 종료 코드 0, 의존성 import·버전 확인, `frontend\dist\index.html` 생성을 확인한 다음
위 성공 확인 1~3(ready·로그인·팀 목록, activation 상태, DB 지원 범위)을 다시 확인한다.
`restart_server_task.bat`은 `CONTENT_HUB_NO_PAUSE=1`이 없으면 종료 전에 `pause`로 입력을 기다린다.
DB를 되돌리거나 실패 표식을 임의로 지우지 않는다. 옛 워커가 남긴 `backend-deps.pending`·
`frontend-build.pending` 표식은 수동 완료로 지워지지 않는다. 다음 staged 갱신은 새 stage에
의존성을 설치하고 프런트를 빌드하므로 수동 완료 뒤에도 이 작업을 한 번 더 수행한다.

근거는 총괄이 제공한 **1358 서버 DB 사본 격리 리허설 보고**다: dev2 변환 후 compatible·ready 200,
옛 1358 코드로 ready·로그인·팀 목록 200, 다시 dev2 compatible을 확인했다. 이는 해당 사본과 코드의
왕복 호환성 근거이며, `serve.py` 직접 기동이었다. supervisor·예약 작업·옛 워커 전체 전환과
그 이후의 모든 데이터 변경까지 검증한 결과는 아니다. 작업자 쪽은 별도 격리 리허설 두 가지로 확인했다.
(1) 작업자 DB 사본(content·trash·manage)으로 격리 허브를 띄워 dev2 변환 → 1358 코드로 ready·목록·쓰기
(열람 기록) 200 → 다시 dev2 compatible. (2) 계정 하위 DB(`data/db/acct/<계정>/`) 사본 1개를 그 트리 코드로
직접 준비해 dev2 변환 → 1358 읽기·쓰기(열람 기록·휴지통 이동) → 다시 dev2 compatible·읽기·쓰기, 단계마다
quick_check ok. 기록은 [dev2 대체 검토](status/dev2_대체검토_2026-10-21.md)의 실측 절이다. 사본 몇 개의 결과이므로
모든 PC의 계정 DB 로 확대하지 않는다.

두 번째 업데이트부터는 새 supervisor와 coordinator를 확인한 뒤 위 **정기 업데이트** 절을 따른다.
선택 커밋의 명시적 rollout·capability 선언과 소스 검증 영수증이 필요하며, 첫 전환판의 선언은
다음 판의 배포를 자동 승인하지 않는다.

### 작업자 PC의 첫 bridge 릴리스

첫 전환판은 **새 릴리스 도구로 같은 ZIP의 검증을 마치고 게시한 현재 후보**만 대상으로 한다.
ZIP·불변 후보 기록·artifact 검증 영수증을 함께 게시한 뒤, **1358 앱의 설정 → 프로그램 업데이트에서
현재 후보 줄의 [배포]**를 사용한다. 이 경로는 `candidate.json` 원문을 `latest.json`으로 옮겨
`contract`와 영수증 참조를 보존한다. 1358 앱 자체가 새 계약을 검증하는 것은 아니므로,
새 도구의 검증·게시 완료를 먼저 확인해야 한다.

**후보가 아닌 옛 ZIP 줄의 [배포]는 사용하지 않는다.** 1358의 그 경로는 ZIP에서 옛 형식의 표지를
재구성해 `contract`와 영수증 참조를 잃는다. **기존 1358 설치 폴더 위에 새 `MVHub_Install.bat`을
실행하지 않는다.** 새 설치기는 새 설치 또는 이미 새 계약을 지원하는 설치본을 위한 경로이며,
1358 폴더의 첫 전환을 대신하지 않는다. 전환 후 해당 PC의 새 설치 기능과 `artifact-receipt-v1`
capability를 확인하고, 그 PC를 기준으로 다음 `enforced` 판을 적용한다. 확인 방법: 설치 폴더에
`update_release_contract.ps1` 이 있고, `installer-capabilities.json` 의 `capabilities` 배열에
`artifact-receipt-v1` 이 들어 있다. **bridge 를 받지 않은 PC(1358 그대로)는 새 계약을 검사하지 않으므로
enforced 판을 거부해 주지 않는다** — 모든 대상 PC 의 bridge 설치를 확인한 뒤에 enforced 판을 공개한다.
새 검증기는 있는데 이 capability 가 없는 PC 는 앱 업데이트에서 "installer bridge required before this release",
업데이터를 직접 실행하면 "Install the compatible bridge before this release." 로 거부된다.

bridge 선언 기록(2026-10-21): 구현 Codex(`dc2d522c`), 통합 후보 병합 `9d49a199`, 구현하지 않은 Claude 별도 세션
독립 리뷰 승인(리뷰어가 `9d49a199` 에서 직접 실행한 `test_release_contract.py` 92 통과, PowerShell 계약 시험 포함).
뒤이은 r10·r11 은 PowerShell 선언 검사를 Python 규칙과 맞추고 시험을 보강했다. 근거·남은 결정은
[dev2 대체 검토](status/dev2_대체검토_2026-10-21.md)에 둔다. 다음 `enforced` 판으로 바꿀 때는
`test_release_contract.py` 의 bridge 고정 단언을 값과 함께 바꾼다.

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

### 서버 관리 창(`MV_console.bat`, 서버 PC 전용)

서버 PC 에서 `MV_console.bat` 을 더블클릭하면 관리자 승인 한 번 뒤 tkinter 창이 열린다(1단계: 상태·로그·주소·Git 업데이트).
승인 요청은 검증된 Python 이 직접 한다(PATH·환경변수로 찾는 PowerShell 을 거치지 않음).
창을 닫아도 서버는 예약 작업으로 계속 돈다. 기존 bat(`update_git.bat`·`MV_logs.bat` 등)은 그대로 쓸 수 있다 — 창이 고장 나도 비상구.

- **전제**: `register_autostart.bat` 이 남긴 `.mvhub-runtime\python.txt` 의 Python 만 쓴다(다른 Python 으로 바꿔 쓰지 않음). 그 Python 에
  tkinter 가 없으면 이유를 보이고 멈춘다.
- **권한은 알림만 한다**(Jay 결정 2026-10-23 — 기존 `update_git.bat` 처럼 단추만 누르면 진행). 업데이트 전에 관리자 권한으로 돌리는
  코드(서버 루트의 `.bat`·`.ps1`·`.py`, `backend`·`tools`·`backend\app`·`.git\hooks`·`.git\config`·`logs\server-verifier`,
  Python·Node·Git 실행 파일·DLL·핵심 폴더와 그 위 폴더)를 관리자 말고 다른 계정도 고칠 수 있는지 보고, 있으면 업데이트 화면에
  '참고' 알림으로만 남긴다 — 업데이트는 막지 않는다(검사 자체가 실패해도 '확인하지 못했습니다' 알림만). 작업 기록 폴더(`logs\console-jobs`)
  권한이 흐트러져 있거나 읽지 못하면 창이 다시 잠그고 한 번 더 읽는다 — 그래도 못 읽으면 지난 결과를 모르니 막는다.
  감수한 위험: 서버 PC 에 이미 숨어 든 프로그램(같은 계정의 승격 안 된 프로그램 포함)이 그 파일이나 관리자 사용자 폴더의 Git·npm 설정
  (`~\.gitconfig`·`~\.npmrc`)을 고쳐 두면 업데이트 때 관리자 권한으로 실행될 수 있다 — 기존 `update_git.bat` 과 같은 수준이다.
- **상태 카드**는 값마다 확인 시각을 보이고, 60초 집계(`runtime_snapshot`)가 3분 넘게 없거나 형식이 다르면 '확인 불가'로 둔다(0·정상으로 채우지 않음).
  서버 상태 = 정상 / 전환 중 / 시작 중 / 유지보수 중 / 요청 차단 중 / 응답하나 준비 실패 / 응답 없음 / 정지 확인 / 서버 작업 없음 / 확인 불가.
  전환이 끝난 서버(admission `activated`)는 정상이다.
- **주소**는 네트워크(NIC) 이름과 함께 보이고, 서버가 그 포트로 답했을 때만 확인된 값이다(아니면 '설정값'·'기본값 추정').
  `CONTENT_HUB_SSL_CERTFILE` 이 있으면 https 로 묻는다.
- **로그 탭**은 `mvhub-runtime.jsonl`(회전 포함)과 `logs\server_console.log` 등을 이벤트 종류로 나눠 보인다. 모르는 이벤트도 '전체'에 남긴다.
  회전 직전 끝부분은 놓칠 수 있는 운영 보기다(감사 기록은 DB 의 `audit_event`).
- **Git 업데이트**는 `update_git.bat` 과 같은 `run_update_git.ps1 -NoPause` 를 창과 따로 도는 실행기(`tools\server_console\job_main.py`)가 돌린다.
  확인 창의 대상은 "실행 시점의 최신 origin/main" 이고(보이는 커밋은 참고), 판정은 종료 코드다. 창을 닫아도 업데이트는 끝까지 가고 결과는
  `logs\console-jobs\<작업 ID>\` 에 남는다. 끝나면 그 작업이 설치한 커밋을 보인다 — 실행 직전에 없던 준비 기록
  (`server-prepare-<run>.json`)이 정확히 하나 생겼을 때만 그 stage 의 `source_commit` 으로 잇고, 아니면 '미확인'이다.
  '이미 최신'이면 새로 설치한 커밋은 없다고 적는다. 참고 커밋을 읽는 Git 은 업데이트 안전장치를 통과한 뒤에만 실행한다(권한 검사 결과는 알림만).
  업데이트 흔적(`git-update.lock` 이 잡힘·전환 요청·끝나지 않았거나 못 읽은 journal·준비 running·못 읽었거나 모르는 상태의 준비 기록)이
  있으면 새 업데이트를 막는다. 실행기가 결과를 남기지 못했거나(모르는 상태·종료 코드 없는 완료 포함) 실행기를 띄우지 못했으면
  '결과 확인 필요'로 보이고, 사람이 서버 상태를 본 뒤 [확인했음]을 누르기 전에는 새 업데이트를 막는다(막고 있는 작업을 화면이 찾아 보여 준다).
  주소는 `/api/ready` 가 MV Hub 의 응답 모양일 때만 '확인'이고, 다른 프로그램이 답하면 'MV Hub 인지 미확인'으로 보인다.
- **반입**: 이 창은 서버 루트 코드라 `update_git` 으로 안 바뀐다 — 위 '검사 도구 밖의 루트 코드만 바뀐 경우' 앞감기로 들인다
  (`MV_console.bat`·`tools/server_console/` 는 검사 도구 지문 밖). 2단계부터 창의 '관리 도구 갱신'으로.

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
