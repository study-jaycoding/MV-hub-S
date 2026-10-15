"""Explicit, additive media/folder seed for a stopped workroom. No downloads."""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import tempfile
import uuid

from workroom import REPO, runtime_lock


def readonly(path):
    return sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)


def unlinked(path):
    """Reject junctions/symlinks in an existing path, including its ancestors."""
    for part in (path, *path.parents):
        if part.exists() or part.is_symlink():
            info = part.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise ValueError("링크 경로는 복사 대상으로 사용할 수 없습니다")
    return path


def inside(runtime, path):
    unlinked(path)
    if not path.resolve().is_relative_to(runtime):
        raise ValueError("시험실 밖의 경로입니다")
    return path


def walk(root, *, folders_only=False, skip_resize_cache=False):
    """No reparse traversal. Media caches include dot-directories."""
    if not root.is_dir():
        raise FileNotFoundError("자료 폴더에 접근할 수 없습니다")
    unlinked(root)
    pending, directories, files, skipped = [root], [], [], 0
    while pending:
        current = pending.pop()
        with os.scandir(current) as entries:
            for item in entries:
                # Resize cache keys contain the old absolute path; it cannot be reused here.
                if skip_resize_cache and current == root and item.name == '.thumbs':
                    continue
                if folders_only and item.name.startswith((".", "_")):
                    continue
                info = item.stat(follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                    skipped += 1
                    continue
                path = Path(item.path)
                if stat.S_ISDIR(info.st_mode):
                    directories.append(path.relative_to(root))
                    pending.append(path)
                    if folders_only and len(directories) > 2000:
                        raise ValueError("프로젝트 폴더가 2000개를 넘습니다")
                elif not folders_only and stat.S_ISREG(info.st_mode):
                    files.append((path, info.st_size, info.st_mtime_ns))
    return directories, files, skipped


def plan(source, runtime, repo=REPO):
    source, runtime, repo = source.absolute(), runtime.absolute(), repo.resolve()
    unlinked(source)
    unlinked(runtime)
    source, runtime = source.resolve(strict=True), runtime.resolve(strict=True)
    if source.is_relative_to(runtime) or runtime.is_relative_to(source):
        raise ValueError("원본과 시험실 경로가 겹칩니다")
    marker = inside(runtime, runtime / ".mvhub-workroom.json")
    saved = json.loads(marker.read_text(encoding="utf-8"))
    if saved != {"version": 1, "repo": str(repo)}:
        raise ValueError("이 저장소가 소유한 시험실이 아닙니다")
    target_db = inside(runtime, runtime / "data/db/content_hub.db")
    if target_db.stat().st_nlink != 1:
        raise ValueError("DB가 다른 파일과 연결돼 있습니다")
    files, directories, links, warnings = [], [], [], []
    skipped_links = 0
    for name in ("media", "assets"):
        root = source / name
        if not root.exists() and name == "assets":
            continue
        dirs, items, skipped = walk(root, skip_resize_cache=name == 'media')
        skipped_links += skipped
        dest = inside(runtime, runtime / "data" / name)
        directories.extend([dest, *(dest / rel for rel in dirs)])
        for src, size, mtime in items:
            dst = inside(runtime, dest / src.relative_to(root))
            if dst.exists() and not dst.is_file():
                raise ValueError("미디어 목적지에 같은 이름의 폴더가 있습니다")
            files.append((src, dst, size, mtime))
    with closing(readonly(source / "db/content_hub.db")) as src, closing(readonly(target_db)) as dst:
        rows = src.execute("""SELECT p.id,p.name,COALESCE(NULLIF(p.render_root_path,''),l.root_path,'')
            FROM project p LEFT JOIN project_folder_link l ON l.project_id=p.id""").fetchall()
        for pid, name, raw in rows:
            if not raw:
                continue
            current = dst.execute("""SELECT p.name,p.render_root_path,l.root_path FROM project p
                LEFT JOIN project_folder_link l ON l.project_id=p.id WHERE p.id=?""", (pid,)).fetchone()
            if not current or current[0] != name or current[1] or current[2]:
                warnings.append({"project": name, "reason": "기존 연결 또는 다른 프로젝트: 보존"})
                continue
            try:
                root = Path(raw).absolute()
                unlinked(root)
                render = root if root.name.lower() == "render" else next(
                    p for p in root.iterdir() if p.name.lower() == "render" and p.is_dir())
                dirs, _, skipped = walk(render, folders_only=True)
            except (OSError, ValueError, StopIteration):
                warnings.append({"project": name, "reason": "원본 Render 트리 접근 불가: 연결하지 않음"})
                continue
            skipped_links += skipped
            dest = inside(runtime, runtime / "data/projects" / hashlib.sha256(pid.encode()).hexdigest()[:20] / "Render")
            directories.extend([dest, *(dest / rel for rel in dirs)])
            links.append((pid, name, dest))
    for directory in directories:
        inside(runtime, directory)
    needed = sum(size for _, dst, size, _ in files if not dst.exists())
    if shutil.disk_usage(runtime).free < needed + 128 * 1024 * 1024:
        raise ValueError("시험실 저장 공간이 부족합니다")
    return {"runtime": runtime, "db": target_db, "files": files, "directories": directories,
            "links": links, "warnings": warnings, "skipped_reparse": skipped_links, "bytes": needed}


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def apply(prepared):
    if os.name != "nt":
        raise OSError("Windows의 덮어쓰지 않는 rename을 사용하는 도구입니다")
    runtime = prepared["runtime"]
    backup = inside(runtime, runtime / ("materials-before-" + uuid.uuid4().hex + ".db"))
    with closing(readonly(prepared["db"])) as src, closing(sqlite3.connect(backup)) as dst:
        src.backup(dst)
    copied, kept, conflicts = 0, 0, 0
    for directory in prepared["directories"]:
        inside(runtime, directory).mkdir(parents=True, exist_ok=True)
    for src, dst, size, mtime in prepared["files"]:
        unlinked(src)
        inside(runtime, dst)
        before = src.stat()
        if (before.st_size, before.st_mtime_ns) != (size, mtime):
            raise RuntimeError("계획 후 원본이 변경됐습니다. 다시 계획하세요")
        if dst.exists():
            kept += 1
            conflicts += digest(src) != digest(dst)
            continue
        descriptor, temporary = tempfile.mkstemp(prefix=".material-", dir=dst.parent)
        temporary = Path(temporary)
        try:
            with os.fdopen(descriptor, "wb") as output, src.open("rb") as original:
                copied_hash = hashlib.sha256()
                while block := original.read(1024 * 1024):
                    output.write(block)
                    copied_hash.update(block)
            after = src.stat()
            if (after.st_size, after.st_mtime_ns) != (size, mtime) or temporary.stat().st_size != size or digest(temporary) != copied_hash.hexdigest():
                raise RuntimeError("복사 중 원본이 변경됐습니다")
            os.utime(temporary, ns=(before.st_atime_ns, before.st_mtime_ns))
            # On Windows rename fails if dst exists; never replace a user's file.
            os.rename(temporary, dst)
            copied += 1
        finally:
            temporary.unlink(missing_ok=True)
    with closing(sqlite3.connect(inside(runtime, prepared["db"]))) as conn, conn:
        for pid, name, dest in prepared["links"]:
            row = conn.execute("""SELECT p.name,p.render_root_path,l.root_path FROM project p
                LEFT JOIN project_folder_link l ON l.project_id=p.id WHERE p.id=?""", (pid,)).fetchone()
            if not row or row[0] != name or row[1] or row[2]:
                raise RuntimeError("계획 후 프로젝트 연결이 변경됐습니다. 기존 연결을 보존합니다")
            conn.execute("""INSERT INTO project_folder_link(project_id,root_path,selected_path,updated_at)
                VALUES(?,?,'',datetime('now')) ON CONFLICT(project_id) DO UPDATE SET
                root_path=excluded.root_path,updated_at=excluded.updated_at
                WHERE COALESCE(project_folder_link.root_path,'')=''""", (pid, str(dest.parent)))
    return {"copied": copied, "preserved_existing": kept, "different_existing": conflicts,
            "linked_projects": len(prepared["links"]), "backup": str(backup)}


def summary(prepared):
    return {"files": len(prepared["files"]), "new_bytes": prepared["bytes"],
            "directories": len(prepared["directories"]), "projects": [name for _, name, _ in prepared["links"]],
            "skipped_reparse": prepared["skipped_reparse"], "warnings": prepared["warnings"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-data", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.apply:
        with runtime_lock(args.runtime):
            prepared = plan(args.source_data, args.runtime)
            result = {**summary(prepared), **apply(prepared)}
    else:
        result = summary(plan(args.source_data, args.runtime))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
