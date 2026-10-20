"""Versioned backup metadata shared by capture, delivery, storage and restore.

B1 pins a reconcilable content/trash pair, not completed business operations or
external writers. Manage remains an independent snapshot even in that set.
"""
from __future__ import annotations

from dataclasses import asdict
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re

from .. import schema_compat
from . import trash_transfer

VERSION = 2
PAYLOAD_VERSION = 1
WORKER_FORMAT = 'mvhub-worker-backup-set'
LOCAL_FORMAT = 'mvhub-local-backup-set'
UNKNOWN = 'consistency_unknown'
INDEPENDENT = 'db_snapshots_independent'
PINNED = 'b1_pair_pinned_reconcilable'
_HEX = re.compile(r'^[0-9a-f]{64}$')
_SCHEMA_FIELDS = {'status', 'database_kind', 'database_id', 'schema_version',
                  'components', 'minimum_reader_protocol', 'minimum_writer_protocol'}
_COMMON_FIELDS = {'format', 'format_version', 'set_id', 'account_scope_digest',
                  'payload_version', 'captured_at', 'consistency_kind', 'consistency_roles', 'roles'}
_WORKER_FIELDS = {'backup_set_id', 'created_at', 'local_stamp', 'schema_version',
                  'app_version', 'device', 'parent_backup_set_id', 'summary'}


def canonical(value: dict) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def manifest_digest(value: dict) -> str:
    return hashlib.sha256(canonical(value).encode('utf-8')).hexdigest()


def account_digest(account_slug: str) -> str:
    return hashlib.sha256(account_slug.encode('utf-8')).hexdigest()


