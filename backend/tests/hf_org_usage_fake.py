"""Only loopback HTTP and temporary DBs. No production key, server or data path."""
from __future__ import annotations

import json
import threading
import urllib.parse
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from app import db, manage_db
from app.repo import hf_org_usage as repo
from app.repo.manage_schema import _ensure_schema
from app.services import hf_org_usage_collector as worker, hf_org_usage_key as key_service

ORG = "00000000-0000-0000-0000-000000000001"
FAKE_KEY = "fake-org-key-for-loopback-only"


@pytest.fixture
def world(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content.db"))
    monkeypatch.setattr(manage_db, "MANAGE_DB_PATH", tmp_path / "manage.db")
    db.flush_pool()
    db.init_db()
    with db.get_connection() as conn:
        _ensure_schema(conn)
    manage_db.init_manage_db()
    monkeypatch.setattr(key_service.comfy_team_key, "protect", lambda _: "encrypted-fixture")
    monkeypatch.setattr(key_service.comfy_team_key, "unprotect", lambda _: FAKE_KEY)
    yield tmp_path
    db.flush_pool()


def configured(enabled=True):
    old = repo.read_config()
    settings = repo.update_config(old["revision"], dict(org_id=ORG, encrypted_key="encrypted-fixture", enabled=int(enabled)), verified=True)
    owner = "fixture-owner"
    fence = repo.acquire_lease(owner)
    return dict(org_id=ORG, revision=settings["revision"], owner=owner, fence=fence)


def row(row_id="r1", *, start=1_800_000_000_000, **changes):
    value = {key: None for key in repo.ROW_FIELDS}
    value.update(row_id=row_id, type="generation", created_at=start, workspace_id="space-1", workspace_name="Space",
                 actor_user_id="user_exact", actor_email="unlinked@example.test", credits_c=125,
                 charged_c=150, refunded_c=25, generation_id="job-1")
    value.update(changes)
    return value


def window(context, start, end=None, kind="day"):
    repo.reserve_windows(context["org_id"], [(start, end or start + repo.DAY_MS, kind, 0)])
    with manage_db.get_connection() as conn:
        return dict(conn.execute("SELECT * FROM hf_org_usage_window WHERE start_ms=? AND kind=?", (start, kind)).fetchone())


def publish(context, item, rows, *, complete=True, actual_end=None):
    with manage_db.get_connection() as conn:
        repo.create_stage(conn)
        repo.stage_rows(conn, rows)
        repo.publish_window(conn, item, context, actual_end=actual_end or item["end_ms"],
                            started=repo.now_ms(), pages=1, next_due=repo.now_ms() + 600000, complete=complete)


def wire_row(row_id="00000000-0000-0000-0000-000000000002", **changes):
    value = dict(id=row_id, type="generation", created_at="2026-11-01T00:00:00.123Z",
                 workspace_id="00000000-0000-0000-0000-000000000003", workspace_name="Deleted workspace",
                 actor=dict(type="user_actor", user_id="user_" + "a"*32, email_address="fixture@example.test", name="Not retained"),
                 model="model_new", model_name="New Model", credits="0.15", credits_charged="8.00", credits_refunded="7.85",
                 status="future_status", state="future_state", started_at=None, completed_at=None, failed_at=None,
                 error=dict(code="future_error", message="Not retained"), generation_id=row_id, original_generation_id=None,
                 output_type="future_output", parameters=dict(batch_size=4),
                 source=dict(surface="future_surface", client_name="Not retained", cli_version="Not retained"),
                 projects=[dict(id="project", name="Not retained")], chat_id=None)
    value.update(changes)
    return value


def report_page(start, end, rows=(), *, next_page=None, org=ORG):
    def iso(value):
        if isinstance(value, str):
            return value
        return datetime.fromtimestamp(value // 1000, timezone.utc).replace(microsecond=(value % 1000)*1000).isoformat(timespec="microseconds").replace("+00:00", "Z")
    return dict(data=list(rows), has_more=next_page is not None, next_page=next_page,
                organization_id=org, starting_at=iso(start), ending_at=iso(end), generated_at="2026-11-10T07:00:00.123Z")


def api_error(code, *, message="fixture error"):
    return dict(type="error", error=dict(type="api_error", code=code, message=message, param=None), request_id="fake-request-id")


@contextmanager
def fake_server(replies, *, organization=False):
    """Responses are supplied by tests; request logs deliberately exclude headers/key."""
    calls = []
    pending = list(replies)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            invalid = None
            if organization:
                if "api_key" in query:
                    invalid = (400, {}, api_error("api_key_in_url"))
                elif self.headers.get("x-api-key") != FAKE_KEY:
                    invalid = (401, {}, api_error("invalid_api_key"))
                elif not self.headers.get("User-Agent") or self.headers.get("Accept") != "application/json":
                    invalid = (400, {}, api_error("missing_parameter"))
                elif set(query) - {"starting_at", "ending_at", "limit", "page"}:
                    invalid = (400, {}, api_error("unknown_parameter"))
                elif any(len(values) != 1 for values in query.values()):
                    invalid = (400, {}, api_error("duplicate_parameter"))
                else:
                    try:
                        start = datetime.fromisoformat(query["starting_at"][0].replace("Z", "+00:00"))
                        end = datetime.fromisoformat(query["ending_at"][0].replace("Z", "+00:00"))
                        limit = int(query["limit"][0])
                        if start < datetime(2026, 2, 1, tzinfo=timezone.utc):
                            invalid = (400, {}, api_error("before_data_start"))
                        elif start >= end or (end-start).total_seconds() > 31*86400 or not 1 <= limit <= 1000:
                            invalid = (400, {}, api_error("invalid_range"))
                    except (KeyError, ValueError, TypeError):
                        invalid = (400, {}, api_error("invalid_parameter"))
            # Even a broken client cannot put the fixture key into captured URLs/test output.
            calls.append(self.path.replace(FAKE_KEY, "[redacted]"))
            reply = invalid or (pending.pop(0) if pending else (500, {}, api_error("internal_error")))
            if callable(reply):
                reply = reply(query)
            code, headers, body = reply
            raw = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            for key, value in headers.items():
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/report", calls
    finally:
        server.shutdown()
        server.server_close()
        thread.join(3)
