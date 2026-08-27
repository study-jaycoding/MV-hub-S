"""R11 백엔드 배치 1 계약 회귀 — 롱폴 사유 강등·로그인 실패 저장소 상한·무검증 입력 방어·
레거시 백업 비밀검증·업로드 DB 읽기전용 검증·백업 업로드 알림 제외·fps 앵커."""

from __future__ import annotations

import asyncio
import sqlite3
import time
import types
from pathlib import Path
from unittest import mock

import pytest

from app import mutation_notify
from app.routers import auth, db_transfer
from app.services import mcp_ingest, video_convert
from app.services.agent_signals import AgentSignals
from app.services.sqlite_db import validate_hub_db


# ── A3: 같은 계정 waiter 2개 ───────────────────────────────────────────────────


def test_second_waiter_of_same_account_gets_none_instead_of_fake_event_reason() -> None:
    async def scenario() -> list[str | None]:
        signals = AgentSignals()
        loop = asyncio.get_running_loop()
        signals.bind_loop(loop)
        try:
            first = asyncio.create_task(signals.wait("artist@example.com", timeout=2.0))
            second = asyncio.create_task(signals.wait("artist@example.com", timeout=2.0))
            await asyncio.sleep(0.05)  # 둘 다 대기 진입
            signals.signal("Artist@Example.com", "sync")
            return list(await asyncio.gather(first, second))
        finally:
            signals.unbind_loop(loop)

    results = asyncio.run(scenario())
    assert "event" not in results  # 사유를 못 받은 쪽에 가짜 사유를 주지 않는다
    assert sorted(results, key=lambda value: value or "") == [None, "sync"]


def test_single_waiter_still_receives_the_real_reason() -> None:
    async def scenario() -> str | None:
        signals = AgentSignals()
        loop = asyncio.get_running_loop()
        signals.bind_loop(loop)
        try:
            signals.signal("artist@example.com", "gen-request")
            return await signals.wait("artist@example.com", timeout=1.0)
        finally:
            signals.unbind_loop(loop)

    assert asyncio.run(scenario()) == "gen-request"


# ── A9: 로그인 실패 기록 저장소 상한 ───────────────────────────────────────────


@pytest.fixture()
def clean_rate_limit_state():
    auth._rl_fails.clear()
    auth._rl_inflight.clear()
    yield
    auth._rl_fails.clear()
    auth._rl_inflight.clear()


