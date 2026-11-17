"""Immutable balance wire contract; no database or HTTP dependencies."""
from __future__ import annotations

import hashlib
import json
import math
import struct
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext
from uuid import UUID

VERSION = 1
MAX_CENTS = 9007199254740991
MAX_OBSERVATIONS = 100
FIELDS = ('observation_id', 'collection_id', 'collector_id', 'collection_seq',
          'workspace_id', 'source', 'started_at_ms', 'observed_at_ms',
          'reported_credits', 'credits_c', 'cli_version')


def amount(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        raise ValueError('invalid_amount')
    if len(str(value)) > 80:
        raise ValueError('invalid_amount')
    try:
        number = Decimal(str(value))
        if not number.is_finite() or abs(number) > Decimal(MAX_CENTS) / 100:
            raise ValueError('invalid_amount')
        with localcontext() as context:
            context.prec = 100
            cents = int((number * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))
        if abs(cents) > MAX_CENTS:
            raise ValueError('invalid_amount')
        if abs(number) < 131072:
            return cents, 'workspace_list_binary32', 0
        binary = struct.unpack('!f', struct.pack('!f', float(number)))[0]
        if Decimal.from_float(binary) != number:
            return cents, 'workspace_list_unknown', None
        spacing = 2.0 ** (math.frexp(abs(binary))[1] - 24)
        return cents, 'workspace_list_binary32', math.floor(0.5 + 50 * spacing)
    except (InvalidOperation, OverflowError, struct.error) as exc:
        raise ValueError('invalid_amount') from exc


def integer(value, minimum=0):
    if type(value) is not int or not minimum <= value <= MAX_CENTS:
        raise ValueError('invalid_integer')
    return value


def normalize(value):
    if not isinstance(value, dict):
        raise ValueError('invalid_observation')
    item = {key: value.get(key) for key in FIELDS}
    for key in ('observation_id', 'collection_id', 'collector_id'):
        try:
            if not isinstance(item[key], str) or str(UUID(item[key])) != item[key]:
                raise ValueError('invalid_id')
        except (ValueError, AttributeError) as exc:
            raise ValueError('invalid_id') from exc
    integer(item['collection_seq'], 1)
    for key in ('started_at_ms', 'observed_at_ms'):
        integer(item[key])
    workspace = item['workspace_id']
    if not isinstance(workspace, str) or not workspace.strip() or len(workspace) > 256:
        raise ValueError('invalid_workspace')
    if item['source'] != 'workspace_list':
        raise ValueError('invalid_source')
    if not isinstance(item['reported_credits'], str):
        raise ValueError('invalid_amount')
    cents, kind, error = amount(item['reported_credits'])
    if type(item['credits_c']) is not int or item['credits_c'] != cents:
        raise ValueError('amount_mismatch')
    version = item['cli_version']
    if version is not None and (not isinstance(version, str) or len(version) > 128):
        raise ValueError('invalid_cli_version')
    return item, kind, error


def payload_hash(item):
    raw = json.dumps({key: item.get(key) for key in FIELDS}, ensure_ascii=False,
                     sort_keys=True, separators=(',', ':'), allow_nan=False)
    return hashlib.sha256(raw.encode('utf8')).hexdigest()


def validate_batch(version, observations):
    if type(version) is not int or version != VERSION:
        raise ValueError('unsupported_version')
    if not isinstance(observations, list) or len(observations) > MAX_OBSERVATIONS:
        raise ValueError('invalid_observation_count')


def matching_ack(receipt, items, receiver):
    """A legacy 200, foreign ID, wrong hash or duplicate ACK cannot settle a queue."""
    if not isinstance(receipt, dict) or type(receipt.get('version')) is not int:
        raise ValueError('invalid_ack')
    if receipt['version'] != VERSION or receipt.get('receiver_kind') != receiver:
        raise ValueError('invalid_ack')
    database_id = receipt.get('receiver_database_id')
    if not isinstance(database_id, str) or not database_id:
        raise ValueError('invalid_ack')
    expected = {item['observation_id']: payload_hash(item) for item in items}
    seen = set()
    for group in ('stored', 'conflicts', 'rejected'):
        entries = receipt.get(group)
        if not isinstance(entries, list):
            raise ValueError('invalid_ack')
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError('invalid_ack')
            key = entry.get('observation_id')
            if key not in expected or key in seen or entry.get('payload_sha256') != expected[key]:
                raise ValueError('invalid_ack')
            if group == 'stored':
                integer(entry.get('received_at_ms'))
            seen.add(key)
    return receipt
