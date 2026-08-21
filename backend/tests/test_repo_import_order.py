"""repo 모듈 import 순서 안전성 스모크 — trash leaf 의존 전환(구조-05) 회귀 방지.

trash 가 전체 manage facade 를 지연 import 하던 시절엔 import 순서가 바뀌면
텔레메트리 표식이 조용히 빠질 수 있었다. leaf(manage_telemetry) 직접 의존으로
바꾼 뒤, 새 프로세스에서 여러 진입 순서로 import 가 깨지지 않는지 고정한다.
"""

from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path


_BACKEND_DIR = Path(__file__).resolve().parents[1]


def _import_in_fresh_process(statement: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-c", statement],
        cwd=_BACKEND_DIR,
        capture_output=True,
        text=True,
        timeout=60,
    )


class RepoImportOrderTests(unittest.TestCase):
    def test_trash_imports_standalone_before_facade(self):
        completed = _import_in_fresh_process(
            "import app.repo.trash; "
            "assert app.repo.trash.mark_telemetry_tombstone; "
            "assert app.repo.trash.mark_telemetry_dirty"
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_facade_then_trash_and_reverse_orders_agree(self):
        for statement in (
            "from app import repo; import app.repo.trash",
            "import app.repo.trash; from app import repo; "
            "assert repo.delete_generation and repo.restore_generation",  # facade 공개 계약 유지
            "import app.repo.manage_telemetry; import app.repo.trash; from app import repo",
        ):
            completed = _import_in_fresh_process(statement)
            self.assertEqual(completed.returncode, 0, f"{statement!r}: {completed.stderr}")


if __name__ == "__main__":
    unittest.main()
