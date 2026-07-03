import { isFolderDisabled, type DisabledFolders } from "./deactivated";
import type { Generation } from "../types";

export const GENERATION_STATUS_LABEL: Record<string, string> = {
  pending: "생성중",
  running: "생성중",
  done: "완료",
  failed: "실패",
  nsfw: "NSFW 차단",
};

// pending/running 카드는 '내 PC 에이전트가 실행'하는 로컬 생성 — 에이전트가 떠 있어야 완료된다.
export const LOCAL_EXEC_HINT =
  "내 PC의 에이전트가 로컬 CLI로 생성 중입니다. 에이전트(push_agent --watch)가 떠 있어야 완료됩니다.";

export function generationStatusLabel(status: string): string {
  return GENERATION_STATUS_LABEL[status] || status;
}

export function generationStatusTitle(status: string, error: string | null): string | undefined {
  if (status === "failed" && error) return error;
  if (status === "pending" || status === "running") return LOCAL_EXEC_HINT;
  return undefined;
}

export function formatGenerationDate(value: string): string {
  const d = new Date(value.replace(" ", "T"));
  if (isNaN(d.getTime())) return value.slice(0, 10);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export function generationListMeta(params: Record<string, unknown>): {
  resolution?: string;
  duration?: string;
  aspect?: string;
} {
  return {
    resolution: typeof params.resolution === "string" ? params.resolution : undefined,
    duration:
      typeof params.duration === "number"
        ? `${params.duration.toFixed(1)}s`
        : typeof params.duration === "string"
          ? params.duration
          : undefined,
    aspect: typeof params.aspect_ratio === "string" ? params.aspect_ratio : undefined,
  };
}

export function hasActiveGenerationJob(gens: Generation[]): boolean {
  return gens.some((g) => g.status === "pending" || g.status === "running");
}

export function filterDisabledGenerations(
  gens: Generation[],
  disabledIds: Set<string>,
  hideDisabled: boolean,
): Generation[] {
  return hideDisabled ? gens.filter((g) => !disabledIds.has(g.id)) : gens;
}

// id 만 받는 소비자(엣지·썸네일그리드·보드노드)에 넘길 '확장된 비활성 id 집합'.
// 폴더 규칙이 없으면 기존 id 집합을 그대로 돌려줘 불필요한 순회를 피한다.
export function expandDisabledGenerationIds(
  gens: Pick<Generation, "id" | "project_id" | "folder_path">[],
  disabledIds: Set<string>,
  disabledFolders: DisabledFolders,
): Set<string> {
  if (!Object.keys(disabledFolders).length) return disabledIds;
  const s = new Set(disabledIds);
  for (const g of gens) {
    if (isFolderDisabled(disabledFolders, g.project_id, g.folder_path)) s.add(g.id);
  }
  return s;
}

export function canFinalizeGeneration(g: Generation, finalizeProjects: Set<string>): boolean {
  return (
    finalizeProjects.has("*") ||
    (!!g.project_id && finalizeProjects.has(g.project_id)) ||
    (!g.project_id && !!g.is_mine)
  );
}

export function shareableGenerations(gens: Generation[]): Generation[] {
  return gens.filter((g) => g.is_mine && g.status === "done" && !g.shared);
}
