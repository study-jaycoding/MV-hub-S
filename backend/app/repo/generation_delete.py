"""generation 본체와 자식 행을 물리 삭제하는 저수준 저장소 연산.

사용자 삭제는 ``trash.move_to_trash``가 먼저 복구용 스냅샷을 만든 뒤 이 함수를 호출한다.
동기화 중복 정리는 휴지통 없이 직접 호출한다. 이 공용 연산을 독립시켜 generations와 trash가
서로 import하던 순환을 없앤다.
"""

from __future__ import annotations

import sqlite3


def delete_generation_rows(conn: sqlite3.Connection, gen_id: str) -> bool:
    """generation과 관련 자식 행을 현재 트랜잭션에서 모두 제거한다.

    자식 테이블을 추가하면 ``backend/cleanup_orphan_creators.py``의 독립 복사본도 같이 수정한다.
    """
    conn.execute("DELETE FROM share WHERE generation_id=?", (gen_id,))
    conn.execute(
        "DELETE FROM history WHERE parent_gen_id=? OR child_gen_id=?",
        (gen_id, gen_id),
    )
    try:
        conn.execute(
            "DELETE FROM generation_comment_seen WHERE comment_id IN "
            "(SELECT id FROM generation_comment WHERE gen_id=?)",
            (gen_id,),
        )
    except Exception:  # noqa: BLE001 - 구버전 DB에는 seen 테이블이 없을 수 있다.
        pass
    conn.execute("DELETE FROM generation_comment WHERE gen_id=?", (gen_id,))
    conn.execute("DELETE FROM generation_comment_read WHERE gen_id=?", (gen_id,))
    conn.execute("DELETE FROM gen_tag WHERE generation_id=?", (gen_id,))
    conn.execute("DELETE FROM gen_auto_tag WHERE generation_id=?", (gen_id,))
    conn.execute("DELETE FROM gen_reference WHERE generation_id=?", (gen_id,))
    conn.execute("DELETE FROM asset WHERE generation_id=?", (gen_id,))
    return conn.execute("DELETE FROM generation WHERE id=?", (gen_id,)).rowcount > 0
