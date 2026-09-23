"""옛 반올림 크레딧 판별 — 읽기 전용. 아무것도 고치지 않는다.

왜: 2026-09-11 에 소수 보존을 고치기 전(릴리스 `2026.09.16-1209` 이전)에 매칭된 실제 사용액은
`round(abs(credits))` 로 적혔다(−1.5 → 2, −0.12 → 0). 재매칭은 `real_credits IS NULL` 인 행만
채우므로(`repo/manage_transactions.py`) 이미 적힌 값은 자동으로 안 고쳐진다.
원본 거래 금액(`credit_txn.credits`)은 소수 그대로라 되살릴 수 있다.

판정은 `credit_round_rules.scan()` 하나만 쓴다 — 보정 도구와 같은 기준이라 "판별엔 안 나왔는데
보정이 건드리는" 행이 생기지 않는다(Codex 리뷰 2026-09-23).

쓰는 법(PowerShell):
    python tools\\credit_round_audit.py --content <content_hub.db> [--manage <manage_hub.db>] [--samples 20]

기본값은 환경변수 `CONTENT_HUB_DB`, 없으면 `backend\\data\\content_hub.db` 다.
**사본을 보는 것을 권한다** — 열려 있는 DB 를 직접 읽으면 진행 중 쓰기와 섞인 순간을 볼 수 있다.

분류:
  rounded_metrics    원본은 소수인데 `generation_metrics.real_credits` 가 그 값을 반올림한 정수 — 되살릴 수 있다
  rounded_fact       서버 팩트(`team_generation_fact.real_credits`)가 반올림 — 화면이 읽는 값이다
                     (두 곳을 **각각** 본다 — 한쪽이 맞아도 다른 쪽이 틀릴 수 있다)
  rounded_fact_only  그중 로컬 값이 아예 없는 것 — 이 PC 를 고쳐도 안 따라온다(서버에서 따로)
  purged             거래는 남았는데 생성물 메트릭이 없다(영구 삭제)
  ambiguous          한 생성물에 거래가 여럿 붙었거나 같은 거래 신원이 여러 행 — 손으로 봐야 한다
  not_transaction    거래에서 온 값이 아니다(견적·손 입력) — 되살리지 않는다
  other_mismatch     반올림으로 설명되지 않는 차이 — 손으로 봐야 한다
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from credit_round_rules import Candidate, connect_ro, load_fact_clashes, scan  # noqa: E402


def _who(item: Candidate, show_ids: bool) -> str:
    """사례 한 줄의 주인 표기 — 기본은 **가린다**(결과를 그대로 공유해도 되게). 모델명만 남긴다."""
    if show_ids:
        return f"{item.email} {item.gen_id}"
    return str(item.display_name or "모델 미상")


def audit(
    content_db: Path, manage_db: Path | None, samples: int, show_ids: bool = False
) -> tuple[list[Candidate], list[Candidate]]:
    """찍고, (로컬에서 되살릴 후보, 서버 팩트 자리) 를 돌려준다.

    첫 번째가 보정 도구가 고르는 것과 **같은 목록**이다."""
    facts, clashed = load_fact_clashes(manage_db)
    conn = connect_ro(content_db)
    try:
        local, server, kinds = scan(conn, facts, clashed)
    finally:
        conn.close()

    print(f"거래(spend, 생성물에 연결됨) {kinds['spend_matched']}건 검사 — {content_db}")
    for where, items in (("metrics", local), ("fact", server)):
        for item in items[:samples]:
            print(
                f"  [반올림·{where}] {item.created_at[:10]} {_who(item, show_ids)} "
                f"장부 {item.stored} ← 실제 {item.exact} (차이 {item.stored - item.exact:+.2f})"
            )

    print("\n분류별 건수")
    for kind in ("ok_metrics", "ok_fact", "rounded_metrics", "rounded_fact", "rounded_fact_only",
                 "purged", "ambiguous", "not_transaction", "other_mismatch", "no_value"):
        if kinds[kind]:
            print(f"  {kind:<18} {kinds[kind]}")
    # ★같은 생성물이 로컬·서버 두 곳에서 틀릴 수 있다 — 자리 수를 더하면 고칠 생성물이 두 배로 보이고
    #  어긋난 금액도 두 배가 된다. 생성물 수는 한 번만 세고, 금액은 **자리별로** 따로 적는다.
    gens = {(c.email, c.gen_id) for c in local} | {(c.email, c.gen_id) for c in server}
    d_local = sum(c.stored - c.exact for c in local)
    d_server = sum(c.stored - c.exact for c in server)
    print(
        f"\n고쳐야 할 생성물 {len(gens)}건"
        f" — 로컬 메트릭 {len(local)}자리({d_local:+.2f} cr) · 서버 팩트 {len(server)}자리({d_server:+.2f} cr)"
    )
    if kinds["rounded_fact_only"]:
        print(f"  (그중 {kinds['rounded_fact_only']}자리는 로컬 값이 없어 이 PC 보정으로는 안 따라온다)")
    if not facts:
        # 준 DB 가 비어 있는 것과 아예 안 준 것은 뜻이 다르다 — 앞은 "그 허브엔 팀 팩트가 없다"는 사실이다.
        print(
            "(서버 팩트가 0건이다 — 이 허브에 팀 팩트가 없다)" if manage_db and Path(manage_db).exists()
            else "(서버 팩트 DB 를 안 줬다 — `--manage` 로 주면 화면이 읽는 값까지 본다)"
        )
    return local, server


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
