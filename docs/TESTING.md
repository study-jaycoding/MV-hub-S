# 테스트 실행 가이드

테스트용 런처는 파일명 앞에 **`test_`**가 붙는다. 나머지 `MV_server.bat`·`MV_agent.bat` 등은 운영/실사용이다.
테스트는 서버의 **테스트 클론**에서 8011 포트 + 복사된 DB로 돌아가며, 운영(8010)과 데이터가 분리된다.

## 개발자 자동 테스트 기준선

백엔드 테스트 의존성은 운영용 `requirements.txt`와 분리된 `requirements-dev.txt`로 설치한다.
Windows PowerShell에서 `backend` 폴더를 기준으로 실행한다.

```powershell
python -m venv .venv
& '.\.venv\Scripts\python.exe' -m pip install -r requirements-dev.txt
$env:CONTENT_HUB_NO_PROXY = '1'
& '.\.venv\Scripts\python.exe' -m pytest -q -p no:cacheprovider
```

`python`이 Microsoft Store 별칭으로 연결되면 설치된 Python 3.11+ 실행 파일로 첫 줄만 실행한다.

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

## 런처 한눈에 보기

| 파일 | 실행 위치 | 하는 일 |
|---|---|---|
| `test_refresh-db.bat` | 서버 | live DB를 테스트 클론의 `backend\data`로 복사(읽기 전용 스냅샷) |
| `test_run-server.bat` | 서버 | 테스트 서버 실행 — 8011, 로그인 켜짐, `CONTENT_HUB_NO_PROXY=1`로 완전 독립 |
| `test_open.bat` | 내 PC | 브라우저로 `http://<서버IP>:8011` 열기 (아무것도 실행 안 함, URL만 엶) |

참고 — 운영(테스트 아님): `MV_server.bat`(공유 서버 8010), `MV_agent.bat`(각 PC 로컬 허브), `update*.bat`.

## 테스트 클론 최초 만들기 (서버에서, git)

테스트 클론은 **`backend frontend tools` 3개**를 sparse-checkout 해야 한다.
`tools/`가 빠지면 `test_refresh-db.bat`이 쓰는 `tools\refresh_pm_test_data.py`가 없어 DB 복사가 실패한다.
(worker용 `setup_clone_git.bat`은 tools가 필요없어 `backend frontend`만 받으므로, 테스트 클론은 별도로 tools를 포함해야 한다.)

```powershell
cd E:\
git clone --filter=blob:none --sparse https://github.com/study-jaycoding/MV-hub-S.git MV-hub-test2
cd E:\MV-hub-test2
git sparse-checkout set backend frontend tools
git checkout feature/pm-dashboard
```

이후 업데이트는 그 폴더에서 `git pull` 한 줄.

## 표준 순서 (서버에서)

1. `test_refresh-db.bat` — live DB를 테스트 클론으로 복사
2. `test_run-server.bat` — 8011로 실행
3. 내 PC에서 `test_open.bat` (= `http://<서버IP>:8011`)

`CONTENT_HUB_NO_PROXY=1`이 중요하다. 빠지면 복사 DB가 로그인 시 토큰을 되살려 `/api/manage/*`가
운영 서버로 프록시되어 엉뚱한 404/오작동이 난다. `test_run-server.bat`은 이 값을 강제로 켠다.

## 머지 전 체크리스트

1. 서버 테스트(AUTH=1) 통과 — 로그인·역할 권한 확인
2. `cd frontend && npm run build` (타입체크) 통과
3. 백엔드 `py_compile` / 서버 기동(smoke) 확인
4. 정리 커밋까지 끝낸 뒤 main에 반영(squash 권장)

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
- WebSocket 100개 연결
- 에이전트 롱폴 90개 이상 동시 대기
- 첫 전체 연결 사이클 이후 2차 사이클 RSS 증가 20% 이하

짧은 테스트 통과 후 운영 서버와 같은 사양의 스테이징 PC에서 8시간 지속 테스트를 실행한다.

```powershell
python tools\load_test_100.py --users 100 --duration 14400 --cycles 2 --output soak-result.json
```

> 주의: 테스트 런처는 8011 포트를 쓰는 프로세스를 강제 종료한다.
> 다른 프로그램이 8011을 쓰고 있으면 함께 종료되니 유의.
