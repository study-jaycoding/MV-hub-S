"""Kling 영상 수정 — 받지 못할 수 있는 영상은 create 직전에 H.264 사본으로 보내고(ffmpeg 가 있으면), 없으면 과금 전에 멈춘다.
가짜 CLI·가짜 ffmpeg 로 에이전트 _submit_one 의 인자·순서·정리만 본다(유료 호출·실제 ffmpeg 없음).
설계·합의: docs/status/Kling_영상수정_코덱변환_2026-10-28.md"""
import hashlib
import importlib.util
import os
import struct
import subprocess
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app import db, repo
from app.repo import manage
from app.routers import ingest as ingest_routes


def load_agent():
    path = Path(__file__).resolve().parents[2] / "agent_push.py"
    spec = importlib.util.spec_from_file_location("kling_convert_agent", path)
    agent = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(agent)
    return agent


def box(kind: str, payload: bytes = b"") -> bytes:
    return struct.pack(">I", 8 + len(payload)) + kind.encode("latin-1") + payload


def big_box(kind: str, payload: bytes) -> bytes:  # 64비트 크기 상자
    return struct.pack(">I", 1) + kind.encode("latin-1") + struct.pack(">Q", 16 + len(payload)) + payload


def mp4(codec="hvc1", width=854, height=480, profile=2, bit_depth=10, moov_last=False, video_traks=1, entries=1,
        large_moov=False, open_mdat=False, bad_config=False, bad_audio_trak=False) -> bytes:
    """ftyp + (소리 trak 먼저, 영상 trak) moov + mdat — 머리 읽기에 필요한 상자만."""
    if codec in ("avc1", "avc3"):
        config = box("avcC", bytes([1, profile, 0, 31, 0xFF, 0xE1]))
    else:
        config = box("hvcC", bytes([1, profile & 0x1F]) + bytes(15) + bytes([0xF8 | (bit_depth - 8)]) * 2 + bytes(4))
    if bad_config:  # 표본 항목 안 설정 상자의 크기가 항목 밖까지 — 판별 불가여야 한다(Codex 독립 리뷰 P3)
        config = struct.pack(">I", len(config) + 100) + config[4:]
    entry_body = bytes(24) + struct.pack(">HH", width, height) + bytes(50) + config
    entry = struct.pack(">I", 8 + len(entry_body)) + codec.encode("latin-1") + entry_body
    stsd = box("stsd", bytes(4) + struct.pack(">I", entries) + entry * entries)

    def trak(handler: bytes, sample: bytes) -> bytes:
        hdlr = box("hdlr", bytes(8) + handler + bytes(12))
        return box("trak", box("mdia", hdlr + box("minf", box("stbl", sample))))

    audio = trak(b"soun", box("stsd", bytes(8)))
    if bad_audio_trak:  # 소리 trak 의 hdlr 크기가 mdia 밖까지 — 영상 trak 이 멀쩡해도 판별 불가여야 한다(Codex 독립 리뷰 2차 P3)
        audio = box("trak", box("mdia", struct.pack(">I", 999) + b"hdlr" + bytes(8)))
    traks = audio + trak(b"vide", stsd) * video_traks
    moov = big_box("moov", traks) if large_moov else box("moov", traks)
    head = box("ftyp", b"isom" + bytes(4) + b"isomavc1")
    if open_mdat:  # 크기 0 = 파일 끝까지(마지막 상자)
        return head + moov + struct.pack(">I", 0) + b"mdat" + b"\x00" * 64
    mdat = box("mdat", b"\x00" * 64)
    return head + (mdat + moov if moov_last else moov + mdat)


# ── 판별(로컬 정책) · 파서 경계 ──

