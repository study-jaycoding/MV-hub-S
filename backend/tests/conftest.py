"""테스트 공통 설정.

CONTENT_HUB_DB_POOL=0: 테스트에서는 스레드별 커넥션 풀을 끈다.

이유(Windows 플레이크 근본 원인): 풀은 스레드-로컬이라 flush_pool() 이 호출 스레드
것만 닫는다. TestClient 의 sync 핸들러는 anyio 워커 스레드에서 돌며 임시 DB 로의
풀 커넥션을 쥐는데, 클라이언트 종료 시 워커 스레드는 비동기로 죽어 커넥션 해제가
GC 타이밍에 달려 있다. tearDown 의 TemporaryDirectory.cleanup() 이 그보다 먼저
돌면 Windows 파일 잠금(PermissionError)으로 매번 다른 테스트가 무작위 실패했다.
풀을 끄면 요청마다 커넥션을 열고 즉시 닫으므로 정리 시점에 잠금이 남지 않는다.
(운영 동작 무변경 — 풀은 CONTENT_HUB_DB_POOL 기본값 1 로 운영에서 계속 켜져 있다.)
"""

import os
import tempfile
import time

# app.db 가 import 시점에 _POOL_ENABLED 를 읽으므로, 어떤 테스트 모듈보다 먼저
# (conftest 로드 시점에) 환경변수를 심는다. 이미 명시된 값이 있으면 존중한다.
os.environ.setdefault("CONTENT_HUB_DB_POOL", "0")

# TemporaryDirectory 정리에 짧은 재시도를 더한다.
#
# 풀을 꺼도 남는 잔여 플레이크: 임시 폴더 삭제 순간에 백그라운드 스레드의 순간적
# 커넥션이나 Windows Defender/검색 인덱서가 방금 만든 DB 파일을 잠깐 열고 있으면
# rmtree 가 PermissionError / WinError 145(디렉터리가 비어 있지 않음)로 실패한다.
# 일시 잠금은 수백 ms 안에 풀리므로 재시도로 흡수한다. 총 2초를 넘겨도 안 풀리는
# 잠금은 진짜 누수(닫지 않은 핸들)이므로 그대로 실패시켜 은폐하지 않는다.
_orig_td_cleanup = tempfile.TemporaryDirectory.cleanup


def _cleanup_with_retry(self):
    last_exc = None
    for attempt in range(10):
        try:
            _orig_td_cleanup(self)
            return
        except OSError as exc:
            last_exc = exc
            time.sleep(0.2)
    raise last_exc


tempfile.TemporaryDirectory.cleanup = _cleanup_with_retry
