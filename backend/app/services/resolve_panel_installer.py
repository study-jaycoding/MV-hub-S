"""Resolve 패널 파일만 설치한다 — OS 잠금과 복구 기록으로 중단된 교체를 되돌린다."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import platform
import re
import shutil
import threading
import uuid
import xml.etree.ElementTree as ET
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from .. import config
from . import release_update

PLUGIN_ID = "com.mvhub.resolve"
RESOLVE_PANEL_RELEASE_ENABLED = True  # Jay 가 실제 Resolve 실사용으로 확인하고 켬(2026-11-17) — 문제가 나면 False 로.
RELEASE_DISABLED_REASON = "실제 Resolve 실측 전이므로 이 릴리스에서 패널이 꺼져 있습니다"
SUPPORT = Path("Blackmagic Design/DaVinci Resolve/Support")
log = logging.getLogger(__name__)


class ResolvePanelInstallError(RuntimeError):
    """설정 화면에 경로와 함께 알릴 설치 오류."""


class InstallBusy(ResolvePanelInstallError):
    pass


def release_disabled() -> bool:
    return not RESOLVE_PANEL_RELEASE_ENABLED and release_update.install_mode() == "release"


def bundled_plugin_path() -> Path:
    return Path(__file__).resolve().parents[1] / "resources/resolve_panel" / PLUGIN_ID


def _root(value, env: str) -> Path:
    raw = value if value is not None else os.environ.get(env)
    if not raw:
        raise ResolvePanelInstallError(f"{env} 폴더를 찾을 수 없습니다")
    return Path(raw).resolve()


def hub_origin(value: str) -> str | None:
    if not isinstance(value, str) or not re.fullmatch(r"http://(127\.0\.0\.1|localhost):[0-9]+/?", value, re.I):
        return None
    try:
        url = urlsplit(value)
        if not url.port or url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
            return None
        return f"http://{url.hostname}" + (f":{url.port}" if url.port != 80 else "")
    except ValueError:
        return None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def write_hub_json(url: str, localappdata=None) -> dict:
    origin = hub_origin(url)
    if origin is None:
        raise ResolvePanelInstallError("로컬 HTTP 주소와 포트만 사용할 수 있습니다")
    # 포트 80도 다음 독자가 명시된 포트로 검사할 수 있게 그대로 기록한다.
    payload = {"url": origin if urlsplit(origin).port else origin + ":80", "written_at": _now()}
    _atomic_json(_root(localappdata, "LOCALAPPDATA") / "MVHub/resolve-panel/hub.json", payload)
    return payload


def tree_sha(path: Path) -> dict[str, str] | None:
    if not path.exists():
        return None
    if not path.is_dir() or path.is_symlink():
        raise ResolvePanelInstallError(f"플러그인 폴더가 아닙니다: {path}")
    result = {}
    for file in sorted(path.rglob("*")):
        if file.is_symlink():
            raise ResolvePanelInstallError(f"연결 파일은 설치하지 않습니다: {file}")
        if file.is_file():
            result[file.relative_to(path).as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()
    return result


def version(value: str | None) -> tuple[int, ...] | None:
    if not value or not re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", value):
        return None
    parts = [int(part) for part in value.split(".")]
    while len(parts) > 1 and parts[-1] == 0:
        parts.pop()
    return tuple(parts)


def _manifest(path: Path) -> tuple[str | None, str | None]:
    try:
        root = ET.parse(path / "manifest.xml").getroot()
        return root.findtext(".//Id"), root.findtext(".//Version")
    except (OSError, ET.ParseError):
        return None, None


@contextmanager
def install_lock(work: Path):
    work.mkdir(parents=True, exist_ok=True)
    stream = (work / "install.lock").open("a+b")
    locked = False
    try:
        stream.seek(0, 2)
        if stream.tell() == 0:
            stream.write(b"0"); stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
        except OSError as exc:
            raise InstallBusy("다른 설치가 진행 중") from exc
        yield
    finally:
        if locked:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        stream.close()


def _owned(path: Path, parent: Path) -> Path:
    resolved = path.resolve()
    if resolved.parent != parent.resolve() or not re.fullmatch(r"[0-9a-f]{32}", resolved.name) or path.is_symlink():
        raise ResolvePanelInstallError(f"작업 경로를 확인할 수 없습니다: {path}")
    return resolved


def _remove(path: Path, parent: Path) -> None:
    checked = _owned(path, parent)
    if checked.exists():
        shutil.rmtree(checked)


def _displace(target: Path, work: Path, preserved: set[Path]) -> None:
    if target.exists():
        backup = work / "backup" / uuid.uuid4().hex
        backup.parent.mkdir(parents=True, exist_ok=True)
        os.replace(target, backup)
        preserved.add(backup)


def _last(work: Path) -> dict:
    try:
        value = json.loads((work / "last_result.json").read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _remember(work: Path, state: str, reason="", *, changed=False) -> dict:
    previous = _last(work)
    result = {"last_attempt": {"at": _now(), "state": state, "reason": reason},
              "changed_at": _now() if changed else previous.get("changed_at")}
    _atomic_json(work / "last_result.json", result)
    return result


def _trim_backups(work: Path, keep: Path, preserved: set[Path]) -> None:
    paths = sorted((work / "backup").glob("*"), key=lambda path: path.stat().st_mtime_ns, reverse=True)
    # 폴더를 옮기면 옛 수정 시각이 남는다 — 방금 보존한 사본을 시각 순위로 지우지 않는다.
    retained = keep if keep.exists() else (paths[0] if paths else None)
    for path in paths:
        if path != retained and path not in preserved:
            _remove(path, work / "backup")


def _recover(target: Path, work: Path, preserved: set[Path]) -> bool:
    journal = work / "journal.json"
    if not journal.exists():
        return False
    try:
        record = json.loads(journal.read_text(encoding="utf-8"))
        staging = _owned(Path(record["staging"]), work / "staging")
        backup = _owned(Path(record["backup"]), work / "backup")
        before, expected = record["before"], record["expected"]
        had_install = record["had_install"]
        if not isinstance(had_install, bool) or not isinstance(expected, dict) or not expected or (had_install and not isinstance(before, dict)) or (not had_install and before is not None):
            raise ValueError("복구 기록 모양이 다릅니다")
        current = tree_sha(target)
        changed = current == expected
        if changed:
            _remember(work, "up_to_date", changed=True)
        elif had_install and current == before:
            pass
        elif had_install:
            # 보존본이 있다는 이유만으로 덮지 않는다 — 작업 전 SHA와 맞는 사본만 복원한다.
            if tree_sha(backup) != before:
                raise ResolvePanelInstallError("작업 전 설치와 같은 보존본이 없습니다")
            _displace(target, work, preserved)
            os.replace(backup, target)
            if tree_sha(target) != before:
                raise ResolvePanelInstallError("되돌린 설치를 확인하지 못했습니다")
        else:
            _displace(target, work, preserved)
        _remove(staging, work / "staging")
        journal.unlink()
        if changed:
            _trim_backups(work, backup, preserved)
        return changed
    except Exception as exc:
        raise ResolvePanelInstallError(f"복구 기록·보존본을 확인하세요: {journal} / {work / 'backup'} — {exc}") from exc


def _status(target: Path, source: Path) -> dict:
    _, bundled = _manifest(source)
    ident, installed = _manifest(target)
    state = "not_installed"
    if target.exists():
        if ident != PLUGIN_ID:
            state = "foreign"
        elif version(installed) is None:
            state = "damaged"
        elif tree_sha(target) == tree_sha(source):
            state = "up_to_date"
        elif version(installed) > (version(bundled) or ()):
            state = "newer_installed"
        elif version(installed) == version(bundled):
            state = "damaged"
        else:
            state = "outdated"
    return {"state": state, "path": str(target), "installed_version": installed, "bundled_version": bundled}


def _probe_write(parent: Path) -> None:
    parent.mkdir(parents=True, exist_ok=True)
    probe = parent / f".{uuid.uuid4().hex}.probe"
    try:
        probe.write_bytes(b"")
    finally:
        probe.unlink(missing_ok=True)


def _failure(exc: Exception, target: Path, work: Path) -> tuple[str, str]:
    if getattr(exc, "winerror", None) in (32, 33):
        return "deferred", f"파일이 쓰이는 중입니다 — 다음 시작 때 다시 시도합니다: {target}"
    if isinstance(exc, PermissionError) or getattr(exc, "winerror", None) == 5:
        try:
            _probe_write(target.parent); _probe_write(work)
        except OSError:
            return "permission_denied", f"이 PC의 관리자가 리졸브 플러그인 폴더 권한을 열어야 합니다: {target}"
        return "deferred", f"파일이 쓰이는 중이거나 플러그인 폴더 권한 문제입니다 — 리졸브를 끈 뒤 다음 시작 때 다시 시도합니다. 계속 실패하면 폴더 권한을 확인하세요: {target}"
    return "damaged", str(exc)


def _run(*, install=False, automatic=False, programdata=None, source_path=None) -> dict:
    root = _root(programdata, "PROGRAMDATA")
    support = root / SUPPORT
    target = support / "Workflow Integration Plugins" / PLUGIN_ID
    work = root / "MVHub/resolve-panel"
    source = Path(source_path) if source_path is not None else bundled_plugin_path()
    base = {"path": str(target), "backup_path": str(work / "backup"), "journal_path": str(work / "journal.json")}
    if not support.is_dir():
        return {**base, "state": "no_resolve"}
    try:
        with install_lock(work):
            # 이번 복구에서 비킨 폴더는 사람이 넣은 것일 수 있어 다음 설치까지 남긴다.
            preserved: set[Path] = set()
            try:
                _recover(target, work, preserved)
            except ResolvePanelInstallError as exc:
                return {**base, **_last(work), "state": "damaged", "reason": str(exc)}
            try:
                status = _status(target, source)
                if install and status["state"] not in {"foreign", "up_to_date"} and not (automatic and status["state"] == "newer_installed"):
                    if _manifest(source)[0] != PLUGIN_ID or version(_manifest(source)[1]) is None:
                        raise ResolvePanelInstallError("묶음 manifest를 읽을 수 없습니다")
                    staging = work / "staging" / uuid.uuid4().hex
                    backup = work / "backup" / uuid.uuid4().hex
                    expected = tree_sha(source)
                    staging.parent.mkdir(parents=True, exist_ok=True)
                    backup.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copytree(source, staging)
                    if tree_sha(staging) != expected:
                        raise ResolvePanelInstallError("임시본 SHA가 묶음과 다릅니다")
                    before = tree_sha(target)
                    _atomic_json(work / "journal.json", {"staging": str(staging), "backup": str(backup), "had_install": target.exists(), "before": before, "expected": expected})
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if target.exists():
                        os.replace(target, backup)
                    os.replace(staging, target)
                    if tree_sha(target) != expected:
                        raise ResolvePanelInstallError("설치본 SHA가 묶음과 다릅니다")
                    _remember(work, "up_to_date", changed=True)
                    (work / "journal.json").unlink()
                    _trim_backups(work, backup, preserved)
                    status = _status(target, source)
                elif install:
                    _remember(work, status["state"])
                return {**base, **status, **_last(work)}
            except Exception as exc:
                state, reason = _failure(exc, target, work)
                try:
                    _recover(target, work, preserved)
                except ResolvePanelInstallError as recovery:
                    state, reason = "damaged", str(recovery)
                result = {**base, "state": state, "reason": reason}
                try:
                    result.update(_remember(work, state, reason))
                except OSError:
                    pass
                return result
    except InstallBusy:
        return {**base, "state": "busy"}
    except OSError as exc:
        state, reason = _failure(exc, target, work)
        return {**base, "state": state, "reason": reason}


def resolve_panel_plugin_status(*, programdata=None, source_path=None) -> dict:
    if release_disabled():
        return {"state": "release_disabled", "path": "", "reason": RELEASE_DISABLED_REASON}
    return _run(programdata=programdata, source_path=source_path)


def install_resolve_panel_plugin(*, automatic=False, programdata=None, source_path=None) -> dict:
    if release_disabled():
        return resolve_panel_plugin_status()
    return _run(install=True, automatic=automatic, programdata=programdata, source_path=source_path)


def run_startup_install(*, programdata=None, localappdata=None) -> None:
    try:
        if (release_disabled() or platform.system() != "Windows" or config.AUTH_ENABLED or release_update.install_mode() != "release"
                or "CONTENT_HUB_DATA" in os.environ or "CONTENT_HUB_DB" in os.environ or config.PORT != 8010):
            return
        write_hub_json("http://127.0.0.1:8010", localappdata)
        install_resolve_panel_plugin(automatic=True, programdata=programdata)
    except Exception:
        log.exception("리졸브 패널 자동 설치를 다음 시작으로 미룹니다")


def start_background_install() -> None:
    try:
        if release_disabled():
            return
        threading.Thread(target=run_startup_install, name="resolve-panel-install", daemon=True).start()
    except Exception:
        log.exception("리졸브 패널 설치 스레드를 시작하지 못했습니다")
