"""담당(배정) 모델 불변식 — task_assignment CRUD·backfill·삭제 정리.

self-assign(예정) 폐지 후 도입한 복수 담당 모델의 핵심 동작을 고정한다.
단일 assignee_uid → task_assignment 1회 이관(멱등)과 배정 목록 조립이 어긋나면 안 된다.
"""
import os
import tempfile
import unittest

from app import db, repo
from app.repo import manage


class TaskAssignmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def _assignee_uids(self, project_id, tid):
        for t in manage.list_tasks(project_id):
            if t["id"] == tid:
                return {a["uid"] for a in t.get("assigned_creators", [])}
        return None

    def test_assignment_crud_and_list(self):
        # 복수 담당 추가 → list_tasks 에 assigned_creators 로 노출, 제거하면 빠진다.
        t = manage.create_task("p1", "seq A")
        tid = t["id"]
        manage.add_assignment(tid, "user_A", "pm")
        manage.add_assignment(tid, "user_B", "pm")
        manage.add_assignment(tid, "user_A", "pm")  # 멱등(중복 무시)
        self.assertEqual(self._assignee_uids("p1", tid), {"user_A", "user_B"})
        self.assertTrue(manage.is_assignee(tid, "user_A"))
        self.assertFalse(manage.is_assignee(tid, "user_Z"))
        self.assertTrue(manage.remove_assignment(tid, "user_A"))
        self.assertEqual(self._assignee_uids("p1", tid), {"user_B"})

    def test_assignee_uid_backfill_is_idempotent(self):
        # 옛 단일 assignee_uid → task_assignment 이관 후 원 컬럼은 비워야(재실행에도 부활 안 함).
        t = manage.create_task("p1", "seq B")
        tid = t["id"]
        with db.get_connection() as conn:
            conn.execute("UPDATE project_task SET assignee_uid='user_C' WHERE id=?", (tid,))
        # 스키마 보장 가드를 비워 다음 호출에서 backfill 이 실제로 돌게 한다.
        manage._SCHEMA_ENSURED.clear()
        self.assertEqual(self._assignee_uids("p1", tid), {"user_C"})
        with db.get_connection() as conn:
            row = conn.execute("SELECT assignee_uid FROM project_task WHERE id=?", (tid,)).fetchone()
            self.assertIsNone(row["assignee_uid"])  # 이관 후 비워짐
        # 담당을 지운 뒤 재보장해도 assignee_uid 로 부활하지 않아야(멱등).
        manage.remove_assignment(tid, "user_C")
        manage._SCHEMA_ENSURED.clear()
        self.assertEqual(self._assignee_uids("p1", tid), set())

    def test_delete_task_clears_assignment(self):
        # 작업 삭제 시 배정 행도 정리(orphan 방지).
        t = manage.create_task("p1", "seq C")
        tid = t["id"]
        manage.add_assignment(tid, "user_D", "pm")
        manage.delete_task(tid)
        with db.get_connection() as conn:
            n = conn.execute(
                "SELECT COUNT(*) AS c FROM task_assignment WHERE task_id=?", (tid,)
            ).fetchone()["c"]
        self.assertEqual(n, 0)


if __name__ == "__main__":
    unittest.main()
