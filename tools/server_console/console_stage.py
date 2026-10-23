"""관리 창 전용 stage 만들기·바꾸기·정리(2단계 설계 3판 6). 서버 루트(HEAD·작업 트리)는 건드리지 않는다.

stage = logs\\console-stages\\<커밋 40자> 에 `git archive` 로 꺼낸 관리 창 코드 + console-stage.json(파일마다 크기·sha256).
포인터 = logs\\console-current.json. 검증은 부트스트랩(main.py)과 같은 함수를 쓴다.
"""
from __future__ import annotations

import hashlib
import json
import msvcrt
import os
import re
import secrets
import shutil
import time
import zipfile
from pathlib import Path
from typing import Callable

from . import names
from .install import Installation, Runner, child_env, trusted_git
from .main import MANIFEST, POINTER, STAGES, StageError, read_pointer, stage_dir, verify_stage_dir

PATHS = ("tools/server_console", "tools/log_viewer.py", "tools/deploy_fence_check.py")
KEEP_AT_LEAST = 3
_SHA = re.compile(r"^[0-9a-f]{40}$")
Say = Callable[[str], None]


def _git(inst: Installation, runner: Runner, args: list[str], timeout: float = 120) -> str:
    git = trusted_git()
    if git is None:
        raise StageError("설치된 Git 을 찾지 못했습니다")
    code, out = runner([str(git), "-C", str(inst.root), "-c", "core.quotepath=off", *args], timeout)
    if code != 0:
        raise StageError(f"git {args[0]} 실패")
    return out


def latest_main(inst: Installation, runner: Runner) -> str:
    """origin 을 받아 온 뒤 그 순간의 origin/main 을 고정한다(루트 HEAD·작업 트리는 그대로)."""
    _git(inst, runner, ["fetch", "origin"], 180)
    sha = _git(inst, runner, ["rev-parse", "origin/main"]).strip()
    if not _SHA.fullmatch(sha):
        raise StageError("origin/main 커밋을 읽지 못했습니다")
    return sha


def expected_files(inst: Installation, runner: Runner, sha: str) -> list[str]:
    """그 커밋에 들어 있는 관리 창 파일 목록 — 꺼낸 결과가 정확히 이것과 같아야 한다(export-ignore 누락 거절)."""
    out = _git(inst, runner, ["ls-tree", "-r", "-z", "--name-only", sha, "--", *PATHS])
    return sorted(name for name in out.split("\0") if name)


def _extract(archive: Path, folder: Path) -> list[str]:
    names_ = []
    with zipfile.ZipFile(archive) as bundle:
        for entry in bundle.infolist():
            if entry.is_dir():
                continue
            name = entry.filename
            if "\\" in name or ":" in name or any(part in ("", ".", "..") for part in name.split("/")):
                raise StageError(f"꺼낸 파일 경로가 올바르지 않습니다: {name}")
            if ((entry.external_attr >> 16) & 0o170000) == 0o120000:
                raise StageError(f"꺼낸 파일이 링크입니다: {name}")
            target = folder / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(entry) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
            names_.append(name)
    return sorted(names_)


def write_json_atomic(path: Path, value: dict) -> bytes:
    raw = (json.dumps(value, ensure_ascii=False, indent=1, sort_keys=True) + "\n").encode("utf-8")
    temp = path.with_name(path.name + f".{os.getpid()}.tmp")
    temp.write_bytes(raw)
    os.replace(temp, path)
    return raw


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _stages_root(inst: Installation) -> Path:
    stages = inst.logs / STAGES
    if not inst.logs.is_dir():
        raise StageError("logs 폴더가 없습니다")
    stages.mkdir(exist_ok=True)
    if getattr(os.lstat(stages), "st_file_attributes", 0) & 0x400:
        raise StageError("console-stages 가 연결 지점입니다")
    return stages


