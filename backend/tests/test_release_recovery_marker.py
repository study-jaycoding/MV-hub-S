"""복구 필요 표식(recovery_required)은 복구 설치가 실제로 성공해야만 풀린다(Codex 남은 위험 검토, 2026-10-03).

main 부터 있던 유실: 반쯤 스왑된 트리에서 다시 시도하면 접수 기록(checking)이 표식을 지웠고, 그 시도가 워커의 복구 전에
실패하면(NAS·승인값·busy) 표식 없는 failed 가 남았다 → 같은 버전 + 얕은 검사 통과면 다음 시작이 '최신'으로 조기 반환해
복구 워커를 건너뛰었다. 워커도 시작 기록·표지 읽기 실패·잔재 이동 실패에서 같은 표식을 잃었다.
"""

from __future__ import annotations

import json
import os
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.services import release_update

PUB, CAND = "2026.10.03-0926", "2026.10.03-0958"
PUB_SHA, CAND_SHA = "a" * 64, "b" * 64


def _setup(tmp_path: Path) -> tuple[Path, Path]:
    root, source = tmp_path / "installed", tmp_path / "releases"
    root.mkdir()
    source.mkdir()
    (root / "VERSION.txt").write_text(PUB, encoding="utf-8")
    (root / "INSTALL_SOURCE.txt").write_text(str(source), encoding="utf-8")
    (root / "update_release.bat").write_text("@echo off\r\n", encoding="utf-8")
    return root, source


def _manifest(source: Path, name: str, version: str, sha: str) -> dict:
    data = {"version": version, "file": f"MVHub-{version}.zip", "sha256": sha, "size": 100,
            "higgsfield_cli_version": "1.1.26"}
    (source / name).write_text(json.dumps(data), encoding="utf-8")
    return data


@pytest.fixture(autouse=True)
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(release_update, "UPDATE_STATE_BASE", tmp_path / "state")
    monkeypatch.setattr(release_update, "AUTH_ENABLED", False)
    monkeypatch.setattr(release_update, "_installation_health", lambda *_a, **_k: (True, ""))  # 얕은 검사는 통과


def _write_marked(root: Path, state: str, *, age_minutes: float = 0) -> None:
    """워커가 남기는 모양 그대로 상태 파일에 표식을 쓴다(되돌려 확인 때 옛 코드에서도 같은 준비가 되게)."""
    release_update.write_state(state, "Update failed: rollback incomplete", root=root, latest_version=PUB)
    path = release_update.state_path(root)
    value = json.loads(path.read_text("utf-8"))
    value["recovery"] = "recovery_required"
    if age_minutes:
        value["updated_at"] = (datetime.now(timezone.utc) - timedelta(minutes=age_minutes)).isoformat()
    path.write_text(json.dumps(value), encoding="utf-8")


def _mark_recovery(root: Path) -> None:
    _write_marked(root, "failed")


def _stored(root: Path) -> dict:
    return release_update._load_state(root)[1]


