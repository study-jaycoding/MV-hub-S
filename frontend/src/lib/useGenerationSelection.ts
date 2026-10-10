import { useEffect, useRef, useState } from "react";
import { pressStartedCovered } from "./keyGate";
import { toggleSetValue } from "./setUtils";

interface UseGenerationSelectionArgs {
  resetKey: string;
  preserveSelectors?: string;
}

export function useGenerationSelection({
  resetKey,
  preserveSelectors = ".gen-cell, .gen-grid, .select-bar, .proj-assign, .cmt-panel",
}: UseGenerationSelectionArgs) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const toggleSelect = (id: string) => setSelected((prev) => toggleSetValue(prev, id));
  // 이미 비어 있으면 같은 Set 을 돌려 재렌더를 만들지 않는다 — Esc 마다 App 이 다시 그려지면 같은 Esc 를 기다리던
  // 다른 keydown 리스너가 전달 도중 재구독되며 첫 입력을 놓친다(2026-09-19 실측, useEscapeClose 와 한 쌍).
  const clearSelect = () => setSelected((prev) => (prev.size ? new Set() : prev));

  useEffect(() => {
    // 위에 창·메뉴·확인 창이 떠 있을 때의 클릭은 그것의 몫이다 — 뒤의 선택을 풀지 않는다(바깥을 눌러 닫는 클릭도). 코멘트 패널도 같다.
    //  2026-10-10 실측: 등급 확인 창의 [확인]을 마우스로 누르면 선택이 풀려 '한 번 더 눌러 최종까지'가 끊겼다(Esc·키보드는 유지).
    //  '누르는 순간 떠 있었나'는 lib/keyGate 가 pointerdown 에서 적어 둔다 — 여기(mousedown)서 보면 이미 닫힌 뒤일 수 있다.
    const onDocDown = (e: MouseEvent) => {
      if (selectedRef.current.size === 0 || pressStartedCovered()) return;
      const target = e.target as HTMLElement | null;
      if (!target || target.closest(preserveSelectors)) return;
      setSelected(new Set());
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [preserveSelectors]);

  useEffect(() => {
    setSelected(new Set());
  }, [resetKey]);

  return { clearSelect, selected, selectedRef, setSelected, toggleSelect };
}
