"""워크스페이스 데이터 규격과 콘텐츠/관리 DB 무손실 마이그레이션 계약."""

from __future__ import annotations

import os
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from pydantic import ValidationError

from app import active_account, db, db_migrations, repo
from app import manage_db
from app.models import GenerationOut, ProjectOut, WorkspaceContext
from app.repo import manage
from app.repo import manage_telemetry
from app.workspace_context import normalize_workspace_context


class WorkspaceContextContractTests(unittest.TestCase):
    def test_strict_api_context_and_safe_storage_normalization(self):
        team = WorkspaceContext(scope="team", id=" ws-millionvolt ", name=" MILLIONVOLT ")
        self.assertEqual(team.model_dump(), {"scope": "team", "id": "ws-millionvolt", "name": "MILLIONVOLT"})

        with self.assertRaises(ValidationError):
            WorkspaceContext(scope="team", id=None, name="MILLIONVOLT")
        with self.assertRaises(ValidationError):
            WorkspaceContext(scope="personal", id="must-not-exist")

        # 저장소 내부 입력은 불완전한 team을 오분류하지 않고 unknown으로 축소한다.
        self.assertEqual(
            normalize_workspace_context({"scope": "team", "name": "MILLIONVOLT"}),
            {"scope": "unknown", "id": None, "name": None},
        )

        # 자체 id/name 을 가진 엔티티 dict(프로젝트 행·공유 번들 generation)가 평면 형식으로
        # 들어와도 엔티티 id 를 워크스페이스 id 로 오인하지 않는다 — cache_projects/공유 import 오염 회귀.
        self.assertEqual(
            normalize_workspace_context({
                "id": "proj-uuid-123", "name": "EP01",
                "workspace_scope": "team", "workspace_id": "ws-uuid-999", "workspace_name": "MILLIONVOLT",
            }),
            {"scope": "team", "id": "ws-uuid-999", "name": "MILLIONVOLT"},
        )
        self.assertEqual(
            normalize_workspace_context({
                "id": "job-abc", "prompt": "x",
                "workspace_scope": "team", "workspace_id": "ws-uuid-999", "workspace_name": None,
            }),
            {"scope": "team", "id": "ws-uuid-999", "name": None},
        )
        # fail closed: "scope" 키가 있으면 그 형식으로만 읽는다 — 비었어도 평면 형식으로 폴백하지 않는다.
        self.assertEqual(
            normalize_workspace_context({
                "scope": None,
                "workspace_scope": "team", "workspace_id": "ws-uuid-999",
            }),
            {"scope": "unknown", "id": None, "name": None},
        )
        # 어느 스코프 키도 없는 엔티티 dict 는 unknown (엔티티 id 미오염).
        self.assertEqual(
            normalize_workspace_context({"id": "job-abc", "prompt": "x"}),
            {"scope": "unknown", "id": None, "name": None},
        )
        self.assertIn("workspace_scope", GenerationOut.model_fields)
        self.assertIn("workspace_scope", ProjectOut.model_fields)


class WorkspaceContentDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = str(Path(self.tmp.name) / "content_hub.db")
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

    @staticmethod
    def _team() -> dict[str, str]:
        return {"scope": "team", "id": "ws-millionvolt", "name": "MILLIONVOLT"}

    def test_generation_project_request_and_telemetry_keep_same_context(self):
        project = repo.create_project("Project A", workspace=self._team())
        self.assertEqual(project["workspace_scope"], "team")
        self.assertEqual(project["workspace_id"], "ws-millionvolt")

        gen_id = repo.create_local_generation(
            {"prompt": "p", "model": "m", "params": {}, "project_id": project["id"]},
            "me",
            creator_uid="user-me",
            workspace=self._team(),
        )
        generation = repo.get_generation(gen_id)
        self.assertEqual(generation["workspace_scope"], "team")
        self.assertEqual(generation["workspace_id"], "ws-millionvolt")
        self.assertEqual(generation["workspace_name"], "MILLIONVOLT")

        recipe = repo.gen_recipe(gen_id)
        self.assertEqual(recipe["workspace"], self._team())
        repo.create_gen_request("artist@example.com", "user-me", gen_id, "create", recipe)
        # 워크스페이스 지정 요청은 capability 없는(구) 에이전트에게 내려가지 않는다 — F7 게이트.
        self.assertEqual(repo.claim_pending_requests("artist@example.com", 1), [])
        claimed = repo.claim_pending_requests("artist@example.com", 1, workspace_capable=True)
        self.assertEqual(claimed[0]["workspace"], self._team())

        telemetry = manage.build_telemetry_facts([gen_id], "user-me")
        self.assertEqual(telemetry[0]["workspace_scope"], "team")
        self.assertEqual(telemetry[0]["workspace_id"], "ws-millionvolt")

    def test_startup_backfills_only_exact_registered_team_workspace_name(self):
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO workspace_registry(id,name) VALUES('ws-known','MILLIONVOLT')"
            )
        known_id = repo.create_local_generation(
            {"prompt": "known", "model": "m", "params": {}},
            "me",
            creator_uid="user-me",
            workspace={"scope": "team", "id": "ws-known", "name": None},
        )
        unknown_id = repo.create_local_generation(
            {"prompt": "unknown", "model": "m", "params": {}},
            "me",
            creator_uid="user-me",
            workspace={"scope": "team", "id": "ws-missing", "name": None},
        )
        self.assertIsNone(repo.get_generation(known_id)["workspace_name"])
        self.assertIsNone(repo.get_generation(unknown_id)["workspace_name"])

        db.flush_pool()
        db.init_db()

        self.assertEqual(repo.get_generation(known_id)["workspace_name"], "MILLIONVOLT")
        self.assertIsNone(repo.get_generation(unknown_id)["workspace_name"])

    def test_project_workspace_automatically_adds_available_members_without_overwriting_roles(self):
        with db.get_connection() as conn:
            conn.execute("INSERT INTO workspace_registry(id,name) VALUES('ws-millionvolt','MILLIONVOLT')")
            for uid, email, global_role, reported_uid in (
                ("u-manager", "manager@example.com", "product_manager", "u-manager"),
                ("u-artist", "artist@example.com", "member", None),
            ):
                conn.execute("INSERT INTO creator(uid,name) VALUES(?,?)", (uid, uid))
                conn.execute(
                    "INSERT INTO account(email,name,password_hash,status,global_role,creator_uid) "
                    "VALUES(?,?,'test-hash','approved',?,?)",
                    (email, uid, global_role, uid),
                )
                conn.execute(
                    "INSERT INTO workspace_member(workspace_id,account_email,creator_uid,is_available) "
                    "VALUES('ws-millionvolt',?,?,1)",
                    (email, reported_uid),
                )

        self.assertEqual(
            {row["uid"] for row in repo.list_workspace_members("ws-millionvolt")},
            {"u-manager", "u-artist"},
        )
        project = repo.create_project("Auto members", workspace=self._team())
        roles = {row["uid"]: row["roles"] for row in repo.list_project_members(project["id"])}
        self.assertEqual(roles["u-manager"], ["project_manager"])
        self.assertEqual(roles["u-artist"], ["creator"])

        repo.set_project_roles(project["id"], "u-artist", ["supervisor"])
        repo.set_project_workspace(project["id"], self._team())
        roles = {row["uid"]: row["roles"] for row in repo.list_project_members(project["id"])}
        self.assertEqual(roles["u-artist"], ["supervisor"])

    def test_claim_gate_does_not_starve_general_requests_behind_specified_backlog(self):
        # 지정(team) 요청이 아무리 앞에 쌓여도(65개>구 스캔상한 64) 구 에이전트 claim 이
        # 뒤의 일반 요청을 집을 수 있어야 한다 — SQL 필터 기아 회귀.
        for i in range(65):
            repo.create_gen_request(
                "artist@example.com", "user-me", f"g{i}", "create",
                {"model": "m", "workspace": self._team()},
            )
        repo.create_gen_request("artist@example.com", "user-me", "g-general", "create", {"model": "m"})
        claimed = repo.claim_pending_requests("artist@example.com", 4)
        self.assertEqual([c["gen_id"] for c in claimed], ["g-general"])
        # capable 에이전트는 남은 지정 요청 전부 claim 가능.
        claimed_capable = repo.claim_pending_requests(
            "artist@example.com", 100, workspace_capable=True
        )
        self.assertEqual(len(claimed_capable), 65)

    def test_cache_projects_mirror_never_uses_project_id_as_workspace_id(self):
        # 서버 ProjectOut dict 는 자체 id/name 을 갖는다 — 미러·백필이 프로젝트 UUID 를
        # workspace_id 로 저장하던 오염 회귀(P1-1).
        gen_id = repo.create_local_generation(
            {"prompt": "p", "model": "m", "params": {}}, "me", creator_uid="user-me",
        )
        server_project = {
            "id": "proj-uuid-123", "name": "EP01", "kind": "team", "archived": False,
            "workspace_scope": "team", "workspace_id": "ws-millionvolt", "workspace_name": "MILLIONVOLT",
        }
        repo.cache_projects([server_project])
        with db.get_connection() as conn:
            conn.execute("UPDATE generation SET project_id='proj-uuid-123' WHERE id=?", (gen_id,))
        repo.cache_projects([server_project])  # 백필 경로 재실행

        with db.get_connection() as conn:
            mirror = conn.execute(
                "SELECT workspace_scope, workspace_id, workspace_name FROM project WHERE id='proj-uuid-123'"
            ).fetchone()
            backfilled = conn.execute(
                "SELECT workspace_scope, workspace_id FROM generation WHERE id=?", (gen_id,)
            ).fetchone()
        self.assertEqual(
            (mirror["workspace_scope"], mirror["workspace_id"], mirror["workspace_name"]),
            ("team", "ws-millionvolt", "MILLIONVOLT"),
        )
        self.assertEqual((backfilled["workspace_scope"], backfilled["workspace_id"]), ("team", "ws-millionvolt"))

    def test_workspace_filter_separates_generations_projects_and_unassigned_counts(self):
        team_a = self._team()
        team_b = {"scope": "team", "id": "ws-other", "name": "OTHER"}
        project_a = repo.create_project("Project A workspace", workspace=team_a)
        project_b = repo.create_project("Project B workspace", workspace=team_b)
        gen_a = repo.create_local_generation(
            {"prompt": "a", "model": "m", "params": {}, "project_id": project_a["id"]},
            "me", creator_uid="user-me", workspace=team_a,
        )
        repo.create_local_generation(
            {"prompt": "b", "model": "m", "params": {}, "project_id": project_b["id"]},
            "me", creator_uid="user-me", workspace=team_b,
        )
        repo.create_local_generation(
            {"prompt": "a unassigned", "model": "m", "params": {}},
            "me", creator_uid="user-me", workspace=team_a,
        )

        generations = repo.list_generations(workspace_id="ws-millionvolt")
        # 기본 list_generations는 한 페이지 반환이며 미분류도 포함한다.
        self.assertEqual({item["prompt"] for item in generations}, {"a", "a unassigned"})
        self.assertIn(gen_a, {item["id"] for item in generations})
        projects = repo.list_projects(workspace_id="ws-millionvolt")
        self.assertEqual([item["id"] for item in projects["projects"]], [project_a["id"]])
        self.assertEqual(projects["projects"][0]["count"], 1)
        self.assertEqual(projects["unassigned"], 1)

    def test_project_assignment_backfills_legacy_unknown_and_rejects_other_workspace(self):
        team_a = self._team()
        team_b = {"scope": "team", "id": "ws-other", "name": "OTHER"}
        project_a = repo.create_project("Assignment target", workspace=team_a)
        legacy = repo.create_local_generation(
            {"prompt": "legacy", "model": "m", "params": {}},
            "me", creator_uid="user-me",
        )
        other = repo.create_local_generation(
            {"prompt": "other", "model": "m", "params": {}},
            "me", creator_uid="user-me", workspace=team_b,
        )

        self.assertEqual(repo.assign_to_project([legacy], project_a["id"]), 1)
        migrated = repo.get_generation(legacy)
        self.assertEqual(
            (migrated["workspace_scope"], migrated["workspace_id"], migrated["workspace_name"]),
            ("team", "ws-millionvolt", "MILLIONVOLT"),
        )
        with self.assertRaisesRegex(ValueError, "다른 워크스페이스"):
            repo.assign_to_project([other], project_a["id"])

    def test_manual_workspace_assignment_enforces_owner_and_marks_telemetry(self):
        mine = repo.create_local_generation(
            {"prompt": "mine", "model": "m", "params": {}},
            "me", creator_uid="user-me",
        )
        other = repo.create_local_generation(
            {"prompt": "other", "model": "m", "params": {}},
            "me", creator_uid="user-other",
        )

        with self.assertRaises(repo.WorkspaceOwnershipError):
            repo.set_generation_workspace_batch(
                [mine, other], "assign", {"id": "ws-millionvolt", "name": "MILLIONVOLT"},
                owner_uid="user-me",
            )
        self.assertIsNone(repo.get_generation(mine)["workspace_id"])

        result = repo.set_generation_workspace_batch(
            [mine], "assign", {"id": "ws-millionvolt", "name": "MILLIONVOLT"},
            owner_uid="user-me",
        )
        self.assertEqual([row["id"] for row in result["changed"]], [mine])
        self.assertEqual(repo.get_generation(mine)["workspace_id"], "ws-millionvolt")
        dirty = manage_telemetry.list_dirty_telemetry()
        self.assertIn(mine, {row["local_gen_id"] for row in dirty})

    def test_manual_workspace_removal_rejects_team_project(self):
        project = repo.create_project("Team project", workspace=self._team())
        gen_id = repo.create_local_generation(
            {"prompt": "p", "model": "m", "params": {}, "project_id": project["id"]},
            "me", creator_uid="user-me", workspace=self._team(),
        )
        with self.assertRaisesRegex(repo.WorkspaceProjectConflict, "프로젝트"):
            repo.set_generation_workspace_batch(
                [gen_id], "remove", {"id": "ws-millionvolt", "name": "MILLIONVOLT"},
                owner_uid="user-me",
            )
        self.assertEqual(repo.get_generation(gen_id)["workspace_id"], "ws-millionvolt")

    def test_manual_removal_stays_personal_after_later_cli_sync(self):
        parsed = {
            "generation": {
                "id": "job-manual-remove",
                "prompt": "p",
                "model": "m",
                "params": {},
                "status": "done",
                "created_at": "2026-08-06T00:00:00Z",
                "sort_ts": 1.0,
                "creator_uid": "user-me",
            },
            "asset": None,
            "references": [],
        }
        repo.apply_synced_jobs([parsed], "me", workspace=self._team())
        with db.get_connection() as conn:
            generation_id = conn.execute(
                "SELECT id FROM generation WHERE job_id='job-manual-remove'"
            ).fetchone()[0]
        repo.set_generation_workspace_batch(
            [generation_id],
            "remove",
            {"id": "ws-millionvolt", "name": "MILLIONVOLT"},
            owner_uid="user-me",
        )
        repo.apply_synced_jobs([parsed], "me", workspace=self._team())
        after = repo.get_generation(generation_id)
        self.assertEqual(
            (after["workspace_scope"], after["workspace_id"], after["workspace_name"]),
            ("personal", None, None),
        )

    def test_workspace_name_resolution_is_case_insensitive_and_rejects_ambiguity(self):
        with db.get_connection() as conn:
            conn.execute("INSERT INTO workspace_registry(id,name) VALUES('ws-a','TeaTime')")
        self.assertEqual(
            repo.resolve_workspace_name("  teatime  "),
            {"id": "ws-a", "name": "TeaTime"},
        )
        with db.get_connection() as conn:
            conn.execute("INSERT INTO workspace_registry(id,name) VALUES('ws-b','TEATIME')")
        with self.assertRaises(repo.WorkspaceNameAmbiguous):
            repo.resolve_workspace_name("teatime")

    def test_synced_unknown_can_be_filled_but_known_context_cannot_be_overwritten(self):
        parsed = {
            "generation": {
                "id": "job-1",
                "prompt": "p",
                "model": "m",
                "params": {},
                "status": "done",
                "created_at": "2026-08-06T00:00:00Z",
                "sort_ts": 1.0,
                "creator_uid": "user-me",
            },
            "asset": None,
            "references": [],
        }
        first = repo.apply_synced_jobs([parsed], "me", workspace=self._team())
        self.assertEqual(first["inserted"], 1)
        with db.get_connection() as conn:
            row = conn.execute(
                "SELECT workspace_scope, workspace_id, workspace_name FROM generation WHERE job_id='job-1'"
            ).fetchone()
        self.assertEqual(tuple(row), ("team", "ws-millionvolt", "MILLIONVOLT"))

        other = {"scope": "team", "id": "ws-other", "name": "OTHER"}
        repo.apply_synced_jobs([parsed], "me", workspace=other)
        with db.get_connection() as conn:
            row = conn.execute(
                "SELECT workspace_scope, workspace_id, workspace_name FROM generation WHERE job_id='job-1'"
            ).fetchone()
        self.assertEqual(tuple(row), ("team", "ws-millionvolt", "MILLIONVOLT"))

    def test_account_reports_build_workspace_member_registry(self):
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO account(email,name,password_hash,status,creator_uid) "
                "VALUES('artist@example.com','Artist','hash','approved','user-me')"
            )
        repo.record_account_status(
            "Artist@Example.com",
            {
                "workspaces": [
                    {
                        "id": "ws-millionvolt",
                        "name": "MILLIONVOLT",
                        "plan_type": "team",
                        "credits": "120.5",
                        "user_role": "member",
                        "is_selected": True,
                    },
                    {"id": "personal", "name": None, "plan_type": "free"},
                ]
            },
        )
        rows = repo.list_workspace_registry("artist@example.com")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], "ws-millionvolt")
        self.assertEqual(rows[0]["creator_uid"], "user-me")
        self.assertEqual(rows[0]["credits"], 120.5)
        self.assertEqual(rows[0]["is_selected"], 1)

        repo.record_account_status("artist@example.com", {"workspaces": []})
        self.assertEqual(repo.list_workspace_registry("artist@example.com"), [])
        stale = repo.list_workspace_registry("artist@example.com", available_only=False)
        self.assertEqual(stale[0]["is_available"], 0)

    def test_legacy_account_status_is_backfilled_without_refreshing_existing_rows(self):
        status = {
            "workspaces": [
                {
                    "id": "ws-legacy",
                    "name": "LEGACY TEAM",
                    "plan_type": "team",
                    "credits": 50,
                    "user_role": "owner",
                    "is_selected": True,
                }
            ]
        }
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO account(email,name,password_hash,status,creator_uid) "
                "VALUES('legacy@example.com','Legacy','hash','approved','user-legacy')"
            )
            conn.execute(
                "INSERT INTO app_setting(key,value) VALUES(?,?)",
                ("hf_status:legacy@example.com", json.dumps(status)),
            )
            conn.execute("DELETE FROM workspace_member")
            conn.execute("DELETE FROM workspace_registry")
            db_migrations._migrate(conn)
            first = conn.execute(
                "SELECT m.creator_uid, m.user_role, m.is_selected, m.last_seen_at "
                "FROM workspace_member m WHERE m.workspace_id='ws-legacy'"
            ).fetchone()
            conn.execute(
                "UPDATE workspace_member SET last_seen_at='2000-01-01 00:00:00' "
                "WHERE workspace_id='ws-legacy'"
            )
            db_migrations._migrate(conn)
            second_seen = conn.execute(
                "SELECT last_seen_at FROM workspace_member WHERE workspace_id='ws-legacy'"
            ).fetchone()[0]
        self.assertEqual(tuple(first[:3]), ("user-legacy", "owner", 1))
        self.assertEqual(second_seen, "2000-01-01 00:00:00")

    def test_workspace_member_identity_follows_account_uid_remap(self):
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO workspace_registry(id,name) VALUES('ws-millionvolt','MILLIONVOLT')"
            )
            conn.execute(
                "INSERT INTO workspace_member(workspace_id,account_email,creator_uid) "
                "VALUES('ws-millionvolt','artist@example.com','acct:artist@example.com')"
            )
            repo.remap_creator_uid(conn, "acct:artist@example.com", "user-artist")
            creator_uid = conn.execute(
                "SELECT creator_uid FROM workspace_member "
                "WHERE workspace_id='ws-millionvolt' AND account_email='artist@example.com'"
            ).fetchone()[0]
        self.assertEqual(creator_uid, "user-artist")

    def test_legacy_content_rows_migrate_to_unknown_without_data_loss(self):
        with db.get_connection() as conn:
            conn.execute("INSERT INTO project(id,name,kind) VALUES('legacy-p','Legacy Project','team')")
            conn.execute(
                "INSERT INTO generation(id,worker_id,prompt,status,created_at,sort_ts,project_id) "
                "VALUES('legacy-g','me','keep-me','done','2026-01-01',1,'legacy-p')"
            )
            # 실제 구버전처럼 두 테이블에서 workspace 컬럼만 없는 구조로 재구성한다.
            conn.execute("DROP TABLE IF EXISTS generation_fts")
            for table in ("generation", "project"):
                columns = [
                    row[1]
                    for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
                    if row[1] not in {"workspace_scope", "workspace_id", "workspace_name"}
                ]
                quoted = ",".join(f'"{column}"' for column in columns)
                conn.execute(f"CREATE TABLE {table}_legacy AS SELECT {quoted} FROM {table}")
                conn.execute(f"DROP TABLE {table}")
                conn.execute(f"ALTER TABLE {table}_legacy RENAME TO {table}")

            db_migrations._migrate(conn)
            # 두 번째 실행도 같은 결과를 유지해야 한다(배포 재시작 멱등성).
            db_migrations._migrate(conn)
            generation = conn.execute(
                "SELECT prompt, workspace_scope, workspace_id, workspace_name "
                "FROM generation WHERE id='legacy-g'"
            ).fetchone()
            project = conn.execute(
                "SELECT name, workspace_scope, workspace_id, workspace_name "
                "FROM project WHERE id='legacy-p'"
            ).fetchone()
            indexes = {
                row["name"]
                for row in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")
            }
        self.assertEqual(tuple(generation), ("keep-me", "unknown", None, None))
        self.assertEqual(tuple(project), ("Legacy Project", "unknown", None, None))
        self.assertIn("idx_generation_workspace_sort", indexes)
        self.assertIn("idx_project_workspace", indexes)


class WorkspaceManageDatabaseMigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_path = manage_db.MANAGE_DB_PATH
        manage_db.MANAGE_DB_PATH = Path(self.tmp.name) / "manage_hub.db"

    def tearDown(self):
        manage_db.MANAGE_DB_PATH = self.old_path
        self.tmp.cleanup()

    def _create_legacy_manage_db(self):
        with sqlite3.connect(manage_db.MANAGE_DB_PATH) as conn:
            conn.executescript(
                """
                CREATE TABLE team_generation_fact (
                    id TEXT PRIMARY KEY, account_email TEXT NOT NULL, creator_uid TEXT,
                    creator_name TEXT, local_gen_id TEXT NOT NULL, job_id TEXT,
                    project_id TEXT, project_name TEXT, folder_path TEXT, model TEXT,
                    output_type TEXT, status TEXT, real_credits REAL, est_credits REAL,
                    credit_source TEXT, elapsed_seconds REAL, created_at TEXT, started_at TEXT,
                    completed_at TEXT, sort_ts REAL, is_final INTEGER DEFAULT 0,
                    is_shared INTEGER DEFAULT 0, is_deleted INTEGER DEFAULT 0, deleted_at TEXT,
                    last_seen_at TEXT, updated_at TEXT, UNIQUE(account_email, local_gen_id)
                );
                INSERT INTO team_generation_fact(id,account_email,local_gen_id,model)
                VALUES('fact-1','artist@example.com','g1','nano');
                """
            )

    def test_legacy_manage_db_adds_workspace_dimensions_and_preserves_known_values(self):
        self._create_legacy_manage_db()
        manage_db.init_manage_db()
        with manage_db.get_connection() as conn:
            legacy = conn.execute(
                "SELECT model, workspace_scope, workspace_id, workspace_name "
                "FROM team_generation_fact WHERE id='fact-1'"
            ).fetchone()
            indexes = {
                row["name"]
                for row in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")
            }
        self.assertEqual(tuple(legacy), ("nano", "unknown", None, None))
        self.assertIn("idx_tgf_workspace_created", indexes)
        self.assertIn("idx_tgf_workspace_creator_created", indexes)

        item = {
            "local_gen_id": "g2",
            "creator_uid": "user-me",
            "workspace_scope": "team",
            "workspace_id": "ws-millionvolt",
            "workspace_name": "MILLIONVOLT",
        }
        manage_db.upsert_facts("artist@example.com", "user-me", [item])
        manage_db.upsert_facts(
            "artist@example.com",
            "user-me",
            [{"local_gen_id": "g2", "creator_uid": "user-me"}],
        )
        with manage_db.get_connection() as conn:
            known = conn.execute(
                "SELECT workspace_scope, workspace_id, workspace_name "
                "FROM team_generation_fact WHERE account_email='artist@example.com' "
                "AND local_gen_id='g2'"
            ).fetchone()
        self.assertEqual(tuple(known), ("team", "ws-millionvolt", "MILLIONVOLT"))

        # 명시적 제거는 unknown이 아니라 personal이므로 옛 클라이언트 보호 규칙에 막히지 않고
        # 팀 대시보드 귀속에서도 빠져야 한다.
        manage_db.upsert_facts(
            "artist@example.com",
            "user-me",
            [{"local_gen_id": "g2", "creator_uid": "user-me", "workspace_scope": "personal"}],
        )
        with manage_db.get_connection() as conn:
            removed = conn.execute(
                "SELECT workspace_scope, workspace_id, workspace_name "
                "FROM team_generation_fact WHERE account_email='artist@example.com' "
                "AND local_gen_id='g2'"
            ).fetchone()
        self.assertEqual(tuple(removed), ("personal", None, None))

    def test_manage_backfill_uses_only_exact_registry_id_and_empty_name(self):
        manage_db.init_manage_db()
        common = {
            "creator_uid": "user-me",
            "workspace_scope": "team",
            "status": "done",
        }
        manage_db.upsert_facts(
            "artist@example.com",
            "user-me",
            [
                {**common, "local_gen_id": "known", "workspace_id": "ws-known"},
                {**common, "local_gen_id": "missing", "workspace_id": "ws-missing"},
                {
                    **common,
                    "local_gen_id": "named",
                    "workspace_id": "ws-known",
                    "workspace_name": "KEEP",
                },
            ],
        )

        updated = manage_db.backfill_workspace_names(
            [{"id": "ws-known", "name": "MILLIONVOLT"}]
        )

        with manage_db.get_connection() as conn:
            rows = {
                row["local_gen_id"]: row["workspace_name"]
                for row in conn.execute(
                    "SELECT local_gen_id, workspace_name FROM team_generation_fact"
                )
            }
        self.assertEqual(updated, 1)
        self.assertEqual(
            rows, {"known": "MILLIONVOLT", "missing": None, "named": "KEEP"}
        )

    def test_workspace_usage_aggregates_models_members_projects_and_folder_efficiency(self):
        manage_db.init_manage_db()
        common = {
            "workspace_scope": "team",
            "workspace_id": "ws-millionvolt",
            "workspace_name": "MILLIONVOLT",
            "status": "done",
            "output_type": "image",
        }
        u1 = [
            {**common, "local_gen_id": "a1", "creator_uid": "u1", "creator_name": "Artist 1",
             "project_id": "p1", "project_name": "Project 1", "folder_path": "shots/010",
             "model": "nano", "real_credits": 2, "is_final": 1,
             "created_at": "2026-08-01T10:00:00Z"},
            {**common, "local_gen_id": "a2", "creator_uid": "u1", "creator_name": "Artist 1",
             "project_id": "p1", "project_name": "Project 1", "folder_path": "shots/010",
             "model": "seedance", "output_type": "video", "real_credits": 4, "is_final": 0,
             "created_at": "2026-08-02T10:00:00Z"},
            {**common, "local_gen_id": "other", "creator_uid": "u1", "model": "nano",
             "workspace_id": "ws-other", "workspace_name": "OTHER", "real_credits": 99,
             "created_at": "2026-08-02T10:00:00Z"},
        ]
        u2 = [
            {**common, "local_gen_id": "a3", "creator_uid": "u2", "creator_name": "Artist 2",
             "project_id": "p2", "project_name": "Project 2", "folder_path": "shots/020",
             "model": "nano", "real_credits": 3, "is_final": 0,
             "created_at": "2026-08-02T12:00:00Z"},
        ]
        self.assertEqual(manage_db.upsert_facts("u1@example.com", "u1", u1), (3, []))
        self.assertEqual(manage_db.upsert_facts("u2@example.com", "u2", u2), (1, []))

        overview = manage_db.team_overview(workspace_id="ws-millionvolt")
        self.assertEqual(overview["totals"]["count"], 3)
        self.assertEqual(overview["totals"]["credits"], 9)
        self.assertEqual(overview["totals"]["workers"], 2)
        self.assertEqual(overview["totals"]["projects"], 2)
        self.assertEqual(overview["totals"]["models"], 2)
        self.assertEqual({row["model"] for row in overview["by_model"]}, {"nano", "seedance"})
        self.assertEqual(
            {row["output_type"]: (row["count"], row["credits"]) for row in overview["by_output_type"]},
            {"image": (2, 5), "video": (1, 4)},
        )
        self.assertEqual(
            {
                (row["output_type"], row["model"]): (row["count"], row["credits"])
                for row in overview["output_models"]
            },
            {("image", "nano"): (2, 5), ("video", "seedance"): (1, 4)},
        )
        self.assertEqual(len([row for row in overview["worker_models"] if row["creator_uid"] == "u1"]), 2)
        folder = next(row for row in overview["folder_efficiency"] if row["folder_path"] == "shots/010")
        self.assertEqual(folder["count"], 2)
        self.assertEqual(folder["final_count"], 1)
        self.assertEqual(folder["episode"], "shots")
        self.assertEqual(folder["scene"], "010")
        self.assertEqual(folder["yield_percent"], 50.0)
        self.assertEqual(folder["final_rate_tenths"], 5.0)
        self.assertEqual(folder["attempts_per_final"], 2.0)

        artist_overview = manage_db.team_overview(
            workspace_id="ws-millionvolt", creator_uid="u1"
        )
        self.assertEqual(artist_overview["totals"]["count"], 2)
        self.assertEqual(
            {row["model"] for row in artist_overview["by_model"]},
            {"nano", "seedance"},
        )
        self.assertEqual(
            [row["folder_path"] for row in artist_overview["folder_efficiency"]],
            ["shots/010"],
        )

        buckets = manage_db.team_timeseries(
            workspace_id="ws-millionvolt", project_id="p1", bucket="day"
        )
        self.assertEqual(sum(row["count"] for row in buckets), 2)
        self.assertEqual(sum(row["credits"] for row in buckets), 6)
        # 버킷·시간 범위는 서버 localtime 기준(팀 표준시 KST 통일) — 기대값을 머신 시간대
        # 무관하게 UTC 원본에서 변환해 계산한다.
        from datetime import datetime, timezone as _tz

        def _local(utc_str: str, fmt: str) -> str:
            dt = datetime.strptime(utc_str, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=_tz.utc)
            return dt.astimezone().strftime(fmt)

        hourly = manage_db.team_timeseries(
            workspace_id="ws-millionvolt", project_id="p1", bucket="hour"
        )
        self.assertEqual(
            [row["bucket"] for row in hourly],
            [
                _local("2026-08-01T10:00:00Z", "%Y-%m-%dT%H:00"),
                _local("2026-08-02T10:00:00Z", "%Y-%m-%dT%H:00"),
            ],
        )
        local_minute = _local("2026-08-02T10:00:00Z", "%Y-%m-%dT%H:%M")
        local_hour_start = _local("2026-08-02T10:00:00Z", "%Y-%m-%dT%H:00:00")
        local_hour_end = _local("2026-08-02T10:00:00Z", "%Y-%m-%dT%H:59:59")
        minutes = manage_db.team_timeseries(
            workspace_id="ws-millionvolt", project_id="p1", bucket="minute",
            time_from=local_hour_start, time_to=local_hour_end,
        )
        self.assertEqual(
            [(row["bucket"], row["count"]) for row in minutes],
            [(local_minute, 1)],
        )

        export_rows = manage_db.team_usage_export(workspace_id="ws-millionvolt")
        d1 = _local("2026-08-01T10:00:00Z", "%Y-%m-%d")
        d2 = _local("2026-08-02T10:00:00Z", "%Y-%m-%d")
        self.assertEqual(
            export_rows,
            [
                {"date": d1, "user_email": "u1@example.com", "user_id": "u1",
                 "model": "nano", "credits_used": 2, "jobs": 1},
                {"date": d2, "user_email": "u1@example.com", "user_id": "u1",
                 "model": "seedance", "credits_used": 4, "jobs": 1},
                {"date": d2, "user_email": "u2@example.com", "user_id": "u2",
                 "model": "nano", "credits_used": 3, "jobs": 1},
            ],
        )


