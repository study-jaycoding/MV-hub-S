"""힉스필드 주기 동기화 (실시간성).

`generate list --json` 은 무료 읽기이므로 백그라운드에서 주기적으로 끌어와
다른 기기·웹·MCP 로 만들어진 잡(생성/결과물/실패)을 자동 반영한다. 변동이 있으면
WS 로 push 해 프론트가 즉시 새로고침하게 한다.

⚠️ 과도기 기능(push 모델 — project_content_hub_push_model): 이 주기 동기화는 **서버에 붙은
   힉스필드 CLI 계정(=하우스/jay) 본인 것만** 끌어온다. 본질적으로는 그 사람도 로컬→push 가
   맞지만, 서버가 jay PC 에 얹혀 있는 동안의 편의로 유지한다. 서버를 다른 머신으로 옮기면
   `CONTENT_HUB_SERVER_SYNC=0` 으로 끄고 전원 push 에이전트로 일원화한다.
   비용 호출(generate create)은 서버가 하지 않는다 — 전원 로컬 CLI(gen-request).
"""

from __future__ import annotations

import asyncio
import contextlib
import os
from typing import Optional

from .. import repo
from ..config import DEFAULT_WORKER_ID
from ..ws import manager
from . import cli_bridge

# 서버측 주기 동기화 on/off(과도기 게이트). 0/false 면 주기 루프를 아예 안 띄운다 — 서버가
# 하우스 PC 밖으로 이전됐을 때 전원 push 에이전트로 일원화하는 스위치. 기본 on.
SERVER_SYNC_ENABLED = os.environ.get("CONTENT_HUB_SERVER_SYNC", "1").lower() in ("1", "true", "yes", "on")

# 주기(초). 0 이하이면 비활성. generate list 는 무료지만 과도한 호출 방지로 기본 20초.
SYNC_INTERVAL = float(os.environ.get("CONTENT_HUB_SYNC_INTERVAL", "20"))

# 갭 경보 워터마크: 한 번의 동기화에서 신규(inserted)가 이 수 이상이면 100-window 밖으로
# 못 본 잡이 밀려났을 수 있다는 신호(CLI 는 최신 100개·페이지네이션 불가).
# 받는 즉시 더 끌어올 방법은 없으므로 경보만 남기고, 사용자가 web/타 소스 export 로 보완.
SYNC_WATERMARK = int(os.environ.get("CONTENT_HUB_SYNC_WATERMARK", "85"))


async def sync_now(worker_id: Optional[str] = None) -> dict[str, int]:
    """CLI 에서 최근 생성 이력을 끌어와 업서트. 카운트 반환.
    신규가 워터마크 이상이면 gap_warning=1 을 함께 반환(누락 위험 알림).

    DB 업서트는 ① 한 트랜잭션 배치(repo.apply_synced_jobs, fsync 1회) + ② to_thread 워커
    스레드에서 수행한다 — 이전엔 잡마다 커넥션·fsync 를 메인 이벤트 루프에서 돌려, 20초 주기마다
    들어오는 HTTP 요청(관리자 창 등)을 그 사이 통째로 밀리게 했다(체감 딜레이의 정체)."""
    jobs = await cli_bridge.list_jobs()
    wid = worker_id or DEFAULT_WORKER_ID
    counts = await asyncio.to_thread(repo.apply_synced_jobs, jobs, wid)
    counts["fetched"] = len(jobs)
    # 신규 적재가 있으면 그 자리에서 중복 정리 — create/sync 레이스로 생긴 중복 2행(로컬 placeholder +
    # 동기화본)이 다음 재시작까지 남지 않게 한다(예전엔 reconcile 가 부팅 때 1회뿐이라 런타임 내내
    # 그리드·카운트에 중복 노출). 중복 없으면 GROUP BY HAVING>1 이 빈 결과라 사실상 무비용.
    if counts.get("inserted"):
        with contextlib.suppress(Exception):
            counts["reconciled"] = await asyncio.to_thread(repo.reconcile_duplicates)
    # 워터마크 초과 = 누락 위험. 100개를 꽉 채워 가져왔는데 대부분이 신규면 더 의심.
    counts["gap_warning"] = 1 if (
        counts["inserted"] >= SYNC_WATERMARK and len(jobs) >= 100
    ) else 0
    return counts


class PeriodicSync:
    def __init__(self, interval: float = SYNC_INTERVAL) -> None:
        self._interval = interval
        self._task: Optional[asyncio.Task] = None

    def start(self) -> None:
        if not SERVER_SYNC_ENABLED:
            print("[syncer] 서버측 주기 동기화 비활성(CONTENT_HUB_SERVER_SYNC=0) — 전원 push 에이전트 모드")
            return
        if self._interval <= 0:
            return  # 비활성
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="periodic-sync")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _run(self) -> None:
        while True:
            await asyncio.sleep(self._interval)
            try:
                c = await sync_now()
                if c.get("gap_warning"):
                    print(
                        f"[periodic-sync] ⚠ 갭 경보: 신규 {c['inserted']}건 — "
                        f"100-window 밖으로 밀린 잡이 있을 수 있음. web/타 소스 export 로 보완 필요."
                    )
                    await manager.broadcast(
                        {"type": "gap_warning", "inserted": c["inserted"]}
                    )
                # 신규/상태변동이 있으면 프론트에 새로고침 신호.
                if c["inserted"] or c["updated"]:
                    await manager.broadcast({"type": "synced"})
            except asyncio.CancelledError:
                raise
            except cli_bridge.CLIError:
                # CLI 일시 불가(네트워크/로그아웃 등) — 조용히 다음 주기 재시도.
                pass
            except Exception as e:  # noqa: BLE001 — 워커가 죽지 않도록 격리
                print(f"[periodic-sync] 오류: {e}")


periodic_sync = PeriodicSync()
