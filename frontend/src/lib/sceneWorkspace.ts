// 씬(캔버스)별 워크스페이스 지정 — 순수 규칙(React·API·저장소 의존 없음).
//
// 뜻(Jay 2026-09-11): "여러 캔버스가 있어도 이 워크스페이스의 캔버스는 이것들이다" 를 한눈에 보이게 한다.
// 씬 탭을 우클릭해 팀 워크스페이스를 지정하면, **다른 공간을 보고 있을 때 그 탭이 회색**으로 보이고
// 누르면 그 공간으로 바뀐다. 지정하지 않은 씬은 어디서나 정상으로 보인다(기존 씬이 전부 회색이 되면 안 된다).
//
// ★지정은 개인 씬에 저장한다 — 원본은 브라우저 IndexedDB이며 팀 워크스페이스 설정을 바꾸지 않는다.
// ★개인 공간은 1차 제외(목록 구조가 달라 id 를 앱이 갖고 있지 않다). 팀 워크스페이스만 지정한다.
import type { Scene } from "./scenes";
import type { WorkspaceContext } from "../types";

/** 씬에 지정된 워크스페이스. 팀 공간만 — 이름은 표시 폴백이고 판정은 언제나 id 로 한다. */
export interface SceneWorkspace {
  id: string;
  name: string | null;
}

/** 저장값 정규화 — 모양이 아니면 '지정 없음'(undefined). 옛 백업·손상값을 관대하게 받는다. */
export function normalizeSceneWorkspace(value: unknown): SceneWorkspace | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { id?: unknown; name?: unknown };
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return undefined;
  return { id, name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : null };
}

/** 지금 보고 있는 공간이 이 씬의 공간인가. 지정 없음·공간 미확정(unknown)은 '맞음'으로 본다. */
export function sceneMatchesWorkspace(
  scene: Pick<Scene, "workspace">,
  context: WorkspaceContext,
): boolean {
  const assigned = normalizeSceneWorkspace(scene.workspace);
  if (!assigned) return true;
  if (context.scope === "unknown") return true; // 아직 확정 전 — 깜빡임 방지(회색으로 만들지 않는다)
  return context.scope === "team" && (context.id || "") === assigned.id;
}

/** 탭을 회색으로 보여야 하는가 = 지정이 있고 지금 공간과 다름. */
export function sceneDimmed(scene: Pick<Scene, "workspace">, context: WorkspaceContext): boolean {
  return !sceneMatchesWorkspace(scene, context);
}

/** 탭에 보여줄 공간 이름 — 목록에 같은 id 가 있으면 **현재 이름**을 쓴다(관리자가 이름을 바꿔도 맞게).
 *  목록에 없으면 저장된 이름, 그것도 없으면 null(이름을 모름 = 접근 불가일 수 있다). */
export function sceneWorkspaceLabel(
  scene: Pick<Scene, "workspace">,
  options: readonly { id: string; name: string }[],
): string | null {
  const assigned = normalizeSceneWorkspace(scene.workspace);
  if (!assigned) return null;
  const known = options.find((item) => item.id === assigned.id);
  return known?.name || assigned.name || null;
}

/** 지정된 공간이 지금 계정에서 안 보이는가(삭제·권한 상실). 목록을 아직 못 받았으면 판정하지 않는다. */
export function sceneWorkspaceMissing(
  scene: Pick<Scene, "workspace">,
  options: readonly { id: string }[] | null,
): boolean {
  const assigned = normalizeSceneWorkspace(scene.workspace);
  if (!assigned || !options || !options.length) return false;
  return !options.some((item) => item.id === assigned.id);
}

/** 탭·보드 머리줄에 보여줄 짧은 이름 — 12자를 넘으면 자르고 … 를 붙인다(Jay 2026-09-14).
 *  폭(px)으로 자르지 않는 이유: 같은 190px 에 한글은 13자, 숫자는 22자가 들어가 글자 종류마다
 *  들쭉날쭉했다. 전체 이름은 두 곳 모두 title 로 본다.
 *  이름을 고치는 곳(우클릭 메뉴의 입력칸)에는 쓰지 않는다 — 값을 자르면 편집이 망가진다. */
