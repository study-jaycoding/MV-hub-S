"""NAS 결과 파일 ↔ 생성물(job) 잇기 판정(docs/NAS_RESULTS.md) — 분석의 토대. 화면·분석 방식은 여기서 정하지 않는다.

입력: 결과물 훑기 스냅샷(content DB, repo/nas_results) + 팀 장부(manage DB team_generation_fact).
판정은 **관측된 일치**다 — 생성물·팩트의 프로젝트·폴더 등 데이터를 고치지 않는다.

단서와 후보 집합(Codex 합의 r3):
  · 강 — 파일 속 hf-job-id · 앱 각인 mvhub.job_id · 파일 이름 hf_…_<uuid>: 장부에 있으면 {J}. 강 단서끼리 J 가 다르면 충돌.
    J 가 장부에 없으면 그 파일은 '장부에 없음(J)' 으로 끝 — 약한 단서로 내려가지 않는다.
  · 앱 각인 mvhub.gen_id — 장부 local_gen_id 와 같은 job 들. 풀리지 않으면: job 단서(위 셋)가 있으면 그 job 이 정체를
    말하므로 무시하고(서버 카드 id 일 수 있다), job 단서가 없으면 '장부에 없음'으로 보류한다 — 약한 단서로 내려가지 않는다(Codex 리뷰).
  · PNG 에 같은 키로 다른 번호가 있었으면(id_conflict) 충돌.
  · 중 — 사이트 받기 이름 <…>-<job 앞 8hex>: 앞자리가 맞는 job 전부.
  · 약 — (크기, 앞 64KiB sha256) 쌍(docs/RESULT_FINGERPRINT.md): 쌍이 같은 job 전부.
  판정 = 비어 있지 않은 후보 집합들의 교집합: 하나 → linked, 비면 → conflict, 여럿 → candidates, 단서 없음 → unmatched.
  유일성은 **전체 장부**로 판정한다(공개 범위로 먼저 거르면 거짓 '유일'이 생긴다 — 공개 필터는 쓰는 쪽에서).
"""

from __future__ import annotations

import posixpath
import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

from .. import manage_db
from ..db import get_connection
from ..repo import nas_results as nas_repo
from .asset_registry import root_key

_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_HF_NAME = re.compile(rf"hf_\d{{8}}_\d{{6}}_({_UUID})", re.I)
_SITE_NAME = re.compile(r"-([0-9a-f]{8})\.[a-z0-9]+$", re.I)


@dataclass
class LedgerIndex:
    """장부 전체에서 만든 찾기 표. owners: job → 그 job 을 가진 계정들(둘 이상이면 소유자 모호)."""

    owners: dict[str, set[str]] = field(default_factory=lambda: defaultdict(set))
    by_gen: dict[str, set[str]] = field(default_factory=lambda: defaultdict(set))
    by_prefix8: dict[str, set[str]] = field(default_factory=lambda: defaultdict(set))
    by_pair: dict[tuple[int, str], set[str]] = field(default_factory=lambda: defaultdict(set))


def build_index(rows: Iterable[dict[str, Any]]) -> LedgerIndex:
    """장부 행들(job_id·local_gen_id·account_email·result_bytes·result_head_sha) → 찾기 표. 삭제 표시 행도 넣는다 —
    지워진 생성물의 파일도 그 job 의 것이다(사용량이 아니라 정체를 본다)."""
    index = LedgerIndex()
    for row in rows:
        job = (row.get("job_id") or "").strip().lower()
        if not job:
            continue
        index.owners[job].add(str(row.get("account_email") or ""))
        gen = (row.get("local_gen_id") or "").strip().lower()
        if gen:
            index.by_gen[gen].add(job)
        index.by_prefix8[job.replace("-", "")[:8]].add(job)
        size, head = manage_db.fingerprint_pair(row)
        if size is not None:
            index.by_pair[(size, head)].add(job)
    return index


