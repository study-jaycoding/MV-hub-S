"""ZIP 없는 후보·게시 경로: 임시 Git 원격/서버/NAS 사본만 사용한다."""
from __future__ import annotations

from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from . import mcp_stage
from .install import Installation, trusted_git

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))  # 콘솔 부트스트랩과 같은 import 경로


class StageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mvhub-mcp-stage-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.origin = self.base / "origin"
        self.origin.mkdir()
        self.git = trusted_git()
        if self.git is None:
            self.skipTest("Git for Windows is not installed")
        self.run_git(self.origin, "init", "-b", "main")
        source = self.origin / "tools" / "mcp_adapter"
        source.mkdir(parents=True)
        for name in mcp_stage._FILES:
            shutil.copyfile(ROOT / "tools" / "mcp_adapter" / name, source / name)
        (source / "server.py").write_text(
            'MCP_UPDATE_API = 1\n_MCP_BUNDLE = "test-bundle"\nADAPTER_VERSION = "2026.10.27.1"\n'
            'HUB_FEATURES = {"generation_result"}\nraise RuntimeError("candidate must never execute")\n',
            encoding="utf-8",
        )
        (self.origin / "unrelated.txt").write_text("not part of MCP", encoding="utf-8")
        self.commit(self.origin)
        self.server = self.base / "server"
        self.run_git(self.base, "clone", "--no-hardlinks", str(self.origin), str(self.server))
        (self.server / "logs").mkdir()
        self.inst = Installation(self.server, self.server / "data", self.server / "logs", self.server / "data" / "test.db",
                                 1, True, None, ())
        self.publication = self.base / "publication"
        self.publication.mkdir()
        setting = self.server / ".mvhub-runtime" / "console-release"
        setting.mkdir(parents=True)
        (setting / "INSTALL_SOURCE.txt").write_text(str(self.publication), encoding="utf-8")
        self.module = mcp_stage.updater(self.inst)

    def run_git(self, root, *args, input=None):
        proc = subprocess.run([str(self.git), "-C", str(root), *args], input=input, capture_output=True,
                              timeout=30, creationflags=0x08000000)
        if proc.returncode:
            self.fail(proc.stderr.decode("utf-8", errors="replace"))
        return proc.stdout.decode("utf-8").strip()

    def commit(self, root):
        self.run_git(root, "add", ".")
        self.run_git(root, "-c", "user.name=MCP Test", "-c", "user.email=mcp-test@example.invalid", "commit", "-m", "test")
        return self.run_git(root, "rev-parse", "HEAD")

    def candidate(self):
        sha = mcp_stage.latest(self.inst)
        manifest = mcp_stage.bring_candidate(self.inst, sha)
        return sha, manifest

    def test_candidate_publish_rollback_without_zip_or_checkout_change(self):
        head = self.run_git(self.server, "rev-parse", "HEAD")
        sha, manifest = self.candidate()
        view = mcp_stage.view(self.inst)
        self.assertTrue(view["rows"][0]["verified"])
        self.assertTrue(view["rows"][0]["compatible"])
        mcp_stage.deploy(self.inst, sha, self.module.manifest_digest(manifest), view["token"], view["source"])
        target = self.publication / "mcp"
        published, files = self.module.read_version(target, sha)
        self.assertEqual(set(files), {"server.py"})
        self.assertEqual(published["commit"], sha)
        client = self.base / "client"
        shutil.copytree(self.server / "tools" / "mcp_adapter", client / "tools" / "mcp_adapter")
        profile = client / "existing-profile.bin"
        profile.write_bytes(b"preserve this fixture")
        installed = self.module.install(client, str(self.publication), self.module.manifest_digest(manifest), self.base / "client-cache")
        self.assertEqual(installed["source"], "downloaded")
        self.assertEqual(installed["commit"], sha)
        self.assertTrue(installed["settings_preserved"])
        self.assertEqual(profile.read_bytes(), b"preserve this fixture")
        first_token = self.module.pointer_token(target)
        payload = self.origin / "tools" / "mcp_adapter" / "server.py"
        text = payload.read_text("utf-8")
        text = re.sub(r'ADAPTER_VERSION = "[^"]+"', 'ADAPTER_VERSION = "2026.10.28.1"', text)
        payload.write_text(text, encoding="utf-8")
        self.commit(self.origin)
        second_sha, second = self.candidate()
        mcp_stage.deploy(self.inst, second_sha, self.module.manifest_digest(second), first_token, str(target))
        self.assertEqual(self.module.read_pointer(target)["current"]["commit"], second_sha)
        mcp_stage.rollback(self.inst, self.module.pointer_token(target), str(target))
        self.assertEqual(self.module.read_pointer(target)["current"]["commit"], sha)
        self.assertEqual(self.run_git(self.server, "rev-parse", "HEAD"), head)
        self.assertFalse(list(self.base.rglob("*.zip")))
        self.assertFalse((target / "unrelated.txt").exists())

    def test_working_copy_is_not_used_as_candidate(self):
        sha = mcp_stage.latest(self.inst)
        selected = self.server / "tools" / "mcp_adapter" / "server.py"
        selected.write_text("raise RuntimeError('working copy must not run')", encoding="utf-8")
        manifest = mcp_stage.bring_candidate(self.inst, sha)
        _manifest, files = self.module.read_version(mcp_stage.stage_root(self.inst), sha)
        self.assertNotEqual(files["server.py"], selected.read_bytes())
        self.assertEqual(manifest["commit"], sha)

    def test_non_main_commit_is_rejected(self):
        (self.server / "unrelated.txt").write_text("local only", encoding="utf-8")
        local_sha = self.commit(self.server)
        with self.assertRaises(mcp_stage.McpStageError):
            mcp_stage.bring_candidate(self.inst, local_sha)

    def test_symlink_blob_is_rejected_before_reading_code(self):
        oid = self.run_git(self.origin, "hash-object", "-w", "--stdin", input=b"../../../private.py")
        self.run_git(self.origin, "update-index", "--cacheinfo", f"120000,{oid},tools/mcp_adapter/server.py")
        self.run_git(self.origin, "-c", "user.name=MCP Test", "-c", "user.email=mcp-test@example.invalid", "commit", "-m", "link")
        sha = mcp_stage.latest(self.inst)
        with self.assertRaises(mcp_stage.McpStageError):
            mcp_stage.bring_candidate(self.inst, sha)

    def test_corrupted_candidate_never_publishes(self):
        sha, manifest = self.candidate()
        view = mcp_stage.view(self.inst)
        path = mcp_stage.stage_root(self.inst) / "versions" / sha / "server.py"
        path.write_bytes(path.read_bytes() + b"\n# changed")
        with self.assertRaises(ValueError):
            mcp_stage.deploy(self.inst, sha, self.module.manifest_digest(manifest), None, view["source"])
        self.assertIsNone(self.module.read_pointer(self.publication / "mcp"))

    def test_changed_destination_and_stale_snapshot_are_rejected(self):
        sha, manifest = self.candidate()
        view = mcp_stage.view(self.inst)
        digest = self.module.manifest_digest(manifest)
        with self.assertRaises(mcp_stage.McpStageError):
            mcp_stage.deploy(self.inst, sha, digest, None, str(self.base / "other"))
        mcp_stage.deploy(self.inst, sha, digest, None, view["source"])
        with self.assertRaises(ValueError):
            mcp_stage.deploy(self.inst, sha, digest, None, view["source"])

    def test_rollback_cannot_bypass_changed_bundle_contract(self):
        sha, manifest = self.candidate()
        target = str(self.publication / "mcp")
        mcp_stage.deploy(self.inst, sha, self.module.manifest_digest(manifest), None, target)
        payload = self.origin / "tools" / "mcp_adapter" / "server.py"
        payload.write_text(payload.read_text("utf-8").replace("2026.10.27.1", "2026.10.28.1"), encoding="utf-8")
        self.commit(self.origin)
        second_sha, second = self.candidate()
        mcp_stage.deploy(self.inst, second_sha, self.module.manifest_digest(second), self.module.pointer_token(Path(target)), target)
        baseline = self.server / "tools" / "mcp_adapter" / "local_setup.py"
        baseline.write_bytes(baseline.read_bytes() + b"\n# new bundle contract\n")
        with self.assertRaises(mcp_stage.McpStageError):
            mcp_stage.rollback(self.inst, self.module.pointer_token(Path(target)), target)
        self.assertEqual(self.module.read_pointer(Path(target))["current"]["commit"], second_sha)


