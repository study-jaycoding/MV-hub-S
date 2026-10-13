// 공유 & 리뷰 탭의 에피소드 화면(프로젝트 맨 위처럼 '들어가는' 폴더가 놓인 단계) — 순수 규칙.
//  리스트 보기 = 에피소드마다 가로 한 줄, 그리드 보기 = 컷 띠가 붙은 카드(Jay 2026-10-13). 컷 화면(겹친 종이 카드)과 확실히 다르게 보이려는 것이다.
//  숫자(영상 수·대표 정한 컷·마지막 공유)와 컷 띠는 서버가 알려 줄 때만 그린다 — 옛 공유 서버면 그 표시만 빠진다.
import type { FolderCard, FolderCardChild } from "../types";

export type EpisodeLayout = "list" | "grid";

// 컷 띠에 그리는 컷 수 — 리스트는 두 줄(4칸 × 2, 마지막 칸은 '+N'), 그리드는 한 줄.
const STRIP_SHOWN: Record<EpisodeLayout, number> = { list: 7, grid: 5 };

/** 이 단계가 에피소드 화면인가 — 하위 폴더를 가진 카드가 하나라도 있으면(= 두 번 클릭이 '들어가기'인 카드가 놓인 단계). */
export function isEpisodeLevel(folders: readonly FolderCard[]): boolean {
  return folders.some((folder) => (folder.subfolders ?? 0) > 0);
}

/** 카드에 크게 얹는 번호 — 이름의 마지막 숫자 덩어리("e020" → "20", "e003" → "03"). 숫자가 없으면 빈 글자. */
export function episodeNumber(name: string): string {
  const digits = name.match(/\d+(?!.*\d)/)?.[0];
  return digits ? String(Number(digits)).padStart(2, "0") : "";
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

/** 대표를 정한 컷 수 / 컷 수 — 서버가 알려 주고 컷이 있을 때만. */
export function repProgress(folder: FolderCard): { done: number; total: number } | null {
  const total = folder.subfolders ?? 0;
  if (folder.rep_count == null || total <= 0) return null;
  return { done: Math.min(folder.rep_count, total), total };
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
