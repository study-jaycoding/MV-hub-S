"""comfy 라우터/파서 방어 로직 회귀 테스트 — 코드 리뷰(2026-07-27)에서 고친 항목 고정.

 · malformed 워크플로(inputs 가 list, _meta 가 문자열)여도 500(AttributeError) 나지 않음
 · 영상 경로모드 파일명이 mvhub 폴더 밖으로 탈출하지 못함(경로 탈출 방어)
 · 동시 실행 게이트가 설정한 슬롯 수만큼만 동시 진입 허용
"""

import json
import io
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from app.routers import comfy
from app.services import comfy_workflow


class _TrackingStream(io.BytesIO):
    def __init__(self, data: bytes):
        super().__init__(data)
        self.max_requested = 0

    def read(self, size=-1):
        self.max_requested = max(self.max_requested, size)
        return super().read(size)


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
            source = Path(d) / "source.mp4"
            source.write_bytes(b"data")
            comfy._fill_videos(target, wf, slots["video_slots"],
                               [comfy._MediaUpload("../../evil.mp4", source, 4)], d)
            written = Path(wf["1"]["inputs"]["video"]).resolve()
            mvhub = (Path(d) / "mvhub").resolve()
            # mvhub 안에 evil.mp4 로만 저장(상위로 탈출 금지).
            self.assertEqual(written.name, "evil.mp4")
            self.assertTrue(str(written).startswith(str(mvhub)))
            self.assertTrue(written.exists())


class UploadNameCollisionTests(unittest.TestCase):
    """병렬 배치에서 잡 간 업로드 파일명 충돌 방지 — 잡 uuid 접두로 유일화.

    프론트가 주는 이름은 image1.png 식이라, 잡 B 의 업로드(overwrite=true)가 잡 A 의
    input/mvhub/image1.png 를 덮어써 A 가 B 의 이미지로 실행되는 무오류 오답이 났다."""

    def _run_inject(self, job_id: str) -> list[str]:
        wf = {"1": {"class_type": "LoadImage", "inputs": {"image": "x.png"}}}
        uploaded: list[str] = []
        orig = comfy.comfy_client.upload_file

        def fake_upload(target, fname, path, subfolder="mvhub"):
            uploaded.append(fname)
            self.assertTrue(Path(path).is_file())
            return f"mvhub/{fname}"

        comfy.comfy_client.upload_file = fake_upload
        with TemporaryDirectory() as d:
            path = Path(d) / "image1.png"
            path.write_bytes(b"a")
            try:
                target = {"cloud": False, "base": "http://x", "prefix": "", "headers": {}}
                comfy._inject_media_files(
                    target,
                    wf,
                    [{"type": "image"}],
                    [comfy._MediaUpload("image1.png", path, 1)],
                    "",
                    job_id,
                )
            finally:
                comfy.comfy_client.upload_file = orig
        # 노드 입력에도 업로드된(접두 붙은) 이름이 그대로 주입된다.
        self.assertEqual(wf["1"]["inputs"]["image"], f"mvhub/{uploaded[0]}")
        return uploaded

    def test_two_jobs_upload_distinct_names(self):
        a = self._run_inject("aaaaaaaaaaaa1111")
        b = self._run_inject("bbbbbbbbbbbb2222")
        self.assertNotEqual(a[0], b[0])
        self.assertTrue(a[0].startswith("aaaaaaaaaaaa-"))
        self.assertTrue(a[0].endswith("image1.png"))

    def test_same_filename_twice_in_one_job_stays_distinct(self):
        # 한 잡 안에서 같은 원본 이름 2개(두 슬롯) — 순번 접두가 없으면 둘 다 같은 이름이 돼
        # overwrite=true 로 두 번째가 첫 번째를 덮는다(코덱스 P1).
        wf = {
            "1": {"class_type": "LoadImage", "inputs": {"image": "x.png"}},
            "2": {"class_type": "LoadImage", "inputs": {"image": "y.png"}},
        }
        uploaded: list[str] = []
        orig = comfy.comfy_client.upload_file

        def fake_upload(target, fname, path, subfolder="mvhub"):
            uploaded.append(fname)
            return f"mvhub/{fname}"

        comfy.comfy_client.upload_file = fake_upload
        with TemporaryDirectory() as d:
            first = Path(d) / "first.png"
            second = Path(d) / "second.png"
            first.write_bytes(b"a")
            second.write_bytes(b"b")
            try:
                target = {"cloud": False, "base": "http://x", "prefix": "", "headers": {}}
                comfy._inject_media_files(
                    target, wf,
                    [{"type": "image"}, {"type": "image"}],
                    [
                        comfy._MediaUpload("image1.png", first, 1),
                        comfy._MediaUpload("image1.png", second, 1),
                    ],
                    "", "cccccccccccc3333",
                )
            finally:
                comfy.comfy_client.upload_file = orig
        self.assertEqual(len(uploaded), 2)
        self.assertNotEqual(uploaded[0], uploaded[1])

    def test_without_job_id_keeps_original_name(self):
        # 하위 호환 — job_id 없이 호출되면 기존 이름 유지.
        uploaded = self._run_inject("")
        self.assertEqual(uploaded[0], "image1.png")


