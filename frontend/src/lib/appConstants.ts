import type { Facets } from "../types";

export const EMPTY_FACETS: Facets = { colors: [], tags: [], auto_tags: [], workers: [] };

// r/g/b 단축키 → 컬러(기존 팔레트·필터와 동일한 색 필드에 매핑)
export const KEY_COLORS: Record<string, string> = {
  r: "#ff5722",
  g: "#4caf50",
  b: "#2196f3",
};
