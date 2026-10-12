import { useEffect, useState } from "react";
import { api } from "../../api";
import { reconcileValueState } from "../../lib/stateReconciliation";
import type { HistoryGraph } from "../../types";

export function useHistoryGraph(focusId: string | null, reloadSignal?: number) {
  // 받은 계보는 **무엇을 물어 받은 것인지**와 함께 든다(아래 shown). 물은 id 와 응답의 노드 id 는 다를 수 있다 — 서버 id(job)로 물으면
  //  백엔드가 이 PC 의 id 로 풀어 답한다(routers/generation.py get_history_tree).
  const [held, setHeld] = useState<{ focusId: string; graph: HistoryGraph } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!focusId) {
      setHeld(null);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setErr(null);
    // 일시적 실패(네트워크 블립 등)면 수동 새로고침 없이 자가 복구 — 2회 재시도 후에만 오류 표시.
    const attempt = (retriesLeft: number) => {
      api
        .historyTree(focusId)
        .then((nextGraph) => {
          if (!alive) return;
          setHeld((previous) => {
            const graph = previous ? reconcileValueState(previous.graph, nextGraph) : nextGraph;
            return previous?.focusId === focusId && previous.graph === graph ? previous : { focusId, graph }; // 같은 값이면 다시 그리지 않는다
          });
        })
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

  // 지금 대상의 계보만 보인다 — 전엔 다른 계보의 카드를 열어도 새것이 올 때까지 앞 계보가 그 카드의 것처럼 보였다(조작 규칙 46).
  //  지금 대상으로 물어 받은 것이거나, 보이던 계보 안의 카드로 옮긴 것(같은 계보 — 누를 때마다 깜빡이지 않게 그대로 둔다)이면 보인다.
  const shown = held && focusId && (held.focusId === focusId || held.graph.nodes.some((node) => node.id === focusId));
  return { err, graph: shown ? held.graph : null };
}
