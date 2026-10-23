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
import json
import sys
from pathlib import Path


import inspect

# 관리 창이 부르는 루트 함수·인자 — 관리 도구 갱신의 시작 점검(selfcheck)이 새 관리 창과 이 서버 루트가 맞는지 미리 본다.
NEEDS = {
    "release_update": {"list_packages": ("root",), "release_overview": ("root",), "package_manifest": ("file", "root"),
                       "promote_candidate": ("expected", "root"),
                       "deploy_package": ("expected", "expect_published", "expect_candidate", "root"),
                       "install_source": ("root",), "ReleaseUpdateError": (), "ReleasePromoteError": ()},
    "server_relocation": {"parse_announcement": ("raw",), "read_source_bytes": ("source",),
                          "publish_announcement": ("source", "url", "name", "last_published_revision"),
                          "AnnouncementMissing": (), "RelocationReadError": (), "RelocationWriteError": ()},
}


def missing_parts(modules: dict, needs: dict) -> list[str]:
    """없는 함수·인자 이름들(맞으면 빈 목록)."""
    missing = []
    absent = object()
    for module_name, wanted in needs.items():
        for name, params in wanted.items():
            thing = getattr(modules[module_name], name, absent)
            if thing is absent:
                missing.append(f"{module_name}.{name}")
                continue
            try:
                have = inspect.signature(thing).parameters if params else {}
            except (TypeError, ValueError):
                have = {}
            missing += [f"{module_name}.{name}({param})" for param in params if param not in have]
    return missing


def _expected(text: str) -> dict:
    value = json.loads(base64.b64decode(text, validate=True).decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("expected")
    return value


def run(install_root: Path, release_root: Path, command: str, args: list[str]) -> dict:
    sys.path.insert(0, str(install_root / "backend"))
    from app.services import release_update as ru  # noqa: PLC0415 — 환경을 정한 뒤에만
    from app.services import server_relocation as sr  # noqa: PLC0415

    if command == "selfcheck" and not args:
        missing = missing_parts({"release_update": ru, "server_relocation": sr}, NEEDS)
        return {"ok": not missing, "missing": missing}
    try:
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
            return {"ok": True, "result": ru.deploy_package(_expected(args[0]), args[1], args[2], release_root)}
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
    except (ru.ReleaseUpdateError, sr.RelocationReadError, sr.RelocationWriteError) as exc:
        return {"ok": False, "error": str(exc), "status": 400}
    return {"ok": False, "error": "알 수 없는 명령입니다", "status": 400}


def main(argv: list[str]) -> int:
    if len(argv) < 4:
        return 64
    print(json.dumps(run(Path(argv[1]), Path(argv[2]), argv[3], argv[4:])))  # ASCII 만
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
