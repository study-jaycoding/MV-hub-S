"""MV Agent 첫 연결 — Claude 상태 판정·로그인 창·PC 뮤텍스·빠른 모드·기본 켜기(설계 docs/status/AskAgent_첫연결_설계_2026-11-09.md 10절).

가짜 CLI·가짜 창 프로세스만 쓴다 — 실제 로그인·실제 Claude 대화·과금·공유 서버 없음. 창은 띄우지 않는다(_spawn_window 를 바꿔 끼움).
"""
import ctypes
import importlib
import json
import os
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from app import config
from app.services import agent_chat as chat
from app.services import agent_chat_claude as claude
from app.services import agent_chat_parse as parse
from app.services import agent_chat_process as process

FAKE = Path(__file__).with_name("agent_chat_fake_cli.py")
CLAUDE = [sys.executable, str(FAKE), "--fake-engine=claude"]
windows = pytest.mark.skipif(os.name != "nt", reason="Windows 뮤텍스·프로세스")


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "AGENT_CHAT_DIR", tmp_path / "agent_chat")
    monkeypatch.setattr(config, "AGENT_CHAT_CLAUDE_DIR", tmp_path / "claude")
    monkeypatch.setattr(config, "AGENT_CHAT_LOGIN_WINDOW", True)
    monkeypatch.setattr(claude, "_claude_command_lines", lambda: [])  # 진짜 프로세스 목록을 보지 않는다(이 PC 의 Claude 와 무관하게)
    monkeypatch.setattr(process, "engine_prefix", lambda engine: CLAUDE if engine == "claude" else None)
    monkeypatch.setattr(process, "find_claude", lambda: CLAUDE)
    yield tmp_path


def state(auth, monkeypatch):
    monkeypatch.setenv("FAKE_AGENT_AUTH", auth)
    return claude.claude_state(CLAUDE)


# ── 상태 판정 ──
@pytest.mark.parametrize("auth, expected, subscription", [
    ("subscription", "ready", "Max"), ("team", "ready", "Team"), ("free", "no_plan", None),
    ("unknown_plan", "subscription_unknown", None), ("missing_plan", "subscription_unknown", None),
    ("api_key", "not_subscription", None), ("api_key_helper", "not_subscription", None),
    ("oauth_token", "not_subscription", None), ("third_party", "not_subscription", None),
    ("none", "not_logged_in", None),  # 종료 코드 1 + JSON — 버리지 않는다
    ("badjson", "unknown", None),
])
def test_state_classification(auth, expected, subscription, monkeypatch):
    got = state(auth, monkeypatch)
    assert got["state"] == expected and got["subscription"] == subscription and got["version"] == "2.1.296"


def test_state_not_installed_outdated_and_timeout(monkeypatch):
    assert claude.claude_state(None)["state"] == "not_installed"
    monkeypatch.setenv("FAKE_CLAUDE_VERSION", "2.1.100 (Claude Code)")
    assert claude.claude_state(CLAUDE)["state"] == "outdated"
    monkeypatch.delenv("FAKE_CLAUDE_VERSION")
    monkeypatch.setattr(claude, "STATUS_TIMEOUT", 1.0)
    assert state("slow", monkeypatch)["state"] == "unknown"


def test_chat_allowed_only_for_ready_or_unknown_plan(monkeypatch):
    for auth, ok in (("subscription", True), ("unknown_plan", True), ("free", False), ("none", False), ("api_key", False)):
        monkeypatch.setenv("FAKE_AGENT_AUTH", auth)
        assert (claude.claude_problem(CLAUDE) is None) is ok, auth
        assert (chat.engine_problem("claude", CLAUDE) is None) is ok, auth
    with pytest.raises(ValueError):
        process.engine_problem("claude", CLAUDE)  # Claude 판정은 한 곳(서비스 → 상태 판정)만


def test_state_and_engines_never_carry_email_org_or_path(monkeypatch):
    monkeypatch.setenv("FAKE_AGENT_AUTH", "leak")
    text = json.dumps([claude.claude_state(CLAUDE), chat.AgentChat().engines(refresh=True)], ensure_ascii=False)
    assert "secret@example.test" not in text and "org-SECRET" not in text and "SECRET" not in text


