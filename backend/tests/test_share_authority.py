"""공유 번들 작성자 권위 테스트.

기존 생성물 id를 아는 다른 사용자가 재공유 번들로 원 작성자의 fact·개인 오버레이·
공유 상태를 바꾸지 못해야 한다.
"""

import os
import tempfile
import unittest

from app import db, repo


class ShareAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            for uid in ("user_owner", "user_attacker"):
                conn.execute(
                    "INSERT INTO worker(id, name, account_type) VALUES(?,?, 'team')",
                    (uid, uid),
                )
            conn.execute(
                "INSERT INTO generation("
                "id, job_id, worker_id, creator_uid, prompt, status, created_at, "
                "project_id, folder_path, display_prompt"
                ") VALUES("
                "'local-owner', 'job-1', 'me', 'user_owner', 'owner prompt', 'done', "
                "'2026-07-31', NULL, 'owner/folder', 'owner display'"
                ")"
            )
            conn.execute("INSERT INTO tag(id, name) VALUES('tag-owner','owner-tag')")
            conn.execute(
                "INSERT INTO gen_tag(generation_id, tag_id) VALUES('local-owner','tag-owner')"
            )
            conn.execute("INSERT INTO auto_tag(id, name) VALUES('auto-owner','owner-auto')")
            conn.execute(
                "INSERT INTO gen_auto_tag(generation_id, auto_tag_id) "
                "VALUES('local-owner','auto-owner')"
            )

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_non_owner_reshare_cannot_mutate_or_publish_existing_generation(self):
        item = {
            "generation": {
                "id": "job-1",
                "creator_uid": "user_owner",
                "prompt": "attacker prompt",
                "status": "failed",
                "display_prompt": "attacker display",
                "project_id": "attacker-project",
                "folder_path": "attacker/folder",
            },
            "tags": ["attacker-tag"],
            "auto_tags": [],
            "comments": [
                {
                    "id": "attacker-comment",
                    "author": "user_attacker",
                    "text": "injected",
                }
            ],
        }

        result = repo.import_bundle_item(item, "me", shared_by="user_attacker")

        # 'unchanged' 가 아니라 'blocked' — 발신 측이 이 값으로 로컬 share 표식을 건너뛰어
        # "내 화면엔 공유됨 / 팀엔 안 보임" 무음 유실을 막는다.
        self.assertEqual(result, "blocked")
        with db.get_connection() as conn:
            gen = conn.execute(
                "SELECT prompt, status, display_prompt, project_id, folder_path "
                "FROM generation WHERE id='local-owner'"
            ).fetchone()
            self.assertEqual(gen["prompt"], "owner prompt")
            self.assertEqual(gen["status"], "done")
            self.assertEqual(gen["display_prompt"], "owner display")
            self.assertIsNone(gen["project_id"])
            self.assertEqual(gen["folder_path"], "owner/folder")
            tags = [
                r["name"]
                for r in conn.execute(
                    "SELECT t.name FROM gen_tag gt JOIN tag t ON t.id=gt.tag_id "
                    "WHERE gt.generation_id='local-owner'"
                )
            ]
            auto_tags = [
                r["name"]
                for r in conn.execute(
                    "SELECT a.name FROM gen_auto_tag gat "
                    "JOIN auto_tag a ON a.id=gat.auto_tag_id "
                    "WHERE gat.generation_id='local-owner'"
                )
            ]
            self.assertEqual(tags, ["owner-tag"])
            self.assertEqual(auto_tags, ["owner-auto"])
            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(*) FROM generation_comment WHERE gen_id='local-owner'"
                ).fetchone()[0],
                0,
            )
            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(*) FROM share WHERE generation_id='local-owner'"
                ).fetchone()[0],
                0,
            )

    def test_bundle_payload_reports_blocked_anchor_to_sender(self):
        # 발신 측(publish_bundle_to_server)이 blocked 항목을 식별해 로컬 share 표식을
        # 건너뛸 수 있도록, payload 집계가 blocked 수와 앵커(job id)를 돌려준다.
        bundle = {
            "provider": {"uid": "user_attacker", "name": "Attacker"},
            "generations": [
                {"generation": {"id": "job-1", "creator_uid": "user_owner", "prompt": "x"}},
            ],
        }
        counts = repo.import_bundle_payload(bundle, "me")
        self.assertEqual(counts["blocked"], 1)
        self.assertEqual(counts["blocked_ids"], ["job-1"])


if __name__ == "__main__":
    unittest.main()
