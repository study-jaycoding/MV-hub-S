# MV Hub

Higgsfield CLI 기반 **로컬 우선(Local-first)** 콘텐츠 생성·관리·공유 툴.

> 상세 설계·개발 문서는 [`docs/`](docs/) 에 있습니다(개발자용). 아래 sparse-checkout 으로
> 받으면 `docs/` 는 다운로드되지 않습니다 — 실행에 필요한 코드만 받습니다.

## 처음 받기 (작업자용 — 문서 제외하고 코드만)

```sh
# docs/ 를 받지 않는 부분 체크아웃(blob 다운로드도 생략)
git clone --filter=blob:none --sparse https://github.com/study-jaycoding/MV-hub-S.git
cd MV-hub-S
git sparse-checkout set backend frontend tools
```

이러면 `backend/`·`frontend/`·루트 실행 파일만 받고, `docs/`·`deploy/` 는 제외됩니다.
나중에 문서까지 보려면: `git sparse-checkout add docs` (배포 설정은 `add deploy`).
`tools`는 서버 자동 시작·복구·백업과 개발 점검에 필요한 실행 파일이므로 기본으로 포함한다.

> 일반 `git clone` 으로 받으면 `docs/` 까지 전부 받습니다 — 코드만 원하면 위 명령을 쓰세요.

## 실행

- **공유 서버**(팀의 단일 DB, 로그인 필요): `MV_server.bat` → http://localhost:8010
- **내 PC 허브 + 에이전트**(로컬 생성·push): `MV_agent.bat`

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

> **CLI 버전을 올릴 때**는 [docs/HF_CLI_UPGRADE.md](docs/HF_CLI_UPGRADE.md) 절차를 따르세요
> (pin 올림 → `python tools/hf_cli_contract_smoke.py` 로 계약 검증 → FAIL 고친 뒤 릴리스).
> CLI 는 필드/플래그를 조용히 바꾸므로 스모크 없이 올리면 데이터가 조용히 깨질 수 있습니다.

## 문서 (docs/ — 개발자용)

| 파일 | 내용 |
|------|------|
| [docs/README.md](docs/README.md) | 구현 현황·아키텍처·검증된 기술 노트 |
| [docs/DESIGN.md](docs/DESIGN.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 설계·구조 |
| [docs/CLAUDE.md](docs/CLAUDE.md) · [docs/AI_CONTEXT.md](docs/AI_CONTEXT.md) | AI 보조 개발 규칙·맥락 |
| [docs/SERVER.md](docs/SERVER.md) · [docs/SERVER_RECOVERY.md](docs/SERVER_RECOVERY.md) | 서버 운영·자동복구 |
| [docs/TESTING.md](docs/TESTING.md) | 테스트·검증 절차 |
| [docs/DATA_OWNERSHIP.md](docs/DATA_OWNERSHIP.md) · [docs/WORKSPACE_DATA_CONTRACT.md](docs/WORKSPACE_DATA_CONTRACT.md) | 데이터 소유권·워크스페이스 계약 |
| [docs/신원과_모드_가이드.md](docs/신원과_모드_가이드.md) | 신원·실행 모드 기준 문서(문서 위상 표 포함) |
| docs/사용설명서.md · docs/기능설명서.md | 사용자·기능 설명 |
