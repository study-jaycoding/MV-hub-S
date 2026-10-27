"""릴리스 전용 NAS 신원 선택: 실제 NAS·로그인 설정은 건드리지 않는다."""
from contextlib import contextmanager
import os
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from server_console import install, nas_access as nas, release, release_helper
from app.services import release_update as ru
from release_contract_fixture import qualified_package

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows NAS 연결")


def winerror(code):
    error = OSError("sensitive OS text must not escape")
    error.winerror = code
    return error


class Tokens:
    def __init__(self, fail="", same=True, session=1, elevation=3):
        self.events = []
        self.fail, self.same, self.session, self.elevation = fail, same, session, elevation

    def event(self, name):
        self.events.append(name)
        if self.fail == name:
            raise winerror(5)

    def current(self):
        self.event("current")
        return "current"

    def desktop(self):
        self.event("desktop")
        return "desktop"

    def number(self, token, kind):
        if kind == 8:
            return 1
        return (2 if token == "current" else self.elevation) if kind == 18 else (1 if token == "current" else self.session)

    def same_user(self, *_):
        return self.same

    def enter(self, token):
        self.event("enter")

    def leave(self):
        self.event("leave")

    def close(self, token):
        self.event("close_" + token)


@pytest.mark.parametrize("options,events", [
    ({"fail": "current"}, ["current"]),
    ({"fail": "desktop"}, ["current", "desktop", "close_current"]),
    ({"fail": "enter"}, ["current", "desktop", "enter", "close_desktop", "close_current"]),
    ({"same": False}, ["current", "desktop", "close_desktop", "close_current"]),
    ({"session": 2}, ["current", "desktop", "close_desktop", "close_current"]),
    ({"elevation": 2}, ["current", "desktop", "close_desktop", "close_current"]),
])
def test_rejects_unusable_identity_and_closes_acquired_handles(options, events):
    tokens = Tokens(**options)
    with pytest.raises((OSError, nas.NasAccessError)):
        with nas._existing_user(tokens):
            pytest.fail("unusable identity entered")
    assert tokens.events == events


@pytest.mark.parametrize("failed", [False, True])
def test_restores_identity_on_success_and_failed_work(failed):
    tokens = Tokens()
    try:
        with nas._existing_user(tokens):
            tokens.event("work")
            if failed:
                raise ValueError("work failed")
    except ValueError:
        assert failed
    assert tokens.events == ["current", "desktop", "enter", "work", "leave", "close_desktop", "close_current"]


@pytest.mark.parametrize("source", [r"D:\releases", r"\\?\C:\releases", r"\\.\C:\releases"])
def test_local_and_device_paths_never_switch_identity(monkeypatch, source):
    monkeypatch.setattr(nas, "_probe", lambda _: pytest.fail("network probe on local path"))
    with nas.connected(source) as identity:
        assert identity == "current"


@pytest.mark.parametrize("code", [5, 86, 1326, 1219])
def test_auth_failure_reuses_one_identity_without_retrying_write(monkeypatch, code):
    tokens, calls = Tokens(), []
    monkeypatch.setattr(nas, "_Tokens", lambda: tokens)

    def probe(source):
        calls.append(source)
        if len(calls) == 1:
            raise winerror(code)
    monkeypatch.setattr(nas, "_probe", probe)
    with pytest.raises(nas.NasAccessError) as caught:
        with nas.connected(r"\\NAS\release") as identity:
            assert identity == "existing_windows_connection"
            tokens.event("write_once")
            raise winerror(112)
    assert "sensitive" not in str(caught.value)
    assert len(calls) == 2 and tokens.events.count("write_once") == 1
    assert tokens.events[-3:] == ["leave", "close_desktop", "close_current"]


@pytest.mark.parametrize("code", [3, 53, 67, 112])
def test_other_errors_do_not_try_another_identity(monkeypatch, code):
    def probe(_):
        raise winerror(code)
    monkeypatch.setattr(nas, "_probe", probe)
    monkeypatch.setattr(nas, "_Tokens", lambda: pytest.fail("unexpected identity switch"))
    with pytest.raises(nas.NasAccessError, match=str(code)):
        with nas.connected(r"\\NAS\release"):
            pytest.fail("unreadable NAS entered")


def test_current_connection_success_does_not_retry_failed_work(monkeypatch):
    monkeypatch.setattr(nas, "_probe", lambda _: None)
    monkeypatch.setattr(nas, "_Tokens", lambda: pytest.fail("unexpected identity switch"))
    with pytest.raises(OSError):
        with nas.connected(r"\\NAS\release") as identity:
            assert identity == "current"
            raise winerror(5)


def test_failed_fallback_probe_restores_identity_and_does_no_work(monkeypatch):
    tokens = Tokens()
    monkeypatch.setattr(nas, "_Tokens", lambda: tokens)
    def probe(_):
        raise winerror(1326)
    monkeypatch.setattr(nas, "_probe", probe)
    with pytest.raises(nas.NasAccessError, match="1326"):
        with nas.connected(r"\\NAS\release"):
            pytest.fail("unreadable NAS entered")
    assert tokens.events[-3:] == ["leave", "close_desktop", "close_current"]


