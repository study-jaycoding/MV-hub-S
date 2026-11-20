"""이 PC의 Codex 활성화 — 표식, 실행/상태 잠금, MV 도구 없는 연결 점검."""
from __future__ import annotations

import json
import os
import secrets
import sys
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .. import config
from .agent_chat_parse import CodexParser

CODEX_POLICY = "2026-11-14"
PROBE_TIMEOUT = 120.0
REAP_RETRY_SECONDS = 5.0
PLAN_TIMEOUT = 15.0
DISABLED = "설정에서 [연결]을 눌러 켜요"
# 공식 app-server 의 PlanType(codex-rs/protocol/src/account.rs) 중 알려진 유료 종류만 이름으로 — 그 밖은 표시하지 않는다.
PLAN_NAMES = {"go": "Go", "plus": "Plus", "pro": "Pro", "prolite": "Pro Lite", "promax": "Pro Max",
              "team": "Team", "business": "Business", "enterprise": "Enterprise", "edu": "Edu"}


class CodexError(RuntimeError):
    pass


class Busy(CodexError):
    pass


def _path(name: str) -> Path:
    return config.AGENT_CHAT_DIR / name


def _read(name: str) -> dict | None:
    try:
        value = json.loads(_path(name).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def marker() -> dict | None:
    value = _read("codex_enabled.json")
    if not value or any(not isinstance(value.get(key), str) or not value[key] for key in ("version", "policy", "at")):
        return None
    try:
        datetime.fromisoformat(value["at"])
    except ValueError:
        return None
    return value


def _write(name: str, value: dict) -> None:
    target = _path(name)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{name}.{secrets.token_hex(16)}.tmp")
    try:
        temporary.write_text(json.dumps(value), encoding="utf-8")
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def _lock(name: str, *, wait: bool = False):
    config.AGENT_CHAT_DIR.mkdir(parents=True, exist_ok=True)
    with _path(name).open("a+b") as stream:
        stream.seek(0, 2)
        if not stream.tell():
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK if wait else msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
        except OSError as exc:
            raise Busy("잠시 뒤 다시 해 주세요" if wait else "확인하는 중이에요") from exc
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def work_problem() -> str | None:
    try:
        work = _path("work").resolve()
        if any((work / name).exists() for name in ("AGENTS.md", "AGENTS.override.md", ".codex")) or any(
                (parent / ".git").exists() for parent in (work, *work.parents)):
            return "작업 폴더에 다른 지침 파일이 있어요"
    except OSError:
        return "작업 폴더를 확인하지 못했어요"
    return None


def state(prefix: list[str] | None) -> dict:
    from . import agent_chat_process as process

    saved = marker()
    result = {"enabled": False, "version": saved["version"] if saved else "", "reason": None}
    if not prefix:
        result["reason"] = "이 PC 에 설치되어 있지 않습니다"
    elif saved is None:
        result["reason"] = DISABLED
    else:
        version = process.cli_version(prefix)
        result["version"] = version
        result["enabled"] = bool(version in process.CODEX_VERIFIED and saved["version"] == version
                                 and saved["policy"] == CODEX_POLICY and target_matches(saved, prefix))
        if not version:
            result["reason"] = "판을 확인하지 못했습니다"
        elif version not in process.CODEX_VERIFIED:
            result["reason"] = f"점검 필요 — 확인하지 않은 판입니다({version})"
        elif not result["enabled"]:
            result["reason"] = "격리 정책이나 Codex 판이 바뀌어 다시 연결해야 해요"
        else:
            result["reason"] = work_problem() or process.auth_problem(prefix)
    return result


def target_matches(saved: dict, prefix: list[str]) -> bool:
    from . import agent_chat_process as process

    target = process.codex_target(prefix)
    if "target" not in saved:
        return target["kind"] == "npm" and saved.get("version") in process.CODEX_VERIFIED and saved.get("policy") == CODEX_POLICY
    return saved["target"] == target


def start_chain(chain_id: str) -> None:
    """부르는 쪽이 codex_enabled.lock 을 쥔 상태에서만 쓴다."""
    _write("codex_chain.json", {"id": chain_id, "cancelled": False})


def check_chain(chain_id: str | None) -> None:
    if chain_id is not None and _read("codex_chain.json") != {"id": chain_id, "cancelled": False}:
        raise CodexError("연결이 취소됐어요")


def plan_name(prefix: list[str]) -> str | None:
    """구독 종류 표시 이름 — 공식 app-server 의 account/read 만 읽는다(로그인 파일은 열지 않는다, 설계 3-4).
    실패·무료·모르는 값은 None — 요금제 표시만 빠지고 사용 가능 판정은 그대로다."""
    from . import agent_chat_process as process

    request = "".join(json.dumps(message) + "\n" for message in (
        {"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "mvhub-plan", "version": "1"}}},
        {"method": "initialized"},
        {"id": 2, "method": "account/read", "params": {}},
    )).encode("utf-8")
    try:
        job = process.JobProcess()
    except (OSError, RuntimeError):
        return None
    timer = threading.Timer(PLAN_TIMEOUT, job.terminate)
    timer.daemon = True
    plan = None
    try:
        timer.start()
        work = _path("plan-probe")  # Codex 작업 폴더(work)와 따로 — 검사가 보는 폴더를 더럽히지 않게
        work.mkdir(parents=True, exist_ok=True)
        job.start([*prefix, "app-server"], work, process.child_env())
        # stdin 을 닫으면 app-server 가 응답 전에 끝난다(2026-11-16 실측) — 응답을 받을 때까지 열어 둔다.
        job.proc.stdin.write(request)
        job.proc.stdin.flush()
        for raw in job.lines():
            try:
                message = json.loads(raw)
            except ValueError:
                continue
            if isinstance(message, dict) and message.get("id") == 2:
                result = message.get("result")
                account = result.get("account") if isinstance(result, dict) else None
                if isinstance(account, dict) and account.get("type") == "chatgpt":
                    plan = PLAN_NAMES.get(str(account.get("planType") or "").lower())
                break
    except Exception:  # noqa: BLE001 — 표시용 조회라 어떤 실패도 요금제 표시만 뺀다
        plan = None
    finally:
        timer.cancel()
        if not job.reap():
            job.reap()  # 못 거두면 한 번 더 — Job 은 닫힐 때 남은 자식을 함께 끈다
    return plan


def _probe(prefix: list[str], model: str, work: Path, nonce: str) -> str | None:
    from . import agent_chat_process as process

    entry = {"command": sys.executable, "args": ["-I", str(Path(__file__).with_name("agent_chat_probe_mcp.py")), nonce]}
    command = process.build_command("codex", prefix, model=model, effort="low", resume=None, mcp_entry=entry,
                                    mcp_file=work / "probe-mcp.json", work=work)
    job = process.JobProcess()
    expired = threading.Event()

    def timeout():
        expired.set()
        job.terminate()

    timer = threading.Timer(PROBE_TIMEOUT, timeout)
    timer.daemon = True
    parser, calls, answer, completed, failed = CodexParser(), 0, "", False, False
    reason = None
    try:
        timer.start()
        job.start(command, work, process.child_env())
        if expired.is_set():
            job.terminate()
        else:
            job.feed("연결 점검: check_connection 을 정확히 한 번 부르고 돌려받은 글만 그대로 답하라".encode("utf-8"))
        for raw in job.lines():
            for event in parser.feed(raw):
                if event["kind"] == "violation":
                    reason = "연결 점검에서 허용하지 않은 동작이 나왔어요"
                    job.terminate()
                elif event["kind"] == "tool" and event["name"] == "check_connection" and event["status"] == "done":
                    calls += 1
                elif event["kind"] == "text":
                    answer = event["text"]
                elif event["kind"] == "result":
                    completed |= event["ok"]
                    failed |= not event["ok"]
    finally:
        # 회수 실패는 점검 실패다. 실행 잠금은 0개 확인 전까지 부르는 쪽이 유지한다.
        try:
            if not job.reap():
                reason = "연결 점검의 실행 묶음을 회수하지 못했어요"
                while True:
                    time.sleep(REAP_RETRY_SECONDS)
                    if job.reap():
                        break
        finally:
            timer.cancel()
    if expired.is_set():
        return "연결 점검 시간이 초과됐어요"
    return reason or (None if completed and not failed and calls == 1 and nonce in answer else "연결 점검을 통과하지 못했어요")


def enable(model: str, still_current=lambda: None, chain_id: str | None = None) -> None:
    from . import agent_chat_process as process

    with _lock("codex_probe.lock"):
        token = secrets.token_hex(32)
        with _lock("codex_enabled.lock", wait=True):
            check_chain(chain_id)
            _write("codex_pending.json", {"token": token, "at": datetime.now(timezone.utc).isoformat()})
        try:
            prefix = process.engine_prefix("codex")
            if not prefix:
                raise CodexError("이 PC 에 설치되어 있지 않습니다")
            version = process.cli_version(prefix)
            if version not in process.CODEX_VERIFIED:
                raise CodexError("판을 확인하지 못했거나 확인하지 않은 Codex 판입니다")
            problem = process.auth_problem(prefix) or work_problem()
            if problem:
                raise CodexError(problem)
            work = _path("work")
            work.mkdir(parents=True, exist_ok=True)
            still_current()
            problem = _probe(prefix, model, work, secrets.token_hex(32))
            if problem:
                raise CodexError(problem)
            still_current()
            with _lock("codex_enabled.lock", wait=True):
                check_chain(chain_id)
                if (_read("codex_pending.json") or {}).get("token") != token:
                    raise CodexError("연결 점검 중 꺼졌어요")
                _write("codex_enabled.json", {"version": version, "policy": CODEX_POLICY, "target": process.codex_target(prefix),
                                               "at": datetime.now(timezone.utc).isoformat()})
                _path("codex_pending.json").unlink(missing_ok=True)
        except (OSError, process.OutputLimit) as exc:
            raise CodexError("연결 점검을 실행하지 못했어요") from exc
        finally:
            with _lock("codex_enabled.lock", wait=True):
                if (_read("codex_pending.json") or {}).get("token") == token:
                    _path("codex_pending.json").unlink(missing_ok=True)


def disable() -> None:
    with _lock("codex_enabled.lock", wait=True):
        chain = _read("codex_chain.json")
        if chain:
            _write("codex_chain.json", {"id": chain.get("id"), "cancelled": True})
        _path("codex_pending.json").unlink(missing_ok=True)
        _path("codex_enabled.json").unlink(missing_ok=True)
