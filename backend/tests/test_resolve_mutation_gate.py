"""호출마다의 Job(win_job.run_in_job)과 Resolve 변경 문(이름 붙은 뮤텍스 — 프로세스 사이 배제).

· Resolve 도우미 자식은 호출마다의 Job 이 트리째 소유한다 — 제한 시간을 넘기면 후손까지 끝내고 기한 안에 돌아온다.
  조회 자식은 허브가 죽으면 같이 끝나고, Resolve 를 바꾸는 자식은 허브가 죽어도 계속 돈다.
· Resolve 를 바꾸는 자식은 문지기가 변경 문을 쥔다 — 다른 프로세스가 쥐고 있으면(다른 변경·선택 읽기) 대상을 시작하지 않는다.
실제 프로세스 시험은 시험마다의 뮤텍스 이름을 쓴다(제품 이름을 건드리지 않는다). 띄운 트리는 시험의 바깥 Job 이 소유한다(owned_tree) —
시험 대상(run_in_job·문지기)의 정리가 틀려도 시험이 프로세스를 남기지 않는다.
"""

from __future__ import annotations

import asyncio
import ctypes
import errno
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from app.services import (
    resolve_library_connect_worker, resolve_library_dialog, resolve_mutation_guard, resolve_selection_monitor, resolve_status_runner, win_job,
)
from app.services.resolve_mutation_guard import MUTATION_BUSY_EXIT
from tests.test_win_job import WIN_JOB_FILE, alive, interpreters, owned_tree, wait_dead

BACKEND = str(Path(win_job.__file__).resolve().parents[2])
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
REAL_EXCLUSIVE = resolve_library_dialog._run_automation_exclusively  # conftest 가 시험마다 같은 프로세스 실행으로 바꾸기 전의 진짜 함수
LOAD_WIN_JOB = (
    "import importlib.util, os, subprocess, sys, threading, time\n"
    "spec = importlib.util.spec_from_file_location('win_job', sys.argv[1])\n"
    "win_job = importlib.util.module_from_spec(spec); spec.loader.exec_module(win_job)\n"
)
# stdout 을 물려받은 후손을 하나 두고, 자기 PID·후손 PID 를 파일에 적은 뒤 잔다(직접 자식만 끝내면 파이프가 닫히지 않는 트리)
SPAWNER = (
    "import os, subprocess, sys, time\n"
    "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])\n"
    "open(sys.argv[1], 'w').write(f'{os.getpid()} {child.pid}')\n"
    "time.sleep(120)\n"
)
# run_in_job 을 부르는 '허브' 대역: argv = [win_job 파일, 인터프리터, 자식 스크립트, PID 파일, kill_on_close(1/0), 함께 돌릴 다른 호출(1/0)]
# 제한 시간(4초)에 걸린 결과·걸린 시간·남은 미확인 트리 수·(함께 돌린 호출의 결과)를 한 줄로 알리고 멈춰 있다.
TIMEOUT_DRIVER = LOAD_WIN_JOB + (
    "other = {}\n"
    "def fine():\n"
    "    other['done'] = win_job.run_in_job([sys.executable, '-c', \"import time; time.sleep(6); print('done')\"], timeout=60, text=True, creationflags=0x08000000)\n"
    "side = threading.Thread(target=fine) if sys.argv[6] == '1' else None\n"
    "side and side.start()\n"
    "began = time.monotonic()\n"
    "try:\n"
    "    win_job.run_in_job([sys.argv[2], '-c', sys.argv[3], sys.argv[4]], timeout=4, kill_on_close=sys.argv[5] == '1', text=True, creationflags=0x08000000)\n"
    "    outcome = 'returned'\n"
    "except subprocess.TimeoutExpired:\n"
    "    outcome = 'timeout'\n"
    "elapsed = time.monotonic() - began\n"
    "side and side.join(60)\n"
    "print(outcome, round(elapsed, 1), len(win_job._strays), other['done'].stdout.strip() if side else '-', flush=True)\n"
    "time.sleep(120)\n"
)
# run_in_job 으로 자식을 돌리다 강제 종료될 '허브' 대역: argv = [win_job 파일, PID 파일, kill_on_close(1/0)]
HUB = LOAD_WIN_JOB + (
    "child = 'import os, sys, time; open(sys.argv[1], \"w\").write(str(os.getpid())); time.sleep(120)'\n"
    "threading.Thread(target=lambda: win_job.run_in_job([sys.executable, '-c', child, sys.argv[2]], kill_on_close=sys.argv[3] == '1',\n"
    "                                                 creationflags=0x08000000), daemon=True).start()\n"
    "while not os.path.exists(sys.argv[2]) or not open(sys.argv[2]).read():\n"
    "    time.sleep(0.05)\n"
    "print(os.getpid(), open(sys.argv[2]).read(), flush=True)\n"
    "time.sleep(120)\n"
)
# 큰 입력을 쓰는 도중 기다림을 떠나는 '허브' 대역: argv = [win_job 파일, 결과 파일]. 자식은 2초 뒤에야 입력을 읽어 받은 글자 수를 파일에 적는다.
# 한 줄로 알린다 — 결과(unknown)·돌아오는 데 걸린 시간·자식이 받은 글자 수·남은 미확인 트리 수.
LEAVER = LOAD_WIN_JOB + (
    "child = 'import sys, time; time.sleep(2); data = sys.stdin.read(); open(sys.argv[1], \"w\").write(str(len(data)))'\n"
    "def leave(self, args, timeout):\n"
    "    time.sleep(0.3)\n"  # 입력 스레드가 꽉 찬 파이프에 막혀 있을 때
    "    raise RuntimeError('caller broke')\n"
    "win_job._Pump.wait = leave\n"
    "began = time.monotonic()\n"
    "try:\n"
    "    win_job.run_in_job([sys.executable, '-c', child, sys.argv[2]], input_text='x' * (4 << 20), kill_on_close=False, text=True, creationflags=0x08000000)\n"
    "    outcome = 'returned'\n"
    "except win_job.ChildOutcomeUnknown:\n"
    "    outcome = 'unknown'\n"
    "elapsed = time.monotonic() - began\n"
    "deadline = time.monotonic() + 30\n"
    "while time.monotonic() < deadline and not (os.path.exists(sys.argv[2]) and open(sys.argv[2]).read()):\n"
    "    time.sleep(0.05)\n"
    "print(outcome, round(elapsed, 1), open(sys.argv[2]).read() if os.path.exists(sys.argv[2]) else '-', len(win_job._strays), flush=True)\n"
    "time.sleep(120)\n"
)
# 문지기를 시험 이름의 뮤텍스로 돌린다: argv = [뮤텍스 이름, 대상 모듈]
GUARD = "import sys; from app.services.resolve_mutation_guard import main; raise SystemExit(main([sys.argv[2]], mutex_name=sys.argv[1]))"
# 뮤텍스를 쥔 채 멈춰 있는 프로세스: argv = [win_job 파일, 이름]
HOLDER = LOAD_WIN_JOB + (
    "gate = win_job.NamedMutex(sys.argv[2])\n"
    "print('held' if gate.acquire(0) else 'busy', flush=True)\n"
    "time.sleep(120)\n"
)
# Resolve 연결 호출이 **GIL 을 쥔 채** 돌아오지 않는 선택 작업자(네이티브 멈춤 — 이 프로세스의 파이썬 스레드는 아무것도 돌지 못한다): argv = [뮤텍스 이름]
STUCK_READER = (
    "import ctypes, sys\n"
    "from app.services import resolve_selection_worker as worker, win_job\n"
    "def never_returns():\n"
    "    print('reading', flush=True)\n"
    "    ctypes.PyDLL('kernel32').Sleep(120000)\n"
    "worker._connect_resolve = never_returns\n"
    "worker._exit_when_stdin_closes()\n"
    "raise SystemExit(worker.main(win_job.NamedMutex(sys.argv[1])))\n"
)