def test_child_env_and_login_argument_order(monkeypatch):
    env = process.child_env({"ANTHROPIC_API_KEY": "k", "ANTHROPIC_PROFILE": "p", "ANTHROPIC_NEW_THING": "x",
                             "CLAUDE_CODE_OAUTH_TOKEN": "t", "CLAUDE_CODE_USE_BEDROCK": "1", "PATH": "keep"})
    assert env == {"PATH": "keep"}
    command = claude.login_command(["claude.exe"])
    assert command == ["claude.exe", "--setting-sources", "local", "auth", "login", "--claudeai"]
    assert command.index("--setting-sources") < command.index("auth")


def test_find_claude_official_location_and_highest_version(tmp_path, monkeypatch):
    monkeypatch.undo()  # 이 시험은 진짜 find_claude 를 본다
    monkeypatch.setattr(config, "AGENT_CHAT_DIR", tmp_path / "agent_chat")
    monkeypatch.setattr(config, "AGENT_CHAT_CLAUDE_DIR", tmp_path / "claude")
    home = tmp_path / "home"
    official = home / ".local" / "bin" / "claude.exe"
    official.parent.mkdir(parents=True)
    official.write_bytes(b"")
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setattr(process.shutil, "which", lambda name: None)
    assert process.find_claude() == [str(official)]  # PATH 에 없어도 공식 위치
    npm = tmp_path / "npm"
    native = npm / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe"
    native.parent.mkdir(parents=True)
    native.write_bytes(b"")
    monkeypatch.setattr(process.shutil, "which", lambda name: str(npm / "claude.cmd"))
    versions = {str(native): "2.1.300", str(official): "2.1.296"}
    monkeypatch.setattr(process, "cli_version", lambda prefix: versions[prefix[0]])
    assert process.find_claude() == [str(native)]  # 판이 높은 쪽
    versions[str(official)] = "2.1.300"
    assert process.find_claude() == [str(official)]  # 같으면 공식 위치


# ── 로그인 창 ──
class FakeWindow:
    """창 대신 — 진짜로 잠자는 프로세스(pid·시작 시각 확인용). 허브가 끄지 않는지 본다."""

    def __init__(self):
        self.proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"],
                                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.pid = self.proc.pid
        self._handle = self.proc._handle

    def kill(self):
        self.proc.kill()
        self.proc.wait(10)


@pytest.fixture
def window(monkeypatch):
    seen = {"spawned": [], "resumed": [], "record_at_spawn": None, "record_at_resume": None}

    def spawn(command):
        seen["record_at_spawn"] = json.loads(claude._window_file().read_text(encoding="utf-8"))
        win = FakeWindow()
        seen["spawned"].append((command, win))
        return win

    def resume(proc):
        seen["record_at_resume"] = json.loads(claude._window_file().read_text(encoding="utf-8"))
        seen["resumed"].append(proc)

    monkeypatch.setattr(claude, "_spawn_window", spawn)
    monkeypatch.setattr(claude, "_resume", resume)
    yield seen
    for _, win in seen["spawned"]:
        win.kill()
    claude._held_windows.clear()


@windows
def test_login_window_order_record_and_duplicate_block(window, monkeypatch):
    monkeypatch.setenv("FAKE_AGENT_AUTH", "none")
    claude.open_login_window(lambda: None)
    command, win = window["spawned"][0]
    assert command[-5:] == ["--setting-sources", "local", "auth", "login", "--claudeai"]
    assert window["record_at_spawn"]["status"] == "launching"  # 띄우기 전에 기록
    assert window["record_at_resume"]["status"] == "open" and window["record_at_resume"]["pid"] == win.pid  # 재개 전에 open
    assert claude.window_alive() and claude.claude_state(CLAUDE)["state"] == "login_window"
    with pytest.raises(claude.Busy) as again:
        claude.open_login_window(lambda: None)
    assert again.value.code == "login_window_open" and len(window["spawned"]) == 1
    assert claude.would_block() is not None
    with pytest.raises(claude.Busy) as turn:
        lock = claude.ClaudeLock("turn")
        lock.acquire()
    assert turn.value.code == "login_window_open"
    assert win.proc.poll() is None  # 허브는 창을 끄지 않는다
    monkeypatch.setenv("FAKE_AGENT_AUTH", "subscription")  # 연결은 됐지만 창이 아직 열림 = 창 상태 유지(차례도 거절)
    assert claude.claude_state(CLAUDE)["state"] == "login_window" and claude.claude_problem(CLAUDE) is not None
    win.kill()
    assert not claude.window_alive() and claude.claude_state(CLAUDE)["state"] == "ready"


