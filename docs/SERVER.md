---
updated: 2026-08-25
status: active
---

# Content Hub — 서버 운영 가이드

이 저장소(`MV-hub-S`)를 **서버 PC에 git 클론**해 공유 서버로 운영한다. 작업자 PC는
릴리스 설치본(`release/README.md`)을 쓰고, 서버는 이 클론에서 `update_git.bat` 으로
업데이트한다.

## 핵심 구조 — 단일 오리진

개발 모드에선 프론트(Vite 5173) 와 백엔드(FastAPI 8000) 가 분리돼 Vite 가 `/api`·`/ws`·
`/media` 를 백엔드로 프록시했다. **서버 모드에선 백엔드가 빌드된 프론트(`frontend/dist`)
를 같은 오리진에서 직접 서빙**한다. 프론트는 이미 모든 호출을 상대경로(`/api`,
`ws://location.host/ws`, `/media`)로 하므로 — **이 폴더째 실서버에 올려도 코드 무변경으로
작동**한다. CORS 도 필요 없다(같은 오리진).

```
[브라우저] ──http──> [FastAPI :8010]
                       ├─ /            → frontend/dist/index.html (SPA)
                       ├─ /assets/*    → 빌드된 JS/CSS
                       ├─ /api/*        → REST
                       ├─ /ws           → 진행률 push (WebSocket)
                       └─ /media/*      → 로컬 미디어
```

## 업데이트(롤아웃) 순서 — ★생성 fence 후 공유 서버 먼저

경로가 둘이다: **서버 = git 클론에서 `update_git.bat`**, **작업자 = 릴리스 ZIP 배포 후
앱 안 "설정 → 프로그램 업데이트" 버튼**(수동은 `update_release.bat`). 릴리스 제작·게시는
`release/README.md` 참고.

혼합 버전에서 구 에이전트가 이미 받은 유료 생성 요청을 나중에 실행하는 창을 닫기 위해 다음 순서를
반드시 지킨다. 관리자 API 호출에는 로그인으로 받은 관리자 Bearer 토큰을
`$env:MVHUB_ADMIN_TOKEN`에 넣어 둔다(토큰을 문서나 명령 기록에 직접 붙여 넣지 않는다).

1. 생성 접수·claim 일시중지:

   ```powershell
   Invoke-RestMethod -Method Put -Uri "http://localhost:8010/api/gen-requests/deployment-pause" -Headers @{Authorization="Bearer $env:MVHUB_ADMIN_TOKEN"} -ContentType "application/json" -Body '{"paused":true}'
   ```

2. 서버 PC의 저장소 루트에서 아래 **한 줄**을 한 번 실행하고 종료 코드 `0`과 `[통과]`를 확인:

   ```powershell
   py -3 tools\deploy_fence_check.py
   ```

   기본 위치가 아닌 DB는 `--db "D:\실제경로\content_hub.db"`를 붙인다. 검사는 DB를 읽기 전용으로
   열며, 다음 중 하나라도 만족하지 않으면 배포를 막는 종료 코드 `2`를 반환한다.

   - DB의 `generation_deployment_paused` 스위치가 ON
   - `gen_request.status`가 `done/failed/canceled`가 아닌 행이 0건. 알려지지 않은 새 상태도 안전하게 미종결로 센다.
   - `generation.status`가 `pending/running`인 행이 0건. 요청표와 연결되지 않은 placeholder,
     동기화본, provider 진행 흔적도 빠뜨리지 않고 보수적으로 센다.

   DB 파일·스키마를 읽지 못하면 종료 코드 `3`이다. `2`나 `3`을 무시하고 업데이트하지 않는다.
   일시중지 전에 이미 시작된 `anchor/fulfill/reconcile/fail` 보고는 계속 받아 자연히 종결되지만,
   남은 `pending/blocked/recovery_required`는 자동으로 숨기지 않으므로 원인을 확인해 명시적으로
   종결한 뒤 fence를 다시 실행한다.

3. `update_git.bat`으로 **공유 서버를 먼저** 배포하고 `/api/ready` 200을 확인한다.
4. `release/README.md` 절차로 모든 작업자 PC의 허브·에이전트를 새 릴리스로 전환한다.
5. 생성 접수 재개:

   ```powershell
   Invoke-RestMethod -Method Put -Uri "http://localhost:8010/api/gen-requests/deployment-pause" -Headers @{Authorization="Bearer $env:MVHUB_ADMIN_TOKEN"} -ContentType "application/json" -Body '{"paused":false}'
   ```

