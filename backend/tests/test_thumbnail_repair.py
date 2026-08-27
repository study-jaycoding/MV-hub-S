"""영상 포스터 오염(2026-08-27) 처방 계약 — MCP 썸네일 차단 · 같은 결과물일 때만 포스터 승계 · 로컬 재조정.

배경: 힉스필드 MCP show_generations 의 영상 항목 results.thumbnailUrl 은 첫 입력 이미지와 같다(실측). 이력 보충이
그 값을 asset.thumbnail_path 로 저장해 레퍼런스 시트가 영상 포스터로 떴다. CLI generate get 은 진짜 포스터를 준다."""

from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from contextlib import nullcontext
from unittest.mock import AsyncMock, patch

from app import db, repo
from app.services import cli_bridge, mcp_ingest, thumbnail_repair
from app.services.media_types import same_media_url

CDN = "https://cdn.example/user_abc"
REF = f"{CDN}/9f9de0bb-449a-4ebb-87fd-657b2875d6eb_resize.jpg"
VIDEO = f"{CDN}/hf_20260730_job-1.mp4"
POSTER = f"{CDN}/hf_20260730_job-1_thumbnail.webp"


class SameMediaUrlTests(unittest.TestCase):
    def test_exact_or_host_path_match_only(self) -> None:
        self.assertTrue(same_media_url(f"{CDN}/a.png", f"{CDN}/a.png"))
        self.assertTrue(same_media_url(f"{CDN}/a.png?sig=1", f"{CDN}/a.png?sig=2"))  # 서명 query 만 다름
        self.assertTrue(same_media_url("https://CDN.example/user_abc/a.png", f"{CDN}/a.png"))  # host 대소문자
        self.assertFalse(same_media_url(f"{CDN}/x/image.png", f"{CDN}/y/image.png"))  # 파일명만 같음
        self.assertFalse(same_media_url("https://host/a/", "https://other/b/"))  # 빈 경로끼리
        self.assertFalse(same_media_url("/media/ab/cd.jpg", "/media/ab/cd.jpg?x"))  # 로컬은 정확 일치만
        self.assertTrue(same_media_url("/media/ab/cd.jpg", "/media/ab/cd.jpg"))
        self.assertFalse(same_media_url(None, f"{CDN}/a.png"))
        self.assertFalse(same_media_url("", ""))
        self.assertFalse(same_media_url(5, f"{CDN}/a.png"))  # type: ignore[arg-type]


