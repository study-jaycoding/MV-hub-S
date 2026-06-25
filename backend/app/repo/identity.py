"""작업자 / 앱 설정 / 생성자(creator) / 제공자(provider) 신원."""

from __future__ import annotations

import sqlite3
from typing import Any, Optional

from ..config import DEFAULT_WORKER_ID, DEFAULT_WORKER_NAME
from ..db import get_connection
from ._common import _UID_RE, _email_localpart


# ── 작업자 ───────────────────────────────────────────────────────────────
def ensure_worker(
    conn: sqlite3.Connection,
    worker_id: str,
    name: str,
    account_type: str = "personal",
) -> None:
    conn.execute(
        "INSERT INTO worker(id, name, account_type) VALUES(?,?,?) "
        "ON CONFLICT(id) DO NOTHING",
        (worker_id, name, account_type),
    )


def ensure_default_worker() -> None:
    with get_connection() as conn:
        ensure_worker(conn, DEFAULT_WORKER_ID, DEFAULT_WORKER_NAME, "personal")


# ── 생성자(팀 워크스페이스 작성자) ────────────────────────────────────────
_MY_UID_CACHE: list[Any] = [None]  # [value] — None=미확정(매번 재조회), non-None=확정 캐시
_MY_UID_PATH: list[Any] = [None]  # 캐시가 어느 DB 경로 기준인지 — 경로가 바뀌면 자동 무효화


def get_my_uid() -> Optional[str]:
    """내 생성자 uid(순수 읽기). 우선순위: ① 지정/학습된 my_creator_uid 설정 ② 로컬 생성본
    (id<>job_id)의 결과 URL user_<id>. 확정값(non-None)만 캐시 — 아직 못 정했으면 매번 재조회해
    로컬 생성본이 완료되는 즉시 is_mine 이 반영되게 한다.
    ※ 영속화(setting 쓰기)는 여기서 하지 않는다 — 학습은 생성 완료 시점에 learn_my_creator_uid()
      가 명시적으로 수행(읽기 경로에 쓰기 부작용을 두지 않기 위함)."""
    # ★경로 키잉: 계정 전환·DB 이관으로 활성 DB 가 바뀌면 캐시를 자동 무효화한다 — 예전엔 전환마다
    # _MY_UID_CACHE[0]=None 수동 리셋에만 의존해, 새 전환 경로가 리셋을 빠뜨리면 옛 계정 uid 로
    # is_mine 을 오판할 위험이 있었다(기존 수동 리셋들은 방어적 중복으로 그대로 둠).
    from ..db import get_db_path

    path = str(get_db_path())
    if _MY_UID_PATH[0] != path:
        _MY_UID_CACHE[0] = None
        _MY_UID_PATH[0] = path
    if _MY_UID_CACHE[0] is not None:
        return _MY_UID_CACHE[0]
    uid = get_setting("my_creator_uid")
    if not uid:
        with get_connection() as conn:
            row = conn.execute(
                "SELECT creator_uid FROM generation "
                "WHERE id<>job_id AND job_id IS NOT NULL AND creator_uid IS NOT NULL LIMIT 1"
            ).fetchone()
        uid = row["creator_uid"] if row else None
    _MY_UID_CACHE[0] = uid  # None 이면 캐시 안 됨(위 가드에서 매번 재시도)
    return uid


def learn_my_creator_uid(uid: Optional[str]) -> None:
    """허브 생성 완료 시점에 내 user_<id> 를 영속화(이미 정해져 있으면 무시).
    읽기 경로(get_my_uid)가 아니라 생성 완료(jobs._process)에서 명시적으로 호출한다."""
    uid = (uid or "").strip()
    if not uid or get_setting("my_creator_uid"):
        return
    set_setting("my_creator_uid", uid)
    _MY_UID_CACHE[0] = None  # 다음 get_my_uid 가 새 값 반영


def backfill_creator_uids() -> int:
    """creator_uid 없는 gen 을 asset URL(source_url/file_path)의 user_<id> 로 채움. 멱등."""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT g.id, COALESCE(a.source_url, a.file_path) url "
            "FROM generation g JOIN asset a ON a.generation_id=g.id "
            "WHERE g.creator_uid IS NULL"
        ).fetchall()
        n = 0
        for r in rows:
            m = _UID_RE.search(r["url"] or "")
            if m:
                conn.execute(
                    "UPDATE generation SET creator_uid=? WHERE id=?", (m.group(1), r["id"])
                )
                n += 1
    _MY_UID_CACHE[0] = None  # 재계산 트리거(다음 get_my_uid 에서 재조회)
    return n


