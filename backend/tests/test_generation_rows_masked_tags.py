"""가려질 남의 행은 태그·자동태그를 읽지 않는다(83회차 A①).

★왜: 남의 공유물을 볼 때 그 사람의 태그·자동태그는 응답에서 빈 배열로 덮인다(개인 메타). 그런데 서버는 덮기 전에
 그것을 다 읽고 이름순으로 정렬했다(lane FG — 500건 보강의 헛일). 읽지 않아도 응답은 같다.
★경계: 읽지 않는 조건은 가리는 조건과 **같은 함수 하나**다 — 보는 계정이 있고, 행에 작성자가 있고, 둘이 다를 때만.
 작성자 미상·빈 작성자·보는 계정 없음(단독)은 지금처럼 읽어서 보여 준다.
★비교: 바꾸기 전 규칙(모든 행의 태그를 읽고 남의 것은 비움)을 아래 `_before` 에 그대로 두고, 같은 입력에서 모든 입구의 응답이
 그것과 같은지 본다(바꾸기 전 코드에서도 통과해야 하는 시험이다).
"""

from __future__ import annotations

import copy

import pytest

from app import db, repo
from app.repo.generation_rows import _GEN_SELECT_COLS, _attach_children

# (id, 작성자, 색, 태그, 자동태그, sort_ts) — 'alpha' 는 내 것과 남의 것에 같이 붙는다(남의 것을 건너뛰어도 내 것은 그대로여야 한다)
GENS = [
    ("g-mine", "u_me", "#ff0000", ["zeta", "alpha"], ["auto-m"], 6),
    ("g-other", "u_other", "#00ff00", ["alpha", "beta"], ["auto-o", "auto-o2"], 5),
    ("g-unknown", None, "#0000ff", ["gamma"], ["auto-u"], 4),
    ("g-blank", "", "#123456", ["delta"], [], 3),
    ("g-plain", "u_other", None, [], [], 2),
    ("g-third", "u_third", "#abcdef", ["eps"], ["auto-t"], 1),
]
IDS = [g[0] for g in GENS]
VIEWERS = ["u_me", "u_other", None, "\x00"]


@pytest.fixture
def catalog(monkeypatch, tmp_path):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content.db"))
    monkeypatch.setattr(db, "_POOL_ENABLED", False)
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    tag_ids: dict[str, str] = {}
    with db.get_connection() as conn:
        conn.execute("INSERT INTO project(id, name) VALUES('p1', 'P1')")
        for gid, creator, color, tags, autos, ts in GENS:
            conn.execute(
                "INSERT INTO generation(id, worker_id, prompt, status, creator_uid, project_id, color, params, sort_ts) "
                "VALUES(?, 'me', 'masked tags fixture', 'done', ?, 'p1', ?, '{\"seed\": 1}', ?)",
                (gid, creator, color, ts),
            )
            conn.execute(
                "INSERT INTO share(id, generation_id, shared_by, visibility) VALUES(?, ?, 'me', 'team')",
                ("s-" + gid, gid),
            )
            for name in tags:
                tid = tag_ids.setdefault(name, f"t-{len(tag_ids)}")
                conn.execute("INSERT OR IGNORE INTO tag(id, name) VALUES(?, ?)", (tid, name))
                conn.execute("INSERT INTO gen_tag(generation_id, tag_id) VALUES(?, ?)", (gid, tid))
            for name in autos:
                conn.execute("INSERT INTO auto_tag(id, name, owner_uid) VALUES(?, ?, ?)", ("a-" + name, name, creator))
                conn.execute("INSERT INTO gen_auto_tag(generation_id, auto_tag_id) VALUES(?, ?)", (gid, "a-" + name))
        # 히스토리·배치 입구도 같은 보강을 쓴다 — 계보로 이어 둔다
        conn.execute("INSERT INTO history(id, parent_gen_id, child_gen_id, relation) VALUES('h1', 'g-other', 'g-mine', 'derived')")
        conn.execute("INSERT INTO history(id, parent_gen_id, child_gen_id, relation) VALUES('h2', 'g-unknown', 'g-mine', 'reference')")
        conn.execute("INSERT INTO history(id, parent_gen_id, child_gen_id, relation) VALUES('h3', 'g-mine', 'g-third', 'derived')")
    yield
    db.flush_pool()


class _Recorder:
    """보강이 던지는 SQL 을 적어 둔다 — `_attach_children` 은 conn.execute 만 쓴다."""

    def __init__(self, conn):
        self.conn, self.calls = conn, []

    def execute(self, sql, params=()):
        self.calls.append((sql, list(params)))
        return self.conn.execute(sql, params)

    def tag_lookups(self):
        return [(sql, params) for sql, params in self.calls if "gen_tag" in sql or "gen_auto_tag" in sql]


def _rows(conn, ids):
    return [dict(r) for r in conn.execute(
        f"SELECT {_GEN_SELECT_COLS} WHERE g.id IN ({','.join('?' for _ in ids)}) ORDER BY g.sort_ts DESC", ids,
    ).fetchall()]


def test_only_others_rows_read_no_tags_at_all(catalog):
    """남의 행만 있는 보강 — 태그·자동태그 조회를 한 번도 하지 않는다(바꾸기 전에는 두 번 읽고 덮었다)."""
    with db.get_connection() as conn:
        rec = _Recorder(conn)
        out = _attach_children(rec, _rows(conn, ["g-other", "g-plain", "g-third"]), viewer_uid="u_me")
    assert rec.tag_lookups() == []
    assert all(g["tags"] == [] and g["auto_tags"] == [] and g["color"] is None for g in out)


