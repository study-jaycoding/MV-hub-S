"""생성물 개인 메타 배치 라우터가 usecase 경계에만 의존하는지 고정한다."""

from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app.routers import generation
from app.usecases.generation_personal_meta import BatchMutationResult


class GenerationMetaBatchRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.request = SimpleNamespace(state=SimpleNamespace(account=None))

    def test_color_batch_delegates_all_items_once(self) -> None:
        body = generation.GenerationColorsBatchIn(
            items=[
                generation.GenerationColorBatchItem(id="g1", color="red"),
                generation.GenerationColorBatchItem(id="g2", color=None),
            ]
        )
        can_edit = object()
        fetch = object()
        with (
            patch.object(generation, "_batch_meta_callbacks", return_value=(can_edit, fetch)),
            patch.object(generation, "_my_uid", return_value="me"),
            patch.object(generation._proxy, "proxying", return_value=True),
            patch.object(
                generation.generation_personal_meta,
                "set_colors_batch",
                return_value=BatchMutationResult(["g1"], ["g2"]),
            ) as setter,
        ):
            result = generation.set_colors_batch(body, self.request)

        self.assertEqual(result, {"succeeded": ["g1"], "failed": ["g2"]})
        setter.assert_called_once_with(
            [("g1", "red"), ("g2", None)],
            proxying=True,
            my_uid="me",
            can_edit=can_edit,
            fetch_server_cards=fetch,
        )

    def test_tag_batch_passes_auto_mode(self) -> None:
        body = generation.GenerationTagsBatchIn(
            items=[generation.GenerationTagsBatchItem(id="g1", tags=["hero"])],
            auto=True,
        )
        can_edit = object()
        fetch = object()
        with (
            patch.object(generation, "_batch_meta_callbacks", return_value=(can_edit, fetch)),
            patch.object(generation, "_my_uid", return_value="me"),
            patch.object(generation._proxy, "proxying", return_value=False),
            patch.object(
                generation.generation_personal_meta,
                "set_tags_batch",
                return_value=BatchMutationResult(["g1"], []),
            ) as setter,
        ):
            result = generation.set_tags_batch(body, self.request)

        self.assertEqual(result, {"succeeded": ["g1"], "failed": []})
        setter.assert_called_once_with(
            [("g1", ["hero"])],
            auto=True,
            proxying=False,
            my_uid="me",
            can_edit=can_edit,
            fetch_server_cards=fetch,
        )

    def test_proxy_callback_fetches_all_missing_cards_once(self) -> None:
        with patch.object(
            generation._proxy,
            "proxy_json",
            return_value={
                "items": {
                    "g1": {"id": "g1", "job_id": "j1"},
                    "bad": "not-a-card",
                }
            },
        ) as proxy:
            _, fetch_server_cards = generation._batch_meta_callbacks(self.request)
            result = fetch_server_cards(["g1", "g2"])

        self.assertEqual(result, {"g1": {"id": "g1", "job_id": "j1"}})
        proxy.assert_called_once_with(
            "POST",
            "/api/generations/batch",
            body={"gen_ids": ["g1", "g2"]},
            timeout=15,
        )

    def test_proxy_callback_turns_remote_failure_into_item_failures(self) -> None:
        with patch.object(
            generation._proxy,
            "proxy_json",
            side_effect=HTTPException(status_code=502, detail="offline"),
        ):
            _, fetch_server_cards = generation._batch_meta_callbacks(self.request)
            self.assertEqual(fetch_server_cards(["g1"]), {})


if __name__ == "__main__":
    unittest.main()