@pytest.mark.parametrize("kwargs, verdict", [
    ({}, "out_of_range"),  # 앱의 Seedance 2.5 결과(HEVC 10비트 854×480)
    ({"codec": "avc1", "width": 1280, "height": 720, "profile": 100}, "skip"),
    ({"codec": "avc3", "width": 720, "height": 1280, "profile": 77}, "skip"),  # 세로 — 짧은 변 720
    ({"codec": "avc1", "width": 1920, "height": 1080, "profile": 110}, "convert"),  # High10
    ({"codec": "hvc1", "width": 1920, "height": 1080, "profile": 1, "bit_depth": 8}, "convert"),
    ({"codec": "avc1", "width": 4096, "height": 2304, "profile": 100}, "out_of_range"),
    ({"moov_last": True}, "out_of_range"),  # 머리가 파일 끝에 있어도(mdat 은 읽지 않고 건너뜀)
    ({"large_moov": True}, "out_of_range"),  # 64비트 크기 상자
    ({"open_mdat": True}, "out_of_range"),  # 크기 0(끝까지) 상자
])
def test_probe_and_verdict(tmp_path, kwargs, verdict):
    agent = load_agent()
    path = tmp_path / "v.mp4"
    path.write_bytes(mp4(**kwargs))
    assert agent._kling_video_verdict(agent._probe_video_format(str(path))) == verdict


def test_probe_reads_codec_size_profile_bit_depth(tmp_path):
    agent = load_agent()
    path = tmp_path / "v.mp4"
    path.write_bytes(mp4())
    assert agent._probe_video_format(str(path)) == {"codec": "hvc1", "width": 854, "height": 480, "profile": 2, "bit_depth": 10}


def test_probe_unknown_for_ambiguous_or_broken_files(tmp_path):
    agent = load_agent()
    whole = mp4()
    cases = [mp4(video_traks=2), mp4(entries=2), whole[:-70],  # 영상 trak 둘 · stsd 항목 둘 · 잘림
             mp4(bad_config=True),  # 설정 상자 깨짐 — 크기는 읽혀도 '범위 밖'이 아니라 판별 불가
             mp4(codec="avc1", width=1280, height=720, profile=100, bad_audio_trak=True),  # 깨진 소리 trak — 'skip' 이 아니라 판별 불가
             struct.pack(">I", 999) + b"moov", b"not a video", b""]
    for data in cases:
        path = tmp_path / "x.mp4"
        path.write_bytes(data)
        assert agent._probe_video_format(str(path)) is None
    assert agent._probe_video_format(str(tmp_path / "missing.mp4")) is None
    assert agent._kling_video_verdict(None) == "unknown"


@pytest.mark.parametrize("kwargs", [{}, {"moov_last": True}, {"open_mdat": True}, {"large_moov": True}])
def test_probe_never_reads_mdat_payload(monkeypatch, kwargs):
    """상자 머리만 읽는다 — mdat 내용은 한 바이트도 읽지 않는다(Codex 독립 리뷰 2차 P3: 머리를 16바이트씩 읽어 내용 8바이트를 읽던 것)."""
    import io
    agent = load_agent()
    data = mp4(**kwargs)
    at = data.index(b"mdat") - 4
    payload = range(at + 8, len(data) if kwargs.get("open_mdat") else at + struct.unpack(">I", data[at:at + 4])[0])
    reads = []

    class Recording(io.BytesIO):
        def read(self, n=-1):
            start = self.tell()
            chunk = super().read(n)
            reads.append(range(start, start + len(chunk)))
            return chunk

    monkeypatch.setattr(agent, "open", lambda *_a, **_k: Recording(data), raising=False)
    assert agent._probe_video_format("v.mp4") is not None
    assert reads and not [r for r in reads if r.start < payload.stop and payload.start < r.stop]


# ── 변환 함수(가짜 ffmpeg) ──

