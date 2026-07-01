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
  const clearSelect = () => setSelected(new Set());

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
