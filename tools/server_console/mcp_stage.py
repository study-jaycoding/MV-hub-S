"""MCP만 Git에서 꺼내 별도 게시한다. 후보 코드는 읽기만 하고 실행하지 않는다."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import re
import subprocess

from . import release
from .console_stage import UpdateLock
from .install import CREATE_NO_WINDOW, Installation, child_env, trusted_git

_SHA = re.compile(r"^[0-9a-f]{40}$")
_FILES = ("server.py", "local_setup.py", "update.py", "requirements.lock.txt")
_PREFIX = "tools/mcp_adapter/"
_MAX_FILE = 2 * 1024 * 1024


class McpStageError(ValueError):
    pass


def updater(inst: Installation):
    # 관리 창은 stage에서 실행돼도 고정 설치본의 실행기 계약을 쓴다.
    path = inst.root / "tools" / "mcp_adapter" / "update.py"
    spec = importlib.util.spec_from_file_location("mvhub_mcp_update", path)
    if spec is None or spec.loader is None or not path.is_file():
        raise McpStageError("MCP 독립 업데이트를 도입한 본체로 먼저 업데이트하세요")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _git(inst: Installation, args: list[str], timeout: int = 30) -> bytes:
    git = trusted_git()
    if git is None:
        raise McpStageError("서버에 설치된 Git을 찾지 못했습니다")
    try:
        result = subprocess.run(
            [str(git), "-C", str(inst.root), "-c", "core.quotepath=off", *args],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=timeout, env=child_env(inst), creationflags=CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise McpStageError("MCP Git 작업에 연결하지 못했거나 시간이 초과됐습니다") from exc
    if result.returncode:
        # Git 오류에 원격 주소/자격 증명이 들어올 수 있어 본문을 노출하지 않는다.
        raise McpStageError(f"MCP Git {args[0]} 실패 — 저장소와 main 접근 권한을 확인하세요")
    return result.stdout


def _sha(value: str) -> str:
    if not isinstance(value, str) or not _SHA.fullmatch(value):
        raise McpStageError("고정된 40자리 main 커밋이 필요합니다")
    return value


def stage_root(inst: Installation) -> Path:
    return inst.logs / "mcp-versions"


def latest(inst: Installation) -> str:
    """원격 추적 참조만 갱신한다. 서버 HEAD/작업 트리는 그대로 둔다."""
    with UpdateLock(inst):
        _git(inst, ["fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"], 180)
        return _sha(_git(inst, ["rev-parse", "refs/remotes/origin/main"]).decode("ascii").strip())


def _blobs(inst: Installation, commit: str) -> dict[str, bytes]:
    _sha(commit)
    _git(inst, ["merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"])
    raw = _git(inst, ["ls-tree", "-r", "-z", "-l", commit, "--", *(_PREFIX + name for name in _FILES)])
    entries = {}
    for record in raw.split(b"\0"):
        if not record:
            continue
        try:
            metadata, raw_name = record.split(b"\t", 1)
            mode, kind, object_id, size = metadata.split()
            name = raw_name.decode("utf-8")
            length = int(size)
        except (ValueError, UnicodeError) as exc:
            raise McpStageError("Git 파일 목록 형식이 올바르지 않습니다") from exc
        if (name not in {_PREFIX + value for value in _FILES} or mode not in (b"100644", b"100755")
                or kind != b"blob" or not _SHA.fullmatch(object_id.decode("ascii", errors="replace"))
                or not 0 < length <= _MAX_FILE or name in entries):
            raise McpStageError("MCP 후보에 링크·허용 밖 파일 또는 잘못된 크기가 있습니다")
        entries[name] = (object_id.decode("ascii"), length)
    if set(entries) != {_PREFIX + name for name in _FILES}:
        raise McpStageError("이 커밋은 MCP 독립 업데이트에 필요한 파일이 없습니다 — 본체 도입 커밋 이후를 고르세요")
    files = {}
    for name in _FILES:
        object_id, length = entries[_PREFIX + name]
        content = _git(inst, ["cat-file", "blob", object_id])
        if len(content) != length:
            raise McpStageError("Git 파일 크기가 목록과 다릅니다")
        files[name] = content
    return files


def bring_candidate(inst: Installation, commit: str) -> dict:
    with UpdateLock(inst):
        module = updater(inst)
        files = _blobs(inst, commit)
        manifest = module.build_manifest(commit, files["server.py"], files)
        module.stage_version(stage_root(inst), manifest, {"server.py": files["server.py"]})
        return manifest


def destination(inst: Installation) -> Path:
    source = release.release_source(inst)
    problem = release.source_problem(source)
    if problem:
        raise McpStageError(problem)
    return Path(source) / "mcp"


def view(inst: Installation) -> dict:
    module = updater(inst)
    base = stage_root(inst)
    result = {"rows": [], "source": "", "token": None, "current": None, "previous": None, "error": ""}
    try:
        target = destination(inst)
        result["source"] = str(target)
        token = module.pointer_token(target)
        pointer = module.read_pointer(target) or {}
        if module.pointer_token(target) != token:
            raise McpStageError("MCP 배포 목록이 바뀌었습니다. 새로고침하세요")
        result.update(token=token, current=pointer.get("current"), previous=pointer.get("previous"))
    except (OSError, ValueError) as exc:
        result["error"] = str(exc)
    versions = base / "versions"
    if versions.is_dir():
        for folder in sorted(versions.iterdir(), key=lambda path: path.name, reverse=True):
            if not _SHA.fullmatch(folder.name):
                continue
            row = {"commit": folder.name, "version": "—", "verified": False, "compatible": False, "reason": "", "state": "후보"}
            try:
                manifest, _files = module.read_version(base, folder.name)
                problem = module.compatibility(manifest, inst.root / "tools" / "mcp_adapter")
                row.update(version=manifest["version"], verified=True, compatible=not problem, reason=problem,
                           manifest_sha256=module.manifest_digest(manifest), file_count=len(manifest["files"]))
                for key, label in (("previous", "직전 배포"), ("current", "현재 배포")):
                    if result[key] and result[key]["commit"] == folder.name:
                        row["state"] = label
            except (OSError, ValueError) as exc:
                row["reason"] = str(exc)
            result["rows"].append(row)
    return result


def changes(inst: Installation, commit: str, previous: str | None) -> str:
    _sha(commit)
    if previous:
        _sha(previous)
        args = ["diff", "--no-ext-diff", "--no-textconv", "--stat", previous, commit, "--", _PREFIX + "server.py"]
    else:
        args = ["show", "--no-ext-diff", "--no-textconv", "--format=", "--stat", commit, "--", _PREFIX + "server.py"]
    return _git(inst, args).decode("utf-8", errors="replace")[:12000]


def deploy(inst: Installation, commit: str, expected_digest: str, expected_token: str | None, source: str) -> dict:
    with UpdateLock(inst):
        module = updater(inst)
        if str(destination(inst)) != source:
            raise McpStageError("게시 위치가 바뀌었습니다. 목록을 새로 확인하세요")
        manifest, files = module.read_version(stage_root(inst), _sha(commit), expected_digest)
        problem = module.compatibility(manifest, inst.root / "tools" / "mcp_adapter")
        if problem:
            raise McpStageError(problem)
        return module.publish(Path(source), manifest, files, expected_token)


def rollback(inst: Installation, expected_token: str | None, source: str) -> dict:
    with UpdateLock(inst):
        if str(destination(inst)) != source:
            raise McpStageError("게시 위치가 바뀌었습니다. 목록을 새로 확인하세요")
        module = updater(inst)
        prior = module.read_pointer(Path(source)) or {}
        previous = prior.get("previous")
        if not previous:
            raise McpStageError("직전 배포가 없습니다")
        manifest, _files = module.read_version(Path(source), **previous)
        problem = module.compatibility(manifest, inst.root / "tools" / "mcp_adapter")
        if problem:
            raise McpStageError(problem)
        return module.rollback(Path(source), expected_token)
