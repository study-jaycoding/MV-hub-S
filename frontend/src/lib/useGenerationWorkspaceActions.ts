import { useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { api } from "../api";
import type { Generation } from "../types";
import { generationBulkIds } from "./generationTags";
import type { WorkspaceCommandOperation } from "./workspaceCommand";

interface UseGenerationWorkspaceActionsArgs {
  activeWorkspaceId?: string;
  flash: (message: string) => void;
  gensRef: MutableRefObject<Generation[]>;
  reload: (silent?: boolean, light?: boolean) => void | Promise<void>;
  selectedRef: MutableRefObject<Set<string>>;
  setGens: Dispatch<SetStateAction<Generation[]>>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
}

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^\d+:\s*/, "") || "워크스페이스 변경에 실패했습니다";
}

export function useGenerationWorkspaceActions({
  activeWorkspaceId,
  flash,
  gensRef,
  reload,
  selectedRef,
  setGens,
  setSelected,
}: UseGenerationWorkspaceActionsArgs) {
  const runningRef = useRef(false);

  const onWorkspaceCommand = async (
    focus: Generation,
    operation: WorkspaceCommandOperation,
    workspaceName: string,
  ): Promise<boolean> => {
    if (runningRef.current) return false;
    const idSet = generationBulkIds(selectedRef.current, focus.id);
    const ids = [...idSet];
    if (!ids.length) return false;
    if (ids.length > 500) {
      flash("워크스페이스는 한 번에 최대 500개 카드까지 변경할 수 있습니다");
      return false;
    }

    runningRef.current = true;
    try {
      const result = await api.setGenerationWorkspace(ids, operation, workspaceName);
      const byRequested = new Map(
        result.updates.map((update) => [update.requested_id, update.generation]),
      );
      const byId = new Map(result.updates.map((update) => [update.generation.id, update.generation]));
      const changed = new Set(result.changed);
      for (const update of result.updates) {
        if (changed.has(update.requested_id)) changed.add(update.generation.id);
      }
      const dropChanged = Boolean(
        activeWorkspaceId &&
          ((operation === "remove" && activeWorkspaceId === result.workspace.id) ||
            (operation === "assign" && activeWorkspaceId !== result.workspace.id)),
      );
      const apply = (generations: Generation[]) =>
        generations.flatMap((generation) => {
          const updated = byRequested.get(generation.id) ?? byId.get(generation.id);
          if (!updated) return [generation];
          if (dropChanged && changed.has(generation.id)) return [];
          return [updated];
        });
      const optimistic = apply(gensRef.current);
      gensRef.current = optimistic;
      setGens((current) => {
        const next = apply(current);
        gensRef.current = next;
        return next;
      });
      if (dropChanged) {
        setSelected((current) => {
          const next = new Set(current);
          for (const id of changed) next.delete(id);
          return next;
        });
      }

      const verb = operation === "assign" ? "적용" : "제거";
      flash(
        result.changed.length
          ? `워크스페이스 ${result.workspace.name} ${verb}: ${result.changed.length}개`
          : `워크스페이스 ${result.workspace.name}: 변경할 카드가 없습니다`,
      );
      try {
        await reload(false, false);
      } catch {
        // 서버 변경은 이미 확정됐다. 새로고침 실패를 변경 실패로 오인해 같은 명령을 다시
        // 입력하게 하지 않고, 현재 응답으로 갱신한 카드 상태를 그대로 유지한다.
        flash("워크스페이스 변경은 완료됐지만 목록 새로고침에 실패했습니다");
      }
      return true;
    } catch (error) {
      flash(readableError(error));
      return false;
    } finally {
      runningRef.current = false;
    }
  };

  return { onWorkspaceCommand };
}