class McpThumbnailTests(unittest.TestCase):
    @staticmethod
    def item(**over) -> dict:
        base = {
            "id": "job-1",
            "status": "completed",
            "model": "seedance_2_0_mini",
            "type": "video",
            "createdAt": 1753833600.0,
            "params": {"prompt": "p", "medias": [{"role": "image", "data": {"id": "m1", "url": REF}}]},
            "results": {"rawUrl": VIDEO, "thumbnailUrl": REF},
        }
        base.update(over)
        return base

    def test_video_item_never_uses_mcp_thumbnail_or_min(self) -> None:
        row = mcp_ingest.mcp_item_to_cli(
            self.item(results={"rawUrl": VIDEO, "thumbnailUrl": f"{CDN}/other.webp", "minUrl": f"{CDN}/min.jpg"})
        )
        self.assertIsNone(row["thumbnail_url"])
        self.assertIsNone(row["min_result_url"])
        self.assertEqual(row["result_media_type"], "video")
        self.assertEqual(row["result_url"], VIDEO)
        parsed = cli_bridge.parse_job(row)
        self.assertEqual(parsed["asset"]["type"], "video")
        self.assertIsNone(parsed["asset"]["thumbnail_url"])

    def test_video_item_without_raw_url_does_not_promote_min_to_result(self) -> None:
        row = mcp_ingest.mcp_item_to_cli(self.item(results={"minUrl": f"{CDN}/poster.jpg"}))
        self.assertIsNone(row["result_url"])
        self.assertIsNone(cli_bridge.parse_job(row)["asset"])

    def test_video_type_survives_parse_job_without_extension(self) -> None:
        row = mcp_ingest.mcp_item_to_cli(
            self.item(results={"rawUrl": f"{CDN}/hf_20260730_job-1", "minUrl": REF})
        )
        parsed = cli_bridge.parse_job(row)
        self.assertEqual(parsed["asset"]["type"], "video")
        self.assertIsNone(parsed["asset"]["thumbnail_url"])
        self.assertIsNone(parsed["asset"]["min_result_url"])

    def test_image_item_drops_thumbnail_and_min_equal_to_input(self) -> None:
        row = mcp_ingest.mcp_item_to_cli(
            self.item(
                type="image",
                results={"rawUrl": f"{CDN}/out.png", "thumbnailUrl": f"{REF}?sig=1", "minUrl": REF},
            )
        )
        self.assertIsNone(row["thumbnail_url"])
        self.assertIsNone(row["min_result_url"])
        self.assertEqual(row["result_media_type"], "image")
        self.assertEqual(cli_bridge.parse_job(row)["asset"]["type"], "image")

    def test_image_item_keeps_unrelated_thumbnail_and_min(self) -> None:
        row = mcp_ingest.mcp_item_to_cli(
            self.item(
                type="image",
                results={"rawUrl": f"{CDN}/out.png", "thumbnailUrl": f"{CDN}/out_thumb.png", "minUrl": f"{CDN}/out_min.png"},
            )
        )
        self.assertEqual(row["thumbnail_url"], f"{CDN}/out_thumb.png")
        self.assertEqual(row["min_result_url"], f"{CDN}/out_min.png")

    def test_image_min_fallback_to_result_is_blocked_only_when_input(self) -> None:
        blocked = mcp_ingest.mcp_item_to_cli(self.item(type="image", results={"minUrl": REF}))
        self.assertIsNone(blocked["result_url"])
        kept = mcp_ingest.mcp_item_to_cli(self.item(type="image", results={"minUrl": f"{CDN}/small.png"}))
        self.assertEqual(kept["result_url"], f"{CDN}/small.png")  # 종전 폴백(객체형 results 이미지) 유지

    def test_input_images_and_medias_both_count_as_inputs(self) -> None:
        row = mcp_ingest.mcp_item_to_cli(
            self.item(
                type="image",
                params={
                    "prompt": "p",
                    "input_images": [{"url": f"{CDN}/in.png"}],
                    "medias": [{"data": {"url": f"{CDN}/m.png"}}],
                },
                results={"rawUrl": f"{CDN}/out.png", "thumbnailUrl": f"{CDN}/in.png", "minUrl": f"{CDN}/m.png"},
            )
        )
        self.assertIsNone(row["thumbnail_url"])
        self.assertIsNone(row["min_result_url"])

    def test_malformed_result_fields_are_ignored_not_raised(self) -> None:
        row = mcp_ingest.mcp_item_to_cli(
            self.item(
                type="image",
                params={"prompt": "p", "medias": "not-a-list", "input_images": [{"url": 3}, "x"]},
                results={"rawUrl": {"nested": 1}, "minUrl": ["x"], "thumbnailUrl": 5},
            )
        )
        self.assertIsNone(row["result_url"])
        self.assertIsNone(row["thumbnail_url"])
        self.assertIsNone(row["min_result_url"])
        self.assertIsNone(cli_bridge.parse_job(row)["asset"])

    def test_untyped_video_by_extension_drops_thumbnail_but_keeps_min(self) -> None:
        item = self.item()
        del item["type"]
        row = mcp_ingest.mcp_item_to_cli(
            dict(item, results={"rawUrl": VIDEO, "thumbnailUrl": f"{CDN}/x.webp", "minUrl": f"{CDN}/min.jpg"})
        )
        self.assertIsNone(row["thumbnail_url"])
        self.assertEqual(row["min_result_url"], f"{CDN}/min.jpg")  # 종전 계약(test_r11) 유지
        self.assertIsNone(row["result_media_type"])
        self.assertEqual(cli_bridge.parse_job(row)["asset"]["type"], "video")  # 확장자 판정


class _TempDbCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()

    def tearDown(self) -> None:
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    @staticmethod
    def parsed(job_id: str, *, file_path: str, thumb: str | None = None, medias: list | None = None) -> dict:
        params = {"prompt": "p"}
        if medias:
            params["medias"] = [{"role": "image", "data": {"url": url}} for url in medias]
        return {
            "generation": {
                "id": job_id,
                "prompt": "p",
                "model": "seedance_2_0_mini",
                "params": params,
                "status": "done",
                "created_at": "2026-07-30T00:00:00Z",
                "sort_ts": 1_753_833_600.0,
                "creator_uid": "u_one",
            },
            "asset": {"type": "video", "file_path": file_path, "thumbnail_url": thumb, "min_result_url": None},
            "references": [],
        }

    @staticmethod
    def assets(job_id: str) -> list:
        with db.get_connection() as conn:
            return conn.execute(
                "SELECT a.id, a.thumbnail_path, a.file_path, a.source_url FROM asset a "
                "JOIN generation g ON g.id=a.generation_id WHERE g.job_id=?",
                (job_id,),
            ).fetchall()


