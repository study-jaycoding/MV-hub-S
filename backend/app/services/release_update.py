"""작업자 릴리스 설치본의 안전한 자기 업데이트 상태와 실행기.

공유 서버의 ``update_git.bat``과 역할을 섞지 않는다. 이 모듈은 작업자 PC에
``MVHub_Install.bat``으로 설치된 릴리스만 다루며, 신뢰된 ``INSTALL_SOURCE.txt``의
``latest.json``을 읽어 이미 설치된 안전 실행기로 격리된 업데이트 작업을 시작한다.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import re
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Literal

from ..config import AUTH_ENABLED, BACKEND_DIR, PORT
from .atomic_io import atomic_write_text
from .read_utf8_sig_first_line import read_first_line

APP_ROOT = BACKEND_DIR.parent
UPDATE_STATE_BASE = Path(
    os.environ.get(
        "MVHUB_UPDATE_STATE_DIR",
        str(Path(os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()) / "MVHub" / "updates"),
    )
)

_ACTIVE_STATES = frozenset({"starting", "checking", "downloading", "installing", "restarting"})
_STATE_STALE_SECONDS = 30 * 60
# 강제 업데이트의 보조 판정. 주 판정은 워커의 설치 잠금(_updater_lock_held)이고, 이것은 워커가
# 아직 잠금을 잡기 전 몇 초를 메운다. 죽은 업데이트는 20초면 풀려, 30분을 기다리거나 재설치할
# 일이 없다.
_FORCE_STALE_SECONDS = 20.0
# 워커가 잠금을 쥐고 있을 때만 나는 오류. ERROR_SHARING_VIOLATION(32)·ERROR_LOCK_VIOLATION(33).
# ACL 거부(5) 같은 다른 PermissionError 와 반드시 구분한다(update_release_worker.bat 과 같은 기준).
_SHARING_VIOLATION = frozenset({32, 33})
_SHA256_RE = re.compile(r"[0-9a-fA-F]{64}")
# make_release 기본 버전 = 제작 시각. 문자열 비교가 곧 시각 순이다 — 관리자 후보 선설치(U1)는 이 꼴만 지원한다.
_DATED_VERSION_RE = re.compile(r"\d{4}\.\d{2}\.\d{2}-\d{4}")
_RELEASE_MANIFESTS = frozenset({"latest.json", "candidate.json"})
_START_LOCK = threading.Lock()
_log = logging.getLogger(__name__)
_STATE_CHECK_FAILED_MESSAGE = (
    "업데이트 상태를 확인할 수 없습니다. 프로그램을 다시 실행한 뒤에도 계속되면 관리자에게 문의하세요"
)
_STATE_WRITE_FAILED_MESSAGE = "업데이트 상태를 저장하지 못했습니다. 잠시 뒤 다시 시도하세요"
_STATE_WRITE_RETRY_SECONDS = 5.0
_STATE_WRITE_RETRY_INTERVAL = 0.25
_PYTHON_DLL_RE = re.compile(r"python3\d{2}\.dll", re.IGNORECASE)
_RELEASE_PYTHON = (3, 14)
_RUNTIME_PROBE = (
    "import sys,struct,glob,pathlib,ssl,sqlite3,json,asyncio;"
    "import fastapi,uvicorn,pydantic,websockets,multipart,PIL,watchdog;"
    "import starlette,pydantic_core,annotated_types,annotated_doc,typing_inspection,typing_extensions;"
    "import anyio,idna,click,h11,httptools,dotenv,yaml,watchfiles,colorama,pip;"
    "print('%d.%d.%d|%d' % (*sys.version_info[:3], struct.calcsize('P') * 8))"
)


class ReleaseUpdateError(RuntimeError):
    """사용자에게 설명할 수 있는 릴리스 업데이트 오류."""


class _StatusRecorded(ReleaseUpdateError):
    """start_update 가 이미 알맞은 상태를 기록하고 멈춘 경우 — 공통 실패 처리가 'failed' 로 덮지 않는다."""


class ReleaseUpdateBusyError(ReleaseUpdateError):
    """유료 생성 또는 Comfy 실행이 남아 업데이트를 시작할 수 없음."""


class ReleaseFileMissing(ReleaseUpdateError):
    """릴리스 폴더에 그 파일이 정말 없다(읽기 실패와 구분 — '표지 없음'은 처음 상태일 수 있다)."""


class ReleasePromoteError(ReleaseUpdateError):
    """후보 배포(promote) 거절. status 는 HTTP 코드, 메시지에는 경로·OS 원문을 넣지 않는다."""

    def __init__(self, message: str, status: int = 409) -> None:
        super().__init__(message)
        self.status = status


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_version(root: Path = APP_ROOT) -> str:
    try:
        return (root / "VERSION.txt").read_text("utf-8-sig").strip()
    except OSError:
        return ""


def install_mode(root: Path = APP_ROOT) -> str:
    """release | server | development.

    인증 공유 서버에서는 INSTALL_SOURCE.txt가 잘못 남아 있어도 작업자 업데이트를
    절대 노출하지 않는다. 서버 배포는 update_git.bat 한 경로만 사용한다.
    """
    if AUTH_ENABLED:
        return "server"
    # VERSION/MV_agent may be absent after an interrupted or damaged install. The
    # durable release identity is the trusted source plus updater itself; keeping
    # repair mode available is more important than misclassifying damage as dev.
    required = ("INSTALL_SOURCE.txt", "update_release.bat")
    return "release" if all((root / name).is_file() for name in required) else "development"


def _installation_health(root: Path, expected_cli_version: str = "") -> tuple[bool, str]:
    """완료 버전 표식만 믿지 않고 실제 설치본이 실행 가능한지 확인한다."""
    required = (
        "MV_agent.bat",
        "update_release.bat",
        "run_release_update.ps1",
        "update_release_worker.bat",
        "run_agent_session.py",
        "agent_push.py",
        "backend/serve.py",
        "backend/app/main.py",
        "frontend/dist/index.html",
    )
    missing = [name for name in required if not (root / Path(name)).is_file()]
    if missing:
        return False, f"필수 파일 누락: {missing[0]}"

    runtime = root / "runtime" / "python"
    python_exe = runtime / "python.exe"
    if not python_exe.is_file():
        return False, "내장 Python 실행 파일 누락"
    try:
        completed = subprocess.run(  # noqa: S603 — 설치 폴더의 고정 실행 파일
            [str(python_exe), "-I", "-c", _RUNTIME_PROBE],
            cwd=str(root),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"내장 Python 실행 실패: {exc}"
    identity = completed.stdout.strip().splitlines()[-1] if completed.stdout.strip() else ""
    if completed.returncode != 0 or not re.fullmatch(r"\d+\.\d+\.\d+\|\d+", identity):
        detail = (completed.stderr or completed.stdout).strip().splitlines()
        return False, f"내장 Python 모듈 검사 실패: {(detail[-1] if detail else 'unknown error')}"
    version, bits = identity.split("|", 1)
    if bits != "64":
        return False, f"내장 Python 비트 수 불일치: {bits}비트"
    major, minor, _patch = version.split(".", 2)
    if (int(major), int(minor)) != _RELEASE_PYTHON:
        return False, f"내장 Python 버전 불일치: {version} (필요: 3.14 x64)"
    expected_dll = f"python{major}{minor}.dll".casefold()
    version_dlls = sorted(path.name for path in runtime.glob("python*.dll") if _PYTHON_DLL_RE.fullmatch(path.name))
    if len(version_dlls) != 1 or version_dlls[0].casefold() != expected_dll:
        return False, f"Python DLL 혼합 감지: {', '.join(version_dlls) or '없음'}"

    pin_path = root / "hf_cli_version.txt"
    manifest_path = root / "runtime" / "higgsfield" / "node_modules" / "@higgsfield" / "cli" / "package.json"
    node_exe = root / "runtime" / "node" / "node.exe"
    cli_entry = manifest_path.parent / "bin" / "higgsfield.js"
    if not all(path.is_file() for path in (pin_path, manifest_path, node_exe, cli_entry)):
        return False, "내장 Higgsfield CLI 파일 누락"
    try:
        # pin 계약=첫 줄(BOM 허용) — 읽기 규칙은 read_first_line 단일 출처.
        pin = read_first_line(pin_path)
        package_version = str(json.loads(manifest_path.read_text("utf-8-sig")).get("version") or "").strip()
    except (OSError, ValueError, TypeError) as exc:
        return False, f"내장 Higgsfield CLI 정보 손상: {exc}"
    if not pin or package_version != pin or (expected_cli_version and pin != expected_cli_version):
        return False, f"내장 Higgsfield CLI 버전 불일치: pin={pin}, package={package_version}"
    try:
        cli_result = subprocess.run(  # noqa: S603 — 설치 폴더의 고정 Node/CLI
            [str(node_exe), str(cli_entry), "version"],
            cwd=str(root),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"내장 Higgsfield CLI 실행 실패: {exc}"
    cli_version = cli_result.stdout.strip()
    expected_prefix = f"higgsfield {pin}"
    if cli_result.returncode != 0 or not (
        cli_version == expected_prefix or cli_version.startswith(expected_prefix + " ")
    ):
        detail = (cli_result.stderr or cli_result.stdout).strip()
        return False, f"내장 Higgsfield CLI 실행 검사 실패: {detail or 'unknown error'}"
    return True, ""


def state_path(root: Path = APP_ROOT) -> Path:
    identity = hashlib.sha256(str(root.resolve()).casefold().encode("utf-8")).hexdigest()[:16]
    return UPDATE_STATE_BASE / f"update-{identity}.json"


def _load_state(
    root: Path = APP_ROOT,
) -> tuple[Literal["ok", "missing", "unreadable", "invalid"], dict[str, Any]]:
    path = state_path(root)
    for attempt in range(3):
        try:
            value = json.loads(path.read_text("utf-8-sig"))
        except (FileNotFoundError, NotADirectoryError):
            return "missing", {}
        except OSError:
            if attempt < 2:
                time.sleep(0.05)
                continue
            _log.warning("Update state: unreadable")
            return "unreadable", {}
        except (ValueError, TypeError):
            _log.warning("Update state: invalid")
            return "invalid", {}
        if isinstance(value, dict):
            return "ok", value
        _log.warning("Update state: invalid")
        return "invalid", {}
    return "unreadable", {}  # 모든 읽기는 위의 유계 반복에서 분류된다.


def write_state(
    state: str,
    message: str,
    *,
    root: Path = APP_ROOT,
    latest_version: str = "",
    current_version: str | None = None,
    candidate: bool = False,
) -> dict[str, Any]:
    payload = {
        "state": state,
        "message": message,
        "current_version": _read_version(root) if current_version is None else current_version,
        "latest_version": latest_version,
        "updated_at": _utc_now(),
    }
    if candidate:
        # 이 PC 가 공지 전 후보를 쓰는 중(U1) — refresh 없는 응답에도 남도록 상태 파일에 저장한다.
        payload["candidate"] = True
    path = state_path(root)
    serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    deadline = time.monotonic() + _STATE_WRITE_RETRY_SECONDS
    while True:
        try:
            atomic_write_text(path, serialized)
            break
        except OSError as exc:
            # 상태 파일만 재시도한다. 원자 교체의 바이트 보장은 작성자 간 순서 보장이 아니다.
            if getattr(exc, "winerror", None) not in {5, 32, 33} or time.monotonic() >= deadline:
                raise
            time.sleep(_STATE_WRITE_RETRY_INTERVAL)
    return payload


def _state_age_seconds(value: dict[str, Any]) -> float | None:
    raw = value.get("updated_at")
    if not isinstance(raw, str) or not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return max(0.0, (datetime.now(timezone.utc) - parsed).total_seconds())
    except ValueError:
        return None


def _active_and_fresh(value: dict[str, Any]) -> bool:
    age = _state_age_seconds(value)
    return bool(
        str(value.get("state") or "") in _ACTIVE_STATES
        and (age is None or age < _STATE_STALE_SECONDS)
    )


def _updater_lock_held(root: Path) -> bool:
    """워커(update_release_worker.bat)가 설치 잠금을 쥐고 있나 — 살아 있는지의 **진짜 신호**.

    워커는 `.update.lock` 을 FileShare.None 으로 연다. 같은 파일을 여기서 열어 보면, 잡혀 있을
    때만 공유 위반(Windows ERROR_SHARING_VIOLATION → PermissionError)이 난다. 상태 파일의
    나이로 살아 있음을 추정하는 것보다 정확하다 — 다운로드는 5% 단위로만 상태를 쓰고
    재시작 대기는 3분까지 간다(Codex 지적, 2026-09-28).
    """
    path = root / ".update.lock"
    try:
        with path.open("r+b"):
            return False
    except PermissionError as exc:
        # PermissionError 에는 ACL 접근 거부(5)·읽기 전용도 섞인다. 그것까지 '워커가 쥐고 있다'로
        # 보면 그런 설치에서는 강제가 영영 거절된다 — 워커와 같은 기준(공유/잠금 위반)만 본다
        # (Codex 2026-09-28, update_release_worker.bat 의 32/33 판정과 같은 계약).
        return getattr(exc, "winerror", None) in _SHARING_VIOLATION
    except OSError:
        # 없음·경로 문제 등 — 잠금 근거가 아니므로 막지 않는다(상태 나이가 뒤에서 걸러 준다).
        return False


def _force_blocked(value: dict[str, Any], root: Path) -> bool:
    """강제 업데이트를 막아야 하나 — 워커가 **살아 있을 때만**.

    ① 설치 잠금을 쥐고 있으면 확실히 살아 있다. ② 잠금을 아직 잡기 전(시작 직후 몇 초)일 수
    있으므로, 방금 갱신된 진행 상태도 막는다. 시각을 모르는 상태(updated_at 없음/깨짐)는
    신뢰할 수 없으므로 막지 않는다 — 강제는 바로 그런 망가진 상태를 푸는 수단이다.
    """
    if _updater_lock_held(root):
        return True
    age = _state_age_seconds(value)
    return bool(
        str(value.get("state") or "") in _ACTIVE_STATES
        and age is not None
        and age < _FORCE_STALE_SECONDS
    )


def update_in_progress(root: Path = APP_ROOT) -> bool:
    kind, value = _load_state(root)
    return kind in {"unreadable", "invalid"} or _active_and_fresh(value)


def install_source(root: Path) -> str:
    """신뢰된 릴리스 위치(INSTALL_SOURCE.txt) — 업데이트와 서버 이사 공지가 함께 쓴다."""
    try:
        source = (root / "INSTALL_SOURCE.txt").read_text("utf-8-sig").strip()
    except OSError as exc:
        raise ReleaseUpdateError("릴리스 설치 정보가 없습니다") from exc
    if not source:
        raise ReleaseUpdateError("릴리스 설치 정보가 비어 있습니다")
    if source.lower().startswith(("http://", "https://")):
        return source.rstrip("/")
    path = Path(source).expanduser()
    if not path.is_absolute():
        raise ReleaseUpdateError("릴리스 위치는 절대경로 또는 HTTP(S) 주소여야 합니다")
    return str(path)


def _safe_release_name(value: Any) -> str:
    name = str(value or "").strip()
    if not name or Path(name).name != name or "/" in name or "\\" in name:
        raise ReleaseUpdateError("latest.json의 릴리스 파일명이 안전하지 않습니다")
    return name


def _read_release_file(source: str, name: str, *, max_bytes: int) -> bytes:
    safe_name = _safe_release_name(name)
    if source.lower().startswith(("http://", "https://")):
        url = source.rstrip("/") + "/" + urllib.parse.quote(safe_name)
        try:
            with urllib.request.urlopen(url, timeout=12) as response:
                try:
                    length = int(response.headers.get("Content-Length") or 0)
                except (TypeError, ValueError):
                    length = 0
                if length > max_bytes:
                    raise ReleaseUpdateError("릴리스 정보 파일이 너무 큽니다")
                data = response.read(max_bytes + 1)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise ReleaseFileMissing(f"릴리스 서버에 {safe_name} 이(가) 없습니다") from exc
            raise ReleaseUpdateError(f"릴리스 서버에 연결할 수 없습니다: {exc}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ReleaseUpdateError(f"릴리스 서버에 연결할 수 없습니다: {exc}") from exc
        if len(data) > max_bytes:
            raise ReleaseUpdateError("릴리스 정보 파일이 너무 큽니다")
        return data

    path = Path(source) / safe_name
    try:
        if path.stat().st_size > max_bytes:
            raise ReleaseUpdateError("릴리스 정보 파일이 너무 큽니다")
        return path.read_bytes()
    except ReleaseUpdateError:
        raise
    except FileNotFoundError as exc:
        raise ReleaseFileMissing(f"릴리스 파일이 없습니다: {path}") from exc
    except OSError as exc:
        raise ReleaseUpdateError(f"릴리스 파일을 읽을 수 없습니다: {path}") from exc


_MANIFEST_MAX_BYTES = 1024 * 1024


def _parse_manifest(raw: bytes, name: str = "latest.json") -> dict[str, Any]:
    """표지(latest.json)·후보(candidate.json) 공통 형식 검사 — 둘은 필드가 같다(B안)."""
    try:
        latest = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError, TypeError) as exc:
        raise ReleaseUpdateError(f"{name} 형식이 올바르지 않습니다") from exc
    if not isinstance(latest, dict):
        raise ReleaseUpdateError(f"{name} 형식이 올바르지 않습니다")
    version = str(latest.get("version") or "").strip()
    filename = _safe_release_name(latest.get("file"))
    digest = str(latest.get("sha256") or "").strip().lower()
    if not version or not _SHA256_RE.fullmatch(digest):
        raise ReleaseUpdateError(f"{name}에 version, file, sha256이 필요합니다")
    try:
        size = int(latest.get("size") or 0)
    except (TypeError, ValueError) as exc:
        raise ReleaseUpdateError(f"{name}의 size가 올바르지 않습니다") from exc
    if size < 0:
        raise ReleaseUpdateError(f"{name}의 size가 올바르지 않습니다")
    return {
        "version": version,
        "file": filename,
        "sha256": digest,
        "size": size,
        # 옛 latest.json 호환: 생성 시각이 없으면 안정적인 과거값으로 두고 등록은 허용한다.
        "created_at": str(latest.get("created_at") or "1970-01-01T00:00:00+00:00").strip(),
        "higgsfield_cli_version": str(latest.get("higgsfield_cli_version") or "").strip(),
    }


def fetch_latest(root: Path = APP_ROOT) -> dict[str, Any]:
    source = install_source(root)
    raw = _read_release_file(source, "latest.json", max_bytes=_MANIFEST_MAX_BYTES)
    return {**_parse_manifest(raw), "source": source}


def fetch_candidate(root: Path = APP_ROOT) -> dict[str, Any]:
    source = install_source(root)
    raw = _read_release_file(source, "candidate.json", max_bytes=_MANIFEST_MAX_BYTES)
    return {**_parse_manifest(raw, "candidate.json"), "source": source}


def _release_key(release: dict[str, Any]) -> tuple[str, str, int, str]:
    """같은 판인가 — promote(공지)와 후보 선설치가 같은 네 필드로 비교한다."""
    return (str(release.get("version")), str(release.get("file")), int(release.get("size") or 0),
            str(release.get("sha256") or "").lower())


def _newer_dated(version: str, than: str) -> bool:
    return (bool(_DATED_VERSION_RE.fullmatch(version or "") and _DATED_VERSION_RE.fullmatch(than or ""))
            and version > than)


def _installed_candidate(root: Path, current: str, latest: dict[str, Any]) -> dict[str, Any] | None:
    """이 PC 가 공지 전 후보를 쓰는 중이면 그 후보(U1, 2026-10-03). get_status 와 일반 start_update 가 같이 쓴다.

    공개본보다 새 날짜 판일 때만 후보를 읽는다(팀원 PC 는 보통 공개본보다 옛 판이라 NAS 를 더 안 읽는다).
    후보가 없거나 다른 판이면 None — 취소·교체된 후보는 지금처럼 공개본이 대상이다(되돌리기 가능).
    후보를 못 읽으면 오류 — 취소로 보고 공개본으로 내려가지 않게.
    """
    if not _newer_dated(current, latest["version"]):
        return None
    try:
        cand = fetch_candidate(root)
    except ReleaseFileMissing:
        return None
    except ReleaseUpdateError as exc:
        raise ReleaseUpdateError("공지 전 후보 상태를 확인할 수 없습니다 — 잠시 뒤 다시 확인하세요") from exc
    if cand["version"] != current or cand["sha256"] == latest["sha256"]:
        return None
    return cand


def _candidate_verdict(root: Path, cand: dict[str, Any]) -> tuple[str, str]:
    """후보를 쓰는 PC 의 판정 — 건강하면 up_to_date, 손상이면 check_failed(성공으로 보이지 않게, Codex).
    건강 검사는 Python·CLI 를 실행해 수 초 걸린다 — get_status 는 상태 잠금 밖에서 부른다."""
    healthy, reason = _installation_health(root, cand["higgsfield_cli_version"])
    if healthy:
        return "up_to_date", f"공지 전 후보 v{cand['version']} 를 이 PC 에서 쓰는 중입니다 — [공지]하면 팀에 배포됩니다."
    return "check_failed", (
        f"공지 전 후보 v{cand['version']} 설치 상태 이상: {reason} — "
        "관리자 창 업데이트 탭의 [이 PC에 다시 설치]로 고치세요."
    )


def _candidate_status(
    root: Path, cand: dict[str, Any], current: str, verdict: tuple[str, str] | None = None,
) -> dict[str, Any]:
    """후보를 쓰는 PC 의 상태 기록(verdict 를 미리 구했으면 그대로 쓴다)."""
    state, message = verdict or _candidate_verdict(root, cand)
    return write_state(
        state, message, root=root, current_version=current, latest_version=cand["version"], candidate=True,
    ) | {"install_mode": "release", "can_update": False}


def release_overview(root: Path = APP_ROOT) -> dict[str, Any]:
    """관리자 업데이트 탭 — 후보·공개 표지를 한 번씩 읽어 상태로 돌려준다(B안 r4 §4).

    보여 줄 5필드는 후보가 정상이면 후보, **후보 파일이 없을 때만** 공개본(후보가 깨졌으면 공개본으로
    조용히 대체하지 않고 candidate_error 로 알린다). pending(공개 대기)은 두 표지를 모두 확인했을 때만
    참/거짓이고, 공개 표지를 못 읽었으면 None(확인 불가 — 배포 단추를 막는다).
    """
    source = install_source(root)

    def read(name: str) -> tuple[str, dict[str, Any] | None]:
        try:
            return "ok", _parse_manifest(_read_release_file(source, name, max_bytes=_MANIFEST_MAX_BYTES), name)
        except ReleaseFileMissing:
            return "missing", None
        except ReleaseUpdateError:
            return "error", None

    cand_state, cand = read("candidate.json")
    pub_state, pub = read("latest.json")
    shown = cand if cand is not None else pub
    if shown is None:
        raise ReleaseUpdateError("릴리스 폴더에서 latest.json·candidate.json 을 읽을 수 없습니다")
    if cand is not None:
        pending = None if pub_state == "error" else pub is None or pub["sha256"] != cand["sha256"]
    else:
        pending = False if cand_state == "missing" else None
    return {
        **{key: shown[key] for key in ("version", "file", "sha256", "size", "created_at")},
        "source": "candidate" if cand is not None else "latest",
        "candidate_error": "candidate.json 을 읽을 수 없습니다" if cand_state == "error" else None,
        "published": None if pub is None else {"version": pub["version"], "sha256": pub["sha256"]},
        "published_state": pub_state,
        "pending": pending,
    }


# ── 후보 배포(promote) — B안 r4: [공지]한 후보를 NAS 표지(latest.json)로 올린다 ──────────────
_OPEN_ALWAYS = 4  # _winapi 에 상수가 없다(Win32 CreateFile dwCreationDisposition)
_RELEASE_LOCK_NAME = "release.lock"
_RELEASE_LOCK_WAIT_SECONDS = 10.0
_RELEASE_LOCK_RETRY_SECONDS = 0.25


def _safe_os_error(exc: OSError) -> ReleasePromoteError:
    """OS 원문(UNC 경로 등)은 내보내지 않고 종류별 고정 문구로(로그에는 winerror 만)."""
    code = getattr(exc, "winerror", None)
    _log.warning("Release promote: os error winerror=%s", code)
    if code == 5:
        return ReleasePromoteError("릴리스 폴더에 쓰기 권한이 없습니다 — 쓰기 권한이 있는 관리자 PC 에서 하세요", 403)
    if code in _SHARING_VIOLATION:
        return ReleasePromoteError("다른 PC 나 프로그램이 표지 파일을 쓰는 중입니다 — 잠시 뒤 다시 하세요")
    if code == 112:
        return ReleasePromoteError("릴리스 폴더 공간이 부족합니다")
    return ReleasePromoteError(f"릴리스 폴더를 다루지 못했습니다(오류 {code or '알 수 없음'})", 400)


@contextmanager
def _release_lock(folder: Path) -> Iterator[None]:
    """릴리스 폴더 잠금 — `release.lock` 을 **배타 공유 모드로 연 동안**이 잠금이다.

    make_release·select_release(PowerShell `[IO.File]::Open(...,'None')`)와 같은 규칙이라 세 쓰기자가
    서로를 기다린다. 핸들을 닫으면 풀리므로 남은 잠금 파일을 지울 일이 없다(파일은 남겨 둔다).
    원격 장애 때는 서버가 연결을 정리할 때까지 해제가 늦을 수 있다. 참여하지 않는 쓰기(옛 스크립트·
    손 복사)는 막지 못한다 — 최종 권한은 NAS 쓰기 권한이다.
    """
    if os.name != "nt":
        raise ReleasePromoteError("배포는 Windows 관리자 PC 에서만 할 수 있습니다", 400)
    import _winapi

    deadline = time.monotonic() + _RELEASE_LOCK_WAIT_SECONDS
    while True:
        try:
            handle = _winapi.CreateFile(
                str(folder / _RELEASE_LOCK_NAME),
                _winapi.GENERIC_READ | _winapi.GENERIC_WRITE,
                0,  # 공유 없음 = 잠금. 보안 속성 NULL 이라 자식 프로세스에 상속되지 않는다.
                0,
                _OPEN_ALWAYS,
                0,
                0,
            )
            break
        except OSError as exc:
            if getattr(exc, "winerror", None) not in _SHARING_VIOLATION:
                raise _safe_os_error(exc) from exc
            if time.monotonic() >= deadline:
                raise ReleasePromoteError("다른 관리자가 배포 표지를 바꾸는 중입니다 — 잠시 뒤 다시 하세요") from exc
            time.sleep(_RELEASE_LOCK_RETRY_SECONDS)
    try:
        yield
    finally:
        _winapi.CloseHandle(handle)


def _read_manifest_bytes(path: Path) -> bytes | None:
    """표지 원문 바이트. 없으면 None(처음 상태), 못 읽으면 거절 — 없음과 읽기 실패를 섞지 않는다."""
    try:
        if path.stat().st_size > _MANIFEST_MAX_BYTES:
            raise ReleasePromoteError(f"{path.name} 이 너무 큽니다")
        return path.read_bytes()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ReleasePromoteError("릴리스 폴더의 표지를 읽을 수 없습니다 — 공개 상태를 확인할 수 없습니다") from exc


def _verify_package(path: Path, size: int, sha256: str) -> None:
    """후보 zip 실물이 공지한 것과 같은지 — 크기와 전체 sha256(수백 MB, 잠금 밖에서)."""
    try:
        if path.stat().st_size != size:
            raise ReleasePromoteError("설치 파일 크기가 후보와 다릅니다 — 다시 만들어 올리세요")
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except FileNotFoundError as exc:
        raise ReleasePromoteError("후보 설치 파일이 릴리스 폴더에 없습니다") from exc
    except OSError as exc:
        raise _safe_os_error(exc) from exc
    if digest.hexdigest() != sha256:
        raise ReleasePromoteError("설치 파일 지문이 후보와 다릅니다 — 다시 만들어 올리세요")


def _backup_published(folder: Path, raw: bytes) -> None:
    """교체 전 공개 표지를 latest-backups 에 남긴다(select_release 와 같은 폴더·이름 규칙 + 고유 접미사)."""
    backups = folder / "latest-backups"
    try:
        backups.mkdir(exist_ok=True)
        if backups.is_symlink() or os.path.isjunction(backups):
            raise ReleasePromoteError("latest-backups 가 링크입니다 — 백업 없이 바꾸지 않습니다", 400)
        name = f"latest.previous-{datetime.now():%Y%m%d-%H%M%S}-{os.urandom(3).hex()}.json"
        with (backups / name).open("xb") as handle:  # 배타 생성(덮어쓰기 없음) — 잠금이 아니라 이름 충돌만 막는다
            handle.write(raw)
    except ReleasePromoteError:
        raise
    except OSError as exc:
        raise _safe_os_error(exc) from exc


def _replace_published(path: Path, new: bytes, old: bytes | None) -> None:
    """같은 폴더 임시 파일 → os.replace. 실패하면 결과를 다시 읽어 셋으로 가른다(Codex r4 P1):
    무변경이면 임시 파일을 지우고 거절, 새 내용이 들어갔으면 성공, 확인할 수 없으면 임시 파일을 남기고 알린다."""
    try:
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix="." + path.name + ".", suffix=".tmp")
    except OSError as exc:
        raise _safe_os_error(exc) from exc
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(new)
            handle.flush()
            os.fsync(handle.fileno())
    except OSError as exc:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise _safe_os_error(exc) from exc
    try:
        os.replace(tmp, path)
        return
    except OSError as exc:
        failure = exc
    try:
        now: bytes | None = path.read_bytes()
    except FileNotFoundError:
        now = None
    except OSError:
        _log.error("Release promote: replace failed and result unreadable (temp kept)")
        raise ReleasePromoteError(
            "공개 표지를 바꾸다 실패했고 결과를 확인할 수 없습니다 — 업데이트 탭을 다시 열어 확인하세요", 500
        ) from failure
    if now == new:
        _log.warning("Release promote: replace reported an error but the new manifest is in place")
        return
    if now == old:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise _safe_os_error(failure) from failure
    _log.error("Release promote: replace failed with unexpected manifest (temp kept)")
    raise ReleasePromoteError(
        "공개 표지가 예상과 다른 상태입니다 — 업데이트 탭을 다시 열어 확인하세요(임시 파일 보존)", 500
    ) from failure


def promote_candidate(expected: dict[str, Any], root: Path = APP_ROOT) -> dict[str, Any]:
    """[공지]한 후보를 공개 표지로 — 후보 원문 바이트를 그대로 latest.json 에 쓴다(B안 r4).

    expected = 서버가 확인해 준 공지 항목(version·file·size·sha256). 느린 zip 검증은 잠금 밖,
    잠금 안에서는 두 표지가 처음 읽은 바이트 그대로인지 재확인 → 백업 → 교체만 한다.
    """
    source = install_source(root)
    if source.lower().startswith(("http://", "https://")):
        raise ReleasePromoteError("HTTP 릴리스 위치에는 배포할 수 없습니다(폴더 경로만 가능합니다)", 400)
    folder = Path(source)
    candidate_path, published_path = folder / "candidate.json", folder / "latest.json"
    cand_raw = _read_manifest_bytes(candidate_path)
    if cand_raw is None:
        raise ReleasePromoteError("릴리스 폴더에 후보가 없습니다")
    try:
        cand = _parse_manifest(cand_raw, "candidate.json")
    except ReleasePromoteError:
        raise
    except ReleaseUpdateError as exc:
        raise ReleasePromoteError(str(exc)) from exc
    if _release_key(cand) != _release_key(expected):
        raise ReleasePromoteError("후보가 바뀌었습니다 — 업데이트 탭을 다시 열어 확인하세요")
    pub_raw = _read_manifest_bytes(published_path)
    if pub_raw is not None:
        try:
            published = _parse_manifest(pub_raw)
        except ReleaseUpdateError as exc:
            # 깨진 공개 표지는 화면에서 '확인 불가'로 막는 상태다 — 여기서도 고쳐 쓰지 않고 명시적 도구에 맡긴다(Codex 코드 리뷰)
            raise ReleasePromoteError("공개 표지(latest.json)가 깨져 있습니다 — select_release 로 먼저 고치세요") from exc
        if published["sha256"] == cand["sha256"]:
            return {"promoted": False, "already": True, "version": cand["version"]}
    _verify_package(folder / cand["file"], cand["size"], cand["sha256"])
    with _release_lock(folder):
        if _read_manifest_bytes(candidate_path) != cand_raw or _read_manifest_bytes(published_path) != pub_raw:
            raise ReleasePromoteError("릴리스 폴더가 그새 바뀌었습니다 — 업데이트 탭을 다시 열어 확인하세요")
        if pub_raw is not None:
            _backup_published(folder, pub_raw)
        _replace_published(published_path, cand_raw, pub_raw)
    return {"promoted": True, "already": False, "version": cand["version"]}


def _base_status(root: Path) -> dict[str, Any]:
    mode = install_mode(root)
    current = _read_version(root)
    if mode != "release":
        message = (
            "공유 서버는 update_git.bat으로 업데이트합니다."
            if mode == "server"
            else "개발/Git 실행본입니다. 릴리스 업데이트 버튼은 작업자 설치본에서만 사용합니다."
        )
        return {
            "state": "unavailable",
            "message": message,
            "install_mode": mode,
            "current_version": current,
            "latest_version": "",
            "can_update": False,
            "updated_at": _utc_now(),
        }
    return {
        "install_mode": mode,
        "current_version": current,
        "latest_version": "",
        "can_update": False,
    }


def _stored_can_update(stored: dict[str, Any]) -> bool:
    state = stored.get("state")
    if state == "available":
        return True
    # 실패 기록도 재시도할 수 있어야 한다 — 단 반쯤 스왑된 트리(recovery_required)는
    # 자동 재시도가 상태를 더 망가뜨릴 수 있어 수동 복구(update.log 확인)를 먼저 요구한다.
    if state == "failed":
        return stored.get("recovery") != "recovery_required"
    return False


def _check_failed(base: dict[str, Any]) -> dict[str, Any]:
    return {
        **base,
        "state": "check_failed",
        "message": _STATE_CHECK_FAILED_MESSAGE,
        "can_update": False,
        "updated_at": _utc_now(),
    }


def _commit_status(
    root: Path,
    base: dict[str, Any],
    build: Callable[[dict[str, Any]], dict[str, Any]],
) -> dict[str, Any]:
    """최종 읽기·보존 판단·쓰기를 start_update와 직렬화한다. 느린 사전 검사는 호출부 몫."""
    acquired = _START_LOCK.acquire(timeout=5.0)
    try:
        kind, stored = _load_state(root)
        if kind in {"unreadable", "invalid"}:
            return _check_failed(base)
        if _active_and_fresh(stored) or stored.get("recovery") == "recovery_required":
            return {**base, **stored, "install_mode": "release", "can_update": False}
        if not acquired:
            # 시작 중인 실행기를 오래 기다리지 않는다. 마지막 상태만 보여주고 쓰기는 하지 않는다.
            if not stored:
                return _check_failed(base)
            return {**base, **stored, "install_mode": "release", "can_update": _stored_can_update(stored)}
        try:
            return build(stored)  # missing은 최초 사용이므로 최초 기록을 허용한다.
        except OSError:
            _log.warning("Update state: write failed")
            return _check_failed(base)
    finally:
        if acquired:
            _START_LOCK.release()


def get_status(*, refresh: bool = False, root: Path = APP_ROOT) -> dict[str, Any]:
    base = _base_status(root)
    if base["install_mode"] != "release":
        return base

    kind, stored = _load_state(root)
    if kind in {"unreadable", "invalid"}:
        return _check_failed(base)
    if str(stored.get("state") or "") in _ACTIVE_STATES:
        if _active_and_fresh(stored):
            return {**base, **stored, "install_mode": "release", "can_update": False}
        stored = _commit_status(
            root, base,
            lambda current_state: write_state(
                "failed",
                "업데이트 상태가 30분 이상 멈췄습니다. 프로그램을 다시 실행한 뒤 재시도하세요.",
                root=root,
                current_version=base["current_version"],
                latest_version=str(current_state.get("latest_version") or ""),
            ),
        )
        if str(stored.get("state") or "") in _ACTIVE_STATES or stored.get("state") == "check_failed":
            return stored

    if stored.get("state") == "failed" and stored.get("recovery") == "recovery_required":
        # 반쯤 스왑된 트리 — 같은 버전 복구(current==latest)든 아니든 refresh 가 지우면
        # 안 된다(코덱스 리뷰: 동버전 repair 실패가 up_to_date 로 둔갑하던 구멍).
        # 해제 경로는 워커 재실행(시작 시 잔재 복원)·강제 업데이트뿐이며, 그때 start 가
        # checking 을 새로 쓴다.
        return {
            **base,
            **stored,
            "install_mode": "release",
            "current_version": _read_version(root),
            "can_update": False,
        }

    if not refresh and stored:
        if stored.get("state") == "up_to_date" and not stored.get("candidate"):
            healthy, reason = _installation_health(root)
            if not healthy:
                latest_version = str(stored.get("latest_version") or _read_version(root))
                current = _read_version(root)
                return _commit_status(
                    root, {**base, "current_version": current, "latest_version": latest_version},
                    lambda _stored: write_state(
                        "available",
                        f"현재 버전 설치가 손상되어 복구가 필요합니다: {reason}",
                        root=root,
                        current_version=current,
                        latest_version=latest_version,
                    ) | {"install_mode": "release", "can_update": True, "repair_required": True},
                )
        return {
            **base,
            **stored,
            "install_mode": "release",
            "current_version": _read_version(root),
            "can_update": _stored_can_update(stored),
        }

    try:
        latest = fetch_latest(root)
    except ReleaseUpdateError as exc:
        if stored.get("state") == "failed":
            # 실패 기록 보존 — 릴리스 서버 확인이 안 된다고 실패 원인이 지워지면 안 된다.
            return {
                **base,
                **stored,
                "install_mode": "release",
                "current_version": _read_version(root),
                "can_update": _stored_can_update(stored),
            }
        return {
            **base,
            "state": "check_failed",
            "message": str(exc),
            "updated_at": _utc_now(),
        }
    current = _read_version(root)
    if stored.get("state") == "failed" and current != latest["version"]:
        # 워커가 남긴 실패 기록은 배경 새로고침(알림센터 60초 주기 refresh=true)이 지우지
        # 않는다 — 사용자가 실패 원인을 봐야 한다. 새 start_update 가 checking 을 쓰거나,
        # 이후 설치가 성공해 current==latest 가 되면(아래 경로) 자연 해제된다.
        # 상태 파일은 재기록하지 않아 워커가 남긴 recovery 필드가 그대로 보존된다.
        return {
            **base,
            **stored,
            "install_mode": "release",
            "current_version": current,
            "latest_version": latest["version"],
            "can_update": _stored_can_update(stored),
        }
    try:
        cand = _installed_candidate(root, current, latest)
    except ReleaseUpdateError as exc:
        return {
            **base, "state": "check_failed", "message": str(exc), "current_version": current,
            "latest_version": latest["version"], "updated_at": _utc_now(),
        }
    if cand is not None:
        # 느린 건강 검사는 잠금 밖에서 먼저 — 잠금 안에서는 다시 읽은 최신 상태를 지키고 기록만 한다(Codex 코드 리뷰).
        verdict = _candidate_verdict(root, cand)

        def _keep_failed_or_candidate(stored_now: dict[str, Any]) -> dict[str, Any]:
            # 후보·건강을 읽는 사이 다른 설치 시도가 남긴 실패는 덮지 않는다(Codex U1 v2 B). 진행 중·복구 필요는
            # _commit_status 가 이미 지킨다.
            if stored_now.get("state") == "failed":
                return {**base, **stored_now, "install_mode": "release", "current_version": current,
                        "can_update": _stored_can_update(stored_now)}
            return _candidate_status(root, cand, current, verdict)

        return _commit_status(
            root, {**base, "current_version": current, "latest_version": cand["version"]}, _keep_failed_or_candidate,
        )
    if current == latest["version"]:
        healthy, reason = _installation_health(root, latest["higgsfield_cli_version"])
        if not healthy:
            return _commit_status(
                root, {**base, "current_version": current, "latest_version": latest["version"]},
                lambda _stored: write_state(
                    "available",
                    f"현재 버전 설치가 손상되어 복구가 필요합니다: {reason}",
                    root=root,
                    current_version=current,
                    latest_version=latest["version"],
                ) | {"install_mode": "release", "can_update": True, "repair_required": True},
            )
        return _commit_status(
            root, {**base, "current_version": current, "latest_version": latest["version"]},
            lambda _stored: write_state(
                "up_to_date",
                "최신 버전입니다.",
                root=root,
                current_version=current,
                latest_version=latest["version"],
            ) | {"install_mode": "release", "can_update": False},
        )
    return _commit_status(
        root, {**base, "current_version": current, "latest_version": latest["version"]},
        lambda _stored: write_state(
            "available",
            f"업데이트 가능: {current or '미확인'} → {latest['version']}",
            root=root,
            current_version=current,
            latest_version=latest["version"],
        ) | {"install_mode": "release", "can_update": True},
    )


def _launch_bootstrap(script: Path, env: dict[str, str], log_path: Path) -> int:
    if os.name != "nt":
        raise ReleaseUpdateError("프로그램 자동 업데이트는 Windows에서만 지원합니다")
    comspec = os.environ.get("ComSpec") or str(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe")
    creationflags = (
        subprocess.CREATE_BREAKAWAY_FROM_JOB
        | subprocess.CREATE_NEW_PROCESS_GROUP
        | subprocess.CREATE_NO_WINDOW
    )
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("ab") as log:
        process = subprocess.Popen(  # noqa: S603 — 설치 폴더의 고정된 안전 실행기만 실행
            [comspec, "/d", "/c", "call", str(script)],
            cwd=str(script.parent),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            close_fds=True,
            creationflags=creationflags,
        )
    return int(process.pid)


def start_update(
    *,
    activity_check: Callable[[], int],
    ready_url: str | None = None,
    root: Path = APP_ROOT,
    force: bool = False,
    manifest: str = "latest.json",
    expected_release: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """업데이트를 단일 실행으로 시작하고 즉시 상태를 반환한다.

    유료 작업 경합을 좁히기 위해 활동 확인 → checking 상태 기록 → latest 확인 → 활동 재확인을
    한 프로세스 락 안에서 수행한다. 생성 라우터도 checking 이후 신규 실행을 거부한다.

    manifest="candidate.json" 은 관리자 후보 선설치(U1) — 서버가 확인한 expected_release 와 한 번 읽은 후보가
    같아야 하고, 워커에는 그 sha·version 을 고정값으로 넘긴다. 공개 표지·공지는 건드리지 않는다.
    """
    with _START_LOCK:
        if install_mode(root) != "release":
            raise ReleaseUpdateError("작업자 릴리스 설치본에서만 자동 업데이트할 수 있습니다")
        if manifest not in _RELEASE_MANIFESTS:
            raise ReleaseUpdateError("지원하지 않는 릴리스 표지입니다")
        candidate_mode = manifest == "candidate.json"
        if candidate_mode and not expected_release:
            raise ReleaseUpdateError("서버가 확인한 후보 정보가 필요합니다")
        kind, stored = _load_state(root)
        # 읽을 수 없는 상태 파일은 **강제로도 뚫지 않는다**. 쓰기 도중인 파일일 수 있고,
        # 그 위에 덮어쓰면 살아 있는 워커의 상태를 파괴한다(test_release_update_state_gate 계약).
        if kind in {"unreadable", "invalid"}:
            raise ReleaseUpdateError(_STATE_CHECK_FAILED_MESSAGE)
        if force:
            if _force_blocked(stored, root):
                raise ReleaseUpdateError(
                    "업데이트를 방금 시작했습니다. 잠시 기다린 뒤 다시 시도하세요"
                )
        elif _active_and_fresh(stored):
            raise ReleaseUpdateError("업데이트가 이미 진행 중입니다")
        if activity_check() > 0:
            raise ReleaseUpdateBusyError("생성 작업이 진행 중입니다. 완료된 뒤 업데이트하세요")

        current = _read_version(root)
        # 반쯤 스왑된 트리(recovery_required)는 버전이 같고 얕은 health 가 통과해도
        # up_to_date 조기 반환으로 워커를 건너뛰면 복구 진입점이 사라진다(코덱스 리뷰).
        # 이때는 무조건 워커를 실행한다 — 워커가 잔재를 격리 보존한 뒤 트리를 재검증하고
        # 필요하면 전체 재설치한다.
        # 강제는 복구와 같은 취급 — 버전이 같고 얕은 검사를 통과해도 워커를 돌려 다시 설치한다.
        # 사람이 강제를 누르는 상황이 바로 '버전은 맞는데 설치가 망가진' 경우다.
        needs_recovery = stored.get("recovery") == "recovery_required" or force
        reinstall = force  # 워커에 '같은 버전이어도 다시 설치'를 알릴지
        try:
            write_state("checking", "최신 릴리스를 다시 확인하는 중…", root=root, current_version=current)
        except OSError as exc:
            # 접수 기록 전 실패: 다운로드/실행도, 같은 파일에 failed 재기록도 하지 않는다.
            raise ReleaseUpdateError(_STATE_WRITE_FAILED_MESSAGE) from exc
        latest_version = ""
        try:
            latest = fetch_latest(root)
            latest_version = latest["version"]
            target = latest
            if candidate_mode:
                # 이 한 번 읽은 후보로 판정하고 워커 고정값도 정한다(두 번 읽는 사이 경합 없음).
                target = fetch_candidate(root)
                if _release_key(target) != _release_key(expected_release or {}):
                    raise ReleaseUpdateError("후보가 바뀌었습니다 — 업데이트 탭을 다시 열어 확인하세요")
                if not _newer_dated(target["version"], latest["version"]):
                    raise ReleaseUpdateError("공개본보다 새 날짜 판인 후보만 이 PC 에 먼저 설치할 수 있습니다")
                latest_version = target["version"]
                # 이미 그 후보면 '다시 설치'(손상 복구) — 같은 버전이어도 워커가 다시 깐다(Codex U1 v2 5-라).
                reinstall = reinstall or current == target["version"]
                needs_recovery = needs_recovery or reinstall
            elif not needs_recovery:
                # 공지 전 후보를 쓰는 PC 의 일반 업데이트는 공개본으로 내려가지 않는다(Codex U1).
                # 강제·복구 필요는 지금처럼 공개본 설치 — 강제 = 명시적 '공개본으로 되돌리기'.
                try:
                    cand = _installed_candidate(root, current, latest)
                except ReleaseUpdateError as exc:
                    write_state("check_failed", str(exc), root=root, current_version=current, latest_version=latest_version)
                    raise _StatusRecorded(str(exc)) from exc
                if cand is not None:
                    status = _candidate_status(root, cand, current)
                    if status["state"] != "up_to_date":  # 손상 후보 — 성공처럼 보이면 안 된다
                        raise _StatusRecorded(status["message"])
                    return status
            if current == target["version"] and not needs_recovery:
                healthy, _reason = _installation_health(root, target["higgsfield_cli_version"])
                if healthy:
                    try:
                        return write_state(
                            "up_to_date",
                            "이 PC 에 이미 이 후보가 설치돼 있습니다." if candidate_mode else "이미 최신 버전입니다.",
                            root=root,
                            current_version=current,
                            latest_version=target["version"],
                            candidate=candidate_mode,
                        ) | {"install_mode": "release", "can_update": False}
                    except OSError as exc:
                        raise ReleaseUpdateError(_STATE_WRITE_FAILED_MESSAGE) from exc
            if activity_check() > 0:
                raise ReleaseUpdateBusyError("확인 중 생성 작업이 시작됐습니다. 완료된 뒤 다시 시도하세요")

            launcher = root / "update_release.bat"
            status_file = state_path(root)
            env = os.environ.copy()
            # 현재 백엔드는 guarded MV_agent의 내부 세션이라 이 표식이 1이다. 새 런처가
            # 그대로 물려받으면 Job Object 보호를 건너뛰므로, 재실행은 반드시 바깥 진입부터 시작한다.
            env.pop("MVHUB_SESSION_GUARDED", None)
            # 후보 고정값은 매번 새로 정한다 — 부모 환경에 남은 값이 일반 업데이트로 새지 않게(Codex U1).
            env.pop("MVHUB_UPDATE_EXPECT_SHA256", None)
            env.pop("MVHUB_UPDATE_EXPECT_VERSION", None)
            env["MVHUB_UPDATE_MANIFEST"] = manifest
            if candidate_mode:
                env["MVHUB_UPDATE_EXPECT_SHA256"] = target["sha256"]
                env["MVHUB_UPDATE_EXPECT_VERSION"] = target["version"]
            env.update(
                {
                    "MVHUB_NO_PAUSE": "1",
                    "MVHUB_UPDATE_TARGET_DIR": str(root),
                    "MVHUB_UPDATE_STATE_FILE": str(status_file),
                    "MVHUB_UPDATE_RESTART": "1",
                    "MVHUB_UPDATE_READY_URL": ready_url or f"http://127.0.0.1:{PORT}/api/ready",
                    # 워커도 강제를 알아야 한다 — 모르면 버전이 같을 때 설치를 건너뛰어
                    # '강제 업데이트'가 아무 일도 하지 않는다(Codex 지적, 2026-09-28).
                    "MVHUB_UPDATE_FORCE": "1" if reinstall else "0",
                }
            )
            try:
                starting = write_state(
                    "starting",
                    "업데이트 실행기를 준비했습니다. 잠시 후 프로그램이 다시 시작됩니다.",
                    root=root,
                    current_version=current,
                    latest_version=target["version"],
                )
            except OSError as exc:
                raise ReleaseUpdateError(_STATE_WRITE_FAILED_MESSAGE) from exc
            _launch_bootstrap(launcher, env, UPDATE_STATE_BASE / "update.log")
            kind, stored = _load_state(root)
            return {
                **(stored if kind == "ok" else starting),
                "install_mode": "release",
                "can_update": False,
                "accepted": True,
            }
        except ReleaseUpdateBusyError:
            try:
                write_state(
                    "available",
                    "생성 작업 완료 후 업데이트할 수 있습니다.",
                    root=root,
                    current_version=current,
                    latest_version=latest_version,
                )
            except OSError:
                _log.warning("Update state: busy status write failed")
            raise
        except _StatusRecorded:
            raise  # 상태는 이미 기록했다(check_failed 등) — failed 로 덮지 않는다
        except Exception as exc:
            message = str(exc) if isinstance(exc, ReleaseUpdateError) else "업데이트를 시작하지 못했습니다. 잠시 뒤 다시 시도하세요"
            try:
                write_state(
                    "failed",
                    message,
                    root=root,
                    current_version=current,
                    latest_version=latest_version,
                )
            except OSError:
                _log.warning("Update state: failure status write failed")
            if isinstance(exc, ReleaseUpdateError):
                raise
            raise ReleaseUpdateError(message) from exc
