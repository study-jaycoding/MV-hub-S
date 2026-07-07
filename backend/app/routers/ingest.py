"""push 적재(ingest) 라우터 — 각자 로컬 CLI 결과물을 서버로 모으는 입구.

설계(합의):
  · 서버는 힉스필드 CLI 를 돌리지 않는다. 각 팀원이 자기 PC·자기 CLI 로 생성하고
    `push_agent` 가 로컬 `generate list --json` 원본을 이 엔드포인트로 밀어올린다.
  · 인증은 '허브 로그인 세션'(미들웨어가 채운 request.state.account)으로만 — 힉스필드
    토큰은 서버로 오지 않는다.
  · 보낸 잡은 그 계정의 힉스필드 생성자 uid 로 귀속되고(결과 URL의 user_<id>),
    계정 ↔ 그 uid 가 연결돼 '내 작업' 분리가 성립한다. 미디어는 공개 URL 그대로.
"""

from __future__ import annotations

import json
from collections import Counter

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from . import _proxy
from .. import repo
from ..config import AUTH_ENABLED, BACKEND_DIR, DEFAULT_WORKER_ID, MANAGE_ENABLED
from ..deps import account_scope_uid, require_agent_account
from ..models import IngestIn, IngestMcpIn, IngestOut
from ..services import cli_bridge
from ..services.agent_signals import agent_signals
from ..services.mcp_ingest import mcp_item_to_cli

# agent_push.py — 저장소 최상단(content-hub-server/). 팀원이 허브에서 받아 자기 PC에서 실행.
_AGENT_PATH = BACKEND_DIR.parent / "agent_push.py"

router = APIRouter(prefix="/api", tags=["ingest"])


def _acc(request: Request) -> dict:
    acc = getattr(request.state, "account", None)
    if not acc:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다(적재는 인증 필수)")
    return acc


def _agent_acc(request: Request) -> dict:
    """에이전트·계정상태용 신원. 공용 require_agent_account 로 단일화(신원 규칙 분산 방지)."""
    return require_agent_account(request)


