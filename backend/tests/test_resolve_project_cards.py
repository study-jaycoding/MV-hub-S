"""Resolve 프로젝트 카드 — 대표 그림(복사본에서만 읽기)·Resolve 켜기·창 제목·열기 라우트 상태 코드."""

from __future__ import annotations

import asyncio
import base64
import os
import sqlite3
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

from app.routers import assets
from app.services import resolve_project_library as lib

JPEG = bytes((0xFF, 0xD8, 0xFF))


def _format(width: int, height: int, fps: float) -> tuple[bytes, bytes]:
    """Resolve Sm2Sequence 와 같은 인코딩 — 해상도 빅엔디언 int64 두 개, fps 리틀엔디언 double + 8바이트 0."""
    return struct.pack(">2q", width, height), struct.pack("<d", fps) + bytes(8)


def _make_project(
    root: Path,
    relative: str,
    frames: list[bytes],
    *,
    wal: bool = False,
    timelines: list[tuple[bytes, bytes]] | None = None,
) -> Path:
    """Resolve 와 같은 표 모양의 가짜 Project.db(표 이름 철자도 Resolve 그대로). timelines=None 이면 타임라인 표가 없다."""
    folder = root / "Resolve Projects" / "Users" / "guest" / "Projects" / relative
    folder.mkdir(parents=True)
    database = folder / "Project.db"
    connection = sqlite3.connect(database)
    try:
        if wal:
            connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE SM_Project (SM_Project_id TEXT PRIMARY KEY)")
        connection.execute("CREATE TABLE BtThumnail (BtThumnail_id TEXT PRIMARY KEY, Buffer BLOB)")
        connection.execute(
            "CREATE TABLE BtThumnail_SM_Project "
            "(DbOwner TEXT, DbAssociate TEXT, DbPropertyName TEXT, DbIndex INTEGER)"
        )
        connection.execute("INSERT INTO SM_Project VALUES ('p')")
        # 일부러 순번을 뒤섞어 넣는다 — 저장 순번(DbIndex) 순으로 나와야 한다.
        for index in reversed(range(len(frames))):
            connection.execute("INSERT INTO BtThumnail VALUES (?, ?)", (f"t{index}", frames[index]))
            connection.execute(
                "INSERT INTO BtThumnail_SM_Project VALUES ('p', ?, 'Thumbnails', ?)", (f"t{index}", index)
            )
        if timelines is not None:
            connection.execute(
                "CREATE TABLE SM_Project_Sm2Timeline "
                "(DbOwner TEXT, DbAssociate TEXT, DbPropertyName TEXT, DbIndex INTEGER)"
            )
            connection.execute("CREATE TABLE Sm2Timeline (Sm2Timeline_id TEXT PRIMARY KEY, Sequence TEXT)")
            connection.execute(
                "CREATE TABLE Sm2Sequence (Sm2Sequence_id TEXT PRIMARY KEY, Resolution BLOB, FrameRate BLOB)"
            )
            for index, (resolution, frame_rate) in enumerate(timelines):
                connection.execute(
                    "INSERT INTO SM_Project_Sm2Timeline VALUES ('p', ?, 'TimelineHandleVec', ?)", (f"tl{index}", index)
                )
                connection.execute("INSERT INTO Sm2Timeline VALUES (?, ?)", (f"tl{index}", f"s{index}"))
                connection.execute("INSERT INTO Sm2Sequence VALUES (?, ?, ?)", (f"s{index}", resolution, frame_rate))
        connection.commit()
    finally:
        connection.close()
    return database


def _b64(frame: bytes) -> str:
    return base64.b64encode(frame).decode("ascii")


def _thumbs(root: Path) -> dict[str, list[str]]:
    return lib.project_cards(root)["thumbnails"]


