import type { Generation } from "../types";

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
