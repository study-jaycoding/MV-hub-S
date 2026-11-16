"""서버 PC 전용 TLS 준비/반영 명령. 개인키는 표준 출력이나 오류에 싣지 않는다."""
from __future__ import annotations

import argparse
import base64
import ctypes
from ctypes import wintypes
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import ssl
import subprocess
import sys
import tempfile
import threading

import server_tls
from server_console import install
from server_console.main import _is_admin


class CertificateError(ValueError):
    pass


def _run(argv, *, stdout=subprocess.PIPE, extra_env=None):
    # OpenSSL 환경 설정으로 관리자 자식에 외부 설정/모듈을 주입하지 못하게 한다.
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith('OPENSSL_')}
    env.update(extra_env or {})
    try:
        result = subprocess.run(list(map(str, argv)), stdout=stdout, stderr=subprocess.PIPE,
                                env=env, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)
    except (OSError, subprocess.SubprocessError):
        raise CertificateError('관리 명령 실행 실패') from None
    if result.returncode:
        # 자식 출력에는 키나 운영 경로가 섞일 수 있으므로 전달하지 않는다.
        raise CertificateError('관리 명령 실패')
    return result.stdout


def trusted_openssl() -> Path:
    git = install.trusted_git()
    if git is None:
        raise CertificateError('신뢰된 Git for Windows 설치가 필요합니다')
    exe = git.parent.parent / 'usr/bin/openssl.exe'
    if not exe.is_file() or exe.is_symlink():
        raise CertificateError('신뢰된 Git OpenSSL을 찾지 못했습니다')
    version = _run([exe, 'version']).decode('ascii', errors='replace')
    match = re.match(r'OpenSSL (\d+)\.', version)
    if not match or int(match[1]) < 3:
        raise CertificateError('OpenSSL 3.0 이상이 필요합니다')
    return exe


def _powershell(script: str, *, extra_env=None):
    encoded = base64.b64encode(script.encode('utf-16-le')).decode('ascii')
    return _run([install.powershell_exe(), '-NoProfile', '-NonInteractive',
                 '-EncodedCommand', encoded], extra_env=extra_env)


def _acl_info(path: Path):
    raw = _powershell("$ErrorActionPreference='Stop'; "
                      "$a=Get-Acl -LiteralPath $env:MVHUB_ACL_PATH; "
                      "$rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | "
                      "ForEach-Object { @{sid=$_.IdentityReference.Value;rights=[int]$_.FileSystemRights;"
                      "type=[int]$_.AccessControlType;inherited=$_.IsInherited;"
                      "inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags} }); "
                      "@{owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;"
                      "protected=$a.AreAccessRulesProtected;rules=$rules} | ConvertTo-Json -Depth 4 -Compress",
                      extra_env={'MVHUB_ACL_PATH': str(path)})
    return json.loads(raw.decode('utf-8-sig'))


def set_acl(path: Path, *, public=False, directory=False) -> None:
    """SID 기반으로 DACL을 제한하고 실제 ACL을 다시 읽어 확인한다."""
    icacls = install.windows_dir() / 'System32/icacls.exe'
    wanted = {'S-1-5-18': 2032127, 'S-1-5-32-544': 2032127}  # FullControl
    if public or directory:
        wanted['S-1-5-32-545'] = 1179817 if directory else 1179785  # RX / R, including Synchronize
    grants = [f'*{sid}:{"(OI)(CI)" if directory and sid != "S-1-5-32-545" else ""}{"F" if rights == 2032127 else "RX" if directory else "R"}'
              for sid, rights in wanted.items()]
    _run([icacls, path, '/inheritance:r', '/grant:r', *grants])
    for rule in _acl_info(path)['rules']:
        if rule['type'] == 1 or rule['sid'] not in wanted:
            _run([icacls, path, '/remove:d' if rule['type'] == 1 else '/remove:g', '*' + rule['sid']])
    _set_owner(path)
    verify_acl(path, public=public, directory=directory)


def _set_owner(path):
    _run([install.windows_dir() / 'System32/icacls.exe', path, '/setowner', '*S-1-5-32-544'])


