"""에셋 대장 훑기 — 자식(목록·지문)과 관리자(자식 수명·반영). 설계: docs/ASSET_REGISTRY.md '12. NAS 읽기 안정성'."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.db import get_connection, init_db
from app.repo import asset_registry as registry
from app.services import asset_registry as svc
from app.services import asset_registry_scan as child
from app.services.asset_tree import is_hidden_name

MIB = 1 << 20


def _job(root: Path, out: Path, **over) -> dict:
    job = {"root": str(root), "out": str(out), "known": {}, "priority": [], "rate_bytes": 512 * MIB,
           "dir_rate": 10_000, "deadline_s": 60, "max_entries": 10_000, "hide_render": True}
    job.update(over)
    return job


def _lines(out: Path) -> tuple[dict, dict[str, dict]]:
    rows = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
    end = rows[-1]
    return end, {r["p"]: r for r in rows if r["t"] == "file"}


class ChildScanTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self._tmp.name) / "proj"
        (self.root / "CH").mkdir(parents=True)
        (self.root / "CH" / "a.png").write_bytes(b"A" * 10)
        (self.root / "CH" / "b.mp4").write_bytes(b"B" * 20)
        (self.root / "CH" / "note.txt").write_bytes(b"not media")
        (self.root / "CH" / "empty.png").write_bytes(b"")
        (self.root / "_hidden").mkdir()
        (self.root / "_hidden" / "x.png").write_bytes(b"h")
        (self.root / ".git").mkdir()
        (self.root / ".git" / "y.png").write_bytes(b"g")
        (self.root / "render" / "shot").mkdir(parents=True)
        (self.root / "render" / "shot" / "f0001.png").write_bytes(b"r")
        self.out = Path(self._tmp.name) / "out.jsonl"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_lists_media_skips_hidden_render_and_marks_empty_undetermined(self) -> None:
        end, files = _lines(self.out) if child.run(_job(self.root, self.out)) else (None, None)
        self.assertTrue(end["complete"])
        self.assertEqual(sorted(files), ["CH/a.png", "CH/b.mp4", "CH/empty.png"])
        self.assertEqual(files["CH/a.png"]["st"], "ok")
        self.assertEqual(files["CH/a.png"]["s"], __import__("hashlib").sha256(b"A" * 10).hexdigest())
        self.assertEqual((files["CH/empty.png"]["st"], files["CH/empty.png"]["why"]), ("undetermined", "empty"))
        self.assertEqual((end["hashed"], end["undetermined"], end["pending"]), (2, 1, 0))

    def test_known_size_and_time_skip_rehashing(self) -> None:
        st = os.stat(self.root / "CH" / "a.png")
        known = {"CH/a.png": [st.st_size, st.st_mtime_ns, "cached-sha"]}
        end, files = (None, None)
        child.run(_job(self.root, self.out, known=known))
        end, files = _lines(self.out)
        self.assertEqual(files["CH/a.png"]["s"], "cached-sha")  # 다시 읽지 않았다
        self.assertEqual(end["hashed"], 1)  # b.mp4 만 읽었다

    def test_budget_and_large_files_become_pending(self) -> None:
        # 초당 5바이트 — b.mp4(20B = 4초)는 예산(3초)을 혼자 넘는 큰 파일, a.png(10B = 2초)는 예산 안
        child.run(_job(self.root, self.out, rate_bytes=5, deadline_s=3))
        end, files = _lines(self.out)
        self.assertTrue(end["complete"])
        self.assertEqual((files["CH/b.mp4"]["st"], files["CH/b.mp4"]["why"]), ("pending", "large"))
        self.assertEqual(files["CH/a.png"]["st"], "ok")

    def test_missing_root_or_unreadable_folder_is_incomplete(self) -> None:
        child.run(_job(self.root / "nope", self.out))
        end, files = _lines(self.out)
        self.assertEqual((end["complete"], files), (False, {}))
        with patch("app.services.asset_registry_scan.os.scandir", side_effect=PermissionError("denied")):
            child.run(_job(self.root, self.out))
        self.assertFalse(_lines(self.out)[0]["complete"])

    def test_one_file_whose_info_cannot_be_read_is_only_that_file(self) -> None:
        """파일 하나의 정보 읽기 실패는 그 파일만 미판정이다 — 루트 전체를 버리지 않는다(Codex P1)."""
        real_scandir = os.scandir

        class Entry:
            def __init__(self, entry):
                self._entry = entry

            def __getattr__(self, key):
                return getattr(self._entry, key)

            def stat(self, **kw):
                if self._entry.name == "a.png":
                    raise PermissionError("locked")
                return self._entry.stat(**kw)

        class Listing:
            def __init__(self, path):
                self._it = real_scandir(path)

            def __enter__(self):
                return [Entry(e) for e in self._it.__enter__()]

            def __exit__(self, *exc):
                return self._it.__exit__(*exc)

        with patch("app.services.asset_registry_scan.os.scandir", side_effect=Listing):
            child.run(_job(self.root, self.out))
        end, files = _lines(self.out)
        self.assertTrue(end["complete"])
        self.assertEqual((files["CH/a.png"]["st"], files["CH/a.png"]["why"]), ("undetermined", "stat"))
        self.assertEqual(files["CH/b.mp4"]["st"], "ok")

    def test_too_many_entries_is_incomplete(self) -> None:
        child.run(_job(self.root, self.out, max_entries=1))
        self.assertEqual(_lines(self.out)[0]["note"], "항목 상한 초과")

    def test_file_changed_while_hashing_is_undetermined(self) -> None:
        real_stat = os.stat
        calls = {"n": 0}

        def moving_stat(path, *a, **kw):
            st = real_stat(path, *a, **kw)
            if str(path).endswith("a.png"):
                calls["n"] += 1
                if calls["n"] == 2:  # 읽은 뒤 다시 본 크기가 다르다
                    return SimpleNamespace(st_mode=st.st_mode, st_size=st.st_size + 1, st_mtime_ns=st.st_mtime_ns)
            return st

        with patch("app.services.asset_registry_scan.os.stat", side_effect=moving_stat):
            child.run(_job(self.root, self.out))
        files = _lines(self.out)[1]
        self.assertEqual((files["CH/a.png"]["st"], files["CH/a.png"]["why"]), ("undetermined", "changed"))

    def test_hash_only_mode_reads_just_the_listed_files(self) -> None:
        child.run(_job(self.root, self.out, hash_only=["CH/b.mp4"]))
        end, files = _lines(self.out)
        self.assertEqual(sorted(files), ["CH/b.mp4"])
        self.assertEqual(files["CH/b.mp4"]["st"], "ok")

    def test_child_stops_when_its_parent_is_gone(self) -> None:
        """부모(서버)가 강제로 꺼지면 고아로 남아 NAS 를 계속 읽지 않는다."""
        parent = subprocess.Popen([sys.executable, "-c", "pass"])
        parent.wait()
        self.assertFalse(child._process_alive(parent.pid))
        self.assertTrue(child._process_alive(os.getpid()))
        with patch.object(child._ParentWatch, "__init__", lambda s, pid, every=2.0: (
                setattr(s, "pid", pid), setattr(s, "every", 0.0), setattr(s, "last", 0.0), None)[-1]):
            child.run(_job(self.root, self.out, parent_pid=parent.pid))
        end = _lines(self.out)[0]
        self.assertEqual((end["complete"], end["note"]), (False, "부모 프로세스가 없음"))

    def test_hidden_rule_matches_the_asset_tree(self) -> None:
        for name in ("a.png", ".git", "_work", "README.md", "readme.md", "x_y.png", "render"):
            self.assertEqual(child.hidden_name(name), is_hidden_name(name), name)

    def test_speed_limit_holds(self) -> None:
        big = self.root / "CH" / "big.png"
        big.write_bytes(b"x" * (3 * MIB))
        t0 = time.monotonic()
        child.run(_job(self.root, self.out, rate_bytes=4 * MIB))
        self.assertGreaterEqual(time.monotonic() - t0, 0.6)  # 3 MiB 를 4 MiB/s 로 → 0.75초 안팎


class DriveMapTests(unittest.TestCase):
    def test_drive_letters_become_shares(self) -> None:
        mapping = svc.drive_map(r"Z:=\\192.168.1.203\millionvolt;x:=\\nas2\share\;bad;Q=")
        self.assertEqual(mapping, {"Z:": r"\\192.168.1.203\millionvolt", "X:": r"\\nas2\share"})
        self.assertEqual(svc.resolve_root(r"Z:\PROJECT_MUDX\10_ai", mapping), r"\\192.168.1.203\millionvolt\PROJECT_MUDX\10_ai")
        self.assertEqual(svc.resolve_root("z:/PROJECT/a", mapping), r"\\192.168.1.203\millionvolt\PROJECT\a")
        self.assertEqual(svc.resolve_root(r"Y:\a\b", mapping), r"Y:\a\b")  # 대응표에 없으면 그대로
        self.assertEqual(svc.resolve_root(r"\\nas\x\y", mapping), r"\\nas\x\y")


class ControllerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        init_db()

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self._tmp.name) / "proj"
        (self.root / "assets" / "CH").mkdir(parents=True)
        (self.root / "assets" / "CH" / "m.png").write_bytes(b"M" * 32)
        (self.root / "assets" / "CH" / "n.png").write_bytes(b"N" * 16)
        self.pid = f"p-{time.time_ns()}"
        self.ctl = svc.AssetRegistryController()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _run(self, mode: str = "manual") -> None:
        with patch.object(svc, "pm_projects", return_value=[(self.pid, "뻘뻘뻘", str(self.root))]):
            asyncio.run(self.ctl._run(None, mode))

    def rows(self) -> dict[str, dict]:
        with get_connection() as conn:
            return {r["path"]: r for r in registry.registry_rows(conn, self.pid)}

    def test_scan_rename_and_status_through_a_real_child(self) -> None:
        self._run()
        rows = self.rows()
        self.assertEqual(sorted(rows), ["assets/CH/m.png", "assets/CH/n.png"])
        rid = rows["assets/CH/m.png"]["registry_asset_id"]
        (self.root / "assets" / "CH" / "m.png").rename(self.root / "assets" / "CH" / "m_final.png")
        self._run()
        self.assertEqual(self.rows()["assets/CH/m_final.png"]["registry_asset_id"], rid)
        with get_connection() as conn:
            scan = {r["project_id"]: r for r in registry.scan_rows(conn)}[self.pid]
        self.assertEqual((scan["state"], scan["complete"], scan["clean"], scan["files"]), ("ok", 1, 1, 2))
        self.assertEqual(self.ctl._last["failed"], 0)
        # 작업 파일을 남기지 않는다
        self.assertEqual(list((svc.DATA_DIR / "asset_registry").glob("*")), [])

    def test_large_file_gets_a_dedicated_run_then_a_clean_rescan(self) -> None:
        (self.root / "assets" / "CH" / "big.mp4").write_bytes(b"B" * 400)
        # 자동 주기 예산을 아주 작게: 초당 100바이트 · 1초 → big.mp4(400B)는 '큰 파일'
        with patch.object(svc, "AUTO_DEADLINE_S", 1), patch.object(svc, "_rates", return_value=(100.0, 100.0)):
            self._run(mode="auto")
        self.assertIn("assets/CH/big.mp4", self.rows())
        self.assertEqual(self.ctl._waiting.get(self.pid), 0)

    def test_hung_child_is_killed_and_nothing_is_applied(self) -> None:
        sleeper = [sys.executable, "-c", "import time; time.sleep(60)"]
        real_popen = subprocess.Popen

        def fake_popen(_args, **kw):
            return real_popen(sleeper, **kw)

        with patch.object(svc.subprocess, "Popen", side_effect=fake_popen), patch.object(svc, "KILL_GRACE_S", 0):
            t0 = time.monotonic()
            end, files, pending, note = asyncio.run(self.ctl._run_child({"root": str(self.root)}, 0.5))
        self.assertLess(time.monotonic() - t0, 15)
        self.assertEqual((end, files, note), (None, [], "시간 초과 — 자식을 끝냄"))

    def test_stop_kills_the_running_child(self) -> None:
        sleeper = [sys.executable, "-c", "import time; time.sleep(60)"]
        real_popen = subprocess.Popen
        seen: list[subprocess.Popen] = []

        def fake_popen(_args, **kw):
            proc = real_popen(sleeper, **kw)
            seen.append(proc)
            return proc

        async def scenario() -> None:
            with patch.object(svc.subprocess, "Popen", side_effect=fake_popen), \
                    patch.object(svc, "pm_projects", return_value=[(self.pid, "P", str(self.root))]):
                self.assertTrue(self.ctl.request_scan(mode="manual"))
                for _ in range(100):
                    if seen:
                        break
                    await asyncio.sleep(0.05)
                self.assertFalse(self.ctl.request_scan(mode="manual"))  # 한 번에 하나
                await self.ctl.stop()

        asyncio.run(scenario())
        self.assertTrue(seen and seen[0].poll() is not None)
        self.assertFalse(self.ctl.busy())
        with get_connection() as conn:
            scan = {r["project_id"]: r for r in registry.scan_rows(conn)}.get(self.pid)
        self.assertIsNotNone(scan)
        self.assertEqual(scan["state"], "failed")
        self.assertEqual(self.rows(), {})


if __name__ == "__main__":
    unittest.main()
