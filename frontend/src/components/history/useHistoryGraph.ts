import { useEffect, useState } from "react";
import { api } from "../../api";
import type { HistoryGraph } from "../../types";

export function useHistoryGraph(focusId: string | null, reloadSignal?: number) {
  const [graph, setGraph] = useState<HistoryGraph | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!focusId) {
      setGraph(null);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setErr(null);
    // 일시적 실패(네트워크 블립 등)면 수동 새로고침 없이 자가 복구 — 2회 재시도 후에만 오류 표시.
    const attempt = (retriesLeft: number) => {
      api
        .historyTree(focusId)
        .then((nextGraph) => alive && setGraph(nextGraph))
        .catch((error) => {
          if (!alive) return;
          if (retriesLeft > 0) timer = setTimeout(() => attempt(retriesLeft - 1), 500);
          else setErr(String(error));
        });
    };
    attempt(2);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [focusId, reloadSignal]);

  return { err, graph };
}
