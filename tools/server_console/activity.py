"""상태·로그 화면의 표 — 누가 무엇을(생성·설정 변경·최근 활동). 서버 DB 를 읽기만 한다.

화면에는 이름만 보인다(서버 identity.resolve_display_names 와 같은 순서: 생성자 이름 → 계정 이름 → 이메일
앞부분, 없으면 '팀원'). 이메일·uid 는 화면 값에 넣지 않는다. 접속 이력은 새로 남기지 않는다(Jay 10-24):
사람마다 이미 DB 에 있는 마지막 활동 시각 하나만 보인다 — 실시간 '지금 접속 중'은 서버 API 가 필요하다(2단계).
서버 기록·DB 시각은 UTC(서버 OS 도 UTC) — 화면은 한국 시각.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from .install import Installation

KST = timezone(timedelta(hours=9))
ROWS = 60
RECENT_DAYS = 7
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
# 생성 시각 — sort_ts 가 비면 created_at(UTC 글자). 표시·정렬·7일·오늘 수를 모두 같은 값으로(Codex 리뷰 P2).
_EFFECTIVE = "COALESCE(sort_ts, CAST(strftime('%s', created_at) AS REAL))"

AUDIT_LABELS = {
    "super_admin.issued": "슈퍼 관리자 세션 발급", "super_admin.revoked": "슈퍼 관리자 세션 해제",
    "account.status_changed": "계정 승인 상태 바꿈", "account.global_roles_changed": "계정 권한 바꿈",
    "account.password_reset": "비밀번호 초기화", "account.visibility_changed": "계정 숨김 바꿈",
    "member.global_roles_changed": "멤버 권한 바꿈",
    "server.backup_replica_target_change_requested": "백업 복사 위치 변경 요청",
    "server.backup_replica_target_change_failed": "백업 복사 위치 변경 실패",
    "server.backup_replica_target_changed": "백업 복사 위치 바꿈",
    "generation.workspace_super_admin_changed": "생성물 워크스페이스 바꿈",
    "generation.publish_bundle_received": "발행 묶음 받음", "generation.published": "공유(발행)",
    "generation.finalized": "최종본 지정", "generation.unfinalized": "최종본 해제", "generation.held": "보류",
    "generation.share_command": "공유 명령",
    "project.created": "프로젝트 만듦", "project.order_changed": "프로젝트 순서 바꿈", "project.updated": "프로젝트 고침",
    "project.deleted": "프로젝트 지움", "project.member_roles_changed": "프로젝트 멤버 역할 바꿈",
    "project.member_removed": "프로젝트 멤버 뺌",
    "release_notice_registered": "업데이트 공지 등록", "release_notice_announced": "업데이트 알림 보냄",
    "release_notice_pinned": "업데이트 공지 고정", "release_notice_removed": "업데이트 공지 해제",
}
_FIELD_LABELS = {"name": "이름", "status": "상태", "global_roles": "권한", "global_role": "권한", "archived": "보관",
                 "sort_order": "순서", "render_root_path": "렌더 폴더", "workspace": "워크스페이스",
                 "workspace_id": "워크스페이스", "hidden": "숨김", "roles": "역할", "role": "역할"}
_RUNNING = {"pending", "claimed", "submitting", "running", "tracking", "verifying", "queued", "in_progress"}
_STATUS = {**{s: ("진행 중", "run") for s in _RUNNING},
           "done": ("완료", "ok"), "completed": ("완료", "ok"), "success": ("완료", "ok"),
           "failed": ("실패", "bad"), "error": ("실패", "bad"), "nsfw": ("거절", "bad"),
           "blocked": ("확인 필요", "warn"), "recovery_required": ("확인 필요", "warn"),
           "cancelled": ("취소", "muted"), "canceled": ("취소", "muted")}


def field_label(field: Any) -> str:
    return _FIELD_LABELS.get(str(field), str(field))


def parse_time(value: Any) -> datetime | None:
    """epoch 초·ISO·SQLite 'YYYY-MM-DD HH:MM:SS' → 시간대 있는 값. 시간대가 없으면 UTC 로 본다."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value), timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    text = str(value or "").strip()
    if not text:
        return None
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def kst_text(value: Any, now: datetime | None = None) -> str:
    """오늘이면 '14:21', 아니면 '10-23 18:40'(한국 시각). 못 읽으면 '—'."""
    moment = parse_time(value)
    if moment is None:
        return "—"
    local = moment.astimezone(KST)
    today = (now or datetime.now(KST)).astimezone(KST).date()
    return local.strftime("%H:%M") if local.date() == today else local.strftime("%m-%d %H:%M")


