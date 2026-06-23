"""PostgreSQL 백엔드 지원 — SQLite 코드를 거의 그대로 굴리는 호환 계층 (Phase 3).

설계 원칙: **추가(additive) + 격리**. 기본 백엔드는 SQLite(무변경). CONTENT_HUB_DB_BACKEND=postgres
일 때만 이 모듈이 쓰인다. repo 의 raw SQL 을 다시 쓰지 않고, 실행 시점에 방언을 번역한다.

번역(_translate):
  · `?`            → `%s`               (psycopg 플레이스홀더)
  · `INSERT OR IGNORE`  → `INSERT ... ON CONFLICT DO NOTHING`
  · `INSERT OR REPLACE` → `INSERT ... ON CONFLICT (<키>) DO UPDATE SET ...`  (테이블 키맵)
  · `datetime('now')`     → SQLite 와 **동일 텍스트 포맷**(to_char) → TEXT 컬럼·날짜파싱·정렬 호환
  · `datetime('now', ?)`  → 인터벌 가감 후 동일 포맷
  · `strftime('%s', X)`   → `extract(epoch from (X)::timestamp)`  (sort_ts 정렬키)
  · `GROUP_CONCAT(DISTINCT x)` → `string_agg(DISTINCT x::text, ',')`
  · `rowid`        → `ctid`             (gen_reference 삽입순 ORDER BY 근사)
  · `LIKE`         → `ILIKE`            (SQLite LIKE 의 대소문자 무시 의미 보존)

행 객체(_HybridRow): sqlite3.Row 처럼 row[0](정수)·row["col"](문자열)·.keys()·dict(row) 모두 지원.
트랜잭션: autocommit=True + 명시 BEGIN/COMMIT/ROLLBACK → SQLite isolation_level=None 과 동일 흐름.
"""

from __future__ import annotations

import os
import re
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import psycopg

PG_DSN = os.environ.get(
    "CONTENT_HUB_PG_DSN", "postgresql://ch:chpass@127.0.0.1:55432/content_hub"
)

_BACKEND_DIR = Path(__file__).resolve().parent.parent
SCHEMA_PG_PATH = _BACKEND_DIR / "schema_pg.sql"  # migrate_to_pg.py 가 생성(SQLite 내성→PG DDL)

# INSERT OR REPLACE 를 ON CONFLICT 로 바꿀 때 쓰는 테이블별 충돌 키(PK/UNIQUE).
_CONFLICT_KEY = {
    "generation": "id", "asset": "id", "reference": "id", "worker": "id",
    "tag": "id", "auto_tag": "id", "history": "id", "share": "id",
    "project": "id", "account": "email", "creator": "uid", "app_setting": "key",
    "generation_comment": "id", "asset_comment": "id", "trashed": "id",
    "gen_reference": "generation_id, reference_id, role",
    "gen_tag": "generation_id, tag_id", "gen_auto_tag": "generation_id, auto_tag_id",
    "generation_comment_read": "worker_id, gen_id",
    "asset_comment_read": "worker_id, project, path",
    "asset_meta": "project, path", "project_member": "project_id, creator_uid",
}

_INSERT_OR = re.compile(
    r"INSERT\s+OR\s+(REPLACE|IGNORE)\s+INTO\s+((?:trash\.)?(\w+))\s*\(([^)]*)\)",
    re.IGNORECASE,
)
# SQLite datetime('now') 를 동일 포맷 텍스트로(UTC, 'YYYY-MM-DD HH24:MI:SS').
_NOW_TEXT = "to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')"


def _conflict(verb: str, table: str, cols_str: str) -> str:
    if verb.upper() == "IGNORE":
        return " ON CONFLICT DO NOTHING"
    key = _CONFLICT_KEY.get(table)
    if not key:
        return " ON CONFLICT DO NOTHING"
    keycols = {k.strip() for k in key.split(",")}
    setcols = [c.strip() for c in cols_str.split(",") if c.strip() not in keycols]
    if not setcols:
        return f" ON CONFLICT ({key}) DO NOTHING"
    sets = ", ".join(f"{c}=EXCLUDED.{c}" for c in setcols)
    return f" ON CONFLICT ({key}) DO UPDATE SET {sets}"


def _translate(sql: str) -> str:
    conflict = ""
    m = _INSERT_OR.search(sql)
    if m:
        verb, full_table, bare_table, cols = m.group(1), m.group(2), m.group(3), m.group(4)
        conflict = _conflict(verb, bare_table, cols)
        sql = sql[: m.start()] + f"INSERT INTO {full_table}({cols})" + sql[m.end():]
    # datetime('now', ?) → 인터벌 가감(먼저 — 'now' 단독 치환보다 앞서야 함)
    sql = re.sub(
        r"datetime\('now',\s*\?\)",
        "to_char(timezone('UTC', now() + (?)::interval), 'YYYY-MM-DD HH24:MI:SS')",
        sql,
    )
    sql = sql.replace("datetime('now')", _NOW_TEXT)
    sql = re.sub(r"strftime\('%s',\s*([^)]+)\)", r"extract(epoch from (\1)::timestamp)", sql)
    sql = re.sub(
        r"GROUP_CONCAT\(DISTINCT\s+([^)]+)\)", r"string_agg(DISTINCT (\1)::text, ',')",
        sql, flags=re.IGNORECASE,
    )
    sql = re.sub(r"\browid\b", "ctid", sql)
    # SQLite COLLATE NOCASE(대소문자 무시 정렬) → PG 는 LOWER(컬럼)
    sql = re.sub(
        r"(\w+(?:\.\w+)?)\s+COLLATE\s+NOCASE", r"LOWER(\1)", sql, flags=re.IGNORECASE
    )
    sql = re.sub(r"\bLIKE\b", "ILIKE", sql)
    if conflict:
        sql += conflict
    # 리터럴 % (예: ILIKE 'http%')는 psycopg 바인딩에서 %% 로 이스케이프해야 함.
    # 이 시점엔 strftime('%s') 도 이미 치환돼 사라졌으므로 안전. ?→%s 는 이 뒤에.
    sql = sql.replace("%", "%%")
    sql = sql.replace("?", "%s")
    return sql


