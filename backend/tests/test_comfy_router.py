"""comfy 라우터/파서 방어 로직 회귀 테스트 — 코드 리뷰(2026-07-27)에서 고친 항목 고정.

 · malformed 워크플로(inputs 가 list, _meta 가 문자열)여도 500(AttributeError) 나지 않음
 · 영상 경로모드 파일명이 mvhub 폴더 밖으로 탈출하지 못함(경로 탈출 방어)
 · 동시 실행 게이트가 설정한 슬롯 수만큼만 동시 진입 허용
"""

import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from app.routers import comfy
from app.services import comfy_workflow


class MalformedWorkflowTests(unittest.TestCase):
    def test_non_dict_inputs_and_meta_do_not_crash(self):
        # inputs 가 list, _meta 가 문자열이어도 AttributeError(→500) 없이 파싱된다.
        wf = {
            "1": {"class_type": "KSampler", "inputs": [], "_meta": "bad"},
            "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "hi"},
                  "_meta": {"title": "T"}},
        }
        slots = comfy_workflow.detect_slots(wf, {"2|text"})
        self.assertEqual(slots["node_count"], 2)
        # 노출한 2|text 는 파라미터로 잡히고, 깨진 1번(inputs=[])은 조용히 건너뛴다.
        param_keys = {(p["node_id"], f["field"]) for p in slots["params"] for f in p["fields"]}
        self.assertIn(("2", "text"), param_keys)
        # 후보 수집도 예외 없이 동작.
        cands = comfy_workflow.param_candidates(wf, set())
        self.assertIn(("2", "text"), {(c["node_id"], c["field"]) for c in cands})

    def test_non_api_format_raises_valueerror_not_500(self):
        with self.assertRaises(ValueError):
            comfy_workflow.detect_slots({}, set())               # 빈 JSON
        with self.assertRaises(ValueError):
            comfy_workflow.detect_slots({"1": {"inputs": {}}}, set())  # class_type 없음


class VideoPathSanitizeTests(unittest.TestCase):
    def test_path_mode_filename_cannot_escape_mvhub(self):
        wf = {"1": {"class_type": "VHS_LoadVideoPath", "inputs": {"video": "x.mp4"}}}
        slots = comfy_workflow.detect_slots(wf, set())
        target = {"cloud": False, "base": "http://127.0.0.1:8188", "prefix": "", "headers": {}}
        with TemporaryDirectory() as d:
            comfy._fill_videos(target, wf, slots["video_slots"],
                               [("../../evil.mp4", b"data")], d)
            written = Path(wf["1"]["inputs"]["video"]).resolve()
            mvhub = (Path(d) / "mvhub").resolve()
            # mvhub 안에 evil.mp4 로만 저장(상위로 탈출 금지).
            self.assertEqual(written.name, "evil.mp4")
            self.assertTrue(str(written).startswith(str(mvhub)))
            self.assertTrue(written.exists())


class RunGateTests(unittest.TestCase):
    def tearDown(self):
        # 게이트 카운터를 다른 테스트에 안 넘기도록 0 으로 되돌린다.
        with comfy._RUN_GATE:
            comfy._RUN_SLOTS_ACTIVE = 0

    def test_gate_limits_active_slots(self):
        comfy._acquire_run_slot(2)
        comfy._acquire_run_slot(2)
        self.assertEqual(comfy._RUN_SLOTS_ACTIVE, 2)
        entered = threading.Event()

        def third():
            comfy._acquire_run_slot(2)
            entered.set()

        threading.Thread(target=third, daemon=True).start()
        self.assertFalse(entered.wait(0.2))   # 슬롯 없어 0.2s 안에 못 들어옴(블록)
        comfy._release_run_slot()             # 하나 반납 → 대기하던 3번째 진입
        self.assertTrue(entered.wait(1.0))
        self.assertEqual(comfy._RUN_SLOTS_ACTIVE, 2)