def list_creators(
    account_uid: Optional[str] = None, tab: str = "my", project_id: Optional[str] = None
) -> list[dict[str, Any]]:
    """생성자 목록 [{uid, name, count, is_mine}] — 사이드바 필터 + 이름붙이기.

    그리드 목록과 같은 범위를 세도록 탭·계정으로 한정한다(예전엔 전체를 세서 '내 작업' 탭에도
    남의 카운트가 떴다):
      · project_id → 그 프로젝트에 **참여한 인원(멤버) 전부**. 클릭 시 팀공유 탭에서 그 사람으로 필터.
        count 는 그 프로젝트에서 그 멤버의 생성물(tab='team'이면 공유된 것)만 센다.
      · tab='my' + account_uid → 로그인 계정 본인 것만(보통 1명 → 사이드바가 자동 숨김).
      · tab='team' → 공유된 결과물의 작성자들.
      · account_uid 없음(비로그인/단독) → 전체(기존 동작 유지)."""
    my = account_uid or get_my_uid()
    if project_id:
        # 프로젝트 생성자 = 배정 멤버 ∪ 그 프로젝트에 실제로 생성물을 만든 작성자.
        # (예전엔 project_member 만 봐서, 멤버 미배정 프로젝트는 생성자 섹션이 통째로 사라졌다.)
        # 이름은 creator→account→로컬파트 폴백(uid 노출 금지).
        share_cond = (
            " AND EXISTS (SELECT 1 FROM share s WHERE s.generation_id = g.id)"
            if tab == "team"
            else ""
        )
        gen_share = (
            " AND EXISTS (SELECT 1 FROM share s WHERE s.generation_id = g2.id)"
            if tab == "team"
            else ""
        )
        with get_connection() as conn:
            # 생성자(배정 멤버 ∪ 실제 작성자) 한 명마다 COUNT 서브쿼리를 돌리던 N+1 을 LEFT JOIN +
            # GROUP BY 1쿼리로(팀 규모만큼 generation 풀스캔하던 비용 제거). LEFT JOIN 이라 기여 0인
            # 배정 멤버도 cnt=0 으로 남고(아래 team 필터가 걸러냄), 매칭 생성물 수가 cnt 가 된다.
            rows = conn.execute(
                "SELECT u.uid uid, COUNT(g.id) cnt "
                "FROM ("
                "  SELECT creator_uid uid FROM project_member "
                "  WHERE project_id=? AND creator_uid IS NOT NULL "
                "  UNION "
                "  SELECT DISTINCT g2.creator_uid uid FROM generation g2 "
                f"  WHERE g2.project_id=? AND g2.creator_uid IS NOT NULL AND g2.deleted_at IS NULL{gen_share}"
                ") u "
                "LEFT JOIN generation g "
                f"  ON g.creator_uid = u.uid AND g.project_id=? AND g.deleted_at IS NULL{share_cond} "
                "GROUP BY u.uid ORDER BY cnt DESC",
                (project_id, project_id, project_id),
            ).fetchall()
            names = resolve_display_names(conn, [r["uid"] for r in rows])
            result = [
                {
                    "uid": r["uid"],
                    "name": names.get(r["uid"]),
                    "count": r["cnt"],
                    "is_mine": r["uid"] == my,
                }
                for r in rows
            ]
            # ★공유(team) 탭에서 프로젝트를 보면 '그 프로젝트에 실제로 공유한 사람'만 보여야 한다.
            # project_member UNION 때문에, 그 프로젝트엔 공유한 적 없고 배정만 됐거나 다른 곳(미분류)에만
            # 작업이 있는 멤버가 count 0 으로 섞여 보이던 버그 → team 탭은 기여자(cnt>0)만 남긴다.
            # ('내 작업' 탭은 배정 멤버 표시가 의미 있어 그대로 둔다.)
            if tab == "team":
                result = [r for r in result if r["count"] > 0]
            # 라이브러리와 일관: '내 작업' 경로에선 멤버·생성물이 없어도 '나'는 항상 보인다.
            if account_uid and tab != "team" and not any(r["uid"] == account_uid for r in result):
                sname = resolve_display_names(conn, [account_uid]).get(account_uid)
                result.insert(
                    0, {"uid": account_uid, "name": sname, "count": 0, "is_mine": account_uid == my}
                )
            return result
    where = ["g.creator_uid IS NOT NULL", "g.deleted_at IS NULL"]
    args: list[Any] = []
    if tab == "team":
        where.append("EXISTS (SELECT 1 FROM share s WHERE s.generation_id = g.id)")
    elif account_uid:
        where.append("g.creator_uid = ?")
        args.append(account_uid)
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT g.creator_uid uid, COUNT(*) cnt "
            "FROM generation g "
            f"WHERE {' AND '.join(where)} "
            "GROUP BY g.creator_uid ORDER BY cnt DESC",
            args,
        ).fetchall()
        # 표시이름은 creator.name 만이 아니라 account.name·이메일까지 폴백(해석기 통일) →
        # 이름 미러 전인 계정도 사이드바에서 '팀원' 대신 제 이름으로 뜬다.
        names = resolve_display_names(conn, [r["uid"] for r in rows])
        result = [
            {"uid": r["uid"], "name": names.get(r["uid"]), "count": r["cnt"], "is_mine": r["uid"] == my}
            for r in rows
        ]
        # My Work 탭: 본인 생성물이 0개여도 '나'는 항상 보인다 — 다른 컴퓨터·새 계정에서도
        # CREATOR 섹션이 사라지지 않게(프로젝트 경로가 멤버 전원을 늘 보여주는 것과 일관).
        if account_uid and tab != "team" and not any(r["uid"] == account_uid for r in result):
            sname = resolve_display_names(conn, [account_uid]).get(account_uid)
            result.insert(
                0, {"uid": account_uid, "name": sname, "count": 0, "is_mine": account_uid == my}
            )
        return result