def _ingest_core(acc, jobs, creator_uid, account_status) -> IngestOut:
    """CLI list 형태 잡들을 적재 + 계정↔힉스필드 uid 연결 + 크레딧 보고. push/mcp 공통 코어.
    각 잡은 자기 고유 creator_uid(URL의 user_<id>)를 유지하고, 이미 실제 uid 에 연결된 계정은
    재연결하지 않는다(레퍼런스 오염 방지, 실측 버그)."""
    # 신원 검증 — 에이전트가 보고한 로컬 CLI 계정(account status 의 email)이 허브 로그인 계정과
    # 같아야 그 계정 작업으로 확정한다. 다르면 남의 힉스필드 신원을 내 계정에 잘못 귀속시키는
    # 것이라 거부(self-report 무조건 신뢰 → 이메일 일치 '검증'으로 격상). 옛 에이전트는 email 을
    # 안 줄 수 있어 그땐 검사 생략(하위호환).
    # 이메일 검증은 서버(AUTH on)에서만 — 로컬 허브(AUTH off)는 내 PC·내 에이전트라 acc.email 이
    # 'local' 이라 검증 대상이 아니다(검증은 크레딧 보고를 서버로 전달할 때 서버가 수행).
    reported_email = ((account_status or {}).get("email") or "").strip().lower()
    acc_email = (acc.get("email") or "").strip().lower()
    if AUTH_ENABLED and (jobs or account_status) and not reported_email:
        raise HTTPException(
            status_code=409,
            detail=(
                "에이전트가 CLI 계정 이메일을 보고하지 않았습니다(옛 버전). "
                "MV_agent.bat 또는 update_cli.bat 으로 에이전트를 갱신하세요 — "
                "신원 검증 없이 적재하면 다른 사람 작업으로 오귀속될 수 있어 막습니다."
            ),
        )
    if AUTH_ENABLED and reported_email and reported_email != acc_email:
        raise HTTPException(
            status_code=409,
            detail=(
                f"로컬 CLI 계정({reported_email})이 허브 로그인({acc.get('email')})과 다릅니다. "
                "같은 계정으로 로그인해야 내 작업으로 정확히 귀속됩니다."
            ),
        )
    # 로컬 허브(AUTH off, 프록시 로그인)도 같은 검증을 해야 한다 — 안 그러면 이 PC 의 CLI 계정이
    # 만든 생성물이 '지금 허브에 로그인한 다른 계정'의 격리 DB 로 적재되어(로그인 시 에이전트 재동기화),
    # 그 계정 '내 작업'에 남의 작업이 섞이고 creator 이름까지 그 로그인 이름으로 덮어써진다
    # (실측: CLI=제이인 PC 에서 jiwon 으로 로그인 → jiwon DB 에 제이 생성물 100건, 이름은 '오지짱').
    # acc.email 은 로컬에선 'local' 이라 비교 대상이 아니므로, 활성 계정 DB 의 주인 이메일
    # (active.json = 지금 로그인한 계정)과 CLI 보고 이메일을 비교한다. 미로그인이면 hub_email 이
    # None 이라 검사 생략(단독 사용 = 레거시 단일 DB).
    if not AUTH_ENABLED:
        from ..active_account import account_key

        hub_email = (account_key() or "").strip().lower()
        if hub_email:  # 프록시 로그인 상태 — 반드시 CLI 신원을 검증해야 한다.
            if not reported_email:
                # 옛 에이전트는 account_status.email 을 안 줘 검증이 불가능 → 적재 거부(예전엔 검증을
                # 건너뛰고 그대로 uid 를 '나'로 학습해 오귀속 위험). 에이전트 업데이트 유도.
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "에이전트가 CLI 계정 이메일을 보고하지 않았습니다(옛 버전). update_cli.bat / "
                        "MV_agent.bat 으로 에이전트를 갱신하세요 — 신원 검증 없이 적재하면 남의 작업으로 "
                        "오귀속될 수 있어 막습니다."
                    ),
                )
            if reported_email != hub_email:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"이 PC 의 CLI 계정({reported_email})이 허브 로그인({hub_email})과 다릅니다. "
                        "MV_agent 창에서 'CLI 계정 바꾸기' 제안에 y 를 누르거나(권장), 허브를 CLI 와 "
                        "같은 계정으로 로그인하세요 — 다른 계정 DB 오염(남의 작업이 내 작업으로 섞임)을 막습니다."
                    ),
                )
        # hub_email 없음(미로그인 단독 사용) → 검증 생략(레거시 단일 DB).
    cur_uid = acc.get("creator_uid")
    linked_real = bool(cur_uid) and not str(cur_uid).startswith("acct:")
    own_uid = creator_uid or (cur_uid if linked_real else None)

    counts = {"inserted": 0, "updated": 0, "unchanged": 0}
    skipped = 0
    uid_votes: Counter[str] = Counter()
    # 1차: 파싱 + URL 유래 uid 표만 먼저 모은다 — 보강 기준 uid 를 잡 루프 '전에' 확정하기 위함.
    # (최초 ingest 라 own_uid 가 아직 None 이어도, 잡들의 URL user_<id> 다수결로 '나'를 알아낼 수 있다.
    #  예전엔 own_uid 로만 보강해, 첫 ingest 의 uid 없는 잡이 NULL 로 남았다가 다음 재시작에야 구제됐다.)
    staged = []
    seen_job_ids: set[str] = set()
    for raw in jobs:
        if not isinstance(raw, dict):
            skipped += 1
            continue
        parsed = cli_bridge.parse_job(raw)
        g = parsed.get("generation") or {}
        if not g.get("id"):
            skipped += 1
            continue
        job_key = str(g["id"])
        if job_key in seen_job_ids:
            skipped += 1
            continue
        seen_job_ids.add(job_key)
        if g.get("creator_uid"):
            uid_votes[g["creator_uid"]] += 1
        staged.append(parsed)

    # 보강 기준 uid 선결정: 명시 creator_uid / 링크된 계정 uid(own_uid) > 잡 다수결(URL user_<id>).
    boost_uid = own_uid or (uid_votes.most_common(1)[0][0] if uid_votes else None)

    # 2차: uid 없는 잡을 boost_uid 로 보강하며 적재(남의 uid 가진 잡은 그대로 보존).
    for parsed in staged:
        g = parsed["generation"]
        if not g.get("creator_uid") and boost_uid:
            g["creator_uid"] = boost_uid
    # 배치 업서트(한 트랜잭션·fsync 1회) — 잡별 개별 커밋은 대량 첫 push(수백 건)에서 fsync
    # 버스트를 만든다(syncer 가 같은 이유로 배치화한 것과 통일). 잡별 SAVEPOINT 라 1건 실패해도
    # 나머지는 반영되고, 실패분은 skipped 와 구분해 errors 로 응답(코덱스: 계약 명시).
    errors = 0
    if staged:
        bcounts = repo.apply_synced_jobs(staged, DEFAULT_WORKER_ID)
        for k in ("inserted", "updated", "unchanged"):
            counts[k] += bcounts.get(k, 0)
        errors = bcounts.get("errors", 0)

    if linked_real:
        linked = cur_uid
    else:
        linked = creator_uid or (uid_votes.most_common(1)[0][0] if uid_votes else None)
        if linked:
            repo.set_account_hf_creator(acc["email"], linked)
    # ★로컬 허브(AUTH off): 이 허브는 내 PC·내 것이라, 에이전트가 올린 내 CLI uid 를 '나'로 학습한다.
    #   안 하면 my_creator_uid 미설정 → get_my_uid()=None → 내 생성물조차 is_mine=false 라 전부
    #   '팀원'으로 뜬다(동기화 잡은 id==job_id 라 id<>job_id 추론도 안 됨). set-if-empty 라 멱등,
    #   계정별 DB 라 각 계정 DB 가 자기 uid 만 학습. 서버(AUTH on)는 하우스 신원이라 학습 안 함.
    #   boost_uid 가 잡 루프 전에 확정되므로 첫 ingest 부터 올바른 uid 로 학습된다.
    if not AUTH_ENABLED and (boost_uid or linked):
        my_uid = boost_uid or linked
        repo.learn_my_creator_uid(my_uid)
        # ★내 표시이름을 내 creator 에 붙인다 — 사이드바·생성정보·카드의 '생성자'가 '나'/'팀원'
        #   대신 내 계정 표시이름(로그인 시 보관한 provider 이름)으로 뜨게 한다. resolve_display_names
        #   가 creator.name 을 1순위로 보므로, 이게 있어야 로컬에서도 내 이름이 해석된다.
        pname = (repo.get_provider() or {}).get("name")
        if pname:
            repo.set_creator_name(my_uid, pname)
    if account_status:
        repo.record_account_status(acc["email"], account_status)

    # 팀 매니징: 적재된 내 생성물을 텔레메트리 outbox 에 dirty 표시(메타만, best-effort).
    # 실제 서버 전송은 ingest 엔드포인트가 _drain_telemetry 로 처리한다.
    if MANAGE_ENABLED and seen_job_ids:
        try:
            from ..repo import manage as _m

            _m.mark_ingested_dirty(list(seen_job_ids), boost_uid or linked)
        except Exception:  # noqa: BLE001 — 텔레메트리 표시 실패가 적재를 막지 않게
            pass

    return IngestOut(
        inserted=counts["inserted"],
        updated=counts["updated"],
        unchanged=counts["unchanged"],
        skipped=skipped,
        errors=errors,
        linked_uid=linked,
    )


