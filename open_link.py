"""Windowless mvhub:// handler. Standard library only; safe under pythonw -I -S."""
from __future__ import annotations

import ctypes
import hashlib
import hmac
import json
import os
from pathlib import Path
import queue
import re
import secrets
import threading
import time
import urllib.error
import urllib.request
import sys

ID = re.compile(r'[A-Za-z0-9_.:-]{1,200}\Z')
KEY = re.compile(r'[A-Za-z0-9_-]{43}\Z')
RESULTS = frozenset(('opened', 'denied', 'no_window', 'busy', 'unsupported'))
TIME_BUDGET = 8.0
MESSAGES = {
    'restart': 'MV hub 를 다시 켜 주세요',
    'offline': 'MV hub 가 꺼져 있어요. MV hub 를 켠 뒤 다시 눌러 주세요',
    'denied': '이 계정에서 볼 수 없는 코멘트예요',
    'no_window': 'MV hub 창이 열려 있지 않아요',
    'busy': '잠시 뒤 다시 눌러 주세요',
    'unsupported': 'MV hub 를 업데이트한 뒤 다시 눌러 주세요',
}


def install_id(root: Path) -> str:
    return hashlib.sha1(str(root.resolve()).casefold().encode('utf-8')).hexdigest()[:10]


def connection_path(root: Path, port: int) -> Path:
    base = os.environ.get('LOCALAPPDATA')
    if not base:
        raise ValueError('missing local directory')
    return Path(base) / 'MVHub' / 'open-link' / f'{install_id(root)}-{port}.json'


def parse_args(argv: list[str]) -> tuple[int, str, str] | None:
    if len(argv) != 4 or argv[1] != '--port' or not re.fullmatch(r'[0-9]{1,5}', argv[2]):
        return None
    port, url = int(argv[2]), argv[3]
    if not 1 <= port <= 65535 or len(url) > 512:
        return None
    # Reject encoding/whitespace before urlsplit can normalize untrusted input.
    match = re.fullmatch(r'mvhub://open/([A-Za-z0-9_.:-]{1,200})\?c=([A-Za-z0-9_.:-]{1,200})', url)
    return (port, *match.groups()) if match else None


def read_connection(root: Path, port: int) -> dict:
    with connection_path(root, port).open('rb') as stream:
        raw = stream.read(4097)
    if len(raw) > 4096:
        raise ValueError('invalid connection')
    value = json.loads(raw)
    if (not isinstance(value, dict) or type(value.get('port')) is not int or value['port'] != port
            or not isinstance(value.get('key'), str) or not KEY.fullmatch(value['key'])
            or not isinstance(value.get('install_root'), str)
            or str(Path(value['install_root']).resolve()).casefold() != str(root.resolve()).casefold()):
        raise ValueError('invalid connection')
    return value


def request_signature(key, stamp, nonce, port, generation, comment):
    message = f'mvhub-open-req\n{stamp}\n{nonce}\n{port}\n{generation}\n{comment}'
    return hmac.new(key.encode('utf-8'), message.encode('utf-8'), hashlib.sha256).hexdigest()


def response_proof(key, nonce, result, hwnd):
    message = f'mvhub-open-res\n{nonce}\n{result}\n{hwnd}'
    return hmac.new(key.encode('utf-8'), message.encode('utf-8'), hashlib.sha256).hexdigest()


