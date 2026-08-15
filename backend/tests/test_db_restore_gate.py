"""DB 파일 복원 유지보수 게이트 — Windows 파일 잠금 회귀 테스트."""

import os
import sqlite3
import tempfile
import threading
import time
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

from app import db
from app.routers import db_transfer


class DbRestoreGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.path = self.root / "active.db"
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = str(self.path)
        self.pool_enabled = mock.patch.object(db, "_POOL_ENABLED", True)
        self.pool_enabled.start()
        db.flush_pool()
        db.init_db()

    def tearDown(self):
        db.flush_pool()
        self.pool_enabled.stop()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    @staticmethod
    def _set_marker(path: Path, value: str) -> None:
        # sqlite Connection 의 with 는 commit/rollback만 하고 close는 하지 않는다. 이 테스트는
        # 풀 밖의 핸들이 아닌 풀 레지스트리만 검증해야 하므로 명시적으로 닫는다.
        with closing(sqlite3.connect(str(path))) as conn:
            with conn:
                conn.execute(
                    "INSERT INTO app_setting(key, value) VALUES('restore_marker', ?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (value,),
                )

    @staticmethod
    def _marker(conn: sqlite3.Connection) -> str:
        return conn.execute(
            "SELECT value FROM app_setting WHERE key='restore_marker'"
        ).fetchone()[0]

    def _make_db(self, path: Path, marker: str) -> None:
        db.init_db(path)
        self._set_marker(path, marker)

    def test_maintenance_flush_closes_all_worker_pool_files(self):
        """유지보수 flush 뒤 DB와 sidecar의 rename/delete가 즉시 가능해야 한다."""
        ready = threading.Barrier(4)
        release = threading.Event()
        errors = []

        def hold_idle_pool(index: int) -> None:
            try:
                # 컨텍스트를 먼저 끝내 활성 작업 수는 0으로 만들되, 살아 있는 워커의 thread-local
                # holder는 계속 남겨 전 스레드 flush 대상인지 확인한다.
                with db.get_connection() as conn:
                    conn.execute(
                        "INSERT INTO app_setting(key, value) VALUES(?, ?)",
                        (f"worker-{index}", "open"),
                    )
                ready.wait(timeout=2)
                release.wait(timeout=2)
            except BaseException as exc:  # 스레드 실패를 메인 테스트로 전달
                errors.append(exc)

        workers = [threading.Thread(target=hold_idle_pool, args=(index,)) for index in range(3)]
        for worker in workers:
            worker.start()
        try:
            ready.wait(timeout=2)
            wal = Path(str(self.path) + "-wal")
            shm = Path(str(self.path) + "-shm")
            self.assertTrue(wal.exists())
            self.assertTrue(shm.exists())

            with db.maintenance_gate():
                db.flush_pool()

            # Windows 에서는 남은 SQLite 핸들이 하나라도 있으면 아래 rename/unlink가 실패한다.
            renamed = self.root / "active-renamed.db"
            self.path.rename(renamed)
            renamed.rename(self.path)
            for sidecar in (wal, shm):
                if sidecar.exists():
                    sidecar.unlink()
        finally:
            release.set()
            for worker in workers:
                worker.join(timeout=2)

        self.assertFalse(any(worker.is_alive() for worker in workers))
        self.assertEqual(errors, [])

    def test_install_db_replaces_data_seen_by_existing_pool(self):
        """복원 전 풀을 만든 뒤에도, 복원 후 조회는 새 DB 데이터를 봐야 한다."""
        self._set_marker(self.path, "old")
        incoming = self.root / "incoming.db"
        self._make_db(incoming, "new")
        with db.get_connection() as conn:
            self.assertEqual(self._marker(conn), "old")

        # 테스트의 실제 active.json을 건드리지 않게만 하고, 나머지는 실제 복원 경로를 탄다.
        with mock.patch.object(db_transfer, "AUTH_ENABLED", True):
            result = db_transfer._install_db(incoming)

        self.assertEqual(result, {"ok": True, "relogin_required": True})
        with db.get_connection() as conn:
            self.assertEqual(self._marker(conn), "new")

    def test_connection_waiting_at_gate_opens_replaced_db(self):
        """게이트 중 시작한 get_connection은 해제 후 교체된 DB만 열어야 한다."""
        self._set_marker(self.path, "old")
        incoming = self.root / "incoming.db"
        self._make_db(incoming, "new")
        started = threading.Event()
        finished = threading.Event()
        observed = []

        def get_after_gate() -> None:
            started.set()
            with db.get_connection() as conn:
                observed.append(self._marker(conn))
            finished.set()

        worker = threading.Thread(target=get_after_gate)
        with db.maintenance_gate():
            db.flush_pool()
            worker.start()
            self.assertTrue(started.wait(timeout=1))
            time.sleep(0.05)
            self.assertFalse(finished.is_set())
            os.replace(incoming, self.path)
            db.init_db()

        worker.join(timeout=2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(observed, ["new"])


if __name__ == "__main__":
    unittest.main()