def _readonly(path: Path) -> sqlite3.Connection:
    # deploy_fence_check 와 같은 방식 — 서버 쓰기를 막지 않는다(두 DB 모두 WAL).
    connection = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=5)
    connection.execute("PRAGMA query_only=ON")
    connection.execute("PRAGMA busy_timeout=5000")
    return connection


def _localpart(email: str | None) -> str:
    return (email or "").split("@", 1)[0].strip()


def shown(value: Any, limit: int = 80) -> str:
    """화면에 내보내는 글자 — 들어 있는 이메일은 앞부분만(서버 이름 폴백과 같게), 제어 문자 없이, 짧게.
    이름 칸에 이메일을 적어 둔 계정도 이메일이 그대로 보이지 않게(Codex 리뷰 P1)."""
    text = _CONTROL.sub(" ", _EMAIL.sub(lambda m: _localpart(m.group(0)), str(value or ""))).strip()
    return text if len(text) <= limit else text[:limit] + "…"


def _digest(text: str) -> str:
    # event_journal.safe_identity 와 같은 지문 — 감사 기록은 이메일(이 든 값) 대신 이것을 남긴다.
    return "account:" + hashlib.sha256(text.lower().encode("utf-8")).hexdigest()[:20]


def name_book(conn: sqlite3.Connection) -> Callable[[Any], str]:
    """uid·'account:지문'·이메일 → 표시 이름. 이메일·uid 자체는 돌려주지 않는다."""
    creators = {uid: shown((name or "").strip()) for uid, name in conn.execute("SELECT uid, name FROM creator")}
    by_uid: dict[str, str] = {}
    by_email: dict[str, str] = {}
    for email, name, uid in conn.execute("SELECT email, name, creator_uid FROM account"):
        key = str(email or "").strip().lower()
        if not key:
            continue
        name_text = creators.get(str(uid or "")) or shown((name or "").strip()) or _localpart(key)  # 서버와 같은 순서
        by_email[key] = name_text
        by_email[_digest(key)] = name_text
        # 생성자 uid 가 없던 때의 행위자는 임시 uid 'acct:<email>'(deps.account_actor_uid) — 그 지문도
        by_email[_digest("acct:" + key)] = name_text
        if uid:
            by_uid[str(uid)] = name_text

    def name_of(value: Any) -> str:
        key = str(value or "").strip()
        if not key:
            return "—"
        return creators.get(key) or by_uid.get(key) or by_email.get(key.lower()) or "팀원"

    return name_of


def _credits(real: Any, est: Any) -> str:
    for value, suffix in ((real, ""), (est, " (추정)")):
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return f"{value:g}{suffix}"
    return "—"


def _where(project: Any, folder: Any) -> str:
    project = shown(project) or "프로젝트 없음"
    folder = str(folder or "").strip().replace("\\", "/").strip("/")
    tail = shown("/".join(folder.split("/")[-2:])) if folder else ""
    return f"{project} › {tail}" if tail else project


def _generations(manage_db: Path, name_of: Callable[[Any], str], now: datetime) -> tuple[list[dict], dict]:
    """최근 생성 표 + 사람마다 마지막 생성·오늘 생성 수(이메일 키는 이 함수 안에서만)."""
    midnight = now.astimezone(KST).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    since = (now - timedelta(days=RECENT_DAYS)).timestamp()
    rows, people = [], {}
    with closing(_readonly(manage_db)) as conn:
        for (email, creator_name, project, folder, model, status, real, est, at) in conn.execute(
                "SELECT account_email, creator_name, project_name, folder_path, model, status, real_credits, "
                f"est_credits, {_EFFECTIVE} AS at FROM team_generation_fact WHERE COALESCE(is_deleted,0)=0 "
                "ORDER BY at DESC LIMIT ?", (ROWS,)):
            label, tone = _STATUS.get(str(status or "").strip().lower(), (shown(status) or "—", "muted"))
            who = name_of(email)
            rows.append({"when": kst_text(at, now),
                         "who": who if who != "팀원" else (shown(creator_name) or who),
                         "model": shown(model) or "—", "where": _where(project, folder), "status": label,
                         "credits": _credits(real, est), "tone": tone})
        for email, last, today in conn.execute(
                f"SELECT account_email, MAX(at), SUM(CASE WHEN at >= ? THEN 1 ELSE 0 END) FROM (SELECT account_email, "
                f"{_EFFECTIVE} AS at FROM team_generation_fact WHERE COALESCE(is_deleted,0)=0) WHERE at >= ? "
                "GROUP BY account_email", (midnight, since)):
            people[str(email or "").lower()] = {"last_gen": last, "today": int(today or 0)}
    return rows, people


