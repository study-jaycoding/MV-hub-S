"""작업자 릴리스 설치본의 안전한 자기 업데이트 상태와 실행기.

공유 서버의 ``update_git.bat``과 역할을 섞지 않는다. 이 모듈은 작업자 PC에
``MVHub_Install.bat``으로 설치된 릴리스만 다루며, 신뢰된 ``INSTALL_SOURCE.txt``의
``latest.json``을 읽어 이미 설치된 안전 실행기로 격리된 업데이트 작업을 시작한다.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from ..config import AUTH_ENABLED, BACKEND_DIR, PORT
from .atomic_io import atomic_write_text

APP_ROOT = BACKEND_DIR.parent
UPDATE_STATE_BASE = Path(
    os.environ.get(
        "MVHUB_UPDATE_STATE_DIR",
        str(Path(os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()) / "MVHub" / "updates"),
    )
)

_ACTIVE_STATES = frozenset({"starting", "checking", "downloading", "installing", "restarting"})
_STATE_STALE_SECONDS = 30 * 60
_SHA256_RE = re.compile(r"[0-9a-fA-F]{64}")
_START_LOCK = threading.Lock()
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


class ReleaseUpdateBusyError(ReleaseUpdateError):
    """유료 생성 또는 Comfy 실행이 남아 업데이트를 시작할 수 없음."""


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
        pin = pin_path.read_text("utf-8-sig").strip()
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


def _read_state(root: Path = APP_ROOT) -> dict[str, Any]:
    path = state_path(root)
    try:
        value = json.loads(path.read_text("utf-8-sig"))
    except (OSError, ValueError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def write_state(
    state: str,
    message: str,
    *,
    root: Path = APP_ROOT,
    latest_version: str = "",
    current_version: str | None = None,
) -> dict[str, Any]:
    payload = {
        "state": state,
        "message": message,
        "current_version": _read_version(root) if current_version is None else current_version,
        "latest_version": latest_version,
        "updated_at": _utc_now(),
    }
    atomic_write_text(
        state_path(root),
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
    )
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


def update_in_progress(root: Path = APP_ROOT) -> bool:
    value = _read_state(root)
    age = _state_age_seconds(value)
    return bool(
        value.get("state") in _ACTIVE_STATES
        and age is not None
        and age < _STATE_STALE_SECONDS
    )


def _install_source(root: Path) -> str:
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
    except OSError as exc:
        raise ReleaseUpdateError(f"릴리스 파일을 읽을 수 없습니다: {path}") from exc


def fetch_latest(root: Path = APP_ROOT) -> dict[str, Any]:
    source = _install_source(root)
    try:
        latest = json.loads(_read_release_file(source, "latest.json", max_bytes=1024 * 1024).decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError, TypeError) as exc:
        raise ReleaseUpdateError("latest.json 형식이 올바르지 않습니다") from exc
    if not isinstance(latest, dict):
        raise ReleaseUpdateError("latest.json 형식이 올바르지 않습니다")
    version = str(latest.get("version") or "").strip()
    filename = _safe_release_name(latest.get("file"))
    digest = str(latest.get("sha256") or "").strip().lower()
    if not version or not _SHA256_RE.fullmatch(digest):
        raise ReleaseUpdateError("latest.json에 version, file, sha256이 필요합니다")
    return {
        "version": version,
        "file": filename,
        "sha256": digest,
        "higgsfield_cli_version": str(latest.get("higgsfield_cli_version") or "").strip(),
        "source": source,
    }


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


def get_status(*, refresh: bool = False, root: Path = APP_ROOT) -> dict[str, Any]:
    base = _base_status(root)
    if base["install_mode"] != "release":
        return base

    stored = _read_state(root)
    if stored.get("state") in _ACTIVE_STATES:
        age = _state_age_seconds(stored)
        if age is not None and age < _STATE_STALE_SECONDS:
            return {**base, **stored, "install_mode": "release", "can_update": False}
        stored = write_state(
            "failed",
            "업데이트 상태가 30분 이상 멈췄습니다. 프로그램을 다시 실행한 뒤 재시도하세요.",
            root=root,
            latest_version=str(stored.get("latest_version") or ""),
        )

    if not refresh and stored:
        if stored.get("state") == "up_to_date":
            healthy, reason = _installation_health(root)
            if not healthy:
                latest_version = str(stored.get("latest_version") or _read_version(root))
                return write_state(
                    "available",
                    f"현재 버전 설치가 손상되어 복구가 필요합니다: {reason}",
                    root=root,
                    latest_version=latest_version,
                ) | {"install_mode": "release", "can_update": True, "repair_required": True}
        return {
            **base,
            **stored,
            "install_mode": "release",
            "current_version": _read_version(root),
            "can_update": stored.get("state") == "available",
        }

    try:
        latest = fetch_latest(root)
    except ReleaseUpdateError as exc:
        return {
            **base,
            "state": "check_failed",
            "message": str(exc),
            "updated_at": _utc_now(),
        }
    current = _read_version(root)
    if current == latest["version"]:
        healthy, reason = _installation_health(root, latest["higgsfield_cli_version"])
        if not healthy:
            return write_state(
                "available",
                f"현재 버전 설치가 손상되어 복구가 필요합니다: {reason}",
                root=root,
                current_version=current,
                latest_version=latest["version"],
            ) | {"install_mode": "release", "can_update": True, "repair_required": True}
        return write_state(
            "up_to_date",
            "최신 버전입니다.",
            root=root,
            current_version=current,
            latest_version=latest["version"],
        ) | {"install_mode": "release", "can_update": False}
    return write_state(
        "available",
        f"업데이트 가능: {current or '미확인'} → {latest['version']}",
        root=root,
        current_version=current,
        latest_version=latest["version"],
    ) | {"install_mode": "release", "can_update": True}


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
) -> dict[str, Any]:
    """업데이트를 단일 실행으로 시작하고 즉시 상태를 반환한다.

    유료 작업 경합을 좁히기 위해 활동 확인 → checking 상태 기록 → latest 확인 → 활동 재확인을
    한 프로세스 락 안에서 수행한다. 생성 라우터도 checking 이후 신규 실행을 거부한다.
    """
    with _START_LOCK:
        if install_mode(root) != "release":
            raise ReleaseUpdateError("작업자 릴리스 설치본에서만 자동 업데이트할 수 있습니다")
        if update_in_progress(root):
            raise ReleaseUpdateError("업데이트가 이미 진행 중입니다")
        if activity_check() > 0:
            raise ReleaseUpdateBusyError("생성 작업이 진행 중입니다. 완료된 뒤 업데이트하세요")

        current = _read_version(root)
        write_state("checking", "최신 릴리스를 다시 확인하는 중…", root=root, current_version=current)
        latest_version = ""
        try:
            latest = fetch_latest(root)
            latest_version = latest["version"]
            if current == latest["version"]:
                healthy, _reason = _installation_health(root, latest["higgsfield_cli_version"])
                if healthy:
                    return write_state(
                        "up_to_date",
                        "이미 최신 버전입니다.",
                        root=root,
                        current_version=current,
                        latest_version=latest["version"],
                    ) | {"install_mode": "release", "can_update": False}
            if activity_check() > 0:
                raise ReleaseUpdateBusyError("확인 중 생성 작업이 시작됐습니다. 완료된 뒤 다시 시도하세요")

            launcher = root / "update_release.bat"
            status_file = state_path(root)
            env = os.environ.copy()
            # 현재 백엔드는 guarded MV_agent의 내부 세션이라 이 표식이 1이다. 새 런처가
            # 그대로 물려받으면 Job Object 보호를 건너뛰므로, 재실행은 반드시 바깥 진입부터 시작한다.
            env.pop("MVHUB_SESSION_GUARDED", None)
            env.update(
                {
                    "MVHUB_NO_PAUSE": "1",
                    "MVHUB_UPDATE_TARGET_DIR": str(root),
                    "MVHUB_UPDATE_STATE_FILE": str(status_file),
                    "MVHUB_UPDATE_RESTART": "1",
                    "MVHUB_UPDATE_READY_URL": ready_url or f"http://127.0.0.1:{PORT}/api/ready",
                }
            )
            write_state(
                "starting",
                "업데이트 실행기를 준비했습니다. 잠시 후 프로그램이 다시 시작됩니다.",
                root=root,
                current_version=current,
                latest_version=latest["version"],
            )
            _launch_bootstrap(launcher, env, UPDATE_STATE_BASE / "update.log")
            return {
                **_read_state(root),
                "install_mode": "release",
                "can_update": False,
                "accepted": True,
            }
        except ReleaseUpdateBusyError:
            write_state(
                "available",
                "생성 작업 완료 후 업데이트할 수 있습니다.",
                root=root,
                current_version=current,
                latest_version=latest_version,
            )
            raise
        except Exception as exc:
            message = str(exc) if isinstance(exc, ReleaseUpdateError) else f"업데이트를 시작하지 못했습니다: {exc}"
            write_state(
                "failed",
                message,
                root=root,
                current_version=current,
                latest_version=latest_version,
            )
            if isinstance(exc, ReleaseUpdateError):
                raise
            raise ReleaseUpdateError(message) from exc
