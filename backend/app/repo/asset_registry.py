"""에셋 대장(2026-09-30) — 대장 표 읽기·쓰기와 훑기 결과 반영(정체 판정). 설계: docs/ASSET_REGISTRY.md.

공유 서버가 권위다. 이 모듈은 DB 만 다룬다 — NAS 는 자식 프로세스(services/asset_registry_scan.py)가 읽고,
부모(services/asset_registry.py)가 그 결과를 plan_changes → apply_plan 으로 한 트랜잭션에 반영한다.

정체 규칙(Codex 합의):
  · 같은 경로 = 같은 논리 파일. 내용이 바뀌면 같은 번호의 새 판(edited).
  · 이동·이름 변경(moved)은 '루트 목록을 끝까지 읽었고(complete) 미판정·대기 파일이 하나도 없는(clean)' 훑기에서,
    같은 지문으로 사라진 것 1개와 새로 생긴 것 1개가 각각 유일할 때만 잇는다. 애매하면 새 번호 — 틀린 연결보다 끊김.
  · missing 은 clean 훑기에서 연속 MISSING_AFTER 번 없을 때만. 미판정 파일이 있으면 카운터를 올리지 않는다
    (그 미판정 파일이 사라진 파일의 이동 목적지일 수 있다).
  · complete 가 아니면(루트 목록 실패·시간 초과·자식 비정상 종료) 결과 전체를 버린다.
"""

from __future__ import annotations

import sqlite3
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

__all__ = [
    "MISSING_AFTER",
    "RegistryFile",
    "RegistryScan",
    "plan_changes",
    "apply_plan",
    "registry_rows",
    "record_scan",
    "scan_rows",
    "registry_counts",
    "lookup_ids",
    "lookup_shas",
    "lookup_tails",
    "resolve_reference_asset_id",
    "attach_reference_registry",
    "backfill_reference_links",
    "reference_usage",
    "tail_matches",
]

MISSING_AFTER = 2  # clean 훑기에서 연속 몇 번 없어야 missing 인가


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parts(path: str) -> list[str]:
    return [part for part in path.replace("\\", "/").casefold().split("/") if part]


def tail_matches(a: str, b: str) -> bool:
    """경로 끝 두 조각 이상이 같은가(양방향) — 같은 폴더를 사람마다 다른 깊이로 등록해도 같은 파일로 본다.
    assets.py 의 경로 일치와 같은 규칙이다(한 조각=이름뿐은 근거가 없어 넣지 않는다)."""
    pa, pb = _parts(a), _parts(b)
    k = min(len(pa), len(pb))
    return k >= 2 and pa[-k:] == pb[-k:]


@dataclass(frozen=True)
class RegistryFile:
    """자식이 본 파일 하나. status: ok(안정적으로 읽혀 지문 있음) · undetermined(잠김·읽기 실패·0바이트·
    읽는 중 바뀜) · pending(이번 예산에서 지문을 못 냄 — 다음 주기)."""

    path: str
    bytes: int
    mtime_ns: int
    sha256: Optional[str]
    status: str


@dataclass
class RegistryScan:
    complete: bool
    files: list[RegistryFile] = field(default_factory=list)

    @property
    def clean(self) -> bool:
        return self.complete and all(f.status == "ok" for f in self.files)


def registry_rows(conn: sqlite3.Connection, project_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT registry_asset_id, path, path_cf, sha256, bytes, mtime_ns, state, miss_count "
        "FROM asset_registry WHERE project_id=?",
        (project_id,),
    ).fetchall()
    return [dict(zip(("registry_asset_id", "path", "path_cf", "sha256", "bytes", "mtime_ns", "state", "miss_count"), r))
            for r in rows]


