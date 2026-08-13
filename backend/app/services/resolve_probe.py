"""시간 제한이 가능한 DaVinci Resolve 연결 상태 검사 프로세스.

Resolve 공식 모듈의 ``scriptapp`` 호출 자체가 멈추는 경우 일반 스레드는 안전하게
중단할 수 없다. 상태 확인만 별도 프로세스에서 실행하면 Media Pool을 변경하지 않으면서
정해진 시간 뒤 검사 프로세스만 종료할 수 있다.
"""

from __future__ import annotations

import json

from .resolve_bridge import resolve_connection_status


RESULT_PREFIX = "MVHUB_RESOLVE_STATUS="


def main() -> None:
    result = resolve_connection_status()
    print(RESULT_PREFIX + json.dumps(result, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
