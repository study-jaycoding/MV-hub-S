"""File-only MCP releases. This bootstrap stays in the application bundle."""
from __future__ import annotations

import ast
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
from urllib.parse import urlsplit
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener

FILES = ("server.py",)
BASELINE = ("local_setup.py", "update.py", "requirements.lock.txt")
MAX_FILE = 2 * 1024 * 1024
MAX_JSON = 64 * 1024
HEX = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
VERSION = re.compile(r"^[0-9]+(?:\.[0-9]+){3}$")


class Error(ValueError):
    pass


class NotPublished(Error):
    pass


def _bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def _hash(raw):
    return hashlib.sha256(raw).hexdigest()


def _text_hash(raw):
    # Git blobs use LF while Windows checkouts may use CRLF.
    return _hash(raw.replace(b"\r\n", b"\n"))


def _plain(path):
    path = Path(os.path.abspath(path))
    for part in (*reversed(path.parents), path):
        if part.exists() or part.is_symlink():
            if part.is_symlink() or getattr(os.lstat(part), "st_file_attributes", 0) & 0x400:
                raise Error("MCP 경로에 연결 지점이 있습니다.")
    return path


def _read(path, limit=MAX_JSON):
    path = _plain(path)
    with path.open("rb") as stream:
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise Error("MCP 파일 크기 제한을 초과했습니다.")
    return raw


def _json(raw):
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError) as exc:
        raise Error("MCP 목록 형식이 올바르지 않습니다.") from exc
    if not isinstance(value, dict):
        raise Error("MCP 목록은 객체여야 합니다.")
    return value


def _constants(raw):
    if len(raw) > MAX_FILE:
        raise Error("MCP 코드 크기 제한을 초과했습니다.")
    try:
        tree = ast.parse(raw)
        values = {}
        for node in tree.body:
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id in {"ADAPTER_VERSION", "HUB_FEATURES", "MCP_UPDATE_API"}:
                        if target.id in values:
                            raise Error("MCP 선언이 중복되었습니다.")
                        values[target.id] = ast.literal_eval(node.value)
        return values
    except (SyntaxError, ValueError, TypeError, RecursionError) as exc:
        raise Error("MCP 코드의 정적 선언을 확인하지 못했습니다.") from exc


def build_manifest(commit: str, payload: bytes, baseline: dict[str, bytes]) -> dict:
    values = _constants(payload)
    if values.get("MCP_UPDATE_API") != 1 or b"_MCP_BUNDLE" not in payload:
        raise Error("독립 실행기 계약이 없는 후보입니다. 최초 본체 도입이 필요합니다.")
    features = values.get("HUB_FEATURES")
    if not isinstance(features, set) or not all(isinstance(v, str) for v in features):
        raise Error("허브 기능 선언이 올바르지 않습니다.")
    manifest = {"schema": 1, "version": values.get("ADAPTER_VERSION"), "commit": commit,
                "files": [{"path": "server.py", "size": len(payload), "sha256": _hash(payload)}],
                "requires": {"baseline": {name: _text_hash(baseline[name]) for name in BASELINE},
                             "hub_features": sorted(features)}, "validation": "static"}
    validate_manifest(manifest)
    return manifest


def validate_manifest(value):
    if (not isinstance(value, dict) or value.get("schema") != 1 or value.get("validation") != "static"
            or not isinstance(value.get("commit"), str) or not COMMIT.fullmatch(value["commit"])
            or not isinstance(value.get("version"), str) or not VERSION.fullmatch(value["version"])
            or len(value["version"]) > 40):
        raise Error("MCP 버전 목록이 올바르지 않습니다.")
    items = value.get("files")
    if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], dict):
        raise Error("MCP 허용 파일 목록과 다릅니다.")
    item = items[0]
    if (item.get("path") != "server.py" or type(item.get("size")) is not int
            or not 0 < item["size"] <= MAX_FILE or not isinstance(item.get("sha256"), str)
            or not HEX.fullmatch(item["sha256"])):
        raise Error("MCP 파일 정보가 올바르지 않습니다.")
    requires = value.get("requires")
    if not isinstance(requires, dict):
        raise Error("MCP 호환 조건이 없습니다.")
    baseline, features = requires.get("baseline"), requires.get("hub_features")
    if (not isinstance(baseline, dict) or set(baseline) != set(BASELINE)
            or not all(isinstance(v, str) and HEX.fullmatch(v) for v in baseline.values())
            or not isinstance(features, list) or len(features) > 50
            or not all(isinstance(v, str) and re.fullmatch(r"[a-z_]{1,80}", v) for v in features)
            or len(set(features)) != len(features)):
        raise Error("MCP 호환 조건이 올바르지 않습니다.")
    if len(_bytes(value)) > MAX_JSON:
        raise Error("MCP 목록 크기 제한을 초과했습니다.")


