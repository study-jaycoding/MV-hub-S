"""공유 서버 주소 전환 공지(C안) — 공지 파싱·제안 판정·전환 계약.

관리자가 공유 서버를 새 주소로 옮기면 릴리스 폴더에 ``server-location.json`` 공지를 둔다.
작업 중인 허브가 그걸 읽어 알리고, 사용자가 수락하면 주소를 바꾸고 로그아웃한다.
이 파일은 그 흐름에서 어기면 안 되는 계약만 고정한다:

1. 공지 파싱 — 형식이 어긋나면 무조건 거부(주소·revision 타입까지).
2. revision 단조 — 이미 수락한 번호 이하는 자동 제안하지 않는다.
3. 같은 revision 인데 주소가 다르면 제안하지 않는다(번호를 안 올린 재작성 = 운영 실수).
4. 전환은 브라우저가 보낸 url/revision 을 믿지 않고 공지 파일을 **다시 읽어** 재검증한다.
5. 전환은 원자적이다 — 성공하면 토큰이 지워지고, 중간 실패는 전부 원상복구된다.
6. 조회·전환 라우트는 loopback + Host 헤더 가드(B안과 같은 8개 라우트 규칙).
7. 릴리스 설치본이 아니면 아무 동작도 하지 않는다(공지 파일을 읽으러 가지도 않는다).
8. 공지 읽기는 별도 프로세스로 격리된다 — 죽은 NAS 가 허브를 붙잡지 못하게.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException, Request

from app import db, repo
from app.routers import publish
from app.services import server_relocation, shared_connection


def _request(client_host: str = "127.0.0.1", host_header: str | None = None) -> Request:
    headers = [(b"host", host_header.encode())] if host_header is not None else []
    return Request({"type": "http", "client": (client_host, 40000), "headers": headers})


def _announcement(
    url: str = "http://192.168.1.50:8010", revision: int = 2, name: str = "MV 팀 서버"
) -> dict:
    return {
        "url": url,
        "revision": revision,
        "name": name,
        "announced_at": "2026-08-23T10:00:00+09:00",
    }


def _location_bytes(
    url: str = "http://192.168.1.50:8010", revision: int = 2, name: str = "MV 팀 서버"
) -> bytes:
    return json.dumps(
        {
            "shared_server_url": url,
            "server_revision": revision,
            "server_name": name,
            "announced_at": "2026-08-23T10:00:00+09:00",
        }
    ).encode("utf-8")


class AnnouncementParsingTests(unittest.TestCase):
    """1. 공지 파싱 — 신뢰 경계는 parse_announcement 한 곳뿐이다."""

    def test_valid_announcement_is_normalized(self):
        parsed = server_relocation.parse_announcement(
            _location_bytes("http://192.168.1.50:8010/")
        )
        self.assertEqual(parsed["url"], "http://192.168.1.50:8010")  # 후행 슬래시 제거
        self.assertEqual(parsed["revision"], 2)
        self.assertEqual(parsed["announced_at"], "2026-08-23T10:00:00+09:00")

    def test_server_name_is_optional_and_falls_back_to_empty(self):
        """이름은 선택 — 없거나 비면 빈 문자열(화면이 주소로 폴백한다)."""
        for raw in (
            b'{"shared_server_url": "http://h:8010", "server_revision": 2}',
            b'{"shared_server_url": "http://h:8010", "server_revision": 2, "server_name": ""}',
            b'{"shared_server_url": "http://h:8010", "server_revision": 2, "server_name": "   "}',
            b'{"shared_server_url": "http://h:8010", "server_revision": 2, "server_name": null}',
        ):
            self.assertEqual(server_relocation.parse_announcement(raw)["name"], "")
        self.assertEqual(
            server_relocation.parse_announcement(_location_bytes(name="  MV 팀 서버  "))["name"],
            "MV 팀 서버",  # 앞뒤 공백 제거
        )

    def test_malformed_server_name_is_rejected(self):
        """이름이 반쯤만 반영되면 PC 마다 다른 표기를 보게 된다 — 조용히 무시하지 않는다."""
        long_name = "가" * (server_relocation.SERVER_NAME_MAX + 1)
        for raw in (
            b'{"shared_server_url": "http://h:8010", "server_revision": 2, "server_name": 5}',
            b'{"shared_server_url": "http://h:8010", "server_revision": 2, "server_name": ["a"]}',
            b'{"shared_server_url": "http://h:8010", "server_revision": 2, "server_name": "a\\nb"}',
            json.dumps(
                {"shared_server_url": "http://h:8010", "server_revision": 2, "server_name": long_name}
            ).encode("utf-8"),
        ):
            with self.assertRaises(server_relocation.RelocationReadError):
                server_relocation.parse_announcement(raw)

    def test_utf8_bom_is_accepted(self):
        """관리자가 메모장으로 저장하면 BOM 이 붙는다 — 그것 때문에 공지가 죽으면 안 된다."""
        raw = b"\xef\xbb\xbf" + _location_bytes()
        self.assertEqual(server_relocation.parse_announcement(raw)["revision"], 2)

    def test_malformed_announcements_are_rejected(self):
        cases = [
            b"not json",
            b"[]",
            b'{"server_revision": 2}',  # 주소 없음
            b'{"shared_server_url": "ftp://x", "server_revision": 2}',  # http(s) 아님
            b'{"shared_server_url": "\\\\\\\\nas\\\\share", "server_revision": 2}',  # UNC
            b'{"shared_server_url": "http://h", "server_revision": "2"}',  # 문자열 revision
            b'{"shared_server_url": "http://h", "server_revision": true}',  # bool 은 int 아님
            b'{"shared_server_url": "http://h", "server_revision": 0}',
            b'{"shared_server_url": "http://h", "server_revision": -1}',
            b'{"shared_server_url": "http://h"}',
            b"x" * (server_relocation.MAX_BYTES + 1),
        ]
        for raw in cases:
            with self.assertRaises(server_relocation.RelocationReadError, msg=raw[:40]):
                server_relocation.parse_announcement(raw)


class ProposalJudgementTests(unittest.TestCase):
    """2·3. 제안 판정 — 순수 함수라 DB 없이 고정한다."""

    def test_new_revision_on_a_different_address_is_proposed(self):
        out = server_relocation.proposal(
            "http://192.168.1.199:8010", {"revision": 1, "url": "http://old"}, _announcement()
        )
        self.assertEqual(out["url"], "http://192.168.1.50:8010")
        self.assertEqual(out["revision"], 2)
        self.assertEqual(out["name"], "MV 팀 서버")  # 이름은 그대로 실려 나간다

    def test_no_proposal_without_an_announcement(self):
        self.assertIsNone(server_relocation.proposal("http://a", {}, None))

    def test_address_already_in_use_is_not_proposed(self):
        """이미 그 주소를 쓰고 있으면 제안하지 않는다(후행 슬래시 차이도 같은 주소)."""
        for current in ("http://192.168.1.50:8010", "http://192.168.1.50:8010/"):
            self.assertIsNone(server_relocation.proposal(current, {}, _announcement()))

    def test_older_or_equal_revision_is_never_proposed(self):
        """revision 단조 — 이미 수락한 번호 이하로는 자동으로 되돌아가지 않는다."""
        seen = {"revision": 5, "url": "http://192.168.1.50:8010"}
        for revision in (1, 4, 5):
            self.assertIsNone(
                server_relocation.proposal(
                    "http://192.168.1.199:8010",
                    seen,
                    _announcement("http://192.168.1.50:8010", revision),
                ),
                revision,
            )
        self.assertIsNotNone(
            server_relocation.proposal(
                "http://192.168.1.199:8010",
                seen,
                _announcement("http://192.168.1.50:8010", 6),
            )
        )

    def test_same_revision_with_a_different_address_is_refused_and_logged(self):
        seen = {"revision": 5, "url": "http://192.168.1.50:8010"}
        with self.assertLogs(server_relocation.__name__, level="ERROR") as logs:
            out = server_relocation.proposal(
                "http://192.168.1.199:8010", seen, _announcement("http://10.0.0.9:8010", 5)
            )
        self.assertIsNone(out)
        self.assertIn("server_relocation_revision_conflict", logs.output[0])

    def test_broken_seen_setting_is_treated_as_never_accepted(self):
        self.assertIsNotNone(
            server_relocation.proposal("http://192.168.1.199:8010", {}, _announcement())
        )


class IsolatedReadTests(unittest.TestCase):
    """8. 격리 읽기 — 실제 자식 프로세스로 읽고, 죽은 소스는 시간 안에 포기한다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.source = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def test_child_process_reads_and_parent_parses(self):
        (self.source / server_relocation.LOCATION_FILE).write_bytes(_location_bytes())
        out = server_relocation.read_announcement(str(self.source))
        self.assertEqual(out, _announcement())

    def test_missing_or_broken_file_is_quietly_none(self):
        self.assertIsNone(server_relocation.read_announcement(str(self.source)))
        (self.source / server_relocation.LOCATION_FILE).write_bytes(b"not json")
        self.assertIsNone(server_relocation.read_announcement(str(self.source)))

    def test_timeout_gives_up_instead_of_blocking(self):
        """죽은 NAS 대역 — 자식이 시간 안에 안 끝나면 회수하고 None."""
        (self.source / server_relocation.LOCATION_FILE).write_bytes(_location_bytes())
        self.assertIsNone(
            server_relocation.read_announcement(str(self.source), timeout=0.001)
        )


