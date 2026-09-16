"""경로 표기만 다른 Windows 경로의 포함 검사와 실제 IO 경로 보존."""

from __future__ import annotations

import os
from pathlib import Path, PurePosixPath, PureWindowsPath
from unittest import mock

import pytest

from app.services import path_safety


@pytest.mark.skipif(os.name != "nt", reason="Windows resolve 경로 표기 회귀")
@pytest.mark.parametrize("extended_base", [False, True])
@pytest.mark.parametrize("extended_candidate", [False, True])
@pytest.mark.parametrize("unc", [False, True])
def test_safe_join_accepts_mixed_resolved_prefix_and_preserves_io_path(
    extended_base: bool, extended_candidate: bool, unc: bool,
):
    plain = r"\\server\share\프로젝트" if unc else r"C:\프로젝트"
    extended = "\\\\?\\UNC\\" + plain[2:] if unc else "\\\\?\\" + plain
    base = Path(extended if extended_base else plain)
    candidate = Path(extended if extended_candidate else plain) / "out" / "final_00.mp4"
    with mock.patch.object(Path, "resolve", side_effect=[base, candidate]) as resolve:
        result = path_safety.safe_join(Path(plain), "out/final_00.mp4")
    assert result is candidate
    assert resolve.call_count == 2


@pytest.mark.parametrize(
    ("normal", "extended"),
    [
        (r"C:\Project\file.mp4", r"\\?\C:\Project\file.mp4"),
        (r"c:\project\FILE.MP4", r"\\?\C:\Project\file.mp4"),
        ("C:\\", "\\\\?\\C:\\"),
        (r"\\server\share\file.mp4", r"\\?\UNC\server\share\file.mp4"),
        (r"\\SERVER\SHARE\File.MP4", r"\\?\unc\server\share\file.mp4"),
        (r"\\server\share", r"\\?\UNC\server\share"),
        (r"C:\Project\trailing. ", r"\\?\C:\Project\trailing. "),
    ],
)
def test_comparison_key_only_unifies_known_windows_prefixes(normal: str, extended: str):
    normal_key = path_safety.path_comparison_key(PureWindowsPath(normal))
    extended_key = path_safety.path_comparison_key(PureWindowsPath(extended))
    assert normal_key == extended_key
    assert hash(normal_key) == hash(extended_key)


@pytest.mark.parametrize(
    "raw",
    [
        r"\\?\GLOBALROOT\Device\HarddiskVolume1\file.mp4",
        r"\\.\C:\Project\file.mp4",
        r"\\?\Volume{example}\file.mp4",
        r"\\?\C:relative.mp4",
        r"\\?\UNC\server",
    ],
)
def test_comparison_key_does_not_rewrite_unknown_namespaces(raw: str):
    path = PureWindowsPath(raw)
    assert path_safety.path_comparison_key(path) is path


def test_comparison_key_preserves_posix_case_and_backslashes():
    path = PurePosixPath(r"/media/Project/\\?\C:\file.mp4")
    assert path_safety.path_comparison_key(path) is path
    assert path_safety.path_comparison_key(PurePosixPath("/media/Project")) != (
        path_safety.path_comparison_key(PurePosixPath("/media/project"))
    )


@pytest.mark.skipif(os.name != "nt", reason="Windows resolve 경로 표기 회귀")
@pytest.mark.parametrize(
    ("base_raw", "candidate_raw"),
    [
        (r"C:\base", r"\\?\C:\base-other\file.mp4"),
        (r"\\?\C:\base", r"C:\outside\file.mp4"),
        (r"C:\base", r"\\?\D:\base\file.mp4"),
        (r"\\server\share\base", r"\\?\UNC\server\other\base\file.mp4"),
        (r"\\server\share\base", r"\\?\UNC\other\share\base\file.mp4"),
        (r"C:\base", r"\\?\GLOBALROOT\Device\HarddiskVolume1\base\file.mp4"),
    ],
)
def test_safe_join_rejects_outside_even_with_extended_prefix(base_raw, candidate_raw):
    with mock.patch.object(
        Path, "resolve", side_effect=[Path(base_raw), Path(candidate_raw)],
    ):
        assert path_safety.safe_join(Path(base_raw), "file.mp4") is None