def verified_response(raw, key, nonce):
    value = json.loads(raw)
    if (not isinstance(value, dict) or not isinstance(value.get('result'), str)
            or value['result'] not in RESULTS or type(value.get('hwnd')) is not int
            or not 0 <= value['hwnd'] <= 2**64 - 1 or not isinstance(value.get('proof'), str)
            or not re.fullmatch(r'[0-9a-f]{64}', value['proof'])):
        raise ValueError('invalid proof')
    if not hmac.compare_digest(response_proof(key, nonce, value['result'], value['hwnd']), value['proof']):
        raise ValueError('invalid proof')
    return value['result'], value['hwnd']


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def exchange(port, generation, comment, key, deadline):
    nonce, stamp = secrets.token_urlsafe(24), str(time.time_ns() // 1_000_000)
    body = json.dumps({'generation_id': generation, 'comment_id': comment}).encode('utf-8')
    request = urllib.request.Request(f'http://127.0.0.1:{port}/api/open/native', data=body, headers={
        'Content-Type': 'application/json', 'X-MVHub-Open-Time': stamp, 'X-MVHub-Open-Nonce': nonce,
        'X-MVHub-Open-Sig': request_signature(key, stamp, nonce, port, generation, comment),
    })
    # A daemon contains even a slow-drip peer within the caller's overall deadline.
    with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(
            request, timeout=max(0.001, deadline - time.monotonic())) as response:
        raw = response.read(4097)
    if len(raw) > 4096:
        raise ValueError('invalid response')
    return verified_response(raw, key, nonce)


class Windows:
    def __init__(self):
        from ctypes import wintypes as W
        self.W = W
        self.u = u = ctypes.WinDLL('user32', use_last_error=True)
        u.IsWindow.argtypes = u.IsIconic.argtypes = [W.HWND]
        u.GetPropW.argtypes, u.GetPropW.restype = [W.HWND, W.LPCWSTR], W.HANDLE
        u.ShowWindow.argtypes = [W.HWND, ctypes.c_int]
        u.SetForegroundWindow.argtypes, u.SetForegroundWindow.restype = [W.HWND], W.BOOL
        u.GetForegroundWindow.restype = W.HWND
        class FLASHWINFO(ctypes.Structure):
            _fields_ = [('cbSize', W.UINT), ('hwnd', W.HWND), ('dwFlags', W.DWORD),
                        ('uCount', W.UINT), ('dwTimeout', W.DWORD)]
        self.flash_info = FLASHWINFO
        u.FlashWindowEx.argtypes = [ctypes.POINTER(FLASHWINFO)]

    def approved(self, hwnd, prop):
        return bool(self.u.IsWindow(hwnd) and self.u.GetPropW(hwnd, prop))

    def focus(self, hwnd):
        if self.u.IsIconic(hwnd):
            self.u.ShowWindow(hwnd, 9)
        if self.u.SetForegroundWindow(hwnd):
            # Another process's activation lands a moment later (2026-11-05 live: flashed after it came forward).
            until = time.monotonic() + 0.3
            while self.u.GetForegroundWindow() != hwnd:
                if time.monotonic() >= until:
                    break
                time.sleep(0.03)
            else:
                return
        info = self.flash_info(ctypes.sizeof(self.flash_info), hwnd, 3, 3, 0)
        self.u.FlashWindowEx(ctypes.byref(info))


def focus_window(hwnd, root, deadline, api=None):
    if not hwnd or time.monotonic() >= deadline:
        return
    api = api or Windows()
    until = min(deadline, time.monotonic() + 1.5)
    prop = f'MVHubAppWindow_{install_id(root)}'
    while time.monotonic() < until:
        if api.approved(hwnd, prop):
            api.focus(hwnd)
            return
        time.sleep(min(0.1, max(0, until - time.monotonic())))


def message_box(kind):
    if os.name == 'nt':
        ctypes.windll.user32.MessageBoxW(None, MESSAGES[kind], 'MV Hub', 0x40)


def run(argv, root=None):
    parsed = parse_args(argv)
    if parsed is None:
        return
    deadline = time.monotonic() + TIME_BUDGET
    root = root or Path(__file__).resolve().parent
    results = queue.Queue(maxsize=1)
    def request():
        try:
            connection = read_connection(root, parsed[0])
            if time.monotonic() >= deadline:
                results.put(('restart', 0))
                return
            results.put(exchange(*parsed, connection['key'], deadline))
        except FileNotFoundError:
            results.put(('offline', 0))
        except urllib.error.HTTPError:
            results.put(('restart', 0))
        except urllib.error.URLError as exc:
            results.put(('offline' if isinstance(exc.reason, ConnectionRefusedError) else 'restart', 0))
        except Exception:
            # Never print an exception containing file contents or request material.
            results.put(('restart', 0))
    threading.Thread(target=request, daemon=True).start()
    try:
        result, hwnd = results.get(timeout=max(0.001, deadline - time.monotonic()))
    except queue.Empty:
        result, hwnd = 'restart', 0
    if result == 'opened':
        try:
            focus_window(hwnd, root, deadline)
        except Exception:
            pass  # Opening succeeded; unavailable focus is not a navigation failure.
    else:
        message_box(result)


if __name__ == '__main__':
    run(sys.argv)
