"""Run the updater with local lock holders and executable-only fake tool boundaries."""
from __future__ import annotations

import ast
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

import pytest


ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(os.environ.get("MVHUB_ADMISSION_SOURCE_ROOT", ROOT))
POWERSHELL = str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe")
pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows updater admission")


def test_server_entry_uses_selected_commit_declaration():
    script = (SOURCE / 'tools/run_update_git.ps1').read_text(encoding='utf-8-sig')
    assert 'server-release-compatibility.json' not in script
    assert "'--compatibility'" not in script
    assert "'--source-receipt', $env:MVHUB_SERVER_SOURCE_RECEIPT" in script
    assert "'--verification-python', $env:MVHUB_SERVER_VERIFICATION_PYTHON" in script


@pytest.mark.parametrize('administrator', [False, True])
def test_administrator_guard_precedes_all_update_work(tmp_path, administrator):
    # Evaluate only the admission guard, never the updater body.
    script = tmp_path / 'admin-guard.ps1'
    script.write_text(f"""
$ErrorActionPreference='Stop'
$Tokens=$null; $Errors=$null
$Tree=[System.Management.Automation.Language.Parser]::ParseFile('{SOURCE / 'tools/run_update_git.ps1'}',[ref]$Tokens,[ref]$Errors)
if($Errors){{throw 'parse failure'}}
$Try=$Tree.EndBlock.Statements | Where-Object {{ $_ -is [System.Management.Automation.Language.TryStatementAst] }} | Select-Object -First 1
$Guard=$Try.Body.Statements[0]
if($Guard -isnot [System.Management.Automation.Language.IfStatementAst] -or $Guard.Extent.Text -notmatch 'Test-UpdateAdministrator'){{throw 'administrator guard must be first'}}
function Test-UpdateAdministrator {{ return ${str(administrator).lower()} }}
Invoke-Expression $Guard.Extent.Text
Write-Output 'admitted'
""", encoding='utf-8-sig')
    result = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(script)],
                            capture_output=True, text=True, timeout=20)
    if administrator:
        assert result.returncode == 0 and 'admitted' in result.stdout, result.stderr
    else:
        assert result.returncode != 0 and 'administrator console' in result.stderr, result.stderr
        assert 'admitted' not in result.stdout

MOCK_QUERIES = r'''
function Get-ScheduledTask {
    $fixture = Get-Content -LiteralPath $env:MVHUB_QUERY_FIXTURE -Raw | ConvertFrom-Json
    if ($fixture.task_error) { throw 'fixture scheduler unavailable' }
    return $fixture.tasks
}
function Get-CimInstance {
    param($ClassName, $Filter)
    $fixture = Get-Content -LiteralPath $env:MVHUB_QUERY_FIXTURE -Raw | ConvertFrom-Json
    if ($fixture.process_error) { throw 'fixture process query unavailable' }
    foreach ($processId in $fixture.process_ids) {
        CimCmdlets\Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = " + $processId) -ErrorAction Stop
    }
    return $fixture.processes
}
'''

FAKE_TOOL = r'''
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
public class FakeTool {
    public static int Main(string[] args) {
        string tool = Path.GetFileNameWithoutExtension(Process.GetCurrentProcess().MainModule.FileName).ToLowerInvariant();
        string trace = Environment.GetEnvironmentVariable("MVHUB_TOOL_TRACE");
        File.AppendAllText(trace, tool + " " + String.Join(" ", args) + "\n");
        if (tool == "schtasks") return 1;
        if (tool == "git") {
            if (args.Length > 1 && args[0] == "sparse-checkout" && args[1] == "list") return 1;
            if (args.Length > 1 && args[0] == "rev-parse") {
                Console.WriteLine(args[1] == "HEAD" ? new String('a', 40) : Environment.GetEnvironmentVariable("MVHUB_FIXTURE_GIT_DIR"));
            }
            string wait = Environment.GetEnvironmentVariable("MVHUB_WAIT_PULL");
            if (args.Length > 0 && args[0] == "pull" && !String.IsNullOrEmpty(wait)) {
                File.WriteAllText(wait + ".entered", "entered");
                DateTime deadline = DateTime.UtcNow.AddSeconds(20);
                while (!File.Exists(wait + ".release")) {
                    if (DateTime.UtcNow > deadline) return 91;
                    Thread.Sleep(30);
                }
            }
        }
        if (tool == "python" && args.Length > 0 && args[0] == "--version") Console.WriteLine("Python 3.14 fixture");
        return 0;
    }
}
'''

