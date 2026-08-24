# MV Hub (MV-hub-S) — 프로젝트 지침

> 이 파일(클로드용)과 `AGENTS.md`(코덱스용)는 **본문이 같아야 한다. 한쪽만 고치지 말 것.**

Higgsfield CLI 기반 **로컬 우선(Local-first)** 콘텐츠 생성·관리·공유 툴.
백엔드 FastAPI + SQLite(WAL) · 프런트 React + Vite + TS · 작업자 PC 에이전트 `agent_push.py`(단일 파일·표준 라이브러리만).

## 문서 진입점

| 알고 싶은 것 | 볼 곳 |
|---|---|
| 지금 상태·다음 작업 | `docs/CURRENT_STATUS.md` (한 장 요약) |
| 날짜별 상세 기록 | `docs/status/` — 필요한 노트만 |
| 코드를 어디에 둘지 | 루트 `ARCHITECTURE.md` §1~3 |
| 동시성·상태 계약(새 코드 규칙) | 루트 `ARCHITECTURE.md` §6 |
| 실행 구조·데이터 흐름 | `docs/ARCHITECTURE.md`, `docs/AI_CONTEXT.md` |
| 주요 문서 색인·문서 위상 | `docs/README.md` |
| 위험 항목 상태의 단일 출처 | `docs/RISK_REDUCTION_PLAN_2026-08-15.md` `Gate 0` 표 |

현행 프로젝트 규칙은 **이 파일**이다. `docs/CLAUDE.md` 는 별개 문서이며 위상은 `docs/README.md` 분류표를 따른다.

## 실행

| 목적 | 명령 | 포트 |
|---|---|---|
| 팀 공유 서버(단일 DB) | `MV_server.bat` | 8010 (네트워크 공개) |
| 작업자 PC 로컬 허브 + 에이전트 | `MV_agent.bat` | 127.0.0.1:8010 |
| 격리 개발·테스트 | `test_dev.bat` | 백엔드 8012 / 프런트 5173 |

## 테스트

```powershell
# 백엔드 — backend 폴더에서
$env:CONTENT_HUB_NO_PROXY = '1'
& '<venv>\Scripts\python.exe' -m pytest -q -p no:cacheprovider

# 프런트 — frontend 폴더에서
npm.cmd test -- --run          # vitest
npm.cmd run lint:architecture  # 경계 검사
npm.cmd run build              # 타입체크 포함
```

venv 위치는 클론마다 다르다(이 클론은 저장소 루트 `.venv`). 최초 설정은 `docs/TESTING.md`.

## 안전선 (어기면 실사용에 피해)

- **실사용 공유 서버 `192.168.1.199:8010` 에 테스트·쓰기 금지.** 내 PC의 8010은 로컬 허브이니 혼동하지 말 것.
- **유료 호출 금지** — `higgsfield generate` 등 실제 크레딧 소모, Comfy Cloud 실제 실행. 계약 검증은 격리 HTTP 호환 서버로.
- **`D:\ClaudeCode\MV-hub-S` 는 실사용 트리다. 건드리지 않는다.** 작업은 `MV-hub-S-dev`에서.
- **`backend/data` 는 사용자 데이터다**(Git 제외). 직접 초기화·마이그레이션 금지. 수동 검증은 임시 `CONTENT_HUB_DATA`/`CONTENT_HUB_DB` 를 지정해서 한다.
- **`register_autostart.bat` · `restart_server_task.bat` 는 검증용으로 실행 금지.** 시스템 자동시작 작업(MVHub Server/Watchdog/BackupCopy)을 교체하고 서버를 즉시 시작한다.
- **`release/make_release*.ps1` · `update_release*.bat` 는 테스트 명령이 아니다.** `_staging` 재귀 삭제·프런트 재빌드·ZIP/`latest.json` 덮어쓰기, `release/publish_target.txt` 가 있으면 배포 폴더(NAS)에도 강제 복사한다. 명시적 배포 지시가 있을 때만.
- **DaVinci Resolve 를 임의로 끄지 않는다.** 열려 있는 사용자 프로젝트를 바꾸지 않는다.

## 브랜치·커밋

- 커밋은 **`dev` 에만**. 문서 변경과 코드 변경은 커밋을 분리한다.
- `main` 병합은 **Jay가 "병합"이라고 말할 때만**, 그리고 `RISK_REDUCTION_PLAN` 의 `Gate 6-A`(전체 테스트·빌드·아키텍처 검사, 깨끗한 작업 트리, DB 하위 호환) 를 확인한 뒤 `git push origin HEAD:main`.
- **여러 세션(클로드·코덱스)이 이 폴더에서 동시에 작업한다.** 수정 전 `git status --short` 를 확인하고, 다른 세션이 이미 고친 파일은 조율 없이 덮어쓰지 않는다.

## 함정

- Git 명령 전 `git rev-parse --show-toplevel` 로 **저장소 루트를 확인**한다. 셸의 현재 위치가 상위 폴더로 바뀌어 있을 수 있다.
- uvicorn **`--reload` 금지**: SelectorEventLoop 을 강제해 CLI 호출(asyncio subprocess)이 깨진다. 코드 변경 시 수동 재시작.
- CLI 버전 변경은 `docs/HF_CLI_UPGRADE.md` 절차를 따른다(스모크 없이 올리면 데이터가 조용히 깨진다).
