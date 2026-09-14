"""앱 아이콘 일관성 — 어디서 보든 같은 그림, 같은 **투명 배경**(Jay 2026-09-14, A안).

전에는 두 갈래였다. `favicon.png` 는 투명 마크였는데 `icon-48/96/192/512.png` 는 검은 둥근 판
위에 얹혀 있어서, 브라우저 탭과 작업표시줄·앱 창의 아이콘이 서로 달라 보였다. 지금은 하나다.

★아이콘을 바꿀 일이 생기면 **전부 같은 원본에서 같은 방식으로** 다시 뽑아야 한다. 하나만 고치면
 이 시험이 잡는다.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

PIL = pytest.importorskip("PIL", reason="Pillow 없이는 이미지 검사 불가")
from PIL import Image, ImageChops, ImageStat  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "frontend" / "public"
MANIFEST = PUBLIC / "manifest.webmanifest"
DESKTOP_ICON = ROOT / "mvhub.ico"


def _manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def _icon_paths() -> list[Path]:
    """매니페스트가 가리키는 파일들 — `?v=` 캐시 무력화 꼬리표는 떼고 본다."""
    return [PUBLIC / entry["src"].lstrip("/").split("?", 1)[0] for entry in _manifest()["icons"]]


def _mean_difference(a: Image.Image, b: Image.Image) -> float:
    """두 그림의 평균 차이(0~255). 리샘플링 오차를 감안해 임계값은 넉넉히 잡는다."""
    diff = ImageChops.difference(a.convert("RGBA"), b.convert("RGBA"))
    bands = ImageStat.Stat(diff).mean
    return sum(bands) / len(bands)


def test_manifest_icons_all_exist():
    missing = [str(p.relative_to(ROOT)) for p in _icon_paths() if not p.is_file()]
    assert missing == [], f"매니페스트가 가리키는 파일이 없다: {missing}"


@pytest.mark.parametrize("name", ["favicon.png", "icon-48.png", "icon-96.png", "icon-192.png", "icon-512.png"])
def test_app_icons_have_no_background_plate(name):
    """★A안: 배경은 투명이다. 검은 둥근 판을 다시 깔면 작업표시줄만 혼자 달라진다."""
    image = Image.open(PUBLIC / name).convert("RGBA")
    width, height = image.size
    corners = [(1, 1), (width - 2, 1), (1, height - 2), (width - 2, height - 2)]
    opaque = [xy for xy in corners if image.getpixel(xy)[3] != 0]
    assert opaque == [], f"{name} 의 모서리가 불투명하다 — 배경판이 깔려 있다: {opaque}"


def test_manifest_does_not_declare_a_maskable_icon():
    """투명 아이콘을 maskable 로 선언하면 안 된다.

    maskable 은 OS 가 원형·둥근 사각형으로 **잘라내도 되는** 그림이라는 뜻이다. 우리 마크는
    모서리까지 뻗어 있어 잘리면 끝이 날아간다. `any` 만 두면 OS 가 알아서 여백을 준다.
    """
    purposes = {entry.get("purpose") for entry in _manifest()["icons"]}
    assert "maskable" not in purposes


def test_every_icon_is_the_same_artwork():
    """★탭·앱 창·작업표시줄·바탕화면이 모두 같은 그림이어야 한다.

    비교 기준은 바탕화면 아이콘(`mvhub.ico`)이다 — 사용자가 제일 자주 보는 것이고,
    나머지는 전부 같은 원본에서 나왔다.
    """
    desktop = Image.open(DESKTOP_ICON)
    # .ico 는 담긴 크기만 꺼낼 수 있다(96·192·512 는 없다) — 제일 큰 것을 꺼내 맞춘다.
    desktop.size = max(desktop.info["sizes"])
    master = desktop.convert("RGBA")
    for path in [PUBLIC / "favicon.png", *_icon_paths()]:
        icon = Image.open(path).convert("RGBA")
        reference = master.resize(icon.size, Image.LANCZOS)
        difference = _mean_difference(icon, reference)
        assert difference < 6.0, f"{path.name} 이 바탕화면 아이콘과 다른 그림이다 (차이 {difference:.1f})"


def test_index_html_points_at_the_shared_favicon():
    html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    assert '<link rel="icon" type="image/png" href="/favicon.png" />' in html
    assert '<link rel="manifest" href="/manifest.webmanifest" />' in html


def test_icon_urls_carry_a_cache_buster():
    """매니페스트 아이콘 주소에는 `?v=` 가 붙어 있어야 한다.

    아이콘을 바꿔도 주소가 그대로면 이미 설치한 사람의 브라우저가 옛 그림을 계속 쓴다.
    그림을 바꿀 때는 이 번호도 같이 올린다.
    """
    versions = set()
    for entry in _manifest()["icons"]:
        src = entry["src"]
        assert "?v=" in src, f"캐시 무력화 꼬리표가 없다: {src}"
        versions.add(src.split("?v=", 1)[1])
    assert len(versions) == 1, f"아이콘마다 번호가 다르다: {versions}"