@pytest.mark.parametrize("viewer, read", [
    ("u_me", {"g-mine", "g-unknown", "g-blank"}),           # 내 것 + 작성자 미상·빈 작성자(가리지 않는다)
    ("u_other", {"g-other", "g-plain", "g-unknown", "g-blank"}),
    (None, set(IDS)),                                         # 보는 계정 없음(단독) — 아무것도 가리지 않는다
    ("\x00", {"g-unknown", "g-blank"}),                       # 미확정 계정 표식도 '보는 계정이 있음'으로 가리던 그대로
])
def test_a_mixed_list_reads_tags_only_for_the_rows_it_shows(catalog, viewer, read):
    with db.get_connection() as conn:
        rec = _Recorder(conn)
        _attach_children(rec, _rows(conn, IDS), viewer_uid=viewer)
    lookups = rec.tag_lookups()
    assert len(lookups) == 2  # 태그·자동태그 한 번씩
    assert [set(params) for _, params in lookups] == [read, read]


# ── 바꾸기 전 규칙과 같은 응답 ─────────────────────────────────────────────


def _before(conn, viewer):
    """바꾸기 전 `_attach_children` 의 태그 단계 그대로 — 모든 행을 읽고(태그는 이름순), 그 뒤 남의 것은 색·태그를 비운다."""
    ph = ",".join("?" * len(IDS))
    tags = {gid: [] for gid in IDS}
    autos = {gid: [] for gid in IDS}
    for r in conn.execute(
        f"SELECT gt.generation_id, t.name FROM gen_tag gt JOIN tag t ON t.id = gt.tag_id "
        f"WHERE gt.generation_id IN ({ph}) ORDER BY t.name", IDS,
    ).fetchall():
        tags[r["generation_id"]].append(r["name"])
    for r in conn.execute(
        f"SELECT gat.generation_id, a.name FROM gen_auto_tag gat JOIN auto_tag a ON a.id = gat.auto_tag_id "
        f"WHERE gat.generation_id IN ({ph})", IDS,
    ).fetchall():
        autos[r["generation_id"]].append(r["name"])
    raw = {r["id"]: dict(r) for r in conn.execute(f"SELECT id, creator_uid, color FROM generation WHERE id IN ({ph})", IDS)}
    out = {}
    for gid in IDS:
        cu = raw[gid]["creator_uid"]
        if viewer and cu and cu != viewer:  # 바꾸기 전 가림 조건(식 그대로)
            out[gid] = {"color": None, "tags": [], "auto_tags": []}
        else:
            out[gid] = {"color": raw[gid]["color"], "tags": tags[gid], "auto_tags": autos[gid]}
    return out


def _as_before(row, expected):
    """응답 행에서 이번에 바뀔 수 있는 세 칸만 바꾸기 전 값으로 — 나머지 칸은 이 변경이 손대지 않는다."""
    fixed = copy.deepcopy(row)
    fixed.update(copy.deepcopy(expected[row["id"]]))
    return fixed


def _check_rows(rows, expected):
    assert rows, "비교할 행이 없다"
    for row in rows:
        assert row == _as_before(row, expected), row["id"]


def _history_rows(node):
    """히스토리 응답 안의 생성물 행을 모두 꺼낸다(키 모양에 기대지 않는다)."""
    found = []
    if isinstance(node, dict):
        if "id" in node and "tags" in node and "auto_tags" in node:
            found.append(node)
        for value in node.values():
            found += _history_rows(value)
    elif isinstance(node, list):
        for value in node:
            found += _history_rows(value)
    return found


@pytest.mark.parametrize("viewer", VIEWERS)
def test_every_entry_point_answers_exactly_as_before(catalog, viewer):
    with db.get_connection() as conn:
        expected = _before(conn, viewer)
        core = _attach_children(conn, _rows(conn, IDS), viewer_uid=viewer)
    _check_rows(core, expected)
    assert [g["id"] for g in core] == IDS  # 행 순서도 그대로

    team = repo.list_generations(tab="team", account_uid=viewer, limit=50)
    _check_rows(team, expected)
    assert [g["id"] for g in team] == IDS
    if viewer in ("u_me", "u_other"):
        _check_rows(repo.list_generations(tab="my", account_uid=viewer, limit=50), expected)
    # 태그로 찾기·검색은 원래 태그(WHERE)로 걸러진다 — 남의 것도 걸리고, 응답에서만 가린다(바꾸기 전과 같다)
    by_tag = repo.list_generations(tab="team", account_uid=viewer, tags=["alpha"], limit=50)
    assert sorted(g["id"] for g in by_tag) == ["g-mine", "g-other"]
    _check_rows(by_tag, expected)
    _check_rows(repo.list_generations(tab="team", account_uid=viewer, search="beta", limit=50), expected)

    _check_rows([repo.get_generation(gid, account_uid=viewer) for gid in IDS], expected)
    _check_rows(list(repo.get_generations_batch(IDS, account_uid=viewer).values()), expected)
    history = _history_rows(repo.get_history("g-mine", viewer_uid=viewer))
    assert {g["id"] for g in history} >= {"g-mine", "g-other", "g-unknown", "g-third"}
    _check_rows(history, expected)
    _check_rows(_history_rows(repo.get_history_graph("g-mine", viewer_uid=viewer)), expected)
