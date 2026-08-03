"""활성 프로젝트 이름과 Assets 권한 대상의 단일성 계약."""

import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from fastapi import HTTPException

from app import db, db_migrations, repo
from app.models import ProjectUpdate
from app.routers import projects


class ProjectNameIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = str(Path(self.tmp.name) / "projects.db")
        db.flush_pool()
        db.init_db()

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_new_database_has_active_name_unique_index(self):
        with db.get_connection() as conn:
            row = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='index' "
                "AND name='idx_project_active_name'"
            ).fetchone()
        self.assertIsNotNone(row)
        self.assertIn("WHERE archived=0", row["sql"])

    def test_create_is_idempotent_case_insensitively(self):
        first = repo.create_project("Project A")
        second = repo.create_project(" project a ")
        self.assertEqual(first["id"], second["id"])

    def test_database_rejects_active_duplicate_but_allows_archived_copy(self):
        repo.create_project("Project A")
        with db.get_connection() as conn:
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO project(id,name,kind,archived) "
                    "VALUES('active-copy',' project a ','team',0)"
                )
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO project(id,name,kind,archived) "
                "VALUES('archived-copy',' project a ','team',1)"
            )

    def test_rename_and_unarchive_reject_active_duplicate(self):
        first = repo.create_project("Project A")
        second = repo.create_project("Project B")
        with self.assertRaises(repo.ProjectNameConflictError):
            repo.rename_project(second["id"], "project a")

        repo.set_archived(first["id"], True)
        repo.rename_project(second["id"], "Project A")
        with self.assertRaises(repo.ProjectNameConflictError):
            repo.set_archived(first["id"], False)

    def test_combined_archive_and_duplicate_rename_uses_final_state(self):
        repo.create_project("Project A")
        second = repo.create_project("Project B")
        self.assertTrue(
            repo.update_project_identity(
                second["id"], name="Project A", archived=True
            )
        )
        updated = repo.get_project(second["id"])
        self.assertEqual(updated["name"], "Project A")
        self.assertTrue(updated["archived"])

    def test_legacy_duplicate_is_preserved_but_authority_lookup_fails_closed(self):
        first = repo.create_project("Project A")
        with db.get_connection() as conn:
            conn.execute("DROP INDEX idx_project_active_name")
            conn.execute(
                "INSERT INTO project(id,name,kind,archived) VALUES('duplicate','project a','team',0)"
            )
            created = db_migrations._ensure_project_active_name_index(conn)
            count = conn.execute(
                "SELECT COUNT(*) FROM project WHERE archived=0"
            ).fetchone()[0]
        self.assertFalse(created)
        self.assertEqual(count, 2)
        self.assertIsNone(repo.get_project_by_name(first["name"]))


class ProjectRouteConflictTests(unittest.TestCase):
    def test_patch_maps_name_conflict_to_409(self):
        request = SimpleNamespace()
        with (
            mock.patch.object(projects._proxy, "proxying", return_value=False),
            mock.patch.object(projects, "require_global_cap"),
            mock.patch.object(projects.repo, "get_project", return_value={"id": "p1"}),
            mock.patch.object(
                projects.repo,
                "update_project_identity",
                side_effect=repo.ProjectNameConflictError("duplicate"),
            ),
        ):
            with self.assertRaises(HTTPException) as caught:
                projects.update_project(
                    "p1", ProjectUpdate(name="duplicate"), request
                )
        self.assertEqual(caught.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
