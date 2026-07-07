"""Higgsfield CLI 계약 스모크 테스트 — CLI 범프 후 1회 돌려 드리프트를 즉시 잡는다.

배경: CLI 0.x→1.x 에서 필드/플래그가 조용히 바뀌어(예: job_set_type→job_type,
created_at epoch→ISO, transactions list→{items}, seedance medias 제거) 우리 코드가
소리 없이 깨졌다. 이 스크립트는 '생성 없이(무료)' 실제 CLI 출력의 계약을 검증한다.

쓰는 법:
  1) hf_cli_version.txt 를 새 버전으로 올린다.
  2) 로그인 + workspace set 된 PC 에서:  python tools/hf_cli_contract_smoke.py
  3) FAIL 이 있으면 어느 계약이 깨졌는지 보고 코드(주로 cli_bridge.parse_job /
     list_models, agent_push)의 해당 매핑을 고친 뒤 다시 돌린다.
  4) 통과하면 hf_cli_version.txt 범프를 커밋/릴리스.

주의: 생성(generate create)은 유료라 여기서 하지 않는다. Seedance --medias 경로는
      별도 유료 실측이 필요(이 스크립트는 medias 제거만 경고).
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PIN_FILE = ROOT / "hf_cli_version.txt"

PASS, WARN, FAIL = "PASS", "WARN", "FAIL"
results: list[tuple[str, str, str]] = []  # (status, check, detail)


def record(status: str, check: str, detail: str = "") -> None:
    results.append((status, check, detail))


def cli_path() -> str | None:
    return shutil.which("higgsfield") or shutil.which("higgsfield.cmd") or shutil.which("hf")


def run_json(cli: str, *args: str):
    """CLI 를 --json 으로 실행하고 (파싱값, 에러문구) 반환."""
    try:
        out = subprocess.run([cli, *args, "--json"], capture_output=True, text=True, timeout=90)
    except Exception as e:  # noqa: BLE001
        return None, f"실행 실패: {e}"
    if out.returncode != 0:
        return None, (out.stderr or out.stdout or "").strip()[:200]
    try:
        return json.loads(out.stdout), None
    except json.JSONDecodeError:
        return None, f"JSON 아님: {out.stdout[:120]}"


def run_text(cli: str, *args: str) -> str:
    try:
        out = subprocess.run([cli, *args], capture_output=True, text=True, timeout=60)
        return (out.stdout or "") + (out.stderr or "")
    except Exception:  # noqa: BLE001
        return ""


def _first(data):
    if isinstance(data, list):
        return data[0] if data else None
    if isinstance(data, dict):  # {items:[...]} 래퍼 대응
        items = data.get("items")
        if isinstance(items, list) and items:
            return items[0]
    return None


def main() -> int:
    cli = cli_path()
    if not cli:
        print("[중단] higgsfield CLI 를 PATH 에서 못 찾음. 설치/PATH 확인 후 다시.")
        return 2

    pin = PIN_FILE.read_text("utf-8").strip().splitlines()[0].strip() if PIN_FILE.exists() else ""

    # 1) 버전 == pin
    ver_txt = run_text(cli, "version")
    if pin and pin in ver_txt:
        record(PASS, "version == pin", f"pin={pin}")
    else:
        record(FAIL, "version == pin", f"pin={pin!r} but `version`={ver_txt.strip()[:60]!r}")

    # 2) model list — 모델선택/거래태깅이 여기 필드에 의존
    ml, err = run_json(cli, "model", "list")
    if err or not isinstance(ml, list) or not ml:
        record(FAIL, "model list = 비어있지 않은 JSON 배열", err or f"type={type(ml).__name__}")
    else:
        m0 = ml[0]
        has_key = ("job_type" in m0) or ("job_set_type" in m0)  # 코드가 or 폴백으로 읽음
        record(PASS if has_key else FAIL, "model list 항목에 job_type|job_set_type",
               f"키={list(m0)} (1.x=job_type)")
        record(PASS if "display_name" in m0 else FAIL, "model list 항목에 display_name", f"키={list(m0)}")

    # 3) model get — _allowed_params / get_model_params 가 params[].name, job_set_type 의존
    mg, err = run_json(cli, "model", "get", "nano_banana_flash")
    if err or not isinstance(mg, dict):
        record(FAIL, "model get nano_banana_flash = JSON dict", err or f"type={type(mg).__name__}")
    else:
        params = mg.get("params") or []
        names = [p.get("name") for p in params if isinstance(p, dict)]
        record(PASS if names else FAIL, "model get: params[].name 존재", f"params={names}")
        # model get 은 1.x 에서도 job_set_type 유지(불일치 주의)
        record(PASS if mg.get("job_set_type") else WARN, "model get: job_set_type 유지",
               f"job_set_type={mg.get('job_set_type')!r} job_type={mg.get('job_type')!r}")

    # 4) account status — email/credits (auth+workspace 필요)
    ac, err = run_json(cli, "account", "status")
    if err or not isinstance(ac, dict):
        record(WARN, "account status = JSON dict", (err or "") + " (로그인+workspace 필요할 수 있음)")
    else:
        record(PASS if ac.get("email") else FAIL, "account status: email", f"키={list(ac)}")
        record(PASS if ("credits" in ac or "credits_exact" in ac) else FAIL,
               "account status: credits", f"키={list(ac)}")

    # 5) account transactions — PM 실제크레딧. 1.x = {cursor, items}, 0.x = list
    tx, err = run_json(cli, "account", "transactions", "--size", "1")
    if err:
        record(WARN, "account transactions 조회", err)
    elif isinstance(tx, dict) and isinstance(tx.get("items"), list):
        record(PASS, "account transactions = {items} 래퍼(1.x)", "agent_push 가 items 추출함")
    elif isinstance(tx, list):
        record(PASS, "account transactions = bare list(0.x)", "")
    else:
        record(FAIL, "account transactions 형태", f"type={type(tx).__name__} keys={list(tx) if isinstance(tx, dict) else ''}")

    # 6) workspace list — id / is_selected
    ws, err = run_json(cli, "workspace", "list")
    w0 = _first(ws)
    if err or not isinstance(w0, dict):
        record(WARN, "workspace list = JSON 배열", err or f"type={type(ws).__name__}")
    else:
        record(PASS if "id" in w0 else FAIL, "workspace list: id", f"키={list(w0)}")

    # 7) generate list — 코드(cli_bridge.list_jobs, agent_push)는 bare list 만 받고,
    #    parse_job 은 result_url(asset·creator uid 추출)을 이 키로만 읽는다.
    #    스모크는 코드보다 관대하면 안 된다(통과해도 코드가 깨지는 오탐 방지) → 코드와 동일하게 엄격.
    gl, err = run_json(cli, "generate", "list", "--size", "1")
    if err or gl is None:
        record(WARN, "generate list 조회", err or "None")
    else:
        record(PASS if isinstance(gl, list) else FAIL,
               "generate list = bare JSON 배열", f"type={type(gl).__name__} (코드가 list 만 받음; {{items}} 래퍼면 코드 깨짐)")
        g0 = gl[0] if isinstance(gl, list) and gl else None
        if g0 is None:
            record(WARN, "generate list 비어있음", "생성 이력이 없어 항목 필드 검증 스킵")
        else:
            for f in ("id", "status", "params", "created_at"):
                record(PASS if f in g0 else FAIL, f"generate list 항목에 {f}", f"키={list(g0)}")
            record(PASS if (("job_type" in g0) or ("job_set_type" in g0)) else FAIL,
                   "generate list 항목에 job_type|job_set_type", f"키={list(g0)}")
            record(PASS if g0.get("result_url") else FAIL,
                   "generate list 항목에 result_url", f"result_url={bool(g0.get('result_url'))} min_result_url={bool(g0.get('min_result_url'))} (코드가 result_url 로만 asset·uid 추출)")
            # result_url 에서 user_ uid 를 뽑는다(_dominant_uid). 패턴 유지 확인.
            ru = g0.get("result_url") or ""
            record(PASS if "user_" in ru else WARN, "result_url 에 user_<id> 패턴",
                   "creator uid 추출용" if "user_" in ru else f"패턴 없음 → creator 연결 확인 필요: {ru[:60]}")
            # created_at 이 우리 파서(_to_epoch)로 해석되는지 — ISO/epoch 둘 다여야
            try:
                sys.path.insert(0, str(ROOT / "backend"))
                from app.services.cli_bridge import _to_epoch  # type: ignore
                ep = _to_epoch(g0.get("created_at"))
                record(PASS if ep else FAIL, "created_at → epoch 파싱(_to_epoch)",
                       f"created_at={g0.get('created_at')!r} → {ep}")
            except Exception as e:  # noqa: BLE001
                record(WARN, "created_at 파싱 검사", f"cli_bridge import 실패: {e}")

    # 7b) account transactions item 필드 — PM 매칭(_match_transactions)이 의존
    tx_item = _first(tx)
    if isinstance(tx_item, dict):
        for f in ("created_at", "credits"):
            record(PASS if f in tx_item else WARN, f"transactions item 에 {f}", f"키={list(tx_item)}")

    # 7c) workspace item 필드 — UI/PM 이 is_selected/credits/plan_type 사용
    if isinstance(w0, dict):
        for f in ("is_selected", "credits", "plan_type"):
            record(PASS if f in w0 else WARN, f"workspace item 에 {f}", f"키={list(w0)}")

    # 7d) generate cost — estimate_cost 가 credits_exact|credits 숫자 의존(무료 견적)
    gc, err = run_json(cli, "generate", "cost", "nano_banana_flash", "--prompt", "smoke test")
    if err or not isinstance(gc, dict):
        record(WARN, "generate cost = JSON dict", err or f"type={type(gc).__name__}")
    else:
        record(PASS if ("credits_exact" in gc or "credits" in gc) else FAIL,
               "generate cost 에 credits_exact|credits", f"키={list(gc)}")

    # 8) Seedance media 계약 — 1.x 는 medias 제거, 역할별 image_references 사용.
    #    agent_push 는 upload id 를 --image-references(반복)로 넘긴다(재작성 완료). 스키마로 확인.
    sd, err = run_json(cli, "model", "get", "seedance_2_0")
    if not err and isinstance(sd, dict):
        names = [p.get("name") for p in (sd.get("params") or []) if isinstance(p, dict)]
        record(PASS if "image_references" in names else FAIL,
               "seedance: image_references param 존재", f"agent_push 가 --image-references 사용; params={names}")
        if "medias" in names:
            record(WARN, "seedance: medias param 재등장?", "코드는 references 로 전환됨 — medias 부활 시 재검토")

    # 9) generate create --help — 코드(agent_push _role_flag)가 쓰는 media flag 전부 존재?
    help_txt = run_text(cli, "generate", "create", "--help")
    for flag in ("--image", "--video", "--audio", "--start-image", "--end-image",
                 "--image-references", "--video-references", "--audio-references"):
        record(PASS if flag in help_txt else FAIL, f"generate create: {flag} 존재",
               "" if flag in help_txt else "agent_push 가 쓰는 미디어 플래그 — 사라지면 참조 전달 실패")

    # ── 리포트 ──
    order = {FAIL: 0, WARN: 1, PASS: 2}
    results.sort(key=lambda r: order[r[0]])
    print("\n=== Higgsfield CLI 계약 스모크 결과 ===")
    for status, check, detail in results:
        print(f"  [{status}] {check}" + (f"  — {detail}" if detail else ""))
    n_fail = sum(1 for r in results if r[0] == FAIL)
    n_warn = sum(1 for r in results if r[0] == WARN)
    print(f"\n합계: FAIL={n_fail}  WARN={n_warn}  PASS={sum(1 for r in results if r[0]==PASS)}")
    if n_fail:
        print("→ FAIL 이 있다. CLI 계약이 깨졌다. cli_bridge/agent_push 의 해당 매핑을 고쳐라.")
    elif n_warn:
        print("→ FAIL 없음. WARN 은 확인 권장(특히 seedance medias, 로그인/workspace 필요 항목).")
    else:
        print("→ 전부 통과. 이 CLI 버전으로 pin 범프해도 안전.")
    return 1 if n_fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