class ComboChoiceTests(unittest.TestCase):
    """ComfyUI /object_info 의 COMBO 위젯 후보를 dropdown 선택지로 자동 채우는 로직."""

    def test_extract_picks_only_list_widgets(self):
        oi = {"GeminiImage": {"input": {"required": {
            "resolution": [["1K", "2K", "4K"], {"default": "1K"}],   # COMBO → 후보
            "model": [["gemini-3-pro-image-preview", "gemini-2"], {}],  # COMBO → 후보
            "seed": ["INT", {"default": 0}],                          # 스칼라 → 후보 없음
            "text": ["STRING", {"multiline": True}],                  # 스칼라 → 후보 없음
        }}}}
        self.assertEqual(
            comfy_workflow.extract_combo_choices(oi, "GeminiImage"),
            {"resolution": ["1K", "2K", "4K"],
             "model": ["gemini-3-pro-image-preview", "gemini-2"]},
        )

    def test_extract_new_combo_format(self):
        # 신형 표기: 첫 원소 "COMBO", 후보는 opts.options (현재 ComfyUI 다수 API 노드).
        oi = {"GeminiImage2Node": {"input": {"required": {
            "resolution": ["COMBO", {"default": "1K", "options": ["1K", "2K", "4K"]}],
            "model": ["COMBO", {"options": ["gemini-3-pro-image-preview", "nano-banana-2"]}],
            "seed": ["INT", {"default": 0}],           # options 없음 → 후보 없음
            "prompt": ["STRING", {"multiline": True}],  # options 없음 → 후보 없음
        }}}}
        self.assertEqual(
            comfy_workflow.extract_combo_choices(oi, "GeminiImage2Node"),
            {"resolution": ["1K", "2K", "4K"],
             "model": ["gemini-3-pro-image-preview", "nano-banana-2"]},
        )

    def test_extract_malformed_is_safe(self):
        self.assertEqual(comfy_workflow.extract_combo_choices({}, "X"), {})
        self.assertEqual(comfy_workflow.extract_combo_choices({"X": "bad"}, "X"), {})

    def _patch(self, get_object_info):
        """make_target/_raw_settings/get_object_info 를 임시 교체(DB·네트워크 없이 테스트)."""
        self._orig = (comfy._raw_settings, comfy.comfy_client.make_target,
                      comfy.comfy_client.get_object_info)
        comfy._raw_settings = lambda: {}
        comfy.comfy_client.make_target = lambda s: {
            "cloud": False, "base": "http://x", "prefix": "", "headers": {}}
        comfy.comfy_client.get_object_info = get_object_info
        self.addCleanup(self._restore)

    def _restore(self):
        (comfy._raw_settings, comfy.comfy_client.make_target,
         comfy.comfy_client.get_object_info) = self._orig

    def test_enrich_fills_choices_and_skips_missing(self):
        # get_object_info 는 전체 object_info 를 1회 반환(cloud 는 개별 조회 불가) → 클래스별 추출.
        full = {"GeminiImage2Node": {"input": {"required": {
            "resolution": ["COMBO", {"options": ["1K", "2K", "4K"]}],
            "model": ["COMBO", {"options": ["gemini-3-pro-image-preview"]}],
        }}}}
        self._patch(lambda target, **kw: full)
        candidates = [
            {"class_type": "GeminiImage2Node", "field": "resolution", "type": "text", "choices": None},
            {"class_type": "GeminiImage2Node", "field": "model", "type": "text", "choices": None},
            {"class_type": "KSampler", "field": "seed", "type": "number", "choices": None},
        ]
        comfy._enrich_choices(candidates)
        by = {c["field"]: c["choices"] for c in candidates}
        self.assertEqual(by["resolution"], ["1K", "2K", "4K"])
        self.assertEqual(by["model"], ["gemini-3-pro-image-preview"])
        self.assertIsNone(by["seed"])   # object_info 에 없는 노드 → 그대로(텍스트/숫자)

    def test_enrich_survives_server_down(self):
        def boom(target, **kw):
            raise comfy.comfy_client.ComfyError("server down")

        self._patch(boom)
        candidates = [{"class_type": "X", "field": "f", "type": "text", "choices": None}]
        comfy._enrich_choices(candidates)   # 예외 없이 통과
        self.assertIsNone(candidates[0]["choices"])

    def test_enrich_keeps_existing_curated_choices(self):
        # 이미 CURATED choices 가 있으면 object_info 조회 자체를 하지 않는다(need 비어 있음).
        def must_not_call(target, **kw):
            raise AssertionError("이미 choices 있으면 조회하면 안 됨")

        self._patch(must_not_call)
        candidates = [{"class_type": "ImpactSwitch", "field": "select",
                       "type": "number", "choices": [1, 2]}]
        comfy._enrich_choices(candidates)
        self.assertEqual(candidates[0]["choices"], [1, 2])


