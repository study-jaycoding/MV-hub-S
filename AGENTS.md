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
| dev 중심 개발·동시 작업 보호·임시 후보 검증 | `docs/WORKROOMS.md` |
| 기능 묶음 PR·수정 영향 재검토·최종 승인 기록 | `docs/PR_GATE.md` |
| 위험 항목 상태의 단일 출처 | `docs/RISK_REDUCTION_PLAN_2026-08-15.md` `Gate 0` 표 |

현행 프로젝트 규칙은 **이 파일**이다. 옛 헌장은 `docs/PROJECT_CHARTER_LEGACY.md` 에 과거 기록으로 보존돼 있다(현행 아님 — 그 안의 `lineage` 테이블·"자동 동기화 금지"·"모든 ID UUID" 는 지금과 다르다).

<!-- BEGIN MVHUB POLICY entry mvhub-vibe-2026-10-21-r1 -->
## 에이전트 운영

개발 운영 확장: `dev-centered-2026-10-27-r1` (updated: 2026-10-27). 최신 적용·보관 결과는 [작업 기록](docs/status/dev_workroom_cleanup_2026-10-27.md)을 따른다.

- 작업 시작 때 `docs/AGENT_WORKFLOW.md`를 읽는다. 사용자 공통 운영 `vibe-2026-10-21-r1`의 적용·설치 부재 처리, 역할 매핑과 모델 선택의 프로젝트 진입점이다.
- PR 운영 확장 `pr-review-2026-10-21-r1`: 새 기능 묶음·후보는 [PR 운영](docs/PR_GATE.md)에 따라 기존 적대적 리뷰 결과를 PR에 연결하고 수정 영향만 재검토한다. 진행 중 작업·고정 후보·세션은 강제 전환하지 않는다.
- 요청받은 Claude 또는 Codex 주 세션 한 명이 총괄한다. Claude 구조 설계·별도 화면 디자인, Codex 사전 검토·기본 구현, 비구현자 독립 리뷰·필요 검증, 뿌리 강의 설명 역할을 필요한 때만 호출한다.
- 담당 작업실·브랜치·변경 경로는 `docs/WORKROOMS.md`로 먼저 확인한다. 기본 개발 위치는 `D:\ClaudeCode\MV-hub-S-dev`의 `dev` 브랜치다. 상태·소유권을 확인하고 같은 파일을 동시에 쓰지 않는다. 위험 분리·독립 병렬 작업·깨끗한 고정 후보 검증이 필요할 때만 임시 작업실을 사용하고 보관·정리한다. 다른 세션을 이동·중단하거나 그 변경을 자동으로 가져오지 않는다.
- 평소에는 단일 구현자가 논리적 묶음별로 자기 검토·관련 시험을 한다. 구현 분할·묶음 리뷰·수정 후 영향 범위 확인은 운영안이 정본이다. 구조·공유 계약·DB·인증·동시성·배포·복구가 어려운 데이터 쓰기는 사전 설계 합의와 실사용 실행 전 독립 리뷰·필요 검증을 유지한다.
- 총괄이 호출마다 난도에 맞는 지원 모델·추론 수준을 선택하고 요청값·실제값을 구분한다. 역할은 호스트 권한을 상속하며 제품 수정 금지 등 역할 책임과 실제 도구 차단을 구분한다. 상위 제한과 아래 안전선은 유지한다.
- 단계 변경은 작업 폴더의 `.mvhub-board.txt`에 덧붙인다. 표시는 증거가 아니며, 실제 상대 응답·검증 근거 없이 합의·공동 완료로 기록하지 않는다. 역할/스킬/교차 호출의 적용과 검증 상태는 운영안을 따른다.
- 이 지침 쌍·역할/에이전트 설정·운영안·작업실·검증/배포 정책(보호 조항 포함)은 사용자 명시 요청·승인 범위에서만 바꾼다. 일반 코드 수정 승인을 정책 변경으로 넓히지 않는다.
- 안전·Git·작업실의 기반 정책은 `2026-10-15-r14`, 이 진입점과 운영안 확장은 `mvhub-vibe-2026-10-21-r1`다. 새 임시 작업실 사용 전 dev의 기반·운영·개발 운영 확장 버전과 내용을 대조한다. 하나라도 다르면 정합성 미확인으로 보고하며 다른 세션의 파일을 자동 덮어쓰지 않는다. 기존 세션 재로딩은 별도다.

<!-- END MVHUB POLICY entry -->

