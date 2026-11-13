"""Ask Agent 칸 기록 — 신원(허브·DB 경로·계정)마다 따로인 SQLite 파일. 전체 복원은 접수 배수 뒤 설치자가 채택한다.

진행 중(`running`·`cancelling`) 차례는 파일 하나에 하나만 — 부분 유일 인덱스가 막는다. 사건은 순번을 먼저 저장한 뒤
대기자를 깨운다(services/agent_chat). 이 프로세스가 파일을 처음 열 때 앞 프로세스가 남긴 진행 중 차례는 `interrupted`.
"""
from __future__ import annotations

import contextlib
import json
import sqlite3
import threading
import time
import uuid
from contextvars import ContextVar
from pathlib import Path

from fastapi import HTTPException

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
# 서랍 메뉴(docs/status/MVAgent_서랍메뉴_2026-11-12.md 2-5) — 처음 열 때 없는 칸만 더한다
_NEW_COLUMNS = {
    "pinned": "INTEGER NOT NULL DEFAULT 0",
    "archived": "INTEGER NOT NULL DEFAULT 0",
    "unread": "INTEGER NOT NULL DEFAULT 0",
    "unread_rev": "INTEGER NOT NULL DEFAULT 0",  # 읽지 않음이 바뀔 때마다 +1 — 늦은 자동 읽음이 뒤의 표시를 못 지우게
    "project_override": "TEXT",  # NULL = 첫 차례 화면의 프로젝트, '' = 프로젝트 없음
    "cli_home": "TEXT",  # 세션을 띄운 때의 Claude 자격 폴더·작업 폴더 — 삭제 때 그 세션 파일만 찾는 근거
    "cli_cwd": "TEXT",
    # 포크(docs/status/MVAgent_포크_2026-11-12.md 2-1) — 원래 세션·누른 때 원래의 마지막 차례·원래 대화·포크 요청 번호
    "fork_session": "TEXT",
    "fork_turn": "TEXT",
    "fork_from": "TEXT",
    "fork_request": "TEXT",
    "restored_from": "TEXT",
    "source_reference": "TEXT",
}
FORK_MAX_TURNS, FORK_MAX_EVENTS = 500, 20_000
# 끌어다 넣기(docs/status/MVAgent_끌어다넣기_2026-11-12.md 2-3) — 차례 표. NULL = 붙인 것 없음, 넣는 모양은 {"workspace", "items"} 하나
_NEW_TURN_COLUMNS = {"attachments": "TEXT"}
_PROJECT = ("CASE WHEN c.project_override IS NULL THEN (SELECT json_extract(t.context,'$.project') FROM agent_chat_turn t "
            "WHERE t.conversation_id=c.id AND json_valid(t.context) AND json_type(t.context,'$.project')='text' "
            "ORDER BY t.created_at, t.rowid LIMIT 1) WHEN c.project_override='' THEN NULL ELSE c.project_override END")
_SUMMARY = ("SELECT c.id,c.title,c.engine,c.model,c.effort,c.updated_at,c.resumable,c.pinned,c.archived,c.unread,c.unread_rev,c.restored_from,"
            " c.cli_session_id AS _sid, c.fork_session AS _fsid, c.fork_turn AS _fturn, c.fork_from AS _ffrom,"
            f" {_PROJECT} AS project FROM agent_chat_conversation c")
_opened: set[str] = set()
_opened_lock = threading.Lock()
_admission = threading.Condition()
_epochs: dict[str, int] = {}
_gates: set[str] = set()
_connections: dict[str, int] = {}
_request_epochs: ContextVar[dict | None] = ContextVar("agent_chat_epochs", default=None)
_restore_owner: ContextVar[frozenset] = ContextVar("agent_chat_restore_owner", default=frozenset())


class StaleRequest(HTTPException):
    def __init__(self):
        super().__init__(503, "대화 기록을 복원 중이거나 요청 뒤 복원되었습니다. 다시 열어 주세요.")


def path_key(path: Path) -> str:
    return str(Path(path).resolve()).casefold()


@contextlib.contextmanager
def request_scope():
    # 최초 요청에서 고정하며 asyncio.to_thread와 명시 copy_context 스레드가 같은 세대를 쓴다.
    with _admission:
        snapshot = dict(_epochs)
        snapshot.update({key: -1 for key in _gates})
    token = _request_epochs.set(snapshot)
    try:
        yield
    finally:
        _request_epochs.reset(token)


def check_current(path: Path) -> None:
    key = path_key(path)
    with _admission:
        if key in _restore_owner.get():
            return
        expected = _request_epochs.get()
        if key in _gates or (expected is not None and expected.get(key, 0) != _epochs.get(key, 0)):
            raise StaleRequest()


def close_admission(paths) -> set[str]:
    keys = {path_key(path) for path in paths}
    with _admission:
        if keys & _gates:
            raise StaleRequest()
        _gates.update(keys)
        for key in keys:
            _epochs[key] = _epochs.get(key, 0) + 1
    return keys


