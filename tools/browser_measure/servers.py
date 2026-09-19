"""격리 브라우저 실측용 서버 두 대를 띄우고 내린다 (절차: docs/TESTING.md "격리 브라우저 실측").

  <venv python> tools/browser_measure/servers.py start     스냅샷 복사 → 토큰 제거 → H·S 기동 → 격리 확인(실패하면 즉시 내림)
  <venv python> tools/browser_measure/servers.py status
  <venv python> tools/browser_measure/servers.py stop      이 도구가 띄운 프로세스만 종료 + 복사본 삭제(계정 정보가 들어 있다). --keep 으로 남김

  H = 로컬 허브 보기(AUTH off, 기본 8231) · S = 서버 보기(AUTH on + 일회용 관리자, 기본 8232)

안전선(어기면 실사용에 피해): `backend/data`·`backend/data_test` 에는 쓰지 않는다(읽기 전용 sqlite backup 으로 복사만). 공유 서버 주소는
죽은 주소로 바꾸고 토큰을 지운다. 루프백에만 바인드한다. `PATH` 에서 Higgsfield CLI 를 빼서 CLI 호출(무료·유료)이 나갈 길을 없앤다.
기동 뒤 `/api/health` 의 `cli_available=false` 와 토큰 없음을 **확인하지 못하면 서버를 내리고 실패**한다.
★격리 DB 여도 Assets 창은 DB 에 등록된 **실제 폴더**를 읽고, 파일을 끌어 놓으면 거기에 저장된다 — Assets 의 파일 조작은 재지 않는다.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SOURCE_DB_DIR = REPO / "backend" / "data_test" / "db"
DEAD_URL = "http://127.0.0.1:9"  # discard 포트 — 아무도 듣지 않는다
SCRUB_KEYS = ("shared_server_token", "shared_server_elev_token", "shared_server_elev_expires", "shared_server_url", "shared_server_url_history")
CLI_NAMES = ("higgsfield", "higgsfield.cmd", "higgsfield.ps1", "higgsfield.exe", "hf", "hf.cmd", "hf.ps1", "hf.exe")
ADMIN_DOMAIN = "@localhost.invalid"


def snapshot(src: Path, dst: Path) -> None:
    """읽기 전용 연결의 backup API 로 복사한다(돌고 있는 세션의 WAL DB 도 안전). 복사본에서 공유 서버 토큰·주소를 지운다."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.unlink(missing_ok=True)
    with sqlite3.connect(src.absolute().as_uri() + "?mode=ro", uri=True) as a, sqlite3.connect(dst) as b:
        a.backup(b)
    with sqlite3.connect(dst) as conn:
        if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_setting'").fetchone():
            conn.execute(f"DELETE FROM app_setting WHERE key IN ({','.join('?' * len(SCRUB_KEYS))})", SCRUB_KEYS)
            conn.execute("INSERT INTO app_setting(key, value) VALUES ('shared_server_url', ?)", (DEAD_URL,))


def clean_path(path_value: str) -> str:
    """Higgsfield CLI 가 들어 있는 폴더를 전부 뺀 PATH."""
    return os.pathsep.join(
        part for part in path_value.split(os.pathsep)
        if part and not any((Path(part) / name).exists() for name in CLI_NAMES)
    )


def give_admin_data(db: Path) -> str:
    """일회용 관리자는 생성물이 0개다 — 복사본에서 최다 소유자와 creator_uid 를 맞바꿔 '내 작업'에 재료를 만든다."""
    with sqlite3.connect(db, timeout=30) as conn:
        top = conn.execute("SELECT creator_uid, COUNT(*) FROM generation WHERE creator_uid IS NOT NULL GROUP BY creator_uid ORDER BY 2 DESC LIMIT 1").fetchone()
        admin = conn.execute("SELECT email, creator_uid FROM account WHERE email LIKE ?", ("%" + ADMIN_DOMAIN,)).fetchone()
        if not top or not admin or admin[1] == top[0]:
            return "재료 없음(빈 DB)" if not top else "변경 없음"
        conn.execute("UPDATE account SET creator_uid = ? WHERE creator_uid = ?", (admin[1] or "bm-parked", top[0]))
        conn.execute("UPDATE account SET creator_uid = ? WHERE email = ?", (top[0], admin[0]))
        return f"일회용 관리자가 생성물 {top[1]}개를 소유"