def manifest_digest(manifest):
    validate_manifest(manifest)
    return _hash(_bytes(manifest))


def compatibility(manifest, bundle_dir: Path) -> str:
    try:
        validate_manifest(manifest)
        for name, digest in manifest["requires"]["baseline"].items():
            if _text_hash(_read(bundle_dir / name, MAX_FILE)) != digest:
                return "실행기·SDK·인증 계약이 다릅니다. MV Hub 본체 업데이트가 필요합니다."
        features = _constants(_read(bundle_dir / "server.py", MAX_FILE)).get("HUB_FEATURES", set())
        if not set(manifest["requires"]["hub_features"]).issubset(features):
            return "새 허브 기능이 필요합니다. MV Hub 본체 업데이트가 필요합니다."
        return ""
    except (OSError, Error):
        return "설치본의 MCP 호환 조건을 확인하지 못했습니다."


def _ref(value):
    if (not isinstance(value, dict) or set(value) != {"commit", "manifest_sha256"}
            or not isinstance(value["commit"], str) or not COMMIT.fullmatch(value["commit"])
            or not isinstance(value["manifest_sha256"], str) or not HEX.fullmatch(value["manifest_sha256"])):
        raise Error("MCP 게시 포인터가 올바르지 않습니다.")
    return value


def _pointer(value):
    if value.get("schema") != 1 or type(value.get("disabled", False)) is not bool:
        raise Error("MCP 게시 형식이 올바르지 않습니다.")
    _ref(value.get("current"))
    if value.get("previous") is not None:
        _ref(value["previous"])
    return value


def read_pointer(base):
    path = _plain(Path(base) / "published.json")
    return _pointer(_json(_read(path))) if path.exists() else None


def pointer_token(base):
    path = _plain(Path(base) / "published.json")
    return _hash(_read(path)) if path.exists() else None


def _verify_files(manifest, files):
    validate_manifest(manifest)
    if set(files) != set(FILES):
        raise Error("MCP 허용 파일 목록과 다릅니다.")
    for item in manifest["files"]:
        raw = files[item["path"]]
        if len(raw) != item["size"] or _hash(raw) != item["sha256"]:
            raise Error("MCP 파일 크기 또는 해시가 다릅니다.")
    values = _constants(files["server.py"])
    if (values.get("MCP_UPDATE_API") != 1 or values.get("ADAPTER_VERSION") != manifest["version"]
            or set(manifest["requires"]["hub_features"]) != values.get("HUB_FEATURES")):
        raise Error("MCP 코드와 버전 목록의 선언이 다릅니다.")


def read_version(base, commit, manifest_sha256=None):
    if not isinstance(commit, str) or not COMMIT.fullmatch(commit):
        raise Error("MCP 커밋 형식이 올바르지 않습니다.")
    folder = _plain(Path(base) / "versions" / commit)
    if {p.name for p in folder.iterdir()} != {"manifest.json", *FILES}:
        raise Error("MCP 버전 폴더에 누락 또는 허용하지 않은 파일이 있습니다.")
    manifest = _json(_read(folder / "manifest.json"))
    if manifest.get("commit") != commit or (manifest_sha256 and manifest_digest(manifest) != manifest_sha256):
        raise Error("MCP 목록이 고정한 게시판과 다릅니다.")
    files = {name: _read(folder / name, MAX_FILE) for name in FILES}
    _verify_files(manifest, files)
    return manifest, files


def stage_version(base, manifest, files):
    _verify_files(manifest, files)
    versions = _plain(Path(base) / "versions")
    versions.mkdir(parents=True, exist_ok=True)
    target = versions / manifest["commit"]
    if target.exists():
        old, _ = read_version(base, manifest["commit"], manifest_digest(manifest))
        return
    temp = Path(tempfile.mkdtemp(prefix=".pending-", dir=versions))
    try:
        for name, raw in files.items():
            (temp / name).write_bytes(raw)
        (temp / "manifest.json").write_bytes(_bytes(manifest))
        os.rename(temp, target)
    finally:
        if temp.exists():
            shutil.rmtree(_plain(temp))


