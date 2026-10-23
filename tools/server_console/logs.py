"""로그 파일 꼬리를 따라가며 탭별로 나눈다. 운영 보기이지 완전한 감사 기록이 아니다
(회전 직전 끝부분은 놓칠 수 있다 — log_viewer.LogFollower 와 같은 한계)."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import log_viewer  # tools/ — 표준 라이브러리만 쓴다

from . import names
from .install import Installation

TABS = (
    ("all", "전체"), ("generation", "생성"), ("connection", "사용자·접속"), ("backup", "백업"),
    ("settings", "설정 변경"), ("lifecycle", "서버 시작·종료"), ("errors", "오류·경고"), ("updates", "업데이트 기록"),
)
_LIFECYCLE = {"startup_begin", "startup_ready", "startup_failed", "shutdown_complete", "shutdown_failed",
              "readiness_failed", "database_unready"}
_ERROR_LEVELS = {"WARNING", "ERROR", "CRITICAL"}
_RESERVED = {"ts", "level", "logger", "service", "run_id", "pid", "message", "event"}
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
# 터미널 색·커서 코드(npm·pip 출력) — '?[32m' 처럼 남지 않게 통째로 지운다.
_ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[ -/]+[0-~]|[@-Z\\-_])")
SOURCE_NAMES = {names.RUNTIME_LOG: "실행 기록", "server_console.log": "서버 창", "watchdog_console.log": "감시",
                "backup_console.log": "백업 복사"}
_TEXT_ERROR = re.compile(r"\b(ERROR|CRITICAL|Traceback|failed|FAILED)\b")
MAX_LINE = 600
MAX_PER_POLL = 1500
MAX_TOTAL_PER_POLL = 3000


@dataclass(frozen=True)
class LogLine:
    tabs: frozenset[str]
    text: str
    level: str
    worker: str = ""


def clean(text: str) -> str:
    """화면에 글자로만 보이게 터미널 색 코드를 지우고, 남은 제어 문자는 '?' 로, 길이를 자른다."""
    text = _CONTROL.sub("?", _ANSI.sub("", text.replace("\r", "")))
    return text if len(text) <= MAX_LINE else text[:MAX_LINE] + "…"


def short_name(name: str) -> str:
    """아래 줄의 출처 이름(파일 이름 대신) — 준비 로그는 실행마다 이름이 길다."""
    return "업데이트 준비" if name.startswith("server-prepare-") else SOURCE_NAMES.get(name, name)


def classify(payload: dict[str, Any]) -> frozenset[str]:
    event = str(payload.get("event") or payload.get("message") or "")
    level = str(payload.get("level") or "INFO").upper()
    tabs = {"all"}
    if event.startswith("generation_") or event == "worker_telemetry_received":
        tabs.add("generation")
    if event.startswith(("browser_", "websocket_", "agent_")):
        tabs.add("connection")
    if event.startswith(("backup_", "worker_backup_")):
        tabs.add("backup")
    if event.startswith("audit_"):
        tabs.add("settings")
    if event in _LIFECYCLE:
        tabs.add("lifecycle")
    if event.startswith("release_"):
        tabs.add("updates")
    if level in _ERROR_LEVELS:
        tabs.add("errors")
    return frozenset(tabs)


def render(payload: dict[str, Any]) -> str:
    """알려진 이벤트는 log_viewer 문구 그대로, 모르는 이벤트도 버리지 않고 간단히 보인다."""
    line = log_viewer.format_event(payload)
    if line:
        return clean(line)
    event = str(payload.get("event") or payload.get("message") or "운영 이벤트")
    level = str(payload.get("level") or "INFO")
    stamp = str(payload.get("ts") or "")[:19].replace("T", " ") or "-"
    details = [f"{k}={v}" for k, v in payload.items()
               if k not in _RESERVED and isinstance(v, (str, int, float, bool)) and v not in ("", None)]
    suffix = " | " + " · ".join(details) if details else ""
    return clean(f"[{stamp}] {level:<7} {event}{suffix}")


def parse_json_line(raw: str) -> LogLine | None:
    try:
        payload = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    return LogLine(classify(payload), render(payload), str(payload.get("level") or "INFO").upper(),
                   str(payload.get("worker_name") or ""))


def parse_text_line(raw: str, base_tabs: frozenset[str], only: bool = False) -> LogLine | None:
    """only = 그 탭에만(업데이트 준비 로그는 '업데이트 기록' 탭에만 — 전체·오류 탭을 덮지 않게)."""
    text = raw.strip()
    if not text:
        return None
    level = "ERROR" if _TEXT_ERROR.search(text) else "INFO"
    if only:
        return LogLine(base_tabs, clean(text), level)
    tabs = set(base_tabs) | {"all"}
    if level == "ERROR":
        tabs.add("errors")
    if "[supervisor]" in text:
        tabs.add("updates")
    return LogLine(frozenset(tabs), clean(text), level)


class _Source:
    def __init__(self, path: Path, kind: str, tabs: frozenset[str], initial: int, only: bool = False) -> None:
        self.path = path
        self.kind = kind
        self.tabs = tabs
        self.initial = initial
        self.only = only
        self.follower: log_viewer.LogFollower | None = None
        self.state = "missing"

    def poll(self) -> list[str]:
        if self.follower is None:
            if not self.path.exists():
                self.state = "missing"
                return []
            try:
                # 같은 핸들에서 최근 줄과 이어 읽을 위치를 얻는다(log_viewer 와 같은 방식).
                lines, position, identity = log_viewer._tail_snapshot(self.path, self.initial)
            except OSError:
                self.state = "error"
                return []
            self.follower = log_viewer.LogFollower(self.path, position, identity)
            self.state = "ok"
            return [line.rstrip("\r\n") for line in lines]
        if not self.path.exists():
            self.state = "missing"
            return []
        try:
            with self.path.open("rb"):
                pass
        except OSError:
            self.state = "error"
            return []
        self.state = "ok"
        return self.follower.poll()


class LogHub:
    """여러 로그 파일을 한 번에 따라간다. poll() 은 새 줄만, 한 번에 MAX_PER_POLL 까지."""

    def __init__(self, inst: Installation, initial: int = 300) -> None:
        self.inst = inst
        self.sources: list[_Source] = [_Source(inst.runtime_log, "json", frozenset(), initial)]
        for name in names.CONSOLE_LOGS:
            tabs = frozenset({"backup"}) if name.startswith("backup") else frozenset({"lifecycle"})
            self.sources.append(_Source(inst.logs / name, "text", tabs, 80))
        self.prepare: _Source | None = None
        self.alerts: dict[str, str] = {}

    def _latest_prepare_log(self) -> Path | None:
        try:
            logs = sorted(self.inst.logs.glob("server-prepare-*.log"), key=lambda p: p.stat().st_mtime)
        except OSError:
            return None
        return logs[-1] if logs else None

    def states(self) -> dict[str, str]:
        result = {source.path.name: source.state for source in self.sources}
        if self.prepare:
            result[self.prepare.path.name] = self.prepare.state
        return result

    def poll(self) -> list[LogLine]:
        out: list[LogLine] = []
        latest = self._latest_prepare_log()
        if latest and (self.prepare is None or self.prepare.path != latest):
            self.prepare = _Source(latest, "text", frozenset({"updates"}), 200, only=True)
        for source in self.sources + ([self.prepare] if self.prepare else []):
            raw_lines = source.poll()
            skipped = max(0, len(raw_lines) - MAX_PER_POLL)
            if skipped:
                out.append(LogLine(frozenset({"all", "errors"}),
                                   f"… {source.path.name}: 한꺼번에 {skipped}줄이 쌓여 앞부분을 건너뜀", "WARNING"))
                raw_lines = raw_lines[-MAX_PER_POLL:]
            for raw in raw_lines:
                line = (parse_json_line(raw) if source.kind == "json"
                        else parse_text_line(raw, source.tabs, only=source.only))
                if line is not None:
                    out.append(line)
        for name in names.ALERT_FILES:
            path = self.inst.logs / name
            try:
                text = path.read_text(encoding="utf-8", errors="replace").strip() if path.is_file() else ""
            except OSError:
                text = ""
            if text and self.alerts.get(name) != text:
                out.append(LogLine(frozenset({"all", "errors", "lifecycle"}), clean(f"[ALERT] {text}"), "ERROR"))
            self.alerts[name] = text
        if len(out) > MAX_TOTAL_PER_POLL:  # 파일이 여럿이라 파일별 상한만으로는 합이 커진다
            skipped = len(out) - MAX_TOTAL_PER_POLL
            out = [LogLine(frozenset({"all", "errors"}), f"… 한꺼번에 {skipped}줄이 쌓여 앞부분을 건너뜀", "WARNING"),
                   *out[-MAX_TOTAL_PER_POLL:]]
        return out
