import type { Project } from "../types";
import { getAccountNamespace } from "./accountScope";
import { EXPECT_ACCOUNT_HEADER } from "./hubFeatures";
import { HttpError, isRouteMissing, jsonFetch } from "./http";
import {
  confirmSceneWrite, exportSceneKeepText, parseSceneImport,
  type Scene, type SceneCard, type SceneCardKind, type SceneSnapshot,
} from "./scenes";

export type SceneKeepPreview = [SceneCardKind, number, number, number, number][];
export type SceneKeepWorkspace = { id: string; name: string | null };
export interface SceneKeepRow {
  id: string;
  name: string;
  description: string;
  project_id: string;
  project_name: string | null;
  workspace: SceneKeepWorkspace | null;
  node_count: number;
  preview: SceneKeepPreview;
  missing_count: number;
  revision: number;
  updated_at: string;
}
export interface SceneKeepPayload {
  name: string;
  description: string;
  project_id: string;
  project_name: string | null;
  workspace: SceneKeepWorkspace | null;
  scene_text: string;
  preview: SceneKeepPreview;
  overwrite_id?: string;
  overwrite_revision?: number;
}
export type SceneKeepSaveResult =
  | { status: "saved"; id: string; revision: number; missing_count: number }
  | { status: "exists"; id: string; revision: number; updated_at: string; description: string }
  | { status: "conflict"; id?: string; revision?: number; updated_at?: string };
export interface SceneKeepDetail {
  scene_text: string;
  revision: number;
  workspace: SceneKeepWorkspace | null;
}
export interface SceneKeepRestoreResult {
  id_map: Record<string, string>;
  rejected: string[];
  restored: number;
}

export function assertSceneKeepScope(scope: string): void {
  if (scope !== getAccountNamespace()) throw new Error("계정이 바뀌었습니다. 다시 열어 주세요.");
}

export function sceneKeepErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof HttpError) return error.detail;
  if (error instanceof TypeError) return "서버에 연결하지 못했습니다.";
  return error instanceof Error ? error.message : fallback;
}

export function normalizeSceneKeepName(value: string): string {
  const name = value.normalize("NFC").trim();
  if (!name || Array.from(name).length > 120) throw new Error("이름은 1~120자로 입력해 주세요.");
  return name;
}

export function defaultSceneKeepProject(scene: Pick<Scene, "workspace">, projects: Project[], selectedProjectId?: string | null): Project | null {
  if (!scene.workspace?.id) return null;
  const matches = projects.filter(project => !project.archived && project.workspace_id === scene.workspace?.id);
  return matches.find(project => project.id === selectedProjectId) ?? matches[0] ?? null;
}

export function buildSceneKeepPreview(cards: SceneCard[]): SceneKeepPreview {
  if (!cards.length) return [];
  // 손상된 파일의 극단적인 유한 좌표도 합산할 때 Infinity가 되지 않게 제한한다.
  const finite = (value: number | undefined, fallback: number) => Number.isFinite(value)
    ? Math.max(-1e9, Math.min(1e9, value as number)) : fallback;
  const rects = cards.slice(0, 200).map(card => ({
    kind: card.kind, x: finite(card.x, 0), y: finite(card.y, 0),
    w: Math.max(1, finite(card.w, 240)), h: Math.max(1, finite(card.h, 160)),
  }));
  const left = Math.min(...rects.map(r => r.x));
  const top = Math.min(...rects.map(r => r.y));
  const width = Math.max(1, Math.max(...rects.map(r => r.x + r.w)) - left);
  const height = Math.max(1, Math.max(...rects.map(r => r.y + r.h)) - top);
  const coord = (n: number) => Math.max(0, Math.min(1000, Math.round(n)));
  const preview: SceneKeepPreview = [];
  for (const r of rects) {
    const item: SceneKeepPreview[number] = [r.kind, coord((r.x - left) / width * 1000),
      coord((r.y - top) / height * 1000), coord(r.w / width * 1000), coord(r.h / height * 1000)];
    if (new TextEncoder().encode(JSON.stringify([...preview, item])).byteLength > 8192) break;
    preview.push(item);
  }
  return preview;
}

export function captureSceneKeep(scene: Scene, name: string, camera = scene.camera) {
  const normalizedName = normalizeSceneKeepName(name);
  return {
    name: normalizedName,
    scene_text: exportSceneKeepText(scene, normalizedName, camera),
    preview: buildSceneKeepPreview(scene.cards),
    node_count: scene.cards.length,
    workspace: scene.workspace ? { ...scene.workspace } : null,
  };
}

