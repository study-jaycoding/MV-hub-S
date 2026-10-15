# MV Hub (MV-hub-S) — 프로젝트 지침

> 이 파일(코덱스용)과 `CLAUDE.md`(클로드용)는 **본문이 같아야 한다. 한쪽만 고치지 말 것.**

Higgsfield CLI 기반 **로컬 우선(Local-first)** 콘텐츠 생성·관리·공유 툴.
백엔드 FastAPI + SQLite(WAL) · 프런트 React + Vite + TS · 작업자 PC 에이전트 `agent_push.py`(단일 파일·표준 라이브러리만).

## 문서 진입점

| 알고 싶은 것 | 볼 곳 |
|---|---|
| 지금 상태·다음 작업 | `docs/CURRENT_STATUS.md` (한 장 요약) |
| 날짜별 상세 기록 | `docs/status/` — 필요한 노트만 |
| 코드를 어디에 둘지 | 루트 `ARCHITECTURE.md` §1~3 |
| 무엇을 고치려면 어느 파일을 여나 · 합치면 안 되는 중복 · 지우면 안 되는 휴면 코드 | `docs/CODE_MAP.md` (§1 빠른 찾기 · §5 함정 지도) |
| 동시성·상태 계약(새 코드 규칙) | 루트 `ARCHITECTURE.md` §6 |
| 실행 구조·데이터 흐름 | `docs/ARCHITECTURE.md`, `docs/AI_CONTEXT.md` |
| 주요 문서 색인·문서 위상 | `docs/README.md` |
| 에이전트 역할 호출·설계 합의·독립 리뷰·완료 기준 | `docs/AGENT_WORKFLOW.md` |
| 작업실 선택·동시 작업 보호·통합 시험실 반영 | `docs/WORKROOMS.md` |
| 위험 항목 상태의 단일 출처 | `docs/RISK_REDUCTION_PLAN_2026-08-15.md` `Gate 0` 표 |

현행 프로젝트 규칙은 **이 파일**이다. 옛 헌장은 `docs/PROJECT_CHARTER_LEGACY.md` 에 과거 기록으로 보존돼 있다(현행 아님 — 그 안의 `lineage` 테이블·"자동 동기화 금지"·"모든 ID UUID" 는 지금과 다르다).

## 에이전트 운영

- 작업 시작 때 `docs/AGENT_WORKFLOW.md`로 규모와 필요한 역할을 정한다. 역할은 필요할 때 호출하며 상주시킬 필요가 없다.
- Claude·Codex 어느 쪽에서 요청받아도 `docs/WORKROOMS.md`에 따라 담당 작업실·브랜치·변경 경로를 먼저 확인한다. 새 기능·개선은 별도 기능 작업실을 기본으로 하며, 같은 작업의 기존 작업실을 우선 재사용한다. 진행 중인 다른 세션을 이동·중단하거나 그 변경을 자동으로 가져오지 않는다.
- 모델·추론 수준·상향 조건은 운영안의 모델 배치를 따른다. 요청한 모델과 실제 실행 모델을 대조하며, 사용할 수 없으면 임의로 낮추지 않고 보고한다.
- 중요한 작업은 Claude 설계 → Codex 사전 검토·합의 → Codex 구현 → 별도 Claude 독립 리뷰·필요한 실측 → 두 모델의 근거 대조로 마감한다. 실제 상대 응답 없이 합의로 기록하지 않는다.
- 작은 문구·서식 수정은 한 담당자가 끝낼 수 있다. 독립적인 작업을 나눌 때는 담당 경로를 분리하고 통합 담당을 한 명 정한다.
- 단계를 넘어갈 때마다 그 작업 폴더의 `.mvhub-board.txt` 에 한 줄을 덧붙인다(Jay 의 작업 흐름 판이 읽는다 — 형식은 운영안의 '작업판 기록'). 표시용이며 완료·검증의 증거가 아니다.
- 리뷰어는 제품 파일을 쓰지 않는다. 역할 프롬프트와 실제 도구 권한은 다르며, 설정 파일을 만들었다는 이유만으로 격리·자동 호출이 검증됐다고 하지 않는다.
- 역할 정의·호출 경로·스킬 적용 조건·검증 상태는 운영 문서에서 확인한다. Ponytail·graft는 그 적용 조건에 따라 먼저 활용한다. 필수 검증이 미확인·보류이면 전체 완료로 선언하지 않는다.

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

