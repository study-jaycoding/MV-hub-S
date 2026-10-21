"""Quiesced install checkpoints. Inspect stable private copies, never migrate originals."""
from __future__ import annotations

import argparse
from dataclasses import asdict
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile


def file_digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def database_paths(root: Path, env: dict[str, str]) -> list[tuple[str, Path]]:
    from app.schema_compat import database_paths as existing_database_paths
    return existing_database_paths(root, env)


def file_set(paths: list[tuple[str, Path]]) -> dict[Path, tuple[int, str]]:
    result = {}
    for _, database in paths:
        for suffix in ("", "-wal", "-shm", "-journal"):
            path = Path(str(database) + suffix)
            if path.is_file():
                if path.is_symlink() or bool(getattr(path.stat(), "st_file_attributes", 0) & 1024):
                    raise ValueError("database_link_forbidden")
                result[path] = (path.stat().st_size, file_digest(path))
    return result


def load_inspector(root: Path, path: Path | None = None):
    path = path or root / "backend/app/schema_compat.py"
    spec = importlib.util.spec_from_file_location("_installed_schema_compat", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.inspect_database


def snapshot(root: Path, output: Path, env: dict[str, str], inspect_database=None, snapshotter=None, recover_database=None) -> list[dict]:
    """Caller proves quiescence. A changed source set aborts; no DB restore is offered."""
    from app.schema_compat import database_key

    paths = database_paths(root, env)
    inspect_database = inspect_database or load_inspector(root)
    recover_database = recover_database or getattr(sys.modules[inspect_database.__module__], 'recover_compatible_database')
    if snapshotter is None:
        from app.services.backup_verify import create_database_set_snapshot
        snapshotter = create_database_set_snapshot
    before = file_set(paths)
    if not paths:
        raise ValueError("database_set_unknown")
    output.mkdir(parents=True, exist_ok=False)
    result = []
    # Recovery, if needed, is performed on the private copied files only.
    with tempfile.TemporaryDirectory(prefix="mvhub-install-db-") as directory:
        temporary = Path(directory)
        copies = {}
        for kind, source in paths:
            key = database_key(source)
            private = temporary / (key + ".db")
            for suffix in ("", "-wal", "-shm", "-journal"):
                path = Path(str(source) + suffix)
                if path in before:
                    shutil.copyfile(path, Path(str(private) + suffix))
            copies[source] = (kind, key, private, output / (key + ".db"))
            recover_database(private, expected_kind=kind)
        remaining = set(copies)
        for kind, source in paths:
            if kind != 'content':
                continue
            group = {'content': source}
            trash = source.with_name('content_hub_trash.db')
            if trash in remaining:
                group['trash'] = trash
            manage = next((path for path in remaining if copies[path][0] == 'manage'), None)
            if manage is not None:
                group['manage'] = manage
            snapshotter({role: copies[path][2] for role, path in group.items()},
                        {role: copies[path][3] for role, path in group.items()})
            remaining.difference_update(group.values())
        if remaining:
            raise ValueError('orphan_database_set')
        for kind, source in paths:
            _, key, _, checkpoint = copies[source]
            inspected = inspect_database(checkpoint, expected_kind=kind)
            value = asdict(inspected) if hasattr(inspected, "__dataclass_fields__") else dict(inspected)
            result.append({**value, "key": key, "checkpoint": checkpoint.name, "sha256": file_digest(checkpoint)})
        if paths != database_paths(root, env) or before != file_set(paths):
            raise ValueError("database_changed_while_checkpointing")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--inspector", type=Path)
    args = parser.parse_args()
    try:
        sys.path.insert(0, str(args.inspector.parent.parent if args.inspector else args.root / 'backend'))
        result = snapshot(args.root.resolve(), args.output.resolve(), dict(os.environ), load_inspector(args.root, args.inspector))
        print(json.dumps({"format_version": 1, "databases": result}, separators=(",", ":")))
        return 0
    except Exception as exc:
        # Database paths, account directory names and SQL contents stay off the log.
        print(json.dumps({"error": getattr(exc, "reason", type(exc).__name__)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