def drain_connections(keys, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    with _admission:
        while any(_connections.get(key, 0) for key in keys):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise StaleRequest()
            _admission.wait(remaining)


def reopen_admission(keys) -> None:
    with _opened_lock:
        _opened.difference_update(keys)
    with _admission:
        _gates.difference_update(keys)
        _admission.notify_all()


class Busy(Exception):
    """이 신원에 진행 중인 차례가 이미 있다."""


class ForkRefused(Exception):
    """포크할 수 없는 대화 — args[0] = codex · no_session · too_long · request_mismatch."""


@contextlib.contextmanager
def connect(path: Path, *, readonly=False):
    key = path_key(path)
    with _admission:
        check_current(path)
        _connections[key] = _connections.get(key, 0) + 1
    conn = None
    try:
        target = f"{Path(path).resolve().as_uri()}?mode=ro" if readonly else str(path)
        conn = sqlite3.connect(target, uri=readonly, timeout=10, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=10000")
        conn.execute("PRAGMA synchronous=FULL")
        yield conn
    finally:
        if conn is not None:
            conn.close()  # 실패하면 count를 남겨 다음 복원이 열린 파일을 교체하지 못하게 한다.
        with _admission:
            _connections[key] -= 1
            _admission.notify_all()


@contextlib.contextmanager
def keep_connection(path: Path):
    """출력을 받는 동안 마지막 연결 종료의 checkpoint가 사건마다 반복되지 않게 한다."""
    with connect(path) as conn:
        cursor = conn.execute("SELECT rootpage FROM sqlite_schema LIMIT 1")
        try:
            cursor.fetchall()
        finally:
            cursor.close()
        yield  # 읽기 거래나 공유할 연결 객체는 남기지 않는다.


def open_db(path: Path, *, recover=True) -> Path:
    """처음 여는 파일이면 표를 만들고(없는 칸은 더하고) 앞 프로세스의 진행 중 차례를 끝난 것으로 정리한다(자동 재실행 없음).
    칸 더하기·정리는 한 IMMEDIATE 트랜잭션 — 성공한 뒤에만 _opened 에 넣는다(실패면 다음 열기에 다시).
    같은 파일을 두 허브가 동시에 쓰는 것은 지원하지 않는다(처음 연 허브가 남은 차례를 끝낸다 — 번갈아 쓰기만)."""
    key = path_key(path)
    with _opened_lock:
        check_current(path)
        if key in _opened:
            return path
        path.parent.mkdir(parents=True, exist_ok=True)
        with connect(path) as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(_SCHEMA)  # 열린 트랜잭션을 커밋해 버리므로 BEGIN 앞에서
            _tx(conn)
            try:
                for table, columns in (("agent_chat_conversation", _NEW_COLUMNS), ("agent_chat_turn", _NEW_TURN_COLUMNS)):
                    have = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
                    for name, decl in columns.items():
                        if name not in have:
                            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
                # 칸을 더한 뒤에 — _SCHEMA 에 두면 옛 파일에서 '그런 칸 없음'으로 멈춘다(포크 설계 Codex 3차 P2)
                conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_chat_fork_request ON agent_chat_conversation(fork_request) "
                             "WHERE fork_request IS NOT NULL")
                if recover:
                    for (turn_id,) in conn.execute("SELECT id FROM agent_chat_turn WHERE status IN ('running','cancelling')").fetchall():
                        _finish(conn, turn_id, "interrupted", "restart", None)
                conn.execute("COMMIT")
            except Exception:
                with contextlib.suppress(sqlite3.Error):
                    conn.execute("ROLLBACK")
                raise
        _opened.add(key)
    return path


def adopt_restored(path: Path, restore_id: str) -> None:
    """설치자가 gate 배수·파일 교체 후 호출한다. 원문 사건/plan_binding은 보존한다."""
    key = path_key(path)
    with _admission:
        if key not in _gates or _connections.get(key, 0):
            raise RuntimeError("Agent restore requires drained admission")
    if not path.is_file():
        raise FileNotFoundError(path)
    token = _restore_owner.set(frozenset({key}))
    try:
        with _opened_lock:
            _opened.discard(key)
        open_db(path, recover=False)
        with connect(path) as conn:
            _tx(conn)
            try:
                conn.execute("UPDATE agent_chat_conversation SET restored_from=?, resumable=0, cli_session_id=NULL, "
                             "cli_home=NULL, cli_cwd=NULL, fork_session=NULL, fork_turn=NULL, fork_from=NULL, fork_request=NULL, "
                             "client_id='', mcp_entry='{}', source_reference=NULL", (restore_id,))
                conn.execute("UPDATE agent_chat_turn SET status='interrupted', reason='restored', ended_at=COALESCE(ended_at,datetime('now')) "
                             "WHERE status IN ('running','cancelling')")
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
    finally:
        _restore_owner.reset(token)


def _tx(conn):
    conn.execute("BEGIN IMMEDIATE")


def _append(conn, turn_id, kind, payload) -> int:
    seq = conn.execute("SELECT COALESCE(MAX(seq),0)+1 FROM agent_chat_event WHERE turn_id=?", (turn_id,)).fetchone()[0]
    conn.execute("INSERT INTO agent_chat_event(turn_id,seq,kind,payload) VALUES(?,?,?,?)",
                 (turn_id, seq, kind, json.dumps(payload, ensure_ascii=False)))
    return seq


def _finish(conn, turn_id, status, reason, error) -> bool:
    """트랜잭션 안에서 — 진행 중인 차례만 끝 상태로, (있으면) 오류 사건·끝남 사건·그 대화의 unread 를 같이 적는다."""
    if not conn.execute("UPDATE agent_chat_turn SET status=?, reason=COALESCE(?,reason), ended_at=datetime('now') "
                        "WHERE id=? AND status IN ('running','cancelling')", (status, reason, turn_id)).rowcount:
        return False
    conversation = conn.execute("SELECT conversation_id FROM agent_chat_turn WHERE id=?", (turn_id,)).fetchone()[0]
    if error:
        _append(conn, turn_id, "error", {"message": error})
    conn.execute("UPDATE agent_chat_conversation SET unread=1, unread_rev=unread_rev+1 WHERE id=?", (conversation,))
    rev = conn.execute("SELECT unread_rev FROM agent_chat_conversation WHERE id=?", (conversation,)).fetchone()
    _append(conn, turn_id, "state", {"status": status, "unread_rev": rev[0] if rev else 0})
    return True


def mark_cancelling(path, turn_id) -> bool:
    """취소 요청 — 진행 중(running)일 때만 cancelling 으로 바꾸고 그 사건을 같은 트랜잭션에(독립 리뷰 P1: 따로 쓰면 끝남 뒤에
    cancelling 사건이 붙거나 지운 차례에 사건이 되살아난다)."""
    with connect(path) as conn:
        _tx(conn)
        try:
            done = bool(conn.execute("UPDATE agent_chat_turn SET status='cancelling' WHERE id=? AND status='running'", (turn_id,)).rowcount)
            if done:
                _append(conn, turn_id, "state", {"status": "cancelling"})
            conn.execute("COMMIT")
        except Exception:
            with contextlib.suppress(sqlite3.Error):
                conn.execute("ROLLBACK")
            raise
    return done


def restore_snapshot(path, conversation_id, event_limit) -> dict | None:
    """대화 복원 — 대화(읽지 않음 포함)·차례·사건을 한 읽기 시점에서(독립 리뷰 P2: 따로 읽으면 끝난 차례와 이전 읽지 않음 값이 같이 온다)."""
    with connect(path) as conn:
        conn.execute("BEGIN")
        try:
            row = conn.execute("SELECT * FROM agent_chat_conversation WHERE id=?", (conversation_id,)).fetchone()
            if not row:
                return None
            fork = _fork_fields(conn, row["engine"], row["resumable"], row["cli_session_id"], row["fork_session"], row["fork_turn"],
                                row["fork_from"])
            turns = [dict(t) for t in conn.execute(
                "SELECT id,status,text,reason,created_at,ended_at,attachments FROM agent_chat_turn WHERE conversation_id=? ORDER BY created_at, rowid",
                (conversation_id,)).fetchall()]
            for turn in turns:
                turn["attachments"] = read_attachments(turn["attachments"])
                turn["events"] = [{"seq": e["seq"], "kind": e["kind"], **json.loads(e["payload"])} for e in conn.execute(
                    "SELECT seq,kind,payload FROM agent_chat_event WHERE turn_id=? ORDER BY seq LIMIT ?", (turn["id"], event_limit)).fetchall()]
        finally:
            conn.execute("COMMIT")
    return {**dict(row), "resumable": bool(row["resumable"]), **fork, "turns": turns}


def finish_turn(path, turn_id, status, *, reason=None, error=None) -> bool:
    """차례 끝 한 번에(설계 2-5) — 상태·오류 사건·끝남 사건·unread 를 한 트랜잭션. 끝남과 삭제가 겹쳐도 사건이 되살아나지 않는다."""
    with connect(path) as conn:
        _tx(conn)
        try:
            done = _finish(conn, turn_id, status, reason, error)
            conn.execute("COMMIT")
        except Exception:
            with contextlib.suppress(sqlite3.Error):
                conn.execute("ROLLBACK")
            raise
    return done


def create_conversation(path, *, engine, model, effort, client_id, mcp_entry, title, conversation_id=None, source_reference=None) -> dict:
    cid = conversation_id or str(uuid.uuid4())
    with connect(path) as conn:
        _insert_conversation(conn, cid, engine=engine, model=model, effort=effort, client_id=client_id,
                             mcp_entry=mcp_entry, title=title, source_reference=source_reference)
    return get_conversation(path, cid)


def _insert_conversation(conn, conversation_id, *, engine, model, effort, client_id, mcp_entry, title, source_reference=None):
    conn.execute("INSERT INTO agent_chat_conversation(id,engine,model,effort,client_id,mcp_entry,title,source_reference) VALUES(?,?,?,?,?,?,?,?)",
                 (conversation_id, engine, model, effort, client_id, json.dumps(mcp_entry, ensure_ascii=False), title[:80],
                  json.dumps(source_reference, ensure_ascii=False) if source_reference else None))


def get_conversation(path, conversation_id) -> dict | None:
    with connect(path) as conn:
        row = conn.execute("SELECT * FROM agent_chat_conversation WHERE id=?", (conversation_id,)).fetchone()
    if not row:
        return None
    return {**dict(row), "mcp_entry": json.loads(row["mcp_entry"]), "resumable": bool(row["resumable"])}


def _fork_state(conn, fork_session, fork_turn, fork_from) -> str:
    """아직 갈라지지 않은 포크가 누른 때 그대로 시작할 수 있나 — 첫 차례 확인(라우터)과 요약이 같이 쓴다(포크 설계 2-2).
    ready = 원래가 있고 세션·마지막 차례(끝난 상태 모두 — 진행 중은 신원 전체 검사로 막힘)가 누른 때와 같음."""
    source = conn.execute("SELECT cli_session_id FROM agent_chat_conversation WHERE id=?", (fork_from,)).fetchone()
    if not source:
        return "source_gone"
    last = conn.execute("SELECT id FROM agent_chat_turn WHERE conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
                        (fork_from,)).fetchone()
    return "ready" if source[0] == fork_session and last is not None and last[0] == fork_turn else "source_changed"


def _fork_fields(conn, engine, resumable, sid, fork_session, fork_turn, fork_from) -> dict:
    """화면이 포크 메뉴·안내를 정하는 값 — can_fork·fork_block(codex·not_resumable·forked_unstarted·no_session)·fork_state."""
    out = {"can_fork": False, "fork_block": None, "fork_state": None}
    if not sid and fork_session and fork_from:
        out["fork_state"] = _fork_state(conn, fork_session, fork_turn, fork_from)
    if engine != "claude":
        out["fork_block"] = "codex"
    elif not resumable:
        out["fork_block"] = "not_resumable"
    elif not sid:
        out["fork_block"] = "forked_unstarted" if fork_session else "no_session"
    else:
        out["can_fork"] = True
    return out


def _summary(row, conn=None) -> dict:
    data = {key: row[key] for key in row.keys() if not key.startswith("_")}  # 세션 id 등 안쪽 칸은 내보내지 않는다
    data.update({key: bool(row[key]) for key in ("resumable", "pinned", "archived", "unread")})
    if conn is not None:
        data.update(_fork_fields(conn, row["engine"], row["resumable"], row["_sid"], row["_fsid"], row["_fturn"], row["_ffrom"]))
    return data


def list_conversations(path, limit=500) -> list[dict]:
    """최근 순 limit 개. project = 옮긴 값(빈 글 = 없음) 아니면 프로젝트를 고른 화면에서 보낸 첫 차례의 project —
    칸 서랍이 묶는다(없으면 null). 보관 대화도 싣는다(화면이 '보관함'으로 묶음)."""
    with connect(path) as conn:
        rows = conn.execute(_SUMMARY + " ORDER BY c.updated_at DESC, c.rowid DESC LIMIT ?", (limit,)).fetchall()
        return [_summary(row, conn) for row in rows]


def conversation_summary(path, conversation_id) -> dict | None:
    with connect(path) as conn:
        row = conn.execute(_SUMMARY + " WHERE c.id=?", (conversation_id,)).fetchone()
        return _summary(row, conn) if row else None


def fork_state_for(path, conversation_id) -> str | None:
    """포크의 첫 차례 전 확인 — 갈라지지 않은 포크면 ready·source_changed·source_gone, 그 밖은 None."""
    with connect(path) as conn:
        row = conn.execute("SELECT cli_session_id,fork_session,fork_turn,fork_from FROM agent_chat_conversation WHERE id=?",
                           (conversation_id,)).fetchone()
        if not row or row["cli_session_id"] or not row["fork_session"] or not row["fork_from"]:
            return None
        return _fork_state(conn, row["fork_session"], row["fork_turn"], row["fork_from"])


def find_fork(path, request_id) -> dict | None:
    """같은 포크 요청 번호로 이미 만든 포크 — {id, fork_from} 또는 None(중복 방지·커밋 여부 확인)."""
    with connect(path) as conn:
        row = conn.execute("SELECT id,fork_from FROM agent_chat_conversation WHERE fork_request=?", (request_id,)).fetchone()
    return dict(row) if row else None


def fork_precheck(path, source_id) -> None:
    """연결을 발급하기 전 빠른 확인 — 없음(LookupError)·Codex·세션 없음·바쁨·너무 긺. 거래 안에서 다시 본다."""
    with connect(path) as conn:
        _fork_check(conn, source_id)


def _fork_check(conn, source_id):
    source = conn.execute("SELECT * FROM agent_chat_conversation WHERE id=?", (source_id,)).fetchone()
    if not source:
        raise LookupError(source_id)
    if source["restored_from"]:
        raise ForkRefused("restored")
    if source["engine"] != "claude":
        raise ForkRefused("codex")
    if not source["cli_session_id"] or not source["resumable"]:
        raise ForkRefused("no_session")
    if conn.execute("SELECT 1 FROM agent_chat_turn WHERE status IN ('running','cancelling') LIMIT 1").fetchone():
        raise Busy()
    turns, events = conn.execute(
        "SELECT COUNT(*), (SELECT COUNT(*) FROM agent_chat_event e JOIN agent_chat_turn t ON t.id=e.turn_id WHERE t.conversation_id=?) "
        "FROM agent_chat_turn WHERE conversation_id=?", (source_id, source_id)).fetchone()
    if turns > FORK_MAX_TURNS or events > FORK_MAX_EVENTS:
        raise ForkRefused("too_long")
    return source


def fork_conversation(path, source_id, *, request_id, client_id, mcp_entry, still_current=None) -> dict:
    """포크(설계 2-1) — 한 IMMEDIATE 거래로 새 대화 행 + 끝난 차례·사건 복사(INSERT…SELECT, 임시 표로 id 대응).
    계획 묶음은 복사하지 않고 plan 사건에 plan.forked=true. 같은 request_id 가 거래 안에서 보이면 그 포크를 그대로 준다
    (다른 원래 대화면 ForkRefused('request_mismatch')). still_current 는 커밋 직전에 불러 신원이 바뀌었으면 되돌린다.
    돌려주는 것 = 새 대화 요약."""
    with connect(path) as conn:
        _tx(conn)
        try:
            found = conn.execute("SELECT id,fork_from FROM agent_chat_conversation WHERE fork_request=?", (request_id,)).fetchone()
            if found:
                conn.execute("ROLLBACK")
                if found["fork_from"] != source_id:
                    raise ForkRefused("request_mismatch")
                return conversation_summary(path, found["id"])
            source = _fork_check(conn, source_id)
            turns = conn.execute("SELECT id FROM agent_chat_turn WHERE conversation_id=? ORDER BY created_at, rowid",
                                 (source_id,)).fetchall()
            new_id = str(uuid.uuid4())
            title = f"{source['title']} (포크)"[:80]
            conn.execute(
                "INSERT INTO agent_chat_conversation(id,engine,model,effort,client_id,mcp_entry,title,cli_home,cli_cwd,project_override,"
                "fork_session,fork_turn,fork_from,fork_request) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (new_id, source["engine"], source["model"], source["effort"], client_id, json.dumps(mcp_entry, ensure_ascii=False), title,
                 source["cli_home"], source["cli_cwd"], source["project_override"], source["cli_session_id"],
                 turns[-1]["id"] if turns else None, source_id, request_id))
            conn.execute("CREATE TEMP TABLE IF NOT EXISTS fork_map(old TEXT PRIMARY KEY, new TEXT NOT NULL, key TEXT NOT NULL)")
            conn.execute("DELETE FROM fork_map")
            conn.executemany("INSERT INTO fork_map(old,new,key) VALUES(?,?,?)",
                             [(row["id"], str(uuid.uuid4()), f"fork-{uuid.uuid4().hex}") for row in turns])
            conn.execute(
                "INSERT INTO agent_chat_turn(id,conversation_id,idempotency_key,status,text,context,reason,created_at,ended_at,attachments) "
                "SELECT m.new, ?, m.key, t.status, t.text, t.context, t.reason, t.created_at, t.ended_at, t.attachments "
                "FROM agent_chat_turn t JOIN fork_map m ON m.old=t.id ORDER BY t.created_at, t.rowid", (new_id,))
            conn.execute(
                "INSERT INTO agent_chat_event(turn_id,seq,kind,payload,created_at) "
                "SELECT m.new, e.seq, e.kind, CASE WHEN e.kind='plan' AND json_valid(e.payload) AND json_type(e.payload,'$.plan')='object' "
                "THEN json_set(e.payload,'$.plan.forked',json('true')) ELSE e.payload END, e.created_at "
                "FROM agent_chat_event e JOIN fork_map m ON m.old=e.turn_id")
            conn.execute("DELETE FROM fork_map")
            if still_current:
                still_current()  # 발급·복사 사이 계정·허브가 바뀌었으면 옛 신원 기록에 커밋하지 않는다(포크 독립 리뷰 P2)
            conn.execute("COMMIT")
        except (ForkRefused, LookupError, Busy):
            with contextlib.suppress(sqlite3.Error):
                conn.execute("ROLLBACK")
            raise
        except Exception:
            with contextlib.suppress(sqlite3.Error):
                conn.execute("ROLLBACK")
            raise
    return conversation_summary(path, new_id)