def fake_run(result=0, stderr=b"", write=b"converted", raise_exc=None, hold=None, seen=None):
    def run(cmd, **kwargs):
        assert cmd[cmd.index("-i") + 1] == "SOURCE" and "-nostdin" in cmd and "-y" in cmd
        assert kwargs["timeout"] == 300 and kwargs["capture_output"] is True
        if seen is not None:
            seen.append(cmd)
        if hold:
            hold()
        if raise_exc:
            raise raise_exc
        Path(cmd[-1]).write_bytes(write)
        return SimpleNamespace(returncode=result, stderr=stderr)
    return run


def test_transcode_success_keeps_copy_and_releases_slot(monkeypatch):
    agent = load_agent()
    seen = []
    monkeypatch.setattr(agent.subprocess, "run", fake_run(seen=seen))
    copy, reason = agent._transcode_for_kling("ff", "SOURCE")
    assert reason is None and Path(copy).read_bytes() == b"converted"
    cmd = seen[0]
    assert cmd[cmd.index("-map") + 1] == "0:v:0" and "0:a:0?" in cmd and cmd[cmd.index("-pix_fmt") + 1] == "yuv420p"
    Path(copy).unlink()
    assert agent._KLING_TRANSCODE_SLOTS.acquire(blocking=False) and agent._KLING_TRANSCODE_SLOTS.acquire(blocking=False)


@pytest.mark.parametrize("case", ["exit", "timeout", "oserror", "empty", "too_big"])
def test_transcode_failure_removes_copy_and_returns_reason(monkeypatch, tmp_path, case):
    agent = load_agent()
    made = []
    real_mkstemp = agent.tempfile.mkstemp

    def mkstemp(**kwargs):
        fd, path = real_mkstemp(dir=tmp_path, **kwargs)
        made.append(path)
        return fd, path

    monkeypatch.setattr(agent.tempfile, "mkstemp", mkstemp)
    run = {
        "exit": fake_run(result=1, stderr="잘못된 데이터".encode("cp949")),  # UTF-8 이 아닌 바이트 — errors=replace
        "timeout": fake_run(raise_exc=subprocess.TimeoutExpired("ff", 300)),
        "oserror": fake_run(raise_exc=OSError("disk full")),
        "empty": fake_run(write=b""),
        "too_big": fake_run(write=b"x" * 16),
    }[case]
    monkeypatch.setattr(agent.subprocess, "run", run)
    if case == "too_big":
        monkeypatch.setattr(agent, "_KLING_MAX_BYTES", 8)
    copy, reason = agent._transcode_for_kling("ff", "SOURCE")
    assert copy is None and reason
    assert {"timeout": "300초", "oserror": "disk full", "empty": "비었습니다", "too_big": "200MB"}.get(case, "") in reason
    assert made and not any(os.path.exists(p) for p in made)  # 실패하면 사본을 남기지 않는다


def test_transcode_unexpected_exception_still_removes_copy_and_slot(monkeypatch, tmp_path):
    """예상 밖 예외(위에서 안 잡는 종류)로 빠져나가도 사본을 지우고 차례를 돌려준다(Codex 독립 리뷰 P2)."""
    agent = load_agent()
    real_mkstemp = agent.tempfile.mkstemp
    monkeypatch.setattr(agent.tempfile, "mkstemp", lambda **kw: real_mkstemp(dir=tmp_path, **kw))
    monkeypatch.setattr(agent.subprocess, "run", fake_run(raise_exc=RuntimeError("can't start new thread")))
    with pytest.raises(RuntimeError):
        agent._transcode_for_kling("ff", "SOURCE")
    assert list(tmp_path.glob("mvhub-kling-*")) == []
    assert agent._KLING_TRANSCODE_SLOTS.acquire(blocking=False) and agent._KLING_TRANSCODE_SLOTS.acquire(blocking=False)


def test_transcode_temp_file_failure_is_a_reason_not_an_exception(monkeypatch):
    agent = load_agent()
    monkeypatch.setattr(agent.tempfile, "mkstemp", MagicMock(side_effect=OSError("no space")))
    assert agent._transcode_for_kling("ff", "SOURCE") == (None, "no space")


