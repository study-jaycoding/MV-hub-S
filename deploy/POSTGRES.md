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
- 과거에는 SQL 방언을 실행 시점에 변환하는 shim을 실험했지만, 현재 스키마·락·쿼리와 호환되지 않아
  관련 코드와 PostgreSQL 전용 스키마·이관 스크립트를 제거했다.
- 향후 재개 시에는 SQLite용 raw SQL을 문자열 치환하는 방식으로 되살리지 않고, 데이터 접근 계층의
  백엔드 경계를 명시적으로 설계하고 SQLite/PostgreSQL 통합 테스트를 함께 구축한다.
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

## 향후 전환을 재개할 때 필요한 작업
1. PostgreSQL 전용 DDL과 명시적 데이터 접근 구현
2. SQLite → PostgreSQL 이관·행수 대조·무결성 검증 도구
3. 전체 repo·HTTP·동시 쓰기·검색·휴지통 통합 테스트
4. PostgreSQL용 백업과 복원 훈련
5. 역이전 도구와 컷오버 이후 쓰기 동결·롤백 절차

위 항목이 모두 구현되기 전에는 `CONTENT_HUB_DB_BACKEND=postgres` 설정을 사용할 수 없다.

## ⚠️ 주의
- 전환은 **단방향 컷오버 시점**을 정해서 한다. PG 로 띄운 뒤 들어온 새 데이터는 SQLite 에 없다
  (되돌리려면 그 사이 데이터를 역이전해야 함). 한가한 시간에 migrate → 전환을 권장.
- PG 백엔드에선 DB 자동 백업(services/backup.py, SQLite 온라인 .backup)은 동작하지 않는다 →
  `pg_dump` 기반 백업을 별도 스케줄하라.
- 과거 제한 검증(2026-06-16): 데이터 이전(737행 전 테이블 행수 일치) + 당시 repo 런타임(목록·키셋·ILIKE 검색·
  통계·facets·GROUP_CONCAT·휴지통 라운드트립) + HTTP 엔드포인트(generations·stats·facets·trash·
  projects·members·creators·team·미디어필터·소스검색)를 PostgreSQL 16에서 통과했다.
  이후 스키마·락·repo가 변경되어 현재 호환성을 보장하지 않는다.