def _drain_telemetry() -> None:
    """dirty 텔레메트리를 서버 매니징 저장소로 push(best-effort). 프록시(서버 연결) 있을 때만 —
    서버 없으면 outbox 에 쌓였다 다음 기회에 전송(오프라인 큐). 순수 클라이언트 측 드레이너.

    정합성(코덱스):
      · dirty 중 내것(build 됨)과 내것 아님(build 에서 빠짐)을 나눈다.
      · 내것 아님 → 큐에서 정리(다시 build 될 일 없음).
      · 내것 → 서버가 실제로 받은 수(upserted)가 보낸 수 이상일 때만 정리, 아니면(미링크·스킵) 실패
        처리해 재시도. mark_pushed 는 dirty_at CAS 라 drain 도중 재dirty 된 건 자동으로 남는다."""
    if not _proxy.proxying():
        return
    from ..repo import manage as _m

    dirty = _m.list_dirty_telemetry(500)  # [{local_gen_id, dirty_at, is_tombstone, tomb_*}]
    if not dirty:
        return
    my_uid = repo.get_my_uid()
    tomb_rows = [d for d in dirty if d.get("is_tombstone")]
    normal_rows = [d for d in dirty if not d.get("is_tombstone")]
    normal_ids = [d["local_gen_id"] for d in normal_rows]
    # 일반: 살아있는 로컬 gen 에서 팩트 빌드(내것만). tombstone: gen 이 사라졌으므로 저장해둔 값으로 직접 구성.
    facts = _m.build_telemetry_facts(gen_ids=normal_ids, my_uid=my_uid) if normal_ids else []
    built_ids = {f["local_gen_id"] for f in facts}
    tomb_facts = []
    for d in tomb_rows:
        snap: dict = {}
        if d.get("tomb_snapshot"):
            try:
                snap = json.loads(d["tomb_snapshot"]) or {}
            except Exception:  # noqa: BLE001
                snap = {}
        # 스냅샷(비용·프로젝트 포함) 위에 삭제 표시를 얹는다 — 서버에 팩트가 없던(미전송) 것도 비용 집계.
        tomb_facts.append(
            {
                **snap,
                "local_gen_id": d["local_gen_id"],
                "job_id": snap.get("job_id") or d.get("tomb_job_id"),
                # tomb_creator_uid(컬럼)를 snapshot JSON 보다 우선 — 컬럼은 remap(acct:→user_)되지만
                # snapshot JSON 은 stale acct: 로 남을 수 있어, 컬럼 우선이라야 전환 후 삭제반영이 정합.
                "creator_uid": d.get("tomb_creator_uid") or snap.get("creator_uid") or my_uid,
                "is_deleted": True,
            }
        )
    all_facts = facts + tomb_facts
    sent = [d for d in normal_rows if d["local_gen_id"] in built_ids] + tomb_rows
    non_sent = [d for d in normal_rows if d["local_gen_id"] not in built_ids]
    _m.mark_telemetry_pushed(non_sent)  # 내것 아님 → 무조건 큐 정리(CAS)
    if not all_facts:
        return
    try:
        resp = _proxy.proxy_json("POST", "/api/manage/telemetry/push", body={"items": all_facts})
        resp = resp if isinstance(resp, dict) else {}
        if "skipped" in resp:
            # 정밀 처리: 서버가 '실제로 스킵한 것'만 재시도로 남기고, 반영된 나머지는 정리한다.
            # (개수만 보고 성공분까지 통째로 failed 처리해 재전송하던 낭비·attempts 부풀림 제거.)
            skipped_ids = set(resp.get("skipped") or [])
            pushed = [d for d in sent if d["local_gen_id"] not in skipped_ids]
            failed = [d["local_gen_id"] for d in sent if d["local_gen_id"] in skipped_ids]
            if pushed:
                _m.mark_telemetry_pushed(pushed)  # 반영됨 → 정리(CAS)
            if failed:
                _m.mark_telemetry_failed(failed, "server skipped (unlinked/foreign)")
        else:
            # 구 서버(skipped 미지원) 폴백: 개수 기반 전량 판정(기존 동작).
            upserted = resp.get("upserted", 0)
            if upserted >= len(all_facts):
                _m.mark_telemetry_pushed(sent)  # 서버가 다 받음 → 정리(CAS)
            else:
                _m.mark_telemetry_failed(
                    [d["local_gen_id"] for d in sent], f"server upserted {upserted}/{len(all_facts)}"
                )
    except Exception as e:  # noqa: BLE001 — 전송 실패는 재시도(다음 drain)로 회복
        _m.mark_telemetry_failed([d["local_gen_id"] for d in sent], str(e))


