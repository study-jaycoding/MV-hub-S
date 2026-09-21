// PM 대시보드 API 클라이언트 — 인증/에러 처리는 공용 jsonFetch 를 재사용한다.
import { chunked } from "./batching";
import { isHttpStatus, isRouteMissing, jsonBody, jsonFetch } from "./http";
import { pathPart, withQuery } from "./url";
import type {
  ManageSummary,
  Planning,
  Task,
  TaskPreviewCandidate,
  TaskPreviewResponse,
} from "../components/manage/types";
import type { WorkspaceOption } from "../types";
import type { CreditPlanSaveBody, CreditPlanSettings, CreditPlanView, MyModelPolicy } from "./creditPlan";
import type { MemberTableData } from "./memberTable";

// 구서버(배치 라우트 없음) 판별 — 404/405 만 폴백 사유다. 400/401/403/5xx 를 폴백하면
// 권한·서버 장애가 "구버전"으로 오인돼 조용히 다른 경로로 재시도된다(합의 설계).
function isLegacyServer(error: unknown): boolean {
  return isRouteMissing(error);
}

let warnedLegacyBatch = false;

function warnLegacyBatchOnce(): void {
  if (warnedLegacyBatch) return;
  warnedLegacyBatch = true;
  console.warn("[manage] 공유 서버가 구버전입니다 — 배치 저장을 단건 API로 대신합니다. 서버 업데이트를 권장합니다.");
}

