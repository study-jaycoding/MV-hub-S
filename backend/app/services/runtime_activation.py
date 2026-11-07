"""Local coordinator admission gate. It cannot prevent startup/background DB writes."""
from __future__ import annotations

import json
import os
from pathlib import Path
import threading

from . import release_contract

_ROOT = Path(__file__).resolve().parents[3]
_LOCK = threading.Lock()
_ACTIVE = 0


def _read(path: Path) -> dict:
    if path.stat().st_size > release_contract.MAX_JSON:
        raise ValueError("activation_record_too_large")
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError("activation_record_invalid")
    return value


_MEMO: tuple | None = None  # (환경값, 저널 경로, 사슬 표식, 판정) — normal·activated 만


def _chain(path: Path, root: Path) -> tuple:
    """경로에서 활성화 루트까지(포함) 각 경로의 lstat 표식 — 전체 검사가 보는 조상 범위와 같다."""
    out = []
    for ancestor in (path, *path.parents):
        st = os.lstat(ancestor)
        out.append((str(ancestor), st.st_ino, st.st_dev, st.st_mtime_ns, st.st_size, st.st_mode,
                    getattr(st, "st_file_attributes", 0)))
        if ancestor == root:
            break
    return tuple(out)


def admission_state() -> str:
    """모든 HTTP 요청이 부른다 — 활성화 파일·조상 사슬이 그대로면 전체 검사(JSON 두 개 읽기)를 다시 하지 않는다.

    요청마다 이벤트 루프에서 경로 검사와 JSON 읽기를 했다(2026-11-07 2-10). normal·activated 만 기억하고 blocked 는
    매번 전체 검사한다. 기억은 '표식 → 전체 검사 → 표식'이 같을 때만 남긴다 — 검사 중 교체된 파일에 옛 판정을 붙이지
    않는다. 조상 폴더를 연결점으로 바꿔치면 그 조상의 lstat 이 달라져 전체 검사로 간다."""
    global _MEMO
    control = os.environ.get("MVHUB_ACTIVATION_CONTROL", "")
    if not control:
        return "normal"
    env = (control, os.environ.get("MVHUB_ACTIVATION_ROOT", ""), os.environ.get("MVHUB_EXECUTION_NONCE", ""))
    memo = _MEMO
    if memo is not None and memo[0] == env:
        try:
            if _chains(env, memo[1]) == memo[2]:
                return memo[3]
        except (OSError, ValueError):
            pass
    result, journal = _admission_full()
    if result == "blocked":
        return result
    try:
        before = _chains(env, journal)
        again, journal_again = _admission_full()
        if again == result and journal_again == journal and _chains(env, journal) == before:
            _MEMO = (env, journal, before, result)
        result = again  # 더 늦게 본 판정 — 그사이 막혔으면 막힘을 돌려준다
    except (OSError, ValueError):
        pass
    return result


def _chains(env: tuple, journal: Path | None) -> tuple:
    root = Path(env[1])
    chains = [_chain(Path(env[0]), root)]
    if journal is not None:
        chains.append(_chain(journal, root))
    return tuple(chains)


def _admission_full() -> tuple[str, Path | None]:
    """전체 검사 — (판정, activated 면 저널 경로)."""
    control = os.environ.get("MVHUB_ACTIVATION_CONTROL", "")
    if not control:
        return "normal", None
    try:
        root = Path(os.environ["MVHUB_ACTIVATION_ROOT"])
        path = Path(control)
        if not root.is_absolute() or not path.is_absolute() or str(root).startswith("\\\\"):
            return "blocked", None
        path.resolve().relative_to(root.resolve())
        for ancestor in (path, *path.parents):
            if ancestor.is_symlink() or bool(getattr(ancestor.stat(), "st_file_attributes", 0) & 1024):
                return "blocked", None
            if ancestor == root:
                break
        value = _read(path)
        nonce = os.environ["MVHUB_EXECUTION_NONCE"]
        if value.get("format_version") != 1 or value.get("execution_nonce") != nonce:
            return "blocked", None
        if value.get("state") == "normal":
            return "normal", None
        if value.get("state") != "activated":
            return "blocked", None
        journal_path = Path(value["journal"])
        if not journal_path.is_absolute():
            return "blocked", None
        journal_path.resolve().relative_to(root.resolve())
        for ancestor in (journal_path, *journal_path.parents):
            if ancestor.is_symlink() or bool(getattr(ancestor.stat(), 'st_file_attributes', 0) & 1024):
                return 'blocked', None
            if ancestor == root:
                break
        journal = _read(journal_path)
        if (journal.get("run_id") != value.get("run_id") or journal.get("execution_nonce") != nonce or
                journal.get("phase") not in {"ready", "committed"} or
                journal.get("business_writes_possible") is not True or journal.get("db_mutation_possible") is not True):
            return "blocked", None
        return "activated", journal_path
    except (OSError, ValueError, KeyError, TypeError):
        return "blocked", None


def runtime_identity() -> dict:
    try:
        descriptor = _read(_ROOT / "build-manifest.json")
        build_id = str(descriptor.get("build_id") or "")
    except (OSError, ValueError):
        build_id = os.environ.get("MVHUB_BUILD_ID", "")
    with _LOCK:
        active = _ACTIVE
    return {"process_id": os.getpid(), "execution_nonce": os.environ.get("MVHUB_EXECUTION_NONCE", ""),
            "build_id": build_id, "role": os.environ.get("MVHUB_PROCESS_ROLE", "unknown"),
            "admission": admission_state(), "active_http": active}


class ActivationAdmissionMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        global _ACTIVE
        kind = scope["type"]
        if kind not in {"http", "websocket"} or scope.get("path") in {"/api/ready", "/api/health"}:
            return await self.app(scope, receive, send)
        with _LOCK:
            blocked = admission_state() == "blocked"
            if not blocked and kind == "http":
                _ACTIVE += 1
        if blocked:
            if kind == "websocket":
                await send({"type": "websocket.close", "code": 1013})
            else:
                await send({"type": "http.response.start", "status": 503, "headers": [(b"retry-after", b"5")]})
                await send({"type": "http.response.body", "body": b"Activation pending"})
            return
        try:
            await self.app(scope, receive, send)
        finally:
            if kind == "http":
                with _LOCK:
                    _ACTIVE -= 1
