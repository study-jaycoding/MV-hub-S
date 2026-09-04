"""복원한 DB 세트의 격리 서버 기동 검증.

백업 파일 자체의 무결성·복원은 ``backup_verify``가 담당하고, 이 모듈은 복원 사본만 사용해
loopback 서버를 띄운 뒤 ready·로그인·핵심 데이터 수와 프로세스 회수를 확인한다.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .backup_verify import (
    BACKUP_SET_MEMBERS,
    inspect_sqlite_database,
    read_table_counts,
)


# 격리 서버를 종료한 직후에만 나타나는 일시적 열기 실패. 실측된 것만 재시도 대상으로 둔다 —
# 'no such table' 같은 진짜 결함까지 재시도로 흡수하면 드릴이 결함을 숨기게 된다.
_TRANSIENT_OPEN_ERRORS = ("disk i/o error", "unable to open database file")


def _read_counts_after_shutdown(
    path: Path, tables: tuple[str, ...], *, attempts: int = 6
) -> dict[str, int]:
    """격리 서버를 종료한 '직후'의 첫 읽기를 짧게 재시도한다.

    2026-09-04 실측: 종료 직후 첫 SELECT 가 sqlite3 'disk I/O error' 로 떨어지는데, 같은
    파일을 몇 초 뒤 그대로 읽으면 정상이고 행 수도 맞다(재현율 100%). 파일 내용 문제가
    아니라 방금 사라진 프로세스의 DB·-shm 을 여는 것이 잠시 막히는 현상으로 보인다
    (핸들 해제 지연, stale -shm 복구, 파일 필터 중 무엇이 주된 원인인지는 확정하지 못했다).

    그래서 '여는 단계의 일시적 실패'만 좁혀서 재시도하고, 그 밖의 OperationalError 는
    즉시 올려 드릴을 실패시킨다. 재시도가 있었으면 로그에 남겨 조용히 넘어가지 않게 한다.
    """
    delay = 0.2
    for attempt in range(attempts):
        try:
            counts = read_table_counts(path, tables)
            if attempt:
                logging.getLogger("mvhub.restore").warning(
                    "격리 서버 종료 직후 %s 읽기가 %d회 재시도 끝에 성공했습니다",
                    path.name,
                    attempt,
                )
            return counts
        except sqlite3.OperationalError as exc:
            message = str(exc).lower()
            transient = any(marker in message for marker in _TRANSIENT_OPEN_ERRORS)
            if not transient or attempt == attempts - 1:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 1.5)
    raise AssertionError("unreachable")


def _free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _local_json_request(
    base_url: str,
    path: str,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    timeout: float = 2.0,
) -> tuple[int, Any]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(base_url + path, data=data, method=method)
    request.add_header("Accept", "application/json")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    # 사용자/서버 PC의 프록시 설정이 loopback 드릴을 외부로 보내지 못하게 명시적으로 끈다.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw.decode("utf-8")) if raw else None
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            payload: Any = json.loads(raw.decode("utf-8")) if raw else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            payload = {"bytes": len(raw)}
        return exc.code, payload


def _stop_test_process(process: subprocess.Popen[Any]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
        return
    except subprocess.TimeoutExpired:
        pass
    if os.name == "nt":
        subprocess.run(
            ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
            capture_output=True,
            check=False,
        )
    else:
        process.kill()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("격리 복원 서버 프로세스를 회수하지 못했습니다") from exc


def verify_restored_set_runtime(
    restored_data_dir: Path,
    *,
    timeout_seconds: float = 60.0,
) -> dict[str, Any]:
    """복원 세트로 격리 서버를 띄워 ready·로그인·핵심 수를 실제 확인한다."""
    restored_data_dir = restored_data_dir.resolve()
    db_dir = restored_data_dir / "db"
    paths = {
        label: db_dir / str(spec["restored_name"])
        for label, spec in BACKUP_SET_MEMBERS.items()
    }
    for label, path in paths.items():
        inspect_sqlite_database(
            path,
            required_tables=set(BACKUP_SET_MEMBERS[label]["required_tables"]),
        )

    before_counts = {
        label: read_table_counts(
            path,
            tuple(BACKUP_SET_MEMBERS[label]["reconcile_tables"]),
        )
        for label, path in paths.items()
    }
    before_bootstrap = read_table_counts(paths["content"], ("account", "creator"))

    backend_dir = Path(__file__).resolve().parents[2]
    serve_script = backend_dir / "serve.py"
    if not serve_script.is_file():
        raise FileNotFoundError(serve_script)
    port = _free_loopback_port()
    base_url = f"http://127.0.0.1:{port}"
    admin_email = f"restore-drill-{secrets.token_hex(8)}@localhost.invalid"
    admin_password = secrets.token_urlsafe(18)
    auth_secret = secrets.token_urlsafe(32)
    log_path = restored_data_dir / "restore-drill-server.log"

    env = os.environ.copy()
    for key in (
        "CONTENT_HUB_SSL_CERTFILE",
        "CONTENT_HUB_SSL_KEYFILE",
        "CONTENT_HUB_TEST_SNAPSHOT_EXPORT",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
    ):
        env.pop(key, None)
    env.update(
        {
            "CONTENT_HUB_DATA": str(restored_data_dir),
            "CONTENT_HUB_DB": str(paths["content"]),
            "CONTENT_HUB_MEDIA": str(restored_data_dir / "media"),
            "CONTENT_HUB_SHARED": str(restored_data_dir / "shared"),
            "CONTENT_HUB_ASSETS_DIR": str(restored_data_dir / "assets"),
            "CONTENT_HUB_FRONTEND_DIST": str(restored_data_dir / "no-frontend"),
            "CONTENT_HUB_BACKUP_DIR": str(restored_data_dir / "backups"),
            "CONTENT_HUB_BACKUP_INTERVAL": "0",
            "CONTENT_HUB_SERVER_SYNC": "0",
            "CONTENT_HUB_METRICS_LOG_INTERVAL": "0",
            "CONTENT_HUB_ACCESS_LOG": "0",
            "CONTENT_HUB_NO_PROXY": "1",
            # 사본 DB의 in-flight 마커·API 키로 라이브 Comfy 잡을 취소하거나 로컬 CLI 를
            # 호출하지 않게 — 드릴의 격리는 파일뿐 아니라 외부 서비스 상태에도 성립해야 한다.
            "CONTENT_HUB_EXTERNAL_RECOVERY": "0",
            "CONTENT_HUB_AUTH": "1",
            "CONTENT_HUB_MANAGE": "1",
            "CONTENT_HUB_HOST": "127.0.0.1",
            "CONTENT_HUB_PORT": str(port),
            "CONTENT_HUB_DB_BACKEND": "sqlite",
            "CONTENT_HUB_ADMIN_EMAIL": admin_email,
            "CONTENT_HUB_ADMIN_PASSWORD": admin_password,
            "CONTENT_HUB_AUTH_SECRET": auth_secret,
            "NO_PROXY": "127.0.0.1,localhost",
        }
    )
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    ready_payload: dict[str, Any] | None = None
    login_ok = False
    process_stopped = False
    with log_path.open("w", encoding="utf-8", errors="replace") as log_file:
        process = subprocess.Popen(
            [sys.executable, str(serve_script)],
            cwd=str(backend_dir),
            env=env,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            creationflags=creationflags,
        )
        try:
            deadline = time.monotonic() + max(1.0, float(timeout_seconds))
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(
                        f"격리 복원 서버가 준비 전에 종료했습니다(code={process.returncode})"
                    )
                try:
                    status, payload = _local_json_request(base_url, "/api/ready")
                except (OSError, urllib.error.URLError, TimeoutError):
                    time.sleep(0.25)
                    continue
                if status == 200 and isinstance(payload, dict):
                    ready_payload = payload
                    break
                time.sleep(0.25)
            if ready_payload is None:
                raise TimeoutError("격리 복원 서버 준비 시간 초과")
            checks = ready_payload.get("checks") or {}
            if any(
                checks.get(label) != "ok"
                for label in ("content", "trash", "manage")
            ):
                raise RuntimeError(f"복원 DB ready 검사 불일치: {checks}")
            login_status, login_payload = _local_json_request(
                base_url,
                "/api/auth/login",
                method="POST",
                body={"email": admin_email, "password": admin_password},
                timeout=10.0,
            )
            login_ok = (
                login_status == 200
                and isinstance(login_payload, dict)
                and bool(login_payload.get("token"))
            )
            if not login_ok:
                raise RuntimeError(f"격리 복원 서버 로그인 실패(status={login_status})")
        except Exception as exc:
            _stop_test_process(process)
            process_stopped = process.poll() is not None
            log_file.flush()
            tail = log_path.read_text(encoding="utf-8", errors="replace")[-3000:]
            raise RuntimeError(
                f"복원 서버 실측 실패: {exc}\n--- server log tail ---\n{tail}"
            ) from exc
        finally:
            # finally 의 종료 실패가 원래 실패 원인(위 raise)을 가리지 않게 한다.
            try:
                _stop_test_process(process)
            except Exception as stop_error:  # noqa: BLE001
                logging.getLogger("mvhub.restore").warning(
                    "복원 드릴 서버 종료 중 오류(원인 예외 우선): %s", stop_error
                )
            process_stopped = process.poll() is not None

    after_counts = {
        label: _read_counts_after_shutdown(
            path,
            tuple(BACKUP_SET_MEMBERS[label]["reconcile_tables"]),
        )
        for label, path in paths.items()
    }
    if before_counts != after_counts:
        raise ValueError(
            "격리 서버 기동 전후 핵심 데이터 수가 다릅니다: "
            f"before={before_counts}, after={after_counts}"
        )
    after_bootstrap = _read_counts_after_shutdown(paths["content"], ("account", "creator"))
    bootstrap_deltas = {
        table: after_bootstrap[table] - before_bootstrap[table]
        for table in before_bootstrap
    }
    if bootstrap_deltas != {"account": 1, "creator": 1}:
        raise ValueError(
            "격리 로그인용 account·creator 외의 부트스트랩 변화가 감지되었습니다: "
            f"before={before_bootstrap}, after={after_bootstrap}"
        )
    return {
        "ok": True,
        "ready": True,
        "ready_checks": ready_payload.get("checks") if ready_payload else {},
        "login": "ok" if login_ok else "failed",
        "reconcile_counts": after_counts,
        "temporary_bootstrap_deltas": bootstrap_deltas,
        "loopback_only": True,
        "isolated_port": port,
        "process_stopped": process_stopped,
        "log": str(log_path),
    }
