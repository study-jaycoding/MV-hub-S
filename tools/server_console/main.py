"""관리 창 부트스트랩: python -I tools\\server_console\\main.py [--check | --launch]

서버 루트에서만 돈다. 표준 라이브러리만 쓰고 server_console 의 다른 모듈을 가져오지 않는다 — 검증한 관리 창
stage(logs\\console-stages\\<커밋>)가 있으면 그 사본의 console.py 를, 없거나 검증에 실패하면 루트의 console.py 를
새 격리 프로세스(-I -B)로 띄운다(2단계 설계 3판). stage 를 만드는 쪽(console_stage.py)도 같은 판정을 쓴다.
--launch 는 일반 권한 bat 에서 불려 관리자 승인(UAC)을 이 검증된 Python 이 직접 요청한다 — 상속 환경
(PATH·SystemRoot)으로 찾는 powershell 을 거치지 않는다.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import os
import re
import subprocess
import sys
from ctypes import wintypes
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STAGES = "console-stages"
POINTER = "console-current.json"
MANIFEST = "console-stage.json"
REQUIRED = ("tools/server_console/__init__.py", "tools/server_console/main.py", "tools/server_console/console.py")
_SHA = re.compile(r"^[0-9a-f]{40}$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_REPARSE_POINT = 0x400
_MAX_JSON = 1_000_000


class StageError(ValueError):
    """관리 창 stage 를 믿을 수 없다 — 이유는 화면에 그대로 보인다."""


def first_line_path(marker: Path) -> Path | None:
    try:
        lines = marker.read_text(encoding="utf-8-sig").strip().splitlines()
    except OSError:
        return None
    if not lines:
        return None
    path = Path(lines[0].strip().strip('"'))
    return path if path.is_absolute() else None


def registered_python(root: Path = ROOT) -> Path | None:
    """`.mvhub-runtime\\python.txt` 의 Python. sys.executable 은 __PYVENV_LAUNCHER__ 로 바뀔 수 있어 쓰지 않는다."""
    path = first_line_path(root / ".mvhub-runtime" / "python.txt")
    return path if path is not None and path.is_file() else None


def isolate_environment(root: Path) -> None:
    """Tk 를 만들기 전 시작 환경 격리 — 홈·현재 폴더의 Tk 설정 파일, 바꿔치기된 Tcl 경로를 쓰지 않게."""
    for key in ("HOME", "TCLLIBPATH", "TCL_LIBRARY", "TK_LIBRARY", "__PYVENV_LAUNCHER__"):
        os.environ.pop(key, None)
    tcl_base = Path(sys.base_prefix) / "tcl"
    for key, prefix, marker in (("TCL_LIBRARY", "tcl", "init.tcl"), ("TK_LIBRARY", "tk", "tk.tcl")):
        found = sorted(p for p in tcl_base.glob(prefix + "[89].*") if (p / marker).is_file()) if tcl_base.is_dir() else []
        if found:
            os.environ[key] = str(found[-1])  # 이 Python 이 함께 설치한 Tcl/Tk 만
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"  # stage 사본에 목록 밖 .pyc 가 생기지 않게(-B 와 같이)
    os.chdir(root)


# ---------- 관리 창 stage 검증 ----------

def _reparse(path: Path) -> bool:
    return bool(getattr(os.lstat(path), "st_file_attributes", 0) & _REPARSE_POINT)


def _read_json(path: Path) -> tuple[bytes, dict]:
    with path.open("rb") as handle:
        raw = handle.read(_MAX_JSON + 1)
    if len(raw) > _MAX_JSON:
        raise StageError(f"{path.name} 이(가) 너무 큽니다")
    try:
        value = json.loads(raw.decode("utf-8"))
    except ValueError as exc:
        raise StageError(f"{path.name} 형식이 아닙니다") from exc
    if not isinstance(value, dict):
        raise StageError(f"{path.name} 형식이 아닙니다")
    return raw, value


def _rel_path(value: object) -> str:
    """목록의 상대경로 — 슬래시 구분, 절대경로·드라이브·`..`·빈 조각 거절."""
    if not isinstance(value, str) or not value or "\\" in value or ":" in value or value.startswith("/"):
        raise StageError(f"목록의 경로가 올바르지 않습니다: {value!r}")
    if any(part in ("", ".", "..") for part in value.split("/")):
        raise StageError(f"목록의 경로가 올바르지 않습니다: {value!r}")
    return value


def stage_dir(install_root: Path, sha: str) -> Path:
    if not _SHA.fullmatch(sha or ""):
        raise StageError("커밋 이름이 40자리 16진수가 아닙니다")
    return install_root / "logs" / STAGES / sha


def manifest_entries(raw_manifest: dict, sha: str) -> dict[str, tuple[int, str]]:
    if raw_manifest.get("format") != 1 or raw_manifest.get("sha") != sha:
        raise StageError("stage 목록의 형식·커밋이 맞지 않습니다")
    files = raw_manifest.get("files")
    if not isinstance(files, list) or not files:
        raise StageError("stage 목록이 비었습니다")
    entries: dict[str, tuple[int, str]] = {}
    folded: set[str] = set()
    for item in files:
        if not isinstance(item, dict):
            raise StageError("stage 목록 항목이 올바르지 않습니다")
        path = _rel_path(item.get("path"))
        size, digest = item.get("size"), item.get("sha256")
        if type(size) is not int or size < 0 or not isinstance(digest, str) or not _HEX64.fullmatch(digest):
            raise StageError(f"stage 목록 항목이 올바르지 않습니다: {path}")
        if path.casefold() in folded or path == MANIFEST:
            raise StageError(f"stage 목록에 같은 경로가 두 번 있습니다: {path}")
        folded.add(path.casefold())
        entries[path] = (size, digest)
    missing = [name for name in REQUIRED if name not in entries]
    if missing:
        raise StageError("stage 에 필수 파일이 없습니다: " + ", ".join(missing))
    return entries


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_stage_dir(stage: Path, sha: str, manifest_sha256: str | None = None) -> dict[str, tuple[int, str]]:
    """stage 폴더가 목록과 바이트까지 같은지. 목록 밖 파일·`__pycache__`·연결 지점이 있으면 거절."""
    for part in (stage.parent.parent, stage.parent, stage):  # logs\console-stages\<sha>
        if not part.is_dir() or _reparse(part):
            raise StageError(f"stage 경로가 없거나 연결 지점입니다: {part}")
    manifest_path = stage / MANIFEST
    if not manifest_path.is_file() or _reparse(manifest_path):
        raise StageError("stage 목록(console-stage.json)이 없습니다")
    raw, value = _read_json(manifest_path)
    if manifest_sha256 is not None and hashlib.sha256(raw).hexdigest() != manifest_sha256:
        raise StageError("stage 목록이 포인터와 다릅니다")
    entries = manifest_entries(value, sha)
    found: set[str] = set()
    for folder, dirs, files in os.walk(stage):
        here = Path(folder)
        for name in dirs:
            if name == "__pycache__" or _reparse(here / name):
                raise StageError(f"stage 에 허용되지 않은 폴더가 있습니다: {here / name}")
        for name in files:
            path = here / name
            if _reparse(path) or name.endswith((".pyc", ".pyo")):
                raise StageError(f"stage 에 허용되지 않은 파일이 있습니다: {path}")
            found.add(path.relative_to(stage).as_posix())
    expected = set(entries) | {MANIFEST}
    if found != expected:
        extra, lost = sorted(found - expected), sorted(expected - found)
        raise StageError(f"stage 파일이 목록과 다릅니다(더 있음 {extra[:3]}, 없음 {lost[:3]})")
    for rel, (size, digest) in entries.items():
        path = stage / rel
        if path.stat().st_size != size or file_sha256(path) != digest:
            raise StageError(f"stage 파일 내용이 목록과 다릅니다: {rel}")
    return entries


def read_pointer(install_root: Path) -> dict | None:
    """포인터 형식까지 확인한 값. 없으면 None."""
    path = install_root / "logs" / POINTER
    if not path.exists():
        return None
    if _reparse(path):
        raise StageError("포인터가 연결 지점입니다")
    _raw, value = _read_json(path)
    sha, rel, digest = value.get("sha"), value.get("path"), value.get("manifest_sha256")
    if value.get("format") != 1 or not isinstance(sha, str) or not _SHA.fullmatch(sha):
        raise StageError("포인터 형식이 아닙니다")
    if rel != f"{STAGES}/{sha}" or not isinstance(digest, str) or not _HEX64.fullmatch(digest):
        raise StageError("포인터 형식이 아닙니다")
    return value


def current_stage(install_root: Path) -> tuple[Path | None, str]:
    """(검증한 stage, 문제). 포인터가 없으면 (None, '') — 루트 판으로 정상 실행."""
    try:
        pointer = read_pointer(install_root)
        if pointer is None:
            return None, ""
        stage = stage_dir(install_root, pointer["sha"])
        verify_stage_dir(stage, pointer["sha"], pointer["manifest_sha256"])
        return stage, ""
    except (StageError, OSError) as exc:
        return None, f"관리 창 stage 확인 실패 — 루트 판으로 열었습니다: {exc}"


# ---------- 띄우기 ----------

def _shell_execute(verb: str, file: str, params: str, directory: str) -> int:
    shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    shell32.ShellExecuteW.argtypes = (wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR,
                                      wintypes.LPCWSTR, ctypes.c_int)
    shell32.ShellExecuteW.restype = ctypes.c_void_p  # HINSTANCE — 32 보다 크면 성공
    return int(shell32.ShellExecuteW(None, verb, file, params, directory, 1) or 0)


def _is_admin() -> bool:
    return bool(ctypes.WinDLL("shell32").IsUserAnAdmin())


def _windowed(python: Path) -> Path:
    pythonw = python.with_name("pythonw.exe")
    return pythonw if pythonw.is_file() else python


def launch(shell_execute=_shell_execute, is_admin=_is_admin, python: Path | None = None) -> int:
    """부트스트랩을 관리자로 다시 띄운다. 이미 관리자면 그대로, 아니면 승인 창을 거친다."""
    python = python or registered_python()
    if python is None:
        print("[error] .mvhub-runtime\\python.txt 의 Python 을 찾지 못했습니다.", file=sys.stderr)
        return 1
    params = subprocess.list2cmdline(["-I", str(Path(__file__).resolve())])
    code = shell_execute("open" if is_admin() else "runas", str(_windowed(python)), params, str(ROOT))
    if code <= 32:
        print(f"[error] 관리자 승인을 받지 못했거나 창을 띄우지 못했습니다(ShellExecute {code}).", file=sys.stderr)
        return 1
    return 0


def console_argv(python: Path, code_root: Path, install_root: Path, extra: list[str]) -> list[str]:
    return [str(python), "-I", "-B", str(code_root / "tools" / "server_console" / "console.py"),
            "--install-root", str(install_root), *extra]


def main(argv: list[str]) -> int:
    if any(part.lower() in (STAGES, "server-stages") for part in ROOT.parts):
        print("[error] 부트스트랩은 서버 루트에서만 돈다(stage 사본 안의 main.py 는 쓰지 않는다).", file=sys.stderr)
        return 2
    isolate_environment(ROOT)
    if "--launch" in argv:
        return launch()
    python = registered_python(ROOT)
    if python is None:
        print("[error] .mvhub-runtime\\python.txt 의 Python 을 찾지 못했습니다.", file=sys.stderr)
        return 1
    stage, note = current_stage(ROOT)
    extra = ["--check"] if "--check" in argv else []
    if note:
        extra += ["--note", note]
    if "--check" in argv:  # bat 의 콘솔에서 결과를 보이고 종료 코드를 그대로 돌려준다
        return subprocess.run(console_argv(python, stage or ROOT, ROOT, extra)).returncode
    subprocess.Popen(console_argv(_windowed(python), stage or ROOT, ROOT, extra), close_fds=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