def unique_name() -> str:
    return f"Local\\MVHub_Test_{os.getpid()}_{time.monotonic_ns()}"


def read_pids(path: Path, seconds: float) -> list[int]:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if path.exists() and (text := path.read_text().strip()):
            return [int(x) for x in text.split()]
        time.sleep(0.05)
    return []


@unittest.skipUnless(os.name == "nt", "Job Object 는 Windows 전용")
class RunInJobRealProcessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.pid_file = Path(self.tmp.name, "pids")
        self.assertEqual(win_job._strays, [])
        self.addCleanup(lambda: self.assertEqual(win_job._strays, [], "시험이 미확인 트리를 남겼다"))

    def test_returns_output_and_passes_input_like_subprocess_run(self):
        done = win_job.run_in_job([sys.executable, "-c", "import sys; print(sys.stdin.read().upper()); sys.exit(3)"],
                                  input_text="hello", timeout=30, text=True, creationflags=NO_WINDOW)
        self.assertEqual((done.returncode, done.stdout.strip(), done.stderr), (3, "HELLO", ""))

    def test_timeout_ends_the_whole_tree_in_bounded_time_even_when_a_descendant_holds_the_pipes(self):
        """직접 자식이 venv 실행기든 바탕 파이썬이든, stdout 을 물려받은 후손이 남아 있어도 — 제한 시간 뒤 기한 안에 돌아오고 트리가 사라진다."""
        for exe in interpreters():
            for flag in ("1", "0"):
                with self.subTest(interpreter=exe, kill_on_close=flag):
                    self.pid_file.unlink(missing_ok=True)
                    with owned_tree([sys.executable, "-c", TIMEOUT_DRIVER, WIN_JOB_FILE, exe, SPAWNER, str(self.pid_file), flag, "0"], 40) as tree:
                        self.assertEqual(len(tree.started), 4, "허브 대역이 40초 안에 답하지 못했다(정리가 멈췄다)")
                        outcome, elapsed, strays, _other = tree.started
                        self.assertEqual((outcome, strays), (b"timeout", b"0"))
                        self.assertLess(float(elapsed), 4 + 8, "정리에 기한이 있다")
                        pids = read_pids(self.pid_file, 1)
                        self.assertEqual(len(pids), 2, "트리가 제한 시간 안에 시작하지 못했다")
                        self.assertEqual(wait_dead(pids, 5), [], "허브 대역은 살아 있는데 제한 시간에 걸린 트리가 남았다")

    def test_a_timed_out_call_does_not_touch_another_call(self):
        with owned_tree([sys.executable, "-c", TIMEOUT_DRIVER, WIN_JOB_FILE, sys.executable, SPAWNER, str(self.pid_file), "1", "1"], 90) as tree:
            self.assertEqual(len(tree.started), 4)
            self.assertEqual((tree.started[0], tree.started[3]), (b"timeout", b"done"), "다른 호출의 트리는 끝내지 않는다")

    def test_hub_death_ends_a_reading_child_but_not_a_mutating_one(self):
        """허브(run_in_job 을 부른 프로세스)가 강제 종료되면 — 조회 자식(kill_on_close)은 OS 가 끝내고, 변경 자식은 계속 돈다."""
        for flag, survives in (("1", False), ("0", True)):
            with self.subTest(kill_on_close=flag):
                self.pid_file.unlink(missing_ok=True)
                with owned_tree([sys.executable, "-c", HUB, WIN_JOB_FILE, str(self.pid_file), flag], 30) as tree:
                    self.assertEqual(len(tree.started), 2, "허브 대역이 30초 안에 자식을 띄우지 못했다")
                    hub_pid, child_pid = (int(x) for x in tree.started)
                    subprocess.run(["taskkill", "/F", "/PID", str(hub_pid)], capture_output=True)
                    if survives:
                        time.sleep(2.0)
                        self.assertTrue(alive(child_pid), "Resolve 를 바꾸는 자식은 허브가 죽어도 계속 돈다")
                    else:
                        self.assertEqual(wait_dead([child_pid], 10), [], "조회 자식이 죽은 허브 뒤에 남았다")

    def test_adoption_failure_ends_the_unstarted_child_and_raises(self):
        marker = Path(self.tmp.name, "ran")
        spawned: list[subprocess.Popen] = []
        real_popen = subprocess.Popen

        def recording(*args, **kwargs):
            spawned.append(real_popen(*args, **kwargs))
            return spawned[-1]

        with mock.patch.object(win_job.ProcessJob, "adopt_suspended", side_effect=OSError("assign failed")), \
             mock.patch.object(subprocess, "Popen", side_effect=recording):
            with self.assertRaises(OSError):
                win_job.run_in_job([sys.executable, "-c", "import sys; open(sys.argv[1], 'w').close()", str(marker)],
                                   timeout=20, text=True, creationflags=NO_WINDOW)
        self.assertEqual(len(spawned), 1)
        self.assertIsNotNone(spawned[0].poll(), "넣지 못한 자식이 끝난 것을 확인했다")
        self.assertEqual(wait_dead([spawned[0].pid], 3), [])
        self.assertFalse(marker.exists(), "한 줄도 돌지 않았다")

    def test_job_creation_failure_spawns_nothing(self):
        with mock.patch.object(win_job, "ProcessJob", side_effect=OSError("CreateJobObject failed")), \
             mock.patch.object(subprocess, "Popen") as popen:
            with self.assertRaises(OSError):
                win_job.run_in_job([sys.executable, "-c", "pass"], timeout=5)
        popen.assert_not_called()  # Job 없이 조용히 돌리지 않는다


class FakeTreeJob:
    """ProcessJob 대역 — 남은 프로세스 수와 '끝내라'가 듣는지를 시험이 정한다."""

    def __init__(self, alive=1, dies_on_terminate=True, adopt_error=None):
        self.alive, self.dies_on_terminate, self.adopt_error = alive, dies_on_terminate, adopt_error
        self.terminated = self.closed = 0
        self.query_error: OSError | None = None

    adopted = 0

    def adopt_suspended(self, _pid):
        self.adopted += 1
        if self.adopt_error:
            raise self.adopt_error

    def active(self):
        if self.query_error:
            raise self.query_error
        return self.alive

    def terminate(self):
        self.terminated += 1
        if self.dies_on_terminate:
            self.alive = 0

    def close(self):
        self.closed += 1


class FakeChild:
    """Popen 대역 — 출력은 'out' 한 덩이. returncode 가 None 이면 기다림이 곧바로 제한 시간에 걸린다. on_wait 로 기다리는 자리에 끼어든다."""

    def __init__(self, dies_on_kill=True, on_wait=None):
        self.pid, self.returncode, self.dies_on_kill = 777, None, dies_on_kill
        self.killed = 0
        self.stdin, self.stdout, self.stderr = io.StringIO(), io.StringIO("out"), io.StringIO()
        self.on_wait = on_wait

    def poll(self):
        return self.returncode

    def kill(self):
        self.killed += 1
        if self.dies_on_kill:
            self.returncode = 1

    def wait(self, timeout=None):
        if self.on_wait:
            hook, self.on_wait = self.on_wait, None  # 한 번만 — 정리 단계의 기다림에는 끼어들지 않는다
            hook()
        if self.returncode is None:
            raise subprocess.TimeoutExpired(["x"], timeout)
        return self.returncode


class BrokenStream(io.StringIO):
    def read(self, *_a):
        raise OSError("pipe broken")


def raising(error):
    def hook():
        raise error
    return hook


