# MV Hub Release

작업자 PC에 Git/Python/Node.js/npm 없이 배포하기 위한 릴리즈 도구입니다.

## 관리자 PC

새 버전 zip 만들기:

```powershell
cd D:\ClaudeCode\MV-hub-S\release
.\make_release.bat
```

생성 결과:

```text
release\packages\
  latest.json
  MVHub-<버전>.zip
```

zip 안에는 실행에 필요한 portable runtime과 로컬 업데이트 파일이 같이 들어갑니다.

```text
MV_agent.bat          # 평소 실행
MVHub_Update.bat      # 설치 후 업데이트만
runtime\python        # 백엔드 실행용 Python
runtime\node          # Node.js/npm
runtime\higgsfield    # Higgsfield CLI
frontend\dist         # 빌드 완료된 프론트
backend               # 백엔드 코드
```

## 서버 폴더

서버에는 아래 구조만 있으면 됩니다.

```text
Z:\mvutil\MV_hub_S
  MVHub_Install.bat

  packages
    latest.json
    MVHub-<버전>.zip
```

`MVHub_Install.bat` 안의 `BASE_URL`은 서버의 `packages` 폴더를 가리켜야 합니다.

```bat
set "BASE_URL=Z:\mvutil\MV_hub_S\packages"
```

## 작업자 사용법

처음 설치:

```text
Z:\mvutil\MV_hub_S\MVHub_Install.bat
```

평소 실행:

```text
%USERPROFILE%\Desktop\MV-hub-S\MV_agent.bat
```

업데이트만:

```text
%USERPROFILE%\Desktop\MV-hub-S\MVHub_Update.bat
```

처음 설치하면 `INSTALL_SOURCE.txt`에 서버 `packages` 경로가 저장됩니다. 이후 업데이트는 작업자 PC 안의
`MVHub_Update.bat`가 이 값을 읽어서 진행하므로, 작업자가 서버 폴더를 다시 찾을 필요가 없습니다.

업데이트 중 기존 MV Hub가 실행 중이면 설치 폴더 안의 Python/Node 프로세스를 먼저 종료하고 파일을 교체합니다.
그래서 작업자는 가능하면 MV Agent 창을 닫고 업데이트하는 것이 가장 깔끔합니다.

## 업데이트 흐름

1. 관리자가 `make_release.bat`로 새 zip 생성
2. 서버 `packages`에 새 `latest.json`과 `MVHub-<버전>.zip` 복사
3. 작업자는 로컬 `Desktop\MV-hub-S\MVHub_Update.bat` 실행
4. 버전이 다르면 자동 다운로드/검증/설치
5. 업데이트 후 필요할 때 `MV_agent.bat` 실행

설치/업데이트는 앱 파일만 덮어쓰며, 작업자 로컬 데이터인 `backend\data`는 zip에 포함하지 않습니다.

## 주의

- 작업자 PC에 Git/Python/Node.js/npm이 없어도 됩니다.
- Higgsfield 첫 로그인은 작업자 본인이 해야 합니다.
- 다른 PC에서 `Z:` 드라이브가 없을 수 있으면 `BASE_URL`을 `\\서버이름\공유폴더\packages` 형태로 바꾸는 것이 더 안전합니다.
