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
    setErr(null);
    api
      .historyTree(focusId)
      .then((nextGraph) => alive && setGraph(nextGraph))
      .catch((error) => alive && setErr(String(error)));
    return () => {
      alive = false;
    };
  }, [focusId, reloadSignal]);

  return { err, graph };
}
