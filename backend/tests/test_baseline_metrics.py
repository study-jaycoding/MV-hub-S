from __future__ import annotations

import hashlib
import importlib.util
import json
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.services import media_cache, thumbs


REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND = REPO_ROOT / "backend"
SCHEMA = BACKEND / "schema.sql"
TOOL = REPO_ROOT / "tools" / "baseline_metrics.py"
REMOTE_ASSET_URL = "https://cdn.example.com/generations/remote.png?token=asset"
UNRELATED_REMOTE_URL = "https://cdn.example.com/generations/unrelated.png"


def _load_tool():
    spec = importlib.util.spec_from_file_location("baseline_metrics", TOOL)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _signature(path: Path) -> tuple[str, int, int]:
    stat = path.stat()
    return hashlib.sha256(path.read_bytes()).hexdigest(), stat.st_size, stat.st_mtime_ns


def _create_content_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.executescript(SCHEMA.read_text(encoding="utf-8"))
        # schema.sql 뒤 실제 마이그레이션으로 존재하는 현재 generation 컬럼 중 이번 판정에 필요한 것.
        conn.execute("ALTER TABLE generation ADD COLUMN project_id TEXT")
        conn.execute("ALTER TABLE generation ADD COLUMN folder_path TEXT")
        conn.execute("ALTER TABLE generation ADD COLUMN deleted_at TEXT")
        conn.execute(
            "CREATE TABLE credit_txn("
            "id TEXT PRIMARY KEY, owner_uid TEXT, account_email TEXT, display_name TEXT, "
            "credits REAL, action TEXT, created_at TEXT, matched_gen_id TEXT, model TEXT)"
        )
        conn.execute("INSERT INTO worker(id,name,account_type) VALUES('w','worker','team')")
        conn.execute(
            "INSERT INTO project(id,name,workspace_scope,workspace_id,workspace_name) "
            "VALUES('p-team','P','team','ws-a','Team A')"
        )

        def generation(
            gen_id: str,
            status: str,
            created_at: str,
            scope: str,
            workspace_id: str | None,
            *,
            sort_ts: float | None = None,
            job_id: str | None = None,
            project_id: str | None = None,
            folder_path: str | None = None,
        ) -> None:
            conn.execute(
                "INSERT INTO generation("
                "id,worker_id,prompt,status,created_at,sort_ts,job_id,origin,"
                "workspace_scope,workspace_id,project_id,folder_path) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    gen_id,
                    "w",
                    gen_id,
                    status,
                    created_at,
                    sort_ts,
                    job_id,
                    "local",
                    scope,
                    workspace_id,
                    project_id,
                    folder_path,
                ),
            )

        generation(
            "g-team",
            "done",
            "2026-01-02 03:04:05",
            "team",
            "ws-a",
            project_id="p-team",
            folder_path="ep01/c001",
        )
        generation(
            "g-personal",
            "done",
            "2026-02-02T03:04:05Z",
            "personal",
            None,
            sort_ts=1.0,
            project_id="p-team",
            folder_path="ep01/c001",
        )
        generation(
            "g-unknown",
            "done",
            "2026-03-02T03:04:05.123Z",
            "unknown",
            None,
            project_id="p-team",
            folder_path="ep01/c001",
        )
        # 레거시/비정상 사본의 빈값도 분류해야 한다. 현행 CHECK만 이 fixture에서 완화한다.
        conn.execute("PRAGMA ignore_check_constraints=ON")
        generation("g-empty-scope", "done", "1700000000", "", "")
        generation("g-other-scope", "done", "not-a-time", "legacy", None)
        generation("g-empty-time", "done", "", "unknown", None)
        generation("g-ghost-linked", "pending", "2020-04-01 00:00:00", "unknown", None)
        generation("g-ghost-unlinked", "running", "2020-05-01 00:00:00", "unknown", None)
        generation(
            "g-recent",
            "pending",
            datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
            "unknown",
            None,
        )
        generation(
            "g-anchored",
            "running",
            "2020-06-01 00:00:00",
            "unknown",
            None,
            job_id="job-1",
        )
        conn.execute(
            "INSERT INTO gen_request("
            "id,account_email,gen_id,status,payload,created_at,updated_at) "
            "VALUES('r1','a@example.com','g-ghost-linked','preparing',?,"
            "'2020-04-01 00:00:00','2020-04-01 00:00:00')",
            (json.dumps({"references": [{"file_path": "/media/not-on-disk.bin"}]}),),
        )
        conn.execute(
            "INSERT INTO asset(id,generation_id,type,file_path,thumbnail_path) "
            "VALUES('a1','g-team','image','/media/aa/asset.bin','/media/aa/asset-thumb.jpg')"
        )
        conn.execute(
            "INSERT INTO asset(id,generation_id,type,file_path) VALUES(?,?,?,?)",
            ("a-remote", "g-team", "image", REMOTE_ASSET_URL),
        )
        conn.execute(
            "INSERT INTO reference(id,type,file_path) "
            "VALUES('ref1','image','/media/bb/reference.png')"
        )
        conn.execute(
            "INSERT INTO scene_backup(owner_uid,scene_id,data,data_hash) VALUES(?,?,?,?)",
            (
                "owner",
                "scene-1",
                json.dumps({"cards": [{"refs": [{"thumb": "/media/scene/only.jpg"}]}]}),
                "hash",
            ),
        )
        conn.execute(
            "INSERT INTO media_preservation(generation_id,reason,status) "
            "VALUES('g-team','manual','complete')"
        )
        credit_times = (
            "2026-01-01 00:00:00",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00.123Z",
            "1700000000",
            "bad",
            None,
            "",
        )
        conn.executemany(
            "INSERT INTO credit_txn(id,created_at) VALUES(?,?)",
            [(f"tx-{index}", value) for index, value in enumerate(credit_times)],
        )
        conn.commit()
    finally:
        conn.close()


