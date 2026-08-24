---
aliases:
  - MV Hub
  - MV-hub-S
tags:
  - mvhub
  - mvhub/진입점
updated: 2026-08-24
status: dev 기준선 안정 · main 병합 대기
---

# MV Hub

Higgsfield CLI 기반 **로컬 우선(Local-first)** 콘텐츠 생성·관리·공유 툴.

> [!NOTE]
> 읽는 순서: 이 문서(설치·실행) → [docs/CURRENT_STATUS.md](docs/CURRENT_STATUS.md)(지금 상태)
> → [docs/README.md](docs/README.md)(전체 문서 색인).
> 코드를 **어디에 둘지** 정할 때는 [ARCHITECTURE.md](ARCHITECTURE.md)가 기준이다.
>
> 기준선(2026-08-24): 자동 테스트 백엔드 1,773건 · 프런트 666건 통과. 최신 코드는 `dev`
> 브랜치에 있고 `main` 병합 전이다. 잔여 항목의 단일 출처는 `docs/CURRENT_STATUS.md`다.

## 처음 받기 (작업자용 — 문서 제외하고 코드만)

상세 설계·개발 문서는 [`docs/`](docs/) 에 있습니다(개발자용). 아래 sparse-checkout 으로
받으면 `docs/` 는 다운로드되지 않습니다 — 실행에 필요한 코드만 받습니다.

```sh
# docs/ 를 받지 않는 부분 체크아웃(blob 다운로드도 생략)
git clone --filter=blob:none --sparse https://github.com/study-jaycoding/MV-hub-S.git
cd MV-hub-S
git sparse-checkout set backend frontend tools
```

이러면 `backend/`·`frontend/`·루트 실행 파일만 받고, `docs/`·`deploy/` 는 제외됩니다.
나중에 문서까지 보려면: `git sparse-checkout add docs` (배포 설정은 `add deploy`).
`tools`는 서버 자동 시작·복구·백업과 개발 점검에 필요한 실행 파일이므로 기본으로 포함한다.

> [!NOTE]
> 일반 `git clone` 으로 받으면 `docs/` 까지 전부 받습니다 — 코드만 원하면 위 명령을 쓰세요.

## 실행

- **공유 서버**(팀의 단일 DB, 로그인 필요): `MV_server.bat` → http://localhost:8010
- **내 PC 허브 + 에이전트**(로컬 생성·push): `MV_agent.bat`
- **서버 PC 감시·로그**: `MV_watchdog.bat`(죽으면 자동 재시작) · `MV_logs.bat`(로그 열기)

최초 1회는 잠금 파일 기준 `npm ci` + 프론트 빌드가 돌아 몇 분 걸립니다. 이후 서버
부팅은 기존 빌드를 바로 사용하므로 인터넷 연결이나 npm 설치를 기다리지 않습니다.

## 업데이트

- **git 클론(서버 PC·개발)**:
  ```sh
  update_git.bat       # 변경분 설치·빌드. 등록된 공유 서버는 안전 재시작+ready 확인까지 수행
  update_cli.bat       # higgsfield CLI 를 hf_cli_version.txt 의 고정 버전으로 맞춤
  ```
- **릴리스 설치본(작업자 PC)**: 평소에는 앱 안 **설정 → 프로그램 업데이트** 버튼이 전부입니다
  (진행 중 생성이 없을 때만 안전하게 종료·교체·재시작). 수동으로는 `update_release.bat`.
  릴리스 제작·배포는 [release/README.md](release/README.md) 참고.

서버 PC는 최초 한 번 `register_autostart.bat`을 관리자 승인으로 실행합니다. 이후에는
`update_git.bat` 하나로 업데이트와 서버 재시작까지 처리하며, 서버 부팅 시에는 기존
프론트 빌드를 그대로 사용합니다. Python·Node 경로는 `.mvhub-runtime/`에 보관되어
로그 파일을 정리해도 자동시작 설정이 사라지지 않습니다.

> [!WARNING]
> **CLI 버전을 올릴 때**는 [docs/HF_CLI_UPGRADE.md](docs/HF_CLI_UPGRADE.md) 절차를 따르세요
> (pin 올림 → `python tools/hf_cli_contract_smoke.py` 로 계약 검증 → FAIL 고친 뒤 릴리스).
> CLI 는 필드/플래그를 조용히 바꾸므로 스모크 없이 올리면 데이터가 조용히 깨질 수 있습니다.

## 팀 운영에서 자주 쓰는 기능

