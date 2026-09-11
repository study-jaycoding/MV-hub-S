"""'카드 생성물 담기' 후보 라우트 — 일괄 조회로 바꾼 뒤에도 순서·내용이 같아야 한다.

라우터는 후보 id 를 뽑은 뒤 생성물 본문을 **일괄 조회**(get_generations_batch)한다.
예전에는 id 마다 get_generation 을 반복했다(N+1). 3,000건 DB 실측으로 30개 36ms→6ms,
100개 116ms→8ms 였다. 일괄 조회는 dict 를 주므로 **순서가 없다** — 라우터가 id 순서(최신순)로
다시 세우지 않으면 목록이 뒤섞인다. 이 테스트가 그 자리를 고정한다.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import db, repo
from app.deps import resolve_agent_account
from app.main import app


@pytest.fixture()
def client(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        old = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = str(Path(tmp) / "content_hub.db")
        db.flush_pool()
        try:
            monkeypatch.setattr(db, "_POOL_ENABLED", False)
            db.init_db()
            repo.ensure_default_worker()
            yield TestClient(app, client=("127.0.0.1", 50000))
        finally:
            db.flush_pool()
            if old is None:
                os.environ.pop("CONTENT_HUB_DB", None)
            else:
                os.environ["CONTENT_HUB_DB"] = old


def _make_candidates(count: int) -> list[str]:
    """카드에 안 담긴 '담기' 후보를 만든 순서대로 돌려준다(= 오래된 것부터).

    정렬키는 generation.sort_ts(정밀 epoch)다 — 라이브러리 목록과 같은 기준. 여기서는
    같은 초에 만들어도 순서가 서는지 보려고 **1밀리초씩만** 벌린다.
    """
    account = resolve_agent_account(None)  # AUTH off 폴백 — 라우터가 쓰는 바로 그 신원
    email, uid = account["email"], account.get("creator_uid") or repo.get_my_uid()
    made: list[str] = []
    for index in range(count):
        gen_id = repo.create_local_generation(
            {
                "prompt": f"후보 {index}",
                "model": "nano_banana_pro",
                "params": {"prompt": f"후보 {index}"},
            },
            "me",
            creator_uid=uid,
        )
        # 캔버스 연결이 없는 create 요청 = 어느 카드에도 안 담긴 후보
        repo.create_gen_request(email, uid, gen_id, "create", repo.gen_recipe(gen_id))
        with db.get_connection() as conn:
            # 같은 초 안(1.000 → 1.004)이라도 최신순이 서야 한다 — 옛 코드는 이 경우
            # 요청 uuid 로 갈려 배치 생성물의 순서가 매번 달라졌다.
            conn.execute(
                "UPDATE generation SET sort_ts=?, created_at='2026-09-01 10:00:01' WHERE id=?",
                (1_788_000_001.0 + index * 0.001, gen_id),
            )
        made.append(gen_id)
    return made


def test_candidates_are_newest_first_with_full_bodies(client):
    made = _make_candidates(5)

    res = client.get("/api/gen-requests/canvas-candidates?limit=5")
    assert res.status_code == 200
    items = res.json()["items"]

    # 만든 역순(최신 먼저) — 일괄 조회의 dict 순서가 아니라 후보 질의 순서를 따라야 한다
    assert [item["id"] for item in items] == list(reversed(made))
    # 본문이 딸려 온다(옛 단건 조회와 같은 컬럼셋) — 화면이 프롬프트·모델로 항목을 그린다
    assert items[0]["prompt"] == "후보 4"
    assert items[0]["model"] == "nano_banana_pro"


def test_candidates_limit_cuts_from_the_newest_end(client):
    made = _make_candidates(5)

    items = client.get("/api/gen-requests/canvas-candidates?limit=2").json()["items"]
    assert [item["id"] for item in items] == [made[4], made[3]]
