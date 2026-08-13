import type { Generation } from "../types";
import { jsonBody, jsonFetch } from "./http";

export interface ResolveTransferItem {
  generation_id: string;
  folder_path: string;
  filename: string;
  media_type: string;
  local_path: string;
  status: "pending" | "downloaded" | "skipped" | "error";
  error: string | null;
}

export interface ResolveTransferResult {
  format: string;
  version: number;
  transfer_id: string;
  project_id: string;
  project_name: string;
  source_root: string;
  manifest_root: string;
  manifest_path: string;
  status: "pending" | "complete" | "partial" | "failed";
  total: number;
  downloaded: number;
  skipped: number;
  error_count: number;
  items: ResolveTransferItem[];
  resolve_target?: ResolveProjectTarget;
  resolve_import: ResolveImportResult;
}

export interface ResolveProjectTarget {
  project_id: string;
  project_name: string;
}

export interface ResolveImportItem {
  generation_id: string;
  local_path: string;
  media_pool_path: string;
  status: "pending" | "imported" | "skipped" | "error";
  error: string | null;
}

export interface ResolveImportResult {
  status: "pending" | "complete" | "partial" | "failed" | "unavailable";
  project_name: string;
  target_root: string;
  total: number;
  imported: number;
  skipped: number;
  error_count: number;
  error: string | null;
  items: ResolveImportItem[];
}

export interface ResolveScriptStatus {
  installed: boolean;
  up_to_date: boolean;
  bundled_version: string | null;
  importer_bundled_version?: string | null;
  installed_version: string | null;
  path: string;
  paths?: string[];
  installed_paths?: string[];
  all_users_installed?: boolean;
  warnings?: string[];
  installations?: Array<{
    scope: "current_user" | "all_users";
    path: string;
    importer_path?: string;
    installed: boolean;
    up_to_date: boolean;
    installed_version: string | null;
    importer_installed?: boolean;
    importer_version?: string | null;
    error: string | null;
  }>;
}

export interface ResolveScriptInstallResult extends ResolveScriptStatus {
  changed: boolean;
  previous_version: string | null;
  migrated_paths?: string[];
  backup_paths?: string[];
}

export interface ResolveConnectionStatus {
  status: "ready" | "no_project" | "not_running" | "api_unavailable" | "module_unavailable";
  connected: boolean;
  process_running: boolean;
  project_open: boolean;
  project_id: string;
  project_name: string;
  resolve_version?: string;
  resolve_product?: string;
  message: string;
}

export type ResolveSelectionCheck =
  | { ok: true; genIds: string[] }
  | { ok: false; message: string };

/** 화면에서 먼저 설명할 수 있는 오류를 걸러 불필요한 대용량 요청을 만들지 않는다. */
export function checkResolveSelection(selected: Generation[]): ResolveSelectionCheck {
  if (!selected.length) return { ok: false, message: "Resolve로 보낼 결과물을 선택하세요." };
  if (selected.length > 500) {
    return { ok: false, message: "Resolve 전송은 한 번에 최대 500개까지 가능합니다." };
  }
  if (selected.some((generation) => generation.deleted)) {
    return { ok: false, message: "휴지통 항목을 제외한 뒤 Resolve로 보내세요." };
  }
  if (selected.some((generation) => generation.status !== "done")) {
    return { ok: false, message: "렌더가 완료된 결과물만 Resolve로 보낼 수 있습니다." };
  }
  if (selected.some((generation) => !generation.project_id)) {
    return { ok: false, message: "먼저 선택한 결과물을 프로젝트에 배정하세요." };
  }
  if (selected.some((generation) => !generation.folder_path)) {
    return { ok: false, message: "렌더 폴더 위치가 지정된 결과물만 전송할 수 있습니다." };
  }
  if (selected.some((generation) => !generation.assets.length)) {
    return { ok: false, message: "원본 파일이 없는 결과물이 포함되어 있습니다." };
  }
  const projectIds = new Set(selected.map((generation) => generation.project_id));
  if (projectIds.size !== 1) {
    return { ok: false, message: "Resolve 전송은 같은 프로젝트끼리 선택해야 합니다." };
  }
  return {
    ok: true,
    genIds: [...new Set(selected.map((generation) => generation.id))],
  };
}

export function resolveTransferSummary(result: ResolveTransferResult): string {
  const completed = result.downloaded + result.skipped;
  if (result.error_count) {
    const firstError = result.items.find((item) => item.status === "error")?.error;
    return [
      `Resolve 전송 ${completed}개 완료 · ${result.error_count}개 실패`,
      firstError ? `(${firstError})` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  const imported = result.resolve_import;
  if (imported.status === "unavailable") {
    return `원본 ${completed}개 준비 완료 · ${imported.error || "Resolve 연결 실패"}`;
  }
  const importedCount = imported.imported + imported.skipped;
  if (imported.error_count || imported.status === "failed" || imported.error) {
    const firstError = imported.items.find((item) => item.status === "error")?.error;
    const reason = firstError || imported.error;
    return [
      `Resolve 가져오기 ${importedCount}개 완료 · ${imported.error_count}개 실패`,
      reason ? `(${reason})` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  const existing = imported.skipped ? ` · 기존 ${imported.skipped}개` : "";
  return `Resolve ${imported.imported}개 가져오기 완료${existing} · ${imported.target_root}`;
}

export function createResolveTransfer(
  genIds: string[],
  target?: ResolveProjectTarget,
): Promise<ResolveTransferResult> {
  return jsonFetch<ResolveTransferResult>("/api/resolve/transfers", {
    method: "POST",
    body: jsonBody({
      gen_ids: genIds,
      resolve_project_id: target?.project_id || "",
      resolve_project_name: target?.project_name || "",
    }),
  });
}

export function getResolveConnectionStatus(): Promise<ResolveConnectionStatus> {
  return jsonFetch<ResolveConnectionStatus>("/api/resolve/status", { cache: "no-store" });
}

export function retryResolveTransfer(
  projectId: string,
  transferId: string,
): Promise<ResolveTransferResult> {
  return jsonFetch<ResolveTransferResult>("/api/resolve/transfers/retry", {
    method: "POST",
    body: jsonBody({ project_id: projectId, transfer_id: transferId }),
  });
}

export function getResolveScriptStatus(): Promise<ResolveScriptStatus> {
  return jsonFetch<ResolveScriptStatus>("/api/resolve/script");
}

export function installResolveScript(): Promise<ResolveScriptInstallResult> {
  return jsonFetch<ResolveScriptInstallResult>("/api/resolve/script/install", {
    method: "POST",
  });
}
