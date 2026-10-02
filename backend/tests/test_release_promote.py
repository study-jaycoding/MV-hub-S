"""B안: 후보(candidate.json)를 [공지] 뒤에만 공개 표지(latest.json)로 — 로컬 허브 promote 계약."""
from __future__ import annotations

import base64
import hashlib
import inspect
import json
import os
from pathlib import Path
import subprocess

import pytest
from fastapi import HTTPException

from app.routers import release_update as router
from app.services import release_update

pytestmark = pytest.mark.skipif(os.name != "nt", reason="릴리스 폴더 잠금은 Windows 공유 모드로 한다")


def _manifest(version: str, data: bytes) -> dict:
    return {"version": version, "higgsfield_cli_version": "1.1.26", "file": f"MVHub-{version}.zip",
            "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "created_at": "2026-10-02T10:00:00"}


def _folder(tmp_path: Path, *, published: str | None = "1.0", candidate: str | None = "2.0") -> tuple[Path, Path]:
    root, source = tmp_path / "installed", tmp_path / "releases"
    root.mkdir()
    source.mkdir()
    (root / "INSTALL_SOURCE.txt").write_text(str(source), encoding="utf-8")
    for version, name in ((published, "latest.json"), (candidate, "candidate.json")):
        if version:
            data = f"zip {version}".encode()
            (source / f"MVHub-{version}.zip").write_bytes(data)
            (source / name).write_text(json.dumps(_manifest(version, data)), encoding="utf-8")
    return root, source


def _item(source: Path, **override) -> dict:
    cand = json.loads((source / "candidate.json").read_text(encoding="utf-8"))
    return {"id": "release-x", "version": cand["version"], "file": cand["file"], "size": cand["size"],
            "sha256": cand["sha256"], "announcement_revision": 1, **override}


# ── 관리자 탭 상태(release_overview) ──────────────────────────────────────────

def test_overview_shows_candidate_and_pending(tmp_path: Path):
    root, _source = _folder(tmp_path)
    view = release_update.release_overview(root)
    assert (view["version"], view["source"], view["pending"]) == ("2.0", "candidate", True)
    assert view["published"]["version"] == "1.0" and view["published_state"] == "ok"


def test_overview_after_rollback_has_nothing_pending(tmp_path: Path):
    root, source = _folder(tmp_path)
    (source / "candidate.json").write_bytes((source / "latest.json").read_bytes())  # select_release 뒤
    view = release_update.release_overview(root)
    assert (view["source"], view["pending"]) == ("candidate", False)


def test_overview_never_falls_back_silently_on_a_broken_candidate(tmp_path: Path):
    root, source = _folder(tmp_path)
    (source / "candidate.json").write_text("{broken", encoding="utf-8")
    view = release_update.release_overview(root)
    assert (view["version"], view["source"], view["pending"]) == ("1.0", "latest", None)
    assert view["candidate_error"]


def test_overview_unreadable_published_is_unknown_not_missing(tmp_path: Path):
    root, source = _folder(tmp_path)
    (source / "latest.json").unlink()
    (source / "latest.json").mkdir()  # 읽기 실패(없음이 아님)
    view = release_update.release_overview(root)
    assert (view["published_state"], view["pending"]) == ("error", None)
    (source / "latest.json").rmdir()
    first = release_update.release_overview(root)  # 정말 없음 = 처음 상태
    assert (first["published_state"], first["pending"]) == ("missing", True)


# ── promote_candidate ────────────────────────────────────────────────────────

def test_promote_writes_candidate_bytes_and_backs_up_previous(tmp_path: Path):
    root, source = _folder(tmp_path)
    old, cand = (source / "latest.json").read_bytes(), (source / "candidate.json").read_bytes()
    result = release_update.promote_candidate(_item(source), root)
    assert result == {"promoted": True, "already": False, "version": "2.0"}
    assert (source / "latest.json").read_bytes() == cand  # 후보 원문 그대로
    backups = list((source / "latest-backups").glob("latest.previous-*.json"))
    assert len(backups) == 1 and backups[0].read_bytes() == old
    assert not list(source.glob(".latest.json.*.tmp"))
    again = release_update.promote_candidate(_item(source), root)
    assert again["already"] is True and len(list((source / "latest-backups").iterdir())) == 1


def test_promote_first_publish_without_previous(tmp_path: Path):
    root, source = _folder(tmp_path, published=None)
    release_update.promote_candidate(_item(source), root)
    assert (source / "latest.json").read_bytes() == (source / "candidate.json").read_bytes()
    assert not (source / "latest-backups").exists()


@pytest.mark.parametrize("override", [{"version": "9.9"}, {"size": 1}, {"sha256": "b" * 64}, {"file": "other.zip"}])
def test_promote_rejects_metadata_mismatch(tmp_path: Path, override: dict):
    root, source = _folder(tmp_path)
    before = (source / "latest.json").read_bytes()
    with pytest.raises(release_update.ReleasePromoteError) as caught:
        release_update.promote_candidate(_item(source, **override), root)
    assert caught.value.status == 409
    assert (source / "latest.json").read_bytes() == before


def test_promote_rejects_tampered_or_missing_package(tmp_path: Path):
    root, source = _folder(tmp_path)
    (source / "MVHub-2.0.zip").write_bytes(b"zip 2.X")  # 크기는 같고 지문만 다름
    with pytest.raises(release_update.ReleasePromoteError, match="지문"):
        release_update.promote_candidate(_item(source), root)
    (source / "MVHub-2.0.zip").unlink()
    with pytest.raises(release_update.ReleasePromoteError, match="없습니다"):
        release_update.promote_candidate(_item(source), root)


@pytest.mark.parametrize("changed", ["candidate.json", "latest.json"])
def test_promote_aborts_when_folder_changes_during_verification(tmp_path: Path, monkeypatch, changed: str):
    root, source = _folder(tmp_path)
    before = (source / "latest.json").read_bytes()
    real_verify = release_update._verify_package

    def verify_then_someone_writes(*args):
        real_verify(*args)
        (source / changed).write_text(json.dumps(_manifest("3.0", b"zip 3.0")), encoding="utf-8")

    monkeypatch.setattr(release_update, "_verify_package", verify_then_someone_writes)
    with pytest.raises(release_update.ReleasePromoteError, match="그새 바뀌었습니다"):
        release_update.promote_candidate(_item(source), root)
    if changed == "candidate.json":
        assert (source / "latest.json").read_bytes() == before


def test_promote_waits_for_the_release_lock_then_gives_up(tmp_path: Path, monkeypatch):
    import _winapi

    root, source = _folder(tmp_path)
    monkeypatch.setattr(release_update, "_RELEASE_LOCK_WAIT_SECONDS", 0.3)
    held = _winapi.CreateFile(str(source / "release.lock"), _winapi.GENERIC_READ | _winapi.GENERIC_WRITE, 0, 0, 4, 0, 0)
    try:
        with pytest.raises(release_update.ReleasePromoteError, match="다른 관리자"):
            release_update.promote_candidate(_item(source), root)
    finally:
        _winapi.CloseHandle(held)
    assert release_update.promote_candidate(_item(source), root)["promoted"] is True  # 풀리면 된다


def _failing_replace(effect):
    def fake(tmp, dest):
        effect(Path(tmp), Path(dest))
        raise PermissionError(5, "denied", None, 5)
    return fake


def test_replace_failure_unchanged_reports_and_removes_temp(tmp_path: Path, monkeypatch):
    root, source = _folder(tmp_path)
    before = (source / "latest.json").read_bytes()
    monkeypatch.setattr(release_update.os, "replace", _failing_replace(lambda _t, _d: None))
    with pytest.raises(release_update.ReleasePromoteError) as caught:
        release_update.promote_candidate(_item(source), root)
    assert caught.value.status == 403 and str(source) not in str(caught.value)
    assert (source / "latest.json").read_bytes() == before
    assert not list(source.glob(".latest.json.*.tmp"))


def test_replace_failure_after_new_content_landed_counts_as_done(tmp_path: Path, monkeypatch):
    root, source = _folder(tmp_path)
    real_replace = os.replace
    monkeypatch.setattr(release_update.os, "replace", _failing_replace(lambda t, d: real_replace(t, d)))
    assert release_update.promote_candidate(_item(source), root)["promoted"] is True
    assert (source / "latest.json").read_bytes() == (source / "candidate.json").read_bytes()


def test_replace_failure_with_unexpected_state_keeps_temp(tmp_path: Path, monkeypatch):
    root, source = _folder(tmp_path)
    monkeypatch.setattr(release_update.os, "replace", _failing_replace(lambda _t, d: d.write_text("{}", encoding="utf-8")))
    with pytest.raises(release_update.ReleasePromoteError) as caught:
        release_update.promote_candidate(_item(source), root)
    assert caught.value.status == 500
    assert list(source.glob(".latest.json.*.tmp"))  # 확인 불가 — 복구 자료 보존


def test_promote_refuses_to_overwrite_a_broken_published_manifest(tmp_path: Path):
    root, source = _folder(tmp_path)
    (source / "latest.json").write_text("{broken", encoding="utf-8")
    with pytest.raises(release_update.ReleasePromoteError, match="깨져"):
        release_update.promote_candidate(_item(source), root)
    assert (source / "latest.json").read_text(encoding="utf-8") == "{broken"


def test_promote_refuses_http_sources(tmp_path: Path):
    root, source = _folder(tmp_path)
    (root / "INSTALL_SOURCE.txt").write_text("https://releases.example/mvhub", encoding="utf-8")
    with pytest.raises(release_update.ReleasePromoteError) as caught:
        release_update.promote_candidate(_item(source), root)
    assert caught.value.status == 400


# ── 라우트: 공지 확인은 공유 서버가 ───────────────────────────────────────────

@pytest.fixture
def route(tmp_path: Path, monkeypatch):
    root, source = _folder(tmp_path)
    calls: list = []
    monkeypatch.setattr(router, "_require_local", lambda _request: None)
    monkeypatch.setattr(router, "install_mode", lambda _root: "release")
    monkeypatch.setattr(router, "APP_ROOT", root)
    monkeypatch.setattr(router._proxy, "proxying", lambda: True)
    state = {"item": _item(source)}

    def fake_proxy(method, path, **kwargs):
        calls.append((method, path, kwargs.get("params")))
        if isinstance(state["item"], Exception):
            raise state["item"]
        return state["item"]

    monkeypatch.setattr(router._proxy, "proxy_json", fake_proxy)
    return source, state, calls


def _promote(source: Path, notice_id: str = "release-x"):
    sha = json.loads((source / "candidate.json").read_text(encoding="utf-8"))["sha256"]
    return router.release_update_promote(router.PromoteIn(notice_id=notice_id, sha256=sha.upper()), object())


def test_route_is_sync_so_network_and_nas_waits_stay_off_the_event_loop():
    assert not inspect.iscoroutinefunction(router.release_update_promote)


def test_route_promotes_only_announced_items_confirmed_by_server(route):
    source, state, calls = route
    assert _promote(source)["promoted"] is True
    assert calls[0][:2] == ("GET", "/api/update-notices/admin/item")
    assert calls[0][2]["sha256"] == calls[0][2]["sha256"].lower()


@pytest.mark.parametrize("item,detail", [
    ({"announcement_revision": 0}, "공지된 업데이트만"),
    ({"id": "release-other"}, "항목이 바뀌었습니다"),
])
def test_route_rejects_unannounced_or_other_item(route, item, detail):
    source, state, _calls = route
    state["item"] = {**state["item"], **item}
    before = (source / "latest.json").read_bytes()
    with pytest.raises(HTTPException) as caught:
        _promote(source)
    assert caught.value.status_code == 409 and detail in caught.value.detail
    assert (source / "latest.json").read_bytes() == before


@pytest.mark.parametrize("detail,expected", [
    ("Not Found", "공유 서버를 업데이트한 뒤"),
    ("업데이트 항목이 없습니다", "등록·공지된 후보만"),
])
def test_route_explains_old_server_and_unregistered(route, detail, expected):
    source, state, _calls = route
    state["item"] = HTTPException(status_code=404, detail=detail)
    with pytest.raises(HTTPException) as caught:
        _promote(source)
    assert caught.value.status_code == 409 and expected in caught.value.detail


def test_route_passes_server_denial_through_without_touching_files(route):
    source, state, _calls = route
    state["item"] = HTTPException(status_code=403, detail="관리자만")
    before = (source / "latest.json").read_bytes()
    with pytest.raises(HTTPException) as caught:
        _promote(source)
    assert caught.value.status_code == 403
    assert (source / "latest.json").read_bytes() == before


# ── 관리자 설정 화면의 '새 후보' 한 줄 ─────────────────────────────────────────

def test_candidate_line_only_for_admins_and_only_while_pending(tmp_path: Path, monkeypatch):
    from app.routers import publish

    root, source = _folder(tmp_path)
    monkeypatch.setattr(router, "APP_ROOT", root)
    status = {"install_mode": "release", "current_version": "1.0", "latest_version": "1.0"}
    monkeypatch.setattr(publish, "_is_admin", lambda: False)
    assert router._admin_candidate_version(status) is None
    monkeypatch.setattr(publish, "_is_admin", lambda: True)
    assert router._admin_candidate_version(status) == "2.0"
    (source / "latest.json").write_bytes((source / "candidate.json").read_bytes())
    assert router._admin_candidate_version(status) is None


# ── 잠금 규칙은 Python(promote)·PowerShell(make/select_release)이 같다 ─────────────

def _powershell(script: str) -> subprocess.CompletedProcess:
    io = Path(__file__).resolve().parents[2] / "release" / "release_manifest_io.ps1"
    full = f"$ErrorActionPreference='Stop'\n. '{io}'\n{script}"
    return subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
         "-EncodedCommand", base64.b64encode(full.encode("utf-16-le")).decode("ascii")],
        capture_output=True, timeout=30, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def test_powershell_tools_wait_for_a_python_held_lock(tmp_path: Path):
    import _winapi

    held = _winapi.CreateFile(str(tmp_path / "release.lock"), _winapi.GENERIC_READ | _winapi.GENERIC_WRITE, 0, 0, 4, 0, 0)
    try:
        result = _powershell(f"$l = Open-ReleaseLock -Directory '{tmp_path}' -WaitSeconds 0.5; $l.Dispose()")
    finally:
        _winapi.CloseHandle(held)
    assert result.returncode != 0 and b"locked by another release tool" in result.stderr
    assert _powershell(f"$l = Open-ReleaseLock -Directory '{tmp_path}' -WaitSeconds 0.5; $l.Dispose()").returncode == 0