def test_login_failure_store_stays_bounded_for_rotating_keys(
    clean_rate_limit_state, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(auth, "_RL_FAILS_MAX_KEYS", 16)

    for index in range(400):
        auth._rl_fail(f"10.0.0.{index}|user{index}@example.com")

    assert len(auth._rl_fails) <= 16
    # 최근 키는 남아 있어야 창 판정(_rl_reserve)이 계속 동작한다.
    assert "10.0.0.399|user399@example.com" in auth._rl_fails
    assert auth._rl_inflight == {}  # in-flight 예약 의미는 건드리지 않는다


def test_expired_failure_keys_are_swept_before_dropping_fresh_ones(
    clean_rate_limit_state, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(auth, "_RL_FAILS_MAX_KEYS", 4)
    expired = time.monotonic() - auth._RL_WINDOW - 1.0
    for index in range(4):
        auth._rl_fails[f"1.2.3.4|stale{index}@example.com"] = [expired]

    auth._rl_fail("5.6.7.8|fresh@example.com")

    assert list(auth._rl_fails) == ["5.6.7.8|fresh@example.com"]


def test_failure_counting_within_the_window_is_unchanged(clean_rate_limit_state) -> None:
    key = "9.9.9.9|victim@example.com"
    for _ in range(auth._RL_MAX - 1):
        auth._rl_fail(key)
    auth._rl_reserve(key)  # 아직 창 안 — 통과하고 예약 1
    auth._rl_release(key)
    auth._rl_fail(key)
    with pytest.raises(auth.HTTPException) as caught:
        auth._rl_reserve(key)
    assert caught.value.status_code == 429


# ── B1: 레거시 서버 백업의 비밀값 제거 검증 ────────────────────────────────────


def _make_hub_db(path: Path, *, secret: bool) -> None:
    conn = sqlite3.connect(str(path))
    try:
        conn.execute("CREATE TABLE generation(id TEXT)")
        conn.execute("CREATE TABLE app_setting(key TEXT PRIMARY KEY, value TEXT)")
        if secret:
            conn.execute("INSERT INTO app_setting VALUES('auth_secret','leaked')")
        conn.commit()
    finally:
        conn.close()


def test_legacy_server_backup_aborts_when_secrets_survive_the_scrub(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "content_hub_20260823.db"
    _make_hub_db(source, secret=True)
    # 구형 DB 처럼 정제가 조용히 실패한 상황을 재현한다.
    monkeypatch.setattr(db_transfer, "_strip_session", lambda _path: None)
    monkeypatch.setattr(db_transfer.tempfile, "gettempdir", lambda: str(tmp_path))

    def refuse_upload(*_args, **_kwargs):
        raise AssertionError("미정제 DB 가 업로드되면 안 된다")

    monkeypatch.setattr(db_transfer, "_multipart_upload", refuse_upload)

    with pytest.raises(sqlite3.DatabaseError):
        db_transfer._legacy_server_backup(source)
    assert list(tmp_path.glob("mvhub-srvbak-*.db")) == []


def test_legacy_server_backup_uploads_when_scrub_actually_removed_secrets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "content_hub_20260823.db"
    _make_hub_db(source, secret=True)
    monkeypatch.setattr(db_transfer.tempfile, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(db_transfer._proxy, "base_url", lambda: "http://server")
    monkeypatch.setattr(db_transfer._proxy, "token", lambda: "tok")
    monkeypatch.setattr(
        db_transfer, "_multipart_upload", lambda *_args, **_kwargs: (200, {"count": 3})
    )

    assert db_transfer._legacy_server_backup(source) == (200, {"count": 3})


# ── B2: 업로드 DB 검증은 읽기 전용 ─────────────────────────────────────────────


def _make_wal_hub_db(path: Path) -> None:
    conn = sqlite3.connect(str(path))
    try:
        conn.execute("PRAGMA journal_mode=WAL")  # 허브 DB 는 WAL 이 헤더에 영속된다
        conn.execute("CREATE TABLE generation(id TEXT)")
        conn.execute("INSERT INTO generation VALUES('g1')")
        conn.commit()
    finally:
        conn.close()


def test_validate_hub_db_leaves_no_sidecar_droppings(tmp_path: Path) -> None:
    path = tmp_path / "uploaded.db"
    _make_wal_hub_db(path)
    before = path.read_bytes()

    validate_hub_db(path, require_integrity=True)

    assert sorted(child.name for child in tmp_path.iterdir()) == ["uploaded.db"]
    assert path.read_bytes() == before


def test_validate_hub_db_does_not_touch_the_uploaded_wal_sidecar(tmp_path: Path) -> None:
    # read-write 로 열면 SQLite 가 남의 업로드 파일에 체크포인트를 돌리고 -wal 을 지운다.
    path = tmp_path / "uploaded.db"
    _make_wal_hub_db(path)
    wal = Path(str(path) + "-wal")
    wal.write_bytes(b"")

    validate_hub_db(path, require_integrity=True)

    assert wal.exists()


def test_validate_hub_db_still_rejects_non_hub_databases(tmp_path: Path) -> None:
    path = tmp_path / "other.db"
    conn = sqlite3.connect(str(path))
    try:
        conn.execute("CREATE TABLE unrelated(id TEXT)")
        conn.commit()
    finally:
        conn.close()

    with pytest.raises(Exception) as caught:
        validate_hub_db(path, require_integrity=True)
    assert getattr(caught.value, "reason", None) == "missing_generation"


# ── B3: 무검증 MCP 입력 ────────────────────────────────────────────────────────


def test_malformed_mcp_params_and_results_are_skipped_not_raised() -> None:
    row = mcp_ingest.mcp_item_to_cli(
        {
            "id": "job-1",
            "status": "completed",
            "model": "seedance",
            "params": ["prompt", "not-a-dict"],
            "results": ["https://cdn.example/raw.mp4"],
            "createdAt": "2026-08-23T00:00:00Z",
        }
    )

    assert row["id"] == "job-1"
    assert row["params"] == {}
    assert row["result_url"] is None
    assert row["thumbnail_url"] is None


def test_wellformed_mcp_item_still_maps_normally() -> None:
    row = mcp_ingest.mcp_item_to_cli(
        {
            "id": "job-2",
            "status": "completed",
            "model": "seedance",
            "params": {"prompt": "hello"},
            "results": [{"rawUrl": "https://cdn.example/raw.mp4", "minUrl": "https://cdn/min.jpg"}],
            "createdAt": "2026-08-23T00:00:00Z",
        }
    )

    assert row["params"] == {"prompt": "hello"}
    assert row["result_url"] == "https://cdn.example/raw.mp4"
    assert row["min_result_url"] == "https://cdn/min.jpg"


# ── B4: 백업 업로드는 라이브러리 알림 대상이 아님 ──────────────────────────────


def test_worker_backup_upload_does_not_broadcast_synced() -> None:
    for path in ("/api/db-backup", "/api/db-backup/sets", "/api/db-backup/sets/abc/activate"):
        assert mutation_notify.DOMAIN_LIBRARY not in mutation_notify.notification_domains("POST", path, 200)
        assert mutation_notify.notification_domains("POST", path, 200) == ()
    # 기존 제외 항목(main 의 수동 백업)과 정상 변경 경로는 그대로.
    assert mutation_notify.DOMAIN_LIBRARY not in mutation_notify.notification_domains("POST", "/api/backup", 200)
    assert mutation_notify.DOMAIN_LIBRARY in mutation_notify.notification_domains("POST", "/api/gen-requests", 201)


# ── B5: fps 는 비디오 스트림 줄에서만 읽는다 ───────────────────────────────────

# 이 PC 의 실제 `ffmpeg -hide_banner -i sample.mp4` stderr(24fps 영상 + 오인용 comment).
_FFMPEG_METADATA_TRAP = (
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'in':\n"
    "  Metadata:\n"
    "    major_brand     : isom\n"
    "    minor_version   : 512\n"
    "    compatible_brands: isomiso2avc1mp41\n"
    "    encoder         : Lavf58.29.100\n"
    "    comment         : captured at 60 fps handheld\n"
    "  Duration: 00:00:01.00, start: 0.000000, bitrate: 66 kb/s\n"
    "    Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 320x240 "
    "[SAR 1:1 DAR 4:3], 56 kb/s, 24 fps, 24 tbr, 12288 tbn, 48 tbc (default)\n"
    "    Metadata:\n"
    "      handler_name    : VideoHandler\n"
)

# 최신 ffmpeg(6/7) 의 스트림 줄 형식 + 오디오 스트림 동반.
_FFMPEG_MODERN = (
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'in':\n"
    "  Duration: 00:00:05.00, start: 0.000000, bitrate: 1234 kb/s\n"
    "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709), "
    "1920x1080 [SAR 1:1 DAR 16:9], 1200 kb/s, 30 fps, 30 tbr, 15360 tbn (default)\n"
    "  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp\n"
)

# fps 표기 없이 tbr 만 있는 케이스(기존 폴백이 계속 살아 있어야 한다).
_FFMPEG_TBR_ONLY = (
    "Input #0, matroska,webm, from 'in':\n"
    "  Stream #0:0: Video: vp9 (Profile 0), yuv420p(tv, bt709), 1280x720, "
    "SAR 1:1 DAR 16:9, 25 tbr, 1k tbn (default)\n"
)

_FFMPEG_AUDIO_ONLY = (
    "Input #0, mp3, from 'in':\n"
    "  Metadata:\n"
    "    comment         : recorded at 60 fps\n"
    "  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s\n"
)


def _probe_with(stderr: str) -> float | None:
    def fake_run(_cmd, **_kwargs):
        return types.SimpleNamespace(returncode=0, stderr=stderr.encode("utf-8"))

    with mock.patch.object(video_convert.subprocess, "run", fake_run):
        return video_convert._probe_fps("ffmpeg", Path("in.mp4"))


def test_container_metadata_fps_text_is_not_mistaken_for_frame_rate() -> None:
    assert _probe_with(_FFMPEG_METADATA_TRAP) == 24.0


def test_normal_stream_lines_are_still_detected() -> None:
    assert _probe_with(_FFMPEG_MODERN) == 30.0
    assert _probe_with(_FFMPEG_TBR_ONLY) == 25.0


def test_without_a_video_stream_the_probe_reports_nothing() -> None:
    assert _probe_with(_FFMPEG_AUDIO_ONLY) is None