def plan_changes(prev_rows: list[dict[str, Any]], scan: RegistryScan) -> dict[str, list]:
    """훑기 결과 → 바꿀 것. 순수 함수(시험하기 쉽게). 반환: inserts·updates·events 목록."""
    plan: dict[str, list] = {"inserts": [], "updates": [], "events": []}
    if not scan.complete:
        return plan
    by_path = {r["path"]: r for r in prev_rows}
    by_cf: dict[str, list[dict[str, Any]]] = {}
    for r in prev_rows:
        by_cf.setdefault(r["path_cf"], []).append(r)
    matched: set[str] = set()
    new_files: list[RegistryFile] = []

    for f in scan.files:
        row = by_path.get(f.path)
        if row is None:
            same_cf = by_cf.get(f.path.casefold()) or []
            row = same_cf[0] if len(same_cf) == 1 and same_cf[0]["registry_asset_id"] not in matched else None
        if row is None:
            if f.status == "ok":
                new_files.append(f)
            continue  # 미판정·대기 새 파일은 아직 등록하지 않는다
        matched.add(row["registry_asset_id"])
        change: dict[str, Any] = {}
        if row["path"] != f.path:  # 대소문자만 바뀐 이름
            change.update(path=f.path, path_cf=f.path.casefold(), name_cf=f.path.rsplit("/", 1)[-1].casefold())
        if row["miss_count"]:
            change["miss_count"] = 0
        if f.status == "ok":
            if row["sha256"] != f.sha256 or row["bytes"] != f.bytes:
                change.update(sha256=f.sha256, bytes=f.bytes, mtime_ns=f.mtime_ns)
                plan["events"].append((row["registry_asset_id"], "edited", f.path, None, f.sha256, f.bytes))
            elif row["mtime_ns"] != f.mtime_ns:
                change["mtime_ns"] = f.mtime_ns
            if row["state"] == "missing":
                change.update(state="present", missing_since=None)
                plan["events"].append((row["registry_asset_id"], "back", f.path, None, f.sha256, f.bytes))
        if change:
            plan["updates"].append((row["registry_asset_id"], change))

    vanished = [r for r in prev_rows if r["state"] == "present" and r["registry_asset_id"] not in matched]
    if scan.clean:
        gone_by_sha: dict[tuple[str, int], list[dict[str, Any]]] = {}
        for r in vanished:
            gone_by_sha.setdefault((r["sha256"], r["bytes"]), []).append(r)
        new_by_sha: dict[tuple[str, int], list[RegistryFile]] = {}
        for f in new_files:
            new_by_sha.setdefault((f.sha256 or "", f.bytes), []).append(f)
        moved_ids: set[str] = set()
        moved_files: set[int] = set()
        for key, gone in gone_by_sha.items():
            arrived = new_by_sha.get(key) or []
            if len(gone) == 1 and len(arrived) == 1:
                row, f = gone[0], arrived[0]
                plan["updates"].append((row["registry_asset_id"], {
                    "path": f.path, "path_cf": f.path.casefold(), "name_cf": f.path.rsplit("/", 1)[-1].casefold(),
                    "mtime_ns": f.mtime_ns, "miss_count": 0,
                }))
                plan["events"].append((row["registry_asset_id"], "moved", f.path, row["path"], f.sha256, f.bytes))
                moved_ids.add(row["registry_asset_id"])
                moved_files.add(id(f))
        for r in vanished:
            if r["registry_asset_id"] in moved_ids:
                continue
            count = int(r["miss_count"] or 0) + 1
            if count >= MISSING_AFTER:
                plan["updates"].append((r["registry_asset_id"], {"miss_count": count, "state": "missing", "missing_since": "@now"}))
                plan["events"].append((r["registry_asset_id"], "missing", r["path"], None, r["sha256"], r["bytes"]))
            else:
                plan["updates"].append((r["registry_asset_id"], {"miss_count": count}))
        new_files = [f for f in new_files if id(f) not in moved_files]
    # clean 이 아니면 이동·missing 은 보류하고, 안정적으로 읽힌 새 경로만 새 번호로 등록한다.
    for f in new_files:
        rid = uuid.uuid4().hex
        plan["inserts"].append((rid, f))
        plan["events"].append((rid, "new", f.path, None, f.sha256, f.bytes))
    return plan