def build(inst: Installation, runner: Runner, sha: str, check: Callable[[Path], None], say: Say) -> Path:
    """그 커밋의 관리 창을 임시 폴더에 꺼내 검사한 뒤 stage 로 게시한다. 이미 있으면 다시 검증해 재사용."""
    final = stage_dir(inst.root, sha)
    stages = _stages_root(inst)
    if final.exists():
        verify_stage_dir(final, sha)
        say(f"이미 있는 관리 창 stage 를 다시 검증해 씁니다: {sha[:12]}")
        return final
    tag = secrets.token_hex(8)
    temp, archive = stages / f".tmp-{tag}", stages / f".tmp-{tag}.zip"
    os.mkdir(temp)
    try:
        _git(inst, runner, ["archive", "--format=zip", f"--output={archive}", sha, "--", *PATHS])
        found = _extract(archive, temp)
        expected = expected_files(inst, runner, sha)
        if found != expected:
            raise StageError(f"꺼낸 파일이 커밋 목록과 다릅니다(꺼냄 {len(found)}, 커밋 {len(expected)})")
        files = [{"path": name, "size": (temp / name).stat().st_size, "sha256": _sha256(temp / name)} for name in found]
        write_json_atomic(temp / MANIFEST, {"format": 1, "sha": sha, "files": files})
        verify_stage_dir(temp, sha)
        say(f"관리 창 코드 {len(found)}개를 꺼냈습니다 — 시작 점검 중")
        check(temp)
        verify_stage_dir(temp, sha)  # 점검이 목록 밖 파일(.pyc 등)을 남기지 않았는지
        os.rename(temp, final)
        return final
    finally:
        archive.unlink(missing_ok=True)
        if temp.exists():
            shutil.rmtree(temp, ignore_errors=True)


def check_with_python(inst: Installation, runner: Runner) -> Callable[[Path], None]:
    """새 stage 로 관리 창 시작 점검(Tk + 모든 모듈 가져오기, -B). 실패하면 게시하지 않는다."""
    def check(code_root: Path) -> None:
        if inst.python is None:
            raise StageError("등록된 Python 이 없습니다")
        argv = [str(inst.python), "-I", "-B", str(code_root / "tools" / "server_console" / "console.py"),
                "--install-root", str(inst.root), "--check"]
        code, out = runner(argv, 120)
        if code != 0:
            raise StageError(f"새 관리 창 시작 점검 실패(종료 코드 {code}) {out.strip()[-200:]}")
    return check


def publish(inst: Installation, sha: str) -> dict:
    """포인터를 새 stage 로 원자 교체한다. 지금 포인터는 previous 로 남긴다(되돌리기)."""
    stage = stage_dir(inst.root, sha)
    verify_stage_dir(stage, sha)
    try:
        old = read_pointer(inst.root)
    except StageError:
        old = None  # 깨진 포인터는 되돌릴 대상으로 남기지 않는다
    pointer = {"format": 1, "sha": sha, "path": f"{STAGES}/{sha}",
               "manifest_sha256": _sha256(stage / MANIFEST), "published_at": time.time(),
               "previous": old["sha"] if old and old["sha"] != sha else (old or {}).get("previous")}
    write_json_atomic(inst.logs / POINTER, pointer)
    return pointer


def in_use(inst: Installation, jobs_in_use: list[str]) -> set[str]:
    """지우면 안 되는 stage 커밋 — 지금·직전 포인터, 실행 중인 화면, 미해결 작업이 쓰는 것."""
    keep: set[str] = set()
    try:
        pointer = read_pointer(inst.root)
    except StageError:
        pointer = None
    for sha in ((pointer or {}).get("sha"), (pointer or {}).get("previous")):
        if isinstance(sha, str) and _SHA.fullmatch(sha):
            keep.add(sha)
    for code_root in jobs_in_use:
        parts = Path(code_root).parts
        if len(parts) >= 2 and parts[-2].lower() == STAGES and _SHA.fullmatch(parts[-1]):
            keep.add(parts[-1])
    return keep