def test_at_most_two_conversions_run_at_once(monkeypatch):
    agent = load_agent()
    lock, running, peak, release = threading.Lock(), [0], [0], threading.Event()

    def hold():
        with lock:
            running[0] += 1
            peak[0] = max(peak[0], running[0])
        release.wait(5)
        with lock:
            running[0] -= 1

    monkeypatch.setattr(agent.subprocess, "run", fake_run(hold=hold))
    results = []
    threads = [threading.Thread(target=lambda: results.append(agent._transcode_for_kling("ff", "SOURCE"))) for _ in range(3)]
    for t in threads:
        t.start()
    time.sleep(0.3)
    assert peak[0] == 2  # 셋째는 차례를 기다린다
    release.set()
    for t in threads:
        t.join(5)
    assert len(results) == 3 and all(copy for copy, _ in results)
    for copy, _ in results:
        Path(copy).unlink()


# ── _submit_one(가짜 CLI) ──

def kling_request(model="kling_video_edit", rid="r1", **extra):
    params = {"mode": "pro"} if model == "kling_video_edit" else {"mode": "video-edit", "resolution": "720p", "duration": 4}
    request = {"id": rid, "model": model, "prompt": "fix the beard", "params": params, "claim_phase": "claimed",
               "workspace": {"scope": "personal", "id": None, "name": None},
               "references": [{"file_path": "source.mp4", "type": "video", "role": "video"},
                              {"file_path": "frame.png", "type": "image", "role": "image_references"}]}
    request.update(extra)
    return request


@pytest.fixture
def harness(monkeypatch, tmp_path):
    agent = load_agent()
    source = tmp_path / "source.mp4"
    source.write_bytes(mp4())
    frame = tmp_path / "frame.png"
    frame.write_bytes(b"png")
    cache = {"source.mp4": str(source), "frame.png": str(frame)}
    monkeypatch.setattr(agent, "_allowed_params", lambda *_: {"mode", "resolution", "duration", "video"})
    monkeypatch.setattr(agent, "_ensure_request_workspace", lambda *_: ("workspace-1", None))
    begin = MagicMock(return_value=True)
    monkeypatch.setattr(agent, "_begin_submission", begin)
    run = MagicMock(return_value=(["12345678-1234-1234-1234-123456789abc"], None))
    monkeypatch.setattr(agent, "_run_cli_json", run)
    monkeypatch.setattr(agent, "_anchor_tracked_safe", MagicMock())
    for name in ("_fail", "_release_claim", "_require_submission_recovery"):
        monkeypatch.setattr(agent, name, MagicMock())
    copies = []

    def fake_transcode(ff, src):
        assert ff == "ffmpeg-path" and src == str(source)
        dst = tmp_path / f"copy{len(copies)}.mp4"
        dst.write_bytes(mp4(codec="avc1", width=1282, height=720, profile=100))
        copies.append(dst)
        return str(dst), None

    real_transcode = agent._transcode_for_kling
    monkeypatch.setattr(agent, "_ffmpeg_h264", lambda: "ffmpeg-path")
    monkeypatch.setattr(agent, "_transcode_for_kling", fake_transcode)

    def submit(request):
        return agent._submit_one("http://hub", "token", "fake-cli", "artist@example.com", request,
                                 cache, {}, agent.Lock(), agent.Lock(), "agent-1")

    return SimpleNamespace(agent=agent, source=source, cache=cache, begin=begin, run=run, copies=copies, submit=submit,
                           real_transcode=real_transcode, tmp_path=tmp_path)


def video_arg(run):
    args = run.call_args.args
    return args[args.index("--video") + 1]


