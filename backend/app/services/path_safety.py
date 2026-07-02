"""경로 안전 결합 공용 — base 아래로만 해석되게 join(traversal·symlink 이탈 차단).

라우터·서비스 여러 곳에서 `(base / rel).resolve()` 후 `relative_to(base)` 로 이탈을 막던 동일 패턴을
한 곳에 모은다. 보안 로직이므로 동작을 그대로 보존한다:
  · `resolve()` 로 symlink 까지 실제 해석해 base 밖을 가리키면 차단(문자열 prefix 검사보다 강함).
  · 절대경로 rel 이라도 최종 위치가 base 안이면 허용(기존 `(base / rel).resolve()` 동작 유지).
  · 해석 실패(ValueError/OSError)는 안전측(None)으로 — 못 여는 경로는 접근 거부.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional, Union


def safe_join(base: Path, rel: Union[str, Path]) -> Optional[Path]:
    """base 아래로 안전하게 결합한 절대경로. 최종 해석 경로가 base 밖이면 None."""
    try:
        base = base.resolve()
        cand = (base / rel).resolve()
        cand.relative_to(base)
    except (ValueError, OSError):
        return None
    return cand
