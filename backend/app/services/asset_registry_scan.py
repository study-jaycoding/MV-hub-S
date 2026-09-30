"""에셋 대장 훑기 — **자식 프로세스 전용**(NAS 읽기만). 설계: docs/ASSET_REGISTRY.md '12. NAS 읽기 안정성'.

부모(services/asset_registry.py)가 작업 파일(JSON)을 주고 이 모듈을 따로 실행한다:
    python -m app.services.asset_registry_scan <job.json>
  · DB 를 열지 않는다 — 반영은 부모만 한다(풀 epoch·유지보수 관문은 부모 메모리에만 있다, Codex).
  · SMB 에 멈추면 부모가 프로세스째 끝낸다(스레드는 못 끊는다). 그래서 무거운 앱 모듈을 불러오지 않는다.
  · 결과는 JSONL 로 흘려 쓴다(메모리에 전부 쌓지 않는다). 마지막 줄 {"t":"end"} 가 없으면 부모는 미완주로 본다.

순서: ① 목록(폴더마다 scandir 한 번, 초당 dir_rate 폴더 이하, 항목별 stat 없음) → ② 지문(1 MiB 단위 token bucket).
  · 목록을 끝까지 못 읽으면(폴더 읽기 오류·시간 초과·항목 상한) complete=false — 부모가 결과 전체를 버린다.
  · 파일 하나가 잠김·읽기 실패·0바이트·읽는 중 바뀜이면 그 파일만 undetermined.
  · 예산(시간) 안에 못 낸 지문은 pending — 다음 주기가 이어서 한다. 혼자서 예산을 넘는 큰 파일은 why=large.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat as stat_mod
import sys
import time
from pathlib import Path
from typing import Any, Iterator, Optional

from .media_types import AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS

_MEDIA = frozenset(IMAGE_EXTENSIONS + VIDEO_EXTENSIONS + AUDIO_EXTENSIONS)
_CHUNK = 1 << 20  # 1 MiB
_REPARSE_POINT = 0x400  # FILE_ATTRIBUTE_REPARSE_POINT — 정션·링크 폴더는 따라가지 않는다(에셋 트리와 같게)


def hidden_name(name: str) -> bool:
    """에셋 트리와 같은 숨김 규칙(services/asset_tree.is_hidden_name) — 무거운 모듈을 안 불러오려고 옮겨 둔 사본.
    둘이 어긋나지 않게 시험(test_asset_registry_scan)이 대조한다."""
    return name.startswith((".", "_")) or name.lower() == "readme.md"


class _Limiter:
    """평균 속도 상한 — 누적 양 / 속도 만큼의 시간이 지나기 전에는 쉰다(token bucket 과 같은 효과, 단순형)."""

    def __init__(self, per_second: float) -> None:
        self.per_second = max(float(per_second), 1e-6)
        self.start = time.monotonic()
        self.spent = 0.0

    def take(self, amount: float) -> None:
        self.spent += amount
        ahead = self.spent / self.per_second - (time.monotonic() - self.start)
        if ahead > 0:
            time.sleep(ahead)


class _Abort(Exception):
    """목록을 끝까지 못 읽었다 — 결과 전체가 무효."""


def _walk(root: Path, dirs: _Limiter, deadline: float, max_entries: int, hide_render: bool) -> Iterator[tuple[str, int, int]]:
    """(상대경로, 크기, 수정시각 ns). Windows scandir 는 목록 한 번에 크기·시각을 주므로 항목마다 NAS 에 묻지 않는다."""
    stack: list[tuple[str, str]] = [("", str(root))]
    count = 0
    while stack:
        if time.monotonic() > deadline:
            raise _Abort("목록 시간 초과")
        rel_dir, abs_dir = stack.pop()
        dirs.take(1)
        try:
            with os.scandir(abs_dir) as it:
                entries = list(it)
        except OSError as exc:
            raise _Abort(f"폴더 읽기 실패: {type(exc).__name__}") from exc
        for entry in entries:
            name = entry.name
            if hidden_name(name):
                continue
            rel = f"{rel_dir}/{name}" if rel_dir else name
            try:
                if entry.is_dir(follow_symlinks=False):
                    attrs = getattr(entry.stat(follow_symlinks=False), "st_file_attributes", 0)
                    if entry.is_symlink() or attrs & _REPARSE_POINT:
                        continue
                    if hide_render and name.casefold() == "render":
                        continue
                    stack.append((rel, entry.path))
                    continue
                if entry.is_symlink() or os.path.splitext(name)[1].lower() not in _MEDIA:
                    continue
                st = entry.stat(follow_symlinks=False)
                if not stat_mod.S_ISREG(st.st_mode):
                    continue
            except OSError as exc:
                raise _Abort(f"항목 읽기 실패: {type(exc).__name__}") from exc
            count += 1
            if count > max_entries:
                raise _Abort("항목 상한 초과")
            yield rel, int(st.st_size), int(st.st_mtime_ns)


def _hash(path: Path, limiter: _Limiter, deadline: float) -> tuple[str, Optional[str], int, int]:
    """(status, sha, bytes, mtime_ns). stat → hash → stat 이 어긋나면 undetermined."""
    try:
        before = os.stat(path)
        if before.st_size <= 0:
            return "undetermined:empty", None, 0, int(before.st_mtime_ns)
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            while True:
                if time.monotonic() > deadline:
                    return "pending:budget", None, int(before.st_size), int(before.st_mtime_ns)
                block = handle.read(_CHUNK)
                if not block:
                    break
                digest.update(block)
                limiter.take(len(block))
        after = os.stat(path)
    except PermissionError:
        return "undetermined:locked", None, 0, 0
    except OSError:
        return "undetermined:error", None, 0, 0
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        return "undetermined:changed", None, int(after.st_size), int(after.st_mtime_ns)
    return "ok", digest.hexdigest(), int(after.st_size), int(after.st_mtime_ns)


def run(job: dict[str, Any]) -> dict[str, Any]:
    started = time.monotonic()
    deadline = started + float(job["deadline_s"])
    root = Path(job["root"])
    known: dict[str, list] = job.get("known") or {}
    priority = set(job.get("priority") or ())
    rate = float(job["rate_bytes"])
    end: dict[str, Any] = {"t": "end", "complete": False, "files": 0, "hashed": 0, "hashed_bytes": 0,
                           "undetermined": 0, "pending": 0, "note": ""}
    out_path = Path(job["out"])
    with open(out_path, "w", encoding="utf-8", newline="\n") as out:

        def emit(rel: str, size: int, mtime: int, sha: Optional[str], status: str) -> None:
            state, _, why = status.partition(":")
            line = {"t": "file", "p": rel, "b": size, "m": mtime, "s": sha, "st": state}
            if why:
                line["why"] = why
            out.write(json.dumps(line, ensure_ascii=False) + "\n")
            end["files"] += 1
            if state in ("undetermined", "pending"):
                end[state] += 1

        queue: list[tuple[str, int, int]] = []
        try:
            if job.get("hash_only") is not None:
                for rel in job["hash_only"]:
                    queue.append((rel, 0, 0))
            else:
                if not root.is_dir():
                    raise _Abort("루트 폴더를 열 수 없음")
                for rel, size, mtime in _walk(root, _Limiter(float(job["dir_rate"])), deadline,
                                              int(job["max_entries"]), bool(job.get("hide_render", True))):
                    k = known.get(rel)
                    if k and int(k[0]) == size and int(k[1]) == mtime and k[2]:
                        emit(rel, size, mtime, k[2], "ok")  # 크기·시각이 같으면 이번엔 다시 안 읽는다(판정 근거 아님)
                    else:
                        queue.append((rel, size, mtime))
        except _Abort as exc:
            end["note"] = str(exc)
            end["elapsed_ms"] = int((time.monotonic() - started) * 1000)
            out.write(json.dumps(end, ensure_ascii=False) + "\n")
            return end

        # 지문: 지난번에 못 한 것 먼저, 그다음 작은 것부터(한 주기에 더 많이 끝낸다).
        queue.sort(key=lambda item: (item[0] not in priority, item[1]))
        limiter = _Limiter(rate)
        budget_s = max(deadline - time.monotonic(), 0.0)
        for i, (rel, size, mtime) in enumerate(queue):
            left = deadline - time.monotonic()
            if size and size / rate > budget_s:
                emit(rel, size, mtime, None, "pending:large")
                continue
            if left <= 0 or (size and size / rate > left):
                emit(rel, size, mtime, None, "pending:budget")
                continue
            status, sha, got_size, got_mtime = _hash(root / rel, limiter, deadline)
            if status == "ok":
                end["hashed"] += 1
                end["hashed_bytes"] += got_size
            emit(rel, got_size or size, got_mtime or mtime, sha, status)
        end["complete"] = True
        end["elapsed_ms"] = int((time.monotonic() - started) * 1000)
        out.write(json.dumps(end, ensure_ascii=False) + "\n")
    return end


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python -m app.services.asset_registry_scan <job.json>", file=sys.stderr)
        return 2
    job = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    run(job)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
