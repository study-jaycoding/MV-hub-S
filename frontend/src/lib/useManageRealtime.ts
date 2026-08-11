import { useEffect, useRef, useState } from "react";
import { consumeOwnDomainSync } from "./librarySync";
import {
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
    let dirtyWhileHidden = false;
    const schedule = () => {
      if (document.hidden) {
        dirtyWhileHidden = true;
        return;
      }
      dirtyWhileHidden = false;
      if (timer) clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        lastRefreshAtRef.current = Date.now();
        setReloadSignal((value) => value + 1);
      }, MANAGE_SYNC_DEBOUNCE_MS);
    };
    const disconnect = connectProgress(
      (message) => {
        if (message.type === "manage_changed") {
          if (consumeOwnDomainSync("manage", message.origins)) return;
          schedule();
        } else if (message.type === "synced") {
          // 작업 카드의 연결 생성물·완료/게시 상태는 라이브러리 변경에도 영향을 받는다.
          // 다만 syncer·구형 위임 서버의 출처 없는 신호는 조회 반향과 구분할 수 없고 연속 도착할 수
          // 있으므로 30초 안전망에 맡긴다. 브라우저 쓰기에서 온 출처 있는 변경만 즉시 반영한다.
          if (!shouldRefreshManageForLibrarySync(message.origins)) return;
          schedule();
        }
      },
      schedule,
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
