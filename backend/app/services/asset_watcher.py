"""어셋 폴더 실시간 감시 → WebSocket 변경 알림.

watchdog Observer 로 '트리를 조회한(=지금 보고 있는) 프로젝트 폴더'만 감시한다(요청 시 lazy 등록,
전체 마운트 상시 스캔은 안 함). 파일이 추가·변경·삭제되면 미디어 파일만 필터하고, 저장 중 연속 이벤트를
짧게 디바운스한 뒤 ① 백엔드 트리 캐시를 무효화하고 ② 이벤트 루프로
manager.broadcast_all({"type": "assets_changed", "projects": [...]}) 를 보낸다.
→ 프론트가 새로고침·포커스 없이 어셋 패널·캔버스를 자동 최신화한다(Phase 2 실시간).

watchdog 미설치 환경에서도 앱이 뜨도록 import 를 방어한다(그 경우 실시간 감시만 비활성 —
Phase 1 의 '창 포커스 시 갱신'은 그대로 동작).

인증 모드에서도 시작하지만 실제 감시는 트리 조회 시 lazy 등록한다. AUTH on에서는
require_local_assets가 로컬 요청만 허용하므로 원격 사용자가 임의의 서버 폴더를 감시 등록할 수 없다.
"""

from __future__ import annotations

import asyncio
import os
import stat
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from . import asset_tree
from .media_types import AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS

try:
    from watchdog.events import FileSystemEventHandler
    from watchdog.observers import Observer

    _HAS_WATCHDOG = True
except ImportError:  # watchdog 미설치 — 실시간 감시 비활성(포커스 갱신으로 폴백)
    _HAS_WATCHDOG = False
    FileSystemEventHandler = object  # type: ignore[assignment,misc]

_MEDIA_EXT = set(IMAGE_EXTENSIONS) | set(VIDEO_EXTENSIONS) | set(AUDIO_EXTENSIONS)
_DEBOUNCE = 0.6  # 초 — 저장 중 쏟아지는 연속 이벤트를 한 번의 알림으로 묶는다
# 네트워크 드라이브는 짧은 재인증·절전 해제에도 수 초간 is_dir=False가 될 수 있다.
# 1→2→4→8초(상한)로 재확인하고 총 30초가 지나기 전에는 기존 핸들을 죽었다고 판정하지 않는다.
_WATCH_HEALTH_INTERVAL = 1.0
_MISSING_RETRY_INITIAL = 1.0
_MISSING_RETRY_MAX = 8.0
_MISSING_GRACE = 30.0


@dataclass
class _Registration:
    project: str
    hide_render: bool
    combined_targets: set[tuple[str, tuple[str, ...]]] = field(default_factory=set)


@dataclass
class _WatchState:
    handle: object | None
    generation: int
    identity: tuple[int, int] | None = None
    scheduling: bool = False


@dataclass
class _RecoveryState:
    generation: int
    missing_since: float
    attempts: int = 0
    next_retry: float = 0.0
    retry_delay: float = 0.0
    # watchdog가 감시 루트 삭제를 알렸거나 emitter가 이미 끝났음. 경로가 돌아오면
    # 기존 핸들이 살아 있다고 가정하지 않고 반드시 새 세대로 교체한다.
    lost_signal: bool = False


def _is_media(path: str) -> bool:
    return Path(path).suffix.lower() in _MEDIA_EXT


def _is_temp(path: str) -> bool:
    """저장 중 임시파일·부분 다운로드는 무시(완성 파일이 곧 별도 이벤트로 온다)."""
    name = Path(path).name.lower()
    return (
        name.startswith(".")
        or name.endswith(".tmp")
        or name.endswith(".part")
        or name.endswith(".crdownload")
    )


def _under_render(dir_key: str, path: str) -> bool:
    """감시 루트(dir_key) 기준 최상위가 'render' 폴더인가 — 자동 PM 프로젝트에서 트리가 숨기는 폴더.
    트리에 안 보이는 render 산출물 대량 생성이 assets_changed 를 헛되이 쏘지 않도록 필터에 쓴다."""
    try:
        rel = Path(path).relative_to(dir_key)
    except ValueError:
        return False
    return bool(rel.parts) and rel.parts[0] == "render"


def _same_path(left: str, right: str) -> bool:
    """watchdog가 돌려준 경로와 등록 경로 비교(Windows 대소문자·구분자 차이 흡수)."""
    return os.path.normcase(os.path.abspath(left)) == os.path.normcase(os.path.abspath(right))


