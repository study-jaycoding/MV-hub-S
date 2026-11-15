"""패널 계약 — 가짜 Resolve와 임시 파일만 사용하고 실제 앱·공유 서버는 부르지 않는다."""
from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException
from pydantic import ValidationError
from starlette.requests import Request

from app import active_account
from app.routers import resolve_panel as route, resolve_integration as integration
from app.services import resolve_bridge as bridge, resolve_panel as panel, resolve_status_runner as runner
from app.services import resolve_transfer as transfer, resolve_panel_worker as worker
from tests.test_resolve_bridge import FakeClip, FakeMediaPool, FakeProject, FakeProjectManager, FakeResolve

REAL_AUTHORIZED_GENERATIONS = integration._authorized_generations


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.pool = FakeMediaPool()
        self.project = FakeProject(self.pool)
        self.manager = FakeProjectManager(self.project)
        self.resolve = FakeResolve(self.manager)
        self.payload = {"operation": "target", "project_id": "p", "project_name": "영화",
                        "folder_path": "S01/C010", "manifest_root": self.tmp.name, "create": True,
                        "gen_id": "g", "resolve_project_id": self.project.unique_id,
                        "path": str(Path(self.tmp.name) / "clip.mp4")}

    def run_panel(self, operation="target", **kwargs):
        payload = {**self.payload, "operation": operation, "hub_key": "hub", "account": "a", **kwargs}
        if operation == "adopt":
            # 과거 경로 인수 시험도 이제 허브가 보관한 항목 ID 증거를 명시한다.
            payload["records"] = [{"item_id": clip.unique_id, "bin_id": self.pool.current.unique_id,
                                   "account": "a", "hub_key": "hub", "resolve_project_id": self.payload["resolve_project_id"],
                                   "project_id": "p", "gen_id": "g", "local_path": clip.path, "nas_path": self.payload["path"]}
                                  for clip in self.pool.current.clips if self.pool.current is not self.pool.root]
        return bridge.panel_operation(payload, resolve=self.resolve)

    def placed(self):
        self.assertEqual(self.run_panel()["state"], "ok")
        clip = FakeClip(self.payload["path"])
        self.pool.current.clips.append(clip)
        return clip

    def test_target_missing_then_create_and_readback(self):
        self.assertEqual(self.run_panel(create=False)["state"], "missing")
        self.assertEqual(self.pool.root.children, [])
        result = self.run_panel()
        self.assertEqual(result["bin_path"], "MV Hub/영화/S01/C010")
        self.assertEqual(result["bin_id"], self.pool.current.unique_id)
        self.assertEqual(result["resolve_project_id"], self.project.unique_id)
        self.assertEqual(self.run_panel(create=False)["state"], "ok")

    def test_target_rejects_false_readback(self):
        self.pool.SetCurrentFolder = Mock(return_value=True)
        self.assertEqual(self.run_panel()["state"], "unavailable")

    def test_current_bin_is_read_only(self):
        self.placed()
        with patch.object(self.pool, "SetCurrentFolder", side_effect=AssertionError), patch.object(self.manager, "SaveProject", side_effect=AssertionError):
            result = self.run_panel("current-bin")
        self.assertEqual(result["state"], "ok")
        self.assertEqual(result["bin_id"], self.pool.current.unique_id)

    def test_adopt_all_duplicates_and_already_stamped_still_save(self):
        first = self.placed()
        second = FakeClip(self.payload["path"])
        self.pool.current.clips.append(second)
        for count in (1, 2):
            self.assertEqual(self.run_panel("adopt")["state"], "in_bin")
            self.assertEqual(self.manager.saved, count)
        for clip in (first, second):
            self.assertEqual(bridge.parse_mvhub_clip_metadata(clip.GetThirdPartyMetadata(bridge.MVHUB_METADATA_KEY))["generation_id"], "g")
        self.assertEqual(self.pool.import_calls, [])

    def test_conflict_scans_all_before_any_write(self):
        first = self.placed()
        second = FakeClip(self.payload["path"])
        bridge.stamp_and_verify(second, "other", "p")
        self.pool.current.clips.append(second)
        self.assertEqual(self.run_panel("adopt")["state"], "conflict")
        self.assertEqual(first.third_party_metadata, {})
        self.assertEqual(self.manager.saved, 0)

    def test_elsewhere_not_seen_and_project_changed(self):
        self.assertEqual(self.run_panel("adopt")["state"], "not_seen")
        clip = FakeClip(self.payload["path"])
        self.pool.root.clips.append(clip)
        self.assertEqual(self.run_panel("adopt")["state"], "not_seen")
        self.assertEqual(self.run_panel("adopt", resolve_project_id="other")["state"], "project_changed")
        self.assertEqual(clip.third_party_metadata, {})
        self.assertEqual(self.manager.saved, 0)

    def test_stamp_failed_does_not_save(self):
        clip = self.placed()
        clip.SetThirdPartyMetadata = Mock(return_value=True)
        self.assertEqual(self.run_panel("adopt")["state"], "stamp_failed")
        self.assertEqual(self.manager.saved, 0)

    def test_save_failure_retry(self):
        self.placed()
        self.manager.save_result = False
        self.assertEqual(self.run_panel("adopt")["state"], "save_failed")
        self.manager.save_result = True
        self.assertEqual(self.run_panel("adopt")["state"], "in_bin")
        self.assertEqual(self.manager.saved, 2)

    def test_project_guard_before_each_write(self):
        clip = self.placed()
        original = clip.SetThirdPartyMetadata

        def change(*args):
            result = original(*args)
            self.project.unique_id = "changed"
            return result

        clip.SetThirdPartyMetadata = change
        self.assertEqual(self.run_panel("adopt")["state"], "project_changed")
        self.assertEqual(self.manager.saved, 0)

    def test_guard_during_target_creation(self):
        original = self.pool.AddSubFolder

        def change(*args):
            folder = original(*args)
            self.project.unique_id = "changed"
            return folder

        self.pool.AddSubFolder = Mock(side_effect=change)
        self.pool.SetCurrentFolder = Mock()
        self.assertEqual(self.run_panel()["code"], "project_changed")
        self.assertEqual(self.pool.AddSubFolder.call_count, 1)
        self.pool.SetCurrentFolder.assert_not_called()

    def test_unreadable_recovery_blocks_target_and_adopt_with_zero_writes(self):
        folder = bridge._recovery_folder(self.payload)
        folder.mkdir(parents=True)
        path = bridge._recovery_record_path(folder, self.project.unique_id, bridge._path_identity(("MV Hub", "영화")))
        path.write_text("{broken", encoding="utf-8")
        with patch.object(self.pool, "AddSubFolder", side_effect=AssertionError), patch.object(self.pool, "SetCurrentFolder", side_effect=AssertionError), patch.object(self.manager, "SaveProject", side_effect=AssertionError):
            for operation in ("target", "adopt"):
                result = self.run_panel(operation)
                self.assertEqual(result["state"], "rebuild_recovery_pending")
                self.assertIn("복구", result["details"])
        self.assertEqual(list(folder.iterdir()), [path])

    def test_unfinished_recovery_blocks_first_write(self):
        folder = bridge._recovery_folder(self.payload)
        folder.mkdir(parents=True)
        path = bridge._recovery_record_path(folder, self.project.unique_id, bridge._path_identity(("MV Hub", "영화")))
        path.write_text("{}", encoding="utf-8")
        record = {"backup": "backup.drp", "staging": "unfinished"}
        with patch.object(bridge, "_check_recovery_record", return_value=record):
            for operation in ("target", "adopt"):
                self.assertEqual(self.run_panel(operation)["state"], "rebuild_recovery_pending")
        self.assertEqual(self.pool.root.children, [])
        self.assertEqual(self.manager.saved, 0)

    def test_missing_recovery_root_is_not_bypassed(self):
        self.assertEqual(self.run_panel(manifest_root="")["state"], "rebuild_recovery_pending")
        self.assertEqual(self.pool.root.children, [])

    def test_stamp_dict_first_legacy_fallback_and_readback(self):
        clip = FakeClip("clip.mp4")
        original = clip.SetThirdPartyMetadata
        clip.SetThirdPartyMetadata = Mock(wraps=original)
        self.assertEqual(bridge.stamp_and_verify(clip, "g", "p"), "written")
        self.assertIsInstance(clip.SetThirdPartyMetadata.call_args.args[0], dict)
        self.assertEqual(bridge.stamp_and_verify(clip, "g", "p"), "already")
        self.assertEqual(clip.SetThirdPartyMetadata.call_count, 1)
        clip.third_party_metadata.clear()

        def legacy(key, value):
            return original(key, value)

        clip.SetThirdPartyMetadata = legacy
        self.assertEqual(bridge.stamp_and_verify(clip, "g", "p"), "written")
        clip.third_party_metadata.clear()
        clip.SetThirdPartyMetadata = lambda *args: True
        self.assertEqual(bridge.stamp_and_verify(clip, "g", "p"), "failed")


class RouteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.media = self.root / "media"
        self.media.mkdir()
        (self.media / "clip.mp4").write_bytes(b"video")
        self.render = self.root / "render"
        self.manifests = self.root / "@davinci"
        self.gen = {"id": "g", "project_id": "p", "project_name": "영화", "folder_path": "S01/C010",
                    "creator_name": "작업자", "status": "done", "assets": [{"type": "video", "file_path": "/media/clip.mp4"}]}
        self.request = Request({"type": "http", "headers": [], "client": ("127.0.0.1", 1234)})
        panel._prepared.clear()
        panel._inflight.clear()
        panel._sequences.clear()
        panel._prepare_lock = asyncio.Lock()
        panel._CACHE_SLOTS = asyncio.Semaphore(panel._CACHE_PARALLEL)  # 시험마다 새 이벤트 루프 — 잠금처럼 새로
        panel._source_locks.clear()
        panel.write_lock = asyncio.Lock()
        self.pool = FakeMediaPool()
        self.project = FakeProject(self.pool)
        self.manager = FakeProjectManager(self.project)
        self.resolve = FakeResolve(self.manager)
        self.patches = [
            patch.object(integration, "_require_local_resolve"),
            patch.object(integration, "_reject_if_update_in_progress"),
            patch.object(integration, "_reject_while_launching"),
            patch.object(integration, "_authorized_generations", AsyncMock(return_value=("p", [self.gen]))),
            patch.object(route._proxy, "proxying", return_value=False),
            patch.object(route._proxy, "proxy_json", return_value={"projects": [{"id": "p"}]}),
            patch.object(route.repo, "get_project", return_value={"name": "영화"}),
            patch.object(transfer, "MEDIA_DIR", self.media),
            patch.object(panel.config, "MEDIA_DIR", self.media),
            patch.object(panel.config, "DATA_DIR", self.root / "data"),
            patch.object(transfer, "resolve_transfer_roots", return_value=(self.render, self.manifests)),
            patch.object(panel, "device_identity", return_value={"device_id": "pc-1", "device_name": "test"}),
            patch.object(runner, "run_resolve_panel_isolated", side_effect=self.child),
            patch.object(bridge, "_connect_resolve", side_effect=AssertionError("실제 Resolve 금지")),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        self.ctx = panel.identity()
        panel._owner.update(window="test-window", context=panel.context_key(self.ctx), generation=1,
                            seen=__import__("time").monotonic(), bin_id="")
        panel._cut_bins.clear()
        panel._episode_bins.clear()
        panel._episode_roots.clear()

    def child(self, payload, before_start=None):
        rejected = before_start() if before_start else None
        return rejected or bridge.panel_operation(payload, resolve=self.resolve)

    def body(self, cls, **kwargs):
        kwargs.setdefault("window", "test-window")
        return cls(ctx=self.ctx, project_id="p", folder_path="S01/C010", **kwargs)

    async def prepare(self):
        return await route.post_prepare(self.body(route.PrepareIn, gen_id="g"), self.request)

    async def target(self, seq=1, create=True):
        return await route.post_target(self.body(route.TargetIn, seq=seq, create=create), self.request)

    async def adopt(self):
        return await route.post_adopt(self.body(route.AdoptIn, gen_id="g", resolve_project_id=self.project.unique_id), self.request)

    async def place(self):
        ready = await self.prepare()
        self.assertEqual(ready["state"], "prepared")
        self.assertEqual((await self.target())["state"], "ok")
        clip = FakeClip(str(self.media / "clip.mp4"))
        self.pool.current.clips.append(clip)
        bridge._panel_stamp(clip, "g", "p", lambda: None, hub_key=panel.hub_key())
        return ready

    async def deferred_pair(self):
        await self.place()
        other = {**self.gen, "id": "h"}
        integration._authorized_generations.side_effect = lambda ids, request, **kwargs: (
            "p", [self.gen if ident == "g" else other for ident in ids])
        await route.post_prepare(self.body(route.PrepareIn, gen_id="h"), self.request)
        clip = FakeClip(str(self.media / "clip.mp4"))
        self.pool.current.clips.append(clip)
        bridge._panel_stamp(clip, "h", "p", lambda: None, hub_key=panel.hub_key())
        return clip

    async def deferred_adopt(self, gen_id):
        return await route.post_adopt(self.body(route.AdoptIn, gen_id=gen_id,
            resolve_project_id=self.project.unique_id, defer_save=True), self.request)

    async def final_save(self):
        return await route.post_save(self.body(route.SaveIn, expect_project=self.project.unique_id), self.request)

    async def test_deferred_adopt_partial_failure_never_saves_or_commits_recovery(self):
        second = await self.deferred_pair()
        with patch.object(panel, "record_adoption", wraps=panel.record_adoption) as ledger:
            self.assertEqual((await self.deferred_adopt("g"))["state"], "in_bin")
            second.ReplaceClip = Mock(return_value=False)
            self.assertEqual((await self.deferred_adopt("h"))["state"], "replace_failed")
            self.assertEqual(self.manager.saved, 0)
            self.assertEqual(len(panel.records("adopt", self.ctx)), 2)
            ledger.assert_not_called()
            # 재시작 후 자동 복구도 저장 유예를 이어받는다.
            panel._prepared.clear()
            self.assertEqual((await self.adopt())["state"], "in_bin")
            self.assertEqual(self.manager.saved, 0)
            ledger.assert_not_called()

    async def test_deferred_adopt_success_commits_only_after_final_save(self):
        await self.deferred_pair()
        for ident in ("g", "h"):
            self.assertEqual((await self.deferred_adopt(ident))["state"], "in_bin")
        self.assertEqual(self.manager.saved, 0)
        self.assertEqual(len(panel.records("adopt", self.ctx)), 2)
        with patch.object(panel, "record_adoption", wraps=panel.record_adoption) as ledger:
            self.manager.save_result = False
            self.assertEqual((await self.final_save())["state"], "save_failed")
            ledger.assert_not_called()
            self.assertEqual(len(panel.records("adopt", self.ctx)), 2)
            self.manager.saved = 0
            self.manager.save_result = True
            self.assertEqual((await self.final_save())["state"], "ok")
            self.assertEqual(self.manager.saved, 1)
            self.assertEqual(ledger.call_count, 2)
            self.assertEqual(panel.records("adopt", self.ctx), [])

    async def test_inventory_batches_projects_and_generations_and_filters_permissions(self):
        rows = [{"project_id": pid, "gen_id": ident, "item_id": ident} for pid, ident in
                (("p", "g"), ("p", "h"), ("hidden", "secret"), ("p", "g"))]
        async def batch(ids, request, **kwargs):
            return "p", [{**self.gen, "id": ident} for ident in ids if ident == "g"]
        with patch.object(route, "_inventory", AsyncMock(return_value={"state": "ok", "items": rows,
                "project_counts": {"p": {"other_owner": 2, "needs_attention": 1}, "hidden": {"other_owner": 9, "needs_attention": 9}}})), \
                patch.object(route._proxy, "proxying", return_value=True), \
                patch.object(integration, "_authorized_generations", AsyncMock(side_effect=batch)) as generations:
            result = await route._operate("inventory", {}, self.request, self.ctx)
        self.assertEqual([row["gen_id"] for row in result["items"]], ["g", "g"])
        self.assertEqual(result["other_owner"], 2)
        route._proxy.proxy_json.assert_called_once_with("GET", "/api/projects?tab=team")
        generations.assert_awaited_once_with(["g", "h"], self.request, visible_only=True)

    async def test_inventory_remote_failure_is_not_retried_for_each_row(self):
        rows = [{"project_id": "p", "gen_id": str(i)} for i in range(501)]
        with patch.object(route, "_inventory", AsyncMock(return_value={"state": "ok", "items": rows})), \
                patch.object(integration, "_authorized_generations", AsyncMock(side_effect=HTTPException(502, "offline"))) as generations:
            with self.assertRaises(HTTPException):
                await route._operate("inventory", {}, self.request, self.ctx)
        self.assertEqual(generations.await_count, 1)

    async def test_release_disabled_blocks_panel_identity_and_operations(self):
        installer = integration.resolve_panel_installer
        with patch.object(installer.release_update, "install_mode", return_value="release"), \
                patch.object(panel, "window_identity", AsyncMock()) as identity:
            for invoke in (lambda: route.get_identity(self.request), self.target,
                           lambda: route.get_inventory(self.request, self.ctx["instance"], self.ctx["account"], self.ctx["epoch"])):
                with self.assertRaises(HTTPException) as error:
                    await invoke()
                self.assertEqual(error.exception.status_code, 403)
            identity.assert_not_called()
            runner.run_resolve_panel_isolated.assert_not_called()

    async def test_inventory_visible_batch_keeps_allowed_rows_and_never_fetches_hidden_local(self):
        # 기존 전송 함수의 실제 구현으로 inventory 전용 필터를 검증한다.
        hidden = {**self.gen, "id": "hidden"}
        with patch.object(integration.repo, "get_generations_batch", return_value={"g": self.gen, "hidden": hidden}), \
                patch.object(integration, "batch_view_member_projects", return_value=set()), \
                patch.object(integration, "can_view_generation_with_member_projects", side_effect=lambda req, gen, members: gen["id"] != "hidden"), \
                patch.object(route._proxy, "proxying", return_value=True), \
                patch.object(route._proxy, "proxy_json", return_value={"items": {"remote": {**self.gen, "id": "remote"}}}) as remote:
            _, gens = await REAL_AUTHORIZED_GENERATIONS(["g", "hidden", "remote", "missing"], self.request, visible_only=True)
        self.assertEqual([gen["id"] for gen in gens], ["g", "remote"])
        remote.assert_called_once_with("POST", "/api/generations/batch", body={"gen_ids": ["remote", "missing"]})

    async def test_inventory_chunks_at_500_and_project_list_failure_stops_immediately(self):
        rows = [{"project_id": "p", "gen_id": str(i)} for i in range(501)]
        with patch.object(route, "_inventory", AsyncMock(return_value={"state": "ok", "items": rows})), \
                patch.object(route._proxy, "proxying", return_value=True):
            await route._operate("inventory", {}, self.request, self.ctx)
            self.assertEqual([len(call.args[0]) for call in integration._authorized_generations.await_args_list], [500, 1])
            route._proxy.proxy_json.assert_called_once()
            integration._authorized_generations.reset_mock()
            route._proxy.proxy_json.reset_mock()
            route._proxy.proxy_json.side_effect = HTTPException(502, "offline")
            with self.assertRaises(HTTPException):
                await route._operate("inventory", {}, self.request, self.ctx)
            route._proxy.proxy_json.assert_called_once()
            integration._authorized_generations.assert_not_awaited()

    async def test_deferred_save_ledger_failure_keeps_recovery_for_retry(self):
        await self.place()
        await self.deferred_adopt("g")
        with patch.object(transfer, "save_manifest", side_effect=OSError("ledger offline")):
            result = await self.final_save()
            self.assertEqual(result["state"], "ledger_failed")
            self.assertTrue(result["project_saved"])
        self.assertEqual(self.manager.saved, 1)
        self.assertEqual(len(panel.records("adopt", self.ctx)), 1)
        panel._prepared.clear()
        self.assertEqual((await self.final_save())["state"], "ok")
        self.assertEqual(panel.records("adopt", self.ctx), [])

    async def test_save_without_recovery_does_not_require_unrelated_clip_identity(self):
        clip = FakeClip(str(self.render / "unrelated.mp4"))
        clip.GetUniqueId = Mock(side_effect=RuntimeError("no identity"))
        self.pool.root.clips.append(clip)
        self.assertEqual((await self.final_save())["state"], "ok")
        clip.GetUniqueId.assert_not_called()

    async def test_review_save_ledger_failure_keeps_q_and_commits_later_p(self):
        await self.place()
        await self.deferred_adopt("g")
        record = panel.records("adopt", self.ctx)[0]
        other = FakeClip(record["nas_path"])
        bridge._panel_stamp(other, "q-gen", "q", lambda: None)
        self.pool.current.clips.append(other)
        panel.save_record("adopt", {**record, "item_id": other.unique_id, "project_id": "q", "gen_id": "q-gen"})
        records, save_manifest = panel.records, transfer.save_manifest
        async def write_manifest(manifest):
            if manifest["project_id"] == "q":
                raise PermissionError("Q ledger denied")
            return await save_manifest(manifest)
        with patch.object(panel, "records", side_effect=lambda *args, **kwargs:
                sorted(records(*args, **kwargs), key=lambda row: row["project_id"] != "q")), \
                patch.object(transfer, "save_manifest", side_effect=write_manifest) as ledger:
            result = await self.final_save()
        self.assertEqual(result["state"], "ledger_failed")
        self.assertTrue(result["project_saved"])
        self.assertEqual(result["details"], "Q ledger denied")
        self.assertEqual(self.manager.saved, 1)
        self.assertEqual([call.args[0]["project_id"] for call in ledger.call_args_list], ["q", "p"])
        self.assertEqual([row["project_id"] for row in panel.records("adopt", self.ctx)], ["q"])
        self.assertEqual((await self.final_save())["state"], "ok")
        self.assertEqual(panel.records("adopt", self.ctx), [])

    async def test_review_save_cleanup_failure_keeps_only_failed_record_and_continues(self):
        await self.deferred_pair()
        for ident in ("g", "h"):
            await self.deferred_adopt(ident)
        record = panel.records("adopt", self.ctx)[0]
        panel.save_record("adopt", {**record, "item_id": "missing", "gen_id": "z"})
        records, remove_records = panel.records, panel.remove_records
        def remove(kind, rows):
            if rows[0]["gen_id"] == "g":
                raise PermissionError("recovery cleanup denied")
            return remove_records(kind, rows)
        with patch.object(panel, "records", side_effect=lambda *args, **kwargs:
                sorted(records(*args, **kwargs), key=lambda row: row["gen_id"])), \
                patch.object(panel, "remove_records", side_effect=remove):
            result = await self.final_save()
        self.assertEqual(result["state"], "cleanup_failed")
        self.assertTrue(result["cleanup_failed"])
        self.assertTrue(result["project_saved"])
        self.assertEqual(result["details"], "recovery cleanup denied")
        self.assertEqual(self.manager.saved, 1)
        self.assertEqual([row["gen_id"] for row in panel.records("adopt", self.ctx)], ["g"])
        self.assertEqual((await self.final_save())["state"], "ok")
        self.assertEqual(panel.records("adopt", self.ctx), [])

    async def test_review_adopt_missing_cleanup_failure_continues_with_and_without_replacement(self):
        for replacement in (False, True):
            with self.subTest(replacement=replacement):
                await self.place()
                await self.deferred_adopt("g")
                old = panel.records("adopt", self.ctx)[0]
                panel.save_record("adopt", {**old, "item_id": "missing-extra"})
                self.pool.current.clips.clear()
                if replacement:
                    clip = FakeClip(str(self.media / "clip.mp4"))
                    bridge._panel_stamp(clip, "g", "p", lambda: None, hub_key=panel.hub_key())
                    self.pool.current.clips.append(clip)
                remove_records = panel.remove_records
                def remove(kind, rows):
                    if any(row["item_id"] == old["item_id"] for row in rows):
                        raise PermissionError("old recovery locked")
                    return remove_records(kind, rows)
                # 새 클립은 사전 inventory 뒤 브리지가 발견하는 경로도 거친다.
                with patch.object(route, "_inventory", AsyncMock(return_value={"state": "ok",
                        "resolve_project_id": self.project.unique_id, "items": []})), \
                        patch.object(panel, "remove_records", side_effect=remove):
                    saved_before = self.manager.saved
                    result = await self.deferred_adopt("g")
                    self.assertEqual(result["state"], "in_bin" if replacement else "not_seen")
                    self.assertTrue(result["cleanup_failed"])
                    self.assertEqual(set(result["missing_record_ids"]), {old["item_id"], "missing-extra"})
                    self.assertEqual(self.manager.saved, saved_before)
                    remaining = {row["item_id"] for row in panel.records("adopt", self.ctx)}
                    self.assertEqual(remaining, {old["item_id"], clip.unique_id} if replacement else {old["item_id"]})
                    self.assertEqual((await self.final_save())["state"], "cleanup_failed")
                self.assertEqual((await self.final_save())["state"], "ok")
                self.assertEqual(panel.records("adopt", self.ctx), [])
                self.pool.current.clips.clear()

    async def test_review_save_mixed_ledger_and_cleanup_failures_are_both_reported(self):
        await self.deferred_pair()
        for ident in ("g", "h"):
            await self.deferred_adopt(ident)
        records, save_manifest = panel.records, transfer.save_manifest
        async def write_manifest(manifest):
            if manifest["resolve_import"]["items"][0]["generation_id"] == "g":
                raise PermissionError("ledger denied")
            return await save_manifest(manifest)
        with patch.object(panel, "records", side_effect=lambda *args, **kwargs:
                sorted(records(*args, **kwargs), key=lambda row: row["gen_id"], reverse=True)), \
                patch.object(transfer, "save_manifest", side_effect=write_manifest), \
                patch.object(panel, "remove_records", side_effect=PermissionError("cleanup denied")):
            result = await self.final_save()
        self.assertEqual(result["state"], "ledger_failed")
        self.assertTrue(result["project_saved"])
        self.assertTrue(result["cleanup_failed"])
        self.assertEqual(len(panel.records("adopt", self.ctx)), 2)

    async def test_review_single_adopt_cleanup_failure_preserves_success_and_retry(self):
        await self.place()
        def remove(kind, rows):
            if rows:
                raise PermissionError("cleanup denied")
        with patch.object(panel, "remove_records", side_effect=remove):
            result = await self.adopt()
        self.assertEqual(result["state"], "in_bin")
        self.assertTrue(result["cleanup_failed"])
        self.assertEqual(self.manager.saved, 1)
        self.assertEqual(len(panel.records("adopt", self.ctx)), 1)
        self.assertEqual((await self.final_save())["state"], "ok")
        self.assertEqual(panel.records("adopt", self.ctx), [])

    async def test_review_import_cleanup_failure_preserves_stage_and_other_cleanup(self):
        await self.place()
        record = {"account": self.ctx["account"], "hub_key": panel.hub_key(),
                  "resolve_project_id": self.project.unique_id, "project_id": "p", "gen_id": "g",
                  "item_id": self.pool.current.clips[0].unique_id, "local_path": str(self.media / "clip.mp4")}
        panel.save_record("import", record)
        panel.save_record("import", {**record, "item_id": "other-old-import"})
        remove_records = panel.remove_records
        def remove(kind, rows):
            if any(row["item_id"] == record["item_id"] for row in rows):
                raise PermissionError("import cleanup denied")
            return remove_records(kind, rows)
        with patch.object(panel, "remove_records", side_effect=remove):
            result = await route.post_stage(self.body(route.StageIn, seq=1, gen_ids=["g"]), self.request)
        self.assertEqual(result["state"], "ok")
        self.assertTrue(result["cleanup_failed"])
        self.assertEqual(result["items"][0]["state"], "present")
        self.assertEqual([row["item_id"] for row in panel.records("import", self.ctx)], [record["item_id"]])

    async def test_review_cleanup_propagates_account_change_and_cancellation(self):
        await self.place()
        await self.deferred_adopt("g")
        self.pool.current.clips.clear()
        for error in (panel.AccountChanged("changed"), asyncio.CancelledError()):
            with self.subTest(error=type(error).__name__), patch.object(panel, "remove_records", side_effect=error):
                with self.assertRaises(type(error)):
                    await route._operate("adopt", self.body(route.AdoptIn, gen_id="g",
                        resolve_project_id=self.project.unique_id, defer_save=True), self.request, self.ctx)
                self.assertEqual(len(panel.records("adopt", self.ctx)), 1)
                self.assertEqual(self.manager.saved, 0)

    async def test_review_deleted_failed_clip_reaches_save_through_inventory_and_adopt(self):
        second = await self.deferred_pair()
        self.assertEqual((await self.deferred_adopt("g"))["state"], "in_bin")
        second.ReplaceClip = Mock(return_value=False)
        self.assertEqual((await self.deferred_adopt("h"))["state"], "replace_failed")
        self.pool.current.clips.remove(second)
        inventory = await route.get_inventory(self.request, self.ctx["instance"], self.ctx["account"], self.ctx["epoch"])
        self.assertEqual({row["gen_id"] for row in inventory["items"]}, {"g", "h"})
        for row in inventory["items"]:
            result = await route.post_adopt(self.body(route.AdoptIn, gen_id=row["gen_id"],
                resolve_project_id=self.project.unique_id, bin_id=row["bin_id"], item_ids=[row["item_id"]], defer_save=True), self.request)
            # 화면도 명시적으로 부재가 확인된 항목만 건너뛰고 최종 save로 진행한다.
            self.assertTrue(result["state"] == "in_bin" or
                (result["state"] == "not_seen" and row["item_id"] in result.get("missing_record_ids", [])))
        self.assertEqual([row["gen_id"] for row in panel.records("adopt", self.ctx)], ["g"])
        self.assertEqual(self.manager.saved, 0)
        self.assertEqual((await self.final_save())["state"], "ok")
        self.assertEqual(self.manager.saved, 1)
        self.assertEqual(panel.records("adopt", self.ctx), [])

    async def test_review_empty_inventory_does_not_request_offline_project_list(self):
        with patch.object(route._proxy, "proxying", return_value=True), \
                patch.object(route._proxy, "proxy_json", side_effect=HTTPException(502, "offline")) as remote:
            result = await route._operate("inventory", {}, self.request, self.ctx)
        self.assertEqual(result["state"], "ok")
        self.assertEqual(result["items"], [])
        remote.assert_not_called()

    async def test_review_unmarked_unreadable_id_allows_save_but_keeps_unproven_missing_record(self):
        await self.place()
        await self.deferred_adopt("g")
        record = panel.records("adopt", self.ctx)[0]
        panel.save_record("adopt", {**record, "item_id": "unproven"})
        clip = FakeClip(str(self.render / "unrelated.mp4"))
        clip.GetUniqueId = Mock(side_effect=RuntimeError("no identity"))
        self.pool.root.clips.append(clip)
        self.assertEqual((await self.final_save())["state"], "ok")
        self.assertEqual(self.manager.saved, 1)
        self.assertEqual([row["item_id"] for row in panel.records("adopt", self.ctx)], ["unproven"])

    async def test_review_unmarked_unreadable_id_does_not_bypass_local_path_check(self):
        await self.place()
        await self.deferred_adopt("g")
        clip = FakeClip(str(self.media / "clip.mp4"))
        clip.GetUniqueId = Mock(side_effect=RuntimeError("no identity"))
        self.pool.root.clips.append(clip)
        self.assertEqual((await self.final_save())["state"], "not_clean")
        self.assertEqual(self.manager.saved, 0)
        self.assertEqual(len(panel.records("adopt", self.ctx)), 1)

    async def test_review_save_commits_all_authorized_mv_projects_once_checked(self):
        await self.place()
        await self.deferred_adopt("g")
        record = panel.records("adopt", self.ctx)[0]
        for project_id, gen_id in (("q", "q1"), ("q", "q2"), ("r", "r1"), ("r", "r2")):
            other = FakeClip(record["nas_path"])
            bridge._panel_stamp(other, gen_id, project_id, lambda: None)
            self.pool.current.clips.append(other)
            ready = {**record["ready"], "item": {**record["ready"]["item"], "generation_id": gen_id}}
            panel.save_record("adopt", {**record, "item_id": other.unique_id,
                "project_id": project_id, "gen_id": gen_id, "ready": ready})
        def permission(request, project_id):
            if project_id == "r":
                raise HTTPException(403, "denied")
        with patch.object(route.projects, "_require_project_read", side_effect=permission) as permission_check, \
                patch.object(panel, "record_adoption", wraps=panel.record_adoption) as ledger:
            self.assertEqual((await self.final_save())["state"], "ok")
        self.assertEqual(self.manager.saved, 1)
        self.assertCountEqual([call.args[1] for call in permission_check.call_args_list], ["p", "q", "r"])
        self.assertCountEqual([call.args[1:3] for call in ledger.call_args_list], [("p", "g"), ("q", "q1"), ("q", "q2")])
        self.assertEqual([row["project_id"] for row in panel.records("adopt", self.ctx)], ["r", "r"])

    async def test_review_save_other_project_permission_error_preserves_records_without_saving(self):
        await self.place()
        await self.deferred_adopt("g")
        record = panel.records("adopt", self.ctx)[0]
        panel.save_record("adopt", {**record, "item_id": "q-item", "project_id": "q"})
        def permission(request, project_id):
            if project_id == "q":
                raise HTTPException(502, "offline")
        with patch.object(route.projects, "_require_project_read", side_effect=permission), \
                patch.object(panel, "record_adoption", wraps=panel.record_adoption) as ledger:
            with self.assertRaises(HTTPException) as error:
                await self.final_save()
            self.assertEqual(error.exception.status_code, 502)
            ledger.assert_not_called()
        self.assertEqual(self.manager.saved, 0)
        self.assertEqual(len(panel.records("adopt", self.ctx)), 2)

    async def test_review_conflict_preserves_clip_and_relink_allows_save(self):
        await self.place()
        await self.deferred_adopt("g")
        record = panel.records("adopt", self.ctx)[0]
        clip = self.pool.current.clips[0]
        clip.path = str(self.render / "someone-else.mp4")
        self.assertEqual((await self.deferred_adopt("g"))["state"], "conflict")
        self.assertEqual(clip.path, str(self.render / "someone-else.mp4"))
        self.assertEqual(self.manager.saved, 0)
        self.assertEqual(len(panel.records("adopt", self.ctx)), 1)
        clip.path = record["local_path"]  # 안내에 따라 사용자가 원래 파일로 다시 연결
        self.assertEqual((await self.deferred_adopt("g"))["state"], "in_bin")
        self.assertEqual((await self.final_save())["state"], "ok")
        self.assertEqual(panel.records("adopt", self.ctx), [])

    def test_cached_preview_only_exposes_real_media_files_with_encoded_urls(self):
        video = self.media / "한 글#%.mp4"
        video.write_bytes(b"video")
        self.assertEqual(panel._cached_item("g", video)["preview_url"], "/media/%ED%95%9C%20%EA%B8%80%23%25.mp4")
        outside = self.root / "outside.mp4"
        outside.write_bytes(b"outside")
        for path in (outside, self.media / ".." / "outside.mp4", self.media, self.media / "missing.mp4"):
            with self.subTest(path=str(path)):
                self.assertNotIn("preview_url", panel._cached_item("g", path))

    async def test_cache_local_only_and_prepare_without_manifest_catalog(self):
        result = await route.post_cache(self.body(route.CacheIn, seq=1, gen_ids=["g"]), self.request)
        self.assertEqual(result["items"], [{"gen_id": "g", "state": "cached", "preview_url": "/media/clip.mp4"}])
        transfer.resolve_transfer_roots.assert_not_called()
        self.assertFalse(self.render.exists())
        ready = await self.prepare()
        self.assertTrue(Path(ready["path"]).is_file())
        self.assertFalse(self.manifests.exists())
        again = await self.prepare()
        self.assertEqual(again["path"], ready["path"])
        self.assertEqual(panel.prepared(self.ctx, "p", "S01/C010", "g")["item"]["status"], "skipped")

    async def test_adopt_ledger_failure_then_same_transfer_id_recovers(self):
        await self.place()
        ids = []

        async def fail(manifest):
            ids.append(manifest["transfer_id"])
            raise OSError("injected ledger failure")

        with patch.object(transfer, "save_manifest", side_effect=fail):
            self.assertEqual((await self.adopt())["state"], "ledger_failed")
        result = await self.adopt()
        self.assertEqual(result["state"], "in_bin")
        self.assertEqual(result["transfer_id"], ids[0])
        result2 = await self.adopt()
        self.assertEqual(result2["state"], "not_seen")
        files = list(self.manifests.rglob("*.json"))
        self.assertEqual(len(files), 1)
        manifest = json.loads(files[0].read_text(encoding="utf-8"))
        self.assertEqual(manifest["origin"], "panel")
        self.assertEqual(manifest["device_id"], "pc-1")
        self.assertEqual(manifest["resolve_import"]["status"], "complete")
        self.assertEqual(len(manifest["items"]), 1)
        self.assertEqual(self.manager.saved, 2)

    async def test_not_prepared_does_not_call_resolve(self):
        self.assertEqual((await self.adopt())["state"], "not_prepared")
        runner.run_resolve_panel_isolated.assert_not_called()

    async def test_save_failure_and_conflict_never_write_ledger(self):
        await self.place()
        self.manager.save_result = False
        with patch.object(transfer, "save_manifest", AsyncMock()) as save:
            self.assertEqual((await self.adopt())["state"], "save_failed")
            bridge.stamp_and_verify(self.pool.current.clips[0], "other", "p")
            self.assertEqual((await self.adopt())["state"], "conflict")
            save.assert_not_called()

    async def test_authorization_and_folder_mismatch(self):
        for operation in ("cache", "prepare"):
            body = self.body(route.CacheIn, seq=1, gen_ids=["g"]) if operation == "cache" else self.body(route.PrepareIn, gen_id="g")
            handler = route.post_cache if operation == "cache" else route.post_prepare
            with patch.object(integration, "_authorized_generations", AsyncMock(side_effect=HTTPException(404, "hidden"))):
                with self.assertRaises(HTTPException) as raised:
                    await handler(body, self.request)
                self.assertEqual(raised.exception.status_code, 404)
            body.folder_path = "other"
            with self.assertRaises(HTTPException) as raised:
                await handler(body, self.request)
            self.assertEqual(raised.exception.status_code, 400)
        transfer.resolve_transfer_roots.assert_not_called()

    async def test_old_instance_and_epoch_rejected_before_permission_lookup(self):
        for field, value in (("instance", "previous-hub"), ("epoch", self.ctx["epoch"] + 1), ("account", "other")):
            with self.subTest(field=field):
                body = self.body(route.PrepareIn, gen_id="g")
                setattr(body.ctx, field, value)
                self.assertEqual((await route.post_prepare(body, self.request))["state"], "account_changed")
        integration._authorized_generations.assert_not_called()

    async def test_context_changed_during_pin_capture(self):
        original = active_account.capture_account_pin

        def change():
            pin = original()
            panel.INSTANCE = "new-hub"
            return pin

        with patch.object(panel, "INSTANCE", panel.INSTANCE), patch.object(active_account, "capture_account_pin", side_effect=change):
            self.assertEqual((await self.prepare())["state"], "account_changed")
        transfer.resolve_transfer_roots.assert_not_called()

    async def test_context_changed_after_lock_wait(self):
        await panel._prepare_lock.acquire()
        task = asyncio.create_task(self.prepare())
        await asyncio.sleep(0.03)
        with patch.object(panel, "INSTANCE", "new-hub"):
            panel._prepare_lock.release()
            self.assertEqual((await task)["state"], "account_changed")
        transfer.resolve_transfer_roots.assert_not_called()

    async def test_context_changed_before_response(self):
        async def change(*args, **kwargs):
            panel.INSTANCE = "new-hub"
            return {"state": "prepared"}

        with patch.object(panel, "INSTANCE", panel.INSTANCE), patch.object(panel, "prepare", side_effect=change):
            self.assertEqual((await self.prepare())["state"], "account_changed")

    async def test_update_gate_after_activity_count(self):
        def reject():
            self.assertGreater(transfer.active_transfer_count(), 0)
            raise HTTPException(409, "updating")

        with patch.object(integration, "_reject_if_update_in_progress", side_effect=reject):
            with self.assertRaises(HTTPException):
                await self.prepare()
        self.assertEqual(transfer.active_transfer_count(), 0)
        integration._authorized_generations.assert_not_called()

    async def test_stale_target_no_resolve_call(self):
        self.assertEqual((await self.target(seq=5))["state"], "ok")
        runner.run_resolve_panel_isolated.reset_mock()
        self.assertEqual((await self.target(seq=4))["state"], "stale")
        runner.run_resolve_panel_isolated.assert_not_called()

    async def test_current_bin_paused_is_busy_without_child(self):
        monitor = integration.resolve_selection_monitor
        async with monitor.suspended():
            result = await route.get_current_bin(self.request, self.ctx["instance"], self.ctx["account"], self.ctx["epoch"])
        self.assertEqual(result["state"], "busy")
        runner.run_resolve_panel_isolated.assert_not_called()

    async def test_prepare_coalescing_and_global_single_copy(self):
        started, finish = asyncio.Event(), asyncio.Event()
        original = transfer.prepare_generation_files
        count = 0

        async def slow(*args, **kwargs):
            nonlocal count
            count += 1
            started.set()
            await finish.wait()
            await original(*args, **kwargs)

        with patch.object(transfer, "prepare_generation_files", side_effect=slow):
            first = asyncio.create_task(self.prepare())
            await started.wait()
            second = asyncio.create_task(self.prepare())
            await asyncio.sleep(0.03)
            self.assertEqual(count, 1)
            self.assertEqual(len(panel._inflight), 2)
            finish.set()
            a, b = await asyncio.gather(first, second)
        self.assertEqual(a, b)
        self.assertEqual(count, 1)

    def remote(self, *ids):
        # 이 PC 에 아직 없는 원본 — 받기 길(자리·_cached_source)을 탄다
        return [dict(self.gen, id=gen_id, assets=[{"type": "video", "file_path": f"/media/remote_{gen_id}.mp4"}]) for gen_id in ids]

    async def test_new_cache_sequence_skips_unstarted_items(self):
        finish = asyncio.Event()
        seen = []

        async def slow(asset, **_):
            seen.append(asset["file_path"])
            await finish.wait()

        panel.note_sequence(self.ctx, 1, "cache")
        with patch.object(transfer, "_cached_source", side_effect=slow):
            task = asyncio.create_task(panel.cache(self.ctx, 1, self.remote("a", "b", "c", "d", "e")))
            await asyncio.sleep(0.03)
            self.assertEqual(len(seen), 3)  # 동시 3개까지
            panel.note_sequence(self.ctx, 2, "cache")  # 새 선택 — 시작 안 한 d·e 는 시작하지 않는다
            finish.set()
            result = await task
        self.assertEqual(len(seen), 3)
        self.assertEqual([item["gen_id"] for item in result["items"]], ["a", "b", "c"])  # 받던 것은 끝까지·결과에 든다

    async def test_request_cancel_keeps_activity_until_adopt_ledger_finishes(self):
        await self.place()
        started, finish = asyncio.Event(), asyncio.Event()
        original = transfer.save_manifest

        async def slow(manifest):
            started.set()
            await finish.wait()
            await original(manifest)

        with patch.object(transfer, "save_manifest", side_effect=slow):
            task = asyncio.create_task(self.adopt())
            await started.wait()
            task.cancel()
            await asyncio.sleep(0)
            self.assertGreater(transfer.active_transfer_count(), 0)
            self.assertFalse(task.done())
            finish.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(len(list(self.manifests.rglob("*.json"))), 1)
        self.assertEqual(transfer.active_transfer_count(), 0)

    async def test_delegated_connection_and_account_remain_pinned(self):
        async def authorize(*args):
            self.assertEqual(active_account.account_key(), "account-a")
            self.assertEqual(route._proxy._PINNED_CONNECTION.get(), ("https://test.invalid", "fake-token"))
            return "p", [self.gen]

        with patch.object(active_account.config, "AUTH_ENABLED", False), patch.object(active_account, "capture_account_pin", return_value=("account-a", "u")), patch.object(route._proxy, "proxying", return_value=True), patch.object(route._proxy, "base_url", return_value="https://test.invalid"), patch.object(route._proxy, "token", return_value="fake-token"), patch.object(integration, "_authorized_generations", side_effect=authorize):
            self.ctx = panel.identity()
            self.assertEqual((await self.prepare())["state"], "prepared")

    async def test_account_switch_is_visible_inside_pinned_scope(self):
        with patch.object(active_account.config, "AUTH_ENABLED", False), patch.object(active_account, "_read_pointer", return_value={"email": "a"}) as pointer:
            ctx = panel.identity()
            with active_account.pinned_account_scope(("a", "u")):
                pointer.return_value = {"email": "b"}
                self.assertEqual(active_account.account_key(), "a")
                with self.assertRaises(panel.AccountChanged):
                    panel.check_context(ctx)

    async def test_account_change_during_download_prevents_nas_copy(self):
        async def change(asset, **_):
            panel.INSTANCE = "new-hub"
            return self.media / "clip.mp4"

        with patch.object(panel, "INSTANCE", panel.INSTANCE), patch.object(transfer, "_cached_source", side_effect=change), patch.object(transfer, "_place_copy") as copy:
            self.assertEqual((await self.prepare())["state"], "account_changed")
        copy.assert_not_called()
        self.assertEqual(panel._prepared, {})

    async def test_cache_failure_is_per_item_and_does_not_touch_roots(self):
        missing = self.remote("g")[0]
        with patch.object(integration, "_authorized_generations", AsyncMock(return_value=("p", [missing]))), \
                patch.object(transfer, "_cached_source", AsyncMock(side_effect=OSError("missing"))):
            result = await route.post_cache(self.body(route.CacheIn, seq=1, gen_ids=["g"]), self.request)
        self.assertEqual(result["items"][0]["state"], "failed")
        transfer.resolve_transfer_roots.assert_not_called()

    async def test_prepare_and_normal_transfer_reuse_identical_file(self):
        ready = await self.prepare()
        manifest = await transfer.transfer_generations("p", [self.gen])
        self.assertEqual(manifest["items"][0]["local_path"], ready["path"])
        self.assertEqual(manifest["items"][0]["status"], "skipped")

    async def test_global_preparation_limit_applies_across_generations(self):
        started, finish = asyncio.Event(), asyncio.Event()
        count = 0
        original = transfer.prepare_generation_files

        async def slow(*args, **kwargs):
            nonlocal count
            count += 1
            started.set()
            await finish.wait()
            await original(*args, **kwargs)

        with patch.object(transfer, "prepare_generation_files", side_effect=slow):
            first = asyncio.create_task(panel.prepare(self.ctx, self.gen))
            await started.wait()
            second = asyncio.create_task(panel.prepare(self.ctx, dict(self.gen, id="other")))
            await asyncio.sleep(0.03)
            self.assertEqual(count, 1)
            finish.set()
            results = await asyncio.gather(first, second)
        self.assertEqual(count, 2)
        self.assertTrue(all(result["state"] == "prepared" for result in results))
        self.assertNotEqual(results[0]["path"], results[1]["path"])

    async def test_cache_requests_for_same_item_join(self):
        started, finish = asyncio.Event(), asyncio.Event()
        gen = self.remote("g")[0]

        async def slow(asset, **_):
            started.set()
            await finish.wait()

        with patch.object(transfer, "_cached_source", side_effect=slow) as cache:
            first = asyncio.create_task(panel.cache(self.ctx, 1, [gen]))
            await started.wait()
            second = asyncio.create_task(panel.cache(self.ctx, 1, [gen]))
            await asyncio.sleep(0.03)
            self.assertEqual(panel._CACHE_SLOTS._value, 2)  # 합류한 요청은 자리를 안 잡는다
            finish.set()
            a, b = await asyncio.gather(first, second)
            self.assertEqual(cache.call_count, 1)
            self.assertTrue(callable(cache.call_args.kwargs["before_download"]))  # 받기 직전 확인 칸을 넘긴다
        self.assertEqual(a, b)

    async def test_cache_parallel_limit_order_local_fast_path_and_prepare_lock_free(self):
        active, peak, gates = set(), [0], {}

        async def slow(asset, **_):
            name = asset["file_path"]
            if name == "/media/clip.mp4":  # 이미 이 PC 에 있는 원본(stage_items 도 이 함수를 부른다)
                return self.media / "clip.mp4"
            active.add(name); peak[0] = max(peak[0], len(active))
            gates.setdefault(name, asyncio.Event())
            await gates[name].wait()
            active.discard(name)

        with patch.object(transfer, "_cached_source", side_effect=slow):
            first = asyncio.create_task(panel.cache(self.ctx, 1, self.remote("a", "b", "c", "d")))
            second = asyncio.create_task(panel.cache(self.ctx, 1, self.remote("x", "y")))  # 다른 요청이 겹쳐도
            await asyncio.sleep(0.03)
            self.assertEqual(len(active), 3)  # cache 전체 동시 3개
            # 자리가 다 차도 이미 이 PC 에 있는 파일은 바로 · 받기는 _prepare_lock 을 안 쥐어 띄움 준비가 기다리지 않는다
            local = await asyncio.wait_for(panel.cache(self.ctx, 1, [self.gen]), 1)
            self.assertEqual(local["items"], [{"gen_id": "g", "state": "cached", "preview_url": "/media/clip.mp4"}])
            self.assertFalse(panel._prepare_lock.locked())
            items = await asyncio.wait_for(panel.stage_items(self.ctx, [self.gen]), 1)
            self.assertEqual(items[0]["gen_id"], "g")
            for _ in range(4):  # 늦게 시작한 것부터 끝내도 결과는 요청 순서
                for name in sorted(active, reverse=True):
                    gates[name].set()
                await asyncio.sleep(0.02)
            a, b = await asyncio.gather(first, second)
        self.assertEqual(peak[0], 3)
        self.assertEqual([row["gen_id"] for row in a["items"]], ["a", "b", "c", "d"])
        self.assertEqual([row["gen_id"] for row in b["items"]], ["x", "y"])

    async def test_cache_waiting_for_slot_rechecks_sequence_and_retries_after_old_owner(self):
        finish = asyncio.Event()
        seen = []

        async def slow(asset, **_):
            seen.append(asset["file_path"])
            await finish.wait()

        panel.note_sequence(self.ctx, 1, "cache", "w1")
        with patch.object(transfer, "_cached_source", side_effect=slow):
            busy = asyncio.create_task(panel.cache(self.ctx, 1, self.remote("a", "b", "c"), window="w1"))
            await asyncio.sleep(0.02)
            waiting = asyncio.create_task(panel.cache(self.ctx, 1, self.remote("d"), window="w1"))  # 자리를 기다린다
            await asyncio.sleep(0.02)
            panel.note_sequence(self.ctx, 2, "cache", "w1")  # 기다리는 사이 새 선택
            finish.set()
            await busy
            self.assertEqual((await waiting)["items"], [])
        self.assertNotIn("/media/remote_d.mp4", seen)  # 자리를 잡은 뒤 다시 보고 시작하지 않았다

    async def test_cache_joined_followers_retry_while_valid_even_if_new_owner_goes_stale(self):
        # 창 셋(w1·w2·w3)이 같은 생성물 e 에 합류 — 주인 w1 이 자리를 기다리다 낡고, 다시 주인이 된 w2 도 낡아도 유효한 w3 은 받는다
        gates = {name: asyncio.Event() for name in ("x", "y", "z")}
        seen = []

        async def slow(asset, **_):
            name = asset["file_path"].split("_")[-1].split(".")[0]
            seen.append(name)
            if name in gates:
                await gates[name].wait()

        for window in ("w1", "w2", "w3", "busy"):
            panel.note_sequence(self.ctx, 1, "cache", window)
        with patch.object(transfer, "_cached_source", side_effect=slow):
            busy = asyncio.create_task(panel.cache(self.ctx, 1, self.remote("x", "y", "z"), window="busy"))  # 자리 셋을 다 쓴다
            await asyncio.sleep(0.02)
            owners = [asyncio.create_task(panel.cache(self.ctx, 1, self.remote("e"), window=window)) for window in ("w1", "w2", "w3")]
            await asyncio.sleep(0.02)
            self.assertEqual(seen, ["x", "y", "z"])  # e 는 아직 자리를 기다린다(w2·w3 은 w1 에 합류)
            panel.note_sequence(self.ctx, 2, "cache", "w1")  # 주인 w1 과 합류자 w2 가 자리를 기다리는 사이 낡았다
            panel.note_sequence(self.ctx, 2, "cache", "w2")
            for gate in gates.values():
                gate.set()
            results = await asyncio.gather(busy, *owners)
        self.assertEqual([row["items"] for row in results[1:]], [[], [], [{"gen_id": "e", "state": "cached"}]])
        self.assertEqual(seen.count("e"), 1)
        # 다시 주인이 된 요청도 낡아 None 을 또 돌려줘도, 이 요청이 유효한 동안은 계속 다시 한다(한 번만 하고 빠지지 않는다)
        real, calls = panel.joined, []

        async def twice_none(key, work):
            calls.append(key)
            return None if len(calls) <= 2 else await real(key, work)

        with patch.object(transfer, "_cached_source", side_effect=slow), patch.object(panel, "joined", side_effect=twice_none):
            again = await panel.cache(self.ctx, 1, self.remote("f"), window="w3")
        self.assertEqual((len(calls), again["items"]), (3, [{"gen_id": "f", "state": "cached"}]))

    async def test_cache_same_source_for_different_generations_rechecks_before_second_download(self):
        # 서로 다른 생성물이 같은 원본 주소 — 앞 받기가 실패하는 사이 새 선택이 오면 뒤의 것은 받기를 시작하지 않는다
        go = asyncio.Event()
        calls = []

        async def failing(asset, **_):
            calls.append(asset["file_path"])
            await go.wait()
            raise OSError("CDN 오류")

        same = [dict(self.gen, id=gen_id, assets=[{"type": "video", "file_path": "https://cdn.test/same.mp4"}]) for gen_id in ("a", "b")]
        panel.note_sequence(self.ctx, 1, "cache")
        with patch.object(transfer, "_cached_source", side_effect=failing):
            task = asyncio.create_task(panel.cache(self.ctx, 1, same))
            await asyncio.sleep(0.02)
            self.assertEqual(len(calls), 1)  # b 는 같은 주소 차례를 기다린다(자리는 안 잡음)
            self.assertEqual(panel._CACHE_SLOTS._value, 2)
            panel.note_sequence(self.ctx, 2, "cache")
            go.set()
            result = await task
        self.assertEqual(len(calls), 1)  # 차례를 받은 뒤 다시 보고 시작하지 않았다
        self.assertEqual(result["items"], [{"gen_id": "a", "state": "failed", "error": "CDN 오류"}])
        self.assertEqual(panel._source_locks, {})  # 다 쓴 차례 잠금은 지운다
        # 띄움 준비(stage_items)가 같은 주소를 받는 중이어도 같다 — 그쪽도 같은 차례를 써서 cache 는 받는 쪽 잠금 안에서 기다리지 않는다
        go.clear(); calls.clear()
        panel.note_sequence(self.ctx, 3, "cache")
        with patch.object(transfer, "_cached_source", side_effect=failing):
            staging = asyncio.create_task(panel.stage_items(self.ctx, [dict(same[0], id="s")]))
            await asyncio.sleep(0.02)
            task = asyncio.create_task(panel.cache(self.ctx, 3, [same[1]]))
            await asyncio.sleep(0.02)
            self.assertEqual((len(calls), panel._CACHE_SLOTS._value), (1, 3))  # cache 는 차례를 기다리고 자리는 안 잡음
            panel.note_sequence(self.ctx, 4, "cache")
            go.set()
            with self.assertRaises(OSError):
                await staging
            self.assertEqual((await task)["items"], [])
        self.assertEqual(len(calls), 1)
        # 반대 방향 — cache 가 받는 중에 stage_items 가 차례를 기다리다 계정이 바뀌면 받기를 시작하지 않는다(리뷰 3차 P3)
        go.clear(); calls.clear()
        panel.note_sequence(self.ctx, 5, "cache")
        with patch.object(panel, "INSTANCE", panel.INSTANCE), patch.object(transfer, "_cached_source", side_effect=failing):
            task = asyncio.create_task(panel.cache(self.ctx, 5, [same[0]]))
            await asyncio.sleep(0.02)
            staging = asyncio.create_task(panel.stage_items(self.ctx, [dict(same[1], id="s")]))
            await asyncio.sleep(0.02)
            panel.INSTANCE = "new-hub"
            go.set()
            with self.assertRaises(panel.AccountChanged):
                await staging
            with self.assertRaises(panel.AccountChanged):
                await task
        self.assertEqual(len(calls), 1)

    async def test_cache_rechecks_inside_media_cache_lock_when_other_feature_downloads_same_url(self):
        # 패널 밖 기능(라이브러리 등)이 media_cache 로 같은 주소를 받는 중 — cache 는 그 잠금 안에서 기다렸다가 받기 직전에 다시 본다
        import threading
        from app.services import media_cache
        url = "https://cdn.test/shared.mp4"
        gen = [dict(self.gen, id="a", assets=[{"type": "video", "file_path": url}])]

        async def scenario(change):
            started, release, downloads = threading.Event(), threading.Event(), []

            def blocked(link, target, *args):
                downloads.append(link)
                started.set()
                release.wait(5)
                raise OSError("CDN 오류")

            with patch.object(media_cache, "MEDIA_DIR", self.media), patch.object(media_cache, "_download", side_effect=blocked), \
                    patch.object(media_cache, "_wait_for_complete_file", AsyncMock(return_value=False)):
                other = asyncio.create_task(media_cache.cache_url(url))
                await asyncio.to_thread(started.wait, 5)
                task = asyncio.create_task(panel.cache(self.ctx, 1, gen))
                await asyncio.sleep(0.05)
                self.assertEqual(downloads, [url])  # cache 는 media_cache 잠금에서 기다리는 중
                change()
                release.set()
                self.assertIsNone(await other)
                outcome = await asyncio.gather(task, return_exceptions=True)
            return outcome[0], downloads

        panel.note_sequence(self.ctx, 1, "cache")
        result, downloads = await scenario(lambda: panel.note_sequence(self.ctx, 2, "cache"))
        self.assertEqual((result, downloads), ({"items": []}, [url]))  # 새 선택 — 받기 1번뿐
        panel._sequences.clear()
        panel.note_sequence(self.ctx, 1, "cache")
        with patch.object(panel, "INSTANCE", panel.INSTANCE):
            result, downloads = await scenario(lambda: setattr(panel, "INSTANCE", "new-hub"))
        self.assertIsInstance(result, panel.AccountChanged)
        self.assertEqual(downloads, [url])
        self.assertEqual((media_cache._LOCKS, media_cache._LOCK_REFS), ({}, {}))

    async def test_cache_account_change_stops_new_work_and_waits_for_running(self):
        gates = {name: asyncio.Event() for name in ("a", "b", "c")}
        started = []

        async def slow(asset, **_):
            name = asset["file_path"].split("_")[-1].split(".")[0]
            started.append(name)
            await gates[name].wait()

        with patch.object(panel, "INSTANCE", panel.INSTANCE), patch.object(transfer, "_cached_source", side_effect=slow):
            task = asyncio.create_task(panel.cache(self.ctx, 1, self.remote("a", "b", "c", "d", "e")))
            joiner = asyncio.create_task(panel.cache(self.ctx, 1, self.remote("b")))  # 다른 요청이 b 에 합류
            await asyncio.sleep(0.03)
            panel.INSTANCE = "new-hub"  # 계정·허브가 바뀌었다
            gates["a"].set()
            await asyncio.sleep(0.03)
            self.assertFalse(task.done())  # 받던 b·c 가 끝나기 전엔 돌려주지 않는다
            self.assertEqual(panel._CACHE_SLOTS._value, 1)  # 끝난 a 만 자리를 돌려줬다
            gates["b"].set(); gates["c"].set()
            with self.assertRaises(panel.AccountChanged):
                await task
            joined = await asyncio.gather(joiner, return_exceptions=True)
        self.assertEqual(started, ["a", "b", "c"])  # 바뀐 뒤 새로 시작 0
        self.assertNotIsInstance(joined[0], asyncio.CancelledError)  # 합류자는 취소 오류를 받지 않는다
        self.assertEqual(panel._CACHE_SLOTS._value, 3)

    async def test_cache_other_error_and_outer_cancel_wait_for_running(self):
        finish = asyncio.Event()

        async def slow(asset, **_):
            await finish.wait()

        broken = dict(self.remote("z")[0])
        del broken["project_id"]  # 순번 열쇠를 못 만든다 — 계정 바뀜이 아닌 오류
        with patch.object(transfer, "_cached_source", side_effect=slow):
            task = asyncio.create_task(panel.cache(self.ctx, 1, self.remote("a") + [broken] + self.remote("b", "c")))
            await asyncio.sleep(0.03)
            self.assertFalse(task.done())  # a 를 받는 중 — 오류는 그 뒤에
            finish.set()
            with self.assertRaises(KeyError):
                await task
        self.assertEqual(panel._CACHE_SLOTS._value, 3)
        # 바깥 작업이 취소돼도 받던 것이 끝날 때까지 자리를 쥐고, 합류한 요청은 정상으로 끝난다
        finish.clear()
        with patch.object(transfer, "_cached_source", side_effect=slow):
            outer = asyncio.create_task(panel.cache(self.ctx, 1, self.remote("p", "q")))
            await asyncio.sleep(0.02)
            joiner = asyncio.create_task(panel.cache(self.ctx, 1, self.remote("p")))
            await asyncio.sleep(0.02)
            outer.cancel()
            await asyncio.sleep(0.02)
            self.assertEqual(panel._CACHE_SLOTS._value, 1)  # p·q 가 아직 자리를 쥐고 있다
            finish.set()
            self.assertEqual((await joiner)["items"], [{"gen_id": "p", "state": "cached"}])
            with self.assertRaises(asyncio.CancelledError):
                await outer
        self.assertEqual(panel._CACHE_SLOTS._value, 3)

    async def test_panel_passes_actual_manifest_root_to_recovery_gate(self):
        ready = await self.place()
        with patch.object(bridge, "_settle_recovery_record", side_effect=bridge.ResolveBridgeError("복구 미완", code="rebuild_recovery_pending")) as gate, patch.object(transfer, "save_manifest", AsyncMock()) as save:
            self.assertEqual((await self.target())["state"], "rebuild_recovery_pending")
            self.assertEqual((await self.adopt())["state"], "rebuild_recovery_pending")
        self.assertEqual(gate.call_count, 2)
        for call in gate.call_args_list:
            self.assertEqual(call.args[0]["manifest_root"], str(self.manifests))
        self.assertEqual(bridge._panel_raw_mark(self.pool.current.clips[0])["staged_by"], panel.hub_key())
        self.assertEqual(self.manager.saved, 0)
        save.assert_not_called()

    async def test_local_and_launch_guards_precede_child(self):
        with patch.object(integration, "_require_local_resolve", side_effect=HTTPException(403, "remote")):
            with self.assertRaises(HTTPException):
                await self.target()
        with patch.object(integration, "_reject_while_launching", side_effect=HTTPException(503, "launching")):
            with self.assertRaises(HTTPException):
                await self.target()
        runner.run_resolve_panel_isolated.assert_not_called()

    async def test_identity_and_http_routes(self):
        identity = await route.get_identity(self.request)
        self.assertEqual(identity["protocol"], {"min": 1, "max": 1})
        self.assertEqual(len(identity["account"]), 16)
        self.assertEqual({r.path for r in route.router.routes}, {
            "/api/resolve/panel/" + name for name in ("identity", "cache", "prepare", "target", "current-bin", "adopt", "stage", "unstage", "inventory",
                                                      "prestage", "rename", "save", "settle")})

    async def test_target_and_adopt_share_current_project_name_and_recovery_identity(self):
        self.gen["project_name"] = "옛 이름"
        ready = await self.prepare()
        with patch.object(bridge, "_settle_recovery_record", wraps=bridge._settle_recovery_record) as recovery:
            self.assertEqual((await self.target())["bin_path"], "MV Hub/영화/S01/C010")
            clip = FakeClip(str(self.media / "clip.mp4"))
            self.pool.current.clips.append(clip)
            bridge._panel_stamp(clip, "g", "p", lambda: None, hub_key=panel.hub_key())
            self.assertEqual((await self.adopt())["state"], "in_bin")
        self.assertEqual(recovery.call_args_list[0].args[3], recovery.call_args_list[1].args[3])
        with patch.object(route.repo, "get_project", return_value=None):
            self.assertEqual(panel.project_name(self.ctx, "p"), "옛 이름")

    async def test_target_project_read_denial_precedes_resolve(self):
        from app import deps
        with patch.object(deps, "AUTH_ENABLED", True), patch.object(deps, "project_roles_of", return_value=[]), patch.object(deps, "account_global_roles", return_value=[]):
            with self.assertRaises(HTTPException) as error:
                await self.target()
            self.assertEqual(error.exception.status_code, 403)
        runner.run_resolve_panel_isolated.assert_not_called()

    async def test_delegated_target_requires_project_in_upstream_visible_list(self):
        with patch.object(route._proxy, "proxying", return_value=True), patch.object(route._proxy, "base_url", return_value="https://test.invalid"), patch.object(route._proxy, "token", return_value="fake"), patch.object(route._proxy, "proxy_json", return_value={"projects": []}) as query:
            with self.assertRaises(HTTPException) as error:
                await self.target()
            self.assertEqual(error.exception.status_code, 403)
            query.assert_called_once_with("GET", "/api/projects?tab=team")
        runner.run_resolve_panel_isolated.assert_not_called()

    async def test_target_and_adopt_context_switch_in_child_does_not_write_ledger(self):
        await self.place()
        original = self.child

        def change(payload, before_start=None):
            result = original(payload, before_start)
            panel.INSTANCE = "restarted"
            return result

        for operation in (self.target, self.adopt):
            with patch.object(panel, "INSTANCE", self.ctx["instance"]), patch.object(runner, "run_resolve_panel_isolated", side_effect=change), patch.object(transfer, "save_manifest", AsyncMock()) as save:
                self.assertEqual((await operation())["state"], "account_changed")
                save.assert_not_called()

    def test_sequence_records_drop_past_context_and_bound_windows(self):
        panel.note_sequence(self.ctx, 10, "target", "old")
        current = {**self.ctx, "epoch": self.ctx["epoch"] + 1}
        for index in range(65):
            for channel in ("cache", "target"):
                panel.note_sequence(current, 5, channel, str(index))
        self.assertEqual(len(panel._sequences), 128)
        self.assertTrue(all(key[:3] == panel.context_key(current) for key in panel._sequences))
        self.assertEqual({key[3] for key in panel._sequences}, {str(index) for index in range(1, 65)})
        self.assertTrue(panel.stale(current, 4, "target", "64"))
        with patch.object(panel.config, "AUTH_ENABLED", True):
            other_account = {**current, "account": "another-login"}
            panel.note_sequence(other_account, 9, "target", "64")
            self.assertTrue(panel.stale(current, 4, "target", "64"))
            self.assertTrue(panel.stale(other_account, 8, "target", "64"))

    def test_sequence_lru_moves_all_window_channels_together(self):
        for index in range(64):
            for channel in ("cache", "target"):
                panel.note_sequence(self.ctx, 3, channel, str(index))
        panel.note_sequence(self.ctx, 4, "target", "0")
        panel.note_sequence(self.ctx, 1, "cache", "new")
        self.assertTrue(panel.stale(self.ctx, 2, "cache", "0"))
        self.assertTrue(panel.stale(self.ctx, 3, "target", "0"))
        self.assertFalse(any(key[3] == "1" for key in panel._sequences))
        self.assertEqual(len({key[3] for key in panel._sequences}), 64)

    async def test_window_sequences_are_independent_and_old_requests_are_stale(self):
        self.assertEqual((await self.target(seq=100))["state"], "ok")
        for name in ("reopened", "second-window"):
            await route.get_identity(self.request, window=name, claim=True)
            result = await route.post_target(self.body(route.TargetIn, seq=1, window=name), self.request)
            self.assertEqual(result["state"], "ok")
        await route.get_identity(self.request, window="test-window", claim=True)
        self.assertEqual((await self.target(seq=99))["state"], "stale")
        panel.note_sequence(self.ctx, 50, "cache", "first")
        self.assertTrue(panel.stale(self.ctx, 1, "cache", "first"))
        self.assertFalse(panel.stale(self.ctx, 1, "cache", "second"))

    async def test_auth_on_identity_uses_request_email_and_rejects_other_login(self):
        self.request.state.account = {"email": "first@example.test"}
        with patch.object(panel.config, "AUTH_ENABLED", True):
            first = await route.get_identity(self.request)
            self.request.state.account = {"email": "second@example.test"}
            second = await route.get_identity(self.request)
            self.assertNotEqual(first["account"], second["account"])
            self.ctx = first
            self.assertEqual((await self.prepare())["state"], "account_changed")
        integration._authorized_generations.assert_not_called()


    async def test_stage_authorized_cached_source_and_cut_sequence(self):
        await self.target()
        body = self.body(route.StageIn, seq=2, gen_ids=["g"])
        result = await route.post_stage(body, self.request)
        self.assertEqual(result["items"][0]["state"], "staged")
        self.assertEqual(self.pool.current.clips[0].path, str(self.media / "clip.mp4"))
        self.assertFalse(self.render.exists())
        self.assertFalse(self.manifests.exists())
        body.seq = 1
        self.assertEqual((await route.post_stage(body, self.request))["state"], "stale")
        panel.note_sequence(self.ctx, 100, "stage:p:other", "test-window")
        body.seq = 3
        self.assertEqual((await route.post_stage(body, self.request))["state"], "ok")

    async def test_stage_nas_overlap_rejected_and_oldest_200_capped(self):
        with patch.object(panel.config, "MEDIA_DIR", self.render):
            with self.assertRaises(transfer.ResolveTransferError):
                await panel.stage_items(self.ctx, [self.gen], self.request)
        rows = [{**self.gen, "id": str(n), "created_at": f"{n:04d}"} for n in reversed(range(201))]
        self.assertEqual([row["gen_id"] for row in await panel.stage_items(self.ctx, rows, self.request)], [str(n) for n in range(200)])
        rows = rows[1:]
        with patch.object(integration, "_authorized_generations", AsyncMock(return_value=("p", rows))):
            await self.target()
            result = await route.post_stage(self.body(route.StageIn, seq=1, gen_ids=[row["id"] for row in rows], capped=True), self.request)
        self.assertTrue(result["capped"])
        self.assertEqual(len(result["items"]), 200)
        self.assertEqual(result["items"][0]["gen_id"], "0")
        self.assertEqual(result["items"][-1]["gen_id"], "199")

    async def test_same_file_not_retried_until_cut_changes(self):
        await self.target()
        self.pool.current.clips.append(FakeClip(str(self.media / "clip.mp4")))
        body = self.body(route.StageIn, seq=1, gen_ids=["g"])
        self.assertEqual((await route.post_stage(body, self.request))["items"][0]["state"], "same_file_exists")
        self.pool.current.clips.clear()
        body.seq = 2
        self.assertEqual((await route.post_stage(body, self.request))["items"][0]["state"], "same_file_exists")
        self.assertEqual(self.pool.import_calls, [])

    async def test_writer_poll_never_steals_and_takeover_waits(self):
        one = await route.get_identity(self.request, window="one", claim=True)
        await route.get_identity(self.request, window="two")
        self.assertTrue((await route.get_identity(self.request, window="one"))["writer"])
        await panel.write_lock.acquire()
        takeover = asyncio.create_task(route.get_identity(self.request, window="two", claim=True))
        await asyncio.sleep(0.01)
        queued = asyncio.create_task(route.post_target(self.body(route.TargetIn, window="one", seq=1), self.request))
        await asyncio.sleep(0.01)
        self.assertFalse(takeover.done())
        panel.write_lock.release()
        second = await takeover
        self.assertGreater(second["generation"], one["generation"])
        self.assertEqual((await queued)["state"], "other_window")

    async def test_writer_global_across_auth_accounts_and_timeout(self):
        with patch.object(panel.config, "AUTH_ENABLED", True):
            self.request.state.account = {"email": "one@test.invalid"}
            one = await route.get_identity(self.request, window="one", claim=True)
            self.request.state.account = {"email": "two@test.invalid"}
            two = await route.get_identity(self.request, window="two", claim=True)
            self.assertNotEqual(one["account"], two["account"])
            self.assertIsNone(panel.owner_generation(one, "one"))
            panel._owner["seen"] -= 16
            self.assertIsNone(panel.owner_generation(two, "two"))
            self.assertTrue((await route.get_identity(self.request, window="two", claim=True))["writer"])

    async def test_inventory_permissions_db_folder_and_active_bin_cleanup(self):
        await self.place()
        result = await route.get_inventory(self.request, self.ctx["instance"], self.ctx["account"], self.ctx["epoch"])
        self.assertEqual(result["items"][0]["folder_path"], self.gen["folder_path"])
        body = self.body(route.UnstageIn, bin_id=self.pool.current.unique_id, inventory_cleanup=True)
        self.assertEqual((await route.post_unstage(body, self.request))["state"], "active_bin")
        with patch.object(route, "_project_read", AsyncMock(side_effect=HTTPException(403, "hidden"))):
            filtered = await route.get_inventory(self.request, self.ctx["instance"], self.ctx["account"], self.ctx["epoch"])
            self.assertEqual(filtered["items"], [])
            with self.assertRaises(HTTPException):
                await route.post_unstage(body, self.request)
            with self.assertRaises(HTTPException):
                await self.adopt()

    def episode(self, **kwargs):
        values = {"window": "test-window", "seq": 1, "create": True, "folder_path": "S01", "episode_path": "S01",
                  "create_paths": ["S01/C010", "S01/C020"], **kwargs}
        return route.TargetIn(ctx=self.ctx, project_id="p", **values)

    async def test_episode_paths_checked_before_resolve(self):
        for bad in [{"episode_path": ""}, {"create_paths": ["S01"]}, {"create_paths": ["S0/C010"]},
                    {"create_paths": ["S01x/C010"]}, {"folder_path": "S02"}, {"create": False}]:
            with self.assertRaises(HTTPException, msg=str(bad)):
                await route.post_target(self.episode(**bad), self.request)
        self.assertEqual(self.pool.root.children, [])  # 리졸브 호출 0
        with self.assertRaises(ValidationError):  # 200개를 넘으면 자르지 않고 거절
            self.episode(create_paths=[f"S01/C{n}" for n in range(201)])

    async def test_episode_bins_guard_follow_stage_and_unstage(self):
        result = await route.post_target(self.episode(), self.request)
        c010, c020 = result["bins"]["S01/C010"], result["bins"]["S01/C020"]
        cut = lambda cls, window="test-window", **kwargs: cls(ctx=self.ctx, project_id="p", folder_path="S01/C010", window=window, **kwargs)
        # 다른 창이 잡아도(claim) 에피소드 기억은 남아 다시 열기의 inventory 정리를 막고, 지울 권한은 넘어가지 않는다
        await route.get_identity(self.request, window="two", claim=True)
        self.assertEqual((await route.post_unstage(cut(route.UnstageIn, "two", bin_id=c010, inventory_cleanup=True), self.request))["state"], "active_bin")
        kept = await route.post_unstage(cut(route.UnstageIn, "two", bin_id=c010, delete_empty=True), self.request)  # 옛 필드는 무시된다
        self.assertEqual((kept["state"], "bin_deleted" in kept), ("ok", False))
        await route.get_identity(self.request, window="test-window", claim=True)
        # 따라가기 stage 의 bin_id 는 이 창이 받은 그 컷의 빈이어야 한다
        self.assertEqual((await route.post_stage(cut(route.StageIn, seq=1, bin_id=c020), self.request))["state"], "not_seen")
        self.assertEqual((await route.post_stage(cut(route.StageIn, seq=2, bin_id=c010), self.request))["state"], "ok")
        # unstage 는 빈을 지우지 않는다(옛 delete_empty 입구 없앰 — 빈 지우기는 settle) · 그 컷 빈 기억도 남는다
        done = await route.post_unstage(cut(route.UnstageIn, bin_id=c010, delete_empty=True), self.request)
        self.assertEqual((done["state"], "bin_deleted" in done), ("ok", False))
        self.assertIsNotNone(bridge._folder_at_path(self.pool.root, ("MV Hub", "영화", "S01", "C010")))
        self.assertIn(c010, panel._cut_bins)

    async def test_settle_route_only_this_window_cut_bins(self):
        first = await route.post_target(self.episode(), self.request)
        c010, c020, ep_s01 = first["bins"]["S01/C010"], first["bins"]["S01/C020"], first["episode_bin_id"]
        def settle(bins, **kwargs):
            body = route.SettleIn(ctx=self.ctx, project_id="p", folder_path="S01", window="test-window",
                                  bins=[route.SettleBin(folder_path=path, bin_id=bin_id) for path, bin_id in bins], **kwargs)
            return route.post_settle(body, self.request)
        # 지금 에피소드(A)의 컷 빈은 지우지 않는다
        self.assertEqual((await settle([("S01/C010", c010)]))["bins"]["S01/C010"]["state"], "current_episode")
        # target A → target B → settle(A 빈) = A 를 지움 · 같은 빈 두 번·에피소드 빈·모르는 ID 는 빼고 돌려줌
        await route.post_target(self.episode(seq=2, folder_path="S02", episode_path="S02", create_paths=["S02/C010"]), self.request)
        seen = []
        with patch.object(runner, "run_resolve_panel_isolated", side_effect=lambda p, before_start=None: (seen.append(p), self.child(p, before_start))[1]):
            done = await settle([("S01/C010", c010), ("S01/C010b", c010), ("S01", ep_s01), ("S01/C030", "없는-빈"), ("S01/C020", c020)],
                                expect_project=self.project.unique_id)
        self.assertEqual({path: row["state"] for path, row in done["bins"].items()},
                         {"S01/C010": "ok", "S01/C010b": "duplicate", "S01": "episode", "S01/C030": "not_seen", "S01/C020": "ok"})
        self.assertEqual(([row["bin_id"] for row in seen[-1]["bins"]], seen[-1]["expect_project"]), ([c010, c020], self.project.unique_id))
        self.assertTrue(done["bins"]["S01/C010"]["bin_deleted"])
        self.assertNotIn(c010, panel._cut_bins)
        self.assertIsNone(bridge._folder_at_path(self.pool.root, ("MV Hub", "영화", "S01", "C010")))
        self.assertIsNotNone(bridge._folder_at_path(self.pool.root, ("MV Hub", "영화", "S01")))
        # A → B → A 뒤의 settle(A 빈) = current_episode
        third = await route.post_target(self.episode(seq=3), self.request)
        again = third["bins"]["S01/C020"]
        self.assertEqual((await settle([("S01/C020", again)]))["bins"]["S01/C020"]["state"], "current_episode")
        # payload 를 만든 뒤 잠금 안 확인 전에 target 이 그 빈을 지금 에피소드로 기억하면 — 자식 입력에서 빠지고 current_episode
        await route.post_target(self.episode(seq=4, folder_path="S02", episode_path="S02", create_paths=["S02/C010"]), self.request)
        inputs = []
        def sneaky(payload, before_start=None):
            panel.remember_episode("test-window", "p", {"S01/C020": again})
            rejected = before_start() if before_start else None
            inputs.append([row["bin_id"] for row in payload["bins"]])
            return rejected or bridge.panel_operation(payload, resolve=self.resolve)
        with patch.object(runner, "run_resolve_panel_isolated", side_effect=sneaky):
            raced = await settle([("S01/C020", again)])
        self.assertEqual((inputs, raced["bins"]["S01/C020"]["state"]), ([[]], "current_episode"))
        self.assertIsNotNone(bridge._folder_at_path(self.pool.root, ("MV Hub", "영화", "S01", "C020")))

    async def test_keep_current_rules_expect_project_and_forget_after_rebuild(self):
        for bad in [{"keep_current": True, "create_paths": [], "create": True}, {"keep_current": True, "folder_path": "S01/C010"}]:
            with self.assertRaises(HTTPException, msg=str(bad)):
                await route.post_target(self.episode(**bad), self.request)
        self.assertEqual(self.pool.root.children, [])  # 리졸브 호출 0
        first = await route.post_target(self.episode(), self.request)
        owner = panel._owner["bin_id"]
        self.assertEqual(owner, first["bin_id"])
        panel._cut_bins["old-other"] = ("w", "q", "Q/C1")  # 다른 MV 프로젝트 기억은 남는다
        seen = []
        rebuilt = {"bins": {"S01/C010": "new-10", "S01/C020": "new-20"}, "bin_create_failed": [], "reordered": True,
                   "folder_order_backup": "", "order_error": "", "ids_changed": True}
        with patch.object(bridge, "_panel_episode_bins", return_value=rebuilt), \
                patch.object(runner, "run_resolve_panel_isolated", side_effect=lambda p, before_start=None: (seen.append(p), self.child(p, before_start))[1]):
            kept = await route.post_target(self.episode(seq=2, keep_current=True, expect_project=self.project.unique_id), self.request)
        self.assertEqual((kept["state"], seen[-1]["keep_current"], seen[-1]["expect_project"]), ("ok", True, self.project.unique_id))
        # 다시 짓기 = 이 프로젝트의 옛 빈 ID 를 버리고 새 bins 만 · keep_current 의 bin_id(사람의 지금 빈)는 패널 빈으로 기억 안 함
        self.assertEqual({key: value[1:] for key, value in panel._cut_bins.items()},
                         {"old-other": ("q", "Q/C1"), "new-10": ("p", "S01/C010"), "new-20": ("p", "S01/C020")})
        self.assertEqual(panel._episode_bins, {"new-10", "new-20"})
        self.assertEqual(panel._owner["bin_id"], "")
        with patch.object(runner, "run_resolve_panel_isolated", side_effect=lambda p, before_start=None: (seen.append(p), self.child(p, before_start))[1]):
            moved = await route.post_stage(self.body(route.StageIn, seq=1, gen_ids=[], expect_project="다른 프로젝트"), self.request)
        self.assertEqual((moved["state"], seen[-1]["expect_project"]), ("project_changed", "다른 프로젝트"))

    # ── 미리 띄우기·이름 뒤따르기·[저장](11-12) ──
    async def test_prestage_rename_and_save_routes(self):
        result = await route.post_target(self.episode(), self.request)
        ep, c010 = result["episode_bin_id"], result["bins"]["S01/C010"]
        cut = lambda bin_id=c010: route.CutIn(folder_path="S01/C010", bin_id=bin_id, gen_ids=["g"])
        pre = lambda **kw: route.PrestageIn(ctx=self.ctx, project_id="p", folder_path="S01", **{"window": "test-window", "episode_bin_id": ep, "cuts": [cut()], **kw})
        # 이 창이 받은 에피소드·컷 빈만 — 모르는 ID·다른 창이면 리졸브 호출 0
        for bad, state in [(pre(episode_bin_id="모르는 빈"), "not_seen"), (pre(cuts=[cut("모르는 빈")]), "not_seen"), (pre(window="other"), "other_window")]:
            self.assertEqual((await route.post_prestage(bad, self.request))["state"], state)
        self.assertEqual(self.pool.import_calls, [])
        done = await route.post_prestage(pre(), self.request)  # 다빈치 지금 빈 = 에피소드 빈 → 거기 가져와 컷 빈으로 옮김
        self.assertEqual(done["cuts"]["S01/C010"]["items"], [{"gen_id": "g", "state": "staged"}])
        episode, c10 = (bridge._folder_at_path(self.pool.root, ("MV Hub", "영화", *parts)) for parts in (("S01",), ("S01", "C010")))
        self.assertEqual((episode.clips, [clip.name for clip in c10.clips]), ([], ["clip.mp4"]))  # 이름은 아직(뒤따르기가)
        renamed = await route.post_rename(route.RenameIn(ctx=self.ctx, project_id="p", folder_path="S01", window="test-window", cuts=[cut()]), self.request)
        self.assertEqual((renamed["named"], renamed["remaining"], c10.clips[0].name), (1, 0, "작업자"))
        # [저장] — 안 쓴 이 PC 클립이 남았으면 저장하지 않는다 → 정리 뒤 저장
        save = lambda project=self.project.unique_id: route.post_save(route.SaveIn(ctx=self.ctx, project_id="p", folder_path="S01", window="test-window", expect_project=project), self.request)
        blocked = await save()
        self.assertEqual((blocked["state"], blocked["not_clean"]["mine"], self.manager.saved), ("not_clean", 1, 0))
        self.assertEqual((await save("다른 프로젝트"))["state"], "project_changed")
        await route.post_unstage(route.UnstageIn(ctx=self.ctx, project_id="p", folder_path="S01/C010", window="test-window", bin_id=c010), self.request)
        self.assertEqual(((await save())["state"], self.manager.saved), ("ok", 1))
        with self.assertRaises(ValidationError):  # 저장할 프로젝트를 고정하지 않은 저장은 받지 않는다
            route.SaveIn(ctx=self.ctx, project_id="p", folder_path="S01", window="test-window", expect_project="")

    async def test_adopt_crash_after_replace_and_restart_uses_disk_ready(self):
        await self.place()
        clip = self.pool.current.clips[0]
        original = clip.ReplaceClip
        def crash(path):
            self.assertEqual(len(panel.records("adopt", self.ctx)), 1)
            original(path)
            raise RuntimeError("process lost after replace")
        with patch.object(clip, "ReplaceClip", side_effect=crash):
            self.assertEqual((await self.adopt())["state"], "unknown")
        panel._prepared.clear()
        with patch.object(panel, "INSTANCE", "restarted"):
            self.ctx = await route.get_identity(self.request, window="test-window", claim=True)
            result = await self.adopt()
        self.assertEqual(result["state"], "in_bin")
        self.assertEqual(panel.records("adopt", self.ctx), [])

    async def test_import_failure_record_then_stage_recovers(self):
        await self.target()
        body = self.body(route.StageIn, seq=1, gen_ids=["g"])
        with patch.object(FakeClip, "SetThirdPartyMetadata", return_value=False), patch.object(self.pool, "DeleteClips", return_value=False):
            self.assertEqual((await route.post_stage(body, self.request))["items"][0]["state"], "import_failed")
        self.assertEqual(len(panel.records("import", self.ctx)), 1)
        body.seq = 2
        self.assertEqual((await route.post_stage(body, self.request))["items"][0]["state"], "staged")
        self.assertEqual(len(self.pool.current.clips), 1)
        self.assertEqual(panel.records("import", self.ctx), [])

    async def test_capped_empty_stage_preserves_existing_item(self):
        await self.place()
        result = await route.post_stage(self.body(route.StageIn, seq=1, gen_ids=[], capped=True), self.request)
        self.assertTrue(result["capped"])
        self.assertEqual(len(self.pool.current.clips), 1)

    async def test_old_owner_context_unclaimed_but_live_other_account_is_other_window(self):
        with patch.object(panel, "INSTANCE", "new-instance"):
            self.assertEqual((await route.get_identity(self.request, window="test-window"))["owner_state"], "unclaimed")
            self.assertTrue((await route.get_identity(self.request, window="test-window", claim=True))["writer"])
        with patch.object(panel.config, "AUTH_ENABLED", True):
            self.request.state.account = {"email": "a@test.invalid"}
            await route.get_identity(self.request, window="one", claim=True)
            self.request.state.account = {"email": "b@test.invalid"}
            self.assertEqual((await route.get_identity(self.request, window="one"))["owner_state"], "unclaimed")
            self.assertEqual((await route.get_identity(self.request, window="two"))["owner_state"], "other_window")

    async def test_missing_adoption_record_deleted_and_other_owned_item_adopted(self):
        await self.place()
        with patch.object(transfer, "save_manifest", side_effect=OSError("ledger")):
            await self.adopt()
        old = panel.records("adopt", self.ctx)[0]
        self.pool.current.clips.clear()
        clip = FakeClip(str(self.media / "clip.mp4"))
        bridge._panel_stamp(clip, "g", "p", lambda: None, hub_key=panel.hub_key())
        self.pool.current.clips.append(clip)
        result = await self.adopt()
        self.assertEqual(result["state"], "in_bin")
        self.assertIn(old["item_id"], result["missing_record_ids"])
        self.assertEqual(panel.records("adopt", self.ctx), [])

    async def test_missing_adoption_record_kept_when_read_fails(self):
        await self.place()
        with patch.object(transfer, "save_manifest", side_effect=OSError("ledger")):
            await self.adopt()
        self.pool.current.clips.clear()
        with patch.object(self.pool.current, "GetClipList", side_effect=RuntimeError("unreadable")):
            await self.adopt()
        self.assertEqual(len(panel.records("adopt", self.ctx)), 1)

    async def test_missing_adoption_without_replacement_clears_confirmed_record(self):
        await self.place()
        with patch.object(transfer, "save_manifest", side_effect=OSError("ledger")):
            await self.adopt()
        self.pool.current.clips.clear()
        self.assertEqual((await self.adopt())["state"], "not_seen")
        self.assertEqual(panel.records("adopt", self.ctx), [])

    async def test_missing_adoption_record_kept_when_project_changes_during_read(self):
        await self.place()
        with patch.object(transfer, "save_manifest", side_effect=OSError("ledger")):
            await self.adopt()
        records = panel.records("adopt", self.ctx)
        self.assertEqual(len(records), 1)

        def changed_read():
            self.project.unique_id = "changed-during-read"
            return []

        def child(payload, before_start=None):
            if payload["operation"] == "adopt":
                with patch.object(self.pool.current, "GetClipList", side_effect=changed_read):
                    return self.child(payload, before_start)
            return self.child(payload, before_start)

        with patch.object(runner, "run_resolve_panel_isolated", side_effect=child), patch.object(transfer, "save_manifest", AsyncMock()) as save:
            result = await self.adopt()
        self.assertEqual(result["state"], "project_changed")
        self.assertNotIn("missing_record_ids", result)
        self.assertEqual(panel.records("adopt", self.ctx), records)
        save.assert_not_called()

    async def test_present_generation_clears_import_record(self):
        await self.place()
        clip = self.pool.current.clips[0]
        panel.save_record("import", {"account": self.ctx["account"], "hub_key": panel.hub_key(),
                                   "resolve_project_id": self.project.unique_id, "project_id": "p", "gen_id": "g",
                                   "item_id": clip.unique_id, "local_path": clip.path})
        result = await route.post_stage(self.body(route.StageIn, seq=1, gen_ids=["g"]), self.request)
        self.assertEqual(result["items"][0]["state"], "present")
        self.assertEqual(panel.records("import", self.ctx), [])

    async def test_adopt_fallback_found_after_preflight_is_recorded_before_replace(self):
        await self.place()
        with patch.object(transfer, "save_manifest", side_effect=OSError("ledger")):
            await self.adopt()
        self.pool.current.clips.clear()
        clip = FakeClip(str(self.media / "clip.mp4"))
        bridge._panel_stamp(clip, "g", "p", lambda: None, hub_key=panel.hub_key())
        self.pool.current.clips.append(clip)
        original = clip.ReplaceClip
        def replace(path):
            self.assertIn(clip.unique_id, {row["item_id"] for row in panel.records("adopt", self.ctx)})
            return original(path)
        with patch.object(route, "_inventory", AsyncMock(return_value={"state": "ok", "resolve_project_id": self.project.unique_id, "items": [], "more": False})), patch.object(clip, "ReplaceClip", side_effect=replace):
            self.assertEqual((await self.adopt())["state"], "in_bin")
        self.assertEqual(panel.records("adopt", self.ctx), [])

    def test_stage_request_limit_matches_screen_limit(self):
        self.assertEqual(len(self.body(route.StageIn, seq=1, gen_ids=[str(n) for n in range(200)]).gen_ids), 200)
        with self.assertRaises(ValueError):
            self.body(route.StageIn, seq=1, gen_ids=[str(n) for n in range(201)])


class RunnerTests(unittest.TestCase):
    def test_busy_read_does_not_probe_resolve(self):
        with runner.resolve_mutation_slot(), patch.object(runner, "_select_interpreter") as probe:
            self.assertEqual(runner.run_resolve_panel_isolated({"operation": "current-bin"})["state"], "busy")
        probe.assert_not_called()

    def test_write_wait_maximum_is_busy(self):
        with runner.resolve_mutation_slot(), patch.object(runner.time, "monotonic", side_effect=[0, 31]), patch.object(runner, "_select_interpreter") as probe:
            self.assertEqual(runner.run_resolve_panel_isolated({"operation": "target"})["state"], "busy")
        probe.assert_not_called()

    def test_child_keeps_slot_and_mutations_have_no_timeout(self):
        for operation in ("target", "adopt", "stage", "unstage", "current-bin", "inventory"):
            def child(*args, **kwargs):
                with runner.resolve_mutation_slot(blocking=False) as acquired:
                    self.assertFalse(acquired)
                self.assertEqual(kwargs["timeout"], {"current-bin": 8, "inventory": 20}.get(operation))
                return SimpleNamespace(stdout=worker.RESULT_PREFIX + '{"state":"ok"}', stderr="", returncode=0)

            with patch.object(runner, "_resolve_is_closed", return_value=False), patch.object(runner, "_select_interpreter", return_value=("python", {}, "")), patch.object(runner, "_run_child", side_effect=child):
                self.assertEqual(runner.run_resolve_panel_isolated({"operation": operation})["state"], "ok")

    def test_post_wait_context_or_sequence_rejection_precedes_probe(self):
        for state in ("account_changed", "stale"):
            with patch.object(runner, "_select_interpreter") as probe:
                result = runner.run_resolve_panel_isolated({"operation": "target"}, before_start=lambda: {"state": state})
            self.assertEqual(result["state"], state)
            probe.assert_not_called()

    def test_recent_read_skips_closed_check_writes_always_check(self):
        ok = SimpleNamespace(stdout=worker.RESULT_PREFIX + '{"state":"ok","resolve_project_id":"r"}', stderr="", returncode=0)
        crash = SimpleNamespace(stdout="", stderr="crashed", returncode=1)
        clock = [100.0]
        self.addCleanup(setattr, runner, "_panel_alive_at", None)
        runner._panel_alive_at = None
        with patch.object(runner, "_resolve_is_closed", return_value=False) as closed, patch.object(runner, "_select_interpreter", return_value=("python", {}, "")), \
                patch.object(runner, "_run_child", return_value=ok) as child, patch.object(runner.time, "monotonic", side_effect=lambda: clock[0]):
            runner.run_resolve_panel_isolated({"operation": "current-bin"})
            self.assertEqual(closed.call_count, 1)  # 처음은 확인
            runner.run_resolve_panel_isolated({"operation": "current-bin"})
            runner.run_resolve_panel_isolated({"operation": "inventory"})
            self.assertEqual(closed.call_count, 1)  # 10초 안 읽기는 건너뜀
            runner.run_resolve_panel_isolated({"operation": "stage"})
            self.assertEqual(closed.call_count, 2)  # 쓰기는 늘 확인
            clock[0] += 11
            runner.run_resolve_panel_isolated({"operation": "current-bin"})
            self.assertEqual(closed.call_count, 3)  # 10초가 지나면 다시
            child.return_value = crash
            runner.run_resolve_panel_isolated({"operation": "current-bin"})  # 건너뛴 채 실패 → 기억을 지운다
            child.return_value = ok
            runner.run_resolve_panel_isolated({"operation": "current-bin"})
            self.assertEqual(closed.call_count, 4)
            child.side_effect = runner.subprocess.TimeoutExpired("python", 8)
            runner.run_resolve_panel_isolated({"operation": "current-bin"})  # 건너뛴 채 시간 초과 → 기억을 지운다
            child.side_effect = None
            runner.run_resolve_panel_isolated({"operation": "current-bin"})
            self.assertEqual(closed.call_count, 5)
            child.return_value = SimpleNamespace(stdout=worker.RESULT_PREFIX + '{"state":"unavailable"}', stderr="", returncode=0)
            runner.run_resolve_panel_isolated({"operation": "current-bin"})  # 프로젝트 ID 없는 결과도 기억을 지운다
            child.return_value = ok
            runner.run_resolve_panel_isolated({"operation": "current-bin"})
            self.assertEqual(closed.call_count, 6)

    def test_child_crash_is_unknown_for_adopt(self):
        with patch.object(runner, "_resolve_is_closed", return_value=False), patch.object(runner, "_select_interpreter", return_value=("python", {}, "")), patch.object(runner, "_run_child", return_value=SimpleNamespace(stdout="", stderr="crashed", returncode=1)):
            self.assertEqual(runner.run_resolve_panel_isolated({"operation": "adopt"})["state"], "unknown")

    def test_pause_during_interpreter_probe_prevents_read_child(self):
        checks = iter([None, {"state": "busy"}])
        with patch.object(runner, "_resolve_is_closed", return_value=False), patch.object(runner, "_select_interpreter", return_value=("python", {}, "")), patch.object(runner, "_run_child") as child:
            result = runner.run_resolve_panel_isolated({"operation": "current-bin"}, before_start=lambda: next(checks))
        self.assertEqual(result["state"], "busy")
        child.assert_not_called()

    def test_worker_holds_transfer_lease(self):
        held = []

        @contextmanager
        def lease():
            held.append(True)
            try:
                yield
            finally:
                held.pop()

        def perform(payload):
            self.assertEqual(held, [True])
            return {"state": "ok"}

        with patch.object(worker, "transfer_lease", lease), patch.object(worker, "panel_operation", side_effect=perform):
            self.assertEqual(worker.run({"operation": "target"})["state"], "ok")
        self.assertEqual(held, [])