def resolve_display_names(
    conn: sqlite3.Connection, uids
) -> dict[str, Optional[str]]:
    """creator_uid → 표시이름. 폴백: creator.name → account.name → 이메일 로컬파트.

    이 프로젝트의 **유일한** 작성자/멤버 이름 해석기 — 카드·사이드바·멤버·코멘트가 전부 이걸
    쓴다(같은 규칙). 읽기 시점에 매번 해석하므로 표시이름을 바꾸면(set_account_name 이
    creator.name·account.name 둘 다 갱신) 다른 사람 화면에도 즉시 전파된다.
    UI 에는 절대 uid/이메일을 노출하지 않는다 — 이름이 없으면 None 을 돌려주고 호출측이 '팀원'으로 표기."""
    ids = {u for u in uids if u}
    if not ids:
        return {}
    ph = ",".join("?" * len(ids))
    crow = {
        r["uid"]: r["name"]
        for r in conn.execute(
            f"SELECT uid, name FROM creator WHERE uid IN ({ph})", list(ids)
        ).fetchall()
    }
    arow = {
        r["creator_uid"]: (r["name"], r["email"])
        for r in conn.execute(
            f"SELECT creator_uid, name, email FROM account WHERE creator_uid IN ({ph})",
            list(ids),
        ).fetchall()
    }
    out: dict[str, Optional[str]] = {}
    for u in ids:
        an, ae = arow.get(u, (None, None))
        out[u] = (
            (crow.get(u) or "").strip()
            or (an or "").strip()
            or _email_localpart(ae)
            or None
        )
    return out


# ── 멤버 전역 역할(복수) — v02 RBAC PART 1 ───────────────────────────────
# 전역 4역할 admin/product_director/production_director/member 를 CSV 로 복수 보유 가능.
# ⚠️ enforcement off 면 '식별·표시'까지만 — 실제 차단은 CONTENT_HUB_AUTH=1 일 때.


def _effective_globals(stored: Optional[str], is_mine: bool) -> list[str]:
    """전역 역할 리스트 — 저장값(CSV) 우선, 비어 있으면 나(제공자)=admin, 그 외 member."""
    from .. import rbac

    roles = rbac.parse_roles(stored)
    if roles:
        return roles
    return [rbac.ADMIN] if is_mine else [rbac.MEMBER]


def account_creator_uid(email: str, owner_email: Optional[str], my_uid: Optional[str]) -> str:
    """한 계정(로그인 사용자)의 생성자 uid 를 결정 — 소유자(provider)면 힉스필드 my_creator_uid,
    그 외는 이메일 앵커 합성 uid('acct:<email>'). 멱등·안정(이메일 불변)."""
    email = (email or "").strip().lower()
    if owner_email and email == (owner_email or "").strip().lower() and my_uid:
        return my_uid
    return "acct:" + email


