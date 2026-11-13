"""Job Object 로 자식 트리를 소유·종료·확인한다 — 실제 프로세스(Windows 전용).

보는 것: (1) 멈춘 채 만든 자식을 넣으면 그 뒤 만든 후손까지 Job 에 든다 (2) 통째 종료 뒤 남은 수 0 을 OS 가 답한다
(3) 감시의 회수(_terminate_process)가 stdin 닫힘을 무시하고 stdout 을 물려받은 후손이 있는 트리도 기한 안에 끝내고 확인한다
(4) Job 을 쥔 프로세스가 강제 종료되면 남은 트리를 OS 가 끝낸다(감시 스레드에 기대지 않는다).
인터프리터는 이 venv 의 실행기(실행기 → 진짜 파이썬 두 겹)와 그 바탕 파이썬(릴리스의 번들 파이썬처럼 한 겹) 둘 다.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path

from app.services import resolve_selection_monitor, win_job
from app.services.resolve_selection_monitor import ResolveSelectionMonitor

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
WIN_JOB_FILE = str(Path(win_job.__file__).resolve())
# stdin 이 닫혀도 끝나지 않고, stdout 을 물려받은 후손을 하나 둔다(파이프 EOF 가 오지 않는 트리)
TREE = (
    "import os, subprocess, sys, time\n"
    "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])\n"
    "print(os.getpid(), child.pid, flush=True)\n"
    "time.sleep(120)\n"
)
# Job 을 만들어 자식을 넣고 자기 PID·자식의 진짜 PID 를 알린 뒤 멈춰 있는 '허브' 대역(패키지 import 없이 파일로 불러온다 — 바탕 파이썬에는 앱 의존성이 없다)
OWNER = (
    "import importlib.util, os, subprocess, sys, time\n"
    "spec = importlib.util.spec_from_file_location('win_job', sys.argv[1])\n"
    "win_job = importlib.util.module_from_spec(spec); spec.loader.exec_module(win_job)\n"
    "job = win_job.ProcessJob()\n"
    "child = subprocess.Popen([sys.executable, '-c', 'import os, time; print(os.getpid(), flush=True); time.sleep(120)'],\n"
    "                         stdout=subprocess.PIPE, creationflags=win_job.CREATE_SUSPENDED | 0x08000000)\n"
    "job.adopt_suspended(child.pid)\n"
    "print(os.getpid(), int(child.stdout.readline()), flush=True)\n"
    "time.sleep(120)\n"
)


class owned_tree:
    """시험이 띄우는 프로세스 트리를 Job 으로 통째 소유한다 — 첫 줄(PID 들)을 limit 초 안에 못 받으면 트리째 끊어 readline 이 돌아오고,
    블록을 나갈 때(단언 실패·시작 실패 포함) 남은 프로세스를 모두 끝낸다. 실행기만 끊으면 진짜 파이썬·후손이 stdout 을 쥔 채 남을 수 있다.
    `left` = 정리한 뒤 Job 에 남은 프로세스 수 — 0 이 아니면 블록을 나갈 때 시험이 실패한다(다른 예외가 올라가는 중이 아니면)."""

    def __init__(self, args: list[str], limit: float, **popen):
        self.args, self.limit, self.popen = args, limit, popen
        self.job = self.process = self.watchdog = None
        self.left = -1

    def __enter__(self) -> "owned_tree":
        try:
            self.job = win_job.new_process_job()
            flags = NO_WINDOW | (win_job.CREATE_SUSPENDED if self.job else 0)
            self.process = subprocess.Popen(self.args, stdout=subprocess.PIPE, creationflags=flags, **self.popen)
            if self.job:
                self.job.adopt_suspended(self.process.pid)
            self.watchdog = threading.Timer(self.limit, self.job.terminate if self.job else self.process.kill)
            self.watchdog.start()
            self.started = self.process.stdout.readline().split()
            self.watchdog.cancel()
            return self
        except BaseException:
            self.__exit__(None, None, None)  # 시작 도중 실패해도(넣기 실패 등) 띄운 것을 남기지 않는다
            raise

    def __exit__(self, *_exc) -> None:
        if self.watchdog:
            self.watchdog.cancel()
        if self.job:
            try:
                self.job.terminate()
                deadline = time.monotonic() + 5
                while self.job.active() and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.left = self.job.active()
            finally:
                self.job.close()
        if self.process:
            if not self.job or self.process.poll() is None:
                self.process.kill()  # Job 에 넣지 못했거나 Job 없는 환경 — 직접 끝낸다
            self.process.stdout.close()
            self.process.wait(10)
        if self.job and self.left != 0 and (not _exc or _exc[0] is None):
            raise AssertionError(f"시험이 띄운 트리가 정리 뒤에도 남았다(남은 프로세스 {self.left})")


def interpreters() -> list[str]:
    found = [sys.executable]
    base = getattr(sys, "_base_executable", "") or ""
    if base and os.path.isfile(base) and os.path.normcase(base) != os.path.normcase(sys.executable):
        found.append(base)
    return found


def alive(pid: int) -> bool:
    out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
    return str(pid) in out


def wait_dead(pids: list[int], seconds: float) -> list[int]:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline and any(alive(pid) for pid in pids):
        time.sleep(0.1)
    return [pid for pid in pids if alive(pid)]


@unittest.skipUnless(os.name == "nt", "Job Object 는 Windows 전용")
class ProcessJobTests(unittest.TestCase):
    def test_tree_made_after_adoption_is_owned_terminated_and_confirmed(self):
        for exe in interpreters():
            with self.subTest(interpreter=exe):
                job = win_job.ProcessJob()
                process = subprocess.Popen([exe, "-c", TREE], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                           creationflags=win_job.CREATE_SUSPENDED | NO_WINDOW)
                watchdog = threading.Timer(20, job.terminate)  # 시작이 멈추면 트리째 끊어 readline 이 돌아오게
                watchdog.start()
                try:
                    job.adopt_suspended(process.pid)
                    started = process.stdout.readline().split()
                    self.assertEqual(len(started), 2, "트리가 20초 안에 시작하지 못했다")
                    pids = [int(x) for x in started]
                    self.assertGreaterEqual(job.active(), 2)  # 진짜 파이썬과 그 후손(실행기가 있으면 더 많다)
                    job.terminate()
                    deadline = time.monotonic() + 5
                    while job.active() and time.monotonic() < deadline:
                        time.sleep(0.05)
                    self.assertEqual(job.active(), 0, "5초 안에 트리가 다 끝나지 않았다")
                    self.assertEqual(wait_dead(pids, 3), [])
                finally:
                    watchdog.cancel()
                    job.close()
                    if process.poll() is None:
                        process.kill()  # Job 에 넣지 못했으면 자식은 Job 밖에 멈춘 채다 — 직접 끝낸다(시험이 프로세스를 남기지 않는다)
                    process.stdout.close()
                    process.stdin.close()
                    process.wait(10)

    def test_closing_the_job_handle_kills_what_is_left(self):
        job = win_job.ProcessJob()
        process = subprocess.Popen([sys.executable, "-c", TREE], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   creationflags=win_job.CREATE_SUSPENDED | NO_WINDOW)
        watchdog = threading.Timer(20, job.terminate)
        watchdog.start()
        try:
            job.adopt_suspended(process.pid)
            pids = [int(x) for x in process.stdout.readline().split()]
            self.assertEqual(len(pids), 2)
            job.close()  # 끝내라고 하지 않고 핸들만 닫는다
            self.assertEqual(wait_dead(pids, 10), [])
        finally:
            watchdog.cancel()
            job.close()
            if process.poll() is None:
                process.kill()  # Job 에 넣지 못했으면 자식은 Job 밖에 멈춘 채다 — 직접 끝낸다
            process.stdout.close()
            process.stdin.close()
            process.wait(10)

    def test_owner_death_kills_the_tree_without_any_watcher_thread(self):
        """Job 을 쥔 프로세스(허브 대역)가 강제 종료되면 — 자식이 stdin 감시 없이 자고 있어도 — OS 가 자식을 끝낸다."""
        # 허브 대역 자체를 시험의 바깥 Job 이 소유한다(세션 Job 안에서 도는 실제 허브와 같은 겹친 Job 구조 — 안쪽 Job 을 만들 수 있는지도 본다)
        for exe in interpreters():
            with self.subTest(interpreter=exe), owned_tree([exe, "-c", OWNER, WIN_JOB_FILE], 20) as tree:
                self.assertEqual(len(tree.started), 2, "허브 대역이 20초 안에 자식을 띄우지 못했다")
                owner_pid, child_pid = (int(x) for x in tree.started)
                self.assertTrue(alive(child_pid))
                subprocess.run(["taskkill", "/F", "/PID", str(owner_pid)], capture_output=True)
                self.assertEqual(wait_dead([child_pid], 10), [], "Job 을 쥔 프로세스가 죽었는데 자식이 남았다")

    def test_child_made_but_not_yet_adopted_never_runs_if_the_owner_dies(self):
        """보장의 경계 — 멈춘 채 만든 뒤 Job 에 넣기 전에 주인이 죽으면 자식은 남지만 한 줄도 돌지 않는다(끝낼 때까지 멈춘 채)."""
        import tempfile
        marker = Path(tempfile.gettempdir()) / f"mvhub-win-job-marker-{os.getpid()}-{time.monotonic_ns()}"
        owner_script = (
            "import os, subprocess, sys, time\n"
            "child = subprocess.Popen([sys.executable, '-c', 'import sys, time; open(sys.argv[1], \"w\").close(); time.sleep(120)', sys.argv[1]],\n"
            "                         creationflags=0x00000004 | 0x08000000)\n"  # CREATE_SUSPENDED — Job 에 넣지 않는다(넣기 전에 죽는 경우)
            "print(os.getpid(), child.pid, flush=True)\n"
            "time.sleep(120)\n"
        )
        # 주인 대역과 멈춘 자식 모두 시험의 바깥 Job 이 소유한다 — 시작이 멈춰도, 단언이 실패해도 블록을 나갈 때 남기지 않는다
        try:
            with owned_tree([sys.executable, "-c", owner_script, str(marker)], 20) as tree:
                self.assertEqual(len(tree.started), 2)
                owner_pid, child_pid = (int(x) for x in tree.started)
                subprocess.run(["taskkill", "/F", "/PID", str(owner_pid)], capture_output=True)
                time.sleep(1.5)
                self.assertTrue(alive(child_pid), "이 경계에서는 자식이 남는다(멈춘 채)")
                self.assertFalse(marker.exists(), "멈춘 채 남은 자식은 한 줄도 돌지 않았다")
            self.assertEqual(tree.left, 0)
            self.assertEqual(wait_dead([child_pid], 5), [])
        finally:
            marker.unlink(missing_ok=True)

    def test_job_creation_failure_is_raised_not_turned_into_the_jobless_path(self):
        """Windows 에서 Job 을 못 만들면 None(= Job 없는 길)이 아니라 OSError — 호출자가 자식을 띄우지 않는다."""
        from unittest import mock
        with mock.patch.object(win_job, "ProcessJob", side_effect=OSError("CreateJobObject failed")):
            with self.assertRaises(OSError):
                win_job.new_process_job()

    def test_owned_tree_cleans_up_when_adoption_fails(self):
        """시험 도우미 — Job 에 넣기가 실패해도 띄운 프로세스를 남기지 않는다."""
        tree = owned_tree([sys.executable, "-c", "import time; time.sleep(120)"], 5)
        original = win_job.ProcessJob.adopt_suspended
        win_job.ProcessJob.adopt_suspended = lambda self, pid: (_ for _ in ()).throw(OSError("assign failed"))
        try:
            with self.assertRaises(OSError):
                tree.__enter__()
        finally:
            win_job.ProcessJob.adopt_suspended = original
        self.assertIsNotNone(tree.process.poll(), "넣지 못한 프로세스를 끝냈다")

    def test_owned_tree_fails_the_test_when_something_is_left_after_cleanup(self):
        """시험 도우미 — 정리한 뒤에도 Job 에 프로세스가 남으면 시험이 실패한다(다른 예외가 올라가는 중이면 그 예외를 가리지 않는다)."""
        from unittest import mock
        for raising, fails in ((None, True), (ValueError, False)):
            tree = owned_tree([], 5)
            tree.job = mock.Mock(**{"active.return_value": 1})
            clock = iter(range(0, 10**6, 10))
            with mock.patch.object(time, "monotonic", side_effect=lambda: next(clock)):  # 5초 기다림을 건너뛴다
                if fails:
                    with self.assertRaises(AssertionError):
                        tree.__exit__(None, None, None)
                else:
                    tree.__exit__(raising, raising(), None)
            tree.job.close.assert_called_once()


async def _kill_if_left(process) -> None:
    """Job 에 넣지 못했으면(넣기 실패) 자식은 Job 밖에 멈춘 채다 — Job 을 닫아도 안 끝나므로 직접 끝내고, 끝난 것을 기한 안에 확인한다
    (확인하지 못하면 시험이 실패한다 — 시험이 프로세스를 남기지 않는다)."""
    if process.returncode is None:
        try:
            process.kill()
        except ProcessLookupError:
            pass  # 이미 끝났다
        await asyncio.wait_for(process.wait(), 10)


@unittest.skipUnless(os.name == "nt", "Job Object 는 Windows 전용")
class MonitorReapRealProcessTests(unittest.IsolatedAsyncioTestCase):
    async def test_reap_ends_a_tree_that_ignores_stdin_and_keeps_stdout_open(self):
        """stdin 닫힘을 무시하고, stdout 을 물려받은 후손이 살아 있어 파이프 EOF 가 오지 않는 트리 — 기한 안에 통째로 끝내고 확인한다."""
        for exe in interpreters():
            with self.subTest(interpreter=exe):
                job = win_job.ProcessJob()
                process = await asyncio.create_subprocess_exec(
                    exe, "-c", TREE, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    creationflags=win_job.CREATE_SUSPENDED | NO_WINDOW,
                )
                try:
                    job.adopt_suspended(process.pid)
                    setattr(process, resolve_selection_monitor._JOB_ATTR, job)
                    started = (await asyncio.wait_for(process.stdout.readline(), 20)).split()
                    self.assertEqual(len(started), 2)
                    pids = [int(x) for x in started]
                    began = time.monotonic()
                    await asyncio.wait_for(ResolveSelectionMonitor._terminate_process(process), 8)
                    self.assertLess(time.monotonic() - began, 6.0)
                    self.assertEqual(await asyncio.to_thread(wait_dead, pids, 3), [])
                    self.assertIsNone(getattr(process, resolve_selection_monitor._JOB_ATTR))
                finally:
                    job.close()
                    await _kill_if_left(process)

    async def test_reap_of_a_child_with_a_full_unread_stdout_confirms_and_releases_the_pipe(self):
        """출력 포화 — 아무도 읽지 않는 stdout 을 버퍼 상한 넘게 채우며 stdin 닫힘을 무시하는 자식. 회수가 기한 안에 끝나고,
        남은 출력을 비워 파이프가 닫히며(EOF) 직접 자식도 거둬진다."""
        script = (
            "import sys, time\n"
            "print('ready', flush=True)\n"
            "chunk = 'x' * 65536\n"
            "while True:\n"
            "    sys.stdout.write(chunk); sys.stdout.flush()\n"  # 파이프가 차면 여기서 멈춘다
        )
        job = win_job.ProcessJob()
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-c", script, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            limit=64 * 1024, creationflags=win_job.CREATE_SUSPENDED | NO_WINDOW,
        )
        try:
            job.adopt_suspended(process.pid)
            setattr(process, resolve_selection_monitor._JOB_ATTR, job)
            self.assertEqual((await asyncio.wait_for(process.stdout.readline(), 20)).strip(), b"ready")
            await asyncio.sleep(1.0)  # 읽지 않는 동안 버퍼·파이프가 찬다
            began = time.monotonic()
            await asyncio.wait_for(ResolveSelectionMonitor._terminate_process(process), 10)
            self.assertLess(time.monotonic() - began, 8.0)
            self.assertTrue(process.stdout.at_eof(), "남은 출력을 비워 파이프가 닫혔다")
            self.assertIsNotNone(process.returncode, "직접 자식을 거뒀다")
        finally:
            job.close()
            await _kill_if_left(process)

    async def test_reap_lets_a_cooperative_child_exit_by_itself(self):
        """stdin 이 닫히면 스스로 끝나는 자식(작업자의 감시와 같은 방식) — 유예 안에 끝나고 강제 종료 없이 확인된다."""
        script = (
            "import os, sys, threading, time\n"
            "threading.Thread(target=lambda: (sys.stdin.buffer.read(), os._exit(0)), daemon=True).start()\n"
            "print(os.getpid(), flush=True)\n"
            "time.sleep(120)\n"
        )
        job = win_job.ProcessJob()
        terminated = []
        original = job.terminate
        job.terminate = lambda: (terminated.append(1), original())[1]
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-c", script, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            creationflags=win_job.CREATE_SUSPENDED | NO_WINDOW,
        )
        try:
            job.adopt_suspended(process.pid)
            setattr(process, resolve_selection_monitor._JOB_ATTR, job)
            pid = int(await asyncio.wait_for(process.stdout.readline(), 20))
            await asyncio.wait_for(ResolveSelectionMonitor._terminate_process(process), 8)
            self.assertEqual(terminated, [], "스스로 끝난 자식에 강제 종료를 쓰지 않는다")
            self.assertEqual(await asyncio.to_thread(wait_dead, [pid], 3), [])
        finally:
            job.close()
            await _kill_if_left(process)


if __name__ == "__main__":
    unittest.main()
