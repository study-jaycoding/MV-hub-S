"""Ask Agent 칸 기록 — 신원(허브·DB 경로·계정)마다 따로인 SQLite 파일. 콘텐츠 DB·백업과 무관하다.

진행 중(`running`·`cancelling`) 차례는 파일 하나에 하나만 — 부분 유일 인덱스가 막는다. 사건은 순번을 먼저 저장한 뒤
대기자를 깨운다(services/agent_chat). 이 프로세스가 파일을 처음 열 때 앞 프로세스가 남긴 진행 중 차례는 `interrupted`.
"""
from __future__ import annotations

import contextlib
import json
import sqlite3
import threading
import uuid
from pathlib import Path

ACTIVE = ("running", "cancelling")
_SCHEMA = """
CREATE TABLE IF NOT EXISTS agent_chat_conversation (
    id TEXT PRIMARY KEY,
    engine TEXT NOT NULL,
    model TEXT NOT NULL,
    effort TEXT NOT NULL,
    cli_session_id TEXT,
    client_id TEXT NOT NULL,
    mcp_entry TEXT NOT NULL,
    title TEXT NOT NULL,
    resumable INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS agent_chat_turn (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES agent_chat_conversation(id),
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    text TEXT NOT NULL,
    context TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_chat_turn_active ON agent_chat_turn((1)) WHERE status IN ('running','cancelling');
CREATE INDEX IF NOT EXISTS idx_agent_chat_turn_conversation ON agent_chat_turn(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS agent_chat_event (
    turn_id TEXT NOT NULL REFERENCES agent_chat_turn(id),
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (turn_id, seq)
);
CREATE TABLE IF NOT EXISTS agent_chat_plan_binding (
    plan_id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL REFERENCES agent_chat_turn(id),
    client_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""
_opened: set[str] = set()
_opened_lock = threading.Lock()


class Busy(Exception):
    """이 신원에 진행 중인 차례가 이미 있다."""


@contextlib.contextmanager
def connect(path: Path):
    conn = sqlite3.connect(str(path), timeout=10, isolation_level=None)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=10000")
        conn.execute("PRAGMA synchronous=NORMAL")  # WAL 이라 커밋마다 디스크 동기화는 필요 없다(칸 기록 — 잃어도 화면 기록일 뿐)
        yield conn
    finally:
        conn.close()


def open_db(path: Path) -> Path:
    """처음 여는 파일이면 표를 만들고 앞 프로세스의 진행 중 차례를 끝난 것으로 정리한다(자동 재실행 없음)."""
    key = str(path).casefold()
    with _opened_lock:
        if key in _opened:
            return path
        path.parent.mkdir(parents=True, exist_ok=True)
        with connect(path) as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(_SCHEMA)
            conn.execute("UPDATE agent_chat_turn SET status='interrupted', reason='restart', ended_at=datetime('now') "
                         "WHERE status IN ('running','cancelling')")
        _opened.add(key)
    return path


def _tx(conn):
    conn.execute("BEGIN IMMEDIATE")


def create_conversation(path, *, engine, model, effort, client_id, mcp_entry, title) -> dict:
    cid = str(uuid.uuid4())
    with connect(path) as conn:
        conn.execute("INSERT INTO agent_chat_conversation(id,engine,model,effort,client_id,mcp_entry,title) VALUES(?,?,?,?,?,?,?)",
                     (cid, engine, model, effort, client_id, json.dumps(mcp_entry, ensure_ascii=False), title[:80]))
    return get_conversation(path, cid)


def get_conversation(path, conversation_id) -> dict | None:
    with connect(path) as conn:
        row = conn.execute("SELECT * FROM agent_chat_conversation WHERE id=?", (conversation_id,)).fetchone()
    if not row:
        return None
    return {**dict(row), "mcp_entry": json.loads(row["mcp_entry"]), "resumable": bool(row["resumable"])}


def list_conversations(path, limit=50) -> list[dict]:
    with connect(path) as conn:
        rows = conn.execute("SELECT id,title,engine,model,effort,updated_at,resumable FROM agent_chat_conversation "
                            "ORDER BY updated_at DESC, rowid DESC LIMIT ?", (limit,)).fetchall()
    return [{**dict(row), "resumable": bool(row["resumable"])} for row in rows]


def update_conversation(path, conversation_id, *, model=None, effort=None, cli_session_id=None, resumable=None) -> None:
    sets, values = ["updated_at=datetime('now')"], []
    for column, value in (("model", model), ("effort", effort), ("cli_session_id", cli_session_id)):
        if value is not None:
            sets.append(f"{column}=?")
            values.append(value)
    if resumable is not None:
        sets.append("resumable=?")
        values.append(int(resumable))
    with connect(path) as conn:
        conn.execute(f"UPDATE agent_chat_conversation SET {','.join(sets)} WHERE id=?", (*values, conversation_id))


def claim_turn(path, *, conversation_id, idempotency_key, text, context) -> tuple[dict, bool]:
    """같은 열쇠면 그 차례를 그대로(새로 실행하지 않음), 진행 중 차례가 있으면 Busy. 원자적으로 선점한다."""
    with connect(path) as conn:
        _tx(conn)
        try:
            row = conn.execute("SELECT * FROM agent_chat_turn WHERE idempotency_key=?", (idempotency_key,)).fetchone()
            if row:
                conn.execute("COMMIT")
                return dict(row), False
            tid = str(uuid.uuid4())
            try:
                conn.execute("INSERT INTO agent_chat_turn(id,conversation_id,idempotency_key,status,text,context) VALUES(?,?,?,?,?,?)",
                             (tid, conversation_id, idempotency_key, "running", text, json.dumps(context, ensure_ascii=False)))
            except sqlite3.IntegrityError as exc:
                conn.execute("ROLLBACK")
                raise Busy() from exc
            conn.execute("UPDATE agent_chat_conversation SET updated_at=datetime('now') WHERE id=?", (conversation_id,))
            conn.execute("COMMIT")
        except Busy:
            raise
        except Exception:
            with contextlib.suppress(sqlite3.Error):
                conn.execute("ROLLBACK")
            raise
    return get_turn(path, tid), True


def turn_by_key(path, idempotency_key) -> dict | None:
    with connect(path) as conn:
        row = conn.execute("SELECT * FROM agent_chat_turn WHERE idempotency_key=?", (idempotency_key,)).fetchone()
    return dict(row) if row else None


def has_active(path) -> bool:
    with connect(path) as conn:
        return conn.execute("SELECT 1 FROM agent_chat_turn WHERE status IN ('running','cancelling') LIMIT 1").fetchone() is not None


def get_turn(path, turn_id) -> dict | None:
    with connect(path) as conn:
        row = conn.execute("SELECT * FROM agent_chat_turn WHERE id=?", (turn_id,)).fetchone()
    return dict(row) if row else None


def turns_for(path, conversation_id) -> list[dict]:
    with connect(path) as conn:
        rows = conn.execute("SELECT id,status,text,reason,created_at,ended_at FROM agent_chat_turn WHERE conversation_id=? "
                            "ORDER BY created_at, rowid", (conversation_id,)).fetchall()
    return [dict(row) for row in rows]


def set_status(path, turn_id, status, *, reason=None, only_from=ACTIVE) -> bool:
    """조건부 전이 — 취소와 정상 종료가 겹쳐도 마지막 상태는 한 번만 정해진다."""
    ended = status not in ACTIVE
    marks = ",".join("?" * len(only_from))
    with connect(path) as conn:
        return bool(conn.execute(
            f"UPDATE agent_chat_turn SET status=?, reason=COALESCE(?,reason), ended_at=CASE WHEN ? THEN datetime('now') ELSE ended_at END "
            f"WHERE id=? AND status IN ({marks})", (status, reason, int(ended), turn_id, *only_from)).rowcount)


def append_event(path, turn_id, kind, payload) -> int:
    with connect(path) as conn:
        _tx(conn)
        try:
            seq = conn.execute("SELECT COALESCE(MAX(seq),0)+1 FROM agent_chat_event WHERE turn_id=?", (turn_id,)).fetchone()[0]
            conn.execute("INSERT INTO agent_chat_event(turn_id,seq,kind,payload) VALUES(?,?,?,?)",
                         (turn_id, seq, kind, json.dumps(payload, ensure_ascii=False)))
            conn.execute("COMMIT")
        except Exception:
            with contextlib.suppress(sqlite3.Error):
                conn.execute("ROLLBACK")
            raise
    return seq


def events_after(path, turn_id, after=0, limit=500) -> list[dict]:
    with connect(path) as conn:
        rows = conn.execute("SELECT seq,kind,payload FROM agent_chat_event WHERE turn_id=? AND seq>? ORDER BY seq LIMIT ?",
                            (turn_id, after, limit)).fetchall()
    return [{"seq": row["seq"], "kind": row["kind"], **json.loads(row["payload"])} for row in rows]


def snapshot(path, turn_id, after=0, limit=500) -> tuple[dict | None, list[dict]]:
    """차례 상태와 사건을 한 읽기 시점(WAL 스냅샷)에서 — '끝남'이 보이면 그 전에 저장된 사건은 모두 함께 보인다."""
    with connect(path) as conn:
        conn.execute("BEGIN")
        try:
            row = conn.execute("SELECT * FROM agent_chat_turn WHERE id=?", (turn_id,)).fetchone()
            rows = conn.execute("SELECT seq,kind,payload FROM agent_chat_event WHERE turn_id=? AND seq>? ORDER BY seq LIMIT ?",
                                (turn_id, after, limit)).fetchall()
        finally:
            conn.execute("COMMIT")
    return (dict(row) if row else None), [{"seq": r["seq"], "kind": r["kind"], **json.loads(r["payload"])} for r in rows]


def bind_plan(path, *, plan_id, turn_id, client_id) -> None:
    with connect(path) as conn:
        conn.execute("INSERT OR IGNORE INTO agent_chat_plan_binding(plan_id,turn_id,client_id) VALUES(?,?,?)",
                     (plan_id, turn_id, client_id))


def binding_for(path, plan_id) -> dict | None:
    with connect(path) as conn:
        row = conn.execute(
            "SELECT b.plan_id, b.turn_id, b.client_id, t.conversation_id FROM agent_chat_plan_binding b "
            "JOIN agent_chat_turn t ON t.id=b.turn_id JOIN agent_chat_conversation c ON c.id=t.conversation_id "
            "WHERE b.plan_id=? AND c.client_id=b.client_id", (plan_id,)).fetchone()
    return dict(row) if row else None