def _capture_launch(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    launched: list[dict] = []
    monkeypatch.setattr(release_update, "_launch_bootstrap", lambda _s, env, _l: launched.append(env) or 1)
    return launched


# ── 백엔드 ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("cause", ["release_missing", "candidate_changed", "busy_after_check"])
def test_marker_survives_a_retry_that_fails_before_the_worker_and_the_next_start_still_recovers(
        tmp_path, monkeypatch, cause):
    root, source = _setup(tmp_path)
    _mark_recovery(root)
    monkeypatch.setattr(release_update, "_launch_bootstrap", lambda *_a: pytest.fail("이 시도는 워커 전에 실패해야 한다"))
    kwargs: dict = {}
    activity = iter([0, 0])
    if cause == "candidate_changed":
        _manifest(source, "latest.json", PUB, PUB_SHA)
        cand = _manifest(source, "candidate.json", CAND, CAND_SHA)
        kwargs = {"manifest": "candidate.json",
                  "expected_release": {**{k: cand[k] for k in ("version", "file", "size")}, "sha256": "c" * 64}}
    elif cause == "busy_after_check":
        _manifest(source, "latest.json", PUB, PUB_SHA)
        activity = iter([0, 1])  # 확인 중에 생성이 시작됐다

    with pytest.raises(release_update.ReleaseUpdateError):
        release_update.start_update(activity_check=lambda: next(activity), root=root, **kwargs)

    stored = _stored(root)
    assert (stored["state"], stored.get("recovery")) == ("failed", "recovery_required")
    status = release_update.get_status(refresh=True, root=root)
    assert (status["state"], status.get("recovery")) == ("failed", "recovery_required")  # '최신'으로 둔갑하지 않는다

    _manifest(source, "latest.json", PUB, PUB_SHA)  # 같은 버전 + 얕은 검사 통과
    launched = _capture_launch(monkeypatch)
    release_update.start_update(activity_check=lambda: 0, root=root)
    assert launched, "표식이 사라져 같은 버전 조기 반환이 복구 워커를 건너뛰었다"


def test_the_worker_handoff_record_carries_the_marker(tmp_path, monkeypatch):
    root, source = _setup(tmp_path)
    _manifest(source, "latest.json", PUB, PUB_SHA)
    _mark_recovery(root)
    seen: list[dict] = []
    monkeypatch.setattr(release_update, "_launch_bootstrap", lambda *_a: seen.append(_stored(root)) or 1)

    release_update.start_update(activity_check=lambda: 0, root=root)

    assert (seen[0]["state"], seen[0].get("recovery")) == ("starting", "recovery_required")  # 워커가 이어받는다


def test_stale_progress_with_the_marker_becomes_failed_with_the_marker(tmp_path):
    root, _source = _setup(tmp_path)
    _write_marked(root, "checking", age_minutes=31)

    status = release_update.get_status(root=root)

    assert (status["state"], status.get("recovery"), status["can_update"]) == ("failed", "recovery_required", False)
    assert _stored(root)["state"] == "failed"  # '진행 중'으로 굳지 않는다


def test_progress_that_turns_stale_with_the_marker_during_a_slow_check_is_never_handed_to_a_callback(
        tmp_path, monkeypatch):
    """Codex 코드 리뷰 P2 — 바깥 읽기는 평범했는데 느린 건강 검사 사이 '멈춘 복구 진행'으로 바뀐 경우, 최종 기록이 up_to_date 로
    표식을 지우면 안 된다(잠금 안 재읽기에서 직접 failed+표식)."""
    root, source = _setup(tmp_path)
    _manifest(source, "latest.json", PUB, PUB_SHA)

    def health_while_state_goes_stale(*_a, **_k):
        _write_marked(root, "checking", age_minutes=31)
        return True, ""

    monkeypatch.setattr(release_update, "_installation_health", health_while_state_goes_stale)
    status = release_update.get_status(refresh=True, root=root)

    assert (status["state"], status.get("recovery")) == ("failed", "recovery_required")
    assert (_stored(root)["state"], _stored(root).get("recovery")) == ("failed", "recovery_required")


def test_without_a_marker_nothing_new_is_recorded(tmp_path, monkeypatch):
    root, source = _setup(tmp_path)
    release_update.write_state("failed", "Update failed: boom", root=root, latest_version=PUB)
    with pytest.raises(release_update.ReleaseUpdateError):
        release_update.start_update(activity_check=lambda: 0, root=root)  # latest.json 없음
    assert "recovery" not in _stored(root)

    _manifest(source, "latest.json", PUB, PUB_SHA)
    monkeypatch.setattr(release_update, "_launch_bootstrap", lambda *_a: pytest.fail("같은 버전·건강하면 워커 없이 최신"))
    assert release_update.start_update(activity_check=lambda: 0, root=root)["state"] == "up_to_date"


# ── 워커(PowerShell) — 실제 실행 ───────────────────────────────────────────

def _payload() -> str:
    raw = (Path(__file__).resolve().parents[2] / "update_release_worker.bat").read_text(encoding="utf-8")
    return raw.split("### MVHUB_" + "UPDATE_POWERSHELL ###")[-1]


def _run_ps(script: str, tmp_path: Path) -> subprocess.CompletedProcess[str]:
    harness = tmp_path / "harness.ps1"
    harness.write_text(script, encoding="utf-8-sig")
    return subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(harness)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60, check=False,
    )


def _state_block(payload: str) -> str:
    """표식 초기화·승계 + Write-UpdateState 정의(함수 정의만 — 실행 부작용 없음)."""
    return payload[payload.index('$script:RecoveryState = "not_started"'):payload.index("function Move-PathWithRetry")]


