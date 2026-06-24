#!/usr/bin/env python3
"""고아 생성자('팀원') 정리 — 관리자 멤버 목록에 뜨는 '계정 없는 외부 생성자' 청소.

배경:
  관리자 창의 멤버 목록은 ① 등록 계정 + ② '계정 없는 외부 생성자'(가져온 번들 작성자 등,
  generation.creator_uid 는 있는데 그 uid 에 연결된 account 가 없는 경우)를 합쳐 보여준다.
  ②는 이름(creator.name)도 없으면 화면에 자리표시자 '팀원' 으로 뜬다 — 진짜 로그인 계정이 아니라
  생성물에 남은 흔적일 뿐이다. 이 스크립트는 그런 고아 uid 와 그 생성물을 점검/정리한다.

★기본은 점검(dry-run)만 — 아무것도 바꾸지 않는다. 실제 변경은 `--apply` 를 줄 때만.
  반드시 공유 서버(DB 가 있는 그 PC)에서 실행하세요. 표준 라이브러리만 사용.

사용 예:
  # 1) 점검(무변경) — 고아 생성자와 그 생성물을 그냥 보여줌
  python cleanup_orphan_creators.py

  # 2) 특정 고아 1명의 생성물을 진짜 계정(예: Jay)으로 귀속 전환(권장 — 데이터 보존)
  python cleanup_orphan_creators.py --uid user_XXXX --reassign-to user_36s5YdXQWtoHy3m52732VBeW6oQ --apply

  # 3) 고아 생성물을 소유자 없음으로 분리(멤버 목록에서만 사라짐, 본체 보존)
  python cleanup_orphan_creators.py --uid user_XXXX --null-owner --apply

  # 4) 고아 생성물을 완전 삭제(앱과 동일한 연쇄 정리 — share/history/comment/tag/ref/asset 까지)
  python cleanup_orphan_creators.py --uid user_XXXX --delete --apply
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from pathlib import Path


def _default_db() -> Path:
    """앱과 동일하게 DB 경로 해석: CONTENT_HUB_DB > CONTENT_HUB_DATA/db > ./data/db."""
    env_db = os.environ.get("CONTENT_HUB_DB")
    if env_db:
        return Path(env_db).resolve()
    data = Path(os.environ.get("CONTENT_HUB_DATA", Path(__file__).resolve().parent / "data"))
    return (data / "db" / "content_hub.db").resolve()


def _orphans(conn: sqlite3.Connection) -> list[dict]:
    """계정 없는 외부 생성자 = generation.creator_uid 인데 account 에 연결 안 된 uid.
    (deleted_at 무관 — 멤버 목록 카운트가 deleted_at 을 안 보므로 동일 기준으로 센다.)"""
    rows = conn.execute(
        "SELECT g.creator_uid uid, COUNT(*) cnt, c.name name "
        "FROM generation g LEFT JOIN creator c ON c.uid = g.creator_uid "
        "WHERE g.creator_uid IS NOT NULL "
        "  AND g.creator_uid NOT IN (SELECT creator_uid FROM account WHERE creator_uid IS NOT NULL) "
        "GROUP BY g.creator_uid, c.name ORDER BY cnt"
    ).fetchall()
    return [{"uid": r[0], "cnt": r[1], "name": r[2]} for r in rows]


def _gens_of(conn: sqlite3.Connection, uid: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT g.id, g.job_id, g.prompt, g.model, g.project_id, g.created_at, g.deleted_at, "
        "       EXISTS(SELECT 1 FROM share s WHERE s.generation_id = g.id) shared "
        "FROM generation g WHERE g.creator_uid = ? ORDER BY g.created_at",
        (uid,),
    ).fetchall()


def _delete_generation(conn: sqlite3.Connection, gen_id: str) -> bool:
    """app/repo/generations.py::_delete_generation 과 동일한 연쇄 정리(복붙 이식)."""
    conn.execute("DELETE FROM share WHERE generation_id=?", (gen_id,))
    conn.execute("DELETE FROM history WHERE parent_gen_id=? OR child_gen_id=?", (gen_id, gen_id))
    try:
        conn.execute(
            "DELETE FROM generation_comment_seen WHERE comment_id IN "
            "(SELECT id FROM generation_comment WHERE gen_id=?)",
            (gen_id,),
        )
    except sqlite3.OperationalError:
        pass
    conn.execute("DELETE FROM generation_comment WHERE gen_id=?", (gen_id,))
    conn.execute("DELETE FROM generation_comment_read WHERE gen_id=?", (gen_id,))
    conn.execute("DELETE FROM gen_tag WHERE generation_id=?", (gen_id,))
    conn.execute("DELETE FROM gen_auto_tag WHERE generation_id=?", (gen_id,))
    conn.execute("DELETE FROM gen_reference WHERE generation_id=?", (gen_id,))
    conn.execute("DELETE FROM asset WHERE generation_id=?", (gen_id,))
    return conn.execute("DELETE FROM generation WHERE id=?", (gen_id,)).rowcount > 0


def main() -> None:
    ap = argparse.ArgumentParser(description="고아 생성자('팀원') 점검/정리")
    ap.add_argument("--db", help="DB 경로(기본: 앱과 동일 해석)")
    ap.add_argument("--uid", help="대상 고아 uid 1명(생략 시 전체 고아 점검만)")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--reassign-to", metavar="UID", help="대상 고아의 생성물을 이 계정 uid 로 귀속 전환")
    g.add_argument("--null-owner", action="store_true", help="대상 고아의 생성물을 소유자 없음으로 분리")
    g.add_argument("--delete", action="store_true", help="대상 고아의 생성물을 완전 삭제(연쇄 정리)")
    ap.add_argument("--apply", action="store_true", help="실제 변경(이 플래그 없으면 점검만)")
    args = ap.parse_args()

    db = Path(args.db).resolve() if args.db else _default_db()
    if not db.exists():
        sys.exit(f"[오류] DB 를 찾을 수 없습니다: {db}")
    print(f"[DB] {db}")
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")

    orphans = _orphans(conn)
    if not orphans:
        print("[결과] 계정 없는 외부 생성자가 없습니다 — 정리할 게 없습니다.")
        return

    print(f"[점검] 계정 없는 외부 생성자 {len(orphans)}명:")
    for o in orphans:
        label = o["name"] or "(이름 없음 → 화면엔 '팀원')"
        print(f"  · uid={o['uid']}  생성물={o['cnt']}  이름={label}")

    if not args.uid:
        print("\n특정 1명을 정리하려면 --uid <uid> 와 함께 --reassign-to/--null-owner/--delete 중 하나를,")
        print("그리고 실제 적용은 --apply 를 추가하세요(지금은 점검만).")
        return

    target = next((o for o in orphans if o["uid"] == args.uid), None)
    if not target:
        sys.exit(f"[오류] --uid {args.uid} 는 고아 생성자 목록에 없습니다(이미 계정 연결됨이거나 오타).")

    gens = _gens_of(conn, args.uid)
    print(f"\n[대상] uid={args.uid} 의 생성물 {len(gens)}건:")
    for r in gens:
        flag = []
        if r["shared"]:
            flag.append("공유됨")
        if r["deleted_at"]:
            flag.append("삭제표시")
        tag = (" [" + ",".join(flag) + "]") if flag else ""
        print(f"  - {r['created_at']}  job={r['job_id']}  model={r['model']}  "
              f"id={r['id']}{tag}")
        print(f"      prompt: {(r['prompt'] or '')[:80]}")

    action = "reassign" if args.reassign_to else "null" if args.null_owner else "delete" if args.delete else None
    if not action:
        print("\n(액션 미지정 — 점검만 했습니다. --reassign-to/--null-owner/--delete 중 하나를 주세요.)")
        return

    if action == "reassign":
        what = f"creator_uid 를 {args.reassign_to} 로 전환"
    elif action == "null":
        what = "creator_uid 를 NULL 로 분리"
    else:
        what = "생성물 완전 삭제(연쇄 정리)"

    if not args.apply:
        print(f"\n[DRY-RUN] --apply 없음 → 변경 안 함. 적용하면: {len(gens)}건의 {what}.")
        return

    try:
        conn.execute("BEGIN")
        if action == "reassign":
            conn.execute(
                "UPDATE generation SET creator_uid=? WHERE creator_uid=?",
                (args.reassign_to, args.uid),
            )
        elif action == "null":
            conn.execute(
                "UPDATE generation SET creator_uid=NULL WHERE creator_uid=?", (args.uid,)
            )
        else:
            for r in gens:
                _delete_generation(conn, r["id"])
        # 고아 creator 행도 정리(있으면) — 더는 참조되지 않음
        if action in ("null", "delete"):
            conn.execute("DELETE FROM creator WHERE uid=?", (args.uid,))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    print(f"\n[완료] {len(gens)}건 {what} 적용. 관리자 창 새로고침 시 '팀원' 항목이 사라집니다"
          " (reassign 은 그 계정으로 합쳐짐).")


if __name__ == "__main__":
    main()
