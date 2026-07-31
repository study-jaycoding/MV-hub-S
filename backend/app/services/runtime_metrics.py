"""가벼운 운영 런타임 지표.

외부 모니터링 서버 없이도 100명 배포 전 HTTP 지연·오류·SQLite 잠금·프로세스 자원과
디스크 증가를 확인한다. 요청 표본은 고정 크기 deque, 디스크 스캔은 TTL 캐시라 메모리와
I/O가 사용자 수에 비례해 계속 늘지 않는다.
"""

from __future__ import annotations

import ctypes
import os
import shutil
import sys
import threading
import time
from collections import Counter, deque
from pathlib import Path
from typing import Any, Optional

from ..config import DATA_DIR, MEDIA_DIR


def _percentile(sorted_values: list[float], percentile: float) -> float:
    if not sorted_values:
        return 0.0
    index = max(0, min(len(sorted_values) - 1, int(round((len(sorted_values) - 1) * percentile))))
    return round(sorted_values[index], 2)


class RuntimeMetrics:
    def __init__(self, sample_max: int = 5000) -> None:
        self._lock = threading.Lock()
        self._started_at = time.time()
        self._request_started = time.perf_counter()
        self._latencies: deque[float] = deque(maxlen=max(100, sample_max))
        self._status_counts: Counter[str] = Counter()
        self._method_counts: Counter[str] = Counter()
        self._path_counts: Counter[str] = Counter()
        self._in_flight = 0
        self._request_total = 0
        self._db_locked_total = 0
        self._db_connections_opened = 0
        self._last_wall = time.perf_counter()
        self._last_cpu = time.process_time()
        self._disk_cached_at = 0.0
        self._disk_cache: dict[str, Any] = {}

    def request_begin(self) -> float:
        with self._lock:
            self._in_flight += 1
        return time.perf_counter()

    def request_end(
        self,
        *,
        started: float,
        status: int,
        method: str,
        path: str,
    ) -> float:
        elapsed_ms = max(0.0, (time.perf_counter() - started) * 1000.0)
        self.record_request(elapsed_ms, status=status, method=method, path=path, was_in_flight=True)
        return elapsed_ms

    def record_request(
        self,
        elapsed_ms: float,
        *,
        status: int,
        method: str = "GET",
        path: str = "/",
        was_in_flight: bool = False,
    ) -> None:
        status_class = f"{max(0, int(status)) // 100}xx"
        with self._lock:
            if was_in_flight:
                self._in_flight = max(0, self._in_flight - 1)
            self._request_total += 1
            self._latencies.append(max(0.0, float(elapsed_ms)))
            self._status_counts[status_class] += 1
            self._method_counts[(method or "UNKNOWN").upper()] += 1
            self._path_counts[path or "/"] += 1

    def record_db_locked(self) -> None:
        with self._lock:
            self._db_locked_total += 1

    def record_db_connection_opened(self) -> None:
        with self._lock:
            self._db_connections_opened += 1

    def request_snapshot(self) -> dict[str, Any]:
        with self._lock:
            latencies = sorted(self._latencies)
            total = self._request_total
            uptime = max(0.001, time.time() - self._started_at)
            return {
                "uptime_seconds": round(uptime, 1),
                "total": total,
                "in_flight": self._in_flight,
                "requests_per_minute_average": round(total * 60.0 / uptime, 2),
                "status": dict(self._status_counts),
                "methods": dict(self._method_counts),
                "top_paths": [
                    {"path": path, "count": count}
                    for path, count in self._path_counts.most_common(12)
                ],
                "latency_sample_size": len(latencies),
                "latency_ms": {
                    "p50": _percentile(latencies, 0.50),
                    "p95": _percentile(latencies, 0.95),
                    "p99": _percentile(latencies, 0.99),
                    "max": round(latencies[-1], 2) if latencies else 0.0,
                },
                "sqlite_locked_total": self._db_locked_total,
                "db_connections_opened_total": self._db_connections_opened,
            }

    def process_snapshot(self) -> dict[str, Any]:
        now_wall = time.perf_counter()
        now_cpu = time.process_time()
        with self._lock:
            wall_delta = max(0.000001, now_wall - self._last_wall)
            cpu_delta = max(0.0, now_cpu - self._last_cpu)
            self._last_wall = now_wall
            self._last_cpu = now_cpu
        return {
            # 100 = 논리 코어 1개를 완전히 사용. 멀티스레드면 100을 넘을 수 있다.
            "cpu_percent_one_core": round(cpu_delta * 100.0 / wall_delta, 2),
            "rss_bytes": _rss_bytes(),
            "threads": threading.active_count(),
            "pid": os.getpid(),
        }

    def disk_snapshot(self, ttl_seconds: float = 60.0) -> dict[str, Any]:
        now = time.monotonic()
        with self._lock:
            if self._disk_cache and (now - self._disk_cached_at) < ttl_seconds:
                return dict(self._disk_cache)
        value = _disk_snapshot()
        with self._lock:
            self._disk_cached_at = now
            self._disk_cache = value
        return dict(value)

    def snapshot(self) -> dict[str, Any]:
        return {
            "requests": self.request_snapshot(),
            "process": self.process_snapshot(),
            "disk": self.disk_snapshot(),
        }