def link_accounts_to_creators() -> int:
    """각 account 에 creator_uid 를 보장하고 creator 행 이름·역할을 account 기준으로 맞춘다(멱등).
    이래야 신규 로그인 계정이 멤버 목록·프로젝트 배정 후보에 뜨고(생성물 0이어도),
    카드 작성자 표기도 계정 이름을 따른다. 시작 시 + 가입 직후 호출."""
    n = 0
    with get_connection() as conn:
        owner_email = get_setting("provider_email")
        my_uid = get_setting("my_creator_uid")
        rows = conn.execute(
            "SELECT email, name, global_role, creator_uid FROM account"
        ).fetchall()
        for r in rows:
            uid = r["creator_uid"] or account_creator_uid(r["email"], owner_email, my_uid)
            if not r["creator_uid"]:
                conn.execute(
                    "UPDATE account SET creator_uid=? WHERE email=?", (uid, r["email"])
                )
                n += 1
            # creator 행 보장 + 전역역할 미러. 계정에 연결된 creator 의 표시이름은 **계정 이름이
            # 우선**(authoritative) — 계정은 허브 신원이고 사용자가 정한 이름이라, 과거 잘못 박힌
            # 라벨(relink 사고로 남의 이름이 stick)을 시작 시 자동 교정한다. 계정명이 비면 기존 보존.
            # (계정에 연결 안 된 동기화 카드 creator 는 이 루프 밖이라 자기 이름 그대로 유지.)
            conn.execute(
                "INSERT INTO creator(uid, name, global_role) VALUES(?,?,?) "
                "ON CONFLICT(uid) DO UPDATE SET "
                "name=COALESCE(excluded.name, creator.name), "
                "global_role=COALESCE(excluded.global_role, creator.global_role)",
                (uid, (r["name"] or "").strip() or None, r["global_role"] or None),
            )
    return n


def set_account_hf_creator(email: str, uid: str) -> bool:
    """push 시 계정을 '실제 힉스필드 생성자 uid'에 연결(합성 acct: uid 를 대체).
    이래야 그 계정 '내 작업'이 자기 힉스필드 생성물(creator_uid=uid)로 채워진다.
    이미 같은 실제 uid 면 그대로. creator 행 표시이름은 계정 이름 우선(authoritative)."""
    email = (email or "").strip().lower()
    uid = (uid or "").strip()
    if not email or not uid:
        return False
    with get_connection() as conn:
        row = conn.execute(
            "SELECT name, creator_uid FROM account WHERE email=?", (email,)
        ).fetchone()
        if not row:
            return False
        if row["creator_uid"] != uid:
            conn.execute(
                "UPDATE account SET creator_uid=? WHERE email=?", (uid, email)
            )
        conn.execute(
            "INSERT INTO creator(uid, name) VALUES(?,?) "
            "ON CONFLICT(uid) DO UPDATE SET name=COALESCE(excluded.name, creator.name)",
            (uid, (row["name"] or "").strip() or None),
        )
    _MY_UID_CACHE[0] = None
    return True


def record_account_status(email: str, status: dict[str, Any]) -> None:
    """push 에이전트가 함께 보고한 그 계정의 힉스필드 상태(크레딧·워크스페이스)를 보관.
    생성정보엔 크레딧이 없으므로, 팀 전체/구성원별 크레딧 집계는 이 '마지막 보고값'으로 한다."""
    import json as _json

    email = (email or "").strip().lower()
    if not email or not isinstance(status, dict):
        return
    set_setting(f"hf_status:{email}", _json.dumps(status, ensure_ascii=False))


def get_reported_status(email: str) -> Optional[dict[str, Any]]:
    """한 계정이 에이전트로 보고한 마지막 힉스필드 상태(크레딧·플랜·워크스페이스) — 계정 메뉴가
    '내 것'을 표시할 때 쓴다. 보고 이력 없으면 None. (브라우저는 그 계정 CLI에 직접 접근 못 함)"""
    import json as _json

    email = (email or "").strip().lower()
    raw = get_setting(f"hf_status:{email}")
    if not raw:
        return None
    try:
        d = _json.loads(raw)
        return d if isinstance(d, dict) else None
    except (ValueError, TypeError):
        return None


