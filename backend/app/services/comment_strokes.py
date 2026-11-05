"""코멘트 그림 '획 목록 v1' 규격 — 검증·정규화·내용 해시(설계 docs/status/크게보기_코멘트그림_설계_2026-11-05.md §10 C4).

프런트 ``frontend/src/components/edit/drawing/strokes.ts`` 와 **같은 바이트**를 만든다:
- 숫자는 소수 1자리(시각은 ms)로 '0.5 는 올림'(floor(x*10+0.5)/10) — 파이썬 round 의 짝수 맞춤은 JS 와 어긋난다.
- 정수가 되면 정수로 쓴다(JS JSON.stringify(2.0) == "2").
- JSON 은 칸 이름 정렬·공백 없음·ensure_ascii=False(JS JSON.stringify 와 같은 출력 — 제어 문자는 받지 않는다).
받은 값은 믿지 않는다: 허용 칸만, 범위 밖은 거절(그릴 때 클라가 잘라 넣는다).
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import io
import json
import math
import re
import unicodedata
from typing import Any, Optional

PALETTE = frozenset({"#ffffff", "#bef264", "#f59e0b", "#ef4444", "#2dd4bf", "#3b82f6", "#ec4899", "#111111"})
SHAPES = frozenset({"line", "arrow", "rect", "ellipse"})
KINDS = frozenset({"image", "video"})
MAX_DRAWINGS = 12
MAX_ITEMS = 500
MAX_PEN_POINTS = 5000
MAX_TOTAL_POINTS = 20000
MAX_TEXT = 200
MAX_SIDE = 16384
MAX_STROKES_BYTES = 256 * 1024
MAX_THUMB_BYTES = 64 * 1024
MAX_THUMB_SIDE = 640
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_KEYS = {
    "pen": {"kind", "erase", "color", "size", "points"},
    "shape": {"kind", "shape", "color", "size", "from", "to"},
    "text": {"kind", "text", "color", "size", "at"},
}


class StrokeError(ValueError):
    """규격 위반 — 메시지는 기계가 읽는 짧은 코드(라우터가 400 으로 돌려준다)."""


def is_uuid(value: Any) -> bool:
    return isinstance(value, str) and bool(_UUID.match(value))


def _finite(value: Any, code: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise StrokeError(code)
    return float(value)


def _q(value: float, scale: int) -> int | float:
    out = math.floor(value * scale + 0.5) / scale
    return int(out) if out == int(out) else out


def quantize(value: float) -> int | float:
    """좌표·굵기 — 소수 1자리, 0.5 올림."""
    return _q(value, 10)


def quantize_time(value: float) -> int | float:
    """영상 시각 — ms, 0.5 올림."""
    return _q(value, 1000)


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def size_limit(width: int, height: int) -> float:
    """굵기·글자 크기 상한 = max(180, 긴 변/4) — 작은 원본에서도 지금 도구 출력(굵기 120·글자 180)을 받는다(Codex 4차)."""
    return max(180.0, max(width, height) / 4)


def _point(raw: Any, width: int, height: int) -> dict[str, int | float]:
    if not isinstance(raw, dict) or set(raw) != {"x", "y"}:
        raise StrokeError("bad_point")
    x = _finite(raw["x"], "bad_point")
    y = _finite(raw["y"], "bad_point")
    if not (0 <= x <= width and 0 <= y <= height):
        raise StrokeError("point_out_of_range")
    return {"x": quantize(x), "y": quantize(y)}


def _common(raw: dict[str, Any], width: int, height: int) -> tuple[str, int | float]:
    color = raw.get("color")
    if color not in PALETTE:
        raise StrokeError("bad_color")
    size = _finite(raw.get("size"), "bad_size")
    if not (1 <= size <= size_limit(width, height)):
        raise StrokeError("size_out_of_range")
    return color, quantize(size)


def _text(value: Any) -> str:
    if not isinstance(value, str) or not (1 <= len(value) <= MAX_TEXT):
        raise StrokeError("bad_text")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as exc:  # 짝 없는 서로게이트 — JS 와 직렬화가 갈린다
        raise StrokeError("bad_text") from exc
    if any(unicodedata.category(ch) == "Cc" for ch in value):
        raise StrokeError("bad_text")
    return value


def normalize_strokes(doc: Any, width: int, height: int) -> dict[str, Any]:
    """받은 획 문서를 v1 규격으로 검사해 정규화본을 돌려준다."""
    if not isinstance(doc, dict) or set(doc) != {"v", "items"}:
        raise StrokeError("bad_strokes")
    if isinstance(doc["v"], bool) or doc["v"] != 1:
        raise StrokeError("unsupported_version")
    items = doc["items"]
    if not isinstance(items, list) or not (1 <= len(items) <= MAX_ITEMS):
        raise StrokeError("bad_items")
    total = 0
    out: list[dict[str, Any]] = []
    for raw in items:
        kind = raw.get("kind") if isinstance(raw, dict) else None
        if kind not in _KEYS or set(raw) != _KEYS[kind]:
            raise StrokeError("bad_item")
        color, size = _common(raw, width, height)
        if kind == "pen":
            if not isinstance(raw["erase"], bool):
                raise StrokeError("bad_item")
            points = raw["points"]
            if not isinstance(points, list) or not (1 <= len(points) <= MAX_PEN_POINTS):
                raise StrokeError("bad_points")
            total += len(points)
            if total > MAX_TOTAL_POINTS:
                raise StrokeError("too_many_points")
            out.append({"kind": "pen", "erase": raw["erase"], "color": color, "size": size,
                        "points": [_point(p, width, height) for p in points]})
        elif kind == "shape":
            if raw["shape"] not in SHAPES:
                raise StrokeError("bad_item")
            out.append({"kind": "shape", "shape": raw["shape"], "color": color, "size": size,
                        "from": _point(raw["from"], width, height), "to": _point(raw["to"], width, height)})
        else:
            out.append({"kind": "text", "text": _text(raw["text"]), "color": color, "size": size,
                        "at": _point(raw["at"], width, height)})
    return {"v": 1, "items": out}


def decode_thumb(value: Any) -> Optional[bytes]:
    """영상 목록용 미리보기 — 엄격한 base64 · 실제 JPEG · 크기 상한. None 이면 없음(정상 계약)."""
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > (MAX_THUMB_BYTES * 4) // 3 + 8:
        raise StrokeError("bad_thumb")
    try:
        data = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise StrokeError("bad_thumb") from exc
    if not data or len(data) > MAX_THUMB_BYTES or not data.startswith(b"\xff\xd8"):
        raise StrokeError("bad_thumb")
    try:
        from PIL import Image
        with Image.open(io.BytesIO(data)) as probe:
            probe.verify()
        with Image.open(io.BytesIO(data)) as image:
            if image.format != "JPEG" or max(image.size) > MAX_THUMB_SIDE:
                raise StrokeError("bad_thumb")
    except StrokeError:
        raise
    except Exception as exc:  # noqa: BLE001 — 깨진 그림은 모두 같은 거절
        raise StrokeError("bad_thumb") from exc
    return data


def content_hash(*, strokes: dict[str, Any], kind: str, width: int, height: int,
                 time_sec: Optional[float], idx: int, thumb: Optional[bytes]) -> str:
    """그림의 전체 의미 해시(C4) — 그림 id 는 넣지 않는다(C1 지문이 {id, hash} 를 따로 묶는다)."""
    envelope = {
        "v": 1, "kind": kind, "width": width, "height": height,
        "time_sec": None if time_sec is None else quantize_time(time_sec),
        "idx": idx, "strokes": strokes,
        "thumb_sha256": hashlib.sha256(thumb).hexdigest() if thumb else None,
    }
    return hashlib.sha256(canonical(envelope).encode("utf-8")).hexdigest()


def _int(value: Any, low: int, high: int, code: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not (low <= value <= high):
        raise StrokeError(code)
    return value


def normalize_drawing(raw: Any) -> dict[str, Any]:
    """API·발행 묶음으로 받은 그림 1장 — 정규화본(strokes 문서·json·thumb 바이트·해시)."""
    if not isinstance(raw, dict):
        raise StrokeError("bad_drawing")
    drawing_id = raw.get("id")
    if not isinstance(drawing_id, str) or not _UUID.match(drawing_id):
        raise StrokeError("bad_drawing_id")
    idx = _int(raw.get("idx"), 0, MAX_DRAWINGS - 1, "bad_idx")
    kind = raw.get("kind")
    if kind not in KINDS:
        raise StrokeError("bad_kind")
    width = _int(raw.get("width"), 1, MAX_SIDE, "bad_size_box")
    height = _int(raw.get("height"), 1, MAX_SIDE, "bad_size_box")
    time_raw = raw.get("time_sec")
    if kind == "video":
        time_sec = _finite(time_raw, "bad_time")
        if time_sec < 0:
            raise StrokeError("bad_time")
    elif time_raw is not None:
        raise StrokeError("bad_time")
    else:
        time_sec = None
    strokes = normalize_strokes(raw.get("strokes"), width, height)
    strokes_json = canonical(strokes)
    if len(strokes_json.encode("utf-8")) > MAX_STROKES_BYTES:
        raise StrokeError("strokes_too_large")
    thumb = decode_thumb(raw.get("thumb_b64"))
    if kind == "image" and thumb is not None:
        raise StrokeError("bad_thumb")
    digest = content_hash(strokes=strokes, kind=kind, width=width, height=height,
                          time_sec=time_sec, idx=idx, thumb=thumb)
    expected = raw.get("content_hash")
    if expected is not None and expected != digest:
        raise StrokeError("content_hash_mismatch")
    return {"id": drawing_id, "idx": idx, "kind": kind, "width": width, "height": height,
            "time_sec": None if time_sec is None else quantize_time(time_sec),
            "strokes": strokes, "strokes_json": strokes_json, "thumb": thumb, "content_hash": digest}


# ── 새 표 구조 검사(이름표·BASELINES 없이 — db 초기화와 저장소가 같이 쓰므로 app 의 다른 모듈을 import 하지 않는 여기에 둔다) ──
DRAWING = "generation_comment_drawing"
REQUEST = "generation_comment_request"
TOMBSTONE = "generation_comment_tombstone"
_SPEC: dict[str, dict[str, Any]] = {
    DRAWING: {
        "columns": {"id", "comment_id", "idx", "kind", "width", "height", "time_sec",
                    "strokes_json", "thumb_jpg", "content_hash", "created_at"},
        "pk": ("id",), "unique": [("comment_id", "idx")],
        "fk": ("comment_id", "generation_comment", "id", "CASCADE"),
    },
    REQUEST: {"columns": {"id", "fingerprint", "gen_key", "created_at"}, "pk": ("id",)},
    TOMBSTONE: {"columns": {"id", "gen_key", "deleted_at"}, "pk": ("id",)},
}


class StructureError(RuntimeError):
    """새 표 구조가 어긋남 — 그 표에 기대는 동작을 바꾸기 전에 거절한다(라우터 503)."""

    def __init__(self, table: str):
        self.table = table
        super().__init__(f"comment_storage_unavailable:{table}")


def table_ok(conn: Any, table: str) -> bool:
    spec = _SPEC[table]
    info = conn.execute(f"PRAGMA table_info({table})").fetchall()
    if not info:
        return False
    columns = {row[1] for row in info}
    pk = tuple(row[1] for row in sorted((r for r in info if r[5]), key=lambda r: r[5]))
    if not spec["columns"] <= columns or pk != spec["pk"]:
        return False
    for wanted in spec.get("unique", []):
        found = False
        for index in conn.execute(f"PRAGMA index_list({table})").fetchall():
            if index[2]:
                cols = tuple(r[2] for r in conn.execute(f"PRAGMA index_info({index[1]})").fetchall())
                found = found or cols == wanted
        if not found:
            return False
    if "fk" in spec:
        column, parent, parent_col, on_delete = spec["fk"]
        if not any(r[3] == column and r[2] == parent and r[4] == parent_col and str(r[6]).upper() == on_delete
                   for r in conn.execute(f"PRAGMA foreign_key_list({table})").fetchall()):
            return False
    return True


def check_structure(conn: Any) -> dict[str, bool]:
    return {table: table_ok(conn, table) for table in _SPEC}


def require(conn: Any, *tables: str) -> None:
    for table in tables:
        if not table_ok(conn, table):
            raise StructureError(table)


def normalize_drawings(raw: Any) -> list[dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_DRAWINGS:
        raise StrokeError("too_many_drawings")
    out = [normalize_drawing(item) for item in raw]
    if len({d["id"] for d in out}) != len(out) or len({d["idx"] for d in out}) != len(out):
        raise StrokeError("duplicate_drawing")
    return sorted(out, key=lambda d: d["idx"])