@windows
def test_login_window_never_runs_untracked(window, monkeypatch):
    monkeypatch.setenv("FAKE_AGENT_AUTH", "none")
    real = claude._handle_start
    spawned = lambda handle: any(handle == int(w._handle) for _, w in window["spawned"])  # noqa: E731
    monkeypatch.setattr(claude, "_handle_start", lambda k32, handle: None if spawned(handle) else real(k32, handle))
    with pytest.raises(OSError):
        claude.open_login_window(lambda: None)  # 생성 핸들의 시작 시각을 못 읽으면 재개하지 않고 끈다
    monkeypatch.setattr(claude, "_handle_start", real)

    def broken_resume(proc):
        raise OSError("resume failed")

    monkeypatch.setattr(claude, "_resume", broken_resume)
    with pytest.raises(OSError):
        claude.open_login_window(lambda: None)  # 재개가 안 되면 멈춘 창을 끈다(보인 적 없는 창이 기록을 막지 않게)
    assert window["resumed"] == [] and len(window["spawned"]) == 2
    for _, win in window["spawned"]:
        assert win.proc.wait(10) is not None
    assert json.loads(claude._window_file().read_text(encoding="utf-8"))["status"] == "none"
    assert not claude.window_alive() and claude._held_windows == []


@windows
def test_login_state_is_judged_inside_the_lock(window, monkeypatch):
    monkeypatch.setenv("FAKE_AGENT_AUTH", "none")
    real, seen = claude.claude_state, []

    def judged(prefix):
        seen.append(_in_thread(claude.would_block).get("value"))  # 다른 허브가 보면 잠겨 있다
        monkeypatch.setenv("FAKE_AGENT_AUTH", "subscription")  # 잠금을 기다리는 사이 다른 허브가 연결을 마침
        return real(prefix)

    monkeypatch.setattr(claude, "claude_state", judged)
    with pytest.raises(claude.Busy) as done:
        claude.open_login_window(lambda: None)
    assert done.value.code == "not_needed" and window["spawned"] == []
    assert seen == ["다른 MV Hub 에서 Claude 가 일하는 중이에요"]


@windows
def test_login_window_refusals(window, monkeypatch):
    monkeypatch.setenv("FAKE_AGENT_AUTH", "subscription")
    with pytest.raises(claude.Busy) as ready:
        claude.open_login_window(lambda: None)
    assert ready.value.code == "not_needed"
    monkeypatch.setenv("FAKE_AGENT_AUTH", "none")
    monkeypatch.setattr(config, "AGENT_CHAT_LOGIN_WINDOW", False)
    with pytest.raises(claude.LoginDisabled):
        claude.open_login_window(lambda: None)
    monkeypatch.setattr(config, "AGENT_CHAT_LOGIN_WINDOW", True)

    def changed():
        raise RuntimeError("account changed")

    with pytest.raises(RuntimeError):
        claude.open_login_window(changed)  # 띄우기 직전 신원 재대조
    assert window["spawned"] == [] and not claude._window_file().exists()


@windows
def test_breakaway_denied_goes_to_terminal_guidance(monkeypatch):
    monkeypatch.setenv("FAKE_AGENT_AUTH", "none")

    def denied(command):
        error = OSError("access denied")
        error.winerror = 5
        raise error

    monkeypatch.setattr(claude, "_spawn_window", denied)
    with pytest.raises(claude.BreakawayDenied):
        claude.open_login_window(lambda: None)
    assert json.loads(claude._window_file().read_text(encoding="utf-8"))["status"] == "none"
    assert not claude.window_alive()


