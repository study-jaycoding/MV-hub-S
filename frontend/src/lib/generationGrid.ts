import { dayInfoFromUtcString } from "./dateGroups";
import type { Generation, PreviewTarget } from "../types";

export type GenerationDateGroups = Map<string, { label: string; ids: string[] }>;

export function buildGenerationDateGroups(generations: Generation[]): GenerationDateGroups {
  const groups: GenerationDateGroups = new Map();
  for (const g of generations) {
    const { key, label } = dayInfoFromUtcString(g.created_at);
    let entry = groups.get(key);
    if (!entry) {
      entry = { label, ids: [] };
      groups.set(key, entry);
    }
    entry.ids.push(g.id);
  }
  return groups;
}

export function toggleGenerationDateSelection(
  selectedIds: Set<string>,
  ids: string[],
  allSelected: boolean,
): Set<string> {
  const next = new Set(selectedIds);
  if (allSelected) ids.forEach((id) => next.delete(id));
  else ids.forEach((id) => next.add(id));
  return next;
}

export function previewTargetFromGenerations(
  generations: Generation[],
  target: Generation,
): PreviewTarget | null {
  const asset = target.assets[0];
  if (!asset) return null;

  const withAsset = generations.filter((g) => g.assets[0]);
  const items = withAsset.map((g) => ({
    url: g.assets[0].file_path,
    type: g.assets[0].type,
    name: g.prompt.slice(0, 50) || "(제목 없음)",
    genId: g.id,
  }));
  const index = withAsset.findIndex((g) => g.id === target.id);

  return {
    url: asset.file_path,
    type: asset.type,
    name: target.prompt.slice(0, 50) || "(제목 없음)",
    genId: target.id,
    items,
    index,
  };
}
