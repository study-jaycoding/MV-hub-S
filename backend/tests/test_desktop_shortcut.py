"""바탕화면 'MV Hub' 바로가기 — 만드는 규칙과 **안 만드는** 규칙.

안 만드는 쪽이 더 중요하다. 바로가기 이름은 PC 에 하나뿐인데 설치 폴더는 여러 개일 수 있고,
남의 바로가기를 덮어쓰면 사용자는 **같은 아이콘을 눌렀는데 다른 DB·다른 브라우저 프로필**을
연다. 실제로 "작업물이 사라졌다"로 신고되는 상황이 그것이다(설치경로가 프로필·DB 축이다).
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows 전용 기능")

ROOT = Path(__file__).resolve().parents[2]
GUARD = ROOT / "run_agent_session.py"
ICON = ROOT / "mvhub.ico"

_POWERSHELL = str(
    Path(os.environ.get("SystemRoot", r"C:\Windows"))
    / "System32"
    / "WindowsPowerShell"
    / "v1.0"
    / "powershell.exe"
)

_READ_LNK = (
    "$ws = New-Object -ComObject WScript.Shell; "
    "$s = $ws.CreateShortcut($env:LNK); "
    '"TargetPath=" + $s.TargetPath; '
    '"WorkingDirectory=" + $s.WorkingDirectory; '
    '"IconLocation=" + $s.IconLocation; '
    '"WindowStyle=" + $s.WindowStyle'
)


def _read_lnk(path: Path) -> dict[str, str]:
    """저장된 .lnk 를 Windows 로 다시 읽는다 — 우리가 넣은 값이 실제로 들어갔는지 확인용."""
    env = dict(os.environ)
    env["LNK"] = str(path)
    done = subprocess.run(
        [_POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", _READ_LNK],
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
        check=False,
    )
    return dict(
        line.split("=", 1) for line in (done.stdout or "").splitlines() if "=" in line
    )


def _install(tmp_path: Path, name: str, *, icon: bool = True, launcher: bool = True, git: bool = False):
    """가짜 설치 폴더 하나. 가드는 자기 파일 위치로 설치를 구분하므로 **복사본**이어야 한다."""
    root = tmp_path / name
    root.mkdir()
    if launcher:
        (root / "MV_agent.bat").write_bytes(b"@echo off\r\n")
    if icon:
        shutil.copy2(ICON, root / "mvhub.ico")
    if git:
        (root / ".git").write_text("gitdir: nowhere\n", encoding="utf-8")
    shutil.copy2(GUARD, root / "run_agent_session.py")

    module_name = "shortcut_guard_" + name.replace("-", "_")
    sys.modules.pop(module_name, None)
    spec = importlib.util.spec_from_file_location(module_name, root / "run_agent_session.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return root, module


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    """가짜 바탕화면 + 가짜 %LOCALAPPDATA% — 진짜 바탕화면은 절대 건드리지 않는다."""
    desktop = tmp_path / "Desktop"
    desktop.mkdir()
    local = tmp_path / "Local"
    local.mkdir()
    monkeypatch.setenv("LOCALAPPDATA", str(local))
    return desktop, local


def test_dev_tree_never_creates_a_shortcut(tmp_path, workspace):
    """개발 저장소·워크트리에서는 만들지 않는다 — 개발본이 대표 아이콘을 차지하면 안 된다."""
    desktop, _ = workspace
    _, guard = _install(tmp_path, "dev", git=True)
    assert guard.ensure_desktop_shortcut(desktop=desktop) == "dev-tree"
    assert list(desktop.iterdir()) == []


def test_creates_one_shortcut_for_this_install(tmp_path, workspace):
    desktop, local = workspace
    root, guard = _install(tmp_path, "install-a")

    assert guard.ensure_desktop_shortcut(desktop=desktop) == "created"

    link = desktop / "MV Hub.lnk"
    assert link.is_file()
    info = _read_lnk(link)
    assert info["TargetPath"] == str(root / "MV_agent.bat")
    assert info["WorkingDirectory"] == str(root)
    # ★창 모드는 보통(1). 최소화(7)로 하면 기동 실패 메시지가 화면에 안 떠서
    #  "눌렀는데 아무 일도 없다"가 된다. 성공하면 어차피 콘솔이 스스로 숨는다.
    assert info["WindowStyle"] == "1"
    # 확정은 임시 이름 → 이동이다. 잔재가 바탕화면에 남으면 안 된다.
    assert list(desktop.glob("*.tmp.lnk")) == []


def test_icon_points_outside_the_install_folder(tmp_path, workspace):
    """★아이콘은 설치 폴더가 아니라 %LOCALAPPDATA% 사본을 가리킨다.

    업데이트는 설치 폴더의 파일을 rename 으로 교체한다. 그 rename 이 잠금에 막히면 15초 재시도 뒤
    **업데이트 전체가 롤백**된다 — 2026-09-02 에 백신이 방금 복사된 파일을 잠가 실제로 일어났다.
    아이콘은 셸이 아무 때나 읽는 파일이라 교체 대상에서 아예 빼 둔다.
    """
    desktop, local = workspace
    root, guard = _install(tmp_path, "install-a")

    assert guard.ensure_desktop_shortcut(desktop=desktop) == "created"

    copied = local / "MVHub" / f"icon-{guard._install_id()}.ico"
    assert copied.is_file()
    assert copied.read_bytes() == (root / "mvhub.ico").read_bytes()
    icon_location = _read_lnk(desktop / "MV Hub.lnk")["IconLocation"]
    assert icon_location == f"{copied},0"
    assert str(root).lower() not in icon_location.lower()


def test_another_installs_shortcut_is_left_alone(tmp_path, workspace):
    """★핵심 안전장치. 이미 있는 바로가기가 다른 설치를 가리키면 손대지 않는다.

    덮어쓰면 같은 아이콘이 다른 DB·다른 브라우저 프로필을 열게 된다.
    """
    desktop, _ = workspace
    root_a, guard_a = _install(tmp_path, "install-a")
    root_b, guard_b = _install(tmp_path, "install-b")

    assert guard_a.ensure_desktop_shortcut(desktop=desktop) == "created"
    assert guard_b.ensure_desktop_shortcut(desktop=desktop) == "foreign"

    assert _read_lnk(desktop / "MV Hub.lnk")["TargetPath"] == str(root_a / "MV_agent.bat")
    # 못 만들었으면 표식도 남기면 안 된다 — 남기면 영영 다시 시도하지 않는다.
    assert not guard_b._shortcut_mark_path().exists()


def test_second_run_does_not_touch_the_desktop(tmp_path, workspace, monkeypatch):
    """두 번째 실행은 PowerShell 조차 부르지 않는다 — 매 기동의 군더더기를 없앤다."""
    desktop, _ = workspace
    _, guard = _install(tmp_path, "install-a")
    guard._shortcut_mark_path().parent.mkdir(parents=True, exist_ok=True)
    guard._shortcut_mark_path().write_text("created", encoding="utf-8")

    def _boom(*args, **kwargs):
        raise AssertionError("표식이 있으면 PowerShell 을 부르면 안 된다")

    monkeypatch.setattr(guard.subprocess, "run", _boom)
    assert guard.ensure_desktop_shortcut(desktop=desktop) == "already-marked"


def test_user_deleted_shortcut_is_not_resurrected(tmp_path, workspace):
    """사용자가 지운 아이콘을 매번 되살리지 않는다 — 표식이 그 기억이다."""
    desktop, _ = workspace
    _, guard = _install(tmp_path, "install-a")

    assert guard.ensure_desktop_shortcut(desktop=desktop) == "created"
    (desktop / "MV Hub.lnk").unlink()

    assert guard.ensure_desktop_shortcut(desktop=desktop) == "already-marked"
    assert not (desktop / "MV Hub.lnk").exists()


def test_missing_icon_skips_creation(tmp_path, workspace, monkeypatch):
    """아이콘을 안 담은 옛 패키지 — 흰 종이 아이콘을 만드느니 안 만든다."""
    desktop, _ = workspace
    _, guard = _install(tmp_path, "old-package", icon=False)

    def _boom(*args, **kwargs):
        raise AssertionError("아이콘이 없으면 PowerShell 을 부르면 안 된다")

    monkeypatch.setattr(guard.subprocess, "run", _boom)
    assert guard.ensure_desktop_shortcut(desktop=desktop) == "no-icon"
    assert list(desktop.iterdir()) == []


def test_missing_launcher_skips_creation(tmp_path, workspace):
    """가리킬 대상이 없으면 만들지 않는다 — 눌러도 안 되는 아이콘은 없느니만 못하다."""
    desktop, _ = workspace
    _, guard = _install(tmp_path, "broken", launcher=False)
    assert guard.ensure_desktop_shortcut(desktop=desktop) == "no-launcher"
    assert list(desktop.iterdir()) == []


def test_ambient_desktop_variable_cannot_move_the_shortcut(tmp_path, workspace, monkeypatch):
    """바깥 환경에 MVHUB_SC_DESKTOP 이 떠 있어도 바로가기 자리가 바뀌지 않는다.

    바탕화면은 **함수 인자**로만 갈아끼운다(시험 전용). 환경변수를 신뢰하면 남의 값 하나로
    아이콘이 엉뚱한 폴더에 생긴다.
    """
    _, guard = _install(tmp_path, "install-a")
    monkeypatch.setenv("MVHUB_SC_DESKTOP", str(tmp_path / "somewhere-else"))
    seen: dict[str, str] = {}

    class _Done:
        returncode = 0
        stdout = "created"
        stderr = ""

    def _spy(_cmd, **kwargs):
        seen.update(kwargs.get("env") or {})
        return _Done()

    monkeypatch.setattr(guard.subprocess, "run", _spy)
    guard.ensure_desktop_shortcut()

    assert seen["MVHUB_SC_DESKTOP"] == ""


def test_shortcut_failure_never_raises(tmp_path, workspace, monkeypatch):
    """바로가기는 편의 기능이다 — 여기서 예외가 새면 앱이 못 뜬다."""
    desktop, _ = workspace
    _, guard = _install(tmp_path, "install-a")

    def _explode(*args, **kwargs):
        raise OSError("powershell is gone")

    monkeypatch.setattr(guard.subprocess, "run", _explode)
    assert guard.ensure_desktop_shortcut(desktop=desktop) == "failed"
    assert not guard._shortcut_mark_path().exists()


def test_install_id_is_unchanged_by_the_shortcut_work():
    """★설치 id 는 앱 창 프로필·mutex 의 축이다. 계산이 한 글자라도 달라지면 모든 사용자의
    프로필이 갈려 "작업물이 사라졌다"가 된다. 리팩터가 값을 바꾸지 않았는지 못 박는다."""
    import hashlib

    expected = hashlib.sha1(
        str(GUARD.resolve().parent).casefold().encode("utf-8")
    ).hexdigest()[:10]

    spec = importlib.util.spec_from_file_location("guard_install_id", GUARD)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    assert module._install_id() == expected
    assert module._app_window_base().name == "app-window"
    assert module._app_window_base().parent.name == "MVHub"


def test_release_package_ships_the_icon():
    """빌더의 세 목록 모두에 있어야 기존 설치에도 아이콘이 배달된다.

    목록은 허용 방식이다 — 스테이징에만 넣고 허용 목록에 빠뜨리면 ZIP 검증이 막고,
    필수 목록에 빠뜨리면 아이콘 없는 릴리스가 조용히 나간다.
    """
    builder = (ROOT / "release" / "make_release.ps1").read_text(encoding="utf-8-sig")
    assert builder.count('"mvhub.ico"') == 3
    assert ICON.is_file()


def test_installer_hands_the_shortcut_to_the_app():
    """설치기는 규칙을 베끼지 않고 앱의 --ensure-shortcut 을 부른다.

    PowerShell 로 설치 id 를 다시 계산하면 casefold/resolve 규칙이 미묘하게 어긋나
    표식이 갈린다(설치 직후 중복 생성, 지운 아이콘의 부활).
    """
    installer = (ROOT / "release" / "MVHub_Install.bat").read_text(encoding="ascii")
    # 주석이 아니라 **실제 호출 인자**를 본다 - 주석만 남고 호출이 바뀌면 못 잡는다.
    # ★경로는 반드시 인용한다. -ArgumentList 는 배열 요소를 공백으로 잇기만 하고 인용하지
    #  않아서, "C:\Users\Jane Doe\..." 같은 설치 경로가 두 인자로 쪼개진다 — 그런 PC 에서는
    #  바로가기가 조용히 안 생긴다(코덱스 리뷰 2026-09-14).
    assert '@("`"$Guard`"", "--ensure-shortcut")' in installer
    assert "New-DesktopShortcut -Root $TargetDir" in installer
    # 설치는 이미 끝난 뒤다 — 아이콘 실패가 설치 실패로 번지면 안 된다.
    shortcut_block = installer.split("function New-DesktopShortcut", 1)[1].split("\n}", 1)[0]
    assert "catch {" in shortcut_block
    assert "throw" not in shortcut_block


_PARSE_PS = (
    "$errors = $null; "
    "[void][System.Management.Automation.Language.Parser]::ParseInput("
    "$env:PS_CODE, [ref]$null, [ref]$errors); "
    "if ($errors.Count) { $errors[0].Message; exit 1 } else { exit 0 }"
)


def _ps_parse_errors(code: str) -> str:
    """PowerShell 파서로만 검사한다 — 실행하지 않는다."""
    env = dict(os.environ)
    env["PS_CODE"] = code
    done = subprocess.run(
        [_POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", _PARSE_PS],
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
        check=False,
    )
    return "" if done.returncode == 0 else (done.stdout or done.stderr or "parse failed").strip()


def test_installer_payload_still_parses():
    """설치기의 PowerShell 페이로드가 문법적으로 온전한가 — ASCII 검사로는 못 잡는다.

    이 파일의 bat 부분은 자기 자신을 읽어 마커 뒤를 .ps1 로 뽑아 실행한다. 거기에 문법 오류가
    있으면 **설치가 통째로 죽는다**(2026-08-14 업데이트 전멸 사고와 같은 구조). 바로가기
    기능이 이 페이로드에 함수를 하나 얹었으므로 여기서 지킨다.
    """
    installer = (ROOT / "release" / "MVHub_Install.bat").read_text(encoding="ascii")
    marker = "### MVHUB_" + "INSTALL_POWERSHELL ###"
    payload = installer.split(marker, 1)
    assert len(payload) == 2, "설치기에서 PowerShell 마커를 못 찾았다"
    assert _ps_parse_errors(payload[1]) == ""


def test_shortcut_powershell_still_parses():
    """런처가 바로가기를 만들 때 넘기는 PowerShell 조각도 같은 이유로 파서에 건다."""
    spec = importlib.util.spec_from_file_location("guard_shortcut_ps", GUARD)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert _ps_parse_errors(module._SHORTCUT_PS) == ""


def test_icon_copy_follows_a_new_release(tmp_path, workspace):
    """★릴리스가 아이콘을 바꾸면 기존 사용자의 바로가기도 따라간다.

    바로가기가 가리키는 것은 %LOCALAPPDATA% 사본이다. 표식이 있다고 일찍 돌아가서 사본을
    안 고치면, 아이콘을 바꿔도 이미 설치된 사람들은 영영 옛 그림을 본다.
    """
    desktop, local = workspace
    root, guard = _install(tmp_path, "install-a")
    assert guard.ensure_desktop_shortcut(desktop=desktop) == "created"

    # 다음 릴리스가 아이콘을 바꿨다고 치자.
    (root / "mvhub.ico").write_bytes(b"NEW-ICON-BYTES")

    assert guard.ensure_desktop_shortcut(desktop=desktop) == "already-marked"
    assert (local / "MVHub" / f"icon-{guard._install_id()}.ico").read_bytes() == b"NEW-ICON-BYTES"


def test_foreign_install_does_not_repaint_the_other_icon(tmp_path, workspace):
    """★남의 바로가기는 대상뿐 아니라 **그림**도 그대로여야 한다.

    아이콘 사본을 한 파일로 공유하면, B 를 한 번 켜는 것만으로 A 바로가기의 그림이 B 것으로
    바뀐다. 실행은 여전히 A 지만 사용자에게는 "아이콘이 멋대로 바뀌었다"로 보인다.
    """
    desktop, local = workspace
    _, guard_a = _install(tmp_path, "install-a")
    root_b, guard_b = _install(tmp_path, "install-b")
    root_b.joinpath("mvhub.ico").write_bytes(b"B-BRAND-ICON")

    assert guard_a.ensure_desktop_shortcut(desktop=desktop) == "created"
    icon_a = local / "MVHub" / f"icon-{guard_a._install_id()}.ico"
    before = icon_a.read_bytes()

    assert guard_b.ensure_desktop_shortcut(desktop=desktop) == "foreign"

    assert icon_a.read_bytes() == before
    assert _read_lnk(desktop / "MV Hub.lnk")["IconLocation"] == f"{icon_a},0"


def test_leftover_temp_link_is_cleared_by_the_next_run(tmp_path, workspace):
    """강제 종료로 남은 임시 .lnk 는 다음 실행이 치운다 — 바탕화면에 쌓이면 안 된다.

    임시 이름을 설치별 고정으로 둔 이유가 이것이다(무작위면 영영 못 치운다).
    """
    desktop, _ = workspace
    _, guard = _install(tmp_path, "install-a")
    stale = desktop / f"MVHub-{guard._install_id()}.tmp.lnk"
    stale.write_bytes(b"corpse")

    assert guard.ensure_desktop_shortcut(desktop=desktop) == "created"

    assert not stale.exists()
    assert list(desktop.glob("*.tmp.lnk")) == []
    assert (desktop / "MV Hub.lnk").is_file()


def test_ensure_shortcut_mode_reports_the_truth_by_exit_code(tmp_path, monkeypatch, capsys):
    """★설치기는 종료 코드로 판단한다 — 'foreign' 을 성공이라 말하면 안 된다.

    foreign 은 아이콘이 있긴 하지만 그것을 누르면 **다른 설치**가 열린다. 그때 설치기가
    "바로가기 준비됨"이라고 하면, 사용자는 방금 설치한 것이 아니라 남의 허브·남의 DB 를 연다.
    """
    _, guard = _install(tmp_path, "install-a")

    for outcome, want in [
        ("created", 0),
        ("already-ours", 0),
        ("foreign", 2),
        ("failed", 2),
        ("no-desktop", 2),
        ("no-icon", 2),
    ]:
        monkeypatch.setattr(guard, "ensure_desktop_shortcut", lambda _o=outcome: _o)
        assert guard.main(["--ensure-shortcut"]) == want, outcome
        assert capsys.readouterr().out.strip() == outcome


def test_broken_icon_copy_is_not_offered_as_usable(tmp_path, workspace, monkeypatch):
    """사본을 쓰다 실패하면 **깨진 것을 쓸 만하다고 내주지 않는다**.

    곧바로 덮어쓰면 write_bytes 가 파일을 먼저 비우므로, 실패 시 0바이트 사본이 남는다.
    옆에 다 쓴 뒤 갈아끼우면 실패해도 이전 사본이 온전히 남는다.
    """
    desktop, local = workspace
    root, guard = _install(tmp_path, "install-a")
    assert guard.ensure_desktop_shortcut(desktop=desktop) == "created"
    copy = local / "MVHub" / f"icon-{guard._install_id()}.ico"
    good = copy.read_bytes()

    real_write = Path.write_bytes

    def _fail_on_staging(self, data):
        if self.name.endswith(".next"):
            real_write(self, data[:10])
            raise OSError("disk full")
        return real_write(self, data)

    (root / "mvhub.ico").write_bytes(b"NEW-ICON-BYTES")
    monkeypatch.setattr(Path, "write_bytes", _fail_on_staging)
    guard._sync_shortcut_icon(root)

    assert copy.read_bytes() == good
    assert list((local / "MVHub").glob("*.next")) == []


def test_normal_launch_is_where_the_shortcut_gets_made(tmp_path, monkeypatch):
    """★이미 설치된 사람이 업데이트로 아이콘을 받는 지점.

    업데이터는 설치 폴더에 파일만 넣는다 — 바탕화면은 그 밖이라 손대지 않는다. 업데이트가
    끝나고 앱이 다시 뜰 때(MVHUB_UPDATE_RESTART=1) **정상 런처 경로**가 바로가기를 만든다.
    이 연결이 끊기면 새 아이콘이 설치 폴더 안에서만 놀고 아무도 못 본다.
    """
    root, guard = _install(tmp_path, "install-a")
    calls: list[str] = []
    monkeypatch.setattr(guard, "ensure_desktop_shortcut", lambda: calls.append("made") or "created")
    monkeypatch.setattr(guard, "acquire_launcher_mutex", lambda port: True)
    monkeypatch.setattr(guard, "_close_stale_launcher_shells", lambda script: None)
    monkeypatch.setattr(guard, "run_guarded", lambda script: 0)

    assert guard.main([str(root / "MV_agent.bat")]) == 0
    assert calls == ["made"]


def test_helper_modes_never_touch_the_desktop(tmp_path, monkeypatch):
    """보조 모드는 바로가기를 건드리지 않는다 — 앱 창 검사·창 닫기는 업데이트 도중에도 돈다.

    거기에 파일 만들기와 PowerShell 호출이 따라붙으면, 멈춘 COM 하나가 업데이트 재기동까지
    붙잡는다(코덱스 P1).
    """
    _, guard = _install(tmp_path, "install-a")
    calls: list[str] = []
    monkeypatch.setattr(guard, "ensure_desktop_shortcut", lambda: calls.append("made") or "created")
    monkeypatch.setattr(guard, "close_app_windows", lambda: 0)
    monkeypatch.setattr(guard, "_find_app_browser", lambda: ("chrome", r"C:\fake\chrome.exe"))
    monkeypatch.setattr(guard, "open_browser_detached", lambda url: None)

    for argv in (["--close-app-window"], ["--app-probe"], ["--open-url", "http://127.0.0.1:8010/"]):
        assert guard.main(argv) == 0, argv
    assert calls == []
