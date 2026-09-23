"""옛 반올림 크레딧 되살리기 — 기본은 **예행연습**. 쓰기는 `--apply` 를 줘야만 한다.

무엇을 고치나: 거래에서 온 실제 사용액이 옛 코드의 `round(abs(credits))` 로 적힌 행을
원본 `ABS(credit_txn.credits)` 로 되돌린다. 판정 기준은 `credit_round_audit.py` 와 같다
(거래 유래·중복 없음·정수로 반올림된 모양만). 설명되지 않는 차이는 건드리지 않는다.

**순서가 중요하다**: 원천은 각 PC 의 `generation_metrics` 다. 서버 팩트(`team_generation_fact`)를
먼저 고치면, 그 PC 가 다음에 그 생성물을 보고할 때 옛 값이 되돌아온다
(`manage_db._UPSERT_SET` 이 `real_credits=COALESCE(새값, 기존값)` 이라 비어 있지 않은 옛 값이 이긴다).
그래서 이 도구는 **로컬 메트릭만 고치고**, 같은 트랜잭션에서 재전송 표시(telemetry outbox dirty)를 남긴다.
서버는 평소 전송이 돌면서 갱신된다.

쓰는 법(PowerShell):
    # 1) 예행연습 — 무엇을 고칠지만 본다(아무것도 안 바꾼다)
    <파이썬> tools\\credit_round_repair.py --content "<...>\\content_hub.db"
    # 2) 진짜 고치기 — 백업을 먼저 뜨고 실행한다
    <파이썬> tools\\credit_round_repair.py --content "<...>\\content_hub.db" --apply

앱을 끄고 실행하는 것을 권한다(WAL 잠금 대기를 피한다).
"""

from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path


def _is_int(value: float) -> bool:
    return float(value).is_integer()


def find_candidates(conn: sqlite3.Connection) -> tuple[list[tuple[str, float, float]], dict[str, int]]:
    """되살릴 (gen_id, 지금 값, 원본 값) 목록과 건너뛴 이유별 건수.

    판정은 `credit_round_audit.py` 와 같다 — 거래표 **전체**에서 중복을 세고, 거래 유래만 본다."""
    conn.row_factory = sqlite3.Row
    per_gen: dict[tuple[str, str], int] = {}
    per_identity: dict[tuple, int] = {}
    for row in conn.execute(
        "SELECT LOWER(TRIM(COALESCE(account_email,''))) AS email, matched_gen_id, created_at, "
        "credits, action, display_name FROM credit_txn"
    ):
        if row["matched_gen_id"]:
            key = (row["email"], row["matched_gen_id"])
            per_gen[key] = per_gen.get(key, 0) + 1
        ident = (row["email"], row["created_at"], row["credits"], row["action"], row["display_name"])
        per_identity[ident] = per_identity.get(ident, 0) + 1

    skipped: dict[str, int] = {}
    out: list[tuple[str, float, float]] = []
    for r in conn.execute(
        "SELECT LOWER(TRIM(COALESCE(t.account_email,''))) AS email, t.matched_gen_id, t.created_at, "
        "t.credits, t.action, t.display_name, m.real_credits, m.credit_source, m.matched "
        "FROM credit_txn t JOIN generation_metrics m ON m.gen_id = t.matched_gen_id "
        "WHERE t.action='spend' AND t.matched_gen_id IS NOT NULL "
        "AND typeof(t.credits) IN ('integer','real') AND m.real_credits IS NOT NULL"
    ):
        exact = abs(float(r["credits"]))
        stored = float(r["real_credits"])
        ident = (r["email"], r["created_at"], r["credits"], r["action"], r["display_name"])
        if stored == exact:
            skipped["이미 맞음"] = skipped.get("이미 맞음", 0) + 1
            continue
        if per_gen.get((r["email"], r["matched_gen_id"]), 0) > 1 or per_identity.get(ident, 0) > 1:
            skipped["애매(중복 연결·중복 신원)"] = skipped.get("애매(중복 연결·중복 신원)", 0) + 1
            continue
        if r["credit_source"] != "transaction" or not r["matched"]:
            skipped["거래에서 온 값이 아님"] = skipped.get("거래에서 온 값이 아님", 0) + 1
            continue
        if not (_is_int(stored) and stored == float(round(exact)) and not _is_int(exact)):
            skipped["반올림으로 설명 안 됨"] = skipped.get("반올림으로 설명 안 됨", 0) + 1
            continue
        out.append((r["matched_gen_id"], stored, exact))
    return out, skipped


