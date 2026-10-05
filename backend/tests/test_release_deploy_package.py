"""업데이트 탭 개편(Jay 2026-10-05) — NAS 판 목록·판 선택 배포(deploy_package).

후보 줄은 기존 promote_candidate 그대로(test_release_promote.py). 여기서는 후보가 아닌 판(옛 판 = 팀 되돌리기)을
고정한다 — Codex 설계 검토 v1·v2: 화면이 본 뒤 바뀐 폴더 거절, 표지가 이미 그 판이면 아무것도 안 씀(새 후보 보존),
후보만 바뀐 부분 실패를 밝히고 재시도는 같은 원문, 지문만 같은 후보 거절, 깨진 표지 거절, 되돌린 뒤 실제 상태 전이.
"""
from __future__ import annotations

import hashlib
import inspect
import json
import os
import re
import zipfile
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.routers import release_update as router
from app.services import release_update

pytestmark = pytest.mark.skipif(os.name != "nt", reason="릴리스 폴더 잠금은 Windows 공유 모드로 한다")

OLD, PUB, CAND = "2026.10.01-0906", "2026.10.03-0958", "2026.10.05-1252"
CLI_PKG = "runtime/higgsfield/node_modules/@higgsfield/cli/package.json"


def _zip(source: Path, version: str, **meta: str | None) -> Path:
    entries: dict[str, str | None] = {
        "VERSION.txt": version, "hf_cli_version.txt": "1.1.26", CLI_PKG: json.dumps({"version": "1.1.26"}),
    }
    entries.update(meta)
    path = source / f"MVHub-{version}.zip"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("backend/app/main.py", f"# {version}")
        for name, text in entries.items():
            if text is not None:
                archive.writestr(name, text)
    return path


