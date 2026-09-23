"""서버에서 한 번에 세는 판별기 — 계정별 DB 를 모두 훑어 **집계만** 찍는다. 읽기 전용.

왜 따로 있나: 공유 서버는 인증이 켜져 있어 계정마다 DB 가 따로다(`data/db/acct/<계정>/content_hub.db`).
거래(`credit_txn`)는 그 계정 DB 에, 화면이 읽는 팩트(`team_generation_fact`)는 공용 `manage_hub.db` 에 있다.
`credit_round_audit.py` 는 한 쌍만 보므로, 팀 전체를 세려면 이 스크립트로 돈다.

판정은 `credit_round_rules.scan()` 하나만 쓴다 — 한 PC 판별·보정과 같은 기준이어야 "서버 집계엔
잡혔는데 그 PC 에선 안 나오는" 숫자가 생기지 않는다(Codex 리뷰 2026-09-23).

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

sys.path.insert(0, str(Path(__file__).resolve().parent))
from credit_round_rules import Candidate, connect_ro, load_fact_clashes, scan  # noqa: E402


def audit_pair(content: Path, facts, clashed) -> tuple[Counter, list[Candidate], list[Candidate]]:
    """계정 DB 하나 — (분류별 건수, 로컬 자리, 서버 자리)."""
    conn = None
    try:
        conn = connect_ro(content)
        local, server, kinds = scan(conn, facts, clashed)
        return kinds, local, server
    except sqlite3.DatabaseError as exc:  # 스키마가 다른 옛 DB 등
        print(f"  (건너뜀: {exc})")
        return Counter(), [], []
    finally:
        if conn is not None:
            conn.close()


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

    facts, clashed = load_fact_clashes(manage if manage.is_file() else None)
    print(
        f"서버 팩트(real_credits 있는 행) {len(facts):,}건 · 키 충돌 {len(clashed):,}건 ·"
        f" manage_hub.db {'있음' if facts else '없음/빈값'}"
    )

    contents = sorted(db_dir.glob("acct/*/content_hub.db")) + (
        [db_dir / "content_hub.db"] if (db_dir / "content_hub.db").is_file() else []
    )
    print(f"계정 DB {len(contents)}개를 훑는다\n")

    total: Counter = Counter()
    all_local: list[Candidate] = []
    all_server: list[Candidate] = []
    for index, content in enumerate(contents, 1):
        kinds, local, server = audit_pair(content, facts, clashed)
        total.update(kinds)
        all_local += local
        all_server += server
        print(
            f"  계정 {index:>2}: 지출 {kinds['spend_matched']:>5}건 · 반올림 로컬 {kinds['rounded_metrics']:>4} ·"
            f" 서버 {kinds['rounded_fact']:>4} · 애매 {kinds['ambiguous']:>3} · 설명안됨 {kinds['other_mismatch']:>3}"
        )

    print("\n=== 합계 ===")
    for key in ("spend_matched", "ok_metrics", "ok_fact", "rounded_metrics", "rounded_fact",
                "rounded_fact_only", "purged", "ambiguous", "not_transaction", "other_mismatch", "no_value"):
        if total[key]:
            print(f"  {key:<18} {total[key]:,}")
    gens = {(c.email, c.gen_id) for c in all_local} | {(c.email, c.gen_id) for c in all_server}
    d_local = sum(c.stored - c.exact for c in all_local)
    d_server = sum(c.stored - c.exact for c in all_server)
    print(
        f"\n고쳐야 할 생성물 {len(gens):,}건 — 로컬 메트릭 {len(all_local):,}자리({d_local:+.2f} cr) ·"
        f" 서버 팩트 {len(all_server):,}자리({d_server:+.2f} cr) (+ 는 장부가 실제보다 많게 적힌 것)"
    )
    # ★보정은 각 작업자 PC 에서 한다 — 여기서 고치면 그 PC 가 다음에 보고할 때 옛 값이 되돌아온다.
    dead = sum(1 for c in all_local if not c.alive)
    if dead:
        print(f"  (로컬 메트릭 중 {dead:,}자리는 생성물이 지워져 재전송으로 서버가 안 따라온다)")
    if total["rounded_fact_only"]:
        print(f"  (서버 자리 {total['rounded_fact_only']:,}개는 로컬 값이 없어 어느 PC 보정으로도 안 따라온다)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