@pytest.mark.skipif(os.name != "nt", reason="Windows updater")
@pytest.mark.parametrize("previous,expect_checking,expect_failed", [
    ({"state": "starting", "recovery": "recovery_required"}, "recovery_required", "recovery_required"),
    ({"state": "starting"}, "", "not_started"),
])
def test_worker_inherits_the_marker_into_every_record(tmp_path, previous, expect_checking, expect_failed):
    state = tmp_path / "state.json"
    state.write_text(json.dumps(previous), encoding="utf-8")
    script = (
        "$ErrorActionPreference = 'Stop'\n"
        f"$TargetDir = '{tmp_path}'\n$StateFile = '{state}'\n$LatestVersion = ''\n"
        + _state_block(_payload())
        + "\nWrite-UpdateState -State 'checking' -Message 'x' -Percent 5\n"
        "$c = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json\n"
        "Write-UpdateState -State 'failed' -Message 'y' -Recovery $script:RecoveryState\n"
        "$f = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json\n"
        "$script:RecoveryState = 'new_committed'\n"  # 설치 확정 뒤 — 성공 기록에는 표식이 붙지 않는다
        "Write-UpdateState -State 'complete' -Message 'z' -Percent 100\n"
        "$s = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json\n"
        "Write-Host ('checking=[' + $c.recovery + '] failed=[' + $f.recovery + '] complete=[' + $s.recovery + ']')\n"
    )
    done = _run_ps(script, tmp_path)
    assert done.returncode == 0, done.stderr
    assert f"checking=[{expect_checking}] failed=[{expect_failed}] complete=[]" in done.stdout


@pytest.mark.skipif(os.name != "nt", reason="Windows updater")
def test_worker_resolve_busy_keeps_the_inherited_marker_when_the_second_read_fails(tmp_path):
    state = tmp_path / "state.json"
    state.write_text(json.dumps({"state": "starting", "recovery": "recovery_required"}), encoding="utf-8")
    script = (
        "$ErrorActionPreference = 'Stop'\n"
        f"$TargetDir = '{tmp_path}'\n$StateFile = '{state}'\n$LatestVersion = ''\n"
        + _state_block(_payload())
        + "\nSet-Content -LiteralPath $StateFile -Value '{broken' -Encoding UTF8\n"  # 두 번째 읽기만 실패
        "Write-ResolveTransferBusyState\n"
        "$b = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json\n"
        "Write-Host ('busy=' + $b.state + '/' + $b.recovery)\n"
    )
    done = _run_ps(script, tmp_path)
    assert done.returncode == 0, done.stderr
    assert "busy=failed/recovery_required" in done.stdout


@pytest.mark.skipif(os.name != "nt", reason="Windows updater")
def test_worker_marks_leftovers_before_moving_them(tmp_path):
    target = tmp_path / "app"
    (target / "backend" / "app.previous.abcdef12").mkdir(parents=True)
    payload = _payload()
    fn = payload[payload.index("function Move-LeftoversToQuarantine"):payload.index("function New-StagedComponents")]
    script = (
        "$ErrorActionPreference = 'Stop'\n"
        f"$TargetDir = '{target}'\n$SwapToken = '12345678'\n$JournalPath = Join-Path $TargetDir 'update-journal.json'\n"
        "$script:RecoveryState = 'not_started'\n$script:HadRecoveryAssets = $false\n"
        "function Move-PathWithRetry { param($Path, $Destination, $Label) throw 'locked' }\n"
        + fn + "\ntry { Move-LeftoversToQuarantine } catch { }\n"
        "Write-Host ('recovery=' + $script:RecoveryState + ' had=' + $script:HadRecoveryAssets)\n"
    )
    done = _run_ps(script, tmp_path)
    assert done.returncode == 0, done.stderr
    assert "recovery=recovery_required had=True" in done.stdout  # 이동이 실패해도 표식은 남는다


def test_worker_inherited_marker_forces_reinstall_and_never_boots_a_rolled_back_untrusted_tree():
    payload = _payload()
    assert "-or $script:HadRecoveryAssets -or $script:InheritedRecovery -or $Forced" in payload
    commit = payload[payload.index("$script:ProcessesStopped = $true"):payload.index("$script:InstalledComponents = $Components")]
    # 믿을 수 없던 트리로 되돌린 것은 여전히 recovery_required — 실패 뒤 재기동 조건(rolled_back·new_committed)에 안 걸린다.
    assert commit.index("if ($script:HadRecoveryAssets -or $script:InheritedRecovery)") < commit.index('"rolled_back"')
    assert "if ($script:HadRecoveryAssets -or $script:InheritedRecovery) {\n            # The tree we just rolled back TO" in payload