export const SCENE_NAME_MAX_CHARS = 12;
export function shortSceneName(name: string): string {
  // 이모지가 반쪽으로 쪼개지지 않게 코드포인트 단위로 센다(slice 는 UTF-16 단위라 안 된다).
  const chars = Array.from(name);
  if (chars.length <= SCENE_NAME_MAX_CHARS) return name;
  return chars.slice(0, SCENE_NAME_MAX_CHARS).join("") + "…";
}

/** 탭 설명 글(이름 다음 줄부터). 줄 규칙은 NodeTip — 상태 줄 · '워크스페이스: 이름'. 앱 창은 '워크스페이스:' 줄을 표식으로 그린다
 *  (표식은 화면 읽기에서 숨겨져 있어 글에는 이름을 남긴다). 상태 색은 SceneBar 의 data-tip-tone 과 짝이다. 조작 안내는 없다 — 창의 단추가 대신한다(Jay 2026-11-02). */
export function sceneTabTitle(
  scene: Pick<Scene, "workspace">,
  context: WorkspaceContext,
  label: string | null,
  missing: boolean,
): string {
  const assigned = normalizeSceneWorkspace(scene.workspace);
  if (!assigned) return "";
  const line = `워크스페이스: ${label || "알 수 없는 공간"}`;
  if (missing) return `찾을 수 없는 워크스페이스 — 지금 계정에 이 공간이 없습니다\n${line}`;
  if (sceneDimmed(scene, context)) return `다른 워크스페이스 — 누르면 이 공간으로 바뀝니다\n${line}`;
  return line;
}

// ── 탭 순서 바꾸기(드래그) ────────────────────────────────────────────────
/** 끌고 있는 탭을 어느 자리에 놓을지 — 탭 사각형 목록과 포인터 좌표로 삽입 위치를 고른다.
 *  `.scene-bar` 는 flex-wrap 이라 여러 줄이 될 수 있다: **먼저 줄을 고르고(세로로 가장 가까운 줄),
 *  그 줄 안에서 중심 x 로 앞/뒤를 정한다.** 반환값은 '이 인덱스 앞에 넣는다'(길이 = 맨 뒤). */
export function dropIndexAt(
  rects: readonly { left: number; right: number; top: number; bottom: number }[],
  x: number,
  y: number,
): number {
  if (!rects.length) return 0;
  // 1) 포인터가 속한(또는 가장 가까운) 줄 — 세로 거리로 고른다.
  let bestRow = 0;
  let bestDy = Infinity;
  rects.forEach((rect, index) => {
    const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    if (dy < bestDy - 0.5) {
      bestDy = dy;
      bestRow = index;
    }
  });
  const rowTop = rects[bestRow].top;
  const rowBottom = rects[bestRow].bottom;
  const inRow = (rect: { top: number; bottom: number }) =>
    rect.bottom > rowTop && rect.top < rowBottom; // 세로로 겹치면 같은 줄
  // 2) 그 줄 안에서 중심 x 를 넘어선 첫 탭 앞에 넣는다.
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index];
    if (!inRow(rect)) continue;
    if (x < (rect.left + rect.right) / 2) return index;
  }
  // 줄의 마지막 탭 뒤 = 그 줄 마지막 인덱스 + 1
  let last = -1;
  rects.forEach((rect, index) => {
    if (inRow(rect)) last = index;
  });
  return last < 0 ? rects.length : last + 1;
}

/** 배열에서 from 을 떼어 to(삽입 위치) 앞에 넣는다. 바뀌지 않으면 같은 배열을 그대로 돌려준다. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length) return items as T[];
  const target = Math.max(0, Math.min(to, items.length));
  if (target === from || target === from + 1) return items as T[];
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(target > from ? target - 1 : target, 0, moved);
  return next;
}

/** 드래그 결과를 '이 씬을 저 씬 앞으로'라는 **연산**으로 표현한다(목록 스냅샷을 넘기지 않는다).
 *  저장 시점에 최신 목록을 다시 읽어 적용해야, 끌던 사이에 다른 창·백업 복구가 추가한 씬이 사라지지 않는다. */
