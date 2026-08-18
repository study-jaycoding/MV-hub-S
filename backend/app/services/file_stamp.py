"""내보내는 파일에 '이 생성물이 무엇인지'를 새긴다(각인).

우리 프로그램을 거쳐 밖으로 나간 파일은 나중에 다시 만났을 때 정체를 알 수 있어야 한다.
그래서 파일 자체에 열쇠(gen_id)를 남기고, 나머지 정보(프롬프트·모델·레퍼런스·계보)는 그 열쇠로
카탈로그에서 찾는다. 파일에 내용을 넣지 않으므로 외주·클라이언트에 보내도 프롬프트가 새지 않고,
정보가 나중에 수정돼도 항상 최신값이 나온다.

원칙(어기면 안 됨):
  · **재인코딩 금지** — 픽셀·영상 스트림은 한 바이트도 건드리지 않는다. PNG/JPEG 는 메타 영역만
    끼워 넣고, MP4 는 `-c copy` 로 컨테이너만 다시 쓴다. 화질 손실 0.
  · **실패는 원본 통과** — 각인에 실패하면(형식 미지원·ffmpeg 없음·깨진 파일) 원본을 그대로
    내보낸다. 각인 때문에 다운로드가 막히거나 파일이 손상되는 일은 없어야 한다.
"""
from __future__ import annotations

import logging
import os
import shutil
import struct
import subprocess
import zlib
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

HUB_TAG = "mv-hub/1"  # 각인 형식 버전 — 읽는 쪽이 세대를 구분할 수 있게.

# 새기는 항목은 이 셋뿐이다. 워크스페이스·프로젝트·모델명은 '내용'이라 넣지 않는다(외부 유출 방지).
KEY_GEN = "mvhub.gen_id"
KEY_JOB = "mvhub.job_id"
KEY_HUB = "mvhub.hub"

_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_JPEG_MAGIC = b"\xff\xd8"
# ffmpeg 로 컨테이너만 다시 쓸 수 있는 형식. 그 외 확장자는 각인 없이 원본 통과.
_FFMPEG_EXTS = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}

_FFMPEG_BIN: Optional[str] = None
_FFMPEG_LOOKED = False


def _ffmpeg() -> Optional[str]:
    """ffmpeg 경로(1회 조회 캐시). 없는 PC 도 있으므로 None 이면 영상 각인은 건너뛴다."""
    global _FFMPEG_BIN, _FFMPEG_LOOKED
    if not _FFMPEG_LOOKED:
        _FFMPEG_BIN = shutil.which("ffmpeg")
        _FFMPEG_LOOKED = True
    return _FFMPEG_BIN


def build_tags(gen_id: str, job_id: Optional[str] = None) -> dict[str, str]:
    """각인할 항목 — 열쇠(gen_id)와 힉스필드 앵커(job_id), 그리고 우리 파일이라는 표시."""
    tags = {KEY_GEN: str(gen_id or "").strip(), KEY_HUB: HUB_TAG}
    if job_id:
        tags[KEY_JOB] = str(job_id).strip()
    return {k: v for k, v in tags.items() if v}


# ── PNG ──────────────────────────────────────────────────────────────────────
def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    )


def _stamp_png(data: bytes, tags: dict[str, str]) -> bytes:
    """IEND 앞에 iTXt 청크를 끼워 넣는다 — 앞의 원본 바이트는 그대로 유지된다."""
    end = data.rfind(b"\x00\x00\x00\x00IEND")
    if end < 0:
        raise ValueError("PNG 종료 청크(IEND)를 찾지 못했습니다")
    added = b"".join(
        # keyword \0 압축플래그 압축방식 언어태그\0 번역키워드\0 본문(UTF-8)
        _png_chunk(b"iTXt", key.encode("latin-1") + b"\x00\x00\x00\x00\x00" + value.encode("utf-8"))
        for key, value in tags.items()
    )
    return data[:end] + added + data[end:]


