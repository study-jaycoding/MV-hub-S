import type { Generation } from "../types";

export class ColorSaveError<T = unknown> extends Error {
  constructor(readonly failed: number, readonly detail?: T) {
    super("generation color save failed");
  }
}

// 계정/씬 수명이 바뀐 작업은 네트워크 실패와 구분해 조용히 폐기한다.
export class ColorScopeChangedError extends Error {
  constructor() { super("generation color scope changed"); }
}

export function nextGenerationSelectionColor(
  generations: Generation[],
  ids: string[],
  color: string,
): string | null {
  const selectedIds = new Set(ids);
  const selected = generations.filter((generation) => selectedIds.has(generation.id));
  return selected.length > 0 && selected.every((generation) => generation.color === color)
    ? null
    : color;
}

export function applyGenerationColor(
  generations: Generation[],
  ids: string[],
  color: string | null,
): Generation[] {
  const selectedIds = new Set(ids);
  return generations.map((generation) =>
    selectedIds.has(generation.id) ? { ...generation, color } : generation,
  );
}
