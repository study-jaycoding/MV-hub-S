"""작업-생성물 연결 라우트의 가시성 검사 배치화 계약 — 실패 의미·순서 불변."""

from __future__ import annotations

import unittest
from unittest import mock

from fastapi import HTTPException, Request

from app.routers import manage


def _request() -> Request:
    return Request({"type": "http", "client": ("127.0.0.1", 1), "headers": []})


class LinkGenerationsVisibilityTests(unittest.TestCase):
    def _call(self, gen_ids, *, gens, visible):
        """visible: gen id -> 판정 결과. 반환: (응답 or HTTPException, link mock)."""

        def judge(_request, gen, _member_projects):
            return visible[gen["id"]]

        with (
            mock.patch.object(manage, "_require_task_manage_current"),
            mock.patch.object(
                manage.repo, "get_generations_batch", return_value=gens
            ) as batched,
            mock.patch.object(manage.repo, "get_generation") as single,
            mock.patch.object(manage, "batch_view_member_projects", return_value=None),
            mock.patch.object(
                manage, "can_view_generation_with_member_projects", side_effect=judge
            ),
            mock.patch.object(
                manage.repo_manage, "link_generations", return_value=7
            ) as link,
        ):
            try:
                result = manage.link_generations(
                    "t1", manage.TaskLinkIn(gen_ids=gen_ids), _request()
                )
            except HTTPException as exc:
                result = exc
        self.assertEqual(single.call_count, 0)  # 단건 재조회 없음
        self.assertEqual(batched.call_count, 1)
        return result, link

    def test_hidden_generation_rejects_whole_batch_before_linking(self):
        gens = {"g1": {"id": "g1"}, "g2": {"id": "g2"}}
        result, link = self._call(
            ["g1", "g2"], gens=gens, visible={"g1": True, "g2": False}
        )
        self.assertIsInstance(result, HTTPException)
        self.assertEqual(result.status_code, 404)  # 존재 은닉 계약 유지
        link.assert_not_called()  # 부분 연결 없음

    def test_all_visible_passes_original_ids_in_order(self):
        gens = {"g1": {"id": "g1"}, "g2": {"id": "g2"}}
        result, link = self._call(
            ["g2", "g1", "g2"], gens=gens, visible={"g1": True, "g2": True}
        )
        self.assertEqual(result, {"linked": 7})
        # 연결 단계에는 종전대로 원본 순서·중복 그대로 전달(연결 계층의 자체 규칙 보존).
        link.assert_called_once_with("t1", ["g2", "g1", "g2"])

    def test_missing_generation_is_left_to_link_stage(self):
        # 부재 id 는 가시성 검사에서 막지 않고 연결 단계 계약(409 등)에 맡긴다 — 종전 동작.
        result, link = self._call(["g1", "nope"], gens={"g1": {"id": "g1"}}, visible={"g1": True})
        self.assertEqual(result, {"linked": 7})
        link.assert_called_once_with("t1", ["g1", "nope"])


if __name__ == "__main__":
    unittest.main()