@windows
def test_window_record_after_crashes(monkeypatch):
    dead = subprocess.Popen([sys.executable, "-c", "pass"])
    dead.wait(10)
    me = claude.process_start(os.getpid())
    claude._write(claude._window_file(), {"status": "launching", "hub_pid": dead.pid, "hub_start": 1})
    assert not claude.window_alive()  # 만들던 허브가 죽음 = 실행 중 로그인 없음(멈춘 창은 인증 못 함)
    claude._write(claude._window_file(), {"status": "launching", "hub_pid": os.getpid(), "hub_start": me})
    assert claude.window_alive()  # 살아 있는 허브가 만드는 중
    claude._write(claude._window_file(), {"status": "open", "pid": dead.pid, "start": 1})
    assert not claude.window_alive()
    # 기록이 깨짐(JSON 아님 · 모양만 맞고 필수 필드·상태가 어긋남): 허브가 띄운 로그인 프로세스가 떠 있거나 목록을 못 보면 막는다(대화도)
    bad = claude._window_file().with_name(claude._window_file().name + ".bad")
    for broken in ("{broken", '{"status": "open", "pid": 12345}', '{"status": "opened", "pid": 12345, "start": 1}',
                   '{"status": "open", "pid": true, "start": 1}', '["open"]'):
        claude._window_file().write_text(broken, encoding="utf-8")
        for auth in ("none", "subscription"):
            monkeypatch.setenv("FAKE_AGENT_AUTH", auth)
            for lines in (["claude.exe --setting-sources local auth login --claudeai"], None):
                monkeypatch.setattr(claude, "_claude_command_lines", lambda lines=lines: lines)
                assert claude.claude_state(CLAUDE)["state"] == "window_record", (broken, auth, lines)
                with pytest.raises(claude.Busy):
                    claude.ClaudeLock("turn").acquire()
        monkeypatch.setenv("FAKE_AGENT_AUTH", "none")
        with pytest.raises(claude.Busy):
            claude.open_login_window(lambda: None)
        # 로그인 프로세스가 없으면(다른 Claude 는 상관없음) 옆으로 치우고 이어 간다
        monkeypatch.setattr(claude, "_claude_command_lines", lambda: ["claude.exe -p --output-format stream-json"])
        assert claude.claude_state(CLAUDE)["state"] == "not_logged_in", broken
        assert not claude._window_file().exists() and bad.read_text(encoding="utf-8") == broken


@windows
def test_liveness_unconfirmed_blocks_until_no_login_process(monkeypatch):
    real = claude._k32

    def fake(error):
        class K32:
            def OpenProcess(self, access, inherit, pid):
                if pid != 12345:  # 기록 속 번호만 못 연다(허브 자신은 연다)
                    return real().OpenProcess(access, inherit, pid)
                ctypes.set_last_error(error)
                return 0

            def __getattr__(self, name):
                return getattr(real(), name)

        return lambda: K32()

    login = ["claude.exe --setting-sources local auth login --claudeai"]
    for error in (87, 5, 6):  # 그런 번호 없음 = 끝남 · 열기 거절·그 밖 = 확인 못 함
        claude._write(claude._window_file(), {"status": "open", "pid": 12345, "start": 1})
        monkeypatch.setattr(claude, "_k32", fake(error))
        monkeypatch.setattr(claude, "_claude_command_lines", lambda: login)
        if error == 87:
            assert not claude.window_alive()
            continue
        with pytest.raises(claude.RecordUnreadable):
            claude.window_alive()  # 로그인 창 프로세스가 떠 있으면 계속 막는다
        monkeypatch.setattr(claude, "_claude_command_lines", lambda: None)
        with pytest.raises(claude.RecordUnreadable):
            claude.window_alive()  # 목록을 못 봐도 막는다
        monkeypatch.setattr(claude, "_claude_command_lines", lambda: [])
        assert not claude.window_alive() and not claude._window_file().exists()  # 로그인 창이 하나도 없음 = 치우고 이어 감
    monkeypatch.setattr(claude, "_k32", real)
    # 주인 허브가 살았는지 모르면(열기 거절) 회수 안 된 차례 표식이 없을 때만 이어 간다
    claude._write(claude._owner_file(), {"pid": 12345, "start": 1, "kind": "turn", "status": "running"})
    monkeypatch.setattr(claude, "_k32", fake(5))
    for marker, ok in ((True, False), (None, False), (False, True)):
        monkeypatch.setattr(claude, "turn_work_alive", lambda marker=marker: marker)
        if ok:
            lock = claude.ClaudeLock("login")
            lock.acquire()
            lock.release()
        else:
            with pytest.raises(claude.Busy):
                claude.ClaudeLock("login").acquire()


