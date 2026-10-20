"""Pure safety contracts; no application import or listening socket."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import subprocess
import unittest
from unittest.mock import Mock, patch

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location("load_soak_under_test", TOOLS / "load_test_100.py")
load = importlib.util.module_from_spec(spec)
spec.loader.exec_module(load)


class LoadSoakSafety(unittest.TestCase):
    def test_cleanup_requires_launcher_identity_even_when_port_is_free(self):
        import psutil
        process = Mock(pid=42, load_create_time=100, returncode=0)
        process.poll.return_value = 0
        with patch.object(psutil, "Process", side_effect=psutil.NoSuchProcess(42)), \
             patch.object(load, "_listening_pid", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "launcher.*cleanup"):
                load._stop_owned(process, 18951)
        process.terminate.assert_not_called()
        process.kill.assert_not_called()

    def test_cleanup_checks_children_identity_and_port(self):
        import psutil
        for failure in (None, "reused", "alive-child", "occupied-port"):
            with self.subTest(failure=failure):
                process = Mock(pid=42, load_create_time=100, returncode=0)
                process.poll.return_value = 0
                child = Mock(pid=43)
                owner = Mock()
                owner.create_time.return_value = 101 if failure == "reused" else 100
                owner.children.return_value = [child]
                alive = [child] if failure == "alive-child" else []
                with patch.object(psutil, "Process", return_value=owner), \
                     patch.object(psutil, "wait_procs", return_value=([], alive)), \
                     patch.object(load, "_listening_pid", return_value=43 if failure == "occupied-port" else None):
                    if failure:
                        with self.assertRaises(RuntimeError):
                            load._stop_owned(process, 18951)
                    else:
                        result = load._stop_owned(process, 18951)
                        self.assertTrue(result["port_released"])
                        self.assertEqual(result["child_pids"], [43])
                        child.terminate.assert_called_once()
                if failure == "reused":
                    child.terminate.assert_not_called()
                    process.terminate.assert_not_called()

    def test_guarded_child_blocks_outside_write_network_and_subprocess(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            code = '''
import sys,socket,subprocess
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from workroom_backend import install_guard,WorkroomBlocked
root=Path(sys.argv[2]);install_guard(root,18951)
blocked=0
for action in (lambda: (root.parent/'outside-forbidden.txt').write_text('bad'),
               lambda: socket.socket().connect(('192.0.2.1',443)),
               lambda: subprocess.run([sys.executable,'-c','print(123)'])):
    try: action()
    except WorkroomBlocked: blocked+=1
assert blocked==3,blocked
print('blocked=3')
'''
            result = subprocess.run([sys.executable, "-E", "-s", "-B", "-c", code, str(TOOLS), str(root)],
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "blocked=3")

    def test_powershell_interpreter_environment_is_clean_and_parent_restored(self):
        shell = Path(r"C:\Users\FX-PC06\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe")
        if not shell.exists():
            self.skipTest("PowerShell 7 unavailable")
        script = r'''
$errors=$null
$tree=[System.Management.Automation.Language.Parser]::ParseFile($args[0],[ref]$null,[ref]$errors)
if($errors.Count){throw 'Parse failed'}
$function=$tree.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-IsolatedPython'},$true)
Invoke-Expression $function.Extent.Text
$PythonExe=$args[1]
$env:PYTHONHOME='must-be-removed'
$env:NODE_OPTIONS='must-be-removed'
Invoke-IsolatedPython @('-c','import os,json;print(json.dumps([os.getenv("PYTHONHOME"),os.getenv("NODE_OPTIONS")]))')
if($LASTEXITCODE -ne 0){throw 'Interpreter failed'}
if($env:PYTHONHOME -ne 'must-be-removed' -or $env:NODE_OPTIONS -ne 'must-be-removed'){throw 'Parent restoration failed'}
'''
        # Use a temporary script so PowerShell argument binding is unambiguous.
        with tempfile.TemporaryDirectory() as folder:
            runner = Path(folder) / "probe.ps1"
            runner.write_text(script, encoding="utf-8")
            result = subprocess.run([str(shell), "-NoProfile", "-File", str(runner),
                                     str(TOOLS / "run_https_soak.ps1"), sys.executable],
                                    capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        # Windows may preserve an empty environment entry; it must contain no injection.
        self.assertTrue(all(not value for value in json.loads(result.stdout.strip())))

    def test_parent_injection_removed_and_all_paths_confined(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            env = load._isolated_environment(root, 18951, {
                "SYSTEMROOT": r"C:\Windows", "CONTENT_HUB_DB": r"C:\private\user.db",
                "CONTENT_HUB_SHARED": r"C:\private", "PYTHONPATH": "evil", "PYTHONHOME": "evil",
                "NODE_OPTIONS": "evil", "MVHUB_EXECUTION_NONCE": "old", "HTTP_PROXY": "evil"})
            for forbidden in ("PYTHONPATH", "PYTHONHOME", "NODE_OPTIONS", "MVHUB_EXECUTION_NONCE", "HTTP_PROXY"):
                self.assertNotIn(forbidden, env)
            for key in ("CONTENT_HUB_DATA", "CONTENT_HUB_DB", "CONTENT_HUB_MEDIA", "CONTENT_HUB_SHARED",
                        "CONTENT_HUB_BACKUP_DIR", "CONTENT_HUB_ASSETS_DIR", "HOME", "TEMP"):
                self.assertTrue(Path(env[key]).is_relative_to(root))
            self.assertEqual(env["CONTENT_HUB_HOST"], "127.0.0.1")
            self.assertEqual(env["CONTENT_HUB_EXTERNAL_RECOVERY"], "0")
            self.assertEqual(env["CONTENT_HUB_SERVER_SYNC"], "0")
            self.assertEqual(env["CONTENT_HUB_AUTH"], "1")

    def test_manifest_rejects_modified_added_missing_duplicate_and_escape(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "frontend/dist").mkdir(parents=True)
            source = root / "frontend/dist/app.js"
            source.write_text("original")
            manifest = root / "manifest.json"
            payload = {"format_version": 1, "scope": "soak-source-dist-tools-v1", "files": load._source_files(root)}
            manifest.write_text(json.dumps(payload))
            self.assertTrue(load._verify_frozen_manifest(manifest, root))
            source.write_text("changed")
            with self.assertRaises(ValueError): load._verify_frozen_manifest(manifest, root)
            source.write_text("original")
            extra = root / "frontend/dist/new.js"
            extra.write_text("new")
            with self.assertRaises(ValueError): load._verify_frozen_manifest(manifest, root)
            extra.unlink()
            source.unlink()
            with self.assertRaises(ValueError): load._verify_frozen_manifest(manifest, root)
            payload["files"] = {"../private.db": "0" * 64}
            manifest.write_text(json.dumps(payload))
            with self.assertRaises(ValueError): load._verify_frozen_manifest(manifest, root)
            manifest.write_text('{"format_version":1,"format_version":1}')
            with self.assertRaises(ValueError): load._verify_frozen_manifest(manifest, root)

    def test_ready_rejects_foreign_listener(self):
        import os
        with patch.object(load, "_listening_pid", return_value=os.getpid() + 100000):
            with self.assertRaisesRegex(RuntimeError, "not owned"):
                load._owned_listener(type("Process", (), {"pid": os.getpid()})(), 18951,
                                     {"runtime": {"process_id": os.getpid() + 100000}})

    def test_redaction(self):
        value = load._redact('password=private Authorization=Bearer cookie=private ' + load.PASSWORD)
        self.assertNotIn("private", value)
        self.assertNotIn(load.PASSWORD, value)


if __name__ == "__main__":
    unittest.main()
