// PM 대시보드 API 클라이언트 — 인증/에러 처리는 공용 jsonFetch 를 재사용한다.
import { chunked } from "./batching";
import { isHttpStatus, jsonBody, jsonFetch } from "./http";
import { pathPart, withQuery } from "./url";
import type {
  ManageSummary,
  Planning,
  Task,
} from "../components/manage/types";
import type { WorkspaceOption } from "../types";

// 구서버(배치 라우트 없음) 판별 — 404/405 만 폴백 사유다. 400/401/403/5xx 를 폴백하면
// 권한·서버 장애가 "구버전"으로 오인돼 조용히 다른 경로로 재시도된다(합의 설계).
function isLegacyServer(error: unknown): boolean {
  return isHttpStatus(error, 404, 405);
}

let warnedLegacyBatch = false;

function warnLegacyBatchOnce(): void {
  if (warnedLegacyBatch) return;
  warnedLegacyBatch = true;
  console.warn("[manage] 공유 서버가 구버전입니다 — 배치 저장을 단건 API로 대신합니다. 서버 업데이트를 권장합니다.");
}

export const manageApi = {
  summary: (workspaceId?: string) =>
    jsonFetch<ManageSummary>(withQuery("/api/manage/summary", { workspace_id: workspaceId })),
  projectSummary: (workspaceId?: string) =>
    jsonFetch<Pick<ManageSummary, "projects">>(
      withQuery("/api/manage/project-summary", { workspace_id: workspaceId }),
    ),
  workspaces: () =>
    jsonFetch<{ workspaces: WorkspaceOption[] }>("/api/manage/workspaces"),
  getPlanning: (pid: string) =>
    jsonFetch<Planning>(`/api/manage/planning/${pathPart(pid)}`),
  setPlanning: (pid: string, body: Partial<Planning>) =>
    jsonFetch<Planning>(`/api/manage/planning/${pathPart(pid)}`, {
      method: "PUT",
      body: jsonBody(body),
    }),
  listTasks: (projectId: string, workspaceId?: string, includeArchived = false) =>
    jsonFetch<Task[]>(withQuery("/api/manage/tasks", {
      project_id: projectId,
      workspace_id: workspaceId,
      include_archived: includeArchived || undefined,
    })),
  // 여러 프로젝트 작업을 1요청으로(WorkBoard fan-out 제거). GET(읽기)이라 mutation 알림 없음.
  // 반환 {pid: Task[]}, 접근불가/오류 pid 는 생략(부분성공).
  listTasksBatch: (projectIds: string[], workspaceId?: string, includeArchived = false) =>
    jsonFetch<Record<string, Task[]>>(
      withQuery("/api/manage/tasks-batch", {
        project_id: projectIds,
        workspace_id: workspaceId,
        include_archived: includeArchived || undefined,
      }),
    ),
  updateTask: (tid: string, body: Partial<Task>) =>
    jsonFetch<Task>(`/api/manage/tasks/${pathPart(tid)}`, {
      method: "PATCH",
      body: jsonBody(body),
    }),
  deleteTask: (tid: string) =>
    jsonFetch<{ ok: boolean }>(`/api/manage/tasks/${pathPart(tid)}`, {
      method: "DELETE",
    }),
  // 순서 저장 = 보드 전체 순서 스냅샷(위치가 곧 순서). 원자성이 계약이라 청크 분할하지 않는다.
  // 이중 페이로드: 신서버는 ordered_task_ids 를, 스냅샷 계약을 모르는 구배치 서버는 items(같은
  // 내용의 전체 목록)를 읽는다 — 어느 쪽이 받아도 "전체 상태 저장"이라 latest-merge 큐와 안전.
  // 라우트 자체가 없는 최구형(404/405)만 단건 PATCH 폴백.
  updateTaskOrderSnapshot: async (orderedTaskIds: string[]) => {
    const items = orderedTaskIds.map((task_id, index) => ({ task_id, sort_order: index * 10 }));
    try {
      return await jsonFetch<{ ok: boolean; count: number }>("/api/manage/tasks-batch/order", {
        method: "PATCH",
        body: jsonBody({ ordered_task_ids: orderedTaskIds, items }),
      });
    } catch (error) {
      if (!isLegacyServer(error)) throw error;
      warnLegacyBatchOnce();
      let count = 0;
      for (const item of items) {
        await manageApi.updateTask(item.task_id, { sort_order: item.sort_order });
        count += 1;
      }
      return { ok: true, count };
    }
  },
  deleteTasksBatch: async (taskIds: string[]) => {
    let count = 0;
    for (const chunk of chunked(taskIds)) {
      try {
        const res = await jsonFetch<{ ok: boolean; count: number }>("/api/manage/tasks-batch/delete", {
          method: "POST",
          body: jsonBody({ task_ids: chunk }),
        });
        count += res.count;
      } catch (error) {
        if (!isLegacyServer(error)) throw error;
        warnLegacyBatchOnce();
        for (const tid of chunk) {
          try {
            await manageApi.deleteTask(tid);
            count += 1;
          } catch (itemError) {
            // 이미 삭제된 작업(404)은 배치 삭제의 '있는 것만 지움' 의미와 동일하게 건너뛴다.
            if (!isHttpStatus(itemError, 404)) throw itemError;
          }
        }
      }
    }
    return { ok: true, count };
  },
  linkGenerations: (tid: string, genIds: string[]) =>
    jsonFetch<{ linked: number }>(`/api/manage/tasks/${pathPart(tid)}/generations`, {
      method: "POST",
      body: jsonBody({ gen_ids: genIds }),
    }),
  unlinkGeneration: (tid: string, genId: string) =>
    jsonFetch<{ ok: boolean }>(
      `/api/manage/tasks/${pathPart(tid)}/generations/${pathPart(genId)}`,
      { method: "DELETE" },
    ),
  // 담당(배정) — 대시보드에서 PM 이 작업자를 배정(=컷 분배). 모두 PM(manage) 권한.
  addAssignee: (tid: string, uid: string) =>
    jsonFetch<{ ok: boolean }>(
      `/api/manage/tasks/${pathPart(tid)}/assignees/${pathPart(uid)}`,
      { method: "POST" },
    ),
  removeAssignee: (tid: string, uid: string) =>
    jsonFetch<{ removed: boolean }>(
      `/api/manage/tasks/${pathPart(tid)}/assignees/${pathPart(uid)}`,
      { method: "DELETE" },
    ),
  // 여러 작업의 담당을 일괄 설정. mode: replace(교체) | add(추가) | remove(지정 담당 해제)
  bulkSetAssignments: async (
    items: { task_id: string; assignee_uids: string[] }[],
    mode: "replace" | "add" | "remove",
  ) => {
    let count = 0;
    for (const chunk of chunked(items)) {
      try {
        const res = await jsonFetch<{ ok: boolean; count: number }>(
          "/api/manage/tasks/assignees/bulk",
          { method: "PATCH", body: jsonBody({ mode, items: chunk }) },
        );
        count += res.count;
        continue;
      } catch (error) {
        // 구서버 판별: 라우트 자체가 없으면 404/405, mode="remove" 미지원 구서버는 400을 낸다.
        // remove 만 400 도 폴백 사유로 인정(다른 mode 의 400 은 진짜 입력 오류라 전파).
        const legacy = isLegacyServer(error) || (mode === "remove" && isHttpStatus(error, 400));
        if (!legacy) throw error;
      }
      warnLegacyBatchOnce();
      if (mode === "replace") {
        // 구 단건 API(add/remove)로는 '교체'를 원자적으로 재현할 수 없다 — 명시 오류.
        throw new Error("공유 서버가 구버전이라 담당 일괄 교체를 지원하지 않습니다. 서버를 업데이트해 주세요.");
      }
      for (const item of chunk) {
        for (const uid of item.assignee_uids) {
          if (mode === "add") await manageApi.addAssignee(item.task_id, uid);
          else await manageApi.removeAssignee(item.task_id, uid);
        }
        count += 1;
      }
    }
    return { ok: true, count };
  },
  // 팀 전체 집계(manage-T4) — 서버 manage_hub.db 를 읽어 매니저 대시보드에 낸다.
  teamOverview: (f: TeamFilters = {}) =>
    jsonFetch<TeamOverview>(
      withQuery("/api/manage/team-overview", {
        date_from: f.dateFrom,
        date_to: f.dateTo,
        project_id: f.projectId,
        creator_uid: f.creatorUid,
        workspace_id: f.workspaceId,
        model: f.model,
      }),
    ),
  teamTimeseries: (bucket: "minute" | "hour" | "day" | "week" | "month" = "day", f: TeamFilters = {}) =>
    jsonFetch<{ buckets: TeamBucket[] }>(
      withQuery("/api/manage/team-timeseries", {
        bucket,
        date_from: f.dateFrom,
        date_to: f.dateTo,
        time_from: f.timeFrom,
        time_to: f.timeTo,
        project_id: f.projectId,
        creator_uid: f.creatorUid,
        workspace_id: f.workspaceId,
        model: f.model,
      }),
    ),
  usageExport: (f: TeamFilters = {}) =>
    jsonFetch<{ rows: TeamUsageExportRow[] }>(
      withQuery("/api/manage/usage-export", {
        date_from: f.dateFrom,
        date_to: f.dateTo,
        project_id: f.projectId,
        creator_uid: f.creatorUid,
        workspace_id: f.workspaceId,
        model: f.model,
      }),
    ),
  // 완료본 렌더폴더 저장 — 완료 작업의 최종본만 물리 저장(멱등). saved/skipped/errors 반환.
  saveFinals: (projectId: string) =>
    jsonFetch<SaveFinalsResult>(withQuery("/api/manage/save-finals", { project_id: projectId }), {
      method: "POST",
    }),
  // 저장 대상 미리보기 + 이력(읽기 전용, 다운로드 없음).
  saveFinalsStatus: (projectId: string) =>
    jsonFetch<SaveFinalsStatus>(withQuery("/api/manage/save-finals", { project_id: projectId })),
};

