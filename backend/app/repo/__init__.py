"""데이터 접근 계층 (Phase 2/3) — 패키지.

repo.py 가 비대해져 모듈로 분해(CLAUDE.md 원칙 5). 외부에서 쓰는 `repo.X` API 는
이 __init__ 의 re-export 로 동일하게 유지된다. 순수 재조직 — 동작 변경 없음.
"""

from __future__ import annotations

# ── 공용 헬퍼·상수 + 외부에서 쓰일 수 있는 재export ───────────────────────
from ..config import DEFAULT_WORKER_ID, DEFAULT_WORKER_NAME, SHARED_DIR
from ..db import get_connection
from ._common import (
    BUNDLE_FORMAT,
    BUNDLE_VERSION,
    _cached_or_remote,
    _remote_url,
    new_id,
)

# ── 각 모듈 전량 re-export ────────────────────────────────────────────────
from .identity import *  # noqa: F401,F403
from .tags import *  # noqa: F401,F403
from .generation_rows import *  # noqa: F401,F403  (조회 응답 보강 _attach_children — generations 앞)
from .lineage import *  # noqa: F401,F403  (generations 앞 — generations 가 lineage private helper 를 import)
from .generations import *  # noqa: F401,F403
from .facets import *  # noqa: F401,F403  (generations 에서 분리 — get_facets)
from .sources import *  # noqa: F401,F403  (generations 뒤 — search_sources 가 _attach_children import)
from .gen_requests import *  # noqa: F401,F403  (generations 뒤 — placeholder gen 을 다룸)
from .trash import *  # noqa: F401,F403  (generations·tags 뒤 — trash 가 둘을 import)
from .assets import *  # noqa: F401,F403
from .share import *  # noqa: F401,F403
from .projects import *  # noqa: F401,F403
from .accounts import *  # noqa: F401,F403

# ── cross-module/외부에서 쓰일 수 있는 private 명시 re-export ──────────────
from .identity import _MY_UID_CACHE, ensure_worker, get_setting, set_setting
from .tags import _add_tags, _set_auto_tags, _set_tags
from .generation_rows import _attach_children
from .generations import _delete_generation
from .share import import_bundle_item