class PosterInheritanceTests(_TempDbCase):
    def test_missing_poster_inherits_existing_for_same_result(self) -> None:
        repo.apply_synced_jobs([self.parsed("j1", file_path=VIDEO, thumb=POSTER)], "me")
        counts = repo.apply_synced_jobs([self.parsed("j1", file_path=VIDEO)], "me")
        rows = self.assets("j1")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["thumbnail_path"], POSTER)
        self.assertEqual(counts["updated"], 0)  # 같은 asset → 재기록 생략

    def test_incoming_poster_replaces_and_counts_as_updated(self) -> None:
        repo.apply_synced_jobs([self.parsed("j1", file_path=VIDEO, thumb=REF)], "me")
        counts = repo.apply_synced_jobs([self.parsed("j1", file_path=VIDEO, thumb=POSTER)], "me")
        self.assertEqual(self.assets("j1")[0]["thumbnail_path"], POSTER)
        self.assertEqual(counts["updated"], 1)  # asset 만 바뀌어도 변경 신호

    def test_different_result_url_does_not_inherit(self) -> None:
        repo.apply_synced_jobs([self.parsed("j1", file_path=VIDEO, thumb=POSTER)], "me")
        counts = repo.apply_synced_jobs([self.parsed("j1", file_path=f"{CDN}/other.mp4")], "me")
        rows = self.assets("j1")
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["thumbnail_path"])
        self.assertEqual(rows[0]["file_path"], f"{CDN}/other.mp4")
        self.assertEqual(counts["updated"], 1)

    def test_multiple_asset_rows_or_type_mismatch_do_not_inherit(self) -> None:
        repo.apply_synced_jobs([self.parsed("j1", file_path=VIDEO, thumb=POSTER)], "me")
        with db.get_connection() as conn:
            gen_id = conn.execute("SELECT id FROM generation WHERE job_id='j1'").fetchone()["id"]
            conn.execute(
                "INSERT INTO asset(id, generation_id, type, file_path, thumbnail_path) VALUES(?,?,?,?,?)",
                ("extra", gen_id, "video", VIDEO, POSTER),
            )
        repo.apply_synced_jobs([self.parsed("j1", file_path=VIDEO)], "me")
        rows = self.assets("j1")
        self.assertEqual(len(rows), 1)  # 복수행은 통째로 교체
        self.assertIsNone(rows[0]["thumbnail_path"])  # 어느 행을 승계할지 정할 수 없어 승계 안 함

        image = self.parsed("j2", file_path=f"{CDN}/out.png", thumb=f"{CDN}/out_thumb.png")
        image["asset"]["type"] = "image"
        repo.apply_synced_jobs([image], "me")
        video_same_url = self.parsed("j2", file_path=f"{CDN}/out.png")  # 타입이 바뀐 결과물
        repo.apply_synced_jobs([video_same_url], "me")
        self.assertIsNone(self.assets("j2")[0]["thumbnail_path"])

    def test_remote_to_local_promotion_inherits_poster(self) -> None:
        repo.apply_synced_jobs([self.parsed("j1", file_path=VIDEO, thumb=POSTER)], "me")
        from app.repo import _common

        with (
            patch.object(_common.media_cache, "is_cached", return_value=True),
            patch.object(_common.media_cache, "local_rel_for", return_value="/media/ab/x.mp4"),
        ):
            repo.apply_synced_jobs([self.parsed("j1", file_path=VIDEO)], "me")
        rows = self.assets("j1")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["file_path"], "/media/ab/x.mp4")
        self.assertEqual(rows[0]["source_url"], VIDEO)
        self.assertEqual(rows[0]["thumbnail_path"], POSTER)


