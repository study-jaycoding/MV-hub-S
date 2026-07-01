// 비활성화(회색) 표시 — 시각 전용 로컬 상태. 서버는 모른다(생성물 color 필드와 별개).
//   생성물 = gen id 기준, 에셋 = path 기준. 둘 다 localStorage 영속.
//   생성물 키는 보드(HistoryBoard)가 쓰던 키와 동일 → 보드에서 끄든 라이브러리에서 끄든 한 소스 공유.
//   어디서 토글하든 DISABLED_EVENT 를 쏘아 다른 화면(App·보드·에셋뷰)이 즉시 재조회한다.

import { APP_EVENTS, dispatchAppEvent } from "./appEvents";
import { loadJSON, saveJSON } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

const GEN_KEY = STORAGE_KEYS.historyDisabled;
const GEN_KEY_OLD = STORAGE_KEYS.historyDisabledLegacy; // 리네임 전 저장값 1회 폴백
const ASSET_KEY = STORAGE_KEYS.assetsDisabled;

export const DISABLED_EVENT = APP_EVENTS.disabledChanged;

function read(key: string, oldKey?: string): Set<string> {
  try {
    return new Set(loadJSON<string[]>(key) ?? (oldKey ? loadJSON<string[]>(oldKey) : null) ?? []);
  } catch {
    return new Set();
  }
}

function write(key: string, s: Set<string>): void {
  saveJSON(key, [...s]);
  dispatchAppEvent(DISABLED_EVENT);
}

// 선택 항목 일괄 토글: 전부 켜져 있으면 끄기, 아니면 켜기(보드의 기존 동작과 동일).
function toggle(load: () => Set<string>, save: (s: Set<string>) => void, keys: string[]): void {
  if (!keys.length) return;
  const s = load();
  const allOn = keys.every((k) => s.has(k));
  keys.forEach((k) => (allOn ? s.delete(k) : s.add(k)));
  save(s);
}

export const loadDisabledGen = (): Set<string> => read(GEN_KEY, GEN_KEY_OLD);
export const saveDisabledGen = (s: Set<string>): void => write(GEN_KEY, s);
export const toggleDisabledGen = (ids: string[]): void => toggle(loadDisabledGen, saveDisabledGen, ids);

export const loadDisabledAssets = (): Set<string> => read(ASSET_KEY);
export const saveDisabledAssets = (s: Set<string>): void => write(ASSET_KEY, s);
export const toggleDisabledAssets = (paths: string[]): void =>
  toggle(loadDisabledAssets, saveDisabledAssets, paths);
