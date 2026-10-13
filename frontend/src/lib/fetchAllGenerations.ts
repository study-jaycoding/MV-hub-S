// 한 조회의 목록을 커서로 끝까지 받는다(상한까지) — 컷 정보 창과 '목록에서 직접 묶는 폴더 카드'(lib/useLocalFolderCards)가 같이 쓴다.
//  목록 한 쪽은 MB 단위라 쪽을 크게(500) 받아 요청 수를 줄이고, 수천 건짜리 조회는 상한에서 자른다(truncated — '최근 N건 기준').
import { api, type GenCursor } from "../api";
import type { GenQuery, Generation } from "../types";

export const FETCH_ALL_PAGE = 500;
export const FETCH_ALL_MAX = 2000; // 이만큼까지(4쪽)

/** alive() 가 거짓이면(창을 닫았거나 다른 조회로) 다음 쪽을 받지 않고 null. */
export async function fetchAllGenerations(
  query: GenQuery, alive: () => boolean,
): Promise<{ gens: Generation[]; truncated: boolean } | null> {
  const all: Generation[] = [];
  let cursor: GenCursor | null = null;
  for (;;) {
    const page: Generation[] = await api.listGenerations(query, cursor, FETCH_ALL_PAGE);
    if (!alive()) return null;
    all.push(...page);
    if (page.length < FETCH_ALL_PAGE) return { gens: all, truncated: false };
    if (all.length >= FETCH_ALL_MAX) return { gens: all, truncated: true };
    const last = page[page.length - 1];
    cursor = { ts: last.sort_ts ?? 0, id: last.id };
  }
}
