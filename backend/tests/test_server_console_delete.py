"""관리 도구의 파일 삭제: 모든 쓰기는 pytest 임시 폴더 안에서만 실행한다."""
import json
import os
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from server_console import actions, install, job_main, jobs, release, release_helper  # noqa: E402
from app.services import release_update as ru  # noqa: E402

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows release lock")


@pytest.fixture
def package(tmp_path):
    folder = tmp_path / "packages"
    folder.mkdir()
    (tmp_path / "INSTALL_SOURCE.txt").write_text(str(folder), encoding="utf-8")
    path = folder / "MVHub-2026.10.20-1200.zip"
    path.write_bytes(b"damaged zip may still be deleted")
    for suffix in (".candidate.json", ".validation.json"):
        path.with_suffix(suffix).write_text("{}", encoding="utf-8")
    return tmp_path, path


def snapshot(root, path):
    return release_helper.delete_package(ru, root, path.name)["manifest"]


def make_inst(root):
    (root / "logs").mkdir(exist_ok=True)
    return install.Installation(root=root, data_dir=root / "data", log_dir=root / "data" / "logs",
                                content_db=root / "data" / "db", port=8010, port_known=False,
                                python=Path(sys.executable), problems=())


def test_delete_exact_bundle_without_markers_and_accepts_damaged_zip(package):
    root, path = package
    for name in ("server-location.json", "unrelated.zip", "latest-backup.json"):
        (path.parent / name).write_text("keep", encoding="utf-8")
    fields = snapshot(root, path)
    result = release_helper.delete_package(ru, root, path.name, fields)
    assert result["ok"] and result["deleted"]
    assert set(result["deleted_files"]) == {path.name, path.with_suffix(".candidate.json").name,
                                           path.with_suffix(".validation.json").name}
    assert {p.name for p in path.parent.iterdir()} == {"release.lock", "server-location.json",
                                                     "unrelated.zip", "latest-backup.json"}


@pytest.mark.parametrize("marker", ["latest.json", "candidate.json"])
@pytest.mark.parametrize("match", ["file", "sha"])
def test_delete_refuses_current_marker_by_filename_or_sha(package, marker, match):
    root, path = package
    fields = snapshot(root, path)
    mark = {**fields, "file": path.name if match == "file" else "MVHub-2026.10.19-1200.zip",
            "sha256": "a" * 64 if match == "file" else fields["sha256"]}
    (path.parent / marker).write_text(json.dumps(mark), encoding="utf-8")
    with pytest.raises(ru.ReleasePromoteError, match="삭제할 수 없습니다"):
        release_helper.delete_package(ru, root, path.name, fields)
    assert path.exists() and path.with_suffix(".candidate.json").exists()


@pytest.mark.parametrize("change", ["zip", "sidecar", "new_sidecar", "corrupt_marker"])
def test_delete_rechecks_confirmed_files_and_markers(package, change):
    root, path = package
    if change == "new_sidecar":
        path.with_suffix(".validation.json").unlink()
    fields = snapshot(root, path)
    target = {"zip": path, "sidecar": path.with_suffix(".candidate.json"),
              "new_sidecar": path.with_suffix(".validation.json"),
              "corrupt_marker": path.parent / "latest.json"}[change]
    target.write_bytes(b"changed")
    with pytest.raises(ru.ReleasePromoteError):
        release_helper.delete_package(ru, root, path.name, fields)
    assert path.exists()


@pytest.mark.parametrize("name", ["../MVHub-2026.10.20-1200.zip", "sub/MVHub-2026.10.20-1200.zip",
                                  "C:\\other.zip", "latest.json"])
def test_delete_refuses_non_release_paths(package, name):
    root, path = package
    with pytest.raises(ru.ReleasePromoteError):
        release_helper.delete_package(ru, root, name)
    assert path.exists()


def test_delete_rejects_linked_sidecar_before_any_unlink(package, monkeypatch):
    root, path = package
    sidecar = path.with_suffix(".candidate.json")
    original = Path.lstat

    def linked(item):
        info = original(item)
        if item == sidecar:
            from types import SimpleNamespace
            return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400)
        return info

    monkeypatch.setattr(Path, "lstat", linked)
    with pytest.raises(ru.ReleasePromoteError, match="연결 지점"):
        snapshot(root, path)
    assert path.exists()


def test_partial_delete_is_unconfirmed_and_preserves_remaining_files(package, monkeypatch):
    root, path = package
    fields = snapshot(root, path)
    original = Path.unlink

    def fail_sidecar(item, *args, **kwargs):
        if item == path.with_suffix(".candidate.json"):
            raise PermissionError("simulated")
        return original(item, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_sidecar)
    answer = release_helper.delete_package(ru, root, path.name, fields)
    assert not answer["ok"] and answer["outcome_unknown"] and answer["deleted_files"] == [path.name]
    assert path.with_suffix(".candidate.json").exists() and not path.exists()
    monkeypatch.setattr(release, "find_delete_notice", lambda *a: None)
    monkeypatch.setattr(release, "helper", lambda *a, **k: answer)
    inst = make_inst(root)
    params = {**fields, "server": {}, "release_dir": str(path.parent)}
    code, extra = release.delete_work(inst, root, params, "token", lambda _: None)
    assert code == 3 and jobs.needs_check({"status": "finished", "exit_code": code})
    assert extra["remaining_files"]


