"""Resolve 를 바꾸는 자식(가져오기·타임라인·프로젝트 열기·패널 변경)의 문지기 — `python -m app.services.resolve_mutation_guard <모듈>`.

그 자식이 사는 동안 이름 붙은 뮤텍스를 쥔다(소유). 다른 프로세스가 쥐고 있어(다른 변경 자식·라이브러리 연결·선택 작업자의 읽기 한 번)
잠깐 기다려도 못 쥐면 대상 모듈을 **시작하지 않고** MUTATION_BUSY_EXIT 로 끝난다(부모가 '다른 Resolve 작업이 진행 중'으로 답한다).
선택 작업자는 Resolve 를 읽는 동안만 같은 뮤텍스를 쥐므로(resolve_selection_worker), 읽기 도중에는 변경이 시작되지 않고 변경 중에는 읽지 않는다.

왜: 한 허브 안의 변경은 부모의 잠금(resolve_status_runner._RESOLVE_MUTATION_LOCK)이 줄 세우지만, 그 잠금은 허브가 죽으면 사라진다.
변경 자식은 도중에 끊지 않으므로(프로젝트가 반쯤 바뀐 채 남는다) 허브가 죽어도 끝까지 돈다 — 감시기가 다시 띄운 새 허브나
같은 PC 의 다른 설치 허브가 그사이 Resolve 를 바꾸면 두 변경이 겹친다. 뮤텍스는 자식 프로세스가 쥐므로 허브와 무관하게 남고,
자식이 끝나면(어떻게 끝나든) OS 가 거둔다.
"""

from __future__ import annotations

import runpy
import sys

from . import win_job

MUTATION_BUSY_EXIT = 75
_WAIT_SECONDS = 2.0  # 선택 작업자의 읽기 한 번(보통 수 ms)이 끝나기를 기다리는 시간 — 다른 변경이 진행 중이면 이만큼 뒤 '바쁨'
_gate = None  # 프로세스가 끝날 때까지 쥔다 — 끝나면(어떻게 끝나든) OS 가 푼다


def main(argv: list[str] | None = None, *, mutex_name: str | None = None) -> int:
    global _gate
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1:
        return 2
    try:
        gate = win_job.NamedMutex(mutex_name or win_job.RESOLVE_MUTATION_MUTEX)
        if not gate.acquire(_WAIT_SECONDS):
            return MUTATION_BUSY_EXIT
    except OSError as error:
        # 문을 만들거나 판정할 수 없다 — 대상은 시작하지 않았다. 결과 줄 없이 죽으면 부모가 '결과 확인 필요'로 답하므로
        # (대상이 무언가 한 것처럼 보인다) '시작하지 않음, 다시 시도'인 같은 코드로 답한다.
        print(f"Resolve 변경 문을 판정할 수 없습니다: {error}", file=sys.stderr)
        return MUTATION_BUSY_EXIT
    _gate = gate
    sys.argv = [args[0]]
    runpy.run_module(args[0], run_name="__main__", alter_sys=True)  # 대상의 SystemExit(종료 코드)이 그대로 올라간다
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
