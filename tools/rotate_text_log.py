# -*- coding: utf-8 -*-
"""Windows에서 로그 핸들이 열리기 전에 작은 번호 세대로 안전하게 회전한다."""
from __future__ import annotations

import argparse
from pathlib import Path


def _generation(path: Path, index: int) -> Path:
    return Path(f"{path}.{index}")


def rotate_text_log(path: Path, *, max_bytes: int, keep: int = 3) -> bool:
    """크기 초과 시 path→path.1로 옮기고 지정한 세대만 보존한다.

    로그 정리 실패가 서버 시작이나 백업을 막지 않도록 실패는 False로 반환한다.
    """
    target = Path(path)
    limit = max(1, int(max_bytes))
    generations = max(1, int(keep))
    try:
        if not target.is_file() or target.stat().st_size <= limit:
            return False
        oldest = _generation(target, generations)
        if oldest.exists():
            oldest.unlink()
        for index in range(generations - 1, 0, -1):
            source = _generation(target, index)
            if source.exists():
                source.replace(_generation(target, index + 1))
        target.replace(_generation(target, 1))
        return True
    except OSError:
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="MV Hub text log rotation")
    parser.add_argument("path")
    parser.add_argument("--max-bytes", type=int, required=True)
    parser.add_argument("--keep", type=int, default=3)
    args = parser.parse_args()
    rotate_text_log(Path(args.path), max_bytes=args.max_bytes, keep=args.keep)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
