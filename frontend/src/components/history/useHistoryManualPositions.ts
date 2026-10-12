import { useEffect, useRef, useState } from "react";
import { loadJSON, mergeOwnChanges, saveJSON } from "../../lib/storage";
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

  // 저장 — 저장소의 최신 표에 **이 창이 옮긴 노드만** 반영한다(lib/storage mergeOwnChanges). 통째로 쓰면 다른 창이 그사이 옮긴 노드의 자리가
  //  이 창이 처음 읽은 낡은 표에 지워졌다(조작 규칙 48). savedRef = 이 창이 마지막으로 읽거나 쓴 표.
  const savedRef = useRef(manualPos);
  useEffect(() => {
    if (savedRef.current === manualPos) return; // 읽은 그대로다 — 쓸 것이 없다
    saveJSON(POS_KEY, mergeOwnChanges(loadPos(), savedRef.current, manualPos));
    savedRef.current = manualPos;
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
