"""저장 통합 1-A — 백업 보관 규칙·곁파일·삭제 안전·정책 API 시험.

계약: docs/status/저장통합_1A_백업보관_2026-11-12.md (criteria retention·safety·listing·policy·runtime·manual_hold).
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db, repo
from app.services import backup

# 2026-11-12(목) 12:00 한국 시간
NOW = datetime(2026, 11, 12, 3, 0, tzinfo=timezone.utc).timestamp()
POLICY_888 = {"recent": 8, "daily_days": 14, "weekly_weeks": 8, "quiet_minutes": 5, "min_interval_minutes": 15}


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()


def _stamp(ts: float, n: int = 0) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y%m%d_%H%M%S_") + f"{n:06d}"


def make_set(d: Path, ts: float, seq: int | None, *, n: int = 0, reason: str = "auto", manifest: bool = True,
             member_size_ok: bool = True, deleting: bool = False, protected: bool = False,
             keep_raw: str | None = None) -> Path:
    d.mkdir(parents=True, exist_ok=True)
    stamp = _stamp(ts, n)
    content = d / f"content_hub_{stamp}.db"
    content.write_bytes(b"c" * 10)
    (d / f"content_trash_{stamp}.db").write_bytes(b"t" * 5)
    os.utime(content, (ts, ts))
    if manifest:
        roles = {"content": {"size": 10}, "trash": {"size": 5 if member_size_ok else 99}}
        content.with_suffix(".manifest.json").write_text(
            json.dumps({"roles": roles, "captured_at": _iso(ts), "set_id": "a" * 64}), "utf-8")
    if keep_raw is not None:
        content.with_suffix(".keep.json").write_text(keep_raw, "utf-8")
    elif seq is not None:
        record = backup._keep_record(seq, _iso(ts), reason, None, manifest=manifest)
        record.update(deleting=deleting, protected=protected)
        content.with_suffix(".keep.json").write_text(json.dumps(record), "utf-8")
    return content


def mark_registered(d: Path, last_seq: int = 0) -> None:
    backup._write_registry(d, state="done", last_seq=last_seq)


def stamps(d: Path) -> list[str]:
    return sorted(p.name[len("content_hub_"):-3] for p in d.glob("content_hub_*.db"))


# ── retention ────────────────────────────────────────────────────────────────
def test_keeps_recent_daily_weekly_and_deletes_the_rest(tmp_path):
    d = tmp_path / "b"
    day = 86400.0
    sets = []
    # 60일 동안 하루 3세트(아침·점심·저녁) — 번호는 시간순
    seq = 0
    for i in range(60, 0, -1):
        for hour in (0, 4, 8):
            seq += 1
            sets.append(make_set(d, NOW - i * day + hour * 3600, seq, n=hour))
    mark_registered(d, seq)
    plan = backup._retention_plan(d, POLICY_888, NOW)
    kept = {s.stamp for s in plan.keep}
    assert plan.blocked is None
    by_new = sorted(sets, key=lambda p: p.name, reverse=True)
    for p in by_new[:8]:
        assert p.name[12:-3] in kept  # 최근 8
    # 날마다: 최근 14개 한국 날짜마다 그날 가장 늦은 세트
    for i in range(1, 14):
        local_day = (datetime.fromtimestamp(NOW, backup.KEEP_TZ).date() - timedelta(days=i))
        that_day = [p for p in sets if datetime.fromtimestamp(p.stat().st_mtime, backup.KEEP_TZ).date() == local_day]
        if that_day:
            assert max(that_day, key=lambda p: p.name).name[12:-3] in kept
    # 지울 것 = 후보 - 남길 것, 그리고 60일 전 세트는 지움(주마다 8주 밖)
    oldest = min(sets, key=lambda p: p.name).name[12:-3]
    assert oldest in {s.stamp for s in plan.delete}
    assert len(plan.keep) + len(plan.delete) == len(sets)
    # 8주 안에서는 주마다 하나 이상 남음
    weeks = {(datetime.fromtimestamp(NOW, backup.KEEP_TZ).date() - timedelta(weeks=w)) for w in range(8)}
    kept_weeks = set()
    for s in plan.keep:
        local = backup._captured_at(s).astimezone(backup.KEEP_TZ).date()
        kept_weeks.add(local - timedelta(days=local.weekday()))
    this_week = datetime.fromtimestamp(NOW, backup.KEEP_TZ).date()
    this_week -= timedelta(days=this_week.weekday())
    for w in range(8):
        assert this_week - timedelta(weeks=w) in kept_weeks
    assert weeks  # (주 계산 사용)


def test_newest_always_kept_and_backup_keep_one_deletes_older(tmp_path):
    d = tmp_path / "b"
    old = make_set(d, NOW - 3600, 1)
    new = make_set(d, NOW - 60, 2)
    mark_registered(d, 2)
    with mock.patch.object(backup, "BACKUP_KEEP", 1):
        backup._rotate(d, now=NOW)
    assert not old.exists() and new.exists()


def test_never_deletes_unregistered_incomplete_invalid_duplicate_protected_or_held(tmp_path):
    d = tmp_path / "b"
    far = NOW - 400 * 86400
    unregistered = make_set(d, far, None, n=1)
    incomplete = make_set(d, far, 2, n=2, member_size_ok=False)
    invalid = make_set(d, far, None, n=3, keep_raw="{broken")
    dup_a = make_set(d, far, 4, n=4)
    dup_b = make_set(d, far, 4, n=5)
    protected = make_set(d, far, 6, n=6, protected=True)
    held = make_set(d, far, 7, n=7)
    plain_old = make_set(d, far, 8, n=8)
    newest = make_set(d, NOW - 10, 9)
    mark_registered(d, 9)
    with backup.hold_set(held):
        summary = backup._rotate(d, policy={**POLICY_888, "recent": 1, "daily_days": 7, "weekly_weeks": 4}, now=NOW)
    for kept in (unregistered, incomplete, invalid, dup_a, dup_b, protected, held, newest):
        assert kept.exists(), kept.name
    assert not plain_old.exists()
    assert summary["blocked"] is None and summary["deleted"] == 1


def test_inverted_pair_front_is_never_deleted(tmp_path):
    d = tmp_path / "b"
    # 번호 2 가 번호 1 보다 하루 먼저 찍힘(시계가 뒤로 갔던 기록) — 앞쪽(번호 1)은 지우지 않는다.
    a = make_set(d, NOW - 2 * 86400, 1)
    make_set(d, NOW - 3 * 86400, 2, n=1)
    mark_registered(d, 2)
    plan = backup._retention_plan(d, {**POLICY_888, "recent": 1, "daily_days": 7}, NOW)
    assert plan.blocked is None and plan.delete == []
    assert a.exists()


def test_clock_reset_to_2000_does_not_mass_delete_day_and_week_representatives(tmp_path):
    """메인보드 시계가 2000년으로 돌아가 세트 3개를 찍고 바로잡힌 뒤 — 날·주 대표가 그대로 남는다(Claude 2차 P1)."""
    d = tmp_path / "b"
    seq = 0
    real = []
    for i in range(30, 0, -1):  # 30일 동안 하루 한 세트
        seq += 1
        real.append(make_set(d, NOW - i * 86400, seq, n=seq))
    y2000 = datetime(2000, 1, 1, tzinfo=timezone.utc).timestamp()
    for k in range(3):
        seq += 1
        make_set(d, y2000 + k * 600, seq, n=seq)
    seq += 1
    make_set(d, NOW - 60, seq, n=seq)  # 시계를 바로잡은 뒤
    mark_registered(d, seq)
    policy = {**POLICY_888, "recent": 4, "daily_days": 14, "weekly_weeks": 8}
    plan = backup._retention_plan(d, policy, NOW)
    assert plan.blocked is None
    assert plan.delete == []  # 거꾸로 된 쌍의 앞쪽(진짜 날짜 세트 30개)은 지우지 않는다
    # 세트가 4개 더 쌓여 2000년 세트가 최근 4 밖으로 밀리면 그것들이 지워지고, 날·주 대표는 남는다
    for k in range(4):
        seq += 1
        make_set(d, NOW - 50 + k, seq, n=seq)
    plan = backup._retention_plan(d, policy, NOW)
    deleted = {s.stamp for s in plan.delete}
    assert all(s.stamp in deleted for s in backup._scan_sets(d) if backup._captured_at(s).year == 2000)
    assert not any(p.name[12:-3] in deleted for p in real)  # 아직 쌍의 앞쪽이라 진짜 세트는 안 지움
    backup._rotate(d, policy=policy, now=NOW)  # 2000년 세트가 지워져 쌍이 사라짐 → 보통 보관으로
    plan = backup._retention_plan(d, policy, NOW)
    kept = {s.stamp for s in plan.keep}
    for i in range(1, 14):
        assert real[30 - i].name[12:-3] in kept  # 최근 13일 날짜마다 한 세트
    assert plan.delete  # 14일 밖·주 대표 아닌 진짜 세트만 이제 솎인다
    assert all(backup._captured_at(s) < datetime.fromtimestamp(NOW - 13 * 86400, timezone.utc) for s in plan.delete)


def test_clock_one_year_ahead_unblocks_after_next_backup_and_keeps_that_set(tmp_path):
    d = tmp_path / "b"
    old = make_set(d, NOW - 400 * 86400, 1)
    ahead = make_set(d, NOW + 365 * 86400, 2, n=1)
    mark_registered(d, 2)
    small = {**POLICY_888, "recent": 1, "daily_days": 7, "weekly_weeks": 4}
    assert backup._retention_plan(d, small, NOW).blocked == "clock_skew"
    make_set(d, NOW - 10, 3, n=2)  # 바로잡힌 시계로 다음 백업
    mark_registered(d, 3)
    summary = backup._rotate(d, policy=small, now=NOW)
    assert summary["blocked"] is None
    assert not old.exists()  # 회전이 다시 돈다
    assert ahead.exists()  # 미래 날짜 세트는 거꾸로 된 쌍의 앞쪽이라 남는다


# ── safety ───────────────────────────────────────────────────────────────────
def test_delete_order_marks_then_content_first_and_resumes_after_failure(tmp_path):
    d = tmp_path / "b"
    victim = make_set(d, NOW - 400 * 86400, 1)
    other = make_set(d, NOW - 399 * 86400, 2, n=1)  # 하나를 못 지워도 이것은 지워진다
    make_set(d, NOW - 10, 3, n=2)
    mark_registered(d, 3)
    stamp = victim.name[12:-3]
    trash = d / f"content_trash_{stamp}.db"
    real_unlink = Path.unlink
    order: list[str] = []

    def failing_unlink(self, *args, **kwargs):
        order.append(self.name)
        if self == trash:
            raise PermissionError("locked")
        return real_unlink(self, *args, **kwargs)

    with mock.patch.object(Path, "unlink", failing_unlink):
        summary = backup._rotate(d, policy={**POLICY_888, "recent": 1, "daily_days": 7, "weekly_weeks": 4}, now=NOW)
    assert order[0] == victim.name  # 콘텐츠 대표 파일을 먼저 내린다
    assert summary["failed"] == 1 and summary["deleted"] == 1 and not other.exists()
    assert backup.retention_status(d, now=NOW)["delete_failed"] == 1
    keep = json.loads(victim.with_suffix(".keep.json").read_text("utf-8"))
    assert keep["deleting"] is True and trash.exists() and not victim.exists()
    assert all(item["file"] != victim.name for item in backup.list_backups_info(d))
    backup._rotate(d, now=NOW)  # 다음 회전이 대표 DB 없이도 이어 지운다
    assert not trash.exists() and not victim.with_suffix(".keep.json").exists()
    assert not victim.with_suffix(".manifest.json").exists()


def test_clock_skew_blocks_until_clock_catches_up(tmp_path):
    d = tmp_path / "b"
    old = make_set(d, NOW - 400 * 86400, 1)
    make_set(d, NOW + 3600, 2)  # 시계가 1시간 뒤로 간 지금보다 앞선 기록
    mark_registered(d, 2)
    small = {**POLICY_888, "recent": 1, "daily_days": 7, "weekly_weeks": 4}
    assert backup._rotate(d, policy=small, now=NOW)["blocked"] == "clock_skew"
    assert old.exists()
    assert backup._rotate(d, policy=small, now=NOW + 3700)["blocked"] is None
    assert not old.exists()


def test_invalid_policy_file_blocks_deletion_until_saved_again(tmp_path):
    d = tmp_path / "b"
    old = make_set(d, NOW - 400 * 86400, 1)
    make_set(d, NOW - 10, 2)
    mark_registered(d, 2)
    (d / "backup_policy.json").write_text('{"format":"mvhub-backup-policy","policy_version":1,"recent":99}', "utf-8")
    policy, version, source = backup.read_policy(d)
    assert source == "invalid" and version == 0 and policy == backup.default_policy()
    assert backup._rotate(d, now=NOW)["blocked"] == "policy_invalid"
    assert old.exists()


def test_saved_policy_file_disappearing_blocks_deletion(tmp_path):
    d = tmp_path / "b"
    old = make_set(d, NOW - 400 * 86400, 1)
    make_set(d, NOW - 10, 2, n=1)
    mark_registered(d, 2)
    backup._write_policy(d, POLICY_888, 3)
    (d / "backup_policy.json").unlink()  # NAS 순단·실수로 파일만 사라짐
    policy, version, source = backup.read_policy(d)
    assert source == "invalid" and version == 3
    assert backup._rotate(d, now=NOW)["blocked"] == "policy_invalid"
    assert old.exists()


def test_registration_pending_resumes_and_done_never_reregisters(tmp_path):
    d = tmp_path / "b"
    a = make_set(d, NOW - 300, None, n=1)
    b = make_set(d, NOW - 200, None, n=2)
    calls = {"n": 0}
    real_write = backup._write_keep

    def flaky(content, data):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError("disk hiccup")
        real_write(content, data)

    with mock.patch.object(backup, "_write_keep", flaky), pytest.raises(OSError):
        backup._ensure_registered(d)
    assert json.loads((d / "backup_keep_registry.json").read_text("utf-8"))["state"] == "pending"
    backup._ensure_registered(d)  # 남은 것만 이어 등록(번호는 비어도 겹치지 않고 커진다)
    seq_a, seq_b = (json.loads(p.with_suffix(".keep.json").read_text("utf-8"))["seq"] for p in (a, b))
    assert seq_a == 1 and seq_b > seq_a
    assert json.loads(a.with_suffix(".keep.json").read_text("utf-8"))["reason"] == "legacy"
    # done 뒤 곁파일이 사라진 세트는 다시 등록하지 않고 지우지도 않는다
    b.with_suffix(".keep.json").unlink()
    backup._ensure_registered(d)
    assert not b.with_suffix(".keep.json").exists()
    with mock.patch.object(backup, "BACKUP_KEEP", 1):
        backup._rotate(d, policy={**POLICY_888, "recent": 4, "daily_days": 7, "weekly_weeks": 4}, now=NOW + 400 * 86400)
    assert b.exists()


def test_missing_registry_with_sidecars_is_done_and_corrupt_registry_skips(tmp_path):
    d = tmp_path / "b"
    make_set(d, NOW - 300, 1, n=1)
    lost = make_set(d, NOW - 200, None, n=2)
    backup._ensure_registered(d)
    assert not lost.with_suffix(".keep.json").exists()
    assert json.loads((d / "backup_keep_registry.json").read_text("utf-8"))["state"] == "done"
    e = tmp_path / "c"
    legacy = make_set(e, NOW - 300, None)
    (e / "backup_keep_registry.json").write_text("{corrupt", "utf-8")
    backup._ensure_registered(e)
    assert not legacy.with_suffix(".keep.json").exists()


def test_next_seq_survives_broken_highest_sidecar(tmp_path):
    d = tmp_path / "b"
    make_set(d, NOW - 300, 1, n=1)
    top = make_set(d, NOW - 200, 2, n=2)
    mark_registered(d, 2)
    top.with_suffix(".keep.json").write_text("{broken", "utf-8")
    assert backup._next_seq(d) == 3


@pytest.fixture()
def live_db(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "source.db"))
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    folder = tmp_path / "backups"
    monkeypatch.setattr(backup, "_backup_dir", lambda: folder)
    monkeypatch.setattr(backup, "MANAGE_DB_PATH", tmp_path / "missing-manage.db")
    yield folder
    db.flush_pool()


def test_new_set_writes_sidecar_before_publish_and_failure_publishes_nothing(live_db):
    first = backup.backup_now()
    keep = json.loads(first.with_suffix(".keep.json").read_text("utf-8"))
    assert keep["seq"] == 1 and keep["reason"] == "auto" and keep["set_id"]
    with mock.patch.object(backup, "_write_keep", side_effect=OSError("no space")), pytest.raises(OSError):
        backup.backup_now()
    assert stamps(live_db) == [first.name[12:-3]]
    assert list(live_db.glob(".content_hub_*")) == []
    assert backup._LAST_ERROR[str(live_db)]["code"] == "OSError"


def test_disk_full_fails_before_writing_and_keeps_sets(live_db):
    first = backup.backup_now()
    usage = mock.Mock(free=1024)
    with mock.patch.object(backup.shutil, "disk_usage", return_value=usage), pytest.raises(backup.BackupDiskFull):
        backup.backup_now()
    assert stamps(live_db) == [first.name[12:-3]]
    assert list(live_db.glob(".content_hub_*")) == []
    assert backup.retention_status(live_db)["last_error"]["code"] == "disk_full"
    backup.backup_now()  # 회복되면 다시 찍고 마지막 실패를 지운다
    assert backup.retention_status(live_db)["last_error"] is None


def test_half_sets_without_content_are_never_auto_cleaned_and_are_counted(tmp_path):
    d = tmp_path / "b"
    lost = make_set(d, NOW - 3 * 86400, 1)
    lost.unlink()  # 공개 전 잔재인지, 공개 뒤 대표 파일만 잃었는지 가를 수 없다 — 남긴다(Codex 3차 P1)
    make_set(d, NOW - 10, 2, n=1)
    mark_registered(d, 2)
    old = time.time() - 2 * 86400
    for path in d.iterdir():
        os.utime(path, (old, old))
    backup._cleanup_stale_tmp(d)
    backup._rotate(d, policy={**POLICY_888, "recent": 1, "daily_days": 7, "weekly_weeks": 4}, now=NOW)
    stamp = lost.name[12:-3]
    assert lost.with_suffix(".keep.json").exists() and (d / f"content_trash_{stamp}.db").exists()
    assert lost.with_suffix(".manifest.json").exists()
    assert backup.retention_status(d, now=NOW)["leftovers"] == 1


def test_duplicate_or_invalid_later_sets_do_not_pin_earlier_sets(tmp_path, monkeypatch):
    """과거 시각의 번호 겹친 세트·깨진 곁파일 세트는 영영 안 지워지므로 쌍의 뒤쪽으로 세지 않는다(Codex 4차 P2)."""
    d = tmp_path / "b"
    early = make_set(d, NOW - 400 * 86400, 1)
    y2000 = datetime(2000, 1, 1, tzinfo=timezone.utc).timestamp()
    make_set(d, y2000, 2, n=1)
    make_set(d, y2000 + 60, 2, n=2)  # 번호 겹침
    make_set(d, y2000 + 120, None, n=3, keep_raw="{broken")
    make_set(d, NOW - 10, 3, n=4)
    mark_registered(d, 3)
    small = {**POLICY_888, "recent": 4, "daily_days": 7, "weekly_weeks": 4}
    plan = backup._retention_plan(d, {**small, "recent": 1}, NOW)
    assert plan.inverted == frozenset()
    assert [s.stamp for s in plan.delete] == [early.name[12:-3]]
    monkeypatch.setattr(backup, "_backup_dir", lambda: d)
    monkeypatch.setattr(backup, "AUTH_ENABLED", False)
    dry = backup.update_policy(small, version=0, dry_run=True, now=NOW)["preview"]
    assert dry["blocked"] is None  # 정책 변경도 막히지 않는다


def test_confirmed_shrink_during_inversion_recomputes_after_clock_is_fixed(tmp_path, monkeypatch):
    """2000년 구간에서 줄이기를 확인 저장해도 지울 목록을 저장해 두지 않는다 — 시계가 바로잡힌 뒤 회전이 그때의 정책·시각으로
    다시 계산하므로 날·주 대표가 남는다(Claude 5차 P3)."""
    d = tmp_path / "b"
    monkeypatch.setattr(backup, "_backup_dir", lambda: d)
    monkeypatch.setattr(backup, "AUTH_ENABLED", False)
    seq = 0
    real = []
    for i in range(20, 0, -1):
        seq += 1
        real.append(make_set(d, NOW - i * 86400, seq, n=seq))
    y2000 = datetime(2000, 1, 1, tzinfo=timezone.utc).timestamp()
    seq += 1
    make_set(d, y2000, seq, n=seq)  # 시계가 2000년인 동안 찍힘 — 번호 최대가 '지금(2000년)'이라 clock_skew 아님
    mark_registered(d, seq)
    small = {**POLICY_888, "recent": 4, "daily_days": 7, "weekly_weeks": 4}
    dry = backup.update_policy(small, version=0, dry_run=True, now=y2000 + 60)["preview"]
    assert dry["blocked"] == "inverted" and dry["delete_count"] > 0  # 2000년 기준이라 많아 보인다
    backup.update_policy(small, version=0, confirm_token=dry["confirm_token"], now=y2000 + 60)
    assert all(p.exists() for p in real)  # 보호 중이라 진짜 세트는 그대로
    for k in range(4):  # 시계가 바로잡히고 백업이 쌓여 2000년 세트가 최근 4 밖으로 밀린다
        seq += 1
        make_set(d, NOW - 40 + k, seq, n=seq)
    mark_registered(d, seq)
    backup._rotate(d, now=NOW)  # 2000년 세트가 지워져 쌍이 사라짐
    backup._rotate(d, now=NOW)  # 그때의 정책·시각으로 다시 계산
    for i in range(1, 7):
        assert real[20 - i].exists()  # 최근 6일 날짜 대표가 남는다


def test_undeletable_later_set_does_not_pin_earlier_sets_forever(tmp_path):
    d = tmp_path / "b"
    early = make_set(d, NOW - 400 * 86400, 1)  # 정상 시각
    wrong = make_set(d, datetime(2000, 1, 1, tzinfo=timezone.utc).timestamp(), 2, n=1, member_size_ok=False)
    make_set(d, NOW - 10, 3, n=2)
    mark_registered(d, 3)
    # 2000년 세트가 불완전(영영 안 지워짐)이면 쌍의 뒤쪽으로 세지 않아 앞 세트 보호가 풀린다
    plan = backup._retention_plan(d, {**POLICY_888, "recent": 1, "daily_days": 7, "weekly_weeks": 4}, NOW)
    assert plan.inverted == frozenset()
    assert [s.stamp for s in plan.delete] == [early.name[12:-3]]
    assert wrong.exists()


# ── listing ──────────────────────────────────────────────────────────────────
def test_latest_and_list_follow_sequence_even_after_clock_rollback(tmp_path, monkeypatch):
    d = tmp_path / "b"
    before = make_set(d, NOW + 7200, 1)  # 옛 세트의 미래 mtime
    after = make_set(d, NOW - 60, 2, n=1)  # 시계를 돌린 뒤 만든 세트
    legacy = make_set(d, NOW - 99999, None, n=2)  # 등록 안 된 옛 세트가 섞여도
    mark_registered(d, 2)
    monkeypatch.setattr(backup, "_backup_dir", lambda: d)
    assert backup.latest_backup_path() == after
    info = backup.list_backups_info(d)
    assert [item["file"] for item in info] == [after.name, before.name, legacy.name]
    assert info[0]["seq"] == 2 and info[0]["reason"] == "auto" and set(info[0]) >= {"file", "size", "mtime", "files"}
    src = tmp_path / "src.db"
    src.write_bytes(b"s")
    os.utime(src, (NOW - 120, NOW - 120))
    with mock.patch.object(backup.time, "time", return_value=NOW):
        age, _sig, needed = backup._read_poll_state(src, d)
    # 옛 방식(mtime 최대)이면 미래 mtime 때문에 나이 0 — 번호 기준이면 방금 세트의 60초
    assert age == pytest.approx(60.0, abs=1.0) and needed is False


def test_poll_treats_future_baseline_as_no_backup(tmp_path):
    d = tmp_path / "b"
    make_set(d, NOW + 7200, 1)
    mark_registered(d, 1)
    src = tmp_path / "src.db"
    src.write_bytes(b"s")
    with mock.patch.object(backup.time, "time", return_value=NOW):
        age, _sig, needed = backup._read_poll_state(src, d)
    assert age is None and needed is True


def test_poll_verifies_only_from_newest_and_skips_an_incomplete_newest(tmp_path):
    d = tmp_path / "b"
    good = make_set(d, NOW - 600, 1)
    broken = make_set(d, NOW - 60, 2, n=1, member_size_ok=False)
    mark_registered(d, 2)
    src = tmp_path / "src.db"
    src.write_bytes(b"s")
    os.utime(src, (NOW - 900, NOW - 900))
    checked: list[str] = []
    real_check = backup._set_complete

    def spy(content, keep=None):
        checked.append(content.name)
        return real_check(content, keep)

    with mock.patch.object(backup.time, "time", return_value=NOW), mock.patch.object(backup, "_set_complete", spy):
        age, _sig, _needed = backup._read_poll_state(src, d)
    assert checked == [broken.name, good.name]  # 새 것부터 완성 세트를 찾을 때까지만
    assert age == pytest.approx(600.0, abs=1.0)


def test_manifest_lost_after_registration_is_incomplete_and_kept(tmp_path):
    d = tmp_path / "b"
    lost = make_set(d, NOW - 400 * 86400, 1)  # manifest 가 있던 세트(곁파일 manifest=true)
    legacy = make_set(d, NOW - 401 * 86400, 2, n=1, manifest=False)  # 처음부터 manifest 없던 옛 세트
    make_set(d, NOW - 10, 3, n=2)
    mark_registered(d, 3)
    lost.with_suffix(".manifest.json").unlink()
    backup._rotate(d, policy={**POLICY_888, "recent": 1, "daily_days": 7, "weekly_weeks": 4}, now=NOW)
    assert lost.exists() and not legacy.exists()
    assert all(item["file"] != lost.name for item in backup.list_backups_info(d))
    assert backup.retention_status(d, now=NOW)["incomplete"] == 1


def test_all_legacy_keeps_old_name_and_mtime_behaviour(tmp_path):
    d = tmp_path / "b"
    a = make_set(d, NOW - 100, None, manifest=False, n=1)
    b = make_set(d, NOW - 50, None, manifest=False, n=2)
    assert [item["file"] for item in backup.list_backups_info(d)] == [b.name, a.name]


# ── policy ───────────────────────────────────────────────────────────────────
def test_default_policy_by_mode_and_module_values():
    with mock.patch.object(backup, "BACKUP_KEEP", 8), mock.patch.object(backup, "BACKUP_KEEP_DAILY", 14), \
            mock.patch.object(backup, "BACKUP_KEEP_WEEKLY", 8), mock.patch.object(backup, "BACKUP_CHANGE_DEBOUNCE", 300.0), \
            mock.patch.object(backup, "BACKUP_MIN_INTERVAL", 900.0):
        assert backup.default_policy() == POLICY_888


def test_update_policy_requires_matching_confirm_token_and_applies(tmp_path, monkeypatch):
    d = tmp_path / "b"
    monkeypatch.setattr(backup, "_backup_dir", lambda: d)
    monkeypatch.setattr(backup, "AUTH_ENABLED", False)
    for i in range(10):
        make_set(d, NOW - i * 3600, 10 - i, n=i)
    mark_registered(d, 10)
    small = {**POLICY_888, "recent": 4, "daily_days": 7, "weekly_weeks": 4}
    with pytest.raises(backup.BackupPolicyError) as bad:
        backup.update_policy({**small, "recent": 5}, version=0)
    assert bad.value.status == 422
    with pytest.raises(backup.BackupPolicyError) as conflict:
        backup.update_policy(small, version=3)
    assert conflict.value.code == "version_conflict"
    preview = backup.update_policy(small, version=0, dry_run=True, now=NOW)["preview"]
    assert preview["delete_count"] == 6 and preview["confirm_token"] and preview["delete_bytes"] > 0
    assert len(stamps(d)) == 10 and not (d / "backup_policy.json").exists()
    with pytest.raises(backup.BackupPolicyError) as need:
        backup.update_policy(small, version=0, confirm_token="wrong", now=NOW)
    assert need.value.code == "confirm_required" and need.value.preview["delete_count"] == 6
    make_set(d, NOW + 10, 11, n=11)  # 미리보기 뒤 세트가 늘어 대상이 바뀌면 같은 토큰으로는 안 된다
    with pytest.raises(backup.BackupPolicyError):
        backup.update_policy(small, version=0, confirm_token=preview["confirm_token"], now=NOW + 20)
    fresh = backup.update_policy(small, version=0, dry_run=True, now=NOW + 20)["preview"]
    result = backup.update_policy(small, version=0, confirm_token=fresh["confirm_token"], now=NOW + 20)
    assert result["saved"] and result["version"] == 1 and result["applied"]["deleted"] == fresh["delete_count"]
    assert backup.read_policy(d) == (small, 1, "saved")
    assert backup._POLICY_INTERVALS[str(d)] == (300.0, 900.0)


def test_shrinking_policy_is_refused_while_clock_is_wrong_and_confirmed_on_invalid_recovery(tmp_path, monkeypatch):
    d = tmp_path / "b"
    monkeypatch.setattr(backup, "_backup_dir", lambda: d)
    monkeypatch.setattr(backup, "AUTH_ENABLED", False)
    for i in range(6):
        make_set(d, NOW - (i + 1) * 3600, 6 - i, n=i)
    make_set(d, NOW + 7200, 7, n=9)  # 번호 최대 세트가 미래 → clock_skew
    mark_registered(d, 7)
    small = {**POLICY_888, "recent": 4, "daily_days": 7, "weekly_weeks": 4}
    with pytest.raises(backup.BackupPolicyError) as skew:
        backup.update_policy(small, version=0, now=NOW)
    assert skew.value.code == "clock_skew" and skew.value.preview["delete_count"] > 0
    assert not (d / "backup_policy.json").exists()
    # 거꾸로 된 쌍이 남아 있는 동안(clock_skew 는 풀림)도 줄이는 값은 거절 — 미리보기에 쌍 보호가 풀린 뒤 대상까지 보인다
    f = tmp_path / "f"
    monkeypatch.setattr(backup, "_backup_dir", lambda: f)
    for i in range(6):
        make_set(f, NOW - (30 - i) * 86400, i + 1, n=i)
    make_set(f, datetime(2000, 1, 1, tzinfo=timezone.utc).timestamp(), 7, n=7)
    make_set(f, NOW - 10, 8, n=8)
    mark_registered(f, 8)
    # 시계는 맞고 쌍 보호만 남음 — 미리보기가 '보호가 풀리면 지울 대상'까지 보이고, 그 확인 토큰으로 저장된다
    dry = backup.update_policy(small, version=0, dry_run=True, now=NOW)["preview"]
    assert dry["blocked"] == "inverted" and dry["delete_count"] > 0
    result = backup.update_policy(small, version=0, confirm_token=dry["confirm_token"], now=NOW)
    assert result["saved"] and result["applied"]["deleted"] == 0  # 지금은 보호 중이라 지우지 않음
    bigger = {**POLICY_888, "recent": 16, "daily_days": 30, "weekly_weeks": 12}
    assert backup.update_policy(bigger, version=1, now=NOW)["saved"]  # 늘리는 값은 그대로 저장
    # 정책 파일이 깨진 상태에서 복구 — 새 정책으로 대상을 계산해 확인받는다
    e = tmp_path / "c"
    monkeypatch.setattr(backup, "_backup_dir", lambda: e)
    for i in range(6):
        make_set(e, NOW - (i + 1) * 3600, 6 - i, n=i)
    mark_registered(e, 6)
    (e / "backup_policy.json").write_text("{broken", "utf-8")
    preview = backup.update_policy(small, version=0, dry_run=True, now=NOW)["preview"]
    assert preview["delete_count"] == 2
    with pytest.raises(backup.BackupPolicyError):
        backup.update_policy(small, version=0, now=NOW)
    assert backup.update_policy(small, version=0, confirm_token=preview["confirm_token"], now=NOW)["saved"]


def test_unreadable_registry_fails_the_backup_with_its_own_code(live_db):
    backup.backup_now()
    real_read = Path.read_text

    def deny(self, *args, **kwargs):
        if self.name == "backup_keep_registry.json":
            raise PermissionError("denied")
        return real_read(self, *args, **kwargs)

    with mock.patch.object(Path, "read_text", deny), pytest.raises(backup.RegistryUnreadable):
        backup.backup_now()
    assert backup.retention_status(live_db)["last_error"]["code"] == "registry_unreadable"
    assert json.loads((live_db / "backup_keep_registry.json").read_text("utf-8"))["state"] == "done"  # 새로 쓰지 않음


def test_auth_ignores_local_policy_files(tmp_path, monkeypatch):
    d = tmp_path / "b"
    old = make_set(d, NOW - 400 * 86400, 1)
    make_set(d, NOW - 10, 2, n=1)
    mark_registered(d, 2)
    monkeypatch.setattr(backup, "AUTH_ENABLED", True)
    monkeypatch.setattr(backup, "BACKUP_KEEP", 1)
    (d / "backup_policy.json").write_text("{broken", "utf-8")  # 깨진 파일이 있어도 서버 회전을 막지 않는다
    assert backup.read_policy(d)[2] == "default"
    assert backup._rotate(d, now=NOW)["blocked"] is None
    assert not old.exists()


def test_policy_is_per_backup_folder_and_auth_is_refused(tmp_path, monkeypatch):
    a, b = tmp_path / "a", tmp_path / "b"
    monkeypatch.setattr(backup, "AUTH_ENABLED", False)
    monkeypatch.setattr(backup, "_backup_dir", lambda: a)
    backup.update_policy(POLICY_888, version=0)
    assert (a / "backup_policy.json").exists() and not (b / "backup_policy.json").exists()
    monkeypatch.setattr(backup, "_backup_dir", lambda: b)
    assert backup.policy_view()["version"] == 0
    monkeypatch.setattr(backup, "AUTH_ENABLED", True)
    for call in (backup.policy_view, lambda: backup.update_policy(POLICY_888, version=0)):
        with pytest.raises(backup.BackupPolicyError) as refused:
            call()
        assert refused.value.status == 403 and refused.value.code == "local_hub_only"


def test_policy_routes(tmp_path, monkeypatch):
    from app.routers import db_transfer

    d = tmp_path / "b"
    monkeypatch.setattr(backup, "_backup_dir", lambda: d)
    monkeypatch.setattr(backup, "AUTH_ENABLED", False)
    monkeypatch.setattr(db_transfer, "require_admin", lambda request: None)
    monkeypatch.setattr(db_transfer, "_require_local_when_open", lambda request: None)
    app = FastAPI()
    app.include_router(db_transfer.router)
    client = TestClient(app)
    got = client.get("/api/db/backup-policy").json()
    assert got["version"] == 0 and got["choices"]["recent"] == [4, 8, 16]
    assert client.put("/api/db/backup-policy", json={**POLICY_888, "recent": 7, "version": 0}).status_code == 422
    assert client.put("/api/db/backup-policy", json={**POLICY_888, "version": 5}).status_code == 409
    ok = client.put("/api/db/backup-policy", json={**POLICY_888, "version": 0})
    assert ok.status_code == 200 and ok.json()["version"] == 1


# ── runtime ──────────────────────────────────────────────────────────────────
def test_poll_reads_saved_intervals_and_loop_uses_them(tmp_path):
    d = tmp_path / "b"
    d.mkdir()
    backup._write_policy(d, {**POLICY_888, "quiet_minutes": 1, "min_interval_minutes": 5}, 1)
    src = tmp_path / "src.db"
    src.write_bytes(b"s")
    backup._read_poll_state(src, d)
    assert backup._POLICY_INTERVALS[str(d)] == (60.0, 300.0)
    assert backup._change_backup_due(0.0, 300.0, now=60.0, intervals=(60.0, 300.0))
    assert not backup._change_backup_due(0.0, 299.0, now=60.0, intervals=(60.0, 300.0))

    worker = backup.PeriodicBackup(interval=3600.0)
    seen: list[dict] = []

    def due(*args, **kwargs):
        seen.append(kwargs)
        return False

    scope = (src, d, "")
    with mock.patch.object(backup, "_capture_backup_scope", return_value=scope), \
            mock.patch.object(backup, "_change_backup_due", due), \
            mock.patch.object(backup, "_STARTUP_SKIP_IF_YOUNGER", 3_600.0), \
            mock.patch.object(backup.asyncio, "sleep", mock.AsyncMock(side_effect=[None, asyncio.CancelledError()])), \
            mock.patch.object(backup.asyncio, "to_thread", mock.AsyncMock(return_value=(10.0, (("content", 1, 1),), False))):
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(worker._run())
    assert seen and seen[-1].get("intervals") == (60.0, 300.0)


# ── 독립 리뷰 1차(Codex 01a1cec0) 지적 시험 ─────────────────────────────────────
def test_policy_change_deletes_only_confirmed_sets_even_if_a_hold_is_released(tmp_path, monkeypatch):
    d = tmp_path / "b"
    monkeypatch.setattr(backup, "_backup_dir", lambda: d)
    monkeypatch.setattr(backup, "AUTH_ENABLED", False)
    far = NOW - 400 * 86400
    sets = [make_set(d, far + i * 60, i + 1, n=i) for i in range(10)]
    mark_registered(d, 10)
    small = {**POLICY_888, "recent": 4, "daily_days": 7, "weekly_weeks": 4}
    with backup.hold_set(sets[0]):  # 1번이 사용 중이어도 미리보기는 '풀리면 지울 대상'으로 1번까지 센다
        preview = backup.update_policy(small, version=0, dry_run=True, now=NOW)["preview"]
    assert preview["delete_count"] == 6
    # 회전은 확인한 집합(only) 밖을 지우지 않는다
    summary = backup._rotate(d, policy={**small, "recent": 1}, now=NOW, only={sets[0].name[12:-3]})
    assert summary["deleted"] == 1 and not sets[0].exists() and all(p.exists() for p in sets[1:])


def test_resume_ignores_field_broken_deleting_sidecar_and_hold_refuses_it(tmp_path):
    d = tmp_path / "b"
    broken = make_set(d, NOW - 400 * 86400, None,
                      keep_raw=json.dumps({"format": "mvhub-backup-keep", "seq": "x", "deleting": True}))
    make_set(d, NOW - 10, 2, n=1)
    mark_registered(d, 2)
    with pytest.raises(FileNotFoundError):
        with backup.hold_set(broken):
            pass
    backup._rotate(d, policy={**POLICY_888, "recent": 1, "daily_days": 7, "weekly_weeks": 4}, now=NOW)
    assert broken.exists() and (d / f"content_trash_{broken.name[12:-3]}.db").exists()


def test_corrupt_registry_and_missing_policy_file_is_unknown_not_default(tmp_path):
    d = tmp_path / "b"
    old = make_set(d, NOW - 400 * 86400, 1)
    make_set(d, NOW - 10, 2, n=1)
    mark_registered(d, 2)
    backup._write_policy(d, POLICY_888, 2)
    (d / "backup_policy.json").unlink()
    (d / "backup_keep_registry.json").write_text('{"state": "done", "last_seq": "x"}', "utf-8")  # 필드 깨짐
    assert backup.read_policy(d)[2] == "invalid"
    assert backup._rotate(d, now=NOW)["blocked"] == "policy_invalid" and old.exists()
    backup._next_seq(d)  # 새 번호 발급이 깨진 표식을 고쳐 써도 '저장 이력 모름'을 지키고
    registry = json.loads((d / "backup_keep_registry.json").read_text("utf-8"))
    assert registry["policy_unknown"] is True and backup.read_policy(d)[2] == "invalid"
    backup._write_policy(d, POLICY_888, 3)  # 다시 저장하면 풀린다
    assert backup.read_policy(d)[2] == "saved"


def test_wal_cleanup_leaves_failed_and_half_sets_alone(tmp_path):
    d = tmp_path / "b"
    half = make_set(d, NOW - 3 * 86400, 1)
    half.unlink()  # 대표 파일만 잃은 반쪽 세트
    (d / f"{half.name}-wal").write_bytes(b"w")
    junk = d / "content_hub_20000101_000000_000001.db-shm"  # 곁파일도 짝 DB 도 없는 옛 부산물
    junk.write_bytes(b"s")
    make_set(d, NOW - 10, 2, n=1)
    mark_registered(d, 2)
    backup._rotate(d, now=NOW)
    assert (d / f"{half.name}-wal").exists() and not junk.exists()


def test_damaged_manifest_and_undecodable_files_do_not_stop_rotation(tmp_path):
    d = tmp_path / "b"
    bad_manifest = make_set(d, NOW - 401 * 86400, 1)
    bad_manifest.with_suffix(".manifest.json").write_text("[]", "utf-8")
    bad_bytes = make_set(d, NOW - 402 * 86400, 2, n=1)
    bad_bytes.with_suffix(".keep.json").write_bytes(b"\xff\xfe\x00broken")
    old = make_set(d, NOW - 400 * 86400, 3, n=2)
    make_set(d, NOW - 10, 4, n=3)
    mark_registered(d, 4)
    (d / "backup_policy.json").write_bytes(b"\xff\xfe")
    assert backup.read_policy(d)[2] == "invalid"
    (d / "backup_policy.json").unlink()
    backup._rotate(d, policy={**POLICY_888, "recent": 1, "daily_days": 7, "weekly_weeks": 4}, now=NOW)
    assert bad_manifest.exists() and bad_bytes.exists() and not old.exists()
    status = backup.retention_status(d, now=NOW)
    assert status["incomplete"] == 1 and status["sidecar_invalid"] == 1


def test_poll_skips_incomplete_unnumbered_newest_and_matches_list_on_duplicates(tmp_path):
    d = tmp_path / "b"
    good = make_set(d, NOW - 600, None, n=1)
    make_set(d, NOW - 60, None, n=2, member_size_ok=False)  # 번호 없는 불완전 최신
    src = tmp_path / "src.db"
    src.write_bytes(b"s")
    os.utime(src, (NOW - 900, NOW - 900))
    with mock.patch.object(backup.time, "time", return_value=NOW):
        age, _sig, _needed = backup._read_poll_state(src, d)
    assert age == pytest.approx(600.0, abs=1.0)
    e = tmp_path / "c"
    make_set(e, NOW - 600, 1)
    make_set(e, NOW - 300, 2, n=1)
    make_set(e, NOW - 60, 2, n=2, member_size_ok=False)  # 완성·불완전이 같은 번호
    mark_registered(e, 2)
    listed = backup.list_backups_info(e)[0]["file"]
    with mock.patch.object(backup.time, "time", return_value=NOW):
        age2, _s, _n = backup._read_poll_state(src, e)
    newest = next(p for p in e.glob("content_hub_*.db") if p.name == listed)
    assert age2 == pytest.approx(NOW - newest.stat().st_mtime, abs=1.0)


def test_disk_full_on_first_run_writes_no_registration(live_db):
    live_db.mkdir(parents=True, exist_ok=True)
    legacy = make_set(live_db, NOW - 3600, None, manifest=False)
    with mock.patch.object(backup.shutil, "disk_usage", return_value=mock.Mock(free=1)), \
            pytest.raises(backup.BackupDiskFull):
        backup.backup_now()
    assert not (live_db / "backup_keep_registry.json").exists()
    assert not legacy.with_suffix(".keep.json").exists()


def test_repeated_resume_failure_keeps_failure_count(tmp_path):
    d = tmp_path / "b"
    victim = make_set(d, NOW - 400 * 86400, 1)
    make_set(d, NOW - 10, 2, n=1)
    mark_registered(d, 2)
    trash = d / f"content_trash_{victim.name[12:-3]}.db"
    real_unlink = Path.unlink

    def locked(self, *args, **kwargs):
        if self == trash:
            raise PermissionError("locked")
        return real_unlink(self, *args, **kwargs)

    small = {**POLICY_888, "recent": 1, "daily_days": 7, "weekly_weeks": 4}
    with mock.patch.object(Path, "unlink", locked):
        assert backup._rotate(d, policy=small, now=NOW)["failed"] == 1
        second = backup._rotate(d, policy=small, now=NOW)  # 이어 지우기도 실패 — 수가 0 으로 덮이지 않음
        assert second["resume_failed"] == 1 and second["failed"] == 0
    assert backup.retention_status(d, now=NOW)["delete_failed"] == 1


# ── 독립 리뷰 2차(재확인) 지적 시험 ──────────────────────────────────────────────
def test_registry_missing_required_fields_is_unknown_even_after_new_number(tmp_path):
    d = tmp_path / "b"
    old = make_set(d, NOW - 400 * 86400, 1)
    make_set(d, NOW - 10, 2, n=1)
    mark_registered(d, 2)
    backup._write_policy(d, POLICY_888, 2)
    (d / "backup_policy.json").unlink()
    for broken in ("{}", '{"format": "other", "state": "done", "last_seq": 2}', '{"format": "mvhub-backup-keep-registry"}'):
        (d / "backup_keep_registry.json").write_text(broken, "utf-8")
        assert backup.read_policy(d)[2] == "invalid", broken
        assert backup._rotate(d, now=NOW)["blocked"] == "policy_invalid" and old.exists()
    backup._next_seq(d)
    registry = json.loads((d / "backup_keep_registry.json").read_text("utf-8"))
    assert registry["policy_unknown"] is True and registry["state"] == "done" and registry["last_seq"] >= 3
    assert backup.read_policy(d)[2] == "invalid"


def test_wal_of_half_set_without_sidecar_is_kept(tmp_path):
    d = tmp_path / "b"
    half = make_set(d, NOW - 3 * 86400, None)  # 곁파일 없는 반쪽 세트(manifest·trash 만 남음)
    half.unlink()
    (d / f"{half.name}-wal").write_bytes(b"w")
    make_set(d, NOW - 10, 2, n=1)
    mark_registered(d, 2)
    backup._rotate(d, now=NOW)
    assert (d / f"{half.name}-wal").exists()


def test_hold_refuses_when_sidecar_cannot_be_read(tmp_path):
    d = tmp_path / "b"
    target = make_set(d, NOW - 10, 1)
    real_read = Path.read_text

    def locked(self, *args, **kwargs):
        if self.name.endswith(".keep.json"):
            raise PermissionError("sharing violation")
        return real_read(self, *args, **kwargs)

    with mock.patch.object(Path, "read_text", locked), pytest.raises(FileNotFoundError):
        with backup.hold_set(target):
            pass
    assert not backup._held(target)


def test_poll_falls_back_to_newest_mtime_when_numbered_sets_are_incomplete(tmp_path):
    d = tmp_path / "b"
    make_set(d, NOW - 30, 1, n=9, member_size_ok=False)  # 번호 있는 세트는 불완전
    late_name_early_mtime = make_set(d, NOW - 900, None, n=8)  # 이름은 뒤인데 mtime 은 이른
    early_name_late_mtime = make_set(d, NOW - 300, None, n=1)
    os.utime(late_name_early_mtime, (NOW - 900, NOW - 900))
    os.utime(early_name_late_mtime, (NOW - 300, NOW - 300))
    mark_registered(d, 1)
    src = tmp_path / "src.db"
    src.write_bytes(b"s")
    os.utime(src, (NOW - 1000, NOW - 1000))
    with mock.patch.object(backup.time, "time", return_value=NOW):
        age, _sig, _needed = backup._read_poll_state(src, d)
    assert age == pytest.approx(300.0, abs=1.0)


def test_corrupt_deleting_marker_half_set_is_counted_as_leftover(tmp_path):
    d = tmp_path / "b"
    gone = make_set(d, NOW - 3600, None,
                    keep_raw=json.dumps({"format": "mvhub-backup-keep", "seq": "x", "deleting": True}))
    gone.unlink()
    resumable = make_set(d, NOW - 1800, 2, n=1, deleting=True)
    resumable.unlink()
    make_set(d, NOW - 10, 3, n=2)
    mark_registered(d, 3)
    status = backup.retention_status(d, now=NOW)
    assert status["leftovers"] == 1  # 깨진 삭제 표식 잔재만(정상 표식은 이어 지우기 몫)


def test_leftovers_count_sets_without_sidecar_too(tmp_path):
    d = tmp_path / "b"
    lost = make_set(d, NOW - 3600, None)  # 공개 직전 실패 — 부속 DB·manifest 만 남고 곁파일 없음
    lost.unlink()
    make_set(d, NOW - 10, 2, n=1)
    mark_registered(d, 2)
    status = backup.retention_status(d, now=NOW)
    assert status["leftovers"] == 1 and status["leftover_bytes"] > 0


# ── manual · hold ────────────────────────────────────────────────────────────
def test_manual_backup_reason_and_hold_blocks_deletion(live_db):
    manual = backup.backup_now(reason="manual")
    assert json.loads(manual.with_suffix(".keep.json").read_text("utf-8"))["reason"] == "manual"
    assert backup.retention_status(live_db)["reasons"]["manual"] == 1
    with backup.hold_set(manual), mock.patch.object(backup, "BACKUP_KEEP", 1):
        backup.backup_now()
        assert manual.exists()
    with mock.patch.object(backup, "BACKUP_KEEP", 1):
        backup.backup_now()
    assert not manual.exists()


def test_hold_refuses_deleting_or_missing_set(tmp_path):
    d = tmp_path / "b"
    going = make_set(d, NOW - 10, 1, deleting=True)
    with pytest.raises(FileNotFoundError):
        with backup.hold_set(going):
            pass
    with pytest.raises(FileNotFoundError):
        with backup.hold_set(d / "content_hub_missing.db"):
            pass


def test_worker_queue_holds_set_while_copying(live_db, monkeypatch, tmp_path):
    from app.services import worker_backup

    monkeypatch.setattr(worker_backup, "STATE_DB", tmp_path / "worker-state.db")
    monkeypatch.setattr(worker_backup, "OUTBOX_DIR", tmp_path / "outbox")
    monkeypatch.setattr(backup.active_account, "account_key", lambda: "artist@example.com")
    current = backup.backup_now()
    held_during_copy: list[bool] = []
    real_copy = worker_backup.shutil.copyfile

    def spy(src, dst, *args, **kwargs):
        held_during_copy.append(backup._held(Path(src)))
        return real_copy(src, dst, *args, **kwargs)

    monkeypatch.setattr(worker_backup.shutil, "copyfile", spy)
    with mock.patch.object(worker_backup.active_account, "account_key", return_value=None):
        assert worker_backup.queue_backup_set(current) is None  # 계정 없으면 지금처럼 None
    worker_backup.queue_backup_set(current, account_email="artist@example.com")  # 빈 DB 라 전송은 건너뛸 수 있음
    assert held_during_copy and all(held_during_copy)
    assert not backup._held(current)