def verify_acl(path, *, public=False, directory=False):
    wanted = {'S-1-5-18': 2032127, 'S-1-5-32-544': 2032127}
    if public or directory:
        wanted['S-1-5-32-545'] = 1179817 if directory else 1179785
    actual = _acl_info(path)
    rules = actual['rules']
    if (actual.get('owner') not in {'S-1-5-18', 'S-1-5-32-544'} or not actual['protected'] or len(rules) != len(wanted)
            or any(r['type'] != 0 or r['inherited'] or r['sid'] not in wanted
                   or r['rights'] != wanted[r['sid']]
                   or r['inheritance'] != (3 if directory and r['sid'] != 'S-1-5-32-545' else 0)
                   or r['propagation'] != 0 for r in rules)):
        raise CertificateError('TLS 파일 권한 확인 실패')


def _plain_path(path: Path) -> None:
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return
    if getattr(info, 'st_file_attributes', 0) & 0x400:
        raise CertificateError('TLS 경로의 연결 지점은 허용하지 않습니다')


def _trusted_owner(path):
    info = _acl_info(path)
    if info['owner'] not in {'S-1-5-18', 'S-1-5-32-544'}:
        raise CertificateError('TLS 경로 소유자는 SYSTEM 또는 Administrators여야 합니다')
    return info


def _check_directory_access(path):
    info = _trusted_owner(path)
    # Already-open write handles survive DACL changes, so do not repair an unsafe directory.
    if any(r['type'] == 0 and r['sid'] not in {'S-1-5-18', 'S-1-5-32-544'}
           and r['rights'] & (0x10000 | 0x40 | 0x40000 | 0x80000 | 0x2 | 0x4 | 0x10000000 | 0x40000000)
           for r in info['rules']):
        raise CertificateError('TLS 폴더 또는 상위 폴더에 일반 사용자 변경 권한이 있습니다')


def _prepare_directory(directory, *, create=False):
    for path in (directory, *directory.parents):
        _plain_path(path)
    parent = directory.parent
    if not parent.exists() and create:
        parent.mkdir()
        set_acl(parent, directory=True)
    _check_directory_access(parent)
    if directory.exists():
        _check_directory_access(directory)
        if create:
            set_acl(directory, directory=True)
        else:
            verify_acl(directory, directory=True)
        allowed = {'server.pem', 'server.key', 'next.pem', 'next.key',
                   'previous.pem', 'previous.key', 'promote.pending'}
        for path in directory.iterdir():
            _plain_path(path)
            if path.name not in allowed or not path.is_file():
                raise CertificateError('TLS 폴더에 예상하지 않은 항목이 있습니다')
            _trusted_owner(path)
    elif create:
        directory.mkdir()
        set_acl(directory, directory=True)
    if not create:
        for path in directory.glob('*.key'):
            verify_acl(path)


