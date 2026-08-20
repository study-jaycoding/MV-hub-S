"""일반(비캔버스) 생성 요청의 계정별 멱등 계약."""

from __future__ import annotations

import asyncio
import concurrent.futures
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

from app import db, repo
from app.models import GenerationCreate, GenRequestIn, WorkspaceContext
from app.routers import gen_requests as gen_requests_router
from app.usecases.gen_requests import (
    GenRequestCommand,
    submit_gen_request,
)


class _State:
    account = {
        "email": "artist@example.com",
        "creator_uid": "artist",
    }


class _Request:
    state = _State()


class GenRequestIdempotencyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = str(Path(self.tmp.name) / "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    @staticmethod
    def _command(prompt: str, key: str | None) -> GenRequestCommand:
        data = GenerationCreate(prompt=prompt, model="model").model_dump()
        return GenRequestCommand(
            kind="create",
            email="artist@example.com",
            creator_uid="artist",
            worker_id="me",
            source_gen_id=None,
            workspace={"scope": "personal", "id": None, "name": None},
            data=data,
            idempotency_key=key,
        )

    @staticmethod
    def _submit(command: GenRequestCommand):
        with mock.patch(
            "app.usecases.gen_requests.MANAGE_ENABLED", False
        ), mock.patch(
            "app.usecases.gen_requests.agent_signals.signal"
        ), mock.patch(
            "app.usecases.gen_requests.journal_generation_event"
        ):
            return asyncio.run(submit_gen_request(command))

    def test_same_key_returns_same_response_and_one_row(self):
        key = "11111111-1111-4111-8111-111111111111"

        first = self._submit(self._command("same", key))
        second = self._submit(self._command("same", key))

        self.assertEqual(first, second)
        with db.get_connection() as conn:
            request_count = conn.execute(
                "SELECT count(*) n FROM gen_request WHERE account_email=? "
                "AND idempotency_key=?",
                ("artist@example.com", key),
            ).fetchone()["n"]
            generation_count = conn.execute(
                "SELECT count(*) n FROM generation WHERE id=?", (first["id"],)
            ).fetchone()["n"]
        self.assertEqual((request_count, generation_count), (1, 1))

    def test_same_key_with_different_payload_is_http_409(self):
        key = "22222222-2222-4222-8222-222222222222"
        def body(prompt: str) -> GenRequestIn:
            return GenRequestIn(
                kind="create",
                workspace=WorkspaceContext(scope="personal"),
                create=GenerationCreate(prompt=prompt, model="model"),
                idempotency_key=key,
            )

        with mock.patch(
            "app.usecases.gen_requests.MANAGE_ENABLED", False
        ), mock.patch(
            "app.usecases.gen_requests.agent_signals.signal"
        ), mock.patch(
            "app.usecases.gen_requests.journal_generation_event"
        ), mock.patch.object(
            gen_requests_router, "schedule_telemetry_drain"
        ):
            asyncio.run(gen_requests_router.create_gen_request(body("first"), _Request()))
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(
                    gen_requests_router.create_gen_request(body("changed"), _Request())
                )
        self.assertEqual(caught.exception.status_code, 409)

    def test_missing_key_keeps_legacy_duplicate_behavior(self):
        first = self._submit(self._command("legacy", None))
        second = self._submit(self._command("legacy", None))

        self.assertNotEqual(first["id"], second["id"])
        with db.get_connection() as conn:
            counts = (
                conn.execute(
                    "SELECT count(*) n FROM gen_request WHERE idempotency_key IS NULL"
                ).fetchone()["n"],
                conn.execute("SELECT count(*) n FROM generation").fetchone()["n"],
            )
        self.assertEqual(counts, (2, 2))

    def test_concurrent_same_key_creates_one_request_and_placeholder(self):
        key = "33333333-3333-4333-8333-333333333333"
        command = self._command("concurrent", key)
        original_create = repo.create_local_generation
        both_at_create = threading.Barrier(2)

        def synchronized_create(*args, **kwargs):
            both_at_create.wait(timeout=5)
            return original_create(*args, **kwargs)

        with mock.patch(
            "app.usecases.gen_requests.repo.create_local_generation",
            side_effect=synchronized_create,
        ), mock.patch(
            "app.usecases.gen_requests.MANAGE_ENABLED", False
        ), mock.patch(
            "app.usecases.gen_requests.agent_signals.signal"
        ) as signal, mock.patch(
            "app.usecases.gen_requests.journal_generation_event"
        ) as journal, concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(
                pool.map(
                    lambda _index: asyncio.run(submit_gen_request(command)), range(2)
                )
            )

        self.assertEqual(results[0], results[1])
        signal.assert_called_once_with("artist@example.com", "gen-request")
        journal.assert_called_once()
        with db.get_connection() as conn:
            counts = (
                conn.execute(
                    "SELECT count(*) n FROM gen_request WHERE idempotency_key=?",
                    (key,),
                ).fetchone()["n"],
                conn.execute(
                    "SELECT count(*) n FROM generation WHERE id=?",
                    (results[0]["id"],),
                ).fetchone()["n"],
            )
        self.assertEqual(counts, (1, 1))


if __name__ == "__main__":
    unittest.main()