export interface SceneMove {
  id: string; // 옮길 씬
  beforeId: string | null; // 이 씬 앞에 놓는다. null = 맨 뒤
}

/** 최신 목록에 이동 연산을 적용. 대상이 사라졌으면 null(호출자가 취소). ID 집합·내용은 그대로 둔다. */
export function applySceneMove(scenes: readonly Scene[], move: SceneMove): Scene[] | null {
  const from = scenes.findIndex((scene) => scene.id === move.id);
  if (from < 0) return null;
  let to = scenes.length;
  if (move.beforeId) {
    const at = scenes.findIndex((scene) => scene.id === move.beforeId);
    if (at < 0) return null;
    to = at;
  }
  const next = moveItem(scenes, from, to);
  return next === scenes ? null : next;
}

// ── 탭 폴더(Jay 2026-11-11) ──────────────────────────────────────────────
// 폴더 = 같은 Scene.tabFolder(id·이름)를 든 씬들. 폴더 목록·폴더 순서는 따로 저장하지 않는다 —
//  폴더는 첫 탭의 순서 자리에 놓이고, 이름은 첫 탭이 든 것을 쓴다. 넣고 빼기는 끌기로만(SceneBar).

/** 탭 폴더 — 판정은 id, 이름은 표시용. */
export interface TabFolder {
  id: string;
  name: string;
}

/** 저장값 정규화 — 모양이 아니면 폴더 없음(옛 백업·손상값은 그냥 줄의 탭으로). 이름이 비면 '폴더'. */
export function normalizeTabFolder(value: unknown): TabFolder | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { id, name } = value as { id?: unknown; name?: unknown };
  if (typeof id !== "string" || !id) return undefined;
  return { id, name: typeof name === "string" && name.trim() ? name : "폴더" };
}

/** 탭 줄 한 칸. inFolder = 폴더 안이지만 그 폴더 바로 뒤에 꺼내 보이는 탭(지금 보는 탭, 아니면 그 폴더에서 마지막으로 연 탭). */
export type TabRowItem =
  | { kind: "tab"; key: string; scene: Scene; inFolder?: TabFolder }
  | { kind: "folder"; key: string; folder: TabFolder; members: Scene[] };

/** 탭 줄 차례 — 폴더는 첫 탭 자리에 한 번, 그 폴더의 보는 탭(없으면 shownByFolder 의 마지막으로 연 탭)은 폴더 바로 뒤,
 *  빈 폴더(이 창에서 막 만든 것)는 맨 뒤. */
export function tabRowItems(
  scenes: readonly Scene[],
  activeId: string | null,
  emptyFolders: readonly TabFolder[] = [],
  shownByFolder: Readonly<Record<string, string>> = {},
): TabRowItem[] {
  const items: TabRowItem[] = [];
  const folders = new Map<string, Extract<TabRowItem, { kind: "folder" }>>();
  for (const scene of scenes) {
    const folder = normalizeTabFolder(scene.tabFolder);
    if (!folder) {
      items.push({ kind: "tab", key: `t:${scene.id}`, scene });
      continue;
    }
    let item = folders.get(folder.id);
    if (!item) {
      item = { kind: "folder", key: `f:${folder.id}`, folder, members: [] };
      folders.set(folder.id, item);
      items.push(item);
    }
    item.members.push(scene);
  }
  for (const item of folders.values()) {
    const shown = item.members.find((scene) => scene.id === activeId) ?? item.members.find((scene) => scene.id === shownByFolder[item.folder.id]);
    if (shown) items.splice(items.indexOf(item) + 1, 0, { kind: "tab", key: `t:${shown.id}`, scene: shown, inFolder: item.folder });
  }
  const shown = new Set(folders.keys());
  for (const folder of emptyFolders) {
    if (shown.has(folder.id)) continue;
    shown.add(folder.id);
    items.push({ kind: "folder", key: `f:${folder.id}`, folder, members: [] });
  }
  return items;
}