class MediaStagingTests(unittest.TestCase):
    def test_stage_uses_bounded_copy_and_cleanup(self):
        from starlette.datastructures import UploadFile

        stream = _TrackingStream(b"x" * (2 * 1024 * 1024 + 17))
        upload = UploadFile(stream, filename="large.png")
        staged = comfy._stage_media_uploads([upload])
        try:
            self.assertEqual(len(staged), 1)
            self.assertEqual(staged[0].size, 2 * 1024 * 1024 + 17)
            self.assertEqual(staged[0].path.stat().st_size, staged[0].size)
            self.assertLessEqual(stream.max_requested, 1024 * 1024)
        finally:
            paths = [item.path for item in staged]
            comfy._cleanup_media_uploads(staged)
        self.assertTrue(all(not path.exists() for path in paths))

    def test_run_impl_cleans_staging_when_injection_fails(self):
        with TemporaryDirectory() as d:
            path = Path(d) / "staged.part"
            path.write_bytes(b"x")
            upload = comfy._MediaUpload("x.png", path, 1)
            settings = {
                "comfy_target": "local",
                "comfy_url": "http://127.0.0.1:8188",
                "comfy_api_key": "",
                "comfy_input_dir": "",
            }
            with mock.patch.object(
                comfy, "_inject_media_files", side_effect=ValueError("bad workflow")
            ):
                with self.assertRaises(comfy.HTTPException) as cm:
                    comfy._run_comfy_job_impl("job", {"1": {}}, {}, [], [upload], settings)
            self.assertEqual(cm.exception.status_code, 400)
            self.assertFalse(path.exists())

    def test_run_cleans_staging_when_thread_start_fails(self):
        with TemporaryDirectory() as d:
            path = Path(d) / "staged.part"
            path.write_bytes(b"x")
            staged = [comfy._MediaUpload("x.png", path, 1)]
            with mock.patch.object(comfy, "_stage_media_uploads", return_value=staged), \
                 mock.patch.object(comfy, "_raw_settings", return_value={}), \
                 mock.patch.object(comfy, "_create_run_job", return_value="job"), \
                 mock.patch.object(comfy, "_fail_run_job"), \
                 mock.patch.object(comfy.threading.Thread, "start", side_effect=OSError("no thread")):
                with self.assertRaises(comfy.HTTPException) as cm:
                    comfy.run(
                        content='{"1":{"class_type":"LoadImage","inputs":{}}}',
                        param_values="{}",
                        media_meta='[{"type":"image"}]',
                        media=[mock.Mock()],
                    )
            self.assertEqual(cm.exception.status_code, 500)
            self.assertFalse(path.exists())


class RunGateTests(unittest.TestCase):
    def tearDown(self):
        # 게이트 카운터를 다른 테스트에 안 넘기도록 0 으로 되돌린다.
        with comfy._RUN_GATE:
            comfy._RUN_SLOTS_ACTIVE = 0
            comfy._RUN_GATE.notify_all()

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

    def test_release_wakes_mixed_capacity_waiters(self):
        # active=3 에 cap 2/3 대기자가 함께 있으면, 한 슬롯 반납(active=2) 뒤에는 cap=3만
        # 들어갈 수 있다. notify()가 먼저 온 cap=2만 깨우면 cap=3은 30초 wait timeout까지
        # 잠든다. notify_all()은 둘을 깨워 cap=3이 즉시 진행하게 한다.
        low_entered = threading.Event()
        high_entered = threading.Event()

        def low_cap_waiter():
            comfy._acquire_run_slot(2)
            low_entered.set()

        def high_cap_waiter():
            comfy._acquire_run_slot(3)
            high_entered.set()

        def wait_for_waiters(count: int) -> None:
            until = time.monotonic() + 1.0
            while time.monotonic() < until:
                with comfy._RUN_GATE:
                    if len(comfy._RUN_GATE._waiters) >= count:  # Condition 내부 대기열(테스트 동기화용)
                        return
                time.sleep(0.01)
            self.fail(f"게이트 대기자 {count}명이 준비되지 않았습니다")

        with comfy._RUN_GATE:
            comfy._RUN_SLOTS_ACTIVE = 3
        threading.Thread(target=low_cap_waiter, daemon=True).start()
        wait_for_waiters(1)  # 낮은 cap을 먼저 대기열에 넣어 기존 notify() 결함도 재현 가능하게 한다.
        threading.Thread(target=high_cap_waiter, daemon=True).start()
        wait_for_waiters(2)

        comfy._release_run_slot()  # active=2 → cap=3 대기자가 즉시 들어가야 한다.
        self.assertTrue(high_entered.wait(0.5))
        self.assertFalse(low_entered.is_set())
        # 남은 가상 슬롯 두 개를 반납하면 cap=2 대기자도 끝까지 진행한다.
        comfy._release_run_slot()
        comfy._release_run_slot()
        self.assertTrue(low_entered.wait(0.5))