def _write_manifest(source: Path, name: str, release: str, **override) -> dict:
    """make_release 처럼 — created_at 은 제작 시각(초 단위)이라 판 선택으로 만든 원문과 바이트가 다르다."""
    data = (source / f"MVHub-{release}.zip").read_bytes()
    body = {"version": release, "higgsfield_cli_version": "1.1.26", "file": f"MVHub-{release}.zip",
            "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "created_at": "2026-10-05T12:54:52", **override}
    (source / name).write_text(json.dumps(body), encoding="utf-8-sig")
    return body


def _setup(tmp_path: Path, *, published: str | None = PUB, candidate: str | None = CAND,
           installed: str = PUB) -> tuple[Path, Path]:
    root, source = tmp_path / "installed", tmp_path / "releases"
    root.mkdir()
    source.mkdir()
    (root / "VERSION.txt").write_text(installed, encoding="utf-8")
    (root / "INSTALL_SOURCE.txt").write_text(str(source), encoding="utf-8")
    (root / "update_release.bat").write_text("@echo off\r\n", encoding="utf-8")
    for version in (OLD, PUB, CAND):
        _zip(source, version)
    for version, name in ((published, "latest.json"), (candidate, "candidate.json")):
        if version:
            _write_manifest(source, name, version)
    return root, source


def _item(source: Path, version: str, **override) -> dict:
    data = (source / f"MVHub-{version}.zip").read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    return {"id": f"release-{sha}", "version": version, "file": f"MVHub-{version}.zip", "size": len(data),
            "sha256": sha, "announcement_revision": 1, **override}


def _sha(source: Path, name: str) -> str:
    path = source / name
    return json.loads(path.read_text(encoding="utf-8-sig"))["sha256"] if path.is_file() else ""


def _deploy(root: Path, source: Path, version: str, **override) -> dict:
    """화면이 지금 폴더를 본 그대로 요청한다."""
    return release_update.deploy_package(
        _item(source, version, **override), _sha(source, "latest.json"), _sha(source, "candidate.json"), root,
    )


def _snapshot(source: Path) -> dict:
    # release.lock 은 잠금을 잡을 때 생기고 일부러 남긴다(지울 일이 없게) — 내용 비교에서 뺀다
    return {path.name: path.read_bytes() for path in source.iterdir() if path.is_file() and path.name != "release.lock"}


@pytest.fixture(autouse=True)
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(release_update, "UPDATE_STATE_BASE", tmp_path / "state")
    monkeypatch.setattr(release_update, "AUTH_ENABLED", False)
    monkeypatch.setattr(release_update, "_installation_health", lambda *_a, **_k: (True, ""))
    for key in ("MVHUB_UPDATE_MANIFEST", "MVHUB_UPDATE_EXPECT_SHA256", "MVHUB_UPDATE_EXPECT_VERSION"):
        monkeypatch.delenv(key, raising=False)


# ── 판 목록 ────────────────────────────────────────────────────────────────

def test_packages_lists_every_release_newest_first_and_nothing_else(tmp_path: Path):
    root, source = _setup(tmp_path)
    (source / "MVHub-2026.10.06-1000.zip.part-1a2b").write_bytes(b"uploading")
    (source / "MVHub-2026.13.40-9999.zip").write_bytes(b"not a calendar time")
    (source / "MVHub-2026.10.04-1000.zip").mkdir()
    (source / "notes.txt").write_text("x", encoding="utf-8")
    rows = release_update.list_packages(root)
    assert [row["version"] for row in rows] == [CAND, PUB, OLD]
    assert set(rows[0]) == {"file", "version", "size", "modified"}
    assert rows[0]["file"] == f"MVHub-{CAND}.zip" and rows[0]["size"] == (source / rows[0]["file"]).stat().st_size
    assert str(source) not in json.dumps(rows)  # 경로는 내보내지 않는다


def test_packages_and_deploy_refuse_an_http_release_source(tmp_path: Path):
    root, source = _setup(tmp_path)
    (root / "INSTALL_SOURCE.txt").write_text("https://releases.example/mvhub", encoding="utf-8")
    for call in (lambda: release_update.list_packages(root), lambda: _deploy(root, source, OLD)):
        with pytest.raises(release_update.ReleasePromoteError) as caught:
            call()
        assert caught.value.status == 400


# ── 판 지문(package_manifest) ──────────────────────────────────────────────

def test_package_manifest_reads_the_zip_and_is_the_same_every_time(tmp_path: Path):
    root, source = _setup(tmp_path)
    data = (source / f"MVHub-{OLD}.zip").read_bytes()
    first = release_update.package_manifest(f"MVHub-{OLD}.zip", root)
    assert first == {"version": OLD, "higgsfield_cli_version": "1.1.26", "file": f"MVHub-{OLD}.zip",
                     "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "created_at": "2026-10-01T09:06:00"}
    raw = release_update._package_manifest(source, f"MVHub-{OLD}.zip")[1]
    assert raw.startswith(b"\xef\xbb\xbf") and raw == release_update._package_manifest(source, f"MVHub-{OLD}.zip")[1]
    assert release_update._parse_manifest(raw) == {**first}


@pytest.mark.parametrize("meta,detail", [
    ({"VERSION.txt": "2026.10.01-0907"}, "버전이 파일 이름과 다릅니다"),
    ({"hf_cli_version.txt": "1.1.25"}, "CLI 정보가 맞지 않습니다"),
    ({"VERSION.txt": None}, "VERSION.txt 이(가) 없습니다"),
    ({CLI_PKG: None}, "package.json 이(가) 없습니다"),
])
def test_package_manifest_refuses_a_package_select_release_would_refuse(tmp_path: Path, meta: dict, detail: str):
    root, source = _setup(tmp_path)
    _zip(source, OLD, **meta)
    with pytest.raises(release_update.ReleasePromoteError, match=re.escape(detail)) as caught:
        release_update.package_manifest(f"MVHub-{OLD}.zip", root)
    assert caught.value.status == 400


@pytest.mark.parametrize("name,detail", [
    ("..\\MVHub-2026.10.01-0906.zip", "이름"),
    ("MVHub-2026.10.01-0906.zip.part-1", "이름"),
    ("MVHub-2026.02.30-0906.zip", "이름"),
    ("MVHub-2026.10.02-0906.zip", "없습니다"),
])
def test_package_manifest_refuses_bad_names_and_missing_files(tmp_path: Path, name: str, detail: str):
    root, source = _setup(tmp_path)
    with pytest.raises(release_update.ReleasePromoteError, match=detail) as caught:
        release_update.package_manifest(name, root)
    assert caught.value.status == 400 and str(source) not in str(caught.value)


def test_package_manifest_refuses_a_broken_zip(tmp_path: Path):
    root, source = _setup(tmp_path)
    (source / f"MVHub-{OLD}.zip").write_bytes(b"not a zip")
    with pytest.raises(release_update.ReleasePromoteError, match="깨져"):
        release_update.package_manifest(f"MVHub-{OLD}.zip", root)


# ── 판 선택 배포(deploy_package) ───────────────────────────────────────────

def test_deploying_an_older_release_rolls_back_the_team_like_select_release(tmp_path: Path):
    root, source = _setup(tmp_path)
    before = (source / "latest.json").read_bytes()
    result = _deploy(root, source, OLD)
    assert result == {"promoted": True, "already": False, "version": OLD, "rolled_back": True}
    latest, candidate = (source / "latest.json").read_bytes(), (source / "candidate.json").read_bytes()
    assert latest == candidate == release_update._package_manifest(source, f"MVHub-{OLD}.zip")[1]  # 같은 원문 양쪽
    backups = list((source / "latest-backups").glob("latest.previous-*.json"))
    assert len(backups) == 1 and backups[0].read_bytes() == before
    assert not list(source.glob(".*.tmp"))
    view = release_update.release_overview(root)
    assert (view["published"]["version"], view["published"]["file"], view["pending"]) == (OLD, f"MVHub-{OLD}.zip", False)


def test_deploying_a_newer_non_candidate_release_is_not_a_rollback(tmp_path: Path):
    root, source = _setup(tmp_path, published=OLD, candidate=OLD)
    assert _deploy(root, source, PUB)["rolled_back"] is False


@pytest.mark.parametrize("stale", ["published", "candidate"])
def test_deploy_refuses_when_the_folder_changed_after_the_tab_read_it(tmp_path: Path, stale: str):
    """Codex P1 — 화면이 본 뒤 다른 관리자가 후보를 올렸으면, 판 선택이 그 새 후보를 말없이 지우지 않는다."""
    root, source = _setup(tmp_path)
    before = _snapshot(source)
    seen_pub, seen_cand = _sha(source, "latest.json"), _sha(source, "candidate.json")
    if stale == "candidate":
        seen_cand = _sha(source, "latest.json")  # 화면은 후보가 없을 때(후보=표지) 읽었다
    else:
        seen_pub = "f" * 64
    with pytest.raises(release_update.ReleasePromoteError, match="그새 바뀌었습니다") as caught:
        release_update.deploy_package(_item(source, OLD), seen_pub, seen_cand, root)
    assert caught.value.status == 409 and _snapshot(source) == before


def test_deploying_the_live_release_writes_nothing_and_keeps_the_new_candidate(tmp_path: Path):
    root, source = _setup(tmp_path)
    before = _snapshot(source)
    assert _deploy(root, source, PUB) == {"promoted": False, "already": True, "version": PUB, "rolled_back": False}
    assert _snapshot(source) == before and not (source / "latest-backups").exists()


def test_deploy_aborts_when_the_folder_changes_during_verification(tmp_path: Path, monkeypatch):
    root, source = _setup(tmp_path)
    real = release_update._package_manifest

    def hash_then_someone_publishes(folder, file):
        value = real(folder, file)
        _write_manifest(source, "candidate.json", PUB)
        return value

    monkeypatch.setattr(release_update, "_package_manifest", hash_then_someone_publishes)
    before_latest = (source / "latest.json").read_bytes()
    with pytest.raises(release_update.ReleasePromoteError, match="그새 바뀌었습니다"):
        _deploy(root, source, OLD)
    assert (source / "latest.json").read_bytes() == before_latest


def _replace_fails_for_latest(monkeypatch, effect=None):
    real = os.replace

    def flaky(tmp, dest):
        if Path(dest).name == "latest.json":
            if effect:
                effect(Path(dest))
            raise PermissionError(5, "denied", None, 5)
        return real(tmp, dest)

    monkeypatch.setattr(release_update.os, "replace", flaky)


def test_candidate_switched_but_published_unchanged_says_so_and_retry_finishes(tmp_path: Path, monkeypatch):
    """Codex P2 — 후보만 바뀐 부분 실패를 '배포 안 됨'으로만 말하지 않는다. 재시도는 후보==대상 경로로 같은 원문."""
    root, source = _setup(tmp_path)
    before_latest = (source / "latest.json").read_bytes()
    _replace_fails_for_latest(monkeypatch)
    with pytest.raises(release_update.ReleasePromoteError, match=f"후보 파일은 v{OLD} 이지만 공개 표지는 그대로") as caught:
        _deploy(root, source, OLD)
    assert caught.value.status == 403 and str(source) not in str(caught.value)
    switched = (source / "candidate.json").read_bytes()
    assert json.loads(switched.decode("utf-8-sig"))["version"] == OLD
    assert (source / "latest.json").read_bytes() == before_latest
    monkeypatch.undo()
    assert _deploy(root, source, OLD)["promoted"] is True
    assert (source / "latest.json").read_bytes() == (source / "candidate.json").read_bytes() == switched


def test_unconfirmed_published_result_is_not_reported_as_unchanged(tmp_path: Path, monkeypatch):
    root, source = _setup(tmp_path)
    _replace_fails_for_latest(monkeypatch, effect=lambda dest: dest.write_text("{}", encoding="utf-8"))
    with pytest.raises(release_update.ReleasePromoteError, match="확인할 수 없습니다") as caught:
        _deploy(root, source, OLD)
    assert caught.value.status == 500


def _replace_fails_for_candidate(monkeypatch, effect=None):
    real = os.replace

    def flaky(tmp, dest):
        if Path(dest).name == "candidate.json":
            if effect:
                effect(Path(dest))
            raise PermissionError(5, "denied", None, 5)
        return real(tmp, dest)

    monkeypatch.setattr(release_update.os, "replace", flaky)


def test_candidate_switch_failure_leaves_both_manifests_unchanged(tmp_path: Path, monkeypatch):
    root, source = _setup(tmp_path)
    before = {name: (source / name).read_bytes() for name in ("latest.json", "candidate.json")}
    _replace_fails_for_candidate(monkeypatch)
    with pytest.raises(release_update.ReleasePromoteError) as caught:
        _deploy(root, source, OLD)
    assert caught.value.status == 403
    assert {name: (source / name).read_bytes() for name in before} == before
    assert not list(source.glob(".candidate.json.*.tmp"))


def test_unconfirmed_candidate_switch_says_published_is_untouched(tmp_path: Path, monkeypatch):
    root, source = _setup(tmp_path)
    before_latest = (source / "latest.json").read_bytes()
    _replace_fails_for_candidate(monkeypatch, effect=lambda dest: dest.write_text("{}", encoding="utf-8"))
    with pytest.raises(release_update.ReleasePromoteError, match="후보 파일 교체 결과를 확인할 수 없습니다") as caught:
        _deploy(root, source, OLD)
    assert caught.value.status == 500 and (source / "latest.json").read_bytes() == before_latest


def test_backup_failure_writes_nothing(tmp_path: Path):
    root, source = _setup(tmp_path)
    (source / "latest-backups").write_text("a file where the backup folder should be", encoding="utf-8")
    before = _snapshot(source)
    with pytest.raises(release_update.ReleasePromoteError):
        _deploy(root, source, OLD)
    assert _snapshot(source) == before


@pytest.mark.parametrize("override", [{"version": "2026.10.01-0907"}, {"file": "MVHub-2026.10.01-0907.zip"}, {"size": 1}])
def test_a_candidate_with_the_same_sha_but_other_fields_is_refused(tmp_path: Path, override: dict):
    """Codex v2 조건 — 후보 원문을 재사용하기 전 지문만이 아니라 버전·파일·크기까지 같아야 한다."""
    root, source = _setup(tmp_path)
    _write_manifest(source, "candidate.json", OLD, **override)
    before = _snapshot(source)
    with pytest.raises(release_update.ReleasePromoteError, match="후보가 바뀌었습니다"):
        _deploy(root, source, OLD)
    assert _snapshot(source) == before


def test_a_package_that_differs_from_the_announced_item_is_refused(tmp_path: Path):
    root, source = _setup(tmp_path)
    before = _snapshot(source)
    with pytest.raises(release_update.ReleasePromoteError, match="공지한 판과 다릅니다"):
        _deploy(root, source, OLD, size=1)
    assert _snapshot(source) == before


@pytest.mark.parametrize("name", ["candidate.json", "latest.json"])
def test_broken_or_unreadable_manifests_are_refused_not_repaired(tmp_path: Path, name: str):
    root, source = _setup(tmp_path)
    (source / name).write_text("{broken", encoding="utf-8")
    with pytest.raises(release_update.ReleasePromoteError, match="깨져"):
        release_update.deploy_package(_item(source, OLD), "", "", root)
    assert (source / name).read_text(encoding="utf-8") == "{broken"
    (source / name).unlink()
    (source / name).mkdir()  # 읽기 실패(없음이 아님)
    with pytest.raises(release_update.ReleasePromoteError, match="읽을 수 없습니다"):
        release_update.deploy_package(_item(source, OLD), "", "", root)


def test_first_publish_into_an_empty_folder(tmp_path: Path):
    root, source = _setup(tmp_path, published=None, candidate=None)
    assert _deploy(root, source, PUB)["promoted"] is True
    assert (source / "latest.json").read_bytes() == (source / "candidate.json").read_bytes()
    assert not (source / "latest-backups").exists()


# ── 되돌린 뒤 실제 상태 전이(Codex 시험 보강) ──────────────────────────────

def test_rollback_moves_a_pc_using_the_cancelled_candidate_to_the_public_release(tmp_path: Path, monkeypatch):
    root, source = _setup(tmp_path, installed=CAND)
    first = release_update.get_status(refresh=True, root=root)
    assert (first["state"], first.get("candidate")) == ("up_to_date", True)
    _deploy(root, source, OLD)
    cached = release_update.get_status(root=root)
    assert cached.get("candidate") is True  # 다시 확인하기 전까지는 마지막 기록
    fresh = release_update.get_status(refresh=True, root=root)
    assert (fresh["state"], fresh["latest_version"], fresh["can_update"]) == ("available", OLD, True)
    launched: list[dict] = []
    monkeypatch.setattr(release_update, "_launch_bootstrap", lambda _s, env, _l: launched.append(env) or 1)
    release_update.start_update(activity_check=lambda: 0, root=root)
    assert launched and launched[0]["MVHUB_UPDATE_MANIFEST"] == "latest.json"
    assert "MVHUB_UPDATE_EXPECT_SHA256" not in launched[0] and "MVHUB_UPDATE_EXPECT_VERSION" not in launched[0]


def test_rollback_offers_the_older_release_to_a_teammate_pc(tmp_path: Path):
    root, source = _setup(tmp_path, installed=PUB)
    _deploy(root, source, OLD)
    status = release_update.get_status(refresh=True, root=root)
    assert (status["state"], status["latest_version"]) == ("available", OLD)


# ── 라우트 ────────────────────────────────────────────────────────────────

@pytest.fixture
def route(tmp_path: Path, monkeypatch):
    root, source = _setup(tmp_path)
    calls: list = []
    monkeypatch.setattr(router, "_require_local", lambda _request: None)
    monkeypatch.setattr(router, "install_mode", lambda _root: "release")
    monkeypatch.setattr(router, "APP_ROOT", root)
    monkeypatch.setattr(router._proxy, "proxying", lambda: True)
    state = {"item": _item(source, OLD)}

    def fake_proxy(method, path, **kwargs):
        calls.append((method, path, kwargs.get("params")))
        if isinstance(state["item"], Exception):
            raise state["item"]
        return state["item"]

    monkeypatch.setattr(router._proxy, "proxy_json", fake_proxy)
    return source, state, calls


def _deploy_route(source: Path, item: dict) -> dict:
    body = router.DeployPackageIn(notice_id=item["id"], sha256=item["sha256"].upper(),
                                  expect_published_sha=_sha(source, "latest.json"),
                                  expect_candidate_sha=_sha(source, "candidate.json"))
    return router.release_update_deploy_package(body, object())


def test_new_routes_are_sync_so_nas_and_network_waits_stay_off_the_event_loop():
    for handler in (router.release_update_packages, router.release_update_package_manifest,
                    router.release_update_deploy_package):
        assert not inspect.iscoroutinefunction(handler)


def test_route_deploys_only_items_the_server_says_were_announced(route):
    source, state, calls = route
    assert _deploy_route(source, state["item"])["rolled_back"] is True
    assert calls[0][:2] == ("GET", "/api/update-notices/admin/item")
    assert calls[0][2]["sha256"] == state["item"]["sha256"]


@pytest.mark.parametrize("change,detail", [
    ({"announcement_revision": 0}, "공지된 업데이트만"),
    ({"id": "release-other"}, "항목이 바뀌었습니다"),
])
def test_route_refuses_unannounced_or_other_items_without_touching_files(route, change, detail):
    source, state, _calls = route
    item = state["item"]
    state["item"] = {**item, **change}
    before = _snapshot(source)
    with pytest.raises(HTTPException) as caught:
        _deploy_route(source, item)
    assert caught.value.status_code == 409 and detail in caught.value.detail
    assert _snapshot(source) == before


def test_route_passes_a_server_denial_through(route):
    source, state, _calls = route
    item = state["item"]
    state["item"] = HTTPException(status_code=403, detail="관리자만")
    with pytest.raises(HTTPException) as caught:
        _deploy_route(source, item)
    assert caught.value.status_code == 403


def test_packages_and_manifest_routes_return_names_and_errors_without_paths(route):
    source, _state, _calls = route
    rows = router.release_update_packages(object())
    assert [row["version"] for row in rows] == [CAND, PUB, OLD] and str(source) not in json.dumps(rows)
    manifest = router.release_update_package_manifest(router.PackageIn(file=f"MVHub-{OLD}.zip"), object())
    assert manifest["version"] == OLD
    with pytest.raises(HTTPException) as caught:
        router.release_update_package_manifest(router.PackageIn(file="MVHub-2026.10.02-0906.zip"), object())
    assert caught.value.status_code == 400 and str(source) not in caught.value.detail