LOCK_HOLDER = r'''
import msvcrt, os, pathlib, sys, time
root = pathlib.Path(sys.argv[1])
lock = root / 'logs' / sys.argv[2]
lock.parent.mkdir(parents=True, exist_ok=True)
with lock.open('a+b') as stream:
    if stream.tell() == 0:
        stream.write(b'0'); stream.flush()
    stream.seek(0)
    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
    (root / 'holder.ready').write_text(str(os.getpid()))
    try:
        while not (root / 'holder.stop').exists(): time.sleep(.03)
    finally:
        stream.seek(0); msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
'''


def _wait_file(path: Path, process=None):
    deadline = time.monotonic() + 15
    while not path.exists():
        if process is not None and process.poll() is not None:
            raise AssertionError(f"fixture exited before {path.name}: {process.returncode}")
        if time.monotonic() >= deadline:
            raise AssertionError(f"fixture timeout: {path}")
        time.sleep(.03)


@pytest.fixture(scope="session")
def fake_tool(tmp_path_factory):
    folder = tmp_path_factory.mktemp("admission-fake-tool")
    source = folder / "FakeTool.cs"
    source.write_text(FAKE_TOOL, encoding="utf-8")
    executable = folder / "boundary.exe"
    compile_script = folder / "compile.ps1"
    compile_script.write_text(
        "param($Source, $Target)\n$ErrorActionPreference='Stop'\n"
        "Add-Type -TypeDefinition ([IO.File]::ReadAllText($Source)) -OutputAssembly $Target -OutputType ConsoleApplication\n",
        encoding="utf-8-sig",
    )
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-File", str(compile_script), str(source), str(executable)],
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return executable


