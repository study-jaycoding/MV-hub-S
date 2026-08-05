"""서버형 테스트용 다중 SQLite 스냅샷 번들.

라이브/스냅샷 서버의 ``data/db``에는 콘텐츠 DB 외에도 휴지통, 팀 통계, 계정별 DB가 있다.
각 파일을 SQLite backup API로 일관 복사한 뒤 한 ZIP으로 묶고, 받는 쪽은 경로·목록·크기·CRC와
SQLite 무결성을 모두 확인한 경우에만 임시 데이터 폴더에 설치한다.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import tempfile
import zipfile
from contextlib import closing
from pathlib import Path, PurePosixPath

from .sqlite_db import HubDbValidationError, validate_hub_db

SNAPSHOT_FORMAT = "mvhub-test-db-snapshot"
SNAPSHOT_VERSION = 1
MANIFEST_NAME = "snapshot.json"
MAX_DB_FILES = 1_000
MAX_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024
MAX_MANIFEST_BYTES = 1 * 1024 * 1024
MIN_FREE_RESERVE_BYTES = 128 * 1024 * 1024


class TestSnapshotError(ValueError):
    """스냅샷 생성·검증·설치 실패."""

    __test__ = False  # pytest가 예외 클래스를 테스트 클래스로 수집하지 않게 한다.


def _sqlite_snapshot(source: Path, target: Path) -> None:
    """WAL에 남은 커밋까지 포함해 SQLite 파일 하나를 일관 복사한다."""
    with closing(sqlite3.connect(f"file:{source.as_posix()}?mode=ro", uri=True)) as src:
        with closing(sqlite3.connect(target)) as dst:
            src.backup(dst)


def _db_archive_name(db_root: Path, source: Path) -> str:
    relative = source.relative_to(db_root).as_posix()
    return f"db/{relative}"


def create_test_snapshot_archive(data_dir: Path) -> Path:
    """``data_dir/db``의 모든 .db를 일관 스냅샷 ZIP으로 만들고 임시 ZIP 경로를 반환한다.

    호출자는 응답 전송 또는 사용이 끝난 뒤 반환 파일을 삭제해야 한다.
    """
    db_root = (data_dir / "db").resolve()
    primary = db_root / "content_hub.db"
    if not primary.is_file():
        raise TestSnapshotError(f"기본 DB가 없습니다: {primary}")

    sources = sorted(
        path for path in db_root.rglob("*.db") if path.is_file() and not path.is_symlink()
    )
    if not sources or len(sources) > MAX_DB_FILES:
        raise TestSnapshotError(f"DB 파일 수가 허용 범위를 벗어났습니다: {len(sources)}")

    archive_handle = tempfile.NamedTemporaryFile(prefix="mvhub-test-snapshot-", suffix=".zip", delete=False)
    archive = Path(archive_handle.name)
    archive_handle.close()
    manifest_files: list[dict[str, int | str]] = []
    try:
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
            for source in sources:
                snapshot_handle = tempfile.NamedTemporaryFile(
                    prefix="mvhub-test-db-", suffix=".db", delete=False
                )
                snapshot = Path(snapshot_handle.name)
                snapshot_handle.close()
                try:
                    _sqlite_snapshot(source, snapshot)
                    archive_name = _db_archive_name(db_root, source)
                    size = snapshot.stat().st_size
                    bundle.write(snapshot, archive_name)
                    manifest_files.append({"path": archive_name, "size": size})
                finally:
                    snapshot.unlink(missing_ok=True)

            manifest = {
                "format": SNAPSHOT_FORMAT,
                "version": SNAPSHOT_VERSION,
                "files": manifest_files,
            }
            bundle.writestr(MANIFEST_NAME, json.dumps(manifest, ensure_ascii=False, indent=2))
        return archive
    except BaseException:
        archive.unlink(missing_ok=True)
        raise


def _safe_db_entry(name: str) -> PurePosixPath:
    if "\\" in name:
        raise TestSnapshotError(f"허용되지 않은 번들 경로입니다: {name}")
    path = PurePosixPath(name)
    if (
        path.is_absolute()
        or not path.parts
        or path.parts[0] != "db"
        or any(part in ("", ".", "..") or ":" in part for part in path.parts)
    ):
        raise TestSnapshotError(f"허용되지 않은 번들 경로입니다: {name}")
    if path.suffix.lower() != ".db" or len(path.parts) < 2:
        raise TestSnapshotError(f"DB 파일이 아닌 번들 항목입니다: {name}")
    return path


def _read_manifest(bundle: zipfile.ZipFile) -> dict:
    try:
        manifest_info = bundle.getinfo(MANIFEST_NAME)
        if manifest_info.file_size > MAX_MANIFEST_BYTES:
            raise TestSnapshotError("스냅샷 manifest가 허용 크기를 넘었습니다")
        manifest = json.loads(bundle.read(MANIFEST_NAME).decode("utf-8"))
    except (KeyError, UnicodeError, json.JSONDecodeError) as exc:
        raise TestSnapshotError("스냅샷 manifest가 없거나 손상됐습니다") from exc
    if not isinstance(manifest, dict):
        raise TestSnapshotError("스냅샷 manifest 형식이 올바르지 않습니다")
    if manifest.get("format") != SNAPSHOT_FORMAT or manifest.get("version") != SNAPSHOT_VERSION:
        raise TestSnapshotError("지원하지 않는 스냅샷 형식 또는 버전입니다")
    if not isinstance(manifest.get("files"), list):
        raise TestSnapshotError("스냅샷 파일 목록이 없습니다")
    return manifest


def _validate_archive_entries(bundle: zipfile.ZipFile, manifest: dict) -> list[tuple[zipfile.ZipInfo, PurePosixPath]]:
    infos = [info for info in bundle.infolist() if not info.is_dir() and info.filename != MANIFEST_NAME]
    if not infos or len(infos) > MAX_DB_FILES:
        raise TestSnapshotError(f"번들 DB 파일 수가 허용 범위를 벗어났습니다: {len(infos)}")

    manifest_sizes: dict[str, int] = {}
    for item in manifest["files"]:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise TestSnapshotError("스냅샷 파일 목록 항목이 손상됐습니다")
        size = item.get("size")
        if not isinstance(size, int) or size < 0 or item["path"] in manifest_sizes:
            raise TestSnapshotError("스냅샷 파일 크기 또는 중복 항목이 잘못됐습니다")
        manifest_sizes[item["path"]] = size

    entries: list[tuple[zipfile.ZipInfo, PurePosixPath]] = []
    seen: set[str] = set()
    total = 0
    for info in infos:
        if info.filename in seen:
            raise TestSnapshotError(f"ZIP에 중복 DB 항목이 있습니다: {info.filename}")
        seen.add(info.filename)
        safe_path = _safe_db_entry(info.filename)
        if manifest_sizes.get(info.filename) != info.file_size:
            raise TestSnapshotError(f"manifest와 ZIP 크기가 다릅니다: {info.filename}")
        total += info.file_size
        if total > MAX_UNCOMPRESSED_BYTES:
            raise TestSnapshotError("스냅샷 압축 해제 크기가 허용 상한을 넘었습니다")
        entries.append((info, safe_path))

    if set(manifest_sizes) != {info.filename for info, _ in entries}:
        raise TestSnapshotError("manifest와 ZIP의 DB 파일 목록이 다릅니다")
    if "db/content_hub.db" not in manifest_sizes:
        raise TestSnapshotError("스냅샷에 기본 content_hub.db가 없습니다")
    bad_crc = bundle.testzip()
    if bad_crc:
        raise TestSnapshotError(f"스냅샷 ZIP CRC 검증에 실패했습니다: {bad_crc}")
    return entries


def _validate_generic_sqlite(path: Path) -> None:
    try:
        with closing(sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)) as conn:
            row = conn.execute("PRAGMA integrity_check").fetchone()
    except sqlite3.DatabaseError as exc:
        raise TestSnapshotError(f"SQLite 파일을 읽을 수 없습니다: {path.name}") from exc
    if not row or str(row[0]).lower() != "ok":
        raise TestSnapshotError(f"SQLite 무결성 검사에 실패했습니다: {path.name}")


def extract_test_snapshot_archive(archive: Path, destination: Path) -> list[Path]:
    """검증된 DB 번들을 새 ``destination``에 설치한다. 기존 폴더에는 절대 덮어쓰지 않는다."""
    if destination.exists():
        raise TestSnapshotError(f"설치 대상이 이미 존재합니다: {destination}")

    installed: list[Path] = []
    try:
        with zipfile.ZipFile(archive, "r") as bundle:
            manifest = _read_manifest(bundle)
            entries = _validate_archive_entries(bundle, manifest)
            total = sum(info.file_size for info, _ in entries)
            free = shutil.disk_usage(destination.parent).free
            if free < total + MIN_FREE_RESERVE_BYTES:
                raise TestSnapshotError("스냅샷을 풀 디스크 여유 공간이 부족합니다")
            destination_root = destination.resolve()
            for info, relative in entries:
                target = destination.joinpath(*relative.parts).resolve()
                if destination_root not in target.parents:
                    raise TestSnapshotError(f"설치 대상 밖의 경로입니다: {relative}")
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(info, "r") as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
                installed.append(target)

        primary = destination / "db" / "content_hub.db"
        try:
            validate_hub_db(primary, require_integrity=True)
        except HubDbValidationError as exc:
            raise TestSnapshotError(f"기본 MV Hub DB 검증에 실패했습니다: {exc.reason}") from exc
        for path in installed:
            if path != primary:
                _validate_generic_sqlite(path)
        return installed
    except zipfile.BadZipFile as exc:
        if destination.exists():
            shutil.rmtree(destination, ignore_errors=True)
        raise TestSnapshotError("스냅샷 ZIP 파일이 손상됐습니다") from exc
    except BaseException:
        if destination.exists():
            shutil.rmtree(destination, ignore_errors=True)
        raise
