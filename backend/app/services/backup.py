"""DB 세트 자동 백업 (서버 운영).

단일 DB 파일 리스크(파일 손상·실수 삭제·랜섬)를 대비한다. 로드맵 §2-6·§6-1.

핵심: **SQLite 온라인 백업 API(Connection.backup) 를 쓴다.** WAL 모드에서 단순 파일복사
(shutil.copy)는 아직 메인 DB 로 체크포인트되지 않은 -wal 분을 놓쳐 깨진 스냅샷이 된다.
.backup 은 잠금 없이 일관된 스냅샷을 떠 준다(서버는 계속 쓰기 가능).

동작: 콘텐츠 DB를 기준으로 휴지통·프로젝트 관리 DB가 존재하면 같은 stamp의 세트로 함께
백업한다. 각 DB의 읽기 시점은 미세하게 다를 수 있다(아래 스냅샷 주석 참고).
시작 시 1회(최근 백업이 충분히 새것이면 생략) + 주기(기본 하루).
보관 = 최근 N세트(촬영 순서) + 날마다 1세트 D일 + 주마다 1세트 W주(저장 통합 1-A,
docs/status/저장통합_1A_백업보관_2026-11-12.md). 세트마다 manifest 밖 곁파일(.keep.json)에
촬영 순서 번호·촬영 시각·이유·지우는 중을 적고, 이상하면 지우지 않는다.
백업 폴더는 CONTENT_HUB_BACKUP_DIR 로 다른 디스크/NAS 지정 권장(같은 디스크면 동반 손실).
"""

from __future__ import annotations

import asyncio
import contextlib
import errno
import hashlib
import json
import os
import shutil
import sqlite3
import stat
import threading
import time
import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterator, Optional
from uuid import uuid4

from .. import active_account
from ..config import AUTH_ENABLED, DATA_DIR
from ..db import get_db_path
from ..manage_db import MANAGE_DB_PATH
from .async_tools import to_thread_non_abandon
from .operational_logging import log_event
from .sqlite_db import read_only_uri, validate_hub_db
from .backup_verify import snapshot_database_set as _snapshot_database_set
from . import backup_manifest
from .atomic_io import atomic_write_text

CAPTURE_VERSION = 2
_AGENT_PATH_CACHE: dict[tuple[str, int, str], tuple[str, Path | None]] = {}

_backup_log = logging.getLogger("mvhub.backup")

# 백업 보관 폴더 — 기본은 데이터 루트 아래. 실서버에선 다른 디스크/NAS 로 지정 권장.
BACKUP_DIR = Path(
    os.environ.get("CONTENT_HUB_BACKUP_DIR", DATA_DIR / "backups")
).resolve()

# 백업 주기(초). 0 이하이면 비활성. 기본 하루.
BACKUP_INTERVAL = float(os.environ.get("CONTENT_HUB_BACKUP_INTERVAL", str(24 * 3600)))

# 보관 기본값 — 최근 N세트(촬영 순서) + 날마다 1세트 D일 + 주마다 1세트 W주. 사용자가 고른 값은
# 백업 폴더의 backup_policy.json 이 이긴다. 로컬 허브 = 8·14·8(Jay J1, 11-12), AUTH 켜진 프로세스
# (공유 서버·격리 dev)는 지금과 같은 최근 7개만 — 서버 보관은 서버·NAS 정책과 함께 따로 정한다.
# 최소 1: 0 이하를 허용하면 방금 만든 백업까지 회전이 지워 백업 자체가 무의미해진다.
BACKUP_KEEP = max(1, int(os.environ.get("CONTENT_HUB_BACKUP_KEEP", "7" if AUTH_ENABLED else "8")))
BACKUP_KEEP_DAILY = 0 if AUTH_ENABLED else 14
BACKUP_KEEP_WEEKLY = 0 if AUTH_ENABLED else 8

# 시작 시 중복 백업 방지: 가장 최근 백업이 이 시간(초)보다 새것이면 시작 백업 생략.
# (서버 재기동·개발 리스타트가 잦아도 백업이 난립하지 않게.)
_STARTUP_SKIP_IF_YOUNGER = min(BACKUP_INTERVAL, 3600.0)

# 개인 메타데이터 변경은 하루를 기다리지 않고 조용해진 뒤 서버 전송용 백업을 만든다.
# 매 수정마다 SQLite 스냅샷을 뜨지 않도록 디바운스와 최소 간격을 함께 둔다.
BACKUP_CHANGE_DEBOUNCE = max(
    5.0, float(os.environ.get("CONTENT_HUB_BACKUP_CHANGE_DEBOUNCE", "300"))
)
BACKUP_MIN_INTERVAL = max(
    BACKUP_CHANGE_DEBOUNCE,
    float(os.environ.get("CONTENT_HUB_BACKUP_MIN_INTERVAL", "900")),
)
BACKUP_POLL_INTERVAL = max(
    5.0, float(os.environ.get("CONTENT_HUB_BACKUP_POLL_INTERVAL", "30"))
)

_PREFIX = "content_hub_"
_TRASH_PREFIX = "content_trash_"
_MANAGE_PREFIX = "manage_hub_"
_ROLE_PREFIX = {"content": _PREFIX, "trash": _TRASH_PREFIX, "manage": _MANAGE_PREFIX}

# ── 보관 규칙(저장 통합 1-A) ──────────────────────────────────────────────
# 한국은 서머타임이 없어 고정 +9 — zoneinfo 는 Windows 에 tzdata 가 없으면 못 쓴다.
KEEP_TZ = timezone(timedelta(hours=9), "Asia/Seoul")
KEEP_TZ_NAME = "Asia/Seoul"
_KEEP_FORMAT = "mvhub-backup-keep"
_REGISTRY_FORMAT = "mvhub-backup-keep-registry"
_POLICY_FORMAT = "mvhub-backup-policy"
_REGISTRY_NAME = "backup_keep_registry.json"
_POLICY_NAME = "backup_policy.json"
_KEEP_REASONS = ("auto", "manual", "legacy")
# 지금 시계가 기록된 가장 늦은 촬영 시각보다 이만큼 넘게 뒤처지면(시계 역행) 지우기를 보류한다.
_CLOCK_SKEW_SECONDS = 300.0
# 사용자가 고르는 값 — 자유 입력 없음(설계 §4-5).
POLICY_CHOICES: dict[str, tuple[int, ...]] = {
    "quiet_minutes": (1, 5, 10),
    "min_interval_minutes": (5, 15, 30, 60),
    "recent": (4, 8, 16),
    "daily_days": (7, 14, 30),
    "weekly_weeks": (4, 8, 12),
}


class BackupDiskFull(OSError):
    """새 세트를 쓸 여유가 없다 — 파일을 쓰기 전에 알린다."""


class RegistryUnreadable(OSError):
    """등록 표식을 읽지 못했다(권한·NAS 순단) — 깨짐으로 보고 새로 쓰지 않고 그 백업을 실패로 끝낸다."""


class BackupPolicyError(ValueError):
    def __init__(self, code: str, status: int, preview: dict | None = None):
        super().__init__(code)
        self.code = code
        self.status = status
        self.preview = preview


@dataclass
class _BackupSet:
    stamp: str
    content: Path
    keep: dict | None  # 정상 곁파일 내용
    keep_state: str  # "ok" | "missing" | "invalid"
    complete: bool
    mtime_ns: int
    marked_deleting: bool = False  # 곁파일 필드가 깨졌어도 원시 JSON 에 deleting=true(또는 곁파일을 못 읽음)

    @property
    def deleting(self) -> bool:
        return bool(self.keep and self.keep.get("deleting")) or self.marked_deleting


def _keep_path(content: Path) -> Path:
    return content.with_suffix(".keep.json")


def _stamp_of(content: Path) -> str:
    return content.name[len(_PREFIX):-3]


