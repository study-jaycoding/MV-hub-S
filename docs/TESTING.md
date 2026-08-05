# 테스트 실행 가이드

테스트용 런처는 파일명 앞에 **`test_`**가 붙는다. 나머지 `MV_server.bat`·`MV_agent.bat` 등은 운영/실사용이다.
평소 개발은 내 PC의 **실시간 개발 모드**를 쓰고, 로그인·권한까지 최종 확인할 때는 서버의
**통합 테스트 모드**를 쓴다. 두 모드 모두 운영(8010)과 포트·데이터가 분리된다.

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
| `test_dev.bat` | 내 PC | 로그인 계정으로 테스트 백엔드(8012)·생성 에이전트·Vite(5173)를 실행하고 실시간 프론트엔드를 엶 |
| `test_pull-db.bat` | 내 PC | 필요할 때만 서버 DB를 격리된 `backend\data_test`로 내려받음(미디어 제외) |
| `test_server_dev.bat` | 서버 | 한 번에 live DB 복사·프론트 빌드·서버 최종 확인 환경(8011)을 실행 |

참고 — 운영(테스트 아님): `MV_server.bat`(공유 서버 8010), `MV_agent.bat`(각 PC 로컬 허브), `update*.bat`.

## 테스트 클론 최초 만들기 (서버에서, git)

테스트 클론은 **`backend frontend tools` 3개**를 sparse-checkout 해야 한다.
`tools/`가 빠지면 `test_server_dev.bat`이 쓰는 `tools\refresh_pm_test_data.py`가 없어 DB 복사가 실패한다.
(worker용 `setup_clone_git.bat`은 tools가 필요없어 `backend frontend`만 받으므로, 테스트 클론은 별도로 tools를 포함해야 한다.)

```powershell
cd E:\
git clone --filter=blob:none --sparse https://github.com/study-jaycoding/MV-hub-S.git MV-hub-test2
cd E:\MV-hub-test2
git sparse-checkout set backend frontend tools
git checkout feature/pm-dashboard
```

이후 업데이트는 그 폴더에서 `git pull` 한 줄.

## 로컬 실시간 개발 (내 PC)

평소에는 `test_dev.bat` 하나만 실행한다. 테스트 계정 이메일을 입력하면 다음 세 가지가 함께 켜지고 브라우저는
`http://127.0.0.1:5173` 하나만 열린다.

1. 격리된 테스트 백엔드 — 8012
2. 로컬 Higgsfield 생성 에이전트
3. Vite 실시간 프론트엔드 — 5173

`.tsx`·`.css` 변경은 저장 즉시 반영된다. 백엔드 `.py` 변경은 생성 CLI 안정성을 위해
자동 재시작하지 않으므로 `test_dev.bat`을 다시 실행한다.

브라우저와 배치 창의 생성 에이전트에는 반드시 같은 서버 계정으로 로그인한다. 서버 DB 전체에는
여러 사람의 결과가 들어 있지만, 로그인 계정의 `creator_uid`로 내 작업을 제한하므로 내 결과만 보인다.

최신 운영 DB 모양이 필요할 때만 먼저 `test_pull-db.bat`을 실행한다. 내려받은 DB와 이후 생성 결과는
`backend\data_test`에만 저장되며 운영 DB에는 쓰지 않는다. 단, 생성 요청은 실제 Higgsfield 작업이므로
실제 크레딧을 사용한다.

기존 버전에서 프론트엔드와 백엔드·에이전트를 따로 실행해 둔 경우에는 두 창을 모두 닫고
새 `test_dev.bat`을 실행한다. 5173 또는 8012가 이미 사용 중이면 새 런처는 중복 생성
에이전트를 만들지 않고 안내 후 종료한다.

## 서버 적용 전 최종 확인 (서버에서)

1. 서버 테스트 클론에서 `test_server_dev.bat` 하나를 실행한다.
2. live DB를 읽기 전용 스냅샷으로 복사한 뒤 현재 코드의 프론트엔드를 빌드한다.
3. 테스트 서버가 8011로 켜지면 내 PC 브라우저에서 `http://<서버IP>:8011`에 접속한다.

`CONTENT_HUB_NO_PROXY=1`이 중요하다. 빠지면 복사 DB가 로그인 시 토큰을 되살려 `/api/manage/*`가
운영 서버로 프록시되어 엉뚱한 404/오작동이 난다. `test_server_dev.bat`은 이 값과 서버측 CLI
동기화를 강제로 끄므로 운영 서버에는 쓰지 않는다.

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

> 주의: 8011 포트가 이미 사용 중이면 `test_server_dev.bat`은 기존 프로세스를 강제 종료하지 않고
> 안내 후 종료한다. 이전 서버 테스트 창을 닫은 뒤 다시 실행한다.
