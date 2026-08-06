"""팀원 계정 일괄 가입+승인 — 운영 공유 서버에 관리자 권한으로 실행한다.

사용법(PowerShell):
    python tools\bulk_register_accounts.py
    (관리자 이메일/비밀번호를 물어본다 — 비밀번호는 화면에 안 보임)

동작: 각 (닉네임, 이메일)을 ①register(이미 있으면 건너뜀) ②approved 승인.
비밀번호는 공통 초기값. 결과를 표로 출력하며, 실패해도 나머지는 계속 진행한다.
"""

from __future__ import annotations

import getpass
import json
import sys
import urllib.error
import urllib.request

SERVER = "http://192.168.1.199:8010"
INITIAL_PASSWORD = "111111"

MEMBERS: list[tuple[str, str]] = [
    ("샤아", "abw@millionvolt.com"),
    ("워니", "mulgogi777@millionvolt.com"),
    ("미로링", "mrj96@millionvolt.com"),
    ("젤다", "karzastral@gmail.com"),
    ("마코", "akttkfn@millionvolt.com"),
    ("무지", "tykim0125@gmail.com"),
    ("우루사", "junginwuk@millionvolt.com"),
    ("히또", "ydfoxading@gmail.com"),
    ("베리", "dlrudtn8217@gmail.com"),
    ("쩜윤", "j.uni@millionvolt.com"),
    ("다다", "iamdaby@millionvolt.com"),
    ("감튀", "hshovo@millionvolt.com"),
    ("체코", "crlee@millionvolt.com"),
    ("담담", "dam_dameun@millionvolt.com"),
]


def call(method: str, path: str, body: dict | None = None, token: str | None = None):
    req = urllib.request.Request(f"{SERVER}{path}", method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data=data, timeout=15) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read().decode()).get("detail", "")
        except Exception:  # noqa: BLE001
            detail = ""
        return e.code, {"detail": detail}


def main() -> int:
    print(f"서버: {SERVER}")
    admin_email = input("관리자 이메일: ").strip()
    admin_password = getpass.getpass("관리자 비밀번호(화면에 안 보임): ")
    status, res = call("POST", "/api/auth/login", {"email": admin_email, "password": admin_password})
    if status != 200 or not res.get("token"):
        print(f"관리자 로그인 실패({status}): {res.get('detail', '')}")
        return 1
    token = res["token"]
    print("관리자 로그인 성공. 계정 생성을 시작합니다.\n")

    rows = []
    for name, email in MEMBERS:
        status, res = call(
            "POST", "/api/auth/register",
            {"email": email, "password": INITIAL_PASSWORD, "name": name},
        )
        if status == 200:
            created = "생성"
        elif status == 400 and "이미" in str(res.get("detail", "")):
            created = "이미 있음"
        else:
            rows.append((name, email, f"가입 실패({status}): {res.get('detail', '')}"))
            continue
        # 승인 — 이미 approved 여도 멱등.
        status, res = call(
            "PATCH", f"/api/auth/accounts/{email}/status",
            {"status": "approved"}, token=token,
        )
        approved = "승인 완료" if status == 200 else f"승인 실패({status}): {res.get('detail', '')}"
        rows.append((name, email, f"{created} → {approved}"))

    print(f"{'닉네임':<8}{'이메일':<32}결과")
    print("-" * 70)
    for name, email, result in rows:
        print(f"{name:<8}{email:<32}{result}")
    print(f"\n총 {len(MEMBERS)}명 처리. 초기 비밀번호는 공통 {INITIAL_PASSWORD!r} — 각자 로그인 후 변경을 권장하세요.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