/** 폴더 연산 — 탭 순서처럼 최신 목록 위에서 다시 적용된다(updateScenesWith). 바뀔 것이 없거나 대상이 사라졌으면 null(저장 안 함). */
export type TabFolderOp =
  // 그 씬을 폴더에 넣거나(folder null = 빼기) beforeId 앞으로 옮긴다(null = 맨 뒤, 자기 id = 제자리)
  | { type: "put"; id: string; folder: TabFolder | null; beforeId: string | null }
  | { type: "rename"; folderId: string; name: string }
  // 폴더 풀기 — 안의 탭은 제 순서 자리에서 줄로 나온다
  | { type: "ungroup"; folderId: string }
  // 폴더째 옮기기 — 안의 탭 순서는 그대로 beforeId 앞에 모인다
  | { type: "moveFolder"; folderId: string; beforeId: string | null }
  // 폴더 안 순서 — 그 씬을 같은 폴더의 beforeId 앞으로(null = 폴더 맨 끝). 폴더 탭들이 차지한 자리 안에서만 바꿔 폴더 자리는 그대로다
  | { type: "order"; folderId: string; id: string; beforeId: string | null };

function withTabFolder(scene: Scene, folder: TabFolder | undefined): Scene {
  if (folder) return { ...scene, tabFolder: { id: folder.id, name: folder.name } };
  const next = { ...scene };
  delete next.tabFolder;
  return next;
}

const inTabFolder = (scene: Scene, folderId: string) => normalizeTabFolder(scene.tabFolder)?.id === folderId;

export function applyTabFolderOp(scenes: readonly Scene[], op: TabFolderOp): Scene[] | null {
  if (op.type === "put") {
    const from = scenes.findIndex((scene) => scene.id === op.id);
    if (from < 0) return null;
    const to = op.beforeId ? scenes.findIndex((scene) => scene.id === op.beforeId) : scenes.length;
    if (to < 0) return null;
    const current = normalizeTabFolder(scenes[from].tabFolder);
    const same = op.folder ? current?.id === op.folder.id && current.name === op.folder.name : !current;
    const placed: readonly Scene[] = same
      ? scenes
      : scenes.map((scene, index) => (index === from ? withTabFolder(scene, op.folder ?? undefined) : scene));
    const next = moveItem(placed, from, to);
    return next === scenes ? null : next;
  }
  if (op.type === "moveFolder") {
    const members = scenes.filter((scene) => inTabFolder(scene, op.folderId));
    if (!members.length || members.some((scene) => scene.id === op.beforeId)) return null;
    const rest = scenes.filter((scene) => !inTabFolder(scene, op.folderId));
    const at = op.beforeId ? rest.findIndex((scene) => scene.id === op.beforeId) : rest.length;
    if (at < 0) return null;
    const next = [...rest.slice(0, at), ...members, ...rest.slice(at)];
    return next.every((scene, index) => scene === scenes[index]) ? null : next;
  }
  if (op.type === "order") {
    const slots = scenes.flatMap((scene, index) => (inTabFolder(scene, op.folderId) ? [index] : []));
    const members = slots.map((index) => scenes[index]);
    const from = members.findIndex((scene) => scene.id === op.id);
    const to = op.beforeId ? members.findIndex((scene) => scene.id === op.beforeId) : members.length;
    if (from < 0 || to < 0) return null;
    const moved = moveItem(members, from, to);
    if (moved === members) return null;
    const next = scenes.slice();
    slots.forEach((slot, index) => {
      next[slot] = moved[index];
    });
    return next;
  }
  const name = op.type === "rename" ? op.name.trim() : "";
  if (op.type === "rename" && !name) return null;
  let changed = false;
  const next = scenes.map((scene) => {
    if (!inTabFolder(scene, op.folderId) || (op.type === "rename" && scene.tabFolder?.name === name)) return scene;
    changed = true;
    return withTabFolder(scene, op.type === "rename" ? { id: op.folderId, name } : undefined);
  });
  return changed ? next : null;
}
