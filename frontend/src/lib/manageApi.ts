// PM 대시보드 API 클라이언트 — 인증/에러 처리는 공용 jsonFetch 를 재사용한다.
import { jsonBody, jsonFetch } from "./http";
import { pathPart, withQuery } from "./url";
import type {
  BreakdownData,
  ManageSummary,
  MatrixData,
  Planning,
  Task,
  TimePoint,
} from "../components/manage/types";

export const manageApi = {
  summary: () => jsonFetch<ManageSummary>("/api/manage/summary"),
  getPlanning: (pid: string) =>
    jsonFetch<Planning>(`/api/manage/planning/${pathPart(pid)}`),
  setPlanning: (pid: string, body: Partial<Planning>) =>
    jsonFetch<Planning>(`/api/manage/planning/${pathPart(pid)}`, {
      method: "PUT",
      body: jsonBody(body),
    }),
  listTasks: (projectId: string) =>
    jsonFetch<Task[]>(withQuery("/api/manage/tasks", { project_id: projectId })),
  updateTask: (tid: string, body: Partial<Task>) =>
    jsonFetch<Task>(`/api/manage/tasks/${pathPart(tid)}`, {
      method: "PATCH",
      body: jsonBody(body),
    }),
  deleteTask: (tid: string) =>
    jsonFetch<{ ok: boolean }>(`/api/manage/tasks/${pathPart(tid)}`, {
      method: "DELETE",
    }),
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
  timeseries: (bucket: "day" | "week" = "day", projectId?: string, creatorUid?: string) =>
    jsonFetch<TimePoint[]>(
      withQuery("/api/manage/timeseries", {
        bucket,
        project_id: projectId,
        creator_uid: creatorUid,
      }),
    ),
  matrix: () => jsonFetch<MatrixData>("/api/manage/matrix"),
  breakdown: (projectId: string) =>
    jsonFetch<BreakdownData>(withQuery("/api/manage/breakdown", { project_id: projectId })),
  // 팀 전체 집계(manage-T4) — 서버 manage_hub.db 를 읽어 매니저 대시보드에 낸다.
  teamOverview: (f: TeamFilters = {}) =>
    jsonFetch<TeamOverview>(
      withQuery("/api/manage/team-overview", {
        date_from: f.dateFrom,
        date_to: f.dateTo,
        project_id: f.projectId,
        creator_uid: f.creatorUid,
      }),
    ),
  teamTimeseries: (bucket: "day" | "week" | "month" = "day", f: TeamFilters = {}) =>
    jsonFetch<{ buckets: TeamBucket[] }>(
      withQuery("/api/manage/team-timeseries", {
        bucket,
        date_from: f.dateFrom,
        date_to: f.dateTo,
        project_id: f.projectId,
        creator_uid: f.creatorUid,
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
  projectId?: string;
  creatorUid?: string;
}

export interface TeamTotals {
  count: number;
  credits: number;
  elapsed_seconds: number;
  estimated_count: number; // 실제크레딧 미매칭(견적으로 대체된) 건수
  final_count: number;
  workers: number;
  projects: number;
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
  targets: SaveFinalsTarget[];
  history: SaveFinalsHistory[];
}
