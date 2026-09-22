"""로컬 Resolve 선택 감시 자식의 수명과 MV Hub WebSocket 전달을 관리한다."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import ntpath
import os
import subprocess
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from .. import active_account, rbac, repo
from ..config import AUTH_ENABLED
from ..deps import realtime_scope
from ..ws import manager
from .resolve_bridge import _normal_path
from . import local_agent_pair
from .async_tools import to_thread_non_abandon
from .resolve_queue import run_non_abandon
from .resolve_selection_worker import MAX_SELECTIONS, RESULT_PREFIX
from .resolve_status_runner import launch_window_active, resolve_compatible_interpreter
from .resolve_transfer import manifest_generation_entries, manifest_source_roots


_BACKEND_DIR = Path(__file__).resolve().parents[2]
_CLIENT_CHECK_SECONDS = 1.0
_INDEX_REUSE_SECONDS = 60.0
_RESTART_DELAYS = (2.0, 5.0, 30.0)
_log = logging.getLogger("mvhub.resolve_selection")


class ResolveSelectionMonitor:
    def __init__(self) -> None:
        self._task: asyncio.Task[None] | None = None
        self._process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._process_lock = asyncio.Lock()
        self._selection_ready = asyncio.Event()
        self._selection_revision = 0
        self._process_epoch = 0
        self._worker_had_snapshot = False
        self._latest_line: tuple[int, bytes] | None = None
        self._reader_closed = True
        self._pause_count = 0
        self._stopping = False
        self._priming = False
        self._last_selection_key: tuple[tuple[str, ...], int, bool] | None = None
        self._index_cache: tuple[
            float,
            str,
            tuple[str, ...],
            tuple[tuple[str, str], ...],
            dict[str, tuple[str, str]],
        ] | None = None
        self._roots_cache: tuple[
            float, str, tuple[str, ...], dict[str, Path]
        ] | None = None

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stopping = False
        self._task = asyncio.create_task(self._run(), name="resolve-selection-monitor")

    async def stop(self) -> None:
        self._stopping = True
        task = self._task
        if task:
            task.cancel()

        async def finish() -> None:
            await self._stop_process()
            if task:
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            if self._task is task:
                self._task = None

        # 종료 요청 자체가 취소돼도 자식과 감시 태스크의 회수를 마친다.
        await run_non_abandon(finish())

    @asynccontextmanager
    async def suspended(self) -> AsyncIterator[None]:
        """Resolve를 변경하는 동안 읽기 poller도 같은 앱에 동시 호출하지 않게 멈춘다."""
        self._pause_count += 1
        try:
            await self._stop_process()
            yield
        finally:
            self._pause_count = max(0, self._pause_count - 1)
            # 직접 전송이 새 manifest를 만들었거나 갱신했을 수 있다.
            self._index_cache = None
            self._roots_cache = None

    def _held(self) -> bool:
        """멈춰 있어야 하나 — 변경 작업 중(suspended)이거나 앱이 Resolve 를 켜는 중(켜기 창, Codex P1)."""
        return bool(self._pause_count) or launch_window_active()

    async def _stop_process(self) -> None:
        await run_non_abandon(self._stop_process_locked())

    async def _stop_process_locked(self) -> None:
        async with self._process_lock:
            await self._close_process()

    async def _close_process(self) -> None:
        # 호출자는 시작·참조 등록과 같은 잠금을 종료 완료까지 보유한다.
        process, self._process = self._process, None
        self._selection_revision += 1
        self._process_epoch += 1
        self._latest_line = None
        self._reader_closed = True
        self._selection_ready.set()
        reader, self._reader_task = self._reader_task, None
        if reader:
            reader.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await reader
        if process is not None:
            await self._terminate_process(process)

    @staticmethod
    async def _terminate_process(process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return
        with contextlib.suppress(ProcessLookupError):
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()

    async def _start_process(self) -> None:
        async with self._process_lock:
            if self._held() or self._stopping:
                return
            # _run의 판정 뒤 suspend가 들어와도 생성·참조 등록·reader 시작을
            # 한 단위로 마친다. 호출자는 이 단위가 끝난 뒤에 취소를 전파한다.
            self._process = await self._launch_process()
            if self._process is not None:
                self._reader_closed = False
                self._selection_ready.clear()
                self._reader_task = asyncio.create_task(
                    self._read_selections(self._process), name="resolve-selection-reader"
                )

    async def _launch_process(self) -> asyncio.subprocess.Process | None:
        interpreter, _failure = await asyncio.to_thread(resolve_compatible_interpreter)
        if not interpreter or self._held() or self._stopping:
            return None
        child_env = os.environ.copy()
        child_env["PYTHONIOENCODING"] = "utf-8"
        child_env["PYTHONDONTWRITEBYTECODE"] = "1"
        process = await asyncio.create_subprocess_exec(
            interpreter,
            "-m",
            "app.services.resolve_selection_worker",
            cwd=str(_BACKEND_DIR),
            env=child_env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            limit=1024 * 1024,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        # 인터프리터 probe 중 suspend/stop이 들어온 경쟁 구간을 닫는다. 대입 전이라
        # _stop_process가 볼 수 없었던 자식은 여기서 직접 회수한다.
        if self._held() or self._stopping:
            await self._terminate_process(process)
            return None
        self._priming = True
        self._worker_had_snapshot = False
        return process

    @staticmethod
    def _account_snapshot_locked() -> tuple[str, str | None, dict[str, Any] | None]:
        """현재 로컬 사용자를 반환한다. 호출자는 transition_lock을 잡고 있어야 한다."""
        if AUTH_ENABLED:
            # 공유 서버에서는 이 monitor 자체가 시작되지 않는다. AUTH-on 격리 test_dev만
            # 브라우저 /me가 메모리에 남긴 로컬 pairing 계정을 사용한다.
            account_key = local_agent_pair.active_email() or ""
            account = repo.get_account(account_key) if account_key else None
            if not account or account.get("status") != "approved":
                return "", None, None
            account_uid = str(account.get("creator_uid") or "").strip() or None
            return account_key, account_uid, account
        account_key = active_account.account_key() or ""
        return account_key, active_account.active_uid(), None

    @classmethod
    def _active_account_identity(cls) -> tuple[str, str | None]:
        with active_account.transition_lock:
            account_key, account_uid, _account = cls._account_snapshot_locked()
            return account_key, account_uid

    @classmethod
    def _active_account_projects(cls) -> tuple[str, str | None, list[str], str | None]:
        """계정 키·프로젝트 목록·WS 스코프를 같은 전환 잠금 안에서 캡처한다."""
        with active_account.transition_lock:
            account_key, account_uid, account = cls._account_snapshot_locked()
            if AUTH_ENABLED and account is None:
                return "", None, [], None
            member_uid: str | None = None
            if AUTH_ENABLED and account is not None:
                read_all = rbac.has_global_cap(
                    rbac.parse_roles(account.get("global_role")), "read_all"
                )
                if not read_all:
                    member_uid = account_uid or f"acct:{account_key}"
            projects = repo.list_projects(
                include_archived=True, member_uid=member_uid
            ).get("projects") or []
            project_ids = [
                str(project.get("id") or "")
                for project in projects
                if isinstance(project, dict) and project.get("id")
            ]
            return account_key, account_uid, project_ids, realtime_scope(account)

    def _path_index(
        self,
        account_key: str,
        project_ids: list[str],
        source_roots: dict[str, Path],
    ) -> dict[str, tuple[str, str]]:
        project_key = tuple(sorted(set(project_ids)))
        root_key = tuple(
            sorted((project_id, _normal_path(str(root))) for project_id, root in source_roots.items())
        )
        cached = self._index_cache
        if (
            cached
            and cached[1] == account_key
            and cached[2] == project_key
            and cached[3] == root_key
            and time.monotonic() - cached[0] < _INDEX_REUSE_SECONDS
        ):
            return cached[4]
        index: dict[str, tuple[str, str]] = {}
        ambiguous: set[str] = set()
        for entry in manifest_generation_entries(
            list(project_key), source_roots=source_roots
        ):
            normalized = _normal_path(entry["local_path"])
            value = (entry["project_id"], entry["generation_id"])
            if not normalized:
                continue
            previous = index.get(normalized)
            if previous is not None and previous != value:
                ambiguous.add(normalized)
                index.pop(normalized, None)
            elif normalized not in ambiguous:
                index[normalized] = value
        self._index_cache = (
            time.monotonic(),
            account_key,
            project_key,
            root_key,
            index,
        )
        return index

    def _source_roots(
        self, account_key: str, project_ids: list[str]
    ) -> dict[str, Path]:
        project_key = tuple(sorted(set(project_ids)))
        cached = self._roots_cache
        if (
            cached
            and cached[1] == account_key
            and cached[2] == project_key
            and time.monotonic() - cached[0] < _INDEX_REUSE_SECONDS
        ):
            return cached[3]
        roots = manifest_source_roots(list(project_key))
        self._roots_cache = (time.monotonic(), account_key, project_key, roots)
        return roots

    @staticmethod
    def _under_source_root(normalized: str, source_roots: dict[str, Path]) -> bool:
        for root in source_roots.values():
            root_normalized = _normal_path(str(root))
            try:
                if ntpath.commonpath((normalized, root_normalized)) == root_normalized:
                    return True
            except ValueError:
                continue
        return False

    def _resolve_selection(
        self, payload: dict[str, Any], *,
        account_snapshot: tuple[str, str | None, list[str], str | None] | None = None,
    ) -> tuple[str, str | None] | None:
        if payload.get("selected_count") != 1:
            return None
        account_key, account_uid, project_ids, scope = account_snapshot or self._active_account_projects()
        metadata_generation = str(payload.get("generation_id") or "")
        metadata_project = str(payload.get("project_id") or "")
        account_token = active_account.set_override(account_key)
        uid_token = active_account.set_uid_override(account_uid)
        try:
            source_roots: dict[str, Path] | None = None

            def path_index(normalized: str) -> dict[str, tuple[str, str]] | None:
                nonlocal source_roots
                if source_roots is None:
                    source_roots = self._source_roots(account_key, project_ids)
                if not self._under_source_root(normalized, source_roots):
                    return None
                return self._path_index(account_key, project_ids, source_roots)

            if metadata_generation:
                # 새 클립의 숨은 ID는 NAS manifest 스캔 없이 현재 계정 DB 존재만 확인한다.
                # 프로젝트를 옮긴 뒤에도 같은 생성물을 열어야 하므로 현재 project_id와의 일치는
                # 요구하지 않고, 각인 당시 프로젝트가 이 계정 소유인지만 확인한다.
                if metadata_project not in project_ids:
                    return None
                if repo.get_generation(metadata_generation) is None:
                    # 공유 리뷰에서 보낸 카드는 로컬 DB에 본문이 없을 수 있다. 그 경우에만
                    # 같은 계정의 검증된 manifest 경로가 각인 ID와 정확히 일치하는지 확인한다.
                    normalized = _normal_path(str(payload.get("file_path") or ""))
                    if not normalized:
                        return None
                    index = path_index(normalized)
                    mapped = index.get(normalized) if index is not None else None
                    if mapped != (metadata_project, metadata_generation):
                        return None
                generation_id = metadata_generation
            else:
                file_path = str(payload.get("file_path") or "")
                normalized = _normal_path(file_path)
                if not normalized:
                    return None
                index = path_index(normalized)
                mapped = index.get(normalized) if index is not None else None
                if mapped is None:
                    return None
                _project_id, generation_id = mapped
        finally:
            active_account.reset_uid_override(uid_token)
            active_account.reset_override(account_token)
        if not generation_id:
            return None
        # NAS 스캔 중 계정이 전환됐으면 옛 계정의 선택을 새 계정 소켓에 보내지 않는다.
        current_key, current_uid = self._active_account_identity()
        if current_key != account_key or current_uid != account_uid:
            return None
        return generation_id, scope

    def _resolve_selections(self, payload: dict[str, Any]) -> tuple[list[str], str | None] | None:
        if payload.get("connection_state"):
            return None
        items = payload.get("selections")
        if not isinstance(items, list) and payload.get("selected_count") == 1:
            # 기존 단일 선택 경로/검증 계약을 그대로 사용한다.
            resolved = self._resolve_selection(payload)
            if resolved is not None:
                return [resolved[0]], resolved[1]
            items = []
        elif not isinstance(items, list):
            if payload.get("selected_count") != 0:
                return None
            items = []
        snapshot = self._active_account_projects()
        account_key, account_uid, _project_ids, scope = snapshot
        if not account_key:
            return None
        generation_ids = set()
        for item in items[:MAX_SELECTIONS]:
            if not isinstance(item, dict):
                continue
            resolved = self._resolve_selection(
                {**item, "selected_count": 1}, account_snapshot=snapshot,
            )
            if resolved is not None:
                generation_ids.add(resolved[0])
        # 중간에 계정이 바뀌면 앞에서 검증한 항목을 포함한 묶음 전체를 버린다.
        if self._active_account_identity() != (account_key, account_uid):
            return None
        return sorted(generation_ids), scope

    @staticmethod
    def _parse_line(raw: bytes) -> dict[str, Any] | None:
        try:
            text = raw.decode("utf-8", errors="replace").strip()
            if not text.startswith(RESULT_PREFIX):
                return
            payload = json.loads(text.removeprefix(RESULT_PREFIX))
        except (json.JSONDecodeError, UnicodeError):
            return
        return payload if isinstance(payload, dict) else None

    async def _read_selections(self, process: asyncio.subprocess.Process) -> None:
        """파이프는 계속 비우고 아직 처리하지 않은 선택은 최신 한 개만 보관한다."""
        try:
            assert process.stdout is not None
            while raw := await process.stdout.readline():
                if self._parse_line(raw) is None:
                    continue
                # 합치기 전에 기준선을 소비해야 직후 들어온 실제 첫 선택을 잃지 않는다.
                if self._priming:
                    self._priming = False
                    self._worker_had_snapshot = True
                    self._last_selection_key = None
                    continue
                self._selection_revision += 1
                if self._latest_line is not None:
                    # A→B→A를 합쳤어도 이전에 보낸 A와 같다는 이유로 마지막 A를 버리지 않는다.
                    self._last_selection_key = None
                self._latest_line = (self._selection_revision, raw)
                self._selection_ready.set()
        finally:
            if self._process is process:
                # EOF/읽기 실패 뒤 늦게 끝난 DB/NAS 조회는 화면에 보내지 않는다.
                self._selection_revision += 1
                self._latest_line = None
                self._process_epoch += 1
                self._reader_closed = True
                self._selection_ready.set()

    def _selection_is_current(self, revision: int) -> bool:
        return (
            revision == self._selection_revision
            and not self._stopping
            and not self._pause_count
            and not self._reader_closed
        )

    async def _handle_line(self, raw: bytes, revision: int | None = None) -> None:
        payload = self._parse_line(raw)
        if payload is None:
            return
        # reader 밖에서 호출돼도 첫 스냅샷을 보내지 않는 이중 방어. 새 자식의 첫 스냅샷은
        # "사용자 클릭"이 아니라 현재 상태 기준선이다. 브라우저
        # 재연결·Resolve 전송 뒤에 이전 선택 때문에 캔버스가 갑자기 튀지 않게 방송하지 않는다.
        if self._priming:
            self._priming = False
            self._last_selection_key = None
            return
        if revision is not None and not self._selection_is_current(revision):
            return
        selected_count = payload.get("selected_count")
        if not isinstance(selected_count, int) or isinstance(selected_count, bool) or selected_count < 0:
            return
        # 선택마다 취소/병렬화하지 않는다. 종료 때도 공유 캐시를 갱신하는 스레드가 끝난 뒤
        # 수명을 닫아, 옛 조회가 다음 감시 세션에 살아남지 않게 한다.
        process_epoch = self._process_epoch
        resolved = await to_thread_non_abandon(self._resolve_selections, payload)
        if revision is not None and not self._selection_is_current(revision):
            self._last_selection_key = None
            if process_epoch != self._process_epoch:
                self._index_cache = None
                self._roots_cache = None
            return
        if resolved is None:
            self._last_selection_key = None
            return
        generation_ids, scope = resolved
        truncated = bool(payload.get("truncated")) or selected_count > MAX_SELECTIONS
        selection_key = (tuple(generation_ids), selected_count, truncated)
        if selection_key == self._last_selection_key:
            return
        self._last_selection_key = selection_key
        await manager.broadcast(
            {
                "type": "resolve_selection",
                "generation_id": generation_ids[0] if generation_ids else None,
                "generation_ids": generation_ids,
                "selected_count": selected_count,
                "truncated": truncated,
                # 한 탭에는 progress/assets 등 여러 WS 소비자가 있을 수 있다. 모두 같은 ID를
                # 받아 프런트가 정확히 한 번만 팝업을 열게 하고, 서버 재시작 뒤에도 충돌하지 않는다.
                "selection_id": uuid.uuid4().hex,
            },
            account_uid=scope,
        )

    async def _run(self) -> None:
        restart_index = 0
        while not self._stopping:
            stats = await manager.stats()
            if self._held() or stats.get("connections", 0) <= 0:
                await self._stop_process()
                self._last_selection_key = None
                restart_index = 0
                await asyncio.sleep(_CLIENT_CHECK_SECONDS)
                continue
            if self._process is None or self._process.returncode is not None:
                await self._stop_process()
                try:
                    await run_non_abandon(self._start_process())
                except asyncio.CancelledError:
                    raise
                except Exception:  # noqa: BLE001 - 보조 감시 실패가 서버 수명을 끝내면 안 된다.
                    _log.exception("Resolve 선택 감시 자식을 시작하지 못했습니다")
                    self._process = None
                if self._process is None:
                    delay = _RESTART_DELAYS[min(restart_index, len(_RESTART_DELAYS) - 1)]
                    restart_index += 1
                    await asyncio.sleep(delay)
                    continue
            process = self._process
            if process is None:
                continue  # 시작 완료 직후 suspend가 회수한 경우
            if process.stdout is None:
                await self._stop_process()
                continue
            try:
                await asyncio.wait_for(self._selection_ready.wait(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            # spawn만 성공하고 즉시 종료하는 자식은 2→5→30초로 늦춘다.
            # 실제 첫 스냅샷을 받은 경우에만 성공으로 보고 백오프를 초기화한다.
            if self._worker_had_snapshot:
                restart_index = 0
                self._worker_had_snapshot = False
            if self._reader_closed:
                await self._stop_process()
                delay = _RESTART_DELAYS[min(restart_index, len(_RESTART_DELAYS) - 1)]
                restart_index += 1
                await asyncio.sleep(delay)
                continue
            latest, self._latest_line = self._latest_line, None
            self._selection_ready.clear()
            if latest is None:
                continue
            revision, raw = latest
            try:
                await self._handle_line(raw, revision)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - DB/NAS/WS 일시 오류 뒤 다음 선택을 계속 감시한다.
                _log.exception("Resolve 선택 신호 처리 중 오류가 발생했습니다")
                self._last_selection_key = None
                await self._stop_process()
                delay = _RESTART_DELAYS[min(restart_index, len(_RESTART_DELAYS) - 1)]
                restart_index += 1
                await asyncio.sleep(delay)


selection_monitor = ResolveSelectionMonitor()