<!-- vibe-intent-guard:begin guard-2026-10-21-r1 -->
- 작업 의도·완료 조건·결정 이유·시험 근거는 기존 작업 기록 한 곳에 연결한다. `docs/AGENT_WORKFLOW.md`의 「작업 의도 검사」와 사용자 공통 검사기 안내를 따른다. 이번 정리 후 실제 훅 등록 대상은 dev만 유지하며(dev2 제거 결과는 작업 기록에서 확인), 기존 역할·작업실·배포 게이트와 승인 규칙은 유지한다.
<!-- vibe-intent-guard:end -->


## 실행

| 목적 | 명령 | 포트 |
|---|---|---|
| 팀 공유 서버(단일 DB) | `MV_server.bat` | 8010 (네트워크 공개) |
| 작업자 PC 로컬 허브 + 에이전트 | `MV_agent.bat` | 127.0.0.1:8010 |
| 로컬 실사용 개발(실제 생성 가능) | `test_dev.bat` | 백엔드 8012 / 프런트 5173 |

현재 dev의 `backend/data_test`는 사용자 실사용 데이터이며 폐기 가능한 격리 사본이 아니다.
위험 변경은 이 데이터로 실행하기 전에 독립 리뷰·필요 검증을 마친다. 사전 시험은 별도 격리 사본에서 한다.

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

<!-- BEGIN MVHUB POLICY safety-git 2026-10-15-r14 -->
## 안전선 (어기면 실사용에 피해)

- **실사용 공유 서버 `192.168.1.171:8010` 에 테스트·쓰기 금지.** 2026-10-02 이사 — 옛 서버 `192.168.1.199` 는 꺼 두었으니 켜지도 쓰지도 말 것. 내 PC의 8010은 로컬 허브이니 혼동하지 말 것.
- **에이전트의 임의 유료 시험 금지** — 자동 회귀·계약 검증은 격리 HTTP 호환 서버로 한다. dev 실사용 모드에서 실제 생성은 사용자 요청 범위로만 허용한다. 사용자가 앱에서 실행하거나 구체적으로 요청한 생성은 그 범위에서 허용하며, 이는 에이전트가 임의로 반복·대량 생성할 승인이 아니다. 운영 공유 서버 쓰기 금지는 유지한다.
- **실행 앱은 릴리스 설치본(이 PC: `C:\Users\FX-PC06\Desktop\MV-hub-S`)이다. 건드리지 않는다.** `D:\ClaudeCode\MV-hub-S` 는 2026-08-24 에 멈춘 옛 소스 트리라 근거로 쓰지 않고 건드리지도 않는다. 작업은 `MV-hub-S-dev`와 그 저장소의 승인된 별도 작업실에서 한다.
- **`backend/data` 는 사용자 데이터다**(Git 제외). 직접 초기화·마이그레이션 금지. 수동 검증은 임시 `CONTENT_HUB_DATA`/`CONTENT_HUB_DB` 를 지정해서 한다.
- **`register_autostart.bat` · `restart_server_task.bat` 는 검증용으로 실행 금지.** 시스템 자동시작 작업(MVHub Server/Watchdog/BackupCopy)을 교체하고 서버를 즉시 시작한다.
- **`release/make_release*.ps1` · `update_release*.bat` 는 테스트 명령이 아니다.** `_staging` 재귀 삭제·프런트 재빌드·패키지 제작/설치를 수행하며, `release/publish_target.txt`가 있으면 NAS에 ZIP·`candidate.json`을 게시한다. 팀 공개(`latest.json`)는 별도 관리자 배포 단계다. 명시적 배포 지시가 있을 때만.
- **배포판은 반드시 고정 폴더 `D:\ClaudeCode\MV-hub-S-release`에서 만든다.** 배포 전에 원격을 갱신하고 이 폴더의 `HEAD`를 `origin/main`과 정확히 일치시킨 뒤, 작업 트리가 깨끗한지 확인하고 이 폴더 안의 릴리스 스크립트만 실행한다. `MV-hub-S-dev`나 임시 worktree에서 배포판을 만들지 않는다. 고정 폴더에 미커밋 변경이 있거나 안전하게 `origin/main`으로 맞출 수 없으면 배포를 중단하고 보고한다.
- **DaVinci Resolve 를 임의로 끄지 않는다.** 열려 있는 사용자 프로젝트를 바꾸지 않는다.

## 브랜치·커밋