export const manageApi = {
  localTaskPreviews: async (viewerUid: string, items: TaskPreviewCandidate[]) => {
    const result: TaskPreviewResponse = { viewer_uid: viewerUid, items: {} };
    for (const page of chunked(items)) {
      const response = await jsonFetch<TaskPreviewResponse>("/api/manage/local-task-previews", {
        method: "POST", body: jsonBody({ viewer_uid: viewerUid, items: page }),
      });
      if (response.viewer_uid !== viewerUid) throw new Error("로컬 미리보기 계정이 변경되었습니다.");
      Object.assign(result.items, response.items);
    }
    return result;
  },
  summary: (workspaceId?: string) =>
    jsonFetch<ManageSummary>(withQuery("/api/manage/summary", { workspace_id: workspaceId })),
  projectSummary: (workspaceId?: string) =>
    jsonFetch<Pick<ManageSummary, "projects" | "usage_source" | "usage_scope">>(
      withQuery("/api/manage/project-summary", { workspace_id: workspaceId }),
    ),
  workspaces: () =>
    jsonFetch<{ workspaces: WorkspaceOption[] }>("/api/manage/workspaces"),
  taskProjects: (workspaceId: string, includeHistorical = false) =>
    jsonFetch<{
      projects: { id: string; name: string; archived?: number | boolean; workspace_moved?: boolean }[];
    }>(withQuery("/api/manage/task-projects", {
      workspace_id: workspaceId,
      include_historical: includeHistorical || undefined,
    })),
  getPlanning: (pid: string) =>
    jsonFetch<Planning>(`/api/manage/planning/${pathPart(pid)}`),
  setPlanning: (pid: string, body: Partial<Planning>) =>
    jsonFetch<Planning>(`/api/manage/planning/${pathPart(pid)}`, {
      method: "PUT",
      body: jsonBody(body),
    }),
  // 크레딧 풀·그룹 한도(워크스페이스 단위) — 대시보드 카드(권한별 범위는 서버가 정함)·설정 창(전역 PM)
  creditPlan: (workspaceId: string) =>
    jsonFetch<CreditPlanView>(withQuery("/api/manage/credit-plan", { workspace_id: workspaceId })),
  creditPlanSettings: (workspaceId: string) =>
    jsonFetch<CreditPlanSettings>(`/api/manage/credit-plan/${pathPart(workspaceId)}/settings`),
  saveCreditPlan: (workspaceId: string, body: CreditPlanSaveBody) =>
    jsonFetch<CreditPlanSettings>(`/api/manage/credit-plan/${pathPart(workspaceId)}`, {
      method: "PUT",
      body: jsonBody(body),
    }),
  // 본인 그룹이 쓸 수 있는 모델(생성 창·캔버스 모델 노드가 모델 목록을 거를 때) — 매니저도 본인 이메일 기준. 구서버는 404.
  // 관리 표 — 계정 한 줄에 등급·그룹·프로젝트 참여·보고된 사실(서버 조인). 구서버는 404.
  memberTable: (workspaceId?: string) =>
    jsonFetch<MemberTableData>(withQuery("/api/manage/member-table", { workspace_id: workspaceId })),
  creditPlanMyModels: (workspaceId: string) =>
    jsonFetch<MyModelPolicy>(withQuery("/api/manage/credit-plan/my-models", { workspace_id: workspaceId })),
  listTasks: (projectId: string, workspaceId?: string, includeArchived = false) =>
    jsonFetch<Task[]>(withQuery("/api/manage/tasks", {
      project_id: projectId,
      workspace_id: workspaceId,
      include_archived: includeArchived || undefined,
    })),
  // 여러 프로젝트 작업을 배치 조회한다. 500개를 넘으면 서버 상한에 맞춰 순차 분할하며,
  // 한 조각이라도 실패하면 불완전한 목록을 정상 결과로 돌려주지 않는다.
  listTasksBatch: async (projectIds: string[], workspaceId?: string, includeArchived = false) => {
    const result: Record<string, Task[]> = {};
    for (const projectChunk of chunked([...new Set(projectIds)])) {
      Object.assign(
        result,
        await jsonFetch<Record<string, Task[]>>(
          withQuery("/api/manage/tasks-batch", {
            project_id: projectChunk,
            workspace_id: workspaceId,
            include_archived: includeArchived || undefined,
          }),
        ),
      );
    }
    return result;
  },
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
  // 프로젝트 상세 보고서 — 생성물 1건 = 1행(프로젝트·폴더·작성자·크레딧·소요시간). HF 호환 usageExport 와 별도.
  usageDetailExport: (f: TeamFilters = {}) =>
    jsonFetch<{ rows: TeamUsageDetailRow[] }>(
      withQuery("/api/manage/usage-detail-export", {
        date_from: f.dateFrom,
        date_to: f.dateTo,
        project_id: f.projectId,
        creator_uid: f.creatorUid,
        workspace_id: f.workspaceId,
        model: f.model,
      }),
    ),
  // 완료본 렌더폴더 저장 — 완료 작업의 최종본만 물리 저장(멱등). saved/skipped/errors 반환.
  //  folderPath 를 주면 그 폴더(하위 포함)의 저장 대상만(폴더 우클릭 '최종 경로로 저장'). 없으면 프로젝트 전체.
  //  kind: final(기본 — 최종본) · shared(공유 중·최종 아님 → 컷 폴더의 shared/) · all(둘 다).
  saveFinals: (projectId: string, folderPath?: string, kind?: SaveFinalsKind | "all") =>
    jsonFetch<SaveFinalsResult>(
      withQuery("/api/manage/save-finals", {
        project_id: projectId,
        ...(folderPath ? { folder_path: folderPath } : {}),
        ...(kind ? { kind } : {}),
      }),
      { method: "POST" },
    ),
  // 비교 — 프로그램이 원하는 집합(최종+공유) vs 이 PC 의 렌더 폴더. 읽기만 한다.
  saveFinalsCompare: (projectId: string) =>
    jsonFetch<SaveFinalsCompare>(withQuery("/api/manage/save-finals/compare", { project_id: projectId })),
  // 미러 — 없는 것을 저장하고, 폴더에만 남은 우리 파일을 격리 폴더로 옮긴다. confirm = 사용자가 확인 창에서 본 목록(서버는 그 교집합만 옮긴다).
  saveFinalsMirror: (projectId: string, confirm: { folder_path: string; filename: string }[], allowMany = false) =>
    jsonFetch<SaveFinalsResult>(withQuery("/api/manage/save-finals/mirror", { project_id: projectId }), {
      method: "POST",
      body: jsonBody({ confirm, allow_many: allowMany }),
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

export interface TeamUsageDetailRow {
  date: string | null; // 생성일 없는 행(날짜 없는 tombstone)도 실린다 — 합계 대조용
  created_local: string | null;
  user_email: string;
  user_id: string | null;
  user_name: string | null;
  workspace_name: string | null;
  project_id: string | null;
  project_name: string | null;
  folder_path: string | null;
  model: string;
  output_type: string | null;
  status: string | null;
  credits: number;
  credit_basis: "real" | "est" | "unknown";
  elapsed_seconds: number | null;
  started_local: string | null;
  completed_local: string | null;
  is_final: number;
  is_shared: number;
  is_deleted: number;
  job_id: string | null;
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
  usage_scope?: "all" | "mine"; // 서버가 강제한 범위 — mine=일반 멤버(내 기록만). 구서버는 없음(read_all 전용).
  // 거래 원장 — 실제로 오간 크레딧. ★생성물 집계(totals)와 **더하면 안 된다**(이중 집계):
  // totals 는 생성물별 실제 또는 견적이고, 이쪽은 거래 기록이다. 환불은 여기서만 반영된다.
  // null = 이 범위에서는 줄 수 없음(프로젝트·작업자·모델 드릴 — 원장은 그 축을 모른다).
  // 없음(undefined) = 이 필드를 모르는 구서버.
  ledger?: LedgerTotals | null;
}

export interface LedgerTotals {
  spend: number;
  refund: number;
  net: number; // 사용 − 환불. 지출 없이 환불만 있는 달이 있어 **음수일 수 있다**.
  spend_count: number;
  refund_count: number;
  other?: Record<string, number>; // spend/refund 밖의 action(예: grant). 실측 970건엔 0건이었다.
  // 공간을 골랐을 때만. ★이 금액이 그 공간 것이라는 뜻이 아니라, **공간을 몰라 위 합계에
  // 넣지 못한** 거래다(옛 에이전트가 올린 행).
  unknown_workspace?: { spend: number; refund: number; count: number };
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
  // 미러만: 격리 폴더로 옮긴 파일 · 방금 쓰여서 안 옮긴 수 · 격리 폴더(렌더 폴더 아래 경로)
  moved?: { folder_path: string; filename: string }[];
  skipped_recent?: number;
  quarantine?: string | null;
}

export type SaveFinalsKind = "final" | "shared";

export interface SaveFinalsTarget {
  gen_id: string;
  kind?: SaveFinalsKind; // 구백엔드는 없음(= final)
  folder_path: string | null;
  filename: string;
  saved: boolean; // 이미 렌더폴더에 존재
  reason: string | null; // null=저장 가능, 값 있으면 저장 불가 사유
}

export interface SaveFinalsCompareItem {
  gen_id: string;
  kind: SaveFinalsKind;
  folder_path: string; // 렌더 폴더 아래 저장 폴더(공유본은 …/shared)
  filename: string;
  reason?: string;
}

export interface SaveFinalsCompare {
  shared_supported: boolean;
  to_add: SaveFinalsCompareItem[]; // 프로그램에는 있는데 폴더에 없다
  extra: SaveFinalsCompareItem[]; // 폴더에만 남은 우리 파일(이름 규칙 + 각인 일치)
  blocked: SaveFinalsCompareItem[]; // 저장 불가(사유)
  same: number;
  unknown: number; // 모르는 파일 — 세기만 하고 건드리지 않는다
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
  // 공유 저장을 쓸 수 있나 — 공유 서버가 구버전이면 false(최종 저장은 그대로 된다). 구백엔드 응답엔 필드가 없다.
  shared_supported?: boolean;
  shared_error?: string | null; // 구버전이 아닌 이유로 공유 목록을 못 읽었을 때
  targets: SaveFinalsTarget[];
  history: SaveFinalsHistory[];
}
