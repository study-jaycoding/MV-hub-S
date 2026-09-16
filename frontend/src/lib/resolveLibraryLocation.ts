import type { Generation, GenQuery } from "../types";

export interface GenerationLocationRequest {
  tab: "my" | "team";
  gen_ids: string[];
  project_id?: string | null;
  folder_path?: string | null;
}

export interface GenerationLocation {
  items: Generation[];
  focus_ids: string[];
  project_id: string | null;
  folder_path: string | null;
}

export function locationFilters(location: GenerationLocation) {
  return {
    project_id: location.project_id || "none",
    folder_path: location.folder_path || undefined,
  };
}

// 정렬을 페이지와 같게 유지한다. 특히 오래된 대상 한 건을 앞에 붙이면 날짜 그룹이 갈라진다.
export function mergeLocatedGenerations(page: Generation[], targets: Generation[]): Generation[] {
  const byId = new Map(page.map((item) => [item.id, item]));
  for (const item of targets) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) =>
    (b.sort_ts ?? 0) - (a.sort_ts ?? 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
}

export function isLocatedQuery(query: GenQuery, tab: "my" | "team", location: GenerationLocation) {
  if (query.tab !== tab || query.project_id !== (location.project_id || "none") ||
      (query.folder_path || "") !== (location.folder_path || "")) return false;
  const { tab: _tab, project_id: _project, folder_path: _folder, ...rest } = query;
  return Object.values(rest).every((value) =>
    Array.isArray(value) ? value.length === 0 : !value,
  );
}

// 서버 확인 뒤에도 표시 계약을 좁혀 방어한다. 숨김/취소 응답은 강조만 지우고 이동하지 않는다.
export function locatedItems(location: GenerationLocation, tab: "my" | "team") {
  const ids = new Set(location.focus_ids);
  return location.items.filter((item) => ids.has(item.id) && !item.deleted &&
    (tab !== "team" || item.shared) &&
    (item.project_id || null) === location.project_id &&
    (!location.folder_path || item.folder_path === location.folder_path ||
      item.folder_path?.startsWith(location.folder_path + "/")));
}