def _parse_utc(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else None


def _read_keep(content: Path) -> tuple[dict | None, str]:
    path = _keep_path(content)
    try:
        raw = path.read_text("utf-8")
    except FileNotFoundError:
        return None, "missing"
    except (OSError, ValueError):  # ValueError = UnicodeDecodeError(글자가 깨진 파일)
        return None, "invalid"
    try:
        data = json.loads(raw)
    except ValueError:
        return None, "invalid"
    if isinstance(data, dict):
        # 없으면 안전한 쪽으로 읽는다 — manifest 없음 = 있었음(manifest 를 잃으면 불완전으로 보존).
        data.setdefault("manifest", True)
    if (
        not isinstance(data, dict)
        or data.get("format") != _KEEP_FORMAT
        or type(data.get("seq")) is not int
        or data["seq"] <= 0
        or _parse_utc(data.get("captured_at")) is None
        or data.get("reason") not in _KEEP_REASONS
        or not isinstance(data.get("protected"), bool)
        or not isinstance(data.get("deleting"), bool)
        or not isinstance(data.get("manifest"), bool)
    ):
        return None, "invalid"
    return data, "ok"


def _write_keep(content: Path, data: dict) -> None:
    atomic_write_text(_keep_path(content), json.dumps(data, ensure_ascii=False, sort_keys=True))


def _set_complete(content: Path, keep: dict | None = None) -> bool:
    """manifest 의 구성원 파일이 모두 있고 크기가 맞는가. manifest 이전 옛 세트(곁파일 manifest=false, 또는
    아직 등록 전)는 대표 파일만 본다 — 옛 코드도 검증 뒤 대표 파일을 마지막에 공개했다. manifest 가 있던
    세트(곁파일 manifest=true)가 manifest 를 잃으면 불완전이다."""
    manifest = backup_manifest.local_path(content)
    try:
        if not manifest.is_file():
            if keep is not None and keep.get("manifest") is True:
                return False
            return content.is_file()
        data = json.loads(manifest.read_text("utf-8"))
        if isinstance(data, dict) and data.get('format_version') == 3:
            backup_manifest.read_local(content, allow_v3=True)
            return True
        roles = data.get("roles") if isinstance(data, dict) else None
        if not isinstance(roles, dict) or "content" not in roles:
            return False
        stamp = _stamp_of(content)
        for role, info in roles.items():
            prefix = _ROLE_PREFIX.get(role)
            if prefix is None or not isinstance(info, dict):
                return False
            member = content.parent / f"{prefix}{stamp}.db"
            if not member.is_file() or member.stat().st_size != info.get("size"):
                return False
        return True
    except (OSError, ValueError, AttributeError, TypeError, sqlite3.Error):  # 불완전 세트 보존
        return False


def _scan_sets(d, *, verify: bool = True) -> list[_BackupSet]:
    """백업 폴더의 콘텐츠 대표 파일을 **한 번** 훑고, 세트마다 곁파일(과 verify 면 완성 여부)을 읽는다.
    verify=False(30초 poll) 는 manifest·구성원 크기를 대조하지 않는다 — NAS 부담."""
    out: list[_BackupSet] = []
    if not d.is_dir():
        return out
    for content in d.glob(f"{_PREFIX}*.db"):
        try:
            mtime_ns = content.stat().st_mtime_ns
        except OSError:
            continue
        keep, state = _read_keep(content)
        complete = _set_complete(content, keep) if verify else True
        # 깨진 곁파일이라도 지우는 중 표식이 보이거나 읽을 수 없으면 목록·최신본·poll 후보에서 뺀다(hold_set 과 같은 판단).
        marked = state == "invalid" and _raw_deleting(content) is not False
        out.append(_BackupSet(_stamp_of(content), content, keep, state, complete, mtime_ns, marked))
    return out


def _duplicate_seqs(sets: list[_BackupSet]) -> set[int]:
    seqs = [s.keep["seq"] for s in sets if s.keep_state == "ok" and s.keep]
    return {seq for seq in seqs if seqs.count(seq) > 1}


def _split_live(sets: list[_BackupSet]) -> tuple[list[_BackupSet], list[_BackupSet]]:
    """(번호 없는 세트 이름순, 번호 있는 세트 번호순) — 완성·지우는 중 아님만. 번호 있음 = 정상 곁파일·번호 안 겹침
    (겹침은 완성 여부와 무관하게 전체에서 센다 — poll(완성 대조 전)·회전과 같은 기준)."""
    live = [s for s in sets if s.complete and not s.deleting]
    dup = _duplicate_seqs(sets)
    numbered = sorted(
        (s for s in live if s.keep_state == "ok" and s.keep and s.keep["seq"] not in dup),
        key=lambda s: s.keep["seq"],  # type: ignore[index]
    )
    numbered_ids = {id(s) for s in numbered}
    others = sorted((s for s in live if id(s) not in numbered_ids), key=lambda s: s.content.name)
    return others, numbered


def _live_sets(sets: list[_BackupSet]) -> tuple[list[_BackupSet], bool]:
    """완성·지우는 중 아님 세트를 오래된 → 새 순으로 — 모든 소비자(목록·최신본·복원 선택)의 한 기준.

    정상 곁파일(번호 안 겹침) 세트는 촬영 순서 번호로 정렬해 **맨 뒤**에, 그 밖(곁파일 없음·깨짐·번호 겹침)은
    이름순으로 그 앞에 둔다 — 등록된 세트가 하나라도 있으면 최신본은 늘 번호가 가장 큰 세트다(옛 세트 하나
    때문에 시계 보호가 꺼지지 않게). 두 번째 값 = 번호로 정렬한 세트가 있나."""
    others, numbered = _split_live(sets)
    return others + numbered, bool(numbered)


def _captured_at(s: _BackupSet) -> datetime:
    if s.keep:
        parsed = _parse_utc(s.keep.get("captured_at"))
        if parsed is not None:
            return parsed
    return datetime.fromtimestamp(s.mtime_ns / 1_000_000_000, timezone.utc)


def _legacy_captured_at(content: Path) -> str:
    """도입 등록 때 옛 세트의 촬영 시각 — manifest captured_at, 없으면 이름(UTC 스탬프), 없으면 mtime."""
    with contextlib.suppress(OSError, ValueError, TypeError, AttributeError):
        manifest = backup_manifest.local_path(content)
        if manifest.is_file():
            parsed = _parse_utc(json.loads(manifest.read_text("utf-8")).get("captured_at"))
            if parsed is not None:
                return parsed.isoformat()
    stamp = _stamp_of(content)
    for fmt in ("%Y%m%d_%H%M%S_%f", "%Y%m%d_%H%M%S"):
        with contextlib.suppress(ValueError):
            return datetime.strptime(stamp, fmt).replace(tzinfo=timezone.utc).isoformat()
    return datetime.fromtimestamp(content.stat().st_mtime, timezone.utc).isoformat()


def _manifest_set_id(content: Path) -> str | None:
    with contextlib.suppress(OSError, ValueError, AttributeError):
        manifest = backup_manifest.local_path(content)
        if manifest.is_file():
            value = json.loads(manifest.read_text("utf-8")).get("set_id")
            return value if isinstance(value, str) else None
    return None


def _read_registry(d: Path) -> tuple[dict | None, bool]:
    """(등록 표식 내용, 깨졌나). 없으면 (None, False). 읽기 자체가 실패하면(NAS 순단 등) OSError 를 그대로
    올린다 — '깨짐'으로 보고 새로 쓰면 policy_version·pending 이 사라진다(부르는 쪽이 백업을 실패로 끝낸다)."""
    try:
        raw = (d / _REGISTRY_NAME).read_text("utf-8")
    except FileNotFoundError:
        return None, False
    except ValueError:  # UnicodeDecodeError — 글자가 깨진 표식
        return None, True
    except OSError as exc:
        raise RegistryUnreadable(exc.errno, f"backup registry unreadable: {exc}") from exc
    try:
        data = json.loads(raw)
    except ValueError:
        return None, True
    # 우리가 쓰는 모양(format·state·last_seq 필수)이 아니면 깨짐 — 빈 객체·필드 유실을 '저장 이력 없음'으로 읽지 않게.
    if (
        not isinstance(data, dict)
        or data.get("format") != _REGISTRY_FORMAT
        or data.get("state") not in ("pending", "done")
        or type(data.get("last_seq")) is not int or data["last_seq"] < 0
        or ("policy_version" in data and (type(data["policy_version"]) is not int or data["policy_version"] < 0))
        or ("policy_unknown" in data and not isinstance(data["policy_unknown"], bool))
    ):
        return None, True
    return data, False


def _policy_file_version(d: Path) -> int:
    with contextlib.suppress(OSError, ValueError, AttributeError):
        version = json.loads((d / _POLICY_NAME).read_text("utf-8")).get("policy_version")
        if type(version) is int and version > 0:
            return version
    return 0


def _write_registry(d: Path, **fields: object) -> None:
    """등록 표식(state·last_seq·policy_version)을 합쳐 원자적으로 쓴다. 깨진 표식은 새로 쓰되 policy_version 은
    정책 파일의 판 번호로 채우고, 그것도 없으면 '저장 이력 모름'(policy_unknown)으로 남긴다 — 저장한 적 없음(0)으로
    덮어 기본값으로 줄이는 일이 없게(PUT 으로 다시 저장하면 풀림)."""
    current, corrupt = _read_registry(d)
    base = dict(current or {})
    if corrupt:
        version = _policy_file_version(d)
        base = {"policy_version": version} if version else {"policy_unknown": True}
    data = {**base, **fields, "format": _REGISTRY_FORMAT, "format_version": 1,
            "updated_at": datetime.now(timezone.utc).isoformat()}
    if corrupt:
        # 깨진 표식을 새로 쓸 때는 늘 done — 등록을 다시 돌려 곁파일 없는 세트를 옛 세트로 등록(→ 지울 후보)하지
        # 않는다(계약 '표식이 깨졌으면 등록하지 않음'). 곁파일 없는 세트는 미등록으로 남아 지워지지 않는다.
        data.setdefault("state", "done")
    if "state" not in data or "last_seq" not in data:
        # 새로 쓰는데 상태가 없다(표식이 처음부터 없었음) — 곁파일이 하나라도 있으면 등록은 이미 끝났던 것(done, E4),
        # 없으면 아직 안 한 것(pending). 번호는 곁파일에서.
        keep_seqs = []
        for path in d.glob(f"{_PREFIX}*.keep.json"):
            with contextlib.suppress(OSError, ValueError, AttributeError):
                seq = json.loads(path.read_text("utf-8")).get("seq")
                if type(seq) is int and seq > 0:
                    keep_seqs.append(seq)
        data.setdefault("state", "done" if any(d.glob(f"{_PREFIX}*.keep.json")) else "pending")
        data.setdefault("last_seq", max(keep_seqs, default=0))
    atomic_write_text(d / _REGISTRY_NAME, json.dumps(data, sort_keys=True))


def _max_seq(d: Path) -> int:
    """준 적 있는 가장 큰 번호 — 등록 표식의 last_seq 와 읽을 수 있는 곁파일 중 큰 값(가장 큰 곁파일이
    깨져도 같은 번호를 다시 주지 않게)."""
    best = 0
    registry, _corrupt = _read_registry(d)
    last = registry.get("last_seq") if registry else None
    if type(last) is int and last > 0:
        best = last
    for path in d.glob(f"{_PREFIX}*.keep.json"):
        with contextlib.suppress(OSError, ValueError, AttributeError):
            seq = json.loads(path.read_text("utf-8")).get("seq")
            if type(seq) is int and seq > best:
                best = seq
    return best


def _next_seq(d: Path) -> int:
    """새 세트 번호(생성 잠금 안에서만). 곁파일보다 먼저 등록 표식에 적어 둔다(깨진 표식이면 done 으로 새로)."""
    seq = _max_seq(d) + 1
    _write_registry(d, state="done", last_seq=seq)
    return seq


def _keep_record(seq: int, captured_at: str, reason: str, set_id: str | None, *, manifest: bool = True) -> dict:
    """manifest = 등록·생성 때 manifest 가 있었나(뒤에 잃으면 불완전으로 보존)."""
    return {
        "format": _KEEP_FORMAT,
        "format_version": 1,
        "seq": seq,
        "captured_at": captured_at,
        "tz": KEEP_TZ_NAME,
        "reason": reason,
        "protected": False,
        "deleting": False,
        "manifest": manifest,
        "set_id": set_id,
    }


def _ensure_registered(d: Path) -> None:
    """도입 등록 — 처음 한 번 기존 세트마다 곁파일(reason=legacy, 이름순 번호)을 만든다.

    등록 표식 pending → 곁파일들 → done. 멈추면 다음에 곁파일 없는 것만 이어 등록한다(그동안 새 세트는
    생기지 않는다 — 생성 잠금 안에서 이 함수를 먼저 부른다). done 뒤에는 다시 돌지 않으므로 곁파일이
    사라진 새 세트를 옛 세트로 다시 등록해 보호를 풀지 않는다. 표식이 깨졌으면 등록하지 않는다(안전 쪽).
    """
    registry, corrupt = _read_registry(d)
    if corrupt:
        return
    state = registry.get("state") if registry else None
    if state == "done":
        return
    if state not in (None, "pending"):
        return
    if state is None:
        if any(d.glob(f"{_PREFIX}*.keep.json")):
            # 표식만 사라졌다 — 등록은 이미 끝났던 것. 곁파일 없는 세트를 옛 세트로 다시 등록하지 않는다(E4).
            _write_registry(d, state="done", last_seq=_max_seq(d))
            return
        _write_registry(d, state="pending", last_seq=_max_seq(d))
    seq = _max_seq(d)
    # 옛 세트는 검증 없이 곁파일만 — manifest 이전 세트는 대표 파일이 공개돼 있으면 완성이다(옛 코드가
    # 검증 뒤 대표 파일을 마지막에 공개했다). 완성 여부는 회전 때 따로 본다.
    for s in sorted(_scan_sets(d, verify=False), key=lambda item: item.content.name):
        if s.keep_state != "missing":
            continue
        seq += 1
        _write_registry(d, state="pending", last_seq=seq)
        _write_keep(s.content, _keep_record(seq, _legacy_captured_at(s.content), "legacy",
                                            _manifest_set_id(s.content),
                                            manifest=backup_manifest.local_path(s.content).is_file()))
    _write_registry(d, state="done", last_seq=seq)


def _registry_done(d: Path) -> bool:
    try:
        registry, corrupt = _read_registry(d)
    except OSError:
        return True  # 못 읽음 = 곁파일 없는 세트는 지우지 않는 쪽(상태 표시용)
    if corrupt:
        return True  # 깨진 표식 = 등록하지 않음 → 곁파일 없는 세트는 지우지 않는 쪽
    return bool(registry) and registry.get("state") == "done"  # type: ignore[union-attr]


# ── 사용 중 세트(서버 전송 복사 등) — 회전이 지우지 않는다 ───────────────────
_IN_USE: dict[str, int] = {}
_IN_USE_LOCK = threading.Lock()


def _use_key(content: Path) -> str:
    return os.path.normcase(os.path.abspath(str(content)))


@contextlib.contextmanager
def hold_set(content: Path) -> Iterator[None]:
    """세트를 복사·대조하는 동안 회전이 그 세트를 지우지 않게 붙잡는다. 이미 지우는 중이거나 대표 파일이
    없으면 FileNotFoundError — 회전은 같은 잠금 안에서 붙잡힘을 보고 지우는 중 표식을 적는다."""
    key = _use_key(content)
    with _IN_USE_LOCK:
        # 지우는 중이거나, 곁파일을 읽지 못해 지우는 중인지 모르면(None) 거절 — 표식을 막 쓴 순간의 읽기 실패로 붙잡지 않게.
        if not Path(content).is_file() or _raw_deleting(Path(content)) is not False:
            raise FileNotFoundError(str(content))
        _IN_USE[key] = _IN_USE.get(key, 0) + 1
    try:
        yield
    finally:
        with _IN_USE_LOCK:
            left = _IN_USE.get(key, 1) - 1
            if left > 0:
                _IN_USE[key] = left
            else:
                _IN_USE.pop(key, None)


def _held(content: Path) -> bool:
    with _IN_USE_LOCK:
        return _use_key(content) in _IN_USE


def _raw_deleting(content: Path) -> bool | None:
    """곁파일에 deleting=true 가 적혔나 — 다른 필드가 깨졌어도. 곁파일 없음 = False, 읽기 자체가 실패(잠김 등) = None(모름)."""
    path = _keep_path(content)
    try:
        raw = path.read_text("utf-8")
    except FileNotFoundError:
        return False
    except OSError:
        return None
    except ValueError:
        return False  # 글자가 깨진 곁파일 — 원자 쓰기라 쓰는 도중 모양이 아니다(지우기는 정상 곁파일만 잇는다)
    try:
        data = json.loads(raw)
    except ValueError:
        return False
    return isinstance(data, dict) and data.get("deleting") is True


# ── 정책(허브·계정별 — 백업 폴더 안 파일) ─────────────────────────────────────
def default_policy() -> dict:
    """정책 파일이 없을 때의 값. 모듈 값을 그때그때 읽는다(시험·환경변수가 바꾼다)."""
    def num(value: float) -> float | int:
        return int(value) if float(value).is_integer() else value

    return {
        "quiet_minutes": num(BACKUP_CHANGE_DEBOUNCE / 60.0),
        "min_interval_minutes": num(BACKUP_MIN_INTERVAL / 60.0),
        "recent": BACKUP_KEEP,
        "daily_days": BACKUP_KEEP_DAILY,
        "weekly_weeks": BACKUP_KEEP_WEEKLY,
    }


def _validate_policy(values: dict) -> dict:
    if not isinstance(values, dict):
        raise BackupPolicyError("invalid_policy", 422)
    out: dict[str, int] = {}
    for key, choices in POLICY_CHOICES.items():
        value = values.get(key)
        if type(value) is not int or value not in choices:
            raise BackupPolicyError("invalid_policy", 422)
        out[key] = value
    return out


def _saved_policy_version(d: Path) -> int | None:
    """등록 표식에 남긴 '저장한 정책 판 번호'(없으면 0). 표식을 못 읽거나 깨졌거나 저장 이력을 모르면 None(→ invalid)."""
    try:
        registry, corrupt = _read_registry(d)
    except OSError:
        return None
    if corrupt or (registry and registry.get("policy_unknown") is True):
        return None
    version = registry.get("policy_version") if registry else None
    return version if type(version) is int and version > 0 else 0


def read_policy(d: Path) -> tuple[dict, int, str]:
    """(정책, 판 번호, 출처 default|saved|invalid). 깨졌거나 허용 목록 밖이거나, 저장한 적 있는데(등록 표식의
    policy_version) 파일이 사라졌으면 invalid — 간격만 기본값, 회전은 지우지 않는다. AUTH(공유 서버·격리 dev)는
    정책 파일을 읽지 않고 모듈 값·환경변수만 쓴다."""
    if AUTH_ENABLED:
        return default_policy(), 0, "default"
    # 판 번호 = PUT 이 대조할 지금 판 번호. invalid 면 표식의 policy_version(없으면 0) — 다시 저장해 풀 수 있게.
    saved = _saved_policy_version(d)
    try:
        raw = (d / _POLICY_NAME).read_text("utf-8")
    except FileNotFoundError:
        if saved == 0:
            return default_policy(), 0, "default"
        return default_policy(), saved or 0, "invalid"
    except (OSError, ValueError):  # ValueError = 글자가 깨진 파일
        return default_policy(), saved or 0, "invalid"
    try:
        data = json.loads(raw)
        if not isinstance(data, dict) or data.get("format") != _POLICY_FORMAT:
            raise ValueError("format")
        version = data.get("policy_version")
        if type(version) is not int or version < 1:
            raise ValueError("version")
        if saved is None or version < saved:
            raise ValueError("older than recorded")  # 표식을 못 읽거나 옛 파일이 돌아옴
        return _validate_policy(data), version, "saved"
    except (ValueError, BackupPolicyError):
        return default_policy(), saved or 0, "invalid"


def _write_policy(d: Path, values: dict, version: int) -> None:
    """정책 파일을 먼저 쓰고, 등록 표식에 '저장한 정책 판 번호'를 남긴다(파일이 사라지면 알아채게)."""
    atomic_write_text(d / _POLICY_NAME, json.dumps(
        {"format": _POLICY_FORMAT, "format_version": 1, "policy_version": version, **values},
        ensure_ascii=False, sort_keys=True))
    _write_registry(d, policy_version=version, policy_unknown=False)


# 주기 루프가 이벤트 루프에서 파일을 읽지 않도록, 백업 폴더 상태를 읽는 스레드 호출(_read_poll_state)이
# 정책 간격도 함께 읽어 둔다. None = 저장된 정책 없음 → 모듈 값(BACKUP_CHANGE_DEBOUNCE 등).
_POLICY_INTERVALS: dict[str, tuple[float, float] | None] = {}


def _intervals_from(policy: dict, source: str) -> tuple[float, float] | None:
    if source != "saved":
        return None
    return float(policy["quiet_minutes"]) * 60.0, float(policy["min_interval_minutes"]) * 60.0


# ── 보관 선택·삭제 ───────────────────────────────────────────────────────────
@dataclass
class _RetentionPlan:
    keep: list[_BackupSet]
    delete: list[_BackupSet]
    blocked: str | None
    inverted: frozenset[str] = frozenset()  # 거꾸로 된 쌍의 앞쪽이라 지키는 세트(시계 문제가 남아 있다는 표시)


def _select_keep(cands: list[_BackupSet], policy: dict, now: float) -> set[str]:
    """남길 세트의 stamp — 최근 N(번호) + 오늘부터 D개 달력 날짜마다 그날 가장 새 것 + 이번 주부터 W개 주마다
    가장 새 것(한국 시간·월요일 시작) + 가장 새 것. 세트는 **자기** 촬영 시각으로 분류한다(시계가 틀렸던 구간의
    세트는 틀린 날짜로 분류돼 최근 N 밖으로 밀리면 지워지고, 그 앞 세트들은 _retention_plan 이 지킨다)."""
    newest_first = sorted(cands, key=lambda s: s.keep["seq"], reverse=True)  # type: ignore[index]
    keep = {s.stamp for s in newest_first[:max(1, int(policy["recent"]))]}
    today = datetime.fromtimestamp(now, KEEP_TZ).date()
    days = {today - timedelta(days=i) for i in range(int(policy["daily_days"]))}
    this_week = today - timedelta(days=today.weekday())
    weeks = {this_week - timedelta(weeks=i) for i in range(int(policy["weekly_weeks"]))}
    seen_days: set[date] = set()
    seen_weeks: set[date] = set()
    for s in newest_first:
        local = _captured_at(s).astimezone(KEEP_TZ).date()
        if local in days and local not in seen_days:
            seen_days.add(local)
            keep.add(s.stamp)
        week = local - timedelta(days=local.weekday())
        if week in weeks and week not in seen_weeks:
            seen_weeks.add(week)
            keep.add(s.stamp)
    return keep


def _retention_plan(
    d: Path,
    policy: dict,
    now: float,
    sets: list[_BackupSet] | None = None,
    *,
    policy_source: str = "saved",
    ignore_block: bool = False,
) -> _RetentionPlan:
    """읽기만 한다. 지울 후보 = 완성·정상 곁파일·번호 안 겹침·보호 아님·사용 중 아님. 미등록·불완전·깨진
    곁파일·번호 겹친 세트는 그 세트만 빼고 지우지 않는다(다른 세트 회전은 계속).

    전체를 막는 것은 저절로 또는 사용자가 풀 수 있는 둘뿐: 정책 파일이 깨지거나 사라짐(policy_invalid — 기본값으로
    줄여 지우지 않게, 다시 저장하면 풀림) · 번호가 가장 큰 세트의 촬영 시각이 지금보다 5분 넘게 뒤(clock_skew —
    poll 이 그 세트를 '백업 없음'처럼 보고 새 세트를 찍으면 풀림).

    시각이 거꾸로 된 쌍(번호가 더 큰 세트가 5분 넘게 먼저 찍힘)의 앞쪽 세트는 지우지 않는다. 쌍의 뒤쪽은 언젠가
    지울 수 있는 세트(완성·지우는 중 아님·보호 아님)만 센다 — 시계가 틀렸던 구간의 세트가 최근 N 밖으로 밀려
    지워지면 쌍이 사라지고, 그 세트가 불완전·보호라 영영 안 지워져도 앞 세트들을 묶지 않는다.

    ignore_block = 정책 미리보기용 '막힘·쌍 보호·사용 중 보호가 모두 풀리면 지울 대상'."""
    sets = _scan_sets(d) if sets is None else sets
    dup = _duplicate_seqs(sets)
    registered = [s for s in sets if s.keep_state == "ok" and s.keep and s.keep["seq"] not in dup]
    by_seq_desc = sorted(registered, key=lambda s: s.keep["seq"], reverse=True)  # type: ignore[index]
    blocked: str | None = None
    if policy_source == "invalid":
        blocked = "policy_invalid"
    elif by_seq_desc and _captured_at(by_seq_desc[0]).timestamp() > now + _CLOCK_SKEW_SECONDS:
        blocked = "clock_skew"

    def deletable(s: _BackupSet) -> bool:
        return s.complete and not s.deleting and not s.keep.get("protected")  # type: ignore[union-attr]

    inverted: set[str] = set()
    earliest_later: datetime | None = None
    for s in by_seq_desc:
        captured = _captured_at(s)
        if earliest_later is not None and earliest_later.timestamp() < captured.timestamp() - _CLOCK_SKEW_SECONDS:
            inverted.add(s.stamp)
        if deletable(s):
            earliest_later = captured if earliest_later is None or captured < earliest_later else earliest_later
    # ignore_block 이면 일시적인 보호(사용 중·쌍)도 풀린 것으로 본다 — 미리보기가 '나중에 지울 대상'까지 보이게.
    cands = [
        s for s in registered
        if deletable(s) and (ignore_block or (not _held(s.content) and s.stamp not in inverted))
    ]
    keep_stamps = _select_keep(cands, policy, now) if cands else set()
    keep = [s for s in cands if s.stamp in keep_stamps]
    delete = [] if blocked and not ignore_block else [s for s in cands if s.stamp not in keep_stamps]
    return _RetentionPlan(keep, delete, blocked, frozenset(inverted))


def _set_members(d: Path, stamp: str) -> list[Path]:
    """지울 때의 구성원 순서 — 만들 때(대표 파일 마지막 공개)의 반대: 콘텐츠 대표 파일 먼저 → 부속 DB →
    manifest → -wal/-shm. 대표 파일이 잠겨 못 지우면 세트가 통째로 남는다. 곁파일은 따로 마지막."""
    content = d / f"{_PREFIX}{stamp}.db"
    paths = backup_manifest.local_paths(content)
    dbs = [path for role, path in paths.items() if role != 'content' and path.suffix == '.db']
    members = [content, *dbs, paths['asset_mounts'], backup_manifest.local_path(content)]
    for db_path in (content, *dbs):
        members += [Path(str(db_path) + suffix) for suffix in ('-wal', '-shm', '-journal')]
    return members


def _finish_delete(d: Path, stamp: str) -> bool:
    for member in _set_members(d, stamp):
        try:
            member.unlink()
        except FileNotFoundError:
            continue
        except OSError:
            return False
    try:
        _keep_path(d / f"{_PREFIX}{stamp}.db").unlink()
    except FileNotFoundError:
        pass
    except OSError:
        return False
    return True


def _delete_set(s: _BackupSet) -> bool | None:
    """지우는 중 표식을 먼저 적고 → 구성원 → 곁파일 마지막. 중간 실패면 False(표식이 남아 다음에 이어 지움).
    붙잡힌(사용 중) 세트면 None — 붙잡기 확인과 표식 쓰기를 hold_set 과 같은 잠금 안에서 한다."""
    with _IN_USE_LOCK:
        if _use_key(s.content) in _IN_USE:
            return None
        try:
            _write_keep(s.content, {**(s.keep or {}), "deleting": True})
        except OSError:
            return False
    return _finish_delete(s.content.parent, s.stamp)


def _resume_deletions(d: Path) -> int:
    """지우다 멈춘 세트(**정상** 곁파일 deleting=true)를 대표 DB 가 없어도 이어 지운다. 깨진 곁파일은 손대지 않고,
    붙잡힌(사용 중) 세트는 건너뛴다(붙잡기 확인을 hold_set 과 같은 잠금 안에서). 돌려주는 값 = 못 지운 세트 수."""
    failed = 0
    for path in d.glob(f"{_PREFIX}*.keep.json"):
        stamp = path.name[len(_PREFIX):-len(".keep.json")]
        content = d / f"{_PREFIX}{stamp}.db"
        keep, state = _read_keep(content)
        if state != "ok" or not keep or keep.get("deleting") is not True:
            continue
        with _IN_USE_LOCK:
            if _use_key(content) in _IN_USE:
                continue
        if not _finish_delete(d, stamp):
            failed += 1
    return failed


# 백업 폴더별 마지막 회전의 막힌 이유·못 지운 세트 수·마지막 실패(상태 표시용, 프로세스 메모리).
_LAST_BLOCKED: dict[str, str | None] = {}
_LAST_DELETE_FAILED: dict[str, int] = {}
_LAST_ERROR: dict[str, dict] = {}


def _backup_dir() -> Path:
    """백업 폴더 — **활성 계정별**로 분리(계정 전환 시 서로의 백업을 회전-삭제하지 않게).
    로그인하면 backups/<email-slug>/, 미로그인/단독·공유서버면 레거시 평면 폴더(기존 그대로)."""
    key = active_account.account_key()
    return (BACKUP_DIR / active_account.slug(key)) if key else BACKUP_DIR


def _capture_backup_scope() -> tuple[Path, Path, str]:
    """계정 전환과 엇갈리지 않게 원본 DB와 백업 폴더를 한 순간에 캡처한다."""
    with active_account.transition_lock:
        account_key = active_account.account_key() or ""
        return get_db_path(), _backup_dir(), account_key


def _list_backups(backup_dir: Path | None = None) -> list[Path]:
    d = backup_dir or _backup_dir()
    if not d.is_dir():
        return []
    return sorted(d.glob(f"{_PREFIX}*.db"))


def latest_backup_path() -> Optional[Path]:
    """활성 계정의 최신 완성 콘텐츠 백업(촬영 순서 기준). 업데이트 뒤 outbox 보강 등에 사용한다."""
    with active_account.transition_lock:
        backup_dir = _backup_dir()
    live, _by_seq = _live_sets(_scan_sets(backup_dir))
    return live[-1].content if live else None


def _db_change_signature(src: Path | None = None) -> tuple[tuple[str, int, int], ...]:
    """개인 콘텐츠·휴지통의 파일/WAL 변화를 값싼 stat으로 감지한다."""
    content = src or get_db_path()
    trash = content.parent / "content_hub_trash.db"
    result: list[tuple[str, int, int]] = []
    inputs = [
        ("content", content),
        ("content-wal", Path(str(content) + "-wal")),
        ("trash", trash),
        ("trash-wal", Path(str(trash) + "-wal")),
    ]
    if _v3_capture_enabled():
        from . import asset_mounts
        manage = content.parent / 'manage_hub.db'
        if not manage.is_file():
            manage = MANAGE_DB_PATH
        inputs.extend([('manage', manage), ('manage-wal', Path(str(manage) + '-wal')),
                       ('asset_mounts', asset_mounts.mounts_file(active_account.account_key()))])
        agent = _poll_agent_path(content)
        if agent is not None:
            inputs.extend([('agent_chat', agent), ('agent_chat-wal', Path(str(agent) + '-wal'))])
    for label, path in inputs:
        try:
            stat = path.stat()
        except OSError:
            continue
        result.append((label, int(stat.st_mtime_ns), int(stat.st_size)))
    return tuple(result)


def _read_poll_state(
    src: Path,
    backup_dir: Path,
) -> tuple[Optional[float], tuple[tuple[str, int, int], ...], bool]:
    """한 번의 백업 목록 스캔으로 최근 나이·DB 서명·변경 필요 여부를 읽는다.

    NAS의 glob/stat은 느리거나 일시 실패할 수 있으므로 이 동기 helper 전체를 이벤트 루프 밖에서
    실행한다. 읽기 실패한 백업은 기존 계약처럼 건너뛰며, 정상 백업이 하나도 없으면 DB가 존재하는
    것 자체를 백업 필요 상태로 본다.
    """
    newest_mtime_ns: int | None = None
    try:
        # 목록은 poll당 정확히 한 번만 순회한다(_scan_sets). 곁파일 번호가 다 있으면 번호가 가장 큰
        # 세트가 최신이다 — 시계가 뒤로 간 뒤에도 옛 세트의 미래 mtime 에 속지 않게. 아니면 지금처럼 mtime.
        others, numbered = _split_live(_scan_sets(backup_dir, verify=False))
        # 곁파일만 읽은 목록에서 번호가 큰 것부터 그 세트만 완성 대조(보통 하나) — 목록·최신본과 같은 기준. 완성된 번호
        # 세트가 없으면 나머지를 지금처럼 mtime 이 큰 것부터(불완전한 세트를 기준으로 백업을 미루지 않게).
        candidates = [*reversed(numbered), *sorted(others, key=lambda s: s.mtime_ns, reverse=True)]
        for candidate in candidates:
            if _set_complete(candidate.content, candidate.keep):
                newest_mtime_ns = candidate.mtime_ns
                break
        if newest_mtime_ns is not None and newest_mtime_ns / 1_000_000_000 > time.time() + _CLOCK_SKEW_SECONDS:
            # 기준 세트가 미래(시계가 뒤로 감) — 나이 0·변경 없음으로 멈추지 않게 '백업 없음'처럼 다시 찍는다.
            # 새 세트는 번호가 더 커서 다음 poll 부터 기준이 된다. 지우기 보류는 회전 쪽(clock_skew) 몫.
            newest_mtime_ns = None
    except OSError:
        # NAS 순단은 '백업 없음'으로 처리해 주기 워커가 다음 poll에서 다시 확인하게 한다.
        newest_mtime_ns = None
    if isinstance(backup_dir, Path):
        # 이 스레드 호출에서 정책 간격도 읽어 둔다 — 주기 루프는 이벤트 루프에서 파일을 읽지 않는다.
        with contextlib.suppress(OSError):
            policy, _version, source = read_policy(backup_dir)
            _POLICY_INTERVALS[str(backup_dir)] = _intervals_from(policy, source)

    signature = _db_change_signature(src)
    backup_age = (
        None
        if newest_mtime_ns is None
        else max(0.0, time.time() - newest_mtime_ns / 1_000_000_000)
    )
    backup_needed = (
        bool(signature)
        if newest_mtime_ns is None
        else any(mtime_ns > newest_mtime_ns for _label, mtime_ns, _size in signature)
    )
    return backup_age, signature, backup_needed


def _change_backup_due(
    changed_at: float | None,
    backup_age: float | None,
    *,
    now: float,
    intervals: tuple[float, float] | None = None,
) -> bool:
    """편집이 잠잠하고 최소 백업 간격도 지난 경우에만 변경 백업을 허용한다.
    intervals = 그 계정이 고른 (조용, 최소 간격) 초. 없으면 모듈 값."""
    debounce, min_interval = intervals or (BACKUP_CHANGE_DEBOUNCE, BACKUP_MIN_INTERVAL)
    return bool(
        changed_at is not None
        and now - changed_at >= debounce
        and (backup_age is None or backup_age >= min_interval)
    )


def list_backups_info(backup_dir: Path | None = None) -> list[dict]:
    """보관 중인 백업 세트(최신순 — 곁파일 촬영 순서, 없으면 이름순). 완성·지우는 중 아닌 세트만.
    콘텐츠 파일은 기존 API의 대표 파일로 유지한다."""
    if backup_dir is None:
        with active_account.transition_lock:
            backup_dir = _backup_dir()
    out: list[dict] = []
    live, _by_seq = _live_sets(_scan_sets(backup_dir))
    for item in reversed(live):
        p = item.content
        st = p.stat()
        stamp = item.stamp
        related = [p]
        manifest = json.loads(backup_manifest.local_path(p).read_text('utf-8')) if backup_manifest.local_path(p).is_file() else None
        if manifest and manifest.get('format_version') == 3:
            related = list(backup_manifest.local_paths(p, manifest).values())
        for prefix in (_TRASH_PREFIX, _MANAGE_PREFIX):
            candidate = p.parent / f"{prefix}{stamp}.db"
            if candidate.is_file() and candidate not in related:
                related.append(candidate)
        manifest_path = backup_manifest.local_path(p)
        if manifest_path.is_file():
            related.append(manifest_path)
        out.append(
            {
                "file": p.name,
                "size": sum(member.stat().st_size for member in related),
                "mtime": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(),
                "files": [member.name for member in related],
                "seq": item.keep.get("seq") if item.keep else None,
                "reason": item.keep.get("reason") if item.keep else None,
                "captured_at": _captured_at(item).isoformat(),
            }
        )
    return out


def _rotate(
    backup_dir: Path,
    *,
    policy: dict | None = None,
    now: float | None = None,
    only: set[str] | None = None,
) -> dict:
    """보관 규칙대로 솎는다(호출자가 _BACKUP_LOCK 을 쥔다 — 시험은 직접 부른다).

    도입 등록 → 지우다 멈춘 세트 이어 지우기 → 계획(읽기) → 지우는 중 표식 → 구성원 → 곁파일. 한 세트를 못 지우면
    그 세트만 표식이 남아 목록에서 빠지고 다음 회전이 잇는다. only = 정책을 바꾸며 확인받은 세트 — 그 밖은 지우지 않는다
    (확인과 회전 사이에 붙잡기가 풀려도 확인한 것보다 많이 지우지 않게)."""
    d = backup_dir
    # failed = 이번에 새로 지우려다 못 지운 세트 · resume_failed = 지우다 멈춘 세트를 이어 지우다 또 못 지운 세트
    summary = {"deleted": 0, "blocked": None, "failed": 0, "resume_failed": 0}
    if not d.is_dir():
        return summary
    _ensure_registered(d)
    summary["resume_failed"] = _resume_deletions(d)
    if policy is None:
        policy, _version, source = read_policy(d)
    else:
        source = "saved"
    plan = _retention_plan(d, policy, time.time() if now is None else now, policy_source=source)
    _LAST_BLOCKED[str(d)] = plan.blocked
    summary["blocked"] = plan.blocked
    victims = plan.delete if only is None else [s for s in plan.delete if s.stamp in only]
    for victim in victims:
        result = _delete_set(victim)
        if result is None:
            continue  # 사용 중 — 다음 회전에
        if not result:
            # 그 세트만 지우는 중으로 남기고(목록에서 빠짐·다음 회전이 이어 지움) 나머지는 계속 — 못 지우는 파일
            # 하나가 회전 전체를 막지 않게.
            summary["failed"] += 1
            continue
        summary["deleted"] += 1
    _LAST_DELETE_FAILED[str(d)] = summary["failed"] + summary["resume_failed"]
    # 검증·조회가 백업본(WAL 헤더)을 열 때 생긴 -wal/-shm 부산물 청소 — 옛 회전이 .db 만 지워
    # 사이드카가 무기한 쌓였다(실측: 0바이트 -wal, 32KB -shm 다수). 짝 .db 가 없고, 같은 stamp 의 구성원(대표·부속
    # DB·manifest·곁파일)이 하나도 없는 것만 지운다 — 지우다 멈춘 세트·반쪽 세트(곁파일이 없어도)는 건드리지 않는다
    # (세트 지우기는 _finish_delete 만 한다). 열려 있으면 unlink 가 거부되므로 사용 중 파일을 지울 위험은 없다(suppress).
    with contextlib.suppress(OSError):
        kept = _member_stamps(d)
        for side in (*d.glob("*.db-wal"), *d.glob("*.db-shm")):
            base_name = side.name.rsplit("-", 1)[0]
            if (d / base_name).is_file() or _side_stamp(base_name) in kept:
                continue
            with contextlib.suppress(OSError):
                side.unlink()
    return summary


def _member_stamps(d: Path) -> set[str]:
    """구성원(대표·부속 DB·manifest·곁파일)이 하나라도 남은 stamp 들 — 한 번씩 목록을 읽는다(실패하면 OSError)."""
    stamps: set[str] = set()
    for pattern, cut, tail in ((f"{_PREFIX}*.db", len(_PREFIX), ".db"),
                               (f"{_TRASH_PREFIX}*.db", len(_TRASH_PREFIX), ".db"),
                               (f"{_MANAGE_PREFIX}*.db", len(_MANAGE_PREFIX), ".db"),
                               ('agent_chat_*.db', len('agent_chat_'), '.db'),
                               ('asset_mounts_*.json', len('asset_mounts_'), '.json'),
                               (f"{_PREFIX}*.manifest.json", len(_PREFIX), ".manifest.json"),
                               (f"{_PREFIX}*.keep.json", len(_PREFIX), ".keep.json")):
        stamps.update(path.name[cut:-len(tail)] for path in d.glob(pattern))
    return stamps


def _side_stamp(db_name: str) -> str | None:
    """세트 구성원 DB 이름에서 stamp — content_hub_/content_trash_/manage_hub_ 가 아니면 None."""
    for prefix in (_PREFIX, _TRASH_PREFIX, _MANAGE_PREFIX, 'agent_chat_'):
        if db_name.startswith(prefix) and db_name.endswith(".db"):
            return db_name[len(prefix):-3]
    return None


# 주기 백업과 관리자 수동 백업(POST /api/backup)이 겹칠 수 있어 파일 작업을 직렬화.
# 둘 다 asyncio.to_thread 로 실행되므로 스레드 락이어야 한다(단일 프로세스 운영 전제).
_BACKUP_LOCK = threading.Lock()
_TMP_MARK = ".tmp-"


def _cleanup_stale_tmp(d: Path) -> None:
    """크래시가 남긴 임시 백업 잔재 청소 — 이 모듈이 만든 이름만, 1일 이상 묵은 것만.
    (락 안에서 호출 — 지금 만들고 있는 tmp 를 지울 일이 없다.)"""
    cutoff = time.time() - 86400.0
    for p in (*d.glob(f".*.db{_TMP_MARK}*"), *d.glob(f".asset_mounts_*.json{_TMP_MARK}*")):
        with contextlib.suppress(OSError):
            if p.stat().st_mtime < cutoff:
                p.unlink()
    # 대표 파일 없는 반쪽 세트(부속 DB·manifest·곁파일)는 자동으로 치우지 않는다 — 공개 전 잔재인지, 공개된 뒤
    # 대표 파일만 잃은 세트인지 확실히 가를 수 없다(Codex 3차 P1). 상태 줄에 수만 보인다(retention_status leftovers).


def _validate_sidecar(path: Path, expected_table: str) -> None:
    """휴지통/관리 DB의 SQLite 무결성과 핵심 테이블 존재를 확인한다.

    path 는 방금 backup API 로 만들고 연결을 닫은 임시 사본이다(짝 -wal 없음) — immutable 로 연다. 아니면 읽기 전용 연결이
    만든 -wal/-shm 을 닫을 때 못 지워 백업마다 임시 이름 곁파일이 4개씩 남았다(2026-10-03 L5-1). 실제 DB 를 여는 곳은 그대로."""
    with contextlib.closing(sqlite3.connect(read_only_uri(path, immutable=True), uri=True)) as conn:
        result = conn.execute("PRAGMA quick_check").fetchone()
        if not result or result[0] != "ok":
            raise sqlite3.DatabaseError(f"quick_check failed: {result}")
        fk_rows = conn.execute("PRAGMA foreign_key_check").fetchmany(1)
        if fk_rows:
            raise sqlite3.DatabaseError("foreign_key_check failed")
        found = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (expected_table,)
        ).fetchone()
        if not found:
            raise sqlite3.DatabaseError(f"required table missing: {expected_table}")


