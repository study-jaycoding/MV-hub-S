"""repo 모듈 import 스모크 — trash leaf 의존 전환(구조-05) 회귀 방지.

주의(코덱스 P3): `import app.repo.trash` 도 파이썬 규칙상 facade(__init__)를 먼저
실행하므로, 아래 문장들이 '다른 import 순서'를 실제로 만드는 것은 아니다. 이 테스트가
고정하는 것은 ①facade 어느 진입에서도 import 가 깨지지 않고 ②trash 가 leaf
(manage_telemetry) 심볼을 모듈 시점에 직접 보유한다는 계약이다.
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

    def test_every_entry_point_imports_cleanly(self):
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