@router.post("/ingest", response_model=IngestOut)
def ingest(body: IngestIn, request: Request):
    """로컬 `generate list` 원본 묶음(최신분)을 내 로컬 DB 에 적재 — push_agent 가 호출.
    로컬 우선: 생성물은 로컬에만 남고(공유는 선택 발행으로만), 팀 크레딧 집계를 위해
    account_status(잔액/플랜)·account_transactions(실제 차감액)를 서버로 전달한다
    (서버가 이메일 일치 검증 + 서버 PM DB 에 집계)."""
    acc = _agent_acc(request)
    out = _ingest_core(acc, body.jobs, body.creator_uid, body.account_status)
    # PM: 실제 차감액 수집·매칭(분리형). 플래그 게이트 + best-effort — 실패해도 적재엔 무영향.
    # 거래는 out.linked_uid(이 계정의 힉스필드 uid) 소유로 적재하고, 같은 소유자 생성물과 시각 매칭.
    if MANAGE_ENABLED and body.account_transactions:
        try:
            from ..repo import manage as _m

            _m.record_transactions(out.linked_uid, acc.get("email"), body.account_transactions)
        except Exception:  # noqa: BLE001 — 메트릭 수집 실패가 적재를 막지 않게
            pass
    if _proxy.proxying() and (body.account_status or body.account_transactions):
        try:
            _proxy.proxy_json(
                "POST",
                "/api/ingest",
                body={
                    "jobs": [],
                    "account_status": body.account_status,
                    "account_transactions": body.account_transactions,
                    "creator_uid": body.creator_uid,
                },
            )
        except Exception:  # noqa: BLE001 — 크레딧 보고 실패는 로컬 적재를 막지 않음
            pass
    # 팀 매니징: dirty 텔레메트리를 서버로 flush(신규 적재분 + 이전 실패분 재시도). best-effort.
    if MANAGE_ENABLED:
        try:
            _drain_telemetry()
        except Exception:  # noqa: BLE001
            pass
    return out