class RepairRepoTests(_TempDbCase):
    def test_candidates_are_only_posters_equal_to_an_input(self) -> None:
        repo.apply_synced_jobs(
            [
                self.parsed("bad", file_path=VIDEO, thumb=REF, medias=[REF]),
                self.parsed("good", file_path=f"{CDN}/hf_2.mp4", thumb=POSTER, medias=[REF]),
                self.parsed("none", file_path=f"{CDN}/hf_3.mp4", medias=[REF]),
            ],
            "me",
        )
        rows = repo.list_video_assets_with_input_thumbnail()
        self.assertEqual(sorted(r["job_id"] for r in rows), ["bad", "good"])  # 포스터 없는 행은 제외
        cands = thumbnail_repair.find_candidates(rows)
        self.assertEqual([c["job_id"] for c in cands], ["bad"])
        self.assertIn(REF, cands[0]["input_urls"])

    def test_reference_rows_count_as_inputs_too(self) -> None:
        parsed = self.parsed("bad", file_path=VIDEO, thumb=REF)
        parsed["references"] = [{"id": None, "type": "image", "file_path": REF, "role": "image"}]
        repo.apply_synced_jobs([parsed], "me")
        cands = thumbnail_repair.find_candidates(repo.list_video_assets_with_input_thumbnail())
        self.assertEqual([c["job_id"] for c in cands], ["bad"])

    def test_cas_setter_only_writes_when_value_is_current_and_generation_alive(self) -> None:
        repo.apply_synced_jobs([self.parsed("j1", file_path=VIDEO, thumb=REF)], "me")
        asset_id = self.assets("j1")[0]["id"]
        self.assertFalse(repo.set_asset_thumbnail_if_current(asset_id, "stale-value", POSTER))
        self.assertEqual(self.assets("j1")[0]["thumbnail_path"], REF)
        self.assertTrue(repo.set_asset_thumbnail_if_current(asset_id, REF, POSTER))
        self.assertEqual(self.assets("j1")[0]["thumbnail_path"], POSTER)
        self.assertTrue(repo.set_asset_thumbnail_if_current(asset_id, POSTER, None))  # 명시적 NULL
        self.assertIsNone(self.assets("j1")[0]["thumbnail_path"])
        # NULL 은 CAS 기대값이 될 수 없다(SQL `=` 는 NULL 과 일치하지 않음) — 살아 있는 생성물에서도 no-op
        self.assertFalse(repo.set_asset_thumbnail_if_current(asset_id, None, POSTER))  # type: ignore[arg-type]
        self.assertIsNone(self.assets("j1")[0]["thumbnail_path"])
        self.assertFalse(repo.set_asset_thumbnail_if_current(asset_id, POSTER, POSTER))  # 지금 값 NULL ≠ POSTER
        with db.get_connection() as conn:
            conn.execute("UPDATE asset SET thumbnail_path=? WHERE id=?", (REF, asset_id))
            conn.execute("UPDATE generation SET deleted_at='2026-08-27' WHERE job_id='j1'")
        self.assertFalse(repo.set_asset_thumbnail_if_current(asset_id, REF, POSTER))  # 삭제된 생성물은 무변경
        self.assertEqual(self.assets("j1")[0]["thumbnail_path"], REF)


class MainWiringContractTests(unittest.TestCase):
    """main.py 가 기동 때 재조정 task 를 이력 audit 직후 예약하고 종료 때 취소하는지 — 소스 계약으로 고정."""

    def test_lifespan_schedules_after_history_audit_and_cancels_on_shutdown(self) -> None:
        import inspect

        from app import main

        source = inspect.getsource(main)
        audit = source.index('startup_history_audit(), name="history-startup-audit"')
        repair = source.index('startup_thumbnail_repair(), name="thumbnail-repair"')
        self.assertLess(audit, repair)
        cancel_audit = source.index("_cancel_background_task(history_audit_task)")
        cancel_repair = source.index("_cancel_background_task(thumbnail_repair_task)")
        self.assertLess(repair, cancel_audit)
        self.assertLess(cancel_audit, cancel_repair)
        self.assertIn("if thumbnail_repair_task and not thumbnail_repair_task.done():", source)


def _candidate(job_id: str = "job-1", **over) -> dict:
    base = {
        "asset_id": f"asset-{job_id}",
        "job_id": job_id,
        "file_path": VIDEO,
        "thumbnail_path": REF,
        "source_url": None,
        "input_urls": [REF],
    }
    base.update(over)
    return base


def _raw(job_id: str = "job-1", *, result_url: str | None = VIDEO, thumbnail_url: str | None = POSTER, status: str = "completed") -> dict:
    return {
        "id": job_id,
        "status": status,
        "job_type": "seedance_2_0_mini",
        "created_at": "2026-07-30T00:00:00Z",
        "params": {"prompt": "p"},
        "result_url": result_url,
        "thumbnail_url": thumbnail_url,
    }