def test_python_promote_waits_for_a_powershell_held_lock(tmp_path: Path, monkeypatch):
    root, source = _folder(tmp_path)
    monkeypatch.setattr(release_update, "_RELEASE_LOCK_WAIT_SECONDS", 0.5)
    holder = subprocess.Popen(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
         f"$l = [IO.File]::Open('{source / 'release.lock'}','OpenOrCreate','ReadWrite','None'); 'held'; Start-Sleep 20; $l.Dispose()"],
        stdout=subprocess.PIPE, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        assert holder.stdout.readline().strip() == b"held"
        with pytest.raises(release_update.ReleasePromoteError, match="다른 관리자"):
            release_update.promote_candidate(_item(source), root)
    finally:
        holder.kill()
        holder.wait(timeout=10)


def test_manifest_writer_replaces_existing_and_creates_missing(tmp_path: Path):
    target = tmp_path / "latest.json"
    script = (f"Write-ManifestAtomic -Path '{target}' -Bytes ([byte[]](65,66))\n"
              f"Write-ManifestAtomic -Path '{target}' -Bytes ([byte[]](67))")
    result = _powershell(script)
    assert result.returncode == 0, result.stderr
    assert target.read_bytes() == b"C"
    assert not list(tmp_path.glob("*.tmp-*"))
