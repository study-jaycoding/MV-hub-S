# MV Hub

Higgsfield CLI 기반 **로컬 우선(Local-first)** 콘텐츠 생성·관리·공유 툴.

> 상세 설계·개발 문서는 [`docs/`](docs/) 에 있습니다(개발자용). 아래 sparse-checkout 으로
> 받으면 `docs/` 는 다운로드되지 않습니다 — 실행에 필요한 코드만 받습니다.

## 처음 받기 (작업자용 — 문서 제외하고 코드만)

```sh
# docs/ 를 받지 않는 부분 체크아웃(blob 다운로드도 생략)
git clone --filter=blob:none --sparse https://github.com/study-jaycoding/MV-hub-S.git
cd MV-hub-S
git sparse-checkout set backend frontend
```

이러면 `backend/`·`frontend/`·루트 실행 파일만 받고, `docs/`·`deploy/` 는 제외됩니다.
나중에 문서까지 보려면: `git sparse-checkout add docs` (배포 설정은 `add deploy`).

> 일반 `git clone` 으로 받으면 `docs/` 까지 전부 받습니다 — 코드만 원하면 위 명령을 쓰세요.

## 실행

- **공유 서버**(팀의 단일 DB, 로그인 필요): `MV_server.bat` → http://localhost:8010
- **내 PC 허브 + 에이전트**(로컬 생성·push): `MV_agent.bat`

최초 1회는 자동으로 `npm install` + 프론트 빌드가 돌아 몇 분 걸립니다(이후엔 빠름).

## 업데이트

```sh
update_git.bat       # git pull --ff-only 후 바뀐 부분만 갱신 (sparse-checkout 유지됨)
update_cli.bat   # higgsfield CLI 업데이트(선택)
```

## 도커로 실행(선택)

루트의 `docker-compose.yml` 로 컨테이너 기동도 가능합니다(`docker compose up -d --build`).
단, 컨테이너엔 higgsfield CLI 가 없어 모델 목록/비용 엔드포인트는 동작하지 않습니다
(팀-뷰/공유 서버 용도엔 무방).

## 문서 (docs/ — 개발자용)

| 파일 | 내용 |
|------|------|
| [docs/README.md](docs/README.md) | 구현 현황·아키텍처·검증된 기술 노트 |
| [docs/DESIGN.md](docs/DESIGN.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 설계·구조 |
| [docs/CLAUDE.md](docs/CLAUDE.md) · [docs/AI_CONTEXT.md](docs/AI_CONTEXT.md) | AI 보조 개발 규칙·맥락 |
| [docs/SERVER.md](docs/SERVER.md) | 서버 운영 |
| docs/사용설명서.md · docs/기능설명서.md | 사용자·기능 설명 |