def _read_png(data: bytes) -> dict[str, str]:
    out: dict[str, str] = {}
    pos = len(_PNG_MAGIC)
    while pos + 8 <= len(data):
        size = struct.unpack(">I", data[pos : pos + 4])[0]
        kind = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + size]
        if kind == b"IEND":
            break
        if kind in (b"iTXt", b"tEXt"):
            key, _, rest = body.partition(b"\x00")
            name = key.decode("latin-1", "replace")
            if name.startswith("mvhub."):
                if kind == b"iTXt":
                    # 압축플래그·방식(2바이트) 뒤에 언어태그\0 번역키워드\0 이 오고 그 다음이 본문.
                    rest = rest[2:]
                    for _ in range(2):
                        _, _, rest = rest.partition(b"\x00")
                out[name] = rest.decode("utf-8", "replace")
        pos += 12 + size
    return out


# ── JPEG ─────────────────────────────────────────────────────────────────────
def _stamp_jpeg(data: bytes, tags: dict[str, str]) -> bytes:
    """SOI 바로 뒤에 주석(COM) 세그먼트를 넣는다. 이미지 데이터는 건드리지 않는다."""
    text = "\n".join(f"{key}={value}" for key, value in tags.items()).encode("utf-8")
    if len(text) + 2 > 0xFFFF:
        raise ValueError("주석이 JPEG 세그먼트 한도를 넘습니다")
    segment = b"\xff\xfe" + struct.pack(">H", len(text) + 2) + text
    return data[:2] + segment + data[2:]


def _read_jpeg(data: bytes) -> dict[str, str]:
    out: dict[str, str] = {}
    pos = 2
    while pos + 4 <= len(data):
        if data[pos] != 0xFF:
            break
        marker = data[pos + 1]
        if marker == 0xDA:  # 이미지 데이터 시작 — 그 앞까지만 세그먼트다.
            break
        size = struct.unpack(">H", data[pos + 2 : pos + 4])[0]
        if marker == 0xFE:  # COM
            for line in data[pos + 4 : pos + 2 + size].decode("utf-8", "replace").splitlines():
                key, _, value = line.partition("=")
                if key.startswith("mvhub."):
                    out[key] = value
        pos += 2 + size
    return out


# ── 공개 API ─────────────────────────────────────────────────────────────────
def stamp_bytes(data: bytes, tags: dict[str, str]) -> bytes:
    """이미지 바이트에 각인해서 돌려준다. 각인할 수 없으면 원본을 그대로 돌려준다."""
    if not data or not tags:
        return data
    try:
        if data.startswith(_PNG_MAGIC):
            return _stamp_png(data, tags)
        if data.startswith(_JPEG_MAGIC):
            return _stamp_jpeg(data, tags)
    except Exception as e:  # noqa: BLE001 — 각인 실패가 다운로드를 막으면 안 된다.
        log.warning("각인 생략(이미지) — %s", e)
    return data


def stamp_file(path: Path, tags: dict[str, str], suffix: Optional[str] = None) -> bool:
    """디스크 파일에 각인한다(제자리 교체). 성공하면 True, 못 하면 원본 유지 후 False.

    이미지는 바이트를 다시 쓰고, 영상은 ffmpeg 로 컨테이너만 다시 쓴다(-c copy = 재인코딩 없음).
    어느 쪽이든 임시 파일에 먼저 만든 뒤 교체하므로, 실패해도 원본이 깨지지 않는다.

    suffix: 최종 확장자를 따로 알려준다. 저장 중인 임시 파일(`clip.mp4.<uuid>.part`)은 이름만
    보면 형식을 알 수 없어, 영상인데도 이미지 경로로 새어 각인이 조용히 빠진다.
    """
    if not tags:
        return False
    try:
        suffix = (suffix or path.suffix).lower()
        if suffix in _FFMPEG_EXTS:
            return _stamp_video_file(path, tags, suffix)
        data = path.read_bytes()
        stamped = stamp_bytes(data, tags)
        if stamped is data or len(stamped) == len(data):
            return False
        tmp = path.with_name(f"{path.name}.{os.getpid()}.stamp")
        tmp.write_bytes(stamped)
        os.replace(tmp, path)
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("각인 생략(%s) — %s", path.name, e)
        return False