@unittest.skipUnless(os.name == "nt", "run_in_job 의 Job 길은 Windows 전용")
class RunInJobUnconfirmedTests(unittest.TestCase):
    """끝내라고 한 트리가 끝난 것을 확인하지 못하면 놓지 않는다 — 붙들어 두고 다음 호출이 다시 확인하며, 그동안 새 자식을 띄우지 않는다."""

    def setUp(self):
        self.jobs: list[FakeTreeJob] = []
        self.children: list[FakeChild] = []
        self.next_job = FakeTreeJob()
        self.next_child = FakeChild()
        patches = (
            mock.patch.object(win_job, "ProcessJob", side_effect=lambda **_k: self.jobs.append(self.next_job) or self.next_job),
            mock.patch.object(subprocess, "Popen", side_effect=lambda *_a, **_k: self.children.append(self.next_child) or self.next_child),
            mock.patch.object(win_job, "_TREE_REAP_SECONDS", 0.1),
            mock.patch.object(win_job, "_TREE_TIDY_SECONDS", 0.05),
            mock.patch.object(win_job, "_strays", []),
        )
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def run_once(self, **kwargs):
        return win_job.run_in_job(["x"], timeout=5, **kwargs)

    def test_normal_run_closes_the_job_and_keeps_nothing(self):
        self.next_child.returncode = 0
        self.assertEqual(self.run_once().stdout, "out")
        self.assertEqual((self.next_job.closed, win_job._strays), (1, []))

    def test_spawn_failure_closes_the_empty_job(self):
        with mock.patch.object(subprocess, "Popen", side_effect=OSError("spawn failed")):
            with self.assertRaises(OSError):
                self.run_once()
        self.assertEqual(self.next_job.closed, 1)

    def test_child_outside_the_job_that_does_not_die_is_kept_and_blocks_new_children_until_it_ends(self):
        """넣기 실패(자식은 Job 밖) + kill 이 듣지 않음 → 그 자식을 붙든다. 다음 호출은 다시 끝내라고 하고 새 자식 없이 실패, 끝난 뒤에는 회복."""
        job, child = self.next_job, self.next_child
        job.alive, job.adopt_error, child.dies_on_kill = 0, OSError("assign failed"), False
        with self.assertRaises(OSError):
            self.run_once()
        self.assertEqual(win_job._strays, [(None, child)])
        self.assertEqual(job.closed, 1, "Job 밖의 자식 — 빈 Job 은 닫는다")
        self.assertFalse(child.stdin.closed, "끝난 것을 확인하지 못한 자식의 파이프는 거두지 않는다(대역의 출력은 읽는 스레드가 끝까지 읽고 닫았다)")
        for _again in range(3):  # 되풀이해도 미확인 자식은 하나에서 멈춘다
            with self.assertRaisesRegex(OSError, "종료를 아직 확인하지 못했습니다"):
                self.run_once()
        self.assertEqual((len(self.children), len(win_job._strays)), (1, 1), "미확인 자식이 있는 동안 새 자식을 띄우지 않는다")
        self.assertEqual(child.killed, 4, "확인할 때마다 다시 끝내라고 한다")
        child.returncode = 1  # 나중에 실제로 끝났다
        self.next_job, self.next_child = FakeTreeJob(), FakeChild()
        self.next_child.returncode = 0
        self.assertEqual(self.run_once().stdout, "out")
        self.assertEqual(win_job._strays, [])
        self.assertTrue(child.stdin.closed, "끝난 것이 확인되면 거둔다")

    def test_child_stuck_inside_the_job_is_kept_with_its_job(self):
        """풀기 실패(자식은 Job 안) + 통째 종료가 듣지 않음 → Job 을 닫지 않고 함께 붙든다(닫으면 다시 물을 수 없다)."""
        job, child = self.next_job, self.next_child
        job.adopt_error, job.dies_on_terminate = OSError("resume failed"), False
        with self.assertRaises(OSError):
            self.run_once(kill_on_close=False)
        self.assertEqual(win_job._strays, [(job, child)])
        self.assertEqual((job.terminated, job.closed), (1, 0))
        job.alive = 0
        self.next_job, self.next_child = FakeTreeJob(), FakeChild()
        self.next_child.returncode = 0
        self.run_once()
        self.assertEqual((win_job._strays, job.closed), ([], 1))

    def test_timeout_whose_tree_does_not_end_is_kept_and_a_failed_query_counts_as_alive(self):
        job, child = self.next_job, self.next_child
        job.dies_on_terminate = False
        began = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            self.run_once(kill_on_close=False)
        self.assertLess(time.monotonic() - began, 2.0, "확인하지 못해도 기한 안에 돌아온다")
        self.assertEqual((win_job._strays, job.closed), ([(job, child)], 0))
        job.query_error = OSError("query failed")  # 물을 수 없음 — 끝난 증거가 아니다
        with self.assertRaisesRegex(OSError, "종료를 아직 확인하지 못했습니다"):
            self.run_once()
        self.assertEqual(len(win_job._strays), 1)

    def test_calls_already_running_together_each_keep_their_own_unconfirmed_tree(self):
        """막는 것은 미확인 트리를 **확인한 뒤의** 새 실행이다 — 이미 함께 돌던 두 호출이 둘 다 미확인으로 끝나면 둘 다 붙든다(하나도 놓지 않는다)."""
        job_a, child_a = FakeTreeJob(dies_on_terminate=False), FakeChild()
        job_b, child_b = FakeTreeJob(dies_on_terminate=False), FakeChild()

        def a_runs_while_b_starts_and_times_out():
            self.next_job, self.next_child = job_b, child_b
            with self.assertRaises(subprocess.TimeoutExpired):
                self.run_once()  # A 가 도는 동안 시작한 B — 그때는 미확인 트리가 없었다

        child_a.on_wait = a_runs_while_b_starts_and_times_out  # 그 뒤 A 도 제한 시간에 걸린다
        self.next_job, self.next_child = job_a, child_a
        with self.assertRaises(subprocess.TimeoutExpired):
            self.run_once()
        self.assertEqual(win_job._strays, [(job_b, child_b), (job_a, child_a)])
        with self.assertRaises(win_job.PreviousChildUnconfirmed):
            self.run_once()
        self.assertEqual(len(self.children), 2, "미확인 트리를 확인한 뒤에는 새 자식을 띄우지 않는다")

    def test_timeout_ends_the_tree_of_a_mutating_child_too(self):
        job, child = self.next_job, self.next_child
        child.on_wait = raising(subprocess.TimeoutExpired(["x"], 5))
        child.returncode = 1
        with self.assertRaises(subprocess.TimeoutExpired):
            self.run_once(kill_on_close=False)
        self.assertEqual((job.terminated, job.closed, win_job._strays), (1, 1, []))

    def test_leaving_the_wait_after_start_is_outcome_unknown_and_never_cuts_a_mutating_child(self):
        """자식이 시작된 뒤 부른 쪽이 기다리다 떠남 — '실행하지 못함'(OSError)이 아니라 결과 미확인. 조회 자식은 끝내고, Resolve 를 바꾸는
        자식은 끊지 않으며 그 파이프도 건드리지 않는다(입출력 스레드가 계속 맡는다)."""
        for kill_on_close, terminated in ((True, 1), (False, 0)):
            with self.subTest(kill_on_close=kill_on_close):
                job, child = FakeTreeJob(), FakeChild(on_wait=raising(RuntimeError("caller broke")))
                self.next_job, self.next_child = job, child
                with self.assertRaises(win_job.ChildOutcomeUnknown) as raised:
                    self.run_once(kill_on_close=kill_on_close)
                self.assertIsInstance(raised.exception, subprocess.SubprocessError)
                self.assertNotIsInstance(raised.exception, OSError)
                self.assertEqual((job.terminated, job.closed, win_job._strays), (terminated, 1, []))
                if not kill_on_close:
                    self.assertEqual(child.killed, 0)

    def test_output_that_could_not_be_read_is_outcome_unknown_even_though_the_child_ended(self):
        job, child = self.next_job, self.next_child
        child.stdout, child.returncode = BrokenStream(), 0
        with self.assertRaises(win_job.ChildOutcomeUnknown):
            self.run_once(kill_on_close=False)
        self.assertEqual((job.terminated, job.closed, child.killed), (0, 1, 0))

    def test_output_still_held_open_after_the_child_exited_counts_against_the_time_limit(self):
        """직접 자식은 끝났는데 출력 파이프를 쥔 후손이 남아 읽기가 안 끝남 — 제한 시간에 걸려 트리째 끝낸다(반쪽 결과를 돌려주지 않는다)."""
        release = threading.Event()
        self.addCleanup(release.set)

        class HeldOpen(io.StringIO):
            def read(self, *_a):
                release.wait(20)
                return ""

        job, child = self.next_job, self.next_child
        child.stdout, child.returncode = HeldOpen(), 0
        with self.assertRaises(subprocess.TimeoutExpired):
            win_job.run_in_job(["x"], timeout=0.3)
        self.assertEqual((job.terminated, win_job._strays), (1, []))

    def test_a_failed_read_still_drains_what_is_left_before_closing(self):
        """출력을 읽다 실패해도(해석 오류 등) 남은 것을 받아 버린 뒤에 닫는다 — 안 받으면 아직 쓰는 자식이 꽉 찬 파이프에 막힌다."""

        class HalfBroken(io.StringIO):
            def read(self, *_a):
                raise UnicodeDecodeError("utf-8", b"", 0, 1, "bad byte")

        job, child = self.next_job, self.next_child
        child.stdout, child.returncode = HalfBroken(), 0
        child.stdout.buffer = io.BytesIO(b"x" * 200_000)
        with self.assertRaises(win_job.ChildOutcomeUnknown):
            self.run_once(kill_on_close=False)
        self.assertEqual(child.stdout.buffer.read(), b"", "남은 출력을 끝까지 받았다")

    def test_io_threads_start_before_the_child_runs_and_a_failure_there_is_a_clean_not_runnable(self):
        """입출력 스레드를 못 띄우면 자식을 풀지 않는다 — 한 줄도 돌지 않은 채 끝내고 '실행할 수 없음'(OSError). 돈 뒤에 입출력 주인을 구하는 일이 없다."""
        job, child = self.next_job, self.next_child
        real_start = threading.Thread.start

        def start(thread):
            if thread.name == "resolve-child-stderr":
                raise RuntimeError("can't start new thread")
            return real_start(thread)

        with mock.patch.object(threading.Thread, "start", start):
            with self.assertRaises(OSError) as raised:
                self.run_once(kill_on_close=False, input_text="{}")
        self.assertNotIsInstance(raised.exception, win_job.ChildOutcomeUnknown)
        self.assertEqual((job.adopted, child.killed, job.closed, win_job._strays), (0, 1, 1, []))

    def test_an_interrupt_while_the_child_is_being_adopted_waits_for_the_outcome_and_then_follows_it(self):
        """넣기·풀기는 중단이 닿지 않는 스레드가 끝까지 한다 — 부른 쪽은 중단돼도 그 결과를 본 뒤에 판단한다(풀렸는지 모르는 상태가 없다).
        풀렸으면: Resolve 를 바꾸는 자식은 끊지 않고 조회 자식은 끝낸다. 넣기·풀기가 실패했으면(멈춘 채): 끝낸다. 어느 쪽이든 중단은 그대로 올라간다."""
        real_wait = win_job._wait
        for kill_on_close, adopt_error, terminated in ((False, None, 0), (True, None, 1), (False, OSError("resume failed"), 1)):
            with self.subTest(kill_on_close=kill_on_close, adopt_fails=adopt_error is not None):
                interrupted = threading.Event()

                class SlowJob(FakeTreeJob):
                    def adopt_suspended(self, pid):
                        interrupted.wait(5)  # 부른 쪽이 중단될 때까지 아직 '풀기 전'이다 — 그래도 끝까지 한다
                        time.sleep(0.05)
                        super().adopt_suspended(pid)

                def wait(event, seconds):
                    if seconds is None and not interrupted.is_set():  # 넣기·풀기의 끝을 기다리는 자리에서 중단된다
                        interrupted.set()
                        raise KeyboardInterrupt
                    return real_wait(event, seconds)

                job, child = SlowJob(adopt_error=adopt_error), FakeChild()
                self.next_job, self.next_child = job, child
                with mock.patch.object(win_job, "_wait", wait):
                    with self.assertRaises(KeyboardInterrupt):
                        self.run_once(kill_on_close=kill_on_close)
                self.assertEqual(job.adopted, 1, "중단돼도 넣기·풀기는 끝까지 갔다")
                self.assertEqual((job.terminated, child.killed, job.closed, win_job._strays), (terminated, 0, 1, []))

    def test_an_interrupt_while_starting_the_adopt_thread_is_owned_too(self):
        """넣기·풀기 스레드를 띄우는 도중의 중단 — 작업자가 뜨지 않았으면 자식은 멈춘 채이므로 끝낸다. 떴으면 끝까지 기다려 그 결과를 따른다.
        '뜨지 않았다'로 판정한 뒤 뒤늦게 뜬 작업자는 아무것도 하지 않는다(끝내는 자식을 뒤늦게 풀지 않는다)."""
        real_start = threading.Thread.start
        late: list[threading.Timer] = []

        def never(thread):
            raise KeyboardInterrupt  # 띄우기 전에 중단

        def after(thread):
            real_start(thread)
            raise KeyboardInterrupt  # 띄운 직후 중단

        def much_later(thread):
            late.append(threading.Timer(0.3, real_start, args=(thread,)))
            late[-1].start()
            raise KeyboardInterrupt  # 중단됐고, 작업자는 판정 기한보다 늦게 뜬다

        for how, adopted, killed in ((never, 0, 1), (after, 1, 0), (much_later, 0, 1)):
            with self.subTest(how=how.__name__):
                job, child = FakeTreeJob(), FakeChild()
                self.next_job, self.next_child = job, child

                def start(thread, _how=how):
                    return _how(thread) if thread.name == "resolve-child-adopt" else real_start(thread)

                with mock.patch.object(threading.Thread, "start", start), mock.patch.object(win_job, "_ADOPT_START_SECONDS", 0.05):
                    with self.assertRaises(KeyboardInterrupt):
                        self.run_once(kill_on_close=False)
                for timer in late:
                    timer.join(5)
                time.sleep(0.2)  # 뒤늦게 뜬 작업자가 무언가 했다면 여기서 드러난다
                self.assertEqual((job.adopted, child.killed, job.terminated, job.closed, win_job._strays), (adopted, killed, 0, 1, []))

    def test_no_thread_for_adopting_means_the_child_never_ran(self):
        job, child = self.next_job, self.next_child
        real_start = threading.Thread.start

        def start(thread):
            if thread.name == "resolve-child-adopt":
                raise RuntimeError("can't start new thread")
            return real_start(thread)

        with mock.patch.object(threading.Thread, "start", start):
            with self.assertRaises(OSError):
                self.run_once(kill_on_close=False)
        self.assertEqual((job.adopted, child.killed, job.closed, win_job._strays), (0, 1, 1, []))

    def test_interrupt_is_passed_through_with_the_same_cut_policy(self):
        job, child = self.next_job, self.next_child
        child.on_wait = raising(KeyboardInterrupt())
        with self.assertRaises(KeyboardInterrupt):
            self.run_once(kill_on_close=False)
        self.assertEqual(job.terminated, 0)


