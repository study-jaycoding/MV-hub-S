"""Comfy에 실제 전달한 바이트를 보존한다. 클라이언트의 SHA·폼 메타는 증거로 쓰지 않는다."""
from __future__ import annotations

import hashlib
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from . import asset_io, asset_sync
from .media_types import ASSET_CONTENT_TYPES, VIDEO_EXTENSIONS
from .path_safety import safe_join


def local_input_path(url: str, media_dir: Path, scope: str) -> Path | None:
    match = re.fullmatch(r"/api/comfy/inputs/([0-9a-f]{16})/([0-9a-f]{64}\.[a-z0-9]{1,8})", url)
    if not match or match.group(1) != scope or Path(match.group(2)).suffix not in ASSET_CONTENT_TYPES:
        return None
    return safe_join(media_dir.parent / "comfy-inputs" / scope, match.group(2))


def _commit_snapshot(staged: Path, target: Path, sha: str, size: int) -> None:
    try:
        os.link(staged, target)
    except FileExistsError:
        pass
    except OSError:
        if os.name != "nt":
            raise
        try:
            os.rename(staged, target)
        except FileExistsError:
            pass
    if target.stat().st_size != size or asset_io.sha256_file(target) != sha:
        raise ValueError("Comfy 보존본의 바이트가 다릅니다")


def materialize_path_input(path: Path, input_dir: str, *, expected_sha: str | None = None) -> Path:
    """경로형 영상 입력도 이름이 아니라 실제 바이트별로 확정해 잡 간 덮어쓰기를 막는다."""
    extension = path.suffix.lower()
    if extension not in VIDEO_EXTENSIONS:
        raise ValueError("Comfy 영상 입력 형식을 확인할 수 없습니다")
    directory = Path(input_dir) / "mvhub"
    directory.mkdir(parents=True, exist_ok=True)
    fd, raw = tempfile.mkstemp(prefix=".snapshot-", suffix=".part", dir=directory)
    staged = Path(raw)
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("rb") as source, os.fdopen(fd, "wb") as destination:
            fd = -1
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                size += len(chunk)
                if size > asset_io.UPLOAD_MAX_BYTES:
                    raise ValueError("Comfy 영상 입력이 너무 큽니다")
                destination.write(chunk)
                digest.update(chunk)
            destination.flush()
            os.fsync(destination.fileno())
        if not size:
            raise ValueError("빈 Comfy 영상 입력은 사용할 수 없습니다")
        sha = digest.hexdigest()
        if expected_sha is not None and sha != expected_sha:
            raise ValueError("Comfy 영상 입력이 보관 당시 바이트와 다릅니다")
        target = safe_join(directory, sha + extension)
        if target is None:
            raise ValueError("Comfy 영상 입력 경로를 확인할 수 없습니다")
        _commit_snapshot(staged, target, sha, size)
        return target.resolve()
    finally:
        if fd >= 0:
            os.close(fd)
        staged.unlink(missing_ok=True)


def archive(path: Path, *, name: str, kind: str, media_dir: Path, scope: str,
            owner_uid: str, project_id: str | None, server_origin: str,
            file_path: str | None = None, expected_sha: str | None = None,
            expected_bytes: int | None = None, require_owned: bool = False) -> dict:
    """복사하며 지문을 계산한 동일 스냅샷을 생성 입력·동기화 양쪽에 제공한다."""
    ext = Path(name).suffix.lower()
    if ext not in ASSET_CONTENT_TYPES or not re.fullmatch(r"[0-9a-f]{16}", scope):
        raise ValueError("Comfy 자료의 파일 형식을 확인할 수 없습니다")
    directory = media_dir.parent / "comfy-inputs" / scope
    directory.mkdir(parents=True, exist_ok=True)
    fd, raw = tempfile.mkstemp(prefix=".snapshot-", suffix=".part", dir=directory)
    staged = Path(raw)
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("rb") as source, os.fdopen(fd, "wb") as destination:
            fd = -1
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                destination.write(chunk)
                digest.update(chunk)
                size += len(chunk)
                if size > asset_io.UPLOAD_MAX_BYTES:
                    raise ValueError("Comfy 자료가 너무 큽니다")
            destination.flush()
            os.fsync(destination.fileno())
        if size <= 0:
            raise ValueError("빈 Comfy 자료는 보존할 수 없습니다")
        sha = digest.hexdigest()
        if ((expected_sha is not None and expected_sha != sha)
                or (expected_bytes is not None and expected_bytes != size)):
            raise ValueError("Comfy 자료가 실행 당시 바이트와 다릅니다")
        if require_owned and not asset_sync.owns_local_content(staged, owner_uid):
            raise PermissionError("이 계정의 검증된 출력 자료가 아닙니다")
        target = directory / (sha + ext)
        _commit_snapshot(staged, target, sha, size)
        url = f"/api/comfy/inputs/{scope}/{target.name}"
        registration = asset_sync.register_local(
            target, file_path or url, sha, size, kind, owner_uid,
            project_id=project_id, server_origin=server_origin, original_name=name,
        )
        return {**registration, "file_path": url, "sha256": sha, "bytes": size,
                "name": Path(name).name, "type": kind, "path": str(target)}
    finally:
        if fd >= 0:
            os.close(fd)
        staged.unlink(missing_ok=True)


def _metadata_value(value, key: str = ""):
    normalized = key.lower().replace("-", "_")
    if normalized in {"key", "credential", "credentials"} or re.search(r"(^|_)(api_key|token|password|secret|authorization|cookie)(_|$)", normalized):
        return "<redacted>"
    if isinstance(value, dict):
        return {name: _metadata_value(item, str(name)) for name, item in value.items()}
    if isinstance(value, list):
        return [_metadata_value(item) for item in value]
    if (isinstance(value, str) and (normalized == "url" or normalized.endswith("_url"))
            and value.startswith(("http://", "https://"))):
        return urlsplit(value)._replace(query="", fragment="").geturl()
    return value


def execution_snapshot(workflow: dict) -> dict:
    """형변환·시드·미디어 주입 후 실제 공급자에 보낸 필드를 기록한다."""
    workflow = _metadata_value(workflow)
    params = {}
    texts = []
    for node_id, node in workflow.items():
        if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
            continue
        for field, value in node["inputs"].items():
            if isinstance(value, (list, dict)):
                continue
            params[f"{node_id}|{field}"] = value
            if (isinstance(value, str) and re.search(r"text|string|prompt|multiline", str(node.get("class_type", "")), re.I)
                    and re.match(r"text|prompt|positive|negative|string", field, re.I) and value.strip()):
                texts.append(value)
    return {"prompt": "\n".join(texts), "params": params, "workflow": workflow}
