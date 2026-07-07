# Content Hub

Higgsfield CLI 기반 **로컬 우선(Local-first)** 콘텐츠 생성·관리·공유 툴.
설계는 [DESIGN.md](DESIGN.md), 규칙은 [CLAUDE.md](CLAUDE.md) 참조.

## 구현 현황 (Phase 1~5)

| Phase | 내용 | 상태 |
|------|------|------|
| 1 | `schema.sql` + `db.py` — SQLite WAL 초기화 | ✅ |
| 2 | FastAPI 골격 + 라이브러리 조회 라우터(필터·검색·패싯) | ✅ |
| 3 | `cli_bridge.py`(검증된 CLI 매핑) + 잡 큐 + WebSocket 진행률 | ✅ |
| 4 | React UI — 썸네일 그리드(가상 스크롤)/필터/생성 모달/팀 작업 탭 | ✅ |
| 5 | publish/import + lineage — **로컬 SQLite 구현** | ✅ (원격 서버 보류) |

> **Phase 5 스코프 컷**: 원격 공유 서버(PostgreSQL + MinIO)는 의도적으로 보류했습니다.
> 발행→팀 작업 탭→가져오기→lineage 전체 루프는 로컬 단일 DB 에서 동작합니다.
> 원격 연동은 `routers/share.py`의 구현만 교체하면 되도록 `repo` 계층 뒤에 격리돼 있습니다.

## 실행

### 1) 백엔드 (FastAPI, 기본 8000)
```powershell
cd backend
pip install -r requirements.txt
python -m app.db init          # DB 초기화 (WAL) — 최초 1회, 멱등
uvicorn app.main:app          # http://127.0.0.1:8000
```

> ⚠️ **Windows 에서 `--reload` 를 붙이지 마세요.** uvicorn 리로더가 SelectorEventLoop 을
> 강제해 `higgsfield` CLI 호출(asyncio subprocess)이 `NotImplementedError` 로 깨집니다.
> Proactor 이벤트 루프가 필요하므로 `--reload` 없이 실행하고, 코드 변경 시 수동 재시작하세요.

### 2) 프론트엔드 (Vite + React, 5173)
```powershell
cd frontend
npm install
npm run dev                    # http://localhost:5173
```
> 백엔드 포트를 바꿨다면 `BACKEND=http://127.0.0.1:<port> npm run dev` 로 프록시 재지정.

### 3) 사용
1. 우측 상단 **↺ 동기화** — `higgsfield generate list` 의 실제 생성 이력을 로컬 DB 로 가져옵니다(멱등).
2. 썸네일 그리드에서 탐색 · 좌측 사이드바로 컬러/태그/작업자/상태 필터.
3. 카드 액션: ● 컬러 / # 태그 / ↻ 재생성 / ↗ 공유.
4. **팀 작업** 탭 → ⬇ 가져오기 = 내 워크스페이스로 복제 + lineage 기록.
5. **+ 새 생성** — 프롬프트·모델·레퍼런스 입력 → 잡 큐 등록 → WebSocket 진행률.
   ⚠️ 실제 Higgsfield 크레딧을 소모합니다.

## 아키텍처

```
backend/
  schema.sql              # 9개 엔티티 DDL (WAL/FK)
  app/
    db.py                 # 커넥션 팩토리(WAL+FK) / init_db / check
    config.py             # 경로·기본 작업자·CORS
    models.py             # Pydantic 요청·응답 (snake_case)
    repo.py               # 데이터 접근·직렬화 (라우터·잡·동기화 공유)
    services/
      cli_bridge.py       # higgsfield CLI asyncio 래퍼 (검증된 필드 매핑)
      jobs.py             # asyncio 잡 큐 + 백그라운드 워커
    ws.py                 # WebSocket 진행률 broadcast
    routers/
      library.py          # GET /generations, /facets
      generation.py       # POST /generations, /regenerate, 태그·컬러, /models
      share.py            # publish / import
      sync.py             # POST /sync (명시적, 자동 아님)
    main.py               # 앱 팩토리 (lifespan: init_db + seed + 큐 기동)
frontend/
  src/
    api.ts, types.ts      # 타입 안전 클라이언트 + WS
    App.tsx               # 상태·WS·액션 오케스트레이션
    components/           # TopBar, FilterSidebar, ThumbnailGrid, GenerationCard, GenerateModal
```

## 기술 노트 (검증됨)

- **WAL + FK**: WAL 은 DB 파일에 영속되지만 `foreign_keys` 는 커넥션마다 꺼진 채
  시작하므로 `db.py` 커넥션 팩토리에서 매번 `PRAGMA foreign_keys=ON` 을 적용한다.
  (CASCADE 동작 실측 확인)
- **Windows CLI 함정**: `higgsfield` 는 npm 셰임 `higgsfield.CMD`. PATH 이름이 아니라
  `shutil.which()` 절대경로로 실행해야 한다. subprocess 는 **Proactor 이벤트 루프**가
  필요하다 — `main.py` 가 import 시점에 Proactor 정책을 박아두지만, **uvicorn `--reload`
  는 SelectorEventLoop 을 강제해 여전히 깨진다**(`NotImplementedError`). 그래서 백엔드는
  `--reload` 없이 실행한다(실측 확인).
- **출처 영속화(byte-cache)**: 소스·결과물이 Higgsfield 원격 URL(계정 귀속·만료 가능)에만
  있으면 재사용이 깨진다. `⤓ 보관`(`/api/cache-all`) 이 바이트를 `media/` 로 내려받아
  `file_path` 를 `/media/..` 로 전환하고 원본 URL 은 `source_url` 에 보존한다. dedupe(sha1)·
  재동기 보존·내 생성물 자동 보관까지 적용(실측 확인).
- **CLI 필드 매핑**: `generate list --json` 실제 출력으로 검증(★CLI 1.x 대응, `docs/HF_CLI_UPGRADE.md`) —
  `id→PK`, `job_set_type|job_type→model`(1.x 개명, 폴백), `result_url`(확장자로 image/video),
  `created_at`(epoch 또는 1.x ISO문자열→파싱), `params.prompt`, `params.medias[]→reference`
  (1.x 도 출력 params 는 `medias` 유지). CLI 버전은 `hf_cli_version.txt` 로 pin.
- **진행률**: higgsfield 는 퍼센트가 아니라 상태 전이를 주므로 가짜 진행바 대신
  coarse 상태(pending/running/done/failed)를 WS 로 push.
```
