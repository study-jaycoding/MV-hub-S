"""생성 결과 공통 정규화와 주기 재조정 경로의 회귀 테스트."""

import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from app.generation_result import normalize_job_result
from app.models import FulfillIn
from app.routers import gen_requests as gen_request_routes
from app.services import syncer
from app.usecases import gen_requests as gen_request_usecases


class GenerationResultTests(unittest.TestCase):
    def test_image_uses_lightweight_result_as_thumbnail(self):
        result = normalize_job_result(
            {
                "generation": {
                    "id": "job-1",
                    "status": "done",
                    "error": "old error",
                    "created_at": "2026-08-05T00:00:00Z",
                    "sort_ts": 123.0,
                },
                "asset": {
                    "type": "image",
                    "file_path": "https://cdn/full.png",
                    "min_result_url": "https://cdn/min.jpg",
                },
            }
        )

        self.assertEqual(result.job_id, "job-1")
        self.assertEqual(result.status, "done")
        self.assertIsNone(result.error)
        self.assertEqual(result.asset_path, "https://cdn/full.png")
        self.assertEqual(result.asset_thumb, "https://cdn/min.jpg")

    def test_video_uses_poster_thumbnail(self):
        result = normalize_job_result(
            {
                "generation": {"id": "job-2", "status": "done"},
                "asset": {
                    "type": "video",
                    "file_path": "https://cdn/result.mp4",
                    "thumbnail_url": "https://cdn/poster.jpg",
                },
            }
        )

        self.assertEqual(result.asset_type, "video")
        self.assertEqual(result.asset_thumb, "https://cdn/poster.jpg")

    def test_image_falls_back_to_full_result_when_lightweight_url_is_missing(self):
        result = normalize_job_result(
            {
                "generation": {"id": "job-2b", "status": "done"},
                "asset": {"type": "image", "file_path": "https://cdn/full.png"},
            }
        )

        self.assertEqual(result.asset_thumb, "https://cdn/full.png")

    def test_terminal_status_preserves_error_without_asset(self):
        result = normalize_job_result(
            {
                "generation": {"id": "job-3", "status": "nsfw", "error": "content blocked"},
                "asset": None,
            }
        )

        self.assertEqual(result.status, "nsfw")
        self.assertEqual(result.error, "content blocked")
        self.assertIsNone(result.asset_path)
        self.assertIsNone(result.asset_thumb)


class PeriodicReconcileTests(unittest.TestCase):
    def test_periodic_reconcile_preserves_nsfw_error(self):
        parsed = {
            "generation": {"id": "job-4", "status": "nsfw", "error": "policy blocked"},
            "asset": None,
        }
        with patch.object(
            syncer, "_house_account_email", AsyncMock(return_value="house@example.com")
        ), patch.object(
            syncer.repo,
            "list_reconcile_candidates",
            return_value=[{"gen_id": "gen-4", "job_id": "job-4"}],
        ), patch.object(
            syncer.cli_bridge, "get_job_raw", AsyncMock(return_value={"id": "job-4"})
        ), patch.object(
            syncer.cli_bridge, "parse_job", return_value=parsed
        ), patch.object(
            syncer.repo, "apply_reconcile", return_value=True
        ) as apply_reconcile:
            count = asyncio.run(syncer.reconcile_local_house())

        self.assertEqual(count, 1)
        self.assertEqual(apply_reconcile.call_args.kwargs["status"], "nsfw")
        self.assertEqual(apply_reconcile.call_args.kwargs["error"], "policy blocked")


class ForceFailReconcileTests(unittest.TestCase):
    def test_force_fail_does_not_read_malformed_asset(self):
        parsed = {
            "generation": {"id": "job-5", "status": "done"},
            "asset": {"unexpected": "shape"},
        }
        with patch.object(
            gen_request_routes,
            "_require_account",
            return_value={"email": "house@example.com", "uid": "house"},
        ), patch.object(
            gen_request_routes.agent_signals, "touch"
        ), patch.object(
            gen_request_routes.repo,
            "get_gen_request",
            return_value={"gen_id": "gen-5", "account_email": "house@example.com"},
        ), patch.object(
            gen_request_usecases.cli_bridge, "parse_job", return_value=parsed
        ), patch.object(
            gen_request_usecases.repo, "apply_reconcile", return_value=True
        ) as apply_reconcile, patch.object(
            gen_request_usecases, "pm_best_effort"
        ), patch.object(
            gen_request_usecases.manager, "broadcast", AsyncMock()
        ):
            response = asyncio.run(
                gen_request_routes.reconcile_gen_request(
                    "request-5",
                    FulfillIn(job={}),
                    MagicMock(),
                    force_fail_reason="reference validation failed",
                )
            )

        self.assertEqual(
            response,
            {
                "ok": True,
                "applied": True,
                "outcome": "applied",
                "status": "failed",
                "job_id": "job-5",
                "asset_saved": False,
            },
        )
        self.assertEqual(apply_reconcile.call_args.args[:2], ("gen-5", "job-5"))
        self.assertEqual(apply_reconcile.call_args.kwargs["force_fail_reason"], "reference validation failed")


if __name__ == "__main__":
    unittest.main()
