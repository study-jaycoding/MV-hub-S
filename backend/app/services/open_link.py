"""Per-process native-link key and replay guard; publish only after serve.py binds."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import tempfile
import time

from .. import config

ID = re.compile(r'[A-Za-z0-9_.:-]{1,200}\Z')
NONCE = re.compile(r'[A-Za-z0-9_-]{32}\Z')
SIGNATURE = re.compile(r'[0-9a-f]{64}\Z')
LIMIT = 20_000


class LinkSession:
    def __init__(self, key, port, born):
        self.key, self.port, self.born = key, port, born
        self.nonces = set()

    def authenticate(self, headers, body, now=None):
        """No await: validate and reserve atomically on the request event loop."""
        stamp, nonce, signature = (headers.get(name, '') for name in
                                  ('x-mvhub-open-time', 'x-mvhub-open-nonce', 'x-mvhub-open-sig'))
        if (not re.fullmatch(r'[0-9]{1,13}', stamp) or not NONCE.fullmatch(nonce)
                or not SIGNATURE.fullmatch(signature) or not isinstance(body, dict)
                or set(body) != {'generation_id', 'comment_id'}
                or any(not isinstance(body[k], str) or not ID.fullmatch(body[k]) for k in body)):
            raise ValueError('unauthorized')
        now = time.time_ns() // 1_000_000 if now is None else now
        if abs(now - int(stamp)) > 10_000 or int(stamp) < self.born:
            raise ValueError('unauthorized')
        message = f"mvhub-open-req\n{stamp}\n{nonce}\n{self.port}\n{body['generation_id']}\n{body['comment_id']}"
        expected = hmac.new(self.key.encode(), message.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature) or nonce in self.nonces:
            raise ValueError('unauthorized')
        if len(self.nonces) >= LIMIT:
            return nonce, False  # No eviction, no opening; signed busy response.
        self.nonces.add(nonce)
        return nonce, True

    def response(self, nonce, result, hwnd=0):
        message = f'mvhub-open-res\n{nonce}\n{result}\n{hwnd}'
        proof = hmac.new(self.key.encode(), message.encode(), hashlib.sha256).hexdigest()
        return {'result': result, 'hwnd': hwnd, 'proof': proof}


session: LinkSession | None = None


def publish():
    """Called once by serve.py after listen. Shutdown deliberately leaves the file."""
    global session
    session = None
    if os.environ.get('MVHUB_OPEN_LINK') != '1' or config.AUTH_ENABLED:
        return
    root = config.BACKEND_DIR.parent.resolve()
    local = os.environ.get('LOCALAPPDATA')
    if not local:
        return
    identity = hashlib.sha1(str(root).casefold().encode()).hexdigest()[:10]
    target = Path(local) / 'MVHub' / 'open-link' / f'{identity}-{config.PORT}.json'
    candidate = LinkSession(secrets.token_urlsafe(32), config.PORT, time.time_ns() // 1_000_000)
    temporary = None
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        value = {'port': config.PORT, 'key': candidate.key, 'install_root': str(root), 'written_at': candidate.born}
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=target.parent, delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream)
        os.replace(temporary, target)
        if json.loads(target.read_bytes()) == value:
            session = candidate
    except (OSError, ValueError):
        pass  # Native links unavailable, ordinary hub startup is unaffected.
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
