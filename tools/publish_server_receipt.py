"""Publish one passed source-only gate receipt as <dest>/<commit>.json for staged server updates.

Run on the release PC after tools/predeploy_gate.ps1 passed for the selected main commit:
  python tools/publish_server_receipt.py --receipt <validation-*.json> --dest \\\\NAS\\...\\server-receipts
The server consumes the same bytes with the same validator; this checks the receipt's own consistency
(the stage byte comparison is only possible on the server). It is not issuer authentication.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from server_activation import validate_source_receipt  # noqa: E402
from app.services.release_contract import document  # noqa: E402

COMMIT = re.compile(r'[0-9a-f]{40}')


def publish(receipt: Path, dest: Path) -> Path:
    raw = receipt.read_bytes()
    value = document(raw)
    source = value.get('source') if isinstance(value.get('source'), dict) else {}
    commit = source.get('commit')
    # The commit becomes a file name: never let a crafted value leave the destination folder.
    if not isinstance(commit, str) or not COMMIT.fullmatch(commit):
        raise ValueError('receipt_commit_invalid')
    rows = source.get('files') if isinstance(source.get('files'), list) else []
    inputs = {row.get('path'): row.get('sha256') for row in rows if isinstance(row, dict) and row.get('tracked') is True}
    validate_source_receipt(value, commit, inputs)
    final = dest / (commit + '.json')
    temp = dest / (commit + '.json.tmp-' + uuid.uuid4().hex)
    try:  # creation, write and publish share one cleanup scope: no partial file survives a failure
        with temp.open('xb') as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        try:
            os.rename(temp, final)  # never replaces an existing name on Windows
        except FileExistsError:
            if final.read_bytes() != raw:
                raise ValueError('published_receipt_differs')
    finally:
        temp.unlink(missing_ok=True)
    return final


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--dest', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(publish(args.receipt, args.dest))
    except (OSError, ValueError) as exc:
        print('[ERROR] Receipt not published: ' + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
