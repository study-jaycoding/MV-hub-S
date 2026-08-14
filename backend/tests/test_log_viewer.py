from __future__ import annotations

import importlib.util
from pathlib import Path


def _module():
    path = Path(__file__).resolve().parents[2] / "tools" / "log_viewer.py"
    spec = importlib.util.spec_from_file_location("log_viewer", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def test_generation_event_is_compact_and_traceable():
    viewer = _module()
    line = viewer.format_event(
        {
            "ts": "2026-08-13T12:00:00+00:00",
            "level": "INFO",
            "event": "generation_finalized",
            "generation_id": "gen-1",
            "request_id": "req-1",
            "job_id": "job-1",
            "status": "done",
        }
    )
    assert "생성 최종 확정" in line
    assert "gen-1" in line and "req-1" in line and "job-1" in line


def test_runtime_snapshot_is_one_clean_summary_line():
    viewer = _module()
    line = viewer.format_event(
        {
            "ts": "2026-08-13T12:00:00+00:00",
            "level": "INFO",
            "event": "runtime_snapshot",
            "snapshot": {
                "requests": {"total": 30, "status": {"5xx": 1}},
                "agents": {"connected_accounts": 2},
                "websocket": {"authenticated_accounts": 3},
                "operations": {
                    "generation_queue": {"active_total": 3},
                    "backups": {"set_count": 7},
                },
            },
        }
    )
    assert line == (
        "[2026-08-13 12:00:00] 상태 | 요청 30 (5xx 1) | 활성 생성 3"
        " | 접속 계정 3 | 관리전송 대기 0 (실패 0) | 백업 7세트"
    )


def test_shared_server_snapshot_hides_non_applicable_local_outbox():
    viewer = _module()
    line = viewer.format_event(
        {
            "ts": "2026-08-13T12:00:00+00:00",
            "event": "runtime_snapshot",
            "snapshot": {
                "requests": {"total": 1, "status": {"5xx": 0}},
                "websocket": {"authenticated_accounts": 4},
                "operations": {
                    "generation_queue": {"active_total": 0},
                    "telemetry": {"pending": 258, "failed": 0, "applicable": False},
                    "backups": {"set_count": 7},
                },
            },
        }
    )
    assert "접속 계정 4" in line
    assert "258" not in line and "관리전송" not in line


def test_shared_server_snapshot_hides_non_applicable_local_generation_queue():
    viewer = _module()
    line = viewer.format_event(
        {
            "event": "runtime_snapshot",
            "snapshot": {
                "operations": {
                    "generation_queue": {"active_total": 0, "applicable": False},
                    "telemetry": {"applicable": False},
                }
            },
        }
    )
    assert "활성 생성" not in line


def test_worker_telemetry_event_is_visible_without_identity():
    viewer = _module()
    line = viewer.format_event(
        {
            "ts": "2026-08-13T12:00:00+00:00",
            "event": "worker_telemetry_received",
            "worker_name": "Paul",
            "received_items": 3,
            "upserted_items": 3,
            "completed_items": 2,
            "failed_items": 1,
        }
    )
    assert "생성 정보" in line
    assert "작업자=Paul" in line
    assert "수신=3" in line and "완료=2" in line and "실패=1" in line


def test_unimportant_info_event_is_hidden_but_warning_is_shown():
    viewer = _module()
    assert viewer.format_event({"level": "INFO", "event": "library_cache_hit"}) is None
    assert "unexpected" in viewer.format_event(
        {"level": "WARNING", "event": "unexpected"}
    )


def test_backup_completion_is_visible_with_set_summary():
    viewer = _module()
    line = viewer.format_event(
        {
            "ts": "2026-08-13T12:00:00+00:00",
            "level": "INFO",
            "event": "backup_completed",
            "backup_set_files": 3,
            "backup_set_bytes": 2048,
        }
    )
    assert "백업 완료" in line
    assert "백업파일수=3" in line
    assert "백업크기byte=2048" in line


def test_recent_update_history_is_trimmed_and_bounded(tmp_path):
    viewer = _module()
    update_log = tmp_path / "update.log"
    update_log.write_text(
        "\n".join(
            [
                "[2026-08-14 09:00:00] START update requested",
                "[2026-08-14 09:00:03] SUCCESS before=abc after=def server=restarted-ready",
                "",
            ]
        ),
        encoding="utf-8",
    )

    assert viewer.recent_update_lines(update_log, count=1) == [
        "[2026-08-14 09:00:03] SUCCESS before=abc after=def server=restarted-ready"
    ]


def test_follower_releases_file_and_follows_rotation(tmp_path):
    viewer = _module()
    runtime_log = tmp_path / "mvhub-runtime.jsonl"
    runtime_log.write_text('{"event":"startup_ready"}\n', encoding="utf-8")
    _, position, identity = viewer._tail_snapshot(runtime_log, 10)
    follower = viewer.LogFollower(runtime_log, position, identity)

    with runtime_log.open("a", encoding="utf-8") as handle:
        handle.write('{"event":"runtime_snapshot"}\n')
    assert follower.poll() == ['{"event":"runtime_snapshot"}']

    rotated = tmp_path / "mvhub-runtime.jsonl.1"
    runtime_log.replace(rotated)
    runtime_log.write_text('{"event":"startup_begin"}\n', encoding="utf-8")
    assert follower.poll() == ['{"event":"startup_begin"}']