# 백업 폴더는 보통 실사용 DB·생성물과 같은 디스크다 — 백업이 마지막 자리를 먹어 DB 쓰기가 실패하지 않게 남길 여유.
_DISK_MARGIN_BYTES = 512 * 1024 * 1024


def _check_disk_space(d: Path, sources: list[tuple[str, Path, str, str | None]]) -> None:
    """원본 DB(+WAL) 합 + 512MiB 여유가 없으면 파일을 쓰기 전에 실패한다 — 다시 시도해도 아무것도 안 쓴다.
    임시 파일을 같은 폴더에서 이름만 바꿔 공개하므로 새 세트에 드는 자리는 원본 크기 정도다."""
    need = 0
    for _label, source, _prefix, _table in sources:
        for path in (source, Path(str(source) + "-wal")):
            with contextlib.suppress(OSError):
                need += path.stat().st_size
    try:
        free = shutil.disk_usage(d).free
    except OSError:
        return  # 모르면 막지 않는다 — 쓰다 실패하면 지금처럼 임시 파일만 정리된다
    if free < need + _DISK_MARGIN_BYTES:
        raise BackupDiskFull(errno.ENOSPC, "backup disk full")


def _v3_capture_enabled() -> bool:
    return CAPTURE_VERSION == 3 and not AUTH_ENABLED and bool(active_account.account_key())


