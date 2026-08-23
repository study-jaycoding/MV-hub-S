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

import json
import os
from typing import Any, Optional

from .. import repo

# app_setting 키 — 로컬 허브가 기억하는 공유 서버 연결 정보(이 PC 로컬 DB 에만 저장).
K_URL = "shared_server_url"
# 최근에 쓴 공유 서버 주소 목록(JSON 배열, 최신순). 서버 이사·IP 변경으로 로그인 화면에
# 갇혔을 때 되돌아갈 후보를 보여주는 '탈출구'용 — 주소만 담는다(토큰·이메일 금지).
K_URL_HISTORY = "shared_server_url_history"
URL_HISTORY_MAX = 5
# 이 PC 가 이미 '수락'한 서버 이사 공지 — {"revision": N, "url": "..."} JSON.
# 주소와 번호만 담는다(토큰·이메일 금지 — K_URL 과 같은 수준의 무해한 값).
K_RELOCATION_SEEN = "shared_server_relocation_seen"
# 공유 '서버'의 표시 이름(관리자가 주소와 함께 등록) — 작업자 화면엔 주소 대신 이 이름이 뜬다.
# ★로그인한 '사람'의 표시 이름 키(shared_server_name, publish 소유)와 다른 키다. 그 키는
# db_scrub.SESSION_KEYS 라 로그아웃·백업 정제에서 지워지는데, 서버 이름은 로그아웃한
# 로그인 화면에서야말로 필요하다. 두 값을 한 키에 겹치면 서로를 덮어 쓴다.
K_SERVER_NAME = "shared_server_display_name"
SERVER_NAME_MAX = 64
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


def server_name() -> str:
    """이 PC 가 기억하는 공유 서버 표시 이름(없으면 빈 문자열 — 화면은 주소로 폴백)."""
    return (repo.get_setting(K_SERVER_NAME) or "").strip()


def normalize_server_name(raw: Optional[str]) -> str:
    """표시 이름 정규화 — 앞뒤 공백 제거, 제어문자 제거, 길이 상한. 빈 값은 빈 문자열.

    이름은 알림·로그인 화면 한 줄에 그대로 들어가므로 줄바꿈·제어문자를 남기지 않는다.
    """
    text = (raw or "").strip()
    return "".join(character for character in text if character >= " ")[:SERVER_NAME_MAX].strip()


def relocation_seen() -> dict[str, Any]:
    """이미 수락한 이사 공지 {"revision": int, "url": str}. 없거나 깨졌으면 빈 dict.

    깨진 값을 '수락한 적 없음'으로 읽는 쪽이 안전하다 — 공지를 못 본 척하는 것보다
    한 번 더 제안하는 쪽이 낫다(전환은 어차피 사용자가 확인한다).
    """
    raw = repo.get_setting(K_RELOCATION_SEEN)
    try:
        value = json.loads(raw) if raw else None
    except (ValueError, TypeError):
        return {}
    if not isinstance(value, dict):
        return {}
    revision = value.get("revision")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
        return {}
    url = value.get("url")
    return {"revision": revision, "url": url if isinstance(url, str) else ""}


def set_relocation_seen(revision: int, url: str) -> None:
    repo.set_setting(
        K_RELOCATION_SEEN, json.dumps({"revision": int(revision), "url": url}, ensure_ascii=False)
    )
