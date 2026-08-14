# -*- coding: utf-8 -*-
"""워크스페이스 등록부 유령 행 정리 도구.

힉스필드에서 워크스페이스를 지웠다 다시 만들면 id가 바뀌어, 등록부(workspace_registry)에
"이름은 같고 id가 다른" 옛 행이 남는다(접근 가능 멤버 0명). 등록부는 행을 지우지 않으므로
프로젝트 설정 드롭다운에 같은 이름이 2개로 보이는 원인이 된다.

유령 판정(전부 만족해야 삭제 후보):
  1) is_available=1 인 workspace_member 가 하나도 없다(현재 아무의 CLI 목록에도 없음).
  2) DB 안에서 workspace_id 컬럼을 가진 다른 어떤 테이블도 이 id 를 참조하지 않는다
     (project·generation 등 — 테이블 목록은 스키마에서 동적으로 찾으므로 누락 없음).

기본은 미리보기(삭제 없음). 실제 삭제는 --apply 를 붙였을 때만 하며,
삭제는 workspace_member(잔여 비활성 멤버십) → workspace_registry 순서로 한 트랜잭션.

사용(서버 PC, 저장소 루트에서):
  run_py.bat tools\\cleanup_workspace_registry.py            # 미리보기
  run_py.bat tools\\cleanup_workspace_registry.py --apply    # 실제 삭제
  다른 DB 경로: --db <경로>  (기본: backend/data/db/content_hub.db)
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

DEFAULT_DB = Path(__file__).resolve().parents[1] / "backend" / "data" / "db" / "content_hub.db"


def tables_with_workspace_id(conn: sqlite3.Connection) -> list[str]:
    """workspace_id 컬럼을 가진 테이블 전부(등록부·멤버 테이블 제외) — 참조 검사 대상."""
    out: list[str] = []
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    for (table,) in rows:
        if table in ("workspace_registry", "workspace_member"):
            continue
        cols = [c[1] for c in conn.execute(f'PRAGMA table_info("{table}")').fetchall()]
        if "workspace_id" in cols:
            out.append(table)
    return out


def find_ghosts(conn: sqlite3.Connection) -> list[dict]:
    ref_tables = tables_with_workspace_id(conn)
    ghosts: list[dict] = []
    rows = conn.execute(
        "SELECT w.id, w.name, w.plan_type, w.credits, w.last_seen_at, "
        "  (SELECT COUNT(*) FROM workspace_member m WHERE m.workspace_id=w.id) AS member_rows, "
        "  (SELECT COUNT(*) FROM workspace_member m WHERE m.workspace_id=w.id AND m.is_available=1) AS available_members "
        "FROM workspace_registry w ORDER BY w.name COLLATE NOCASE"
    ).fetchall()
    for row in rows:
        entry = dict(row)
        refs = {}
        for table in ref_tables:
            n = conn.execute(
                f'SELECT COUNT(*) FROM "{table}" WHERE workspace_id=?', (entry["id"],)
            ).fetchone()[0]
            if n:
                refs[table] = n
        entry["refs"] = refs
        entry["is_ghost"] = entry["available_members"] == 0 and not refs
        ghosts.append(entry)
    return ghosts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="workspace_registry 유령 행 정리")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="content DB 경로")
    parser.add_argument("--apply", action="store_true", help="실제 삭제 실행(기본은 미리보기)")
    args = parser.parse_args(argv)

    if not args.db.is_file():
        print(f"[ERROR] DB 파일이 없습니다: {args.db}")
        return 1

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    try:
        entries = find_ghosts(conn)
        if not entries:
            print("등록부가 비어 있습니다 — 할 일 없음.")
            return 0

        print(f"DB: {args.db}")
        print(f"{'상태':<6} {'이름':<20} {'멤버(가용/전체)':<14} 참조  id")
        for e in entries:
            status = "유령" if e["is_ghost"] else "유지"
            refs = ", ".join(f"{t}:{n}" for t, n in e["refs"].items()) or "-"
            print(
                f"{status:<6} {e['name']:<20} {e['available_members']}/{e['member_rows']:<12} "
                f"{refs}  {e['id']}"
            )

        targets = [e for e in entries if e["is_ghost"]]
        if not targets:
            print("\n삭제할 유령 행이 없습니다.")
            return 0

        if not args.apply:
            print(f"\n[미리보기] 유령 {len(targets)}건 — 실제 삭제하려면 --apply 를 붙여 다시 실행하세요.")
            return 0

        with conn:  # 한 트랜잭션 — 중간 실패 시 전체 롤백
            for e in targets:
                conn.execute("DELETE FROM workspace_member WHERE workspace_id=?", (e["id"],))
                conn.execute("DELETE FROM workspace_registry WHERE id=?", (e["id"],))
                print(f"[삭제] {e['name']} ({e['id']})")
        print(f"\n완료 — 유령 {len(targets)}건 삭제. 앱에서 프로젝트 설정을 다시 열면 반영됩니다.")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
