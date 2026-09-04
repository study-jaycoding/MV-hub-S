"""로그 한 줄이 서버 기동을 죽이지 못하게 하는 보호(serve.py).

2026-09-04 실서버: CONTENT_HUB_EXTERNAL_RECOVERY=0 으로 띄우자 app/main.py 의 기동 안내
print 에 든 em dash(—)가 cp949 로 인코딩되지 않아 UnicodeEncodeError 가 났고, uvicorn 이
'Application startup failed' 로 프로세스를 끝냈다. cp949 에 한글은 있지만 em dash 는 없다.

예약 작업은 stdout 을 logs\\server_console.log 로 돌리므로 콘솔이 아니라 로케일 인코딩이
쓰인다. 같은 문자가 serve.py·backup·syncer·thumbs·asset_watcher 등 여러 곳에 있어,
그 경로를 지나가는 순간 같은 일이 난다.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]

# 실제로 코드에 들어 있는 문구. cp949 에 없는 문자는 em dash 하나다.
EM_DASH_LINE = (
    'print("[startup] \\uc678\\ubd80 \\ubcf5\\uad6c \\ube44\\ud65c\\uc131'
    "(CONTENT_HUB_EXTERNAL_RECOVERY=0) \\u2014 CLI"
    ' \\uc2e0\\uc6d0 \\ucea1\\ucc98 \\uc0dd\\ub7b5")'
)


def _run(code: str) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    # 한국어 Windows 에서 stdout 이 파일로 갈 때와 같은 상태를 만든다.
    env["PYTHONIOENCODING"] = "cp949"
    env.pop("PYTHONUTF8", None)
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(BACKEND),
        env=env,
        capture_output=True,
        text=True,
        errors="replace",
        timeout=120,
    )


def test_em_dash_kills_startup_without_the_guard():
    """보호가 없으면 정말 죽는다 — 이 전제가 무너지면 아래 테스트가 무의미해진다."""
    done = _run(EM_DASH_LINE)
    assert done.returncode != 0
    assert "UnicodeEncodeError" in done.stderr


def test_importing_serve_makes_that_same_line_survive():
    """serve.py 를 거쳐 오면 같은 줄이 기동을 막지 못한다."""
    done = _run("import serve\n" + EM_DASH_LINE + '\nprint("STILL-ALIVE")')
    assert done.returncode == 0, done.stderr
    assert "STILL-ALIVE" in done.stdout


def test_guard_keeps_the_stream_encoding_it_was_given():
    """인코딩까지 바꾸지는 않는다 — 기존 로그 읽기(MV_logs.bat)가 그대로여야 한다.

    바꾸는 것은 오류 처리(strict -> replace)뿐이다. PYTHONIOENCODING 을 준 호출자
    (복원 드릴은 utf-8 을 준다)의 선택도 그대로 유지된다.
    """
    done = _run("import serve, sys; print(sys.stdout.encoding, sys.stdout.errors)")
    assert done.returncode == 0, done.stderr
    encoding, errors = done.stdout.split()[:2]
    assert encoding.lower().replace("-", "") in {"cp949", "ms949", "euckr", "uhc"}
    assert errors == "replace"
