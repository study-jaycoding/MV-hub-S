"""conftest 의 격리 기본값 가드.

전체 시험이 실제 `backend/data`(계정 포인터·manage_hub.db·비용 캐시)와 운영 공유 서버에 닿지
않는다는 것을 못 박는다. 명시값으로 실제 폴더를 지정한 실행도 여기서 실패하는 것이 맞다.
"""

import os
from pathlib import Path


def test_pytest_is_isolated_from_real_data_and_shared_server():
    from app import config

    assert os.environ.get("CONTENT_HUB_NO_PROXY", "").lower() in ("1", "true", "yes", "on")
    real_data = Path(__file__).resolve().parents[1] / "data"
    # samefile: 대소문자·8.3 단축 이름·junction 으로 같은 폴더를 가리키는 경우까지 잡는다(DATA_DIR 자신과 그 상위 전부).
    for candidate in (config.DATA_DIR, *config.DATA_DIR.parents):
        assert not (real_data.exists() and candidate.exists() and os.path.samefile(candidate, real_data)), candidate
    assert (config.DATA_DIR / "db").is_dir()  # 기본 DB 를 바로 여는 시험이 기대는 레이아웃