@pytest.mark.parametrize("model", ["kling_video_edit", "kling4_0"])
def test_unacceptable_video_goes_as_converted_copy_and_copy_is_removed(harness, model):
    h = harness
    original = h.source.read_bytes()
    cache_before = dict(h.cache)
    result = h.submit(kling_request(model))
    assert result["job_id"] == "12345678-1234-1234-1234-123456789abc"
    assert video_arg(h.run) == str(h.copies[0])  # 사본을 올린다
    h.agent._fail.assert_not_called()
    refs = h.begin.call_args.args[4]["submitted_refs"]
    assert refs[0]["sha256"] == hashlib.sha256(original).hexdigest()  # 지문은 원본
    assert refs[0]["transcoded"] == "h264"
    assert h.source.read_bytes() == original and h.cache == cache_before  # 원본·ref_cache 그대로
    assert not h.copies[0].exists()  # 요청이 끝나면 사본을 지운다


def test_same_source_in_two_requests_gets_two_copies(harness):
    h = harness
    h.submit(kling_request(rid="r1"))
    h.submit(kling_request(rid="r2"))
    assert len(h.copies) == 2 and h.copies[0] != h.copies[1]
    assert not any(c.exists() for c in h.copies)


@pytest.mark.parametrize("stage", ["cmdline", "digest", "workspace", "begin", "cli"])
def test_copy_is_removed_whatever_fails_after_conversion(harness, monkeypatch, stage):
    h = harness
    request = kling_request()
    if stage == "cmdline":
        monkeypatch.setattr(h.agent, "_WIN_CMDLINE_MAX", 10)
    elif stage == "digest":
        request["references"][0]["expected_asset_content_id"] = "sha256:" + "0" * 64
    elif stage == "workspace":
        monkeypatch.setattr(h.agent, "_ensure_request_workspace", lambda *_: (None, "no workspace"))
    elif stage == "begin":
        h.begin.return_value = False
    else:
        h.run.return_value = (None, "CLI error")
    assert h.submit(request) is None
    assert len(h.copies) == 1 and not h.copies[0].exists()


def test_no_ffmpeg_and_out_of_range_fails_before_any_paid_call(harness, monkeypatch):
    h = harness
    monkeypatch.setattr(h.agent, "_ffmpeg_h264", lambda: None)
    assert h.submit(kling_request()) is None
    h.run.assert_not_called()
    h.begin.assert_not_called()
    assert h.copies == []
    reason = h.agent._fail.call_args.args[3]
    for part in ("앱의 변환 정책상", "854×480", "hvc1", "ffmpeg", "Seedance 2.5", "과금 없음"):
        assert part in reason


@pytest.mark.parametrize("outcome", ["error", "raise"])
def test_conversion_failure_or_exception_fails_before_create(harness, monkeypatch, outcome):
    h = harness

    def broken(*_args, **_kwargs):
        if outcome == "raise":
            raise RuntimeError("boom")
        return None, "Invalid data found"

    monkeypatch.setattr(h.agent, "_transcode_for_kling", broken)
    assert h.submit(kling_request()) is None  # 예외가 밖으로 새지 않는다('제출 확인 필요'로 묶이지 않게)
    h.run.assert_not_called()
    h.begin.assert_not_called()
    h.agent._require_submission_recovery.assert_not_called()
    reason = h.agent._fail.call_args.args[3]
    assert "변환" in reason and "과금 없음" in reason and ("boom" in reason or "Invalid data" in reason)


