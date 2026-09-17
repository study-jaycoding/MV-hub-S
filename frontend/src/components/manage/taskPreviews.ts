import type { Cut, Task, TaskPreviewCandidate, TaskPreviewResponse } from "./types";

function candidateFor(task: Task, cut: Cut, viewerUid: string | null): TaskPreviewCandidate | null {
  if (!viewerUid || cut.creator_uid !== viewerUid || !cut.metadata_only ||
      task.workspace_scope !== "team" || !task.workspace_id || !task.project_id ||
      !task.folder_path || (!cut.local_gen_id && !cut.job_id)) return null;
  return {
    id: cut.id,
    ...(cut.local_gen_id ? { local_gen_id: cut.local_gen_id } : {}),
    ...(cut.job_id ? { job_id: cut.job_id } : {}),
    project_id: task.project_id,
    folder_path: task.folder_path,
    workspace_id: task.workspace_id,
  };
}

/** 같은 컷이 서로 다른 위치를 가리키면 로컬 원본을 추측해서 연결하지 않는다. */
export function taskPreviewCandidates(tasks: Task[], viewerUid: string | null): TaskPreviewCandidate[] {
  const byId = new Map<string, TaskPreviewCandidate>();
  const ambiguous = new Set<string>();
  for (const task of tasks) for (const cut of task.cuts || []) {
    const item = candidateFor(task, cut, viewerUid);
    if (!item) continue;
    const previous = byId.get(item.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(item)) ambiguous.add(item.id);
    else byId.set(item.id, item);
  }
  return [...byId.values()].filter((item) => !ambiguous.has(item.id));
}

/** 매번 서버의 집계를 유지하면서 이전 로컬 미디어만 지우고 다시 확인한다. */
export function prepareTaskPreviews(tasks: Task[], viewerUid: string | null): Task[] {
  const candidates = new Set(taskPreviewCandidates(tasks, viewerUid).map((item) => item.id));
  return tasks.map((task) => ({ ...task, cuts: task.cuts?.map((cut) => cut.metadata_only
    ? { ...cut, thumb: null, file_path: null,
      preview_state: candidates.has(cut.id) ? "pending" : "unavailable" }
    : cut) }));
}

export function applyTaskPreviews(
  tasks: Task[], viewerUid: string | null, candidates: TaskPreviewCandidate[],
  response: TaskPreviewResponse | null,
): Task[] {
  const allowed = new Map(candidates.map((item) => [item.id, JSON.stringify(item)]));
  const valid = !!viewerUid && response?.viewer_uid === viewerUid;
  return tasks.map((task) => ({ ...task, cuts: task.cuts?.map((cut) => {
    if (!cut.metadata_only || cut.creator_uid !== viewerUid || !allowed.has(cut.id)) return cut;
    const candidate = candidateFor(task, cut, viewerUid);
    if (!candidate || JSON.stringify(candidate) !== allowed.get(cut.id)) return cut;
    const preview = valid ? response?.items[cut.id] : undefined;
    if (!preview?.local_gen_id || (!preview.thumb && !preview.file_path)) {
      return { ...cut, thumb: null, file_path: null,
        preview_state: valid ? "missing" : "unavailable" };
    }
    // 비용·공유·최종 상태 등은 로컬에서 덮지 않는다. 확인된 미디어 필드만 보강한다.
    return { ...cut, local_gen_id: preview.local_gen_id, thumb: preview.thumb,
      file_path: preview.file_path, media_type: preview.media_type, preview_state: "ready" };
  }) }));
}

/** 팩트 식별자는 로컬 생성물 비활성 저장소나 콘텐츠 변경 API에 쓰지 않는다. */
export function cutLocalId(cut: Cut): string | undefined {
  const id = cut.metadata_only
    ? (cut.preview_state === "ready" ? cut.local_gen_id : undefined)
    : cut.id;
  return id && !id.startsWith("fact:") ? id : undefined;
}

export function cutHasPreview(cut: Cut): boolean {
  return !cut.metadata_only || cut.preview_state === "ready";
}

export function privateCutLabel(cut: Cut, viewerUid?: string | null): string {
  if (!viewerUid || cut.creator_uid !== viewerUid) return "미공유";
  if (cut.preview_state === "pending") return "로컬 확인 중";
  if (cut.preview_state === "missing") return "이 PC에 원본 없음";
  return "로컬 미리보기 없음";
}
