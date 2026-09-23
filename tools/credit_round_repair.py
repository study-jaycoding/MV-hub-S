"""옛 반올림 크레딧 되살리기 — 기본은 **예행연습**. 쓰기는 `--apply` 를 줘야만 한다.

무엇을 고치나: 거래에서 온 실제 사용액이 옛 코드의 `round(abs(credits))` 로 적힌 행을 원본
`ABS(credit_txn.credits)` 로 되돌린다. 판정은 `credit_round_rules.scan()` 하나만 쓴다 — 판별기와 같은 규칙이라
"판별엔 안 나왔는데 보정이 건드리는" 행이 생기지 않는다.

**순서가 중요하다**: 원천은 각 PC 의 `generation_metrics` 다. 서버 팩트(`team_generation_fact`)를 먼저 고치면,
그 PC 가 다음에 그 생성물을 보고할 때 옛 값이 되돌아온다(`manage_db._UPSERT_SET` 이
`real_credits=COALESCE(새값, 기존값)` 이라 비어 있지 않은 옛 값이 이긴다). 그래서 **로컬 메트릭만** 고치고,
같은 트랜잭션에서 재전송 표시를 남긴다. 서버는 평소 전송이 돌면서 갱신된다.

★쓰기 안전(Codex 리뷰 2026-09-23):
 · 후보는 **쓰기 잠금을 잡은 뒤 다시 계산한다** — 조회~쓰기 사이에 앱이 거래를 더하면 옛 판정이 된다.
 · 살아 있는 생성물만 재전송 표시를 한다. 삭제 통보(tombstone)를 일반 dirty 로 덮으면 그 통보가 사라진다.
 · 실제로 바뀐 행만 재전송 대상으로 센다.

쓰는 법(PowerShell) — **앱(MV_agent 창)을 끄고** 실행한다:
    <파이썬> tools\\credit_round_repair.py --content "<...>\\content_hub.db"            # 예행연습
    <파이썬> tools\\credit_round_repair.py --content "<...>\\content_hub.db" --apply     # 진짜 고치기
"""

from __future__ import annotations

import argparse
import hashlib
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from credit_round_rules import Candidate, connect_ro, load_fact_clashes, scan  # noqa: E402


def _describe(item: Candidate, show_ids: bool) -> str:
    who = item.gen_id if show_ids else (item.display_name or "모델 미상")
    return f"  {item.created_at[:10]} {who}  {item.stored} → {item.exact}"


def backup(db: Path) -> tuple[Path, str]:
    """고치기 전 사본(Backup API — WAL 까지 일관) + 무결성 확인. (경로, sha256) 을 돌려준다."""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dst = db.with_name(f"{db.stem}.before-credit-repair-{stamp}.db")
    serial = 1
    while dst.exists():  # 같은 초에 두 번 돌려도 앞 백업을 덮지 않는다
        serial += 1
        dst = db.with_name(f"{db.stem}.before-credit-repair-{stamp}-{serial}.db")
    src = connect_ro(db)
    try:
        with sqlite3.connect(dst) as out:
            src.backup(out)
    finally:
        src.close()
    check = sqlite3.connect(dst)
    try:
        ok = check.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        check.close()
    if ok != "ok":
        raise SystemExit(f"백업이 온전하지 않다({ok}) — 보정을 멈춘다: {dst}")
    digest = hashlib.sha256(dst.read_bytes()).hexdigest()
    return dst, digest