스위치는 `app_setting`에 영속되므로 서버 재시작·롤백 뒤에도 자동으로 풀리지 않는다. 에이전트 전환과
준비 상태 확인이 끝난 뒤 반드시 5단계를 실행한다. 새 허브의 배치 쓰기(작업 순서/삭제/담당해제·팀
카드 색/태그)는 구서버 상대로 404/400 폴백 안전망이 있지만, 폴백은 과도기용이지 정상 운영 경로다.

워크스페이스 지정 생성요청: 신 서버는 워크스페이스가 지정된 대기 요청을
capability 를 밝힌 신 에이전트에게만 내려준다. 구 에이전트는 그 요청을 집지 못하고
pending 으로 남으므로, 서버 업데이트 후 **워커 PC(에이전트)도 곧 업데이트**해야
지정 요청이 처리된다(잘못된 워크스페이스에서 실행·과금되는 것을 막기 위한 게이트).

## 서버 시간대 — KST 전제

관리 대시보드의 날짜·시간 집계는 SQLite `'localtime'` 변환으로 **서버 OS 시간대**를
따른다. 팀 표준시는 KST 이므로 서버 머신의 OS 시간대는 반드시 KST(Asia/Seoul)여야
한다. UTC 클라우드로 이전하면 OS 시간대를 KST 로 맞추거나 집계 쿼리를 조정해야 한다.

## 실행

```bat
MV_server.bat
```

하는 일: ① 기존 `frontend/dist` 확인 → ② 없을 때만 잠금 파일 기준 `npm ci`와 빌드
→ ③ 백엔드를 `0.0.0.0:8010` 으로 기동(빌드된 dist 서빙). 평소 부팅은 npm 설치나
외부 네트워크에 의존하지 않는다. 일반 크래시는 대기 시간을
늘리며 자동 재기동하고, 빠른 실패 5회면 폭풍을 차단해 작업 스케줄러의 지연 재시도로 넘긴다.

MV_server.bat 은 **팀 서버 기본값**을 켠다: `CONTENT_HUB_AUTH=1`(로그인 필수)·
`CONTENT_HUB_MANAGE=1`(관리 대시보드 on). 끄려면 실행 전 해당 환경변수를 0 으로 설정.

- 같은 PC:        http://localhost:8010
- 같은 네트워크:  http://<이 PC IP>:8010   (IP 는 `ipconfig` 로 확인)

포트/바인딩 변경: `set PORT=9000 & MV_server.bat`, 또는 환경변수
`CONTENT_HUB_PORT` / `CONTENT_HUB_HOST`.

### Windows 자동시작과 업데이트

서버 PC에서 최초 한 번 `register_autostart.bat`을 관리자 승인으로 실행한다. 서버·감시·
백업 작업이 SYSTEM 계정으로 등록되며, 현재 검증된 Python·Node 절대 경로는 로그가 아닌
`.mvhub-runtime/`에 저장된다. 구버전의 `logs/scheduled_*.txt`는 첫 실행 때 자동 이전한다.

이후 `update_git.bat`은 잠금 파일 기준 `npm ci`로 필요한 경우에만 프론트를 갱신한다.
`MVHub Server` 예약 작업이 있으면 관리자 승인 후 서버·감시 작업을 안전하게 다시 시작하고
`/api/ready`가 200인지 확인한다. 실패하면 예약 작업의 상태·결과 코드와
`logs/server_console.log` 마지막 부분을 즉시 보여준다. 따라서 등록 후에는
`MV_server.bat`을 별도 창에서 수동 실행하지 않는다.

## 설정 (모두 환경변수, 하드코딩 없음)

> 아래 표는 **운영에서 자주 만지는 것만** 추린 것이다. 전체 `CONTENT_HUB_*` 변수는 70개가
> 넘으며(Comfy `_COMFY_*`, Resolve `_RESOLVE_*`, HTTPS `_SSL_CERTFILE/_SSL_KEYFILE`,
> 백업 복제 `_BACKUP_REPLICA_DIR`, 캐시 상한 `_MEDIA_CACHE_MAX_BYTES`/`_THUMB_*` 등)
> 기본값과 정의는 `backend/app/config.py` 와 각 서비스 모듈 상단이 정답이다.

