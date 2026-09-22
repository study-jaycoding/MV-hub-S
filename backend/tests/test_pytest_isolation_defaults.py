"""conftest 의 격리 가드.

전체 시험이 실제 `backend/data`(계정 포인터·manage_hub.db·비용 캐시)와 운영 공유 서버에 닿지
않는다는 것을 못 박는다. 부모 셸이 CONTENT_HUB_* 에 실제 값을 넣어 둔 채 돌려도 conftest 가 버린다.
"""

import os
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
POISON_URL = "http://127.0.0.1:9/mvhub-poison"


def test_pytest_is_isolated_from_real_data_and_shared_server():
    from app import config

    assert os.environ.get("CONTENT_HUB_NO_PROXY", "").lower() in ("1", "true", "yes", "on")
    assert os.environ.get("CONTENT_HUB_SHARED_URL") != POISON_URL
    real_data = BACKEND / "data"
    # samefile: 대소문자·8.3 단축 이름·junction 으로 같은 폴더를 가리키는 경우까지 잡는다(DATA_DIR 자신과 그 상위 전부).
    for candidate in (config.DATA_DIR, *config.DATA_DIR.parents):
        assert not (real_data.exists() and candidate.exists() and os.path.samefile(candidate, real_data)), candidate
    assert config.DATA_DIR.name.startswith("mvhub-pytest-data-"), config.DATA_DIR  # conftest 가 만든 임시 폴더
    assert (config.DATA_DIR / "db").is_dir()  # 기본 DB 를 바로 여는 시험이 기대는 레이아웃


def test_parent_env_is_dropped_before_app_import(tmp_path):
    # 부모가 실제 값을 넣어 두고 돌린 실행(Codex P0 2026-09-22) — 새 인터프리터에서 위 가드 하나만 돌린다
    # (파일 전체를 주면 이 시험이 자기를 다시 띄운다). conftest 의 '전부 버리기'를 되돌리면 실패한다.
    poisoned = tmp_path / "poisoned-data"
    poisoned.mkdir()
    env = {
        **os.environ,
        "CONTENT_HUB_DATA": str(poisoned),
        "CONTENT_HUB_NO_PROXY": "0",
        "CONTENT_HUB_SHARED_URL": POISON_URL,
        "PYTHONIOENCODING": "utf-8",
    }
    node = "tests/test_pytest_isolation_defaults.py::test_pytest_is_isolated_from_real_data_and_shared_server"
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", node],
        cwd=BACKEND, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180,
    )
    assert result.returncode == 0, result.stdout[-3000:] + result.stderr[-3000:]
    assert not any(poisoned.iterdir())  # 오염된 폴더에는 아무것도 만들지 않았다