class RunChildRoutingTests(unittest.TestCase):
    """resolve_status_runner._run_child — 조회 자식은 허브와 함께 끝나게, 바꾸는 자식은 문지기를 거쳐 허브보다 오래 살 수 있게."""

    def setUp(self):
        self.done = subprocess.CompletedProcess(["x"], 0, "out", "")
        for patch in (
            mock.patch.object(resolve_status_runner, "_resolve_is_closed", return_value=False),
            mock.patch.object(resolve_status_runner, "_select_interpreter", return_value=("py", {"status": "ready"}, "")),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def test_reading_child_is_tied_to_the_hub(self):
        with mock.patch.object(resolve_status_runner, "run_in_job", return_value=self.done) as run:
            result = resolve_status_runner._run_child("py", "app.services.resolve_probe", timeout=8, input_text="{}")
        self.assertIs(result, self.done)
        self.assertEqual(run.call_args.args[0], ["py", "-m", "app.services.resolve_probe"])
        self.assertEqual((run.call_args.kwargs["timeout"], run.call_args.kwargs["input_text"], run.call_args.kwargs["kill_on_close"]), (8, "{}", True))

    def test_mutating_child_runs_through_the_guard_and_outlives_the_hub(self):
        with mock.patch.object(resolve_status_runner, "run_in_job", return_value=self.done) as run:
            resolve_status_runner._run_child("py", "app.services.resolve_import_worker", timeout=None, input_text="{}", mutation=True)
        self.assertEqual(run.call_args.args[0], ["py", "-m", "app.services.resolve_mutation_guard", "app.services.resolve_import_worker"])
        self.assertEqual((run.call_args.kwargs["timeout"], run.call_args.kwargs["kill_on_close"]), (None, False))

    def test_a_child_that_cannot_be_owned_is_reported_as_not_runnable(self):
        """실행 전 실패(Job 을 만들거나 넣지 못함 — OSError): Job 없이 다시 띄우지 않고 '실행할 수 없음'으로 답한다."""
        with mock.patch.object(resolve_status_runner, "run_in_job", side_effect=OSError("assign failed")) as run:
            result = resolve_status_runner.run_resolve_import_isolated({"items": []})
            listed = resolve_status_runner.run_resolve_library_list_isolated()
        self.assertEqual((result["status"], result["error_code"]), ("unavailable", "spawn_failed"))
        self.assertEqual(listed["error_code"], "spawn_failed")
        self.assertEqual(run.call_count, 2)

    def test_blocked_by_an_unconfirmed_child_after_the_interpreter_check_was_reused_still_says_so(self):
        """인터프리터 선택이 재사용돼(검사를 건너뜀) 실제 실행에서 처음 차단을 만나도 같은 안내 — '실행 못 함'·'결과 확인 필요'로 답하지 않는다."""
        message = resolve_status_runner.PREVIOUS_CHILD_MESSAGE
        with mock.patch.object(resolve_status_runner, "run_in_job", side_effect=win_job.PreviousChildUnconfirmed("x")):
            imported = resolve_status_runner.run_resolve_import_isolated({"items": []})
            opened = resolve_status_runner.run_resolve_project_open_isolated({"library_name": "L", "project_name": "P", "folder_parts": []})
            adopted = resolve_status_runner.run_resolve_panel_isolated({"operation": "adopt"})
            listed = resolve_status_runner.run_resolve_library_list_isolated()
        self.assertEqual((imported["error_code"], imported["error"]), ("api_unavailable", message))
        self.assertEqual(opened["error_code"], "api_unavailable")
        self.assertEqual(adopted, {"state": "unavailable", "details": message})
        self.assertEqual(listed["error_code"], "api_unavailable")

    def test_a_mutation_whose_outcome_is_unknown_is_not_reported_as_never_run(self):
        """실행 뒤 결과 미확인 — 이미 Resolve 를 바꿨을 수 있다. '실행하지 못함'(spawn_failed)이 아니라 결과 없이 죽은 자식과 같은 '확인 필요'."""
        unknown = win_job.ChildOutcomeUnknown("pipe broken")
        with mock.patch.object(resolve_status_runner, "run_in_job", side_effect=unknown):
            imported = resolve_status_runner.run_resolve_import_isolated({"items": []})
            timeline = resolve_status_runner.run_resolve_timeline_isolated({"items": []}, {})
            opened = resolve_status_runner.run_resolve_project_open_isolated({"library_name": "L", "project_name": "P", "folder_parts": []})
        self.assertEqual(imported["error_code"], "child_crashed")
        self.assertEqual((timeline["import"]["error_code"], timeline["timeline"]["error_code"]), ("child_crashed", "child_crashed"))
        self.assertEqual(opened["error_code"], "child_crashed")


class PreviousChildUnconfirmedReportTests(unittest.TestCase):
    """앞선 자식의 종료를 확인하지 못해 새로 띄우지 않은 것은 인터프리터 문제가 아니다 — 후보를 돌아 '호환되는 Python 없음'으로 답하지 않는다."""

    def test_probe_blocked_by_an_unconfirmed_child_reports_that_cause_and_tries_no_other_interpreter(self):
        blocked = win_job.PreviousChildUnconfirmed("앞선 Resolve 자식의 종료를 아직 확인하지 못했습니다")
        with (
            mock.patch.object(resolve_status_runner, "resolve_process_running", return_value=True),
            mock.patch.object(resolve_status_runner, "_resolve_is_closed", return_value=False),
            mock.patch.object(resolve_status_runner, "_candidate_interpreters", return_value=["py-a", "py-b"]),
            mock.patch.object(resolve_status_runner, "_last_selection", None),
            mock.patch.object(resolve_status_runner, "_working_interpreter", None),
            mock.patch.object(resolve_status_runner, "run_in_job", side_effect=blocked) as run,
        ):
            status = resolve_status_runner.resolve_connection_status_bounded()
            interpreter, failure = resolve_status_runner.resolve_compatible_interpreter()
            imported = resolve_status_runner.run_resolve_import_isolated({"items": []})
        self.assertEqual(run.call_count, 3, "호출마다 첫 후보에서 멈춘다 — 다음 후보로 돌지 않는다")
        self.assertNotEqual(status.get("status"), "python_incompatible")
        self.assertIn("아직 끝나지 않아", status["message"])
        self.assertEqual((interpreter, failure), (None, resolve_status_runner.PREVIOUS_CHILD_MESSAGE))
        self.assertEqual(imported["error_code"], "api_unavailable")
        self.assertIn("아직 끝나지 않아", imported["error"])

    def test_library_connect_blocked_by_an_unconfirmed_child_says_so(self):
        with mock.patch.object(win_job, "run_in_job", side_effect=win_job.PreviousChildUnconfirmed("x")):
            with self.assertRaisesRegex(resolve_library_dialog.ResolveLibraryDialogError, "아직 끝나지 않아"):
                REAL_EXCLUSIVE(Path("C:/lib"), "lib")


class MutationBusyMappingTests(unittest.TestCase):
    """다른 프로세스의 변경이 진행 중(문지기가 대상 시작 없이 끝남) → 각 호출이 '바쁨'으로 답한다(부수효과 없음)."""

    def setUp(self):
        busy = subprocess.CompletedProcess(["x"], MUTATION_BUSY_EXIT, "", "")
        patches = (
            mock.patch.object(resolve_status_runner, "_resolve_is_closed", return_value=False),
            mock.patch.object(resolve_status_runner, "resolve_process_running", return_value=True),
            mock.patch.object(resolve_status_runner, "_select_interpreter", return_value=("py", {"status": "ready"}, "")),
            mock.patch.object(resolve_status_runner, "_run_child", return_value=busy),
        )
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def test_import_reports_resolve_busy(self):
        result = resolve_status_runner.run_resolve_import_isolated({"items": []})
        self.assertEqual((result["status"], result["error_code"]), ("unavailable", "resolve_busy"))
        self.assertEqual(result["error"], resolve_status_runner.BUSY_ELSEWHERE_MESSAGE)

    def test_project_open_reports_resolve_busy(self):
        result = resolve_status_runner.run_resolve_project_open_isolated({"library_name": "L", "project_name": "P", "folder_parts": []})
        self.assertEqual((result["status"], result["error_code"]), ("unavailable", "resolve_busy"))

    def test_panel_change_reports_busy(self):
        self.assertEqual(resolve_status_runner.run_resolve_panel_isolated({"operation": "adopt"}), {"state": "busy"})


@unittest.skipUnless(os.name == "nt", "이름 붙은 뮤텍스는 Windows 전용")
class NamedMutexTests(unittest.TestCase):
    def test_held_by_another_thread_is_busy_until_released(self):
        name = unique_name()
        holding, release = threading.Event(), threading.Event()

        def hold():
            gate = win_job.NamedMutex(name)
            assert gate.acquire(0)
            holding.set()
            release.wait(30)
            gate.release()

        holder = threading.Thread(target=hold)
        holder.start()
        self.assertTrue(holding.wait(10))
        mine = win_job.NamedMutex(name)
        self.assertFalse(mine.acquire(0), "다른 스레드가 쥐고 있다")
        began = time.monotonic()
        self.assertFalse(mine.acquire(0.3))
        self.assertGreaterEqual(time.monotonic() - began, 0.25, "주어진 시간만큼 기다린다")
        threading.Timer(0.2, release.set).start()
        self.assertTrue(mine.acquire(10), "풀리면 기다리던 쪽이 쥔다")
        mine.release()
        holder.join(10)

    def test_merely_opening_the_mutex_does_not_make_it_busy(self):
        """쥐지 않고 열어만 둔 핸들(엿보는 쪽)은 배제에 영향이 없다 — 존재가 아니라 소유를 본다."""
        name = unique_name()
        peeker = win_job.NamedMutex(name)  # 만들기만 하고 쥐지 않는다
        gate = win_job.NamedMutex(name)
        self.assertTrue(gate.acquire(0))
        gate.release()
        peeker.close()

    def test_a_holder_that_dies_hands_the_mutex_over(self):
        name = unique_name()
        with owned_tree([sys.executable, "-c", HOLDER, WIN_JOB_FILE, name], 20) as tree:
            self.assertEqual(tree.started, [b"held"])
            self.assertFalse(win_job.NamedMutex(name).acquire(0))
        gate = win_job.NamedMutex(name)
        self.assertTrue(gate.acquire(5), "쥔 프로세스가 죽으면 OS 가 풀어 준다")
        gate.release()

    def test_releasing_what_this_thread_does_not_hold_is_an_error(self):
        gate = win_job.NamedMutex(unique_name())
        with self.assertRaises(OSError):
            gate.release()
        self.assertTrue(gate.acquire(0))
        gate.release()
        with self.assertRaises(OSError):
            gate.release()  # 두 번 풀 수 없다

    def test_closed_handles_are_given_back(self):
        """한 번 쓰고 닫는 쪽(라이브러리 연결)이 되풀이돼도 이 프로세스의 핸들 수가 늘지 않는다."""
        kernel32 = ctypes.WinDLL("kernel32")
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        kernel32.GetProcessHandleCount.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]

        def handles() -> int:
            count = ctypes.c_ulong()
            kernel32.GetProcessHandleCount(kernel32.GetCurrentProcess(), ctypes.byref(count))
            return count.value

        name = unique_name()
        before = handles()
        for _round in range(300):
            gate = win_job.NamedMutex(name)
            self.assertTrue(gate.acquire(0))
            gate.release()
            gate.close()
        self.assertLess(handles() - before, 50, "닫은 핸들이 남아 쌓였다")

    def test_close_gives_back_the_handle_only_never_the_ownership(self):
        """닫기는 핸들 정리일 뿐 — 다른 핸들이 열려 있으면 쥔 스레드가 살아 있는 동안 소유는 그대로다. 닫은 뒤의 쥐기·풀기는 오류."""
        name = unique_name()
        other = win_job.NamedMutex(name)  # 같은 뮤텍스의 다른 핸들 — 이것이 있으면 닫아도 뮤텍스는 사라지지 않는다
        closed, leave = threading.Event(), threading.Event()
        held = win_job.NamedMutex(name)

        def owner() -> None:
            held.acquire(0)
            held.close()  # 쥔 채 닫음
            closed.set()
            leave.wait(20)

        thread = threading.Thread(target=owner)
        thread.start()
        try:
            self.assertTrue(closed.wait(10))
            self.assertFalse(other.acquire(0.3), "쥔 스레드가 살아 있으면 닫아도 소유는 풀리지 않는다")
        finally:
            leave.set()
            thread.join(10)
        self.assertTrue(other.acquire(5), "쥔 스레드가 끝나면 OS 가 넘긴다")
        other.release()
        with self.assertRaises(OSError):
            held.acquire(0)
        with self.assertRaises(OSError):
            held.release()

    def test_guard_that_cannot_judge_the_gate_does_not_start_the_target_and_answers_like_busy(self):
        with mock.patch.object(win_job, "NamedMutex", side_effect=OSError("CreateMutex failed")), mock.patch("runpy.run_module") as target:
            self.assertEqual(resolve_mutation_guard.main(["some.module"]), MUTATION_BUSY_EXIT)
        target.assert_not_called()

    def test_gate_uses_the_name_current_at_call_time(self):
        with mock.patch.object(win_job, "RESOLVE_MUTATION_MUTEX", unique_name()), mock.patch.object(win_job, "NamedMutex") as made:
            win_job.resolve_mutation_gate()
            made.assert_called_once_with(win_job.RESOLVE_MUTATION_MUTEX)
        self.assertIn("MVHub_Test_Mutation_", win_job.RESOLVE_MUTATION_MUTEX, "시험은 제품 이름을 쓰지 않는다(conftest)")


