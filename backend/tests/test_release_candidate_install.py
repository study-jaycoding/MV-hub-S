"""관리자 PC 후보 선설치(U1, Jay 2026-10-03) — '목록에 등록'한 후보를 [공지] 전에 관리자 PC 에만 설치한다.

Codex 설계 검토 v1·v2 의 반례를 시험으로 고정한다: 후보 고정값이 일반 업데이트로 새지 않음, 승인 뒤 바뀐 후보는 설치 안 함,
후보를 쓰는 PC 의 일반 업데이트가 공개본으로 내려가지 않음(강제·복구는 공개본), 후보를 못 읽으면 취소로 보지 않음,
실패·복구 기록을 덮지 않음, 손상 후보는 성공으로 보이지 않음, 공개 표지는 바뀌지 않음, 서버 권한 판정·워커 실제 동작.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import subprocess
from pathlib import Path

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.routers import release_update as router
from app.services import release_update

PUB, CAND, OLD = "2026.10.03-0926", "2026.10.03-0958", "2026.10.01-0906"
PUB_SHA, CAND_SHA = "a" * 64, "b" * 64


def _setup(tmp_path: Path, version: str) -> tuple[Path, Path]:
    root, source = tmp_path / "installed", tmp_path / "releases"
    root.mkdir()
    source.mkdir()
    (root / "VERSION.txt").write_text(version, encoding="utf-8")
    (root / "INSTALL_SOURCE.txt").write_text(str(source), encoding="utf-8")
    (root / "update_release.bat").write_text("@echo off\r\n", encoding="utf-8")
    return root, source


def _manifest(source: Path, name: str, version: str, sha: str) -> dict:
    data = {"version": version, "file": f"MVHub-{version}.zip", "sha256": sha, "size": 100,
            "higgsfield_cli_version": "1.1.26"}
    (source / name).write_text(json.dumps(data), encoding="utf-8")
    return data


def _expected(data: dict) -> dict:
    return {key: data[key] for key in ("version", "file", "size", "sha256")}


@pytest.fixture(autouse=True)
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(release_update, "UPDATE_STATE_BASE", tmp_path / "state")
    monkeypatch.setattr(release_update, "AUTH_ENABLED", False)
    monkeypatch.setattr(release_update, "_installation_health", lambda *_a, **_k: (True, ""))
    for key in ("MVHUB_UPDATE_MANIFEST", "MVHUB_UPDATE_EXPECT_SHA256", "MVHUB_UPDATE_EXPECT_VERSION"):
        monkeypatch.delenv(key, raising=False)


def _capture_launch(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    launched: list[dict] = []
    monkeypatch.setattr(release_update, "_launch_bootstrap", lambda _s, env, _l: launched.append(env) or 1)
    return launched


def _no_launch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(release_update, "_launch_bootstrap", lambda *_a: pytest.fail("워커를 띄우면 안 된다"))


# ── 후보 설치 시작 ─────────────────────────────────────────────────────────

def test_candidate_install_pins_the_approved_release_and_leaves_public_files_alone(tmp_path, monkeypatch):
    root, source = _setup(tmp_path, PUB)
    _manifest(source, "latest.json", PUB, PUB_SHA)
    cand = _manifest(source, "candidate.json", CAND, CAND_SHA)
    before = {name: (source / name).read_bytes() for name in ("latest.json", "candidate.json")}
    launched = _capture_launch(monkeypatch)

    result = release_update.start_update(activity_check=lambda: 0, root=root, manifest="candidate.json",
                                         expected_release=_expected(cand))

    assert result["accepted"] is True and result["latest_version"] == CAND
    env = launched[0]
    assert (env["MVHUB_UPDATE_MANIFEST"], env["MVHUB_UPDATE_EXPECT_SHA256"], env["MVHUB_UPDATE_EXPECT_VERSION"]) == (
        "candidate.json", CAND_SHA, CAND)
    assert env["MVHUB_UPDATE_FORCE"] == "0"
    assert {name: (source / name).read_bytes() for name in before} == before  # 팀 표지·후보 그대로


def test_normal_update_never_inherits_leftover_candidate_values(tmp_path, monkeypatch):
    root, source = _setup(tmp_path, OLD)
    _manifest(source, "latest.json", PUB, PUB_SHA)
    monkeypatch.setenv("MVHUB_UPDATE_MANIFEST", "candidate.json")
    monkeypatch.setenv("MVHUB_UPDATE_EXPECT_SHA256", CAND_SHA)
    monkeypatch.setenv("MVHUB_UPDATE_EXPECT_VERSION", CAND)
    launched = _capture_launch(monkeypatch)

    release_update.start_update(activity_check=lambda: 0, root=root)

    env = launched[0]
    assert env["MVHUB_UPDATE_MANIFEST"] == "latest.json"
    assert "MVHUB_UPDATE_EXPECT_SHA256" not in env and "MVHUB_UPDATE_EXPECT_VERSION" not in env


@pytest.mark.parametrize("field,value", [("sha256", "c" * 64), ("version", "2026.10.03-1000"),
                                         ("file", "other.zip"), ("size", 101)])
def test_candidate_changed_after_approval_is_not_installed(tmp_path, monkeypatch, field, value):
    root, source = _setup(tmp_path, PUB)
    _manifest(source, "latest.json", PUB, PUB_SHA)
    cand = _manifest(source, "candidate.json", CAND, CAND_SHA)
    _no_launch(monkeypatch)
    with pytest.raises(release_update.ReleaseUpdateError, match="후보가 바뀌었습니다"):
        release_update.start_update(activity_check=lambda: 0, root=root, manifest="candidate.json",
                                    expected_release={**_expected(cand), field: value})


@pytest.mark.parametrize("version", ["1.2.3", "2026.10.02-2348"])
def test_only_a_newer_dated_candidate_can_be_preinstalled(tmp_path, monkeypatch, version):
    root, source = _setup(tmp_path, OLD)
    _manifest(source, "latest.json", PUB, PUB_SHA)
    cand = _manifest(source, "candidate.json", version, CAND_SHA)
    _no_launch(monkeypatch)
    with pytest.raises(release_update.ReleaseUpdateError, match="새 날짜 판인 후보만"):
        release_update.start_update(activity_check=lambda: 0, root=root, manifest="candidate.json",
                                    expected_release=_expected(cand))


def test_unknown_manifest_name_is_refused(tmp_path, monkeypatch):
    root, source = _setup(tmp_path, OLD)
    _manifest(source, "latest.json", PUB, PUB_SHA)
    _no_launch(monkeypatch)
    with pytest.raises(release_update.ReleaseUpdateError):
        release_update.start_update(activity_check=lambda: 0, root=root, manifest="../latest.json")


def test_candidate_reinstall_with_activity_still_waits(tmp_path, monkeypatch):
    root, source = _setup(tmp_path, CAND)
    _manifest(source, "latest.json", PUB, PUB_SHA)
    cand = _manifest(source, "candidate.json", CAND, CAND_SHA)
    _no_launch(monkeypatch)
    with pytest.raises(release_update.ReleaseUpdateBusyError):
        release_update.start_update(activity_check=lambda: 1, root=root, manifest="candidate.json",
                                    expected_release=_expected(cand))


# ── 후보를 쓰는 PC ─────────────────────────────────────────────────────────

def test_pc_on_candidate_is_up_to_date_and_normal_update_does_not_go_back(tmp_path, monkeypatch):
    root, source = _setup(tmp_path, CAND)
    _manifest(source, "latest.json", PUB, PUB_SHA)
    _manifest(source, "candidate.json", CAND, CAND_SHA)

    status = release_update.get_status(refresh=True, root=root)
    assert (status["state"], status["latest_version"], status.get("candidate"), status["can_update"]) == (
        "up_to_date", CAND, True, False)
    # refresh 없는 응답(덮개·설정)에도 후보 표시가 남는다
    assert release_update.get_status(root=root).get("candidate") is True

    _no_launch(monkeypatch)
    result = release_update.start_update(activity_check=lambda: 0, root=root)  # 옛 공지 클릭 등
    assert (result["state"], result.get("candidate")) == ("up_to_date", True)


def test_force_on_candidate_pc_reinstalls_the_public_release(tmp_path, monkeypatch):
    root, source = _setup(tmp_path, CAND)
    _manifest(source, "latest.json", PUB, PUB_SHA)
    _manifest(source, "candidate.json", CAND, CAND_SHA)
    launched = _capture_launch(monkeypatch)
    release_update.start_update(activity_check=lambda: 0, root=root, force=True)
    assert launched[0]["MVHUB_UPDATE_MANIFEST"] == "latest.json"  # 강제 = 명시적 공개본 되돌리기


def test_unreadable_candidate_is_not_treated_as_cancelled(tmp_path, monkeypatch):
    root, source = _setup(tmp_path, CAND)
    _manifest(source, "latest.json", PUB, PUB_SHA)
    (source / "candidate.json").write_text("{broken", encoding="utf-8")

    assert release_update.get_status(refresh=True, root=root)["state"] == "check_failed"
    _no_launch(monkeypatch)
    with pytest.raises(release_update.ReleaseUpdateError, match="후보 상태를 확인할 수 없습니다"):
        release_update.start_update(activity_check=lambda: 0, root=root)
    kind, stored = release_update._load_state(root)
    assert stored["state"] == "check_failed"  # 'failed' 로 덮지 않는다


@pytest.mark.parametrize("cancel", ["select_release", "removed"])
def test_cancelled_candidate_offers_the_public_release_again(tmp_path, cancel):
    root, source = _setup(tmp_path, CAND)
    _manifest(source, "latest.json", PUB, PUB_SHA)
    if cancel == "select_release":
        _manifest(source, "candidate.json", PUB, PUB_SHA)  # 되돌리기는 후보=표지=공개본
    status = release_update.get_status(refresh=True, root=root)
    assert (status["state"], status["latest_version"]) == ("available", PUB)


def test_failed_and_recovery_records_are_not_overwritten_on_a_candidate_pc(tmp_path, monkeypatch):
    root, source = _setup(tmp_path, CAND)
    _manifest(source, "latest.json", PUB, PUB_SHA)
    _manifest(source, "candidate.json", CAND, CAND_SHA)
    release_update.write_state("failed", "Update failed: boom", root=root, latest_version=CAND)
    assert release_update.get_status(refresh=True, root=root)["state"] == "failed"

    path = release_update.state_path(root)
    value = json.loads(path.read_text("utf-8"))
    value["recovery"] = "recovery_required"
    path.write_text(json.dumps(value), encoding="utf-8")
    launched = _capture_launch(monkeypatch)
    release_update.start_update(activity_check=lambda: 0, root=root)
    assert launched, "복구 필요인데 후보 조기 반환이 복구 워커를 막았다(Codex U1 v2 C)"


def test_failure_recorded_while_checking_the_candidate_survives(tmp_path, monkeypatch):
    root, source = _setup(tmp_path, CAND)
    _manifest(source, "latest.json", PUB, PUB_SHA)
    _manifest(source, "candidate.json", CAND, CAND_SHA)
    original = release_update.fetch_candidate

    def candidate_while_another_attempt_fails(root_arg):
        release_update.write_state("failed", "Update failed: other attempt", root=root_arg, latest_version=CAND)
        return original(root_arg)

    monkeypatch.setattr(release_update, "fetch_candidate", candidate_while_another_attempt_fails)
    assert release_update.get_status(refresh=True, root=root)["state"] == "failed"


@pytest.mark.parametrize("written", ["failed", "checking"])
def test_slow_candidate_health_check_runs_outside_the_lock_and_keeps_newer_state(tmp_path, monkeypatch, written):
    """Codex 코드 리뷰 P2 — 건강 검사(Python·CLI 실행, 수 초)는 상태 잠금 밖에서, 그동안 기록된 상태는 덮지 않는다."""
    root, source = _setup(tmp_path, CAND)
    _manifest(source, "latest.json", PUB, PUB_SHA)
    _manifest(source, "candidate.json", CAND, CAND_SHA)

    def health_while_a_worker_writes(*_a, **_k):
        assert release_update._START_LOCK.acquire(blocking=False), "건강 검사가 상태 잠금 안에서 돈다"
        release_update._START_LOCK.release()
        release_update.write_state(written, "worker", root=root, latest_version=CAND)
        return True, ""

    monkeypatch.setattr(release_update, "_installation_health", health_while_a_worker_writes)
    assert release_update.get_status(refresh=True, root=root)["state"] == written


def test_damaged_candidate_never_looks_successful_and_reinstalls_the_same_candidate(tmp_path, monkeypatch):
    root, source = _setup(tmp_path, CAND)
    _manifest(source, "latest.json", PUB, PUB_SHA)
    cand = _manifest(source, "candidate.json", CAND, CAND_SHA)
    monkeypatch.setattr(release_update, "_installation_health", lambda *_a, **_k: (False, "runtime damaged"))

    status = release_update.get_status(refresh=True, root=root)
    assert (status["state"], status.get("candidate"), status["can_update"]) == ("check_failed", True, False)
    assert "다시 설치" in status["message"]

    _no_launch(monkeypatch)
    with pytest.raises(release_update.ReleaseUpdateError):
        release_update.start_update(activity_check=lambda: 0, root=root)  # 일반 시작 — 성공 상태 없음
    assert release_update._load_state(root)[1]["state"] == "check_failed"

    launched = _capture_launch(monkeypatch)
    release_update.start_update(activity_check=lambda: 0, root=root, manifest="candidate.json",
                                expected_release=_expected(cand))
    assert (launched[0]["MVHUB_UPDATE_MANIFEST"], launched[0]["MVHUB_UPDATE_FORCE"]) == ("candidate.json", "1")


def test_team_pc_older_than_public_never_reads_the_candidate(tmp_path, monkeypatch):
    root, source = _setup(tmp_path, OLD)
    _manifest(source, "latest.json", PUB, PUB_SHA)
    monkeypatch.setattr(release_update, "fetch_candidate", lambda _r: pytest.fail("팀원 PC 는 후보를 안 읽는다"))
    assert release_update.get_status(refresh=True, root=root)["state"] == "available"


# ── 라우트 ──────────────────────────────────────────────────────────────

def _request() -> Request:
    return Request({"type": "http", "method": "POST", "path": "/", "headers": [], "client": ("127.0.0.1", 5000)})


@pytest.fixture
def route(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(router, "_require_local", lambda _r: None)
    monkeypatch.setattr(router, "install_mode", lambda _root: "release")
    monkeypatch.setattr(router._proxy, "proxying", lambda: True)
    monkeypatch.setattr(router.active_account, "pinned_account_scope", contextlib.nullcontext)
    monkeypatch.setattr(router, "_activity",
                        lambda: {"generation_active": 2, "comfy_active": 0, "resolve_active": 0, "active_total": 2})
    calls: list[dict] = []

    def fake_start(**kwargs):
        calls.append({**kwargs, "activity": kwargs["activity_check"]()})
        return {"state": "starting", "accepted": True, "can_update": False}

    monkeypatch.setattr(router, "start_update", fake_start)
    return calls


def _call(body: dict, header: str | None = "1"):
    return router.release_update_start_candidate(router.CandidateStartIn(**body), _request(), x_mvhub_update=header)


ITEM = {"id": "n1", "version": CAND, "file": f"MVHub-{CAND}.zip", "size": 100, "sha256": CAND_SHA,
        "announcement_revision": 0}


def test_route_installs_a_registered_unannounced_candidate_with_real_activity_check(route, monkeypatch):
    monkeypatch.setattr(router._proxy, "proxy_json", lambda *_a, **_k: dict(ITEM))
    result = _call({"notice_id": "n1", "sha256": CAND_SHA.upper(), "confirm": True})
    assert result["accepted"] is True
    call = route[0]
    assert call["manifest"] == "candidate.json"
    assert call["expected_release"] == {k: ITEM[k] for k in ("version", "file", "size", "sha256")}
    assert call["activity"] == 2  # 강제 우회 없음
    assert call.get("force", False) is False


@pytest.mark.parametrize("error,status", [
    (HTTPException(403, "Admin 권한이 필요합니다"), 403),
    (HTTPException(404, "등록되지 않은 업데이트입니다"), 409),
    (HTTPException(404, "Not Found"), 409),
])
def test_route_refuses_without_server_admin_or_registration(route, monkeypatch, error, status):
    def fail(*_a, **_k):
        raise error

    monkeypatch.setattr(router._proxy, "proxy_json", fail)
    with pytest.raises(HTTPException) as exc:
        _call({"notice_id": "n1", "sha256": CAND_SHA, "confirm": True})
    assert exc.value.status_code == status
    assert route == []


def test_route_refuses_changed_item_or_missing_confirmation(route, monkeypatch):
    monkeypatch.setattr(router._proxy, "proxy_json", lambda *_a, **_k: {**ITEM, "id": "other"})
    with pytest.raises(HTTPException) as exc:
        _call({"notice_id": "n1", "sha256": CAND_SHA, "confirm": True})
    assert exc.value.status_code == 409
    with pytest.raises(HTTPException) as exc:
        _call({"notice_id": "n1", "sha256": CAND_SHA, "confirm": True}, header=None)
    assert exc.value.status_code == 400
    assert route == []


# ── 워커(PowerShell) — 실제 실행 ───────────────────────────────────────────

def _payload() -> str:
    raw = (Path(__file__).resolve().parents[2] / "update_release_worker.bat").read_text(encoding="utf-8")
    return raw.split("### MVHUB_" + "UPDATE_POWERSHELL ###")[-1]


def _run_ps(script: str, tmp_path: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    harness = tmp_path / "harness.ps1"
    harness.write_text(script, encoding="utf-8-sig")
    return subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(harness)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60, check=False,
        env={**os.environ, **env},
    )


@pytest.mark.skipif(os.name != "nt", reason="Windows updater")
def test_worker_reads_the_handoff_once_and_hides_it_from_child_processes(tmp_path):
    payload = _payload()
    block = payload[payload.index("$ManifestName = [string]$env:MVHUB_UPDATE_MANIFEST"):payload.index("if (-not $TargetDir)")]
    script = ("$ErrorActionPreference = 'Stop'\n" + block
              + "Write-Host ('manifest=' + $ManifestName + ' sha=' + $ExpectSha256 + ' ver=' + $ExpectVersion)\n"
              + "Write-Host ('child=' + (cmd /c 'echo [%MVHUB_UPDATE_MANIFEST%][%MVHUB_UPDATE_EXPECT_SHA256%]'))\n")
    done = _run_ps(script, tmp_path, {"MVHUB_UPDATE_MANIFEST": "candidate.json",
                                      "MVHUB_UPDATE_EXPECT_SHA256": CAND_SHA.upper(),
                                      "MVHUB_UPDATE_EXPECT_VERSION": CAND})
    assert done.returncode == 0, done.stderr
    assert f"manifest=candidate.json sha={CAND_SHA} ver={CAND}" in done.stdout
    assert "child=[%MVHUB_UPDATE_MANIFEST%][%MVHUB_UPDATE_EXPECT_SHA256%]" in done.stdout  # 자식은 못 물려받는다

    bad = _run_ps(script, tmp_path, {"MVHUB_UPDATE_MANIFEST": "..\\latest.json"})
    assert bad.returncode != 0 and "Unsupported release manifest" in (bad.stdout + bad.stderr)


@pytest.mark.skipif(os.name != "nt", reason="Windows updater")
@pytest.mark.parametrize("sha,version,ok", [(CAND_SHA, CAND, True), ("c" * 64, CAND, False), (CAND_SHA, PUB, False)])
def test_worker_refuses_a_candidate_that_changed_after_approval(tmp_path, sha, version, ok):
    source = tmp_path / "src"
    source.mkdir()
    _manifest(source, "candidate.json", CAND, CAND_SHA)
    payload = _payload()
    fn = payload[payload.index("function Read-ReleaseManifest"):payload.index("function Get-Sha256Hex")]
    script = (
        "$ErrorActionPreference = 'Stop'\n"
        f"$TempRoot = '{tmp_path}'\n$ManifestName = 'candidate.json'\n"
        f"$ExpectSha256 = '{sha}'\n$ExpectVersion = '{version}'\n"
        "function Get-ReleaseFile { param([string]$Name, [string]$Destination) "
        f"Copy-Item -LiteralPath (Join-Path '{source}' $Name) -Destination $Destination -Force }}\n"
        + fn + "\n$m = Read-ReleaseManifest\nWrite-Host ('read=' + $m.version)\n"
    )
    done = _run_ps(script, tmp_path, {})
    if ok:
        assert done.returncode == 0 and f"read={CAND}" in done.stdout, done.stderr
    else:
        assert done.returncode != 0 and "changed after approval" in (done.stdout + done.stderr)


def test_worker_checks_the_approval_before_the_same_version_shortcut_and_leftover_moves():
    payload = _payload()
    main = payload.index('Write-Host "[1/3] Checking MV Hub release server..."')
    read_at = payload.index("$Latest = Read-ReleaseManifest")
    # 승인값 대조(Read-ReleaseManifest) → 잔재 정리 → 동일 버전 판단 순서(Codex U1 v2 E)
    assert main < read_at < payload.index("    Move-LeftoversToQuarantine\n", main) < payload.index("$NeedsInstall = ")