- **실사용 공유 서버 `192.168.1.171:8010` 에 테스트·쓰기 금지.** 2026-10-02 이사 — 옛 서버 `192.168.1.199` 는 꺼 두었으니 켜지도 쓰지도 말 것. 내 PC의 8010은 로컬 허브이니 혼동하지 말 것.
- **유료 호출 금지** — `higgsfield generate` 등 실제 크레딧 소모, Comfy Cloud 실제 실행. 계약 검증은 격리 HTTP 호환 서버로.
- **실행 앱은 릴리스 설치본(이 PC: `C:\Users\FX-PC06\Desktop\MV-hub-S`)이다. 건드리지 않는다.** `D:\ClaudeCode\MV-hub-S` 는 2026-08-24 에 멈춘 옛 소스 트리라 근거로 쓰지 않고 건드리지도 않는다. 작업은 `MV-hub-S-dev`와 그 저장소의 승인된 별도 작업실에서 한다.
- **`backend/data` 는 사용자 데이터다**(Git 제외). 직접 초기화·마이그레이션 금지. 수동 검증은 임시 `CONTENT_HUB_DATA`/`CONTENT_HUB_DB` 를 지정해서 한다.
- **`register_autostart.bat` · `restart_server_task.bat` 는 검증용으로 실행 금지.** 시스템 자동시작 작업(MVHub Server/Watchdog/BackupCopy)을 교체하고 서버를 즉시 시작한다.
- **`release/make_release*.ps1` · `update_release*.bat` 는 테스트 명령이 아니다.** `_staging` 재귀 삭제·프런트 재빌드·패키지 제작/설치를 수행하며, `release/publish_target.txt`가 있으면 NAS에 ZIP·`candidate.json`을 게시한다. 팀 공개(`latest.json`)는 별도 관리자 배포 단계다. 명시적 배포 지시가 있을 때만.
- **배포판은 반드시 고정 폴더 `D:\ClaudeCode\MV-hub-S-release`에서 만든다.** 배포 전에 원격을 갱신하고 이 폴더의 `HEAD`를 `origin/main`과 정확히 일치시킨 뒤, 작업 트리가 깨끗한지 확인하고 이 폴더 안의 릴리스 스크립트만 실행한다. `MV-hub-S-dev`나 임시 worktree에서 배포판을 만들지 않는다. 고정 폴더에 미커밋 변경이 있거나 안전하게 `origin/main`으로 맞출 수 없으면 배포를 중단하고 보고한다.
- **DaVinci Resolve 를 임의로 끄지 않는다.** 열려 있는 사용자 프로젝트를 바꾸지 않는다.

## 브랜치·커밋

- 커밋은 `dev` 또는 사용자가 승인한 기능 작업실의 브랜치에 한다(새 브랜치 기본 접두사 `codex/`). 문서 변경과 코드 변경은 커밋을 분리한다. 다른 작업자의 브랜치는 조율 없이 수정하지 않는다.
- 기능 작업실 → 통합 시험실 → `dev` 순서로 검증한다. 통합 시험실은 선택한 변경의 고정 사본이며 자동 병합·배포 경로가 아니다. `dev` 반영도 사용자 승인 범위의 검증된 변경만 대상으로 한다. 상세 운영은 [작업실 운영](docs/WORKROOMS.md)을 따른다.
- `main` 병합은 **Jay가 "병합"이라고 말할 때만**, 그리고 `RISK_REDUCTION_PLAN` 의 `Gate 6-A`(전체 테스트·빌드·아키텍처 검사, 깨끗한 작업 트리, DB 하위 호환) 를 확인한 뒤 `git push origin HEAD:main`.
- **여러 세션(클로드·코덱스)이 이 폴더에서 동시에 작업한다.** 수정 전 `git status --short` 를 확인하고, 다른 세션이 이미 고친 파일은 조율 없이 덮어쓰지 않는다.

