"""docs/CODE_MAP.md 와 저장소를 양방향으로 대조한다(읽기 전용, 수동 도구).

  1. 문서에 백틱으로 적힌 코드 파일 이름이 전부 실제 추적 파일인가  (지어낸·옮겨진 파일)
  2. 코드 파일이 전부 문서에 이름으로 실려 있는가                  (지도에서 빠진 파일)

사용:  python tools/check_code_map.py [문서 경로]
종료 코드 0 = 일치, 1 = 어긋남(목록 출력). 배포 게이트·lint:docs 에는 묶여 있지 않다.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CODE_EXT = (".py", ".ts", ".tsx", ".css", ".bat", ".ps1")
MAPPED_DIRS = ("backend/app/", "frontend/src/", "tools/", "release/", "deploy/")


def main() -> int:
    doc_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "docs" / "CODE_MAP.md"
    doc = doc_path.read_text(encoding="utf-8")
    tracked = subprocess.run(
        ["git", "-C", str(ROOT), "ls-files"], capture_output=True, text=True, encoding="utf-8", check=True
    ).stdout.splitlines()

    tokens = {
        tok.strip().replace("\\", "/")
        for tok in re.findall(r"`([^`\n]+)`", doc)
        if tok.strip().endswith(CODE_EXT) and not re.search(r"^\.|[\s*<({=]", tok.strip())
    }
    invented = sorted(t for t in tokens if not any(p == t or p.endswith("/" + t) for p in tracked))

    in_scope = [
        p for p in tracked
        if p.endswith(CODE_EXT)
        and (p.startswith(MAPPED_DIRS) or "/" not in p)
        and "/tests/" not in p
        and not p.endswith(("__init__.py", ".test.ts", ".test.tsx", ".d.ts"))
    ]
    missing = sorted(p for p in in_scope if Path(p).name not in doc)

    print(f"{doc_path.name}: 문서의 코드 파일 이름 {len(tokens)}개 중 저장소에 없는 것 {len(invented)}개")
    for t in invented:
        print(f"  ? {t}")
    print(f"대상 코드 파일 {len(in_scope)}개 중 문서에 없는 것 {len(missing)}개")
    for p in missing:
        print(f"  - {p}")
    return 1 if invented or missing else 0


if __name__ == "__main__":
    sys.exit(main())