def _create_key(path):
    """Create the key with a protected DACL before any other process can open it."""
    import msvcrt

    class SecurityAttributes(ctypes.Structure):
        _fields_ = [('length', wintypes.DWORD), ('descriptor', wintypes.LPVOID),
                    ('inherit', wintypes.BOOL)]

    advapi = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    convert = advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW
    convert.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(wintypes.LPVOID), wintypes.LPVOID]
    convert.restype = wintypes.BOOL
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  ctypes.POINTER(SecurityAttributes), wintypes.DWORD,
                                  wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.LocalFree.argtypes = [wintypes.LPVOID]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    descriptor = wintypes.LPVOID()
    if not convert('D:P(A;;FA;;;SY)(A;;FA;;;BA)', 1, ctypes.byref(descriptor), None):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        attrs = SecurityAttributes(ctypes.sizeof(SecurityAttributes), descriptor, False)
        handle = kernel.CreateFileW(str(path), 0x40000000, 0, ctypes.byref(attrs), 1, 0x00200000, None)
        if handle == wintypes.HANDLE(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel.LocalFree(descriptor)
    try:
        fd = msvcrt.open_osfhandle(handle, os.O_WRONLY | os.O_BINARY)
    except BaseException:
        kernel.CloseHandle(handle)
        path.unlink()
        raise
    try:
        return os.fdopen(fd, 'wb')
    except BaseException:
        os.close(fd)
        path.unlink()
        raise


def _require_admin():
    if os.name != 'nt' or not _is_admin():
        raise CertificateError('승격된 관리자 창에서 실행하세요')


def _inputs(ip: str, dns: str | None, days: int):
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        raise CertificateError('올바른 서버 IP가 필요합니다') from None
    if address.is_loopback or address.is_unspecified or address.is_multicast or '%' in ip:
        raise CertificateError('서버 IP로 루프백·미지정·멀티캐스트·범위 ID는 허용하지 않습니다')
    if dns is not None and not re.fullmatch(r'[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*', dns):
        raise CertificateError('DNS 이름이 올바르지 않습니다')
    if type(days) is not int or not 30 <= days <= 3650:
        raise CertificateError('기간은 30~3650일 정수여야 합니다')
    return str(address)


def fingerprint(cert: Path) -> str:
    der = ssl.PEM_cert_to_DER_cert(cert.read_text(encoding='ascii'))
    return hashlib.sha256(der).hexdigest()


def self_check(cert: Path, key: Path, exe: Path) -> list[str]:
    """D2 형식과 이름을 확인하고 TCP 연결은 항상 루프백 임시 포트로만 한다."""
    details = _run([exe, 'x509', '-in', cert, '-noout', '-text']).decode('ascii', errors='replace')
    required = (r'X509v3 Basic Constraints: critical\s+CA:FALSE',
                r'X509v3 Key Usage: critical\s+Digital Signature\s*\n',
                r'X509v3 Extended Key Usage:\s+TLS Web Server Authentication\s*\n',
                r'X509v3 Subject Key Identifier:', r'X509v3 Authority Key Identifier:',
                r'ASN1 OID: prime256v1')
    if not all(re.search(p, details) for p in required):
        raise CertificateError('D2 인증서 형식이 아닙니다')
    names = ssl._ssl._test_decode_cert(str(cert)).get('subjectAltName', ())
    ips = [str(ipaddress.ip_address(value)) for kind, value in names if kind == 'IP Address']
    dns = [value for kind, value in names if kind == 'DNS']
    if '127.0.0.1' not in ips or 'localhost' not in dns or not any(ip != '127.0.0.1' for ip in ips):
        raise CertificateError('서버 IP·루프백·localhost SAN이 필요합니다')
    for ip in ips:
        if ip != '127.0.0.1':
            _inputs(ip, None, 825)
    for name in dns:
        _inputs(next(ip for ip in ips if ip != '127.0.0.1'), name, 825)
    subject = _run([exe, 'x509', '-in', cert, '-noout', '-subject', '-issuer']).decode('ascii')
    lines = subject.strip().splitlines()
    if len(lines) != 2 or lines[0].partition('=')[2] != lines[1].partition('=')[2]:
        raise CertificateError('자체 서명 인증서가 아닙니다')
    _run([exe, 'verify', '-check_ss_sig', '-trusted', cert, cert])
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(cert), str(key))
    client = ssl.create_default_context(cafile=str(cert))
    client.verify_flags |= ssl.VERIFY_X509_STRICT | ssl.VERIFY_X509_PARTIAL_CHAIN
    hosts = list(dict.fromkeys(ips + dns))
    errors = []
    stop = threading.Event()
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        listener.settimeout(0.2)

        def serve():
            while not stop.is_set():
                try:
                    raw, _ = listener.accept()
                except socket.timeout:
                    continue
                except OSError:
                    break
                try:
                    with raw:
                        raw.settimeout(3)
                        with context.wrap_socket(raw, server_side=True) as secure:
                            secure.sendall(b'1')
                except (OSError, ValueError):
                    errors.append(True)

        thread = threading.Thread(target=serve, name='tls-cert-self-check', daemon=True)
        thread.start()
        try:
            for hostname in hosts:
                with socket.create_connection(('127.0.0.1', listener.getsockname()[1]), timeout=3) as raw:
                    with client.wrap_socket(raw, server_hostname=hostname) as secure:
                        if secure.recv(1) != b'1':
                            raise CertificateError('TLS 자체 확인 실패')
        finally:
            stop.set()
            thread.join(timeout=4)
        if thread.is_alive() or errors:
            raise CertificateError('TLS 자체 확인 종료 실패')
    return hosts