@windows
def test_lock_scope_follows_claude_credentials(tmp_path, monkeypatch):
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    name, owner = claude.mutex_name(), claude._owner_file()
    monkeypatch.setattr(config, "AGENT_CHAT_DIR", tmp_path / "other_hub")  # 기록 폴더를 따로 준 허브 = 같은 잠금·기록
    assert (claude.mutex_name(), claude._owner_file()) == (name, owner)
    held, release = threading.Event(), threading.Event()

    def first_hub():
        lock = claude.ClaudeLock("turn")
        lock.acquire()
        held.set()
        release.wait(20)
        lock.release()

    thread = threading.Thread(target=first_hub)
    thread.start()
    assert held.wait(10)
    monkeypatch.setattr(config, "AGENT_CHAT_DIR", tmp_path / "third_hub")
    with pytest.raises(claude.Busy) as busy:
        claude.ClaudeLock("login").acquire()
    assert busy.value.code == "claude_busy"
    release.set()
    thread.join(10)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "other_credentials"))  # 다른 자격 = 다른 잠금
    assert claude.mutex_name() != name and claude._owner_file() != owner


# ── PC 뮤텍스(같은 이름을 쓰는 다른 허브 = 다른 스레드로 흉내) ──
def _in_thread(fn):
    box = {}

    def run():
        try:
            box["value"] = fn()
        except BaseException as exc:  # noqa: BLE001
            box["error"] = exc

    thread = threading.Thread(target=run)
    thread.start()
    thread.join(20)
    return box


@windows
def test_lock_blocks_other_hub_and_releases_clean():
    held, release = threading.Event(), threading.Event()

    def other_hub():
        lock = claude.ClaudeLock("turn")
        lock.acquire()
        held.set()
        release.wait(20)
        lock.release()

    thread = threading.Thread(target=other_hub)
    thread.start()
    assert held.wait(10)
    with pytest.raises(claude.Busy) as busy:
        claude.ClaudeLock("login").acquire()
    assert busy.value.code == "claude_busy"
    assert claude.would_block() == "다른 MV Hub 에서 Claude 가 일하는 중이에요"
    release.set()
    thread.join(10)
    assert json.loads(claude._owner_file().read_text(encoding="utf-8"))["status"] == "clean"
    lock = claude.ClaudeLock("turn")
    lock.acquire()
    lock.release()


@windows
def test_abandoned_lock_rules(monkeypatch):
    def dead_turn():
        """차례 잠금을 잡은 채 스레드만 끝난다(놓지 않음 = 버려진 뮤텍스·표식 열린 채) — 그 잠금을 돌려준다."""
        lock = claude.ClaudeLock("turn")
        assert "error" not in _in_thread(lock.acquire)
        return lock

    def kernel_closes(lock):  # 주인 허브가 죽으면 커널이 그 허브의 표식(과 Job)을 닫는다
        claude._k32().CloseHandle(lock._marker)
        lock._marker = None

    def enters(kind="turn"):
        lock = claude.ClaudeLock(kind)
        lock.acquire()
        lock.release()

    # A 스레드만 죽음(허브 살아 있음) → B 버려진 획득·거절 → C 정상 획득도 거절
    a = dead_turn()
    for _ in range(2):
        with pytest.raises(claude.Busy) as blocked:
            claude.ClaudeLock("turn").acquire()
        assert blocked.value.code == "unclean"
    claude._owner_file().unlink()  # 주인 기록이 없어져도 표식이 열려 있으면 막는다(로그인도)
    with pytest.raises(claude.Busy) as blocked:
        claude.ClaudeLock("login").acquire()
    assert blocked.value.code == "unclean"
    a.release()  # A 가 회수를 확인하고 놓으면(clean·표식 닫음) 들어간다 — 남의 스레드라 뮤텍스는 버려진 채로 둔다
    enters()
    # 주인 허브가 죽었으면(커널이 Job·표식을 닫음) 기록이 running 이어도 이어 간다
    dead = subprocess.Popen([sys.executable, "-c", "pass"])
    dead.wait(10)
    kernel_closes(dead_turn())
    claude._write(claude._owner_file(), {"pid": dead.pid, "start": 1, "kind": "turn", "status": "running"})
    enters()
    # 주인 기록이 없거나 깨져도(JSON 아님 · 필수 필드·상태 어긋남): 놓지 못한 차례의 표식이 열려 있으면 claude.exe 가 없어도
    # (Job 에 MCP 자식만 남은 경우) 막고, 표식을 확인 못 해도 막고, 없음을 확인했을 때만 이어 간다
    monkeypatch.setattr(claude, "_claude_command_lines", lambda: [])
    real_marker = claude.turn_work_alive
    c = dead_turn()
    cases = (None, "{broken", '{"pid": 1, "start": 1, "kind": "turn", "status": "runing"}', '{"status": "running"}')

    def put(broken):
        if broken is None:
            claude._owner_file().unlink(missing_ok=True)
        else:
            claude._owner_file().write_text(broken, encoding="utf-8")

    for broken in cases:
        put(broken)
        with pytest.raises(claude.Busy):
            claude.ClaudeLock("turn").acquire()
    kernel_closes(c)
    for broken in cases:
        put(broken)
        monkeypatch.setattr(claude, "turn_work_alive", lambda: None)
        with pytest.raises(claude.Busy):
            claude.ClaudeLock("turn").acquire()
        monkeypatch.setattr(claude, "turn_work_alive", real_marker)
        enters()


