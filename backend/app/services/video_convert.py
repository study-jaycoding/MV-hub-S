"""입력 영상을 Comfy Cloud 호환 MP4(H.264)로 변환.

Comfy Cloud 는 표준 코덱·정상 프레임레이트 영상만 받는다(예: 프레임레이트 메타가 0 이면
'Could not convert the input video to MP4 ... Fraction(1, 0)' 로 실패). ffmpeg 로 재인코딩하면
깨진/0 프레임레이트 메타데이터가 실제 값으로 다시 쓰여 Cloud 가 받아들인다.

ffmpeg 는 '외부 실행파일'을 subprocess 로 호출하는 것이라 파이썬 새 의존성이 아니다.
ffmpeg 가 없으면 원본을 그대로 반환(호출부가 최선-노력으로 원본 업로드).
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

log = logging.getLogger("comfy.video")

_DEFAULT_FPS = 16.0  # 원본 fps 를 못 읽을 때(깨진 0-fps 등) 강제할 안전 기본값


class VideoConvertError(RuntimeError):
    """ffmpeg 변환 자체가 실패(코덱/손상/타임아웃 등)."""


def find_ffmpeg() -> str | None:
    """ffmpeg 실행파일 경로 — 환경변수(CONTENT_HUB_FFMPEG) 우선, 그다음 PATH."""
    env = os.environ.get("CONTENT_HUB_FFMPEG")
    if env and Path(env).exists():
        return env
    return shutil.which("ffmpeg")


def _probe_fps(ff: str, src: Path) -> float | None:
    """원본 프레임레이트를 읽는다(ffprobe 없이 ffmpeg -i 의 stderr 파싱). 유효한 값(1~240)만 반환.

    깨진 영상은 '0 fps' 로 나오거나 값이 없어 None → 호출부가 기본값을 강제한다.
    """
    try:
        p = subprocess.run([ff, "-hide_banner", "-i", str(src)],
                           capture_output=True, timeout=30)
    except (subprocess.SubprocessError, OSError):
        return None
    txt = (p.stderr or b"").decode("utf-8", "replace")
    for pat in (r"(\d+(?:\.\d+)?)\s*fps", r"(\d+(?:\.\d+)?)\s*tbr"):
        m = re.search(pat, txt)
        if m:
            try:
                f = float(m.group(1))
            except ValueError:
                continue
            if 1.0 <= f <= 240.0:
                return f
    return None


def to_cloud_mp4(data: bytes, timeout: int = 180) -> bytes:
    """영상 바이트를 H.264 MP4(yuv420p, faststart, 무음)로 재인코딩해 반환.

    · ffmpeg 가 없으면 원본을 그대로 반환한다(변환 불가 — 호출부가 최선-노력으로 처리).
    · 변환 실패(코덱/손상/타임아웃)면 VideoConvertError.
    · ★오디오는 '무음 트랙'으로 교체한다 — Cloud 의 VHS LoadVideo 는 오디오를 추출하므로, 오디오가 없으면
      'VHS failed to extract audio' 로 실패한다. 무음(anullsrc) 스테레오 트랙을 영상 길이에 맞춰(-shortest)
      넣어 항상 추출 가능하게 한다(r2v 등 영상 입력엔 실제 오디오가 불필요).
    · 프레임레이트는 강제하지 않는다 — 재인코딩만으로 유효한 fps 헤더가 새로 써져 0-fps 문제가 해소되고,
      원본 프레임 타이밍(r2v 레퍼런스 길이)이 최대한 보존된다.
    """
    ff = find_ffmpeg()
    if not ff:
        return data  # ffmpeg 없음 → 변환 못 함(원본 유지)
    with tempfile.TemporaryDirectory(prefix="mvhub_vid_") as td:
        src = Path(td) / "in"
        dst = Path(td) / "out.mp4"
        src.write_bytes(data)
        # 원본 fps 를 감지해 유효하면 보존, 못 읽으면(깨진 0-fps) 기본값 강제 — 명시적 CFR 로 출력해야
        # Cloud VHS 가 프레임레이트를 0(Fraction(1,0))으로 읽지 않는다.
        fps = _probe_fps(ff, src) or _DEFAULT_FPS
        log.info("cloud video transcode: %d bytes, fps=%s", len(data), fps)
        cmd = [
            ff, "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(src),
            "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
            "-map", "0:v:0", "-map", "1:a:0",  # 영상=원본, 오디오=무음(항상 1개 트랙 보장)
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-r", str(fps), "-vsync", "cfr",  # 명시적 고정 프레임레이트(0-fps 해소)
            "-c:a", "aac",
            "-shortest",  # 무음 트랙을 영상 길이에 맞춤
            "-movflags", "+faststart",
            str(dst),
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise VideoConvertError(f"영상 변환 시간 초과({timeout}s, ffmpeg)")
        except OSError as e:
            raise VideoConvertError(f"ffmpeg 실행 실패: {e}")
        if proc.returncode != 0 or not dst.exists():
            err = (proc.stderr or b"").decode("utf-8", "replace").strip()[-400:]
            raise VideoConvertError(f"영상 변환 실패(ffmpeg): {err or '알 수 없는 오류'}")
        out = dst.read_bytes()
        if not out:
            raise VideoConvertError("영상 변환 결과가 비어 있습니다(ffmpeg)")
        return out