class DecideTests(unittest.TestCase):
    def test_decisions(self) -> None:
        cand = _candidate()
        self.assertEqual(thumbnail_repair.decide(cand, None), ("skip", None))
        self.assertEqual(thumbnail_repair.decide(cand, cli_bridge.parse_job(_raw())), ("replace", POSTER))
        self.assertEqual(thumbnail_repair.decide(cand, cli_bridge.parse_job(_raw(thumbnail_url=REF))), ("clear", None))
        self.assertEqual(thumbnail_repair.decide(cand, cli_bridge.parse_job(_raw(thumbnail_url=None))), ("clear", None))
        self.assertEqual(thumbnail_repair.decide(cand, cli_bridge.parse_job(_raw("job-9"))), ("skip", None))  # 다른 잡
        self.assertEqual(
            thumbnail_repair.decide(cand, cli_bridge.parse_job(_raw(result_url=f"{CDN}/different.mp4"))), ("skip", None)
        )  # 다른 결과물
        self.assertEqual(
            thumbnail_repair.decide(cand, cli_bridge.parse_job(_raw(result_url=None, status="queued"))), ("skip", None)
        )  # 미완료 → asset 없음
        self.assertEqual(
            thumbnail_repair.decide(cand, cli_bridge.parse_job(_raw(result_url=f"{CDN}/out.png"))), ("skip", None)
        )  # 영상 아님
        # 로컬 캐시된 행은 source_url 이 결과 동일성 키
        cached = _candidate(file_path="/media/ab/x.mp4", source_url=VIDEO)
        self.assertEqual(thumbnail_repair.decide(cached, cli_bridge.parse_job(_raw())), ("replace", POSTER))
        # 로컬 UUID(generation.id) 와 job_id 를 혼동하지 않는다 — 후보 job_id 만 본다
        self.assertEqual(thumbnail_repair.decide(_candidate(job_id="job-1"), cli_bridge.parse_job(_raw("job-1"))), ("replace", POSTER))