| 변수 | 기본값 | 용도 |
|------|--------|------|
| `CONTENT_HUB_HOST` | `0.0.0.0` | 바인딩 주소 |
| `CONTENT_HUB_PORT` | `8000`(코드) · **MV_server.bat=8010** | 포트 |
| `CONTENT_HUB_DATA` | `backend/data` | DB·미디어·공유 루트 |
| `CONTENT_HUB_FRONTEND_DIST` | `frontend/dist` | 서빙할 빌드 산출물(없으면 API 전용) |
| `CONTENT_HUB_ASSETS_DIR` | `<DATA>/assets` | Assets(구성) 패널 루트 |
| `CONTENT_HUB_WORKER_ID` / `_NAME` | `me` / `나` | 기본 작업자 |
| `CONTENT_HUB_BACKUP_DIR` | `<DATA>/backups` | DB 백업 보관 폴더(실서버: 다른 디스크/NAS 권장) |
| `CONTENT_HUB_BACKUP_INTERVAL` | `86400`(하루) | 백업 주기(초). 0 이하 = 비활성 |
| `CONTENT_HUB_BACKUP_KEEP` | `7` | 백업 보관 개수(회전) |
| `CONTENT_HUB_AUTH` | `0`(코드) · **MV_server.bat=1** | 로그인 인증 enforcement. 1 이면 로그인 필수 |
| `CONTENT_HUB_MANAGE` | `1`(on) | PM/관리 대시보드(상단 보드 아이콘). 0 이면 숨김 |
| `CONTENT_HUB_AUTH_SECRET` | (자동생성) | 토큰 서명 시크릿. 미지정 시 DB에 1회 생성·영속 |
| `CONTENT_HUB_LOG_DIR` | `<DATA>/logs` | JSON 운영 로그 폴더 |
| `CONTENT_HUB_LOG_MAX_BYTES` | `10485760` | 운영 로그 파일 1개의 회전 크기 |
| `CONTENT_HUB_LOG_KEEP` | `5` | 회전 로그 보관 개수 |
| `CONTENT_HUB_METRICS_LOG_INTERVAL` | `60` | CPU·메모리·요청 집계를 로그에 남기는 주기(초), 0=비활성 |
| `CONTENT_HUB_SLOW_REQUEST_MS` | `1000` | 개별 느린 요청을 운영 로그에 기록하는 기준(ms) |
| `CONTENT_HUB_MEDIA_PRESERVATION` | `0`(off) | 기본 URL-only. 특수 설치에서만 1로 영구 보존 opt-in |
| `CONTENT_HUB_PRESERVED_MEDIA_MAX_BYTES` | `53687091200`(50GiB) | opt-in 시 원본 영구 보존 총량 |
| `CONTENT_HUB_MEDIA_PRESERVATION_INTERVAL_SECONDS` | `30` | opt-in 원본 보존 워커 주기(초), 한 주기 최대 2건 |
| `CONTENT_HUB_MEDIA_PRESERVATION_STARTUP_DELAY_SECONDS` | `10` | 서버 시작 뒤 원본 보존 다운로드 시작 유예(초) |
| `CONTENT_HUB_MEDIA_PRESERVATION_MAX_ATTEMPTS` | `5` | 자동 재시도 최대 횟수. 이후 정보창에서 수동 재시도 가능 |
| `CONTENT_HUB_RESTART_LIMIT` | `5` | 빠른 서버 종료를 연속 허용하는 횟수 |
| `CONTENT_HUB_STABLE_SECONDS` | `120` | 이 시간 이상 정상 실행하면 빠른 종료 횟수 초기화 |

## 로그인/계정 승인 보안 (CONTENT_HUB_AUTH=1)

코드 기본은 off 지만 **MV_server.bat 은 `CONTENT_HUB_AUTH=1`(로그인 필수) 로 켜서 기동**한다
(팀 서버 용도). 개인 PC·개발에서 인증 없이 쓰려면 실행 전 `set CONTENT_HUB_AUTH=0`.

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

## 미디어 URL-only 정책

Higgsfield 생성물은 DB에 원격 HTTPS URL을 보관한다. 공유·최종 선택은 서버와 작업자
PC의 `media/`에 원본 영상을 자동 저장하지 않는다. 구버전이 보존한 항목도 DB에 남은
`source_url`을 응답에서 우선하며, 이미 받은 파일은 안전을 위해 자동 삭제하지 않는다.

목록을 빠르게 보여주기 위한 썸네일은 각 작업자의 로컬 허브에서 만든다. 원격 이미지와
영상 포스터를 목록 조회 직후 작은 JPEG로 미리 만들며, 썸네일과 썸네일 생성용 원본은
작업자 PC의 용량 상한이 있는 LRU 캐시에만 둔다. 오래된 캐시는 자동 정리되고 비디오 원본
자체는 사전 준비하지 않는다. 공유 서버는 원격 썸네일을 생성·저장하지 않는다.

