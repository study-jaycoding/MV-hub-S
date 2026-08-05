# 테스트 실행 가이드

테스트용 런처는 파일명 앞에 **`test_`**가 붙는다. 나머지 `MV_server.bat`·`MV_agent.bat` 등은 운영/실사용이다.
평소 개발은 내 PC의 **실시간 개발 모드**를 쓰고, 로그인·권한·빌드 결과까지 최종 확인할 때는
내 PC의 **서버형 테스트 모드**를 쓴다. 최신 운영 DB가 필요하면 서버가 먼저 격리 스냅샷을
준비하고 내 PC가 그 복사본만 내려받는다. 모든 테스트 데이터는 운영(8010)과 분리된다.

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
| `test_push-db.bat` | 서버 | live DB를 수정하지 않고 `backend\data_test_push`에 일관된 스냅샷을 만든 뒤, 다운로드용 서버(8011)를 실행 |
| `test_pull-db.bat` | 내 PC | 서버가 준비한 8011 스냅샷 DB를 격리된 `backend\data_test`로 내려받음(미디어 제외) |
| `test_dev.bat` | 내 PC | 테스트 백엔드(8012)·생성 에이전트·Vite(5173)를 실행하고, 브라우저 로그인 계정을 에이전트에 자동 연결 |
| `test_dev_server.bat` | 내 PC | 내려받은 DB로 프론트 빌드와 API를 한 서버(8011)에서 실행해 배포 직전 형태를 확인 |

참고 — 운영(테스트 아님): `MV_server.bat`(공유 서버 8010), `MV_agent.bat`(각 PC 로컬 허브), `update*.bat`.

## 테스트 클론 최초 만들기 (서버에서, git)

테스트 클론은 **`backend frontend tools` 3개**를 sparse-checkout 해야 한다.
`tools/`가 빠지면 `test_push-db.bat`이 쓰는 `tools\refresh_pm_test_data.py`가 없어 DB 복사가 실패한다.
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

`test_pull-db.bat`의 관리자 비밀번호는 DB 다운로드에 필요하므로 CMD에서 한 번 입력한다. Windows 콘솔의
입력 echo를 끈 상태에서 실제 문자 대신 `*`만 표시하며 비밀번호를 저장하지 않는다.

최신 운영 DB 모양이 필요할 때는 서버에서 `test_push-db.bat`을 먼저 실행한 뒤, 내 PC에서
`test_pull-db.bat`을 실행한다. 내려받은 DB와 이후 생성 결과는 `backend\data_test`에만 저장되며
운영 DB에는 쓰지 않는다. 단, `test_dev.bat`에서 실행한 생성 요청은 실제 Higgsfield 작업이므로
실제 크레딧을 사용한다.

기존 버전에서 프론트엔드와 백엔드·에이전트를 따로 실행해 둔 경우에는 두 창을 모두 닫고
새 `test_dev.bat`을 실행한다. 5173 또는 8012가 이미 사용 중이면 새 런처는 중복 생성
에이전트를 만들지 않고 안내 후 종료한다.

## 최신 서버 DB로 배포 직전 확인

다음 순서를 그대로 따른다.

1. **서버** 테스트 클론에서 `test_push-db.bat`을 실행하고 창을 열어 둔다.
   - live DB는 읽기만 하고 `backend\data_test_push`에 일관된 복사본을 만든다.
   - 복사본만 제공하는 임시 서버가 서버 PC의 8011 포트에서 실행된다.
2. **내 PC**에서 `test_pull-db.bat`을 실행한다.
   - 관리자 비밀번호를 입력하면 서버의 8011 복사본을 `backend\data_test`로 내려받는다.
   - 다운로드가 끝나면 서버의 `test_push-db.bat` 창은 종료해도 된다.
3. **내 PC**에서 `test_dev_server.bat`을 실행한다.
   - 프론트엔드를 실제 배포 방식으로 빌드하고 UI와 API를 한 서버로 실행한다.
   - 준비가 끝나면 `http://127.0.0.1:8011`이 자동으로 열린다.

서버의 8011과 내 PC의 8011은 서로 다른 컴퓨터의 포트라 충돌하지 않는다. 운영 서버 8010과
live DB는 이 과정에서 수정되지 않는다. `test_dev_server.bat`은 Vite 실시간 반영과 생성 에이전트를
실행하지 않으므로, 코드를 수정하면서 확인하거나 실제 생성을 시험할 때는 `test_dev.bat`을 사용한다.

두 테스트 런처는 `CONTENT_HUB_NO_PROXY=1`과 서버측 CLI 동기화 비활성화를 강제한다. 복사 DB에
남아 있는 공유 서버 토큰 때문에 테스트 요청이 운영 서버로 잘못 전달되는 것을 막기 위한 설정이다.

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

> 주의: 8011 포트가 이미 사용 중이면 `test_push-db.bat`과 `test_dev_server.bat`은 기존 프로세스를
> 강제 종료하지 않고 안내 후 종료한다. 같은 PC에서 이전 8011 테스트 창을 닫은 뒤 다시 실행한다.