@router.post("/ingest/mcp", response_model=IngestOut)
def ingest_mcp(body: IngestMcpIn, request: Request):
    """과거 전체 백필 — MCP `show_generations` 원시 아이템(100개 밖)을 내 로컬 DB 에 적재. 멱등.
    흐름: Claude 가 그 사용자 세션으로 show_generations 를 next_cursor 끝까지 순회하며 각 페이지를
    이 엔드포인트로 POST. mcp_item_to_cli 로 CLI 형태 변환 후 push 와 동일 코어로 처리."""
    jobs = [mcp_item_to_cli(it) for it in body.items if isinstance(it, dict)]
    out = _ingest_core(_agent_acc(request), jobs, None, body.account_status)
    # 팀 매니징: 백필도 일반 ingest 와 동일하게 dirty 텔레메트리를 flush 한다. MCP 백필은 페이지를
    # 여러 번 POST 하고 '마지막 페이지' 신호가 없어, 매 페이지 drain 해야 백필만 한 사용자도 대시보드가
    # 밀리지 않는다. drain 은 프록시 없으면 no-op, 실패분은 큐에 남아 재시도. best-effort.
    if MANAGE_ENABLED:
        try:
            _drain_telemetry()
        except Exception:  # noqa: BLE001
            pass
    return out


@router.get("/credits")
def team_credits(request: Request):
    """팀 크레딧 집계(전체 합계 + 구성원별) — 에이전트가 보고한 마지막 잔액 기준. 로그인 필수."""
    if not getattr(request.state, "account", None):
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")
    return repo.credit_summary()