def _directory_identity(dir_key: str) -> tuple[int, int] | None:
    """현재 경로의 폴더 ID. 같은 이름으로 재생성된 다른 폴더를 구별한다."""
    try:
        stat_result = Path(dir_key).stat()
        if not stat.S_ISDIR(stat_result.st_mode):
            return None
        # 일부 네트워크 파일시스템은 st_ino=0을 돌려주므로 그 경우 생성 시각을 보조 ID로 쓴다.
        file_id = int(stat_result.st_ino) or int(stat_result.st_ctime_ns)
        return int(stat_result.st_dev), file_id
    except OSError:
        return None  # NAS 일시 단절·권한 오류도 우선 '의심'으로만 처리한다.


def _watch_handle_alive(observer, handle: object | None) -> bool | None:
    """watchdog 공개 emitters에서 핸들 담당 스레드 생존 여부를 읽는다.

    테스트 대역이나 다른 Observer 구현처럼 emitters를 제공하지 않으면 경로 확인만 쓰도록
    None을 반환한다. Windows Observer에서는 루트 삭제 후 멈춘 emitter를 즉시 찾을 수 있다.
    """
    if handle is None:
        return False
    try:
        emitters = tuple(observer.emitters)
    except (AttributeError, RuntimeError, TypeError):
        return None
    matching = [emitter for emitter in emitters if getattr(emitter, "watch", None) == handle]
    if not matching:
        return False
    try:
        return any(emitter.is_alive() for emitter in matching)
    except Exception:  # noqa: BLE001 — 상태 조회 실패 자체를 죽은 핸들로 오판하지 않게
        return None


def _log_future_exception(fut) -> None:
    try:
        exc = fut.exception()
    except Exception:  # noqa: BLE001 — cancelled 등
        return
    if exc:
        print(f"[asset-watcher] 브로드캐스트 예외: {exc}")


class _AssetChangeHandler(FileSystemEventHandler):
    def __init__(
        self,
        on_change,
        dir_key: str,
        hide_render_for: Callable[[str], bool],
        on_root_lost=None,
    ) -> None:
        self._on_change = on_change
        self._dir_key = dir_key
        self._on_root_lost = on_root_lost
        # ★hide_render 를 고정값이 아니라 조회 콜백으로 받는다 — 같은 폴더가 여러 alias 로 등록될 때
        #   'alias 중 하나라도 render 를 보고 싶어하면 통과' 를 이벤트 시점에 동적으로 판정하기 위함.
        self._hide_render_for = hide_render_for

    def on_any_event(self, event) -> None:  # created/modified/moved/deleted 공통
        if getattr(event, "is_directory", False):
            src = getattr(event, "src_path", "") or ""
            event_type = getattr(event, "event_type", "") or ""
            if (
                self._on_root_lost is not None
                and src
                and event_type in {"deleted", "moved"}
                and _same_path(src, self._dir_key)
            ):
                self._on_root_lost(self._dir_key)
            return
        src = getattr(event, "src_path", "") or ""
        dest = getattr(event, "dest_path", "") or ""  # moved 는 dest 로 온다
        cand = dest or src
        if not (_is_media(cand) or _is_media(src)):
            return  # 미디어 파일이 아니면(설정·임시파일 등) 무시
        if _is_temp(cand):
            return
        if self._hide_render_for(self._dir_key) and (
            _under_render(self._dir_key, cand) or _under_render(self._dir_key, src)
        ):
            return  # 숨김 render 폴더 변경은 트리에 안 보이므로 알리지 않음
        self._on_change(self._dir_key)