export interface TeamFilters {
  dateFrom?: string;
  dateTo?: string;
  timeFrom?: string;
  timeTo?: string;
  projectId?: string;
  creatorUid?: string;
  workspaceId?: string;
  model?: string;
}

export interface TeamTotals {
  count: number;
  credits: number;
  elapsed_seconds: number;
  estimated_count: number; // 실제크레딧 미매칭(견적으로 대체된) 건수
  final_count: number;
  workers: number;
  projects: number;
  models: number;
  features: number;
}

export interface TeamModelRow {
  model: string;
  count: number;
  credits: number;
  elapsed_seconds?: number;
  final_count: number;
}

export interface TeamOutputTypeRow {
  output_type: string;
  count: number;
  credits: number;
}

export interface TeamOutputModelRow extends TeamOutputTypeRow {
  model: string;
}

export interface TeamUsageExportRow {
  date: string;
  user_email: string;
  user_id: string | null;
  model: string;
  credits_used: number;
  jobs: number;
}

export interface TeamWorkerModelRow extends TeamModelRow {
  creator_uid: string | null;
}

export interface TeamProjectModelRow extends TeamModelRow {
  project_id: string | null;
}

export interface FolderEfficiencyRow {
  project_id: string | null;
  project_name: string | null;
  folder_path: string;
  episode?: string | null;
  scene?: string | null;
  count: number;
  final_count: number;
  credits: number;
  yield_percent?: number;
  final_rate_tenths: number;
  attempts_per_final: number | null;
}

