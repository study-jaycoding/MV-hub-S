r"""MV Hub 100명 격리 부하 테스트.

운영 DB를 사용하지 않는다. 임시 DB와 임시 데이터 폴더, 임의의 로컬 포트에 테스트 서버를
띄운 뒤 100 로그인·WebSocket·에이전트 롱폴·읽기/쓰기를 재현하고 자동 종료한다.

빠른 검증:
  python tools\load_test_100.py --users 20 --duration 10

배포 전 기본:
  python tools\load_test_100.py --users 100 --duration 60 --generations-per-user 20

8시간 지속:
  python tools\load_test_100.py --users 100 --duration 28800 --output soak-result.json
"""

from __future__ import annotations

import argparse
import asyncio
import http.client
import json
import os
import random
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
PASSWORD = "load-test-password"


def _percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int(round((len(ordered) - 1) * p))))
    return round(ordered[index], 2)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _http_json(
    base_url: str,
    path: str,
    *,
    method: str = "GET",
    token: Optional[str] = None,
    body: Optional[dict[str, Any]] = None,
    timeout: float = 35.0,
) -> tuple[int, Any, float]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(base_url + path, data=data, method=method)
    request.add_header("Accept", "application/json")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            try:
                parsed: Any = json.loads(raw.decode("utf-8")) if raw else None
            except (UnicodeDecodeError, json.JSONDecodeError):
                parsed = {"bytes": len(raw)}
            return response.status, parsed, (time.perf_counter() - started) * 1000.0
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            parsed = raw.decode("utf-8", "replace")[:500]
        return exc.code, parsed, (time.perf_counter() - started) * 1000.0
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return 0, {"error": str(exc)}, (time.perf_counter() - started) * 1000.0


def _decode_response(raw: bytes) -> Any:
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
    ) -> None:
        parsed = urllib.parse.urlsplit(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError(f"지원하지 않는 base URL: {base_url}")
        connection_type = (
            http.client.HTTPSConnection
            if parsed.scheme == "https"
            else http.client.HTTPConnection
        )
        self._connection = connection_type(
            parsed.hostname,
            parsed.port,
            timeout=timeout,
        )
        self._token = token

    def request(
        self,
        path: str,
        *,
        method: str = "GET",
        body: Optional[dict[str, Any]] = None,
    ) -> tuple[int, Any, float]:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        started = time.perf_counter()
        try:
            self._connection.request(method, path, body=data, headers=headers)
            response = self._connection.getresponse()
            raw = response.read()
            return (
                response.status,
                _decode_response(raw),
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
            "INSERT INTO project(id, name, kind, archived) "
            "VALUES('load-project','Load Project','team',0)"
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
                "VALUES('load-project',?,'creator')",
                (uid,),
            )
            first_generation = ""
            for gen_index in range(generations_per_user):
                gid = f"load-g-{index:03d}-{gen_index:03d}"
                first_generation = first_generation or gid
                conn.execute(
                    "INSERT INTO generation("
                    "id, worker_id, creator_uid, prompt, model, params, color, status, "
                    "created_at, sort_ts, project_id, origin"
                    ") VALUES(?,?,?,?,?,?,?,?,datetime('now'),?,?,?)",
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
                        "load-project",
                        "local",
                    ),
                )
            accounts.append({"email": email, "uid": uid, "generation_id": first_generation})
    db.flush_pool()
    # 운영 부팅은 평면 media 파일을 앞 2글자 폴더로 샤딩한다. 처음부터 실제 최종 구조로 만든다.
    media = data_dir / "media" / "lo"
    media.mkdir(parents=True, exist_ok=True)
    (media / "load.bin").write_bytes(b"M" * (256 * 1024))
    return accounts


def _server_environment(data_dir: Path, db_path: Path, port: int) -> dict[str, str]:
    env = os.environ.copy()
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
    return env


def _wait_ready(base_url: str, process: subprocess.Popen, timeout: float = 45.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"테스트 서버가 조기 종료했습니다(code={process.returncode})")
        status, _, _ = _http_json(base_url, "/api/ready", timeout=2)
        if status == 200:
            return
        time.sleep(0.25)
    raise TimeoutError("테스트 서버 준비 시간 초과")


