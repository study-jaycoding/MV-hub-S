// 자리(탭·프로젝트·폴더)마다 마지막으로 본 모양 — 리스트/그리드와 '리스트 한 번 더'(낱장 목록 = 날짜별 구분 · 폴더 카드 = 표).
//  Jay 2026-10-13 저녁: "각 폴더별로 내가 봤던 게 리스트인지 그리드인지도 기억하게 한다." 순수 계산과 저장 모양만 둔다(쓰는 곳 = lib/useLibraryFilters).
//  규칙:
//   · **본 자리는 본 모양으로 적힌다** — 처음 들어간 폴더는 방금 보던 모양을 물려받고, 그 모양이 그 폴더의 것으로 적힌다(탐색기의 폴더별 보기와 같다).
//     그래서 다른 폴더에서 모양을 바꿔도 이미 본 폴더는 그때 본 모양 그대로다.
//   · 모양을 바꾸면 그 자리 것만 바뀐다.
//   · 이 브라우저에만 남는다(localStorage `placeViews`). 자리는 PLACE_VIEWS_MAX 곳까지 — 넘으면 가장 오래전에 적힌 것부터 버린다.
import type { Filters } from "../types";

export interface PlaceView {
  layout: "grid" | "list";
  group: boolean; // 리스트 단추를 한 번 더 누른 상태(도구 줄의 '날짜별 구분' 값)
}
export type PlaceViews = Readonly<Record<string, PlaceView>>;

export const PLACE_VIEWS_KEY = "placeViews";
export const PLACE_VIEWS_MAX = 400;

/** 그 조회가 보는 자리의 열쇠 — 휴지통·찾는 조건은 자리가 아니다(같은 폴더의 다른 보기다). */
export function placeViewKey(filters: Pick<Filters, "tab" | "project_id" | "folder_path">): string {
  return JSON.stringify([filters.tab, filters.project_id ?? null, filters.folder_path ?? null]);
}

/** 저장된 것을 읽는다 — 모양이 깨진 줄은 버린다(손상·옛 형식). */
export function parsePlaceViews(raw: unknown): PlaceViews {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const views: Record<string, PlaceView> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const view = value as Partial<PlaceView> | null;
    if (!view || (view.layout !== "grid" && view.layout !== "list")) continue;
    views[key] = { layout: view.layout, group: view.group === true };
  }
  return views;
}

/** 그 자리의 모양을 적은 새 목록 — 같은 값이면 **같은 객체**를 돌려준다(다시 그리지도 저장하지도 않게). 적힌 자리는 맨 뒤(가장 새것)로 간다. */
export function withPlaceView(views: PlaceViews, key: string, view: PlaceView, max = PLACE_VIEWS_MAX): PlaceViews {
  const known = views[key];
  if (known && known.layout === view.layout && known.group === view.group) return views;
  const next: Record<string, PlaceView> = {};
  for (const [other, value] of Object.entries(views)) if (other !== key) next[other] = value;
  next[key] = { layout: view.layout, group: view.group };
  const keys = Object.keys(next);
  for (let index = 0; index < keys.length - max; index++) delete next[keys[index]];
  return next;
}