def list_account_statuses() -> dict[str, Any]:
    """보관된 계정별 힉스필드 상태 {email: {credits,...}} — 크레딧 집계 뷰용."""
    import json as _json

    out: dict[str, Any] = {}
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT key, value FROM app_setting WHERE key LIKE 'hf_status:%'"
        ).fetchall()
    for r in rows:
        email = r["key"].split("hf_status:", 1)[-1]
        try:
            out[email] = _json.loads(r["value"]) if r["value"] else None
        except (ValueError, TypeError):
            out[email] = None
    return out


def credit_summary() -> dict[str, Any]:
    """팀 크레딧 집계 — 각 계정 에이전트가 push 때 보고한 마지막 account_status 기준.
    생성정보엔 크레딧이 없으므로 이 '마지막 보고값'으로 전체 합계·구성원별을 만든다."""
    statuses = list_account_statuses()  # {email: {credits, plan, ...}}
    with get_connection() as conn:
        names = {
            r["email"]: r["name"]
            for r in conn.execute("SELECT email, name FROM account").fetchall()
        }
    rows: list[dict[str, Any]] = []
    total = 0.0
    for email, st in statuses.items():
        if not isinstance(st, dict):
            continue
        cr = st.get("credits")
        try:
            crv = float(cr) if cr is not None else None
        except (TypeError, ValueError):
            crv = None
        if crv is not None:
            total += crv
        rows.append(
            {
                "email": email,
                "name": (names.get(email) or "").strip() or _email_localpart(email),
                "credits": crv,
                "plan": st.get("plan"),
            }
        )
    rows.sort(key=lambda r: -(r["credits"] or 0))
    return {"total": round(total, 2), "accounts": rows}


def list_members() -> list[dict[str, Any]]:
    """멤버 목록 [{uid, name, global_roles, is_mine, count, email, status}].
    관리자 창·프로젝트 배정 후보용. ① 모든 로그인 계정(생성물 0이어도 포함) +
    ② 계정 없는 외부 생성자(가져온 작업의 작성자)도 표기 유지."""
    my = get_my_uid()
    link_accounts_to_creators()  # 계정↔creator 연결 보장(멱등) — 신규 계정 즉시 후보화
    with get_connection() as conn:
        counts = {
            r["uid"]: r["cnt"]
            for r in conn.execute(
                "SELECT creator_uid uid, COUNT(*) cnt FROM generation "
                "WHERE creator_uid IS NOT NULL GROUP BY creator_uid"
            ).fetchall()
        }
        members: list[dict[str, Any]] = []
        seen: set[str] = set()
        # ① 로그인 계정 = 멤버(권한·신원의 1차 출처). 숨긴 계정은 멤버·배정 후보에서 제외.
        for a in conn.execute(
            "SELECT email, name, status, global_role, creator_uid FROM account "
            "WHERE COALESCE(hidden,0)=0 ORDER BY created_at"
        ).fetchall():
            uid = a["creator_uid"]
            if not uid or uid in seen:
                continue
            seen.add(uid)
            members.append(
                {
                    "uid": uid,
                    "name": (a["name"] or "").strip() or _email_localpart(a["email"]),
                    "global_roles": _effective_globals(a["global_role"], uid == my),
                    "is_mine": uid == my,
                    "count": counts.get(uid, 0),
                    "email": a["email"],
                    "status": a["status"],
                }
            )
        # ② 계정 없는 외부 생성자(가져온 번들 작성자 등)도 목록 유지. 단, '숨긴 계정'에 연결된 uid 는
        #    제외한다 — 생성물이 있는 계정은 ①에서 숨겨도 여기서 다시 들어와('숨기기'가 멤버·프로젝트
        #    후보에서 안 먹던 버그). 계정 없는 순수 외부 생성자(account 에 없음)는 그대로 유지된다.
        for r in conn.execute(
            "SELECT g.creator_uid uid, COUNT(*) cnt, c.name name, c.global_role grole "
            "FROM generation g LEFT JOIN creator c ON c.uid=g.creator_uid "
            "WHERE g.creator_uid IS NOT NULL "
            "AND g.creator_uid NOT IN ("
            "  SELECT creator_uid FROM account WHERE COALESCE(hidden,0)=1 AND creator_uid IS NOT NULL) "
            "GROUP BY g.creator_uid, c.name, c.global_role"
        ).fetchall():
            if r["uid"] in seen:
                continue
            seen.add(r["uid"])
            members.append(
                {
                    "uid": r["uid"],
                    "name": r["name"],
                    "global_roles": _effective_globals(r["grole"], r["uid"] == my),
                    "is_mine": r["uid"] == my,
                    "count": r["cnt"],
                    "email": None,
                    "status": None,
                }
            )
    # 생성물 많은 순 → 이름순(계정이 위로 오도록 count 동률이면 이름)
    members.sort(key=lambda m: (-m["count"], (m["name"] or "").lower()))
    return members