def get_json(port: int, path: str, timeout: float = 3):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def wait_ready(port: int, timeout: float = 90) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            if get_json(port, "/api/ready").get("status") == "ready":
                return True
        except Exception:  # noqa: BLE001 — 아직 뜨는 중
            time.sleep(1)
    return False


def isolation_problems(name: str, port: int) -> list[str]:
    problems = []
    if get_json(port, "/api/health", 10).get("cli_available") is not False:
        problems.append("cli_available 이 false 가 아니다 — PATH 에 CLI 가 남아 있다")
    if name == "H":
        shared = get_json(port, "/api/shared-server/status", 10)
        if shared.get("has_token") or shared.get("url") != DEAD_URL:
            problems.append("공유 서버 토큰이 남았거나 주소가 죽은 주소가 아니다")
    return problems


def start(work: Path, ports: dict[str, int], seed: bool) -> int:
    pids_file = work / "pids.json"
    if pids_file.exists():
        print(f"이미 띄운 기록이 있다({pids_file}) — 먼저 stop")
        return 1
    pids: dict[str, int] = {}
    for name, port in ports.items():
        data = work / name
        shutil.rmtree(data, ignore_errors=True)
        for sub in ("db", "media", "shared", "assets", "backups"):
            (data / sub).mkdir(parents=True)
        for db_name in ("content_hub.db", "content_hub_trash.db", "manage_hub.db"):
            if (SOURCE_DB_DIR / db_name).is_file():
                snapshot(SOURCE_DB_DIR / db_name, data / "db" / db_name)
        env = os.environ.copy()
        for key in ("CONTENT_HUB_SSL_CERTFILE", "CONTENT_HUB_SSL_KEYFILE", "CONTENT_HUB_TEST_SNAPSHOT_EXPORT",
                    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "ELECTRON_RUN_AS_NODE"):
            env.pop(key, None)
        env.update({
            "PATH": clean_path(env.get("PATH", "")),
            "CONTENT_HUB_DATA": str(data), "CONTENT_HUB_DB": str(data / "db" / "content_hub.db"),
            "CONTENT_HUB_MEDIA": str(data / "media"), "CONTENT_HUB_SHARED": str(data / "shared"),
            "CONTENT_HUB_ASSETS_DIR": str(data / "assets"), "CONTENT_HUB_BACKUP_DIR": str(data / "backups"),
            "CONTENT_HUB_FRONTEND_DIST": str(REPO / "frontend" / "dist"),
            "CONTENT_HUB_BACKUP_INTERVAL": "0", "CONTENT_HUB_SERVER_SYNC": "0", "CONTENT_HUB_METRICS_LOG_INTERVAL": "0",
            "CONTENT_HUB_ACCESS_LOG": "1", "CONTENT_HUB_NO_PROXY": "1", "CONTENT_HUB_EXTERNAL_RECOVERY": "0",
            "CONTENT_HUB_SHARED_URL": DEAD_URL, "CONTENT_HUB_MANAGE": "1", "CONTENT_HUB_DB_BACKEND": "sqlite",
            "CONTENT_HUB_HOST": "127.0.0.1", "CONTENT_HUB_PORT": str(port), "CONTENT_HUB_AUTH": "1" if name == "S" else "0",
            "NO_PROXY": "127.0.0.1,localhost", "PYTHONIOENCODING": "utf-8",
        })
        if name == "S":
            creds = {"email": f"bm-{secrets.token_hex(4)}{ADMIN_DOMAIN}", "password": secrets.token_urlsafe(18)}
            env.update({"CONTENT_HUB_ADMIN_EMAIL": creds["email"], "CONTENT_HUB_ADMIN_PASSWORD": creds["password"],
                        "CONTENT_HUB_AUTH_SECRET": secrets.token_urlsafe(32)})
            (data / "creds.json").write_text(json.dumps(creds), encoding="utf-8")  # 실측 스크립트만 읽는다 — 출력하지 않는다
        log = (data / "server.log").open("w", encoding="utf-8", errors="replace")
        proc = subprocess.Popen([sys.executable, str(REPO / "backend" / "serve.py")], cwd=str(REPO / "backend"), env=env,
                                stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP)
        pids[name] = proc.pid
        pids_file.write_text(json.dumps(pids), encoding="utf-8")
        if not wait_ready(port):
            print(f"{name}: 준비되지 않았다 — {data / 'server.log'} 를 본다")
            stop(work, keep=True)
            return 1
        problems = isolation_problems(name, port)
        if problems:
            print(f"{name}: 격리 확인 실패 — " + " / ".join(problems))
            stop(work, keep=False)
            return 1
        note = give_admin_data(data / "db" / "content_hub.db") if (name == "S" and seed) else ""
        print(f"{name}: http://127.0.0.1:{port}/ 준비 · 격리 확인 통과" + (f" · {note}" if note else ""))
    print(f"작업 폴더: {work}  (일회용 관리자 자격은 S/creds.json — 출력하지 않는다)")
    return 0


