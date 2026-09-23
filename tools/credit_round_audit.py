"""옛 반올림 크레딧 판별 — 읽기 전용. 아무것도 고치지 않는다.

왜: 2026-09-11 에 소수 보존을 고치기 전(릴리스 `2026.09.16-1209` 이전)에 매칭된 실제 사용액은
`round(abs(credits))` 로 적혔다(−1.5 → 2, −0.12 → 0). 재매칭은 `real_credits IS NULL` 인 행만
채우므로(`repo/manage_transactions.py`) 이미 적힌 값은 자동으로 안 고쳐진다.
원본 거래 금액(`credit_txn.credits`)은 소수 그대로라 되살릴 수 있다.

쓰는 법(PowerShell):
    python tools\\credit_round_audit.py --content <content_hub.db> [--manage <manage_hub.db>] [--samples 20]

기본값은 환경변수 `CONTENT_HUB_DB`, 없으면 `backend\\data\\content_hub.db` 다.
**사본을 보는 것을 권한다** — 열려 있는 DB 를 직접 읽으면 진행 중 쓰기와 섞인 순간을 볼 수 있다.

분류:
  rounded_metrics   원본은 소수인데 `generation_metrics.real_credits` 가 그 값을 반올림한 정수 — 되살릴 수 있다
  rounded_fact      서버 팩트(`team_generation_fact.real_credits`)가 반올림 — 화면이 읽는 값이라 이쪽도 고쳐야 한다
                    (두 곳을 **각각** 본다 — 한쪽이 맞아도 다른 쪽이 틀릴 수 있다)
  purged            거래는 남았는데 생성물 메트릭이 없다(영구 삭제) — 서버 팩트만 보정 대상
  ambiguous         한 생성물에 거래가 여럿 붙었거나 같은 거래 신원이 여러 행 — 손으로 봐야 한다
  other_mismatch    반올림으로 설명되지 않는 차이 — 손으로 봐야 한다
"""

from __future__ import annotations

import argparse
import os
import sqlite3
from collections import Counter
from pathlib import Path

def _connect_ro(path: Path) -> sqlite3.Connection:
    """읽기 전용 연결. Windows 경로의 `#`·`%` 때문에 URI 를 손으로 조립하지 않는다(옛 사고)."""
    uri = Path(path).absolute().as_uri() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    return conn


def _is_int(value: float) -> bool:
    """정수인가 — 허용오차를 두지 않는다(Codex 2026-09-23). DB 의 float 를 그대로 읽은 값이라,
    미세 차이를 '같다'로 뭉개면 진짜 어긋난 행을 ok 로 숨기고 정수가 아닌 값을 후보로 넣는다."""
    return float(value).is_integer()


def _who(row, show_ids: bool) -> str:
    """사례 한 줄의 주인 표기 — 기본은 **가린다**(결과를 그대로 공유해도 되게). 모델명만 남긴다."""
    if show_ids:
        return f"{row['email']} {row['matched_gen_id']}"
    return str(row["display_name"] or "모델 미상")