def apply_plan(conn: sqlite3.Connection, project_id: str, plan: dict[str, list], now: Optional[str] = None) -> dict[str, int]:
    """plan_changes 의 결과를 쓴다. 트랜잭션은 부르는 쪽이 연다(BEGIN IMMEDIATE — 한 번에 원자 반영)."""
    now = now or utc_now()
    for rid, f in plan["inserts"]:
        conn.execute(
            "INSERT INTO asset_registry(registry_asset_id, project_id, path, path_cf, name_cf, sha256, bytes, mtime_ns, "
            "state, miss_count, first_seen, last_seen, updated_at) VALUES(?,?,?,?,?,?,?,?,'present',0,?,?,?)",
            (rid, project_id, f.path, f.path.casefold(), f.path.rsplit("/", 1)[-1].casefold(), f.sha256, f.bytes,
             f.mtime_ns, now, now, now),
        )
    for rid, change in plan["updates"]:
        fields = {k: (now if v == "@now" else v) for k, v in change.items()}
        fields["updated_at"] = now
        if set(change) - {"miss_count", "mtime_ns"}:  # 실제 상태가 바뀐 것만 last_seen 을 올린다
            fields["last_seen"] = now
        cols = ", ".join(f"{k}=?" for k in fields)
        conn.execute(f"UPDATE asset_registry SET {cols} WHERE registry_asset_id=?", (*fields.values(), rid))
    for rid, kind, path, old_path, sha, size in plan["events"]:
        conn.execute(
            "INSERT INTO asset_registry_event(registry_asset_id, kind, project_id, path, old_path, sha256, bytes, at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (rid, kind, project_id, path, old_path, sha, size, now),
        )
    kinds: dict[str, int] = {}
    for event in plan["events"]:
        kinds[event[1]] = kinds.get(event[1], 0) + 1
    return kinds


_SCAN_FIELDS = ("root", "state", "started_at", "finished_at", "complete", "clean", "files", "hashed",
                "hashed_bytes", "undetermined", "pending", "elapsed_ms", "note")


def record_scan(conn: sqlite3.Connection, project_id: str, **fields: Any) -> None:
    """프로젝트마다 마지막 훑기 결과 한 줄을 덮어쓴다."""
    values = {k: fields.get(k) for k in _SCAN_FIELDS}
    for k in ("complete", "clean", "files", "hashed", "hashed_bytes", "undetermined", "pending", "elapsed_ms"):
        values[k] = int(values[k] or 0)
    conn.execute(
        f"INSERT INTO asset_registry_scan(project_id, {', '.join(_SCAN_FIELDS)}) "
        f"VALUES(?{', ?' * len(_SCAN_FIELDS)}) ON CONFLICT(project_id) DO UPDATE SET "
        + ", ".join(f"{k}=excluded.{k}" for k in _SCAN_FIELDS),
        (project_id, *values.values()),
    )