class UiTests(unittest.TestCase):
    def test_worker_checks_admin_and_reports_error_without_silent_success(self):
        from . import server_api, ui
        app = ui.App.__new__(ui.App)
        app.inst = object()
        app.session = type("Session", (), {"server": {}, "token": "test-token"})()
        messages = []
        app._put = messages.append
        with patch.object(server_api, "read_intake", side_effect=server_api.AuthExpired("expired")), \
                patch.object(mcp_stage, "latest") as latest:
            app._mcp_worker("latest", "", None, {}, app.session)
        self.assertFalse(latest.called)
        self.assertEqual(messages[0][0], "mcp_result")
        self.assertTrue(messages[0][2]["auth_expired"])
        self.assertEqual(messages[0][2]["error"], "expired")

    def test_panel_builds_and_handles_empty_error_and_ready_states(self):
        import tkinter as tk
        from . import ui
        root = tk.Tk()
        root.withdraw()
        self.addCleanup(root.destroy)
        app = ui.App.__new__(ui.App)
        app.root = root
        app.mcp_busy = False
        app.mcp_view = {"rows": []}
        app.session = None
        page = tk.Frame(root)
        app._build_mcp_page(page)
        app._on_mcp_result(None, {"view": {"rows": [], "source": "", "error": ""}, "note": "후보 없음"})
        self.assertEqual(app.mcp_note.cget("text"), "후보 없음")
        sha = "a" * 40
        app._on_mcp_result(None, {"view": {"rows": [{"commit": sha, "version": "1", "state": "후보", "verified": True,
            "compatible": True, "file_count": 1}], "source": "test", "error": ""}, "note": "준비 완료"})
        self.assertTrue(app.mcp_tree.exists(sha))
        app._on_mcp_result(None, {"view": None, "note": "", "error": "검증 실패"})
        self.assertEqual(app.mcp_note.cget("text"), "검증 실패")
        self.assertFalse(app.mcp_busy)


if __name__ == "__main__":
    unittest.main()
