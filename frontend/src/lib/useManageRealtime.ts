import { useEffect, useRef, useState } from "react";
import { consumeOwnDomainSync } from "./librarySync";
import {
  manageRefreshDelay,
  shouldRefreshManageForLibrarySync,
  shouldRunManageFallbackRefresh,
} from "./manageRefreshPolicy";
import { connectProgress } from "./progressSocket";

const MANAGE_SYNC_DEBOUNCE_MS = 180;
const MANAGE_FALLBACK_REFRESH_MS = 30_000;

/** 독립 관리 창이 메인 App 없이도 서버 변경을 따라가기 위한 가벼운 reload 신호. */
export function useManageRealtime(enabled: boolean): number {
  const [reloadSignal, setReloadSignal] = useState(0);
  const lastRefreshAtRef = useRef(Date.now());

  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    let dueAt = 0;
    let deadline = Infinity; // 출처 없는 변경이 늦어도 이때는 읽혀야 한다 — 디바운스가 이 뒤로 밀지 못한다
    let dirtyWhileHidden = false;
    // coalesce = 출처 없는 신호: 이미 더 일찍 잡힌 재조회가 이 신호도 담으니 미루지 않는다. 그 밖의 신호는 예전처럼
    // 마지막 신호 뒤 180ms(디바운스) — 연달아 오는 출처 있는 변경을 한 번에 읽는다(Codex 리뷰 P2 2026-11-05).
    const schedule = (delay = MANAGE_SYNC_DEBOUNCE_MS, coalesce = false) => {
      if (document.hidden) {
        dirtyWhileHidden = true;
        return;
      }
      dirtyWhileHidden = false;
      const now = Date.now();
      const at = now + delay;
      if (coalesce) {
        deadline = Math.min(deadline, at);
        if (timer && dueAt <= at) return;
      }
      if (timer) clearTimeout(timer);
      dueAt = Math.min(at, deadline);
      timer = window.setTimeout(() => {
        timer = undefined;
        deadline = Infinity;
        lastRefreshAtRef.current = Date.now();
        setReloadSignal((value) => value + 1);
      }, dueAt - now);
    };
    const disconnect = connectProgress(
      (message) => {
        if (message.type === "manage_changed") {
          if (consumeOwnDomainSync("manage", message.origins)) return;
          const originless = !message.origins?.length;
          schedule(manageRefreshDelay({
            originless,
            lastRefreshAt: lastRefreshAtRef.current,
            now: Date.now(),
          }), originless);
        } else if (message.type === "synced") {
          // 작업 카드의 연결 생성물·완료/게시 상태는 라이브러리 변경에도 영향을 받는다.
          // 다만 syncer·구형 위임 서버의 출처 없는 신호는 조회 반향과 구분할 수 없고 연속 도착할 수
          // 있으므로 30초 안전망에 맡긴다. 브라우저 쓰기에서 온 출처 있는 변경만 즉시 반영한다.
          if (!shouldRefreshManageForLibrarySync(message.origins)) return;
          schedule();
        }
      },
      () => schedule(),
    );
    // WebSocket 신호가 누락되거나 구버전 서버가 출처 없는 synced 만 보내도 대시보드·작업·완료
    // 탭이 결국 최신 상태를 따라잡는다. 현재 보이는 관리 창만 느슨하게 다시 조회한다.
    const poll = window.setInterval(() => {
      if (
        shouldRunManageFallbackRefresh({
          hidden: document.hidden,
          lastRefreshAt: lastRefreshAtRef.current,
          now: Date.now(),
        })
      )
        schedule();
    }, MANAGE_FALLBACK_REFRESH_MS);
    const onVisibility = () => {
      if (
        dirtyWhileHidden ||
        shouldRunManageFallbackRefresh({
          hidden: document.hidden,
          lastRefreshAt: lastRefreshAtRef.current,
          now: Date.now(),
        })
      )
        schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);

  return reloadSignal;
}
