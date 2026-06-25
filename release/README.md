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

zip 안에는 실행에 필요한 portable runtime이 같이 들어갑니다.

```text
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
  MV_agent_bootstrap.bat

  packages
    latest.json
    MVHub-<버전>.zip
```

`MV_agent_bootstrap.bat` 안의 `BASE_URL`은 서버의 `packages` 폴더를 가리켜야 합니다.

```bat
set "BASE_URL=Z:\mvutil\MV_hub_S\packages"
```

작업자는 `MV_agent_bootstrap.bat`만 더블클릭하면 됩니다.

## 업데이트 흐름

1. 관리자가 `make_release.bat`로 새 zip 생성
2. 서버 `packages`에 새 `latest.json`과 `MVHub-<버전>.zip` 복사
3. 작업자는 기존 `MV_agent_bootstrap.bat`를 다시 실행
4. 버전이 다르면 자동 다운로드/검증/설치 후 실행

설치/업데이트는 앱 파일만 덮어쓰며, 작업자 로컬 데이터인 `backend\data`는 zip에 포함하지 않습니다.

## 주의

- 작업자 PC에 Git/Python/Node.js/npm이 없어도 됩니다.
- Higgsfield 첫 로그인은 작업자 본인이 해야 합니다.
- 다른 PC에서 `Z:` 드라이브가 없을 수 있으면 `BASE_URL`을 `\\서버이름\공유폴더\packages` 형태로 바꾸는 것이 더 안전합니다.
