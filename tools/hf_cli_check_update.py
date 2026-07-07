"""힉스필드 CLI 선제 업데이트 체크 — 새 버전이 있는지 + 문서 변경 예고편을 미리 본다.

배경: `higgsfield-ai/cli` GitHub 의 릴리스 노트 본문은 비어 있어(확인됨) 쓸모없다.
하지만 버전 태그별 `MODELS.md`(모델·파라미터 스키마)·`README.md`(명령/플래그)는 상세하다.
우리 pin ↔ 최신 을 diff 하면 param·플래그·모델 변경을 '설치 전에' 예고편으로 확인할 수 있다
(예: seedance 의 medias → image_references 변화가 diff 에 잡힌다).

한계: 출력 JSON 형식 변경(job_set_type→job_type, created_at ISO, transactions {items})은
문서에 안 나온다 → 실제 확정은 tools/hf_cli_contract_smoke.py (설치 후 실측)로 한다.

사용:  python tools/hf_cli_check_update.py
"""
from __future__ import annotations

import difflib
import shutil
import subprocess
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PIN_FILE = ROOT / "hf_cli_version.txt"
REPO = "higgsfield-ai/cli"
DOCS = ["MODELS.md", "README.md"]
MAX_DIFF_LINES = 250  # 노이즈 방지: 이보다 길면 잘라서 표시


def latest_version() -> str | None:
    npm = shutil.which("npm") or shutil.which("npm.cmd")
    if not npm:
        return None
    try:
        out = subprocess.run([npm, "view", "@higgsfield/cli", "version"],
                             capture_output=True, text=True, timeout=90)
        v = (out.stdout or "").strip()
        return v or None
    except Exception:  # noqa: BLE001
        return None


def fetch_doc(tag: str, name: str) -> str | None:
    url = f"https://raw.githubusercontent.com/{REPO}/{tag}/{name}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return r.read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        return None


def main() -> int:
    pin = PIN_FILE.read_text("utf-8").strip().splitlines()[0].strip() if PIN_FILE.exists() else ""
    if not pin:
        print("[중단] hf_cli_version.txt 를 못 읽음.")
        return 2
    print(f"현재 pin = {pin}")

    latest = latest_version()
    if not latest:
        print("[경고] 최신 버전 조회 실패(npm/네트워크 확인). 문서 diff 스킵.")
        return 1
    print(f"npm 최신 = {latest}")

    if latest == pin:
        print("\n→ 이미 최신 버전. 준비할 것 없음.")
        return 0

    print(f"\n{'='*60}\n★ 새 버전 있음: {pin} → {latest}")
    print("아래는 '문서' 변경 예고편(param/플래그/모델). 출력형식 변경은 여기 안 나오니")
    print("설치 후 반드시 tools/hf_cli_contract_smoke.py 로 확정하라.\n" + "=" * 60)

    for name in DOCS:
        old = fetch_doc(f"v{pin}", name)
        new = fetch_doc(f"v{latest}", name)
        if old is None or new is None:
            print(f"\n=== {name}: 조회 실패(태그 v{pin} / v{latest} 존재 확인) ===")
            continue
        diff = list(difflib.unified_diff(
            old.splitlines(), new.splitlines(),
            fromfile=f"{name}@{pin}", tofile=f"{name}@{latest}", lineterm=""))
        if not diff:
            print(f"\n=== {name}: 변경 없음 ===")
            continue
        print(f"\n=== {name} diff (v{pin} → v{latest}) ===")
        for ln in diff[:MAX_DIFF_LINES]:
            print(ln)
        if len(diff) > MAX_DIFF_LINES:
            print(f"... ({len(diff) - MAX_DIFF_LINES}줄 더 — 전체는 "
                  f"https://github.com/{REPO}/compare/v{pin}...v{latest} 에서)")

    print("\n" + "=" * 60)
    print("다음 단계 (docs/HF_CLI_UPGRADE.md 절차):")
    print(f"  1) npm install -g @higgsfield/cli@{latest}")
    print("  2) python tools/hf_cli_contract_smoke.py   # 출력형식 변경까지 확정")
    print(f"  3) 통과하면 hf_cli_version.txt 를 {latest} 로 올리고 커밋 → 릴리스")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
