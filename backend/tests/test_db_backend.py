"""DB 백엔드 가드 불변식 — sqlite 외 백엔드(미완 PG)는 런타임 진입에서 차단된다."""
import unittest
from unittest import mock

from app import db


class DbBackendGuardTests(unittest.TestCase):
    def test_postgres_backend_is_blocked_at_entry(self):
        # 미지원 백엔드(postgres)면 init_db·get_connection 진입에서 RuntimeError.
        # pgsupport 미완 코드가 옵트인처럼 조용히 실행되지 않게 하는 불변식.
        with mock.patch.object(db, "DB_BACKEND", "postgres"):
            with self.assertRaises(RuntimeError):
                db.init_db()
            with self.assertRaises(RuntimeError):
                with db.get_connection():
                    pass

    def test_sqlite_backend_passes_guard(self):
        # 기본 sqlite 는 가드를 통과(예외 없음).
        with mock.patch.object(db, "DB_BACKEND", "sqlite"):
            db._assert_supported_backend()  # 예외 안 나면 통과


if __name__ == "__main__":
    unittest.main()
