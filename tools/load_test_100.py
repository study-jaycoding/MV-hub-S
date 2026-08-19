r"""MV Hub 100명 격리 부하 테스트.

운영 DB를 사용하지 않는다. 임시 DB와 임시 데이터 폴더, 임의의 로컬 포트에 테스트 서버를
띄운 뒤 100 로그인·WebSocket·에이전트 롱폴·읽기/쓰기를 재현하고 자동 종료한다.

빠른 검증:
  python tools\load_test_100.py --users 20 --duration 10

배포 전 기본:
  python tools\load_test_100.py --users 100 --duration 60 --generations-per-user 20

8시간 지속(4시간씩 2회 비교):
  python tools\load_test_100.py --users 100 --duration 14400 --cycles 2 ^
    --server-cpu-cores 4 --server-priority below-normal --max-rss-mb 512 ^
    --output soak-result.json
"""

from __future__ import annotations

import argparse
import asyncio
import gzip
import hashlib
import http.client
import json
import logging
import os
import random
import shutil
import socket
import sqlite3
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
PASSWORD = "load-test-password"
LOAD_WORKSPACE_ID = "load-workspace"
LOAD_PROJECT_ID = "load-project"


class _ExpectedSslCloseFilter(logging.Filter):
    """정상 WSS close 뒤 CPython sslproto가 남기는 Windows 전용 경고만 거른다."""

    def filter(self, record: logging.LogRecord) -> bool:
        return record.getMessage() != "SSL connection is closed"


@contextmanager
def _suppress_expected_ssl_close_warning():
    asyncio_logger = logging.getLogger("asyncio")
    close_filter = _ExpectedSslCloseFilter()
    asyncio_logger.addFilter(close_filter)
    try:
        yield
    finally:
        asyncio_logger.removeFilter(close_filter)


def _percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int(round((len(ordered) - 1) * p))))
    return round(ordered[index], 2)


def _reservoir_add(
    samples: list[float],
    value: float,
    seen: int,
    limit: int,
    rng: random.Random,
) -> None:
    """전체 개수는 버리지 않고, 장기 지연시간 분포만 고정 메모리로 표본화한다."""
    if len(samples) < limit:
        samples.append(value)
        return
    replace_at = rng.randrange(seen)
    if replace_at < limit:
        samples[replace_at] = value