def patch_conversation(path, conversation_id, fields: dict, seen_rev: int | None = None) -> dict | None:
    """서랍 메뉴 고치기 — updated_at(목록 순서·MCP 넘김 기준)은 바꾸지 않는다. fields 의 열쇠는 title·pinned·archived·
    project_override·unread. unread=False 에 seen_rev 가 있으면 지금 rev 가 같고 아직 읽지 않음일 때만 끈다(자동 읽음)."""
    with connect(path) as conn:
        _tx(conn)
        try:
            if not conn.execute("SELECT 1 FROM agent_chat_conversation WHERE id=?", (conversation_id,)).fetchone():
                conn.execute("ROLLBACK")
                return None
            plain = [(col, fields[col]) for col in ("title", "pinned", "archived", "project_override") if col in fields]
            if plain:
                conn.execute(f"UPDATE agent_chat_conversation SET {','.join(f'{col}=?' for col, _ in plain)} WHERE id=?",
                             (*[int(v) if isinstance(v, bool) else v for _, v in plain], conversation_id))
            if fields.get("unread") is True:
                conn.execute("UPDATE agent_chat_conversation SET unread=1, unread_rev=unread_rev+1 WHERE id=?", (conversation_id,))
            elif fields.get("unread") is False and seen_rev is None:
                conn.execute("UPDATE agent_chat_conversation SET unread=0, unread_rev=unread_rev+1 WHERE id=?", (conversation_id,))
            elif fields.get("unread") is False:
                conn.execute("UPDATE agent_chat_conversation SET unread=0, unread_rev=unread_rev+1 "
                             "WHERE id=? AND unread=1 AND unread_rev=?", (conversation_id, seen_rev))
            conn.execute("COMMIT")
        except Exception:
            with contextlib.suppress(sqlite3.Error):
                conn.execute("ROLLBACK")
            raise
    return conversation_summary(path, conversation_id)


