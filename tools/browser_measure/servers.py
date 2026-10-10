"""격리 브라우저 실측용 서버 두 대를 띄우고 내린다 (절차: docs/TESTING.md "격리 브라우저 실측").

  <venv python> tools/browser_measure/servers.py start     스냅샷 복사 → 토큰 제거 → H·S 기동 → 격리 확인(실패하면 즉시 내림)
        --source <폴더>   복사해 올 시험 DB 폴더(기본: 이 저장소의 backend/data_test/db). 원본이 없거나 지금 코드로 열 수 없으면(옛 스키마 등) 원인을 말하고 끝난다
  <venv python> tools/browser_measure/servers.py status
  <venv python> tools/browser_measure/servers.py stop      이 도구가 띄운 프로세스만 종료 + 복사본·실측 결과 삭제(계정 정보가 들어 있다). --keep 으로 남김

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
from contextlib import closing
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SOURCE_DB_DIR = REPO / "backend" / "data_test" / "db"  # 기본 원본 — test_pull-db.bat 이 채우는 자리(저장소마다 따로 있다)
SOURCE_HINT = "다른 원본은 `start --source <content_hub.db 가 든 폴더>` 로 준다. 기본 원본(이 저장소의 backend/data_test/db)은 test_pull-db.bat 으로 새로 받는다."
DEAD_URL = "http://127.0.0.1:9"  # discard 포트 — 아무도 듣지 않는다
SCRUB_KEYS = ("shared_server_token", "shared_server_elev_token", "shared_server_elev_expires", "shared_server_url", "shared_server_url_history")
CLI_NAMES = ("higgsfield", "higgsfield.cmd", "higgsfield.ps1", "higgsfield.exe", "hf", "hf.cmd", "hf.ps1", "hf.exe")
ADMIN_DOMAIN = "@localhost.invalid"
MARKER = ".mvhub-browser-measure"  # start 가 작업 폴더에 남기는 표식 — 이 도구는 자기가 만든 작업 폴더 안에서만 지운다
CLEANED = ("H", "S", "chrome_profile", "shots")  # stop 이 지우는 폴더(+ results_*.json)


def snapshot(src: Path, dst: Path) -> None:
    """읽기 전용 연결의 backup API 로 복사한다(돌고 있는 세션의 WAL DB 도 안전). 복사본에서 공유 서버 토큰·주소와 프로젝트의 실제 폴더 경로를 지운다."""
    if src.resolve() == dst.resolve():
        raise ValueError(f"원본과 복사본이 같은 파일이다: {src}")  # 아래 unlink 가 원본을 지운다
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.unlink(missing_ok=True)
    uri = src.absolute().as_uri()
    if not uri.startswith("file:///"):  # UNC: file://server/share → file:////server/share (sqlite 는 authority 를 거부한다)
        uri = "file:////" + uri[len("file://"):]
    # closing: sqlite 의 with 는 연결을 닫지 않는다 — 복사가 실패하면 열린 연결이 파일을 쥐어 start() 가 복사하다 만 것을 치우지 못한다
    with closing(sqlite3.connect(uri + "?mode=ro", uri=True)) as a, closing(sqlite3.connect(dst)) as b:
        a.backup(b)
    with closing(sqlite3.connect(dst)) as conn, conn:
        if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_setting'").fetchone():
            conn.execute(f"DELETE FROM app_setting WHERE key IN ({','.join('?' * len(SCRUB_KEYS))})", SCRUB_KEYS)
            conn.execute("INSERT INTO app_setting(key, value) VALUES ('shared_server_url', ?)", (DEAD_URL,))
        # Assets 창은 프로젝트의 폴더 경로를 자동 마운트한다(routers/assets.py `_auto_project_mounts`) — 남겨 두면 격리 복사본이어도
        # 실제 NAS·로컬 폴더가 열리고 업로드가 거기에 저장된다. ★손으로 폴더를 등록하는 것까지는 못 막는다(운영 규칙으로 금지).
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "project_folder_link" in tables:
            conn.execute("DELETE FROM project_folder_link")
        if "project" in tables and any(col[1] == "render_root_path" for col in conn.execute("PRAGMA table_info(project)")):
            conn.execute("UPDATE project SET render_root_path = NULL")


def isolated_base_env(parent) -> dict[str, str]:
    """부모 셸의 `CONTENT_HUB_*` 를 **전부** 버린다 — 경로 변수(작업자 백업 상태 DB·outbox·기기 신원·로그 폴더 등)는 DATA_DIR 보다
    우선하므로, 하나라도 물려받으면 격리 폴더 밖에 쓴다. 필요한 값은 start() 가 아래에서 다시 넣는다."""
    dropped = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "ELECTRON_RUN_AS_NODE")
    return {k: v for k, v in parent.items() if not k.upper().startswith("CONTENT_HUB_") and k.upper() not in dropped}


def server_env(parent, name: str, port: int, data: Path) -> dict[str, str]:
    """격리 서버 한 대의 환경 — 부모의 `CONTENT_HUB_*` 없이, 모든 경로가 작업 폴더(data) 안을 가리킨다."""
    env = isolated_base_env(parent)
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
    return env


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


def wait_ready(port: int, timeout: float = 90, proc: subprocess.Popen | None = None) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if proc is not None and proc.poll() is not None:
            return False  # 기동 중에 죽었다 — 더 기다려도 뜨지 않는다(전에는 남은 90초를 다 기다렸다)
        try:
            if get_json(port, "/api/ready").get("status") == "ready":
                return True
        except Exception:  # noqa: BLE001 — 아직 뜨는 중
            time.sleep(1)
    return False


def startup_cause(log: Path) -> str:
    """기동 중에 죽은 서버의 로그에서 원인 한 줄 — 마지막 예외 줄(`sqlite3.OperationalError: …`), 없으면 마지막 줄."""
    lines = [line for line in log.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()]
    # 예외 줄 = 첫 칸에서 시작하고 `:` 앞이 한 낱말이며 Error·Exception 으로 끝난다(uvicorn 의 `ERROR:` 머리·들여 쓴 코드 줄은 아니다)
    heads = [(line, line.split(":", 1)[0]) for line in lines if line[:1].isalpha()]
    errors = [line for line, head in heads if " " not in head and head.endswith(("Error", "Exception"))]
    return (errors or lines or ["(로그가 비어 있다)"])[-1].strip()[:300]


def isolation_problems(name: str, port: int) -> list[str]:
    problems = []
    if get_json(port, "/api/health", 10).get("cli_available") is not False:
        problems.append("cli_available 이 false 가 아니다 — PATH 에 CLI 가 남아 있다")
    if name == "H":
        shared = get_json(port, "/api/shared-server/status", 10)
        if shared.get("has_token") or shared.get("url") != DEAD_URL:
            problems.append("공유 서버 토큰이 남았거나 주소가 죽은 주소가 아니다")
    return problems


def owned(work: Path) -> bool:
    """이 도구가 만든 작업 폴더인가 — start 가 남긴 표식이 있다."""
    # ponytail: 뒤의 셋은 표식을 남기지 않던 판(2026-10-11 이전)이 띄운 폴더의 흔적이다 — 그 폴더들이 다 내려가면 표식만 본다
    return any((work / trace).is_file() for trace in (MARKER, "pids.json", "H/server.log", "S/server.log"))


def foreign(work: Path) -> list[str]:
    """작업 폴더에서 start·stop 이 지울 이름인데 이 도구가 만들지 않은 것 — 비어 있어야 지워도 된다(`--work` 가 남의 폴더를 가리킨 경우)."""
    if owned(work):
        return []
    return [name for name in CLEANED if (work / name).exists()] + [p.name for p in work.glob("results_*.json")]


def start(work: Path, ports: dict[str, int], seed: bool, source: Path | None = None) -> int:
    source = (source or SOURCE_DB_DIR).absolute()  # 모듈 값은 부를 때 읽는다 — 래퍼가 SOURCE_DB_DIR 를 바꿔 끼울 수 있다
    # 작업 폴더 안의 것은 지우고 다시 만든다 — 원본이 그 안이면 원본이 지워지고, 작업 폴더가 원본 안이면 원본에 쓴다.
    # resolve 로 링크·junction·대소문자를 풀어 견준다(지난 실행의 사본 `<work>/H/db` 를 원본으로 준 경우가 실제로 지워졌다).
    real_work, real_source = work.resolve(), source.resolve()
    if real_work == real_source or real_work in real_source.parents or real_source in real_work.parents:
        print(f"원본과 작업 폴더가 겹친다 — 아무것도 지우지 않고 끝낸다. 서로 밖에 있는 폴더를 준다(--source, --work)\n  원본: {source}\n  작업 폴더: {work}")
        return 1
    pids_file = work / "pids.json"
    if pids_file.exists():
        print(f"이미 띄운 기록이 있다({pids_file}) — 먼저 stop")
        return 1
    if not (source / "content_hub.db").is_file():
        # 전에는 말없이 빈 DB 로 떴다 — 잰 것이 빈 앱인 줄 모른다
        print(f"원본 시험 DB 가 없다: {source / 'content_hub.db'}\n  {SOURCE_HINT}")
        return 1
    if names := foreign(work):
        print(f"작업 폴더에 이 도구가 만들지 않은 것이 있다({', '.join(names)}) — 지우지 않고 끝낸다. 빈 폴더나 새 폴더를 --work 로 준다: {work}")
        return 1
    work.mkdir(parents=True, exist_ok=True)
    (work / MARKER).touch()  # 여기부터 이 폴더는 내 것 — 아래에서 만드는 것과 나중에 실측이 남기는 것(크롬 프로필·결과)을 stop 이 치울 수 있다
    pids: dict[str, int] = {}
    for name, port in ports.items():
        data = work / name
        shutil.rmtree(data, ignore_errors=True)
        for sub in ("db", "media", "shared", "assets", "backups"):
            (data / sub).mkdir(parents=True)
        try:
            for db_name in ("content_hub.db", "content_hub_trash.db", "manage_hub.db"):
                if (source / db_name).is_file():
                    snapshot(source / db_name, data / "db" / db_name)
        except sqlite3.Error as exc:
            print(f"{name}: 원본을 복사하지 못했다({type(exc).__name__}: {exc}) — {source}\n  {SOURCE_HINT}")
            stop(work, keep=False)  # 복사하다 만 것을 치운다. S 차례였다면 H 가 이미 떠 있다
            return 1
        env = server_env(os.environ, name, port, data)
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
        if not wait_ready(port, proc=proc):
            if proc.poll() is None:
                print(f"{name}: 준비되지 않았다 — {data / 'server.log'} 를 본다")
            else:
                cause = startup_cause(data / "server.log")
                print(f"{name}: 기동 중에 서버가 죽었다(종료 코드 {proc.returncode}) — {cause}\n  전체 로그: {data / 'server.log'}")
                if "sqlite3." in cause:  # DB 오류로 죽었다면 대개 복사해 온 원본이 지금 코드와 맞지 않는 것이다(옛 스키마 등)
                    print(f"  원본 DB 가 지금 코드와 맞지 않는 것으로 보인다: {source}\n  {SOURCE_HINT}")
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
    if names := foreign(work):
        print(f"이 도구가 만든 작업 폴더가 아니다({', '.join(names)} 가 있지만 표식 {MARKER} 가 없다) — 아무것도 지우지 않는다: {work}")
        return 1
    if owned(work):
        (work / MARKER).touch()  # 표식 전 판의 폴더는 여기서 표식을 얻는다 — 흔적(서버 로그)을 지운 뒤의 '다시 stop' 도 내 폴더로 알아보게
    pids_file = work / "pids.json"
    if pids_file.exists():
        for name, pid in json.loads(pids_file.read_text(encoding="utf-8")).items():
            r = subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, text=True)
            print(f"{name}: pid {pid} 종료 — {'성공' if r.returncode == 0 else '이미 없음'}")
        pids_file.unlink()
    if not keep:
        time.sleep(1)  # 방금 종료한 프로세스의 파일 핸들이 풀릴 시간
        # 이 도구들이 만든 것만 지운다(작업 폴더 자체는 건드리지 않는다). 결과·스크린샷에도 실제 계정 이름이 남을 수 있어 함께 지운다.
        for name in CLEANED:
            shutil.rmtree(work / name, ignore_errors=True)
            print(f"삭제: {work / name}" + (" (일부 남음 — 다시 stop)" if (work / name).exists() else ""))
        for result in work.glob("results_*.json"):
            result.unlink(missing_ok=True)
            print(f"삭제: {result}")
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
    ap.add_argument("--source", type=Path, help="복사해 올 시험 DB 폴더(content_hub.db 가 든 곳 — 읽기만 한다). 기본: 이 저장소의 backend/data_test/db")
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
        return start(args.work, ports, seed=not args.no_seed, source=args.source)
    if args.command == "stop":
        return stop(args.work, keep=args.keep)
    return status(ports)


if __name__ == "__main__":
    sys.exit(main())