- 커밋은 `dev` 또는 사용자가 승인한 기능 작업실의 브랜치에 한다(새 브랜치 기본 접두사 `codex/`). 문서 변경과 코드 변경은 커밋을 분리한다. 다른 작업자의 브랜치는 조율 없이 수정하지 않는다.
- **기본 개발은 dev에서, 배포 선택은 변경 묶음별로 한다.** 상시 통합 브랜치 `codex/mvhub-integration`로 매번 병합하는 의무는 종료했다(Jay 2026-10-27). 구현·관련 확인과 필요한 독립 리뷰를 마친 변경 중 Jay가 선택한 범위와 승인된 의존성만 후보 PR로 준비한다. dev의 미커밋 변경 전체를 자동으로 main에 반영하거나 자동 배포하지 않는다. 깨끗한 고정 후보가 필요하면 검토된 임시 작업실을 사용한다. 상세 운영은 [작업실 운영](docs/WORKROOMS.md)을 따른다.
- `main` 병합은 **Jay가 "병합"이라고 말할 때만** 한다. 선택한 변경과 승인된 선행 의존성만 포함한 후보 SHA로 `RISK_REDUCTION_PLAN`의 `Gate 6-A`를 통과해야 한다. 현재 폴더의 `HEAD`를 그대로 보내지 않으며, PR에 기록한 검토·검증 대상과 사용자 승인 후보가 같은지 확인하고 검증한 후보만 fast-forward로 반영한다. PR 생성·AI 리뷰 통과는 병합·배포 승인이 아니며 GitHub 자동 병합은 켜지 않는다. 원격 기준이 바뀌면 후보·검증 영향을 다시 확인하고 강제 푸시는 하지 않는다.
- **여러 세션(클로드·코덱스)이 이 폴더에서 동시에 작업한다.** 수정 전 `git status --short` 를 확인하고, 다른 세션이 이미 고친 파일은 조율 없이 덮어쓰지 않는다.
<!-- END MVHUB POLICY safety-git -->

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

<!-- BEGIN MVHUB POLICY completion 2026-10-15-r14 -->
## 작업 마무리 점검 (파일을 고친 작업)

완료 보고를 쓰기 **전에** 스스로 돌리고, 결과를 보고의 "검증 방법과 결과"에 한 줄로 적는다. 사용자가 물어봐야
최신이 되는 상태로 두지 않는다(2026-09-19 실제로 그랬다 — 자동으로 최신이 되는 것은 생성 목록뿐이다).

1. 소스를 바꿨거나 사용할 색인이 낡았으면 `powershell -NoProfile -File tools\graft.ps1 build` → `check` 가 "in sync"인지 확인한다(graft 설치 환경만). 문서·역할 지침만 바꿨으면 코드 색인 재빌드는 생략한다. `graft/`는 커밋하지 않는다.
2. 내용을 고친 문서의 프런트매터 `updated` 가 오늘 날짜인지 — `git diff --name-only` 로 고친 문서를 뽑아 본다(린트는 이 값을 검사하지 않는다)
3. `python tools/check_code_map.py` — 파일을 더하거나 옮겼으면 "문서에 없는 것 0"
4. `python tools/gen_inventory.py --check` — 엔드포인트·환경변수·DB 테이블·백그라운드 작업을 건드렸으면 필수(낡으면 전체 시험도 실패한다)

볼트(`D:\vault`) 기록은 전역 지침의 공동 판단 상시 승인 범위를 따른다. 두 모델이 합의한 재사용 지식은 기록하고, 미합의 후보는 사유와 함께 보고한다.

지침·역할·설정을 커밋할 때 로컬 훅은 stage된 내용의 일관성만 확인한다. 훅 통과는 사용자 승인·독립 리뷰·배포 검증을 대신하지 않는다. 설치·범위·한계는 운영안의 로컬 검사 절을 따른다.
<!-- END MVHUB POLICY completion -->

## 함정

- Git 명령 전 `git rev-parse --show-toplevel` 로 **저장소 루트를 확인**한다. 셸의 현재 위치가 상위 폴더로 바뀌어 있을 수 있다.
- uvicorn **`--reload` 금지**: SelectorEventLoop 을 강제해 CLI 호출(asyncio subprocess)이 깨진다. 코드 변경 시 수동 재시작.
- CLI 버전 변경은 `docs/HF_CLI_UPGRADE.md` 절차를 따른다(스모크 없이 올리면 데이터가 조용히 깨진다).
