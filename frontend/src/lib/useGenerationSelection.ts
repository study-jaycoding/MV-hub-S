import { useEffect, useRef, useState } from "react";
import { toggleSetValue } from "./setUtils";

interface UseGenerationSelectionArgs {
  resetKey: string;
  preserveSelectors?: string;
}

export function useGenerationSelection({
  resetKey,
  preserveSelectors = ".gen-cell, .gen-grid, .select-bar, .proj-assign",
}: UseGenerationSelectionArgs) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const toggleSelect = (id: string) => setSelected((prev) => toggleSetValue(prev, id));
  // 이미 비어 있으면 같은 Set 을 돌려 재렌더를 만들지 않는다 — Esc 마다 App 이 다시 그려지면 같은 Esc 를 기다리던
  // 다른 keydown 리스너가 전달 도중 재구독되며 첫 입력을 놓친다(2026-09-19 실측, useEscapeClose 와 한 쌍).
  const clearSelect = () => setSelected((prev) => (prev.size ? new Set() : prev));

  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      if (selectedRef.current.size === 0) return;
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
