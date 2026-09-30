"""에셋 대장(2026-09-30) — 정체 판정·조회·레퍼런스 연결. 설계: docs/ASSET_REGISTRY.md."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from app.db import init_db
from app.repo import asset_registry as ar

F = ar.RegistryFile


class RegistryDb(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.db = init_db(Path(self._tmp.name) / "content_hub.db")
        self.conn = sqlite3.connect(self.db)

    def tearDown(self) -> None:
        self.conn.close()
        self._tmp.cleanup()

    def scan(self, files: list[F], complete: bool = True, project: str = "P") -> dict[str, int]:
        plan = ar.plan_changes(ar.registry_rows(self.conn, project), ar.RegistryScan(complete, files))
        self.conn.execute("BEGIN IMMEDIATE")
        kinds = ar.apply_plan(self.conn, project, plan)
        self.conn.execute("COMMIT")
        return kinds

    def rows(self, project: str = "P") -> dict[str, dict]:
        return {r["path"]: r for r in ar.registry_rows(self.conn, project)}


class IdentityRuleTests(RegistryDb):
    def test_new_move_edit_missing_back_keep_one_number(self) -> None:
        self.assertEqual(self.scan([F("a/x.png", 3, 1, "s1", "ok"), F("a/y.png", 4, 1, "s2", "ok")]), {"new": 2})
        first = self.rows()["a/x.png"]["registry_asset_id"]
        # 이름 바꿔 옮김 — 같은 지문으로 사라진 것 하나·생긴 것 하나 → 같은 번호
        self.assertEqual(self.scan([F("b/x2.png", 3, 2, "s1", "ok"), F("a/y.png", 4, 1, "s2", "ok")]), {"moved": 1})
        self.assertEqual(self.rows()["b/x2.png"]["registry_asset_id"], first)
        # 같은 자리에서 고쳐 저장 → 같은 번호의 새 판
        self.assertEqual(self.scan([F("b/x2.png", 5, 3, "s9", "ok"), F("a/y.png", 4, 1, "s2", "ok")]), {"edited": 1})
        self.assertEqual(self.rows()["b/x2.png"]["registry_asset_id"], first)
        self.assertEqual(self.rows()["b/x2.png"]["sha256"], "s9")
        # 한 번 없으면 아직 있음(카운터만), 두 번째에 missing
        self.assertEqual(self.scan([F("b/x2.png", 5, 3, "s9", "ok")]), {})
        self.assertEqual(self.rows()["a/y.png"]["state"], "present")
        self.assertEqual(self.scan([F("b/x2.png", 5, 3, "s9", "ok")]), {"missing": 1})
        self.assertEqual(self.rows()["a/y.png"]["state"], "missing")
        self.assertEqual(self.scan([F("b/x2.png", 5, 3, "s9", "ok"), F("a/y.png", 4, 1, "s2", "ok")]), {"back": 1})
        self.assertEqual((self.rows()["a/y.png"]["state"], self.rows()["a/y.png"]["miss_count"]), ("present", 0))

    def test_incomplete_scan_changes_nothing(self) -> None:
        self.scan([F("a/x.png", 3, 1, "s1", "ok")])
        self.assertEqual(self.scan([], complete=False), {})
        self.assertEqual(self.scan([F("z.png", 1, 1, "s0", "ok")], complete=False), {})
        self.assertEqual(list(self.rows()), ["a/x.png"])
        self.assertEqual(self.rows()["a/x.png"]["miss_count"], 0)

    def test_undetermined_file_freezes_moves_and_missing_but_not_new_or_edits(self) -> None:
        self.scan([F("a/x.png", 3, 1, "s1", "ok"), F("a/y.png", 4, 1, "s2", "ok"), F("a/z.png", 5, 1, "s3", "ok")])
        x = self.rows()["a/x.png"]["registry_asset_id"]
        # x 가 옮겨졌지만 잠긴 파일이 하나 있다 → 이동을 잇지 않고(새 번호), x 의 카운터도 올리지 않는다
        kinds = self.scan([
            F("b/x.png", 3, 2, "s1", "ok"),
            F("a/y.png", 4, 9, None, "undetermined"),
            F("a/z.png", 6, 2, "s4", "ok"),
            F("c/new.png", 7, 1, None, "pending"),
        ])
        self.assertEqual(kinds, {"new": 1, "edited": 1})
        rows = self.rows()
        self.assertNotEqual(rows["b/x.png"]["registry_asset_id"], x)
        self.assertEqual((rows["a/x.png"]["state"], rows["a/x.png"]["miss_count"]), ("present", 0))
        self.assertEqual(rows["a/y.png"]["sha256"], "s2")  # 미판정은 기존 행 그대로
        self.assertNotIn("c/new.png", rows)  # 대기 새 파일은 아직 등록하지 않는다

    def test_ambiguous_same_content_is_not_merged(self) -> None:
        self.scan([F("a/1.png", 3, 1, "s", "ok"), F("a/2.png", 3, 1, "s", "ok")])
        ids = {r["registry_asset_id"] for r in self.rows().values()}
        # 같은 지문 둘이 사라지고 하나가 생겼다 → 어느 것의 이동인지 모른다 → 새 번호
        self.assertEqual(self.scan([F("b/1.png", 3, 2, "s", "ok")]), {"new": 1})
        self.assertNotIn(self.rows()["b/1.png"]["registry_asset_id"], ids)
        # 사라진 것 하나·같은 지문 새것 둘(복사) → 역시 잇지 않는다
        self.scan([F("c/1.png", 3, 1, "t", "ok")], project="Q")
        kinds = self.scan([F("d/1.png", 3, 1, "t", "ok"), F("d/2.png", 3, 1, "t", "ok")], project="Q")
        self.assertEqual(kinds, {"new": 2})

    def test_case_only_rename_keeps_the_number(self) -> None:
        self.scan([F("CH/Mat.png", 3, 1, "s1", "ok")])
        rid = self.rows()["CH/Mat.png"]["registry_asset_id"]
        self.assertEqual(self.scan([F("ch/mat.png", 3, 1, "s1", "ok")]), {})
        self.assertEqual(self.rows()["ch/mat.png"]["registry_asset_id"], rid)

    def test_projects_are_scanned_apart(self) -> None:
        self.scan([F("a/x.png", 3, 1, "s1", "ok")], project="P")
        # 다른 프로젝트의 같은 지문 새 파일은 P 의 이동이 아니다(프로젝트 간 이동 = 새 번호)
        self.scan([F("a/x.png", 3, 1, "s1", "ok")], project="Q")
        self.assertNotEqual(self.rows("P")["a/x.png"]["registry_asset_id"], self.rows("Q")["a/x.png"]["registry_asset_id"])


class LookupTests(RegistryDb):
    def test_lookups_hide_projects_the_caller_cannot_see(self) -> None:
        self.scan([F("CH/m/x.png", 3, 1, "s1", "ok")], project="P")
        self.scan([F("CH/m/y.png", 4, 1, "s2", "ok")], project="Q")
        rid_q = self.rows("Q")["CH/m/y.png"]["registry_asset_id"]
        visible = {"P"}
        self.assertEqual(ar.lookup_ids(self.conn, [rid_q], visible), {})
        self.assertEqual(ar.lookup_shas(self.conn, [("s2", 4)], visible), {"s2": []})
        self.assertEqual(ar.lookup_tails(self.conn, ["m/y.png"], visible), {"m/y.png": []})
        self.assertEqual(len(ar.lookup_tails(self.conn, ["m/y.png"], None)["m/y.png"]), 1)

    def test_tail_lookup_follows_a_move_and_needs_two_parts(self) -> None:
        self.scan([F("assets/CH/m/x.png", 3, 1, "s1", "ok")])
        self.scan([F("assets/CH/m/old/x_v2.png", 3, 2, "s1", "ok")])
        hits = ar.lookup_tails(self.conn, ["CH/m/x.png", "x.png"], None)
        self.assertEqual([r["path"] for r in hits["CH/m/x.png"]], ["assets/CH/m/old/x_v2.png"])
        self.assertNotIn("x.png", hits)  # 이름뿐인 경로는 근거가 없다


class ReferenceLinkTests(RegistryDb):
    def _reference(self, rid: str, file_path: str, sha: str | None = None, size: int | None = None) -> None:
        self.conn.execute(
            "INSERT INTO reference(id, type, file_path, content_sha, content_bytes) VALUES(?,?,?,?,?)",
            (rid, "image", file_path, sha, size),
        )

    def test_resolve_by_content_prefers_the_matching_path_among_copies(self) -> None:
        self.scan([F("assets/CH/x.png", 3, 1, "s1", "ok"), F("backup/x.png", 3, 1, "s1", "ok")])
        want = self.rows()["assets/CH/x.png"]["registry_asset_id"]
        self.assertEqual(ar.resolve_reference_asset_id(self.conn, "s1", 3, "asset:뻘뻘뻘_RnD|CH/x.png"), want)
        self.assertIsNone(ar.resolve_reference_asset_id(self.conn, "s1", 3, "asset:imports|x.png"))
        self.assertIsNone(ar.resolve_reference_asset_id(self.conn, "s1", 99, "asset:P|assets/CH/x.png"))

    def test_backfill_marks_old_path_links_as_unverified(self) -> None:
        self.scan([F("assets/CH/x.png", 3, 1, "s1", "ok"), F("assets/CH/y.png", 4, 1, "s2", "ok")])
        rows = self.rows()
        self._reference("r1", "asset:뻘뻘뻘|assets/CH/x.png")  # 이름·경로 정확 → 가능 연결
        self._reference("r2", "asset:뻘뻘뻘_RnD|CH/x.png")  # 다른 이름 → 채우지 않는다
        self._reference("r3", "asset:imports|z.png", "s2", 4)  # 지문 → 판 확인
        self._reference("r4", "asset:뻘뻘뻘|assets/CH/gone.png")  # 대장에 없다
        self.conn.commit()
        self.assertEqual(ar.backfill_reference_links(self.conn, {"뻘뻘뻘": "P"}), {"verified": 1, "possible": 1})
        got = {r[0]: (r[1], r[2]) for r in self.conn.execute("SELECT id, registry_asset_id, version_verified FROM reference")}
        self.assertEqual(got["r1"], (rows["assets/CH/x.png"]["registry_asset_id"], 0))
        self.assertEqual(got["r2"], (None, None))
        self.assertEqual(got["r3"], (rows["assets/CH/y.png"]["registry_asset_id"], 1))
        self.assertEqual(got["r4"], (None, None))

    def test_attach_uses_the_pinned_content(self) -> None:
        self.scan([F("a/x.png", 3, 1, "s1", "ok")])
        self._reference("r1", "asset:P|a/x.png", "s1", 3)
        self._reference("r2", "asset:P|a/x.png", "other", 3)  # 다른 판 — 붙이지 않는다
        self.assertEqual(ar.attach_reference_registry(self.conn, "r1"), self.rows()["a/x.png"]["registry_asset_id"])
        self.assertIsNone(ar.attach_reference_registry(self.conn, "r2"))


class RequestDataCannotPinVersionTests(unittest.TestCase):
    """판(content_sha·bytes)·대장 번호는 에이전트가 실제로 제출한 파일의 지문(begin-submission)으로만 붙는다.
    생성 요청 데이터가 먼저 채우면 COALESCE 때문에 그 실제 지문이 영영 기록되지 못한다(2026-09-30 Claude 검토)."""

    def test_create_local_generation_ignores_client_version_fields(self) -> None:
        from app import repo
        from app.db import get_connection

        init_db()
        repo.ensure_default_worker()
        gid = repo.create_local_generation(
            {"prompt": "p", "model": "m", "params": {}, "references": [{
                "file_path": "asset:P|a.png", "type": "image", "content_sha": "c" * 64, "content_bytes": 9,
                "registry_asset_id": "client-says", "version_verified": 1,
            }]},
            "me",
        )
        with get_connection() as conn:
            row = conn.execute(
                "SELECT r.content_sha, r.content_bytes, r.registry_asset_id, r.version_verified FROM reference r "
                "JOIN gen_reference gr ON gr.reference_id = r.id WHERE gr.generation_id=?",
                (gid,),
            ).fetchone()
        self.assertEqual(tuple(row), (None, None, None, None))


class BackupCoverageTests(RegistryDb):
    """대장 번호는 생성 기록이 가리켜 다시 만들 수 없다 — 백업 복원 연습·서버 이사가 대장 표의 행까지 지켜야 한다.
    두 도구 모두 모든 표의 행 수를 복원 전후로 대조한다(backup_verify.inspect_sqlite_database). 필수 표에는 넣지 않는다 —
    대장 표가 없는 옛 백업도 복원할 수 있어야 한다(Codex P1)."""

    def test_restore_drill_counts_registry_rows_and_old_backups_still_pass(self) -> None:
        from app.services.backup_verify import create_sqlite_snapshot, inspect_sqlite_database, verify_restore_drill

        self.scan([F("a/x.png", 3, 1, "s1", "ok"), F("a/y.png", 4, 1, "s2", "ok")])
        self.conn.close()
        root = Path(self._tmp.name)
        backup = create_sqlite_snapshot(self.db, root / "backup.db")
        self.assertEqual(inspect_sqlite_database(backup)["table_counts"]["asset_registry"], 2)
        self.assertEqual(inspect_sqlite_database(backup)["table_counts"]["asset_registry_event"], 2)
        self.assertTrue(verify_restore_drill(backup, root / "restored.db")["ok"])
        # 대장 표가 없는 옛 DB 도 그대로 통과한다
        old = sqlite3.connect(root / "restored.db")
        old.executescript("DROP TABLE asset_registry; DROP TABLE asset_registry_event; DROP TABLE asset_registry_scan;")
        old.close()
        self.assertNotIn("asset_registry", inspect_sqlite_database(root / "restored.db")["tables"])
        self.conn = sqlite3.connect(self.db)  # tearDown 이 닫는다


if __name__ == "__main__":
    unittest.main()
