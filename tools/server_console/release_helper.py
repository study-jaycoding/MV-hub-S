"""서버 루트의 릴리스·이사 공지 함수(backend/app/services)를 대신 부르는 짧은 도우미 자식.

python -I -B release_helper.py <설치 루트> <관리 창 릴리스 루트> <명령> [인자…]
- 관리 창 릴리스 루트 = INSTALL_SOURCE.txt 하나만 둔 관리 창 전용 폴더(.mvhub-runtime\\console-release) — 함수의 root.
- 가져오기 전에 부르는 쪽이 CONTENT_HUB_DATA 를 빈 작업 폴더로 정한다(config 의 폴더 만들기가 실제 데이터에 닿지 않게).
- 결과는 JSON 한 줄: {"ok": true, ...} 또는 {"ok": false, "error": 문구, "status": HTTP 상태}.
명령: read · manifest <file> · promote <기대 b64> · deploy <기대 b64> <공개 sha> <후보 sha> · location · publish <url> <이름> <기억한 판>
· selfcheck(쓰기 없음 — 관리 창이 부르는 루트 함수·인자가 있는지)
"""
from __future__ import annotations

import base64
import _strptime  # noqa: F401 — NAS 신원으로 넘어간 뒤 표준 라이브러리를 추가로 열지 않게 한다
import encodings.cp437  # noqa: F401 — ZIP 파일명의 기본 인코딩
import json
import sys
import zipfile  # noqa: F401 — 신원을 전환하기 전에 ZIP 검사 모듈을 읽어 둔다
from pathlib import Path


import inspect

# 관리 창이 부르는 루트 함수 — 관리 도구 갱신의 시작 점검(selfcheck)이 새 관리 창과 이 서버 루트가 맞는지 미리 본다.
# 값 = 실제 부르는 모양(위치 인자 수, 키워드 인자) · "error" = 예외 클래스 · "value" = 있기만 하면 되는 값.
NEEDS = {
    "release_update": {"list_packages": (1, ()), "release_overview": (1, ()), "package_manifest": (2, ()),
                       "promote_candidate": (2, ()), "deploy_package": (4, ()), "install_source": (1, ()),
                       "ReleaseUpdateError": "error", "ReleasePromoteError": "error"},
    "server_relocation": {"parse_announcement": (1, ()), "read_source_bytes": (1, ()),
                          "publish_announcement": (1, ("url", "name", "last_published_revision")),
                          "AnnouncementMissing": "error", "RelocationReadError": "error", "RelocationWriteError": "error"},
}


def missing_parts(modules: dict, needs: dict) -> list[str]:
    """실제로 부르는 모양으로 부를 수 없는 것들(맞으면 빈 목록) — 인자 이름만이 아니라 위치·키워드·필수 인자까지
    inspect.signature().bind 로 본다."""
    missing = []
    absent = object()
    for module_name, wanted in needs.items():
        for name, shape in wanted.items():
            thing = getattr(modules[module_name], name, absent)
            if thing is absent:
                missing.append(f"{module_name}.{name}")
            elif shape == "error":
                if not (isinstance(thing, type) and issubclass(thing, BaseException)):
                    missing.append(f"{module_name}.{name}(예외 아님)")
            elif shape != "value":
                positional, keywords = shape
                try:
                    inspect.signature(thing).bind(*([None] * positional), **dict.fromkeys(keywords))
                except (TypeError, ValueError):
                    missing.append(f"{module_name}.{name}(인자 {positional}개{' + ' + ','.join(keywords) if keywords else ''})")
    return missing


def _expected(text: str) -> dict:
    value = json.loads(base64.b64decode(text, validate=True).decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("expected")
    return value


def run(install_root: Path, release_root: Path, command: str, args: list[str]) -> dict:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from server_console import nas_access
    if sys.platform == "win32":
        import _winapi  # noqa: F401 — NAS 잠금 모듈도 신원 전환 전에 읽는다
    sys.path.insert(0, str(install_root / "backend"))
    from app.services import release_update as ru  # noqa: PLC0415 — 환경을 정한 뒤에만
    from app.services import server_relocation as sr  # noqa: PLC0415

    if command == "selfcheck" and not args:
        missing = missing_parts({"release_update": ru, "server_relocation": sr}, NEEDS)
        return {"ok": not missing, "missing": missing}
    try:
        if command in ("read", "manifest", "promote", "deploy"):
            # 생성자가 이 설정에만 같은 사용자의 읽기 권한을 주었다. 작업 중에도 같은 경로만 읽는다.
            source = ru.install_source(release_root)
            with nas_access.connected(source):
                if command == "read" and not args:
                    out: dict = {"ok": True}
                    try:
                        out["packages"] = ru.list_packages(release_root)
                    except ru.ReleaseUpdateError as exc:
                        out["packages_error"] = str(exc)
                    try:
                        out["overview"] = ru.release_overview(release_root)
                    except ru.ReleaseUpdateError as exc:
                        out["overview_error"] = str(exc)
                    return out
                if command == "manifest" and len(args) == 1:
                    return {"ok": True, "manifest": ru.package_manifest(args[0], release_root)}
                if command == "promote" and len(args) == 1:
                    return {"ok": True, "result": ru.promote_candidate(_expected(args[0]), release_root)}
                if command == "deploy" and len(args) == 3:
                    return {"ok": True, "result": ru.deploy_package(
                        _expected(args[0]), args[1], args[2], release_root)}
        if command == "location" and not args:
            source = ru.install_source(release_root)
            try:
                return {"ok": True, "announcement": sr.parse_announcement(sr.read_source_bytes(source))}
            except sr.AnnouncementMissing:
                return {"ok": True, "announcement": None}
        if command == "publish" and len(args) == 3:
            source = ru.install_source(release_root)
            return {"ok": True, "announcement": sr.publish_announcement(
                source, url=args[0], name=args[1], last_published_revision=int(args[2]))}
    except ru.ReleasePromoteError as exc:
        return {"ok": False, "error": str(exc), "status": exc.status}
    except (ru.ReleaseUpdateError, sr.RelocationReadError, sr.RelocationWriteError, nas_access.NasAccessError) as exc:
        return {"ok": False, "error": str(exc), "status": 400}
    return {"ok": False, "error": "알 수 없는 명령입니다", "status": 400}


def main(argv: list[str]) -> int:
    if len(argv) < 4:
        return 64
    print(json.dumps(run(Path(argv[1]), Path(argv[2]), argv[3], argv[4:])))  # ASCII 만
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
