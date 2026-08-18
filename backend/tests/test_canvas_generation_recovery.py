"""캔버스 생성 연결의 재시작 복구·계정 격리·멱등 계약."""

from __future__ import annotations

import asyncio
import concurrent.futures
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from app import db, repo
from app.models import RegenerateIn
from app.usecases.gen_requests import (
    CanvasGenerationConflict,
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
            # 실운영 제출은 라우터의 RL-04 가드를 지나 항상 워크스페이스가 확정돼 있다 —
            # repair 재큐잉도 그 전제를 검사하므로 픽스처도 확정 워크스페이스로 만든다.
            workspace={"scope": "team", "id": "ws-1", "name": "팀"},
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

    def test_concurrent_same_attempt_creates_and_queues_exactly_once(self):
        link = self._link("concurrent")
        command = GenRequestCommand(
            kind="create",
            email="artist@example.com",
            creator_uid="artist",
            worker_id="me",
            source_gen_id=None,
            data={"prompt": "canvas", "model": "model", "params": {}},
            canvas_link=link,
        )
        original_create = repo.create_local_generation
        both_at_create = threading.Barrier(2)

        def synchronized_create(*args, **kwargs):
            both_at_create.wait(timeout=5)
            return original_create(*args, **kwargs)

        def submit():
            return asyncio.run(submit_gen_request(command))

        with mock.patch(
            "app.usecases.gen_requests.repo.create_local_generation",
            side_effect=synchronized_create,
        ), mock.patch(
            "app.usecases.gen_requests.MANAGE_ENABLED", False
        ), mock.patch(
            "app.usecases.gen_requests.agent_signals.signal"
        ) as signal, mock.patch(
            "app.usecases.gen_requests.journal_generation_event"
        ) as journal, concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _index: submit(), range(2)))

        self.assertEqual([result["id"] for result in results], [link["generation_id"]] * 2)
        signal.assert_called_once_with("artist@example.com", "gen-request")
        journal.assert_called_once()
        with db.get_connection() as conn:
            counts = (
                conn.execute(
                    "SELECT count(*) n FROM generation WHERE id=?",
                    (link["generation_id"],),
                ).fetchone()["n"],
                conn.execute(
                    "SELECT count(*) n FROM gen_request WHERE canvas_attempt_id=?",
                    (link["attempt_id"],),
                ).fetchone()["n"],
            )
        self.assertEqual(counts, (1, 1))

    def test_direct_retry_finishes_preparing_reservation_after_crash_window(self):
        link = self._link("direct-retry")
        with mock.patch(
            "app.usecases.gen_requests.repo.activate_canvas_gen_request",
            side_effect=RuntimeError("simulated stop before activation"),
        ), self.assertRaisesRegex(RuntimeError, "simulated stop"):
            self._submit(link)

        with db.get_connection() as conn:
            before = conn.execute(
                "SELECT status FROM gen_request WHERE canvas_attempt_id=?",
                (link["attempt_id"],),
            ).fetchone()
        self.assertEqual(before["status"], "preparing")
        self.assertEqual(
            repo.claim_pending_requests("artist@example.com", 1, workspace_capable=True),
            [],
        )

        retried = self._submit(link)

        self.assertEqual(retried["id"], link["generation_id"])
        claimed = repo.claim_pending_requests(
            "artist@example.com", 1, workspace_capable=True
        )
        self.assertEqual([item["gen_id"] for item in claimed], [link["generation_id"]])

    def test_restart_repair_activates_preparing_request_only_when_placeholder_exists(self):
        link = self._link("restart-preparing")
        with mock.patch(
            "app.usecases.gen_requests.repo.activate_canvas_gen_request",
            side_effect=RuntimeError("simulated stop before activation"),
        ), self.assertRaises(RuntimeError):
            self._submit(link)

        self.assertEqual(
            repo.resolve_canvas_generation_links(
                "artist@example.com", [link["attempt_id"]]
            ),
            [],
        )
        self.assertEqual(repo.fail_orphaned_jobs(), 0)
        self.assertEqual(repo.get_generation(link["generation_id"])["status"], "pending")
        with mock.patch("app.usecases.gen_requests.agent_signals.signal") as signal:
            repaired = repair_canvas_generation_links(
                "artist@example.com", "artist", [link]
            )

        self.assertEqual(repaired[0]["generation_id"], link["generation_id"])
        self.assertEqual(repaired[0]["request_status"], "pending")
        signal.assert_called_once_with("artist@example.com", "gen-request")

    def test_repair_refuses_unknown_workspace_and_fails_placeholder(self):
        """RL-04 는 repair 재큐잉에도 적용 — unknown 워크스페이스 payload 를 pending 에
        넣으면 구 에이전트(claim 게이트가 team/personal 제외)가 이것만 골라 현재 CLI
        공간으로 실행해 오귀속 과금이 재현된다. 유령 placeholder 대신 명확한 실패로 종결."""
        link = self._link("unknown-ws")
        repo.create_local_generation(
            {"prompt": "legacy", "model": "model", "params": {}},
            "me",
            creator_uid="artist",
            generation_id=link["generation_id"],  # 워크스페이스 미기록(레거시 placeholder)
        )

        with mock.patch("app.usecases.gen_requests.agent_signals.signal") as signal:
            repaired = repair_canvas_generation_links(
                "artist@example.com", "artist", [link]
            )

        self.assertEqual(repaired, [])  # 요청행이 만들어지지 않음
        signal.assert_not_called()
        self.assertEqual(repo.claim_pending_requests("artist@example.com", 5), [])
        generation = repo.get_generation(link["generation_id"])
        self.assertEqual(generation["status"], "failed")
        self.assertIn("워크스페이스", generation["error"])

    def test_reservation_without_placeholder_is_not_exposed_and_expires(self):
        link = self._link("reservation-only")
        repo.reserve_canvas_gen_request(
            "artist@example.com",
            "artist",
            link["generation_id"],
            "create",
            link,
            {"kind": "create"},
        )

        self.assertEqual(
            repo.resolve_canvas_generation_links(
                "artist@example.com", [link["attempt_id"]]
            ),
            [],
        )
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE gen_request SET created_at=datetime('now','-11 minutes') "
                "WHERE canvas_attempt_id=?",
                (link["attempt_id"],),
            )
        repo.resolve_canvas_generation_links(
            "artist@example.com", [link["attempt_id"]]
        )
        with db.get_connection() as conn:
            count = conn.execute(
                "SELECT count(*) n FROM gen_request WHERE canvas_attempt_id=?",
                (link["attempt_id"],),
            ).fetchone()["n"]
        self.assertEqual(count, 0)

    def test_same_attempt_with_changed_contract_is_rejected_without_new_generation(self):
        link = self._link("changed")
        self._submit(link)
        changed = GenRequestCommand(
            kind="create",
            email="artist@example.com",
            creator_uid="artist",
            worker_id="me",
            source_gen_id=None,
            data={"prompt": "different", "model": "model", "params": {}},
            canvas_link=link,
        )
        with mock.patch(
            "app.usecases.gen_requests.MANAGE_ENABLED", False
        ), self.assertRaises(CanvasGenerationConflict):
            asyncio.run(submit_gen_request(changed))

        with db.get_connection() as conn:
            self.assertEqual(
                conn.execute(
                    "SELECT count(*) n FROM generation WHERE id=?",
                    (link["generation_id"],),
                ).fetchone()["n"],
                1,
            )

    def test_restart_repair_rejects_completed_attempt_pointing_to_another_card(self):
        link = self._link("completed-mismatch")
        self._submit(link)
        mismatched = {
            **link,
            "generation_id": "generation_1234567890_other",
            "card_id": "card-other",
        }

        repaired = repo.repair_orphaned_canvas_generation(
            "artist@example.com",
            "artist",
            mismatched,
            {"prompt": "other", "model": "model", "params": {}},
        )

        self.assertFalse(repaired)
        self.assertIsNone(repo.get_generation(mismatched["generation_id"]))

    def test_regenerate_retry_resumes_same_child_and_preserves_override(self):
        source_id = repo.create_local_generation(
            {"prompt": "source", "model": "model", "params": {}},
            "me",
            creator_uid="artist",
        )
        link = self._link("regenerate")
        command = GenRequestCommand(
            kind="regenerate",
            email="artist@example.com",
            creator_uid="artist",
            worker_id="me",
            source_gen_id=source_id,
            regenerate=RegenerateIn(prompt="changed"),
            canvas_link=link,
        )
        common = (
            mock.patch("app.usecases.gen_requests.MANAGE_ENABLED", False),
            mock.patch("app.usecases.gen_requests.agent_signals.signal"),
            mock.patch("app.usecases.gen_requests.journal_generation_event"),
        )
        with common[0], common[1], common[2], mock.patch(
            "app.usecases.gen_requests.repo.activate_canvas_gen_request",
            side_effect=RuntimeError("simulated stop"),
        ), self.assertRaises(RuntimeError):
            asyncio.run(submit_gen_request(command))
        with mock.patch(
            "app.usecases.gen_requests.MANAGE_ENABLED", False
        ), mock.patch(
            "app.usecases.gen_requests.agent_signals.signal"
        ), mock.patch(
            "app.usecases.gen_requests.journal_generation_event"
        ):
            retried = asyncio.run(submit_gen_request(command))

        self.assertEqual(retried["id"], link["generation_id"])
        self.assertEqual(retried["prompt"], "changed")
        with db.get_connection() as conn:
            self.assertEqual(
                conn.execute(
                    "SELECT count(*) n FROM history WHERE parent_gen_id=? AND child_gen_id=?",
                    (source_id, link["generation_id"]),
                ).fetchone()["n"],
                1,
            )

    def test_restart_repair_applies_regenerate_options_missed_before_crash(self):
        source_id = repo.create_local_generation(
            {"prompt": "source", "model": "old-model", "params": {}},
            "me",
            creator_uid="artist",
        )
        link = self._link("regenerate-repair")
        contract = {
            "kind": "regenerate",
            "worker_id": "me",
            "source_gen_id": source_id,
            "workspace": {"scope": "unknown", "id": None, "name": None},
            "create": None,
            "regenerate": RegenerateIn(
                prompt="recovered prompt",
                model="new-model",
                color="#abcdef",
                auto_tags=["recovered"],
            ).model_dump(),
        }
        repo.reserve_canvas_gen_request(
            "artist@example.com",
            "artist",
            link["generation_id"],
            "regenerate",
            link,
            contract,
        )
        # import까지만 끝나고 override 직전에 프로세스가 종료된 상태를 재현한다.
        repo.import_generation(
            source_id,
            "me",
            creator_uid="artist",
            generation_id=link["generation_id"],
            workspace={"scope": "team", "id": "ws-1", "name": "팀"},
        )

        with mock.patch("app.usecases.gen_requests.agent_signals.signal"):
            repaired = repair_canvas_generation_links(
                "artist@example.com", "artist", [link]
            )

        self.assertEqual(repaired[0]["request_status"], "pending")
        generation = repo.get_generation(link["generation_id"])
        self.assertEqual(generation["prompt"], "recovered prompt")
        self.assertEqual(generation["model"], "new-model")
        self.assertEqual(generation["color"], "#abcdef")
        self.assertIn("recovered", generation["auto_tags"])
        claimed = repo.claim_pending_requests(
            "artist@example.com", 1, workspace_capable=True
        )[0]
        self.assertEqual(claimed["prompt"], "recovered prompt")
        self.assertEqual(claimed["model"], "new-model")

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
        # 카드 소속표에 이미 담긴 것은 후보에서 빠진다 — 씬 열 때 자동으로 합쳐지므로
        # 목록에 남으면 이미 잘 있는 생성물을 또 붙이게 된다.
        repo.sync_scene_card_links(
            "u-artist",
            [{"scene_id": "scene-a", "card_id": "card-a", "generation_id": old_id}],
            [],
        )
        self.assertNotIn(
            old_id,
            repo.list_canvas_generation_candidates("artist@example.com", owner_uid="u-artist"),
        )
        # 다른 사람 소속표는 내 후보에 영향을 주지 않는다
        self.assertIn(
            old_id,
            repo.list_canvas_generation_candidates("artist@example.com", owner_uid="u-other"),
        )
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
        self.assertEqual(pm.call_count, 2)
        self.assertEqual(
            [call.kwargs["operation"] for call in pm.call_args_list],
            ["record_request", "record_request_estimate"],
        )

    def test_placeholder_only_crash_window_is_requeued_for_same_owner(self):
        link = self._link("orphan")
        repo.create_local_generation(
            {"prompt": "orphan", "model": "model", "params": {}},
            "me",
            creator_uid="artist",
            generation_id=link["generation_id"],
            workspace={"scope": "team", "id": "ws-1", "name": "팀"},
        )
        with mock.patch("app.usecases.gen_requests.agent_signals.signal") as signal:
            repaired = repair_canvas_generation_links(
                "artist@example.com", "artist", [link]
            )

        self.assertEqual(repaired[0]["generation_id"], link["generation_id"])
        signal.assert_called_once_with("artist@example.com", "gen-request")
        self.assertEqual(
            repo.claim_pending_requests(
                "artist@example.com", 1, workspace_capable=True
            )[0]["gen_id"],
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