| 기능 | 어떻게 동작하나 | 계약·절차 문서 |
|---|---|---|
| **Resolve로 보내기** | 고른 원본이 누를 때마다 **바로 접수**되고(앞 작업을 기다리지 않음), 전담 워커가 순서대로 DaVinci Resolve 미디어 풀에 넣는다. 앱을 껐다 켜도 큐가 남고, 중단된 반입은 사용자가 확인할 때까지 자동 재실행하지 않는다. | [docs/DESIGN_RESOLVE_QUEUE_V3_2026-08-24.md](docs/DESIGN_RESOLVE_QUEUE_V3_2026-08-24.md) |
| **공유 서버 이사** | 서버 PC·IP가 바뀌면 관리자가 관리자 창에서 **[팀에 공지]** 를 누른다. 작업자에게 알림이 뜨고 **알림을 한 번 누르면 새 주소로 전환**된다(옛 토큰은 그때 지워진다). | [docs/SERVER_RELOCATION.md](docs/SERVER_RELOCATION.md) |
| **프로그램 업데이트** | 설정 → 프로그램 업데이트. 진행 중 생성이 없을 때만 종료·교체·재시작한다. | [release/README.md](release/README.md) |

## 문서 (docs/ — 개발자용)

| 문서 | 내용 |
|------|------|
| [docs/README.md](docs/README.md) | **문서 색인** — 전체 문서 위상·갱신 규칙(전체 목록은 여기) |
| [docs/CURRENT_STATUS.md](docs/CURRENT_STATUS.md) | 현재 완료 항목·남은 위험·검증 상태 한눈에 보기 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | **구조 원칙** — 어디에 무슨 코드를 두는가(이 저장소의 규칙) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/AI_CONTEXT.md](docs/AI_CONTEXT.md) | 현행 구조 지도 · AI 에게 통째로 붙여넣는 자기완결 브리프 |
| [docs/RISK_REDUCTION_PLAN_2026-08-15.md](docs/RISK_REDUCTION_PLAN_2026-08-15.md) | 위험 항목 상태를 바꾸는 단일 출처(Gate 0 표) |
| [docs/DESIGN_RESOLVE_QUEUE_V3_2026-08-24.md](docs/DESIGN_RESOLVE_QUEUE_V3_2026-08-24.md) | Resolve 전송 큐 v3 — 상태 전이·중단 복구·잠금 계약 |
| [docs/SERVER_RELOCATION.md](docs/SERVER_RELOCATION.md) | 공유 서버 주소 이사 — 공지 발행·원클릭 전환·수동 대안 |
| [docs/TELEMETRY_DRAIN_LIFECYCLE.md](docs/TELEMETRY_DRAIN_LIFECYCLE.md) | 로컬 응답·관리 텔레메트리 전송·마지막 성공 관측 계약 |
| [docs/SHARE_STATE_COMPENSATION.md](docs/SHARE_STATE_COMPENSATION.md) | 공유 해제·최종 해제의 로컬/서버 일관성 계약 |
| [docs/DATA_OWNERSHIP.md](docs/DATA_OWNERSHIP.md) · [docs/WORKSPACE_DATA_CONTRACT.md](docs/WORKSPACE_DATA_CONTRACT.md) | 데이터 소유권·워크스페이스 계약 |
| [docs/신원과_모드_가이드.md](docs/신원과_모드_가이드.md) | 신원·실행 모드 기준 문서(문서 위상 표 포함) |
| [docs/SERVER.md](docs/SERVER.md) · [docs/SERVER_RECOVERY.md](docs/SERVER_RECOVERY.md) | 서버 운영·자동복구 |
| [docs/TESTING.md](docs/TESTING.md) · [docs/HF_CLI_UPGRADE.md](docs/HF_CLI_UPGRADE.md) | 테스트·검증 절차 · CLI 버전 올리는 절차 |
| [docs/OPT_PLAN12_2026-08-23.md](docs/OPT_PLAN12_2026-08-23.md) | 최적화 라운드 최종 장부 — 수렴 선언·잔여 백로그 판정 |
| [docs/DESIGN.md](docs/DESIGN.md) · [docs/PROJECT_CHARTER_LEGACY.md](docs/PROJECT_CHARTER_LEGACY.md) | 초기 설계·헌장 보존 기록 — 현행 구현 판단에 사용하지 않음 |
| docs/사용설명서.md · docs/기능설명서.md | 사용자·기능 설명 |

> [!IMPORTANT]
> 문서는 삭제하지 않고 **위상만 구분**한다. `설계`·`계획`·`감사`가 제목에 있어도 자동으로
> "지금 할 일"이나 "최신 보증"이 아니다. 판단 기준은 [docs/README.md](docs/README.md)의 위상 표를 따른다.
