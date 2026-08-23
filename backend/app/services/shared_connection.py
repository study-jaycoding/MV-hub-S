"""공유 서버 연결 정보(설정 키·기본 주소·조회 함수)의 단일 출처.

_proxy(프록시 호출)·publish(로그인/발행)·worker_backup(백업 업로드)이 같은
키·기본 주소·후행 슬래시 규칙을 제각각 정의하다 드리프트하는 것을 막는다.
라우터에 의존하지 않는 leaf 모듈 — repo 설정만 읽는다.

계약:
- 기본 주소는 **import 시점**의 CONTENT_HUB_SHARED_URL 환경변수로 확정된다
  (프로세스 수명 동안 고정 — 런타임 env 변경은 반영하지 않는다).
- base_url()·token()·elevation_token()은 **호출 시점**의 활성 계정 DB 설정을
  읽는다(로그인·계정 전환이 즉시 반영).
- base_url()은 항상 후행 슬래시를 제거해 반환한다. 빈 문자열 설정은 기본
  주소로 폴백한다(공백만 있는 설정 문자열은 종전대로 그대로 쓴다).
"""

from __future__ import annotations

import os
from typing import Optional

from .. import repo

# app_setting 키 — 로컬 허브가 기억하는 공유 서버 연결 정보(이 PC 로컬 DB 에만 저장).
K_URL = "shared_server_url"
# 최근에 쓴 공유 서버 주소 목록(JSON 배열, 최신순). 서버 이사·IP 변경으로 로그인 화면에
# 갇혔을 때 되돌아갈 후보를 보여주는 '탈출구'용 — 주소만 담는다(토큰·이메일 금지).
K_URL_HISTORY = "shared_server_url_history"
URL_HISTORY_MAX = 5
K_TOKEN = "shared_server_token"
# 임시 관리자 권한 토큰(계정관리 호출에만) — 로그아웃·계정전환 시 해제.
K_ELEV_TOKEN = "shared_server_elev_token"

# 팀이 한 번 정해 배포하는 기본 주소(env 로 덮어쓰기).
DEFAULT_SHARED_URL = (
    os.environ.get("CONTENT_HUB_SHARED_URL") or "http://192.168.1.199:8010"
).rstrip("/")


def base_url() -> str:
    return (repo.get_setting(K_URL) or DEFAULT_SHARED_URL).rstrip("/")


def token() -> Optional[str]:
    return repo.get_setting(K_TOKEN)


def elevation_token() -> Optional[str]:
    return repo.get_setting(K_ELEV_TOKEN)