class ProjectThumbnailTests(unittest.TestCase):
    def setUp(self):
        lib._thumb_cache.clear()
        self.addCleanup(lib._thumb_cache.clear)
        self._temp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._temp.cleanup)
        self.root = Path(self._temp.name)

    def test_frames_come_in_saved_order_and_only_jpeg(self):
        _make_project(self.root, "Mud_Ai", [JPEG + b"one", b"not-a-jpeg", JPEG + b"three"])
        _make_project(self.root, "Episodes/Part 1", [JPEG + b"x"])

        thumbs = _thumbs(self.root)

        # 키는 화면이 쓰는 "<folder_path>/<name>" 모양 그대로(루트면 앞에 '/').
        self.assertEqual(thumbs["/Mud_Ai"], [_b64(JPEG + b"one"), _b64(JPEG + b"three")])
        self.assertEqual(thumbs["Episodes/Part 1"], [_b64(JPEG + b"x")])

    def test_the_original_database_is_never_opened_by_sqlite(self):
        # 원본은 NAS 위에서 Resolve 가 쓰는 SQLite 다 — 읽기 잠금이 Resolve 저장을 막을 수 있어 복사본만 연다.
        original = _make_project(self.root, "Mud_Ai", [JPEG + b"one"])
        opened: list[str] = []
        real_connect = sqlite3.connect

        def spy(target, *args, **kwargs):
            opened.append(str(target))
            return real_connect(target, *args, **kwargs)

        with mock.patch.object(lib.sqlite3, "connect", side_effect=spy):
            _thumbs(self.root)

        self.assertEqual(len(opened), 1)
        self.assertNotIn(original.as_posix(), opened[0])
        self.assertIn("mvhub-resolve-thumb-", opened[0])

    def test_second_call_uses_the_cache_until_the_database_changes(self):
        database = _make_project(self.root, "Mud_Ai", [JPEG + b"one"])
        _thumbs(self.root)
        with mock.patch.object(lib.shutil, "copyfile", wraps=lib.shutil.copyfile) as copy:
            _thumbs(self.root)
            self.assertEqual(copy.call_count, 0)

            later = database.stat().st_mtime_ns + 5_000_000_000
            os.utime(database, ns=(later, later))  # Resolve 가 저장했다
            _thumbs(self.root)
            self.assertEqual(copy.call_count, 1)

    def test_unreadable_database_gives_no_picture_and_is_retried_next_time(self):
        folder = self.root / "Resolve Projects" / "Users" / "guest" / "Projects" / "Broken"
        folder.mkdir(parents=True)
        (folder / "Project.db").write_bytes(b"this is not sqlite")

        self.assertEqual(_thumbs(self.root), {})
        self.assertEqual(lib._thumb_cache, {})  # 실패는 캐시하지 않는다

    def test_database_with_a_live_journal_or_wal_is_skipped(self):
        # Codex P1: 쓰는 도중 복사한 것일 수 있다 / WAL 이면 본 파일만으로는 마지막 저장이 빠진다.
        journaled = _make_project(self.root, "Journaled", [JPEG + b"one"])
        journaled.with_name("Project.db-journal").write_bytes(b"")
        _make_project(self.root, "Wal", [JPEG + b"one"], wal=True)

        self.assertEqual(_thumbs(self.root), {})

    def test_a_write_during_the_copy_discards_the_copy(self):
        database = _make_project(self.root, "Mud_Ai", [JPEG + b"one"])
        real_copy = lib.shutil.copyfile

        def copy_then_resolve_saves(source, destination):
            real_copy(source, destination)
            later = database.stat().st_mtime_ns + 5_000_000_000
            os.utime(database, ns=(later, later))

        with mock.patch.object(lib.shutil, "copyfile", side_effect=copy_then_resolve_saves):
            self.assertEqual(_thumbs(self.root), {})

    def test_frame_count_and_frame_size_are_capped(self):
        # Codex P1 — 손상되거나 달라진 DB 하나가 응답·메모리를 붙잡지 않게.
        big = JPEG + bytes(lib._MAX_FRAME_BYTES)  # 상한보다 크다
        _make_project(self.root, "Many", [JPEG + bytes((index,)) for index in range(12)])
        _make_project(self.root, "Big", [big, JPEG + b"small"])

        thumbs = _thumbs(self.root)

        self.assertEqual(len(thumbs["/Many"]), lib._MAX_FRAMES)
        self.assertEqual(thumbs["/Big"], [_b64(JPEG + b"small")])

    def test_whole_response_is_capped(self):
        for name in ("A", "B", "C"):
            _make_project(self.root, name, [JPEG + b"x" * 64])
        with mock.patch.object(lib, "_MAX_RESPONSE_BYTES", 1):
            thumbs = _thumbs(self.root)
        self.assertEqual(len(thumbs), 1)  # 첫 프로젝트 뒤로는 아이콘 자리표시

    def test_linked_project_database_is_not_followed(self):
        # Codex P1 — 폴더 링크는 목록이 거르지만, Project.db 파일 자체가 링크일 수도 있다.
        _make_project(self.root, "Linked", [JPEG + b"one"])
        real = lib._is_reparse_or_symlink
        with mock.patch.object(
            lib, "_is_reparse_or_symlink", side_effect=lambda path: path.name == "Project.db" or real(path)
        ), mock.patch.object(lib.shutil, "copyfile") as copy:
            self.assertEqual(_thumbs(self.root), {})
        copy.assert_not_called()

    def test_projects_gone_from_the_listing_leave_the_cache(self):
        database = _make_project(self.root, "Mud_Ai", [JPEG + b"one"])
        _thumbs(self.root)
        self.assertEqual(len(lib._thumb_cache), 1)

        database.unlink()
        database.parent.rmdir()
        _thumbs(self.root)

        self.assertEqual(lib._thumb_cache, {})