def _stamp_video_file(path: Path, tags: dict[str, str], suffix: str) -> bool:
    ffmpeg = _ffmpeg()
    if not ffmpeg:
        log.info("각인 생략(영상) — 이 PC 에 ffmpeg 가 없습니다: %s", path.name)
        return False
    # 출력 확장자로 컨테이너를 정하므로 임시 파일도 진짜 확장자로 끝나야 한다(`.part` 면 ffmpeg 가
    # 형식을 몰라 실패한다).
    tmp = path.with_name(f"{path.name}.{os.getpid()}.stamp{suffix}")
    # -map 은 주지 않는다. Resolve 출력처럼 타임코드(tmcd) 트랙이 있는 파일은 그걸 그대로
    # 복사하려다 mp4 재기록에 실패한다(실측 2026-08-18). 기본 매핑이면 영상·음성만 복사된다.
    args = [ffmpeg, "-y", "-v", "error", "-i", str(path), "-c", "copy",
            "-movflags", "use_metadata_tags"]
    for key, value in tags.items():
        args += ["-metadata", f"{key}={value}"]
    args.append(str(tmp))
    try:
        done = subprocess.run(args, capture_output=True, timeout=300)
        if done.returncode != 0 or not tmp.exists() or tmp.stat().st_size == 0:
            log.warning("각인 생략(영상) — ffmpeg 실패: %s", done.stderr[-300:].decode("utf-8", "replace"))
            tmp.unlink(missing_ok=True)
            return False
        os.replace(tmp, path)
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("각인 생략(영상) — %s", e)
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        return False


def read_stamp(path: Path) -> dict[str, str]:
    """파일에서 각인을 읽는다. 없으면 빈 dict — '우리가 만든 파일이 아니다'라는 뜻."""
    try:
        suffix = path.suffix.lower()
        if suffix in _FFMPEG_EXTS:
            return _read_video(path)
        head = path.read_bytes()
        if head.startswith(_PNG_MAGIC):
            return _read_png(head)
        if head.startswith(_JPEG_MAGIC):
            return _read_jpeg(head)
    except Exception as e:  # noqa: BLE001
        log.warning("각인 읽기 실패(%s) — %s", path.name, e)
    return {}


def _read_video(path: Path) -> dict[str, str]:
    """ffprobe 가 없는 PC 도 있어 ffmpeg 의 ffmetadata 덤프로 읽는다(실측 2026-08-18)."""
    ffmpeg = _ffmpeg()
    if not ffmpeg:
        return {}
    done = subprocess.run(
        [ffmpeg, "-v", "quiet", "-i", str(path), "-f", "ffmetadata", "-"],
        capture_output=True, timeout=120,
    )
    out: dict[str, str] = {}
    for line in done.stdout.decode("utf-8", "replace").splitlines():
        key, _, value = line.partition("=")
        if key.startswith("mvhub."):
            # ffmetadata 는 =·;·#·\ 를 역슬래시로 이스케이프한다.
            out[key] = value.replace("\\=", "=").replace("\\;", ";").replace("\\#", "#").replace("\\\\", "\\")
    return out


def tags_for_generation(gen_id: str) -> dict[str, str]:
    """카탈로그에서 힉스필드 앵커(job_id)를 찾아 각인 항목을 만든다.

    팀 카드처럼 로컬에 행이 없으면 job_id 를 못 찾지만, 그때도 gen_id 만으로 카탈로그를 찾을 수
    있으므로 조회 실패는 그냥 넘어간다 — 각인이 저장·다운로드를 막으면 안 된다."""
    from .. import repo  # 지연 임포트 — 서비스가 라우터 로딩 순서에 묶이지 않게

    job_id = None
    try:
        row = repo.get_generation(gen_id)
        job_id = (row or {}).get("job_id")
    except Exception:  # noqa: BLE001
        job_id = None
    return build_tags(gen_id, job_id)


def gen_id_of(stamp: dict[str, str]) -> Optional[str]:
    """각인에서 열쇠(gen_id)만 뽑는다."""
    value = (stamp or {}).get(KEY_GEN, "").strip()
    return value or None
