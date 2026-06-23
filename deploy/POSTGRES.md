# PostgreSQL 백엔드 (Phase 3) — 옵트인 전환 가이드

확장성 로드맵 Phase 3. **팀 동시 쓰기**가 SQLite 단일-writer 의 벽이 될 때 PostgreSQL 로 전환한다.
데이터 양이 아니라 *동시 쓰기 경합*("database is locked")이 신호다.

## 설계 — 추가(additive) · env 스위치
- 기본 백엔드는 **SQLite**(무변경). `CONTENT_HUB_DB_BACKEND=postgres` 일 때만 PG 사용.
- repo 의 raw SQL 은 **다시 쓰지 않는다.** [app/pgsupport.py](../backend/app/pgsupport.py) 가 실행 시점에
  방언을 번역한다: `?`→`%s`, `INSERT OR REPLACE/IGNORE`→`ON CONFLICT`, `datetime('now')`→동일 포맷
  `to_char`, `strftime`→`extract(epoch)`, `LIKE`→`ILIKE`, `GROUP_CONCAT`→`string_agg`,
  `rowid`→`ctid`, `COLLATE NOCASE`→`LOWER()`, 리터럴 `%`→`%%`.
- 검색은 FTS5 대신 **pg_trgm GIN + ILIKE**(부분일치 의미 보존). 휴지통은 ATTACH 대신 **trash 스키마**.

## 사전 준비
```sh
pip install "psycopg[binary]"            # 드라이버(이미 설치돼 있을 수 있음)
# PostgreSQL 16 (예: Docker)
docker run -d --name ch-postgres \
  -e POSTGRES_USER=ch -e POSTGRES_PASSWORD=chpass -e POSTGRES_DB=content_hub \
  -p 55432:5432 postgres:16
```
DSN 기본값: `postgresql://ch:chpass@127.0.0.1:55432/content_hub`
(바꾸려면 `CONTENT_HUB_PG_DSN` 환경변수.)

## 전환 절차
1. **데이터 이전**(SQLite → PG). SQLite 는 읽기만, 멱등(매번 PG public 스키마를 리셋 후 재적재):
   ```sh
   cd backend && python migrate_to_pg.py
   ```
   - SQLite 스키마를 내성해 `schema_pg.sql`(동등 PG DDL)을 생성·적용하고 전 행을 복사한다.
   - 끝에 테이블별 행수를 SQLite vs PG 로 대조해 무결성을 보고한다.
2. **백엔드 전환** — 서버를 PG 백엔드로 띄운다:
   ```sh
   set CONTENT_HUB_DB_BACKEND=postgres   &  run-server.bat   (Windows)
   CONTENT_HUB_DB_BACKEND=postgres python serve.py            (그 외)
   ```
   시작 시 `init_db` 가 schema_pg.sql 적용 + pg_trgm + 성능 인덱스를 멱등 보장한다.
3. **롤백** — 환경변수를 빼고 재시작하면 즉시 SQLite 로 돌아간다(원본 SQLite 파일은 그대로).

## ⚠️ 주의
- 전환은 **단방향 컷오버 시점**을 정해서 한다. PG 로 띄운 뒤 들어온 새 데이터는 SQLite 에 없다
  (되돌리려면 그 사이 데이터를 역이전해야 함). 한가한 시간에 migrate → 전환을 권장.
- PG 백엔드에선 DB 자동 백업(services/backup.py, SQLite 온라인 .backup)은 동작하지 않는다 →
  `pg_dump` 기반 백업을 별도 스케줄하라.
- 검증됨(2026-06-16): 데이터 이전(737행 전 테이블 행수 일치) + repo 런타임(목록·키셋·ILIKE 검색·
  통계·facets·GROUP_CONCAT·휴지통 라운드트립) + HTTP 엔드포인트(generations·stats·facets·trash·
  projects·members·creators·team·미디어필터·소스검색) 전부 PostgreSQL 16 에서 통과.
