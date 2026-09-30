"""에셋 대장 도우미 PC 훑기(로컬 허브 쪽) — 서버가 NAS 를 못 읽을 때 관리자 PC 가 대신 훑어 서버에 올린다.
설계: docs/ASSET_REGISTRY.md §10(Claude 설계 · Codex 적대적 검토 합의, 2026-09-30).

  · 기존 AssetRegistryController 를 그대로 쓴다(자식 훑기·큰 파일 전용 실행·부모 감시·속도 상한). 바꾸는 것은
    ① 프로젝트 목록을 서버에 묻고 ② 프로젝트마다 서버 자리(lease)를 받아 ③ 결과를 DB 대신 서버로 올리는 것뿐.
  · 번호는 서버만 만든다. 서버가 준 PM 루트만, 서버가 아는 공유 주소(UNC)와 이 PC 드라이브의 공유가 같을 때만
    훑고, 자식에게는 그 **공유 주소**를 루트로 준다(드라이브 연결이 도중에 바뀌어도 같은 곳을 읽게).
  · 시작할 때의 서버 주소·토큰으로만 부른다 — 도중에 로그인이 바뀌거나 401·403·옛 서버(404·405)면 전체를 멈춘다.
  · 미완주 결과는 올리지 않는다(서버도 받으면 기록하지 않는다) — 이 PC 상태에만 남긴다.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import urllib.error
import urllib.request
from typing import Any, Optional

from ..repo import asset_registry as registry
from . import shared_connection
from .asset_registry import AssetRegistryController
from .operational_logging import log_event
from .path_safety import unc_for_drive

_log = logging.getLogger("mvhub.asset_registry")

RENEW_EVERY_S = 60  # 서버 자리 만료(10분)보다 한참 짧게
RESULT_TIMEOUT_S = 300


class _Abort(Exception):
    """전체를 멈춘다 — 로그인이 바뀜·권한 없음·옛 서버·서버에서 도우미가 꺼짐."""


class _ProjectFail(Exception):
    """그 프로젝트만 실패 — 다른 곳에서 훑는 중·공유 주소 불일치·결과 거부 등."""


class _Network(Exception):
    """서버에 닿지 못했다(한 번 더 해 볼 수 있다)."""


def _error_for(code: int, detail: str) -> Exception:
    """서버의 거절 → 전체 멈춤(_Abort) 또는 그 프로젝트만 실패(_ProjectFail)."""
    if code in (401, 403):
        return _Abort("관리자(system) 권한이 필요합니다" if code == 403 else "공유 서버 로그인이 필요합니다")
    if code == 405 or (code == 404 and detail in ("", "Not Found")):  # 라우트 자체가 없다 = 옛 서버
        return _Abort("공유 서버 업데이트가 필요합니다(도우미 훑기를 모르는 서버)")
    if code == 503:
        return _Abort(detail or "공유 서버에서 도우미 훑기가 꺼져 있습니다")
    return _ProjectFail(detail or f"서버가 거부했습니다({code})")


def _same_share(root: str, unc: str) -> bool:
    """이 PC 에서 root 가 가리키는 공유 = 서버가 아는 unc 인가. 로컬 드라이브·모름(None)·다름은 모두 아니다."""
    local = unc_for_drive(root)
    if not local or not unc:
        return False

    def norm(path: str) -> str:
        return path.replace("/", "\\").rstrip("\\").casefold()

    return norm(local) == norm(unc) and norm(local).startswith("\\\\")


class HelperController(AssetRegistryController):
    def __init__(self) -> None:
        super().__init__()
        self._base = ""
        self._token: Optional[str] = None
        self._lease: dict[str, Any] = {}  # 지금 프로젝트의 자리: id·unc·seq·known
        self._detail: dict[str, Any] = {}  # 마지막 _apply 가 남긴 것(화면용)
        self._results: list[dict[str, Any]] = []
        self._abort = ""
        self._lease_lost = False  # 연장이 거부됐다(만료·서버 재시작) — 올려도 거부되니 그 프로젝트를 멈춘다

    @property
    def enabled(self) -> bool:
        return True  # 관리자 창에서 누를 때만 돈다(자동 주기 없음 — 결정 8)

    def _halted(self) -> bool:
        # 로그인이 바뀌었거나 자리를 잃었으면 도는 자식을 곧바로 끝낸다(결과를 올릴 때까지 기다리지 않는다, Codex P1)
        return self._stopping or bool(self._abort) or self._lease_lost

    # ── 서버 호출(시작할 때 고정한 주소·토큰으로만) ─────────────────────────────────
    def _call(
        self, method: str, path: str, body: Optional[dict[str, Any]] = None, timeout: float = 60, pinned_ok: bool = False
    ) -> Any:
        # pinned_ok: 로그인이 바뀐 뒤에도 시작 때 토큰으로 보낸다 — 자기 자리 반납만(안 풀면 서버가 10분 동안 막힌다, Codex)
        if not pinned_ok and shared_connection.token() != self._token:
            raise _Abort("로그인이 바뀌어 멈췄습니다")
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(self._base + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        req.add_header("Authorization", f"Bearer {self._token}")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
            return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            try:
                detail = str(json.loads(exc.read() or b"{}").get("detail") or "")
            except (ValueError, AttributeError, OSError):
                detail = ""
            raise _error_for(exc.code, detail) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise _Network("공유 서버에 닿지 못했습니다") from exc

    # ── 시작·상태 ─────────────────────────────────────────────────────────────
    def begin(self, project_ids: Optional[list[str]]) -> tuple[bool, str]:
        """관리자 창의 [이 PC 에서 훑기]. 시작할 때의 서버 주소·토큰을 고정한다."""
        tok = shared_connection.token()
        if not tok:
            return False, "공유 서버 로그인이 필요합니다"
        if self.busy():
            return False, "이미 이 PC 에서 훑는 중입니다"
        self._clear_leftovers()
        self._base, self._token = shared_connection.base_url(), tok
        self._abort, self._results = "", []
        if not self.request_scan(project_ids, mode="manual"):
            return False, "지금은 시작할 수 없습니다(앱 종료 중)"
        return True, ""

    def helper_status(self) -> dict[str, Any]:
        return {"running": self.busy(), "current": dict(self._current), "last": dict(self._last),
                "results": list(self._results), "abort": self._abort}

    # ── 기존 흐름에 끼우는 곳 ──────────────────────────────────────────────────
    def _projects(self) -> list[tuple[str, str, str]]:
        try:
            data = self._call("GET", "/api/asset-registry/helper/projects")
        except (_Abort, _ProjectFail, _Network) as exc:
            self._abort = str(exc)
            return []
        return [(str(p["project_id"]), str(p.get("name") or ""), str(p.get("root") or ""))
                for p in data.get("projects") or [] if isinstance(p, dict) and p.get("project_id") and p.get("root")]

    async def _project_run(self, pid: str, name: str, root: str, rate: float, deadline: float) -> str:
        """서버 자리를 받아 프로젝트 하나(일반 → 큰 파일 → 다시 훑기) 전체를 감싼다(Codex P0 — 큰 파일 재훑기도 자리 안에서)."""
        if self._abort:
            return "aborted"
        outcome: dict[str, Any] = {"project_id": pid, "name": name}
        failure: Optional[tuple[str, str]] = None
        self._detail, self._lease_lost = {}, False
        try:
            try:
                lease = await asyncio.to_thread(self._call, "POST", "/api/asset-registry/helper/lease", {"project_id": pid})
            except _Network as exc:
                raise _ProjectFail(str(exc)) from exc
            lease_id, unc = str(lease.get("lease_id") or ""), str(lease.get("unc") or "")
            self._lease = {"id": lease_id, "unc": unc, "seq": 0,
                           "known": {k["p"]: [k["b"], k["m"], k["s"]] for k in lease.get("known") or [] if isinstance(k, dict)}}
            renew = asyncio.create_task(self._renew_loop(lease_id))
            try:
                if not await asyncio.to_thread(_same_share, root, unc):
                    raise _ProjectFail("이 PC 의 드라이브가 서버가 아는 공유 주소와 다릅니다")
                outcome["state"] = await super()._project_run(pid, name, unc, rate, deadline)
                if self._abort:
                    raise _Abort(self._abort)
                if self._lease_lost:
                    raise _ProjectFail("서버 자리를 잃었습니다(만료·서버 재시작) — 다시 누릅니다")
            finally:
                renew.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await renew
                with contextlib.suppress(Exception):
                    await asyncio.to_thread(self._call, "POST", "/api/asset-registry/helper/release", {"lease_id": lease_id},
                                            pinned_ok=True)
                self._lease = {}
        except _Abort as exc:
            self._abort = str(exc)
            failure = ("aborted", str(exc))
        except _ProjectFail as exc:
            failure = ("failed", str(exc))
        outcome.update(self._detail)  # 마지막으로 올린 판의 상태(큰 파일 보충 뒤면 그 결과, Codex P2)
        if failure:
            outcome.update(state=failure[0], note=failure[1])
        self._results.append(outcome)
        log_event(_log, "asset_registry_helper_project", project_id=pid, state=outcome.get("state"),
                  note=outcome.get("note", ""))
        return str(outcome.get("state") or "")

    async def _renew_loop(self, lease_id: str) -> None:
        while True:
            await asyncio.sleep(RENEW_EVERY_S)
            try:
                await asyncio.to_thread(self._call, "POST", "/api/asset-registry/helper/renew", {"lease_id": lease_id})
            except _Abort as exc:  # 로그인 바뀜·권한 — 전체를 멈춘다(_halted 가 자식을 끝낸다)
                self._abort = str(exc)
                return
            except _ProjectFail:  # 자리를 잃었다 — 이 프로젝트를 멈춘다
                self._lease_lost = True
                return
            except Exception:  # noqa: BLE001 — 잠깐 끊김 등: 만료(10분)까지 다시 시도한다
                continue

    def _known(self, pid: str) -> dict[str, list]:
        known = dict(self._lease.get("known") or {})
        known.update(self._cache.get(pid) or {})
        return known

    def _apply(self, pid: str, name: str, scan: registry.RegistryScan, stats: dict[str, Any]) -> dict[str, int]:
        """결과를 DB 대신 서버로 올린다(완주만). 연결 오류는 같은 순번으로 한 번 더 — 서버가 같은 내용이면 같은 답을 준다."""
        self._detail = {"files": int(stats.get("files") or 0), "note": str(stats.get("note") or ""), "state": "failed"}
        if not scan.complete:
            return {}
        self._lease["seq"] += 1
        body = {
            "lease_id": self._lease["id"], "seq": self._lease["seq"], "complete": True,
            "files": [{"p": f.path, "b": int(f.bytes), "m": int(f.mtime_ns),
                       "s": f.sha256 if f.status == "ok" else None, "st": f.status} for f in scan.files],
            "stats": {k: int(stats.get(k) or 0) for k in ("hashed", "hashed_bytes", "elapsed_ms")},
        }
        for attempt in (1, 2):
            try:
                ack = self._call("POST", "/api/asset-registry/helper/result", body, timeout=RESULT_TIMEOUT_S)
                break
            except _Network as exc:
                if attempt == 2:
                    raise _ProjectFail("서버에 결과를 올리지 못했습니다(연결)") from exc
        kinds = {k: int(v) for k, v in (ack.get("kinds") or {}).items()}
        clean = bool(ack.get("clean"))
        self._detail.update(state="ok" if clean else "partial", clean=clean, kinds=kinds)
        return kinds


helper = HelperController()