def _target(row: sqlite3.Row, projects: dict[str, str], name_of: Callable[[Any], str]) -> str:
    kind = str(row["target_type"] or "")
    if kind == "account":
        return name_of(row["target_id"])
    project = projects.get(str(row["project_id"] or "")) or projects.get(str(row["target_id"] or ""))
    if project:
        return f"「{shown(project)}」"
    return {"generation": "생성물", "project": "프로젝트", "server": "서버", "notice": "업데이트 공지",
            "release_notice": "업데이트 공지"}.get(kind, shown(kind) or "—")


def _changes(content_db: Path, now: datetime) -> tuple[list[dict], Callable[[Any], str], dict]:
    with closing(_readonly(content_db)) as conn:
        conn.row_factory = sqlite3.Row
        name_of = name_book(conn)
        projects = {str(pid): str(name or "") for pid, name in conn.execute("SELECT id, name FROM project")}
        rows = []
        for row in conn.execute("SELECT action, actor_uid, target_type, target_id, project_id, fields, created_at "
                                "FROM audit_event ORDER BY created_at DESC, id DESC LIMIT ?", (ROWS,)):
            try:
                parsed = json.loads(row["fields"] or "[]")
            except ValueError:
                parsed = []
            fields = [str(f) for f in parsed][:6] if isinstance(parsed, list) else []  # 'null' 같은 행 하나가 표 전체를 막지 않게
            action = str(row["action"] or "")
            rows.append({"when": kst_text(row["created_at"], now), "who": name_of(row["actor_uid"]),
                         "what": AUDIT_LABELS.get(action, shown(action) or "—"), "target": _target(row, projects, name_of),
                         "fields": shown(", ".join(field_label(f) for f in fields)) or "—",
                         "tone": "bad" if action.endswith("_failed") else "muted"})
        agents = {str(email or "").lower(): seen for email, seen in conn.execute(
            "SELECT account_email, MAX(last_seen_at) FROM workspace_member GROUP BY account_email")}
    return rows, name_of, agents


def read_activity(inst: Installation, now: datetime | None = None) -> dict[str, Any]:
    """세 표와 읽은 시각. 한 DB 를 못 읽어도 나머지는 보인다(errors 에 이유)."""
    now = now or datetime.now(timezone.utc)
    out: dict[str, Any] = {"generations": [], "changes": [], "people": [], "errors": {}, "read_at": time.time()}
    name_of: Callable[[Any], str] = lambda value: "팀원" if value else "—"  # noqa: E731 — 계정 표를 못 읽었을 때
    agents: dict[str, Any] = {}
    try:
        out["changes"], name_of, agents = _changes(inst.content_db, now)
    except (sqlite3.Error, OSError) as exc:
        out["errors"]["changes"] = f"서버 DB 를 읽지 못했습니다({type(exc).__name__})"
    people: dict[str, dict] = {}
    try:
        out["generations"], people = _generations(inst.data_dir / "db" / "manage_hub.db", name_of, now)
    except (sqlite3.Error, OSError) as exc:
        out["errors"]["generations"] = f"관리 DB 를 읽지 못했습니다({type(exc).__name__})"
    unknown_gen = "generations" in out["errors"]  # 못 읽었으면 '0건'이 아니라 '모름'
    since = now - timedelta(days=RECENT_DAYS)
    merged = []
    for email in set(people) | {e for e, seen in agents.items() if (parse_time(seen) or since - timedelta(1)) >= since}:
        gen = people.get(email, {})
        last = [t for t in (parse_time(gen.get("last_gen")), parse_time(agents.get(email))) if t]
        merged.append({"who": name_of(email), "last_gen": "—" if unknown_gen else kst_text(gen.get("last_gen"), now),
                       "agent": kst_text(agents.get(email), now),
                       "today": "—" if unknown_gen else str(gen.get("today", 0)),
                       "_latest": max(last) if last else since, "tone": "muted"})
    merged.sort(key=lambda row: row["_latest"], reverse=True)
    out["people"] = [{k: v for k, v in row.items() if k != "_latest"} for row in merged[:ROWS]]
    return out
