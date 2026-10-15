import { useEffect, useRef } from "react";
import { api } from "../api";
import type { Generation, WorkspaceContext } from "../types";
import { getAccountNamespace } from "./accountScope";
import { getAuthToken, jsonBody, jsonFetch } from "./http";
import { confirmSceneWrite, listPersistedScenes, listScenes, updateScenesWith, type Scene, type SceneCard } from "./scenes";
import { sceneStoreReady } from "./sceneStore";
import { sceneMatchesWorkspace } from "./sceneWorkspace";

export interface McpCanvasTask {
  id: string;
  scene_id: string;
  workspace: WorkspaceContext;
  generation_ids: string[];
  status: string;
}
interface CanvasPorts {
  flushScenePending: (sceneId: string) => void;
  refreshSceneById: (sceneId: string) => void;
}
const sameWorkspace = (a: WorkspaceContext, b: WorkspaceContext) =>
  a.scope !== "unknown" && a.scope === b.scope && (a.id || null) === (b.id || null);

export function appendMcpGenerations(scene: Scene, task: McpCanvasTask, generations: Generation[]): Scene {
  if (scene.mcpAttachmentReceipts?.includes(task.id)) return scene;
  const top = Math.max(0, ...scene.cards.map((card) => card.y + (card.h || 250))) + 100;
  const cards: SceneCard[] = generations.map<SceneCard>((generation, index) => ({
    id: `mcp-attach:${task.id}:${generation.id}`, kind: "generation", x: index * 350, y: top,
    genId: generation.id, genIds: [generation.id], prompt: generation.display_prompt || generation.prompt,
    status: generation.status === "nsfw" ? "failed" : generation.status,
  })).filter((card) => !scene.cards.some((existing) => existing.id === card.id));
  return { ...scene, cards: [...scene.cards, ...cards], mcpAttachmentReceipts: [...(scene.mcpAttachmentReceipts || []), task.id] };
}

export async function attachMcpCanvasTask(task: McpCanvasTask, workspace: WorkspaceContext, ports: CanvasPorts, isCurrent: () => boolean): Promise<boolean> {
  if (!isCurrent() || task.status !== "pending" || !sameWorkspace(task.workspace, workspace) || !task.generation_ids.length) return false;
  const existing = listScenes(null).find((scene) => scene.id === task.scene_id);
  if (!existing || !sceneMatchesWorkspace(existing, workspace)) return false;
  if (listPersistedScenes(null).find((scene) => scene.id === task.scene_id)?.mcpAttachmentReceipts?.includes(task.id)) return true;
  const generations: Generation[] = [];
  for (const id of [...new Set(task.generation_ids)]) {
    const generation = await api.getGeneration(id);
    if (!isCurrent() || generation.id !== id || !sameWorkspace({ scope: generation.workspace_scope, id: generation.workspace_id, name: null }, workspace)) return false;
    generations.push(generation);
  }
  const write = confirmSceneWrite(() => {
    ports.flushScenePending(task.scene_id);
    return updateScenesWith(null, (scenes) => {
      const scene = scenes.find((item) => item.id === task.scene_id);
      if (!scene || !sceneMatchesWorkspace(scene, workspace) || scene.mcpAttachmentReceipts?.includes(task.id)) return null;
      return scenes.map((item) => item.id === scene.id ? appendMcpGenerations(item, task, generations) : item);
    });
  });
  if (write.value && isCurrent()) ports.refreshSceneById(task.scene_id);
  // 저장 확인 응답이 유실돼도 처리 기록으로 삭제된 카드의 재부착을 막는다.
  if (!write.value || !await write.confirmed || !isCurrent()) return false;
  return !!listPersistedScenes(null).find((scene) => scene.id === task.scene_id)?.mcpAttachmentReceipts?.includes(task.id);
}

export function useMcpCanvasTasks(props: CanvasPorts & { authReady: boolean; authKey: string; workspace: WorkspaceContext }): void {
  const current = useRef(props); current.current = props;
  const scope = JSON.stringify([props.authReady, props.authKey, props.workspace.scope, props.workspace.id]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  useEffect(() => {
    if (!props.authReady || props.workspace.scope === "unknown") return;
    const account = getAccountNamespace(), token = getAuthToken(), tab = crypto.randomUUID();
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 15_000;
    const fresh = () => !abort.signal.aborted && scopeRef.current === scope && account === getAccountNamespace() && token === getAuthToken();
    const poll = async () => {
      let failed = false;
      try {
        if (!sceneStoreReady() || !fresh()) return;
        const query = new URLSearchParams({ workspace_scope: props.workspace.scope });
        if (props.workspace.id) query.set("workspace_id", props.workspace.id);
        const result = await jsonFetch<{ tasks: McpCanvasTask[] }>(`/api/mcp/v2/app/canvas-tasks?${query}`, { headers: { "X-MVHub-Tab": tab }, signal: abort.signal });
        if (!fresh()) return;
        for (const task of result.tasks) {
          if (!fresh()) return;
          try {
            if (await attachMcpCanvasTask(task, props.workspace, current.current, fresh) && fresh()) {
              await jsonFetch(`/api/mcp/v2/app/canvas-tasks/${encodeURIComponent(task.id)}/complete`, { method: "POST", headers: { "X-MVHub-Tab": tab }, body: jsonBody({ workspace: props.workspace }), signal: abort.signal });
            } else failed = true;
          } catch { failed = true; }
        }
      } catch { failed = true; }
      finally {
        // 카드 추가만 재확인하며, 막힌 작업을 완료 처리하거나 생성을 다시 요청하지 않는다.
        const delay = failed ? retryDelay : 15_000;
        retryDelay = failed ? Math.min(retryDelay * 2, 120_000) : 15_000;
        if (fresh()) timer = setTimeout(() => void poll(), delay);
      }
    };
    void poll();
    return () => { abort.abort(); if (timer) clearTimeout(timer); };
    // current carries the latest UI callbacks without restarting a poll on each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
}
