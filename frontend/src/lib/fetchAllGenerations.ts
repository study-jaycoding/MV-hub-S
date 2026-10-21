// 한 조회의 목록을 커서로 끝까지 받는다(상한까지) — 컷 정보 창과 '목록에서 직접 묶는 폴더 카드'(lib/useLocalFolderCards)가 같이 쓴다.
//  목록 한 쪽은 MB 단위라 쪽을 크게(500) 받아 요청 수를 줄이고, 수천 건짜리 조회는 상한에서 자른다(truncated — '최근 N건 기준').
import { api, type GenCursor } from "../api";
import type { GenQuery, Generation } from "../types";
import { timedLibraryRequest } from "./libraryRequestTimeout";

export const FETCH_ALL_PAGE = 500;
export const FETCH_ALL_MAX = 2000; // 이만큼까지(4쪽)

/** 한 쪽(FETCH_ALL_PAGE 건) — 쪽마다 30초 제한 + 실제 취소(본문 읽기까지). 멈춘 요청이 폴더 카드의 한 줄 대기열을 끝없이 막았다(81회차 F-B-03). */
export function fetchGenerationsPage(query: GenQuery, cursor: GenCursor | null, opts: { leanPrompt?: boolean } = {}): Promise<Generation[]> {
  return timedLibraryRequest((signal) => api.listGenerations(query, cursor, FETCH_ALL_PAGE, { ...opts, signal }));
}

/** alive() 가 거짓이면(창을 닫았거나 다른 조회로) 다음 쪽을 받지 않고 null. leanPrompt = 프롬프트를 빈 글로 받는다(읽지 않는 곳만 — api.listGenerations).
 *  firstPage = 이미 받은 첫 쪽(서버가 준 그대로 — 공간 필터 전) — 다시 받지 않고 그 뒤부터 잇는다. 다음 커서·끝·상한은 **원본** 건수와 마지막 행으로
 *  센다(거른 뒤의 건수로 세면 499건을 '마지막 쪽'으로 잘못 보고 뒤를 놓친다). 돌려주는 first = 받은 첫 쪽 원본(다음 확인의 비교 기준). */
export async function fetchAllGenerations(
  query: GenQuery, alive: () => boolean, opts: { leanPrompt?: boolean; firstPage?: Generation[] } = {},
): Promise<{ gens: Generation[]; truncated: boolean; first: Generation[] } | null> {
  const { firstPage, ...ask } = opts;
  const all: Generation[] = [];
  let first: Generation[] | null = null;
  let cursor: GenCursor | null = null;
  for (;;) {
    const page: Generation[] = first === null && firstPage ? firstPage : await fetchGenerationsPage(query, cursor, ask);
    if (!alive()) return null;
    first ??= page;
    all.push(...page);
    if (page.length < FETCH_ALL_PAGE) return { gens: all, truncated: false, first };
    if (all.length >= FETCH_ALL_MAX) return { gens: all, truncated: true, first };
    const last = page[page.length - 1];
    cursor = { ts: last.sort_ts ?? 0, id: last.id };
  }
}
