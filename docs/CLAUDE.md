# Content Hub — 프로젝트 헌법

이 파일은 Claude Code가 세션 시작 시 자동으로 읽는 프로젝트 규칙이다.
상세 설계는 @DESIGN.md 를 참조한다.

## 한 줄 정의
Higgsfield CLI로 이미지/영상을 생성하고, 생성에 쓰인 프롬프트·레퍼런스를 보존하며,
선택한 결과물만 팀과 공유해 재활용할 수 있게 하는 **로컬 우선(Local-first)** 콘텐츠 관리 툴.

## 기술 스택 (확정)
- 로컬 백엔드: FastAPI (async), Python 3.11+
- 로컬 DB: SQLite (WAL 모드)
- CLI 브리지: `asyncio` subprocess 로 `higgsfield` CLI 래핑
- 실시간: WebSocket (생성 진행률 / 공유 알림)
- 프론트엔드: Vite + React + react-window (썸네일 가상 스크롤)
- 공유 서버(2단계): FastAPI + PostgreSQL + MinIO(S3 호환)
- 패키지: 백엔드는 `uv` 또는 `pip`, 프론트는 `pnpm`

## 설계 원칙 (불변 규칙)
1. **개인 작업은 100% 로컬에서 즉시 처리한다.** 내 작업물 탐색은 네트워크를 절대 타지 않는다.
2. **공유는 명시적 발행(publish)으로만 일어난다.** 자동 동기화 금지.
3. **프롬프트와 레퍼런스는 원본 그대로 보존한다.** 재생성 시 그대로 복제해 재활용한다.
4. **재활용 계보는 lineage 테이블에 항상 기록한다.**
5. 코드는 모듈 단위로 작게, 유지보수 가능하게. 한 파일이 비대해지면 분리한다.
6. 파괴적 작업(파일 삭제, DB drop)은 먼저 사람에게 확인받는다.

## 데이터 엔티티 (요약, 상세는 DESIGN.md)
worker / generation / asset / reference / gen_reference / tag / gen_tag / share / lineage

## 디렉토리 구조 (목표)
```
content-hub/
  backend/
    app/
      main.py            # FastAPI 엔트리
      db.py              # SQLite 연결 (WAL)
      models.py          # 스키마 / Pydantic
      routers/           # generation, share, library
      services/
        cli_bridge.py    # higgsfield CLI 래퍼
        jobs.py          # 비동기 잡 큐
      ws.py              # WebSocket 진행률
    schema.sql
  frontend/
    src/
      components/        # ThumbnailGrid, FilterSidebar, GenerateModal
      api/
      App.tsx
  CLAUDE.md
  DESIGN.md
```

## 개발 순서 (Phase)
1. `schema.sql` + `db.py` — SQLite 초기화
2. FastAPI 골격 + 라이브러리 조회 라우터 (로컬 탐색)
3. `cli_bridge.py` + 잡 큐 + WebSocket 진행률 (생성)
4. React UI — 썸네일 그리드 / 필터 / 생성 모달
5. publish / import 엔드포인트 + 공유 서버 (PostgreSQL + MinIO)

## 컨벤션
- 주석·커밋 메시지는 한국어 OK. 코드 식별자는 영어.
- API 응답은 snake_case JSON.
- 모든 ID는 UUID 문자열(TEXT).

## 개발 명령
- 백엔드 실행: `cd backend && uvicorn app.main:app` (http://127.0.0.1:8000)
  - ⚠️ **Windows 에서 `--reload` 금지** — uvicorn 리로더가 SelectorEventLoop 을 강제해
    CLI 브리지(asyncio subprocess)가 `NotImplementedError` 로 깨진다. Proactor 가 필요하므로
    `--reload` 없이 실행하고, 코드 변경 시 수동 재시작한다.
- 프론트 실행: `cd frontend && npm run dev` (http://localhost:5173, pnpm 아님)
- DB 초기화: `cd backend && python -m app.db init` (WAL+FK, 멱등)