class WorkspaceProjectApiPolicyTests(unittest.TestCase):
    """프로젝트 API 워크스페이스 정책(규격 규칙 8·10) — 등록부 검증·정식 이름 교체·unknown 강등 거절."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        self.old_np = os.environ.get("CONTENT_HUB_NO_PROXY")
        os.environ["CONTENT_HUB_DB"] = str(Path(self.tmp.name) / "content_hub.db")
        os.environ["CONTENT_HUB_NO_PROXY"] = "1"
        # 사용자 PC의 data/active.json 로그인 포인터가 API 정책 테스트에 섞이지 않게 한다.
        # 이 테스트는 인증이 아니라 워크스페이스 입력 정규화만 검증한다.
        self.active_token = active_account.set_override("")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            conn.execute("INSERT INTO workspace_registry(id,name) VALUES('ws-millionvolt','MILLIONVOLT')")
        from fastapi.testclient import TestClient
        from app.main import app

        self.client = TestClient(app, client=("127.0.0.1", 50000))

    def tearDown(self):
        self.client.close()
        db.flush_pool()
        active_account.reset_override(self.active_token)
        for key, old in (("CONTENT_HUB_DB", self.old_db), ("CONTENT_HUB_NO_PROXY", self.old_np)):
            if old is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old
        db.flush_pool()
        self.tmp.cleanup()

    def test_team_workspace_must_exist_in_registry_and_name_is_canonicalized(self):
        r = self.client.post(
            "/api/projects",
            json={"name": "EP-bad", "workspace": {"scope": "team", "id": "ws-forged", "name": "가짜"}},
        )
        self.assertEqual(r.status_code, 400)

        r = self.client.post(
            "/api/projects",
            json={"name": "EP01", "workspace": {"scope": "team", "id": "ws-millionvolt", "name": "옛날이름"}},
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["workspace_name"], "MILLIONVOLT")  # 등록부 정식 이름으로 교체

    def test_explicit_unknown_downgrade_is_rejected_but_personal_removal_allowed(self):
        pid = self.client.post(
            "/api/projects",
            json={"name": "EP02", "workspace": {"scope": "team", "id": "ws-millionvolt", "name": "MILLIONVOLT"}},
        ).json()["id"]

        r = self.client.patch(f"/api/projects/{pid}", json={"workspace": {"scope": "unknown"}})
        self.assertEqual(r.status_code, 400)  # 제거는 personal 로만 (unknown 은 동기화가 재보강)

        r = self.client.patch(f"/api/projects/{pid}", json={"workspace": {"scope": "personal"}})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["workspace_scope"], "personal")

    def test_default_workspace_on_create_stays_unknown(self):
        r = self.client.post("/api/projects", json={"name": "EP03"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["workspace_scope"], "unknown")  # 미지정 기본값은 허용

    def test_ingest_accepts_broken_workspace_field_as_unknown(self):
        # 워크스페이스 필드 하나가 깨져도 push 배치 전체가 422 로 거부되면 안 된다(규격 규칙①).
        for broken in ({"scope": "team", "name": "MILLIONVOLT"}, None, "garbage"):
            r = self.client.post("/api/ingest", json={"jobs": [], "workspace": broken})
            self.assertEqual(r.status_code, 200, f"workspace={broken!r}")


if __name__ == "__main__":
    unittest.main()
