"""서버에서 한 번에 세는 판별기 — 계정별 DB 를 모두 훑어 **집계만** 찍는다. 읽기 전용.

왜 따로 있나: 공유 서버는 인증이 켜져 있어 계정마다 DB 가 따로다(`data/db/acct/<계정>/content_hub.db`).
거래(`credit_txn`)는 그 계정 DB 에, 화면이 읽는 팩트(`team_generation_fact`)는 공용 `manage_hub.db` 에 있다.
`credit_round_audit.py` 는 한 쌍만 보므로, 팀 전체를 세려면 이 스크립트로 돈다.

쓰는 법(서버 PC, PowerShell):
    <파이썬> tools\\credit_round_audit_server.py --data "<설치폴더>\\backend\\data"

출력에는 **이메일·생성물 id 를 찍지 않는다**(계정 수·건수·금액만). 아무것도 고치지 않는다.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from collections import Counter
from pathlib import Path

EPS = 1e-9


def _ro(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(Path(path).absolute().as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    return conn


def _is_int(value: float) -> bool:
    return abs(value - round(value)) <= EPS


def audit_pair(content: Path, facts: dict[tuple[str, str], float]) -> tuple[Counter, dict[str, float], set]:
    kinds: Counter[str] = Counter()
    delta = {"metrics": 0.0, "fact": 0.0}
    repair: set[tuple[str, str]] = set()
    conn = _ro(content)
    try:
        rows = conn.execute(
            "SELECT LOWER(TRIM(COALESCE(t.account_email,''))) AS email, t.matched_gen_id, t.created_at, "
            "t.credits, t.action, t.display_name, m.gen_id AS metrics_gen, m.real_credits AS metrics_real "
            "FROM credit_txn t LEFT JOIN generation_metrics m ON m.gen_id = t.matched_gen_id "
            "WHERE t.matched_gen_id IS NOT NULL AND typeof(t.credits) IN ('integer','real') AND t.action='spend'"
        ).fetchall()
    except sqlite3.DatabaseError as exc:  # 스키마가 다른 옛 DB 등
        print(f"  (건너뜀: {exc})")
        return kinds, delta, repair
    finally:
        conn.close()

    per_gen = Counter((r["email"], r["matched_gen_id"]) for r in rows)
    per_identity = Counter(
        (r["email"], r["created_at"], r["credits"], r["action"], r["display_name"]) for r in rows
    )
    kinds["spend_matched"] += len(rows)
    for r in rows:
        exact = abs(float(r["credits"]))
        places = [("metrics", None if r["metrics_real"] is None else float(r["metrics_real"])),
                  ("fact", facts.get((r["email"], r["matched_gen_id"])))]
        if all(v is None for _, v in places):
            kinds["purged" if r["metrics_gen"] is None else "no_value"] += 1
            continue
        ambiguous = (
            per_gen[(r["email"], r["matched_gen_id"])] > 1
            or per_identity[(r["email"], r["created_at"], r["credits"], r["action"], r["display_name"])] > 1
        )
        for where, observed in places:
            if observed is None:
                continue
            if abs(observed - exact) <= EPS:
                kinds[f"ok_{where}"] += 1
            elif ambiguous:
                kinds["ambiguous"] += 1
            elif _is_int(observed) and abs(observed - float(round(exact))) <= EPS and not _is_int(exact):
                kinds[f"rounded_{where}"] += 1
                delta[where] += observed - exact
                repair.add((r["email"], r["matched_gen_id"]))
            else:
                kinds["other_mismatch"] += 1
    return kinds, delta, repair


def main() -> int:
    ap = argparse.ArgumentParser(description="서버 전체 반올림 크레딧 판별(읽기 전용·집계만)")
    ap.add_argument("--data", required=True, help="설치폴더\\backend\\data")
    args = ap.parse_args()
    data = Path(args.data)
    db_dir = data / "db"
    manage = db_dir / "manage_hub.db"
    if not db_dir.is_dir():
        print(f"db 폴더가 없다: {db_dir}")
        return 1

    facts: dict[tuple[str, str], float] = {}
    if manage.is_file():
        mconn = _ro(manage)
        try:
            for row in mconn.execute(
                "SELECT LOWER(TRIM(account_email)) AS email, local_gen_id, real_credits "
                "FROM team_generation_fact WHERE real_credits IS NOT NULL"
            ):
                facts[(row["email"], row["local_gen_id"])] = float(row["real_credits"])
        finally:
            mconn.close()
    print(f"서버 팩트(real_credits 있는 행) {len(facts):,}건 · manage_hub.db {'있음' if facts else '없음/빈값'}")

    contents = sorted(db_dir.glob("acct/*/content_hub.db")) + (
        [db_dir / "content_hub.db"] if (db_dir / "content_hub.db").is_file() else []
    )
    print(f"계정 DB {len(contents)}개를 훑는다\n")

    total = Counter()
    total_delta = {"metrics": 0.0, "fact": 0.0}
    repair_all: set[tuple[str, str]] = set()
    for index, content in enumerate(contents, 1):
        kinds, delta, repair = audit_pair(content, facts)
        total.update(kinds)
        for key in total_delta:
            total_delta[key] += delta[key]
        repair_all |= repair
        print(
            f"  계정 {index:>2}: 지출 {kinds['spend_matched']:>5}건 · 반올림 로컬 {kinds['rounded_metrics']:>4} ·"
            f" 서버 {kinds['rounded_fact']:>4} · 애매 {kinds['ambiguous']:>3} · 설명안됨 {kinds['other_mismatch']:>3}"
        )

    print("\n=== 합계 ===")
    for key in ("spend_matched", "ok_metrics", "ok_fact", "rounded_metrics", "rounded_fact",
                "purged", "ambiguous", "other_mismatch", "no_value"):
        if total[key]:
            print(f"  {key:<16} {total[key]:,}")
    print(
        f"\n고쳐야 할 생성물 {len(repair_all):,}건 — 로컬 메트릭 {total_delta['metrics']:+.2f} cr ·"
        f" 서버 팩트 {total_delta['fact']:+.2f} cr (+ 는 장부가 실제보다 많게 적힌 것)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