def apply_repair(db: Path, facts=None, clashed=None) -> tuple[int, int, list[Candidate]]:
    """쓰기 잠금을 잡고 **그 안에서 다시 판정**해 고친다. (고친 행, 재전송 표시, 서버에만 있는 것)."""
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
    from app.repo.manage_telemetry import mark_telemetry_dirty_in_connection  # noqa: E402

    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("BEGIN IMMEDIATE")  # 잠금부터 — 이 뒤의 판정이 곧 쓰기 대상이다
        local, facts_place, _ = scan(conn, facts, clashed)
        changed: list[Candidate] = []
        for item in local:
            cur = conn.execute(
                # 읽은 그 값일 때만 바꾼다 — 같은 트랜잭션이라도 계약을 코드에 남긴다.
                "UPDATE generation_metrics SET real_credits=? "
                "WHERE gen_id=? AND real_credits=? AND credit_source='transaction' AND matched=1",
                (item.exact, item.gen_id, item.stored),
            )
            if cur.rowcount == 1:
                changed.append(item)
        # ★살아 있는 생성물만 재전송 표시 — 삭제 통보(tombstone)를 일반 dirty 로 덮으면 그 통보를 잃는다.
        resend = [item.gen_id for item in changed if item.alive]
        mark_telemetry_dirty_in_connection(conn, resend)
        conn.execute("COMMIT")
        return len(changed), len(resend), [c for c in facts_place if not c.has_local]
    except Exception:
        if conn.in_transaction:  # 잠금 자체를 못 잡았으면 롤백할 것이 없다(원래 오류를 가리지 않게)
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="옛 반올림 크레딧 되살리기(기본 예행연습)")
    ap.add_argument("--content", required=True, help="content_hub.db 경로(그 PC 의 계정 DB)")
    ap.add_argument("--manage", default=None, help="manage_hub.db(있으면 서버 팩트 충돌까지 본다)")
    ap.add_argument("--apply", action="store_true", help="진짜 고친다(주지 않으면 예행연습)")
    ap.add_argument("--samples", type=int, default=5, help="보여 줄 사례 수")
    ap.add_argument("--show-ids", action="store_true", help="생성물 id 를 찍는다(기본은 가림)")
    args = ap.parse_args()
    db = Path(args.content)
    if not db.exists():
        print(f"DB 가 없다: {db}")
        return 1
    facts, clashed = load_fact_clashes(Path(args.manage) if args.manage else db.parent / "manage_hub.db")

    conn = connect_ro(db)
    try:
        local, facts_place, kinds = scan(conn, facts, clashed)
    finally:
        conn.close()

    fix = sum(item.exact - item.stored for item in local)
    print(f"되살릴 행 {len(local)}건 · 장부를 {fix:+.2f} 크레딧 만큼 바로잡는다 — {db}")
    for item in local[: args.samples]:
        print(_describe(item, args.show_ids))
    dead = [item for item in local if not item.alive]
    if dead:
        print(f"  (그중 {len(dead)}건은 로컬 생성물이 없어 값만 고치고 재전송 표시는 하지 않는다)")
    server_only = [c for c in facts_place if not c.has_local]
    if server_only:
        print(f"서버에만 있는 반올림 {len(server_only)}건 — 이 경로로는 못 고친다(모든 PC 보정 뒤 따로)")
    skipped = {k: v for k, v in kinds.items() if k in ("ok_metrics", "ambiguous", "not_transaction",
                                                       "other_mismatch", "purged", "no_value")}
    if skipped:
        print("건너뜀: " + " · ".join(f"{k} {v}" for k, v in sorted(skipped.items())))

    if not args.apply:
        print("\n예행연습이다(아무것도 안 바꿨다). 진짜 고치려면 `--apply` 를 준다. **앱을 끄고** 실행한다.")
        return 0
    if not local:
        print("고칠 것이 없다.")
        return 0

    saved, digest = backup(db)
    print(f"\n백업: {saved}\n백업 sha256: {digest}")
    changed, resend, _ = apply_repair(db, facts, clashed)
    print(f"고친 행 {changed}건 · 재전송 표시 {resend}건 — 에이전트를 켜면 서버 팩트도 갱신된다")
    if changed != len(local):
        print("(그 사이 값이 바뀐 행은 건드리지 않았다 — 다시 예행연습해 남은 것을 확인한다)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