class ProjectDetailTests(unittest.TestCase):
    """카드 정보(타임라인 수·해상도·fps) — 그림과 같은 복사본에서 읽는다(2026-09-22)."""

    def setUp(self):
        lib._thumb_cache.clear()
        self.addCleanup(lib._thumb_cache.clear)
        self._temp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._temp.cleanup)
        self.root = Path(self._temp.name)

    def test_timelines_resolution_and_frame_rate_are_read(self):
        _make_project(self.root, "Mud_Ai", [JPEG + b"one"], timelines=[_format(1920, 1080, 24.0)] * 2)
        _make_project(self.root, "Film", [JPEG + b"two"], timelines=[_format(3840, 2160, 24000 / 1001)])

        details = lib.project_cards(self.root)["details"]

        self.assertEqual(details["/Mud_Ai"], {"timelines": 2, "width": 1920, "height": 1080, "fps": 24.0})
        self.assertEqual(details["/Film"], {"timelines": 1, "width": 3840, "height": 2160, "fps": 23.976})

    def test_mixed_timelines_do_not_invent_a_representative_format(self):
        # 타임라인마다 다르면 Resolve 가 무엇을 대표로 보여 주는지 모른다 — 지어내지 않고 비운다(Codex).
        _make_project(
            self.root, "Mixed", [JPEG + b"one"], timelines=[_format(1920, 1080, 24.0), _format(3840, 2160, 24.0)]
        )

        self.assertEqual(lib.project_cards(self.root)["details"]["/Mixed"], {"timelines": 2})

    def test_too_many_timelines_to_compare_leave_format_blank(self):
        # 앞쪽만 같아도 '모두 같다'고 하지 않는다(Codex P1).
        _make_project(self.root, "Huge", [JPEG + b"one"], timelines=[_format(1920, 1080, 24.0)] * 3)
        with mock.patch.object(lib, "_MAX_INFO_TIMELINES", 2):
            details = lib.project_cards(self.root)["details"]

        self.assertEqual(details["/Huge"], {"timelines": 3})

    def test_unknown_or_nonsense_values_are_dropped(self):
        nan = struct.pack("<d", float("nan")) + bytes(8)
        for name, timeline in (
            ("Short", (b"short", _format(1920, 1080, 24.0)[1])),
            ("Zero", _format(0, 1080, 24.0)),
            ("NaN", (_format(1920, 1080, 24.0)[0], nan)),
        ):
            _make_project(self.root, name, [JPEG + b"x"], timelines=[timeline])

        details = lib.project_cards(self.root)["details"]

        for name in ("Short", "Zero", "NaN"):
            with self.subTest(name=name):
                self.assertEqual(details[f"/{name}"], {"timelines": 1})

    def test_a_database_without_timeline_tables_keeps_its_pictures(self):
        # 다른 Resolve 버전이라 표 모양이 달라도 그림은 잃지 않는다(Codex).
        _make_project(self.root, "Old", [JPEG + b"one"])

        cards = lib.project_cards(self.root)

        self.assertEqual(cards["thumbnails"]["/Old"], [_b64(JPEG + b"one")])
        self.assertNotIn("/Old", cards["details"])

    def test_route_returns_pictures_and_details_together(self):
        _make_project(self.root, "Mud_Ai", [JPEG + b"one"], timelines=[_format(1920, 1080, 24.0)])
        with mock.patch.object(assets, "_resolve_davinci_root", return_value=self.root):
            reply = asyncio.run(assets.list_resolve_library_thumbnails(mock.Mock(), project="p", dir="@davinci"))

        self.assertEqual(set(reply), {"thumbnails", "details"})
        self.assertEqual(reply["details"]["/Mud_Ai"]["timelines"], 1)


