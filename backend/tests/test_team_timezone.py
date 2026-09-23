"""팀 표준시(KST) 고정 — 서버 OS 시간대가 무엇이든 집계 경계는 KST 여야 한다.

배경: 사용량·예산·크레딧 기간 경계는 SQLite `localtime` 과 파이썬 지역시간으로 계산한다.
공유 서버 OS 가 UTC 면(2026-09-10 실측) 시·일·주·월 경계가 9시간 밀려, 어제 저녁 사용이 오늘로 잡힌다.
`app.config` 가 프로세스 시작 시 `TZ` 를 못 박아 모든 경로가 한 시계를 쓰게 한다.

Windows 런타임은 TZ 를 **첫 사용 때 한 번만** 읽으므로(실행 중 변경은 안 먹는다 — 2026-09-23 실측)
이 시험은 반드시 **자식 프로세스**에서 확인한다. 부모의 TZ 는 물려주지 않는다.
"""

import os
import subprocess
import sys
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]


def _run(code: str, env_tz: str | None, extra: dict[str, str] | None = None) -> str:
    env = {k: v for k, v in os.environ.items() if k not in ("TZ", "CONTENT_HUB_TZ")}
    if env_tz is not None:
        env["TZ"] = env_tz
    env.update(extra or {})
    env["PYTHONPATH"] = str(BACKEND)
    out = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, env=env, cwd=str(BACKEND)
    )
    assert out.returncode == 0, out.stderr
    return out.stdout.strip()


class TeamTimezoneTests(unittest.TestCase):
    def test_config_pins_tz_when_unset(self) -> None:
        """TZ 가 없으면 설정 모듈이 KST 로 못 박는다 — 서버 OS 가 UTC 여도 경계가 안 밀린다."""
        self.assertEqual(_run("import os, app.config; print(os.environ['TZ'])", None), "KST-9")

    def test_outside_tz_does_not_unpin_us(self) -> None:
        """밖에 `TZ=UTC0` 이 있어도 **우리가 덮어쓴다** — 그러지 않으면 'KST 고정'이 조용히 풀린다
        (Codex 코드 리뷰 2026-09-23). 다른 표준시로 돌리려면 우리 변수로 명시해야 한다."""
        self.assertEqual(_run("import os, app.config; print(os.environ['TZ'])", "UTC0"), "KST-9")

    def test_our_variable_can_change_it(self) -> None:
        env = {"CONTENT_HUB_TZ": "UTC0"}
        self.assertEqual(_run("import os, app.config; print(os.environ['TZ'])", None, extra=env), "UTC0")

    def test_server_entry_pins_before_heavy_imports(self) -> None:
        """`serve.py` 는 **app.config 를 uvicorn 보다 먼저** 부른다 — 시간대는 런타임이 첫 시간 함수에서
        한 번만 읽으므로, 시간을 건드릴 수 있는 큰 라이브러리를 먼저 부르면 고정이 늦는다.
        (KST 인 개발 PC 에서는 차이가 안 보여 순서로 고정한다 — Codex 코드 리뷰 2026-09-23)"""
        source = (BACKEND / "serve.py").read_text(encoding="utf-8")
        self.assertLess(
            source.index("from app.config import"), source.index("import uvicorn"),
            "serve.py 가 uvicorn 을 app.config 보다 먼저 import 한다 — 표준시 고정이 늦을 수 있다",
        )

    def test_sqlite_localtime_is_kst(self) -> None:
        """집계가 쓰는 `localtime` 이 KST 다 — 9/22 15:30Z 는 KST 로 **다음 날** 00:30 이다."""
        code = (
            "import app.config, sqlite3;"
            "print(sqlite3.connect(':memory:').execute("
            "\"SELECT strftime('%Y-%m-%d %H:%M','2026-09-22T15:30:00Z','localtime')\").fetchone()[0])"
        )
        self.assertEqual(_run(code, None), "2026-09-23 00:30")

    def test_python_local_date_is_kst(self) -> None:
        """크레딧 기간 계산의 '오늘'(`manage_credit_plan.today_local`)도 같은 시계를 쓴다."""
        code = (
            "import app.config, datetime;"
            "from app.repo.manage_credit_plan import today_local;"
            "kst = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=9)).date().isoformat();"
            "print(today_local() == kst)"
        )
        self.assertEqual(_run(code, None), "True")


if __name__ == "__main__":
    unittest.main()
