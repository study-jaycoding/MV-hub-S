import { useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { api } from "../api";
import type { Generation } from "../types";
import type { WorkspaceCommandOperation } from "./workspaceCommand";

interface UseGenerationWorkspaceActionsArgs {
  activeWorkspaceId?: string;
  flash: (message: string) => void;
  gensRef: MutableRefObject<Generation[]>;
  reload: (silent?: boolean, light?: boolean) => void | Promise<void>;
  selectedRef: MutableRefObject<Set<string>>;
  setGens: Dispatch<SetStateAction<Generation[]>>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  /** 팀 탭 여부 — 팀 카드 id 는 서버 UUID 라 job_id 앵커가 필수(없으면 명시 거절). */
  teamTab?: boolean;
}

/** 로컬↔서버를 잇는 유일한 안정 앵커 — 팀 카드 id(서버 UUID)는 로컬 DB 와 매칭되지 않는다. */
function anchorOf(generation: Generation): string {
  return generation.job_id || generation.id;
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
  teamTab,
}: UseGenerationWorkspaceActionsArgs) {
  const runningRef = useRef(false);

  const onWorkspaceCommand = async (
    focus: Generation,
    operation: WorkspaceCommandOperation,
    workspaceName: string,
  ): Promise<boolean> => {
    if (runningRef.current) return false;
    // 적용 범위는 태그와 동일 규칙 — 포커스가 선택에 포함된 다중 선택일 때만 선택 전체,
    // 그 외엔 포커스 단건. (선택 안 된 카드에서 입력했는데 보이지 않는 선택 전체가 바뀌는 사고 방지)
    const selected = selectedRef.current;
    const multi = selected.has(focus.id) && selected.size > 1;
    const targets = multi ? gensRef.current.filter((g) => selected.has(g.id)) : [focus];
    if (!targets.length) return false;
    if (teamTab && targets.some((g) => !g.job_id)) {
      flash("팀 탭에서는 잡 앵커가 없는 카드(Comfy 등)의 워크스페이스를 변경할 수 없습니다");
      return false;
    }
    const ids = [...new Set(targets.map(anchorOf))];
    if (ids.length > 500) {
      flash("워크스페이스는 한 번에 최대 500개 카드까지 변경할 수 있습니다");
      return false;
    }

    runningRef.current = true;
    try {
      const result = await api.setGenerationWorkspace(ids, operation, workspaceName);
      // 응답 매핑은 요청 앵커 기준 — 카드 객체의 id 는 절대 바꾸지 않고 워크스페이스 필드만
      // 패치한다(팀 카드 id 를 로컬 id 로 치환하면 선택·코멘트 패널·읽음 표시가 어긋난다).
      const byRequested = new Map(
        result.updates.map((update) => [update.requested_id, update.generation]),
      );
      const changedAnchors = new Set(result.changed);
      const dropChanged = Boolean(
        activeWorkspaceId &&
          ((operation === "remove" && activeWorkspaceId === result.workspace.id) ||
            (operation === "assign" && activeWorkspaceId !== result.workspace.id)),
      );
      const apply = (generations: Generation[]) =>
        generations.flatMap((generation) => {
          const anchor = anchorOf(generation);
          const updated = byRequested.get(anchor);
          if (!updated) return [generation];
          if (dropChanged && changedAnchors.has(anchor)) return [];
          return [
            {
              ...generation,
              workspace_scope: updated.workspace_scope,
              workspace_id: updated.workspace_id,
              workspace_name: updated.workspace_name,
            },
          ];
        });
      const optimistic = apply(gensRef.current);
      gensRef.current = optimistic;
      setGens((current) => {
        const next = apply(current);
        gensRef.current = next;
        return next;
      });
      if (dropChanged) {
        const droppedCardIds = new Set(
          targets.filter((g) => changedAnchors.has(anchorOf(g))).map((g) => g.id),
        );
        setSelected((current) => {
          const next = new Set(current);
          for (const id of droppedCardIds) next.delete(id);
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
