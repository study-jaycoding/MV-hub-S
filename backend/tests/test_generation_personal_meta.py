"""생성물 개인 메타 usecase의 로컬/팀 shadow 분기와 부분 성공 계약."""

from __future__ import annotations

import unittest
from unittest.mock import call, patch

from app.usecases import generation_personal_meta as meta


class GenerationPersonalMetaUsecaseTests(unittest.TestCase):
    def test_local_color_batch_keeps_permission_failures_partial(self) -> None:
        refs = {
            "g1": {"id": "loc1", "job_id": "job1", "creator_uid": "me"},
            "g2": {"id": "loc2", "job_id": "job2", "creator_uid": "other"},
        }
        with (
            patch.object(meta.repo, "resolve_generation_meta_batch", return_value=refs) as resolver,
            patch.object(meta.repo, "set_generation_colors_batch") as local_setter,
            patch.object(meta.repo, "set_color_overlays_batch") as shadow_setter,
        ):
            result = meta.set_colors_batch(
                [("g1", "red"), ("g2", "blue")],
                proxying=False,
                my_uid="me",
                can_edit=lambda ref: ref["creator_uid"] == "me",
                fetch_server_cards=lambda _: self.fail("서버 조회를 하면 안 됩니다"),
            )

        self.assertEqual(result, meta.BatchMutationResult(["g1"], ["g2"]))
        resolver.assert_called_once_with(["g1", "g2"])
        local_setter.assert_called_once_with([("loc1", "red")])
        shadow_setter.assert_called_once_with([])

    def test_missing_team_tag_uses_one_server_lookup_and_shadow_batch(self) -> None:
        fetches: list[str] = []
        with (
            patch.object(meta.repo, "resolve_generation_meta_batch", side_effect=[{}, {}]) as resolver,
            patch.object(meta.repo, "set_generation_tags_batch") as local_setter,
            patch.object(meta.repo, "set_tag_overlays_batch") as shadow_setter,
        ):
            result = meta.set_tags_batch(
                [("srv1", ["hero"])],
                auto=False,
                proxying=True,
                my_uid="me",
                can_edit=lambda _: True,
                fetch_server_cards=lambda gen_ids: (
                    fetches.extend(gen_ids)
                    or {
                        "srv1": {
                            "id": "srv1",
                            "job_id": "jobOther",
                            "creator_uid": "other",
                        }
                    }
                ),
            )

        self.assertEqual(result, meta.BatchMutationResult(["srv1"], []))
        self.assertEqual(fetches, ["srv1"])
        self.assertEqual(resolver.call_args_list, [call(["srv1"]), call(["jobOther"])])
        local_setter.assert_called_once_with([])
        shadow_setter.assert_called_once_with([("jobOther", ["hero"])])

    def test_missing_server_uuid_reclaims_own_local_row_by_job_id(self) -> None:
        reclaimed = {"jobMine": {"id": "locMine", "job_id": "jobMine", "creator_uid": "me"}}
        with (
            patch.object(meta.repo, "resolve_generation_meta_batch", side_effect=[{}, reclaimed]),
            patch.object(meta.repo, "set_generation_colors_batch") as local_setter,
            patch.object(meta.repo, "set_color_overlays_batch") as shadow_setter,
        ):
            result = meta.set_colors_batch(
                [("srvMine", "green")],
                proxying=True,
                my_uid="me",
                can_edit=lambda ref: ref["creator_uid"] == "me",
                fetch_server_cards=lambda _: {
                    "srvMine": {"id": "srvMine", "job_id": "jobMine"}
                },
            )

        self.assertEqual(result, meta.BatchMutationResult(["srvMine"], []))
        local_setter.assert_called_once_with([("locMine", "green")])
        shadow_setter.assert_called_once_with([])

    def test_auto_tags_require_local_row_and_never_create_shadow(self) -> None:
        with (
            patch.object(meta.repo, "resolve_generation_meta_batch", side_effect=[{}, {}]),
            patch.object(meta.repo, "set_generation_auto_tags_batch") as local_setter,
            patch.object(meta.repo, "set_tag_overlays_batch") as shadow_setter,
        ):
            result = meta.set_tags_batch(
                [("srvOther", ["hero"])],
                auto=True,
                proxying=True,
                my_uid="me",
                can_edit=lambda _: True,
                fetch_server_cards=lambda _: {
                    "srvOther": {"id": "srvOther", "job_id": "jobOther"}
                },
            )

        self.assertEqual(result, meta.BatchMutationResult([], ["srvOther"]))
        local_setter.assert_called_once_with([])
        shadow_setter.assert_not_called()

    def test_known_other_local_row_uses_server_anchor_without_reclaim_query(self) -> None:
        refs = {"srvOther": {"id": "locOther", "job_id": "jobOther", "creator_uid": "other"}}
        with (
            patch.object(meta.repo, "resolve_generation_meta_batch", return_value=refs) as resolver,
            patch.object(meta.repo, "set_generation_colors_batch") as local_setter,
            patch.object(meta.repo, "set_color_overlays_batch") as shadow_setter,
        ):
            result = meta.set_colors_batch(
                [("srvOther", "blue")],
                proxying=True,
                my_uid="me",
                can_edit=lambda _: False,
                fetch_server_cards=lambda _: {
                    "srvOther": {"id": "srvOther", "job_id": "jobOther"}
                },
            )

        self.assertEqual(result, meta.BatchMutationResult(["srvOther"], []))
        resolver.assert_called_once_with(["srvOther"])
        local_setter.assert_called_once_with([])
        shadow_setter.assert_called_once_with([("jobOther", "blue")])


if __name__ == "__main__":
    unittest.main()