def test_native_token_metadata_and_failed_restore_exit(monkeypatch, tmp_path):
    api = nas._Tokens()
    current = api.current()
    try:
        assert api.number(current, 18) in (1, 2, 3)
        assert api.number(current, 12) >= 0
        assert api.same_user(current, current)
        desktop = api.desktop()
        try:
            assert api.number(desktop, 8) == 1 and api.number(desktop, 18) == 3
            assert api.same_user(current, desktop)
            assert api.number(current, 12) == api.number(desktop, 12)
            api.enter(desktop)
            try:
                nas._probe(str(tmp_path))
            finally:
                api.leave()
        finally:
            api.close(desktop)
    finally:
        api.close(current)
    monkeypatch.setattr(api.adv, "RevertToSelf", lambda: False)
    def exit_process(code):
        raise SystemExit(code)
    monkeypatch.setattr(nas.os, "_exit", exit_process)
    with pytest.raises(SystemExit) as result:
        api.leave()
    assert result.value.code == 72


@pytest.mark.parametrize("fail", [False, True])
def test_source_acl_is_admin_owned_and_read_only_on_exactly_two_new_paths(monkeypatch, tmp_path, fail):
    api = nas._Tokens()
    convert = api.adv.ConvertStringSecurityDescriptorToSecurityDescriptorW
    convert.argtypes = [nas.wt.LPCWSTR, nas.wt.DWORD, nas.ctypes.POINTER(nas.wt.LPVOID), nas.wt.LPVOID]
    descriptions, paths = [], []

    def parse(sddl, revision, output, size):
        descriptions.append(sddl)
        return convert(sddl, revision, output, size)  # 실제 Windows가 읽을 수 있는 보안 설명자

    def apply(path, flags, descriptor):
        paths.append(path)
        assert flags == 0x80000005
        if fail:
            nas.ctypes.set_last_error(5)
            return False
        return True

    monkeypatch.setattr(api.adv, "ConvertStringSecurityDescriptorToSecurityDescriptorW", parse)
    monkeypatch.setattr(api.adv, "SetFileSecurityW", apply)
    monkeypatch.setattr(nas, "_Tokens", lambda: api)
    if fail:
        with pytest.raises(OSError):
            nas.allow_source_read(tmp_path)
        assert paths == [str(tmp_path)]
    else:
        nas.allow_source_read(tmp_path)
        assert paths == [str(tmp_path), str(tmp_path / "INSTALL_SOURCE.txt")]
    assert all(s.startswith("O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GR") for s in descriptions)
    assert "GRGX" in descriptions[0]
    if not fail:
        assert "GRGX" not in descriptions[1] and ";;GR;;;" in descriptions[1]
    assert all("CI" not in s and "OI" not in s for s in descriptions)


@pytest.mark.parametrize("failed", [False, True])
def test_helper_prepares_source_read_access_before_launch_or_stops(monkeypatch, tmp_path, failed):
    inst = install.Installation(root=ROOT, data_dir=tmp_path, log_dir=tmp_path, content_db=tmp_path / "x.db",
                                port=8010, port_known=False, python=Path(sys.executable), problems=())
    events = []

    def prepare(root):
        events.append("acl")
        assert (root / "INSTALL_SOURCE.txt").read_text(encoding="utf-8").strip() == r"\\NAS\release"
        if failed:
            raise nas.NasAccessError("failed")

    def run(*_args):
        events.append("run")
        return 0, '{"ok": true}'

    monkeypatch.setattr(nas, "allow_source_read", prepare)
    monkeypatch.setattr(release, "run_command", run)
    result = release.helper(inst, tmp_path / "scratch", r"\\NAS\release", "read")
    assert result["ok"] is not failed
    assert events == (["acl"] if failed else ["acl", "run"])
    assert list((tmp_path / "scratch").iterdir()) == []


@pytest.mark.parametrize("command", ["read", "manifest", "promote", "deploy"])
def test_helper_keeps_all_nas_work_inside_identity_with_existing_backend(tmp_path, monkeypatch, command):
    folder = tmp_path / "nas"
    folder.mkdir()
    expected, raw = qualified_package(folder, "2026.10.27-1200")
    (folder / "candidate.json").write_bytes(raw)
    local = tmp_path / "protected-local-settings"
    local.mkdir()
    (local / "INSTALL_SOURCE.txt").write_text(str(folder), encoding="utf-8")
    original_source, original_manifest = ru.install_source, ru._package_manifest
    active, events = [False], []

    def install_source(root):
        assert root == local
        if not active[0]:
            events.append("settings")
        return original_source(root)

    @contextmanager
    def connected(source):
        assert source == str(folder)
        active[0] = True
        events.append("enter")
        try:
            yield
        finally:
            active[0] = False
            events.append("leave")

    def manifest(*args):
        assert active[0]
        return original_manifest(*args)

    monkeypatch.setattr(ru, "install_source", install_source)
    monkeypatch.setattr(ru, "_package_manifest", manifest)
    monkeypatch.setattr(nas, "connected", connected)
    args = {"read": [], "manifest": [expected["file"]], "promote": [release._b64(expected)],
            "deploy": [release._b64(expected), "", expected["sha256"]]}[command]
    result = release_helper.run(ROOT, local, command, args)
    assert result["ok"], result
    assert events == ["settings", "enter", "leave"] and not active[0]
    if command in ("promote", "deploy"):
        assert (folder / "latest.json").read_bytes() == raw
    else:
        assert not (folder / "latest.json").exists()