class LaunchResolveTests(unittest.TestCase):
    def setUp(self):
        # 90초 재실행 방지 = 서버 공용 켜기 창(test_resolve_launch_window 가 창 자체를 본다).
        lib.end_launch_window()
        self.addCleanup(lib.end_launch_window)

    def test_running_resolve_is_left_alone(self):
        with (
            mock.patch.object(lib, "resolve_process_running", return_value=True),
            mock.patch.object(lib.os, "startfile", create=True) as start,
        ):
            self.assertEqual(lib.launch_resolve(), {"status": "running", "launch_id": ""})
        start.assert_not_called()

    def test_closed_resolve_is_started_once_and_not_again_while_it_boots(self):
        with tempfile.NamedTemporaryFile(suffix=".exe", delete=False) as exe:
            executable = exe.name
        self.addCleanup(os.unlink, executable)
        with (
            mock.patch.object(lib, "resolve_process_running", return_value=False),
            mock.patch.object(lib, "_resolve_executable", return_value=executable),
            mock.patch.object(lib.os, "name", "nt"),
            mock.patch.object(lib.os, "startfile", create=True) as start,
        ):
            first = lib.launch_resolve()
            second = lib.launch_resolve()  # 창이 뜨기 전 두 번째 요청

        start.assert_called_once_with(executable)
        self.assertEqual(first["status"], "starting")
        self.assertTrue(first["launch_id"])  # 실제로 켠 호출만 번호를 받는다
        self.assertEqual(second, {"status": "starting", "launch_id": ""})

    def test_unknown_process_state_does_not_start_anything(self):
        with (
            mock.patch.object(lib, "resolve_process_running", return_value=None),
            mock.patch.object(lib.os, "startfile", create=True) as start,
            self.assertRaises(lib.ResolveProjectLibraryError) as raised,
        ):
            lib.launch_resolve()
        self.assertEqual(raised.exception.code, "state_unknown")
        start.assert_not_called()

    def test_missing_installation_is_reported(self):
        with (
            mock.patch.object(lib, "resolve_process_running", return_value=False),
            mock.patch.object(lib, "_resolve_executable", return_value=""),
            mock.patch.object(lib.os, "name", "nt"),
            mock.patch.object(lib.os, "startfile", create=True) as start,
            self.assertRaises(lib.ResolveProjectLibraryError) as raised,
        ):
            lib.launch_resolve()
        self.assertEqual(raised.exception.code, "resolve_missing")
        start.assert_not_called()


class ResolveWindowTitleTests(unittest.TestCase):
    def _title(self, stdout: str):
        completed = subprocess.CompletedProcess(["tasklist"], 0, stdout=stdout, stderr="")
        with (
            mock.patch.object(lib.os, "name", "nt"),
            mock.patch.object(lib.subprocess, "run", return_value=completed),
        ):
            return lib.resolve_window_title()

    def test_reads_the_window_title_column(self):
        row = '"Resolve.exe","65600","Console","1","2,061,452 K","Running","PC\\\\me","0:00:53","Project Manager"'
        self.assertEqual(self._title(row), "Project Manager")

    def test_no_window_yet_is_empty(self):
        row = '"Resolve.exe","65600","Console","1","200 K","Unknown","PC\\\\me","0:00:01","N/A"'
        self.assertEqual(self._title(row), "")

    def test_not_running_is_none(self):
        self.assertIsNone(self._title("INFO: No tasks are running which match the specified criteria."))


class ResolveOpenRouteStatusTests(unittest.TestCase):
    def _open(self, error: Exception | None = None, result: dict | None = None):
        body = assets.ResolveProjectOpenIn(project="뻘뻘뻘", dir="@davinci", name="Mud_Ai")
        with (
            mock.patch.object(assets, "require_loopback_browser_request"),
            mock.patch.object(assets, "_resolve_davinci_root", return_value=Path("Z:/x/@davinci")),
            mock.patch.object(
                assets.resolve_project_library,
                "open_disk_project",
                side_effect=error,
                return_value=result,
            ) as open_project,
        ):
            try:
                return asyncio.run(assets.open_resolve_library_project(body, mock.Mock())), open_project
            except HTTPException as exc:
                return exc, open_project

    def test_resolve_not_ready_is_503_so_the_screen_starts_it(self):
        # resolve_busy·launching 도 기다리면 풀린다 — 화면이 다시 시도하게 503(Codex P1).
        for code in ("not_running", "api_unavailable", "manager_unavailable", "resolve_busy", "launching"):
            with self.subTest(code=code):
                raised, _ = self._open(error=lib.ResolveProjectLibraryError("준비 안 됨", code=code))
                self.assertEqual(raised.status_code, 503)

    def test_real_failures_stay_400(self):
        for code in ("save_failed", "untitled_unsaved", "project_missing", ""):
            with self.subTest(code=code):
                raised, _ = self._open(error=lib.ResolveProjectLibraryError("실패", code=code))
                self.assertEqual(raised.status_code, 400)

    def test_opened_project_passes_through(self):
        opened = {"status": "complete", "project_name": "Mud_Ai", "message": "열었습니다."}
        result, open_project = self._open(result=opened)

        self.assertEqual(result, opened)
        self.assertEqual(open_project.call_args.args[4], "")  # 켜기 번호(launch_id) — 켜지 않은 열기라 빈 값

    def test_launch_state_reports_running_and_window(self):
        for title, expected in (("Project Manager", {"running": True, "window": True}),
                                ("", {"running": True, "window": False}),
                                (None, {"running": False, "window": False})):
            with self.subTest(title=title):
                with mock.patch.object(assets.resolve_project_library, "resolve_window_title", return_value=title):
                    self.assertEqual(asyncio.run(assets.resolve_launch_state()), expected)


if __name__ == "__main__":
    unittest.main()
