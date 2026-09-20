import type { Generation, PreviewTarget } from "../types";
import { thumbOf } from "./media";

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
  thumbSize?: number, // 격자가 카드에 준 썸네일 폭 — 같은 URL 이어야 미리보기 자리 표시가 브라우저 캐시에서 뜬다
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
    thumb: thumbOf(g, thumbSize ?? 512),
  }));
  const index = withAsset.findIndex((g) => g.id === target.id);

  return {
    url: asset.file_path,
    type: asset.type,
    name: (target.prompt ?? "").slice(0, 50) || "(제목 없음)",
    genId: target.id,
    thumb: thumbOf(target, thumbSize ?? 512),
    items,
    index,
  };
}
