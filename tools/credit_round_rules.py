"""옛 반올림 크레딧 — **판정 규칙 한 곳**. 판별·보정·서버 집계가 모두 이것만 쓴다.

왜 한 곳인가(Codex 리뷰 2026-09-23): 판별과 보정이 각자 기준을 들고 있으면 "판별엔 안 나왔는데
보정이 건드리는" 행이 생긴다. 규칙이 바뀌는 자리를 하나로 만들어 그런 어긋남을 구조적으로 막는다.

되살릴 수 있는 자리의 조건(모두 만족해야 한다):
  · 거래가 지출(`spend`)이고 생성물에 연결돼 있다
  · 장부값이 **정수**이고, 원본 `ABS(credits)` 는 **소수**이며, 장부값 == 파이썬 `round(원본)`
    (옛 코드가 파이썬 반올림을 썼다 — SQLite 의 `round()` 와 `.5` 규칙이 다르다)
  · 로컬 메트릭이면 그 값이 **거래에서 온 것**이다(`credit_source='transaction'` · `matched=1`)
  · 애매하지 않다 — 한 생성물에 거래가 둘 이상 · 같은 거래 신원이 여러 행 · 서버 팩트 키 충돌

한 생성물이 로컬(`generation_metrics`)과 서버(`team_generation_fact`) 두 곳에서 따로 틀릴 수 있어
**자리별로** 따로 돌려준다. 고칠 수 있는 것은 로컬 자리뿐이다(서버는 재전송으로 따라온다).
"""

from __future__ import annotations

import sqlite3
from collections import Counter
from dataclasses import dataclass
from pathlib import Path