async def _login_all(
    base_url: str,
    accounts: list[dict[str, str]],
) -> tuple[list[str], list[float], Counter[int]]:
    async def one(account: dict[str, str]) -> tuple[int, Any, float]:
        return await asyncio.to_thread(
            _http_json,
            base_url,
            "/api/auth/login",
            method="POST",
            body={"email": account["email"], "password": PASSWORD},
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


async def _runtime_snapshot(base_url: str, admin_token: str) -> dict[str, Any]:
    status, body, _ = await asyncio.to_thread(
        _http_json,
        base_url,
        "/api/admin/runtime",
        token=admin_token,
    )
    if status != 200 or not isinstance(body, dict):
        raise RuntimeError(f"런타임 지표 조회 실패: status={status}, body={body}")
    return body


async def _websocket_worker(
    ws_url: str,
    token: str,
    stop: asyncio.Event,
    ready: asyncio.Event,
    errors: list[str],
) -> None:
    import websockets

    try:
        encoded = urllib.parse.quote(token, safe="")
        async with websockets.connect(
            f"{ws_url}/ws?token={encoded}",
            open_timeout=15,
            close_timeout=3,
            ping_interval=20,
            ping_timeout=20,
        ) as websocket:
            ready.set()
            while not stop.is_set():
                try:
                    await asyncio.wait_for(stop.wait(), timeout=10)
                except asyncio.TimeoutError:
                    await websocket.send("ping")
    except Exception as exc:  # noqa: BLE001 — 부하 결과로 수집
        errors.append(str(exc))
        ready.set()


async def _workload_user(
    index: int,
    base_url: str,
    token: str,
    generation_id: str,
    deadline: float,
    think_min: float,
    think_max: float,
) -> list[dict[str, Any]]:
    rng = random.Random(10_000 + index)
    results: list[dict[str, Any]] = []
    colors = [None, "#e85d5d", "#58a6ff", "#6bcB77"]
    client = _KeepAliveJsonClient(base_url, token=token)
    try:
        while time.monotonic() < deadline:
            roll = rng.random()
            if roll < 0.55:
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
            results.append(
                {
                    "name": name,
                    "status": status,
                    "elapsed_ms": elapsed,
                    "error": response if status == 0 or status >= 500 else None,
                }
            )
            await asyncio.sleep(rng.uniform(think_min, think_max))
    finally:
        client.close()
    return results


async def _long_poll_worker(
    base_url: str,
    token: str,
    stop: asyncio.Event,
    errors: list[str],
) -> None:
    """실제 에이전트처럼 롱폴이 반환되면 종료 신호 전까지 즉시 다시 대기한다."""
    client = _KeepAliveJsonClient(base_url, token=token, timeout=35)
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
) -> dict[str, Any]:
    tokens, login_latencies, login_statuses = await _login_all(base_url, accounts)

    # 연결·SQLite 풀·목록 캐시를 한 번 데운 뒤 메모리 기준점을 잡는다.
    await asyncio.gather(
        *(
            asyncio.to_thread(
                _http_json,
                base_url,
                "/api/generations?tab=my&limit=20",
                token=token,
            )
            for token in tokens
        )
    )
    baseline = await _runtime_snapshot(base_url, tokens[0])

    stop_ws = asyncio.Event()
    ws_errors: list[str] = []
    ws_ready = [asyncio.Event() for _ in tokens]
    ws_tasks = [
        asyncio.create_task(
            _websocket_worker(ws_url, token, stop_ws, ws_ready[index], ws_errors)
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
            )
        )
        for token in tokens
    ]

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
            )
        )
        for index, account in enumerate(accounts)
    ]

    await asyncio.sleep(min(3.0, max(1.0, duration / 4)))
    during = await _runtime_snapshot(base_url, tokens[0])
    started = time.perf_counter()
    nested_results = await asyncio.gather(*workload_tasks)
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
            )
            for token in tokens
        )
    )
    await asyncio.gather(*long_poll_tasks, return_exceptions=True)
    stop_ws.set()
    await asyncio.gather(*ws_tasks, return_exceptions=True)
    after = await _runtime_snapshot(base_url, tokens[0])

    results = [item for group in nested_results for item in group]
    status_counts = Counter(int(item["status"]) for item in results)
    endpoint_counts = Counter(str(item["name"]) for item in results)
    latencies = [float(item["elapsed_ms"]) for item in results]
    endpoint_latency: dict[str, dict[str, float]] = {}
    for name in endpoint_counts:
        values = [float(item["elapsed_ms"]) for item in results if item["name"] == name]
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
    return {
        "login": {
            "statuses": dict(login_statuses),
            "p95_ms": _percentile(login_latencies, 0.95),
            "max_ms": round(max(login_latencies), 2) if login_latencies else 0.0,
        },
        "workload": {
            "requests": len(results),
            "requests_per_second": round(len(results) / workload_seconds, 2),
            "statuses": dict(status_counts),
            "endpoint_counts": dict(endpoint_counts),
            "latency_ms": {
                "p50": _percentile(latencies, 0.50),
                "p95": _percentile(latencies, 0.95),
                "p99": _percentile(latencies, 0.99),
                "max": round(max(latencies), 2) if latencies else 0.0,
            },
            "endpoint_latency_ms": endpoint_latency,
            "errors": [item for item in results if item["status"] == 0 or item["status"] >= 500][
                :20
            ],
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
        },
    }


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
        "websockets_connected": during["websocket"].get("connections", 0) >= users,
        "agent_long_polls_connected": during["agents"].get("long_poll_waiters", 0)
        >= max(1, int(users * 0.90)),
        "websocket_client_errors_zero": not during.get("websocket_client_errors", []),
        "long_poll_client_errors_zero": not during.get("long_poll_client_errors", []),
        "prior_cycles_functional_ok": report.get("prior_cycles_functional_ok", True),
    }
    growth = report["server"].get("memory_growth_percent_after_warmup")
    if growth is not None:
        checks["memory_growth_within_target"] = growth <= args.max_memory_growth_percent
    return {"passed": all(checks.values()), "checks": checks}


