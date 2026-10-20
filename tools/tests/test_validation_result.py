"""Exercise evidence helpers only, with disposable files/Git repositories.

Never execute predeploy_gate, an application, a server, or a deployment script.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "tools" / "validation_result.ps1"
GATE = ROOT / "tools" / "predeploy_gate.ps1"
POWERSHELL = shutil.which("powershell.exe")


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


@unittest.skipUnless(os.name == "nt" and POWERSHELL, "Windows PowerShell contract")
class ValidationResultTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mvhub-validation-helper-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.reports = self.root / "reports"
        self.env = {k: v for k, v in os.environ.items() if not k.upper().startswith(("GIT_", "CONTENT_HUB_"))}
        self.env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)

    def script(self, body):
        path = self.root / "probe.ps1"
        path.write_text(
            "$ErrorActionPreference = 'Stop'\n. " + quote(HELPER) + "\n"
            + "$Reports = " + quote(self.reports) + "\n" + body,
            encoding="utf-8-sig",
        )
        return [POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(path)]

    def run_ps(self, body, expected=0):
        result = subprocess.run(self.script(body), cwd=self.root, env=self.env,
                                capture_output=True, timeout=30)
        self.assertEqual(result.returncode, expected,
                         (result.stdout + result.stderr).decode("utf-8", "replace"))
        return result

    def latest(self):
        pointer = json.loads((self.reports / "predeploy-latest.json").read_text("utf-8-sig"))
        return json.loads((self.reports / pointer["run_file"]).read_text("utf-8-sig"))

    def test_running_then_passed_remains_source_only_and_terminal_is_immutable(self):
        self.run_ps("""
$r = Start-ValidationRun $Reports
Copy-Item -LiteralPath $r.Path -Destination (Join-Path $Reports 'observed-running.json')
$r.Data.release_eligible = $true
Complete-ValidationRun $r passed
try { Complete-ValidationRun $r failed; throw 'accepted terminal mutation' }
catch { if ($_.Exception.Message -eq 'accepted terminal mutation') { throw } }
""")
        running = json.loads((self.reports / "observed-running.json").read_text())
        self.assertEqual(running["status"], "running")
        final = self.latest()
        self.assertEqual(final["status"], "passed")
        self.assertTrue(final["passed"])
        self.assertFalse(final["release_eligible"])
        self.assertGreaterEqual(final["elapsed_ms"], 0)

    def test_previous_success_cannot_mask_new_failure_or_be_overwritten(self):
        self.run_ps("""
$old = Start-ValidationRun $Reports
Complete-ValidationRun $old passed
$r = Start-ValidationRun $Reports
Complete-ValidationRun $r failed @{ type='SyntheticFailure'; step='resolve-python'; exit_code=7 }
""")
        final = self.latest()
        self.assertEqual(final["status"], "failed")
        self.assertEqual(final["error"]["exit_code"], 7)
        all_runs = [json.loads(p.read_text()) for p in self.reports.glob("validation-*.json")]
        self.assertEqual(sorted(r["status"] for r in all_runs), ["failed", "passed"])

    def test_older_completion_does_not_move_latest_back(self):
        self.run_ps("""
$old = Start-ValidationRun $Reports
$new = Start-ValidationRun $Reports
Complete-ValidationRun $old passed
""")
        self.assertEqual(self.latest()["status"], "running")

    def test_skipped_checks_and_interrupt_do_not_grant_release_eligibility(self):
        self.run_ps("""
$r = Start-ValidationRun $Reports @{skip_load=$true; skip_backup_drill=$true}
$r.Data.steps += @{name='load'; status='skipped'; exit_code=$null}
Complete-ValidationRun $r interrupted
""")
        final = self.latest()
        self.assertEqual(final["status"], "interrupted")
        self.assertTrue(final["options"]["skip_load"])
        self.assertEqual(final["steps"][0]["status"], "skipped")
        self.assertFalse(final["release_eligible"])
        self.run_ps("""
$r = Start-ValidationRun $Reports @{skip_load=$true}
$r.Data.steps += @{name='load'; status='skipped'; exit_code=$null}
Complete-ValidationRun $r passed
""")
        self.assertTrue(self.latest()["passed"])
        self.assertFalse(self.latest()["release_eligible"])

    def test_invalid_output_path_stops_before_a_run_is_claimed(self):
        self.reports.write_text("existing file", encoding="utf-8")
        self.run_ps("Start-ValidationRun $Reports | Out-Null", expected=1)
        self.assertEqual(self.reports.read_text(), "existing file")

    def test_finalization_write_failure_remains_running_and_throws(self):
        self.run_ps("""
