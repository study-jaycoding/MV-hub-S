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

# 격리 — 부모(셸·배포 게이트·도구)가 넘긴 CONTENT_HUB_* 는 **전부 버리고** 시험용 값만 다시 짠다.
# config·app.db 가 import 시점에 값을 굳히므로 어떤 테스트 모듈보다 먼저(conftest 로드 시점에) 한다.
#
# 2026-09-19 에는 "비어 있을 때만 기본값, 명시값은 존중"이었다. 그런데 경로·주소를 담는 변수가 DATA 말고도 많아
# (DB·MEDIA·ASSETS_DIR·BACKUP_DIR·MANAGE·SHARED_URL·WORKER_BACKUP_* …) 셸에 실제 값이 하나라도 남아 있으면
# 시험이 실제 데이터·운영 공유 서버에 닿을 수 있었다 — 실제 폴더 가드(test_pytest_isolation_defaults)는 일반
# 시험이라 수집·초기화보다 늦다(Codex P0, 2026-09-22). DATA 를 실제 backend/data 로 두면 DATA_DIR 파생 경로
# (active.json 계정 포인터·manage_hub.db·cost_cache_v2.json·device_identity.json)의 실제 토큰으로 proxying()
# 이 성립해 시험 요청이 운영 서버로 중계된다. 이름은 대소문자를 가리지 않는다(Windows env).
# 시험 안의 monkeypatch·patch.dict 는 이 뒤라 영향이 없다(프록시 모드를 시험하는 곳은 스스로 "0" 을 넣는다).
# ★보장 범위는 pytest 수집 경로뿐이다 — conftest 보다 먼저 app 을 import 하는 외부 플러그인(-p)과
#  직접 실행하는 도구(tools/*.py, tests/*_mutation_check.py)는 각자 env 를 고정한다.
# ponytail: 바깥 env 를 일부러 쓰는 탈출구는 없다 — 쓰는 시험이 생기면 그 시험 안에서 넣는다.
# pytest-xdist 는 쓰지 않는 전제다(워커들이 이 임시 DATA 하나를 물려받아 공유한다 — 종전의 실제 폴더 공유와 같다).
for _key in [k for k in os.environ if k.upper().startswith("CONTENT_HUB_")]:
    del os.environ[_key]

_data_root = tempfile.mkdtemp(prefix="mvhub-pytest-data-")
os.environ.update({
    "CONTENT_HUB_DB_POOL": "0",  # 맨 위 독스트링의 '스레드별 커넥션 풀' 설명
    "CONTENT_HUB_NO_PROXY": "1",
    "CONTENT_HUB_DATA": _data_root,
    "CONTENT_HUB_EXTERNAL_RECOVERY": "0",  # 기본 "1" 이면 앱 기동이 CLI 신원 캡처 등 바깥 동작을 시도한다
})


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