def _env_fingerprint() -> str:
    return hashlib.sha256((os.environ.get('CONTENT_HUB_AUTH_SECRET') or '').encode()).hexdigest()


def _agent_path(source: Path, content: Path, email: str, *, immutable: bool, secret: str | None) -> Path | None:
    from . import agent_chat, auth

    if not secret:
        with contextlib.closing(sqlite3.connect(read_only_uri(content, immutable=immutable), uri=True)) as conn:
            row = conn.execute("SELECT value FROM app_setting WHERE key='auth_secret'").fetchone()
            secret = row[0] if row else None
    if not secret:
        return None
    return agent_chat.Identity(auth.hub_id_for(secret, source), str(source.resolve()), email).file_path()


def _poll_agent_path(source: Path) -> Path | None:
    from .. import db

    if db.maintenance_active():
        return None
    try:
        with db.pinned_share_operation():
            secret = os.environ.get('CONTENT_HUB_AUTH_SECRET')
            epoch = db.pool_epoch()
            fingerprint = hashlib.sha256((secret or '').encode()).hexdigest()
            key = (str(source.resolve()), epoch, fingerprint)
            email = active_account.account_key() or ''
            cached = _AGENT_PATH_CACHE.get(key)
            if cached is not None and cached[0] == email:
                return cached[1]
            with db.share_operation_write():
                journal = Path(str(source) + '-journal')
                if journal.exists() and journal.stat().st_size:
                    return None
                path = _agent_path(source, source, email, immutable=False, secret=secret)
            db.require_share_operation_epoch()
            if fingerprint != _env_fingerprint():
                return None
        _AGENT_PATH_CACHE[key] = (email, path)
        return path
    except (OSError, ValueError, sqlite3.Error, db.DatabaseEpochChanged):
        return None


