import { useEffect, useRef, useState } from "react";
import { loadJSON, saveJSON } from "../../lib/storage";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import type { XY } from "../../lib/historyGraphLayout";
import type { HistoryGraph } from "../../types";

const POS_KEY = STORAGE_KEYS.historyPos;
const POS_KEY_OLD = STORAGE_KEYS.historyPosLegacy;

const loadPos = (): Record<string, XY> => {
  try {
    return loadJSON<Record<string, XY>>(POS_KEY) ?? loadJSON<Record<string, XY>>(POS_KEY_OLD) ?? {};
  } catch {
    return {};
  }
};

export function useHistoryManualPositions(graph: HistoryGraph | null, arrangeSignal?: number) {
  const [manualPos, setManualPos] = useState<Record<string, XY>>(loadPos);
  const pendingArrangeRef = useRef(false);
  const arrangeInitRef = useRef(true);

  useEffect(() => {
    saveJSON(POS_KEY, manualPos);
  }, [manualPos]);

  // '구성에서 보기' 진입(arrangeSignal 변화) 시 이 트리 노드들의 수동 위치를 비워 자동 정렬한다.
  useEffect(() => {
    if (arrangeInitRef.current) {
      arrangeInitRef.current = false;
      return;
    }
    pendingArrangeRef.current = true;
  }, [arrangeSignal]);

  useEffect(() => {
    if (!graph || !pendingArrangeRef.current) return;
    pendingArrangeRef.current = false;
    const ids = new Set(graph.nodes.map((node) => node.id));
    setManualPos((prev) => {
      let changed = false;
      const next: Record<string, XY> = {};
      for (const id in prev) {
        if (ids.has(id)) {
          changed = true;
          continue;
        }
        next[id] = prev[id];
      }
      return changed ? next : prev;
    });
  }, [graph]);

  return { manualPos, setManualPos };
}