@unittest.skipUnless(os.name == "nt", "이름 붙은 뮤텍스는 Windows 전용")
class MutationGuardRealProcessTests(unittest.TestCase):
    """실제 프로세스 — 문지기를 거친 변경 자식이 사는 동안 두 번째 변경 자식은 대상을 시작하지 않는다. 끝나면 풀린다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.stop = Path(self.tmp.name, "stop")
        self.name = unique_name()
        # 대상 모듈 대역 — 시작을 알리고, 멈춤 파일이 생길 때까지 살다가 종료 코드 7 로 끝난다
        Path(self.tmp.name, "mvhub_guard_target.py").write_text(
            "import os, sys, time\n"
            "print('started', sys.argv, __name__, flush=True)\n"
            f"while not os.path.exists({str(self.stop)!r}):\n"
            "    time.sleep(0.05)\n"
            "raise SystemExit(7)\n", encoding="utf-8")
        # 가져오기 자식처럼 표준 입력의 JSON 을 읽어 되돌려 적는 대상
        Path(self.tmp.name, "mvhub_guard_echo.py").write_text(
            "import json, sys\nprint('ECHO=' + json.dumps(json.loads(sys.stdin.read()), ensure_ascii=True))\nraise SystemExit(4)\n", encoding="utf-8")
        self.env = {**os.environ, "PYTHONPATH": os.pathsep.join([BACKEND, self.tmp.name])}

    def guard_args(self, target: str = "mvhub_guard_target") -> list[str]:
        return [sys.executable, "-c", GUARD, self.name, target]

    def run_guard(self, target: str = "mvhub_guard_target", **kwargs) -> subprocess.CompletedProcess:
        return win_job.run_in_job(self.guard_args(target), timeout=60, text=True, env=self.env, creationflags=NO_WINDOW, **kwargs)

    def test_second_mutation_is_refused_while_the_first_lives_and_allowed_after(self):
        with owned_tree(self.guard_args(), 30, env=self.env) as first:
            # `python -m 대상` 과 같게 — __main__ 으로, argv 는 대상 파일 경로 하나(문지기의 인자가 섞이지 않는다)
            self.assertEqual((len(first.started), first.started[0], first.started[-1]), (3, b"started", b"__main__"))
            self.assertTrue(first.started[1].startswith(b"['") and first.started[1].endswith(b"mvhub_guard_target.py']"), first.started)
            began = time.monotonic()
            second = self.run_guard()
            self.assertEqual(second.returncode, MUTATION_BUSY_EXIT)
            self.assertEqual(second.stdout, "", "대상을 시작하지 않았다")
            self.assertGreaterEqual(time.monotonic() - began, 1.5, "잠깐 기다린 뒤에 '바쁨'으로 답한다")
            self.stop.write_text("")
            self.assertEqual(first.process.wait(30), 7, "대상의 종료 코드가 그대로 올라온다")
        third = self.run_guard()  # 멈춤 파일이 있어 바로 끝난다
        self.assertEqual(third.returncode, 7)
        self.assertTrue(third.stdout.startswith("started"))

    def test_json_input_reaches_the_target_through_the_job_and_the_guard(self):
        """run_in_job → 문지기 → 대상 전체 경로로 표준 입력(JSON)·출력·종료 코드가 그대로 오간다(가져오기 자식이 받는 방식)."""
        payload = {"items": [{"path": "Z:\\프로젝트\\컷 01.mov"}], "n": 3}
        done = self.run_guard("mvhub_guard_echo", input_text=json.dumps(payload, ensure_ascii=True), kill_on_close=False)
        self.assertEqual(done.returncode, 4)
        self.assertEqual(json.loads(done.stdout.strip().removeprefix("ECHO=")), payload)

    def test_a_refused_mutation_with_a_large_input_is_still_reported_as_busy(self):
        """문지기는 못 쥐면 입력을 읽지 않고 75 로 끝난다 — 파이프보다 큰 입력(가져오기 manifest)을 쓰던 쪽은 BrokenPipe 나 EINVAL 을 받는다.
        어느 쪽이든 '결과 미확인'이 아니라 75 가 그대로 돌아오고, 호출자는 '바쁨'으로 답한다(대상은 시작하지 않았다)."""
        with owned_tree([sys.executable, "-c", HOLDER, WIN_JOB_FILE, self.name], 20) as holder:
            self.assertEqual(holder.started, [b"held"])
            refused = self.run_guard(input_text=json.dumps({"pad": "x" * (1 << 20)}), kill_on_close=False)
            self.assertEqual((refused.returncode, refused.stdout), (MUTATION_BUSY_EXIT, ""))
            with (
                mock.patch.object(resolve_status_runner, "_resolve_is_closed", return_value=False),
                mock.patch.object(resolve_status_runner, "_select_interpreter", return_value=(sys.executable, {"status": "ready"}, "")),
                mock.patch.object(resolve_status_runner, "run_in_job", side_effect=lambda _args, **kw: self.run_guard(input_text=kw["input_text"], kill_on_close=False)),
            ):
                imported = resolve_status_runner.run_resolve_import_isolated({"items": [], "pad": "x" * (1 << 20)})
            self.assertEqual(imported["error_code"], "resolve_busy")

    def test_the_input_writer_ignores_einval_like_subprocess_does(self):
        """쓰기와 닫기(버퍼 내보내기) 어느 단계든 — BrokenPipe·EINVAL(자식이 입력을 다 읽지 않고 끝남)은 오류가 아니고, 그 밖의 실패는 결과 미확인이다.
        쓰기가 실패해도 닫기는 한다."""
        failures = ((BrokenPipeError(), 0), (OSError(errno.EINVAL, "Invalid argument"), 0), (OSError(errno.EIO, "I/O error"), 1), (ValueError("bad"), 1))
        for stage in ("write", "close"):
            for failure, counted in failures:
                with self.subTest(stage=stage, failure=type(failure).__name__, errno=getattr(failure, "errno", None)):
                    calls: list[str] = []

                    def act(name, _stage=stage, _failure=failure):
                        calls.append(name)
                        if name == _stage:
                            raise _failure

                    stream = mock.Mock(write=lambda _text: act("write"), close=lambda: act("close"))
                    pump = win_job._Pump.__new__(win_job._Pump)
                    pump.errors = []
                    pump._write(stream, "data")
                    self.assertEqual((calls, len(pump.errors)), (["write", "close"], counted))

    def test_a_caller_that_leaves_in_the_middle_of_a_large_input_returns_at_once_and_the_mutation_still_finishes(self):
        """큰 입력(4MiB)을 쓰는 도중 — 자식이 아직 읽지 않아 쓰기가 막혀 있다 — 부른 쪽이 떠난다. 호출은 곧바로 '결과 미확인'으로 돌아오고
        (입력 닫기를 기다리며 붙잡히지 않는다), 변경 자식은 끊기지 않으며, 입출력 스레드가 입력을 끝까지 주고 닫아 자식이 다 받고 끝난다.
        허브 대역째 바깥 Job 안에서 돌린다 — 시험 대상의 정리가 틀려도 남지 않는다."""
        result = Path(self.tmp.name, "received")
        with owned_tree([sys.executable, "-c", LEAVER, WIN_JOB_FILE, str(result)], 90) as hub:
            self.assertEqual(len(hub.started), 4, hub.started)
            outcome, elapsed, received, strays = hub.started
            self.assertEqual(outcome, b"unknown")
            self.assertLess(float(elapsed), 1.5, "자식이 읽기 시작할 때(2초 뒤)까지 붙잡히지 않는다")
            self.assertEqual((received, strays), (str(4 << 20).encode(), b"0"), "끊기지 않고 입력을 다 받았다")

    def test_the_mutex_outlives_a_killed_parent_until_the_child_ends(self):
        """허브(부모)가 강제 종료돼도 변경 자식은 살아 뮤텍스를 쥐고 있다 — 새 허브의 변경이 겹치지 않는다. 자식이 죽으면 풀린다."""
        parent = (
            "import os, subprocess, sys, time\n"
            "child = subprocess.Popen(sys.argv[1:], stdout=subprocess.PIPE, text=True)\n"
            "child.stdout.readline()\n"  # 대상이 시작했다(뮤텍스를 쥐었다)
            "print(os.getpid(), flush=True)\n"
            "time.sleep(120)\n"
        )
        with owned_tree([sys.executable, "-c", parent, *self.guard_args()], 30, env=self.env) as tree:
            self.assertEqual(len(tree.started), 1)
            subprocess.run(["taskkill", "/F", "/PID", tree.started[0].decode()], capture_output=True)  # 허브 대역만 죽인다
            time.sleep(1.0)
            self.assertEqual(self.run_guard().returncode, MUTATION_BUSY_EXIT, "변경 자식이 살아 있는 동안 새 변경은 시작하지 않는다")
        self.stop.write_text("")
        self.assertEqual(self.run_guard().returncode, 7, "자식이 죽으면 풀린다")

    def test_mutation_does_not_start_while_a_selection_read_holds_the_gate(self):
        """선택 작업자가 Resolve 를 읽는 동안(문을 쥔 프로세스가 있는 동안) 변경 자식은 대상을 시작하지 않는다 — 읽기와 변경의 겹침 0."""
        with owned_tree([sys.executable, "-c", HOLDER, WIN_JOB_FILE, self.name], 20) as reader:
            self.assertEqual(reader.started, [b"held"])
            refused = self.run_guard()
            self.assertEqual((refused.returncode, refused.stdout), (MUTATION_BUSY_EXIT, ""))
        self.stop.write_text("")
        self.assertEqual(self.run_guard().returncode, 7)

    def test_a_reader_skips_while_a_mutation_holds_the_gate(self):
        """변경 자식이 사는 동안 다른 프로세스의 읽기 쪽은 문을 쥐지 못한다(그 바퀴는 읽지 않는다)."""
        with owned_tree(self.guard_args(), 30, env=self.env) as mutation:
            self.assertEqual(mutation.started[0], b"started")
            with owned_tree([sys.executable, "-c", HOLDER, WIN_JOB_FILE, self.name], 20) as reader:
                self.assertEqual(reader.started, [b"busy"])

    def test_a_selection_read_stuck_holding_the_gil_is_ended_by_the_parent_and_lets_the_mutation_in(self):
        """읽기 A 가 문을 쥔 채 네이티브 호출에 멈춤(GIL 도 쥔 채 — 작업자 안의 어떤 파이썬 스레드도 못 돈다) → 변경 B 는 거절 →
        부모의 회수(선택 감시가 신호 끊김을 보고 부르는 그 길)가 stdin 닫기로는 못 끝내고 Job 째 끝냄 → 문이 넘어와 B 허용."""
        self.stop.write_text("")  # 변경 대상은 시작하면 바로 7 로 끝난다
        job = win_job.ProcessJob()
        self.addCleanup(job.close)

        async def scenario() -> float:
            reader = await asyncio.create_subprocess_exec(
                sys.executable, "-c", STUCK_READER, self.name, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                env=self.env, creationflags=win_job.CREATE_SUSPENDED | NO_WINDOW,
            )
            try:
                job.adopt_suspended(reader.pid)
                setattr(reader, resolve_selection_monitor._JOB_ATTR, job)
                self.assertEqual((await asyncio.wait_for(reader.stdout.readline(), 30)).strip(), b"reading", "작업자가 문을 쥐고 Resolve 연결에 들어갔다")
                refused = await asyncio.to_thread(self.run_guard)
                self.assertEqual(refused.returncode, MUTATION_BUSY_EXIT, "읽기가 문을 쥐고 있는 동안 변경은 시작하지 않는다")
                began = time.monotonic()
                await asyncio.wait_for(resolve_selection_monitor.ResolveSelectionMonitor._terminate_process(reader), 10)
                return time.monotonic() - began
            finally:
                # 시험 대상(회수)에 기대지 않는 정리 — 넣기가 실패했으면 Job 밖의 자식을 직접 끝내고, 넣었으면 Job(닫히면 끝냄)이 트리를 끝낸다
                job.close()
                if reader.returncode is None:
                    try:
                        reader.kill()
                    except ProcessLookupError:
                        pass  # 이미 끝났다
                    await asyncio.wait_for(reader.wait(), 10)  # 끝난 것을 확인한다 — 못 하면 시험이 실패한다

        self.assertLess(asyncio.run(scenario()), 6.0, "기한 안에 끝내고 확인한다")
        self.assertEqual(self.run_guard().returncode, 7, "읽던 프로세스가 끝난 뒤에는 변경이 들어간다")

    def test_guard_rejects_a_bad_command_line(self):
        self.assertEqual(resolve_mutation_guard.main([]), 2)
        self.assertEqual(resolve_mutation_guard.main(["a", "b"]), 2)


class LibraryConnectTests(unittest.TestCase):
    """라이브러리 연결 자동화(PowerShell 이 Resolve 를 바꾼다)는 문지기를 거친 자식이 돌린다 — 허브가 죽어도 그 자식이 문을 쥔 채 끝까지 간다."""

    def completed(self, code=0, outcome=None, stderr=""):
        out = "" if outcome is None else resolve_library_dialog.CONNECT_RESULT_PREFIX + json.dumps(outcome) + "\n"
        return subprocess.CompletedProcess(["x"], code, "noise\n" + out, stderr)

    def test_automation_runs_as_a_guarded_child_that_outlives_the_hub(self):
        with mock.patch.object(win_job, "run_in_job", return_value=self.completed(outcome={"ok": True, "result": {"ok": True, "name": "L"}})) as run:
            self.assertEqual(REAL_EXCLUSIVE(Path("Z:/lib"), "L"), {"ok": True, "name": "L"})
        args = run.call_args.args[0]
        self.assertEqual(args[1:], ["-m", "app.services.resolve_mutation_guard", "app.services.resolve_library_connect_worker"])
        self.assertEqual(args[0], sys.executable)
        self.assertEqual((run.call_args.kwargs["kill_on_close"], run.call_args.kwargs["timeout"]), (False, None))
        self.assertEqual(json.loads(run.call_args.kwargs["input_text"]), {"path": str(Path("Z:/lib")), "name": "L"})

    def test_child_answers_are_mapped(self):
        error = resolve_library_dialog.ResolveLibraryDialogError
        cases = (
            (self.completed(code=MUTATION_BUSY_EXIT), "바꾸는 중"),  # 다른 프로세스의 변경 — 자동화는 시작하지 않았다
            (self.completed(outcome={"ok": False, "message": "창을 찾지 못했습니다"}), "창을 찾지 못했습니다"),
            (self.completed(code=1, stderr="Traceback boom"), "boom"),  # 결과 줄 없이 끝남
        )
        for done, expected in cases:
            with self.subTest(expected=expected), mock.patch.object(win_job, "run_in_job", return_value=done):
                with self.assertRaisesRegex(error, expected):
                    REAL_EXCLUSIVE(Path("x"), "L")
        with mock.patch.object(win_job, "run_in_job", side_effect=OSError("no job")):
            with self.assertRaisesRegex(error, "실행하지 못했습니다"):
                REAL_EXCLUSIVE(Path("x"), "L")
        with mock.patch.object(win_job, "run_in_job", side_effect=win_job.ChildOutcomeUnknown("pipe")):
            with self.assertRaisesRegex(error, "결과를 확인하지 못했습니다"):
                REAL_EXCLUSIVE(Path("x"), "L")

    def test_worker_runs_the_automation_and_reports_one_result_line(self):
        for automation, expected in (
            (mock.Mock(return_value={"ok": True, "name": "L"}), {"ok": True, "result": {"ok": True, "name": "L"}}),
            (mock.Mock(side_effect=resolve_library_dialog.ResolveLibraryDialogError("시간 초과")), {"ok": False, "message": "시간 초과"}),
        ):
            with self.subTest(expected=expected), \
                 mock.patch.object(resolve_library_connect_worker, "_run_automation", automation), \
                 mock.patch.object(sys, "stdin", io.StringIO(json.dumps({"path": "Z:/lib", "name": "L"}))), \
                 mock.patch("builtins.print") as output:
                self.assertEqual(resolve_library_connect_worker.main(), 0)
            automation.assert_called_once_with(Path("Z:/lib"), "L")
            line = output.call_args.args[0]
            self.assertTrue(line.startswith(resolve_library_dialog.CONNECT_RESULT_PREFIX))
            self.assertEqual(json.loads(line.removeprefix(resolve_library_dialog.CONNECT_RESULT_PREFIX)), expected)

    def test_the_connect_dialog_never_runs_the_automation_in_the_hub(self):
        """연결 창 흐름(open_library_connect_dialog)은 자동화를 허브 안에서 직접 부르지 않는다 — 문지기를 거친 길로만."""
        busy = resolve_library_dialog.ResolveLibraryDialogError("다른 MV Hub 작업이 아직 DaVinci Resolve 를 바꾸는 중입니다.")
        with tempfile.TemporaryDirectory() as root:
            Path(root, "Resolve Projects").mkdir()
            with mock.patch.object(resolve_library_dialog.os, "name", "nt"), \
                 mock.patch.object(resolve_library_dialog, "registered_library_name", return_value=None), \
                 mock.patch.object(resolve_library_dialog, "library_name_for_project", return_value="L"), \
                 mock.patch.object(resolve_library_dialog, "_run_automation_exclusively", side_effect=busy) as guarded, \
                 mock.patch.object(resolve_library_dialog, "_run_automation") as direct:
                with self.assertRaises(resolve_library_dialog.ResolveLibraryDialogError):
                    resolve_library_dialog.open_library_connect_dialog(Path(root), "P")
        guarded.assert_called_once()
        direct.assert_not_called()


if __name__ == "__main__":
    unittest.main()