async def _async_main(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    port = args.port or _free_port()
    base_url = f"http://127.0.0.1:{port}"
    ws_url = f"ws://127.0.0.1:{port}"
    with tempfile.TemporaryDirectory(prefix="mvhub-load-") as temp_name:
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
                env=_server_environment(data_dir, db_path, port),
                stdout=log_file,
                stderr=subprocess.STDOUT,
                creationflags=creationflags,
            )
            try:
                await asyncio.to_thread(_wait_ready, base_url, process)
                loop = asyncio.get_running_loop()
                # 100 롱폴 + 100 HTTP 가 서로 클라이언트 스레드를 굶기지 않도록 격리 클라이언트 풀 확보.
                executor = ThreadPoolExecutor(
                    max_workers=max(64, args.users * 3 + 20),
                    thread_name_prefix="mvhub-load-client",
                )
                loop.set_default_executor(executor)
                try:
                    cycle_reports = []
                    for _ in range(args.cycles):
                        cycle_reports.append(
                            await _run_load(
                                base_url,
                                ws_url,
                                accounts,
                                args.duration,
                                args.think_min,
                                args.think_max,
                            )
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
                "sqlite_locked_total": cycle["server"]["after"]["requests"].get(
                    "sqlite_locked_total", 0
                ),
                "after_rss_bytes": cycle["server"]["after"]["process"].get("rss_bytes"),
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
            for cycle in cycle_reports
        )
        report["config"] = {
            "users": args.users,
            "duration_seconds": args.duration,
            "cycles": args.cycles,
            "generations_per_user": args.generations_per_user,
            "base_url": base_url,
            "isolated_temp_data": True,
        }
        report["acceptance"] = _evaluate(report, args)
        if not report["acceptance"]["passed"]:
            try:
                report["server_log_tail"] = server_log.read_text(
                    encoding="utf-8", errors="replace"
                ).splitlines()[-80:]
            except OSError:
                pass
        return report, 0 if report["acceptance"]["passed"] else 2


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
    parser.add_argument("--think-min", type=float, default=0.25)
    parser.add_argument("--think-max", type=float, default=0.75)
    parser.add_argument("--max-p95-ms", type=float, default=500.0)
    parser.add_argument("--max-memory-growth-percent", type=float, default=20.0)
    parser.add_argument("--port", type=int, default=0)
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

    report, exit_code = asyncio.run(_async_main(args))
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
            "server_process_during": report["server"]["during"]["process"],
        }
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(text)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + "\n", encoding="utf-8")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