def delete_conversation(path, conversation_id) -> dict | None:
    """한 IMMEDIATE 트랜잭션 — 있는지·도는 차례(Busy)를 보고 사건·계획 묶음·차례·대화를 지운다. 돌려주는 것 = 세션 파일 정리용
    (engine·cli_session_id·cli_home·cli_cwd). 없으면 None."""
    with connect(path) as conn:
        _tx(conn)
        try:
            row = conn.execute("SELECT engine,cli_session_id,cli_home,cli_cwd FROM agent_chat_conversation WHERE id=?",
                               (conversation_id,)).fetchone()
            if not row:
                conn.execute("ROLLBACK")
                return None
            if conn.execute("SELECT 1 FROM agent_chat_turn WHERE conversation_id=? AND status IN ('running','cancelling') LIMIT 1",
                            (conversation_id,)).fetchone():
                conn.execute("ROLLBACK")
                raise Busy()
            turns = "SELECT id FROM agent_chat_turn WHERE conversation_id=?"
            conn.execute(f"DELETE FROM agent_chat_event WHERE turn_id IN ({turns})", (conversation_id,))
            conn.execute(f"DELETE FROM agent_chat_plan_binding WHERE turn_id IN ({turns})", (conversation_id,))
            conn.execute("DELETE FROM agent_chat_turn WHERE conversation_id=?", (conversation_id,))
            conn.execute("DELETE FROM agent_chat_conversation WHERE id=?", (conversation_id,))
            conn.execute("COMMIT")
        except Busy:
            raise
        except Exception:
            with contextlib.suppress(sqlite3.Error):
                conn.execute("ROLLBACK")
            raise
    return dict(row)