def test_real_transcode_unexpected_exception_leaves_no_copy_and_no_paid_call(harness, monkeypatch):
    """실제 변환 함수로 — 임시 파일을 만든 뒤 ffmpeg 실행이 예상 밖 예외를 내도 사본·차례가 정리되고 create 전 실패(Codex 독립 리뷰 P2)."""
    h = harness
    monkeypatch.setattr(h.agent, "_transcode_for_kling", h.real_transcode)
    real_mkstemp = h.agent.tempfile.mkstemp
    monkeypatch.setattr(h.agent.tempfile, "mkstemp", lambda **kw: real_mkstemp(dir=h.tmp_path, **kw))

    def ffmpeg(cmd, **_kw):
        assert Path(cmd[-1]).exists()  # 임시 파일은 이미 만들어졌다
        raise RuntimeError("can't start new thread")

    monkeypatch.setattr(h.agent.subprocess, "run", ffmpeg)
    assert h.submit(kling_request()) is None
    h.run.assert_not_called()
    h.begin.assert_not_called()
    assert "can't start new thread" in h.agent._fail.call_args.args[3]
    assert list(h.tmp_path.glob("mvhub-kling-*")) == []
    slots = h.agent._KLING_TRANSCODE_SLOTS
    assert slots.acquire(blocking=False) and slots.acquire(blocking=False)


def test_unknown_format_is_converted_when_ffmpeg_exists(harness):
    h = harness
    h.source.write_bytes(b"unknown container")
    h.submit(kling_request())
    assert video_arg(h.run) == str(h.copies[0])


@pytest.mark.parametrize("data, has_ffmpeg", [
    (mp4(codec="avc1", width=1280, height=720, profile=100), True),  # 변환 생략 후보 — ffmpeg 가 있어도 그대로
    (b"unknown container", False),  # 판별 불가 + ffmpeg 없음
    (mp4(codec="hvc1", width=1920, height=1080, profile=1, bit_depth=8), False),  # 범위 안 변환 대상 + ffmpeg 없음
])
def test_goes_as_is_when_skip_or_no_ffmpeg_and_not_out_of_range(harness, monkeypatch, data, has_ffmpeg):
    h = harness
    transcode = MagicMock()
    monkeypatch.setattr(h.agent, "_transcode_for_kling", transcode)
    if not has_ffmpeg:
        monkeypatch.setattr(h.agent, "_ffmpeg_h264", lambda: None)
    h.source.write_bytes(data)
    h.submit(kling_request())
    assert video_arg(h.run) == str(h.source)
    transcode.assert_not_called()
    h.agent._fail.assert_not_called()


@pytest.mark.parametrize("has_ffmpeg", [True, False])
def test_upload_id_video_goes_as_is_whatever_ffmpeg(harness, monkeypatch, has_ffmpeg):
    """레퍼런스가 업로드 ID(UUID)면 로컬 파일이 아니라 판별·변환하지 않고 지금처럼 그대로(Codex 독립 리뷰 2차 P2)."""
    h = harness
    upload_id = "abcdef01-2345-6789-abcd-ef0123456789"
    h.cache["source.mp4"] = upload_id
    monkeypatch.setattr(h.agent, "_probe_video_format", MagicMock(side_effect=AssertionError("probe")))
    transcode = MagicMock(side_effect=AssertionError("transcode"))
    monkeypatch.setattr(h.agent, "_transcode_for_kling", transcode)
    if not has_ffmpeg:
        monkeypatch.setattr(h.agent, "_ffmpeg_h264", lambda: None)
    assert h.submit(kling_request())["job_id"] == "12345678-1234-1234-1234-123456789abc"
    assert video_arg(h.run) == upload_id
    h.agent._fail.assert_not_called()
    ref = h.begin.call_args.args[4]["submitted_refs"][0]
    assert ref["upload_id"] == upload_id and "transcoded" not in ref


@pytest.mark.parametrize("key", sorted(["video", "video_references", "image_references", "image", "start_image",
                                        "end_image", "input_video", "medias"]))
def test_media_in_params_is_rejected_before_create(harness, key):
    h = harness
    request = kling_request()
    request["params"][key] = "C:/other.mp4"
    assert h.submit(request) is None
    h.run.assert_not_called()
    h.begin.assert_not_called()
    assert "레퍼런스로만" in h.agent._fail.call_args.args[3]


