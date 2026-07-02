# 테스트 실행 가이드

테스트 관련 런처가 여러 개라 헷갈리기 쉬워, "어디서 무엇을 실행하는지"를 한 표로 정리한다.
핵심 원칙: **테스트는 항상 8011 포트 + 복사된 DB**로 돌아가며, 운영(8010)과 데이터가 분리된다.

## 한눈에 보기

| 모드 | 런처 | 실행 위치 | 포트 | 로그인(AUTH) | 사용하는 DB | 운영 영향 |
|---|---|---|---|---|---|---|
| 로컬 테스트 | `run-test.bat` | 내 PC | 8011 | 꺼짐(0) | `..\_pm_test_data` (리포 밖 복사본) | 없음 |
| 서버 테스트 | `run-server-test.bat` | 서버 | 8011 | 켜짐(1) | `backend\data` (live 복사본) | 없음 |
| 운영 서버 | `run-server.bat` | 서버 | 8010 | 켜짐(1) | `backend\data` (실데이터) | ★실서비스 |

두 테스트 모드 모두 `CONTENT_HUB_NO_PROXY=1`로 **완전 독립** — 관리 API가 운영 서버로 넘어가지 않는다.
(이 값이 빠지면 복사 DB가 로그인 시 토큰을 되살려 `/api/manage/*`가 운영으로 프록시되어 엉뚱한 404/오작동이 난다.)

## 데이터 준비(리프레시)

| 대상 | 런처 | 하는 일 |
|---|---|---|
| 로컬 테스트 DB | `refresh_pm_test_data.bat` | 공유 서버 데이터를 `..\_pm_test_data`로 스냅샷. 소스는 `pm_test_source_data.txt`(또는 Z:\ / URL) |
| 서버 테스트 DB | `refresh-server-test-db.bat` | 서버에서 live DB를 테스트 클론의 `backend\data`로 복사 |

`pm_test_source_data.txt`는 **머신마다 다른 로컬 상태값**(refresh가 매 실행 시 다시 씀)이라 git에서 제외한다.
처음 쓸 때 `pm_test_source_data.txt.example`을 복사해 자신의 공유 서버 주소를 넣으면 된다.

## 표준 순서

**내 PC에서 로컬 테스트**
1. `refresh_pm_test_data.bat` — 테스트 DB 준비(최초 1회 또는 최신화할 때)
2. `run-test.bat` — 8011로 실행
3. 브라우저 `http://127.0.0.1:8011`

**서버에서 테스트**
1. `refresh-server-test-db.bat` — live DB를 테스트 클론으로 복사
2. `run-server-test.bat` — 8011로 실행
3. 내 PC에서 `open-test.bat` (= `http://<서버IP>:8011`)

## 머지 전 체크리스트

로컬 테스트(AUTH=0)는 로그인·권한 버그를 못 잡는다. main 머지 전 아래를 모두 확인한다.

1. 로컬 테스트(AUTH=0) 통과
2. 서버 테스트(AUTH=1) 통과 — 로그인·역할 권한 확인
3. `cd frontend && npm run build` (타입체크) 통과
4. 백엔드 `py_compile` / 서버 기동(smoke) 확인
5. 정리 커밋까지 끝낸 뒤 main에 반영(squash 권장)

> 주의: `run-test.bat`·리프레시 배치는 8011 포트를 쓰는 프로세스를 강제 종료한다.
> 다른 프로그램이 8011을 쓰고 있으면 함께 종료되니 유의.