def update_conversation(path, conversation_id, *, model=None, effort=None, cli_session_id=None, resumable=None,
                        cli_home=None, cli_cwd=None) -> None:
    sets, values = ["updated_at=datetime('now')"], []
    for column, value in (("model", model), ("effort", effort), ("cli_session_id", cli_session_id),
                          ("cli_home", cli_home), ("cli_cwd", cli_cwd)):
        if value is not None:
            sets.append(f"{column}=?")
            values.append(value)
    if resumable is not None:
        sets.append("resumable=?")
        values.append(int(resumable))
    with connect(path) as conn:
        conn.execute(f"UPDATE agent_chat_conversation SET {','.join(sets)} WHERE id=?", (*values, conversation_id))


_ATTACH_FIELDS = {"generation": ("id",), "asset": ("project", "path"), "folder": ("project_id", "path")}


def _attachment_ok(item) -> bool:
    if not isinstance(item, dict) or not isinstance(item.get("kind"), str):  # kind 가 목록 등이면 사전 조회가 TypeError(재확인 P2)
        return False
    need = _ATTACH_FIELDS.get(item["kind"])
    return bool(need) and all(isinstance(item.get(key), str) and item[key] for key in need) and (
        item.get("name") is None or isinstance(item.get("name"), str))


def _space_ok(space) -> bool:
    """개인 = id 가 None, 팀 = 비지 않은 문자열 id."""
    if not isinstance(space, dict):
        return False
    if space.get("scope") == "personal":
        return space.get("id") is None
    return space.get("scope") == "team" and isinstance(space.get("id"), str) and bool(space["id"])


