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
# fps/tbr 은 비디오 스트림 줄에만 있다. 앵커 없이 전체 stderr 를 뒤지면 컨테이너 Metadata 의
# 자유 텍스트(예: comment "captured at 60 fps")를 프레임레이트로 오인해 -r 을 잘못 강제한다.
_VIDEO_STREAM_RE = re.compile(r"^\s*Stream #\d+[:.]\d+.*\bVideo:")


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
    stream_lines = [ln for ln in txt.splitlines() if _VIDEO_STREAM_RE.search(ln)]
    for pat in (r"(\d+(?:\.\d+)?)\s*fps", r"(\d+(?:\.\d+)?)\s*tbr"):
        for line in stream_lines:
            m = re.search(pat, line)
            if m:
                try:
                    f = float(m.group(1))
                except ValueError:
                    continue
                if 1.0 <= f <= 240.0:
                    return f
    return None


def to_cloud_mp4_path(source: Path, timeout: int = 180) -> Path:
    """파일 경로를 H.264 MP4로 변환하고 결과 경로를 반환한다.

    ffmpeg가 없으면 원본 경로를 그대로 반환한다. 새 결과는 호출자가 사용 후 지워야 하며, 변환 실패
    시에는 이 함수가 부분 결과를 지운다. 운영 Comfy 경로는 이 함수를 써 원본·변환본을 bytes로
    동시에 올리지 않는다.
    """
    src = Path(source)
    ff = find_ffmpeg()
    if not ff:
        return src
    fd, raw_path = tempfile.mkstemp(prefix="mvhub-comfy-converted-", suffix=".mp4")
    os.close(fd)
    dst = Path(raw_path)
    try:
        # 원본 fps 를 감지해 유효하면 보존, 못 읽으면(깨진 0-fps) 기본값 강제 — 명시적 CFR 로 출력해야
        # Cloud VHS 가 프레임레이트를 0(Fraction(1,0))으로 읽지 않는다.
        fps = _probe_fps(ff, src) or _DEFAULT_FPS
        try:
            source_size = src.stat().st_size
        except OSError:
            source_size = -1
        log.info("cloud video transcode: %d bytes, fps=%s", source_size, fps)
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
        if dst.stat().st_size <= 0:
            raise VideoConvertError("영상 변환 결과가 비어 있습니다(ffmpeg)")
        return dst
    except Exception:
        dst.unlink(missing_ok=True)
        raise
