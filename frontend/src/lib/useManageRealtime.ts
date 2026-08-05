import { useEffect, useState } from "react";
import { consumeOwnDomainSync } from "./librarySync";
import { connectProgress } from "./progressSocket";

const MANAGE_SYNC_DEBOUNCE_MS = 180;

/** 독립 관리 창이 메인 App 없이도 서버 변경을 따라가기 위한 가벼운 reload 신호. */
export function useManageRealtime(enabled: boolean): number {
  const [reloadSignal, setReloadSignal] = useState(0);

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
          schedule();
        }
      },
      schedule,
    );
    const onVisibility = () => {
      if (!document.hidden && dirtyWhileHidden) schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer) clearTimeout(timer);
      disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);

  return reloadSignal;
}