$r = Start-ValidationRun $Reports
$lock = [IO.File]::Open($r.Path, 'Open', 'Read', 'None')
try {
    try { Complete-ValidationRun $r passed; throw 'false success' }
    catch {
        if ($_.Exception.Message -eq 'false success') { throw }
        if ($r.Data.status -ne 'running') { throw 'memory was marked passed' }
    }
} finally { $lock.Dispose() }
""")
        self.assertEqual(self.latest()["status"], "running")
        self.assertEqual(list(self.reports.glob("*.tmp")), [])

    def test_killed_helper_leaves_new_incomplete_run_not_old_success(self):
        self.run_ps("$r = Start-ValidationRun $Reports; Complete-ValidationRun $r passed")
        old_id = self.latest()["run_id"]
        command = self.script("$r = Start-ValidationRun $Reports; Start-Sleep -Seconds 60")
        process = subprocess.Popen(command, cwd=self.root, env=self.env,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if self.latest()["run_id"] != old_id:
                    break
                time.sleep(0.05)
            self.assertNotEqual(self.latest()["run_id"], old_id)
        finally:
            # This handle owns only a sleeping PowerShell helper; it has no children.
            process.terminate()
            process.wait(timeout=10)
        self.assertEqual(self.latest()["status"], "running")
        self.assertFalse(self.latest()["passed"])

    def test_source_manifest_captures_untracked_edits_and_excludes_private_data(self):
        repo = self.root / "source"
        repo.mkdir()
        def git(*args):
            subprocess.run(["git", "-c", "init.templateDir=", *args], cwd=repo, env=self.env,
                           check=True, capture_output=True, timeout=10)
        git("init", "-q")
        git("config", "user.name", "Validation Fixture")
        git("config", "user.email", "fixture@example.invalid")
        git("config", "core.autocrlf", "false")
        for relative in ("backend/app/main.py", "backend/app/database.py", "backend/tests/test_token.py", "frontend/package-lock.json",
                         "frontend/src/shared/contracts/generation.ts", "shared/private.json", "backend/shared/private.json", "frontend/shared/private.json",
                         "deploy/windows/server.xml", "deploy/windows/launcher.ps1",
                         "backend/data/private.json", "tools/credentials.json", ".mcp.json"):
            path = repo / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("{}\n", encoding="utf-8")
        git("add", ".")
        git("-c", "core.hooksPath=", "commit", "-qm", "fixture")
        def snapshot(name):
            self.run_ps("$s = Get-ValidationSourceManifest " + quote(repo)
                        + "; Write-ValidationJson " + quote(self.root / name) + " $s")
            return json.loads((self.root / name).read_text())
        clean = snapshot("clean.json")
        self.assertFalse(clean["dirty"])
        untracked = repo / "backend/app/한글 새 코드.py"
        untracked.write_text("x = 1\n", encoding="utf-8")
        before = snapshot("before.json")
        untracked.write_text("x = 2\n", encoding="utf-8")
        after = snapshot("after.json")
        self.assertTrue(before["dirty"])
        self.assertNotEqual(before["sha256"], after["sha256"])
        files = {f["path"]: f for f in before["files"]}
        self.assertFalse(files["backend/app/한글 새 코드.py"]["tracked"])
        self.assertIn("backend/tests/test_token.py", files)
        self.assertIn("backend/app/database.py", files)
        self.assertIn("frontend/package-lock.json", files)
        self.assertTrue(files["frontend/src/shared/contracts/generation.ts"]["tracked"])
        for name in ("shared/private.json", "backend/shared/private.json", "frontend/shared/private.json"):
            self.assertNotIn(name, files)
        self.assertIn("deploy/windows/server.xml", files)
        self.assertIn("deploy/windows/launcher.ps1", files)
        self.assertNotIn("backend/data/private.json", files)
        self.assertNotIn("tools/credentials.json", files)
        self.assertNotIn(".mcp.json", files)
        (repo / "backend/app/main.py").unlink()
        deleted = snapshot("deleted.json")
        missing = next(f for f in deleted["files"] if f["path"] == "backend/app/main.py")
        self.assertIsNone(missing["sha256"])

    def test_git_failure_is_recorded_without_running_gate(self):
        self.run_ps("""
$r = Start-ValidationRun $Reports
try { $r.Data.source = Get-ValidationSourceManifest $Reports }
catch { Complete-ValidationRun $r failed @{type=$_.Exception.GetType().FullName; step='source-manifest'} }
""")
        self.assertEqual(self.latest()["status"], "failed")

    def test_checked_command_preserves_exit_and_exception_when_writer_fails(self):
        # Extract only this function. Never dot-source/execute the gate itself.
        text = GATE.read_text(encoding="utf-8-sig")
        function = text[text.index("function Invoke-Checked {"):text.index("function Resolve-TestPython {")]
        self.run_ps(function + """
$Run = Start-ValidationRun $Reports
try { Invoke-Checked 'native-seven' { & $env:ComSpec /d /c exit 7 } }
catch {
    if ($_.Exception.Message -ne 'native-seven failed (exit code 7)') { throw }
    Complete-ValidationRun $Run failed @{exit_code=$LASTEXITCODE}
}
""")
        final = self.latest()
        self.assertEqual(final["steps"][0]["exit_code"], 7)
        self.assertEqual(final["error"]["exit_code"], 7)
        self.run_ps(function + """
$Run = Start-ValidationRun $Reports
try {
    Invoke-Checked 'throwing-command' {
        $script:lock = [IO.File]::Open($Run.Path, 'Open', 'Read', 'None')
        throw 'original-command-error'
    }
} catch {
    if ($_.Exception.Message -ne 'original-command-error') { throw }
} finally { $script:lock.Dispose() }
Complete-ValidationRun $Run failed
""")
        self.assertEqual(self.latest()["steps"][0]["status"], "failed")

    def test_gate_parses_and_starts_evidence_before_environment_resolution(self):
        self.run_ps("""
$tokens=$null; $errors=$null
[void][System.Management.Automation.Language.Parser]::ParseFile(""" + quote(GATE) + """, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
""")
        text = GATE.read_text(encoding="utf-8-sig")
        self.assertLess(text.index("$Run = Start-ValidationRun"),
                        text.index("$PythonExe = Resolve-TestPython"))
        self.assertIn("Complete-ValidationRun -Run $Run -Status $FailureStatus", text)
        self.assertIn("System.Management.Automation.PipelineStoppedException", text)
        self.assertIn("Complete-ValidationRun -Run $Run -Status interrupted", text)


if __name__ == "__main__":
    unittest.main()
