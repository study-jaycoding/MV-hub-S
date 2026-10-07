import { useEffect, useRef } from "react";
import { APP_EVENTS, dispatchAppEvent } from "./appEvents";
import { hasActiveGenerationJob } from "./generationDisplay";
import type { Filters, Generation } from "../types";

interface UseGenerationAutoRefreshArgs {
  generations: Generation[];
  tab: Filters["tab"];
  reload: (silent?: boolean, light?: boolean) => void | Promise<void>;
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
    let inflight = false;
    const id = setInterval(() => {
      // 창이 안 보이면 쉰다(복귀 시 아래 visibilitychange 가 즉시 1회 갱신).
      if (inflight || pausedRef.current || document.visibilityState === "hidden") return;
      inflight = true;
      lastRefreshRef.current = Date.now();
      void Promise.resolve(reload(true, true)).finally(() => {
        inflight = false;
        // 팀 탭 유휴 폴링: light 리로드는 projects 를 안 갱신해 사이드바 폴더 카운트(+N 신규 배지)가
        // 낡는다 — 사이드바 카운트 갱신 채널을 깨운다(활성 잡 3초 폴링에선 스팸 방지 위해 제외).
        if (tab === "team" && !hasActiveJob) dispatchAppEvent(APP_EVENTS.libraryChanged);
      });
    }, ms);
    return () => clearInterval(id);
  }, [hasActiveJob, reload, tab]);

  useEffect(() => {
    // focus 와 visibilitychange 가 복귀 시 함께 터지고 앱 전환 중에도 반복된다 → 5초 공유 가드.
    // 방금 인터벌 폴이 돈 직후 복귀해도 중복 리로드하지 않는다(같은 lastRefreshRef 공유).
    const onVisible = () => {
      // 쉬는 동안의 복귀는 시계(lastRefreshRef)도 건드리지 않는다 — 풀린 뒤의 복귀는 평소처럼 받는다.
      if (pausedRef.current || document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastRefreshRef.current < 5000) return;
      lastRefreshRef.current = now;
      void reload(true, true);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [reload]);
}
