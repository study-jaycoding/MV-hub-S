// 공유 & 리뷰 탭의 폴더 카드 화면 — 줄·카드·표의 순수 규칙.
//  에피소드 화면(프로젝트 맨 위처럼 '들어가는' 폴더가 놓인 단계): 리스트 보기 = 에피소드마다 가로 한 줄, 그리드 보기 = 컷 띠가 붙은 카드
//  (Jay 2026-10-13). 컷 화면도 같은 큰 카드를 쓰되 띠에는 컷 대신 그 컷의 생성물을 싣는다.
//  리스트 단추 한 번 = 줄, 한 번 더 = 표.
//  숫자(영상 수·대표 정한 컷·마지막 공유·검토 개수·작업자)와 띠는 서버가 알려 줄 때만 그린다 — 옛 공유 서버면 그 표시만 빠진다.
import type { FolderCard, FolderCardChild, FolderCardTake } from "../types";

export type EpisodeLayout = "list" | "grid" | "table";

// 컷 띠에 그리는 컷 수 — 리스트는 두 줄(4칸 × 2, 마지막 칸은 '+N'), 그리드는 한 줄. 표에는 띠가 없다.
export const STRIP_SHOWN: Record<EpisodeLayout, number> = { list: 7, grid: 5, table: 0 };
export const EPISODE_CARD_WIDTH = 340;
// 컷 줄의 생성물 띠 — 두 줄(5칸 × 2). 다 못 실으면 마지막 칸은 '+N'.
const TAKES_SHOWN = 10;

/** 이 단계가 에피소드 화면인가 — 하위 폴더를 가진 카드가 하나라도 있으면(= 두 번 클릭이 '들어가기'인 카드가 놓인 단계). */
export function isEpisodeLevel(folders: readonly FolderCard[]): boolean {
  return folders.some((folder) => (folder.subfolders ?? 0) > 0);
}

/** 이 화면을 어느 모양으로 그리나 — 리스트 단추 한 번 = 줄, 한 번 더(table) = 표. 그리드는 모든 단계에서 같은 큰 카드. */
export function boardView(_folders: readonly FolderCard[], layout: "grid" | "list", table: boolean): EpisodeLayout {
  if (layout === "list") return table ? "table" : "list";
  return "grid";
}

/** 줄·카드에 크게 얹는 번호 — 이름의 마지막 숫자 덩어리를 **쓴 그대로**("e003" → "003", "C0010" → "0010" — Jay 2026-10-13 오후. 전엔 두 자리로
 *  줄여 "03" 이었다). 숫자가 없으면 빈 글자. */
export function episodeNumber(name: string): string {
  return name.match(/\d+(?!.*\d)/)?.[0] ?? "";
}

/** 번호 칸의 폭·글자 크기(px) — 이 화면에서 가장 긴 번호에 맞춘다(모든 줄의 번호가 같은 칸에 선다). */
export function numberColumn(folders: readonly FolderCard[]): { width: number; size: number } {
  const longest = folders.reduce((max, folder) => Math.max(max, episodeNumber(folder.name).length), 0);
  if (longest <= 2) return { width: 50, size: 34 };
  if (longest === 3) return { width: 66, size: 30 };
  return { width: 74, size: 22 };
}

export interface EpisodeStrip {
  cuts: FolderCardChild[];
  more: number; // 띠에 못 실은 컷 수 — '+N' 칸(누르면 그 에피소드로 들어간다)
}

/** 컷 띠 — 서버가 미리보기를 안 주면(옛 서버) null. */
export function stripOf(folder: FolderCard, layout: EpisodeLayout): EpisodeStrip | null {
  if (!folder.children) return null;
  const cuts = folder.children.slice(0, STRIP_SHOWN[layout]);
  return { cuts, more: Math.max(0, (folder.subfolders ?? 0) - cuts.length) };
}

export interface TakeStrip {
  takes: FolderCardTake[];
  more: number; // 띠에 못 실은 생성물 수 — '+N' 칸(누르면 그 컷 폴더로 간다)
}

/** 컷의 생성물 띠 — 옛 서버는 null. 그리드는 5장 + 잔여 수, 리스트는 기존 10칸 중 마지막을 '+N'에 내준다. */
export function takesOf(folder: FolderCard, layout: EpisodeLayout = "list"): TakeStrip | null {
  if (!folder.takes || (folder.subfolders ?? 0) > 0) return null;
  if (layout === "grid") {
    const takes = folder.takes.slice(0, STRIP_SHOWN.grid);
    return { takes, more: Math.max(0, folder.count - takes.length) };
  }
  if (folder.count <= folder.takes.length) return { takes: folder.takes.slice(0, TAKES_SHOWN), more: 0 };
  const takes = folder.takes.slice(0, TAKES_SHOWN - 1);
  return { takes, more: folder.count - takes.length };
}

/** 대표를 정한 컷 수 / 컷 수 — 서버가 알려 주고 컷이 있을 때만. */
export function repProgress(folder: FolderCard): { done: number; total: number } | null {
  const total = folder.subfolders ?? 0;
  if (folder.rep_count == null || total <= 0) return null;
  return { done: Math.min(folder.rep_count, total), total };
}

/** 그 폴더 안의 검토 개수(공유·최종·보류 — 사이드바 폴더 숫자와 같은 규칙) — 서버가 안 주면(옛 서버) null. */
export function reviewCounts(folder: FolderCard): { shared: number; final: number; held: number } | null {
  const { final_count: final, held_count: held } = folder;
  if (final == null || held == null) return null;
  return { shared: Math.max(0, folder.count - final - held), final, held };
}

/** 마지막 공유가 얼마나 전인가 — 글자는 화면이 번역해 붙인다. */
export interface Ago {
  unit: "now" | "min" | "hour" | "yesterday" | "day";
  n: number;
}

/** 서버의 UTC 시각("YYYY-MM-DD HH:MM:SS")을 지금 기준의 '얼마 전'으로. 읽지 못하면 null. */
export function sharedAgo(utc: string | null | undefined, now: number): Ago | null {
  if (!utc) return null;
  const iso = utc.includes("T") ? utc : utc.replace(" ", "T");
  const at = Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z");
  if (Number.isNaN(at)) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return { unit: "now", n: 0 };
  if (minutes < 60) return { unit: "min", n: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hour", n: hours };
  const days = Math.floor(hours / 24);
  return days === 1 ? { unit: "yesterday", n: 1 } : { unit: "day", n: days };
}
