import { useEffect } from "react";
import { hasActiveGenerationJob } from "./generationDisplay";
import type { Filters, Generation } from "../types";

interface UseGenerationAutoRefreshArgs {
  generations: Generation[];
  tab: Filters["tab"];
  reload: (silent?: boolean, light?: boolean) => void | Promise<void>;
}

export function useGenerationAutoRefresh({
  generations,
  tab,
  reload,
}: UseGenerationAutoRefreshArgs) {
  const hasActiveJob = hasActiveGenerationJob(generations);

  useEffect(() => {
    if (!hasActiveJob && tab !== "team") return;
    // 내 활성 잡: 3초(진행률 체감·WS 누락 보강). team 탭 유휴: 15초 안전망 —
    // 팀원 변경은 공유서버에서 일어나 로컬 WS 로는 안 오므로 폴링 자체는 필요하지만,
    // 3초 전체 리로드(프록시 왕복+원격 썸네일 prewarm 재스케줄)는 과했다.
    const ms = hasActiveJob ? 3000 : 15000;
    let inflight = false;
    const id = setInterval(() => {
      // 창이 안 보이면 쉰다(복귀 시 아래 visibilitychange 가 즉시 1회 갱신).
      if (inflight || document.visibilityState === "hidden") return;
      inflight = true;
      void Promise.resolve(reload(true, true)).finally(() => {
        inflight = false;
      });
    }, ms);
    return () => clearInterval(id);
  }, [hasActiveJob, reload, tab]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void reload(true, true);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [reload]);
}
