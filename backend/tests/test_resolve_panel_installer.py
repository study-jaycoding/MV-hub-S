"""설치 시험은 임시 ProgramData/LocalAppData만 쓴다 — 실제 Resolve·설치본은 열지 않는다."""
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi import HTTPException
from starlette.requests import Request

from app.services import resolve_panel_installer as installer
from app.routers import resolve_integration as route


class ProcessStopped(BaseException):
    pass


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.pd, self.local = self.root / "programdata", self.root / "local"
        self.support = self.pd / installer.SUPPORT
        self.support.mkdir(parents=True)
        self.source = self.root / "source"
        shutil.copytree(installer.bundled_plugin_path(), self.source)
        self.target = self.support / "Workflow Integration Plugins" / installer.PLUGIN_ID
        self.work = self.pd / "MVHub/resolve-panel"
        self.kwargs = {"programdata": self.pd, "source_path": self.source}

    def install(self, **kwargs):
        return installer.install_resolve_panel_plugin(**self.kwargs, **kwargs)

    def status(self):
        return installer.resolve_panel_plugin_status(**self.kwargs)

    def old_install(self):
        self.assertEqual(self.install()["state"], "up_to_date")
        (self.target / "main.js").write_text("old", encoding="utf-8")
        return installer.tree_sha(self.target)

    def manifest(self, content):
        (self.target / "manifest.xml").write_text(content, encoding="utf-8")

    def test_no_resolve_creates_nothing(self):
        untouched = self.root / "absent"
        self.assertEqual(installer.install_resolve_panel_plugin(programdata=untouched)["state"], "no_resolve")
        self.assertFalse(untouched.exists())

    def test_install_exact_and_unchanged_keeps_timestamp(self):
        first = self.install()
        self.assertEqual(installer.tree_sha(self.target), installer.tree_sha(self.source))
        changed = first["changed_at"]
        mtime = (self.target / "main.js").stat().st_mtime_ns
        self.assertEqual(self.install()["changed_at"], changed)
        self.assertEqual(self.status()["changed_at"], changed)
        self.assertEqual((self.target / "main.js").stat().st_mtime_ns, mtime)
        self.assertEqual(len(list(self.target.parent.iterdir())), 1)

    def test_same_version_changed_missing_extra_files_repaired(self):
        self.install()
        for damage in ("change", "missing", "extra"):
            with self.subTest(damage=damage):
                if damage == "change": (self.target / "main.js").write_text("bad")
                elif damage == "missing": (self.target / "preload.js").unlink()
                else: (self.target / "extra.txt").write_text("extra")
                self.assertEqual(self.status()["state"], "damaged")
                self.assertEqual(self.install(automatic=True)["state"], "up_to_date")
                self.assertEqual(installer.tree_sha(self.target), installer.tree_sha(self.source))
                self.assertLessEqual(len(list((self.work / "backup").iterdir())), 1)

    def test_backup_retains_last_install_not_directory_mtime(self):
        self.old_install(); self.install()
        (self.target / "main.js").write_text("most recent original")
        before = installer.tree_sha(self.target)
        os.utime(self.target, (1, 1))
        self.install()
        backups = list((self.work / "backup").iterdir())
        self.assertEqual(len(backups), 1)
        self.assertEqual(installer.tree_sha(backups[0]), before)

    def test_versions_and_manual_downgrade(self):
        self.assertEqual(installer.version("1.0.0"), installer.version("1"))
        self.assertLess(installer.version("0.1"), installer.version("0.10"))
        for value in ("1.a", "1.", "v1", "-1", "", None): self.assertIsNone(installer.version(value))
        self.install()
        self.manifest('<Plugin><Id>com.mvhub.resolve</Id><Version>1.1</Version></Plugin>')
        before = installer.tree_sha(self.target)
        self.assertEqual(self.install(automatic=True)["state"], "newer_installed")
        self.assertEqual(installer.tree_sha(self.target), before)
        self.assertEqual(self.install()["state"], "up_to_date")

    def test_foreign_manifest_untouched_and_bad_version_repaired(self):
        self.install()
        for content in (None, "<broken", '<Plugin><Id>other</Id><Version>1</Version></Plugin>'):
            with self.subTest(content=content):
                if content is None: (self.target / "manifest.xml").unlink()
                else: self.manifest(content)
                before = installer.tree_sha(self.target)
                for automatic in (True, False):
                    self.assertEqual(self.install(automatic=automatic)["state"], "foreign")
                    self.assertEqual(installer.tree_sha(self.target), before)
        self.manifest('<Plugin><Id>com.mvhub.resolve</Id><Version>bad</Version></Plugin>')
        self.assertEqual(self.status()["state"], "damaged")
        self.assertEqual(self.install(automatic=True)["state"], "up_to_date")

    def test_another_handle_holds_os_lock(self):
        self.install()
        before = installer.tree_sha(self.target)
        last = (self.work / "last_result.json").read_bytes()
        with installer.install_lock(self.work):
            self.assertEqual(self.install()["state"], "busy")
            self.assertEqual(self.status()["state"], "busy")
        self.assertEqual(installer.tree_sha(self.target), before)
        self.assertEqual((self.work / "last_result.json").read_bytes(), last)

    def crash(self, point):
        replace = os.replace
        def interrupted(source, destination):
            replace(source, destination)
            destination = Path(destination)
            if ((point == "journal" and destination == self.work / "journal.json")
                    or (point == "backup" and destination.parent == self.work / "backup")
                    or (point == "installed" and destination == self.target)):
                raise ProcessStopped()
        with patch.object(installer.os, "replace", interrupted), self.assertRaises(ProcessStopped):
            self.install()

    def test_crash_after_journal_preserves_old_install(self):
        before = self.old_install(); self.crash("journal")
        self.assertEqual(self.status()["state"], "damaged")
        self.assertEqual(installer.tree_sha(self.target), before)
        self.assertFalse((self.work / "journal.json").exists())
        self.assertEqual(list((self.work / "staging").iterdir()), [])

    def test_crash_after_backup_restores_original(self):
        before = self.old_install(); self.crash("backup")
        self.assertFalse(self.target.exists())
        self.assertEqual(self.status()["state"], "damaged")
        self.assertEqual(installer.tree_sha(self.target), before)

    def test_crash_after_staging_move_commits_verified_new(self):
        self.old_install(); self.crash("installed")
        self.assertEqual(self.status()["state"], "up_to_date")
        self.assertFalse((self.work / "journal.json").exists())
        self.assertEqual(installer.tree_sha(self.target), installer.tree_sha(self.source))

    def test_mismatched_target_displaced_and_matching_backup_restored(self):
        before = self.old_install(); self.crash("backup")
        self.target.mkdir(); (self.target / "human.txt").write_text("keep me")
        self.status()
        self.assertEqual(installer.tree_sha(self.target), before)
        self.assertTrue(any((path / "human.txt").exists() for path in (self.work / "backup").iterdir()))

    def test_first_install_crash_displaces_unknown_target(self):
        self.crash("journal")
        self.target.mkdir(parents=True); (self.target / "human.txt").write_text("keep me")
        self.assertEqual(self.status()["state"], "not_installed")
        self.assertFalse(self.target.exists())
        self.assertTrue(any((path / "human.txt").exists() for path in (self.work / "backup").iterdir()))

    def test_displaced_unknown_survives_success_in_same_run(self):
        self.old_install(); self.crash("backup")
        self.target.mkdir(); (self.target / "human.txt").write_text("keep this run")
        self.assertEqual(self.install()["state"], "up_to_date")
        backups = list((self.work / "backup").iterdir())
        self.assertTrue(any((path / "human.txt").exists() for path in backups))
        self.assertEqual(len(backups), 2)
        (self.target / "main.js").write_text("changed again")
        self.assertEqual(self.install()["state"], "up_to_date")
        self.assertFalse(any((path / "human.txt").exists() for path in (self.work / "backup").iterdir()))

    def test_wrong_backup_is_never_restored_or_deleted(self):
        self.old_install(); self.crash("backup")
        record = json.loads((self.work / "journal.json").read_text())
        backup = Path(record["backup"]); (backup / "main.js").write_text("not original")
        before = installer.tree_sha(self.work)
        self.assertEqual(self.install()["state"], "damaged")
        self.assertEqual(installer.tree_sha(self.work), before)
        self.assertFalse(self.target.exists())

    def test_unreadable_journal_preserved(self):
        self.old_install(); (self.work / "journal.json").write_text("bad json")
        before = installer.tree_sha(self.pd)
        self.assertEqual(self.install()["state"], "damaged")
        self.assertEqual(installer.tree_sha(self.pd), before)

    def test_crash_during_or_after_rollback_next_lock_finishes(self):
        for after in (False, True):
            with self.subTest(after=after):
                before = self.old_install()
                replace, sha = os.replace, installer.tree_sha
                bad_once = False
                def wrong_final(path):
                    nonlocal bad_once
                    result = sha(path)
                    if path == self.target and (self.work / "journal.json").exists() and result == sha(self.source) and not bad_once:
                        bad_once = True
                        # 복구가 새 설치 완료로 판단하지 않도록 실제 파일 손상도 주입한다.
                        (self.target / "main.js").write_text("partial")
                        return sha(self.target)
                    return result
                def stop_restore(source, destination):
                    restoring = Path(source).parent == self.work / "backup" and Path(destination) == self.target
                    if restoring and not after: raise ProcessStopped()
                    replace(source, destination)
                    if restoring and after: raise ProcessStopped()
                with patch.object(installer, "tree_sha", wrong_final), patch.object(installer.os, "replace", stop_restore), self.assertRaises(ProcessStopped):
                    self.install()
                self.assertEqual(self.status()["state"], "damaged")
                self.assertEqual(installer.tree_sha(self.target), before)
                self.assertFalse((self.work / "journal.json").exists())

    def test_restore_failure_keeps_journal_and_recovers_next_time(self):
        before = self.old_install(); self.crash("backup")
        with patch.object(installer.os, "replace", side_effect=PermissionError("locked")):
            self.assertEqual(self.status()["state"], "damaged")
        self.assertTrue((self.work / "journal.json").exists())
        self.status(); self.assertEqual(installer.tree_sha(self.target), before)

    def test_sharing_and_access_denied_classification_and_persisted_reason(self):
        before = self.old_install()
        for winerror, writable, expected in ((32, True, "deferred"), (5, True, "deferred"), (5, False, "permission_denied")):
            with self.subTest(winerror=winerror, writable=writable):
                error = PermissionError("blocked"); error.winerror = winerror
                replace = os.replace
                def deny(source, destination):
                    if Path(source) == self.target: raise error
                    replace(source, destination)
                with patch.object(installer.os, "replace", deny), patch.object(installer, "_probe_write", side_effect=None if writable else PermissionError("no access")):
                    result = self.install()
                self.assertEqual(result["state"], expected)
                self.assertEqual(installer.tree_sha(self.target), before)
                self.assertEqual(self.status()["last_attempt"]["state"], expected)
                self.assertEqual(self.status()["changed_at"], result["changed_at"])
                if winerror == 5 and writable: self.assertIn("사용 중", result["reason"].replace("쓰이는 중", "사용 중"))

    def test_hub_json_only_url_and_timestamp(self):
        installer.write_hub_json("http://localhost:5173/", self.local)
        value = json.loads((self.local / "MVHub/resolve-panel/hub.json").read_text())
        self.assertEqual(set(value), {"url", "written_at"}); self.assertEqual(value["url"], "http://localhost:5173")
        for url in ("http://127.0.0.1:8010@evil.example", "http://localhost.evil.example:8010", "https://localhost:8010", "http://localhost", "http://localhost:8010/path", "http://localhost:8010?q", "http://localhost:8010#x", "http://u@localhost:8010", "http://127.1:8010", "http://localhost:0"):
            with self.subTest(url=url), self.assertRaises(installer.ResolvePanelInstallError): installer.write_hub_json(url, self.local)