def create(ip: str, dns: str | None = None, days: int = 825) -> Path:
    _require_admin()
    ip = _inputs(ip, dns, days)
    directory = server_tls.directory()
    _prepare_directory(directory, create=True)
    cert, key = directory / 'next.pem', directory / 'next.key'
    if any(p.exists() or p.is_symlink() for p in (cert, key, directory / 'promote.pending')):
        raise CertificateError('next 파일 또는 교체 표식이 이미 있습니다')
    exe = trusted_openssl()
    made = []
    try:
        _plain_path(directory)
        _plain_path(key)
        with _create_key(key) as handle:
            made.append(key)
            set_acl(key)
            _run([exe, 'genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256'], stdout=handle)
        with cert.open('xb'):
            made.append(cert)
        set_acl(cert, public=True)
        san = f'IP:{ip},IP:127.0.0.1,DNS:localhost' + (f',DNS:{dns}' if dns else '')
        with tempfile.TemporaryDirectory(prefix='mvhub-cert-config-') as temp:
            config = Path(temp) / 'request.cnf'
            config.write_text('[req]\ndistinguished_name=dn\n[dn]\n[v3]\n'
                              'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n'
                              'extendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\n'
                              'authorityKeyIdentifier=keyid:always\nsubjectAltName=' + san + '\n', encoding='ascii')
            _run([exe, 'req', '-new', '-x509', '-key', key, '-out', cert, '-days', str(days),
                  '-subj', '/CN=mvhub-shared-server', '-extensions', 'v3', '-config', config])
        self_check(cert, key, exe)
        return cert
    except BaseException:
        cleanup_failed = False
        for path in reversed(made):
            try:
                path.unlink()
            except OSError:
                cleanup_failed = True
        if cleanup_failed:
            raise CertificateError('생성 실패 및 임시 TLS 파일 정리 실패 — 관리자 확인 필요') from None
        raise


def _process_created(pid: int) -> int | None:
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        if ctypes.get_last_error() == 87:  # PID no longer exists
            return None
        raise CertificateError('교체 프로세스 상태를 확인할 수 없습니다')
    try:
        times = [wintypes.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, *(ctypes.byref(t) for t in times)):
            raise CertificateError('교체 프로세스 생성 시각 확인 실패')
        if times[1].dwHighDateTime or times[1].dwLowDateTime:
            return None
        return times[0].dwHighDateTime << 32 | times[0].dwLowDateTime
    finally:
        kernel.CloseHandle(handle)


def _write_marker(handle, state):
    handle.seek(0)
    handle.write(json.dumps(state).encode('ascii'))
    handle.truncate()
    handle.flush()
    os.fsync(handle.fileno())


def _finish(directory: Path, state: dict, exe: Path):
    cert, key = directory / 'server.pem', directory / 'server.key'
    next_cert, next_key = directory / 'next.pem', directory / 'next.key'
    if next_cert.exists():
        if fingerprint(next_cert) != state['target']:
            raise CertificateError('next 인증서가 교체 목표와 다릅니다')
        self_check(next_cert, next_key, exe)
        if state['original'] is not None:
            if fingerprint(cert) != state['original']:
                raise CertificateError('기존 인증서가 바뀌었습니다')
            for suffix in ('pem', 'key'):
                previous, source = directory / ('previous.' + suffix), directory / ('server.' + suffix)
                if previous.exists():
                    if not os.path.samefile(previous, source):
                        raise CertificateError('이전 파일이 원래 서버 파일과 다릅니다')
                else:
                    os.link(source, previous)
        os.replace(next_cert, cert)
    if fingerprint(cert) != state['target']:
        raise CertificateError('교체 목표 인증서를 찾지 못했습니다')
    if next_key.exists():
        self_check(cert, next_key, exe)
        os.replace(next_key, key)
    self_check(cert, key, exe)


def _rollback(directory: Path, state: dict, exe: Path):
    for suffix in ('pem', 'key'):
        server = directory / ('server.' + suffix)
        next_file = directory / ('next.' + suffix)
        previous = directory / ('previous.' + suffix)
        if not next_file.exists() and server.exists():
            os.replace(server, next_file)
        if previous.exists():
            if server.exists() and os.path.samefile(previous, server):
                previous.unlink()  # 교체 전 같은 파일의 링크이면 백업 링크만 제거한다.
            else:
                os.replace(previous, server)
    if state['original'] is None:
        if any((directory / ('server.' + suffix)).exists() for suffix in ('pem', 'key')):
            raise CertificateError('첫 전환 되돌림 실패')
    else:
        if fingerprint(directory / 'server.pem') != state['original']:
            raise CertificateError('이전 인증서 복구 확인 실패')
        # 만료된 원래 짝으로도 복원할 수 있어야 한다. 새 목표만 유효기간·D2 핸드셰이크를 요구한다.
        ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(
            str(directory / 'server.pem'), str(directory / 'server.key'))


