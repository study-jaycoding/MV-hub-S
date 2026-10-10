import { backgroundKeysBlocked } from "../../lib/keyGate";
import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { toggleDisabledGen } from "../../lib/deactivated";
import { matchShortcut } from "../../lib/shortcuts";
import type { XY } from "../../lib/historyGraphLayout";

export function useHistoryBoardShortcuts({
  focusId,
  selectedRef,
  nodeIdsRef,
  setManualPos,
}: {
  focusId: string | null;
  selectedRef: MutableRefObject<Set<string>>;
  nodeIdsRef: MutableRefObject<string[]>; // 지금 보는 계보의 노드
  setManualPos: Dispatch<SetStateAction<Record<string, XY>>>;
}) {
  useEffect(() => {
    if (!focusId) return;
    const onKey = (event: KeyboardEvent) => {
      if (backgroundKeysBlocked()) return; // 위에 뜬 창·메뉴의 키(lib/keyGate)
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if (matchShortcut(event, "boardDisable")) {
        const ids = [...selectedRef.current];
        if (!ids.length || event.repeat) return; // 길게 눌러도 한 번(누르고 있으면 켬·끔이 번갈아 뒤집혔다)
        event.preventDefault();
        toggleDisabledGen(ids);
      } else if (matchShortcut(event, "boardArrange")) {
        event.preventDefault();
        setManualPos((prev) => {
          // 선택이 없으면 **지금 보는 계보의 노드만** 자동 자리로 — 저장소는 모든 계보의 수동 배치를 한 곳에 담고 있어, 통째로 비우면
          //  다른 계보에서 손으로 놓은 자리까지 사라졌다.
          const ids = selectedRef.current.size ? [...selectedRef.current] : nodeIdsRef.current;
          if (!ids.some((id) => id in prev)) return prev;
          const next = { ...prev };
          ids.forEach((id) => delete next[id]);
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusId, selectedRef, nodeIdsRef, setManualPos]);
}