class RepairFlowTests(unittest.TestCase):
    def run_repair(
        self,
        rows,
        raw_effects,
        cas_effects,
        *,
        auth: bool = False,
        pair: str = "",
        status: dict | None = None,
        scope: str | None = "a@b.c",
        budget: float | None = None,
    ):
        patches = [
            patch.object(thumbnail_repair, "AUTH_ENABLED", auth),
            patch.object(thumbnail_repair, "LOCAL_AGENT_PAIR_SECRET", pair),
            patch.object(thumbnail_repair, "EXTERNAL_RECOVERY_ENABLED", True),
            patch.object(thumbnail_repair, "_capture_scope", return_value=scope),
            patch.object(
                thumbnail_repair.cli_bridge,
                "get_account_status",
                new=AsyncMock(return_value=status or {"connected": True, "email": "a@b.c"}),
            ),
            patch.object(thumbnail_repair.repo, "list_video_assets_with_input_thumbnail", return_value=rows),
            patch.object(thumbnail_repair.cli_bridge, "get_job_raw", new=AsyncMock(side_effect=raw_effects)),
            patch.object(thumbnail_repair.repo, "set_asset_thumbnail_if_current", side_effect=cas_effects),
            patch.object(thumbnail_repair.manager, "broadcast_all", new=AsyncMock()),
            patch.object(thumbnail_repair, "REPAIR_TIME_BUDGET_SECONDS", budget)
            if budget is not None
            else nullcontext(),
        ]
        started = [p.__enter__() for p in patches]
        try:
            counts = asyncio.run(thumbnail_repair.repair_once())
        finally:
            for p in reversed(patches):
                p.__exit__(None, None, None)
        get_raw, cas, broadcast = started[6], started[7], started[8]
        return counts, get_raw, cas, broadcast, started[4], started[5]

    def test_replace_clear_skip_and_stale_are_counted_and_written_by_cas(self) -> None:
        rows = [
            _candidate("job-1"),
            _candidate("job-2"),
            _candidate("job-3"),
            _candidate("job-4"),
            _candidate("job-5"),
        ]
        raws = [
            _raw("job-1"),  # 진짜 포스터 → replace
            _raw("job-2", thumbnail_url=REF),  # 또 입력 → clear
            None,  # 확인불가 → skip
            _raw("job-9"),  # 다른 잡 → skip
            _raw("job-5"),  # replace 인데 CAS 경합(stale)
        ]
        counts, get_raw, cas, broadcast, _, _ = self.run_repair(rows, raws, [True, True, False])
        self.assertEqual(
            {k: counts[k] for k in ("candidates", "replaced", "cleared", "skipped", "stale", "deferred")},
            {"candidates": 5, "replaced": 1, "cleared": 1, "skipped": 2, "stale": 1, "deferred": 0},
        )
        self.assertEqual(get_raw.await_count, 5)
        self.assertEqual(
            [c.args for c in cas.call_args_list],
            [("asset-job-1", REF, POSTER), ("asset-job-2", REF, None), ("asset-job-5", REF, POSTER)],
        )
        broadcast.assert_awaited_once_with({"type": "synced"})

    def test_no_broadcast_when_nothing_changed(self) -> None:
        counts, get_raw, cas, broadcast, _, _ = self.run_repair([_candidate()], [None], [])
        self.assertEqual(counts["skipped"], 1)
        cas.assert_not_called()
        broadcast.assert_not_awaited()

    def test_budget_defers_remaining_candidates_without_cli_calls(self) -> None:
        counts, get_raw, cas, broadcast, _, _ = self.run_repair(
            [_candidate("a"), _candidate("b")], [], [], budget=0.5
        )
        self.assertEqual(counts["deferred"], 2)
        get_raw.assert_not_awaited()
        broadcast.assert_not_awaited()

    def test_server_mode_without_pairing_never_starts(self) -> None:
        counts, get_raw, cas, broadcast, status, listing = self.run_repair([_candidate()], [], [], auth=True)
        self.assertEqual(counts["candidates"], 0)
        status.assert_not_awaited()
        listing.assert_not_called()

    def test_account_mismatch_or_legacy_db_skips_before_reading_db(self) -> None:
        counts, _, _, _, _, listing = self.run_repair(
            [_candidate()], [], [], status={"connected": True, "email": "someone@else.com"}
        )
        self.assertEqual(counts["candidates"], 0)
        listing.assert_not_called()
        counts, _, _, _, status, listing = self.run_repair([_candidate()], [], [], scope=None)
        self.assertEqual(counts["candidates"], 0)
        status.assert_not_awaited()
        listing.assert_not_called()

    def test_candidates_are_filtered_by_input_match(self) -> None:
        rows = [_candidate("x", thumbnail_path=POSTER)]  # 진짜 포스터 → 후보 아님
        counts, get_raw, _, _, _, _ = self.run_repair(rows, [], [])
        self.assertEqual(counts["candidates"], 0)
        get_raw.assert_not_awaited()

    def test_partial_success_then_candidate_error_still_broadcasts_and_continues(self) -> None:
        rows = [_candidate("job-1"), _candidate("job-2"), _candidate("job-3")]
        raws = [_raw("job-1"), OSError("subprocess spawn failed"), _raw("job-3")]
        counts, get_raw, cas, broadcast, _, _ = self.run_repair(rows, raws, [True, True])
        self.assertEqual((counts["replaced"], counts["skipped"]), (2, 1))
        self.assertEqual(get_raw.await_count, 3)  # 한 후보의 예외가 나머지를 막지 않는다
        broadcast.assert_awaited_once_with({"type": "synced"})

    def test_cancellation_after_partial_success_still_broadcasts(self) -> None:
        rows = [_candidate("job-1"), _candidate("job-2")]
        raws = [_raw("job-1"), asyncio.CancelledError()]
        broadcast = AsyncMock()
        with (
            patch.object(thumbnail_repair, "AUTH_ENABLED", False),
            patch.object(thumbnail_repair, "LOCAL_AGENT_PAIR_SECRET", ""),
            patch.object(thumbnail_repair, "EXTERNAL_RECOVERY_ENABLED", True),
            patch.object(thumbnail_repair, "_capture_scope", return_value="a@b.c"),
            patch.object(
                thumbnail_repair.cli_bridge,
                "get_account_status",
                new=AsyncMock(return_value={"connected": True, "email": "a@b.c"}),
            ),
            patch.object(thumbnail_repair.repo, "list_video_assets_with_input_thumbnail", return_value=rows),
            patch.object(thumbnail_repair.cli_bridge, "get_job_raw", new=AsyncMock(side_effect=raws)),
            patch.object(thumbnail_repair.repo, "set_asset_thumbnail_if_current", side_effect=[True]),
            patch.object(thumbnail_repair.manager, "broadcast_all", new=broadcast),
        ):
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(thumbnail_repair.repair_once())
        broadcast.assert_awaited_once_with({"type": "synced"})

    def test_account_scope_override_reaches_db_reads_and_cas_writes(self) -> None:
        """후보 조회 뒤 계정이 A→B 로 바뀌어도 이번 실행의 조회·쓰기는 캡처한 A 계정 DB 를 본다."""
        from app import active_account

        seen: list[str | None] = []

        def listing():
            seen.append(active_account.account_key())
            return [_candidate("job-1")]

        def cas(*_args):
            seen.append(active_account.account_key())
            return True

        with (
            patch.object(active_account.config, "AUTH_ENABLED", False),
            patch.object(active_account, "_read_pointer", return_value={"email": "b@other.com"}),  # 전환 뒤 포인터
            patch.object(thumbnail_repair, "AUTH_ENABLED", False),
            patch.object(thumbnail_repair, "LOCAL_AGENT_PAIR_SECRET", ""),
            patch.object(thumbnail_repair, "EXTERNAL_RECOVERY_ENABLED", True),
            patch.object(thumbnail_repair, "_capture_scope", return_value="a@b.c"),  # 실행 시작 때 캡처한 A
            patch.object(
                thumbnail_repair.cli_bridge,
                "get_account_status",
                new=AsyncMock(return_value={"connected": True, "email": "a@b.c"}),
            ),
            patch.object(thumbnail_repair.repo, "list_video_assets_with_input_thumbnail", side_effect=listing),
            patch.object(thumbnail_repair.cli_bridge, "get_job_raw", new=AsyncMock(return_value=_raw("job-1"))),
            patch.object(thumbnail_repair.repo, "set_asset_thumbnail_if_current", side_effect=cas),
            patch.object(thumbnail_repair.manager, "broadcast_all", new=AsyncMock()),
        ):
            counts = asyncio.run(thumbnail_repair.repair_once())
        self.assertEqual(counts["replaced"], 1)
        self.assertEqual(seen, ["a@b.c", "a@b.c"])  # 조회(to_thread)·쓰기(to_thread_non_abandon) 모두 A
        self.assertIsNone(active_account._override.get())  # override 해제

    def test_recovery_disabled_skips_and_pairing_allows_server_mode(self) -> None:
        with patch.object(thumbnail_repair, "EXTERNAL_RECOVERY_ENABLED", False):
            self.assertTrue(thumbnail_repair._forbidden())
        counts, get_raw, _, _, status, _ = self.run_repair([_candidate()], [_raw()], [True], auth=True, pair="pair-key")
        self.assertEqual(counts["replaced"], 1)  # AUTH on 이라도 pairing 키가 있으면 로컬 작업자 PC
        status.assert_awaited_once()

    def test_cli_timeout_is_capped_by_call_limit_and_remaining_budget(self) -> None:
        counts, get_raw, _, _, _, _ = self.run_repair([_candidate()], [_raw()], [True])
        timeout = get_raw.await_args.kwargs["timeout"]
        self.assertEqual(timeout, thumbnail_repair.REPAIR_CALL_TIMEOUT_SECONDS)
        counts, get_raw, _, _, _, _ = self.run_repair([_candidate()], [_raw()], [True], budget=5.0)
        self.assertLessEqual(get_raw.await_args.kwargs["timeout"], 5.0)

    def test_startup_wrapper_swallows_exceptions(self) -> None:
        with (
            patch.object(thumbnail_repair, "REPAIR_STARTUP_DELAY_SECONDS", 0),
            patch.object(thumbnail_repair, "repair_once", new=AsyncMock(side_effect=RuntimeError("boom"))),
        ):
            self.assertEqual(asyncio.run(thumbnail_repair.startup_thumbnail_repair()), {})

    def test_startup_wrapper_propagates_cancellation(self) -> None:
        async def scenario() -> bool:
            with patch.object(thumbnail_repair, "REPAIR_STARTUP_DELAY_SECONDS", 60):
                task = asyncio.create_task(thumbnail_repair.startup_thumbnail_repair())
                await asyncio.sleep(0)
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    return True
                return False

        self.assertTrue(asyncio.run(scenario()))


if __name__ == "__main__":
    unittest.main()
