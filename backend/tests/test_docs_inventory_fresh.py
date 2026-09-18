"""docs/inventory/ 의 생성 목록이 코드와 어긋나지 않았는지 지킨다.

엔드포인트·환경변수·테이블·백그라운드 작업을 바꾸면 이 시험이 떨어진다. 그때는
`python tools/gen_inventory.py` 를 돌리고, 바뀐 docs/inventory/ 를 문서 커밋으로 올린다.
생성기는 앱을 import 하지 않고 소스를 읽기만 한다(사용자 데이터에 닿지 않는다).
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # pytest 는 backend/ 에서 돈다 — cwd 에 기대지 않는다


def _load_generator():
    spec = importlib.util.spec_from_file_location("gen_inventory", ROOT / "tools" / "gen_inventory.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_generated_inventory_matches_the_code():
    gen = _load_generator()
    rendered = gen.render()

    old = gen.stale(rendered)
    assert not old, (
        f"docs/inventory/ 가 코드와 어긋났다: {', '.join(old)}\n"
        "고치기: 저장소 루트에서 `python tools/gen_inventory.py` → 바뀐 docs/inventory/ 를 문서 커밋으로 올린다."
    )

    # 추출기가 조용히 빈 목록을 내는 회귀를 막는 앵커(디스크와 같아도 둘 다 비어 있을 수 있다).
    text = {name: data.decode("utf-8") for name, (data, _count) in rendered.items()}
    assert "| `GET` | `/api/health` | `health` | 로컬 예외 |" in text["endpoints.md"]
    assert "| `GET` | `/api/assets/meta`" in text["endpoints.md"]  # 중첩 include_router 의 접두 상속
    assert "| `CONTENT_HUB_DATA` |" in text["env_vars.md"]
    assert "| `generation` | content DB |" in text["db_tables.md"]
    assert "| `trashed` | trash DB (ATTACH) |" in text["db_tables.md"]  # 스키마 접두(trash.trashed)
    assert "| `periodic_backup` | start() | 항상 |" in text["background_jobs.md"]