def read_attachments(raw) -> dict | None:
    """저장한 붙인 자료 — NULL·깨진 JSON·모양이 다르면(공간·항목 하나라도) 없음(None). 화면이 깨진 항목을 받지 않게(독립 리뷰 P2)."""
    try:
        value = json.loads(raw) if isinstance(raw, str) else None
    except ValueError:
        return None
    if not isinstance(value, dict) or not isinstance(value.get("items"), list) or not value["items"] or not _space_ok(value.get("workspace")):
        return None
    return value if all(_attachment_ok(item) for item in value["items"]) else None


def claim_turn(path, *, conversation_id, idempotency_key, text, context, attachments=None, new_conversation=None) -> tuple[dict, bool]:
    """같은 열쇠면 그 차례를 그대로, 진행 중이면 Busy. 새 대화와 첫 차례도 한 거래로 선점한다."""
    with connect(path) as conn:
        _tx(conn)
        try:
            row = conn.execute("SELECT * FROM agent_chat_turn WHERE idempotency_key=?", (idempotency_key,)).fetchone()
            if row:
                conn.execute("COMMIT")
                return dict(row), False
            if new_conversation is not None:
                _insert_conversation(conn, conversation_id, **new_conversation)
            source = conn.execute("SELECT restored_from FROM agent_chat_conversation WHERE id=?", (conversation_id,)).fetchone()
            if not source:
                conn.execute("ROLLBACK")  # 사이에 지워진 대화에 차례를 붙이지 않는다(설계 2-5)
                raise LookupError(conversation_id)
            if source["restored_from"]:
                raise HTTPException(409, "복원한 기록은 읽기 전용입니다. 새 대화로 시작하세요.")
            tid = str(uuid.uuid4())
            try:
                conn.execute("INSERT INTO agent_chat_turn(id,conversation_id,idempotency_key,status,text,context,attachments) "
                             "VALUES(?,?,?,?,?,?,?)",
                             (tid, conversation_id, idempotency_key, "running", text, json.dumps(context, ensure_ascii=False),
                              json.dumps(attachments, ensure_ascii=False) if attachments else None))
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