기존 영구 보존 코드는 특수 설치 호환성을 위해 남아 있지만 기본은 꺼져 있다.
`CONTENT_HUB_MEDIA_PRESERVATION=1`을 명시한 설치에서만 시작 백필·주기 다운로드·수동
`/api/cache-all`이 활성화된다. 일반 배포는 이 값을 설정하지 않는다.

## DB 자동 백업

SQLite 파일 손상·실수 삭제 대비. **SQLite 온라인 백업 API**로 콘텐츠·휴지통·프로젝트
관리 DB를 같은 stamp의 세트로 뜬다(WAL 모드에서 단순 파일복사는 위험 — `-wal` 미반영분 누락).
단, SQLite/WAL은 여러 attached DB 전체의 원자적 동일 시점을 보장하지 않아 별칭별 첫 읽기 사이에
미세한 시점 차와 이동 중 행의 중복·누락 가능성이 있다. 서버 시작 시 1회(최근 백업이
1시간 내면 생략) + 주기 실행, 최근 `BACKUP_KEEP` 개만 회전 보관.

- 수동 백업:   `POST /api/backup`
- 백업 목록:   `GET /api/backups`
- ⚠️ 실서버에선 `CONTENT_HUB_BACKUP_DIR` 를 **다른 디스크/NAS**로 — 같은 디스크면 동반 손실.

### 작업자 PC 백업

로그인한 작업자 허브는 로컬 온라인 백업 뒤 개인 `content + trash` 세트를 영속 outbox에 넣고
공유 서버의 `POST /api/db-backup/sets`로 자동 전송한다. 공유 서버는 세션 계정별
`backend/data/db-backups/<계정>/sets/<backup_set_id>/`에 저장하며, 크기·SHA-256·SQLite
무결성과 정확한 ACK가 모두 맞아야 성공이다. 설정의 `서버에 백업`은 같은 경로를 즉시 실행한다.

공유 서버 디스크는 두 번째 물리 사본이 아니다. `tools/backup_replicate.py`와
`register_autostart.bat`의 `MVHub BackupCopy`를 사용해 서버 자체 백업과 작업자 세트를 NAS·다른
디스크로 한 번 더 복제해야 한다. 자세한 완료 조건은
[WORKER_OFFDISK_BACKUP_CONTRACT.md](WORKER_OFFDISK_BACKUP_CONTRACT.md)를 따른다.

### 백업 복원 훈련

운영 DB를 교체하지 않고 임시 파일에 온라인 백업→복원→무결성·외래키·테이블 행 수 비교를 수행한다.
운영 복구 가능성을 확인할 때는 단일 DB가 아니라 **같은 stamp의 콘텐츠·휴지통·관리 DB 세트**를
검증해야 한다. 이 stamp는 세트 구성 표식이지 DB 간 완전히 동일한 트랜잭션 시점의 증명이 아니다.

```powershell
py -3 tools\verify_backup_restore.py
py -3 tools\verify_backup_restore.py --backup "E:\MVHub-backups\content_hub_20260731_120000.db"
py -3 tools\verify_backup_restore.py --backup-set "E:\MVHub-backups\content_hub_20260731_120000.db"
```

`--backup-set`은 같은 폴더에서 정확히 같은 stamp의 `content_trash_*.db`와 `manage_hub_*.db`를
찾는다. 세 파일 중 하나라도 없으면 아무것도 복원하지 않는다. 성공 JSON에서 다음을 확인한다.

- 최상위 `"ok": true`, `"mode": "database_set"`
- `isolated_server.ready_checks`의 `content`, `trash`, `manage`가 모두 `"ok"`
- `isolated_server.login`이 `"ok"`, `process_stopped`가 `true`
- `files.*.source_unchanged`가 모두 `true`

검사 실패나 핵심 수의 예상 밖 변화가 있으면 그 세트를 운영에 설치하지 말고 이전 완성 세트로 같은
드릴을 다시 실행한다. content와 trash에 같은 generation ID가 함께 남은 경우에만 부팅 정합기가
살아 있는 content 행을 우선하고 trash 중복을 제거한다. 한쪽에만 빠진 행이나 manage 의미 불일치는
드릴만으로 완전 검출할 수 없고 자동 추측 복구도 하지 않는다. 화면·세트 요약을 이전 세트와 대조해
차이가 의심되면 이전 정상 세트를 선택하고 별도 조사한다.

