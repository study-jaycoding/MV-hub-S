"""격리 브라우저 실측 도구의 안전 장치 — 복사본에서 공유 서버 토큰·주소가 사라지고, PATH 에서 Higgsfield CLI 가 빠진다.

이 두 가지가 깨지면 실측 중의 클릭이 운영 공유 서버나 실제 CLI(과금)로 나갈 수 있다(tools/browser_measure/servers.py).
"""
from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _load():
    spec = importlib.util.spec_from_file_location("bm_servers", ROOT / "tools" / "browser_measure" / "servers.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_snapshot_removes_shared_server_session_and_points_to_a_dead_address(tmp_path):
    servers = _load()
    src = tmp_path / "src.db"
    with sqlite3.connect(src) as conn:
        conn.execute("CREATE TABLE app_setting(key TEXT PRIMARY KEY, value TEXT)")
        conn.executemany("INSERT INTO app_setting VALUES (?, ?)", [
            ("shared_server_token", "secret-token"), ("shared_server_elev_token", "elev"),
            ("shared_server_url", "http://192.168.1.199:8010"), ("shared_server_url_history", "[]"), ("unrelated", "kept"),
        ])
        conn.execute("CREATE TABLE project_folder_link(project_id TEXT PRIMARY KEY, root_path TEXT)")
        conn.execute("INSERT INTO project_folder_link VALUES ('p1', '//nas/real/project')")
        conn.execute("CREATE TABLE project(id TEXT PRIMARY KEY, name TEXT, render_root_path TEXT)")
        conn.execute("INSERT INTO project VALUES ('p1', 'kept-name', 'D:/real/render')")
    before = src.read_bytes()

    servers.snapshot(src, tmp_path / "copy" / "dst.db")

    with sqlite3.connect(tmp_path / "copy" / "dst.db") as conn:
        rows = dict(conn.execute("SELECT key, value FROM app_setting"))
        folders = conn.execute("SELECT COUNT(*) FROM project_folder_link").fetchone()[0]
        projects = conn.execute("SELECT name, render_root_path FROM project").fetchall()
    assert rows == {"shared_server_url": servers.DEAD_URL, "unrelated": "kept"}
    # Assets 창이 자동 마운트할 실제 폴더 경로가 복사본에 남지 않는다(프로젝트 자체는 남는다)
    assert folders == 0 and projects == [("kept-name", None)]
    assert servers.DEAD_URL.startswith("http://127.0.0.1:")
    assert src.read_bytes() == before  # 원본은 읽기 전용으로만 연다


def test_results_keep_event_kinds_and_paths_but_no_user_text():
    """실측 결과 파일에는 시험 DB 의 실제 이름·이메일이 남을 수 있다 — 기본은 종류와 경로만, 원문을 남길 때도 이메일은 가린다."""
    import sys

    sys.path.insert(0, str(ROOT / "tools" / "browser_measure"))
    try:
        spec = importlib.util.spec_from_file_location("bm_walk", ROOT / "tools" / "browser_measure" / "walk.py")
        walk = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(walk)
    finally:
        sys.path.pop(0)
    events = {
        "console": [{"kind": "log-error", "text": "Failed to load http://127.0.0.1:8232/api/creators?q=홍길동 (someone@example.com)"}],
        "network": [{"status": 409, "method": "DELETE", "url": "http://127.0.0.1:8232/api/generations/abc?owner=홍길동"}],
        "mutations": ["POST api/generations/abc/comments?author=홍길동", "PATCH api/auth/accounts/someone%40example.com/status",
                      "DELETE api/assets/mounts/%ED%99%8D%EA%B8%B8%EB%8F%99", "POST api/no-such-route/honggildong/x"],
        "dialogs": [{"type": "confirm", "message": "프로젝트 '홍길동의 작업'을 지울까요?", "accepted": True}],
    }

    plain = json.dumps(walk.redact(events), ensure_ascii=False)

    assert "홍길동" not in plain and "example.com" not in plain and "someone" not in plain
    # 경로의 동적 조각(이름·이메일·percent-encoding 된 이름)은 라우트 틀로 바뀐다 — 실제 값은 남지 않는다
    assert "%ED%99%8D" not in plain and "honggildong" not in plain and "abc" not in plain
    assert "PATCH /api/auth/accounts/{email}/status" in plain and "POST /api/{…}" in plain
    assert "/api/generations/{gen_id}" in plain and "DELETE" in plain and "confirm" in plain  # 진단에 필요한 종류·틀은 남는다
    assert walk.mask({"note": ["a someone@example.com b"]}) == {"note": ["a <email> b"]}

    # 기본 모드의 단계 기록에는 자유 문장이 남지 않는다 — 메모·예외 원문·검색어가 든 주소는 verbose 일 때만.
    import asyncio

    class FakePage:
        def drain(self):
            return {"console": [], "network": [{"status": "FAILED", "method": "GET", "url": "http://h/x", "err": "홍길동 거부"}], "mutations": [], "dialogs": []}

        async def eval(self, _js):
            return {"cards": 3, "selected": 1, "layers": ["admin-window"], "count": "홍길동 · 3건", "url": "/?q=홍길동"}

    async def says_a_name():
        return "화면에서 읽은 홍길동"

    def record_of(verbose):
        walker = walk.Walker(FakePage(), "t", Path("."), shots=False, verbose=verbose)
        return asyncio.run(walker.step("기능", "단계", says_a_name, settle=0, expect=lambda s, n: "홍길동 이 아니다"))

    # 생성 요청 판정은 기록 상한(12건)·라우트 축약에 기대지 않는다 — 13번째 요청도, 틀에 안 맞는 주소도 센다
    class BusyPage(FakePage):
        def drain(self):
            return {"console": [], "network": [], "dialogs": [],
                    "mutations": ["PUT api/scenes/backup"] * 12 + ["POST api/gen-requests", "POST api/gen-requests/" + "x" * 200]}

    busy = walk.Walker(BusyPage(), "t", Path("."))
    kept = asyncio.run(busy.step("기능", "단계", says_a_name, settle=0))
    assert busy.gen_requests == 2 and len(kept["mutations"]) == 12 and "gen-requests" not in json.dumps(kept)

    quiet = json.dumps(record_of(False), ensure_ascii=False)
    assert "홍길동" not in quiet and '"reason": "기대와 다름"' in quiet and '"verdict": "failed"' in quiet
    assert "홍길동" in json.dumps(record_of(True), ensure_ascii=False)  # 원문이 필요하면 명시적으로 켠다


def test_parent_shell_cannot_redirect_the_isolated_servers():
    """경로 변수는 DATA_DIR 보다 우선한다 — 부모 셸의 `CONTENT_HUB_*` 가 하나라도 넘어가면 격리 폴더 밖에 쓴다."""
    servers = _load()
    parent = {"PATH": "x", "CONTENT_HUB_WORKER_BACKUP_OUTBOX_DIR": "D:/real", "CONTENT_HUB_LOG_DIR": "D:/logs",
              "content_hub_future_path": "D:/later", "HTTPS_PROXY": "http://proxy", "USERPROFILE": "kept"}

    assert servers.isolated_base_env(parent) == {"PATH": "x", "USERPROFILE": "kept"}

    # start() 가 서버에 넘기는 환경 전체: 부모 값은 하나도 없고, 경로 변수는 전부 작업 폴더 안이다
    data = Path("C:/work/H")
    env = servers.server_env(parent, "H", 8231, data)
    assert "D:/real" not in env.values() and "D:/logs" not in env.values() and "D:/later" not in env.values()
    assert env["CONTENT_HUB_NO_PROXY"] == "1" and env["CONTENT_HUB_EXTERNAL_RECOVERY"] == "0" and env["CONTENT_HUB_SHARED_URL"] == servers.DEAD_URL
    for key in ("CONTENT_HUB_DATA", "CONTENT_HUB_DB", "CONTENT_HUB_MEDIA", "CONTENT_HUB_SHARED", "CONTENT_HUB_ASSETS_DIR", "CONTENT_HUB_BACKUP_DIR"):
        assert Path(env[key]) == data or data in Path(env[key]).parents, key


def test_clean_path_drops_every_folder_that_holds_the_cli(tmp_path):
    servers = _load()
    with_cli, also_cli, plain = tmp_path / "npm", tmp_path / "other", tmp_path / "plain"
    for folder in (with_cli, also_cli, plain):
        folder.mkdir()
    (with_cli / "higgsfield.cmd").write_text("", encoding="ascii")
    (also_cli / "hf.exe").write_text("", encoding="ascii")

    cleaned = servers.clean_path(os.pathsep.join([str(with_cli), str(plain), str(also_cli), ""]))

    assert cleaned.split(os.pathsep) == [str(plain)]
