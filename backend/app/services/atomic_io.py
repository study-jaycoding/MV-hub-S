"""파일을 원자적으로 쓴다 — 같은 디렉터리 임시파일에 쓴 뒤 os.replace 로 교체.

크래시/동시쓰기 중간에 '잘린 파일'이 남지 않게 한다(활성계정 포인터·마운트·비용캐시 등 설정 JSON).
os.replace 는 같은 파일시스템에서 원자적이라, 읽는 쪽은 항상 '이전 완전본' 또는 '새 완전본'만 본다.
(예: 활성계정 포인터가 반쯤 쓰이다 크래시하면 허브가 빈 계정 DB 를 읽어 데이터가 안 보이던 류의 사고 방지.)
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path


def atomic_write_text(path: Path, text: str, encoding: str = "utf-8") -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # 같은 디렉터리에 고유 임시파일(동시 쓰기끼리 tmp 충돌 없음) → fsync 로 디스크 반영 → 원자 교체.
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix="." + path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding=encoding, newline="") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)  # 원자적 교체(같은 FS)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
