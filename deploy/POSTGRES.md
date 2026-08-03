# PostgreSQL 백엔드 (Phase 3) — 현재 전환 금지

> **운영 상태(2026-07-31): PostgreSQL 런타임은 미완성이며 사용할 수 없습니다.**
> `backend/app/db.py`가 `CONTENT_HUB_DB_BACKEND=postgres`를 의도적으로 차단합니다.
> 아래 내용은 과거 실험 기록과 향후 구현 설계 참고용입니다. 운영 서버에서 환경변수만
> 바꾸거나 이 문서의 이전 절차를 실행하지 마세요.

확장성 로드맵 Phase 3. **팀 동시 쓰기**가 SQLite 단일-writer 의 벽이 될 때 PostgreSQL 로 전환한다.
데이터 양이 아니라 *동시 쓰기 경합*("database is locked")이 신호다.

## 현재 결정
- 운영 백엔드는 **SQLite만 지원**한다.
- 먼저 100명 부하 테스트에서 잠금 횟수와 쓰기 지연을 측정한다.
- 실제 경합이 확인되면 PostgreSQL 호환성 복구, 전체 테스트, 마이그레이션·역마이그레이션,
  백업 체계를 별도 프로젝트로 구현한 뒤 전환한다.

## 과거 설계 기록 — 아직 운영 기능 아님
- 목표 설계는 `CONTENT_HUB_DB_BACKEND=postgres` 옵트인 전환이다.
- repo 의 raw SQL 은 **다시 쓰지 않는다.** [app/pgsupport.py](../backend/app/pgsupport.py) 가 실행 시점에
  방언을 번역한다: `?`→`%s`, `INSERT OR REPLACE/IGNORE`→`ON CONFLICT`, `datetime('now')`→동일 포맷
  `to_char`, `strftime`→`extract(epoch)`, `LIKE`→`ILIKE`, `GROUP_CONCAT`→`string_agg`,
  `rowid`→`ctid`, `COLLATE NOCASE`→`LOWER()`, 리터럴 `%`→`%%`.
- 검색은 FTS5 대신 **pg_trgm GIN + ILIKE**(부분일치 의미 보존). 휴지통은 ATTACH 대신 **trash 스키마**.

## 개발 재개 시 사전 준비 예시
```sh
pip install "psycopg[binary]"            # 드라이버(이미 설치돼 있을 수 있음)
# PostgreSQL 16 (예: Docker)
docker run -d --name ch-postgres \
  -e POSTGRES_USER=ch -e POSTGRES_PASSWORD=chpass -e POSTGRES_DB=content_hub \
  -p 55432:5432 postgres:16
```
DSN 기본값: `postgresql://ch:chpass@127.0.0.1:55432/content_hub`
(바꾸려면 `CONTENT_HUB_PG_DSN` 환경변수.)

## 목표 전환 절차(현재 실행 금지)
1. **데이터 이전**(SQLite → PG). SQLite 는 읽기만, 멱등(매번 PG public 스키마를 리셋 후 재적재):
   ```sh
   cd backend && python migrate_to_pg.py
   ```
   - SQLite 스키마를 내성해 `schema_pg.sql`(동등 PG DDL)을 생성·적용하고 전 행을 복사한다.
   - 끝에 테이블별 행수를 SQLite vs PG 로 대조해 무결성을 보고한다.
2. **백엔드 전환** — 호환성 구현과 전체 테스트가 완료된 미래 버전에서만:
   ```sh
   set CONTENT_HUB_DB_BACKEND=postgres   &  MV_server.bat   (Windows)
   CONTENT_HUB_DB_BACKEND=postgres python serve.py            (그 외)
   ```
   시작 시 `init_db` 가 schema_pg.sql 적용 + pg_trgm + 성능 인덱스를 멱등 보장한다.
3. **롤백** — 단순 환경변수 제거로는 PG 전환 뒤의 새 데이터를 되돌릴 수 없다.
   역이전 도구와 컷오버 이후 쓰기 동결 절차가 준비되어야 한다.

## ⚠️ 주의
- 전환은 **단방향 컷오버 시점**을 정해서 한다. PG 로 띄운 뒤 들어온 새 데이터는 SQLite 에 없다
  (되돌리려면 그 사이 데이터를 역이전해야 함). 한가한 시간에 migrate → 전환을 권장.
- PG 백엔드에선 DB 자동 백업(services/backup.py, SQLite 온라인 .backup)은 동작하지 않는다 →
  `pg_dump` 기반 백업을 별도 스케줄하라.
- 과거 제한 검증(2026-06-16): 데이터 이전(737행 전 테이블 행수 일치) + 당시 repo 런타임(목록·키셋·ILIKE 검색·
  통계·facets·GROUP_CONCAT·휴지통 라운드트립) + HTTP 엔드포인트(generations·stats·facets·trash·
  projects·members·creators·team·미디어필터·소스검색)를 PostgreSQL 16에서 통과했다.
  이후 스키마·락·repo가 변경되어 현재 호환성을 보장하지 않는다.