class UpdaterFixture:
    def __init__(self, folder: Path, fake_tool: Path):
        self.folder = folder
        self.root = folder / "한글 repo"
        self.tools = self.root / "tools"
        self.tools.mkdir(parents=True)
        (self.root / "backend").mkdir()
        (self.root / "frontend/dist").mkdir(parents=True)
        (self.root / "frontend/node_modules").mkdir()
        (self.root / "frontend/dist/index.html").write_text("fixture")
        (self.root / "backend/requirements.txt").write_text("")
        (self.root / ".git").mkdir()
        self.bin = folder / "fake-bin"
        self.bin.mkdir()
        for name in ("git.exe", "node.exe", "schtasks.exe", "boundary.exe"):
            shutil.copy2(fake_tool, self.bin / name)
        (self.root / "runtime/python").mkdir(parents=True)
        shutil.copy2(fake_tool, self.root / "runtime/python/python.exe")
        (self.bin / "npm.cmd").write_text(f'@"{self.bin / "boundary.exe"}" npm %*\n@exit /b %errorlevel%\n', encoding="utf-8")
        coordinator = folder / "coordinator_probe.py"
        coordinator.write_text(
            "import msvcrt,os,pathlib,sys\n"
            "root=pathlib.Path(sys.argv[sys.argv.index('--root')+1])\n"
            "with (root/'logs/server-update.lock').open('a+b') as lock:\n"
            " lock.seek(0); msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)\n"
            " with open(os.environ['MVHUB_TOOL_TRACE'], 'a', encoding='utf-8') as trace: trace.write('coordinator '+ ' '.join(sys.argv[1:])+'\\n')\n"
            "raise SystemExit(int(os.environ.get('MVHUB_COORDINATOR_EXIT','0')))\n",
            encoding="utf-8",
        )
        (self.root / "run_py.bat").write_text(f'@"{sys._base_executable}" -I -S -B "{coordinator}" %*\n@exit /b %errorlevel%\n', encoding="utf-8")
        self.trace_path = folder / "tools.trace"
        self.query = folder / "queries.json"
        self.queries = {"tasks": [], "process_ids": [], "processes": []}
        self.write_queries()
        self.env = {k: v for k, v in os.environ.items() if not k.upper().startswith(("CONTENT_HUB_", "MVHUB_"))}
        for key, relative in (("TEMP", "temp"), ("TMP", "temp"), ("HOME", "profile"), ("USERPROFILE", "profile"),
                              ("APPDATA", "profile/AppData/Roaming"), ("LOCALAPPDATA", "profile/AppData/Local")):
            target = folder / relative; target.mkdir(parents=True, exist_ok=True); self.env[key] = str(target)
        self.env.update({"MVHUB_NO_PAUSE": "1", "MVHUB_QUERY_FIXTURE": str(self.query),
                         "MVHUB_TOOL_TRACE": str(self.trace_path), "MVHUB_FIXTURE_GIT_DIR": str(self.root / ".git"),
                         "MVHUB_SERVER_SOURCE_RECEIPT": str(folder / "source-receipt.json"),
                         "MVHUB_SERVER_VERIFICATION_PYTHON": str(sys._base_executable),
                         "CONTENT_HUB_NO_PROXY": "1", "CONTENT_HUB_READ_ONLY": "1",
                         "CONTENT_HUB_DATA": str(folder / "data"), "CONTENT_HUB_DB": str(folder / "data/db/content_hub.db"),
                         "CONTENT_HUB_SERVER_SYNC": "0", "CONTENT_HUB_EXTERNAL_RECOVERY": "0",
                         "PATH": os.pathsep.join((str(self.bin), str(Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0'), str(Path(os.environ['SystemRoot']) / 'System32'),
                                                  str(Path(os.environ['SystemRoot'])), str(Path(sys._base_executable).parent)))})
        shutil.copy2(ROOT / "update_git.bat", self.root / "update_git.bat")
        shutil.copy2(SOURCE / "tools/update_git_worker.bat", self.tools / "update_git_worker.bat")
        wrapper = (SOURCE / "tools/run_update_git.ps1").read_text(encoding="utf-8-sig")
        wrapper = wrapper.replace('$ErrorActionPreference = "Stop"', '$ErrorActionPreference = "Stop"\n' + MOCK_QUERIES, 1)
        wrapper = wrapper.replace('try {\n    if (-not (Test-UpdateAdministrator))',
                                  'function Test-UpdateAdministrator { return $true }\ntry {\n    if (-not (Test-UpdateAdministrator))', 1)
        (self.tools / "run_update_git.ps1").write_text(wrapper, encoding="utf-8-sig")
        self.processes = []

    def write_queries(self):
        self.query.write_text(json.dumps(self.queries), encoding="utf-8")

    def trace(self):
        return self.trace_path.read_text(encoding="utf-8") if self.trace_path.exists() else ""

    def command(self, direct=False):
        path = self.tools / "update_git_worker.bat" if direct else self.root / "update_git.bat"
        command = ["cmd.exe", "/d", "/c", "call", str(path)]
        if direct: command.append(str(self.root))
        return command

    def run(self, direct=False):
        result = subprocess.run(self.command(direct), cwd=self.root, env=self.env, stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
        evidence = os.environ.get("MVHUB_ADMISSION_EVIDENCE")
        if evidence:
            target = Path(evidence); target.mkdir(parents=True, exist_ok=True)
            (target / (self.folder.name + ("-direct" if direct else "") + ".json")).write_text(
                json.dumps({"command": self.command(direct), "returncode": result.returncode,
                            "stdout": result.stdout, "stderr": result.stderr, "tool_trace": self.trace()}, ensure_ascii=False, indent=2),
                encoding="utf-8")
        return result

    def holder(self, *, own=True, supervisor=True, lock="server-supervisor.lock", entry=None,
               script_argument=None, python_options=("-I", "-S", "-B")):
        root = self.root if own else self.folder / "foreign repo"
        script = root / entry if entry else root / "tools" / ("server_supervisor.py" if supervisor else "lock_holder.py")
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text(LOCK_HOLDER, encoding="utf-8")
        process = subprocess.Popen([sys._base_executable, *python_options, script_argument or str(script), str(root), lock],
                                   cwd=root, env=self.env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.processes.append((process, root))
        _wait_file(root / "holder.ready", process)
        self.queries["process_ids"].append(process.pid); self.write_queries()
        return process

    def close(self):
        for process, root in self.processes:
            (root / "holder.stop").write_text("stop")
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=5)


@pytest.fixture
def updater(tmp_path, fake_tool):
    fixture = UpdaterFixture(tmp_path, fake_tool)
    try: yield fixture
    finally: fixture.close()


@pytest.mark.parametrize("direct", [False, True])
def test_manual_supervisor_routes_only_to_staged_coordinator(updater, direct):
    updater.holder()
    result = updater.run(direct)
    assert result.returncode == 0, result.stdout + result.stderr
    trace = updater.trace()
    assert "git pull" not in trace, trace
    assert "coordinator" in trace and "server_release_update.py" in trace, trace
    assert "pip install" not in trace and " npm " not in trace


def test_idle_worker_keeps_legacy_refresh_path(updater):
    result = updater.run(direct=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "git pull --ff-only" in updater.trace()
    assert "coordinator" not in updater.trace()


@pytest.mark.parametrize("query_error", ["task_error", "process_error"])
def test_query_failure_never_falls_back_to_mutating_worker(updater, query_error):
    updater.queries[query_error] = True; updater.write_queries()
    result = updater.run()
    assert result.returncode != 0
    assert updater.trace() == ""


def test_unknown_python_identity_fails_closed(updater):
    updater.queries["processes"] = [{"Name": "python.exe", "CommandLine": None, "ProcessId": 123}]
    updater.write_queries()
    assert updater.run().returncode != 0
    assert updater.trace() == ""


def test_held_supervisor_lock_without_matching_process_fails_closed(updater):
    updater.holder(supervisor=False)
    assert updater.run().returncode != 0
    assert updater.trace() == ""


def test_active_serve_without_supervisor_never_enters_worker_update(updater):
    updater.holder(lock='fixture-unrelated.lock', entry='backend/serve.py')
    assert updater.run().returncode != 0
    assert updater.trace() == ''


@pytest.mark.parametrize('entry', [r'backend\serve.py', r'.\backend\serve.py',
                                   r'tools\server_supervisor.py', r'.\tools\server_supervisor.py'])
@pytest.mark.parametrize('python_options', [("-I", "-S", "-B"), ("-X", "utf8", "-I", "-S", "-B")])
@pytest.mark.parametrize('direct', [False, True])
def test_relative_python_entrypoint_without_root_proof_never_mutates(updater, entry, python_options, direct):
    updater.holder(lock='fixture-unrelated.lock', entry=entry, script_argument=entry, python_options=python_options)
    result = updater.run(direct)
    assert result.returncode != 0, result.stdout + result.stderr
    assert updater.trace() == '', updater.trace()


def test_stage_updater_lock_prevents_legacy_mutation(updater):
    updater.holder(supervisor=False, lock='server-update.lock')
    assert updater.run().returncode != 0
    assert updater.trace() == ''


def test_unreadable_named_task_action_is_not_confirmed_absence(updater):
    updater.queries['tasks'] = [{'TaskName': 'MVHub Server', 'Actions': []}]
    updater.write_queries()
    assert updater.run().returncode != 0
    assert updater.trace() == ''


@pytest.mark.parametrize("locked", [False, True])
def test_stale_or_locked_activation_marker_is_not_worker_authority(updater, locked):
    marker = updater.root / "logs/server-activation.json"
    marker.parent.mkdir(exist_ok=True); marker.write_bytes(b"do not change or truncate")
    if locked: updater.holder(supervisor=False, lock=marker.name)
    assert updater.run().returncode != 0
    assert updater.trace() == ""
    if locked: updater.close()
    assert marker.read_bytes() == b"do not change or truncate"


@pytest.mark.parametrize("active", [False, True])
def test_registered_server_needs_its_live_coordinator(updater, active):
    updater.queries["tasks"] = [{"TaskName": "MVHub Server", "Actions": [{"Execute": "cmd.exe", "Arguments": f'/c call "{updater.root / "task_launch.bat"}" server'}]}]
    updater.write_queries()
    if active: updater.holder()
    result = updater.run()
    assert result.returncode == (0 if active else 1), result.stdout + result.stderr
    assert "git pull" not in updater.trace()
    assert ("coordinator" in updater.trace()) is active


@pytest.mark.parametrize("source", ["task", "process"])
@pytest.mark.parametrize("active", [False, True])
def test_redirected_command_lines_keep_the_same_admission(updater, source, active):
    # Windows PowerShell 5.1 의 IsPathRooted 는 '>' 조각에 예외를 던졌다 — 2026-10-22 실제 서버 전환에서 멈춤.
    log = updater.root / "logs/server_console.log"
    if source == "task":
        updater.queries["tasks"] = [{"TaskName": "MVHub Server", "Actions": [
            {"Execute": "cmd.exe", "Arguments": f'/c call "{updater.root / "task_launch.bat"}" server > "{log}" 2>&1'}]}]
    else:
        updater.queries["processes"] = [{"Name": "cmd.exe", "ProcessId": 4242, "CommandLine":
            f'cmd.exe /d /c "{sys._base_executable}" "{updater.root / "backend/serve.py"}" > "{log}" 2>&1'}]
    updater.write_queries()
    if active: updater.holder()
    result = updater.run()
    output = result.stdout + result.stderr
    assert "IsPathRooted" not in output, output
    assert result.returncode == (0 if active else 1), output
    assert "git pull" not in updater.trace()
    assert ("coordinator" in updater.trace()) is active


@pytest.mark.parametrize("process", [
    # cmd 의 바깥 두 겹 따옴표 + 공백 경로는 조각 나누기가 경로를 잃는다 — 작업자로 떨어지지 않고 멈춰야 한다.
    {"Name": "cmd.exe", "line": 'cmd.exe /d /c ""{py}" "{serve}" > "{log}" 2>&1"'},
    # 경로 API 가 예외를 던지는 조각('a|b')이 python 명령줄에 있어도 판정은 이어진다(서버 → supervisor 없음 거부).
    {"Name": "python.exe", "line": '"{py}" -I "{serve}" "a|b"'},
])
def test_unparsed_or_invalid_server_command_line_never_enters_worker_update(updater, process):
    line = process["line"].format(py=sys._base_executable, serve=updater.root / "backend/serve.py",
                                  log=updater.root / "logs/server_console.log")
    updater.queries["processes"] = [{"Name": process["Name"], "ProcessId": 4343, "CommandLine": line}]
    updater.write_queries()
    result = updater.run()
    output = result.stdout + result.stderr
    assert "IsPathRooted" not in output and "GetFileName" not in output, output
    assert result.returncode != 0, output
    assert updater.trace() == "", updater.trace()


@pytest.mark.parametrize("arguments", [
    '/c ""{launcher}" > "{log}" 2>&1"',
    '/c ""{task_launch}" server > "{log}" 2>&1"',
])
def test_unparsed_server_task_of_any_name_never_enters_worker_update(updater, arguments):
    # 이름이 'MVHub Server' 가 아니어도 이 설치의 서버 실행을 해석 못 하면 작업자로 떨어지지 않는다.
    args = arguments.format(launcher=updater.root / "MV_server.bat", task_launch=updater.root / "task_launch.bat",
                            log=updater.root / "logs/server_console.log")
    updater.queries["tasks"] = [{"TaskName": "MVHub Custom", "Actions": [{"Execute": "cmd.exe", "Arguments": args}]}]
    updater.write_queries()
    result = updater.run()
    assert result.returncode != 0, result.stdout + result.stderr
    assert updater.trace() == "", updater.trace()


def test_supervisor_path_in_a_wrapper_process_is_server_evidence(updater):
    log = updater.root / "logs/server_console.log"
    updater.queries["processes"] = [{"Name": "cmd.exe", "ProcessId": 4444, "CommandLine":
        f'cmd.exe /d /c "{sys._base_executable}" "{updater.root / "tools/server_supervisor.py"}" > "{log}" 2>&1'}]
    updater.write_queries()
    result = updater.run()
    assert result.returncode != 0, result.stdout + result.stderr
    assert updater.trace() == "", updater.trace()


def test_foreign_task_and_supervisor_do_not_reclassify_worker_clone(updater):
    updater.holder(own=False)
    foreign = updater.folder / "foreign repo/task_launch.bat"
    updater.queries["tasks"] = [{"TaskName": "MVHub Server", "Actions": [{"Execute": "cmd.exe", "Arguments": f'/c call "{foreign}" server'}]}]
    updater.write_queries()
    result = updater.run()
    assert result.returncode == 0, result.stdout + result.stderr
    assert "git pull --ff-only" in updater.trace() and "coordinator" not in updater.trace()


def test_staged_coordinator_failure_is_returned_without_legacy_retry(updater):
    updater.holder()
    updater.env['MVHUB_COORDINATOR_EXIT'] = '23'
    result = updater.run()
    assert result.returncode == 23, result.stdout + result.stderr
    assert len([line for line in updater.trace().splitlines() if line.startswith('coordinator ')]) == 1
    assert 'git pull' not in updater.trace()


def test_worker_holds_supervisor_and_update_locks_through_mutation(updater):
    wait = updater.folder / "pull-wait"
    updater.env["MVHUB_WAIT_PULL"] = str(wait)
    worker = subprocess.Popen(updater.command(), cwd=updater.root, env=updater.env, stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        _wait_file(Path(str(wait) + ".entered"), worker)
        duplicate = updater.run()
        assert duplicate.returncode != 0
        assert updater.trace().count("git pull --ff-only") == 1
        # These are the supervisor/coordinator's real msvcrt byte-zero lock operations.
        activation_source = (ROOT / 'tools/server_activation.py').read_text(encoding='utf-8')
        node = next(n for n in ast.parse(activation_source).body if isinstance(n, ast.FunctionDef) and n.name == 'exclusive_lock')
        start = min([node.lineno, *(d.lineno for d in node.decorator_list)])
        lock_source = '\n'.join(activation_source.splitlines()[start - 1:node.end_lineno])
        for lock in ("server-supervisor.lock", "server-update.lock"):
            probe = updater.folder / (lock + ".py")
            probe.write_text('from pathlib import Path\nfrom contextlib import contextmanager\nimport sys\n' + lock_source + '\nwith exclusive_lock(Path(sys.argv[1])): pass\n', encoding="utf-8")
            result = subprocess.run([sys._base_executable, "-I", "-S", "-B", str(probe), str(updater.root / "logs" / lock)],
                                    env=updater.env, capture_output=True, timeout=10)
            assert result.returncode != 0, f"worker did not hold {lock}"
    finally:
        Path(str(wait) + ".release").write_text("release")
        output, _ = worker.communicate(timeout=30)
    assert worker.returncode == 0, output.decode(errors="replace")


def test_worker_script_has_no_in_place_server_restart_fallback():
    worker = (SOURCE / "tools/update_git_worker.bat").read_text(encoding="utf-8-sig")
    assert 'schtasks /Query /TN "MVHub Server"' not in worker
    assert "restart_server_task.bat" not in worker
    assert "run_update_git.ps1" in worker