def scan_rows(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    cur = conn.execute(f"SELECT project_id, {', '.join(_SCAN_FIELDS)} FROM asset_registry_scan ORDER BY project_id")
    names = [d[0] for d in cur.description]
    return [dict(zip(names, r)) for r in cur.fetchall()]


def registry_counts(conn: sqlite3.Connection) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {}
    for pid, state, n in conn.execute(
        "SELECT project_id, state, COUNT(*) FROM asset_registry GROUP BY project_id, state"
    ):
        out.setdefault(pid, {})[state] = n
    return out


_ROW_COLS = ("registry_asset_id", "project_id", "path", "sha256", "bytes", "mtime_ns", "state")


def _rows(conn: sqlite3.Connection, where: str, args: Iterable[Any], visible: Optional[set[str]]) -> list[dict[str, Any]]:
    sql = f"SELECT {', '.join(_ROW_COLS)} FROM asset_registry WHERE {where}"
    rows = [dict(zip(_ROW_COLS, r)) for r in conn.execute(sql, tuple(args)).fetchall()]
    # 안 보이는 프로젝트는 번호·지문·경로 어느 것으로 물어도 똑같이 '없음'이다(존재·후보 수도 알리지 않는다).
    return rows if visible is None else [r for r in rows if r["project_id"] in visible]


def lookup_ids(conn: sqlite3.Connection, ids: Iterable[str], visible: Optional[set[str]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for rid in dict.fromkeys(i for i in ids if i):
        rows = _rows(conn, "registry_asset_id=?", (rid,), visible)
        if rows:
            out[rid] = rows[0]
    return out


def lookup_shas(
    conn: sqlite3.Connection, pairs: Iterable[tuple[str, int]], visible: Optional[set[str]]
) -> dict[str, list[dict[str, Any]]]:
    """지문(sha256+bytes) → 지금 있는(present) 대장 행들."""
    out: dict[str, list[dict[str, Any]]] = {}
    for sha, size in dict.fromkeys((s, int(b)) for s, b in pairs if s and b):
        out[sha] = _rows(conn, "sha256=? AND bytes=? AND state='present'", (sha, size), visible)
    return out


def lookup_tails(conn: sqlite3.Connection, tails: Iterable[str], visible: Optional[set[str]]) -> dict[str, list[dict[str, Any]]]:
    """경로 끝(두 조각 이상) → 지금 있는 대장 행들. 지금 경로와 '옮기기 전 경로'(moved 이력) 둘 다 본다 —
    이름을 바꾸거나 옮긴 파일을 옛 경로 참조로 찾는 길이다."""
    wanted = [t for t in dict.fromkeys(tails) if len(_parts(t)) >= 2]
    out: dict[str, list[dict[str, Any]]] = {t: [] for t in wanted}
    if not wanted:
        return out
    moves = conn.execute(
        "SELECT registry_asset_id, old_path FROM asset_registry_event WHERE kind='moved' AND old_path IS NOT NULL"
    ).fetchall()
    for tail in wanted:
        name = _parts(tail)[-1]
        hits = {r["registry_asset_id"]: r for r in _rows(conn, "name_cf=? AND state='present'", (name,), visible)
                if tail_matches(tail, r["path"])}
        moved_ids = [rid for rid, old in moves if tail_matches(tail, old)]
        if moved_ids:
            for r in lookup_ids(conn, moved_ids, visible).values():
                if r["state"] == "present":
                    hits.setdefault(r["registry_asset_id"], r)
        out[tail] = list(hits.values())
    return out


def _token_parts(file_path: str) -> tuple[str, str]:
    head, sep, rest = (file_path or "").partition("|")
    return (head[len("asset:"):], rest) if head.startswith("asset:") and sep else ("", "")


def resolve_reference_asset_id(
    conn: sqlite3.Connection, content_sha: Optional[str], content_bytes: Optional[int], file_path: str = ""
) -> Optional[str]:
    """레퍼런스가 쓴 판(지문)으로 대장 번호를 찾는다 — 생성 기록(provenance)용.
    같은 내용이 여러 곳(복사본)이면 참조 경로(asset:<이름>|<경로>)의 끝이 맞는 것이 **하나**일 때만 고른다."""
    if not content_sha or not content_bytes:
        return None
    rows = lookup_shas(conn, [(content_sha, int(content_bytes))], None).get(content_sha) or []
    if len(rows) == 1:
        return rows[0]["registry_asset_id"]
    _name, rest = _token_parts(file_path)
    near = [r for r in rows if rest and tail_matches(rest, r["path"])]
    return near[0]["registry_asset_id"] if len(near) == 1 else None


def attach_reference_registry(conn: sqlite3.Connection, reference_id: str) -> Optional[str]:
    """reference 행에 지문이 있고 번호가 비어 있으면 대장에서 찾아 붙인다(version_verified=1). 붙인 번호를 돌려준다."""
    row = conn.execute(
        "SELECT content_sha, content_bytes, file_path, registry_asset_id FROM reference WHERE id=?", (reference_id,)
    ).fetchone()
    if not row or row[3]:
        return row[3] if row else None
    rid = resolve_reference_asset_id(conn, row[0], row[1], row[2] or "")
    if rid:
        conn.execute(
            "UPDATE reference SET registry_asset_id=?, version_verified=1 WHERE id=? AND registry_asset_id IS NULL",
            (rid, reference_id),
        )
    return rid


def backfill_reference_links(conn: sqlite3.Connection, complete_projects: dict[str, str]) -> dict[str, int]:
    """번호 없는 옛 레퍼런스 기록에 번호를 붙인다(Codex 합의 — 조건부).
      · 지문이 있으면 지문으로(판 확인 = version_verified 1).
      · 지문이 없으면 'asset:<프로젝트 이름>|<경로>' 의 이름이 **완주한 PM 프로젝트 이름 하나**와 정확히 같고,
        그 프로젝트 대장에 **그 경로 그대로** 있는 파일이 하나일 때만 '가능 연결'(version_verified 0).
        옛 경로 이력·이름·다른 이름의 프로젝트로는 채우지 않는다(그때 어느 판이었는지 모른다).
    complete_projects: 이름 → project_id (clean·complete 훑기를 마친 프로젝트만)."""
    verified = possible = 0
    # 이 이름들의 토큰이거나 지문이 있는 행만 본다 — 훑기마다 레퍼런스 전체를 다시 읽지 않게.
    # (LIKE 의 _·% 는 넓게 걸릴 뿐이고, 아래에서 이름을 정확히 다시 대조한다.)
    names = [n for n in complete_projects if n]
    like = " OR ".join("file_path LIKE ?" for _ in names)
    where = "registry_asset_id IS NULL AND (content_sha IS NOT NULL" + (f" OR {like})" if like else ")")
    for ref_id, sha, size, fp in conn.execute(
        f"SELECT id, content_sha, content_bytes, file_path FROM reference WHERE {where}",
        tuple(f"asset:{n}|%" for n in names),
    ).fetchall():
        if sha and size:
            rid = resolve_reference_asset_id(conn, sha, size, fp or "")
            if rid:
                conn.execute("UPDATE reference SET registry_asset_id=?, version_verified=1 WHERE id=?", (rid, ref_id))
                verified += 1
            continue
        name, rest = _token_parts(fp or "")
        pid = complete_projects.get(name)
        if not pid or not rest:
            continue
        rows = conn.execute(
            "SELECT registry_asset_id FROM asset_registry WHERE project_id=? AND path=? AND state='present'",
            (pid, rest),
        ).fetchall()
        if len(rows) == 1:
            conn.execute("UPDATE reference SET registry_asset_id=?, version_verified=0 WHERE id=?", (rows[0][0], ref_id))
            possible += 1
    return {"verified": verified, "possible": possible}


def reference_usage(conn: sqlite3.Connection, registry_asset_id: str) -> list[dict[str, Any]]:
    """이 대장 번호를 쓴 생성 기록 — 판 확인(1)과 가능 연결(0)을 나눠 돌려준다(섞지 않는다)."""
    cur = conn.execute(
        "SELECT g.id, g.project_id, g.created_at, r.version_verified, r.content_sha "
        "FROM reference r JOIN gen_reference gr ON gr.reference_id = r.id JOIN generation g ON g.id = gr.generation_id "
        "WHERE r.registry_asset_id=? ORDER BY g.created_at DESC",
        (registry_asset_id,),
    )
    seen: dict[str, dict[str, Any]] = {}
    for gid, pid, created, verified, sha in cur.fetchall():
        item = seen.setdefault(gid, {"generation_id": gid, "project_id": pid, "created_at": created,
                                     "version_verified": verified, "content_sha": sha})
        if verified == 1:
            item["version_verified"] = 1
    return list(seen.values())
