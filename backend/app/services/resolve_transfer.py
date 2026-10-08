"""DaVinci Resolve 편집 원본 전송 기반.

선택한 생성물 원본을 기존 ``Render/<folder_path>`` 아래에 안전하게 모으고,
Resolve 연결 계층이 읽을 manifest JSON은 ``@davinci/.mvhub``에 분리한다.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import stat
import threading
import time
import uuid
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator

from ..config import MEDIA_DIR
from . import export_names, media_cache, project_folders
from .atomic_io import atomic_write_text
from .path_safety import safe_join, path_comparison_key
from .resolve_transfer_gate import transfer_lease


MANIFEST_FORMAT = "mvhub.resolve-transfer"
MANIFEST_VERSION = 2
_SELECTION_INDEX_MANIFEST_LIMIT = 5000

# ── 진행 중 직접 전송 수 — 업데이트 차단(routers/release_update._activity) 이 읽는다 ─────────
# 증감은 이벤트 루프에서, 읽기는 to_thread 워커 스레드에서 일어나므로 락으로 보호한다.
_ACTIVE_LOCK = threading.Lock()
_ACTIVE_TRANSFERS = 0


@asynccontextmanager
async def track_active() -> AsyncIterator[None]:
    """핸들러 진입부터 종료까지 '진행 중 전송' 으로 센다.

    취소·예외에서도 finally 로 내린다. 본문이 ``resolve_queue.run_non_abandon`` 을 쓰면 요청이
    취소돼도 내부 작업이 끝난 뒤에야 빠져나오므로, 그동안은 계속 세어진다(업데이트가 반입 중인
    프로세스를 교체하지 않게).
    """
    global _ACTIVE_TRANSFERS
    with _ACTIVE_LOCK:
        _ACTIVE_TRANSFERS += 1
    try:
        with transfer_lease():
            yield
    finally:
        with _ACTIVE_LOCK:
            _ACTIVE_TRANSFERS -= 1


def active_transfer_count() -> int:
    """지금 진행 중인 직접 전송(준비·반입·저장) 수."""
    with _ACTIVE_LOCK:
        return _ACTIVE_TRANSFERS
FOLDER_CATALOG_FORMAT = "mvhub.resolve-folder-catalog"
FOLDER_CATALOG_VERSION = 1
DAVINCI_DIR_NAME = "@davinci"
_MIN_FREE_BYTES = max(
    0, int(os.environ.get("CONTENT_HUB_RESOLVE_MIN_FREE_BYTES", str(256 * 1024 * 1024)))
)
_TRANSFER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
_NATURAL_NAME_CHUNKS = re.compile(r"(\d+)")
_CATALOG_LOCK = threading.Lock()
_MANIFEST_CHECKPOINT_ITEMS = max(
    1, int(os.environ.get("CONTENT_HUB_RESOLVE_MANIFEST_CHECKPOINT_ITEMS", "10"))
)
# 다른 전송이 방금 그 번호를 가져갔을 때 다음 번호로 넘어가 보는 횟수.
_DONE_WAIT_TRIES = 4  # 같은 이름을 방금 확정한 다른 PC 의 표식을 기다리는 횟수(0.5초 간격)


class ResolveTransferError(RuntimeError):
    """전송 전체를 시작할 수 없는 설정/경로 오류."""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _new_transfer_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{stamp}-{uuid.uuid4().hex[:8]}"


def resolve_transfer_roots(project_id: str) -> tuple[Path, Path]:
    """미디어를 둘 Render와 manifest를 둘 ``@davinci`` 폴더를 반환한다."""
    state = project_folders.render_root_state(project_id)
    if state.get("error"):
        raise ResolveTransferError(str(state["error"]))
    render_raw = (state.get("render_path") or "").strip()
    if not render_raw:
        raise ResolveTransferError("렌더 폴더가 연결되지 않았습니다")

    render = Path(render_raw).resolve()
    project_root = render.parent
    manifest_root = safe_join(project_root, DAVINCI_DIR_NAME)
    if manifest_root is None:
        raise ResolveTransferError("@davinci 경로가 프로젝트 밖을 가리킵니다")
    if manifest_root.exists() and not manifest_root.is_dir():
        raise ResolveTransferError(f"@davinci 위치가 폴더가 아닙니다: {manifest_root}")
    try:
        manifest_root.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ResolveTransferError(f"@davinci 폴더를 만들 수 없습니다: {exc}") from exc

    # mkdir 직후 다시 해석해 생성 중 경로가 바뀌었거나 정션인 경우도 차단한다.
    checked = safe_join(project_root, DAVINCI_DIR_NAME)
    if checked is None or checked != manifest_root:
        raise ResolveTransferError("@davinci 경로 안전성을 확인할 수 없습니다")
    return render, manifest_root


def _manifest_path(manifest_root: Path, transfer_id: str) -> Path:
    if not _TRANSFER_ID_RE.fullmatch(transfer_id):
        raise ResolveTransferError("전송 ID 형식이 안전하지 않습니다")
    path = safe_join(
        manifest_root,
        Path(".mvhub") / "transfers" / f"{transfer_id}.json",
    )
    if path is None:
        raise ResolveTransferError("전송 목록 저장 경로가 안전하지 않습니다")
    return path


def _folder_catalog_path(manifest_root: Path) -> Path:
    path = safe_join(manifest_root, Path(".mvhub") / "folder-catalog.json")
    if path is None:
        raise ResolveTransferError("Resolve 폴더 목록 저장 경로가 안전하지 않습니다")
    return path


def _normalized_folder_path(value: str) -> str:
    raw_parts = [part.strip() for part in value.replace("\\", "/").split("/")]
    if any(part in {".", ".."} for part in raw_parts):
        return ""
    parts = [part for part in raw_parts if part]
    return "/".join(parts)


def _natural_name_key(value: str) -> tuple[Any, ...]:
    chunks = tuple(
        (1, int(chunk)) if chunk.isdigit() else (0, chunk.casefold())
        for chunk in _NATURAL_NAME_CHUNKS.split(value)
        if chunk
    )
    return chunks, value.casefold(), value


def _folder_path_sort_key(value: str) -> tuple[Any, ...]:
    return tuple(_natural_name_key(part) for part in value.split("/") if part)


def _update_folder_catalog(manifest: dict[str, Any]) -> tuple[Path, list[str]]:
    """이번 전송에서 선택한 경로만 자연 정렬해 원자 저장한다."""
    manifest_root = Path(str(manifest.get("manifest_root") or "")).resolve()
    catalog_path = _folder_catalog_path(manifest_root)
    project_id = str(manifest.get("project_id") or "")
    with _CATALOG_LOCK:
        paths: set[str] = set()
        for item in manifest.get("items") or []:
            if item.get("status") not in {"downloaded", "skipped"}:
                continue
            if normalized := _normalized_folder_path(str(item.get("folder_path") or "")):
                paths.add(normalized)

        ordered = sorted(paths, key=_folder_path_sort_key)
        payload = {
            "format": FOLDER_CATALOG_FORMAT,
            "version": FOLDER_CATALOG_VERSION,
            "project_id": project_id,
            "project_name": str(manifest.get("project_name") or ""),
            "updated_at": _utc_now(),
            "paths": ordered,
        }
        atomic_write_text(
            catalog_path,
            json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        )
        return catalog_path, ordered


def _write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    atomic_write_text(
        path,
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    )


async def save_manifest(manifest: dict[str, Any]) -> None:
    """후속 Resolve 가져오기 결과까지 같은 manifest에 원자적으로 저장한다."""
    path = Path(str(manifest.get("manifest_path") or ""))
    # v1 manifest는 ResolveSource 하나가 미디어·manifest 공통 루트였다.
    manifest_root = Path(
        str(manifest.get("manifest_root") or manifest.get("source_root") or "")
    )
    try:
        relative = path.relative_to(manifest_root)
    except ValueError as exc:
        raise ResolveTransferError("전송 목록 저장 경로가 안전하지 않습니다") from exc
    if not path.name or safe_join(manifest_root, relative) != path:
        raise ResolveTransferError("전송 목록 저장 경로가 안전하지 않습니다")
    await asyncio.to_thread(_write_manifest, path, manifest)


def _read_manifest(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ResolveTransferError("다시 가져올 전송 기록을 찾을 수 없습니다") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise ResolveTransferError(f"전송 기록을 읽을 수 없습니다: {exc}") from exc
    if not isinstance(data, dict):
        raise ResolveTransferError("전송 기록 형식이 올바르지 않습니다")
    return data


async def load_manifest(project_id: str, transfer_id: str) -> dict[str, Any]:
    """프로젝트의 ``@davinci`` 아래에서 재가져오기용 manifest를 안전하게 읽는다."""
    _source_root, manifest_root = await asyncio.to_thread(
        resolve_transfer_roots, project_id
    )
    path = _manifest_path(manifest_root, transfer_id)
    manifest = await asyncio.to_thread(_read_manifest, path)
    if manifest.get("format") != MANIFEST_FORMAT:
        raise ResolveTransferError("MV Hub Resolve 전송 기록이 아닙니다")
    if str(manifest.get("project_id") or "") != project_id:
        raise ResolveTransferError("전송 기록의 프로젝트가 일치하지 않습니다")
    recorded_path = Path(str(manifest.get("manifest_path") or ""))
    try:
        recorded_path = recorded_path.resolve()
    except OSError as exc:
        raise ResolveTransferError("전송 기록 경로를 확인할 수 없습니다") from exc
    if recorded_path != path.resolve():
        raise ResolveTransferError("전송 기록 경로가 현재 프로젝트 밖을 가리킵니다")
    return manifest


def _pending_manifest(
    project_id: str,
    path: Path,
    manifest_root: Path,
    source_root: Path,
) -> dict[str, Any] | None:
    """수동 Resolve 메뉴에 노출해도 안전한 준비 완료 manifest인지 검증한다.
    ★manifest_root·source_root 는 호출자가 resolve 를 마친 경로여야 한다(R5 transfer-3 —
    manifest 마다 같은 root 를 재-resolve 하지 않는다)."""
    try:
        manifest = _read_manifest(path)
        recorded_path = Path(str(manifest.get("manifest_path") or "")).resolve()
        recorded_root = Path(str(manifest.get("manifest_root") or "")).resolve()
        recorded_source = Path(str(manifest.get("source_root") or "")).resolve()
    except (ResolveTransferError, OSError):
        return None
    if manifest.get("format") != MANIFEST_FORMAT:
        return None
    if str(manifest.get("project_id") or "") != project_id:
        return None
    if (
        recorded_path != path.resolve()
        or recorded_root != manifest_root
        or recorded_source != source_root
    ):
        return None
    if manifest.get("status") not in {"complete", "partial"}:
        return None
    ready = False
    for item in manifest.get("items") or []:
        if not isinstance(item, dict) or item.get("status") not in {
            "downloaded",
            "skipped",
        }:
            continue
        try:
            local_path = Path(str(item.get("local_path") or "")).resolve()
            local_path.relative_to(source_root)
        except (OSError, ValueError):
            return None
        if local_path.is_file():
            ready = True
    if not ready:
        return None
    if (manifest.get("resolve_import") or {}).get("status") == "complete":
        return None
    return manifest


def list_pending_manifests(
    project_ids: list[str], *, limit: int = 20
) -> list[dict[str, Any]]:
    """Resolve 내부 Importer가 처리할 준비 완료 전송을 최신순으로 반환한다.

    프로젝트 전체를 재귀 검색하지 않고 등록된 ``@davinci/.mvhub/transfers``만
    확인하므로 NAS 프로젝트에서도 가볍게 동작한다.
    """
    pending: list[dict[str, Any]] = []
    for project_id in dict.fromkeys(pid for pid in project_ids if pid):
        state = project_folders.render_root_state(project_id)
        render_raw = str(state.get("render_path") or "").strip()
        if not render_raw or state.get("error"):
            continue
        try:
            source_root = Path(render_raw).resolve()
            project_root = source_root.parent
            manifest_root = safe_join(project_root, DAVINCI_DIR_NAME)
            transfer_dir = (
                safe_join(manifest_root, Path(".mvhub") / "transfers")
                if manifest_root is not None
                else None
            )
            if transfer_dir is None or not transfer_dir.is_dir():
                continue
            # stat 1회로 파일 여부·mtime 을 함께 얻는다(R5 transfer-3) — 종전 is_file+
            # 정렬키 stat 은 manifest 당 메타데이터 조회 2회였다(NAS 왕복 비용).
            stats = [(path, path.stat()) for path in transfer_dir.glob("*.json")]
            paths = [
                path
                for path, stat_result in sorted(
                    stats, key=lambda entry: entry[1].st_mtime, reverse=True
                )
                if stat.S_ISREG(stat_result.st_mode)
            ]
            # 검증에 쓰는 root 도 프로젝트당 1회만 resolve 해 manifest 마다 반복하지 않는다.
            manifest_root_resolved = manifest_root.resolve()
        except OSError:
            continue
        # 완료 manifest가 최신 창을 차지해 더 오래된 실제 pending을 가리지 않도록 먼저
        # 상태를 판정한다. 최종 전역 정렬 뒤에만 limit을 적용한다.
        project_pending = 0
        for path in paths:
            manifest = _pending_manifest(
                project_id, path, manifest_root_resolved, source_root
            )
            if manifest is not None:
                pending.append(manifest)
                project_pending += 1
                # 한 프로젝트가 최종 전역 limit보다 많이 기여할 수는 없으므로 여기서 멈춘다.
                if project_pending >= max(1, limit):
                    break
    pending.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
    return pending[: max(1, limit)]


def manifest_source_roots(project_ids: list[str]) -> dict[str, Path]:
    """현재 계정 프로젝트에서 검증된 Render 루트만 한 번씩 계산한다."""
    result: dict[str, Path] = {}
    for project_id in dict.fromkeys(pid for pid in project_ids if pid):
        state = project_folders.render_root_state(project_id)
        render_raw = str(state.get("render_path") or "").strip()
        if not render_raw or state.get("error"):
            continue
        try:
            result[project_id] = Path(render_raw).resolve()
        except OSError:
            continue
    return result


def manifest_generation_entries(
    project_ids: list[str], *, source_roots: dict[str, Path] | None = None
) -> list[dict[str, str]]:
    """현재 계정이 아는 프로젝트의 완료/과거 manifest에서 안전한 경로-ID 쌍을 읽는다.

    Resolve 선택 감시는 예전 클립에 third-party metadata가 없을 때만 이 작은 JSON 기록을
    폴백으로 쓴다. 파일명은 보지 않고 manifest의 절대 경로 완전 일치만 허용한다.
    스캔은 프로젝트별 최신 5천 전송으로 제한한다. 그보다 오래된 클립은 새 메타데이터가
    각인된 경우에만 자동 연결하고, 무제한 NAS 순회로 앱을 멈추게 하지 않는다.
    """
    result: list[dict[str, str]] = []
    roots = source_roots if source_roots is not None else manifest_source_roots(project_ids)
    for project_id, source_root in roots.items():
        try:
            project_root = source_root.parent
            manifest_root = safe_join(project_root, DAVINCI_DIR_NAME)
            transfer_dir = (
                safe_join(manifest_root, Path(".mvhub") / "transfers")
                if manifest_root is not None
                else None
            )
            if transfer_dir is None or not transfer_dir.is_dir():
                continue
            manifest_root_resolved = manifest_root.resolve()
            stats = [(path, path.stat()) for path in transfer_dir.glob("*.json")]
            paths = [
                path
                for path, stat_result in sorted(
                    stats, key=lambda entry: entry[1].st_mtime, reverse=True
                )
                if stat.S_ISREG(stat_result.st_mode)
            ][:_SELECTION_INDEX_MANIFEST_LIMIT]
        except OSError:
            continue
        for path in paths:
            try:
                manifest = _read_manifest(path)
                recorded_path = Path(str(manifest.get("manifest_path") or "")).resolve()
                recorded_root = Path(str(manifest.get("manifest_root") or "")).resolve()
                recorded_source = Path(str(manifest.get("source_root") or "")).resolve()
            except (ResolveTransferError, OSError):
                continue
            if (
                manifest.get("format") != MANIFEST_FORMAT
                or str(manifest.get("project_id") or "") != project_id
                or recorded_path != path.resolve()
                or recorded_root != manifest_root_resolved
                or recorded_source != source_root
            ):
                continue
            for item in manifest.get("items") or []:
                if not isinstance(item, dict) or item.get("status") not in {
                    "downloaded",
                    "skipped",
                }:
                    continue
                generation_id = str(item.get("generation_id") or "").strip()
                try:
                    local_path = Path(str(item.get("local_path") or "")).resolve()
                    local_path.relative_to(source_root)
                except (OSError, ValueError):
                    continue
                if generation_id:
                    result.append(
                        {
                            "project_id": project_id,
                            "generation_id": generation_id,
                            "local_path": str(local_path),
                        }
                    )
    return result


def _folder_dir(source_root: Path, folder_path: str) -> Path | None:
    """``source_root/<folder_path>`` 를 안전성 검사를 거쳐 반환한다."""
    probe = project_folders.safe_dest(source_root, folder_path, "_probe")
    return probe.parent if probe is not None else None


def _refresh_summary(manifest: dict[str, Any], *, finished: bool = False) -> None:
    items = manifest["items"]
    manifest["downloaded"] = sum(item["status"] == "downloaded" for item in items)
    manifest["skipped"] = sum(item["status"] == "skipped" for item in items)
    manifest["error_count"] = sum(item["status"] == "error" for item in items)
    if not finished:
        manifest["status"] = "pending"
        return
    ok_count = manifest["downloaded"] + manifest["skipped"]
    if manifest["error_count"] == 0:
        manifest["status"] = "complete"
    elif ok_count:
        manifest["status"] = "partial"
    else:
        manifest["status"] = "failed"
    manifest["completed_at"] = _utc_now()


async def _cached_source(asset: dict[str, Any]) -> Path:
    """asset의 로컬 캐시를 확보한다. 임의 절대경로는 허용하지 않는다."""
    file_path = str(asset.get("file_path") or "")
    source_url = str(asset.get("source_url") or "")

    if file_path.startswith("/media/"):
        local = safe_join(MEDIA_DIR, file_path.removeprefix("/media/"))
        if local is not None and local.is_file() and local.stat().st_size > 0:
            return local

    # 로컬 /media가 유실됐으면 보존해 둔 원격 source_url로 자기치유한다.
    candidates = [file_path, source_url]
    seen: set[str] = set()
    for candidate in candidates:
        if candidate in seen or not candidate.startswith(("http://", "https://")):
            continue
        seen.add(candidate)
        rel = await media_cache.cache_url(candidate)
        if not rel or not rel.startswith("/media/"):
            continue
        local = safe_join(MEDIA_DIR, rel.removeprefix("/media/"))
        if local is not None and local.is_file() and local.stat().st_size > 0:
            return local
    raise ResolveTransferError("원본을 내려받을 수 없습니다")


# 목적지별 복사 직렬화(R5 2-B) — 같은 이름을 두 요청이 동시에 처리하면 둘 다
# exists()==False 를 보고 각자 대용량 복사를 한다(같은 생성물을 동시에 보낸 경우 — 헛복사 한 번).
# 존재 확인→.part 복사→확정을 목적지 단위 임계구역으로 묶는다(다른 목적지끼리는 병렬 유지).
# ★프로세스 내부 동시성만 막는다 — 프로세스 밖(다른 PC) 경합의 방어선은 이름 장부와
# 덮어쓰지 않는 확정(export_names.commit_new)이다. 레지스트리는 refcount 로 마지막 사용자가
# 회수해 경로 수만큼 영구 누적되지 않는다.
_DEST_LOCKS: dict[str, tuple[threading.Lock, int]] = {}
_DEST_LOCKS_GUARD = threading.Lock()


@contextmanager
def _dest_lock(dest: Path):
    key = os.path.normcase(str(path_comparison_key(dest)))
    with _DEST_LOCKS_GUARD:
        entry = _DEST_LOCKS.get(key)
        lock = entry[0] if entry else threading.Lock()
        users = entry[1] if entry else 0
        _DEST_LOCKS[key] = (lock, users + 1)
    try:
        with lock:
            yield
    finally:
        with _DEST_LOCKS_GUARD:
            current, users = _DEST_LOCKS[key]
            if users <= 1:
                _DEST_LOCKS.pop(key, None)
            else:
                _DEST_LOCKS[key] = (current, users - 1)


def _place_copy(
    source: Path,
    source_root: Path,
    folder_path: str,
    gen_key: str,
    ext: str,
    books: export_names.Books,
) -> tuple[Path, bool]:
    """원본을 이 생성물의 다빈치 이름(``<폴더 경로>_davinci_<번호 3자리>``)으로 놓는다 — (경로, 새로 썼나).

    이름은 렌더 폴더의 장부가 정한다(``services/export_names.py``): 생성물마다 번호 하나이고 한 번 쓴
    번호는 다시 쓰지 않는다. 같은 생성물을 또 보내면 **있는 파일을 그대로 쓴다**(사본을 만들지 않는다 —
    Jay 2026-10-08, 09-02 의 "매번 다음 번호" 를 바꿈). 파일이 지워졌으면 같은 이름으로 다시 놓는다.
    저장본(``…_share_…`` · ``…_fin_…``)과는 토큰이 달라 이름이 겹치지 않는다 — 서로의 파일을 쓰지도
    건드리지도 않는다. 기존 파일은 어떤 경우에도 덮지 않는다.
    """
    folder = _folder_dir(source_root, folder_path)
    if folder is None:
        raise ResolveTransferError("경로 안전성 위반")
    book = books.get(folder_path, export_names.DAVINCI)
    name = book.allocate(gen_key, ext, folder)
    # 다운로드 사이에 정션/경로가 바뀌지 않았는지 복사 직전 재검증한다.
    dest = project_folders.safe_dest(source_root, folder_path, name)
    if dest is None:
        raise ResolveTransferError("복사 직전 경로 안전성 확인에 실패했습니다")
    with _dest_lock(dest):
        for _attempt in range(_DONE_WAIT_TRIES):
            if not dest.exists():
                if _copy_new(source, dest):
                    book.mark_done(gen_key)
                    return dest, True
                continue  # 그 사이 다른 PC 가 같은 이름을 확정했다 — 아래에서 그 파일을 본다
            # 이름이 같다는 것만으로 우리 파일로 보지 않는다 — 장부의 확정 표식이 있어야 한다.
            book.reload()
            if dest.is_file() and dest.stat().st_size > 0 and book.is_done(gen_key):
                return dest, False
            time.sleep(0.5)  # 방금 확정한 다른 PC 의 표식은 곧 따라온다
        # 표식이 끝내 없다(확정 직후 끊긴 전송 등) — 원본과 바이트가 같을 때만 우리 파일로 인정하고 표식을 채운다.
        if dest.is_file() and _same_bytes(source, dest):
            book.mark_done(gen_key)
            return dest, False
    raise ResolveTransferError(f"같은 이름의 확인할 수 없는 파일이 있습니다: {name}")


def _same_bytes(first: Path, second: Path) -> bool:
    """두 파일의 바이트가 같은가. filecmp 는 크기·시각이 같으면 예전 결과를 돌려쓰므로 직접 견준다(코덱스 리뷰)."""
    if first.stat().st_size != second.stat().st_size:
        return False
    with first.open("rb") as one, second.open("rb") as two:
        while True:
            left, right = one.read(1 << 20), two.read(1 << 20)
            if left != right:
                return False
            if not left:
                return True


def _sent_copy(source_root: Path, folder_path: str, gen_key: str, books: export_names.Books) -> Path | None:
    """이 생성물을 전에 보낸 파일이 그대로 있으면 그 경로, 아니면 None — 읽기만 한다(번호를 만들지 않는다).

    장부가 이 생성물의 이름이라 하고 확정 표식도 있으며 파일이 실제로 있을 때만이다. 이때는 원본이 필요 없다 —
    로컬 원본이 정리됐거나 원본 주소가 만료돼도 이미 보낸 파일은 다시 보낼 수 있어야 한다(코덱스 리뷰 P1).
    """
    book = books.get(folder_path, export_names.DAVINCI)
    name = book.name_of(gen_key)
    if not name or not book.is_done(gen_key):
        return None
    dest = project_folders.safe_dest(source_root, folder_path, name)
    if dest is None or not dest.is_file() or dest.stat().st_size == 0:
        return None
    return dest


def _prepare_destination(source: Path, dest: Path) -> int:
    """복사 전 공통 검사 — 원본 크기 확인과 목적지 공간 확보. 반환=원본 크기."""
    source_size = source.stat().st_size
    if source_size <= 0:
        raise ResolveTransferError("원본 파일이 비어 있습니다")
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        free = shutil.disk_usage(dest.parent).free
        if free < source_size + _MIN_FREE_BYTES:
            raise ResolveTransferError("대상 디스크 공간이 부족합니다")
    except OSError:
        # 일부 UNC는 여유 공간 조회를 지원하지 않는다. 실제 쓰기 오류로 최종 판정한다.
        pass
    return source_size


def _copy_new(source: Path, dest: Path) -> bool:
    """복사해서 dest 라는 이름으로 확정하고 True. 그 사이 같은 이름의 파일이 생겼으면 손대지 않고 False.

    임시 파일을 다 만든 뒤 **덮어쓰지 않는 이름 바꾸기**로 확정한다 — 다른 PC 가 같은 이름을 골라도
    먼저 확정한 쪽만 남고, 목적지 이름에는 완성된 파일만 보인다(빈 선점 파일을 두지 않는다).
    """
    source_size = _prepare_destination(source, dest)
    tmp = dest.with_name(dest.name + f".{uuid.uuid4().hex}.part")
    try:
        shutil.copy2(source, tmp)
        if tmp.stat().st_size != source_size:
            raise ResolveTransferError("원본 복사가 불완전합니다(크기 불일치)")
        try:
            export_names.commit_new(tmp, dest)
        except FileExistsError:
            return False
        return True
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


async def transfer_generations(
    project_id: str,
    generations: list[dict[str, Any]],
    *,
    transfer_id: str | None = None,
) -> dict[str, Any]:
    """생성물 원본을 폴더 구조대로 복사하고 Resolve용 manifest를 반환한다.

    항목은 순차 처리한다. 대용량 원본 여러 개가 동시에 네트워크와 NAS를 점유하지
    않게 하고, 한 항목의 실패가 나머지를 막지 않게 오류를 항목별로 격리한다.
    """
    if not project_id:
        raise ResolveTransferError("프로젝트가 지정되지 않았습니다")
    if not generations:
        raise ResolveTransferError("전송할 생성물이 없습니다")
    if any((gen.get("project_id") or "") != project_id for gen in generations):
        raise ResolveTransferError("한 번에 하나의 프로젝트만 전송할 수 있습니다")

    source_root, manifest_root = await asyncio.to_thread(
        resolve_transfer_roots, project_id
    )
    transfer_id = transfer_id or _new_transfer_id()
    manifest_path = _manifest_path(manifest_root, transfer_id)
    manifest: dict[str, Any] = {
        "format": MANIFEST_FORMAT,
        "version": MANIFEST_VERSION,
        "transfer_id": transfer_id,
        "project_id": project_id,
        "project_name": generations[0].get("project_name") or "",
        "source_root": str(source_root),
        "manifest_root": str(manifest_root),
        "manifest_path": str(manifest_path),
        "folder_catalog_path": str(_folder_catalog_path(manifest_root)),
        "folder_paths": [],
        "created_at": _utc_now(),
        "completed_at": None,
        "status": "pending",
        "total": len(generations),
        "downloaded": 0,
        "skipped": 0,
        "error_count": 0,
        "items": [],
    }

    work: list[tuple[dict[str, Any], dict[str, Any], str, str]] = []
    for gen in generations:
        gen_id = str(gen.get("id") or "")
        folder_path = str(gen.get("folder_path") or "")
        assets = gen.get("assets") or []
        asset = assets[0] if assets and isinstance(assets[0], dict) else None
        media_type = str((asset or {}).get("type") or "")
        source_hint = str((asset or {}).get("source_url") or (asset or {}).get("file_path") or "")
        item: dict[str, Any] = {
            "generation_id": gen_id,
            "folder_path": folder_path,
            "filename": "",
            "media_type": media_type,
            "local_path": "",
            "status": "pending",
            "error": None,
        }
        manifest["items"].append(item)

        reason = None
        if gen.get("status") != "done":
            reason = "완료된 생성물만 전송할 수 있습니다"
        elif not gen_id:
            reason = "생성물 ID가 없습니다"
        elif not folder_path:
            reason = "폴더 경로가 없습니다"
        elif asset is None:
            reason = "원본 파일이 없습니다"
        elif media_type not in {"video", "audio", "image"}:
            reason = f"Resolve 전송을 지원하지 않는 형식입니다: {media_type or 'unknown'}"
        else:
            ext = project_folders.export_ext(source_hint, media_type)
            # 이름(번호)은 복사 직전에 장부에서 정한다. 여기서는 폴더 경로 자체가 안전한지만 확인한다.
            if _folder_dir(source_root, folder_path) is None:
                reason = "경로 안전성 위반"
            else:
                # 장부의 열쇠 = job_id 우선(공유할 때 쓰는 앵커와 같은 규칙 — 만든 PC 와 받은 PC 가 같은 영상을 같은 번호로 본다).
                work.append((item, asset, str(gen.get("job_id") or gen_id), ext))
        if reason:
            item["status"] = "error"
            item["error"] = reason

    _refresh_summary(manifest)
    await asyncio.to_thread(_write_manifest, manifest_path, manifest)

    books = export_names.Books(source_root)  # 이름 장부 — 전송 한 건 동안 폴더별로 한 번만 읽는다
    for index, (item, asset, gen_key, ext) in enumerate(work, 1):
        try:
            # 전에 보낸 파일이 그대로 있으면 원본을 찾지 않고 그 파일을 쓴다.
            dest = await asyncio.to_thread(_sent_copy, source_root, item["folder_path"], gen_key, books)
            written = False
            if dest is None:
                source = await _cached_source(asset)
                dest, written = await asyncio.to_thread(
                    _place_copy,
                    source,
                    source_root,
                    item["folder_path"],
                    gen_key,
                    ext,
                    books,
                )
            item["filename"] = dest.name
            item["local_path"] = str(dest)
            # skipped = 전에 보낸 파일이 그대로 있어 다시 복사하지 않았다(그 파일을 그대로 가져온다).
            item["status"] = "downloaded" if written else "skipped"
        except Exception as exc:  # noqa: BLE001 - 파일 1건 실패를 격리해 나머지는 계속 처리
            item["status"] = "error"
            item["error"] = str(exc)
        # NAS의 작은 JSON 파일을 항목마다 다시 쓰면 대량 전송이 크게 느려진다. 최대
        # N건까지만 메모리에 두고 체크포인트하며, 원본 복사 자체는 항상 원자적으로 끝난다.
        # 요약 재집계도 저장 직전에만 한다(R5 transfer-1) — 항목마다 전체 items 3회
        # 순회(O(N²))였지만 저장은 checkpoint 뿐이라 중간 집계는 쓰이지 않았다.
        if index % _MANIFEST_CHECKPOINT_ITEMS == 0:
            _refresh_summary(manifest)
            await asyncio.to_thread(_write_manifest, manifest_path, manifest)

    _refresh_summary(manifest, finished=True)
    catalog_path, folder_paths = await asyncio.to_thread(
        _update_folder_catalog, manifest
    )
    manifest["folder_catalog_path"] = str(catalog_path)
    manifest["folder_paths"] = folder_paths
    await asyncio.to_thread(_write_manifest, manifest_path, manifest)
    return manifest
