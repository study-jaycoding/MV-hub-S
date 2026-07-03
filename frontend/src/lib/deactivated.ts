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
// 강제 비활성화(토글 아님) — '생략'으로 옮긴 작업의 컷을 모두 회색 처리할 때. 이미 꺼진 건 유지.
export const addDisabledGen = (ids: string[]): void => {
  if (!ids.length) return;
  const s = loadDisabledGen();
  ids.forEach((id) => s.add(id));
  saveDisabledGen(s);
};
// 강제 재활성화(토글 아님) — '생략'에서 빼낸 작업의 컷을 다시 켤 때. 실제로 바뀐 게 있을 때만 저장.
export const removeDisabledGen = (ids: string[]): void => {
  if (!ids.length) return;
  const s = loadDisabledGen();
  let changed = false;
  ids.forEach((id) => {
    if (s.delete(id)) changed = true;
  });
  if (changed) saveDisabledGen(s);
};

export const loadDisabledAssets = (): Set<string> => read(ASSET_KEY);
export const saveDisabledAssets = (s: Set<string>): void => write(ASSET_KEY, s);
export const toggleDisabledAssets = (paths: string[]): void =>
  toggle(loadDisabledAssets, saveDisabledAssets, paths);

// ── 폴더 단위 비활성화(생략) ─────────────────────────────────────────────
// 생성물 id 스냅샷(위)과 달리 '폴더 경로'를 저장 → 그 폴더(및 하위)에 나중에 생성한 것도 자동 포함.
// projectId 별 최소 집합(부모가 걸려 있으면 자식은 저장하지 않음). 로컬 전용, DISABLED_EVENT 공유.
const FOLDER_KEY = STORAGE_KEYS.disabledFolders;
export type DisabledFolders = Record<string, string[]>;

// 렌더 루트 상대 경로 정규화 — 백슬래시/중복슬래시/앞뒤슬래시/. .. 제거(백엔드 clean_folder_path 규칙과 정합).
export function normalizeFolderPath(path: string | null | undefined): string {
  return (path || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");
}

export function loadDisabledFolders(): DisabledFolders {
  try {
    return loadJSON<DisabledFolders>(FOLDER_KEY) ?? {};
  } catch {
    return {};
  }
}
function saveDisabledFolders(f: DisabledFolders): void {
  saveJSON(FOLDER_KEY, f);
  dispatchAppEvent(DISABLED_EVENT);
}

// 이 폴더가 비활성인가 — 자신 또는 조상 폴더가 목록에 있으면 true(하위 폴더 자동 포함).
export function isFolderDisabled(
  f: DisabledFolders,
  projectId: string | null | undefined,
  path: string | null | undefined,
): boolean {
  if (!projectId) return false;
  const list = f[projectId];
  if (!list || !list.length) return false;
  const p = normalizeFolderPath(path);
  return list.some((d) => p === d || p.startsWith(d + "/"));
}

// 폴더 비활성 토글 — 정확히 이 경로가 목록에 있으면 해제, 조상 때문에 이미 걸려 있으면 no-op(부모에서 토글),
// 아니면 추가하며 이 폴더의 자식(중복)은 제거해 최소 집합 유지.
export function toggleDisabledFolder(projectId: string, path: string): void {
  const norm = normalizeFolderPath(path);
  if (!norm) return;
  const f = loadDisabledFolders();
  const list = f[projectId] ? [...f[projectId]] : [];
  if (list.includes(norm)) {
    const next = list.filter((d) => d !== norm);
    if (next.length) f[projectId] = next;
    else delete f[projectId];
    saveDisabledFolders(f);
    return;
  }
  // 조상이 이미 걸려 있으면 이미 회색 → 중복 추가하지 않음(부모에서 해제하도록).
  if (list.some((d) => norm.startsWith(d + "/"))) return;
  const next = list.filter((d) => !(d === norm || d.startsWith(norm + "/")));
  next.push(norm);
  f[projectId] = next;
  saveDisabledFolders(f);
}