def test_other_models_never_probe_or_convert(harness, monkeypatch):
    h = harness
    probe = MagicMock(side_effect=AssertionError("probe"))
    monkeypatch.setattr(h.agent, "_probe_video_format", probe)
    monkeypatch.setattr(h.agent, "_allowed_params", lambda *_: {"duration", "resolution", "video"})
    request = kling_request()
    request.update(model="draw_to_video", media_protocol="media-v2", params={"duration": 5, "resolution": "720p"})
    h.submit(request)
    probe.assert_not_called()
    assert video_arg(h.run) == str(h.source)
    request = kling_request()
    request.update(model="draw_to_video", media_protocol="media-v2", params={"duration": 5, "video": "x"})
    h.submit(request)  # 우회 거절은 Kling 두 모델만 — 다른 모델의 공용 인자 처리는 그대로
    assert "레퍼런스로만" not in str(h.agent._fail.call_args)


# ── 보고 · 응답 · outbox ──

def test_account_status_reports_ffmpeg_h264(monkeypatch):
    agent = load_agent()
    monkeypatch.setattr(agent, "_cli_json", lambda _cli, *args, **_kw: {"email": "a@b.c"} if args[0] == "account" else [])
    monkeypatch.setattr(agent, "_cached_cli_version", lambda _cli: "1.2.3")
    monkeypatch.setattr(agent, "_ffmpeg_h264", lambda: "ff")
    assert agent._collect_account_status("cli")[0]["ffmpeg_h264"] is True
    monkeypatch.setattr(agent, "_ffmpeg_h264", lambda: None)
    assert agent._collect_account_status("cli")[0]["ffmpeg_h264"] is False


def test_ffmpeg_check_needs_libx264_and_is_remembered_for_ten_minutes(monkeypatch):
    agent = load_agent()
    monkeypatch.delenv("CONTENT_HUB_FFMPEG", raising=False)
    monkeypatch.setattr(agent.shutil, "which", lambda _name: "ffmpeg.exe")
    calls = []

    def encoders(cmd, **_kw):
        calls.append(cmd)
        return SimpleNamespace(returncode=0, stdout=b" V..... libx264  H.264\n" if len(calls) > 1 else b" V..... mpeg4\n")

    monkeypatch.setattr(agent.subprocess, "run", encoders)
    now = [1000.0]
    monkeypatch.setattr(agent.time, "monotonic", lambda: now[0])
    assert agent._ffmpeg_h264() is None  # libx264 없음
    assert agent._ffmpeg_h264() is None and len(calls) == 1  # 10분 동안 다시 재지 않음
    now[0] += 601
    assert agent._ffmpeg_h264() == "ffmpeg.exe" and len(calls) == 2  # 설치 뒤 다음 확인에 반영


def test_account_hf_returns_bool_or_null(monkeypatch):
    request = SimpleNamespace()
    monkeypatch.setattr(ingest_routes, "_agent_acc", lambda _req: {"email": "a@b.c"})
    for stored, expected in [({"ffmpeg_h264": True}, True), ({"ffmpeg_h264": False}, False),
                             ({}, None), ({"ffmpeg_h264": "yes"}, None)]:
        monkeypatch.setattr(ingest_routes.repo, "get_reported_status", lambda _email, s=stored: {"credits": 1, **s})
        assert ingest_routes.my_hf_status(request)["ffmpeg_h264"] is expected
    monkeypatch.setattr(ingest_routes.repo, "get_reported_status", lambda _email: None)
    assert ingest_routes.my_hf_status(request)["ffmpeg_h264"] is None


@pytest.fixture
def report_db(monkeypatch, tmp_path):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    yield
    db.flush_pool()


def test_outbox_forwards_ffmpeg_h264_unchanged(report_db):
    status = {"email": "artist@example.com", "credits": 10, "cli_version": "1.2.3", "ffmpeg_h264": True}
    manage.queue_account_reports(status, [], "artist@example.com")
    assert manage.latest_account_status_payload()["ffmpeg_h264"] is True
