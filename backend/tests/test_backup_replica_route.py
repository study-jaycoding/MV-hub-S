"""서버 백업 복사 위치 — 복사기 도우미(지문·형식·수용·겹침·정리·결과)와 관리자 라우트(2026-10-02 설계 r5)."""

import json
import os
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import deps, repo
from app.routers import backup_replica as route

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
import backup_replicate as tool  # noqa: E402

NAS = "\\\\NAS\\backup\\mvhub"


# ── 복사기 도우미 ──────────────────────────────────────────────────────────────


def test_target_id_ignores_trailing_slash_and_case():
    assert tool.target_id(NAS) == tool.target_id(NAS.lower() + "\\") == tool.target_id(str(Path(NAS)))
    assert tool.target_id(NAS) != tool.target_id(NAS + "2")


@pytest.mark.parametrize("value, ok", [
    (NAS, True), ("\\\\NAS\\backup", True), ("\\\\NAS\\backup\\", True),
    ("D:\\mvhub_backup", False), ("Z:\\backup", False), ("\\\\NAS", False), ("\\\\?\\C:\\x", False),
    ("\\\\.\\pipe\\x", False), ("\\\\NAS\\a\\\\b", False), ("\\\\NAS\\a\\b.", False), ("\\\\NAS/a", False),
    ("\\\\NAS\\a\nb", False), ("\\\\NAS\\" + "x" * 200, False),
])
def test_unc_format(value, ok):
    assert (tool.unc_format_error(value) is None) is ok


