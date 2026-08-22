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


class _DbGateHarness(unittest.TestCase):
    """공통 셋업·헬퍼만 담는 harness — 테스트 클래스가 이걸 상속해야
    상속으로 기존 테스트가 중복 수집되지 않는다(코덱스 P2)."""

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

    @staticmethod
    def _make_trash(path: Path, marker: str) -> None:
        with closing(sqlite3.connect(path)) as conn:
            conn.execute("CREATE TABLE trashed(id TEXT PRIMARY KEY, payload TEXT)")
            conn.execute("INSERT INTO trashed VALUES('row', ?)", (marker,))
            conn.commit()


class DbRestoreGateTests(_DbGateHarness):
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

    def test_install_db_set_replaces_content_and_trash_together(self):
        self._set_marker(self.path, "old")
        current_trash = self.path.parent / "content_hub_trash.db"
        self._make_trash(current_trash, "old-trash")
        incoming = self.root / "incoming.db"
        incoming_trash = self.root / "incoming-trash.db"
        self._make_db(incoming, "new")
        self._make_trash(incoming_trash, "new-trash")

        with mock.patch.object(db_transfer, "AUTH_ENABLED", True):
            result = db_transfer._install_db(
                incoming,
                trash_tmp=incoming_trash,
                restore_trash_set=True,
            )

        self.assertEqual(result, {"ok": True, "relogin_required": True})
        with db.get_connection() as conn:
            self.assertEqual(self._marker(conn), "new")
        with closing(sqlite3.connect(current_trash)) as conn:
            self.assertEqual(conn.execute("SELECT payload FROM trashed").fetchone()[0], "new-trash")

    def test_install_db_set_rolls_back_both_files_when_second_replace_fails(self):
        self._set_marker(self.path, "old")
        current_trash = self.path.parent / "content_hub_trash.db"
        self._make_trash(current_trash, "old-trash")
        incoming = self.root / "incoming.db"
        incoming_trash = self.root / "incoming-trash.db"
        self._make_db(incoming, "new")
        self._make_trash(incoming_trash, "new-trash")
        real_replace = os.replace

        def fail_trash_restore(source, destination):
            source_path = Path(source)
            destination_path = Path(destination)
            if destination_path == current_trash and ".restore-" in source_path.name:
                raise OSError("simulated second-file failure")
            return real_replace(source, destination)

        with (
            mock.patch.object(db_transfer, "AUTH_ENABLED", True),
            mock.patch.object(db_transfer.os, "replace", side_effect=fail_trash_restore),
            self.assertRaises(OSError),
        ):
            db_transfer._install_db(
                incoming,
                trash_tmp=incoming_trash,
                restore_trash_set=True,
            )

        with db.get_connection() as conn:
            self.assertEqual(self._marker(conn), "old")
        with closing(sqlite3.connect(current_trash)) as conn:
            self.assertEqual(conn.execute("SELECT payload FROM trashed").fetchone()[0], "old-trash")

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


class DbInstallSecurityInitTests(_DbGateHarness):
    """R7 0-B(코덱스 P1) — 교체 후 보안 초기화가 보상 롤백 경계 안에서 원자적으로."""

    def _seed_secrets(self, path: Path) -> None:
        with closing(sqlite3.connect(str(path))) as conn:
            with conn:
                for key in db_transfer._SESSION_KEYS:
                    conn.execute(
                        "INSERT INTO app_setting(key, value) VALUES(?, 'leaked') "
                        "ON CONFLICT(key) DO UPDATE SET value='leaked'",
                        (key,),
                    )
                conn.execute(
                    "INSERT INTO account(email, password_hash, status, global_role, password_changed_at) "
                    "VALUES('imported@example.com','h','approved','member','2000-01-01T00:00:00Z')"
                )

    def test_success_wipes_secrets_and_rotates_sessions_inside_gate(self):
        self._set_marker(self.path, "old")
        incoming = self.root / "incoming.db"
        self._make_db(incoming, "new")
        self._seed_secrets(incoming)  # 가져온 DB 에 남의 토큰·서명키·계정이 있는 시나리오
        with mock.patch.object(db_transfer, "AUTH_ENABLED", True):
            result = db_transfer._install_db(incoming)
        self.assertEqual(result, {"ok": True, "relogin_required": True})
        with closing(sqlite3.connect(str(self.path))) as conn:
            leaked = conn.execute(
                "SELECT COUNT(*) FROM app_setting WHERE value='leaked'"
            ).fetchone()[0]
            self.assertEqual(leaked, 0)  # 비밀 키 전부 제거(auth_secret 포함 교체)
            secret = conn.execute(
                "SELECT value FROM app_setting WHERE key='auth_secret'"
            ).fetchone()
            self.assertTrue(secret and secret[0] and secret[0] != "leaked")
            stamp = conn.execute(
                "SELECT password_changed_at FROM account WHERE email='imported@example.com'"
            ).fetchone()[0]
            self.assertNotEqual(stamp, "2000-01-01T00:00:00Z")  # 전 계정 세션 회전

    def test_auth_off_failure_restores_active_pointer(self):
        """코덱스 P2 — AUTH off 에서 실패 시 active.json 이 원래 내용으로 복구된다."""
        from app import active_account

        pointer = self.root / "active.json"
        pointer.write_text('{"active": "artist@example.com"}', encoding="utf-8")
        self._set_marker(self.path, "old")
        incoming = self.root / "incoming.db"
        self._make_db(incoming, "new")
        with (
            mock.patch.object(db_transfer, "AUTH_ENABLED", False),
            mock.patch.object(active_account, "_POINTER", pointer),
            mock.patch.object(
                db_transfer,
                "_post_install_security_init",
                side_effect=RuntimeError("보안 초기화 실패"),
            ),
        ):
            with self.assertRaises(RuntimeError):
                db_transfer._install_db(incoming)
        self.assertEqual(
            pointer.read_text(encoding="utf-8"), '{"active": "artist@example.com"}'
        )  # 포인터 원상(로그인 상태 보존)
        with db.get_connection() as conn:
            self.assertEqual(self._marker(conn), "old")

    def test_security_init_failure_rolls_back_files(self):
        self._set_marker(self.path, "old")
        incoming = self.root / "incoming.db"
        self._make_db(incoming, "new")
        with mock.patch.object(db_transfer, "AUTH_ENABLED", True), mock.patch.object(
            db_transfer,
            "_post_install_security_init",
            side_effect=RuntimeError("보안 초기화 실패"),
        ):
            with self.assertRaises(RuntimeError):
                db_transfer._install_db(incoming)
        with db.get_connection() as conn:
            self.assertEqual(self._marker(conn), "old")  # 성공 응답 없이 기존 파일로 롤백
