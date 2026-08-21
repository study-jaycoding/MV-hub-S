"""크래시 격리가 가능한 DaVinci Resolve 가져오기 작업 프로세스.

fusionscript(C 확장)는 Resolve 버전과 파이썬 버전이 비호환이면 예외 없이
프로세스를 즉시 죽일 수 있다(0xC0000005). Media Pool 가져오기를 백엔드와
분리된 프로세스에서 실행해 서버가 함께 죽지 않게 하고, PC별로 호환되는
파이썬 인터프리터를 골라 실행할 수 있게 한다. 표준입력으로 manifest JSON을
받아 결과 JSON 한 줄을 표준출력으로 돌려준다.
"""

from __future__ import annotations

import json
import sys

from .resolve_bridge import import_manifest_to_current_project


RESULT_PREFIX = "MVHUB_RESOLVE_IMPORT="


def main() -> None:
    manifest = json.load(sys.stdin)
    # import_manifest_to_current_project 는 내부 예외를 unavailable 결과로 바꿔
    # 항상 dict 를 돌려준다. 프로세스가 죽는 경우만 부모가 종료 코드로 감지한다.
    result = import_manifest_to_current_project(manifest)
    print(RESULT_PREFIX + json.dumps(result, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