@pytest.mark.skipif(os.name != "nt", reason="Windows 불완전 resolve 방어 계약")
@pytest.mark.parametrize("extended", [False, True])
@pytest.mark.parametrize("on_base", [False, True])
def test_safe_join_rejects_unresolved_parent_components(extended, on_base):
    # 현재 bundled 3.14의 실제 resolve는 이 '..'를 제거한다. 해석 결과에 남는
    # 경우에도 relative_to의 문자 컴포넌트 비교를 안전 판정으로 오인하지 않는다.
    prefix = "\\\\?\\" if extended else ""
    if on_base:
        base = Path(prefix + r"C:\base\missing\..")
        candidate = base / "file.mp4"
    else:
        base = Path(r"C:\base")
        candidate = Path(prefix + r"C:\base\missing\..\..\outside.mp4")
    with mock.patch.object(Path, "resolve", side_effect=[base, candidate]):
        assert path_safety.safe_join(base, candidate) is None


@pytest.mark.skipif(os.name != "nt", reason="Windows 실제 extended traversal 검사")
@pytest.mark.parametrize(
    "tail", [r"..\..\outside.mp4", r"missing\..\..\outside.mp4", r"..\outside.mp4"],
)
def test_safe_join_rejects_extended_parent_traversal_after_actual_resolve(tmp_path, tail):
    base = tmp_path / "base"
    base.mkdir()
    candidate = Path("\\\\?\\" + str(base) + "\\" + tail)
    assert path_safety.safe_join(base, candidate) is None


@pytest.mark.parametrize("existing", [False, True])
def test_safe_join_accepts_fully_resolved_parent_component_inside_base(tmp_path, existing):
    (tmp_path / "inside").mkdir()
    expected = tmp_path / "file.mp4"
    if existing:
        expected.write_bytes(b"existing-content")
    result = path_safety.safe_join(tmp_path, Path("inside") / ".." / "file.mp4")
    assert result == expected.resolve()
    if existing:
        assert result.read_bytes() == b"existing-content"


@pytest.mark.parametrize("failure", [OSError("unavailable"), ValueError("bad path")])
@pytest.mark.parametrize("on_candidate", [False, True])
def test_safe_join_resolve_failure_is_denied(tmp_path, failure, on_candidate):
    outcomes = [tmp_path, failure] if on_candidate else [failure]
    with mock.patch.object(Path, "resolve", side_effect=outcomes):
        assert path_safety.safe_join(tmp_path, "file.mp4") is None


def test_safe_join_rejects_parent_traversal_and_absolute_escape(tmp_path):
    base = tmp_path / "base"
    base.mkdir()
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"outside")
    assert path_safety.safe_join(base, "../outside.mp4") is None
    assert path_safety.safe_join(base, outside) is None
    assert outside.read_bytes() == b"outside"


def test_safe_join_accepts_absolute_path_inside_base(tmp_path):
    candidate = tmp_path / "out" / "file.mp4"
    assert path_safety.safe_join(tmp_path, candidate) == candidate.resolve()


def test_safe_join_resolves_symlink_and_rejects_escape(tmp_path):
    base = tmp_path / "base"
    outside = tmp_path / "outside"
    base.mkdir()
    outside.mkdir()
    link = base / "link"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except OSError as exc:
        if os.name == "nt" and getattr(exc, "winerror", None) == 1314:
            pytest.skip("Windows symbolic-link creation privilege is unavailable")
        raise
    assert path_safety.safe_join(base, "link/file.mp4") is None
    # 기준 자체가 링크이면 실체 경로 안의 정상 대상은 허용한다.
    assert path_safety.safe_join(link, "file.mp4") == outside.resolve() / "file.mp4"


@pytest.mark.skipif(os.name != "nt", reason="Windows junction 경로 검사")
def test_safe_join_resolves_junction_and_rejects_escape(tmp_path):
    import _winapi

    base = tmp_path / "base"
    outside = tmp_path / "outside"
    base.mkdir()
    outside.mkdir()
    link = base / "junction"
    _winapi.CreateJunction(str(outside), str(link))
    assert path_safety.safe_join(base, "junction/file.mp4") is None
    assert path_safety.safe_join(link, "file.mp4") == outside.resolve() / "file.mp4"


@pytest.mark.skipif(os.name != "nt", reason="Windows 긴 경로 IO 검사")
def test_safe_join_preserves_long_extended_io_path(tmp_path):
    base = tmp_path.resolve()
    extended_base = Path("\\\\?\\" + str(base))
    rel = Path(*(["긴경로" * 8] * 12)) / "원본.mp4"
    candidate = extended_base / rel
    candidate.parent.mkdir(parents=True)
    candidate.write_bytes(b"long-path-content")
    result = path_safety.safe_join(extended_base, rel)
    assert result is not None
    assert str(result).startswith("\\\\?\\")
    assert len(str(result)) > 260
    assert result.read_bytes() == b"long-path-content"