def audit(content_db: Path, manage_db: Path | None, samples: int, show_ids: bool = False) -> int:
    conn = _connect_ro(content_db)
    facts: dict[tuple[str, str], float] = {}
    clashed: set[tuple[str, str]] = set()  # 정규화하면 같아지는 서버 팩트 키 — 어느 쪽이 맞는지 모른다
    if manage_db and manage_db.exists():
        mconn = _connect_ro(manage_db)
        try:
            for row in mconn.execute(
                "SELECT LOWER(TRIM(account_email)) AS email, local_gen_id, real_credits "
                "FROM team_generation_fact WHERE real_credits IS NOT NULL"
            ):
                key = (row["email"], row["local_gen_id"])
                value = float(row["real_credits"])
                if key in facts and facts[key] != value:
                    clashed.add(key)
                facts[key] = value
        finally:
            mconn.close()

    rows = conn.execute(
        "SELECT t.id AS txn_id, LOWER(TRIM(COALESCE(t.account_email,''))) AS email, t.matched_gen_id, "
        "t.created_at, t.action, t.credits, t.display_name, "
        "m.gen_id AS metrics_gen, m.real_credits AS metrics_real, m.credit_source, m.matched "
        "FROM credit_txn t LEFT JOIN generation_metrics m ON m.gen_id = t.matched_gen_id "
        "WHERE t.matched_gen_id IS NOT NULL AND typeof(t.credits) IN ('integer','real') "
        "AND t.action='spend' ORDER BY t.created_at"
    ).fetchall()

    # ★중복은 **거래표 전체**에서 센다(Codex 2026-09-23). 연결된 지출만 세면 같은 생성물에 붙은
    #  다른 종류(환불 등)나 같은 신원의 미연결 복제 행을 못 봐 애매한 행을 '안전'으로 넘긴다.
    per_gen: Counter = Counter()
    per_identity: Counter = Counter()
    for other in conn.execute(
        "SELECT LOWER(TRIM(COALESCE(account_email,''))) AS email, matched_gen_id, created_at, "
        "credits, action, display_name FROM credit_txn"
    ):
        if other["matched_gen_id"]:
            per_gen[(other["email"], other["matched_gen_id"])] += 1
        per_identity[
            (other["email"], other["created_at"], other["credits"], other["action"], other["display_name"])
        ] += 1

    kinds: Counter[str] = Counter()
    delta = {"metrics": 0.0, "fact": 0.0}  # 장부가 실제보다 얼마나 더(+)/덜(−) 적혔나 — 자리별로
    repair_gens: set[tuple[str, str]] = set()  # 고쳐야 할 **생성물**(자리 수가 아니라)
    shown = 0
    print(f"거래(spend, 생성물에 연결됨) {len(rows)}건 검사 — {content_db}")
    for r in rows:
        exact = abs(float(r["credits"]))
        stored = None if r["metrics_real"] is None else float(r["metrics_real"])
        fact = facts.get((r["email"], r["matched_gen_id"]))
        ambiguous = (
            (r["email"], r["matched_gen_id"]) in clashed
            or per_gen[(r["email"], r["matched_gen_id"])] > 1
            or per_identity[(r["email"], r["created_at"], r["credits"], r["action"], r["display_name"])] > 1
        )
        # ★로컬 메트릭과 서버 팩트를 **각각** 본다(Codex 코드 리뷰 2026-09-23). 한쪽만 보면
        #  '로컬은 맞는데 서버만 반올림' 같은 경우를 통째로 ok 로 넘긴다 — 화면은 서버 팩트를 읽는다.
        places = [("metrics", stored), ("fact", fact)]
        if all(value is None for _, value in places):
            kinds["purged" if r["metrics_gen"] is None else "no_value"] += 1
            continue
        # ★애매한 거래는 값이 우연히 맞아도 **먼저** 걸러 낸다(Codex 2026-09-23). ok 를 먼저 보면
        #  중복 연결인데 한 값이 맞다는 이유로 '문제 없음'이 된다. 거래당 한 번만 센다.
        if ambiguous:
            kinds["ambiguous"] += 1
            continue
        # 거래에서 온 값만 되살린다 — 손으로 적었거나 견적에서 온 값이 우연히 반올림 모양일 수 있다.
        from_transaction = r["credit_source"] == "transaction" and bool(r["matched"])
        for where, observed in places:
            if observed is None:
                continue
            if observed == exact:
                kinds[f"ok_{where}"] += 1
                continue
            if where == "metrics" and not from_transaction:
                kinds["not_transaction"] += 1
                continue
            # 옛 코드는 파이썬 round() 였다 — SQLite round() 와 .5 규칙이 달라 여기서도 파이썬으로 판정한다.
            if _is_int(observed) and observed == float(round(exact)) and not _is_int(exact):
                kinds[f"rounded_{where}"] += 1
                delta[where] += observed - exact
                repair_gens.add((r["email"], r["matched_gen_id"]))
                if shown < samples:
                    shown += 1
                    print(
                        f"  [반올림·{where}] {r['created_at'][:10]} {_who(r, show_ids)} "
                        f"장부 {observed} ← 실제 {exact} (차이 {observed - exact:+.2f})"
                    )
                continue
            kinds["other_mismatch"] += 1
            if shown < samples:
                shown += 1
                print(
                    f"  [설명안됨·{where}] {r['created_at'][:10]} {_who(r, show_ids)} "
                    f"장부 {observed} vs 실제 {exact}"
                )
    conn.close()

    print("\n분류별 건수")
    for kind in ("ok_metrics", "ok_fact", "rounded_metrics", "rounded_fact", "purged", "ambiguous",
                 "not_transaction", "other_mismatch", "no_value"):
        if kinds[kind]:
            print(f"  {kind:<16} {kinds[kind]}")
    # ★같은 생성물이 로컬·서버 두 곳에서 틀릴 수 있다 — 자리 수를 더하면 고칠 생성물이 두 배로 보이고
    #  어긋난 금액도 두 배가 된다. 생성물 수는 한 번만 세고, 금액은 **자리별로** 따로 적는다.
    print(
        f"\n고쳐야 할 생성물 {len(repair_gens)}건"
        f" — 로컬 메트릭 {kinds['rounded_metrics']}자리({delta['metrics']:+.2f} cr) ·"
        f" 서버 팩트 {kinds['rounded_fact']}자리({delta['fact']:+.2f} cr)"
    )
    if not facts:
        print("(서버 팩트 DB 를 안 줬다 — `--manage` 로 주면 화면이 읽는 값까지 본다)")
    return len(repair_gens)


def main() -> None:
    default_content = os.environ.get("CONTENT_HUB_DB") or str(
        Path(__file__).resolve().parent.parent / "backend" / "data" / "content_hub.db"
    )
    ap = argparse.ArgumentParser(description="옛 반올림 크레딧 판별(읽기 전용)")
    ap.add_argument("--content", default=default_content, help="content_hub.db 경로")
    ap.add_argument("--manage", default=None, help="manage_hub.db 경로(서버 팩트)")
    ap.add_argument("--samples", type=int, default=20, help="본문에 찍을 사례 수")
    ap.add_argument("--show-ids", action="store_true", help="사례에 이메일·생성물 id 까지 찍는다(기본은 가림)")
    args = ap.parse_args()
    content = Path(args.content)
    if not content.exists():
        raise SystemExit(f"DB 가 없다: {content}")
    manage = Path(args.manage) if args.manage else content.parent / "manage_hub.db"
    audit(content, manage, args.samples, args.show_ids)


if __name__ == "__main__":
    main()