별도 `--restored-dir`을 주지 않으면 복원 사본과 격리 서버 로그는 성공·실패 후 임시 폴더와 함께
삭제된다. `--restored-dir`로 남긴 사본에는 로그인 실측용 임시 account·creator가 각 1건 추가되므로
**운영 DB로 직접 교체하면 안 된다.** 실제 장애 복원은 서버를 중지하고 기존 운영 DB를 별도 보존한
뒤 검증된 원본 백업 3개를 사용한다. 이 도구 자체는 운영 DB와 원본 백업을 자동 교체·수정하지 않는다.

## 운영 상태 확인

- 준비 상태: `GET /api/ready` — 콘텐츠·생성 큐 및 활성화된 관리/휴지통 DB의 핵심
  테이블 읽기까지 성공하면 `ready`, 실패하면 HTTP 503. DB 복원 유지보수 중에는 DB 연결을
  기다리지 않고 즉시 `503 {"status":"maintenance"}`와 `Retry-After: 5`를 반환한다.
- 관리자 지표: `GET /api/admin/runtime` — 요청 p50/p95/p99, 5xx, SQLite 잠금,
  프로세스 CPU·RSS, WebSocket·에이전트 연결, 생성 단계/지연, 최근 백업,
  관리 데이터 전송 대기·실패, 원본 보존 pending/running/partial/failed/capacity 집계,
  작업자 백업 대기·마지막 성공, 외부 복제 상태, DB/WAL·미디어·썸네일 용량.
- 회전 로그: `<DATA>/logs/mvhub-runtime.jsonl` — 60초 집계와 생성 상태 전이,
  5xx·느린 요청을 JSON 한 줄로 기록. 평상시에는 `MV_logs.bat`로 정돈된 로그를 본다.
- 장기 생성 이력: `GET /api/admin/generation-events?generation_id=...` — 회전 로그와 별개로
  DB의 `generation_event`에 요청·작업 ID 확보·검증·완료/실패 전이를 보관한다.
- 중요 변경 감사: `GET /api/admin/audit-events?project_id=...` — 계정 상태/역할,
  프로젝트 생성·변경·삭제/멤버 역할, 일정·예산, 최종 선택 변경을 `audit_event`에 보관한다.

생성 확인 지연, 10분 이상 밀린 관리 데이터, 전송 실패, 원본 보존 일부 실패·실패·용량 부족,
DB 준비 실패는 `WARNING`으로 남는다.
같은 상태를 매분 반복하지 않고 상태가 바뀌거나 30분 이상 계속될 때만 다시 알려 로그 폭주를 막는다.

초기 관리자 비밀번호를 환경변수로 주지 않은 첫 설치는
`<DATA>/bootstrap_admin_password.txt`에만 1회용 비밀번호를 기록한다. 콘솔 로그에는
비밀번호가 나오지 않는다. 로그인 후 비밀번호를 변경하고 이 파일을 삭제한다.

관리자 지표·회전 로그·장기 이력에는 비밀번호·이메일 원문·프롬프트·미디어 URL을 기록하지 않는다.
이메일 기반 임시 신원은 복구 불가능한 지문으로 바꿔 기록한다. 부하 테스트 중에는
`sqlite_locked_total=0`, 애플리케이션 `5xx=0`, 메모리 워밍업 이후 안정 여부를 우선 확인한다.

## 실서버 이전 체크리스트

1. 이 폴더 전체를 서버로 복사(`node_modules`·`dist`·`__pycache__` 제외 — 설치 과정에서 재생성).
2. `pip install -r backend/requirements.txt`, Node 설치.
3. 데이터 경로를 서버 디스크에 맞춰 `CONTENT_HUB_DATA` 지정(권장: 영속 볼륨).
4. Windows는 `register_autostart.bat`으로 설치·기동한다. 수동 구성은
   `npm ci` → `npm run build` → `python serve.py`(IPv4/IPv6 듀얼스택, `--reload` 금지). 직접 uvicorn 이면
   `python -m uvicorn app.main:app --host 0.0.0.0 --port 8010`.
5. 방화벽에서 해당 포트 인바운드 허용.
6. Higgsfield CLI 는 **각 사용자 개인 PC**에서 본인 계정으로 — 서버엔 토큰을 두지 않는다
   (로드맵 보안 원칙). 서버는 데이터 수집(`/sync`)·보관·서빙만 담당.

> ⚠️ Windows 에서 `--reload` 금지: 리로더가 SelectorEventLoop 을 강제해 CLI subprocess 가
> 깨진다(NotImplementedError). 코드 수정 후엔 프로세스를 직접 재기동.
