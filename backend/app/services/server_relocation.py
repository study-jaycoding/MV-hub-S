"""공유 서버 '이사 공지'(server-location.json) 리더·발행기 — 주소 전환 공지(C안).

관리자가 공유 서버를 새 주소(새 PC·새 IP)로 옮기면, 이미 로그인해 작업 중인 사람의 허브는
다음 요청부터 옛 주소로 실패한다. 로그인 화면 탈출구(B안)는 '이미 갇힌 뒤'의 수동 복구라
작업 중인 사람에게 먼저 알려 줄 통로가 없다. 이 모듈이 그 통로다 — 릴리스 폴더에 놓인 공지
파일을 읽어, 새 주소가 공지됐는지 판정해 준다(전환 자체는 routers/publish 가 한다).

★공지는 latest.json 이 아니라 **별도 파일** ``server-location.json`` 이다.
``release/make_release.ps1``·``release/select_release.ps1`` 이 latest.json 을 고정 필드
목록으로 통째 재작성하므로 거기 주소를 넣으면 다음 릴리스에서 지워지고, 앱 버전 롤백이
주소 revision 까지 되감는다. 두 수명주기를 분리한다(릴리스 스크립트는 손대지 않는다).

형식(같은 릴리스 폴더·같은 ACL — 작업자에겐 읽기 권한만):
    {"shared_server_url": "http://192.168.1.50:8010",
     "server_revision": 3,
     "server_name": "MV 팀 서버",
     "announced_at": "2026-08-23T10:00:00+09:00"}

``server_name`` 은 작업자 화면에 주소 대신 보일 이름이다(선택 — 비거나 없으면 주소로 폴백).

관리자는 이 파일을 손으로 쓰지 않아도 된다: 관리자 창의 '팀에 공지' 버튼이
``publish_announcement`` 로 **지금 저장된 이름·주소를 revision+1 로 기록**한다(수동 작성은
비상용으로 남는다 — docs/SERVER_RELOCATION.md).

★읽기도 쓰기도 반드시 '별도 프로세스 + 하드 타임아웃'으로 한다. 소스는 보통 NAS(SMB) 경로인데
그 NAS 가 죽어 있으면 ``Path.open()``·``stat()`` 이 커널 I/O 에서 수십 초를 블로킹하고,
파이썬 스레드는 그걸 중간에 끊을 수 없다(스레드는 버려질 뿐 회수되지 않는다 — 발행은 버튼을
누르는 요청 경로라 그 스레드가 요청 처리 풀을 갉아먹는다). release_update 의 UNC 읽기에는
타임아웃이 없지만 거기는 사용자가 버튼을 눌러 시작하는 1회 조회라 허용된다 — 이쪽은 기동 +
60초 주기로 도는 백그라운드다. worker_backup 이 같은 이유로 NAS 전송을 자식 프로세스에
맡기는 것과 같은 판단.

그래서 이 파일은 **자식 프로세스에서 스크립트로도 실행된다**(읽기 ``python -I
server_relocation.py <source>``, 쓰기 ``... <source> --write <base64 본문>``). 모듈 최상단에는
상대 import 를 두지 않는다(스크립트 실행 시 패키지가 없어 실패). release_update 의존과
원자 쓰기(atomic_io) 는 함수 안에서 지연 import 하고, 설정(repo) 접근은 아예 이 모듈 밖
(services/shared_connection)에 둔다.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping, Optional

# 릴리스 폴더에 놓이는 공지 파일 이름(고정 — 관리자 문서 docs/SERVER_RELOCATION.md 와 동일).
LOCATION_FILE = "server-location.json"
# 공지는 작은 JSON 한 줄이다. 그보다 크면 공지 파일이 아니다(잘못된 소스·거대 파일 방어).
MAX_BYTES = 64 * 1024
# 서버 표시 이름 상한 — 알림 한 줄에 들어가야 한다(shared_connection 과 같은 값).
SERVER_NAME_MAX = 64
# 자식 프로세스 하드 타임아웃 — 죽은 NAS 를 만나도 이 시간 안에 반드시 회수된다.
READ_TIMEOUT_SECONDS = 8.0
# 발행(쓰기)도 같은 예산으로 격리한다. 쓰기가 읽기보다 오래 걸릴 이유는 없고, 예산을 늘리면
# 죽은 NAS 를 만난 관리자가 그만큼 더 기다릴 뿐이다(실패 안내가 빠른 쪽이 낫다).
WRITE_TIMEOUT_SECONDS = 8.0
_HTTP_TIMEOUT_SECONDS = 6

_log = logging.getLogger(__name__)

# 마지막으로 성공적으로 읽은 공지(프로세스 메모리 — 재기동하면 다시 읽는다).
# 요청 경로가 느린 원격 I/O 를 만지지 않도록, 백그라운드가 채워 두고 라우터는 이것만 읽는다.
_snapshot: list[Optional[dict[str, Any]]] = [None]
# 앞선 읽기가 아직 안 끝났으면(죽은 NAS) 새로 띄우지 않는다 — 자식 프로세스가 쌓이지 않게.
_refresh_lock = threading.Lock()


class RelocationReadError(RuntimeError):
    """공지를 읽거나 해석할 수 없음. 공지가 아예 없는 것도 정상이므로 조용히 다룬다."""


class AnnouncementMissing(RelocationReadError):
    """공지 파일이 아직 없음 — '못 읽었다'와 구분해야 하는 유일한 실패다.

    발행은 기존 번호에 +1 을 해야 하는데, 못 읽은 것을 '없음(0)'으로 착각하면 번호가
    되감겨 팀 전체가 어느 공지가 최신인지 판단할 수 없는 상태가 된다(proposal 이 거부하는
    바로 그 사고). 그래서 여기서만 구분한다.
    """


class RelocationWriteError(RuntimeError):
    """공지를 발행할 수 없음 — 문구를 그대로 관리자에게 보여준다."""


class RelocationPermissionError(RelocationWriteError):
    """릴리스 폴더에 쓰기 권한이 없음(작업자 PC 등) — 권한의 본질은 NAS ACL 이다."""


# ── 공지 파싱(신뢰 경계) ────────────────────────────────────────────────────
def parse_announcement(raw: bytes) -> dict[str, Any]:
    """공지 원문 → {url, revision, name, announced_at}. 형식이 조금이라도 어긋나면 예외.

    검증은 여기 한 곳에서만 한다(자식 프로세스는 바이트를 그대로 넘기는 통로일 뿐).
    ``server_name`` 만 선택 항목이다 — 없거나 비면 빈 문자열(화면은 주소로 폴백).
    """
    if len(raw) > MAX_BYTES:
        raise RelocationReadError("공지 파일이 너무 큽니다")
    try:
        payload = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise RelocationReadError("공지 파일 형식이 올바르지 않습니다") from exc
    if not isinstance(payload, dict):
        raise RelocationReadError("공지 파일 형식이 올바르지 않습니다")

    url = str(payload.get("shared_server_url") or "").strip().rstrip("/")
    if len(url) > 512 or not url.lower().startswith(("http://", "https://")):
        raise RelocationReadError("shared_server_url 은 http(s):// 주소여야 합니다")
    revision = payload.get("server_revision")
    # bool 은 int 의 하위형이라 따로 막는다(True 가 revision 1 로 통과하지 않게).
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
        raise RelocationReadError("server_revision 은 1 이상의 정수여야 합니다")
    return {
        "url": url,
        "revision": revision,
        "name": _parse_server_name(payload.get("server_name")),
        "announced_at": str(payload.get("announced_at") or "").strip()[:64],
    }


def _parse_server_name(value: Any) -> str:
    """선택 항목 server_name — 없으면 빈 문자열, 있으면 '제어문자 없는 짧은 문자열'만 받는다.

    조용히 무시하지 않고 거부한다: 잘못 적힌 이름이 반쯤 반영돼 어떤 PC 는 이름을,
    어떤 PC 는 주소를 보는 상태가 더 헷갈린다(공지는 관리자가 손으로 쓰는 작은 파일이다).
    """
    if value is None:
        return ""
    if not isinstance(value, str):
        raise RelocationReadError("server_name 은 문자열이어야 합니다")
    name = value.strip()
    if len(name) > SERVER_NAME_MAX or any(character < " " for character in name):
        raise RelocationReadError(
            f"server_name 은 제어문자 없는 {SERVER_NAME_MAX}자 이내여야 합니다"
        )
    return name


# ── 느린 원격 I/O (자식 프로세스에서만 실행) ────────────────────────────────
def read_source_bytes(source: str) -> bytes:
    """공지 파일 원문을 읽는다. **이 함수만이 죽은 NAS 에서 오래 붙잡힐 수 있다.**"""
    if source.lower().startswith(("http://", "https://")):
        url = source.rstrip("/") + "/" + urllib.parse.quote(LOCATION_FILE)
        try:
            with urllib.request.urlopen(url, timeout=_HTTP_TIMEOUT_SECONDS) as response:
                return response.read(MAX_BYTES + 1)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise RelocationReadError(f"공지 주소에 연결할 수 없습니다: {exc}") from exc
    try:
        with (Path(source) / LOCATION_FILE).open("rb") as handle:
            return handle.read(MAX_BYTES + 1)
    except FileNotFoundError as exc:
        # 공지를 아직 한 번도 안 낸 정상 상태 — 발행이 이 경우에만 revision 1 로 시작한다.
        raise AnnouncementMissing("공지 파일이 아직 없습니다") from exc
    except OSError as exc:
        raise RelocationReadError(f"공지 파일을 읽을 수 없습니다: {exc}") from exc


def _atomic_write_text(path: Path, text: str) -> None:
    """원자 쓰기는 services/atomic_io 한 곳만 쓴다(구현을 복사하지 않는다).

    ★이 파일은 자식 프로세스에서 패키지 없이 스크립트로 실행되므로 그때는 상대 import 가
    불가능하다 — 같은 폴더의 모듈을 경로로 직접 불러온다(atomic_io 는 표준 라이브러리만 쓴다).
    """
    try:
        from .atomic_io import atomic_write_text
    except ImportError:  # 자식 프로세스(패키지 없음)
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from atomic_io import atomic_write_text  # type: ignore[no-redef]

    atomic_write_text(path, text)


# 릴리스 소스가 HTTP 주소인 배포(웹 서버에 릴리스를 올려 두는 방식)에서는 발행할 수 없다.
_HTTP_PUBLISH_REFUSAL = "HTTP 릴리스 소스에는 공지를 발행할 수 없습니다(폴더 경로만 가능합니다)"


def write_source_text(source: str, text: str) -> None:
    """공지 파일을 원자적으로 기록한다. **이 함수도 죽은 NAS 에서 오래 붙잡힐 수 있다.**"""
    if source.lower().startswith(("http://", "https://")):
        raise RelocationWriteError(_HTTP_PUBLISH_REFUSAL)
    folder = Path(source)
    if not folder.is_dir():
        # atomic_write_text 는 없는 폴더를 만든다 — 오타 난 경로에 가짜 릴리스 폴더를
        # 만들어 두면 아무도 못 읽는 공지가 조용히 생긴다. 먼저 존재를 확인한다.
        raise RelocationWriteError(f"릴리스 폴더를 찾을 수 없습니다: {source}")
    try:
        _atomic_write_text(folder / LOCATION_FILE, text)
    except PermissionError as exc:
        raise RelocationPermissionError(
            "릴리스 폴더에 쓰기 권한이 없습니다 — 관리자 PC 에서 실행하세요"
        ) from exc
    except OSError as exc:
        raise RelocationWriteError(f"공지 파일을 쓸 수 없습니다: {exc}") from exc


# ── 자식 프로세스 호출(읽기·쓰기 공통) ─────────────────────────────────────
def _run_child(args: list[str], timeout: float) -> dict[str, Any]:
    """이 파일을 자식 프로세스로 실행하고 마지막 JSON 한 줄을 돌려준다(실패는 빈 dict).

    느린 원격 I/O 는 전부 자식 안에서만 일어난다 — 부모는 타임아웃으로 반드시 회수한다.
    """
    try:
        completed = subprocess.run(  # noqa: S603 — 이 파일 자신을 현재 Python 으로 실행
            [sys.executable, "-I", str(Path(__file__).resolve()), *args],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            check=False,
        )
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        # 죽은 NAS 의 정상 결말이다 — 읽기는 직전 스냅샷을 그대로 쓰고, 발행은 실패 안내를 낸다.
        _log.info("server_relocation_child_skipped: %s", exc)
        return {}

    lines = [line for line in (completed.stdout or "").splitlines() if line.strip()]
    try:
        result = json.loads(lines[-1]) if lines else None
    except ValueError:
        result = None
    return result if isinstance(result, dict) else {}


def read_announcement(
    source: str, *, timeout: float = READ_TIMEOUT_SECONDS
) -> Optional[dict[str, Any]]:
    """공지를 격리된 자식 프로세스로 읽는다. 실패·타임아웃·형식 오류는 모두 None.

    자식은 바이트를 base64 로 실어 보내기만 하고, 해석은 부모(parse_announcement)가 한다.
    """
    result = _run_child([source], timeout)
    if not result.get("ok"):
        return None
    try:
        return parse_announcement(base64.b64decode(str(result.get("raw") or ""), validate=True))
    except (ValueError, RelocationReadError) as exc:
        _log.info("server_relocation_parse_failed: %s", exc)
        return None


# ── 소스 확정 · 스냅샷 ──────────────────────────────────────────────────────
def announcement_source(root: Optional[Path] = None) -> Optional[str]:
    """공지를 읽을 소스(INSTALL_SOURCE.txt) — **릴리스 설치본에서만**. 그 외는 None.

    ★release_update import 는 함수 안에서 한다: 이 파일은 자식 프로세스에서 스크립트로도
    실행되므로 최상단 상대 import 가 있으면 자식이 뜨지 않는다.
    """
    from .release_update import APP_ROOT, ReleaseUpdateError, install_mode, install_source

    target = APP_ROOT if root is None else root
    if install_mode(target) != "release":
        return None  # 공유 서버 본체·개발 실행본은 이사 공지의 대상이 아니다
    try:
        return install_source(target)
    except ReleaseUpdateError:
        return None


def snapshot() -> Optional[dict[str, Any]]:
    """마지막으로 읽어 둔 공지(없으면 None) — 라우터는 이것만 본다(느린 I/O 없음)."""
    return _snapshot[0]


def remember(announcement: Optional[dict[str, Any]]) -> None:
    """방금 직접 읽은 공지를 스냅샷에 반영한다(다음 주기를 기다리지 않게)."""
    if announcement:
        _snapshot[0] = announcement


def refresh(
    *, root: Optional[Path] = None, timeout: float = READ_TIMEOUT_SECONDS
) -> Optional[dict[str, Any]]:
    """공지를 다시 읽어 스냅샷을 갱신한다. 어떤 실패도 올리지 않는다(직전 값 유지).

    기동 1회 + worker_backup 유휴 주기(60초)에서 호출한다. 절대 예외를 던지지 않으므로
    호출부는 결과를 무시해도 된다.
    """
    if not _refresh_lock.acquire(blocking=False):
        return _snapshot[0]  # 앞선 읽기가 아직 진행 중 — 이번 주기는 건너뛴다
    try:
        source = announcement_source(root)
        if not source:
            return None
        remember(read_announcement(source, timeout=timeout))
        return _snapshot[0]
    except Exception:  # noqa: BLE001 — 공지 확인 실패가 백그라운드 루프를 죽이지 않게
        _log.info("server_relocation_refresh_failed", exc_info=True)
        return _snapshot[0]
    finally:
        _refresh_lock.release()


# ── 공지 발행(관리자 창 '팀에 공지') ────────────────────────────────────────
def render_announcement(url: str, revision: int, name: str, announced_at: str) -> str:
    """공지 파일 본문(JSON 텍스트). 쓰기 전에 **리더로 스스로 검증**한다.

    깨진 공지를 팀 전체에 뿌리면 아무도 알림을 못 받는데 관리자는 성공했다고 믿는다 —
    파싱을 통과하지 못하는 본문은 애초에 파일로 나가지 않는다.
    """
    text = json.dumps(
        {
            "shared_server_url": url,
            "server_revision": int(revision),
            "server_name": name,
            "announced_at": announced_at,
        },
        ensure_ascii=False,
        indent=2,
    ) + "\n"
    parse_announcement(text.encode("utf-8"))  # 자기 검증 — 어긋나면 RelocationReadError
    return text


def current_revision(source: str, *, timeout: float = READ_TIMEOUT_SECONDS) -> int:
    """지금 릴리스 폴더에 놓인 공지의 revision(파일이 없으면 0). 못 읽으면 예외.

    ★'없음'과 '못 읽음'을 반드시 구분한다 — 못 읽었는데 0 으로 진행하면 번호가 되감겨,
    이미 옮긴 PC 와 아직 안 옮긴 PC 중 어느 쪽이 맞는지 판단할 근거가 사라진다.
    """
    result = _run_child([source], timeout)
    if result.get("missing"):
        return 0
    if not result.get("ok"):
        raise RelocationWriteError(
            "기존 공지 파일을 확인하지 못했습니다: "
            + str(result.get("error") or "릴리스 폴더에 연결할 수 없습니다(시간 초과)")
        )
    try:
        return int(
            parse_announcement(base64.b64decode(str(result.get("raw") or ""), validate=True))[
                "revision"
            ]
        )
    except (ValueError, RelocationReadError) as exc:
        raise RelocationWriteError(
            f"기존 {LOCATION_FILE} 을 해석할 수 없습니다({exc}). "
            "그 파일을 고치거나 지운 뒤 다시 시도하세요"
        ) from exc


def _positive_int(value: Any) -> int:
    """1 이상의 정수만 통과시킨다(bool·None·문자열 쓰레기는 0 = '기억 없음')."""
    if isinstance(value, bool):
        return 0
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    return number if number > 0 else 0


def publish_announcement(
    source: str,
    *,
    url: str,
    name: str,
    last_published_revision: int = 0,
    timeout: float = WRITE_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """지금 주소·이름을 revision+1 로 공지 파일에 기록한다(원자 쓰기). 실패는 예외.

    읽기(번호 확인)와 쓰기가 각각 격리된 자식 프로세스다 — 죽은 NAS 를 만나도 각 단계가
    제한 시간 안에 회수된다. 두 단계 사이의 경쟁(다른 관리자가 동시에 발행)은 막지 않는다:
    관리자 둘이 같은 순간 다른 주소를 공지하는 것은 파일 잠금이 아니라 운영으로 막을 일이고,
    그때도 리더는 '같은 번호·다른 주소'를 거부해 사고를 조용히 퍼뜨리지 않는다.

    ★번호의 하한은 **파일과 ``last_published_revision`` 중 큰 쪽**이다. 누가 공지 파일을
    지우면 파일만 보는 계산은 1 로 되감기고, 이미 더 높은 번호를 수락한 PC 들은 그 공지를
    '지난 번호'로 보고 조용히 무시한다(아무도 못 옮기는데 관리자는 성공했다고 믿는다).
    호출자가 로컬에 기억해 둔 마지막 발행 번호를 넘겨 주면 파일이 사라져도 이어서 센다.
    기존 계약은 그대로다: 파일이 **있는데 못 읽으면**(무응답·손상) 여전히 발행을 거부한다 —
    로컬 폴백은 '파일 부재'에만 적용된다(그 구분은 :func:`current_revision` 이 한다).
    """
    if source.lower().startswith(("http://", "https://")):
        raise RelocationWriteError(_HTTP_PUBLISH_REFUSAL)  # 읽으러 가기 전에 끝낸다
    revision = (
        max(current_revision(source, timeout=timeout), _positive_int(last_published_revision)) + 1
    )
    announced_at = datetime.now().astimezone().isoformat(timespec="seconds")
    payload = render_announcement(url, revision, name, announced_at)
    result = _run_child(
        [source, "--write", base64.b64encode(payload.encode("utf-8")).decode("ascii")], timeout
    )
    if not result.get("ok"):
        if result.get("denied"):
            raise RelocationPermissionError(
                str(result.get("error") or "릴리스 폴더에 쓰기 권한이 없습니다")
            )
        raise RelocationWriteError(
            str(result.get("error") or "릴리스 폴더에 연결할 수 없습니다(시간 초과)")
        )
    announcement = {
        "url": url,
        "revision": revision,
        "name": name,
        "announced_at": announced_at,
    }
    remember(announcement)  # 방금 파일에 쓴 값이 곧 디스크의 진실이다 — 스냅샷도 맞춰 둔다
    return announcement


# ── 제안 판정(순수 함수) ────────────────────────────────────────────────────
def proposal(
    current_url: str,
    seen: Mapping[str, Any],
    announcement: Optional[Mapping[str, Any]],
) -> Optional[dict[str, Any]]:
    """지금 사용자에게 제안할 이사 공지(없으면 None).

    · 공지 없음 / 공지 주소가 이미 현재 주소 → 제안 없음
    · revision 이 이미 수락한 값 이하 → 제안 없음(지난 공지를 자동으로 되돌리지 않는다)
    · 같은 revision 인데 주소가 다르면 → **오류 로그 후 제안 없음**. 번호를 올리지 않고
      주소만 고쳐 쓴 공지는 어느 쪽이 최신인지 판단할 근거가 없다(운영 실수 신호).
    """
    if not announcement:
        return None
    url = str(announcement.get("url") or "")
    revision = announcement.get("revision")
    if not url or isinstance(revision, bool) or not isinstance(revision, int):
        return None
    if url == (current_url or "").rstrip("/"):
        return None

    seen_revision = seen.get("revision")
    seen_revision = seen_revision if isinstance(seen_revision, int) else 0
    if revision == seen_revision and url != str(seen.get("url") or ""):
        _log.error(
            "server_relocation_revision_conflict",
            extra={
                "event_fields": {
                    "event": "server_relocation_revision_conflict",
                    "revision": revision,
                    "announced_url": url,
                    "accepted_url": str(seen.get("url") or ""),
                }
            },
        )
        return None
    if revision <= seen_revision:
        return None
    return {
        "url": url,
        "revision": revision,
        "name": str(announcement.get("name") or ""),
        "announced_at": str(announcement.get("announced_at") or ""),
    }


# ── 자식 프로세스 진입점 ────────────────────────────────────────────────────
def _emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def _main(argv: list[str]) -> int:
    """``<source>`` = 읽기, ``<source> --write <base64 본문>`` = 발행(원자 쓰기).

    자식은 느린 I/O 만 담당한다 — 공지 해석·번호 계산은 전부 부모가 한다.
    """
    if not argv or not argv[0].strip():
        _emit({"ok": False, "error": "source required"})
        return 2
    if len(argv) == 3 and argv[1] == "--write":
        try:
            write_source_text(argv[0], base64.b64decode(argv[2], validate=True).decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            _emit({"ok": False, "error": f"본문을 해석할 수 없습니다: {exc}"[:300]})
            return 1
        except RelocationWriteError as exc:
            # 권한 거부는 안내 문구가 달라야 한다(작업자 PC 에서 누른 경우) — 따로 표시한다.
            _emit(
                {
                    "ok": False,
                    "denied": isinstance(exc, RelocationPermissionError),
                    "error": str(exc)[:300],
                }
            )
            return 1
        _emit({"ok": True})
        return 0
    if len(argv) != 1:
        _emit({"ok": False, "error": "source required"})
        return 2
    try:
        raw = read_source_bytes(argv[0])
    except RelocationReadError as exc:
        # 파일이 아직 없는 것은 '실패'가 아니라 '공지 전' 상태다 — 발행이 이 표식을 본다.
        _emit(
            {
                "ok": False,
                "missing": isinstance(exc, AnnouncementMissing),
                "error": str(exc)[:300],
            }
        )
        return 1
    _emit({"ok": True, "raw": base64.b64encode(raw).decode("ascii")})
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
