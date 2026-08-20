import type { Generation, PreviewTarget } from "../types";

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
  // 프록시·백필 스키마가 어긋나면 assets 자체가 없을 수 있다 — 화이트스크린 대신 미리보기만 생략.
  const asset = target.assets?.[0];
  if (!asset) return null;

  const withAsset = generations.filter((g) => g.assets?.[0]);
  const items = withAsset.map((g) => ({
    url: g.assets[0].file_path,
    type: g.assets[0].type,
    name: (g.prompt ?? "").slice(0, 50) || "(제목 없음)",
    genId: g.id,
  }));
  const index = withAsset.findIndex((g) => g.id === target.id);

  return {
    url: asset.file_path,
    type: asset.type,
    name: (target.prompt ?? "").slice(0, 50) || "(제목 없음)",
    genId: target.id,
    items,
    index,
  };
}
