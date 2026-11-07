import { useEffect, useRef } from "react";
import { api } from "../api";
import { APP_EVENTS, dispatchAppEvent, LIBRARY_POLL_TICK } from "./appEvents";
import { hasActiveGenerationJob } from "./generationDisplay";
import type { Filters, Generation } from "../types";
import type { LibraryIntent } from "./useGenerationLibraryData";

// 처리 중 카드에서 화면에 보이는 진행 필드 — 확인 시각(last_checked_at·next_check_at)은 15초 안전망이 맞춘다.
const PROGRESS_FIELDS = ["status", "error", "execution_phase", "provider_status", "recovery_probe_status", "check_failures"] as const;
// 처리 중 카드가 있는 동안 마지막으로 목록을 받은 지 이만큼 지나면 비교 없이 받는다(팀 탭 유휴 주기와 같다).
const FULL_EVERY_MS = 15_000;
// 처리 중 카드 확인의 제한 시간 — 넘으면 실제로 끊고 '바뀜'으로 보아 목록을 받는다(목록 쪽은 자기 30초 제한이 있다).
export const ACTIVE_CHECK_TIMEOUT_MS = 8_000;

function isActive(g: Generation): boolean {
  return g.status === "pending" || g.status === "running";
}

// 처리 중 카드가 바뀌었나 — 바뀌었거나 확인할 수 없으면(오류·시간 초과·끊김) true. 실패를 '바뀜 없음'으로 보지 않는다.
export async function activeGenerationsChanged(generations: Generation[], tab: Filters["tab"], stop?: AbortSignal): Promise<boolean> {
  const active = generations.filter(isActive);
  if (!active.length || active.some((g) => g._comfyPending)) return true; // 임시 Comfy 카드는 서버에 없다 — 목록으로 맞춘다
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, ACTIVE_CHECK_TIMEOUT_MS);
  stop?.addEventListener("abort", abort);
  try {
    const batch = await api.getGenerationsBatch(active.map((g) => g.id), undefined,
      { ...(tab === "team" ? { authority: "team" as const } : {}), signal: controller.signal });
    return active.some((g) => {
      const fresh = Object.prototype.hasOwnProperty.call(batch.items, g.id) ? batch.items[g.id] : undefined;
      if (!fresh) return true;
      return PROGRESS_FIELDS.some((field) => field in fresh && fresh[field] !== g[field]);
    });
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
    stop?.removeEventListener("abort", abort);
  }
}

interface UseGenerationAutoRefreshArgs {
  generations: Generation[];
  tab: Filters["tab"];
  // 주기 폴링·창 복귀는 "check" 로 부른다 — 실제 변경이 아니라 확인이다(걸러 보는 컷 화면은 받는 중이면 합류하고 첫 쪽만 본다, 83회차)
  reload: (silent?: boolean, light?: boolean, intent?: LibraryIntent) => void | Promise<void>;
  // 지금은 자동으로 다시 받지 않는다 — 폴더 창을 닫은 직후 옛 첫 쪽을 보이며 새 첫 쪽을 기다리는 동안(목록 훅의 staleList).
  //  그 사이에 자동 조회가 끼면 받던 첫 쪽이 seq 로 버려지고 한 번 더 받느라 조작 잠금이 한 왕복 더 간다(2026-10-07 실측:
  //  0.63초 → 1.2초). 막는 것은 **여기서 시작하는 조회**(주기 폴링·창 복귀)뿐이다 — 실제 변경 통보(WS 동기화·알림)의 조회는
  //  그대로 두어 낡은 응답을 무효화하게 한다. 풀린 뒤 따로 한 번 더 받지 않는다(다음 틱은 원래 주기대로 온다).
  paused?: boolean;
}

