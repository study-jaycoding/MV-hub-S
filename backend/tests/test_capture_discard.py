"""캡처 고아 정리(/api/assets/capture-discard) 계약 — 부분 수정이 올린 캡처가 생성 요청
확정 거절(400/422)로 잡과 연결되지 못했을 때만, 서버 발급 1회용 토큰으로 지운다.

핵심 계약(코덱스 합의):
· 토큰은 '신규 업로드'에만 발급, reused 업로드가 오면 같은 파일의 옛 토큰 무효화.
· reference 테이블이 그 파일을 참조하면 409 — 잡과 연결된 파일은 절대 지우지 않는다.
· 원격 호스트 403(작업자 PC 전용), 만료/재사용 토큰 404.
"""

from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.routers import assets
from app.services import request_guards


def _request(host: str = "127.0.0.1") -> Request:
    return Request(
        {"type": "http", "method": "POST", "path": "/", "headers": [], "client": (host, 5000)}
    )


@pytest.fixture()
def local_only(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        request_guards, "local_machine_hosts", lambda: frozenset({"127.0.0.1"})
    )


@pytest.fixture()
def captures_root(tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(assets, "ASSETS_ROOT", tmp_path)
    (tmp_path / "captures").mkdir()
    # 전역 토큰 저장소를 테스트 간 격리
    monkeypatch.setattr(assets, "_capture_discard_tokens", {})
    return tmp_path


def _fake_db(monkeypatch: pytest.MonkeyPatch, referenced_paths: list[str]):
    @contextmanager
    def fake_connection():
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE reference (file_path TEXT)")
        conn.executemany(
            "INSERT INTO reference VALUES (?)", [(p,) for p in referenced_paths]
        )
        try:
            yield conn
        finally:
            conn.close()

    monkeypatch.setattr(assets, "get_connection", fake_connection)


def test_discard_deletes_unreferenced_new_capture(local_only, captures_root, monkeypatch):
    _fake_db(monkeypatch, [])
    f = captures_root / "captures" / "capture-x.png"
    f.write_bytes(b"png")
    token = assets._issue_capture_discard_token("capture-x.png")
    body = assets.CaptureDiscardIn(token=token)
    assert assets.discard_capture(body, _request()) == {"ok": True}
    assert not f.exists()
    # 토큰은 1회용 — 재사용은 404
    with pytest.raises(HTTPException) as exc:
        assets.discard_capture(body, _request())
    assert exc.value.status_code == 404


def test_discard_refuses_referenced_file(local_only, captures_root, monkeypatch):
    """생성물이 이미 참조하는 파일은 지우지 않는다(레퍼런스 깨짐 방지)."""
    _fake_db(monkeypatch, ["asset:captures|capture-x.png"])
    f = captures_root / "captures" / "capture-x.png"
    f.write_bytes(b"png")
    token = assets._issue_capture_discard_token("capture-x.png")
    with pytest.raises(HTTPException) as exc:
        assets.discard_capture(assets.CaptureDiscardIn(token=token), _request())
    assert exc.value.status_code == 409
    assert f.exists()


def test_discard_is_local_machine_only(local_only, captures_root, monkeypatch):
    _fake_db(monkeypatch, [])
    token = assets._issue_capture_discard_token("capture-x.png")
    with pytest.raises(HTTPException) as exc:
        assets.discard_capture(assets.CaptureDiscardIn(token=token), _request("192.168.10.44"))
    assert exc.value.status_code == 403


def test_discard_rejects_expired_and_unknown_tokens(local_only, captures_root, monkeypatch):
    _fake_db(monkeypatch, [])
    with pytest.raises(HTTPException) as exc:
        assets.discard_capture(assets.CaptureDiscardIn(token="no-such"), _request())
    assert exc.value.status_code == 404
    # 만료 토큰 — 직접 과거 만료로 심는다
    assets._capture_discard_tokens["old"] = ("capture-x.png", time.monotonic() - 1.0)
    with pytest.raises(HTTPException) as exc:
        assets.discard_capture(assets.CaptureDiscardIn(token="old"), _request())
    assert exc.value.status_code == 404


def test_reused_upload_invalidates_prior_tokens(local_only, captures_root, monkeypatch):
    """같은 내용이 재업로드(reused)되면 그 파일을 가리키던 옛 토큰은 무효 — 다른 제출이
    참조하기 시작한 파일을 최초 업로더가 지우는 경합 차단."""
    _fake_db(monkeypatch, [])
    f = captures_root / "captures" / "capture-x.png"
    f.write_bytes(b"png")
    token = assets._issue_capture_discard_token("capture-x.png")
    assets._invalidate_capture_discard_tokens("capture-x.png")  # reused 경로가 부르는 함수
    with pytest.raises(HTTPException) as exc:
        assets.discard_capture(assets.CaptureDiscardIn(token=token), _request())
    assert exc.value.status_code == 404
    assert f.exists()


def test_finalize_reused_capture_atomic_contract(local_only, captures_root, monkeypatch):
    """reuse 확정과 discard 는 같은 락 경계 — 파일이 살아 있으면 옛 토큰을 무효화한 뒤
    정상 응답(이후 discard 불가), 이미 정리된 뒤라면 사라진 경로 대신 409(코덱스 BLOCK 해소)."""
    _fake_db(monkeypatch, [])
    f = captures_root / "captures" / "capture-x.png"
    f.write_bytes(b"png")
    token = assets._issue_capture_discard_token("capture-x.png")
    out = assets._finalize_reused_capture(f)
    assert out["reused"] is True
    # reuse 가 먼저 확정됐으면 옛 토큰으로는 못 지운다(무효화됨)
    with pytest.raises(HTTPException) as exc:
        assets.discard_capture(assets.CaptureDiscardIn(token=token), _request())
    assert exc.value.status_code == 404
    assert f.exists()
    # 반대 순서: 파일이 이미 정리된 뒤의 reuse 확정은 사라진 경로 응답 대신 409
    f.unlink()
    with pytest.raises(HTTPException) as exc:
        assets._finalize_reused_capture(f)
    assert exc.value.status_code == 409


def test_missing_file_is_not_an_error(local_only, captures_root, monkeypatch):
    """이미 사라진 파일(missing_ok) — 정리 목적은 달성된 것이라 ok."""
    _fake_db(monkeypatch, [])
    token = assets._issue_capture_discard_token("gone.png")
    assert assets.discard_capture(assets.CaptureDiscardIn(token=token), _request()) == {"ok": True}
