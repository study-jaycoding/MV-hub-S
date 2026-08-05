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
            patch.object(repo, "set_hf_missing") as set_hf_missing,
            patch.object(repo, "delete_generation") as delete_generation,
            patch.object(
                cli_bridge,
                "job_exists",
                new=AsyncMock(side_effect=lambda job_id: outcomes[job_id]),
            ),
        ):
            result = await generation.trash_hf_missing(SimpleNamespace())

        list_gens.assert_called_once_with(account_uid="account-1")
        set_hf_missing.assert_called_once_with("gen-exists", False)
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
            patch.object(repo, "set_hf_missing"),
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
            patch.object(repo, "set_hf_missing"),
            patch.object(repo, "delete_generation") as delete_generation,
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


if __name__ == "__main__":
    import unittest

    unittest.main()
