// 씬(캔버스)별 워크스페이스 지정 — 순수 규칙(React·API·저장소 의존 없음).
//
// 뜻(Jay 2026-09-11): "여러 캔버스가 있어도 이 워크스페이스의 캔버스는 이것들이다" 를 한눈에 보이게 한다.
// 씬 탭을 우클릭해 팀 워크스페이스를 지정하면, **다른 공간을 보고 있을 때 그 탭이 회색**으로 보이고
// 누르면 그 공간으로 바뀐다. 지정하지 않은 씬은 어디서나 정상으로 보인다(기존 씬이 전부 회색이 되면 안 된다).
//
// ★지정은 이 브라우저에만 남는다 — 씬 자체가 localStorage 저장이라 PC·브라우저 프로필마다 다르다.
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

/** 탭 title(마우스를 올렸을 때). 상태별로 다른 문장을 준다. */
export function sceneTabTitle(
  scene: Pick<Scene, "workspace">,
  context: WorkspaceContext,
  label: string | null,
  missing: boolean,
): string {
  const base = "클릭=열기 · 더블클릭=이름 변경 · 끌어서 순서 · 우클릭=워크스페이스";
  const assigned = normalizeSceneWorkspace(scene.workspace);
  if (!assigned) return base;
  const name = label || "알 수 없는 공간";
  if (missing) return `이 캔버스의 워크스페이스(${name})를 지금 계정에서 찾을 수 없습니다.\n${base}`;
  if (sceneDimmed(scene, context)) {
    return `이 캔버스는 '${name}' 워크스페이스입니다 — 누르면 그 공간으로 바뀝니다.\n${base}`;
  }
  return `워크스페이스: ${name}\n${base}`;
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