def stop(work: Path, keep: bool) -> int:
    pids_file = work / "pids.json"
    if pids_file.exists():
        for name, pid in json.loads(pids_file.read_text(encoding="utf-8")).items():
            r = subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, text=True)
            print(f"{name}: pid {pid} 종료 — {'성공' if r.returncode == 0 else '이미 없음'}")
        pids_file.unlink()
    if not keep:
        time.sleep(1)  # 방금 종료한 프로세스의 파일 핸들이 풀릴 시간
        # 이 도구들이 만든 하위 폴더만 지운다(작업 폴더 자체는 건드리지 않는다). 결과 JSON·shots 는 사람이 보라고 남긴다.
        for name in ("H", "S", "chrome_profile"):
            shutil.rmtree(work / name, ignore_errors=True)
            print(f"복사본 삭제: {work / name}" + (" (일부 남음 — 다시 stop)" if (work / name).exists() else ""))
    return 0


def status(ports: dict[str, int]) -> int:
    for name, port in ports.items():
        try:
            print(name, port, get_json(port, "/api/ready"))
        except (OSError, urllib.error.URLError) as e:
            print(name, port, f"응답 없음 ({e.__class__.__name__})")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("command", choices=("start", "stop", "status"))
    ap.add_argument("--work", type=Path, default=Path(tempfile.gettempdir()) / "mvhub-browser-measure", help="복사본·로그를 둘 임시 폴더")
    ap.add_argument("--hub-port", type=int, default=8231)
    ap.add_argument("--server-port", type=int, default=8232)
    ap.add_argument("--no-seed", action="store_true", help="일회용 관리자에게 생성물을 주지 않는다")
    ap.add_argument("--keep", action="store_true", help="stop 때 복사본을 지우지 않는다")
    args = ap.parse_args()
    work = args.work.resolve()
    if work == REPO or REPO in work.parents or work in REPO.parents:
        print(f"작업 폴더는 저장소 밖이어야 한다: {work}")  # 복사본(계정 정보)이 저장소에 섞이거나 stop 이 저장소 폴더를 지우지 않게
        return 1
    args.work = work
    ports = {"H": args.hub_port, "S": args.server_port}
    if args.command == "start":
        return start(args.work, ports, seed=not args.no_seed)
    if args.command == "stop":
        return stop(args.work, keep=args.keep)
    return status(ports)


if __name__ == "__main__":
    sys.exit(main())