def _create_manage_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.execute(
            "CREATE TABLE team_generation_fact("
            "id TEXT PRIMARY KEY, created_at TEXT, sort_ts REAL, folder_path TEXT)"
        )
        values = (
            "2026-01-01 00:00:00",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00.123Z",
            "1700000000",
            "bad",
            None,
            "",
        )
        conn.executemany(
            "INSERT INTO team_generation_fact(id,created_at,sort_ts) VALUES(?,?,?)",
            [(f"fact-{index}", value, None if index % 2 == 0 else float(index)) for index, value in enumerate(values)],
        )
        conn.commit()
    finally:
        conn.close()


def _create_trash_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.execute("CREATE TABLE trashed(id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
        conn.execute(
            "INSERT INTO trashed(id,payload) VALUES(?,?)",
            (
                "trash-1",
                json.dumps(
                    {
                        "generation": {"id": "trash-1"},
                        "assets": [{"file_path": "/media/trash/kept.bin"}],
                        "references": [],
                    }
                ),
            ),
        )
        conn.commit()
    finally:
        conn.close()


def test_baseline_metrics_contract_and_inputs_are_unchanged(tmp_path: Path):
    content = tmp_path / "content_hub.db"
    trash = tmp_path / "content_hub_trash.db"
    manage = tmp_path / "manage_hub.db"
    media = tmp_path / "media"
    out_dir = tmp_path / "report"
    _create_content_db(content)
    _create_trash_db(trash)
    _create_manage_db(manage)

    remote_cache = media_cache.local_rel_for(REMOTE_ASSET_URL).removeprefix("/media/")
    remote_thumb_source = media_cache.thumb_source_rel_for(REMOTE_ASSET_URL).removeprefix(
        "/media/"
    )
    unrelated_cache = media_cache.local_rel_for(UNRELATED_REMOTE_URL).removeprefix(
        "/media/"
    )
    files = {
        "aa/asset.bin": b"asset",
        "aa/asset-thumb.jpg": b"thumb",
        "bb/reference.png": b"reference",
        "scene/only.jpg": b"scene",
        "trash/kept.bin": b"trash",
        "orphan.bin": b"orphan",
        remote_cache: b"remote",
        remote_thumb_source: b"source",
        unrelated_cache: b"unrelated",
    }
    for relative, data in files.items():
        target = media / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    derived_thumb = (
        Path(".thumbs")
        / thumbs.cache_path(media / remote_cache, thumbs.THUMB_WIDTHS[0]).name
    ).as_posix()
    files[derived_thumb] = b"derived-thumb"
    files[".thumbs/orphan-thumb.jpg"] = b"orphan-thumb"
    for relative in (derived_thumb, ".thumbs/orphan-thumb.jpg"):
        target = media / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(files[relative])

    protected = [content, trash, manage, *(media / relative for relative in files)]
    before = {path: _signature(path) for path in protected}
    result = subprocess.run(
        [
            sys.executable,
            str(TOOL),
            "--db",
            str(content),
            "--trash",
            str(trash),
            "--manage",
            str(manage),
            "--media-dir",
            str(media),
            "--out-dir",
            str(out_dir),
        ],
        cwd=BACKEND,
        text=True,
        capture_output=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert "media 스캔 완료" in result.stderr
    assert {path: _signature(path) for path in protected} == before

    report = json.loads((out_dir / "baseline_metrics.json").read_text(encoding="utf-8"))
    assert (out_dir / "baseline_metrics.md").is_file()
    assert report["read_only_contract"]["sqlite_uri"] == "mode=ro&immutable=1"

    workspace = report["workspace_scope_distribution"]
    assert workspace["scope_counts"]["team"] == 1
    assert workspace["scope_counts"]["personal"] == 1
    assert workspace["scope_counts"]["empty"] == 1
    assert workspace["scope_counts"]["other"] == 1
    assert workspace["management_task_derivation_excluded"]["count"] == 2
    assert workspace["management_task_derivation_excluded"]["by_reason"] == {
        "generation_workspace_unresolved": 1,
        "personal_in_team_project": 1,
    }

    credit = report["timestamp_formats"]["credit_txn.created_at"]["formats"]
    assert {name: credit[name]["count"] for name in credit} == {
        "space_naive": 1,
        "iso_t_z": 1,
        "iso_t_milliseconds_z": 1,
        "epoch_string": 1,
        "unparseable": 1,
        "null_or_empty": 2,
    }
    team_fact = report["timestamp_formats"]["team_generation_fact.created_at"]
    assert team_fact["sort_ts"]["null_count"] == 4

    orphan = report["orphan_files"]
    assert orphan["streaming_scan"] is True
    assert orphan["categories"] == {
        "referenced": {"count": 4, "size_bytes": 24},
        "referenced_cache": {"count": 2, "size_bytes": 12},
        "thumb_derived": {"count": 1, "size_bytes": 13},
        "trash_referenced": {"count": 1, "size_bytes": 5},
        "thumb_orphan": {"count": 1, "size_bytes": 12},
        "orphan_candidate": {"count": 2, "size_bytes": 15},
    }
    candidates = json.loads((out_dir / "orphan_candidates.json").read_text(encoding="utf-8"))
    candidates_by_path = {
        item["path"]: item["size_bytes"] for item in candidates["candidates"]
    }
    assert candidates_by_path == {"orphan.bin": 6, unrelated_cache: 9}
    assert remote_cache not in candidates_by_path
    assert remote_thumb_source not in candidates_by_path

    ghosts = report["ghost_cards"]
    assert ghosts["count"] == 2
    assert ghosts["by_request_linkage"] == {"linked": 1, "unlinked": 1}
    assert ghosts["by_linked_request_status"] == {"preparing": 1}
    assert ghosts["active_request_state_definition"] == [
        "preparing",
        "pending",
        "claimed",
        "submitting",
        "running",
        "tracking",
        "verifying",
        "blocked",
        "recovery_required",
    ]


def test_all_declared_remote_url_sources_use_service_cache_mapping(tmp_path: Path):
    module = _load_tool()
    db = tmp_path / "urls.db"
    media = tmp_path / "media"
    media.mkdir()
    urls = [f"https://cdn.example.com/source-{index}.png?token={index}" for index in range(7)]
    conn = sqlite3.connect(db)
    try:
        conn.execute("CREATE TABLE asset(file_path TEXT, thumbnail_path TEXT)")
        conn.execute("CREATE TABLE reference(file_path TEXT, thumbnail_path TEXT)")
        conn.execute("CREATE TABLE gen_request(payload TEXT)")
        conn.execute("CREATE TABLE scene_backup(data TEXT)")
        conn.execute("CREATE TABLE trashed(payload TEXT)")
        conn.execute("INSERT INTO asset VALUES(?,?)", urls[0:2])
        conn.execute("INSERT INTO reference VALUES(?,?)", urls[2:4])
        conn.execute(
            "INSERT INTO gen_request VALUES(?)",
            (json.dumps({"references": [{"file_path": urls[4]}]}),),
        )
        conn.execute(
            "INSERT INTO scene_backup VALUES(?)",
            (json.dumps({"cards": [{"thumbnail_path": urls[5]}]}),),
        )
        conn.execute(
            "INSERT INTO trashed VALUES(?)",
            (json.dumps({"assets": [{"file_path": urls[6]}]}),),
        )
        conn.commit()

        direct, cached, external_sources, inventory, warnings = (
            module.collect_media_references(conn, media, database_label="synthetic")
        )
    finally:
        conn.close()

    expected = {
        module._media_key(rel, media)
        for url in urls
        for rel in (
            media_cache.local_rel_for(url),
            media_cache.thumb_source_rel_for(url),
        )
    }
    assert direct == set()
    assert cached == expected
    assert external_sources == set()
    assert sum(item["remote_url_values"] for item in inventory) == len(urls)
    assert warnings == []


def test_readonly_connection_and_edge_classifiers(tmp_path: Path):
    module = _load_tool()
    db = tmp_path / "copy.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE item(id INTEGER)")
    conn.execute(
        "CREATE TABLE generation(workspace_scope TEXT, workspace_id TEXT, created_at TEXT)"
    )
    conn.executemany(
        "INSERT INTO generation(workspace_scope,workspace_id,created_at) VALUES(?,?,?)",
        [
            (None, None, "2026-01-01 00:00:00"),
            ("", "", "2026-01-02 00:00:00"),
        ],
    )
    conn.commit()
    conn.close()
    before = _signature(db)

    readonly = module.open_readonly(db)
    try:
        distribution = module.measure_workspace_distribution(readonly)
        assert distribution["scope_counts"] == {"NULL": 1, "empty": 1}
        with pytest.raises(sqlite3.OperationalError):
            readonly.execute("INSERT INTO item(id) VALUES(1)")
    finally:
        readonly.close()
    assert _signature(db) == before
    assert module.classify_workspace_scope(None) == "NULL"
    assert module.classify_workspace_scope("  ") == "empty"
    assert module.classify_timestamp(None)[0] == "null_or_empty"
    assert module.classify_timestamp("2026-02-30 00:00:00")[0] == "unparseable"