@router.get("/agent/download")
def download_agent():
    """agent_push.py 다운로드 — 공개(미들웨어 _AUTH_PUBLIC_PREFIXES). MV_agent.bat 이 인증 없이
    curl 로 받게 한다. 스크립트엔 비밀이 없다(실제 push 는 여전히 허브 로그인 필요)."""
    if not _AGENT_PATH.is_file():
        raise HTTPException(status_code=404, detail="agent_push.py 를 찾을 수 없습니다")
    return FileResponse(
        _AGENT_PATH, filename="agent_push.py", media_type="text/x-python"
    )


@router.get("/agent/run-bat")
def run_agent_bat(request: Request):
    """원클릭 실행용 MV_agent.bat — 서버 주소·로그인 이메일을 채워 반환. 더블클릭하면
    agent_push.py 를 자동으로 받아(curl) 상시(--watch) 실행한다. 로그인 필수(이메일 필요)."""
    acc = _agent_acc(request)
    server = str(request.base_url).rstrip("/")
    email = acc["email"]
    # CLI 버전 고정(pin): 서버 저장소 루트의 hf_cli_version.txt 를 읽어 그 버전으로 설치·교정한다.
    # @latest 금지(힉스필드가 파괴적 변경을 자주 냄). 파일이 없으면 unpinned 폴백.
    try:
        _pin = (BACKEND_DIR.parent / "hf_cli_version.txt").read_text("utf-8").strip().splitlines()[0].strip()
    except Exception:  # noqa: BLE001
        _pin = ""
    if _pin:
        cli_ensure = f"""echo [3/5] 힉스필드 CLI 확인(고정 {_pin})...
set "HF=higgsfield"
where higgsfield >nul 2>nul || set "HF=hf"
set "CURVER="
where %HF% >nul 2>nul && for /f "tokens=2" %%v in ('%HF% version 2^>nul') do if not defined CURVER set "CURVER=%%v"
if not "%CURVER%"=="{_pin}" (
  echo     힉스필드 CLI 고정 버전 {_pin} 설치/교정...
  call npm install -g @higgsfield/cli@{_pin} || (echo [오류] CLI 설치 실패 - 인터넷/npm 권한을 확인하세요. & pause & exit /b 1)
  call :refreshpath
  set "HF=higgsfield"
)"""
    else:
        cli_ensure = """echo [3/5] 힉스필드 CLI 확인...
set "HF=higgsfield"
where higgsfield >nul 2>nul || set "HF=hf"
where %HF% >nul 2>nul
if errorlevel 1 (
  echo     힉스필드 CLI 미설치 - npm 으로 설치...
  call npm install -g @higgsfield/cli || (echo [오류] CLI 설치 실패 - 인터넷/npm 권한을 확인하세요. & pause & exit /b 1)
  call :refreshpath
  set "HF=higgsfield"
)"""
    # 자동 설치형 .bat — 없으면 winget(Python·Node)·npm(@higgsfield/cli)로 자동 설치 후 실행.
    #  · winget/npm 설치분은 현재 콘솔 PATH 에 즉시 안 잡혀(레지스트리에만 반영) → :refreshpath 로
    #    재읽기(베스트에포트), 그래도 안 잡히면 '새 창에서 다시 실행' 안내로 수렴.
    #  · higgsfield 는 npm 셰임(.CMD)이라 배치에서 반드시 `call` 로 호출(안 하면 제어 안 돌아옴).
    #  · `higgsfield auth login` 은 대화형(계정 로그인)이라 자동화 불가 — 처음 1회 사람이 직접.
    bat = rf"""@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================================
echo  Content Hub 에이전트 - 자동 설치 + 실행
echo ============================================================

echo [0/5] agent_push.py 최신본 받는 중...
curl -fsSL -o "%~dp0agent_push.py.new" "{server}/api/agent/download" 2>nul || powershell -NoProfile -Command "Invoke-WebRequest -Uri '{server}/api/agent/download' -OutFile 'agent_push.py.new'" 2>nul
if exist "%~dp0agent_push.py.new" move /y "%~dp0agent_push.py.new" "%~dp0agent_push.py" >nul
if not exist "%~dp0agent_push.py" (echo [오류] agent_push.py 다운로드 실패 - 서버 주소를 확인하세요. & pause & exit /b 1)

set "NEEDREOPEN=0"

echo [1/5] Python 확인...
set "PY=python"
where python >nul 2>nul || set "PY=py"
where %PY% >nul 2>nul
if errorlevel 1 (
  echo     Python 미설치 - winget 으로 설치 시도...
  where winget >nul 2>nul || (echo [오류] winget 이 없어 자동 설치 불가. https://www.python.org 에서 Python 설치 후 다시 실행하세요. & pause & exit /b 1)
  winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements --silent
  set "NEEDREOPEN=1"
)

echo [2/5] Node.js(npm) 확인...
where npm >nul 2>nul
if errorlevel 1 (
  echo     Node.js 미설치 - winget 으로 설치 시도...
  where winget >nul 2>nul || (echo [오류] winget 이 없어 자동 설치 불가. https://nodejs.org 에서 설치 후 다시 실행하세요. & pause & exit /b 1)
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
  set "NEEDREOPEN=1"
)

if "%NEEDREOPEN%"=="1" call :refreshpath

set "PY=python"
where python >nul 2>nul || set "PY=py"
where %PY% >nul 2>nul || (echo. & echo [안내] Python 설치는 완료됐지만 현재 창에 PATH 가 반영되지 않았습니다. & echo        이 창을 닫고 MV_agent.bat 을 다시 더블클릭하세요. & pause & exit /b 0)
where npm >nul 2>nul || (echo. & echo [안내] Node.js 설치는 완료됐지만 현재 창에 PATH 가 반영되지 않았습니다. & echo        이 창을 닫고 MV_agent.bat 을 다시 더블클릭하세요. & pause & exit /b 0)

{cli_ensure}

echo [4/5] 힉스필드 로그인 + workspace 확인...
call %HF% auth token >nul 2>nul
if errorlevel 1 (
  echo     로그인이 필요합니다 - 브라우저 안내에 따라 내 힉스필드 계정으로 로그인하세요.
  call %HF% auth login
)
rem CLI 1.x 는 workspace 미선택 시 generate 가 실패(rc!=0)한다. 워크스페이스가 '정확히 1개'면
rem 자동 선택한다(모호성 없어 안전). 여러 개면 임의선택이 위험(엉뚱한 워크스페이스 청구/귀속)하므로 안내만.
%PY% -c "import subprocess,sys,json; hf=sys.argv[1]; r=subprocess.run([hf,'workspace','list','--json'],capture_output=True,text=True); ws=json.loads(r.stdout or '[]') if r.returncode==0 else []; ws=ws if isinstance(ws,list) else []; (len(ws)==1 and not any(w.get('is_selected') for w in ws)) and subprocess.run([hf,'workspace','set',ws[0]['id']])" "%HF%" >nul 2>nul
call %HF% account status >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [조치 필요] 힉스필드 workspace 가 선택되지 않아 생성이 꺼집니다. 한 번만 설정하세요:
  call %HF% workspace list
  echo     실행:  higgsfield workspace set [id]   그다음 이 창을 닫고 다시 실행하세요.
  echo.
  pause
  exit /b 0
)

echo [5/5] 허브 열기 + 에이전트 실행 - 켜두면 작동, 창을 닫으면 멈춥니다.
rem 기본 브라우저로 허브(우리 프로그램) 자동 열기. 그 뒤 에이전트는 이 창에서 상주.
start "" "{server}"
%PY% agent_push.py --server {server} --email {email} --watch 30
pause
exit /b 0

:refreshpath
rem winget/npm 설치분 PATH 를 레지스트리(시스템+사용자)에서 다시 읽어 현재 세션에 반영(베스트에포트).
for /f "skip=2 tokens=2,*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SysPath=%%b"
for /f "skip=2 tokens=2,*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "UsrPath=%%b"
set "PATH=%SysPath%;%UsrPath%"
goto :eof
"""
    bat = bat.replace("\n", "\r\n")
    return Response(
        content=bat.encode("utf-8"),
        media_type="application/octet-stream",
        headers={"Content-Disposition": 'attachment; filename="MV_agent.bat"'},
    )