def set_member_global_roles(uid: str, global_roles) -> None:
    """멤버 전역 역할(복수) 부여 — 리스트/CSV → CSV 저장. 연결된 account 에도 미러."""
    from .. import rbac

    csv = rbac.roles_to_str(global_roles)
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO creator(uid, global_role) VALUES(?,?) "
            "ON CONFLICT(uid) DO UPDATE SET global_role=excluded.global_role",
            (uid, csv),
        )
        conn.execute(
            "UPDATE account SET global_role=? WHERE creator_uid=?", (csv or rbac.MEMBER, uid)
        )


def set_creator_name(uid: str, name: Optional[str], overwrite: bool = True) -> None:
    """생성자 uid 에 사용자 지정 이름 부여(CLI 가 uid→이름을 안 주므로).
    overwrite=False 면 이미 이름이 있는 경우 보존(받은 번들의 이름이 내 로컬 명명을 침범하지 않게)."""
    conflict = (
        "ON CONFLICT(uid) DO UPDATE SET name=excluded.name"
        if overwrite
        else "ON CONFLICT(uid) DO NOTHING"
    )
    with get_connection() as conn:
        conn.execute(
            f"INSERT INTO creator(uid, name) VALUES(?,?) {conflict}",
            (uid, (name or "").strip() or None),
        )


# ── 앱 설정 / 제공자 신원 ─────────────────────────────────────────────────
def get_setting(key: str, default: Optional[str] = None) -> Optional[str]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT value FROM app_setting WHERE key=?", (key,)
        ).fetchone()
    return row["value"] if row and row["value"] is not None else default


def set_setting(key: str, value: Optional[str]) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO app_setting(key, value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


def capture_provider_identity(email: Optional[str]) -> None:
    """시작 시 CLI account status 이메일로 제공자 신원 기본값을 잡는다(멱등).
    uid 앵커는 이메일 우선(불변·안정), 없으면 로컬 생성본의 user_<id>. 표시이름은 미설정 시
    이메일 로컬파트. 이미 설정된 값(특히 사용자가 바꾼 이름)은 절대 덮어쓰지 않는다."""
    if email:
        set_setting("provider_email", email)
    if not get_setting("provider_uid"):
        uid = email or get_my_uid()
        if uid:
            set_setting("provider_uid", uid)
    if not get_setting("provider_name"):
        name = _email_localpart(email) or get_my_uid()
        if name:
            set_setting("provider_name", name)


def get_provider() -> dict[str, Optional[str]]:
    """내 제공자 신원 {uid, name, email}. 공유 파일명·작성자 표기의 기준(불변 uid + 가변 이름)."""
    email = get_setting("provider_email")
    # uid 는 권위 소스(my_creator_uid)에서 우선 — 과거 relink 사고로 provider_uid 에 이메일이
    # 잘못 박혀도 실제 힉스필드 uid 를 쓰게(계정 식별자 표기 정확).
    uid = get_my_uid() or get_setting("provider_uid") or email
    name = get_setting("provider_name") or _email_localpart(email) or uid or "me"
    return {"uid": uid, "name": name, "email": email}


def set_provider_name(name: str) -> dict[str, Optional[str]]:
    """제공자 표시이름 변경 → 이후 모든 공유 파일명·작성자 표기에 반영.
    uid 앵커는 그대로라 병합·dedup 이 깨지지 않는다. 내 uid 의 creator 행에도 미러(목록 표기)."""
    name = (name or "").strip()
    if not name:
        return get_provider()
    set_setting("provider_name", name)
    # 내 신원과 연결된 모든 uid(이메일 앵커 + 지정한 user_<id>)에 새 이름 미러 → 카드 표기 갱신.
    for uid in {get_setting("provider_uid"), get_setting("my_creator_uid")}:
        if uid:
            set_creator_name(uid, name)
    return get_provider()