// 응답 열쇠는 실제 행 id가 아니라 씬이 참조한 id다. 중복 별칭도 각각 처리한다.
export function applySceneKeepRestore(snapshot: SceneSnapshot, result: Pick<SceneKeepRestoreResult, "id_map" | "rejected">): SceneSnapshot {
  const copy: SceneSnapshot = JSON.parse(JSON.stringify(snapshot));
  const mapping = new Map(Object.entries(result.id_map));
  const rejected = new Set(result.rejected);
  const remap = (id: string) => rejected.has(id) ? null : mapping.get(id) ?? id;
  for (const card of copy.cards) {
    delete card.pendingGenerationAttempts;
    if (card.genIds) card.genIds = [...new Set(card.genIds.map(remap).filter((id): id is string => id !== null))];
    if (card.genId) card.genId = remap(card.genId) ?? card.genIds?.[card.genIds.length - 1] ?? null;
    if (card.refs) for (const ref of card.refs) if (ref.source_gen_id) ref.source_gen_id = remap(ref.source_gen_id);
    if (card.comfyCfg?.outputs) for (const output of card.comfyCfg.outputs) {
      if (!output.saved_generation_id) continue;
      const id = remap(output.saved_generation_id);
      if (id) output.saved_generation_id = id;
      else delete output.saved_generation_id;
    }
  }
  return copy;
}

async function keepRequest<T>(scope: string, path = "", init?: RequestInit): Promise<T> {
  assertSceneKeepScope(scope);
  const response = await jsonFetch<T>(`/api/scene-keeps${path}`, {
    ...init, headers: { ...init?.headers, [EXPECT_ACCOUNT_HEADER]: scope },
  });
  assertSceneKeepScope(scope);
  return response;
}

export const sceneKeepApi = {
  async list(scope: string): Promise<SceneKeepRow[]> {
    try { return await keepRequest<SceneKeepRow[]>(scope); }
    catch (error) {
      if (isRouteMissing(error)) throw new Error("공유 서버 업데이트가 필요합니다.");
      throw error;
    }
  },
  async save(scope: string, payload: SceneKeepPayload): Promise<SceneKeepSaveResult> {
    try { return await keepRequest<SceneKeepSaveResult>(scope, "", { method: "POST", body: JSON.stringify(payload) }); }
    catch (error) {
      if (isRouteMissing(error)) throw new Error("공유 서버 업데이트가 필요합니다.");
      throw error;
    }
  },
  detail: (scope: string, id: string) => keepRequest<SceneKeepDetail>(scope, `/${encodeURIComponent(id)}`),
  restore: (scope: string, id: string, revision: number) => keepRequest<SceneKeepRestoreResult>(scope, "/restore", { method: "POST", body: JSON.stringify({ id, revision }) }),
  remove: (scope: string, id: string, revision: number) => keepRequest<{ ok: boolean }>(scope, `/${encodeURIComponent(id)}?revision=${revision}`, { method: "DELETE" }),
};

export interface OpenSceneKeepOptions {
  id: string;
  scope: string;
  canWrite: () => boolean;
  importSnapshot: (snapshot: SceneSnapshot, scope: string) => Scene | null;
  // 호출자가 현재 내 공간 목록에 있는 값인지 확인한 뒤 적용한다.
  restoreWorkspace?: (scene: Scene, workspace: SceneKeepWorkspace) => Promise<void> | void;
}

export async function openSceneKeep(options: OpenSceneKeepOptions) {
  const { id, scope, canWrite, importSnapshot } = options;
  const check = () => {
    assertSceneKeepScope(scope);
    if (!canWrite()) throw new Error("캔버스를 편집할 수 있는 창에서 열어 주세요.");
  };
  check();
  const detail = await sceneKeepApi.detail(scope, id);
  check();
  let snapshot: SceneSnapshot;
  try { snapshot = parseSceneImport(detail.scene_text); }
  catch { throw new Error("이 앱에서 열 수 없는 보관본입니다."); }
  let restored: SceneKeepRestoreResult;
  try { restored = await sceneKeepApi.restore(scope, id, detail.revision); }
  catch (error) {
    if (error instanceof HttpError && error.status === 409 && error.detail.includes("보관본")) {
      throw new Error("보관본이 바뀌었습니다, 다시 열어 주세요.");
    }
    throw error;
  }
  let scene: Scene;
  let saveWarning: string | null = null;
  try {
    check();
    const write = confirmSceneWrite(() => importSnapshot(applySceneKeepRestore(snapshot, restored), scope));
    const confirmed = await write.confirmed;
    check();
    if (!write.value) throw new Error("탭 저장 실패");
    scene = write.value;
    if (!confirmed) saveWarning = "탭은 열었지만 이 PC 에 아직 저장하지 못했습니다.";
  } catch {
    throw new Error("기록은 복원했지만 탭을 열지 못했습니다.");
  }
  let workspaceError: string | null = null;
  if (detail.workspace?.id && options.restoreWorkspace) {
    try { check(); await options.restoreWorkspace(scene, detail.workspace); check(); }
    catch { workspaceError = "탭은 열었지만 탭 표식을 되돌리지 못했습니다."; }
  }
  return { scene, restored: restored.restored, rejected: restored.rejected.length, workspaceError, saveWarning };
}