@router.get("/agent/wait")
async def agent_wait(request: Request):
    """에이전트 롱폴 — 내 계정에 이벤트(생성요청/동기화)가 생길 때까지 대기하다 즉시 반환.
    타임아웃이면 wake=false(에이전트가 즉시 재대기). 30초 고정 폴링을 대체한다."""
    acc = _agent_acc(request)
    reason = await agent_signals.wait(acc["email"], timeout=25.0)
    return {"wake": reason is not None, "reason": reason}


@router.post("/agent/sync")
def agent_sync(request: Request):
    """'내 작업 올리기' 버튼 — 내 에이전트를 깨워 로컬 결과물을 push 하게 한다."""
    acc = _agent_acc(request)
    agent_signals.signal(acc["email"], "sync")
    return {"ok": True, "connected": agent_signals.connected(acc["email"])}


@router.get("/agent/status")
def agent_status(request: Request):
    """내 에이전트가 지금 붙어 있나(롱폴 대기 중) — UI 연결 점 표시용."""
    acc = _agent_acc(request)
    return {"connected": agent_signals.connected(acc["email"])}


@router.get("/account/hf")
def my_hf_status(request: Request):
    """로그인 계정 본인이 에이전트로 보고한 힉스필드 상태(크레딧·플랜·워크스페이스) — 계정 메뉴가
    '내 것'을 표시할 때 쓴다. 브라우저는 그 계정 CLI에 직접 접근 못 하므로 이 보고값이 유일한 출처.
    보고 이력 없으면 reported=false(에이전트 미연결 안내)."""
    acc = _agent_acc(request)
    st = repo.get_reported_status(acc["email"])
    if not st:
        return {"reported": False, "credits": None, "plan": None, "workspaces": []}
    return {
        "reported": True,
        "credits": st.get("credits"),
        "plan": st.get("plan"),
        "connected": st.get("connected"),
        "workspaces": st.get("workspaces") or [],
    }


