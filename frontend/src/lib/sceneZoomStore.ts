import { useSyncExternalStore } from "react";

// 캔버스 확대 % — 휠 확대마다 App 전체가 다시 그려지지 않게 React 밖에 두고, 툴바의 % 글자만 구독한다.
let pct = 100;
const listeners = new Set<() => void>();

export const getSceneZoomPct = () => pct;

export function subscribeSceneZoomPct(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setSceneZoomPct(next: number): void {
  if (next === pct) return;
  pct = next;
  for (const listener of listeners) listener();
}

export const useSceneZoomPct = () => useSyncExternalStore(subscribeSceneZoomPct, getSceneZoomPct);