class InstallModeGateTests(unittest.TestCase):
    """7. 릴리스 설치본이 아니면 공지를 읽으러 가지도 않는다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def test_development_install_has_no_source_and_never_reads(self):
        self.assertIsNone(server_relocation.announcement_source(self.root))
        with mock.patch.object(server_relocation, "read_announcement") as read:
            self.assertIsNone(server_relocation.refresh(root=self.root))
        read.assert_not_called()

    def test_release_install_uses_the_trusted_install_source(self):
        source = str(self.root / "releases")
        (self.root / "INSTALL_SOURCE.txt").write_text(source, "utf-8")
        (self.root / "update_release.bat").write_text("@echo off", "utf-8")
        self.assertEqual(server_relocation.announcement_source(self.root), source)
        with mock.patch.object(
            server_relocation, "read_announcement", return_value=_announcement()
        ) as read:
            self.assertEqual(server_relocation.refresh(root=self.root), _announcement())
        read.assert_called_once()
        self.assertEqual(server_relocation.snapshot(), _announcement())

    def tearDown(self):
        server_relocation.remember(None)
        server_relocation._snapshot[0] = None


class RelocationRouteTests(unittest.TestCase):
    """4·5·6. 조회·전환 라우트."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.set_setting(publish._K_URL, "http://192.168.1.199:8010")
        repo.set_setting(publish._K_SERVER_NAME, "옛 팀 서버")
        repo.set_setting(publish._K_TOKEN, "secret-token")
        repo.set_setting(publish._K_EMAIL, "artist@example.com")
        repo.set_setting(publish._K_NAME, "Artist")
        # 실제 머신 상태(활성 계정 포인터·레거시 DB)를 테스트가 건드리지 않게 한다.
        self.enterContext(mock.patch.object(publish.active_account, "clear_active"))
        self.enterContext(
            mock.patch.object(publish.db, "DEFAULT_DB_PATH", Path(self.tmp.name) / "legacy.db")
        )

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        server_relocation._snapshot[0] = None
        self.tmp.cleanup()

    # ── 6. 가드 ──────────────────────────────────────────────────────────
    def _routes(self, request: Request):
        return [
            lambda: publish.shared_server_relocation(request),
            lambda: publish.relocate_shared_server(
                publish.RelocateIn(url="http://10.0.0.9:8010", revision=2), request
            ),
        ]

    def test_remote_and_rebinding_requests_are_rejected(self):
        requests = [
            _request(client_host="192.168.1.50"),
            _request(host_header="evil.example.com:8010"),
        ]
        for request in requests:
            for operation in self._routes(request):
                with self.assertRaises(HTTPException) as caught:
                    operation()
                self.assertEqual(caught.exception.status_code, 403)

    # ── 조회 ─────────────────────────────────────────────────────────────
    def test_status_reports_no_proposal_without_an_announcement(self):
        out = publish.shared_server_relocation(_request())
        self.assertEqual(out["current_url"], "http://192.168.1.199:8010")
        self.assertIsNone(out["proposed_url"])
        self.assertEqual(out["revision"], 0)
        self.assertFalse(out["reachable"])

    def test_status_reports_the_proposal_and_probes_the_new_address(self):
        server_relocation.remember(_announcement())
        with mock.patch.object(
            publish,
            "_probe_shared_health",
            return_value=publish._probe_result(True, True, "1.1.23", None),
        ) as probe:
            out = publish.shared_server_relocation(_request())
        probe.assert_called_once_with("http://192.168.1.50:8010")
        self.assertEqual(out["proposed_url"], "http://192.168.1.50:8010")
        self.assertEqual(out["revision"], 2)
        self.assertEqual(out["server_name"], "MV 팀 서버")
        self.assertTrue(out["reachable"])

    def test_proposal_without_a_name_keeps_showing_the_current_server_name(self):
        """자리만 옮긴 같은 서버다 — 공지에 이름이 없으면 지금 쓰던 이름을 그대로 보여준다."""
        server_relocation.remember(_announcement(name=""))
        with mock.patch.object(
            publish,
            "_probe_shared_health",
            return_value=publish._probe_result(True, True, None, None),
        ):
            out = publish.shared_server_relocation(_request())
        self.assertEqual(out["server_name"], "옛 팀 서버")

    def test_status_never_reads_the_announcement_file_in_the_request(self):
        """조회는 백그라운드 스냅샷만 본다 — 죽은 NAS 가 이 요청을 붙잡으면 안 된다."""
        server_relocation.remember(_announcement())
        with (
            mock.patch.object(server_relocation, "read_announcement") as read,
            mock.patch.object(
                publish,
                "_probe_shared_health",
                return_value=publish._probe_result(True, True, None, None),
            ),
        ):
            publish.shared_server_relocation(_request())
        read.assert_not_called()

    # ── 4. 전환 재검증 ───────────────────────────────────────────────────
    def _relocate(self, url: str, revision: int, announcement, *, probe_ok: bool = True):
        with (
            mock.patch.object(
                server_relocation, "announcement_source", return_value="D:\\releases"
            ),
            mock.patch.object(
                server_relocation, "read_announcement", return_value=announcement
            ),
            mock.patch.object(
                publish,
                "_probe_shared_health",
                return_value=publish._probe_result(
                    probe_ok, True, "1.1.23", None if probe_ok else "MV Hub 서버가 아닙니다"
                ),
            ),
        ):
            return publish.relocate_shared_server(
                publish.RelocateIn(url=url, revision=revision), _request()
            )

    def _assert_untouched(self):
        self.assertEqual(repo.get_setting(publish._K_URL), "http://192.168.1.199:8010")
        self.assertEqual(repo.get_setting(publish._K_TOKEN), "secret-token")

    def test_browser_supplied_address_is_not_trusted(self):
        """공지엔 A 가 적혀 있는데 브라우저가 B 를 보내면 전환하지 않는다."""
        with self.assertRaises(HTTPException) as caught:
            self._relocate("http://10.0.0.9:8010", 2, _announcement())
        self.assertEqual(caught.exception.status_code, 409)
        self._assert_untouched()

    def test_stale_revision_from_the_browser_is_refused(self):
        with self.assertRaises(HTTPException) as caught:
            self._relocate("http://192.168.1.50:8010", 1, _announcement(revision=2))
        self.assertEqual(caught.exception.status_code, 409)
        self._assert_untouched()

    def test_unreadable_announcement_refuses_the_switch(self):
        with self.assertRaises(HTTPException) as caught:
            self._relocate("http://192.168.1.50:8010", 2, None)
        self.assertEqual(caught.exception.status_code, 409)
        self._assert_untouched()

    def test_unreachable_new_address_refuses_the_switch(self):
        with self.assertRaises(HTTPException) as caught:
            self._relocate("http://192.168.1.50:8010", 2, _announcement(), probe_ok=False)
        self.assertEqual(caught.exception.status_code, 400)
        self._assert_untouched()

    def test_malformed_address_is_refused_before_any_read(self):
        with mock.patch.object(server_relocation, "read_announcement") as read:
            for bad in ("ftp://x", "http://", "http://u:p@h", "http://h?q=1", "not-a-url"):
                with self.assertRaises(HTTPException) as caught:
                    publish.relocate_shared_server(
                        publish.RelocateIn(url=bad, revision=2), _request()
                    )
                self.assertEqual(caught.exception.status_code, 400)
        read.assert_not_called()

    # ── 5. 원자 전환 ─────────────────────────────────────────────────────
    def test_successful_switch_replaces_the_address_and_clears_the_session(self):
        out = self._relocate("http://192.168.1.50:8010", 2, _announcement())
        self.assertTrue(out["ok"])
        self.assertEqual(repo.get_setting(publish._K_URL), "http://192.168.1.50:8010")
        for key in (publish._K_TOKEN, publish._K_EMAIL, publish._K_NAME, publish._K_ROLES):
            self.assertIsNone(repo.get_setting(key), key)
        self.assertFalse(out["has_token"])
        # 옛 주소는 로그인 화면의 '되돌아갈 후보'로 남는다.
        self.assertEqual(publish._url_history(), ["http://192.168.1.199:8010"])
        publish.active_account.clear_active.assert_called_once()

    def test_switch_adopts_the_announced_server_name(self):
        out = self._relocate("http://192.168.1.50:8010", 2, _announcement())
        self.assertEqual(repo.get_setting(publish._K_SERVER_NAME), "MV 팀 서버")
        self.assertEqual(out["server_name"], "MV 팀 서버")
        # 옛 주소는 '그때의 이름'과 짝지어 이력에 남는다 — 되돌아가면 그 이름이 되살아난다.
        self.assertEqual(
            publish._url_history_entries(),
            [{"url": "http://192.168.1.199:8010", "name": "옛 팀 서버"}],
        )
        self.assertEqual(publish._server_name_for("http://192.168.1.199:8010"), "옛 팀 서버")

    def test_switch_without_an_announced_name_keeps_the_current_one(self):
        self._relocate("http://192.168.1.50:8010", 2, _announcement(name=""))
        self.assertEqual(repo.get_setting(publish._K_SERVER_NAME), "옛 팀 서버")

    def test_accepted_revision_is_remembered_so_it_is_not_proposed_again(self):
        self._relocate("http://192.168.1.50:8010", 2, _announcement())
        self.assertEqual(
            shared_connection.relocation_seen(),
            {"revision": 2, "url": "http://192.168.1.50:8010"},
        )
        # 같은 공지는 더 이상 제안되지 않는다(주소도 이미 그 주소).
        server_relocation.remember(_announcement())
        self.assertIsNone(publish.shared_server_relocation(_request())["proposed_url"])

    def test_seen_never_records_a_token_or_email(self):
        self._relocate("http://192.168.1.50:8010", 2, _announcement())
        raw = repo.get_setting(shared_connection.K_RELOCATION_SEEN) or ""
        self.assertNotIn("secret-token", raw)
        self.assertNotIn("artist@example.com", raw)

    def test_failure_midway_restores_everything(self):
        """세션 정리 도중 실패하면 주소도 토큰도 전환 전 상태로 돌아간다."""
        real_set_setting = repo.set_setting
        failed = {"done": False}

        def flaky(key, value):
            if key == publish._K_NAME and not failed["done"]:
                failed["done"] = True
                raise RuntimeError("설정 저장 실패")
            return real_set_setting(key, value)

        with mock.patch.object(publish.repo, "set_setting", side_effect=flaky):
            with self.assertRaises(HTTPException) as caught:
                self._relocate("http://192.168.1.50:8010", 2, _announcement())
        self.assertEqual(caught.exception.status_code, 500)
        self.assertEqual(repo.get_setting(publish._K_URL), "http://192.168.1.199:8010")
        self.assertEqual(repo.get_setting(publish._K_SERVER_NAME), "옛 팀 서버")
        self.assertEqual(repo.get_setting(publish._K_TOKEN), "secret-token")
        self.assertEqual(repo.get_setting(publish._K_EMAIL), "artist@example.com")
        self.assertEqual(shared_connection.relocation_seen(), {})
        # 되돌릴 수 없는 포인터 해제까지 가지 않았다.
        publish.active_account.clear_active.assert_not_called()


