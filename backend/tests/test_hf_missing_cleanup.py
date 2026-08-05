"""Higgsfield 원본 누락 생성물 정리 흐름의 특성화 테스트.

라우터를 직접 호출하되 repo·CLI·서버 프록시는 모두 가짜로 바꾼다. 따라서 실제 DB,
Higgsfield, 공유 서버에는 접근하지 않는다.
"""

from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock, call, patch


class HfMissingCleanupTests(IsolatedAsyncioTestCase):
    async def test_local_results_only_change_definitively_checked_generations(self):
        from app import repo
        from app.routers import generation
        from app.services import cli_bridge

        outcomes = {
            "job-exists": True,
            "job-missing": False,
            "job-unknown": None,
        }

        with (
            patch.object(generation, "account_scope_uid", return_value="account-1"),
            patch.object(generation._proxy, "proxying", return_value=False),
            patch.object(
                repo,
                "gens_with_job_id",
                return_value=[
                    ("gen-exists", "job-exists"),
                    ("gen-missing", "job-missing"),
                    ("gen-unknown", "job-unknown"),
                ],
            ) as list_gens,
            patch.object(repo, "set_hf_missing_batch") as set_hf_missing_batch,
            patch.object(repo, "delete_generation", return_value=True) as delete_generation,
            patch.object(
                cli_bridge,
                "job_exists",
                new=AsyncMock(side_effect=lambda job_id: outcomes[job_id]),
            ),
        ):
            result = await generation.trash_hf_missing(SimpleNamespace())

        list_gens.assert_called_once_with(account_uid="account-1")
        set_hf_missing_batch.assert_called_once_with([("gen-exists", False)])
        delete_generation.assert_called_once_with("gen-missing")
        self.assertEqual(
            result,
            {
                "checked": 3,
                "trashed": 1,
                "server_checked": 0,
                "server_trashed": 0,
            },
        )

    async def test_server_sends_only_definitive_results(self):
        from app import repo
        from app.routers import generation
        from app.services import cli_bridge

        outcomes = {
            "server-missing": False,
            "server-exists": True,
            "server-unknown": None,
        }
        candidates = [
            {"gen_id": "server-gen-1", "job_id": "server-missing"},
            {"gen_id": "server-gen-2", "job_id": "server-exists"},
            {"gen_id": "server-gen-3", "job_id": "server-unknown"},
            {"gen_id": "server-gen-4", "job_id": None},
        ]
        proxy_json = MagicMock(
            side_effect=[
                {"candidates": candidates},
                {"trashed": 1},
            ]
        )

        with (
            patch.object(generation, "account_scope_uid", return_value="account-1"),
            patch.object(generation._proxy, "proxying", return_value=True),
            patch.object(generation._proxy, "proxy_json", proxy_json),
            patch.object(repo, "gens_with_job_id", return_value=[]),
            patch.object(repo, "set_hf_missing_batch"),
            patch.object(repo, "delete_generation"),
            patch.object(
                cli_bridge,
                "job_exists",
                new=AsyncMock(side_effect=lambda job_id: outcomes[job_id]),
            ),
        ):
            result = await generation.trash_hf_missing(SimpleNamespace())

        self.assertEqual(proxy_json.call_args_list[0], call("GET", "/api/manage/hf-missing-candidates"))
        self.assertEqual(
            proxy_json.call_args_list[1],
            call(
                "POST",
                "/api/manage/hf-missing-apply",
                body={
                    "results": [
                        {
                            "gen_id": "server-gen-1",
                            "job_id": "server-missing",
                            "exists": False,
                        },
                        {
                            "gen_id": "server-gen-2",
                            "job_id": "server-exists",
                            "exists": True,
                        },
                    ]
                },
            ),
        )
        self.assertEqual(result["server_checked"], 4)
        self.assertEqual(result["server_trashed"], 1)

    async def test_server_failure_does_not_discard_local_result(self):
        from app import repo
        from app.routers import generation
        from app.services import cli_bridge

        with (
            patch.object(generation, "account_scope_uid", return_value="account-1"),
            patch.object(generation._proxy, "proxying", return_value=True),
            patch.object(
                generation._proxy,
                "proxy_json",
                side_effect=ConnectionError("server unavailable"),
            ),
            patch.object(
                repo,
                "gens_with_job_id",
                return_value=[("gen-missing", "job-missing")],
            ),
            patch.object(repo, "set_hf_missing_batch"),
            patch.object(repo, "delete_generation", return_value=True) as delete_generation,
            patch.object(
                cli_bridge,
                "job_exists",
                new=AsyncMock(return_value=False),
            ),
            patch("app.usecases.hf_missing.logger.warning"),
        ):
            result = await generation.trash_hf_missing(SimpleNamespace())

        delete_generation.assert_called_once_with("gen-missing")
        self.assertEqual(
            result,
            {
                "checked": 1,
                "trashed": 1,
                "server_checked": 0,
                "server_trashed": 0,
            },
        )

    async def test_local_trash_count_increases_only_when_move_succeeds(self):
        from app import repo
        from app.routers import generation
        from app.services import cli_bridge

        with (
            patch.object(generation, "account_scope_uid", return_value="account-1"),
            patch.object(generation._proxy, "proxying", return_value=False),
            patch.object(
                repo,
                "gens_with_job_id",
                return_value=[("already-gone", "job-missing")],
            ),
            patch.object(repo, "set_hf_missing_batch") as set_hf_missing_batch,
            patch.object(repo, "delete_generation", return_value=False),
            patch.object(cli_bridge, "job_exists", new=AsyncMock(return_value=False)),
        ):
            result = await generation.trash_hf_missing(SimpleNamespace())

        self.assertEqual(result["trashed"], 0)
        set_hf_missing_batch.assert_called_once_with([])

    async def test_server_apply_batches_identity_validation_and_reappeared_flags(self):
        from app.routers import manage

        body = manage.HfMissingApplyIn(
            results=[
                manage.HfCheckResult(gen_id="exists", job_id="job-exists", exists=True),
                manage.HfCheckResult(gen_id="missing", job_id="job-missing", exists=False),
                manage.HfCheckResult(gen_id="other", job_id="job-other", exists=False),
                manage.HfCheckResult(gen_id="mismatch", job_id="wrong-job", exists=True),
            ]
        )
        identities = {
            "exists": ("me", "job-exists"),
            "missing": ("me", "job-missing"),
            "other": ("someone-else", "job-other"),
            "mismatch": ("me", "real-job"),
        }
        with (
            patch.object(manage, "_push_acc", return_value={"creator_uid": "me"}),
            patch.object(
                manage.repo,
                "get_generation_identities_batch",
                return_value=identities,
            ) as identity_batch,
            patch.object(manage.repo, "set_hf_missing_batch") as missing_batch,
            patch.object(manage.repo, "delete_generation", return_value=True) as delete,
        ):
            result = manage.hf_missing_apply(body, SimpleNamespace())

        self.assertEqual(result, {"trashed": 1})
        identity_batch.assert_called_once_with(["exists", "missing", "other", "mismatch"])
        missing_batch.assert_called_once_with([("exists", False)])
        delete.assert_called_once_with("missing")


if __name__ == "__main__":
    import unittest

    unittest.main()
