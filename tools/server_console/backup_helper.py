"""서버 루트의 백업 복사기(tools/backup_replicate.py)를 대신 부르는 짧은 도우미 자식.

python -I -B backup_helper.py <설치 루트> status | probe <위치> | selfcheck
관리 창·실행기는 그 모듈을 직접 가져오지 않는다 — 가져오면 루트 tools·backend 를 경로 맨 앞에 넣는다(2단계 설계 3판 (6)).
위치 판정·지문·위치 확인은 예약 작업(SYSTEM)이 쓰는 바로 그 코드로 한다. 결과는 JSON 한 줄(status) 또는 종료 코드(probe).
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


def load(root: Path):
    spec = importlib.util.spec_from_file_location("mvhub_backup_replicate", root / "tools" / "backup_replicate.py")
    if spec is None or spec.loader is None:
        raise ImportError("backup_replicate")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def status(mod) -> dict:
    target, source = mod.configured_target()
    try:
        result = json.loads(Path(mod.STATUS_FILE).read_text("utf-8"))
        if not isinstance(result, dict) or result.get("format") != "mvhub-backup-replica-status":
            result = {"state": "state_unavailable"}
    except FileNotFoundError:
        result = {"state": "never_run"}
    except (OSError, ValueError):
        result = {"state": "state_unavailable"}
    return {"target": target, "source": source, "target_id": mod.target_id(target) if target else None,
            "unc_error": mod.unc_format_error(target) if target else None, "result": result}


NEEDS = {"configured_target": (0, ()), "target_id": (1, ()), "unc_format_error": (1, ()), "probe": (1, ()),
         "STATUS_FILE": "value"}  # 관리 창이 부르는 복사기 모양 — 관리 도구 갱신의 시작 점검(selfcheck, release_helper.NEEDS 와 같은 꼴)


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        return 64
    mod = load(Path(argv[1]))
    if argv[2] == "selfcheck" and len(argv) == 3:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from release_helper import missing_parts  # 같은 판의 검사 함수(루트 모듈은 가져오지 않는다)
        missing = missing_parts({"backup_replicate": mod}, {"backup_replicate": NEEDS})
        print(json.dumps({"ok": not missing, "missing": missing}))
        return 0
    if argv[2] == "status" and len(argv) == 3:
        print(json.dumps(status(mod)))  # ASCII 만 — 콘솔 코드 페이지와 상관없이 읽히게
        return 0
    if argv[2] == "probe" and len(argv) == 4:
        return mod.probe(argv[3])
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv))