class _Watcher:
    def __init__(self) -> None:
        self._observer = None  # Observer | None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._watches: dict[str, _WatchState] = {}  # dir_key -> 핸들+세대(중복 등록 방지)
        # 같은 경로를 해제 후 다시 등록해도 세대를 되감지 않는다. 옛 handler의 지연 이벤트가
        # 우연히 새 핸들과 같은 번호를 얻어 통과하는 일을 막는다.
        self._watch_generations: dict[str, int] = {}
        self._recoveries: dict[str, _RecoveryState] = {}
        # 등록자 ID를 실제 폴더와 분리한다. 같은 폴더를 여러 계정·별칭이 공유해도 마지막 등록자가
        # 빠질 때만 watchdog 핸들을 해제하고, 같은 등록자가 새 경로로 이동하면 옛 핸들을 회수한다.
        self._registrations_by_dir: dict[str, dict[str, _Registration]] = {}
        self._registration_dirs: dict[str, str] = {}
        self._dir_projects: dict[str, set[str]] = {}  # dir_key -> {project 이름들}(같은 폴더 다중 이름)
        # dir_key -> {project: hide_render} — alias 별 render 숨김 의사. 하나라도 False 면 render 알림을 통과시킨다.
        self._dir_hide_by_project: dict[str, dict[str, bool]] = {}
        # dir_key -> {(합본 루트, 합본 폴더들)}. captures/imports 같은 합본 뷰는 개별 폴더 변경 시
        # 일반 프로젝트 캐시뿐 아니라 합본 캐시도 함께 비워야 한다.
        self._dir_combined_targets: dict[str, set[tuple[str, tuple[str, ...]]]] = {}
        self._lock = threading.Lock()
        self._pending: set[str] = set()  # 디바운스 윈도우에 모인 변경 폴더(dir_key)
        self._timer: Optional[threading.Timer] = None
        self._health_timer: Optional[threading.Timer] = None
        self._health_check_running = False

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        if not _HAS_WATCHDOG:
            print(
                "[asset-watcher] watchdog 미설치 — 실시간 감시 비활성(포커스 갱신으로 동작). "
                "pip install watchdog 로 활성화"
            )
            return
        if self._observer:
            self._loop = loop
            return
        self._loop = loop
        self._observer = Observer()
        self._observer.daemon = True
        self._observer.start()
        print("[asset-watcher] 어셋 실시간 감시 시작")

    def stop(self) -> None:
        # 먼저 새 이벤트·재예약의 입구를 닫고 내부 참조를 비운 뒤 Observer 종료를 기다린다.
        # 반대 순서면 join 중 도착한 이벤트가 새 Timer를 만들어 앱 종료 뒤에도 살아남을 수 있다.
        with self._lock:
            obs = self._observer
            self._observer = None
            timer = self._timer
            self._timer = None
            health_timer = self._health_timer
            self._health_timer = None
            self._watches.clear()
            self._watch_generations.clear()
            self._recoveries.clear()
            self._registrations_by_dir.clear()
            self._registration_dirs.clear()
            self._dir_projects.clear()
            self._dir_hide_by_project.clear()
            self._dir_combined_targets.clear()
            self._pending.clear()
            self._loop = None
        if timer:
            timer.cancel()
        if health_timer:
            health_timer.cancel()
        if obs:
            try:
                obs.stop()
                obs.join(timeout=5)
                if obs.is_alive():
                    print("[asset-watcher] 종료 대기 5초 초과 — Observer 스레드가 아직 살아 있습니다")
            except Exception as exc:  # noqa: BLE001 — 종료 정리 실패가 shutdown 을 막지 않게
                print(f"[asset-watcher] 종료 정리 실패: {exc}")

    @staticmethod
    def _default_registration_id(dir_key: str, project: str) -> str:
        # 기존 호출자는 폴더별 등록으로 동작한다. 명시적 ID를 쓰는 라우터만 경로 이동을 추적한다.
        return f"path:{dir_key}\x1fproject:{project}"

    def _refresh_dir_views_locked(self, dir_key: str) -> None:
        registrations = self._registrations_by_dir.get(dir_key)
        if not registrations:
            self._dir_projects.pop(dir_key, None)
            self._dir_hide_by_project.pop(dir_key, None)
            self._dir_combined_targets.pop(dir_key, None)
            return

        projects: dict[str, list[bool]] = {}
        combined: set[tuple[str, tuple[str, ...]]] = set()
        for registration in registrations.values():
            projects.setdefault(registration.project, []).append(registration.hide_render)
            combined.update(registration.combined_targets)
        self._dir_projects[dir_key] = set(projects)
        self._dir_hide_by_project[dir_key] = {
            project: all(hide_values) for project, hide_values in projects.items()
        }
        if combined:
            self._dir_combined_targets[dir_key] = combined
        else:
            self._dir_combined_targets.pop(dir_key, None)

    def _remove_registration_locked(self, registration_id: str) -> object | None:
        dir_key = self._registration_dirs.pop(registration_id, None)
        if dir_key is None:
            return None
        registrations = self._registrations_by_dir.get(dir_key)
        if registrations is not None:
            registrations.pop(registration_id, None)
            if not registrations:
                self._registrations_by_dir.pop(dir_key, None)
        self._refresh_dir_views_locked(dir_key)
        if dir_key in self._registrations_by_dir:
            return None

        self._pending.discard(dir_key)
        state = self._watches.pop(dir_key, None)
        handle = state.handle if state is not None else None
        self._recoveries.pop(dir_key, None)
        if not self._pending and self._timer:
            self._timer.cancel()
            self._timer = None
        if not self._registrations_by_dir and self._health_timer:
            self._health_timer.cancel()
            self._health_timer = None
        return handle

    @staticmethod
    def _unschedule(observer, handle: object | None) -> None:
        if observer is None or handle is None:
            return
        try:
            observer.unschedule(handle)
        except KeyError:
            pass  # 이미 stop/unschedule 된 핸들은 멱등 해제로 취급
        except Exception as exc:  # noqa: BLE001 — 실시간 감시 실패가 Assets 요청을 막지 않게
            print(f"[asset-watcher] 감시 해제 실패: {exc}")
            pass

    def _reserve_generation_locked(self, dir_key: str) -> int:
        generation = self._watch_generations.get(dir_key, 0) + 1
        self._watch_generations[dir_key] = generation
        self._watches[dir_key] = _WatchState(None, generation)
        recovery = self._recoveries.get(dir_key)
        if recovery is not None:
            recovery.generation = generation
        return generation

    @staticmethod
    def _postpone_recovery(recovery: _RecoveryState, now: float) -> None:
        delay = (
            _MISSING_RETRY_INITIAL
            if recovery.retry_delay <= 0
            else min(recovery.retry_delay * 2, _MISSING_RETRY_MAX)
        )
        recovery.attempts += 1
        recovery.retry_delay = delay
        recovery.next_retry = now + delay

    def _mark_recovery_locked(
        self,
        dir_key: str,
        generation: int,
        now: float,
        *,
        lost_signal: bool,
    ) -> _RecoveryState:
        recovery = self._recoveries.get(dir_key)
        if recovery is None or recovery.generation != generation:
            recovery = _RecoveryState(
                generation=generation,
                missing_since=now,
                lost_signal=lost_signal,
            )
            self._recoveries[dir_key] = recovery
            self._postpone_recovery(recovery, now)
        elif lost_signal:
            recovery.lost_signal = True
            # 이미 긴 백오프 중이어도 명시적 루트 삭제 신호는 최초 재시도 안에 확인한다.
            recovery.next_retry = min(
                recovery.next_retry,
                now + _MISSING_RETRY_INITIAL,
            )
        return recovery

    def _schedule_reserved(self, observer, dir_key: str, generation: int) -> None:
        # Observer는 handler 호출 중 자체 락을 잡는다. watcher 락을 잡은 채 schedule하면
        # handler(Observer→watcher)와 역순이 되어 교착할 수 있으므로 실제 등록은 락 밖에서 한다.
        with self._lock:
            state = self._watches.get(dir_key)
            if (
                observer is not self._observer
                or dir_key not in self._registrations_by_dir
                or state is None
                or state.generation != generation
                or state.handle is not None
                or state.scheduling
            ):
                return
            state.scheduling = True
            # 지금부터는 이 세대의 새 handler가 신호를 기록한다. 등록 중 루트가 사라져
            # handler가 lost_signal을 다시 세우면 성공 반환 뒤에도 지우지 않아야 한다.
            self._recoveries.pop(dir_key, None)
            projects = sorted(self._dir_projects.get(dir_key, ()))
            label = ", ".join(projects) or dir_key
            handler = _AssetChangeHandler(
                lambda key, gen=generation: self._on_change(key, gen),
                dir_key,
                self._hide_render_for,
                lambda key, gen=generation: self._on_root_lost(key, gen),
            )

        identity = _directory_identity(dir_key)
        try:
            handle = observer.schedule(handler, dir_key, recursive=True)
        except Exception as exc:  # noqa: BLE001 — 감시 등록 실패는 백오프로 재시도
            print(f"[asset-watcher] 감시 등록 실패({label}): {exc}")
            with self._lock:
                current = self._watches.get(dir_key)
                if current is state:
                    state.scheduling = False
                    self._mark_recovery_locked(
                        dir_key,
                        generation,
                        time.monotonic(),
                        lost_signal=True,
                    )
            return

        discard_handle = None
        with self._lock:
            current = self._watches.get(dir_key)
            if (
                observer is not self._observer
                or dir_key not in self._registrations_by_dir
                or current is not state
            ):
                discard_handle = handle
            elif handle is None:
                state.scheduling = False
                self._mark_recovery_locked(
                    dir_key,
                    generation,
                    time.monotonic(),
                    lost_signal=True,
                )
            else:
                state.handle = handle
                state.identity = identity
                state.scheduling = False
        self._unschedule(observer, discard_handle)

    def _ensure_health_timer_locked(self, delay: float | None = None) -> None:
        observer = self._observer
        if observer is None or not self._registrations_by_dir:
            return
        if self._health_check_running:
            return
        try:
            if not observer.is_alive():
                return
        except (AttributeError, RuntimeError):
            pass
        if self._health_timer and self._health_timer.is_alive():
            return
        if delay is None:
            delay = _WATCH_HEALTH_INTERVAL
        self._health_timer = threading.Timer(delay, self._health_check)
        self._health_timer.daemon = True
        self._health_timer.start()

    def _prepare_reschedule_locked(
        self,
        dir_key: str,
        state: _WatchState,
        recovery: _RecoveryState,
    ) -> tuple[object | None, int]:
        old_handle = state.handle
        generation = self._reserve_generation_locked(dir_key)
        recovery.generation = generation
        recovery.lost_signal = True
        # 옛 세대에서 이미 디바운스 대기 중인 변경도 새 상태의 알림으로 섞지 않는다.
        self._pending.discard(dir_key)
        if not self._pending and self._timer:
            self._timer.cancel()
            self._timer = None
        return old_handle, generation

    def _health_check(self) -> None:
        """경로와 watchdog emitter를 확인하고 죽은 핸들을 새 세대로 교체한다."""
        owns_check = False
        try:
            with self._lock:
                self._health_timer = None
                if self._health_check_running:
                    return
                self._health_check_running = True
                owns_check = True
                observer = self._observer
                if observer is None:
                    return
                now = time.monotonic()
                candidates = [
                    (dir_key, state.generation, state.handle, state.identity)
                    for dir_key, state in self._watches.items()
                    if dir_key in self._registrations_by_dir
                    and not state.scheduling
                    and (
                        dir_key not in self._recoveries
                        or now >= self._recoveries[dir_key].next_retry
                    )
                ]

            # NAS의 is_dir가 느려도 이벤트/등록 락을 막지 않도록 파일시스템 확인은 락 밖에서 한다.
            for dir_key, generation, handle, watched_identity in candidates:
                current_identity = _directory_identity(dir_key)
                available = current_identity is not None
                alive = _watch_handle_alive(observer, handle)
                old_handle = None
                schedule_generation = None
                with self._lock:
                    state = self._watches.get(dir_key)
                    if (
                        observer is not self._observer
                        or dir_key not in self._registrations_by_dir
                        or state is None
                        or state.generation != generation
                        or state.handle is not handle
                        or state.identity != watched_identity
                        or state.scheduling
                    ):
                        continue
                    recovery = self._recoveries.get(dir_key)

                    if not available:
                        was_recovering = (
                            recovery is not None
                            and recovery.generation == generation
                        )
                        recovery = self._mark_recovery_locked(
                            dir_key,
                            generation,
                            now,
                            lost_signal=alive is False,
                        )
                        if now - recovery.missing_since >= _MISSING_GRACE:
                            recovery.lost_signal = True
                            if state.handle is not None:
                                old_handle, schedule_generation = (
                                    self._prepare_reschedule_locked(
                                        dir_key,
                                        state,
                                        recovery,
                                    )
                                )
                        if was_recovering:
                            self._postpone_recovery(recovery, now)
                    elif (
                        state.handle is None
                        or alive is False
                        or current_identity != state.identity
                        or (recovery is not None and recovery.lost_signal)
                    ):
                        if recovery is None:
                            recovery = self._mark_recovery_locked(
                                dir_key,
                                generation,
                                now,
                                lost_signal=True,
                            )
                        old_handle, schedule_generation = self._prepare_reschedule_locked(
                            dir_key,
                            state,
                            recovery,
                        )
                    else:
                        # 유예 안에 경로가 돌아왔고 emitter도 살아 있다 — NAS 순간 단절이었다.
                        self._recoveries.pop(dir_key, None)

                if schedule_generation is not None:
                    # Windows delete-pending 해소를 위해 옛 OS 핸들을 닫은 다음 새 핸들을 연다.
                    self._unschedule(observer, old_handle)
                    if available:
                        self._schedule_reserved(
                            observer,
                            dir_key,
                            schedule_generation,
                        )
        except Exception as exc:  # noqa: BLE001 — 점검 스레드 한 번의 실패로 복구가 영구 정지하지 않게
            print(f"[asset-watcher] 감시 상태 점검 실패: {exc}")
        finally:
            if owns_check:
                with self._lock:
                    self._health_check_running = False
                    self._ensure_health_timer_locked()

    def watch(
        self,
        proj_dir: Path,
        project: str,
        hide_render: bool = False,
        *,
        registration_id: str | None = None,
        combined_target: tuple[str, tuple[str, ...]] | None = None,
    ) -> None:
        """이 프로젝트 폴더를 감시 등록(이미 감시 중이면 이름만 추가). tree 조회 시점에 호출된다.
        같은 실제 폴더가 여러 project 이름으로 열릴 수 있으므로 dir_key→이름 집합으로 관리한다."""
        key = str(proj_dir)
        registration_id = registration_id or self._default_registration_id(key, project)
        old_handle = None
        observer = None
        schedule_generation = None
        with self._lock:
            observer = self._observer
            if observer is None:
                return  # watchdog 없음 또는 아직 start 전
            old_key = self._registration_dirs.get(registration_id)
            if old_key is not None and old_key != key:
                old_handle = self._remove_registration_locked(registration_id)

            registrations = self._registrations_by_dir.setdefault(key, {})
            previous = registrations.get(registration_id)
            targets = set(previous.combined_targets) if previous else set()
            if combined_target is not None:
                targets.add(combined_target)
            registrations[registration_id] = _Registration(project, hide_render, targets)
            self._registration_dirs[registration_id] = key
            self._refresh_dir_views_locked(key)
            if key in self._watches:
                pass
            else:
                generation = self._reserve_generation_locked(key)
                if proj_dir.is_dir():
                    schedule_generation = generation
                else:
                    self._mark_recovery_locked(
                        key,
                        generation,
                        time.monotonic(),
                        lost_signal=False,
                    )
            self._ensure_health_timer_locked()
        if schedule_generation is not None:
            self._schedule_reserved(observer, key, schedule_generation)
        # 같은 등록자가 경로를 옮긴 경우 새 등록을 잠근 뒤 옛 핸들을 해제한다. 다른 등록자가
        # 옛 폴더를 계속 사용하면 _remove_registration_locked가 핸들을 반환하지 않는다.
        self._unschedule(observer, old_handle)

    def unwatch(self, registration_id: str) -> None:
        """등록자 한 명을 해제한다. 같은 폴더의 마지막 등록자일 때만 watchdog 핸들을 내린다."""
        with self._lock:
            observer = self._observer
            handle = self._remove_registration_locked(registration_id)
        self._unschedule(observer, handle)

    def watch_combined(
        self,
        assets_root: Path,
        project: str,
        folders: tuple[str, ...],
    ) -> None:
        """합본 뷰를 이루는 실제 폴더들을 감시하고 합본 캐시 무효화 대상을 연결한다."""
        # 캐시 키는 asset_tree.read_combined_tree에 전달한 경로 문자열과 같아야 한다.
        # 여기서 resolve하면 상대 경로를 쓰는 테스트/배포 설정에서 서로 다른 키가 될 수 있다.
        root = assets_root
        target = (str(assets_root), folders)
        for folder in folders:
            directory = root / folder
            registration_id = combined_registration_id(assets_root, project, folder)
            self.watch(
                directory,
                project,
                registration_id=registration_id,
                combined_target=target,
            )

    def _hide_render_for(self, dir_key: str) -> bool:
        """이 폴더의 render 변경을 숨길지 — 등록된 모든 alias 가 hide_render=True 일 때만 숨긴다.
        하나라도 render 를 보고 싶어하면(False) 알림을 통과시킨다. (감시 스레드에서 호출 → 락 짧게)"""
        with self._lock:
            by_project = self._dir_hide_by_project.get(dir_key)
            return bool(by_project) and all(by_project.values())

    def _start_timer_locked(self) -> None:
        # ★_lock 을 잡은 상태에서만 호출. 새 타이머로 교체(직전 타이머는 곧 종료됨).
        self._timer = threading.Timer(_DEBOUNCE, self._flush)
        self._timer.daemon = True
        self._timer.start()

    def _on_change(self, dir_key: str, generation: int | None = None) -> None:
        # ★감시 스레드에서 호출됨 — 디바운스 후 _flush 로 넘긴다.
        with self._lock:
            state = self._watches.get(dir_key)
            if (
                self._observer is None
                or state is None
                or (state.handle is None and not state.scheduling)
                or (generation is not None and generation != state.generation)
            ):
                return  # 해제/종료와 경합한 늦은 watchdog 이벤트
            self._pending.add(dir_key)
            if self._timer and self._timer.is_alive():
                return  # 이미 예약됨 → 위 set 에 합쳐졌다(_flush 가 재예약으로 마저 처리)
            self._start_timer_locked()

    def _on_root_lost(self, dir_key: str, generation: int) -> None:
        # WindowsApiEmitter는 감시 루트 삭제 시 DirDeletedEvent를 보낸 뒤 자기 스레드를 멈춘다.
        # 경로가 아직 delete-pending이면 즉시 재등록하지 않고 최초 재시도까지 핸들을 유지한다.
        with self._lock:
            state = self._watches.get(dir_key)
            if (
                self._observer is None
                or state is None
                or state.generation != generation
            ):
                return
            self._mark_recovery_locked(
                dir_key,
                generation,
                time.monotonic(),
                lost_signal=True,
            )
            self._ensure_health_timer_locked(_MISSING_RETRY_INITIAL)

    def _flush(self) -> None:
        with self._lock:
            self._timer = None
            dirs = list(self._pending)
            self._pending.clear()
            projects = sorted({p for d in dirs for p in self._dir_projects.get(d, ())})
            combined_targets = {
                target
                for directory in dirs
                for target in self._dir_combined_targets.get(directory, ())
            }
            loop = self._loop
        if dirs and loop is not None:
            # ① 백엔드 트리 캐시 무효화 — 재조회가 최신을 보게.
            for directory in dirs:
                asset_tree.invalidate_project_tree(Path(directory))
            for root, folders in combined_targets:
                asset_tree.invalidate_combined_tree(Path(root), folders)
            # ② 이벤트 루프로 넘겨 WS 브로드캐스트(감시 스레드 → 루프 스레드 브리지).
            if projects:
                from ..ws import manager

                try:
                    fut = asyncio.run_coroutine_threadsafe(
                        manager.broadcast_all(
                            {"type": "assets_changed", "projects": projects}
                        ),
                        loop,
                    )
                    fut.add_done_callback(_log_future_exception)
                except Exception as e:  # noqa: BLE001 — 알림 실패가 감시를 멈추지 않게
                    print(f"[asset-watcher] 알림 전송 실패: {e}")
        # ★경합 유실 방지 — flush 도는 동안 새로 쌓인 pending 이 있으면 다시 예약한다.
        # (디바운스 윈도우 종료~flush 사이에 온 이벤트가 다음 이벤트까지 묻히던 문제 방지.)
        with self._lock:
            if self._observer is not None and self._pending:
                self._start_timer_locked()


_watcher = _Watcher()


def start(loop: asyncio.AbstractEventLoop) -> None:
    _watcher.start(loop)


def stop() -> None:
    _watcher.stop()


def manual_registration_id(owner: str, project: str) -> str:
    return f"manual:{owner}\x1fproject:{project}"


def auto_registration_id(project_id: str) -> str:
    return f"auto:{project_id}"


def combined_registration_id(assets_root: Path, project: str, folder: str) -> str:
    return f"combined:{assets_root}\x1fproject:{project}\x1ffolder:{folder}"


def watch(
    proj_dir: Path,
    project: str,
    hide_render: bool = False,
    *,
    registration_id: str | None = None,
) -> None:
    _watcher.watch(
        proj_dir,
        project,
        hide_render,
        registration_id=registration_id,
    )


def unwatch(registration_id: str) -> None:
    _watcher.unwatch(registration_id)


def watch_combined(
    assets_root: Path,
    project: str,
    folders: tuple[str, ...],
) -> None:
    _watcher.watch_combined(assets_root, project, folders)