export interface TeamWorkerRow {
  creator_uid: string | null;
  creator_name: string | null;
  count: number;
  credits: number;
  elapsed_seconds: number;
  final_count: number;
}

export interface TeamProjectRow {
  project_id: string | null;
  project_name: string | null;
  count: number;
  credits: number;
  elapsed_seconds: number;
  final_count: number;
}

export interface TeamMatrixCell {
  creator_uid: string | null;
  creator_name: string | null;
  project_id: string | null;
  project_name: string | null;
  count: number;
  credits: number;
}

export interface TeamOverview {
  totals: TeamTotals;
  by_worker: TeamWorkerRow[];
  by_project: TeamProjectRow[];
  by_model: TeamModelRow[];
  by_output_type?: TeamOutputTypeRow[];
  output_models?: TeamOutputModelRow[];
  worker_models: TeamWorkerModelRow[];
  project_models: TeamProjectModelRow[];
  folder_efficiency: FolderEfficiencyRow[];
  matrix: TeamMatrixCell[];
}

export interface TeamBucket {
  bucket: string;
  count: number;
  credits: number;
  elapsed_seconds: number;
}

export interface SaveFinalsResult {
  saved: number;
  skipped: number;
  errors: { gen_id: string; reason: string }[];
}

export interface SaveFinalsTarget {
  gen_id: string;
  folder_path: string | null;
  filename: string;
  saved: boolean; // 이미 렌더폴더에 존재
  reason: string | null; // null=저장 가능, 값 있으면 저장 불가 사유
}

export interface SaveFinalsHistory {
  gen_id: string;
  dest_path: string;
  exported_at: string;
  exists: boolean; // 대장 기록의 실제 파일 존재 여부
}

export interface SaveFinalsStatus {
  render_path: string;
  error: string | null;
  // 위임 모드에서 공유 서버가 구버전(targets API 없음)이라 대상 판정이 불가한 상태 —
  // 0건으로 오인되지 않게 UI 가 "서버 업데이트 필요"를 표시한다(구백엔드 응답엔 필드 자체가 없음).
  server_outdated?: boolean;
  targets: SaveFinalsTarget[];
  history: SaveFinalsHistory[];
}
