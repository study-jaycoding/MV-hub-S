"""생성물 개인 메타 배치 API의 부분 성공 계약."""

from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import call, patch

from fastapi import HTTPException

from app.routers import generation


class GenerationMetaBatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.request = SimpleNamespace(state=SimpleNamespace(account=None))

    def test_color_batch_reports_item_failures(self) -> None:
        body = generation.GenerationColorsBatchIn(
            items=[
                generation.GenerationColorBatchItem(id="g1", color="red"),
                generation.GenerationColorBatchItem(id="g2", color="red"),
            ]
        )
        with patch.object(
            generation,
            "set_color",
            side_effect=[{"id": "g1"}, HTTPException(status_code=403, detail="forbidden")],
        ) as setter:
            result = generation.set_colors_batch(body, self.request)

        self.assertEqual(result, {"succeeded": ["g1"], "failed": ["g2"]})
        self.assertEqual(
            setter.call_args_list,
            [
                call("g1", generation.ColorIn(color="red"), self.request),
                call("g2", generation.ColorIn(color="red"), self.request),
            ],
        )

    def test_tag_batch_selects_personal_or_auto_setter(self) -> None:
        body = generation.GenerationTagsBatchIn(
            items=[generation.GenerationTagsBatchItem(id="g1", tags=["hero"])],
            auto=True,
        )
        with (
            patch.object(generation, "set_tags") as personal,
            patch.object(generation, "set_gen_auto_tags", return_value={"id": "g1"}) as automatic,
        ):
            result = generation.set_tags_batch(body, self.request)

        self.assertEqual(result, {"succeeded": ["g1"], "failed": []})
        personal.assert_not_called()
        automatic.assert_called_once_with(
            "g1",
            generation.AutoTagsIn(auto_tags=["hero"]),
            self.request,
        )


if __name__ == "__main__":
    unittest.main()