def prune(inst: Installation, keep: set[str], say: Say) -> list[str]:
    """쓰지 않는 오래된 stage 만 지운다(최근 KEEP_AT_LEAST 개는 늘 남김). 남은 임시 폴더도 정리."""
    stages = _stages_root(inst)
    found = []
    for path in stages.iterdir():
        if path.name.startswith(".tmp-") and time.time() - path.stat().st_mtime > 3600:
            if path.is_dir() and not (getattr(os.lstat(path), "st_file_attributes", 0) & 0x400):
                shutil.rmtree(path, ignore_errors=True)
            elif path.is_file():
                path.unlink(missing_ok=True)
        elif _SHA.fullmatch(path.name) and path.is_dir() and not (getattr(os.lstat(path), "st_file_attributes", 0) & 0x400):
            found.append(path)
    found.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    removed = []
    for path in found[KEEP_AT_LEAST:]:
        if path.name not in keep:
            shutil.rmtree(path, ignore_errors=True)
            removed.append(path.name)
    if removed:
        say(f"쓰지 않는 옛 관리 창 stage {len(removed)}개를 정리했습니다")
    return removed


class UpdateLock:
    """Git 업데이트와 같은 잠금(git-update.lock 0번 바이트) — 관리 도구 갱신이 서버 업데이트와 겹치지 않게."""

    def __init__(self, inst: Installation) -> None:
        self.path = inst.logs / names.GIT_UPDATE_LOCK
        self.handle = None

    def __enter__(self) -> "UpdateLock":
        handle = self.path.open("a+b")  # 내용은 건드리지 않는다(run_update_git.ps1 Open-UpdateLock 과 같은 0번 바이트 잠금)
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            handle.close()
            raise StageError("다른 업데이트가 실행 중입니다(git-update.lock)") from exc
        self.handle = handle
        return self

    def __exit__(self, *exc) -> None:
        try:
            self.handle.seek(0)
            msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
        finally:
            self.handle.close()


def update_work(inst: Installation, runner: Runner, recheck: Callable[[], list[str]],
                jobs_in_use: Callable[[], list[str]], say: Say) -> tuple[int, dict]:
    """[관리 도구 갱신] — 잠금 아래에서 다시 확인 → origin/main 고정 → stage 만들기·검사 → 포인터 교체 → 정리."""
    with UpdateLock(inst):
        reasons = recheck()
        if reasons:
            raise StageError("시작하지 않음: " + " / ".join(reasons))
        sha = latest_main(inst, runner)
        say(f"origin/main 을 {sha[:12]} 로 고정했습니다")
        build(inst, runner, sha, check_with_python(inst, runner), say)
        pointer = publish(inst, sha)
        say(f"관리 창을 {sha[:12]} 로 바꿨습니다 — 관리 창을 다시 열면 적용됩니다")
        prune(inst, in_use(inst, jobs_in_use()), say)
    return 0, {"console_sha": sha, "previous_sha": pointer.get("previous") or ""}


def rollback_work(inst: Installation, from_sha: str, to_sha: str, say: Say) -> tuple[int, dict]:
    """[이전 관리 창으로] — 확인한 지금 포인터가 그대로일 때만, 검증한 직전 stage 로 포인터를 바꾼다."""
    with UpdateLock(inst):
        pointer = read_pointer(inst.root)
        if (pointer or {}).get("sha") != from_sha:
            raise StageError("관리 창 포인터가 그새 바뀌었습니다 — 다시 확인하세요")
        publish(inst, to_sha)
        say(f"관리 창을 {to_sha[:12]} 로 되돌렸습니다 — 관리 창을 다시 열면 적용됩니다")
    return 0, {"console_sha": to_sha, "previous_sha": from_sha}


def default_runner_for(inst: Installation) -> Runner:
    from .install import run_command
    env = dict(child_env(inst), PYTHONDONTWRITEBYTECODE="1")
    return lambda argv, timeout: run_command(argv, timeout, env)
