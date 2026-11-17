"""Shared-server TLS policy. Status readers never open the private key."""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import ssl
import stat
import sys
import urllib.error
import urllib.request

TLS_ERROR_EXIT = 3
_override_logged = False

class TLSConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Configuration:
    state: str
    cert: Path
    key: Path
    error: str = ''

    @property
    def scheme(self) -> str:
        if self.state == 'error':
            raise TLSConfigError(self.error)
        return 'https' if self.state == 'on' else 'http'


def _context(cert: Path) -> ssl.SSLContext:
    context = ssl.create_default_context(cafile=str(cert))
    context.verify_flags |= ssl.VERIFY_X509_STRICT | ssl.VERIFY_X509_PARTIAL_CHAIN
    return context


def directory() -> Path:
    global _override_logged
    override = os.environ.get('MVHUB_SERVER_TLS_DIR', '').strip()
    if override and not _override_logged:
        print('[server-tls] MVHUB_SERVER_TLS_DIR override active', file=sys.stderr)
        _override_logged = True
    programdata = os.environ.get('PROGRAMDATA', '').strip()
    if not override and not programdata:
        raise TLSConfigError('server_tls_directory_unknown')
    return Path(override) if override else Path(programdata) / 'MVHub/server-tls'


def read_config() -> Configuration:
    try:
        folder = directory()
    except TLSConfigError as exc:
        return Configuration('error', Path(), Path(), str(exc))
    cert, key = folder / 'server.pem', folder / 'server.key'
    try:
        try:
            (folder / 'promote.pending').lstat()
        except FileNotFoundError:
            pass
        else:
            raise TLSConfigError('server_tls_promotion_pending')
        present = []
        for path in (cert, key):
            try:
                info = path.stat()
            except FileNotFoundError:
                present.append(False)
            else:
                if not stat.S_ISREG(info.st_mode):
                    raise TLSConfigError('server_tls_not_regular_file')
                present.append(True)
        if not any(present):
            return Configuration('off', cert, key)
        if not all(present):
            raise TLSConfigError('incomplete_server_tls_configuration')
        _context(cert)
        return Configuration('on', cert, key)
    except (OSError, ValueError):
        return Configuration('error', cert, key, 'server_tls_configuration_error')


def certificate_expiry(cert: Path, *, now: datetime | None = None) -> tuple[datetime, float] | None:
    """Return UTC expiry and remaining days, reading only the public certificate."""
    try:
        # Private CPython API: display-only on our pinned runtime; absence means unknown.
        import _ssl
        decoded = _ssl._test_decode_cert(str(cert))
        expires = datetime.fromtimestamp(ssl.cert_time_to_seconds(decoded['notAfter']), timezone.utc)
        remaining = (expires - (now or datetime.now(timezone.utc))).total_seconds() / 86400
        return expires, remaining
    except (AttributeError, OSError, ValueError, KeyError, TypeError):
        return None


def client_context(config: Configuration | None = None) -> ssl.SSLContext | None:
    config = config or read_config()
    if config.state == 'error':
        raise TLSConfigError(config.error)
    try:
        return _context(config.cert) if config.state == 'on' else None
    except (OSError, ValueError) as exc:
        raise TLSConfigError('server_tls_configuration_error') from exc


def server_files(config: Configuration) -> tuple[str, str]:
    if config.state != 'on':
        raise TLSConfigError(config.error or 'server_tls_not_enabled')
    return str(config.cert), str(config.key)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def opener(config: Configuration):
    handlers = [urllib.request.ProxyHandler({}), NoRedirect()]
    context = client_context(config)
    if context is not None:
        handlers.append(urllib.request.HTTPSHandler(context=context))
    return urllib.request.build_opener(*handlers)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--probe', type=int)
    action.add_argument('--scheme', action='store_true')
    args = parser.parse_args(argv)
    if args.probe is not None and not 0 < args.probe < 65536:
        parser.error('invalid port')
    try:
        config = read_config()
        scheme = config.scheme
        if args.scheme:
            print(scheme)
            return 0
        with opener(config).open(f'{scheme}://127.0.0.1:{args.probe}/api/ready', timeout=3) as response:
            payload = json.loads(response.read(65536))
            return 0 if response.status == 200 and payload.get('status') == 'ready' else 1
    except (TLSConfigError, ssl.SSLCertVerificationError):
        print('TLS configuration or certificate verification failed', file=sys.stderr)
        return TLS_ERROR_EXIT
    except urllib.error.URLError as exc:
        return TLS_ERROR_EXIT if isinstance(exc.reason, ssl.SSLCertVerificationError) else 1
    except (OSError, ValueError, AttributeError):
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
