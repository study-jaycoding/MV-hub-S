"""Pre-migration snapshots; schema inspection stays independent of backup IO."""
from __future__ import annotations

from contextlib import closing, suppress
from datetime import datetime, timezone
import logging
from pathlib import Path
import re
import sqlite3
import time
from uuid import uuid4

from .. import schema_compat


def backup_before_baseline(path: Path, kind: str) -> Path | None:
    """Preserve an existing unversioned DB before any migration or recovery write."""
    from .backup_verify import create_sqlite_snapshot
    from .sqlite_db import read_only_uri

    temporary = None
    try:
        if not path.is_file() or not path.stat().st_size:
            return None
        if schema_compat.inspect_database(path, kind).status != 'unversioned':
            return None
        parent = path.parent
        if parent.parent.name == 'acct' and parent.parent.parent.name == 'db':
            folder = parent.parent.parent.parent / 'backups' / parent.name
        elif parent.name == 'db':
            folder = parent.parent / 'backups'
        elif parent.name == 'backend':
            from ..config import DATA_DIR
            folder = DATA_DIR / 'backups'
        else:
            folder = parent / 'backups'
        folder /= 'pre-dev2-baseline'
        folder.mkdir(parents=True, exist_ok=True)
        prefix = f'{path.name}.pre-dev2-baseline-{schema_compat.database_key(path)[:8]}-'
        pattern = re.compile(re.escape(prefix) + r'\d{8}_\d{6}_\d{6}-[0-9a-f]{32}(-first)?\.db')
        temporary_pattern = re.compile(r'\.' + pattern.pattern + r'\.tmp(?:-journal|-wal|-shm)?')
        cutoff = time.time() - 86400.0
        for old in folder.iterdir():
            if temporary_pattern.fullmatch(old.name):
                with suppress(OSError):
                    if old.stat().st_mtime < cutoff:
                        old.unlink()
        stamp = datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S_%f')
        target = folder / f'{prefix}{stamp}-{uuid4().hex}.db'
        temporary = target.with_name(f'.{target.name}.tmp')
        journal = Path(str(path) + '-journal')
        if journal.is_file() and journal.stat().st_size:
            schema_compat._recover_database_copy(path, kind, temporary)
        else:
            create_sqlite_snapshot(path, temporary)
        if not temporary.stat().st_size:
            raise sqlite3.DatabaseError('baseline_backup_empty')
        with closing(sqlite3.connect(read_only_uri(temporary, immutable=True), uri=True)) as conn:
            if conn.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
                raise sqlite3.DatabaseError('baseline_backup_integrity_failed')
        # shortcut: concurrent first publications may both be retained; serialize if a strict cap is needed.
        if not any(pattern.fullmatch(p.name) and p.name.endswith('-first.db') and p.is_file()
                   for p in folder.iterdir()):
            target = target.with_name(target.stem + '-first.db')
        temporary.rename(target)
        # Keep the original pre-conversion state plus the two latest attempts.
        copies = sorted(p for p in folder.iterdir() if pattern.fullmatch(p.name)
                        and not p.name.endswith('-first.db') and p.is_file())
        for old in copies[:-2]:
            try:
                old.unlink(missing_ok=True)
            except OSError as exc:
                logging.getLogger(schema_compat.__name__).warning('baseline_backup_prune_failed: error=%s', type(exc).__name__)
        return target
    except schema_compat.SchemaCompatibilityError:
        raise
    except Exception as exc:
        # Exception text can contain account paths; log only the safe error category/code.
        logging.getLogger(schema_compat.__name__).error(
            'baseline_backup_failed: kind=%s error=%s code=%s', kind,
            type(exc).__name__, getattr(exc, 'sqlite_errorname', None) or getattr(exc, 'errno', None))
        raise schema_compat.SchemaCompatibilityError('baseline_backup_failed') from None
    finally:
        if temporary is not None:
            for suffix in ('', '-journal', '-wal', '-shm'):
                with suppress(OSError):
                    Path(str(temporary) + suffix).unlink(missing_ok=True)
