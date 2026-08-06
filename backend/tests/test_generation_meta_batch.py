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

    def test_proxy_callback_reraises_non_legacy_failures(self) -> None:
        # 401(인증 만료)·403(권한)·502(서버 장애)를 삼켜 "N건 실패"로 뭉개면 사용자가
        # 원인을 볼 수 없다 — 구서버 판별(404/405) 외에는 그대로 전파한다(합의 설계).
        for status in (401, 403, 502):
            with patch.object(
                generation._proxy,
                "proxy_json",
                side_effect=HTTPException(status_code=status, detail="boom"),
            ):
                _, fetch_server_cards = generation._batch_meta_callbacks(self.request)
                with self.assertRaises(HTTPException):
                    fetch_server_cards(["g1"])

    def test_proxy_callback_falls_back_to_single_gets_on_legacy_server(self) -> None:
        # 배치 라우트가 없는 구서버(404) → 단건 GET fan-out 으로 실제 카드를 되찾는다.
        # 개별 404(서버에 없는 항목)는 그 항목만 실패로 남긴다.
        def fake_proxy(method, path, body=None, timeout=None):
            if method == "POST":
                raise HTTPException(status_code=404, detail="Not Found")
            gen_id = path.rsplit("/", 1)[-1]
            if gen_id == "gone":
                raise HTTPException(status_code=404, detail="Not Found")
            return {"id": gen_id, "job_id": f"job-{gen_id}"}

        with patch.object(generation._proxy, "proxy_json", side_effect=fake_proxy):
            _, fetch_server_cards = generation._batch_meta_callbacks(self.request)
            result = fetch_server_cards(["g1", "gone", "g2"])

        self.assertEqual(set(result), {"g1", "g2"})
        self.assertEqual(result["g1"]["job_id"], "job-g1")

    def test_proxy_callback_fanout_respects_limit(self) -> None:
        # 폴백 fan-out 은 상한까지만 순차 조회 — 초과분은 실패로 남는다(폭주 방지).
        calls: list[str] = []

        def fake_proxy(method, path, body=None, timeout=None):
            if method == "POST":
                raise HTTPException(status_code=404, detail="Not Found")
            calls.append(path)
            return {"id": path.rsplit("/", 1)[-1]}

        ids = [f"g{i}" for i in range(generation._LEGACY_FANOUT_LIMIT + 20)]
        with patch.object(generation._proxy, "proxy_json", side_effect=fake_proxy):
            _, fetch_server_cards = generation._batch_meta_callbacks(self.request)
            result = fetch_server_cards(ids)

        self.assertEqual(len(calls), generation._LEGACY_FANOUT_LIMIT)
        self.assertEqual(len(result), generation._LEGACY_FANOUT_LIMIT)


if __name__ == "__main__":
    unittest.main()
