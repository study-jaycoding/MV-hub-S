# MV Hub 100명 서비스 배포 점검

> **시점 고정 검증 기록**: 이 문서는 2026-07-31 당시 코드와 격리 환경의 결과를 보존한다.
> 현재 배포 가능 여부와 최신 테스트 숫자는 [CURRENT_STATUS.md](CURRENT_STATUS.md)를 따른다.
> 코드·CLI·운영 환경이 바뀐 뒤 이 결과를 새 배포의 자동 보증으로 사용하지 않는다.

## 현재 결론

2026-07-31 기준, 격리된 Windows 로컬 환경에서 100개 계정·100개 WebSocket·100개 에이전트
롱폴을 동시에 연결하고 API 읽기·쓰기·미디어 요청을 섞은 30초 부하를 같은 서버에 2회 연속
실행했다. 자동 통과 기준을 모두 만족했다.

| 항목 | 실제 결과 | 기준 |
|---|---:|---:|
| 2회차 처리량 | 5,715건 / 30초, 186.24 RPS | 참고값 |
| 워크로드 p95 / p99 | 61.58ms / 239.82ms | p95 500ms 이하 |
| HTTP 오류 | 0건 | 0건 |
| SQLite 잠금 | 0건 | 0건 |
| WebSocket / 에이전트 롱폴 | 100 / 100 | 100 / 90 이상 |
| 1회차 종료 RSS | 202.88MiB | 워밍업 기준 |
| 2회차 종료 RSS | 224.00MiB | 증가 20% 이하 |
| 안정화 후 RSS 증가 | 10.41% | 20% 이하 |
| 부하 중 RSS | 256.80MiB | 서버 여유 메모리로 판단 |
| 프로세스 CPU | 한 코어 기준 92.55% | 지속 85% 이상이면 주의 |

이 테스트는 실제 작업 패턴보다 공격적인 약 186 RPS를 발생시켰다. 현재 100명 목표에서는 DB 구조나
캐시를 추가로 바꿀 근거가 없다. 다만 단일 서버 프로세스의 한 코어가 약 200 RPS 부근에서 포화될
가능성이 있으므로, 운영에서 p95가 계속 500ms를 넘으면 미디어 분리 서빙 또는 서버 프로세스 확장을
그때 검토한다. SQLite를 PostgreSQL로 바꾸는 작업은 현재 범위에 포함하지 않는다.

## 자동 배포 게이트

커밋된 깨끗한 작업 트리에서 실행한다. 백엔드 테스트, 프론트 테스트와 production build, 운영 DB의
온라인 백업·비파괴 복원 훈련, 격리 100명 부하를 순서대로 실행한다. 현재 게이트의 기본 부하 조건은
논리 CPU 2개·`below-normal` 우선순위·60초·2회이며 결과 JSON에도 적용값이 기록된다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\predeploy_gate.ps1
```

빠른 로컬 재검증에서만 부하를 생략할 수 있다. 실제 배포 승인에는 `-SkipLoad` 결과를 사용하지 않는다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\predeploy_gate.ps1 -SkipLoad
```

결과는 `predeploy-reports\predeploy-latest.json`과 부하 JSON에 저장되며 Git에는 포함하지 않는다.

## 단계적 배포 순서

1. 배포 직전 운영 DB 백업을 만들고 `verify_backup_restore.py --backup <백업경로>`로 복원 검증한다.
2. `make_release.ps1 -SkipPublish`로 로컬 패키지를 만든다. ZIP의 SHA256과 실행 여부를 확인한 뒤에만
   공유 `packages` 폴더로 ZIP을 먼저 복사하고 `latest.json`을 마지막에 복사한다.
3. 서버를 먼저 업데이트하고 `/api/ready`가 `ready=true`인지 확인한다.
4. 내부 관리자 5명에게 배포하고 30분 관찰한다.
5. 이상이 없으면 20명, 50명, 100명 순서로 확대하며 각 단계마다 최소 30분 관찰한다.
6. 각 단계에서 로그인, 생성물 목록·상세, 태그/색상 쓰기, 공유, SceneBoard 저장·undo, 에이전트
   연결과 생성 요청을 실제 브라우저에서 확인한다.
7. 전체 배포 후 운영 사양 스테이징 PC에서 8시간 지속 부하를 실행하고 다음 근무일까지 로그를 관찰한다.

## 단계 중단 기준

다음 중 하나라도 발생하면 다음 인원 단계로 넘어가지 않는다.

- 5xx 또는 예기치 않은 4xx가 반복됨
- `sqlite_locked_total`이 증가함
- 일반 API p95가 5분 연속 500ms 초과
- RSS가 워밍업 고수위보다 20% 이상 계속 증가
- 저사양 기준 시험에서 서버 RSS가 정한 절대 상한을 한 번이라도 초과
- 디스크 여유가 20% 미만
- 주기 측정 중 WebSocket 100개 또는 에이전트 연결 계정이 목표 인원의 90% 미만
- 권한 밖 프로젝트·개인 메타데이터가 보이는 데이터 격리 문제

관리자는 `/api/admin/runtime`에서 요청 지연, SQLite 잠금, 메모리, CPU, 연결 수와 디스크를 확인한다.
서버 로그는 JSON 회전 로그이며 기본 위치와 보존 설정은 `docs\SERVER.md`를 따른다.

## 롤백

서버 코드 배포 전 기준은 Git 태그 `predeploy-baseline-defda2d`이다. 서버 장애 시 현재 DB와 로그를 먼저
보존하고 이 태그 또는 직전 정상 릴리즈로 서버를 되돌린다. DB 스키마를 되돌려야 하는 경우에는 운영 DB를
직접 덮어쓰지 말고, 검증된 백업을 새 파일로 복원한 뒤 점검 후 경로를 전환한다.

작업자 패키지는 공유폴더에 남아 있는 직전 정상 ZIP을 선택한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File release\select_release.ps1 `
  -PackagePath Z:\mvutil\MV_hub_S\packages\MVHub-<직전정상버전>.zip
```

이 도구는 기존 `latest.json`을 `latest.previous-날짜.json`으로 보관하고, 선택한 ZIP 내부의
`VERSION.txt`, 크기, SHA256으로 새 `latest.json`을 만든다. 이후 작업자가 `update_release.bat`를
실행하면 이전 버전으로도 정상 전환된다.

## 아직 필요한 실제 운영 검증

자동 부하는 API와 연결 안정성을 검증하지만 GPU/Houdini/ComfyUI, 실제 대용량 영상, 사내 네트워크 속도,
사용자 브라우저의 SceneBoard 렌더링 비용까지 재현하지 않는다. 이 항목은 위 5→20→50→100명 단계에서
확인한다. `rearch/mv-hub-v`에서 SceneBoard 저장/undo와 Comfy 실행 훅 분리는 완료했지만,
실제 Comfy 실행 중 씬 전환·배치 결과 순서·브라우저 undo는 위 단계적 배포에서 반드시 다시 확인한다.
키보드/paste/drop과 포인터/드래그의 추가 분리는 이 운영 검증과 8시간 지속 테스트가 안정된 뒤 진행한다.
