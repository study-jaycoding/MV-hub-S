"""고정 Higgsfield CLI 출력 계약의 작은 회귀 테스트."""

from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch


class CliBridgeContractTests(IsolatedAsyncioTestCase):
    async def test_model_get_accepts_cli_1_1_20_job_type(self):
        from app.services import cli_bridge

        cli_bridge._CALL_CACHE.clear()
        response = {
            "display_name": "Nano Banana Flash",
            "job_type": "nano_banana_flash",
            "type": "image",
            "params": [{"name": "prompt"}],
        }
        with patch.object(cli_bridge, "_run_json", new=AsyncMock(return_value=response)):
            result = await cli_bridge.get_model_params("nano_banana_flash")

        self.assertEqual(result["job_set_type"], "nano_banana_flash")
        self.assertEqual(result["params"], [{"name": "prompt"}])
