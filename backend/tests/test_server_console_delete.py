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
    commands = []

    def helper(*args, **kwargs):
        commands.append(args[3])
        return {"ok": True}

    monkeypatch.setattr(release, "helper", helper)
    monkeypatch.setattr(release, "delete_work", lambda *a: (0, {"deleted": True}))

    def run_job(_inst, _id, recompute, work):
        assert actions.same_target(plan, recompute())
        assert work(root, lambda _: None) == (0, {"deleted": True})
        return 0

    monkeypatch.setattr(jobs, "run_job", run_job)
    assert job_main.run_release(inst, "a" * 32, request, "token") == 0
    assert commands == ["read"]  # 전체 지문은 마지막 삭제 잠금에서 다시 검사한다.


def notice(index=1, **changes):
    return {"id": f"notice-{index}", "file": f"release-{index}.zip", "sha256": f"{index:064x}",
            "version": str(index), **changes}


def test_notice_lookup_distinguishes_complete_truncated_and_malformed(monkeypatch):
    first = notice()
    assert release.find_notice_for_file({}, "token", first["file"].upper(), [first]) == (first, True)
    assert release.find_notice_for_file({}, "token", "absent.zip", [first]) == (None, True)
    rows = [notice(i) for i in range(1, 6)]
    assert release.find_notice_for_file({}, "token", "absent.zip", rows) == (None, False)
    with pytest.raises(release.ReleaseError, match="여럿"):
        release.find_notice_for_file({}, "token", first["file"], [first, notice(2, file=first["file"])])
    monkeypatch.setattr(release.server_api, "call", lambda *a: (200, [first, {"sha256": "bad"}]))
    with pytest.raises(release.ReleaseError, match="형식"):
        release.list_notices({}, "token")


@pytest.mark.parametrize("response,expected,auth", [
    ((200, {"removed": True}), 0, False), ((200, {"removed": False}), 0, False),
    ((None, None), 3, False), ((503, {}), 3, False), ((200, {}), 3, False),
    ((200, {"removed": "yes"}), 3, False), ((204, None), 3, False),
    ((401, {}), 1, True), ((403, {}), 1, True), ((409, {}), 1, False),
])
def test_remove_response_uncertainty_and_auth(monkeypatch, response, expected, auth):
    monkeypatch.setattr(release.server_api, "call", lambda *a: response)
    code, extra = release.remove_work({"server": {}, "notice_id": "n1"}, "token", lambda _: None)
    assert code == expected and bool(extra.get("auth_expired")) == auth
    assert bool(extra.get("outcome_unknown")) == (expected == 3)


def removal_plans(inst, count=3):
    return [actions.plan_notice_action(inst, "release-remove", {}, notice(i), notice(i)["sha256"])
            for i in range(1, count + 1)]


@pytest.mark.parametrize("invalid", ["empty", "kind", "file", "notice", "source", "server", "root", "nested"])
def test_batch_plan_refuses_invalid_or_mixed_selection(tmp_path, invalid):
    from dataclasses import replace

    inst = make_inst(tmp_path)
    release.save_source(inst, str(tmp_path / "packages"))
    plans = removal_plans(inst, 2)
    if invalid == "empty":
        plans = []
    else:
        second = plans[1]
        if invalid == "root":
            plans[1] = replace(second, root="other")
        elif invalid == "kind":
            plans[1] = replace(second, kind="release-delete")
        else:
            changes = {"file": {"file": plans[0].params["file"].upper()},
                       "notice": {"notice_id": plans[0].params["notice_id"].upper()},
                       "source": {"release_dir": "elsewhere"}, "server": {"server": {"pid": 2}},
                       "nested": {"items": []}}[invalid]
            plans[1] = replace(second, params={**second.params, **changes})
    assert isinstance(actions.plan_release_batch(inst, "release-remove", plans), actions.Refusal)


