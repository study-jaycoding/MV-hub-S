# Content Hub — 서버 운영 가이드

이 폴더(`content-hub-server`)는 **서버 배포용 클론**이다. 원본 `content-hub` 는 개인
작업용으로 그대로 두고, 서버화·추가기능은 여기서 진행한다.

## 핵심 구조 — 단일 오리진

개발 모드에선 프론트(Vite 5173) 와 백엔드(FastAPI 8000) 가 분리돼 Vite 가 `/api`·`/ws`·
`/media` 를 백엔드로 프록시했다. **서버 모드에선 백엔드가 빌드된 프론트(`frontend/dist`)
를 같은 오리진에서 직접 서빙**한다. 프론트는 이미 모든 호출을 상대경로(`/api`,
`ws://location.host/ws`, `/media`)로 하므로 — **이 폴더째 실서버에 올려도 코드 무변경으로
작동**한다. CORS 도 필요 없다(같은 오리진).

```
[브라우저] ──http──> [FastAPI :8000]
                       ├─ /            → frontend/dist/index.html (SPA)
                       ├─ /assets/*    → 빌드된 JS/CSS
                       ├─ /api/*        → REST
                       ├─ /ws           → 진행률 push (WebSocket)
                       └─ /media/*      → 로컬 미디어
```

## 실행

```bat
MV_server.bat
```

하는 일: ① 프론트 의존성 확인(최초 1회 `npm install`) → ② `npm run build`(dist 생성)
→ ③ 백엔드를 `0.0.0.0:8000` 으로 기동(빌드된 dist 서빙).

- 같은 PC:        http://localhost:8000
- 같은 네트워크:  http://<이 PC IP>:8000   (현재 개발 PC: http://192.168.1.38:8000)

포트/바인딩 변경: `set PORT=9000 & MV_server.bat`, 또는 환경변수
`CONTENT_HUB_PORT` / `CONTENT_HUB_HOST`.

## 설정 (모두 환경변수, 하드코딩 없음)

| 변수 | 기본값 | 용도 |
|------|--------|------|
| `CONTENT_HUB_HOST` | `0.0.0.0` | 바인딩 주소 |
| `CONTENT_HUB_PORT` | `8000` | 포트 |
| `CONTENT_HUB_DATA` | `backend/data` | DB·미디어·공유 루트 |
| `CONTENT_HUB_FRONTEND_DIST` | `frontend/dist` | 서빙할 빌드 산출물(없으면 API 전용) |
| `CONTENT_HUB_ASSETS_DIR` | `D:/ClaudeCode-data/projects` | Assets(구성) 패널 루트 |
| `CONTENT_HUB_WORKER_ID` / `_NAME` | `me` / `나` | 기본 작업자 |
| `CONTENT_HUB_BACKUP_DIR` | `<DATA>/backups` | DB 백업 보관 폴더(실서버: 다른 디스크/NAS 권장) |
| `CONTENT_HUB_BACKUP_INTERVAL` | `86400`(하루) | 백업 주기(초). 0 이하 = 비활성 |
| `CONTENT_HUB_BACKUP_KEEP` | `7` | 백업 보관 개수(회전) |
| `CONTENT_HUB_AUTH` | `0`(off) | 로그인 인증 enforcement. 1 이면 로그인 필수 |
| `CONTENT_HUB_AUTH_SECRET` | (자동생성) | 토큰 서명 시크릿. 미지정 시 DB에 1회 생성·영속 |

## 로그인/계정 승인 보안 (CONTENT_HUB_AUTH=1)

기본은 **off** — 개인 PC·개발에선 인증 없이 그대로 쓴다(로드맵: 식별 먼저, 차단은 켤 때).
팀 서버에서 접근을 막으려면 `set CONTENT_HUB_AUTH=1`.

켜면:
- 모든 `/api/*`(로그인·헬스 제외)가 **승인된 세션**을 요구(미들웨어가 매 요청 검증).
- **첫 가입 계정 = 관리자(C0)**, 이후 가입은 **승인 대기(pending)** → 관리자가 승인해야 로그인 가능.
- 관리자 작업(멤버 등급·계정 승인)은 **C0/C1 만**(2겹: 미들웨어 + 역할 검증).
- 비밀번호는 pbkdf2-sha256(솔트), 세션은 hmac 서명 토큰(stdlib, 새 의존성 0).
- 프론트: 미로그인 시 로그인/가입 화면이 앱 전체를 가리고, 관리자 창에 계정 승인 섹션이 뜬다.
- **보호 범위**: `/api/*`(인증·헬스 제외) + `/media/*` + `/ws`. 결과물 원본·실시간 채널까지 전부 차단.
  - 인증 전달: API 는 `Authorization: Bearer` 헤더, 미디어·WS 는 **httpOnly 세션 쿠키**(ch_session,
    헤더를 못 붙이는 img 태그·WebSocket 용). 로그인 시 토큰+쿠키 동시 발급, 로그아웃 시 둘 다 폐기.
  - 정적 SPA(로그인 화면)와 로그인·가입·헬스 엔드포인트는 공개(그래야 로그인 화면이 뜬다).

## DB 자동 백업

단일 SQLite 파일 손상·실수 삭제 대비. **SQLite 온라인 백업 API**로 일관 스냅샷을 뜬다
(WAL 모드에서 단순 파일복사는 위험 — `-wal` 미반영분 누락). 서버 시작 시 1회(최근 백업이
1시간 내면 생략) + 주기 실행, 최근 `BACKUP_KEEP` 개만 회전 보관.

- 수동 백업:   `POST /api/backup`
- 백업 목록:   `GET /api/backups`
- ⚠️ 실서버에선 `CONTENT_HUB_BACKUP_DIR` 를 **다른 디스크/NAS**로 — 같은 디스크면 동반 손실.

## 실서버 이전 체크리스트

1. 이 폴더 전체를 서버로 복사(`node_modules`·`dist`·`__pycache__` 제외 — 서버에서 재생성).
2. `pip install -r backend/requirements.txt`, Node 설치.
3. 데이터 경로를 서버 디스크에 맞춰 `CONTENT_HUB_DATA` 지정(권장: 영속 볼륨).
4. `MV_server.bat`(Windows) 또는 동등한 쉘에서
   `npm run build` → `python -m uvicorn app.main:app --host 0.0.0.0 --port 8000`.
5. 방화벽에서 해당 포트 인바운드 허용.
6. Higgsfield CLI 는 **각 사용자 개인 PC**에서 본인 계정으로 — 서버엔 토큰을 두지 않는다
   (로드맵 보안 원칙). 서버는 데이터 수집(`/sync`)·보관·서빙만 담당.

> ⚠️ Windows 에서 `--reload` 금지: 리로더가 SelectorEventLoop 을 강제해 CLI subprocess 가
> 깨진다(NotImplementedError). 코드 수정 후엔 프로세스를 직접 재기동.