def bindings_for_conversation(path, conversation_id, limit=20) -> list[dict]:
    """대화 복원 보정용 — 이 대화의 칸 연결로 만든 계획, 최근 것부터 limit 개(설계 A2-5)."""
    with connect(path) as conn:
        rows = conn.execute(
            "SELECT b.plan_id, b.client_id FROM agent_chat_plan_binding b JOIN agent_chat_turn t ON t.id=b.turn_id "
            "JOIN agent_chat_conversation c ON c.id=t.conversation_id WHERE c.id=? AND (c.client_id=b.client_id OR c.restored_from IS NOT NULL) "
            "ORDER BY b.created_at DESC, b.rowid DESC LIMIT ?", (conversation_id, limit)).fetchall()
    return [dict(row) for row in rows]


def binding_for(path, plan_id) -> dict | None:
    with connect(path) as conn:
        row = conn.execute(
            "SELECT b.plan_id, b.turn_id, b.client_id, t.conversation_id FROM agent_chat_plan_binding b "
            "JOIN agent_chat_turn t ON t.id=b.turn_id JOIN agent_chat_conversation c ON c.id=t.conversation_id "
            "WHERE b.plan_id=? AND c.client_id=b.client_id", (plan_id,)).fetchone()
    return dict(row) if row else None


# ── MCP 읽기 전용(설계 docs/status/MVAgent_대화기록_MCP읽기_2026-11-12.md 2-3 ④) ──
@contextlib.contextmanager
def connect_readonly(path: Path):
    """open_db 를 거치지 않는다(표 생성·남은 차례 정리 없음). mode=ro 라 없는 파일을 만들지 않고 query_only 로 쓰기를 막는다.
    한 읽기 시점(트랜잭션) 안에서 쓴다 — 차례 상태와 사건이 같은 스냅샷. 없는 파일 = FileNotFoundError, 그 밖은 sqlite3.Error 그대로.
    shortcut: Path.as_uri 의 file:// URI 는 UNC 경로(\\\\서버\\공유)를 SQLite 가 못 연다 — 대화 폴더는 %LOCALAPPDATA% 라 로컬이다."""
    check_current(path)
    if not path.is_file():
        raise FileNotFoundError(path)
    with connect(path, readonly=True) as conn:
        conn.execute("PRAGMA query_only=ON")
        conn.execute("BEGIN")
        try:
            yield conn
        finally:
            conn.execute("ROLLBACK")