def test_batch_delete_summary_contains_every_confirmed_file(package):
    root, path = package
    inst = make_inst(root)
    fields = snapshot(root, path)
    plans = [actions.plan_release_delete(inst, {}, str(path.parent), {}, fields, None)]
    second = path.with_name("MVHub-2026.10.19-1200.zip")
    second.write_bytes(b"older")
    second.with_suffix(".validation.json").write_text("{}", encoding="utf-8")
    plans.append(actions.plan_release_delete(inst, {}, str(path.parent), {}, snapshot(root, second), None))
    batch = actions.plan_release_batch(inst, "release-delete", plans)
    assert isinstance(batch, actions.Plan)
    assert batch.params["items"] == [plan.params for plan in plans]
    for plan in plans:
        for filename in (plan.params["file"], *plan.params["sidecars"]):
            assert filename in "\n".join(batch.summary)
    assert "되돌리지" in "\n".join(batch.summary)


@pytest.mark.parametrize("failure", ["known", "unknown", "auth", "exception"])
def test_batch_stops_with_durable_partial_results(tmp_path, failure):
    items = [notice(i) for i in range(1, 4)]
    seen = []

    def work(item):
        index = len(seen)
        before = json.loads((tmp_path / "batch.json").read_text("utf-8"))
        assert before["pending"] and before["current_index"] == index
        if index:
            assert before["batch_results"][0]["status"] == "succeeded"
        seen.append(item["file"])
        if index == 0:
            return 0, {"removed": True}
        if failure == "exception":
            raise OSError("simulated failure")
        return (3 if failure == "unknown" else 1), {"error": "stopped", "auth_expired": failure == "auth"}

    code, extra = release.batch_work(tmp_path, items, work, lambda _: None)
    assert code == (3 if failure in ("unknown", "exception") else 1)
    assert seen == [item["file"] for item in items[:2]]
    assert [row["status"] for row in extra["batch_results"]] == [
        "succeeded", "unconfirmed" if code == 3 else "failed", "not_started"]
    saved = json.loads((tmp_path / "batch.json").read_text("utf-8"))
    assert saved["complete"] and not saved["pending"] and saved["batch_results"] == extra["batch_results"]
    assert extra["batch_total"] == 3
    assert bool(extra.get("auth_expired")) == (failure == "auth")


@pytest.mark.parametrize("fail_at", [1, 2, 3])
def test_batch_stops_if_progress_cannot_be_saved(tmp_path, monkeypatch, fail_at):
    original = release._atomic_text
    writes, executed = [], []

    def write(path, text):
        writes.append(text)
        if len(writes) == fail_at:
            raise PermissionError("simulated")
        original(path, text)

    monkeypatch.setattr(release, "_atomic_text", write)

    def work(item):
        executed.append(item["file"])
        return 0, {"removed": True}

    code, extra = release.batch_work(tmp_path, [notice(1), notice(2)], work, lambda _: None)
    assert code == (3 if fail_at == 2 else 1)
    assert len(executed) == (0 if fail_at == 1 else 1)
    assert extra["batch_results"][1]["status"] == "not_started"


@pytest.mark.parametrize("change", ["source", "notice", "server", "unresolved"])
def test_batch_runner_rechecks_each_target_before_write(tmp_path, monkeypatch, change):
    inst = make_inst(tmp_path)
    source = str(tmp_path / "packages")
    release.save_source(inst, source)
    plans = removal_plans(inst)
    batch = actions.plan_release_batch(inst, "release-remove", plans)
    executed = []
    monkeypatch.setattr(release.server_api, "verify_server", lambda *a: {"pid": 9}
                        if executed and change == "server" else {})
    monkeypatch.setattr(jobs, "unresolved_jobs", lambda *a, **k: ["other"]
                        if executed and change == "unresolved" else [])

    def find(server, token, sha):
        item = next(item for item in [notice(i) for i in range(1, 4)] if item["sha256"] == sha)
        return {**item, "id": "changed"} if executed and change == "notice" else item

    monkeypatch.setattr(release, "find_notice", find)

    def remove(params, token, say):
        executed.append(params["file"])
        if change == "source":
            release.save_source(inst, str(tmp_path / "changed"))
        return 0, {"removed": True}

    monkeypatch.setattr(release, "remove_work", remove)

    def run_job(_inst, _id, recompute, work):
        assert actions.same_target(batch, recompute())
        code, extra = work(tmp_path, lambda _: None)
        assert code == 1 and executed == [notice(1)["file"]]
        assert [row["status"] for row in extra["batch_results"]] == ["succeeded", "failed", "not_started"]
        return code

    monkeypatch.setattr(jobs, "run_job", run_job)
    assert job_main.run_release(inst, "a" * 32, {"kind": batch.kind, "plan": batch.to_json()}, "token") == 1


