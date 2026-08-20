"""UTF-8 BOM을 허용해 작은 pin 파일의 첫 줄을 출력한다."""

from __future__ import annotations

import sys
from pathlib import Path


def read_first_line(path: Path) -> str:
    text = path.read_text(encoding="utf-8-sig").strip()
    return text.splitlines()[0].strip() if text else ""


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        return 2
    try:
        value = read_first_line(Path(args[0]))
    except OSError:
        return 1
    if value:
        print(value)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
