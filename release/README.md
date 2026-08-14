# MV Hub Release

작업자 PC에 Git/Python/Node.js/npm 없이 배포하기 위한 릴리즈 도구입니다.

## 관리자 PC

새 버전 zip 만들기:

```powershell
cd D:\ClaudeCode\MV-hub-S\release
.\make_release.bat
```

공유 서버에 자동 게시하지 않고 로컬 검증용 패키지만 만들기:

```powershell
.\make_release.ps1 -SkipPublish
```

생성 결과:

```text
release\packages\
  latest.json
  MVHub-<버전>.zip
  MVHub_Install.bat
```

### 서버로 자동 복사

`release\publish_target.txt`에 서버 `packages` 폴더 경로가 있으면, `make_release.bat`이 빌드 후
**zip, 설치기, latest.json을 그 폴더로 자동 복사**합니다(수동 복사 불필요). latest.json을 맨 나중에 복사해
작업자가 배포 중간본을 받는 일이 없습니다. 경로 파일이 없으면 기존처럼 수동 안내만 뜹니다.

```text
release\publish_target.txt   ← 예: Z:\mvutil\MV_hub_S\packages  (머신별 로컬, git 제외)
```

처음 한 번 `publish_target.txt.example`을 복사해 자기 서버 경로를 넣어두면 됩니다.

zip 안에는 실행에 필요한 portable runtime과 로컬 업데이트 파일이 같이 들어갑니다.

```text
MV_agent.bat          # 평소 실행
update_release.bat      # 설치 후 업데이트만
runtime\python        # 백엔드 실행용 Python
runtime\node          # Node.js/npm
runtime\higgsfield    # Higgsfield CLI
frontend\dist         # 빌드 완료된 프론트
backend               # 백엔드 코드
```

`hf_cli_version.txt`의 고정 버전과 실제 번들 npm 패키지 버전이 다르면 릴리즈 생성이 중단됩니다.
완성된 ZIP 내부에서도 같은 검사를 한 번 더 수행하고, `latest.json`에
`higgsfield_cli_version`을 기록합니다. 따라서 작업자는 `update_release.bat`만 실행하면 앱 코드와
Higgsfield CLI가 함께 갱신되며, 릴리즈 설치본에서는 `update_git.bat`을 사용할 필요가 없습니다.

## 서버 폴더

서버에는 아래 구조만 있으면 됩니다.

```text
Z:\mvutil\MV_hub_S\packages
    MVHub_Install.bat
    latest.json
    MVHub-<버전>.zip
```

설치기는 자신과 같은 폴더의 `latest.json`을 자동으로 사용하므로 서버 경로를 직접 편집하지 않습니다.
한 단계 위에 두더라도 바로 아래 `packages\latest.json`을 자동으로 찾습니다.

## 작업자 사용법

처음 설치:

```text
Z:\mvutil\MV_hub_S\packages\MVHub_Install.bat
```

평소 실행:

```text
%USERPROFILE%\Desktop\MV-hub-S\MV_agent.bat
```

업데이트만(최초 1회 또는 비상 복구):

```text
%USERPROFILE%\Desktop\MV-hub-S\update_release.bat
```

처음 설치하면 `INSTALL_SOURCE.txt`에 서버 `packages` 경로가 저장됩니다. 자동 업데이트 기능이 포함된
릴리스를 한 번 설치한 뒤부터는 MV Hub **설정 → 프로그램 업데이트**만 누르면 됩니다. 프로그램이
새 릴리스를 검증·설치하고 자동으로 다시 시작하므로 작업자가 서버 폴더를 다시 찾을 필요가 없습니다.

이 버튼이 없던 구버전 작업자 PC에는 새 버튼을 원격으로 만들 수 없으므로, 첫 전환 때만 위의
`update_release.bat`를 한 번 실행합니다. 그 다음 릴리스부터는 프로그램 안의 버튼만 사용합니다.

프로그램 안에서 업데이트하면 진행 중인 생성·Comfy 작업이 없는지 먼저 확인합니다. 안전할 때만 기존
MV Hub를 종료하고 파일을 교체한 뒤 새 버전의 준비 완료까지 확인합니다. 수동 `update_release.bat`는
비상 복구용이라 실행 전에 MV Agent 창을 닫는 것이 가장 깔끔합니다.

## 업데이트 흐름

