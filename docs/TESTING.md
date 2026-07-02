# 테스트 실행 가이드

테스트용 런처는 파일명 앞에 **`TEST_`**가 붙는다. 나머지 `run-server.bat`·`MV_agent.bat` 등은 운영/실사용이다.
테스트는 서버의 **테스트 클론**에서 8011 포트 + 복사된 DB로 돌아가며, 운영(8010)과 데이터가 분리된다.

## 런처 한눈에 보기

| 파일 | 실행 위치 | 하는 일 |
|---|---|---|
| `TEST_refresh-db.bat` | 서버 | live DB를 테스트 클론의 `backend\data`로 복사(읽기 전용 스냅샷) |
| `TEST_run-server.bat` | 서버 | 테스트 서버 실행 — 8011, 로그인 켜짐, `CONTENT_HUB_NO_PROXY=1`로 완전 독립 |
| `TEST_open.bat` | 내 PC | 브라우저로 `http://<서버IP>:8011` 열기 (아무것도 실행 안 함, URL만 엶) |

참고 — 운영(테스트 아님): `run-server.bat`(공유 서버 8010), `MV_agent.bat`(각 PC 로컬 허브), `update*.bat`.

## 표준 순서 (서버에서)

1. `TEST_refresh-db.bat` — live DB를 테스트 클론으로 복사
2. `TEST_run-server.bat` — 8011로 실행
3. 내 PC에서 `TEST_open.bat` (= `http://<서버IP>:8011`)

`CONTENT_HUB_NO_PROXY=1`이 중요하다. 빠지면 복사 DB가 로그인 시 토큰을 되살려 `/api/manage/*`가
운영 서버로 프록시되어 엉뚱한 404/오작동이 난다. `TEST_run-server.bat`은 이 값을 강제로 켠다.

## 머지 전 체크리스트

1. 서버 테스트(AUTH=1) 통과 — 로그인·역할 권한 확인
2. `cd frontend && npm run build` (타입체크) 통과
3. 백엔드 `py_compile` / 서버 기동(smoke) 확인
4. 정리 커밋까지 끝낸 뒤 main에 반영(squash 권장)

> 주의: 테스트 런처는 8011 포트를 쓰는 프로세스를 강제 종료한다.
> 다른 프로그램이 8011을 쓰고 있으면 함께 종료되니 유의.
