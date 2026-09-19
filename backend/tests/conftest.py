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

import atexit
import os
import shutil
import sys
import tempfile
import time

# app.db 가 import 시점에 _POOL_ENABLED 를 읽으므로, 어떤 테스트 모듈보다 먼저
# (conftest 로드 시점에) 환경변수를 심는다. 이미 명시된 값이 있으면 존중한다.
os.environ.setdefault("CONTENT_HUB_DB_POOL", "0")

# 격리 기본값 — 변수를 빠뜨린 실행이 실제 데이터·운영 공유 서버에 닿지 않게 한다(2026-09-19).
#
# 종전에는 "돌리는 쪽이 CONTENT_HUB_NO_PROXY=1 을 넣는다"가 규칙이었는데, 사람도 에이전트도
# predeploy_gate.ps1 도 빠뜨릴 수 있었다. 게다가 CONTENT_HUB_DB 만 임시로 돌리는 시험이 많아
# DATA_DIR 파생 경로(active.json 계정 포인터·manage_hub.db·cost_cache_v2.json·device_identity.json)
# 는 실제 backend/data 를 봤다 — 계정 포인터와 그 계정 DB 의 실제 토큰이 있으면 proxying() 이
# 성립해 시험 요청이 운영 서버로 중계된다. config 가 import 시점에 경로를 굳히므로 여기서 심는다.
# ★보장 범위는 pytest 수집 경로뿐이다 — conftest 보다 먼저 app 을 import 하는 외부 플러그인(-p)과
#  직접 실행하는 도구(tools/*.py, tests/*_mutation_check.py)는 각자 env 를 고정한다.
# 비어 있지 않은 명시값은 존중한다(프록시 모드를 시험하는 곳은 스스로 "0" 을 넣는다). ★빈 문자열은 기본값으로
# 바꾼다 — setdefault 는 "" 를 '있음'으로 보는데, 빈 NO_PROXY 는 위임 허용이고 빈 DATA 는 현재 폴더(backend)다.
# pytest-xdist 는 쓰지 않는 전제다(워커들이 이 임시 DATA 하나를 물려받아 공유한다 — 종전의 실제 폴더 공유와 같다).
if not os.environ.get("CONTENT_HUB_NO_PROXY"):
    os.environ["CONTENT_HUB_NO_PROXY"] = "1"

if not os.environ.get("CONTENT_HUB_DATA"):
    _data_root = tempfile.mkdtemp(prefix="mvhub-pytest-data-")
    os.environ["CONTENT_HUB_DATA"] = _data_root

    def _remove_data_root():
        # 아래 TemporaryDirectory 정리와 같은 재시도 정책. 끝내 못 지우면 경고만 남기고
        # 시험 결과는 바꾸지 않는다(임시 폴더 잔존은 시험 실패가 아니다).
        for _attempt in range(10):
            try:
                shutil.rmtree(_data_root)
                return
            except FileNotFoundError:
                return
            except OSError:
                time.sleep(0.2)
        # ASCII 로만 쓴다 - 종료 시점의 stderr 인코딩을 믿지 않는다(cp949 콘솔·파일 리다이렉트).
        print(f"[conftest] could not remove temp data dir: {_data_root!r}", file=sys.stderr)

    atexit.register(_remove_data_root)

# 실제 레이아웃처럼 db/ 를 미리 둔다 — 기본 DB 를 바로 여는 시험(test_generation_media_cache)이 폴더 부재로 깨지지 않게.
os.makedirs(os.path.join(os.environ["CONTENT_HUB_DATA"], "db"), exist_ok=True)

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