def _operational_error_tail(path: Path, limit: int = 20) -> list[dict[str, Any]]:
    """격리 서버 운영 로그에서 ERROR/CRITICAL만 읽어 실패 보고서에 남긴다."""
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    errors: list[dict[str, Any]] = []
    for line in lines:
        try:
            payload = json.loads(line)
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(payload, dict) and payload.get("level") in {"ERROR", "CRITICAL"}:
            errors.append(payload)
    return errors[-max(1, limit) :]


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    """장기 시험 진행 파일이 중간 쓰기 상태로 남지 않게 같은 폴더에서 교체한다."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _apply_server_limits(
    pid: int,
    *,
    cpu_cores: int = 0,
    priority: str = "normal",
) -> dict[str, Any]:
    """격리 서버 프로세스에만 저사양 조건을 적용하고 실제 적용값을 반환한다."""
    import psutil

    process = psutil.Process(pid)
    available_affinity = process.cpu_affinity()
    if cpu_cores:
        if cpu_cores > len(available_affinity):
            raise ValueError(
                f"요청한 서버 CPU {cpu_cores}개가 사용 가능한 {len(available_affinity)}개보다 큽니다"
            )
        process.cpu_affinity(available_affinity[:cpu_cores])

    if priority == "below-normal":
        if os.name == "nt":
            process.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
        else:
            process.nice(10)

    applied_priority = process.nice()
    applied_affinity = process.cpu_affinity()
    return {
        "requested_cpu_cores": cpu_cores or None,
        "cpu_affinity": applied_affinity,
        "priority": priority,
        "platform_priority_value": str(applied_priority),
    }


@contextmanager
def _temporary_load_root():
    """Windows의 일시적인 로그 파일 잠금을 기다리며 테스트 폴더를 정리한다."""
    temp_name = tempfile.mkdtemp(prefix="mvhub-load-")
    try:
        yield temp_name
    finally:
        for attempt in range(20):
            try:
                shutil.rmtree(temp_name)
                break
            except FileNotFoundError:
                break
            except PermissionError as exc:
                if attempt == 19:
                    print(
                        f"[warn] 임시 부하 테스트 폴더 정리를 건너뜁니다: {exc}",
                        file=sys.stderr,
                    )
                    break
                time.sleep(0.25)


def _http_json(
    base_url: str,
    path: str,
    *,
    method: str = "GET",
    token: Optional[str] = None,
    body: Optional[dict[str, Any]] = None,
    timeout: float = 35.0,
    ssl_context: Optional[ssl.SSLContext] = None,
) -> tuple[int, Any, float]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(base_url + path, data=data, method=method)
    request.add_header("Accept", "application/json")
    request.add_header("Accept-Encoding", "gzip")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    started = time.perf_counter()
    try:
        open_kwargs: dict[str, Any] = {"timeout": timeout}
        if ssl_context is not None:
            open_kwargs["context"] = ssl_context
        with urllib.request.urlopen(request, **open_kwargs) as response:
            raw = response.read()
            parsed = _decode_response(
                raw,
                _response_header(response, "Content-Encoding"),
            )
            return response.status, parsed, (time.perf_counter() - started) * 1000.0
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            parsed = _decode_response(
                raw,
                _response_header(exc, "Content-Encoding"),
            )
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            parsed = raw.decode("utf-8", "replace")[:500]
        return exc.code, parsed, (time.perf_counter() - started) * 1000.0
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return 0, {"error": str(exc)}, (time.perf_counter() - started) * 1000.0


def _response_header(response: Any, name: str) -> str:
    getter = getattr(response, "getheader", None)
    if callable(getter):
        return str(getter(name) or "")
    headers = getattr(response, "headers", None)
    if headers is not None:
        return str(headers.get(name, "") or "")
    return ""


def _decode_response(raw: bytes, content_encoding: str = "") -> Any:
    encodings = {
        value.strip().lower() for value in content_encoding.split(",") if value.strip()
    }
    if "gzip" in encodings and raw:
        raw = gzip.decompress(raw)
    try:
        return json.loads(raw.decode("utf-8")) if raw else None
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {"bytes": len(raw)}


class _KeepAliveJsonClient:
    """한 가상 사용자의 HTTP 연결을 재사용해 실제 브라우저 동작을 가깝게 재현한다."""

    def __init__(
        self,
        base_url: str,
        *,
        token: Optional[str] = None,
        timeout: float = 35.0,
        ssl_context: Optional[ssl.SSLContext] = None,
    ) -> None:
        parsed = urllib.parse.urlsplit(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError(f"지원하지 않는 base URL: {base_url}")
        if parsed.scheme == "https":
            self._connection = http.client.HTTPSConnection(
                parsed.hostname,
                parsed.port,
                timeout=timeout,
                context=ssl_context,
            )
        else:
            self._connection = http.client.HTTPConnection(
                parsed.hostname,
                parsed.port,
                timeout=timeout,
            )
        self._token = token
        # 브라우저의 private HTTP cache처럼 같은 GET의 ETag와 해석 결과를 연결별로 보존한다.
        self._response_cache: dict[str, tuple[str, Any]] = {}

    def request(
        self,
        path: str,
        *,
        method: str = "GET",
        body: Optional[dict[str, Any]] = None,
    ) -> tuple[int, Any, float]:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Accept": "application/json", "Accept-Encoding": "gzip"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        cache_key = path if method.upper() == "GET" and data is None else None
        cached = self._response_cache.get(cache_key) if cache_key else None
        if cached:
            headers["If-None-Match"] = cached[0]
        started = time.perf_counter()
        try:
            self._connection.request(method, path, body=data, headers=headers)
            response = self._connection.getresponse()
            raw = response.read()
            if response.status == 304 and cached:
                return (
                    200,
                    cached[1],
                    (time.perf_counter() - started) * 1000.0,
                )
            parsed = _decode_response(
                raw,
                _response_header(response, "Content-Encoding"),
            )
            etag = _response_header(response, "ETag")
            if cache_key and 200 <= response.status < 300 and etag:
                self._response_cache[cache_key] = (etag, parsed)
            return (
                response.status,
                parsed,
                (time.perf_counter() - started) * 1000.0,
            )
        except (http.client.HTTPException, TimeoutError, OSError) as exc:
            self._connection.close()
            return 0, {"error": str(exc)}, (time.perf_counter() - started) * 1000.0

    def close(self) -> None:
        self._connection.close()


def _seed_database(
    data_dir: Path,
    db_path: Path,
    users: int,
    generations_per_user: int,
) -> list[dict[str, str]]:
    os.environ["CONTENT_HUB_DATA"] = str(data_dir)
    os.environ["CONTENT_HUB_DB"] = str(db_path)
    if str(BACKEND) not in sys.path:
        sys.path.insert(0, str(BACKEND))

    from app import db, repo
    from app.services.auth import hash_password

    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    password_hash = hash_password(PASSWORD)
    accounts: list[dict[str, str]] = []
    with db.get_connection() as conn:
        conn.execute(
            "INSERT INTO workspace_registry(id, name) VALUES(?, 'Load Workspace')",
            (LOAD_WORKSPACE_ID,),
        )
        conn.execute(
            "INSERT INTO project(id, name, kind, archived, workspace_scope, workspace_id, "
            "workspace_name) VALUES(?, 'Load Project', 'team', 0, 'team', ?, 'Load Workspace')",
            (LOAD_PROJECT_ID, LOAD_WORKSPACE_ID),
        )
        for index in range(users):
            email = f"load{index:03d}@example.test"
            uid = f"user_load_{index:03d}"
            roles = "admin,product_manager" if index == 0 else "member"
            conn.execute(
                "INSERT INTO creator(uid, name, global_role) VALUES(?,?,?)",
                (uid, f"Load User {index:03d}", roles),
            )
            conn.execute(
                "INSERT INTO account("
                "email, name, password_hash, status, global_role, creator_uid, approved_at"
                ") VALUES(?,?,?,?,?,?,datetime('now'))",
                (email, f"Load User {index:03d}", password_hash, "approved", roles, uid),
            )
            conn.execute(
                "INSERT INTO project_member(project_id, creator_uid, project_role) "
                "VALUES(?,?,'creator')",
                (LOAD_PROJECT_ID, uid),
            )
            conn.execute(
                "INSERT INTO workspace_member("
                "workspace_id, account_email, creator_uid, is_available, is_selected"
                ") VALUES(?,?,?,?,?)",
                (LOAD_WORKSPACE_ID, email, uid, 1, 1),
            )
            first_generation = ""
            for gen_index in range(generations_per_user):
                gid = f"load-g-{index:03d}-{gen_index:03d}"
                first_generation = first_generation or gid
                conn.execute(
                    "INSERT INTO generation("
                    "id, worker_id, creator_uid, prompt, model, params, color, status, "
                    "created_at, sort_ts, project_id, origin, folder_path, workspace_scope, "
                    "workspace_id) VALUES(?,?,?,?,?,?,?,?,datetime('now'),?,?,?,?,?,?)",
                    (
                        gid,
                        "me",
                        uid,
                        f"load prompt {index}-{gen_index}",
                        "load-model",
                        "{}",
                        None,
                        "done",
                        float(index * generations_per_user + gen_index),
                        LOAD_PROJECT_ID,
                        "local",
                        f"ep{index:03d}/c{gen_index:04d}",
                        "team",
                        LOAD_WORKSPACE_ID,
                    ),
                )
            accounts.append({"email": email, "uid": uid, "generation_id": first_generation})
    db.flush_pool()
    # 운영 부팅은 평면 media 파일을 앞 2글자 폴더로 샤딩한다. 처음부터 실제 최종 구조로 만든다.
    media = data_dir / "media" / "lo"
    media.mkdir(parents=True, exist_ok=True)
    (media / "load.bin").write_bytes(b"M" * (256 * 1024))
    return accounts


def _server_environment(
    data_dir: Path,
    db_path: Path,
    port: int,
    *,
    ssl_certfile: Optional[Path] = None,
    ssl_keyfile: Optional[Path] = None,
) -> dict[str, str]:
    env = os.environ.copy()
    # 호출한 셸의 TLS 설정이 HTTP 회귀 시험에 우연히 섞이지 않도록 항상 명시적으로 재구성한다.
    env.pop("CONTENT_HUB_SSL_CERTFILE", None)
    env.pop("CONTENT_HUB_SSL_KEYFILE", None)
    env.update(
        {
            "PYTHONUTF8": "1",
            "CONTENT_HUB_DATA": str(data_dir),
            "CONTENT_HUB_DB": str(db_path),
            "CONTENT_HUB_AUTH": "1",
            "CONTENT_HUB_AUTH_SECRET": "load-test-secret-not-for-production",
            "CONTENT_HUB_MANAGE": "1",
            "CONTENT_HUB_HOST": "127.0.0.1",
            "CONTENT_HUB_PORT": str(port),
            "CONTENT_HUB_BACKUP_INTERVAL": "0",
            "CONTENT_HUB_SERVER_SYNC": "0",
            "CONTENT_HUB_METRICS_LOG_INTERVAL": "0",
            "CONTENT_HUB_FRONTEND_DIST": str(data_dir / "no-frontend"),
        }
    )
    if ssl_certfile and ssl_keyfile:
        env["CONTENT_HUB_SSL_CERTFILE"] = str(ssl_certfile)
        env["CONTENT_HUB_SSL_KEYFILE"] = str(ssl_keyfile)
    return env


def _wait_ready(
    base_url: str,
    process: subprocess.Popen,
    timeout: float = 45.0,
    ssl_context: Optional[ssl.SSLContext] = None,
) -> None:
    deadline = time.monotonic() + timeout
    last_status = 0
    last_detail: Any = {"error": "no response"}
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"테스트 서버가 조기 종료했습니다(code={process.returncode})")
        status, detail, _ = _http_json(
            base_url,
            "/api/ready",
            timeout=2,
            ssl_context=ssl_context,
        )
        if status == 200:
            return
        last_status = status
        last_detail = detail
        time.sleep(0.25)
    try:
        detail_text = json.dumps(last_detail, ensure_ascii=False)
    except (TypeError, ValueError):
        detail_text = repr(last_detail)
    raise TimeoutError(
        "테스트 서버 준비 시간 초과"
        f"(last_status={last_status}, detail={detail_text[:500]})"
    )


async def _login_all(
    base_url: str,
    accounts: list[dict[str, str]],
    ssl_context: Optional[ssl.SSLContext] = None,
) -> tuple[list[str], list[float], Counter[int]]:
    async def one(account: dict[str, str]) -> tuple[int, Any, float]:
        return await asyncio.to_thread(
            _http_json,
            base_url,
            "/api/auth/login",
            method="POST",
            body={"email": account["email"], "password": PASSWORD},
            ssl_context=ssl_context,
        )

    results = await asyncio.gather(*(one(account) for account in accounts))
    tokens: list[str] = []
    latencies: list[float] = []
    statuses: Counter[int] = Counter()
    for status, body, elapsed in results:
        statuses[status] += 1
        latencies.append(elapsed)
        token = body.get("token") if isinstance(body, dict) else None
        if status != 200 or not token:
            raise RuntimeError(f"로그인 실패 status={status} body={body}")
        tokens.append(token)
    return tokens, latencies, statuses


async def _probe_during_login(
    base_url: str,
    login_task: asyncio.Task,
    ssl_context: Optional[ssl.SSLContext] = None,
) -> dict[str, Any]:
    """CPU 해시 폭주 중에도 일반 sync API가 공용 스레드풀에서 굶지 않는지 측정한다."""
    latencies: list[float] = []
    statuses: Counter[int] = Counter()
    while not login_task.done() or not latencies:
        status, _body, elapsed = await asyncio.to_thread(
            _http_json,
            base_url,
            "/api/auth/config",
            ssl_context=ssl_context,
        )
        statuses[status] += 1
        latencies.append(elapsed)
        if not login_task.done():
            await asyncio.sleep(0.05)
    return {
        "samples": len(latencies),
        "statuses": dict(statuses),
        "p95_ms": _percentile(latencies, 0.95),
        "max_ms": round(max(latencies), 2) if latencies else 0.0,
    }


async def _runtime_snapshot(
    base_url: str,
    admin_token: str,
    ssl_context: Optional[ssl.SSLContext] = None,
) -> dict[str, Any]:
    status, body, _ = await asyncio.to_thread(
        _http_json,
        base_url,
        "/api/admin/runtime",
        token=admin_token,
        ssl_context=ssl_context,
    )
    if status != 200 or not isinstance(body, dict):
        raise RuntimeError(f"런타임 지표 조회 실패: status={status}, body={body}")
    return body


async def _monitor_runtime(
    base_url: str,
    admin_token: str,
    stop: asyncio.Event,
    interval: float,
    samples: list[dict[str, Any]],
    errors: list[str],
    ssl_context: Optional[ssl.SSLContext] = None,
    progress_path: Optional[Path] = None,
    cycle_number: int = 1,
) -> None:
    """장기 시험 중 자원·연결 최고점과 순간 저하를 놓치지 않도록 계속 측정한다."""
    started = time.monotonic()
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
            break
        except asyncio.TimeoutError:
            pass
        try:
            snapshot = await _runtime_snapshot(base_url, admin_token, ssl_context)
            samples.append(
                {
                    "elapsed_seconds": round(time.monotonic() - started, 3),
                    "snapshot": snapshot,
                }
            )
            if progress_path is not None:
                await asyncio.to_thread(
                    _atomic_write_json,
                    progress_path,
                    {
                        "state": "running",
                        "updated_at_unix": round(time.time(), 3),
                        "cycle": cycle_number,
                        "elapsed_seconds_in_cycle": round(time.monotonic() - started, 3),
                        "snapshot": snapshot,
                    },
                )
        except Exception as exc:  # noqa: BLE001 — 시험 결과에 진단용으로 보존
            errors.append(f"{type(exc).__name__}: {exc}")


def _resource_summary(samples: list[dict[str, Any]]) -> dict[str, Any]:
    snapshots = [item.get("snapshot", item) for item in samples]
    rss_values = [
        snapshot.get("process", {}).get("rss_bytes")
        for snapshot in snapshots
        if snapshot.get("process", {}).get("rss_bytes") is not None
    ]
    cpu_values = [
        snapshot.get("process", {}).get("cpu_percent_one_core")
        for snapshot in snapshots
        if snapshot.get("process", {}).get("cpu_percent_one_core") is not None
    ]
    websocket_values = [
        snapshot.get("websocket", {}).get("connections")
        for snapshot in snapshots
        if snapshot.get("websocket", {}).get("connections") is not None
    ]
    agent_values = [
        snapshot.get("agents", {}).get("long_poll_waiters")
        for snapshot in snapshots
        if snapshot.get("agents", {}).get("long_poll_waiters") is not None
    ]
    agent_connected_values = [
        snapshot.get("agents", {}).get("connected_accounts")
        for snapshot in snapshots
        if snapshot.get("agents", {}).get("connected_accounts") is not None
    ]
    return {
        "sample_count": len(snapshots),
        "max_rss_bytes": max(rss_values) if rss_values else None,
        "max_cpu_percent_one_core": max(cpu_values) if cpu_values else None,
        "min_websocket_connections": min(websocket_values) if websocket_values else None,
        "min_agent_long_poll_waiters": min(agent_values) if agent_values else None,
        "min_agent_connected_accounts": (
            min(agent_connected_values) if agent_connected_values else None
        ),
    }


async def _websocket_worker(
    ws_url: str,
    token: str,
    stop: asyncio.Event,
    ready: asyncio.Event,
    errors: list[str],
    ssl_context: Optional[ssl.SSLContext] = None,
) -> None:
    import websockets

    started = time.monotonic()
    try:
        encoded = urllib.parse.quote(token, safe="")
        connect_kwargs: dict[str, Any] = {
            "open_timeout": 15,
            "close_timeout": 3,
            # 브라우저는 프로토콜 ping을 직접 예약하지 않고 서버 ping에 자동 응답한다.
            # 프론트와 같은 텍스트 ping만 아래 루프에서 보내 동기화된 이중 ping 폭주를 피한다.
            "ping_interval": None,
        }
        if ssl_context is not None:
            connect_kwargs["ssl"] = ssl_context
        async with websockets.connect(
            f"{ws_url}/ws?token={encoded}",
            **connect_kwargs,
        ) as websocket:
            ready.set()
            while not stop.is_set():
                try:
                    await asyncio.wait_for(stop.wait(), timeout=25)
                except asyncio.TimeoutError:
                    await websocket.send("ping")
    except Exception as exc:  # noqa: BLE001 — 부하 결과로 수집
        # 실제 사용 중 단절과 테스트 종료(close) 중 단절을 구분할 수 있게 한다.
        # 토큰·URL은 기록하지 않아 결과 JSON에 인증정보가 남지 않는다.
        errors.append(
            f"{type(exc).__name__}|stop_requested={stop.is_set()}|"
            f"after_seconds={time.monotonic() - started:.2f}|{exc}"
        )
        ready.set()


async def _workload_user(
    index: int,
    base_url: str,
    token: str,
    generation_id: str,
    deadline: float,
    think_min: float,
    think_max: float,
    ssl_context: Optional[ssl.SSLContext] = None,
    workload: str = "mixed",
) -> dict[str, Any]:
    rng = random.Random(10_000 + index)
    sample_rng = random.Random(20_000 + index)
    sample_limit = 2_000
    request_count = 0
    statuses: Counter[int] = Counter()
    endpoint_counts: Counter[str] = Counter()
    latency_samples: list[float] = []
    endpoint_latency_samples: dict[str, list[float]] = {}
    errors: list[dict[str, Any]] = []
    colors = [None, "#e85d5d", "#58a6ff", "#6bcB77"]
    client = _KeepAliveJsonClient(
        base_url,
        token=token,
        ssl_context=ssl_context,
    )
    try:
        while time.monotonic() < deadline:
            roll = rng.random()
            if workload == "task-read" and roll < 0.35:
                query = urllib.parse.urlencode({"workspace_id": LOAD_WORKSPACE_ID})
                path, method, body, name = (
                    f"/api/manage/task-projects?{query}",
                    "GET",
                    None,
                    "task_projects",
                )
            elif workload == "task-read":
                query = urllib.parse.urlencode(
                    {
                        "workspace_id": LOAD_WORKSPACE_ID,
                        "project_id": LOAD_PROJECT_ID,
                    }
                )
                path, method, body, name = (
                    f"/api/manage/tasks-batch?{query}",
                    "GET",
                    None,
                    "tasks_batch",
                )
            elif roll < 0.55:
                path, method, body, name = (
                    "/api/generations?tab=my&limit=50",
                    "GET",
                    None,
                    "list",
                )
            elif roll < 0.70:
                path, method, body, name = "/api/facets?tab=my", "GET", None, "facets"
            elif roll < 0.80:
                path, method, body, name = (
                    "/api/generations-stats",
                    "GET",
                    None,
                    "stats",
                )
            elif roll < 0.90:
                path = f"/api/generations/{generation_id}"
                method, body, name = "GET", None, "detail"
            elif roll < 0.96:
                path = f"/api/generations/{generation_id}/color"
                method, body, name = "PUT", {"color": rng.choice(colors)}, "write_color"
            else:
                path, method, body, name = "/media/lo/load.bin", "GET", None, "media"
            status, response, elapsed = await asyncio.to_thread(
                client.request,
                path,
                method=method,
                body=body,
            )
            request_count += 1
            statuses[status] += 1
            endpoint_counts[name] += 1
            _reservoir_add(
                latency_samples,
                elapsed,
                request_count,
                sample_limit,
                sample_rng,
            )
            endpoint_samples = endpoint_latency_samples.setdefault(name, [])
            _reservoir_add(
                endpoint_samples,
                elapsed,
                endpoint_counts[name],
                sample_limit,
                sample_rng,
            )
            if (status == 0 or status >= 500) and len(errors) < 20:
                errors.append(
                    {
                        "name": name,
                        "status": status,
                        "elapsed_ms": elapsed,
                        "error": response,
                    }
                )
            await asyncio.sleep(rng.uniform(think_min, think_max))
    finally:
        client.close()
    return {
        "requests": request_count,
        "statuses": dict(statuses),
        "endpoint_counts": dict(endpoint_counts),
        "latency_samples": latency_samples,
        "endpoint_latency_samples": endpoint_latency_samples,
        "errors": errors,
    }


def _task_workspace_signature(conn: sqlite3.Connection) -> dict[str, Any]:
    """작업 읽기 부하 전후의 의미 있는 행 전체를 고정 해시로 비교한다."""
    rows = conn.execute(
        "SELECT id, project_id, name, status, assignee_uid, start_date, due_date, "
        "sort_order, note, folder_path, sequence, description, source_kind, "
        "source_last_seen_at, archived, workspace_scope, workspace_id, workspace_name, "
        "workspace_origin, created_at FROM project_task ORDER BY id"
    ).fetchall()
    encoded = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return {
        "row_count": len(rows),
        "sha256": hashlib.sha256(encoded).hexdigest().upper(),
    }


async def _long_poll_worker(
    base_url: str,
    token: str,
    stop: asyncio.Event,
    errors: list[str],
    ssl_context: Optional[ssl.SSLContext] = None,
) -> None:
    """실제 에이전트처럼 롱폴이 반환되면 종료 신호 전까지 즉시 다시 대기한다."""
    client = _KeepAliveJsonClient(
        base_url,
        token=token,
        timeout=35,
        ssl_context=ssl_context,
    )
    try:
        while not stop.is_set():
            status, response, _elapsed = await asyncio.to_thread(
                client.request,
                "/api/agent/wait",
            )
            if status < 200 or status >= 300:
                errors.append(f"status={status}: {response}")
                return
    finally:
        client.close()


async def _run_load(
    base_url: str,
    ws_url: str,
    accounts: list[dict[str, str]],
    duration: float,
    think_min: float,
    think_max: float,
    sample_interval: float,
    ssl_context: Optional[ssl.SSLContext] = None,
    progress_path: Optional[Path] = None,
    cycle_number: int = 1,
    db_path: Optional[Path] = None,
    workload: str = "mixed",
) -> dict[str, Any]:
    login_task = asyncio.create_task(
        _login_all(
            base_url,
            accounts,
            ssl_context,
        )
    )
    login_probe_task = asyncio.create_task(
        _probe_during_login(base_url, login_task, ssl_context)
    )
    try:
        tokens, login_latencies, login_statuses = await login_task
    finally:
        login_control_probe = await login_probe_task

    # 작업 읽기 모드는 최초 파생 작업 생성까지 워밍업에 포함한다. 그 뒤의 반복 GET은
    # project_task를 단 한 번도 쓰지 않아야 한다.
    if workload == "task-read":
        query = urllib.parse.urlencode(
            {"workspace_id": LOAD_WORKSPACE_ID, "project_id": LOAD_PROJECT_ID}
        )
        status, body, _elapsed = await asyncio.to_thread(
            _http_json,
            base_url,
            f"/api/manage/tasks-batch?{query}",
            token=tokens[0],
            ssl_context=ssl_context,
        )
        if status != 200:
            raise RuntimeError(f"작업 읽기 워밍업 실패 status={status} body={body}")

    # 연결·SQLite 풀·목록 캐시를 한 번 데운 뒤 메모리 기준점을 잡는다.
    await asyncio.gather(
        *(
            asyncio.to_thread(
                _http_json,
                base_url,
                "/api/generations?tab=my&limit=20",
                token=token,
                ssl_context=ssl_context,
            )
            for token in tokens
        )
    )
    stop_ws = asyncio.Event()
    ws_errors: list[str] = []
    ws_ready = [asyncio.Event() for _ in tokens]
    ws_tasks = [
        asyncio.create_task(
            _websocket_worker(
                ws_url,
                token,
                stop_ws,
                ws_ready[index],
                ws_errors,
                ssl_context,
            )
        )
        for index, token in enumerate(tokens)
    ]
    await asyncio.wait_for(
        asyncio.gather(*(event.wait() for event in ws_ready)),
        timeout=30,
    )

    stop_long_poll = asyncio.Event()
    long_poll_errors: list[str] = []
    long_poll_tasks = [
        asyncio.create_task(
            _long_poll_worker(
                base_url,
                token,
                stop_long_poll,
                long_poll_errors,
                ssl_context,
            )
        )
        for token in tokens
    ]

    # TLS·WebSocket·롱폴 연결 버퍼가 만들어진 뒤를 기준점으로 잡아 정상 초기 할당을
    # 메모리 누수로 오인하지 않는다. 이후 지속 워크로드에서 추가로 늘어난 양만 비교한다.
    await asyncio.sleep(1.0)
    baseline = await _runtime_snapshot(base_url, tokens[0], ssl_context)

    task_integrity_conn: Optional[sqlite3.Connection] = None
    task_integrity: Optional[dict[str, Any]] = None
    if workload == "task-read":
        if db_path is None:
            raise ValueError("task-read 부하는 db_path가 필요합니다")
        task_integrity_conn = sqlite3.connect(db_path, isolation_level=None, timeout=10)
        try:
            task_integrity = {
                "data_version_before": int(
                    task_integrity_conn.execute("PRAGMA data_version").fetchone()[0]
                ),
                "before": _task_workspace_signature(task_integrity_conn),
            }
        except Exception:
            task_integrity_conn.close()
            task_integrity_conn = None
            raise

    deadline = time.monotonic() + duration
    workload_tasks = [
        asyncio.create_task(
            _workload_user(
                index,
                base_url,
                tokens[index],
                account["generation_id"],
                deadline,
                think_min,
                think_max,
                ssl_context,
                workload,
            )
        )
        for index, account in enumerate(accounts)
    ]

    await asyncio.sleep(min(3.0, max(1.0, duration / 4)))
    during = await _runtime_snapshot(base_url, tokens[0], ssl_context)
    runtime_samples: list[dict[str, Any]] = [{"elapsed_seconds": 0.0, "snapshot": during}]
    runtime_monitor_errors: list[str] = []
    stop_monitor = asyncio.Event()
    monitor_task = asyncio.create_task(
        _monitor_runtime(
            base_url,
            tokens[0],
            stop_monitor,
            sample_interval,
            runtime_samples,
            runtime_monitor_errors,
            ssl_context,
            progress_path,
            cycle_number,
        )
    )
    started = time.perf_counter()
    try:
        nested_results = await asyncio.gather(*workload_tasks)
    finally:
        stop_monitor.set()
        await monitor_task
        if task_integrity_conn is not None and task_integrity is not None:
            try:
                task_integrity["data_version_after"] = int(
                    task_integrity_conn.execute("PRAGMA data_version").fetchone()[0]
                )
                task_integrity["after"] = _task_workspace_signature(task_integrity_conn)
                task_integrity["data_version_unchanged"] = (
                    task_integrity["data_version_before"]
                    == task_integrity["data_version_after"]
                )
                task_integrity["signature_unchanged"] = (
                    task_integrity["before"] == task_integrity["after"]
                )
            finally:
                task_integrity_conn.close()
    workload_seconds = max(0.001, time.perf_counter() - started + min(3.0, max(1.0, duration / 4)))

    # 짧은 테스트에서도 25초 롱폴을 즉시 정리한다.
    stop_long_poll.set()
    await asyncio.gather(
        *(
            asyncio.to_thread(
                _http_json,
                base_url,
                "/api/agent/sync",
                method="POST",
                token=token,
                ssl_context=ssl_context,
            )
            for token in tokens
        )
    )
    await asyncio.gather(*long_poll_tasks, return_exceptions=True)
    stop_ws.set()
    await asyncio.gather(*ws_tasks, return_exceptions=True)
    after = await _runtime_snapshot(base_url, tokens[0], ssl_context)

    request_count = sum(int(group["requests"]) for group in nested_results)
    status_counts: Counter[int] = Counter()
    endpoint_counts: Counter[str] = Counter()
    latencies: list[float] = []
    endpoint_samples_combined: dict[str, list[float]] = {}
    errors: list[dict[str, Any]] = []
    for group in nested_results:
        status_counts.update({int(key): value for key, value in group["statuses"].items()})
        endpoint_counts.update(group["endpoint_counts"])
        latencies.extend(float(value) for value in group["latency_samples"])
        for name, values in group["endpoint_latency_samples"].items():
            endpoint_samples_combined.setdefault(name, []).extend(values)
        if len(errors) < 20:
            errors.extend(group["errors"][: 20 - len(errors)])
    endpoint_latency: dict[str, dict[str, float]] = {}
    for name in endpoint_counts:
        values = endpoint_samples_combined.get(name, [])
        endpoint_latency[name] = {
            "p50": _percentile(values, 0.50),
            "p95": _percentile(values, 0.95),
            "p99": _percentile(values, 0.99),
            "max": round(max(values), 2) if values else 0.0,
        }

    baseline_rss = baseline.get("process", {}).get("rss_bytes") or 0
    after_rss = after.get("process", {}).get("rss_bytes") or 0
    memory_growth = (
        round((after_rss - baseline_rss) * 100.0 / baseline_rss, 2)
        if baseline_rss
        else None
    )
    report = {
        "login": {
            "statuses": dict(login_statuses),
            "p95_ms": _percentile(login_latencies, 0.95),
            "max_ms": round(max(login_latencies), 2) if login_latencies else 0.0,
            "control_probe": login_control_probe,
        },
        "workload": {
            "requests": request_count,
            "requests_per_second": round(request_count / workload_seconds, 2),
            "statuses": dict(status_counts),
            "endpoint_counts": dict(endpoint_counts),
            "latency_sample_size": len(latencies),
            "latency_percentiles_sampled": len(latencies) < request_count,
            "latency_ms": {
                "p50": _percentile(latencies, 0.50),
                "p95": _percentile(latencies, 0.95),
                "p99": _percentile(latencies, 0.99),
                "max": round(max(latencies), 2) if latencies else 0.0,
            },
            "endpoint_latency_ms": endpoint_latency,
            "errors": errors,
        },
        "connections_during_load": {
            "websocket": during.get("websocket", {}),
            "agents": during.get("agents", {}),
            "websocket_client_errors": ws_errors[:20],
            "long_poll_client_errors": long_poll_errors[:20],
        },
        "server": {
            "baseline": baseline,
            "during": during,
            "after": after,
            "memory_growth_percent_after_warmup": memory_growth,
            "runtime_samples": runtime_samples,
            "runtime_monitor_errors": runtime_monitor_errors,
            # 종료 후에는 정상적으로 WS/롱폴이 0이 되므로 연결 최저치는 부하가
            # 살아 있는 표본만 본다. 종료 RSS는 아래에서 메모리 최고점에만 합친다.
            "resource_summary": _resource_summary([baseline, *runtime_samples]),
        },
    }
    if task_integrity is not None:
        report["task_workspace_read_integrity"] = task_integrity

    after_rss_for_peak = after.get("process", {}).get("rss_bytes")
    resource_summary = report["server"]["resource_summary"]
    if after_rss_for_peak is not None:
        current_peak = resource_summary.get("max_rss_bytes")
        resource_summary["max_rss_bytes"] = max(
            value for value in (current_peak, after_rss_for_peak) if value is not None
        )
    return report


def _evaluate(report: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    workload = report["workload"]
    during = report["connections_during_load"]
    after_requests = report["server"]["after"]["requests"]
    users = args.users
    statuses = {int(k): v for k, v in workload["statuses"].items()}
    five_xx = sum(count for status, count in statuses.items() if status >= 500)
    transport_errors = statuses.get(0, 0)
    non_2xx = sum(count for status, count in statuses.items() if status < 200 or status >= 300)
    checks = {
        "workload_5xx_zero": five_xx == 0,
        "transport_errors_zero": transport_errors == 0,
        "workload_non_2xx_zero": non_2xx == 0,
        "sqlite_locked_zero": after_requests.get("sqlite_locked_total", 0) == 0,
        "p95_within_target": workload["latency_ms"]["p95"] <= args.max_p95_ms,
        "login_p95_within_target": report["login"]["p95_ms"]
        <= args.max_login_p95_ms,
        "websockets_connected": during["websocket"].get("connections", 0) >= users,
        "agent_long_polls_connected": during["agents"].get("long_poll_waiters", 0)
        >= max(1, int(users * 0.90)),
        "websocket_client_errors_zero": not during.get("websocket_client_errors", []),
        "long_poll_client_errors_zero": not during.get("long_poll_client_errors", []),
        "runtime_monitor_errors_zero": not report["server"].get(
            "runtime_monitor_errors", []
        ),
        "prior_cycles_functional_ok": report.get("prior_cycles_functional_ok", True),
    }
    task_integrity = report.get("task_workspace_read_integrity")
    if task_integrity is not None:
        checks["task_read_commits_zero"] = bool(
            task_integrity.get("data_version_unchanged")
        )
        checks["task_rows_unchanged"] = bool(task_integrity.get("signature_unchanged"))
    login_probe = report["login"].get("control_probe")
    if login_probe is not None:
        probe_statuses = {
            int(k): v for k, v in login_probe.get("statuses", {}).items()
        }
        checks["login_control_probe_healthy"] = (
            login_probe.get("samples", 0) > 0
            and set(probe_statuses) == {200}
            and login_probe.get("p95_ms", float("inf")) <= args.max_p95_ms
        )
    growth = report["server"].get("memory_growth_percent_after_warmup")
    if growth is not None:
        checks["memory_growth_within_target"] = growth <= args.max_memory_growth_percent
    resource_summary = report["server"].get("resource_summary", {})
    max_rss = resource_summary.get("max_rss_bytes")
    if args.max_rss_mb > 0 and max_rss is not None:
        checks["rss_within_target"] = max_rss <= args.max_rss_mb * 1024 * 1024
    min_websockets = resource_summary.get("min_websocket_connections")
    if min_websockets is not None:
        checks["sampled_websockets_healthy"] = min_websockets >= users
    min_agents = resource_summary.get("min_agent_connected_accounts")
    if min_agents is not None:
        # long_poll_waiters는 정상적인 25초 응답→즉시 재요청 사이에도 잠깐 감소한다.
        # 실제 연결 안정성은 서버가 추적하는 connected_accounts로 판정한다.
        checks["sampled_agent_connections_healthy"] = min_agents >= max(
            1, int(users * 0.90)
        )
    return {"passed": all(checks.values()), "checks": checks}


async def _async_main(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    port = args.port or _free_port()
    tls_enabled = bool(args.tls_certfile)
    scheme = "https" if tls_enabled else "http"
    ws_scheme = "wss" if tls_enabled else "ws"
    base_url = f"{scheme}://127.0.0.1:{port}"
    ws_url = f"{ws_scheme}://127.0.0.1:{port}"
    ssl_context = None
    if tls_enabled:
        ssl_context = ssl.create_default_context(cafile=str(args.tls_ca_file))
        ssl_context.minimum_version = ssl.TLSVersion.TLSv1_2
    with _temporary_load_root() as temp_name:
        temp_root = Path(temp_name)
        data_dir = temp_root / "data"
        db_path = temp_root / "load.db"
        accounts = _seed_database(
            data_dir,
            db_path,
            args.users,
            args.generations_per_user,
        )
        server_log = temp_root / "server.log"
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        with server_log.open("w", encoding="utf-8", errors="replace") as log_file:
            process = subprocess.Popen(
                [sys.executable, str(BACKEND / "serve.py")],
                cwd=str(BACKEND),
                env=_server_environment(
                    data_dir,
                    db_path,
                    port,
                    ssl_certfile=args.tls_certfile,
                    ssl_keyfile=args.tls_keyfile,
                ),
                stdout=log_file,
                stderr=subprocess.STDOUT,
                creationflags=creationflags,
            )
            try:
                server_limits = _apply_server_limits(
                    process.pid,
                    cpu_cores=args.server_cpu_cores,
                    priority=args.server_priority,
                )
                await asyncio.to_thread(
                    _wait_ready,
                    base_url,
                    process,
                    ssl_context=ssl_context,
                )
                loop = asyncio.get_running_loop()
                # 100 롱폴 + 100 HTTP 가 서로 클라이언트 스레드를 굶기지 않도록 격리 클라이언트 풀 확보.
                executor = ThreadPoolExecutor(
                    max_workers=max(64, args.users * 3 + 20),
                    thread_name_prefix="mvhub-load-client",
                )
                loop.set_default_executor(executor)
                try:
                    cycle_reports = []
                    progress_path = (
                        args.output.with_name(args.output.name + ".progress.json")
                        if args.output
                        else None
                    )
                    for cycle_index in range(args.cycles):
                        cycle_report = await _run_load(
                            base_url,
                            ws_url,
                            accounts,
                            args.duration,
                            args.think_min,
                            args.think_max,
                            args.sample_interval,
                            ssl_context,
                            progress_path,
                            cycle_index + 1,
                            db_path,
                            args.workload,
                        )
                        cycle_reports.append(cycle_report)
                        if progress_path is not None:
                            await asyncio.to_thread(
                                _atomic_write_json,
                                progress_path,
                                {
                                    "state": "cycle_completed",
                                    "updated_at_unix": round(time.time(), 3),
                                    "cycle": cycle_index + 1,
                                    "cycles": args.cycles,
                                    "workload": cycle_report["workload"],
                                    "server": {
                                        "resource_summary": cycle_report["server"][
                                            "resource_summary"
                                        ],
                                        "runtime_monitor_errors": cycle_report["server"][
                                            "runtime_monitor_errors"
                                        ],
                                    },
                                },
                            )
                    report = cycle_reports[-1]
                finally:
                    executor.shutdown(wait=True, cancel_futures=True)
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)

        first_after_rss = cycle_reports[0]["server"]["after"]["process"].get("rss_bytes") or 0
        last_after_rss = cycle_reports[-1]["server"]["after"]["process"].get("rss_bytes") or 0
        stabilized_growth = (
            round((last_after_rss - first_after_rss) * 100.0 / first_after_rss, 2)
            if first_after_rss
            else None
        )
        if args.cycles > 1:
            # 첫 전체 연결이 만든 정상 고수위를 워밍업으로 보고, 이후 사이클끼리 비교해 누수를 판정한다.
            report["server"]["memory_growth_percent_after_warmup"] = stabilized_growth
        report["cycle_summaries"] = [
            {
                "cycle": index + 1,
                "requests": cycle["workload"]["requests"],
                "statuses": cycle["workload"]["statuses"],
                "p95_ms": cycle["workload"]["latency_ms"]["p95"],
                "p99_ms": cycle["workload"]["latency_ms"]["p99"],
                "requests_per_second": cycle["workload"]["requests_per_second"],
                "sqlite_locked_total": cycle["server"]["after"]["requests"].get(
                    "sqlite_locked_total", 0
                ),
                "after_rss_bytes": cycle["server"]["after"]["process"].get("rss_bytes"),
                "max_rss_bytes": cycle["server"]["resource_summary"].get(
                    "max_rss_bytes"
                ),
                "max_cpu_percent_one_core": cycle["server"]["resource_summary"].get(
                    "max_cpu_percent_one_core"
                ),
                "runtime_sample_count": cycle["server"]["resource_summary"].get(
                    "sample_count"
                ),
                "min_agent_connected_accounts": cycle["server"][
                    "resource_summary"
                ].get("min_agent_connected_accounts"),
                "min_agent_long_poll_waiters": cycle["server"][
                    "resource_summary"
                ].get("min_agent_long_poll_waiters"),
                "within_cycle_memory_growth_percent": cycle["server"].get(
                    "memory_growth_percent_after_warmup"
                ),
                "websockets": cycle["connections_during_load"]["websocket"].get(
                    "connections", 0
                ),
                "long_poll_waiters": cycle["connections_during_load"]["agents"].get(
                    "long_poll_waiters", 0
                ),
                "websocket_errors": len(
                    cycle["connections_during_load"]["websocket_client_errors"]
                ),
                "long_poll_errors": len(
                    cycle["connections_during_load"]["long_poll_client_errors"]
                ),
                "task_read_commits_zero": (
                    cycle.get("task_workspace_read_integrity", {}).get(
                        "data_version_unchanged"
                    )
                    if cycle.get("task_workspace_read_integrity") is not None
                    else None
                ),
                "task_rows_unchanged": (
                    cycle.get("task_workspace_read_integrity", {}).get(
                        "signature_unchanged"
                    )
                    if cycle.get("task_workspace_read_integrity") is not None
                    else None
                ),
            }
            for index, cycle in enumerate(cycle_reports)
        ]
        report["prior_cycles_functional_ok"] = all(
            all(200 <= int(status) < 300 for status in cycle["workload"]["statuses"])
            and cycle["server"]["after"]["requests"].get("sqlite_locked_total", 0) == 0
            and cycle["connections_during_load"]["websocket"].get("connections", 0)
            >= args.users
            and cycle["connections_during_load"]["agents"].get("long_poll_waiters", 0)
            >= max(1, int(args.users * 0.90))
            and not cycle["connections_during_load"]["websocket_client_errors"]
            and not cycle["connections_during_load"]["long_poll_client_errors"]
            and not cycle["server"].get("runtime_monitor_errors")
            and (
                cycle.get("task_workspace_read_integrity") is None
                or (
                    cycle["task_workspace_read_integrity"].get(
                        "data_version_unchanged"
                    )
                    and cycle["task_workspace_read_integrity"].get(
                        "signature_unchanged"
                    )
                )
            )
            and cycle["workload"]["latency_ms"]["p95"] <= args.max_p95_ms
            and cycle["login"]["p95_ms"] <= args.max_login_p95_ms
            and (
                cycle["server"]["resource_summary"].get(
                    "min_websocket_connections"
                )
                or 0
            )
            >= args.users
            and (
                cycle["server"]["resource_summary"].get(
                    "min_agent_connected_accounts"
                )
                or 0
            )
            >= max(1, int(args.users * 0.90))
            and (
                args.max_rss_mb <= 0
                or (
                    cycle["server"]["resource_summary"].get("max_rss_bytes")
                    or 0
                )
                <= args.max_rss_mb * 1024 * 1024
            )
            for cycle in cycle_reports
        )
        report["config"] = {
            "users": args.users,
            "duration_seconds": args.duration,
            "cycles": args.cycles,
            "generations_per_user": args.generations_per_user,
            "workload": args.workload,
            "base_url": base_url,
            "isolated_temp_data": True,
            "tls_enabled": tls_enabled,
            "tls_certificate_verified": tls_enabled,
            "sample_interval_seconds": args.sample_interval,
            "max_rss_mb": args.max_rss_mb,
            "max_login_p95_ms": args.max_login_p95_ms,
        }
        report["server_limits"] = server_limits
        report["acceptance"] = _evaluate(report, args)
        if progress_path is not None:
            _atomic_write_json(
                progress_path,
                {
                    "state": "completed",
                    "updated_at_unix": round(time.time(), 3),
                    "acceptance": report["acceptance"],
                    "cycle_summaries": report["cycle_summaries"],
                },
            )
        if not report["acceptance"]["passed"]:
            report["operational_error_tail"] = _operational_error_tail(
                data_dir / "logs" / "mvhub-runtime.jsonl"
            )
            try:
                report["server_log_tail"] = server_log.read_text(
                    encoding="utf-8", errors="replace"
                ).splitlines()[-80:]
            except OSError:
                pass
        return report, 0 if report["acceptance"]["passed"] else 2


def _run_async_main(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    if os.name == "nt":
        # Windows Proactor는 다수 TLS 소켓을 정상 종료할 때도 WinError 10054를
        # 이벤트 루프 콜백 예외로 출력할 수 있다. 테스트 클라이언트는 asyncio
        # subprocess를 쓰지 않으므로 Selector 루프로 TLS 종료를 안정화한다.
        # sslproto의 정확한 정상 종료 경고만 루프가 완전히 닫힐 때까지 거른다.
        with _suppress_expected_ssl_close_warning():
            with asyncio.Runner(loop_factory=asyncio.SelectorEventLoop) as runner:
                return runner.run(_async_main(args))
    return asyncio.run(_async_main(args))


def main() -> int:
    parser = argparse.ArgumentParser(description="MV Hub 격리 100명 부하 테스트")
    parser.add_argument("--users", type=int, default=100)
    parser.add_argument("--duration", type=float, default=60.0)
    parser.add_argument(
        "--cycles",
        type=int,
        default=2,
        help="같은 서버에서 연속 실행할 횟수(첫 사이클은 메모리 고수위 워밍업)",
    )
    parser.add_argument("--generations-per-user", type=int, default=20)
    parser.add_argument(
        "--workload",
        choices=("mixed", "task-read"),
        default="mixed",
        help="mixed=일반 사용 혼합, task-read=작업 대시보드 읽기·DB 무쓰기 검증",
    )
    parser.add_argument("--think-min", type=float, default=0.25)
    parser.add_argument("--think-max", type=float, default=0.75)
    parser.add_argument("--max-p95-ms", type=float, default=500.0)
    parser.add_argument("--max-login-p95-ms", type=float, default=10_000.0)
    parser.add_argument("--max-memory-growth-percent", type=float, default=20.0)
    parser.add_argument(
        "--max-rss-mb",
        type=float,
        default=0.0,
        help="서버 프로세스 RSS 상한(MB). 0이면 상한 판정을 생략",
    )
    parser.add_argument(
        "--server-cpu-cores",
        type=int,
        default=0,
        help="격리 서버에 허용할 논리 CPU 수. 0이면 제한하지 않음",
    )
    parser.add_argument(
        "--server-priority",
        choices=("normal", "below-normal"),
        default="normal",
        help="격리 서버 프로세스 우선순위",
    )
    parser.add_argument(
        "--sample-interval",
        type=float,
        default=30.0,
        help="장기 시험 중 자원·연결 측정 간격(초)",
    )
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--tls-certfile", type=Path)
    parser.add_argument("--tls-keyfile", type=Path)
    parser.add_argument(
        "--tls-ca-file",
        type=Path,
        help="클라이언트가 인증서 검증에 사용할 CA PEM(자체 서명은 certfile과 같은 파일)",
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument("--quiet", action="store_true", help="콘솔에는 요약만 출력")
    args = parser.parse_args()
    if args.users < 1 or args.users > 500:
        parser.error("--users는 1~500")
    if args.duration <= 0:
        parser.error("--duration은 0보다 커야 합니다")
    if args.cycles < 1 or args.cycles > 10:
        parser.error("--cycles는 1~10")
    if args.generations_per_user < 1:
        parser.error("--generations-per-user는 1 이상")
    if args.server_cpu_cores < 0:
        parser.error("--server-cpu-cores는 0 이상")
    if args.max_rss_mb < 0:
        parser.error("--max-rss-mb는 0 이상")
    if args.sample_interval <= 0:
        parser.error("--sample-interval은 0보다 커야 합니다")
    if bool(args.tls_certfile) != bool(args.tls_keyfile):
        parser.error("HTTPS 사용 시 --tls-certfile과 --tls-keyfile을 모두 지정해야 합니다")
    if args.tls_ca_file and not args.tls_certfile:
        parser.error("--tls-ca-file은 HTTPS 설정과 함께 사용해야 합니다")
    if args.tls_certfile and not args.tls_ca_file:
        args.tls_ca_file = args.tls_certfile
    for option_name in ("tls_certfile", "tls_keyfile", "tls_ca_file"):
        path = getattr(args, option_name)
        if path:
            resolved = path.resolve()
            if not resolved.is_file():
                parser.error(f"--{option_name.replace('_', '-')} 파일을 찾을 수 없습니다: {path}")
            setattr(args, option_name, resolved)

    report, exit_code = _run_async_main(args)
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.quiet:
        summary = {
            "config": report["config"],
            "acceptance": report["acceptance"],
            "login": report["login"],
            "workload": {
                "requests": report["workload"]["requests"],
                "requests_per_second": report["workload"]["requests_per_second"],
                "statuses": report["workload"]["statuses"],
                "latency_ms": report["workload"]["latency_ms"],
            },
            "connections_during_load": report["connections_during_load"],
            "memory_growth_percent_after_warmup": report["server"][
                "memory_growth_percent_after_warmup"
            ],
            "resource_summary": report["server"]["resource_summary"],
            "server_limits": report["server_limits"],
            "cycle_summaries": report["cycle_summaries"],
            "server_process_during": report["server"]["during"]["process"],
        }
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(text)
    if args.output:
        _atomic_write_json(args.output, report)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
