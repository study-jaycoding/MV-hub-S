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


if __name__ == "__main__":
    unittest.main()