class MediaKindTests(unittest.TestCase):
    """출력 파일 확장자 → 미디어 종류 판정. 비미디어(.txt 등)는 None(image 로 잘못 저장 방지)."""

    def test_only_image_video_extensions(self):
        self.assertEqual(comfy._media_kind("a.png"), "image")
        self.assertEqual(comfy._media_kind("A.JPG"), "image")
        self.assertEqual(comfy._media_kind("clip.MP4"), "video")
        self.assertIsNone(comfy._media_kind("note.txt"))   # SaveText 출력 → 미디어 아님
        self.assertIsNone(comfy._media_kind("noext"))
        self.assertIsNone(comfy._media_kind(""))


class ObjectInfoCacheTests(unittest.TestCase):
    """object_info 캐시가 api_key 까지 키로 삼아 키/워크스페이스 변경을 구분하는지."""

    def test_cache_keyed_by_api_key(self):
        calls = []
        orig = comfy.comfy_client._get_json
        comfy.comfy_client._get_json = lambda target, route, **kw: (calls.append(route), {"X": {"input": {}}})[1]
        try:
            comfy.comfy_client._OBJECT_INFO_CACHE.clear()
            t1 = {"base": "https://cloud.comfy.org", "prefix": "/api", "headers": {"X-API-Key": "k1"}, "cloud": True}
            t2 = {"base": "https://cloud.comfy.org", "prefix": "/api", "headers": {"X-API-Key": "k2"}, "cloud": True}
            comfy.comfy_client.get_object_info(t1)
            comfy.comfy_client.get_object_info(t1)  # 같은 키 → 캐시 히트(재조회 없음)
            comfy.comfy_client.get_object_info(t2)  # 다른 api_key → 새 조회
            self.assertEqual(len(calls), 2)
        finally:
            comfy.comfy_client._get_json = orig


class SubscriptionTierTests(unittest.TestCase):
    """Comfy Cloud 구독 등급 추출(크레딧 표시용) — /workspaces 응답 파싱."""

    def test_extracts_tier_from_workspaces(self):
        orig = comfy.comfy_client._get_json
        comfy.comfy_client._get_json = lambda target, route, **kw: {
            "workspaces": [{"id": "w-1", "subscription_tier": "PRO"}]}
        try:
            comfy.comfy_client._SUBSCRIPTION_CACHE.clear()
            t = {"base": "https://cloud.comfy.org", "prefix": "/api", "headers": {}, "cloud": True}
            self.assertEqual(comfy.comfy_client.get_subscription_tier(t, use_cache=False), "PRO")
        finally:
            comfy.comfy_client._get_json = orig

    def test_missing_tier_returns_none(self):
        orig = comfy.comfy_client._get_json
        comfy.comfy_client._get_json = lambda target, route, **kw: {"workspaces": [{"id": "w-1"}]}
        try:
            comfy.comfy_client._SUBSCRIPTION_CACHE.clear()
            t = {"base": "http://x", "prefix": "", "headers": {}, "cloud": True}
            self.assertIsNone(comfy.comfy_client.get_subscription_tier(t, use_cache=False))
        finally:
            comfy.comfy_client._get_json = orig

    def test_fetch_error_returns_none(self):
        orig = comfy.comfy_client._get_json

        def boom(target, route, **kw):
            raise comfy.comfy_client.ComfyError("down")

        comfy.comfy_client._get_json = boom
        try:
            comfy.comfy_client._SUBSCRIPTION_CACHE.clear()
            t = {"base": "http://x", "prefix": "", "headers": {}, "cloud": True}
            self.assertIsNone(comfy.comfy_client.get_subscription_tier(t, use_cache=False))
        finally:
            comfy.comfy_client._get_json = orig


if __name__ == "__main__":
    unittest.main()
