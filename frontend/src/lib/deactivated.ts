// 비활성화(회색) 표시 — 시각 전용 로컬 상태. 서버는 모른다(생성물 color 필드와 별개).
//   생성물 = gen id 기준, 에셋 = path 기준. 둘 다 localStorage 영속.
//   생성물 키는 보드(HistoryBoard)가 쓰던 키와 동일 → 보드에서 끄든 라이브러리에서 끄든 한 소스 공유.
//   어디서 토글하든 DISABLED_EVENT 를 쏘아 다른 화면(App·보드·에셋뷰)이 즉시 재조회한다.

import { APP_EVENTS, dispatchAppEvent } from "./appEvents";
import { normalizeFolderPath } from "./folderTreeModel";
import { loadJSON, removeStorage, saveJSON, trySaveJSON } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

export { normalizeFolderPath } from "./folderTreeModel";

const GEN_KEY = STORAGE_KEYS.historyDisabled;
const GEN_KEY_OLD = STORAGE_KEYS.historyDisabledLegacy; // 리네임 전 저장값 1회 폴백
const ASSET_KEY = STORAGE_KEYS.assetsDisabled;

export const DISABLED_EVENT = APP_EVENTS.disabledChanged;

// 생성물 회색 바뀜 번호 — 이 창이 저장할 때와 다른 창의 storage 알림 때 오른다. MV Agent 화면 동작의 되돌리기가
//  '그 뒤 다른 회색 변경 없음'을 본다(풀었다 다시 회색으로 한 것은 지금 값만으로 구별 못 하므로 — docs/status/MVAgent_화면동작_2026-11-12.md 3-3).
let genRev = 0;
export const disabledGenRev = (): number => genRev;
// 저장마다 새로 적는 고유 표식 — 다른 창이 풀었다 다시 회색으로 해 값이 같아지고 알림이 늦어도 바뀐 것을 안다(화면 동작 독립 리뷰 P1)
//  값보다 **먼저** 쓴다(값을 쓰다 멈춰도 표식은 이미 바뀌어 있다). 표식 쓰기가 실패하면 지워서 빈 값 — 기록해 둔 표식과 달라진다.
const GEN_STAMP_KEY = `${GEN_KEY}.stamp`;
export const disabledGenStamp = (): string => loadJSON<string>(GEN_STAMP_KEY) ?? "";
/** 새 표식을 쓰고 그 값을 준다 — 못 쓰면 지우고 ""(빈 표식은 되돌리기 자격이 아니다). */
const bumpGenStamp = (): string => {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  if (trySaveJSON(GEN_STAMP_KEY, stamp)) return stamp;
  removeStorage(GEN_STAMP_KEY);
  return "";
};

/** 생성물 회색 저장 — 표식 먼저, 값 다음. 값 저장이 됐는지·이번에 쓴 표식을 돌려준다(화면 동작 되돌리기가 '내 저장 실패'를 가른다). */
function writeGen(s: Set<string>): { saved: boolean; stamp: string } {
  const stamp = bumpGenStamp();
  const saved = trySaveJSON(GEN_KEY, [...s]);
  genRev += 1;
  dispatchAppEvent(DISABLED_EVENT);
  return { saved, stamp };
}

/** 목표 상태로(뒤집기 아님) — MV Agent 화면 동작과 그 되돌리기용. 저장 결과를 돌려준다. */
export function setDisabledGen(ids: string[], hidden: boolean): { saved: boolean; stamp: string } {
  const s = loadDisabledGen();
  ids.forEach((id) => (hidden ? s.add(id) : s.delete(id)));
  return writeGen(s);
}

function read(key: string, oldKey?: string): Set<string> {
  try {
    return new Set(loadJSON<string[]>(key) ?? (oldKey ? loadJSON<string[]>(oldKey) : null) ?? []);
  } catch {
    return new Set();
  }
}

function write(key: string, s: Set<string>): void {
  if (key === GEN_KEY) return void writeGen(s);
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

// 다른 창이 바꾼 비활성도 같은 신호로 알린다 — 전엔 같은 창의 신호만 들어, 다른 창에서 끈 카드·폴더가 이 창에서는 새로 고칠 때까지 그대로였다.
//  storage 이벤트는 다른 창의 저장에만 온다(이 창의 저장은 위에서 직접 알린다).
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === GEN_KEY) genRev += 1;
    if (event.key === GEN_KEY || event.key === ASSET_KEY || event.key === FOLDER_KEY) dispatchAppEvent(DISABLED_EVENT);
  });
}