@windows
def test_turn_marker_lives_until_release_or_thread_death():
    assert claude.turn_work_alive() is False
    lock = claude.ClaudeLock("turn")
    lock.acquire()
    assert claude.turn_work_alive() is True  # 차례 중
    lock.release()
    assert claude.turn_work_alive() is False  # 회수 확인 뒤 놓으면 닫힘
    login = claude.ClaudeLock("login")
    login.acquire()
    assert claude.turn_work_alive() is False  # 로그인(Job 없음)은 표식 없음
    login.release()
    _in_thread(lambda: claude.ClaudeLock("turn").acquire())  # 놓지 못하고 스레드가 끝남
    assert claude.turn_work_alive() is True  # 허브가 살아 있는 동안 열린 채(허브가 죽으면 커널이 닫는다)


# ── 빠른 모드·깊이·해석기 ──
def test_fast_mode_is_explicit_every_turn(tmp_path):
    entry = {"command": "python", "args": ["adapter.py", "--panel"]}
    for fast in (True, False):
        command = process.build_command("claude", ["claude.exe"], model="opus", effort="max", resume="S1", mcp_entry=entry,
                                        mcp_file=tmp_path / "m.json", work=tmp_path, fast=fast)
        assert command[command.index("--settings") + 1] == json.dumps({"fastMode": fast})
        assert command[command.index("--effort") + 1] == "max"


def test_models_and_efforts_per_engine():
    assert {m["id"] for m in chat.MODELS["claude"]} == {"opus", "sonnet", "haiku", "fable"}
    assert chat.EFFORTS["claude"] == ("low", "medium", "high", "xhigh", "max")
    assert chat.EFFORTS["codex"] == ("low", "medium", "high")
    assert claude.FAST_MODELS == {"opus"}


def test_parser_turns_system_notices_into_events():
    parser = parse.ClaudeParser()
    assert parser.feed(json.dumps({"type": "system", "subtype": "notice", "message": "Fast mode unavailable — using standard"})) == [
        {"kind": "notice", "text": "Fast mode unavailable — using standard"}]
    assert parser.feed(json.dumps({"type": "system", "subtype": "compact_boundary"})) == []
    init = parser.feed(json.dumps({"type": "system", "subtype": "init", "session_id": "S", "tools": [], "apiKeySource": "none"}))
    assert init[0]["kind"] == "session"


# ── 기본 켜기 ──
def test_enabled_by_default_and_off_with_zero(monkeypatch):
    saved = os.environ.get("CONTENT_HUB_AGENT_CHAT")
    try:
        monkeypatch.delenv("CONTENT_HUB_AGENT_CHAT", raising=False)
        assert importlib.reload(config).AGENT_CHAT_ENABLED is True
        monkeypatch.setenv("CONTENT_HUB_AGENT_CHAT", "0")
        assert importlib.reload(config).AGENT_CHAT_ENABLED is False
        monkeypatch.delenv("CONTENT_HUB_AGENT_CHAT_LOGIN_WINDOW", raising=False)
        assert importlib.reload(config).AGENT_CHAT_LOGIN_WINDOW is False  # 로그인 창 스위치는 기본 꺼짐
    finally:
        if saved is None:
            monkeypatch.delenv("CONTENT_HUB_AGENT_CHAT", raising=False)
        else:
            monkeypatch.setenv("CONTENT_HUB_AGENT_CHAT", saved)
        importlib.reload(config)