def test_plan_requires_notice_removal_and_keeps_exact_confirmed_files(package):
    root, path = package
    fields = snapshot(root, path)
    inst = make_inst(root)
    plan = actions.plan_release_delete(inst, {}, str(path.parent), {}, fields, None)
    assert isinstance(plan, actions.Plan) and plan.params["sidecars"] == fields["sidecars"]
    assert path.name in " ".join(plan.summary) and "휴지통" in " ".join(plan.summary)
    refused = actions.plan_release_delete(inst, {}, str(path.parent), {}, fields, {"announcement_revision": 0})
    assert isinstance(refused, actions.Refusal) and "[해제]" in refused.reasons[0]
    assert "release-delete" in actions.AUTH_KINDS


def test_delete_notice_matches_stale_file_even_if_sha_changed(monkeypatch):
    notice = {"file": "MVHub-2026.10.20-1200.zip", "sha256": "a" * 64}
    monkeypatch.setattr(release, "list_notices", lambda *a: [notice])
    monkeypatch.setattr(release, "find_notice", lambda *a: None)
    assert release.find_delete_notice({}, "token", {"file": notice["file"].upper(), "sha256": "b" * 64}) == notice


def test_delete_notice_uses_direct_lookup_beyond_five_and_refuses_incomplete_list(monkeypatch):
    notice = {"file": "old.zip", "sha256": "a" * 64}
    monkeypatch.setattr(release, "find_notice", lambda *a: notice)
    assert release.find_delete_notice({}, "token", notice) == notice
    monkeypatch.setattr(release, "find_notice", lambda *a: None)
    monkeypatch.setattr(release, "list_notices", lambda *a: [{"file": f"other{i}.zip"} for i in range(5)])
    with pytest.raises(release.ReleaseError, match="일부만"):
        release.find_delete_notice({}, "token", notice)


@pytest.mark.parametrize("code,out", [(1, ""), (0, "broken response"), (None, "")])
def test_delete_helper_lost_reply_remains_unconfirmed(package, monkeypatch, code, out):
    root, path = package
    fields = snapshot(root, path)
    inst = make_inst(root)
    monkeypatch.setattr(release, "run_command", lambda *a: (code, out))
    monkeypatch.setattr(release, "find_delete_notice", lambda *a: None)
    result, _ = release.delete_work(inst, root, {**fields, "release_dir": str(path.parent), "server": {}},
                                    "token", lambda _: None)
    assert result == 3
    assert path.exists()


def test_delete_reports_concurrent_notice_instead_of_silent_success(package, monkeypatch):
    root, path = package
    fields = snapshot(root, path)
    seen = iter([None, {"id": "new"}])
    monkeypatch.setattr(release, "find_delete_notice", lambda *a: next(seen))
    monkeypatch.setattr(release, "helper", lambda *a, **k: {"ok": True, "deleted": True, "file": path.name})
    code, extra = release.delete_work(make_inst(root), root, {**fields, "server": {}, "release_dir": str(path.parent)},
                                      "token", lambda _: None)
    assert code == 3 and "새 팀원 알림" in extra["error"]


def test_runner_recomputes_delete_target_before_work(package, monkeypatch):
    root, path = package
    fields = snapshot(root, path)
    inst = make_inst(root)
    release.save_source(inst, str(path.parent))
    plan = actions.plan_release_delete(inst, {}, str(path.parent), {}, fields, None)
    request = {"kind": plan.kind, "plan": plan.to_json()}
    monkeypatch.setattr(release.server_api, "verify_server", lambda *a: {})
    monkeypatch.setattr(release, "find_delete_notice", lambda *a: None)
    monkeypatch.setattr(jobs, "unresolved_jobs", lambda *a, **k: [])
    monkeypatch.setattr(release, "helper", lambda *a, **k: {"ok": True, "manifest": fields})
    monkeypatch.setattr(release, "delete_work", lambda *a: (0, {"deleted": True}))

    def run_job(_inst, _id, recompute, work):
        assert actions.same_target(plan, recompute())
        assert work(root, lambda _: None) == (0, {"deleted": True})
        return 0

    monkeypatch.setattr(jobs, "run_job", run_job)
    assert job_main.run_release(inst, "a" * 32, request, "token") == 0


def test_remove_check_only_uses_latest_successful_job_in_same_source(tmp_path, monkeypatch):
    inst = make_inst(tmp_path)
    ids = ["a" * 32, "b" * 32, "c" * 32]
    monkeypatch.setattr(jobs, "recent_jobs", lambda *a: ids)
    kinds = ["release-deploy", "release-remove", "release-remove"]
    for job_id, kind, file in zip(ids, kinds, ["one.zip", "one.zip", "two.zip"]):
        folder = jobs.job_dir(inst, job_id)
        folder.mkdir(parents=True)
        jobs.write_json(folder / "request.json", {"kind": kind, "plan": {"params": {
            "file": file, "release_dir": "source"}}})
        jobs.write_json(folder / "state.json", {"status": "finished", "exit_code": 0})
    assert release.removed_files(inst, "source") == ["two.zip"]
    assert release.removed_files(inst, "different") == []
