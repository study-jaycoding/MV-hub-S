// 모아보기 '연결' 재생기의 계산(순수) — 클립 길이 배열로 시작 시각·위치 찾기·타임코드. 화면은 components/CutReel.
import type { FolderCard } from "../types";
import { thumbOf } from "./media";
import { workerLabel } from "./cutSummary";

export const REEL_IMAGE_SEC = 3; // 대표가 이미지인 컷(과 재생 못 하는 영상)은 이 길이로 멈춘 화면(Jay 2026-10-08 '가')

export interface ReelClip {
  path: string; // 컷 폴더 경로(키)
  name: string; // C0080
  url: string;
  type: "image" | "video";
  thumb: string | null;
  worker: string;
  rep: boolean; // 팀이 정한 대표인가(아니면 최신 것)
}

// 컷 카드 → 클립. 표지에 파일이 없는 카드는 뺀다(재생할 것이 없다).
export function reelClips(folders: FolderCard[]): ReelClip[] {
  const clips: ReelClip[] = [];
  for (const folder of folders) {
    const asset = folder.cover.assets?.[0];
    if (!asset?.file_path) continue;
    clips.push({
      path: folder.path, name: folder.name, url: asset.file_path, type: asset.type === "video" ? "video" : "image",
      thumb: thumbOf(folder.cover, 512), worker: workerLabel(folder.cover), rep: folder.rep,
    });
  }
  return clips;
}

// 각 클립의 시작 시각(앞 클립 길이의 합).
export function reelStarts(durations: number[]): number[] {
  const starts: number[] = [];
  let acc = 0;
  for (const d of durations) {
    starts.push(acc);
    acc += d;
  }
  return starts;
}

// 가상 시각 → 어느 클립의 몇 초인가. 끝을 넘으면 마지막 클립의 끝.
export function reelLocate(durations: number[], vt: number): { index: number; offset: number } {
  if (!durations.length) return { index: 0, offset: 0 };
  const total = durations.reduce((a, b) => a + b, 0);
  const clamped = Math.max(0, Math.min(vt, total));
  let acc = 0;
  for (let i = 0; i < durations.length; i++) {
    if (clamped < acc + durations[i]) return { index: i, offset: clamped - acc };
    acc += durations[i];
  }
  const lastIndex = durations.length - 1;
  return { index: lastIndex, offset: durations[lastIndex] };
}

// "m:ss.s" — 편집 탭 뷰어의 시계와 같은 꼴. 음수·NaN 은 0.
export function fmtReelTime(sec: number): string {
  const s = Number.isFinite(sec) && sec > 0 ? sec : 0;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, "0")}`;
}