@router.get("/ingest/known-jobs")
def known_jobs(request: Request):
    """이 계정(힉스필드 uid)으로 이미 서버에 있는 job_id 목록 — 에이전트가 새 것만 보내게.
    인증 필수. account.creator_uid 기준. (구버전 에이전트 호환용 — 신버전은 POST 차집합 사용.)"""
    acc = getattr(request.state, "account", None)
    if not acc:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")
    # account_scope_uid: creator_uid, 미링크면 acct:email 또는 '\x00'(불가능값) — None 으로 떨어져
    # 전역 검색(남의 job 존재 oracle)이 되지 않게 한다.
    uid = account_scope_uid(request)
    return {"creator_uid": uid, "job_ids": repo.known_job_ids(uid) if uid else []}


class KnownJobsIn(BaseModel):
    job_ids: list[str] = []


@router.post("/ingest/known-jobs")
def known_jobs_diff(body: KnownJobsIn, request: Request):
    """에이전트의 로컬 job_id 목록(≤ --size 개)을 받아 서버에 '없는 것'만 돌려준다 —
    GET(서버 보유 전량 응답)은 라이브러리가 커질수록 매 사이클 왕복이 무거워져 차집합으로 교체.
    응답 payload 가 요청 크기로 유한해진다. 인증 필수."""
    acc = getattr(request.state, "account", None)
    if not acc:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")
    ids = [str(j) for j in (body.job_ids or []) if j][:1000]  # 방어적 상한
    # account_scope_uid 로 스코프 — 미링크 계정도 acct:email/'\x00' 이라 전역 검색(남의 job 존재
    # oracle)이 되지 않는다. GET 경로와 동일 기준.
    return {"unknown": repo.unknown_job_ids(ids, creator_uid=account_scope_uid(request))}
