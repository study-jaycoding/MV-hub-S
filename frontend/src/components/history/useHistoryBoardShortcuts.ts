import { backgroundKeysBlocked, isTypingTarget } from "../../lib/keyGate";
import { isKeyHandled, markKeyHandled } from "../../lib/keyHandled";
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
  setSelected,
}: {
  focusId: string | null;
  selectedRef: MutableRefObject<Set<string>>;
  nodeIdsRef: MutableRefObject<string[]>; // 지금 보는 계보의 노드
  setManualPos: Dispatch<SetStateAction<Record<string, XY>>>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
}) {
  useEffect(() => {
    if (!focusId) return;
    const onKey = (event: KeyboardEvent) => {
      if (backgroundKeysBlocked()) return; // 위에 뜬 창·메뉴의 키(lib/keyGate)
      // 글자를 치는 자리만 양보한다(lib/keyGate isTypingTarget) — 체크박스·슬라이더에 초점이 남아 있어도 d·a·Esc 는 먹고,
      //  select 에서 친 글자는 목록 고르기의 것이다(전엔 INPUT 이면 전부 양보하고 select 는 양보하지 않았다).
      if (isTypingTarget(event.target)) return;
      if (event.key === "Escape") {
        // 뒤 화면의 Esc = 선택 해제(라이브러리·캔버스와 같게). 보드의 선택은 보드가 쥐고 있어 라이브러리의 Esc 로는 풀리지 않았다.
        //  안쪽이 이미 쓴 Esc 는 손대지 않는다. 푼 Esc 는 '쓴 것'으로 표시하고(lib/keyHandled), 고른 것이 없으면 쓰지 않는다 —
        //  다른 뒤 화면의 Esc 가 받는다.
        if (isKeyHandled(event) || !selectedRef.current.size) return;
        markKeyHandled(event);
        setSelected(new Set());
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
  }, [focusId, selectedRef, nodeIdsRef, setManualPos, setSelected]);
}