def ro_conversations(conn, *, search, limit, before) -> list[dict]:
    """최근 순(updated_at, id) limit+1 개 — 하나 더 읽어 다음 쪽이 있는지 안다. before = (updated_at, id) 발급 정렬값."""
    where, args = [], []
    if search:
        where.append("instr(lower(c.title), lower(?)) > 0")  # LIKE 의 %·_ 이스케이프 문제 없이, 대소문자 무시
        args.append(search)
    if before:
        where.append("(c.updated_at < ? OR (c.updated_at = ? AND c.id < ?))")
        args += [before[0], before[0], before[1]]
    first = ("(SELECT substr(json_extract(t.context,'$.project'),1,200) FROM agent_chat_turn t WHERE t.conversation_id=c.id"
             " AND json_valid(t.context) AND json_type(t.context,'$.project')='text' ORDER BY t.created_at, t.rowid LIMIT 1)")
    # 서랍에서 옮긴 프로젝트를 따른다 — open_db 를 안 거치므로 칸이 없는 옛 파일이면 첫 차례 것만(설계 2-5)
    moved = "project_override" in {row[1] for row in conn.execute("PRAGMA table_info(agent_chat_conversation)")}
    project = (f"CASE WHEN c.project_override IS NULL THEN {first} WHEN c.project_override='' THEN NULL "
               "ELSE substr(c.project_override,1,200) END" if moved else first)
    rows = conn.execute(
        "SELECT c.id,substr(c.title,1,80) AS title,c.engine,c.model,c.updated_at,"
        f" {project} AS project,"
        " (SELECT COUNT(*) FROM agent_chat_turn t WHERE t.conversation_id=c.id) AS turns"
        " FROM agent_chat_conversation c" + (" WHERE " + " AND ".join(where) if where else "") +
        " ORDER BY c.updated_at DESC, c.id DESC LIMIT ?", (*args, limit + 1)).fetchall()
    return [dict(row) for row in rows]


def ro_conversation(conn, conversation_id) -> dict | None:
    row = conn.execute("SELECT id,title,engine,model,effort,updated_at FROM agent_chat_conversation WHERE id=?",
                       (conversation_id,)).fetchone()
    return dict(row) if row else None


def ro_turns(conn, conversation_id, *, limit, before) -> list[dict]:
    """뒤에서부터 limit 개를 오래된 순으로. before = (created_at, 저장 순번) — 그보다 앞 차례만. pos = 저장 순번(rowid)."""
    where, args = "", []
    if before:
        where = " AND (created_at < ? OR (created_at = ? AND rowid < ?))"
        args = [before[0], before[0], before[1]]
    rows = conn.execute("SELECT rowid AS pos,id,status,text,context,reason,created_at FROM agent_chat_turn WHERE conversation_id=?"
                        + where + " ORDER BY created_at DESC, rowid DESC LIMIT ?", (conversation_id, *args, limit)).fetchall()
    return [dict(row) for row in reversed(rows)]


def ro_count_before(conn, conversation_id, created_at, pos) -> int:
    return conn.execute("SELECT COUNT(*) FROM agent_chat_turn WHERE conversation_id=? AND (created_at < ? OR (created_at = ? AND rowid < ?))",
                        (conversation_id, created_at, created_at, pos)).fetchone()[0]


def ro_events(conn, turn_id, page=500):
    """그 차례의 사건을 순서대로 끝까지(쪽 단위로 읽어 한꺼번에 들고 있지 않는다)."""
    after = 0
    while True:
        rows = conn.execute("SELECT seq,kind,payload FROM agent_chat_event WHERE turn_id=? AND seq>? ORDER BY seq LIMIT ?",
                            (turn_id, after, page)).fetchall()
        for row in rows:
            yield row["kind"], json.loads(row["payload"])
        if len(rows) < page:
            return
        after = rows[-1]["seq"]


def ro_progress(conn, conversation_id, plan_ids) -> dict[str, tuple[dict, str]]:
    """돌려줄 계획(plan_ids)마다 그 대화 안에서 저장 순서(사건 rowid)로 마지막 plan_progress 한 건만 — 한 번의 조회.
    seq 는 차례마다 새로 세서 쓰지 않는다. 다른 계획·앞선 진행 원문은 읽어 들이지 않는다."""
    ids = sorted(set(plan_ids))
    if not ids:
        return {}
    marks = ",".join("?" * len(ids))
    rows = conn.execute(
        "SELECT payload, created_at FROM agent_chat_event WHERE rowid IN ("
        " SELECT MAX(e.rowid) FROM agent_chat_event e JOIN agent_chat_turn t ON t.id=e.turn_id"
        " WHERE t.conversation_id=? AND e.kind='plan_progress' AND json_valid(e.payload)"
        f" AND json_extract(e.payload,'$.plan_id') IN ({marks}) GROUP BY json_extract(e.payload,'$.plan_id'))",
        (conversation_id, *ids)).fetchall()
    last: dict[str, tuple[dict, str]] = {}
    for row in rows:
        payload = json.loads(row["payload"])
        if isinstance(payload, dict) and isinstance(payload.get("plan_id"), str):
            last[payload["plan_id"]] = (payload, row["created_at"])
    return last