def promote() -> tuple[Path, bool]:
    _require_admin()
    directory = server_tls.directory()
    _plain_path(directory)
    for name in ('server.pem', 'server.key', 'next.pem', 'next.key', 'previous.pem', 'previous.key', 'promote.pending'):
        _plain_path(directory / name)
    marker = directory / 'promote.pending'
    recovering = marker.exists()
    _prepare_directory(directory)
    exe = trusted_openssl()
    if not recovering:
        if any((directory / ('previous.' + suffix)).exists() for suffix in ('pem', 'key')):
            raise CertificateError('previous 파일을 먼저 확인·정리하세요')
        self_check(directory / 'next.pem', directory / 'next.key', exe)
        present = [(directory / ('server.' + suffix)).exists() for suffix in ('pem', 'key')]
        if any(present) and not all(present):
            raise CertificateError('기존 서버 인증서 짝이 불완전합니다')
        original = None
        if all(present):
            ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(
                str(directory / 'server.pem'), str(directory / 'server.key'))
            original = fingerprint(directory / 'server.pem')
        state = {'target': fingerprint(directory / 'next.pem'), 'original': original,
                 'pid': os.getpid(), 'created': _process_created(os.getpid())}
    # 잠금은 죽은 세션을 복구하는 두 프로세스가 동시에 파일을 바꾸는 것도 막는다.
    import msvcrt
    try:
        handle = marker.open('r+b' if recovering else 'x+b')
    except FileExistsError:
        raise CertificateError('다른 promote 실행 중') from None
    remove_marker = False
    with handle:
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise CertificateError('다른 promote 실행 중') from None
        if recovering:
            try:
                state = json.load(handle)
                if (not re.fullmatch('[0-9a-f]{64}', state['target'])
                        or not (state['original'] is None or re.fullmatch('[0-9a-f]{64}', state['original']))
                        or type(state['pid']) is not int or type(state['created']) is not int):
                    raise ValueError()
            except (ValueError, KeyError, TypeError):
                raise CertificateError('교체 표식이 손상됐습니다 — 표식을 보존하고 관리자 확인 필요') from None
            if _process_created(state['pid']) == state['created']:
                raise CertificateError('다른 promote 실행 중')
            state.update(pid=os.getpid(), created=_process_created(os.getpid()))
        _write_marker(handle, state)
        try:
            _finish(directory, state, exe)
            remove_marker = True
        except Exception:
            if not recovering:
                try:
                    _rollback(directory, state, exe)
                    remove_marker = True
                except Exception:
                    raise CertificateError('되돌림 실패 — promote.pending 유지, 관리자 복구 필요') from None
            else:
                raise CertificateError('교체 복구 중단 — promote.pending 유지, 관리자 확인 필요') from None
            raise
        finally:
            # Windows에서는 열린 파일을 삭제할 수 없으므로 핸들을 먼저 닫는다.
            if remove_marker:
                handle.close()
                marker.unlink()
    return directory / 'server.pem', state['original'] is None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    make = sub.add_parser('create')
    make.add_argument('--ip', required=True)
    make.add_argument('--dns')
    make.add_argument('--days', type=int, default=825)
    sub.add_parser('promote')
    args = parser.parse_args(argv)
    try:
        if args.command == 'create':
            cert = create(args.ip, args.dns, args.days)
        else:
            cert, first = promote()
            print('지금 서버 재시작 필요 — ' + ('첫 전환: 감시기가 HTTP 서버를 dead로 보고 자동 재시작할 수 있음'
                  if first else '교체: 재시작 전 감시기 tls_error·업데이트 거절'))
        try:
            expiry = ssl._ssl._test_decode_cert(str(cert))['notAfter']
            digest = fingerprint(cert)
        except (OSError, ValueError, AttributeError, KeyError):
            if args.command != 'promote':
                raise
            print('promote 성공 — 인증서 지문·만료 정보 읽기 실패; 공개 인증서를 확인하세요.')
            return 0
        print(f'공개 인증서: {cert}\nSHA-256: {digest}\n만료(UTC): {expiry}')
        if args.command == 'create':
            print('공개 인증서만 저장소 backend/app/resources/tls/shared_server.pem에 넣으세요(교체면 옛 인증서와 함께).')
        return 0
    except CertificateError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except (OSError, ValueError, AttributeError):
        # 예외 메시지에도 자식 출력·키 바이트가 섞이지 않게 고정 안내만 출력한다.
        print('TLS 관리 명령 실패 — 기존 파일·promote.pending을 보존하고 관리자 확인이 필요합니다.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