class WaitResilienceTests(unittest.TestCase):
    def test_local_poll_transient_errors_below_limit_survive(self):
        # N-1회의 일시 연결 오류 뒤 실제 완료 history를 받으면, 전체 30분 잡을 502로 끝내지 않는다.
        errors = [comfy.comfy_client.ComfyError("temporary") for _ in range(2)]
        history = {"status": {"completed": True}, "outputs": {}}
        target = {"cloud": False, "base": "http://x", "prefix": "", "headers": {}}
        with mock.patch.object(comfy, "_POLL_ERROR_RETRY_LIMIT", 3), \
             mock.patch.object(comfy.comfy_client, "get_history", side_effect=[*errors, history]) as get_history, \
             mock.patch.object(comfy.time, "sleep", lambda _s: None):
            self.assertEqual(comfy._wait(target, "pid"), history)
        self.assertEqual(get_history.call_count, 3)

    def test_cloud_poll_transient_errors_below_limit_survive(self):
        errors = [comfy.comfy_client.ComfyError("temporary") for _ in range(2)]
        target = {"cloud": True, "base": "https://cloud.comfy.org", "prefix": "/api", "headers": {}}
        with mock.patch.object(comfy, "_POLL_ERROR_RETRY_LIMIT", 3), \
             mock.patch.object(comfy.comfy_client, "cloud_job_status",
                               side_effect=[*errors, "completed"]), \
             mock.patch.object(comfy.comfy_client, "cloud_job_detail", return_value={"outputs": {}}), \
             mock.patch.object(comfy.time, "sleep", lambda _s: None):
            self.assertEqual(comfy._wait(target, "pid"), {"outputs": {}})


class InflightRunPersistenceTests(unittest.TestCase):
    def test_submitted_run_is_persisted_then_removed_on_finish(self):
        values: dict[str, str] = {}

        def get_setting(key, default=None):
            return values.get(key, default)

        def set_setting(key, value):
            values[key] = value

        with mock.patch.object(comfy.repo, "get_setting", get_setting), \
             mock.patch.object(comfy.repo, "set_setting", set_setting):
            comfy._track_inflight_run("job-1", "prompt-1", "cloud")
            rows = json.loads(values[comfy._K_INFLIGHT_RUNS])
            self.assertEqual(rows[0]["job_id"], "job-1")
            self.assertEqual(rows[0]["prompt_id"], "prompt-1")
            self.assertEqual(rows[0]["target"], "cloud")
            self.assertIn("created_at", rows[0])
            comfy._forget_inflight_run("job-1")
        self.assertEqual(json.loads(values[comfy._K_INFLIGHT_RUNS]), [])

    def test_restart_logs_cloud_job_cancels_and_clears_store(self):
        values = {
            comfy._K_INFLIGHT_RUNS: (
                '[{"job_id":"job-1","prompt_id":"cloud-prompt","target":"cloud","created_at":1},'
                '{"job_id":"job-2","prompt_id":"local-prompt","target":"local","created_at":2}]'
            )
        }

        def get_setting(key, default=None):
            return values.get(key, default)

        def set_setting(key, value):
            values[key] = value

        with mock.patch.object(comfy.repo, "get_setting", get_setting), \
             mock.patch.object(comfy.repo, "set_setting", set_setting), \
             mock.patch.object(comfy, "_raw_settings", return_value={"comfy_api_key": "key"}), \
             mock.patch.object(comfy.comfy_client, "cloud_cancel_pending") as cancel:
            comfy.recover_interrupted_run_jobs()
        cancel.assert_called_once()
        self.assertEqual(cancel.call_args.args[1], "cloud-prompt")
        self.assertEqual(json.loads(values[comfy._K_INFLIGHT_RUNS]), [])

    def test_restart_skips_cloud_cancel_when_external_recovery_disabled(self):
        """복원 드릴(격리 서버) 계약 — 사본 DB의 키로 라이브 Cloud 잡을 취소하면 안 된다.

        CONTENT_HUB_EXTERNAL_RECOVERY=0 이면 취소 호출 없이 로그만 남기고 흔적은 비운다
        (사본이므로 비워도 무해, 반복 로그 방지).
        """
        values = {
            comfy._K_INFLIGHT_RUNS: (
                '[{"job_id":"job-1","prompt_id":"cloud-prompt","target":"cloud","created_at":1}]'
            )
        }

        def get_setting(key, default=None):
            return values.get(key, default)

        def set_setting(key, value):
            values[key] = value

        with mock.patch.object(comfy.repo, "get_setting", get_setting), \
             mock.patch.object(comfy.repo, "set_setting", set_setting), \
             mock.patch.object(comfy, "EXTERNAL_RECOVERY_ENABLED", False), \
             mock.patch.object(comfy, "_raw_settings") as raw_settings, \
             mock.patch.object(comfy.comfy_client, "cloud_cancel_pending") as cancel:
            comfy.recover_interrupted_run_jobs()
        cancel.assert_not_called()
        raw_settings.assert_not_called()  # 설정(키) 접근 자체가 없어야 한다
        self.assertEqual(json.loads(values[comfy._K_INFLIGHT_RUNS]), [])


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