## 노트·문서 도구

- 옵시디언 문법(위키링크·콜아웃·프로퍼티)은 `obsidian-markdown` 스킬을 따른다. 볼트 조작은
  `obsidian-cli`, `.base` 는 `obsidian-bases`, `.canvas` 는 `json-canvas` 스킬.
- URL 본문을 읽을 때는 WebFetch 대신 `defuddle` 스킬을 쓴다.
- 저장소 md 의 링크는 **표준 상대경로**로 쓴다(옵시디언 그래프·GitHub 양쪽에서 동작).
  콜아웃은 양쪽이 지원하는 5종(NOTE·TIP·IMPORTANT·WARNING·CAUTION)만, 커스텀 제목 없이.

## 코드 탐색 도구 (graft)

- **항상 래퍼로 부른다**: `powershell -NoProfile -File tools\graft.ps1 <명령>`. 직접 부르면
  편집기가 심어 둔 `ELECTRON_RUN_AS_NODE` 때문에 죽고, `build` 가 `.gitignore` 와 `.ignore` 를
  멋대로 고친다. 설치 함정과 이유는 래퍼 머리말에 있다. **`init` 금지** — `AGENTS.md` 를 덮는다.
- 쓰는 것: `callers <심볼>`(부르는 곳) · `grep "<정규식>"`(정의·참조와 in-edges) ·
  `blast --base <ref>`(변경의 영향 범위와 **시험이 닿는 비율**) · `skeleton <파일>`(API 표면).
- **보조 색인이지 근거가 아니다.** 중요한 결론은 해당 소스와 시험을 열어 확인한다. `ask` 의
  자연어 결과는 후보일 뿐 답으로 인용하지 않는다(키 없이는 키워드 순위기다 — 실측에서 틀렸다).
- `graft/` 는 재생성되는 로컬 캐시다(git 무시, 재빌드 2~3초). 배포 게이트·`lint:docs`·제품 실행
  경로에 **연결하지 않는다.** 팀원 필수 설치도 아니다.

## 작업 마무리 점검 (파일을 고친 작업)

완료 보고를 쓰기 **전에** 스스로 돌리고, 결과를 보고의 "검증 방법과 결과"에 한 줄로 적는다. 사용자가 물어봐야
최신이 되는 상태로 두지 않는다(2026-09-19 실제로 그랬다 — 자동으로 최신이 되는 것은 생성 목록뿐이다).

1. `powershell -NoProfile -File tools\graft.ps1 build` → `check` 가 "in sync" (graft 를 설치한 환경만. `graft/` 는 커밋하지 않는다)
2. 내용을 고친 문서의 프런트매터 `updated` 가 오늘 날짜인지 — `git diff --name-only` 로 고친 문서를 뽑아 본다(린트는 이 값을 검사하지 않는다)
3. `python tools/check_code_map.py` — 파일을 더하거나 옮겼으면 "문서에 없는 것 0"
4. `python tools/gen_inventory.py --check` — 엔드포인트·환경변수·DB 테이블·백그라운드 작업을 건드렸으면 필수(낡으면 전체 시험도 실패한다)

볼트(`D:\vault`) 기록은 전역 지침의 공동 판단 상시 승인 범위를 따른다. 두 모델이 합의한 재사용 지식은 기록하고, 미합의 후보는 사유와 함께 보고한다.

## 함정

- Git 명령 전 `git rev-parse --show-toplevel` 로 **저장소 루트를 확인**한다. 셸의 현재 위치가 상위 폴더로 바뀌어 있을 수 있다.
- uvicorn **`--reload` 금지**: SelectorEventLoop 을 강제해 CLI 호출(asyncio subprocess)이 깨진다. 코드 변경 시 수동 재시작.
- CLI 버전 변경은 `docs/HF_CLI_UPGRADE.md` 절차를 따른다(스모크 없이 올리면 데이터가 조용히 깨진다).