def connect_ro(path: Path) -> sqlite3.Connection:
    """읽기 전용 연결. 경로의 `#`·`%` 때문에 URI 를 손으로 조립하지 않는다(옛 사고)."""
    conn = sqlite3.connect(Path(path).absolute().as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    return conn


def is_int(value: float) -> bool:
    """정수인가 — 허용오차를 두지 않는다. DB 의 float 를 그대로 읽은 값이라 정확 비교가 옳다."""
    return float(value).is_integer()


def explained_by_rounding(stored: float, exact: float) -> bool:
    """장부값이 원본을 **옛 방식으로 반올림한 모양**인가."""
    return is_int(stored) and not is_int(exact) and stored == float(round(exact))


@dataclass
class Candidate:
    """되살릴 한 자리."""

    gen_id: str
    email: str
    stored: float
    exact: float
    display_name: str | None
    created_at: str
    alive: bool      # 로컬에 생성물 본체가 살아 있나(재전송으로 서버를 고칠 수 있나)
    has_local: bool  # 로컬 메트릭 값이 있나(없으면 서버 자리는 이 PC 에서 못 고친다)


def load_fact_clashes(manage_db: Path | None) -> tuple[dict[tuple[str, str], float], set[tuple[str, str]]]:
    """서버 팩트 {(이메일, 생성물): 값} 과 **정규화하면 같아지는 키**(어느 쪽이 맞는지 모른다)."""
    facts: dict[tuple[str, str], float] = {}
    clashed: set[tuple[str, str]] = set()
    if not manage_db or not Path(manage_db).exists():
        return facts, clashed
    conn = connect_ro(Path(manage_db))
    try:
        for row in conn.execute(
            "SELECT LOWER(TRIM(account_email)) AS email, local_gen_id, real_credits "
            "FROM team_generation_fact WHERE real_credits IS NOT NULL"
        ):
            key = (row["email"], row["local_gen_id"])
            value = float(row["real_credits"])
            if key in facts and facts[key] != value:
                clashed.add(key)
            facts[key] = value
    finally:
        conn.close()
    return facts, clashed


def _duplicate_index(conn: sqlite3.Connection) -> tuple[Counter, Counter]:
    """중복은 **거래표 전체**에서 센다 — 연결된 지출만 세면 같은 생성물의 환불이나 미연결 복제를 놓친다."""
    per_gen: Counter = Counter()
    per_identity: Counter = Counter()
    for row in conn.execute(
        "SELECT LOWER(TRIM(COALESCE(account_email,''))) AS email, matched_gen_id, created_at, "
        "credits, action, display_name FROM credit_txn"
    ):
        if row["matched_gen_id"]:
            per_gen[(row["email"], row["matched_gen_id"])] += 1
        per_identity[
            (row["email"], row["created_at"], row["credits"], row["action"], row["display_name"])
        ] += 1
    return per_gen, per_identity


def _generation_alive(conn: sqlite3.Connection) -> set[str] | None:
    """로컬에 살아 있는 생성물 id. `generation` 표가 없는 사본이면 None(그때는 생존을 따지지 않는다)."""
    try:
        return {r[0] for r in conn.execute("SELECT id FROM generation WHERE deleted_at IS NULL")}
    except sqlite3.DatabaseError:
        return None


def scan(
    conn: sqlite3.Connection,
    facts: dict[tuple[str, str], float] | None = None,
    clashed: set[tuple[str, str]] | None = None,
) -> tuple[list[Candidate], list[Candidate], Counter]:
    """(로컬 메트릭 자리, 서버 팩트 자리, 분류별 건수).

    고칠 수 있는 것은 첫 번째 목록뿐이다. 두 번째 중 `has_local=False` 인 것은 로컬 값이 아예 없어
    재전송으로도 안 따라오므로 서버에서 따로 봐야 한다."""
    facts = facts or {}
    clashed = clashed or set()
    conn.row_factory = sqlite3.Row
    per_gen, per_identity = _duplicate_index(conn)
    alive = _generation_alive(conn)

    kinds: Counter = Counter()
    local: list[Candidate] = []
    server: list[Candidate] = []
    for r in conn.execute(
        "SELECT LOWER(TRIM(COALESCE(t.account_email,''))) AS email, t.matched_gen_id, t.created_at, "
        "t.credits, t.action, t.display_name, m.gen_id AS metrics_gen, m.real_credits AS metrics_real, "
        "m.credit_source, m.matched "
        "FROM credit_txn t LEFT JOIN generation_metrics m ON m.gen_id = t.matched_gen_id "
        "WHERE t.matched_gen_id IS NOT NULL AND typeof(t.credits) IN ('integer','real') "
        "AND t.action='spend' ORDER BY t.created_at"
    ):
        gen_id = r["matched_gen_id"]
        email = r["email"]
        exact = abs(float(r["credits"]))
        stored = None if r["metrics_real"] is None else float(r["metrics_real"])
        fact = facts.get((email, gen_id))
        kinds["spend_matched"] += 1
        if stored is None and fact is None:
            kinds["purged" if r["metrics_gen"] is None else "no_value"] += 1
            continue
        # 애매한 거래는 값이 우연히 맞아도 **먼저** 걸러 낸다 — ok 를 먼저 보면 중복 연결이 '문제 없음'이 된다.
        if (
            (email, gen_id) in clashed
            or per_gen[(email, gen_id)] > 1
            or per_identity[(email, r["created_at"], r["credits"], r["action"], r["display_name"])] > 1
        ):
            kinds["ambiguous"] += 1
            continue
        from_transaction = r["credit_source"] == "transaction" and bool(r["matched"])
        row_alive = True if alive is None else gen_id in alive
        for where, observed in (("metrics", stored), ("fact", fact)):
            if observed is None:
                continue
            if observed == exact:
                kinds[f"ok_{where}"] += 1
                continue
            # 거래에서 온 값만 되살린다 — 손으로 적었거나 견적에서 온 값이 우연히 반올림 모양일 수 있다.
            if where == "metrics" and not from_transaction:
                kinds["not_transaction"] += 1
                continue
            if not explained_by_rounding(observed, exact):
                kinds["other_mismatch"] += 1
                continue
            kinds[f"rounded_{where}"] += 1
            item = Candidate(gen_id, email, observed, exact, r["display_name"], r["created_at"],
                             row_alive, stored is not None)
            if where == "metrics":
                local.append(item)
            else:
                if stored is None:
                    # 로컬 메트릭이 아예 없는데 서버만 반올림 — 재전송으로는 못 고친다(서버에서 따로).
                    kinds["rounded_fact_only"] += 1
                server.append(item)
    return local, server, kinds
