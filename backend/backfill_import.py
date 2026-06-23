"""과거 전체 백필 import — 독립 실행 도구 (허브 본체와 분리).

허브 본체는 '생성 시 누적' + '최신 100 주기동기화'만 한다(CLI 100개 상한·페이지네이션 불가).
100개 밖으로 밀린 과거 이력 전체는 이 도구로 따로 채운다.

흐름(역할 분리):
  1) 에이전트(Claude)가 MCP `show_generations` 를 next_cursor 로 끝까지 페이지네이션 →
     각 페이지를 JSON 파일로 덤프(원시 MCP 아이템 그대로 저장하면 됨).
  2) 이 스크립트를 돌려 그 JSON 들을 DB 에 멱등 import(uuid 앵커, 재실행해도 중복 0).

왜 스크립트가 직접 안 끌어오나: MCP 는 에이전트 전용이라 독립 프로세스가 호출 불가.
토큰으로 HTTP API 를 직접 치는 길도 있으나(사용자가 무토큰 경로 선택) 여기선 안 쓴다.

매핑은 주기동기화와 동일한 cli_bridge.parse_job → repo.upsert_synced_generation 을
재사용한다(같은 잡이면 동기화본과 한 치도 안 어긋나게 멱등 병합). 단 MCP 아이템은 필드명이
달라(model/results.rawUrl/createdAt) CLI list 형태로 먼저 변환한다.

사용:
    cd backend
    python backfill_import.py page1.json page2.json ...      # 여러 파일
    python backfill_import.py dumps/*.json                    # 글롭(셸 미확장 시 내부 확장)
    python backfill_import.py --dry-run dumps/*.json          # 쓰지 않고 카운트만

허브 서버가 떠 있어도 실행 가능(SQLite WAL, 쓰기 잠깐 경합은 대기로 처리).
"""

from __future__ import annotations

import glob
import json
import sys
from pathlib import Path
from typing import Any, Iterable

# 이 파일은 backend/ 직속이라 app 패키지를 그대로 import 할 수 있다.
from app.config import DEFAULT_WORKER_ID
from app.db import init_db
from app import repo
from app.services import cli_bridge
from app.services.mcp_ingest import mcp_item_to_cli  # 공유 매핑(routers/ingest.py 의 /ingest/mcp 와 동일)


def _looks_like_bundle_item(x: Any) -> bool:
    """content-hub 번들 항목(generation/asset 래퍼)인지 — 그렇다면 여긴 잘못된 입력."""
    return isinstance(x, dict) and "generation" in x and ("asset" in x or "references" in x)


def load_items(path: Path) -> list[dict[str, Any]]:
    """JSON 파일에서 MCP 아이템 리스트 추출. list / {items|generations|data:[...]} 허용."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"  ⚠ {path.name}: 읽기/파싱 실패 — {e}")
        return []
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        for key in ("items", "generations", "data"):
            if isinstance(data.get(key), list):
                return [x for x in data[key] if isinstance(x, dict)]
    print(f"  ⚠ {path.name}: 아이템 배열을 못 찾음(list 또는 {{items:[...]}} 형태여야 함)")
    return []


def expand_paths(args: Iterable[str]) -> list[Path]:
    """글롭 미확장 셸(예: PowerShell)을 대비해 인자를 내부에서 한 번 더 확장."""
    out: list[Path] = []
    seen: set[str] = set()
    for a in args:
        matches = glob.glob(a)
        for m in matches or ([a] if Path(a).exists() else []):
            rp = str(Path(m).resolve())
            if rp not in seen:
                seen.add(rp)
                out.append(Path(m))
    return out


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    dry_run = "--dry-run" in argv[1:]

    if not args:
        print(__doc__)
        print("오류: 입력 JSON 파일을 하나 이상 지정하세요.", file=sys.stderr)
        return 2

    paths = expand_paths(args)
    if not paths:
        print(f"오류: 일치하는 파일이 없음: {args}", file=sys.stderr)
        return 2

    init_db()  # 스키마 보장(멱등). 기존 data/db 사용, 위치 이동은 이미 끝나 no-op.
    repo.ensure_default_worker()  # generation.worker_id FK 대상('me') 보장(신규 DB 대비)

    totals = {"inserted": 0, "updated": 0, "unchanged": 0, "skipped": 0}
    creators: dict[str, int] = {}
    seen_ids: set[str] = set()
    job_ids: list[str] = []

    print(f"백필 import 시작 — 파일 {len(paths)}개{' (DRY-RUN)' if dry_run else ''}")
    for path in paths:
        items = load_items(path)
        file_counts = {"inserted": 0, "updated": 0, "unchanged": 0, "skipped": 0}
        for it in items:
            if _looks_like_bundle_item(it):
                file_counts["skipped"] += 1
                totals["skipped"] += 1
                continue
            cli = mcp_item_to_cli(it)
            if not cli.get("id"):
                file_counts["skipped"] += 1
                totals["skipped"] += 1
                continue
            if cli["id"] in seen_ids:  # 페이지 경계 중복(cursor 겹침) 방지
                continue
            seen_ids.add(cli["id"])
            parsed = cli_bridge.parse_job(cli)
            cu = parsed["generation"].get("creator_uid")
            if cu:
                creators[cu] = creators.get(cu, 0) + 1
            if dry_run:
                continue
            res = repo.upsert_synced_generation(parsed, DEFAULT_WORKER_ID)
            file_counts[res] += 1
            totals[res] += 1
            if parsed["generation"].get("id"):
                job_ids.append(parsed["generation"]["id"])
        print(
            f"  {path.name}: {len(items)}건 → "
            f"신규 {file_counts['inserted']} · 갱신 {file_counts['updated']} · "
            f"중복 {file_counts['unchanged']} · 건너뜀 {file_counts['skipped']}"
        )

    # 목록에 다시 나타난 잡 = 힉스필드에 존재 → hf_missing 해제(주기동기화와 동일 보정).
    if not dry_run and job_ids:
        repo.mark_present_by_job_ids(job_ids)

    print("─" * 48)
    print(
        f"합계: 고유 {len(seen_ids)}건 · 신규 {totals['inserted']} · 갱신 {totals['updated']} · "
        f"중복 {totals['unchanged']} · 건너뜀 {totals['skipped']}"
        + (" (DRY-RUN, 쓰지 않음)" if dry_run else "")
    )
    if creators:
        top = sorted(creators.items(), key=lambda kv: kv[1], reverse=True)
        print("생성자별:", ", ".join(f"{u}({n})" for u, n in top[:10]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