class StartupAndApiTests(unittest.TestCase):
    def test_release_disabled_blocks_status_manual_and_background_without_writes(self):
        with patch.object(installer.release_update, "install_mode", return_value="release"), \
                patch.object(installer, "_run") as run, patch.object(installer, "write_hub_json") as write, \
                patch.object(installer.threading, "Thread") as thread:
            self.assertEqual(installer.resolve_panel_plugin_status()["state"], "release_disabled")
            self.assertEqual(installer.install_resolve_panel_plugin()["state"], "release_disabled")
            self.assertEqual(route.post_resolve_panel_plugin_install(self.request())["state"], "release_disabled")
            installer.run_startup_install()
            installer.start_background_install()
            run.assert_not_called(); write.assert_not_called(); thread.assert_not_called()

    def test_development_and_release_opt_in_keep_installer_available(self):
        with patch.object(installer.release_update, "install_mode", return_value="development"), \
                patch.object(installer, "_run", return_value={"state": "up_to_date"}) as run:
            self.assertEqual(installer.install_resolve_panel_plugin()["state"], "up_to_date")
            run.assert_called_once()

    def test_startup_conditions_and_errors_never_escape(self):
        with patch.object(installer, "RESOLVE_PANEL_RELEASE_ENABLED", True), patch.object(installer.platform, "system", return_value="Windows") as system, patch.object(installer.config, "AUTH_ENABLED", False), patch.object(installer.config, "PORT", 8010), patch.object(installer.release_update, "install_mode", return_value="release") as mode, patch.dict(os.environ, {}, clear=True), patch.object(installer, "write_hub_json") as write, patch.object(installer, "install_resolve_panel_plugin") as install:
            installer.run_startup_install(); write.assert_called_once(); install.assert_called_once_with(automatic=True, programdata=None)
            for key, value in (("CONTENT_HUB_DATA", "isolated"), ("CONTENT_HUB_DB", "")):
                with patch.dict(os.environ, {key: value}): installer.run_startup_install()
            for value in ("development", "server"):
                mode.return_value = value; installer.run_startup_install()
            mode.return_value = "release"
            with patch.object(installer.config, "PORT", 8012): installer.run_startup_install()
            with patch.object(installer.config, "AUTH_ENABLED", True): installer.run_startup_install()
            system.return_value = "Linux"; installer.run_startup_install()
            write.assert_called_once(); install.assert_called_once()
            system.return_value = "Windows"; write.side_effect = RuntimeError("failed")
            installer.run_startup_install()

    def test_background_is_daemon_and_start_failure_ignored(self):
        with patch.object(installer.threading, "Thread") as thread:
            installer.start_background_install()
            self.assertTrue(thread.call_args.kwargs["daemon"])
            self.assertIs(thread.call_args.kwargs["target"], installer.run_startup_install)
            thread.return_value.start.side_effect = RuntimeError("failed")
            installer.start_background_install()

    def request(self, host="127.0.0.1", origin=""):
        return Request({"type": "http", "method": "POST", "path": "/api/resolve/panel-plugin/install", "client": (host, 123), "headers": [(b"origin", origin.encode())]})

    def test_api_local_gate_and_manual_origin(self):
        with patch.object(installer, "write_hub_json") as write, patch.object(installer, "install_resolve_panel_plugin", return_value={"state": "up_to_date"}), patch.object(installer, "resolve_panel_plugin_status", return_value={"state": "busy"}):
            for method in (route.get_resolve_panel_plugin, route.post_resolve_panel_plugin_install):
                with self.assertRaises(HTTPException): method(self.request("192.0.2.1"))
            write.assert_not_called()
            self.assertEqual(route.get_resolve_panel_plugin(self.request())["state"], "busy")
            route.post_resolve_panel_plugin_install(self.request(origin="http://localhost:5173"))
            write.assert_called_with("http://localhost:5173")
            with self.assertRaises(HTTPException):
                route.post_resolve_panel_plugin_install(self.request(origin="http://evil.example:8010"))
            with patch.object(route.config, "PORT", 8012):
                route.post_resolve_panel_plugin_install(self.request(origin="https://localhost:8010"))
                write.assert_called_with("http://127.0.0.1:8012")