def _rss_bytes_windows() -> Optional[int]:
    try:
        from ctypes import wintypes

        class ProcessMemoryCounters(ctypes.Structure):
            _fields_ = [
                ("cb", wintypes.DWORD),
                ("PageFaultCount", wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        counters = ProcessMemoryCounters()
        counters.cb = ctypes.sizeof(counters)
        get_current_process = ctypes.windll.kernel32.GetCurrentProcess
        get_current_process.restype = wintypes.HANDLE
        get_process_memory_info = ctypes.windll.psapi.GetProcessMemoryInfo
        get_process_memory_info.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(ProcessMemoryCounters),
            wintypes.DWORD,
        ]
        get_process_memory_info.restype = wintypes.BOOL
        handle = get_current_process()
        ok = get_process_memory_info(
            handle,
            ctypes.byref(counters),
            counters.cb,
        )
        return int(counters.WorkingSetSize) if ok else None
    except (AttributeError, OSError, ValueError):
        return None


def _rss_bytes() -> Optional[int]:
    if sys.platform == "win32":
        return _rss_bytes_windows()
    try:
        statm = Path("/proc/self/statm").read_text("ascii").split()
        return int(statm[1]) * int(os.sysconf("SC_PAGE_SIZE"))
    except (OSError, ValueError, IndexError, AttributeError):
        return None


def _file_size(path: Path) -> int:
    try:
        return path.stat().st_size if path.is_file() else 0
    except OSError:
        return 0


def _directory_size(path: Path) -> int:
    total = 0
    try:
        with os.scandir(path) as entries:
            for entry in entries:
                try:
                    if entry.is_symlink():
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        total += _directory_size(Path(entry.path))
                    elif entry.is_file(follow_symlinks=False):
                        total += entry.stat(follow_symlinks=False).st_size
                except OSError:
                    continue
    except OSError:
        pass
    return total


def _disk_snapshot() -> dict[str, Any]:
    from ..db import get_db_path

    db_path = get_db_path()
    try:
        usage = shutil.disk_usage(DATA_DIR)
        free_bytes: Optional[int] = usage.free
        total_bytes: Optional[int] = usage.total
    except OSError:
        free_bytes = None
        total_bytes = None
    thumbs = MEDIA_DIR / ".thumbs"
    return {
        "data_root": str(DATA_DIR),
        "volume_total_bytes": total_bytes,
        "volume_free_bytes": free_bytes,
        "db_bytes": _file_size(db_path),
        "wal_bytes": _file_size(Path(str(db_path) + "-wal")),
        "shm_bytes": _file_size(Path(str(db_path) + "-shm")),
        "media_bytes": _directory_size(MEDIA_DIR),
        "thumb_cache_bytes": _directory_size(thumbs),
    }


metrics = RuntimeMetrics(
    sample_max=int(os.environ.get("CONTENT_HUB_METRICS_SAMPLE_MAX", "5000"))
)