1. 관리자가 `make_release.bat`로 새 zip 생성 (→ `publish_target.txt` 설정 시 서버 `packages`로 자동 복사)
2. (자동 복사 안 쓰면) 서버 `packages`에 새 `latest.json`과 `MVHub-<버전>.zip` 수동 복사
3. 작업자는 MV Hub 설정에서 `프로그램 업데이트` 클릭
4. 버전 차이 또는 설치 손상을 발견하면 자동 다운로드/검증/복구 설치
5. MV Hub가 자동 재시작되고 새 버전의 준비 완료를 확인

공유 서버 코드는 기존처럼 서버 PC에서 `update_git.bat`으로 갱신합니다. 작업자 릴리스 버튼과 서버 Git
업데이트는 서로 다른 경로이며, 한쪽이 다른 쪽을 대신 실행하지 않습니다. 서버 업데이트의 실제 작업
파일은 실행 전에 Windows 임시 폴더로 복사되므로 `git pull`이 업데이트 스크립트 자체를 교체해도
진행 중인 실행 흐름은 바뀌지 않습니다.

## 직전 버전으로 롤백

`packages` 폴더에 직전 정상 ZIP을 보관한 상태에서 다음 명령을 실행합니다.

```powershell
.\select_release.ps1 -PackagePath Z:\mvutil\MV_hub_S\packages\MVHub-<직전정상버전>.zip
```

기존 `latest.json`은 날짜가 붙은 `latest.previous-*.json`으로 보관됩니다. 선택한 ZIP의
`VERSION.txt`와 SHA256으로 새 `latest.json`을 만든 뒤 작업자가 `update_release.bat`를 실행하면
이전 버전으로 전환됩니다.

설치/업데이트는 DB·미디어를 보존하고, 프로그램 영역은 폴더 단위로 깨끗하게 교체합니다. 릴리즈는 `backend\app`과 필요한 실행 파일만 허용 목록으로
복사하며, `backend\data`, `data_test`, 테스트 스냅샷, DB, 미디어, 캐시는 zip에 포함하지 않습니다.
압축 후에도 필수 런타임 존재와 로컬 데이터 부재를 확인하고, ZIP을 다시 풀어 Python 표준 라이브러리와
백엔드 의존성을 실제 실행합니다. Python 버전 DLL이 둘 이상 섞여도 배포 전에 ZIP을 폐기합니다.
정식 작업자 릴리즈의 Python은 Resolve 20.3.2 실연결까지 검증한 CPython 3.14 x64로 고정합니다.
빌드 PC에 3.14 x64가 없거나 다른 버전이 선택되면 릴리즈를 만들지 않으며, 업데이트 후에도
`python314.dll` 하나만 남았는지 검사합니다. 소스 개발 환경의 Python 3.11+ 최소조건과는 별도입니다.

저장소 관리자만 사용하는 `backfill_import.py`, `cleanup_orphan_creators.py`, `reset_db.py`도
작업자 릴리즈에서는 제외합니다. 테스트 BAT·테스트 코드·개발 문서와 도구·프론트 소스맵·로컬
설정 파일이 ZIP에 섞여도 검증 단계에서 실패합니다. 단, `test_pull-db`가 배포된 서버에서 안전한
DB 사본을 만들 때 사용하는 스냅샷 기능 코드는 평소 비활성 상태로 앱에 유지됩니다.
압축 검증은 금지 파일 검사뿐 아니라 최상위·백엔드·프론트 허용 구조도 확인하므로, 새 개발
파일을 릴리즈 복사 단계에 실수로 추가해도 배포 전에 중단됩니다.

이 ZIP은 작업자 설치 전용이므로 Git 저장소에서만 쓰는 `MV_server.bat`, `update_cli.bat`, 루트
`README.md`도 넣지 않습니다. 공유 서버는 저장소의 `MV_server.bat`으로 별도 운영하고, 작업자
ZIP에는 `MV_agent.bat`, 자동 업데이트 파일과 실행 런타임만 넣습니다.

portable Python에서는 컴파일·GUI 개발용 `include`, `libs`, Tcl/Tk, IDLE, venv와 기존 Scripts를
제외합니다. 대신 앱 의존성이 손상됐을 때 `MV_agent.bat`이 자동 복구할 수 있도록 고정 버전 `pip`는
반드시 포함하고, 압축 검증에서도 실제 모듈 존재를 확인합니다.

## 주의

- 작업자 PC에 Git/Python/Node.js/npm이 없어도 됩니다.
- Higgsfield 첫 로그인은 작업자 본인이 해야 합니다.
- 다른 PC에서 `Z:` 드라이브가 없을 수 있으면 `BASE_URL`을 `\\서버이름\공유폴더\packages` 형태로 바꾸는 것이 더 안전합니다.