def file_digest(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def schema_info(path: Path, role: str) -> dict:
    value = asdict(schema_compat.inspect_database(path, role))
    value['components'] = list(value['components'])
    return value


def role_info(path: Path, role: str) -> dict:
    for suffix in ('-wal', '-journal'):
        sidecar = Path(str(path) + suffix)
        if sidecar.exists() and sidecar.stat().st_size:
            raise ValueError('backup database is not standalone')
    return {'size': path.stat().st_size, 'sha256': file_digest(path), 'schema': schema_info(path, role)}


def seal(value: dict) -> dict:
    value = dict(value)
    identity = {key: item for key, item in value.items() if key not in {'set_id', 'backup_set_id'}}
    value['set_id'] = manifest_digest(identity)
    if value['format'] == WORKER_FORMAT:
        value['backup_set_id'] = value['set_id']
    return value


def check_version(value: dict) -> None:
    if (not isinstance(value, dict) or type(value.get('format_version')) is not int
            or value['format_version'] not in {1, VERSION}):
        raise ValueError('unsupported backup manifest version')
    if value['format_version'] == 1:
        if set(value) & (_COMMON_FIELDS - {'format', 'format_version', 'roles'}):
            raise ValueError('v2 backup metadata in legacy manifest')
        roles = value.get('roles')
        if not isinstance(roles, dict):
            raise ValueError('invalid legacy backup roles')
        for info in roles.values():
            if isinstance(info, dict) and 'schema' in info:
                raise ValueError('v2 schema in legacy manifest')


def validate(value: dict, *, local: bool = False) -> None:
    """V2 is exact. V1 normalization belongs to its existing compatibility reader."""
    fields = _COMMON_FIELDS | (set() if local else _WORKER_FIELDS)
    if (not isinstance(value, dict) or set(value) != fields
            or value.get('format') != (LOCAL_FORMAT if local else WORKER_FORMAT)
            or type(value.get('format_version')) is not int or value['format_version'] != VERSION
            or type(value.get('payload_version')) is not int or value['payload_version'] != PAYLOAD_VERSION):
        raise ValueError('unsupported backup manifest fields or version')
    for key in ('set_id', 'account_scope_digest'):
        if not isinstance(value[key], str) or not _HEX.fullmatch(value[key]):
            raise ValueError('invalid backup identity')
    if value != seal(value):
        raise ValueError('backup manifest identity mismatch')
    roles = value['roles']
    allowed = {'content', 'trash', 'manage'} if local else {'content', 'trash'}
    if not isinstance(roles, dict) or 'content' not in roles or not set(roles) <= allowed:
        raise ValueError('invalid backup roles')
    for role, info in roles.items():
        if (not isinstance(info, dict) or set(info) != {'size', 'sha256', 'schema'}
                or type(info['size']) is not int or info['size'] <= 0
                or not isinstance(info['sha256'], str) or not _HEX.fullmatch(info['sha256'])):
            raise ValueError('invalid backup role integrity')
        schema = info['schema']
        if not isinstance(schema, dict) or set(schema) != _SCHEMA_FIELDS or schema['database_kind'] != role:
            raise ValueError('invalid backup schema metadata')
        if schema['status'] not in {'compatible', 'unversioned'}:
            raise ValueError('unsupported backup schema status')
        if (not isinstance(schema['components'], list)
                or not all(isinstance(component, str) for component in schema['components'])
                or any(type(schema[key]) is not int or schema[key] < 0 for key in
                       ('schema_version', 'minimum_reader_protocol', 'minimum_writer_protocol'))):
            raise ValueError('invalid backup schema version')
        if schema['status'] == 'unversioned' and (schema['database_id'] is not None or schema['schema_version'] != 0):
            raise ValueError('invalid unversioned database identity')
    kind, covered = value['consistency_kind'], value['consistency_roles']
    if (kind not in {UNKNOWN, INDEPENDENT, PINNED} or not isinstance(covered, list)
            or (kind == PINNED and (covered != ['content', 'trash'] or 'trash' not in roles))
            or (kind == INDEPENDENT and covered != sorted(roles))
            or (kind == UNKNOWN and covered != [])):
        raise ValueError('unsupported backup consistency')
    captured = value['captured_at']
    if captured is None:
        if kind != UNKNOWN:
            raise ValueError('missing backup capture time')
    else:
        if not isinstance(captured, str) or len(captured) > 64:
            raise ValueError('invalid backup capture time')
        try:
            parsed = datetime.fromisoformat(captured)
        except ValueError as exc:
            raise ValueError('invalid backup capture time') from exc
        if parsed.tzinfo is None:
            raise ValueError('backup capture timezone missing')


def verify_files(value: dict, paths: dict[str, Path], *, local: bool = False,
                 expected_account_digest: str | None = None) -> None:
    validate(value, local=local)
    if expected_account_digest is not None and value['account_scope_digest'] != expected_account_digest:
        raise ValueError('backup account scope mismatch')
    if set(paths) != set(value['roles']):
        raise ValueError('backup files differ')
    for role, path in paths.items():
        if role_info(path, role) != value['roles'][role]:
            raise ValueError('backup bytes or schema differ')
    # A pinned claim cannot excuse an invalid pair or missing B1 guards.
    try:
        trash_transfer.validate_pair(paths['content'], paths.get('trash'))
    except trash_transfer.TransferRecoveryRequired as exc:
        raise ValueError('backup transfer pair invalid') from exc
    if value['consistency_kind'] == PINNED:
        import sqlite3
        from contextlib import closing
        from .sqlite_db import read_only_uri
        with closing(sqlite3.connect(read_only_uri(paths['content'], immutable=True), uri=True)) as conn:
            if not trash_transfer.enabled(conn):
                raise ValueError('pinned backup is not a B1 pair')


def local_path(content: Path) -> Path:
    return content.with_suffix('.manifest.json')


def read_local(content: Path) -> dict | None:
    path = local_path(content)
    if not path.exists():
        return None
    if path.stat().st_size > 64 * 1024:
        raise ValueError('backup manifest too large')
    value = json.loads(path.read_text('utf-8'))
    validate(value, local=True)
    stamp = content.name[len('content_hub_'):-3]
    prefixes = {'content': 'content_hub_', 'trash': 'content_trash_', 'manage': 'manage_hub_'}
    paths = {role: content.parent / f'{prefixes[role]}{stamp}.db' for role in value['roles']}
    present = {role for role, prefix in prefixes.items() if (content.parent / f'{prefix}{stamp}.db').is_file()}
    if present != set(paths):
        raise ValueError('backup manifest members differ')
    verify_files(value, paths, local=True)
    return value