class ServerNameRegistrationTests(unittest.TestCase):
    """서버 표시 이름 — 관리자가 주소와 함께 등록하고, 작업자에겐 이름만 보인다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_admin_registers_name_with_the_address_and_status_exposes_it(self):
        out = publish.set_shared_url(
            publish.SetUrlIn(url="http://192.168.1.50:8010/", name="  MV 팀 서버  "), _request()
        )
        self.assertEqual(out["url"], "http://192.168.1.50:8010")
        self.assertEqual(out["server_name"], "MV 팀 서버")
        self.assertEqual(shared_connection.server_name(), "MV 팀 서버")

    def test_name_is_optional_and_can_be_cleared(self):
        publish.set_shared_url(publish.SetUrlIn(url="http://h:8010", name="이름"), _request())
        publish.set_shared_url(publish.SetUrlIn(url="http://h:8010"), _request())
        self.assertEqual(publish.shared_server_status(_request())["server_name"], "")

    def test_control_characters_and_length_are_stripped(self):
        publish.set_shared_url(
            publish.SetUrlIn(url="http://h:8010", name="A\nB\tC" + "가" * 100), _request()
        )
        stored = shared_connection.server_name()
        self.assertNotIn("\n", stored)
        self.assertNotIn("\t", stored)
        self.assertLessEqual(len(stored), shared_connection.SERVER_NAME_MAX)

    def test_server_name_key_is_separate_from_the_account_display_name(self):
        """'서버 이름'과 '로그인한 사람 이름'은 다른 키다 — 로그아웃해도 서버 이름은 남는다."""
        self.assertNotEqual(publish._K_SERVER_NAME, publish._K_NAME)
        publish.set_shared_url(
            publish.SetUrlIn(url="http://h:8010", name="MV 팀 서버"), _request()
        )
        repo.set_setting(publish._K_NAME, "Artist")
        with (
            mock.patch.object(publish.active_account, "clear_active"),
            mock.patch.object(
                publish.db, "DEFAULT_DB_PATH", Path(self.tmp.name) / "legacy.db"
            ),
        ):
            out = publish.shared_server_logout(_request())
        self.assertIsNone(out["name"])  # 사람 이름은 지워지고
        self.assertEqual(out["server_name"], "MV 팀 서버")  # 서버 이름은 남는다

    def test_login_adopts_the_name_stored_for_that_address(self):
        publish.set_shared_url(
            publish.SetUrlIn(url="http://192.168.1.199:8010", name="옛 팀 서버"), _request()
        )
        self._login("http://192.168.1.50:8010")  # 이름을 모르는 새 주소 → 비운다
        self.assertEqual(shared_connection.server_name(), "")
        self._login("http://192.168.1.199:8010")  # 되돌아가면 이력에서 이름을 되찾는다
        self.assertEqual(shared_connection.server_name(), "옛 팀 서버")

    def test_legacy_string_history_is_still_readable(self):
        """업데이트 전에 쌓인 이력(주소 문자열 배열)도 그대로 후보로 남는다."""
        repo.set_setting(publish._K_URL_HISTORY, json.dumps(["http://a", "http://b"]))
        self.assertEqual(publish._url_history(), ["http://a", "http://b"])
        self.assertEqual(
            publish._url_history_entries(),
            [{"url": "http://a", "name": ""}, {"url": "http://b", "name": ""}],
        )

    def test_history_never_contains_token_or_email(self):
        publish.set_shared_url(
            publish.SetUrlIn(url="http://192.168.1.199:8010", name="옛 팀 서버"), _request()
        )
        self._login("http://192.168.1.50:8010")
        raw = repo.get_setting(publish._K_URL_HISTORY) or ""
        self.assertIn("옛 팀 서버", raw)
        self.assertNotIn("secret-token", raw)
        self.assertNotIn("artist@example.com", raw)

    def _login(self, url: str) -> None:
        def run_before_publish(email, uid, *, before_publish=None):
            if before_publish is not None:
                before_publish()

        with (
            mock.patch.object(
                publish,
                "_http_json",
                return_value=(
                    200,
                    {
                        "token": "secret-token",
                        "account": {
                            "email": "artist@example.com",
                            "name": "Artist",
                            "global_roles": [],
                        },
                    },
                ),
            ),
            mock.patch.object(publish, "_switch_account_db", side_effect=run_before_publish),
            mock.patch.object(publish, "kick_share_state_reconciler"),
        ):
            publish.shared_server_login(
                publish.SharedLoginIn(url=url, email="artist@example.com", password="pw"),
                _request(),
            )


if __name__ == "__main__":
    unittest.main()
