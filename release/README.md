# MV Hub Release

작업자 PC에 Git/Python/Node.js 없이 배포하기 위한 릴리즈 도구입니다.

구성 파일:

```text
make_release.bat / make_release.ps1   # 관리자 PC: 배포 패키지 생성
MV_agent_bootstrap.ps1                # 설치/업데이트 핵심 로직(서버에 함께 올림)
MV_agent_bootstrap.bat                # 작업자용: 설치/업데이트 + 실행(파일 하나)
install_mvhub_from_server.bat         # 작업자용: 설치/업데이트만(실행 안 함)
```

## 1. 릴리즈 만들기 (관리자/개발 PC)

```powershell
cd D:\ClaudeCode\MV-hub-S\release
.\make_release.bat
```

`release\packages\` 에 **세 개**가 생깁니다:

```text
latest.json                 # 버전 + 파일명 + sha256 + size
MVHub-<버전>.zip            # 앱 코드 + portable runtime(아래)
MV_agent_bootstrap.ps1      # 작업자 부트스트랩이 받아 실행하는 설치 로직
```

zip 안에는 앱 코드뿐 아니라 실행에 필요한 portable runtime도 같이 들어갑니다(작업자 무설치):

```text
runtime\python        # 백엔드 실행용 Python(requirements 미리 설치됨)
runtime\node          # Higgsfield CLI 실행용 Node.js/npm
runtime\higgsfield    # Higgsfield CLI
frontend\dist         # 이미 빌드된 프론트
```

> runtime을 빼고 만들려면 `make_release.bat` 대신
> `make_release.ps1 -SkipPythonRuntime -SkipNodeRuntime -SkipHiggsfieldCli` 처럼 옵션을 줍니다.

## 2. 서버(공유 폴더)에 올리기

`release\packages\` 의 **세 파일**을 회사 서버의 배포 폴더 하나에 그대로 올립니다.

```text
\\회사서버\MVHub\packages\
  latest.json
  MVHub-<버전>.zip
  MV_agent_bootstrap.ps1
```

UNC 공유 경로(`\\서버\...`) 또는 http 경로(`http://192.168.1.199:8010/packages`) 둘 다 됩니다.

## 3. 작업자에게 배포

작업자에게는 `.bat` **하나만** 주면 됩니다. 두 가지 중 선택:

| 파일 | 동작 |
|---|---|
| `MV_agent_bootstrap.bat` | 최신으로 설치/업데이트 후 **바로 MV_agent 실행** |
| `install_mvhub_from_server.bat` | 설치/업데이트만(실행은 따로) |

배포 전, 그 `.bat` 안의 `BASE_URL` 한 줄을 위 2번의 서버 폴더 경로로 바꿉니다.

```bat
set "BASE_URL=\\회사서버\MVHub\packages"
```

작업자가 더블클릭하면:

```text
1) BASE_URL 에서 MV_agent_bootstrap.ps1 를 받아 실행
2) latest.json 의 버전과 설치된 VERSION.txt 비교 — 같으면 아무것도 안 함(멱등)
3) 다르면 zip 다운로드 -> sha256 검증(불일치면 중단) -> 설치
   설치 위치: %USERPROFILE%\Desktop\MV-hub-S
4) (bootstrap 만) 설치된 MV_agent.bat 실행
```

설치/업데이트는 zip의 앱 파일만 덮어쓰고 **`backend\data`(작업자 로컬 DB·미디어)는 절대 건드리지 않습니다.**

## 주의

- 이 방식은 Git, npm build 과정을 작업자 PC에서 숨기는 1단계 배포입니다.
- 작업자 PC에 Python/Node.js/npm/Higgsfield CLI가 없어도 zip 안의 runtime을 먼저 사용합니다.
- 다운로드는 sha256으로 검증하므로 깨진/중간에 끊긴 파일은 설치되지 않습니다.
- Higgsfield 첫 로그인은 작업자 본인이 해야 합니다. 토큰은 작업자 PC의 사용자 영역에 저장되며 서버로 보내지 않습니다.
