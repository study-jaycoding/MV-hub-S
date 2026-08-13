"""캔버스 생성 연결의 재시작 복구·계정 격리·멱등 계약."""

from __future__ import annotations

import asyncio
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from app import db, repo
from app.usecases.gen_requests import (
    GenRequestCommand,
    repair_canvas_generation_links,
    submit_gen_request,
)


class CanvasGenerationRecoveryTests(unittest.TestCase):
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
    def _link(suffix: str = "a") -> dict[str, str]:
        return {
            "attempt_id": f"attempt_1234567890_{suffix}",
            "generation_id": f"generation_1234567890_{suffix}",
            "scene_id": "scene-a",
            "card_id": "card-a",
        }

    def _submit(self, link: dict[str, str]):
        command = GenRequestCommand(
            kind="create",
            email="artist@example.com",
            creator_uid="artist",
            worker_id="me",
            source_gen_id=None,
            data={"prompt": "canvas", "model": "model", "params": {}},
            canvas_link=link,
        )
        with mock.patch("app.usecases.gen_requests.MANAGE_ENABLED", False), mock.patch(
            "app.usecases.gen_requests.agent_signals.signal"
        ), mock.patch(
            "app.usecases.gen_requests.journal_generation_event"
        ):
            return asyncio.run(submit_gen_request(command))

    def test_same_attempt_is_idempotent_and_uses_preallocated_generation_id(self):
        link = self._link()
        first = self._submit(link)
        second = self._submit(link)

        self.assertEqual(first["id"], link["generation_id"])
        self.assertEqual(second["id"], link["generation_id"])
        with db.get_connection() as conn:
            generation_count = conn.execute(
                "SELECT count(*) n FROM generation WHERE id=?", (link["generation_id"],)
            ).fetchone()["n"]
            request_count = conn.execute(
                "SELECT count(*) n FROM gen_request WHERE canvas_attempt_id=?",
                (link["attempt_id"],),
            ).fetchone()["n"]
        self.assertEqual((generation_count, request_count), (1, 1))

    def test_resolve_and_manual_candidates_are_account_scoped(self):
        linked = self._link("linked")
        self._submit(linked)
        old_id = repo.create_local_generation(
            {"prompt": "old", "model": "model", "params": {}},
            "me",
            creator_uid="artist",
        )
        repo.create_gen_request(
            "artist@example.com", "artist", old_id, "create", repo.gen_recipe(old_id)
        )

        self.assertEqual(
            repo.resolve_canvas_generation_links(
                "artist@example.com", [linked["attempt_id"]]
            )[0]["generation_id"],
            linked["generation_id"],
        )
        self.assertEqual(
            repo.resolve_canvas_generation_links(
                "other@example.com", [linked["attempt_id"]]
            ),
            [],
        )
        self.assertIn(old_id, repo.list_canvas_generation_candidates("artist@example.com"))
        self.assertNotIn(old_id, repo.list_canvas_generation_candidates("other@example.com"))
        self.assertFalse(
            repo.claim_canvas_generation_candidate(
                "other@example.com", old_id, "scene-other", "card-other"
            )
        )
        self.assertTrue(
            repo.claim_canvas_generation_candidate(
                "artist@example.com", old_id, "scene-a", "card-a"
            )
        )
        self.assertFalse(
            repo.claim_canvas_generation_candidate(
                "artist@example.com", old_id, "scene-a", "card-a"
            )
        )

    def test_slow_cost_estimate_does_not_delay_generation_response(self):
        link = self._link("slow")

        async def scenario():
            command = GenRequestCommand(
                kind="create",
                email="artist@example.com",
                creator_uid="artist",
                worker_id="me",
                source_gen_id=None,
                data={"prompt": "canvas", "model": "model", "params": {}},
                canvas_link=link,
            )
            started = time.perf_counter()
            result = await submit_gen_request(command)
            elapsed = time.perf_counter() - started
            await asyncio.sleep(0.24)
            return result, elapsed

        async def slow_estimate(*_args, **_kwargs):
            await asyncio.sleep(0.20)
            return {"credits": 5}

        with mock.patch("app.usecases.gen_requests.MANAGE_ENABLED", True), mock.patch(
            "app.usecases.gen_requests.cli_bridge.cli_available", return_value=True
        ), mock.patch(
            "app.usecases.gen_requests.cli_bridge.estimate_cost", side_effect=slow_estimate
        ), mock.patch(
            "app.usecases.gen_requests.pm_best_effort"
        ) as pm, mock.patch(
            "app.usecases.gen_requests.agent_signals.signal"
        ), mock.patch(
            "app.usecases.gen_requests.journal_generation_event"
        ):
            result, elapsed = asyncio.run(scenario())

        self.assertEqual(result["id"], link["generation_id"])
        self.assertLess(elapsed, 0.10)
        pm.assert_called_once()

    def test_placeholder_only_crash_window_is_requeued_for_same_owner(self):
        link = self._link("orphan")
        repo.create_local_generation(
            {"prompt": "orphan", "model": "model", "params": {}},
            "me",
            creator_uid="artist",
            generation_id=link["generation_id"],
        )
        with mock.patch("app.usecases.gen_requests.agent_signals.signal") as signal:
            repaired = repair_canvas_generation_links(
                "artist@example.com", "artist", [link]
            )

        self.assertEqual(repaired[0]["generation_id"], link["generation_id"])
        signal.assert_called_once_with("artist@example.com", "gen-request")
        self.assertEqual(
            repo.claim_pending_requests("artist@example.com", 1)[0]["gen_id"],
            link["generation_id"],
        )

    def test_placeholder_only_repair_rejects_other_owner(self):
        link = self._link("foreign-orphan")
        repo.create_local_generation(
            {"prompt": "orphan", "model": "model", "params": {}},
            "me",
            creator_uid="artist",
            generation_id=link["generation_id"],
        )
        with mock.patch("app.usecases.gen_requests.agent_signals.signal") as signal:
            repaired = repair_canvas_generation_links(
                "other@example.com", "other-user", [link]
            )

        self.assertEqual(repaired, [])
        signal.assert_not_called()
        self.assertIsNone(repo.get_canvas_generation_link("other@example.com", link["attempt_id"]))


if __name__ == "__main__":
    unittest.main()