export function useGenerationAutoRefresh({
  generations,
  tab,
  reload,
  paused = false,
}: UseGenerationAutoRefreshArgs) {
  const hasActiveJob = hasActiveGenerationJob(generations);
  // 최신 값을 ref 로 읽어 진입만 막는다 — paused 로 아래 effect 를 다시 만들면 주기가 처음부터 다시 돌고, 진행 중 표시
  //  (inflight)가 지워져 아직 안 끝난 폴링 위에 다음 폴링이 겹친다.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  // 마지막 갱신 시각 — 폴링 인터벌과 focus/visibility 복귀가 공유해 중복 리로드를 막는다.
  const lastRefreshRef = useRef(0);
  const inflightRef = useRef(false);
  // 생성 중 3초 틱은 처리 중 카드만 확인한다(2026-11-07 2-7) — 확인에 쓰는 최신 목록.
  const generationsRef = useRef(generations);
  generationsRef.current = generations;

  // 탭 전환 자체가 목록 reload 를 일으키므로, 직후 따라오는 브라우저 focus 이벤트는 중복 처리하지 않는다.
  useEffect(() => {
    lastRefreshRef.current = Date.now();
  }, [tab]);

  useEffect(() => {
    // 캔버스의 생성 상태는 useSceneGenData가 배치 폴링한다. 이전 탭 gens를 기준으로 라이브러리까지
    // 함께 폴링하면 같은 상태를 두 경로에서 확인하고 projects 목록도 불필요하게 반복 조회한다.
    if (tab === "compose") return;
    if (!hasActiveJob && tab !== "team") return;
    // 내 활성 잡: 3초(진행률 체감·WS 누락 보강). team 탭 유휴: 15초 안전망 —
    // 팀원 변경은 공유서버에서 일어나 로컬 WS 로는 안 오므로 폴링 자체는 필요하지만,
    // 3초 전체 리로드(프록시 왕복+원격 썸네일 prewarm 재스케줄)는 과했다.
    const ms = hasActiveJob ? 3000 : 15000;
    let alive = true;
    let checking: AbortController | null = null; // 지금 떠 있는 처리 중 카드 확인 — 주기가 끝나면(탭 전환·정리) 끊는다
    let lastFullAt = Date.now();
    const id = setInterval(() => {
      // 창이 안 보이면 쉰다(복귀 시 아래 visibilitychange 가 즉시 1회 갱신).
      if (pausedRef.current || document.visibilityState === "hidden") return;
      const now = Date.now();
      if (inflightRef.current) {
        // 확인만 떠 있는데 안전망 기한이 지났다 — 그 확인을 끊는다(끊긴 확인은 '바뀜'으로 보고 목록을 받는다).
        if (checking && now - lastFullAt >= FULL_EVERY_MS) checking.abort();
        return;
      }
      // 직전 복귀 조회는 중복을 막되, 주기보다 수 ms 일찍 온 틱은 버리지 않는다.
      if (now - lastRefreshRef.current < ms / 2) return;
      inflightRef.current = true;
      // 생성 중: 처리 중 카드만 묻고 바뀌었을 때만 목록 첫 쪽(약 3.38MB)을 받는다. 마지막으로 받은 지 15초가 지나면 비교 없이 받는다(안전망).
      const full = !hasActiveJob || now - lastFullAt >= FULL_EVERY_MS;
      const run = async () => {
        if (!full) {
          const check = (checking = new AbortController());
          try {
            if (!(await activeGenerationsChanged(generationsRef.current, tab, check.signal))) return;
          } finally {
            if (checking === check) checking = null;
          }
        }
        // 확인을 기다리는 사이 이 주기가 정리됐거나(탭 전환) 쉬기·숨김에 들어갔으면 새 조회를 시작하지 않는다.
        if (!alive || pausedRef.current || document.visibilityState === "hidden") return;
        // 목록을 실제로 받을 때만 시계를 넘긴다 — 확인만 한 틱이 창 복귀 조회(5초 가드)를 막지 않게.
        lastRefreshRef.current = lastFullAt = Date.now();
        await reload(true, true, "check");
      };
      void run().finally(() => {
        if (alive) inflightRef.current = false;
        // 팀 탭 유휴 폴링: light 리로드는 projects 를 안 갱신해 사이드바 폴더 카운트(+N 신규 배지)가
        // 낡는다 — 사이드바 카운트 갱신 채널을 깨운다(활성 잡 3초 폴링에선 스팸 방지 위해 제외).
        // 실제 변경이 아니라는 표식을 단다(LIBRARY_POLL_TICK) — 편집 탭은 이것에 공유 목록을 다시 받지 않는다.
        if (alive && tab === "team" && !hasActiveJob) dispatchAppEvent(APP_EVENTS.libraryChanged, LIBRARY_POLL_TICK);
      });
    }, ms);
    return () => {
      alive = false;
      checking?.abort();
      inflightRef.current = false;
      clearInterval(id);
    };
  }, [hasActiveJob, reload, tab]);

  useEffect(() => {
    // focus 와 visibilitychange 가 복귀 시 함께 터지고 앱 전환 중에도 반복된다 → 5초 공유 가드.
    // 방금 인터벌 폴이 돈 직후 복귀해도 중복 리로드하지 않는다(같은 lastRefreshRef 공유).
    let alive = true;
    const onVisible = () => {
      // 쉬는 동안의 복귀는 시계(lastRefreshRef)도 건드리지 않는다 — 풀린 뒤의 복귀는 평소처럼 받는다.
      if (inflightRef.current || pausedRef.current || document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastRefreshRef.current < 5000) return;
      inflightRef.current = true;
      lastRefreshRef.current = now;
      void Promise.resolve(reload(true, true, "check")).finally(() => {
        if (alive) inflightRef.current = false;
        // 복귀 조회가 주기 조회를 대신해도 팀 사이드바 숫자는 갱신한다.
        if (alive && tab === "team" && !hasActiveJob) dispatchAppEvent(APP_EVENTS.libraryChanged, LIBRARY_POLL_TICK);
      });
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      alive = false;
      inflightRef.current = false;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [hasActiveJob, reload, tab]);
}