class _HybridRow:
    """sqlite3.Row 호환 — row[int]·row['col']·keys()·dict(row) 모두 지원."""

    __slots__ = ("_c", "_v", "_m")

    def __init__(self, cols: list[str], vals: tuple) -> None:
        self._c = cols
        self._v = vals
        self._m: dict[str, Any] | None = None

    def _map(self) -> dict[str, Any]:
        if self._m is None:
            self._m = dict(zip(self._c, self._v))
        return self._m

    def __getitem__(self, k):
        return self._v[k] if isinstance(k, int) else self._map()[k]

    def keys(self):
        return list(self._c)

    def get(self, k, default=None):
        return self._map().get(k, default)


def _hybrid_factory(cursor):
    cols = [c.name for c in cursor.description] if cursor.description else []
    return lambda values: _HybridRow(cols, values)


class _PgConn:
    """psycopg 연결 래퍼 — execute 시 SQL 을 PG 방언으로 번역. sqlite3.Connection 인터페이스 모사."""

    def __init__(self, raw: psycopg.Connection) -> None:
        self._raw = raw

    def execute(self, sql: str, params: Any = ()):
        return self._raw.execute(_translate(sql), params)

    @property
    def in_transaction(self) -> bool:
        return self._raw.info.transaction_status != psycopg.pq.TransactionStatus.IDLE

    def __getattr__(self, name):
        return getattr(self._raw, name)


@contextmanager
def get_connection() -> Iterator[_PgConn]:
    """PostgreSQL 트랜잭션 컨텍스트 — SQLite get_connection 과 동일 계약."""
    raw = psycopg.connect(PG_DSN, autocommit=True, row_factory=_hybrid_factory)
    conn = _PgConn(raw)
    try:
        yield conn
        if conn.in_transaction:
            conn.execute("COMMIT")
    except Exception:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    finally:
        raw.close()


def exec_script(raw: psycopg.Connection, sql: str) -> None:
    """여러 문장을 ;로 나눠 순차 실행(psycopg3 는 1 execute = 1 문장). DDL 전용 — 인라인 ; 없음.
    각 문장에서 주석(--) 줄을 걷어낸 뒤 남은 본문만 실행(헤더 주석이 첫 문장에 붙는 문제 회피)."""
    for stmt in sql.split(";"):
        body = "\n".join(
            ln for ln in stmt.splitlines() if not ln.strip().startswith("--")
        ).strip()
        if body:
            raw.execute(body)


def init_db() -> None:
    """PG 백엔드 시작 초기화(멱등): schema_pg.sql 적용 + pg_trgm + 성능 인덱스.
    schema_pg.sql 은 migrate_to_pg.py 가 SQLite 스키마 내성으로 1회 생성한다."""
    raw = psycopg.connect(PG_DSN, autocommit=True, row_factory=_hybrid_factory)
    try:
        # 테이블 리네임(lineage→history)은 schema_pg.sql 의 CREATE IF NOT EXISTS 가 빈 history 를
        # 만들기 전에 처리(SQLite _pre_migrate 와 동형). 존재할 때만, best-effort.
        try:
            raw.execute("ALTER TABLE IF EXISTS lineage RENAME TO history")
        except Exception:  # noqa: BLE001 — 이미 history 거나 권한 문제면 조용히 통과
            pass
        if SCHEMA_PG_PATH.exists():
            exec_script(raw, SCHEMA_PG_PATH.read_text(encoding="utf-8"))
        ensure_indexes(raw)
    finally:
        raw.close()


def ensure_indexes(raw: psycopg.Connection) -> None:
    """Phase 0/1 성능 인덱스의 PG 대응(멱등). 검색은 FTS5 대신 pg_trgm GIN + ILIKE."""
    raw.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    stmts = [
        "CREATE INDEX IF NOT EXISTS idx_generation_keyset ON generation(sort_ts DESC, id DESC)",
        "CREATE INDEX IF NOT EXISTS idx_generation_color ON generation(color)",
        "CREATE INDEX IF NOT EXISTS idx_generation_status ON generation(status)",
        "CREATE INDEX IF NOT EXISTS idx_generation_project ON generation(project_id)",
        "CREATE INDEX IF NOT EXISTS idx_gentag_tag ON gen_tag(tag_id, generation_id)",
        "CREATE INDEX IF NOT EXISTS idx_genautotag_tag ON gen_auto_tag(auto_tag_id, generation_id)",
        "CREATE INDEX IF NOT EXISTS idx_share_gen ON share(generation_id)",
        # 부분일치 검색 가속(FTS5 trigram 대체) — ILIKE '%..%' 를 GIN trgm 인덱스가 받침.
        "CREATE INDEX IF NOT EXISTS idx_generation_prompt_trgm ON generation USING gin (prompt gin_trgm_ops)",
        "CREATE INDEX IF NOT EXISTS idx_generation_srcname_trgm ON generation USING gin (source_name gin_trgm_ops)",
    ]
    for s in stmts:
        raw.execute(s)
