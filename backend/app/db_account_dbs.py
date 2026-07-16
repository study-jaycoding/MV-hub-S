"""계정별 DB 순수 헬퍼 — 기본 작업자 시드·레거시 소유자 판별·sqlite 일관 복사.

db.py 에서 분리(순수 재조직). init_db·경로 상수(get_db_path/ensure_account_db/_migrate_db_location)에
의존하지 않는 자족 헬퍼만 모은다(config·sqlite3 만 import → db.py 와 순환 없음). db.py 가 이들을
re-import 해 ensure_account_db 오케스트레이션과 외부(db_transfer.py 의 db._copy_sqlite)에 노출한다.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Optional

from . import config


def _seed_default_worker(path: Path) -> None:
    """새 계정 DB 에 기본 작업자('me') 행을 넣는다(멱등). generation.worker_id 는
    worker(id) 를 NOT NULL 참조하므로, 이 행이 없으면 첫 generation INSERT 가
    'FOREIGN KEY constraint failed'(500) 로 깨진다. startup 의 ensure_default_worker 는
    그 시점 활성 DB 에만 적용돼, 로그인 때 새로 만든 계정 DB 는 비어 있었다."""
    try:
        c = sqlite3.connect(str(path))
        try:
            c.execute(
                "INSERT INTO worker(id, name, account_type) VALUES(?,?,?) "
                "ON CONFLICT(id) DO NOTHING",
                (config.DEFAULT_WORKER_ID, config.DEFAULT_WORKER_NAME, "personal"),
            )
            c.commit()
        finally:
            c.close()
    except sqlite3.DatabaseError:
        pass


def _legacy_owner(legacy: Path) -> Optional[str]:
    """레거시 DB 의 소유자 creator_uid 판별 — **강한 소유 신호만** 사용:
    ① my_creator_uid 설정 ② 로컬 생성본(id<>job_id = 이 허브가 직접 만든 것)의 creator_uid.

    ⚠️ '최다 creator_uid' 다수결은 일부러 쓰지 않는다 — 남의 공유 번들을 많이 동기화한 DB 라면
    그 남(teammate)의 uid 가 최다라서, 그 사람이 같은 PC 로 로그인하면 이 PC 주인의 사적 작업까지
    그 사람 계정 DB 로 복사되는 '교차 계정 누출'이 난다. id<>job_id 는 '이 PC 가 직접 생성' 한
    것이라 기계 주인의 확실한 표식이다(동기화본 id==job_id 와 구분). 둘 다 못 정하면 None(이관 안 함
    = 빈 DB 가 더 안전하다 — 잘못된 계정으로의 이관보다)."""
    try:
        c = sqlite3.connect(str(legacy))
        try:
            row = c.execute(
                "SELECT value FROM app_setting WHERE key='my_creator_uid'"
            ).fetchone()
            if row and row[0]:
                return row[0]
            row = c.execute(
                "SELECT creator_uid FROM generation "
                "WHERE id<>job_id AND job_id IS NOT NULL AND creator_uid IS NOT NULL LIMIT 1"
            ).fetchone()
            return row[0] if row and row[0] else None
        finally:
            c.close()
    except sqlite3.DatabaseError:
        return None


def _copy_sqlite(src: Path, dst: Path) -> None:
    """sqlite backup API 로 일관 복사(WAL 상태 무관 완전 스냅샷)."""
    s = sqlite3.connect(str(src))
    try:
        d = sqlite3.connect(str(dst))
        try:
            s.backup(d)
        finally:
            d.close()
    finally:
        s.close()