def _atomic(path, value):
    path = _plain(path)
    fd, name = tempfile.mkstemp(prefix=".pointer-", dir=path.parent)
    temp = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(_bytes(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


@contextmanager
def exclusive_lock(path):
    path = _plain(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                     wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.CreateFileW(str(path), 0xC0000000, 0, None, 4, 0x80, None)
        if handle == ctypes.c_void_p(-1).value:
            raise Error("다른 업데이트가 실행 중이거나 업데이트 폴더에 쓸 수 없습니다.")
        try:
            yield
        finally:
            kernel.CloseHandle(handle)
    else:
        import fcntl
        with path.open("a+b") as stream:
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise Error("다른 업데이트가 실행 중입니다.") from exc
            try:
                yield
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)


def publish(base, manifest, files, expected_token):
    base = _plain(Path(base))
    with exclusive_lock(base / "publish.lock"):
        if pointer_token(base) != expected_token:
            raise Error("게시판이 변경되었습니다. 목록을 다시 확인하세요.")
        prior = read_pointer(base)
        stage_version(base, manifest, files)
        current = {"commit": manifest["commit"], "manifest_sha256": manifest_digest(manifest)}
        if prior and prior["current"] == current:
            return prior
        value = {"schema": 1, "current": current, "previous": prior["current"] if prior else None}
        _atomic(base / "published.json", value)
        return value


def rollback(base, expected_token):
    base = Path(base)
    with exclusive_lock(base / "publish.lock"):
        if pointer_token(base) != expected_token:
            raise Error("게시판이 변경되었습니다. 목록을 다시 확인하세요.")
        prior = read_pointer(base)
        if not prior or not prior.get("previous"):
            raise Error("직전 게시판이 없습니다.")
        read_version(base, **prior["previous"])
        value = {**prior, "current": prior["previous"], "previous": prior["current"]}
        _atomic(base / "published.json", value)
        return value


class _SameOrigin(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old, new = urlsplit(req.full_url), urlsplit(newurl)
        if new.scheme != "https" or (old.hostname, old.port or 443) != (new.hostname, new.port or 443) or new.username or new.password:
            raise Error("MCP 파일의 다른 출처 이동을 거부했습니다.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _source_read(source, relative, limit):
    # Callers construct these names only from validated commit IDs and fixed names.
    if not re.fullmatch(r"mcp/(published\.json|versions/[0-9a-f]{40}/(manifest\.json|server\.py))", relative):
        raise Error("허용되지 않은 MCP 배포 경로입니다.")
    parsed = urlsplit(source)
    if parsed.scheme in {"http", "https"}:
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise Error("MCP 실행 파일은 신뢰된 HTTPS 또는 릴리스 폴더에서만 받습니다.")
        try:
            with build_opener(_SameOrigin()).open(Request(source.rstrip("/") + "/" + relative), timeout=12) as response:
                raw = response.read(limit + 1)
        except HTTPError as exc:
            if exc.code == 404:
                raise FileNotFoundError("MCP 배포 파일이 없습니다.") from exc
            raise Error("MCP 배포 원본을 읽지 못했습니다.") from exc
        except (OSError, ValueError) as exc:
            raise Error("MCP 배포 원본을 읽지 못했습니다.") from exc
        if len(raw) > limit:
            raise Error("MCP 다운로드 크기 제한을 초과했습니다.")
        return raw
    path = Path(source)
    if not path.is_absolute():
        raise Error("MCP 릴리스 폴더는 절대경로여야 합니다.")
    return _read(path / relative, limit)


def source_overview(source):
    try:
        raw = _source_read(source, "mcp/published.json", MAX_JSON)
    except FileNotFoundError as exc:
        raise NotPublished("아직 게시된 MCP 버전이 없습니다.") from exc
    pointer = _pointer(_json(raw))
    ref = pointer["current"]
    manifest = _json(_source_read(source, f"mcp/versions/{ref['commit']}/manifest.json", MAX_JSON))
    if manifest.get("commit") != ref["commit"] or manifest_digest(manifest) != ref["manifest_sha256"]:
        raise Error("MCP 게시 목록 해시가 다릅니다.")
    return {"manifest": manifest, "manifest_sha256": ref["manifest_sha256"], "pointer": pointer}


def storage_path(root):
    local = os.environ.get("LOCALAPPDATA")
    if not local or not Path(local).is_absolute():
        raise Error("Windows 사용자 MCP 저장 위치를 확인하지 못했습니다.")
    identity = _hash(os.path.normcase(str(Path(root).resolve())).encode("utf-8"))[:24]
    return Path(local) / "MVHub-MCP" / "updates" / identity


def _bundle_identity(root):
    version = _read(root / "VERSION.txt") if (root / "VERSION.txt").exists() else b""
    return _hash(version + b"\0" + _read(root / "tools/mcp_adapter/server.py", MAX_FILE))


def selection(root, storage=None):
    root = Path(root)
    bundle = root / "tools/mcp_adapter"
    version = _constants(_read(bundle / "server.py", MAX_FILE)).get("ADAPTER_VERSION")
    result = {"version": version, "bundle_version": version, "source": "bundle", "reason": "",
              "path": str(bundle / "server.py"), "commit": None, "manifest_sha256": None, "rollback_available": False}
    try:
        base = Path(storage) if storage is not None else storage_path(root)
        pointer = read_pointer(base)
        if pointer is None:
            return result
        if pointer.get("disabled"):
            result["reason"] = "설치본 MCP로 되돌렸습니다."
            return result
        if pointer.get("bundle_identity") != _bundle_identity(root):
            raise Error("본체가 변경되어 MCP 게시판을 다시 확인해야 합니다. 설치본 판을 사용합니다.")
        ref = pointer["current"]
        manifest, _ = read_version(base, **ref)
        problem = compatibility(manifest, bundle)
        if problem:
            raise Error(problem)
        return {**result, **ref, "version": manifest["version"], "source": "downloaded",
                "path": str(base / "versions" / ref["commit"] / "server.py"),
                "rollback_available": True}
    except (OSError, Error) as exc:
        result["reason"] = str(exc)
        return result


def install(root, source, expected_manifest_sha256, storage=None):
    root = Path(root)
    base = Path(storage) if storage is not None else storage_path(root)
    with exclusive_lock(root / ".update.lock"):
        identity = _bundle_identity(root)
        overview = source_overview(source)
        manifest = overview["manifest"]
        if overview["manifest_sha256"] != expected_manifest_sha256:
            raise Error("배포판이 변경되었습니다. 새 버전을 다시 확인하세요.")
        problem = compatibility(manifest, root / "tools/mcp_adapter")
        if problem:
            raise Error(problem)
        files = {name: _source_read(source, f"mcp/versions/{manifest['commit']}/{name}", MAX_FILE) for name in FILES}
        stage_version(base, manifest, files)
        if _bundle_identity(root) != identity:
            raise Error("본체가 변경되었습니다. 다시 확인하세요.")
        # Downloading never touches profiles or LLM client registration.
        prior = read_pointer(base)
        current = {"commit": manifest["commit"], "manifest_sha256": manifest_digest(manifest)}
        previous = prior.get("current") if prior and not prior.get("disabled") and prior.get("bundle_identity") == identity else None
        if previous == current:
            previous = prior.get("previous")
        _atomic(base / "published.json", {"schema": 1, "current": current, "previous": previous, "bundle_identity": identity})
    return {**selection(root, base), "settings_preserved": True, "reload_required": True}


def rollback_install(root, expected_manifest_sha256, storage=None):
    root = Path(root)
    base = Path(storage) if storage is not None else storage_path(root)
    with exclusive_lock(root / ".update.lock"):
        state = selection(root, base)
        if state["source"] != "downloaded" or state["manifest_sha256"] != expected_manifest_sha256:
            raise Error("설치판이 변경되었습니다. 다시 확인하세요.")
        prior = read_pointer(base)
        if not prior.get("previous"):
            _atomic(base / "published.json", {**prior, "disabled": True})
        else:
            manifest, _ = read_version(base, **prior["previous"])
            problem = compatibility(manifest, root / "tools/mcp_adapter")
            if problem:
                raise Error(problem)
            _atomic(base / "published.json", {**prior, "current": prior["previous"], "previous": prior["current"]})
    return {**selection(root, base), "settings_preserved": True, "reload_required": True}
