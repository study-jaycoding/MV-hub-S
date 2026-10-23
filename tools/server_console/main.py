"""관리 창 진입점: python -I tools\\server_console\\main.py [--check | --launch]

Tk 를 만들기 전에 시작 환경을 격리한다 — 홈·현재 폴더의 Tk 설정 파일, 바꿔치기된 Tcl 경로를 쓰지 않게.
--launch 는 일반 권한 bat 에서 불려 관리자 승인(UAC)을 이 검증된 Python 이 직접 요청한다 — 상속 환경
(PATH·SystemRoot)으로 찾는 powershell 을 거치지 않는다.
"""
from __future__ import annotations

import ctypes
import os
import subprocess
import sys
from ctypes import wintypes
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1]
ROOT = TOOLS.parent


def isolate_environment() -> None:
    for key in ("HOME", "TCLLIBPATH", "TCL_LIBRARY", "TK_LIBRARY", "__PYVENV_LAUNCHER__"):
        os.environ.pop(key, None)
    tcl_base = Path(sys.base_prefix) / "tcl"
    for key, prefix, marker in (("TCL_LIBRARY", "tcl", "init.tcl"), ("TK_LIBRARY", "tk", "tk.tcl")):
        found = sorted(p for p in tcl_base.glob(prefix + "[89].*") if (p / marker).is_file()) if tcl_base.is_dir() else []
        if found:
            os.environ[key] = str(found[-1])  # 이 Python 이 함께 설치한 Tcl/Tk 만
    os.chdir(ROOT)
    sys.path.insert(0, str(TOOLS))  # -I 라 스크립트 폴더가 경로에 없다


def _shell_execute(verb: str, file: str, params: str, directory: str) -> int:
    shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    shell32.ShellExecuteW.argtypes = (wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR,
                                      wintypes.LPCWSTR, ctypes.c_int)
    shell32.ShellExecuteW.restype = ctypes.c_void_p  # HINSTANCE — 32 보다 크면 성공
    return int(shell32.ShellExecuteW(None, verb, file, params, directory, 1) or 0)


def _is_admin() -> bool:
    return bool(ctypes.WinDLL("shell32").IsUserAnAdmin())


def registered_python(root: Path = ROOT) -> Path | None:
    """`.mvhub-runtime\\python.txt` 의 Python. sys.executable 은 __PYVENV_LAUNCHER__ 로 바뀔 수 있어 쓰지 않는다."""
    from server_console.install import _first_line_path  # isolate_environment 뒤에만 부른다(sys.path)
    path = _first_line_path(root / ".mvhub-runtime" / "python.txt")
    return path if path is not None and path.is_file() else None


def launch(shell_execute=_shell_execute, is_admin=_is_admin, python: Path | None = None) -> int:
    """창(pythonw)을 관리자로 띄운다. 이미 관리자면 그대로, 아니면 승인 창을 거친다."""
    python = python or registered_python()
    if python is None:
        print("[error] .mvhub-runtime\\python.txt 의 Python 을 찾지 못했습니다.", file=sys.stderr)
        return 1
    pythonw = python.with_name("pythonw.exe")
    exe = pythonw if pythonw.is_file() else python
    params = subprocess.list2cmdline(["-I", str(Path(__file__).resolve())])
    code = shell_execute("open" if is_admin() else "runas", str(exe), params, str(ROOT))
    if code <= 32:
        print(f"[error] 관리자 승인을 받지 못했거나 창을 띄우지 못했습니다(ShellExecute {code}).", file=sys.stderr)
        return 1
    return 0


def main(argv: list[str]) -> int:
    isolate_environment()
    if "--launch" in argv:
        return launch()
    from server_console import ui
    if "--check" in argv:
        return ui.check_tk()
    return ui.run()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
