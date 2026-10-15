"""작업실의 최초 DB 사본과 개인 실행 환경. 기존 데이터는 다시 복사하지 않는다."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import secrets
import sqlite3
from contextlib import closing
from pathlib import Path

from browser_measure.servers import server_env, snapshot

MARKER = ".mvhub-workroom.json"


def prepare_runtime(runtime: Path, source_db: Path | None, repo: Path) -> None:
    runtime, repo = runtime.resolve(), repo.resolve()
    if runtime == repo or runtime in repo.parents or repo in runtime.parents:
        raise ValueError("작업실 데이터는 소스 폴더 밖에 두세요")
    marker = runtime / MARKER
    if marker.exists():
        saved = json.loads(marker.read_text(encoding="utf-8"))
        if saved.get("repo") != str(repo) or saved.get("version") != 1:
            raise ValueError("다른 작업실의 데이터 폴더입니다")
        if not (runtime / "data/db/content_hub.db").is_file() or not (runtime / "auth.secret").is_file():
            raise ValueError("작업실 데이터가 불완전합니다. 덮어쓰지 않습니다")
        return
    if runtime.exists() and any(runtime.iterdir()):
        raise ValueError("표식 없는 기존 폴더를 덮어쓰지 않습니다. 새 작업실 폴더를 지정하세요")
    if source_db is None or not source_db.is_file():
        raise ValueError("최초 실행에는 --source-db 로 시험용 content_hub.db를 지정하세요")
    source_db = source_db.resolve()
    if runtime == source_db.parent or runtime in source_db.parents or source_db.parent in runtime.parents:
        raise ValueError("원본 DB와 작업실 데이터 경로가 겹칩니다")
    runtime.mkdir(parents=True, exist_ok=True)
    # 코드만 로드한다. app 패키지 import는 실제 데이터 폴더를 만들 수 있다.
    spec = importlib.util.spec_from_file_location("workroom_scrub", repo / "backend/app/services/db_scrub.py")
    scrub = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(scrub)
    for name in ("content_hub.db", "content_hub_trash.db", "manage_hub.db"):
        src = source_db if name == "content_hub.db" else source_db.parent / name
        if not src.is_file():
            continue
        dst = runtime / "data/db" / name
        snapshot(src, dst)
        with closing(sqlite3.connect(dst)) as conn, conn:
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "app_setting" in tables:
                conn.executemany("DELETE FROM app_setting WHERE key=?", [(key,) for key in scrub.SESSION_KEYS])
                conn.execute("DELETE FROM app_setting WHERE key LIKE 'comfy_%' OR key LIKE 'resolve_%' OR key LIKE 'backup_replica_%'")
            if "mcp_client" in tables:
                conn.execute("UPDATE mcp_client SET revoked_at=COALESCE(revoked_at,datetime('now'))")
    (runtime / "auth.secret").write_text(secrets.token_urlsafe(48), encoding="utf-8")
    marker.write_text(json.dumps({"version": 1, "repo": str(repo)}, indent=2), encoding="utf-8")


def runtime_env(runtime: Path, repo: Path, backend_port: int, parent=None) -> dict[str, str]:
    runtime = runtime.resolve()
    env = server_env(os.environ if parent is None else parent, "S", backend_port, runtime / "data")
    homes = {"HOME": "home", "USERPROFILE": "home", "APPDATA": "home/AppData/Roaming",
             "LOCALAPPDATA": "home/AppData/Local", "TEMP": "tmp", "TMP": "tmp",
             "CODEX_HOME": "home/.codex", "CLAUDE_CONFIG_DIR": "home/.claude"}
    for key, sub in homes.items():
        target = runtime / sub
        target.mkdir(parents=True, exist_ok=True)
        env[key] = str(target)
    env.update({"CONTENT_HUB_AUTH_SECRET": (runtime / "auth.secret").read_text(encoding="utf-8"),
                "CONTENT_HUB_FRONTEND_DIST": str(repo / "frontend/dist"),
                "CONTENT_HUB_ASSET_REGISTRY": "0", "MVHUB_NAMES_READONLY": "1",
                "PYTHONDONTWRITEBYTECODE": "1", "BACKEND": f"http://127.0.0.1:{backend_port}"})
    return env


def llm_config_hashes(parent=None) -> dict[str, str | None]:
    """기존 설정은 내용 대신 해시만 비교한다. 외부 세션의 변경을 되돌리지 않는다."""
    parent = os.environ if parent is None else parent
    home = Path(parent.get("USERPROFILE", str(Path.home())))
    paths = [Path(parent.get("CODEX_HOME", str(home / ".codex"))) / "config.toml",
             home / ".claude.json", home / ".claude/settings.json",
             Path(parent.get("APPDATA", str(home / "AppData/Roaming"))) / "Claude/claude_desktop_config.json"]
    return {str(path): hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None for path in paths}
