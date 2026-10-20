"""Prepared regression: actual restore function, fake DB/HTTP/Popen, no app config."""
import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch
import pytest

PREP = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def restore_module():
    prefix = "restore_env_fixture"
    for name in (prefix, prefix + ".services"):
        package = ModuleType(name); package.__path__ = []
        sys.modules[name] = package
    members = {kind: {"restored_name": kind + ".db", "required_tables": set(), "reconcile_tables": ("evidence",)}
               for kind in ("content", "trash", "manage")}
    backup = ModuleType(prefix + ".services.backup_verify")
    backup.BACKUP_SET_MEMBERS = members
    backup.inspect_sqlite_database = Mock()
    backup.read_table_counts = lambda path, tables: ({"account": 0, "creator": 0} if tables == ("account", "creator") else {"evidence": 2})
    sys.modules[backup.__name__] = backup
    transfer = ModuleType(prefix + ".services.trash_transfer")
    transfer.validate_pair = Mock()
    sys.modules[transfer.__name__] = transfer
    helper = load(prefix + ".services.isolated_env", PREP / "backend/app/services/isolated_env.py")
    restore = load(prefix + ".services.restore_runtime_verify", PREP / "backend/app/services/restore_runtime_verify.py")
    return restore, helper


def test_mock_server_gets_safe_environment_and_existing_restore_layout(tmp_path):
    module, _ = restore_module()
    fake = {key: "synthetic-injection" for key in (
        "PYTHONPATH", "PYTHONHOME", "PYTHONPYCACHEPREFIX", "NODE_OPTIONS", "HOME", "APPDATA", "USERPROFILE",
        "LOCALAPPDATA", "TEMP", "TMP", "CONTENT_HUB_WORKER_BACKUP_STATE_DB", "CONTENT_HUB_WORKER_BACKUP_OUTBOX_DIR",
        "CONTENT_HUB_DEVICE_IDENTITY_FILE", "CONTENT_HUB_SERVER_ALERT_PATH", "CONTENT_HUB_BACKUP_REPLICA_DIR",
        "MVHUB_ACTIVATION_CONTROL", "MVHUB_EXECUTION_NONCE", "HOST", "PORT", "PYEXE", "BACKEND")}
    process = SimpleNamespace(stopped=False)
    process.poll = lambda: 0 if process.stopped else None
    popen = Mock(return_value=process)
    restored = tmp_path / "restored"; restored.mkdir()
    after = lambda path, tables: ({"account": 1, "creator": 1} if tables == ("account", "creator") else {"evidence": 2})
    with patch.object(module, "os", SimpleNamespace(environ=fake, name="nt")), \
         patch.object(module.subprocess, "Popen", popen), \
         patch.object(module, "_free_loopback_port", return_value=18991), \
         patch.object(module, "_local_json_request", side_effect=[(200, {"checks": {k: "ok" for k in ("content", "trash", "manage")}}), (200, {"token": "synthetic-only"})]), \
         patch.object(module, "_stop_test_process", side_effect=lambda p: setattr(p, "stopped", True)), \
         patch.object(module, "_read_counts_after_shutdown", side_effect=after):
        result = module.verify_restored_set_runtime(restored)
    assert result["ok"] and result["process_stopped"]
    env = popen.call_args.kwargs["env"]
    assert not any(value == "synthetic-injection" for value in env.values())
    for key in ("CONTENT_HUB_DATA", "CONTENT_HUB_DB", "CONTENT_HUB_MEDIA", "CONTENT_HUB_SHARED", "CONTENT_HUB_ASSETS_DIR",
                "CONTENT_HUB_BACKUP_DIR", "CONTENT_HUB_LOG_DIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"):
        assert Path(env[key]).is_relative_to(restored), key
    assert Path(env["CONTENT_HUB_DATA"]) == restored
    assert Path(env["CONTENT_HUB_DB"]) == restored / "db/content.db"
    assert env["CONTENT_HUB_READ_ONLY"] == "1" and env["CONTENT_HUB_NO_PROXY"] == "1"
    assert env["CONTENT_HUB_AUTH"] == "1" and env["CONTENT_HUB_MANAGE"] == "1"
    assert popen.call_args.args[0][1:7] == ["-E", "-s", "-B", "-X", "utf8", "-u"]


def test_only_data_may_equal_work_root(tmp_path):
    _, helper = restore_module()
    work = tmp_path / "work"
    env = helper.build_smoke_env({}, work, frontend_dist=work / "no-frontend", python_exe=Path(sys.executable), port=18991)
    env["CONTENT_HUB_DATA"] = str(work)
    helper.validate_smoke_paths(work, env, allowed_frontend_root=work / "no-frontend")
    for key in ("CONTENT_HUB_DB", "CONTENT_HUB_MEDIA", "HOME", "TEMP"):
        with pytest.raises(ValueError):
            helper.validate_smoke_paths(work, {**env, key: str(work)}, allowed_frontend_root=work / "no-frontend")
    with pytest.raises(ValueError):
        helper.validate_smoke_paths(work, {**env, "CONTENT_HUB_LOG_DIR": str(tmp_path / "outside")},
                                    allowed_frontend_root=work / "no-frontend")


def test_final_path_revalidation_prevents_popen(tmp_path):
    module, _ = restore_module()
    popen = Mock()
    with patch.object(module, "os", SimpleNamespace(environ={}, name="nt")), \
         patch.object(module.subprocess, "Popen", popen), \
         patch.object(module, "_free_loopback_port", return_value=18991), \
         patch.object(module, "validate_smoke_paths", side_effect=ValueError("final-path-rejected"), create=True):
        with pytest.raises(ValueError, match="final-path-rejected"):
            module.verify_restored_set_runtime(tmp_path)
    popen.assert_not_called()


@pytest.mark.parametrize("root", [Path("relative-restore"), Path(r"\\server\share\restore")])
def test_invalid_root_is_rejected_before_database_inspection(root):
    module, _ = restore_module()
    with pytest.raises(ValueError):
        module.verify_restored_set_runtime(root)
    module.inspect_sqlite_database.assert_not_called()


@pytest.mark.parametrize("bad_child", ["db/content.db", "restore-drill-server.log"])
def test_database_or_log_link_is_rejected_before_inspection_open_and_spawn(tmp_path, bad_child):
    module, _ = restore_module()
    real_local_path = module._local_path
    bad = tmp_path / bad_child
    def check(path):
        if path == bad:
            raise ValueError("fixture-reparse-path")
        return real_local_path(path)
    popen = Mock()
    with patch.object(module, "_local_path", side_effect=check), \
         patch.object(Path, "open") as opened, \
         patch.object(module.subprocess, "Popen", popen):
        with pytest.raises(ValueError, match="fixture-reparse-path"):
            module.verify_restored_set_runtime(tmp_path)
    module.inspect_sqlite_database.assert_not_called()
    opened.assert_not_called()
    popen.assert_not_called()
