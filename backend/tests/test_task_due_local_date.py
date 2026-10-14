"""작업 보관의 마감일 비교는 팀 표준시의 '오늘'로 한다(46회차).

마감일은 PM 이 고른 달력 날짜다. SQL 이 UTC 의 오늘(`date('now')`)과 비교하면 KST 00~09시에는
어제 마감이 아직 안 지난 것으로 보여 보관이 최대 9시간 늦었다.

Windows 런타임은 TZ 를 첫 사용 때 한 번만 읽으므로(test_team_timezone 참고) **자식 프로세스**에서
지역 날짜와 UTC 날짜가 다른 시간대(UTC±12)를 골라 확인한다. 그래야 몇 시에 돌려도 차이가 드러난다.
"""

from __future__ import annotations

import os
import subprocess
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import test_task_activity_facts as facts  # 클래스째 가져오면 그 시험들이 여기서 한 번 더 돈다
from app import db
from app.repo import manage

BACKEND = Path(__file__).resolve().parents[1]
_CHILD = "MVHUB_DUE_TZ_CHILD"


@unittest.skipUnless(os.environ.get(_CHILD), "자식 프로세스에서만 돈다")
class DueDateLocalChild(unittest.TestCase):
    setUp = facts.TaskActivityFactsTests.setUp
    tearDown = facts.TaskActivityFactsTests.tearDown
    fact = facts.TaskActivityFactsTests.fact
    read = facts.TaskActivityFactsTests.read

    def test_due_dates_use_local_today(self):
        today = datetime.now().date()
        if today == datetime.now(timezone.utc).date():
            self.skipTest("방금 날짜 경계를 넘었다 — 부모가 다시 고른다")
        yesterday = (today - timedelta(days=1)).isoformat()
        self.fact(created_at="2025-01-01T00:00:00Z", sort_ts=1735689600)
        tid = self.read(archived=True)[0]["id"]
        manage.update_task(tid, {"due_date": today.isoformat()})
        self.assertEqual(self.read()[0]["archived"], 0, "오늘 마감은 아직 안 지났다")
        manage.update_task(tid, {"due_date": yesterday})
        self.assertEqual(self.read(archived=True)[0]["archived"], 1, "어제 마감은 지났다")
        manage.update_task(tid, {"due_date": None})
        with db.get_connection() as conn:
            conn.execute("INSERT INTO project_planning(project_id,due_date) VALUES('p1',?)", (today.isoformat(),))
        self.assertEqual(self.read()[0]["archived"], 0, "프로젝트 마감이 오늘이면 아직 진행 중")
        with db.get_connection() as conn:
            conn.execute("UPDATE project_planning SET due_date=? WHERE project_id='p1'", (yesterday,))
        self.assertEqual(self.read(archived=True)[0]["archived"], 1, "프로젝트 마감이 어제면 보관")


class DueDateLocalTodayTests(unittest.TestCase):
    def test_archive_due_dates_follow_team_local_date(self):
        node = f"{Path(__file__).name}::DueDateLocalChild::test_due_dates_use_local_today"
        for _ in range(2):
            # UTC 12시 이후엔 UTC+12(지역이 다음 날), 전엔 UTC-12(지역이 전날) — 늘 날짜가 갈린다.
            tz = "AAA-12" if datetime.now(timezone.utc).hour >= 12 else "AAA+12"
            env = {**os.environ, "TZ": tz, "CONTENT_HUB_TZ": tz, _CHILD: "1"}
            out = subprocess.run(
                [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests/" + node],
                capture_output=True, text=True, encoding="utf-8", errors="replace", env=env, cwd=str(BACKEND),
            )
            report = out.stdout + out.stderr
            if "1 skipped" not in report:
                break
        self.assertEqual(out.returncode, 0, report[-3000:])
        self.assertIn("1 passed", report, report[-3000:])


if __name__ == "__main__":
    unittest.main()