def backup(db: Path) -> Path:
    """고치기 전 사본 — SQLite Backup API 로 일관된 스냅샷(같은 폴더에 시각을 붙여 남긴다)."""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dst = db.with_name(f"{db.stem}.before-credit-repair-{stamp}.db")
    src = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    try:
        with sqlite3.connect(dst) as out:
            src.backup(out)
    finally:
        src.close()
    return dst


def apply_repair(db: Path, rows: list[tuple[str, float, float]]) -> int:
    """한 트랜잭션에서 값 교정 + 재전송 표시. 값만 고치고 outbox 를 안 남기면 서버는 옛 값 그대로다."""
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
    from app.repo.manage_telemetry import mark_telemetry_dirty_in_connection  # noqa: E402

    conn = sqlite3.connect(db)
    try:
        conn.execute("BEGIN IMMEDIATE")
        changed = 0
        for gen_id, stored, exact in rows:
            cur = conn.execute(
                # 읽은 그 값일 때만 바꾼다 — 그 사이 누가 고쳤으면 건드리지 않는다.
                "UPDATE generation_metrics SET real_credits=? "
                "WHERE gen_id=? AND real_credits=? AND credit_source='transaction' AND matched=1",
                (exact, gen_id, stored),
            )
            changed += cur.rowcount
        mark_telemetry_dirty_in_connection(conn, [gen_id for gen_id, _, _ in rows])
        conn.execute("COMMIT")
        return changed
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="옛 반올림 크레딧 되살리기(기본 예행연습)")
    ap.add_argument("--content", required=True, help="content_hub.db 경로(그 PC 의 계정 DB)")
    ap.add_argument("--apply", action="store_true", help="진짜 고친다(주지 않으면 예행연습)")
    ap.add_argument("--samples", type=int, default=5, help="예행연습에서 보여 줄 사례 수")
    args = ap.parse_args()
    db = Path(args.content)
    if not db.exists():
        print(f"DB 가 없다: {db}")
        return 1

    mode = "file:" + db.as_posix() + ("" if args.apply else "?mode=ro")
    conn = sqlite3.connect(mode, uri=True)
    try:
        rows, skipped = find_candidates(conn)
    finally:
        conn.close()

    total = sum(exact - stored for _, stored, exact in rows)
    print(f"되살릴 행 {len(rows)}건 · 장부를 {total:+.2f} 크레딧 만큼 바로잡는다 — {db}")
    for gen_id, stored, exact in rows[: args.samples]:
        print(f"  {gen_id[:8]}…  {stored} → {exact}")
    if skipped:
        print("건너뜀: " + " · ".join(f"{k} {v}" for k, v in sorted(skipped.items())))
    if not args.apply:
        print("\n예행연습이다(아무것도 안 바꿨다). 진짜 고치려면 `--apply` 를 준다.")
        return 0
    if not rows:
        print("고칠 것이 없다.")
        return 0

    saved = backup(db)
    print(f"\n백업: {saved}")
    changed = apply_repair(db, rows)
    print(f"고친 행 {changed}건 · 재전송 표시 {len(rows)}건 — 에이전트가 돌면 서버 팩트도 갱신된다")
    if changed != len(rows):
        print("(그 사이 값이 바뀐 행은 건드리지 않았다 — 다시 예행연습해 남은 것을 확인한다)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