def clues(row: dict[str, Any]) -> dict[str, Any]:
    """파일 한 행에서 단서를 뽑는다(이름은 경로의 마지막 조각)."""
    name = posixpath.basename(row.get("path") or "")
    hf_name = _HF_NAME.search(name)
    site = None if hf_name else _SITE_NAME.search(name)
    pair = None
    if row.get("status") == "ok" and row.get("bytes") and row.get("head_sha"):
        pair = (int(row["bytes"]), str(row["head_sha"]))
    return {
        "hf_job_id": (row.get("hf_job_id") or "").lower() or None,
        "mv_job_id": (row.get("mv_job_id") or "").lower() or None,
        "name_job_id": hf_name.group(1).lower() if hf_name else None,
        "mv_gen_id": (row.get("mv_gen_id") or "").lower() or None,
        "name_prefix8": site.group(1).lower() if site else None,
        "pair": pair,
    }


def judge(row: dict[str, Any], index: LedgerIndex) -> dict[str, Any]:
    """파일 하나 → {state, job_id, method, candidates, owner_ambiguous}. state: linked · conflict · candidates · absent · unmatched."""
    c = clues(row)
    if row.get("id_conflict"):
        return _result("conflict", method="png_ids")
    strong = {key: c[key] for key in ("hf_job_id", "mv_job_id", "name_job_id") if c[key]}
    if len(set(strong.values())) > 1:
        return _result("conflict", method="+".join(strong))
    if c["mv_gen_id"] and not index.by_gen.get(c["mv_gen_id"]) and not strong:
        return _result("absent", method="mv_gen_id")  # 장부에 없는 각인 — 지문·이름 앞자리로 내려가지 않는다
    sets: list[tuple[str, set[str]]] = []
    if strong:
        method, job = next(iter(strong.items()))
        if job not in index.owners:
            return _result("absent", job_id=job, method=method)  # 장부에 없는 job — 약한 단서로 내려가지 않는다
        sets.append((method, {job}))
    if c["mv_gen_id"] and index.by_gen.get(c["mv_gen_id"]):
        sets.append(("mv_gen_id", set(index.by_gen[c["mv_gen_id"]])))
    if c["name_prefix8"] and index.by_prefix8.get(c["name_prefix8"]):
        sets.append(("name_prefix8", set(index.by_prefix8[c["name_prefix8"]])))
    if c["pair"] and index.by_pair.get(c["pair"]):
        sets.append(("pair", set(index.by_pair[c["pair"]])))
    if not sets:
        return _result("unmatched")
    common = set.intersection(*(found for _m, found in sets))
    method = sets[0][0]  # 가장 강한 단서(위 순서)
    if not common:
        return _result("conflict", method="+".join(m for m, _f in sets))
    if len(common) > 1:
        return _result("candidates", method=method, candidates=sorted(common))
    job = next(iter(common))
    return _result("linked", job_id=job, method=method, owner_ambiguous=len(index.owners.get(job) or ()) > 1)


def _result(state: str, *, job_id: Optional[str] = None, method: str = "", candidates: Optional[list[str]] = None,
            owner_ambiguous: bool = False) -> dict[str, Any]:
    return {"state": state, "job_id": job_id, "method": method, "candidates": candidates or [],
            "owner_ambiguous": owner_ambiguous}


def ledger_rows() -> list[dict[str, Any]]:
    """팀 장부 전체(서버의 manage DB) — 잇기에 필요한 칸만."""
    with manage_db.get_connection() as conn:
        rows = conn.execute(
            "SELECT job_id, local_gen_id, account_email, result_bytes, result_head_sha FROM team_generation_fact"
        ).fetchall()
    return [dict(row) for row in rows]


def link_project(project_id: str, index: Optional[LedgerIndex] = None) -> list[dict[str, Any]]:
    """프로젝트의 지금 루트로 만든 스냅샷 파일마다 판정을 붙여 돌려준다(서버에서 — 두 DB 가 다 있는 곳).
    루트가 바뀌어 스냅샷이 없으면 빈 목록. 공개 범위(누가 무엇을 보나)는 쓰는 쪽이 정한다."""
    with get_connection() as conn:
        rows = nas_repo.snapshot(conn, project_id, root_key(nas_repo.current_root(conn, project_id)))
    if index is None:
        index = build_index(ledger_rows())
    return [{**row, **judge(row, index)} for row in rows]