@pytest.mark.parametrize("change_second", [False, True])
def test_batch_delete_runs_final_locked_guard_without_middle_hash(package, monkeypatch, change_second):
    import base64

    root, first = package
    inst = make_inst(root)
    release.save_source(inst, str(first.parent))
    paths = [first, first.with_name("MVHub-2026.10.19-1200.zip"), first.with_name("MVHub-2026.10.18-1200.zip")]
    for path in paths[1:]:
        path.write_bytes(b"old release")
    plans = [actions.plan_release_delete(inst, {}, str(first.parent), {}, snapshot(root, path), None)
             for path in paths]
    batch = actions.plan_release_batch(inst, "release-delete", plans)
    commands = []
    monkeypatch.setattr(release.server_api, "verify_server", lambda *a: {})
    monkeypatch.setattr(release, "find_delete_notice", lambda *a: None)
    monkeypatch.setattr(jobs, "unresolved_jobs", lambda *a, **k: [])

    def helper(inst, scratch, source, command, *args, **kwargs):
        commands.append(command)
        if command == "read":
            return {"ok": True}
        assert command == "delete"
        expected = json.loads(base64.b64decode(args[0]))
        if change_second and expected["file"] == paths[1].name:
            paths[1].write_bytes(b"replaced after confirmation")
        try:
            return release_helper.delete_package(ru, root, expected["file"], expected)
        except ru.ReleasePromoteError as exc:
            return {"ok": False, "error": str(exc), "status": exc.status}

    monkeypatch.setattr(release, "helper", helper)

    def run_job(_inst, _id, recompute, work):
        assert actions.same_target(batch, recompute())
        code, extra = work(root, lambda _: None)
        assert "delete-info" not in commands and not first.exists()
        if change_second:
            assert code == 1 and paths[1].exists() and paths[2].exists()
            assert [row["status"] for row in extra["batch_results"]] == ["succeeded", "failed", "not_started"]
        else:
            assert code == 0 and not any(path.exists() for path in paths)
            assert all(row["status"] == "succeeded" for row in extra["batch_results"])
        return code

    monkeypatch.setattr(jobs, "run_job", run_job)
    assert job_main.run_release(inst, "a" * 32, {"kind": batch.kind, "plan": batch.to_json()}, "token") == \
        (1 if change_second else 0)


@pytest.mark.parametrize("damage", [None, "file", "status", "total", "pending", "oversized", "missing"])
def test_dead_batch_runner_recovers_only_valid_progress(tmp_path, damage):
    inst = make_inst(tmp_path)
    release.save_source(inst, str(tmp_path / "packages"))
    batch = actions.plan_release_batch(inst, "release-remove", removal_plans(inst))
    job_id = "d" * 32
    job = jobs.job_dir(inst, job_id)
    job.mkdir(parents=True)
    jobs.write_json(job / "request.json", {"kind": batch.kind, "plan": batch.to_json()})
    jobs.write_json(job / "state.json", {"status": "running", "pid": 123})
    saved = {"batch_total": 3, "current_index": 1, "pending": True, "complete": False,
             "batch_results": [
                 {"file": notice(1)["file"], "status": "succeeded", "exit_code": 0},
                 {"file": notice(2)["file"], "status": "not_started"},
                 {"file": notice(3)["file"], "status": "not_started"}]}
    if damage == "file":
        saved["batch_results"][0]["file"] = "other.zip"
    elif damage == "status":
        saved["batch_results"][2]["status"] = "succeeded"
    elif damage == "total":
        saved["batch_total"] = 4
    elif damage == "pending":
        saved["pending"] = "true"
    elif damage == "oversized":
        saved["extra"] = "x" * 1_000_001
    if damage != "missing":
        jobs.write_json(job / "batch.json", saved)
    state = jobs.read_job(inst, job_id, alive=lambda *args: False)
    assert state["status"] == "check_needed" and jobs.needs_check(state)
    if damage is None:
        assert state["batch_total"] == 3
        assert [row["status"] for row in state["batch_results"]] == ["succeeded", "unconfirmed", "not_started"]
    else:
        assert "batch_results" not in state


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
