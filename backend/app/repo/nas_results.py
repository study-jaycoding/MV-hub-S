"""결과물 훑기 스냅샷(docs/NAS_RESULTS.md) — 서버 content DB 의 nas_result_scan·nas_result_file.

스냅샷은 '훑기 시작 때의 루트'에 묶인다. 바꾸기는 완주한 훑기만, 그리고 **지금 루트가 시작 루트와 같을 때만**
(호출자가 같은 트랜잭션에서 current_root 로 다시 본다). 조회도 지금 루트로 만든 스냅샷만 돌려준다.
"""

from __future__ import annotations

import sqlite3
from typing import Any, Iterable

_FILE_COLS = ("path", "bytes", "mtime_ns", "head_sha", "hf_job_id", "mv_job_id", "mv_gen_id", "id_conflict", "status")


def current_root(conn: sqlite3.Connection, project_id: str) -> str:
    """프로젝트의 지금 루트(원문) — services/project_folders.effective_root_path 와 같은 규칙(팀 공유값 우선,
    없으면 레거시 로컬 링크)을 **호출자의 트랜잭션 안에서** 읽는다."""
    row = conn.execute("SELECT render_root_path FROM project WHERE id=?", (project_id,)).fetchone()
    shared = (row[0] if row and row[0] else "").strip()
    if shared:
        return shared
    try:
        row = conn.execute("SELECT root_path FROM project_folder_link WHERE project_id=?", (project_id,)).fetchone()
    except sqlite3.OperationalError:  # PM 사이드카 표가 아직 없는 DB
        return ""
    return (row[0] if row and row[0] else "").strip()


def replace_snapshot(
    conn: sqlite3.Connection,
    project_id: str,
    scan_id: str,
    root: str,
    runner: str,
    files: Iterable[dict[str, Any]],
    finished_at: str,
) -> int:
    """프로젝트 스냅샷을 통째로 바꾼다(호출자가 BEGIN·루트 재확인을 맡는다)."""
    conn.execute("DELETE FROM nas_result_file WHERE project_id=?", (project_id,))
    rows = [(project_id, scan_id, *(f.get(col) for col in _FILE_COLS)) for f in files]
    conn.executemany(
        f"INSERT INTO nas_result_file(project_id, scan_id, {', '.join(_FILE_COLS)}) "
        f"VALUES({', '.join('?' for _ in range(len(_FILE_COLS) + 2))})",
        rows,
    )
    conn.execute(
        "INSERT INTO nas_result_scan(project_id, scan_id, root, runner, files, finished_at) VALUES(?,?,?,?,?,?) "
        "ON CONFLICT(project_id) DO UPDATE SET scan_id=excluded.scan_id, root=excluded.root, runner=excluded.runner, "
        "files=excluded.files, finished_at=excluded.finished_at",
        (project_id, scan_id, root, runner, len(rows), finished_at),
    )
    return len(rows)


def snapshot(conn: sqlite3.Connection, project_id: str, root: str) -> list[dict[str, Any]]:
    """지금 루트(root)로 만든 스냅샷의 파일들. 루트가 바뀌었으면 빈 목록(다음 완주까지 쓰지 않는다)."""
    scan = conn.execute(
        "SELECT scan_id, root FROM nas_result_scan WHERE project_id=?", (project_id,)
    ).fetchone()
    if scan is None or scan[1] != root:
        return []
    cur = conn.execute(
        f"SELECT {', '.join(_FILE_COLS)} FROM nas_result_file WHERE project_id=? AND scan_id=? ORDER BY path",
        (project_id, scan[0]),
    )
    return [dict(zip(_FILE_COLS, row)) for row in cur.fetchall()]