def test_existing_folder_acceptance(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    assert tool._accepts_existing(empty, [])
    ours = tmp_path / "ours"
    (ours / "backups").mkdir(parents=True)
    (ours / "backups" / "content_hub_20261001_031500_123456.db").write_bytes(b"x")
    set_dir = ours / "db-backups" / "me" / "sets" / ("a" * 64)
    set_dir.mkdir(parents=True)
    (set_dir / "content.db").write_bytes(b"x")
    (set_dir / "manifest.json").write_text(json.dumps(
        {"format": "mvhub-worker-backup-set", "backup_set_id": "a" * 64, "roles": {"content": {}}}))
    (ours / "db-backups" / "me" / "sets" / ".setpart-1").mkdir()
    (ours / "db-backups" / "me" / "sets" / ".setpart-1" / "trash.db").write_bytes(b"x")
    (ours / "db-backups" / "me" / "20261001_031500_abcdef12.db").write_bytes(b"x")
    (ours / tool.MARKER_NAME).write_text("{}")
    assert tool._accepts_existing(ours, list(ours.iterdir()))
    (set_dir / "trash.db").write_bytes(b"x")  # manifest 에 없는 역할
    assert not tool._accepts_existing(ours, list(ours.iterdir()))
    (set_dir / "trash.db").unlink()
    fake = ours / "backups" / "sets" / "foreign"
    fake.mkdir(parents=True)
    (fake / "content.db").write_bytes(b"x")  # 'sets' 라는 이름만 같은 남의 구조
    assert not tool._accepts_existing(ours, list(ours.iterdir()))
    (fake / "content.db").unlink()
    (ours / "backups" / "someone_else.db").write_bytes(b"x")
    assert not tool._accepts_existing(ours, list(ours.iterdir()))
    other = tmp_path / "other"
    (other / "photos").mkdir(parents=True)
    assert not tool._accepts_existing(other, list(other.iterdir()))


def test_target_overlap_with_sources(tmp_path, monkeypatch):
    data = tmp_path / "repo" / "backend" / "data"
    data.mkdir(parents=True)
    monkeypatch.setattr(tool, "ROOT", tmp_path / "repo")
    monkeypatch.setattr(tool, "DATA_DIR", data)
    monkeypatch.setattr(tool, "_sources", lambda: [("backups", data / "backups"), ("db-backups", data / "db-backups")])
    assert tool.target_overlaps(data)  # target\backups == 원본
    assert tool.target_overlaps(tmp_path / "repo" / "copies")  # 저장소 안
    assert tool.target_overlaps(data / "backups" / "x")  # 원본 안
    assert not tool.target_overlaps(tmp_path / "elsewhere")


def test_prune_only_deletes_our_names(tmp_path, monkeypatch):
    monkeypatch.setattr(tool, "KEEP_PER_DIR", 1)
    d = tmp_path / "backups"
    d.mkdir()
    for i in range(3):
        p = d / f"content_hub_2026100{i}_031500.db"
        p.write_bytes(b"x")
        os.utime(p, (1000 + i, 1000 + i))
    foreign = d / "keep_me.db"
    foreign.write_bytes(b"x")
    os.utime(foreign, (1, 1))
    assert tool.prune_dir(d, set()) == 2
    assert sorted(p.name for p in d.iterdir()) == ["content_hub_20261002_031500.db", "keep_me.db"]


def test_last_success_carries_only_for_same_target(tmp_path, monkeypatch):
    monkeypatch.setattr(tool, "STATUS_FILE", tmp_path / "status.json")
    tool._write_status("success", target_id="aaa", started_at="s1", copied=1)
    first = json.loads((tmp_path / "status.json").read_text("utf-8"))
    tool._write_status("failed", error_code="copy_failed", target_id="aaa", started_at="s2")
    assert json.loads((tmp_path / "status.json").read_text("utf-8"))["last_success_at"] == first["last_success_at"]
    tool._write_status("failed", error_code="copy_failed", target_id="bbb", started_at="s3")
    assert json.loads((tmp_path / "status.json").read_text("utf-8"))["last_success_at"] is None


def test_main_refuses_overlapping_target(tmp_path, monkeypatch):
    monkeypatch.setattr(tool, "STATUS_FILE", tmp_path / "status.json")
    monkeypatch.setattr(tool, "LOG", tmp_path / "log.txt")
    monkeypatch.setattr(tool, "replica_root", lambda: tmp_path / "t")
    monkeypatch.setattr(tool, "target_overlaps", lambda target: True)
    assert tool.main() == 1
    status = json.loads((tmp_path / "status.json").read_text("utf-8"))
    assert (status["state"], status["error_code"], status["target_id"]) == ("failed", "target_unsafe", tool.target_id(str(tmp_path / "t")))


def test_probe_rejects_bad_format_and_self_host(monkeypatch):
    assert tool.probe("D:\\x") == 10
    monkeypatch.setattr(tool, "_self_host", lambda server: True)
    assert tool.probe(NAS) == 11


# ── 라우트 ───────────────────────────────────────────────────────────────────


TASK = {"exists": True, "enabled": True, "running": False, "matches_install": True, "ignore_new": True,
        "system": True, "last_run_at": "2026-10-02T03:30:00+00:00", "last_result": 0, "next_run_at": None}


@pytest.fixture
def env(tmp_path, monkeypatch):
    mod = route._replicator()
    monkeypatch.setattr(mod, "TARGET_FILE", tmp_path / "backup_replica_target.txt")
    monkeypatch.setattr(mod, "STATUS_FILE", tmp_path / "backup_replica_status.json")
    monkeypatch.delenv("CONTENT_HUB_BACKUP_REPLICA_DIR", raising=False)
    monkeypatch.delenv("CONTENT_HUB_DATA", raising=False)
    monkeypatch.delenv("CONTENT_HUB_NO_PROXY", raising=False)
    monkeypatch.setattr(deps, "AUTH_ENABLED", True)
    monkeypatch.setattr(route, "AUTH_ENABLED", True)
    monkeypatch.setattr(route, "_server_is_system", lambda: True)
    state = {"task": dict(TASK), "probe": 0, "audits": [], "audit_ok": True, "runs": []}
    monkeypatch.setattr(route, "_task_info", lambda: None if state["task"] is None else dict(state["task"]))
    monkeypatch.setattr(route, "_run_probe", lambda target: state["probe"])

    def audit(action, **fields):
        state["audits"].append(action)
        return state["audit_ok"] if action != "server.backup_replica_target_change_failed" else True
    monkeypatch.setattr(route, "journal_audit_event", audit)
    account = {"email": "boss@example.test", "status": "approved", "global_roles": ["admin"],
               "global_role": "admin", "password_changed_at": "p1", "creator_uid": "u_boss"}
    monkeypatch.setattr(repo, "authenticate", lambda email, pw: dict(account) if pw == "right" else None)
    monkeypatch.setattr(repo, "get_account", lambda email: dict(account, **state.get("account_change", {})))

    app = FastAPI()

    @app.middleware("http")
    async def who(request, call_next):
        role = request.headers.get("x-role", "admin")
        request.state.account = {**account, "global_role": role, "global_roles": [role]}
        return await call_next(request)

    app.include_router(route.router)
    state["client"] = TestClient(app)
    state["mod"] = mod
    return state


def test_status_snapshot_and_member_forbidden(env):
    c = env["client"]
    assert c.get("/api/admin/backup-replica", headers={"x-role": "member"}).status_code == 403
    body = c.get("/api/admin/backup-replica").json()
    assert (body["target"], body["source"], body["editable"], body["result"]["state"]) == (None, "none", True, "never_run")
    assert "system" not in body["task"]


def test_save_requires_password_and_writes_txt_with_audit(env):
    c = env["client"]
    bad = c.put("/api/admin/backup-replica", json={"target": NAS, "expected_target_id": None, "password": "wrong"})
    assert bad.status_code == 400  # 401 이면 앱이 로그아웃한다
    assert not Path(env["mod"].TARGET_FILE).exists()
    ok = c.put("/api/admin/backup-replica", json={"target": NAS, "expected_target_id": None, "password": "right"})
    assert ok.status_code == 200, ok.text
    assert Path(env["mod"].TARGET_FILE).read_bytes() == (NAS + "\n").encode("utf-8")  # BOM 없음
    assert ok.json()["target"] == NAS and ok.json()["audit_warning"] is None
    assert env["audits"] == ["server.backup_replica_target_change_requested", "server.backup_replica_target_changed"]
    assert env["mod"].configured_target() == (NAS, "file")


def test_save_rejections(env):
    c = env["client"]
    put = lambda **kw: c.put("/api/admin/backup-replica", json={"target": NAS, "expected_target_id": None, "password": "right", **kw})  # noqa: E731
    assert put(target="D:\\x").status_code == 400
    env["probe"] = 14
    assert "쓸 수 없습니다" in put().json()["detail"]
    env["probe"] = 0
    assert put(expected_target_id="zzz").status_code == 409  # 그 사이 바뀜
    env["task"]["running"] = True
    assert put().status_code == 409
    env["task"]["running"] = False
    env["account_change"] = {"password_changed_at": "p2"}
    assert put().status_code == 409  # 확인하는 동안 비밀번호가 바뀜
    env["account_change"] = {}
    env["audit_ok"] = False
    assert put().status_code == 503
    assert not Path(env["mod"].TARGET_FILE).exists()  # 감사가 안 되면 안 바꾼다


def test_env_locked_target_is_not_editable(env, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_BACKUP_REPLICA_DIR", "\\\\ENV\\share")
    body = env["client"].get("/api/admin/backup-replica").json()
    assert (body["source"], body["editable"]) == ("env", False)
    put = env["client"].put("/api/admin/backup-replica", json={"target": NAS, "expected_target_id": body["target_id"], "password": "right"})
    assert put.status_code == 409


def test_run_checks_task_and_calls_schtasks(env, monkeypatch):
    c = env["client"]
    assert c.post("/api/admin/backup-replica/run").status_code == 409  # 위치 없음
    Path(env["mod"].TARGET_FILE).write_text(NAS + "\n", encoding="utf-8")
    calls = []

    class Done:
        returncode = 0
    monkeypatch.setattr(route.subprocess, "run", lambda args, **kw: calls.append(args) or Done())
    for change, code in (({"exists": False}, 409), ({"enabled": False}, 409), ({"ignore_new": False}, 409),
                         ({"system": False}, 409), ({"running": True}, 409)):
        env["task"] = dict(TASK, **change)
        assert c.post("/api/admin/backup-replica/run").status_code == code, change
    env["task"] = None
    assert c.post("/api/admin/backup-replica/run").status_code == 503  # 상태를 모르면 안 돌린다
    env["task"] = dict(TASK)
    started = c.post("/api/admin/backup-replica/run")
    assert started.status_code == 200
    assert started.json()["baseline_last_run_at"] == TASK["last_run_at"]
    assert calls == [["schtasks", "/Run", "/TN", "MVHub BackupCopy"]]


def test_not_shared_server_runtime(env, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_NO_PROXY", "1")
    assert env["client"].get("/api/admin/backup-replica").json() == {"applicable": False}


def test_direct_server_path_is_never_auto_proxied_from_a_local_hub():
    # 로컬 허브가 이 경로를 자동 중계하면 저장된 관리자 토큰이 붙어 출처 검사를 건너뛴다(Codex P1)
    assert route._proxy.is_local_path("/api/admin/backup-replica")
    assert route._proxy.is_local_path("/api/admin/backup-replica/run")


def test_bad_body_never_echoes_password(env, monkeypatch):
    bad = env["client"].put("/api/admin/backup-replica", json={"password": "pw-secret-123"})
    assert bad.status_code == 400 and "pw-secret-123" not in bad.text
    wrong_type = env["client"].put("/api/admin/backup-replica", json={"target": 5, "password": "pw-secret-123"})
    assert wrong_type.status_code == 400 and "pw-secret-123" not in wrong_type.text
    app = FastAPI()
    app.include_router(route.router)
    monkeypatch.setattr(route._proxy, "proxying", lambda: True)
    local = TestClient(app, base_url="http://127.0.0.1:8010", client=("127.0.0.1", 50000))
    relayed = local.put("/api/shared-server/backup-replica", json={"password": "pw-secret-123"})
    assert relayed.status_code == 400 and "pw-secret-123" not in relayed.text


def test_run_refused_on_nonstandard_data_path(env, monkeypatch):
    Path(env["mod"].TARGET_FILE).write_text(NAS + "\n", encoding="utf-8")
    monkeypatch.setenv("CONTENT_HUB_DATA", "E:\\elsewhere")
    assert env["client"].post("/api/admin/backup-replica/run").status_code == 409


def test_task_action_must_match_register_autostart_exactly():
    good = {"action_count": 1, "execute": "cmd", "arguments": f'/c call "{route.ROOT / "task_launch.bat"}" backup'}
    assert route._is_our_backup_action(good)
    assert route._is_our_backup_action(dict(good, execute="C:\\Windows\\System32\\cmd.exe"))
    assert not route._is_our_backup_action(dict(good, arguments=f'/c call "{route.ROOT / "task_launch.bat"}" server backup'))
    assert not route._is_our_backup_action(dict(good, action_count=2))
    assert not route._is_our_backup_action(dict(good, execute="powershell"))
    assert not route._is_our_backup_action(dict(good, arguments='/c call "C:\\other\\task_launch.bat" backup'))


def test_local_relay_is_loopback_only_and_forwards(env, monkeypatch):
    app = FastAPI()
    app.include_router(route.router)
    sent = []
    monkeypatch.setattr(route._proxy, "proxying", lambda: True)
    monkeypatch.setattr(route._proxy, "proxy_json", lambda method, path, **kw: sent.append((method, path, kw.get("body"))) or {"ok": True})
    remote = TestClient(app, base_url="http://192.168.1.50:8010", client=("192.168.1.50", 50000))
    assert remote.get("/api/shared-server/backup-replica").status_code == 403
    local = TestClient(app, base_url="http://127.0.0.1:8010", client=("127.0.0.1", 50000))
    assert local.get("/api/shared-server/backup-replica").json() == {"ok": True}
    local.put("/api/shared-server/backup-replica", json={"target": NAS, "expected_target_id": None, "password": "x"})
    local.post("/api/shared-server/backup-replica/run")
    assert [(m, p) for m, p, _ in sent] == [("GET", "/api/admin/backup-replica"), ("PUT", "/api/admin/backup-replica"),
                                            ("POST", "/api/admin/backup-replica/run")]
    assert sent[1][2]["password"] == "x"