class BackupCaptureError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _backup_v3_for_scope(src: Path, d: Path, stamp: str | None, reason: str) -> Path:
    from .. import db
    from ..repo import agent_chat as agent_store
    from . import asset_mounts

    snapshots: list[tuple[str, Path, Path, str | None]] = []
    try:
        with db.pinned_share_operation():
            email = active_account.account_key() or ''
            secret = os.environ.get('CONTENT_HUB_AUTH_SECRET')
            epoch = db.pool_epoch()
            fingerprint = hashlib.sha256((secret or '').encode()).hexdigest()
            with _BACKUP_LOCK:
                db.require_share_operation_epoch()
                if fingerprint != _env_fingerprint():
                    raise BackupCaptureError('backup_scope_changed')
                d.mkdir(parents=True, exist_ok=True)
                _cleanup_stale_tmp(d)
                stamp = stamp or datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S_%f')
                content_dest = d / f'{_PREFIX}{stamp}.db'
                destinations = backup_manifest.local_paths(content_dest)
                if any(p.exists() for p in (*destinations.values(), backup_manifest.local_path(content_dest), _keep_path(content_dest))):
                    raise FileExistsError('backup stamp already exists')
                sources = [('content', src, _PREFIX, None)]
                manage = src.parent / 'manage_hub.db'
                if not manage.is_file():
                    manage = MANAGE_DB_PATH
                for role, path, table in (('trash', src.parent / 'content_hub_trash.db', 'trashed'),
                                          ('manage', manage, 'team_generation_fact')):
                    try:
                        mode = path.stat().st_mode
                    except FileNotFoundError:
                        continue
                    if not stat.S_ISREG(mode):
                        raise BackupCaptureError('backup_source_unreadable')
                    sources.append((role, path, _ROLE_PREFIX[role], table))

                def temporary(role: str, table: str | None = None) -> Path:
                    target = destinations[role]
                    path = target.with_name('.' + target.name + _TMP_MARK + uuid4().hex[:8])
                    snapshots.append((role, target, path, table))
                    return path

                for role, _source, _prefix, table in sources:
                    temporary(role, table)
                _check_disk_space(d, sources)
                _ensure_registered(d)
                times: dict[str, str] = {}
                with db.share_operation_write():
                    capture = _snapshot_database_set(sources, snapshots, capture_times=times)
                db.require_share_operation_epoch()
                role_paths = {role: tmp for role, _, tmp, _ in snapshots}
                for role, _, tmp, table in snapshots:
                    if role == 'content':
                        validate_hub_db(tmp, require_integrity=True)
                    else:
                        _validate_sidecar(tmp, table or '')
                roles = {role: {'state': 'present', 'captured_at': times[role],
                                **backup_manifest.role_info(path, role)} for role, path in role_paths.items()}
                for role in ('trash', 'manage'):
                    roles.setdefault(role, {'state': 'absent', 'captured_at': capture['captured_at']})
                agent = _agent_path(src, role_paths['content'], email, immutable=True, secret=secret)
                _AGENT_PATH_CACHE[(str(src.resolve()), epoch, fingerprint)] = (email, agent)
                roles['agent_chat'] = {'state': 'absent', 'captured_at': capture['captured_at']}
                if agent is not None:
                    try:
                        captured = datetime.now(timezone.utc).isoformat()
                        try:
                            mode = agent.stat().st_mode
                        except FileNotFoundError:
                            mode = None
                        roles['agent_chat']['captured_at'] = captured
                        if mode is not None:
                            if not stat.S_ISREG(mode):
                                raise ValueError('not a file')
                            _check_disk_space(d, [*sources, ('agent_chat', agent, '', None)])
                            tmp = temporary('agent_chat')
                            with agent_store.connect(agent, readonly=True) as conn:
                                conn.execute('BEGIN')
                                conn.execute('SELECT name FROM sqlite_master LIMIT 1').fetchone()
                                captured = datetime.now(timezone.utc).isoformat()
                                with contextlib.closing(sqlite3.connect(tmp)) as dest:
                                    conn.backup(dest)
                            backup_manifest._verify_agent(tmp)
                            role_paths['agent_chat'] = tmp
                            roles['agent_chat'] = {'state': 'present', 'captured_at': captured,
                                                   'size': tmp.stat().st_size, 'sha256': backup_manifest.file_digest(tmp)}
                    except agent_store.StaleRequest as exc:
                        raise BackupCaptureError('agent_chat_busy') from exc
                    except (OSError, ValueError, sqlite3.Error) as exc:
                        if isinstance(exc, BackupDiskFull):
                            raise
                        raise BackupCaptureError('agent_chat_unreadable') from exc
                db.require_share_operation_epoch()
                try:
                    mounts = asset_mounts.mounts_file(email)
                    raw, captured = asset_mounts.capture_bytes(mounts)
                    roles['asset_mounts'] = {'state': 'absent', 'captured_at': captured}
                    if raw is not None:
                        _check_disk_space(d, [*sources, ('asset_mounts', mounts, '', None),
                                              *([('agent_chat', agent, '', None)] if agent else [])])
                        tmp = temporary('asset_mounts')
                        tmp.write_bytes(raw)
                        role_paths['asset_mounts'] = tmp
                        roles['asset_mounts'] = {'state': 'present', 'captured_at': captured,
                                                'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
                    manifest = backup_manifest.seal({
                        'format': backup_manifest.LOCAL_FORMAT, 'format_version': 3,
                        'payload_version': backup_manifest.PAYLOAD_VERSION,
                        'account_scope_digest': backup_manifest.account_digest(active_account.slug(email)),
                        **capture, 'roles': roles,
                        'consistency_roles': (['content', 'trash'] if capture['consistency_kind'] == backup_manifest.PINNED
                                              else sorted(role_paths)),
                    })
                    backup_manifest.verify_files_v3(manifest, role_paths, local=True)
                except (OSError, ValueError) as exc:
                    if isinstance(exc, BackupDiskFull):
                        raise
                    raise BackupCaptureError('asset_mounts_invalid') from exc
                with db.share_operation_write():
                    if fingerprint != _env_fingerprint():
                        raise BackupCaptureError('backup_scope_changed')
                    atomic_write_text(backup_manifest.local_path(content_dest), backup_manifest.canonical(manifest))
                    _write_keep(content_dest, _keep_record(_next_seq(d), capture['captured_at'], reason, manifest['set_id']))
                    for role, dest, tmp, _ in sorted(snapshots, key=lambda item: item[0] == 'content'):
                        os.replace(tmp, dest)
        # The pin's exit check must succeed before retention can delete anything.
        with _BACKUP_LOCK:
            _rotate(d)
        _LAST_ERROR.pop(str(d), None)
        return content_dest
    except BaseException as exc:
        for _, _, tmp, _ in snapshots:
            with contextlib.suppress(OSError):
                tmp.unlink()
        _LAST_ERROR[str(d)] = {'code': ('disk_full' if isinstance(exc, BackupDiskFull)
                                      else getattr(exc, 'code', type(exc).__name__)),
                               'at': datetime.now(timezone.utc).isoformat()}
        raise


def _backup_now_for_scope(
    src: Path,
    backup_dir: Path,
    stamp: Optional[str] = None,
    reason: str = "auto",
) -> Optional[Path]:
    """이미 캡처한 한 계정의 경로만 사용해 백업과 회전을 끝낸다. reason = auto|manual(곁파일에 남는다)."""
    if reason not in ("auto", "manual"):
        raise ValueError(f"unknown backup reason: {reason}")
    if not src.exists():
        return None
    if _v3_capture_enabled():
        return _backup_v3_for_scope(src, backup_dir, stamp, reason)
    with _BACKUP_LOCK:
        d = backup_dir
        d.mkdir(parents=True, exist_ok=True)
        _cleanup_stale_tmp(d)
        # 마이크로초 포함 — 같은 초의 연속 백업(수동+주기)이 같은 최종 이름을 덮지 않게.
        stamp = stamp or datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S_%f")
        sources: list[tuple[str, Path, str, str | None]] = [
            ("content", src, _PREFIX, None),
        ]
        trash_src = src.parent / "content_hub_trash.db"
        # 관리 DB는 계정과 무관한 고정 경로(manage_db.MANAGE_DB_PATH)에 산다. 계정 로그인으로
        # 콘텐츠 DB가 acct/<slug>/ 아래로 옮겨가면 src.parent 에는 manage_hub.db 가 없어
        # 백업 세트에서 조용히 빠졌다 — 같은 폴더(레거시/서버 배치) 우선, 없으면 고정 경로.
        manage_src = src.parent / "manage_hub.db"
        if not manage_src.is_file():
            manage_src = MANAGE_DB_PATH
        if trash_src.is_file():
            sources.append(("trash", trash_src, _TRASH_PREFIX, "trashed"))
        if manage_src.is_file():
            sources.append(("manage", manage_src, _MANAGE_PREFIX, "team_generation_fact"))

        snapshots: list[tuple[str, Path, Path, str | None]] = []
        for label, source, prefix, expected_table in sources:
            dest = d / f"{prefix}{stamp}.db"
            tmp = d / f".{prefix}{stamp}.db{_TMP_MARK}{uuid4().hex[:8]}"
            snapshots.append((label, dest, tmp, expected_table))
        content_dest = d / f"{_PREFIX}{stamp}.db"
        keep_written = False
        try:
            # 디스크 확인을 가장 먼저(아무것도 쓰기 전) → 도입 등록을 새 세트보다 먼저 — 등록이 끝나기 전에는 새 세트가
            # 생기지 않는다(E4).
            _check_disk_space(d, sources)
            _ensure_registered(d)
            capture = _snapshot_database_set(sources, snapshots)
            for label, _, tmp, expected_table in snapshots:
                if label == "content":
                    validate_hub_db(tmp, require_integrity=True)
                else:
                    _validate_sidecar(tmp, expected_table or "")

            role_paths = {label: tmp for label, _, tmp, _ in snapshots}
            account_key = active_account.account_key() or ''
            manifest = backup_manifest.seal({
                'format': backup_manifest.LOCAL_FORMAT,
                'format_version': backup_manifest.VERSION,
                'payload_version': backup_manifest.PAYLOAD_VERSION,
                'account_scope_digest': backup_manifest.account_digest(active_account.slug(account_key) if account_key else ''),
                **capture,
                'roles': {role: backup_manifest.role_info(path, role) for role, path in role_paths.items()},
            })
            backup_manifest.verify_files(manifest, role_paths, local=True)
            # The metadata is durable before the representative content file is visible.
            atomic_write_text(backup_manifest.local_path(d / f'{_PREFIX}{stamp}.db'),
                              backup_manifest.canonical(manifest))
            # 보관 곁파일(촬영 순서 번호)도 대표 파일보다 먼저 — 못 쓰면 세트를 공개하지 않고 회전도 안 한다.
            captured = capture.get("captured_at") if isinstance(capture, dict) else None
            _write_keep(content_dest, _keep_record(
                _next_seq(d),
                captured if _parse_utc(captured) is not None else datetime.now(timezone.utc).isoformat(),
                reason,
                manifest.get("set_id") if isinstance(manifest, dict) else None,
            ))
            keep_written = True

            # 콘텐츠 대표 파일을 마지막에 공개한다. 중간 크래시가 나도 목록에는 불완전한
            # 세트가 나타나지 않는다(앞서 공개된 sidecar는 다음 회전에서 함께 정리됨).
            for label, dest, tmp, _ in sorted(snapshots, key=lambda item: item[0] == "content"):
                os.replace(tmp, dest)
        except BaseException as exc:
            for _, _, tmp, _ in snapshots:
                with contextlib.suppress(OSError):
                    tmp.unlink()
            if keep_written and not content_dest.exists():
                with contextlib.suppress(OSError):
                    _keep_path(content_dest).unlink()
            _LAST_ERROR[str(d)] = {
                "code": ("disk_full" if isinstance(exc, BackupDiskFull)
                         else "registry_unreadable" if isinstance(exc, RegistryUnreadable)
                         else type(exc).__name__),
                "at": datetime.now(timezone.utc).isoformat(),
            }
            raise
        _LAST_ERROR.pop(str(d), None)
        _rotate(d)  # 교체 성공 후에만 — 실패 시 기존 정상 백업은 손대지 않는다
        return content_dest


def backup_now(stamp: Optional[str] = None, reason: str = "auto") -> Optional[Path]:
    """검증 가능한 DB 백업 세트를 생성하고 대표 콘텐츠 경로를 반환(블로킹).
    DB 파일이 아직 없으면 None. 회전까지 수행.

    ★원자성: 임시 파일(선행 점 + .tmp — _list_backups 의 glob 에 절대 안 걸림)에 스냅샷을 뜬 뒤
    quick_check 무결성 검증을 통과해야만 최종 이름으로 os.replace 한다. 중간 크래시/디스크풀이면
    tmp 쓰레기만 남고, 백업 목록·회전은 검증 통과한 완성본만 본다."""
    src, backup_dir, account_key = _capture_backup_scope()
    token = active_account.set_override(account_key)
    try:
        return _backup_now_for_scope(src, backup_dir, stamp, reason)
    finally:
        active_account.reset_override(token)


def _files_bytes(s: _BackupSet) -> int:
    total = 0
    d = s.content.parent
    for path in (*_set_members(d, s.stamp), _keep_path(s.content)):
        with contextlib.suppress(OSError):
            total += path.stat().st_size
    return total


def retention_status(backup_dir: Path | None = None, *, now: float | None = None) -> dict:
    """설정 '자료 관리' 칸의 백업 현황(읽기만). 경로·이메일은 내보내지 않는다."""
    if backup_dir is None:
        with active_account.transition_lock:
            backup_dir = _backup_dir()
    policy, version, source = read_policy(backup_dir)
    sets = _scan_sets(backup_dir)
    live, _by_seq = _live_sets(sets)
    plan = _retention_plan(backup_dir, policy, time.time() if now is None else now, sets, policy_source=source)
    reasons = {reason: 0 for reason in _KEEP_REASONS}
    for s in live:
        if s.keep and s.keep.get("reason") in reasons:
            reasons[s.keep["reason"]] += 1
    latest_bytes = _files_bytes(live[-1]) if live else 0
    slots = int(policy["recent"]) + int(policy["daily_days"]) + int(policy["weekly_weeks"])
    # 대표 파일 없는 반쪽 세트 — 알려진 구성원(부속 DB·manifest·곁파일)을 stamp 로 모아, 대표 파일이 없고 지우는 중이
    # 아닌 것. 자동으로 치우지 않으므로 수와 용량을 보인다(곁파일 없는 잔재 — 공개 직전 실패 — 도 센다).
    leftovers = 0
    leftover_bytes = 0
    with contextlib.suppress(OSError):
        published = {s.stamp for s in sets}
        stamps: set[str] = set()
        for pattern, cut, tail in ((f"{_TRASH_PREFIX}*.db", len(_TRASH_PREFIX), ".db"),
                                   (f"{_MANAGE_PREFIX}*.db", len(_MANAGE_PREFIX), ".db"),
                                   ('agent_chat_*.db', len('agent_chat_'), '.db'),
                                   ('asset_mounts_*.json', len('asset_mounts_'), '.json'),
                                   (f"{_PREFIX}*.manifest.json", len(_PREFIX), ".manifest.json"),
                                   (f"{_PREFIX}*.keep.json", len(_PREFIX), ".keep.json")):
            stamps.update(path.name[cut:-len(tail)] for path in backup_dir.glob(pattern))
        for stamp in sorted(stamps - published):
            keep, state = _read_keep(backup_dir / f"{_PREFIX}{stamp}.db")
            if state == "ok" and keep and keep.get("deleting") is True:
                continue  # 정상 표식 = 이어 지우기 몫(깨진 삭제 표식 잔재는 이어 지우지 않으므로 여기서 센다)
            leftovers += 1
            for member in (*_set_members(backup_dir, stamp), _keep_path(backup_dir / f"{_PREFIX}{stamp}.db")):
                with contextlib.suppress(OSError):
                    leftover_bytes += member.stat().st_size
    return {
        "policy": {**policy, "version": version, "source": source},
        "set_count": len(live),
        "oldest_created_at": _captured_at(live[0]).isoformat() if live else None,
        "newest_created_at": _captured_at(live[-1]).isoformat() if live else None,
        "total_bytes": sum(_files_bytes(s) for s in live),
        "latest_set_bytes": latest_bytes,
        "estimated_max_bytes": latest_bytes * slots if latest_bytes else None,
        "reasons": reasons,
        "unregistered": sum(1 for s in sets if s.keep_state == "missing" and s.complete and _registry_done(backup_dir)),
        "incomplete": sum(1 for s in sets if not s.complete and not s.deleting),
        "sidecar_invalid": sum(1 for s in sets if s.keep_state == "invalid"),
        "sequence_conflict": sum(1 for s in sets if s.keep and s.keep["seq"] in _duplicate_seqs(sets)),
        "blocked": plan.blocked,
        "inverted": len(plan.inverted),
        "leftovers": leftovers,
        "leftover_bytes": leftover_bytes,
        "delete_failed": _LAST_DELETE_FAILED.get(str(backup_dir), 0),
        "last_error": _LAST_ERROR.get(str(backup_dir)),
    }


def _require_local_hub() -> None:
    # 공유 서버·격리 dev(AUTH)의 보관은 서버·NAS 정책과 함께 따로 정한다 — 여기서 바꾸지 않는다.
    if AUTH_ENABLED:
        raise BackupPolicyError("local_hub_only", 403)


def policy_view() -> dict:
    """GET /api/db/backup-policy — 지금 계정의 정책·판 번호·고를 수 있는 값(로컬 허브만)."""
    _require_local_hub()
    with active_account.transition_lock:
        backup_dir = _backup_dir()
    policy, version, source = read_policy(backup_dir)
    return {
        "policy": policy,
        "version": version,
        "source": source,
        "choices": {key: list(values) for key, values in POLICY_CHOICES.items()},
    }


def _preview(plan: _RetentionPlan, version: int) -> dict:
    kept = [_captured_at(s) for s in plan.keep]
    deleted = [_captured_at(s) for s in plan.delete]
    # 확인 토큰 = 정책 판 번호 + 지울 세트들 — 미리보기 뒤 백업이 늘어 대상이 바뀌면 토큰이 달라져 다시 묻는다.
    token_src = f"{version}|" + ",".join(sorted(s.stamp for s in plan.delete))
    return {
        "delete_count": len(plan.delete),
        "delete_bytes": sum(_files_bytes(s) for s in plan.delete),
        "delete_oldest_at": min(deleted).isoformat() if deleted else None,
        "delete_newest_at": max(deleted).isoformat() if deleted else None,
        "oldest_kept_at": min(kept).isoformat() if kept else None,
        "blocked": plan.blocked,
        "confirm_token": hashlib.sha256(token_src.encode("utf-8")).hexdigest()[:16] if deleted else None,
    }


def update_policy(
    values: dict,
    *,
    version: int,
    dry_run: bool = False,
    confirm_token: str | None = None,
    now: float | None = None,
) -> dict:
    """PUT /api/db/backup-policy(로컬 허브만). 한 생성 잠금 안에서: 허용 목록 → 판 번호 대조 → 도입 등록 →
    새 정책으로 미리보기 → 지울 세트가 있으면 같은 대상의 확인 토큰이어야 저장 → 저장(판 번호+1) → 회전."""
    _require_local_hub()
    clean = _validate_policy(values)
    with active_account.transition_lock:
        backup_dir = _backup_dir()
    when = time.time() if now is None else now
    with _BACKUP_LOCK:
        _old, current_version, _source = read_policy(backup_dir)
        if version != current_version:
            raise BackupPolicyError("version_conflict", 409)
        if backup_dir.is_dir():
            # 쓰기 경로(PUT) 안이라 dry_run 이어도 도입 등록·멈춘 지우기 잇기를 먼저 한다 — 미리보기 대상이 실제와 같게.
            _ensure_registered(backup_dir)
            _resume_deletions(backup_dir)
            # 새(정상) 정책으로 계산 — 깨진 정책(policy_invalid)에서 복구할 때도 대상을 보이고 확인받는다.
            # 미리보기 = 막힘·쌍 보호가 모두 풀리면 지울 대상(지금 지울 것만 보이면 나중에 확인 없이 지워진다).
            sets = _scan_sets(backup_dir)
            now_plan = _retention_plan(backup_dir, clean, when, sets)
            plan = _retention_plan(backup_dir, clean, when, sets, ignore_block=True)
        else:
            now_plan = plan = _RetentionPlan([], [], None)
        preview = _preview(plan, current_version)
        # 지금 시계가 기록보다 뒤(clock_skew)면 대상을 확정할 수 없다 — 지울 것이 생기는 정책은 시계가 바로잡힌 뒤에
        # 저장한다(늘리는 값은 저장). 시계는 맞고 거꾸로 된 쌍의 보호만 남았으면 미리보기('보호가 풀리면 지울 대상'
        # 까지)가 정확하므로 확인 토큰으로 저장한다 — 막힌 이유는 inverted 로 따로 보인다.
        skewed = now_plan.blocked == "clock_skew"
        if preview["delete_count"]:
            preview["blocked"] = "clock_skew" if skewed else ("inverted" if now_plan.inverted else preview["blocked"])
        if dry_run:
            return {"saved": False, "preview": preview, "version": current_version}
        if skewed and preview["delete_count"]:
            raise BackupPolicyError("clock_skew", 409, preview)
        if preview["delete_count"] and confirm_token != preview["confirm_token"]:
            raise BackupPolicyError("confirm_required", 409, preview)
        backup_dir.mkdir(parents=True, exist_ok=True)
        _write_policy(backup_dir, clean, current_version + 1)
        _POLICY_INTERVALS[str(backup_dir)] = _intervals_from(clean, "saved")
        # 확인받은 세트 안에서만 지운다 — 확인과 회전 사이에 붙잡기가 풀려도 확인한 것보다 많이 지우지 않게.
        applied = _rotate(backup_dir, policy=clean, now=when, only={s.stamp for s in plan.delete})
    return {"saved": True, "policy": clean, "version": current_version + 1, "preview": preview, "applied": applied}


def _completed_backup_info(path: Path) -> tuple[int, int | None]:
    """방금 반환된 대표 경로를 기준으로 완료 로그용 파일 수와 크기를 읽는다."""
    try:
        # 최신 목록 재탐색 대신 반환 경로의 stat을 먼저 읽어 다른 계정/동시 백업 혼입을 막는다.
        size = path.stat().st_size
    except OSError:
        return 1, None
    with contextlib.suppress(OSError, ValueError, TypeError):
        manifest = json.loads(backup_manifest.local_path(path).read_text('utf-8'))
        if isinstance(manifest, dict) and manifest.get('format_version') == 3:
            members = backup_manifest.local_paths(path, manifest)
            return len(members), sum(member.stat().st_size for member in members.values())
    stamp = path.name[len(_PREFIX):-3]
    related = [path]
    for prefix in (_TRASH_PREFIX, _MANAGE_PREFIX):
        candidate = path.parent / f"{prefix}{stamp}.db"
        if candidate.is_file():
            related.append(candidate)
            with contextlib.suppress(OSError):
                size += candidate.stat().st_size
    return len(related), size


def _run_backup_cycle(
    src: Path,
    backup_dir: Path,
    completed_callback: Callable[[Path], object] | None,
) -> Optional[Path]:
    """백업·성공 콜백·완료 기록을 취소로 중간 유기할 수 없는 한 동기 단위로 실행한다."""
    path = _backup_now_for_scope(src, backup_dir)
    if path is None:
        return None
    if completed_callback is not None:
        try:
            completed_callback(path)
        except Exception:  # noqa: BLE001 — 성공한 로컬 백업과 콜백 실패는 별개다
            log_event(
                _backup_log,
                "backup_callback_failed",
                level=logging.ERROR,
                exc_info=True,
            )
    file_count, total_size = _completed_backup_info(path)
    log_event(
        _backup_log,
        "backup_completed",
        backup_set_files=file_count,
        backup_set_bytes=total_size,
    )
    print(f"[backup] DB 세트 백업 생성 → {path.name}")
    return path


class PeriodicBackup:
    """백그라운드 주기 백업. PeriodicSync 와 동일한 수명주기 패턴."""

    def __init__(self, interval: float = BACKUP_INTERVAL) -> None:
        self._interval = interval
        self._task: Optional[asyncio.Task] = None
        self._completed_callback: Callable[[Path], object] | None = None

    def set_completed_callback(self, callback: Callable[[Path], object] | None) -> None:
        """검증된 세트가 공개된 뒤 실행할 부수효과. 서버·테스트는 기본 None이다."""
        self._completed_callback = callback

    def start(self) -> None:
        if self._interval <= 0:
            return  # 비활성
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="periodic-backup")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _run(self) -> None:
        # NAS 파일 조회는 한 동기 helper로 묶어 poll당 to_thread 한 번만 사용한다.
        scope = _capture_backup_scope()
        src, backup_dir, _account_key = scope
        age, signature, backup_needed = await self._poll(scope)
        # 시작 백업: 최근 백업이 충분히 새것이면 생략(재기동 난립 방지).
        if age is None or age >= _STARTUP_SKIP_IF_YOUNGER:
            await self._backup_once(scope)
            # 성공·실패 뒤의 최신 백업 시각을 다시 읽어 기존 시작 시점 판단을 보존한다.
            age, signature, backup_needed = await self._poll(scope)
        changed_at = time.monotonic() if backup_needed else None
        while True:
            await asyncio.sleep(min(60.0, BACKUP_POLL_INTERVAL))
            current_scope = _capture_backup_scope()
            src, backup_dir, _account_key = current_scope
            age, current_signature, current_backup_needed = await self._poll(current_scope)
            now = time.monotonic()
            if current_scope != scope:
                # 계정 전환 시 이전 계정의 dirty 시각을 버리고, 방금 읽은 새 계정 상태를
                # 독립 기준선으로 삼는다. 새 계정이 실제 dirty면 debounce를 지금부터 센다.
                scope = current_scope
                signature = current_signature
                changed_at = now if current_backup_needed else None
            elif current_signature != signature:
                signature = current_signature
                changed_at = now
            daily_due = age is None or age >= self._interval
            # 그 계정이 고른 간격 — _read_poll_state 가 같은 poll 의 스레드 호출에서 읽어 둔 값. 저장된 정책이
            # 없으면 지금처럼 모듈 값(인자 없이 부른다).
            intervals = _POLICY_INTERVALS.get(str(backup_dir))
            quiet_dirty_due = (
                _change_backup_due(changed_at, age, now=now, intervals=intervals)
                if intervals
                else _change_backup_due(changed_at, age, now=now)
            )
            if daily_due or quiet_dirty_due:
                succeeded = await self._backup_once(scope)
                if succeeded:
                    # 백업 중 원본 DB를 쓰지 않으므로 방금 읽은 서명을 다음 비교 기준으로 재사용한다.
                    signature = current_signature
                    changed_at = None
                elif not current_signature:
                    # 초기화 전이거나 제거된 DB는 성공이 아니지만, 사라진 대상의 dirty를
                    # 무한히 유지할 이유도 없다. DB가 생기면 새 서명이 다시 변경을 알린다.
                    changed_at = None

    async def _poll(self, scope):
        src, backup_dir, account_key = scope
        if CAPTURE_VERSION != 3 or AUTH_ENABLED or not account_key:
            return await asyncio.to_thread(_read_poll_state, src, backup_dir)
        token = active_account.set_override(account_key)
        try:
            return await asyncio.to_thread(_read_poll_state, src, backup_dir)
        finally:
            active_account.reset_override(token)

    async def _backup_once(
        self,
        scope: tuple[Path, Path, str] | None = None,
    ) -> bool:
        """검증된 로컬 백업 경로가 생성된 경우에만 True를 반환한다."""
        try:
            # 스케줄러는 poll에서 캡처한 scope를 넘긴다. None은 직접 호출 호환 경로다.
            src, backup_dir, account_key = (
                _capture_backup_scope() if scope is None else scope
            )
            account_token = active_account.set_override(account_key)
            try:
                # 스레드가 백업 파일·콜백을 소유하는 동안 요청 취소가 와도 완료까지 기다린다.
                path = await to_thread_non_abandon(
                    _run_backup_cycle,
                    src,
                    backup_dir,
                    self._completed_callback,
                )
                return path is not None
            finally:
                active_account.reset_override(account_token)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — 워커가 죽지 않도록 격리
            log_event(_backup_log, "backup_failed", level=logging.ERROR, exc_info=True)
            print(f"[backup] 오류({type(e).__name__}) — MV_logs.bat에서 상세 확인")
            return False


periodic_backup = PeriodicBackup()
