"""SQLite → PostgreSQL 데이터 이전 도구 (Phase 3).

하는 일(멱등, 격리):
  1. 라이브 SQLite DB 스키마를 내성(PRAGMA)해 **동등한 PG DDL** 생성 → schema_pg.sql 기록.
  2. PG 의 public 스키마를 리셋하고 DDL 적용(테이블·PK·기본값. FK 는 생략 — 앱이 명시 정리).
  3. 모든 행을 PG 로 복사(타입 그대로: INTEGER→bigint, REAL→double precision, TEXT→text).
  4. pg_trgm + 성능 인덱스 생성(pgsupport.ensure_indexes).

SQLite 는 직접(sqlite3) 읽고 PG 는 직접(psycopg) 쓴다 — 백엔드 env 와 무관하게 동작.
실데이터 무오염: SQLite 는 읽기만. PG 는 격리된 컨테이너.

사용:  python migrate_to_pg.py
"""

from __future__ import annotations

import sqlite3
import sys

import psycopg

from app.db import get_db_path
from app.pgsupport import PG_DSN, SCHEMA_PG_PATH, ensure_indexes, exec_script

# FTS5 그림자 테이블·sqlite 내부는 건너뜀(PG 는 pg_trgm 사용).
_SKIP_PREFIX = ("sqlite_", "generation_fts")

_TYPE = {"INTEGER": "bigint", "REAL": "double precision", "TEXT": "text"}
_NOW_DEFAULT = "to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')"


def _pg_type(sqlite_type: str) -> str:
    return _TYPE.get((sqlite_type or "").upper(), "text")


def _pg_default(dflt: str) -> str:
    if dflt is None:
        return ""
    if "datetime('now')" in dflt or "datetime(''now'')" in dflt:
        return f" DEFAULT {_NOW_DEFAULT}"
    return f" DEFAULT {dflt}"


def _tables(scon: sqlite3.Connection) -> list[str]:
    rows = scon.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).fetchall()
    return [r[0] for r in rows if not r[0].startswith(_SKIP_PREFIX)]


def _ddl_for(scon: sqlite3.Connection, table: str) -> tuple[str, list[str]]:
    """(CREATE TABLE 문, 컬럼순서). PRAGMA table_info 로 PG DDL 생성."""
    info = scon.execute(f"PRAGMA table_info({table})").fetchall()
    cols, defs, pk = [], [], []
    for cid, name, ctype, notnull, dflt, ispk in info:
        cols.append(name)
        d = f"  {name} {_pg_type(ctype)}"
        if notnull:
            d += " NOT NULL"
        d += _pg_default(dflt)
        defs.append(d)
        if ispk:
            pk.append((ispk, name))
    if pk:
        pk.sort()
        defs.append(f"  PRIMARY KEY ({', '.join(n for _, n in pk)})")
    ddl = f"CREATE TABLE IF NOT EXISTS {table} (\n" + ",\n".join(defs) + "\n);"
    return ddl, cols


def main() -> int:
    sqlite_path = get_db_path()
    print(f"[migrate] SQLite 원본: {sqlite_path}")
    print(f"[migrate] PG 대상:    {PG_DSN}")
    scon = sqlite3.connect(sqlite_path)
    scon.row_factory = sqlite3.Row

    tables = _tables(scon)
    ddls, colmap = [], {}
    for t in tables:
        ddl, cols = _ddl_for(scon, t)
        ddls.append(ddl)
        colmap[t] = cols
    schema_sql = "-- 자동 생성(migrate_to_pg.py) — SQLite 스키마 내성 → PG DDL\n\n" + "\n\n".join(ddls) + "\n"
    SCHEMA_PG_PATH.write_text(schema_sql, encoding="utf-8")
    print(f"[migrate] schema_pg.sql 생성: {len(tables)}개 테이블 → {SCHEMA_PG_PATH}")

    pg = psycopg.connect(PG_DSN, autocommit=True)
    # public 스키마 리셋(깨끗한 재이전) + DDL 적용
    pg.execute("DROP SCHEMA IF EXISTS public CASCADE")
    pg.execute("CREATE SCHEMA public")
    pg.execute("DROP SCHEMA IF EXISTS trash CASCADE")
    exec_script(pg, schema_sql)
    print("[migrate] PG 스키마 적용 완료")

    # 데이터 복사
    total = 0
    with pg.transaction():
        for t in tables:
            cols = colmap[t]
            rows = scon.execute(f"SELECT {', '.join(cols)} FROM {t}").fetchall()
            if not rows:
                continue
            ph = ", ".join(["%s"] * len(cols))
            sql = f"INSERT INTO {t} ({', '.join(cols)}) VALUES ({ph})"
            with pg.cursor() as cur:
                cur.executemany(sql, [tuple(r) for r in rows])
            total += len(rows)
            print(f"[migrate]   {t}: {len(rows)}행")
    print(f"[migrate] 데이터 복사 완료: 총 {total}행")

    ensure_indexes(pg)
    print("[migrate] pg_trgm + 성능 인덱스 생성 완료")

    # 무결성 점검 — 행수 대조
    print("\n[검증] 테이블별 행수 대조(SQLite vs PG):")
    ok = True
    for t in tables:
        s = scon.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        p = pg.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        mark = "OK" if s == p else "✗ 불일치"
        if s != p:
            ok = False
        print(f"  {t:28} sqlite={s:6} pg={p:6}  {mark}")
    scon.close()
    pg.close()
    print("\n[migrate] 완료" + ("" if ok else " — ⚠️ 행수 불일치 있음"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
