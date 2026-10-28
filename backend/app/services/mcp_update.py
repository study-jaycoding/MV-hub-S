"""Local app boundary for the bundled, ZIP-free MCP updater."""
from __future__ import annotations

import importlib.util
import threading
from pathlib import Path

from . import release_update


class McpUpdateError(ValueError):
    pass


_operation = threading.Lock()


def _core(root: Path):
    path = root / "tools" / "mcp_adapter" / "update.py"
    if not path.is_file():
        raise McpUpdateError("MCP 독립 업데이트를 사용하려면 MV Hub 본체를 먼저 업데이트하세요.")
    try:
        spec = importlib.util.spec_from_file_location("mvhub_mcp_updater", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    except (ImportError, SyntaxError, OSError) as exc:
        raise McpUpdateError("MCP 업데이트 도구를 읽지 못했습니다. MV Hub 본체 설치를 확인하세요.") from exc
    return module


def _selected(value: dict) -> dict:
    return {"selected_version": value["version"], "bundle_version": value["bundle_version"],
            "source": value["source"], "selection_reason": value.get("reason", ""),
            "manifest_sha256": value.get("manifest_sha256"),
            "rollback_available": bool(value.get("rollback_available")),
            "reload_required": bool(value.get("reload_required")),
            "settings_preserved": bool(value.get("settings_preserved"))}


def installed(root: Path) -> dict:
    core = _core(root)
    try:
        return _selected(core.selection(root))
    except (core.Error, OSError) as exc:
        raise McpUpdateError("설치된 MCP 버전을 확인하지 못했습니다.") from exc


def status(root: Path) -> dict:
    core = _core(root)
    try:
        selection = core.selection(root)
    except (core.Error, OSError) as exc:
        raise McpUpdateError("설치된 MCP 버전을 확인하지 못했습니다.") from exc
    result = {**_selected(selection), "published": None, "compatible": False,
              "available": False, "checked": False, "note": ""}
    try:
        if release_update.update_in_progress(root):
            result["note"] = "MV Hub 본체 업데이트 중입니다. 완료 후 다시 확인하세요."
            return result
        source = release_update.install_source(root)
        remote = core.source_overview(source)
        manifest = remote["manifest"]
        problem = core.compatibility(manifest, root / "tools" / "mcp_adapter")
        different = remote["manifest_sha256"] != selection.get("manifest_sha256")
        result.update(published={"version": manifest["version"], "commit": manifest["commit"],
                                 "manifest_sha256": remote["manifest_sha256"]},
                      compatible=not problem, checked=True,
                      available=not problem and different,
                      note=problem or ("새 MCP 버전을 준비할 수 있습니다." if different
                                       else "게시된 MCP 버전과 같습니다."))
        return result
    except core.NotPublished:
        result.update(checked=True, note="아직 배포된 MCP 버전이 없습니다.")
        return result
    except (core.Error, release_update.ReleaseUpdateError, OSError) as exc:
        result["note"] = (str(exc) if isinstance(exc, core.Error) else
                          "게시된 MCP 버전을 확인하지 못했습니다. 릴리스 위치와 접근 권한을 확인하세요.")
        return result


def apply(root: Path, expected_manifest_sha256: str, *, rollback: bool = False) -> dict:
    if not _operation.acquire(blocking=False):
        raise McpUpdateError("다른 MCP 업데이트가 진행 중입니다. 완료 후 다시 확인하세요.")
    try:
        if release_update.update_in_progress(root):
            raise McpUpdateError("MV Hub 본체 업데이트 중입니다. 완료 후 다시 확인하세요.")
        core = _core(root)
        try:
            value = (core.rollback_install(root, expected_manifest_sha256) if rollback else
                     core.install(root, release_update.install_source(root), expected_manifest_sha256))
        except (core.Error, release_update.ReleaseUpdateError, OSError) as exc:
            raise McpUpdateError(str(exc) if isinstance(exc, core.Error) else
                                 "MCP 파일을 준비하지 못했습니다. 버전과 릴리스 위치를 다시 확인하세요.") from exc
        return {**_selected(value), "note": "이전 MCP 버전을 준비했습니다." if rollback else "MCP 업데이트를 준비했습니다."}
    finally:
        _operation.release()
