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

/**
 * 전송 접수 응답(202). 원본 복사·Resolve 가져오기는 전담 워커가 큐에서 처리하므로
 * 이 응답에는 아직 결과가 없다. 진행 상황은 큐 조회로 본다.
 */
export interface ResolveTransferAccepted {
  transfer_id: string;
  project_id: string;
  project_name: string;
  queued: boolean;
  ahead: number;
  queue: { state: string; dispatch_policy: string };
  resolve_target: ResolveProjectTarget;
  status: string;
  total: number;
  /** 설정 조건이 아니라 '드레인 워커가 실제로 도는가'. 잠금 self-test 실패면 false다. */
  worker_enabled: boolean;
  /** worker_enabled 가 false 인 이유(사용자에게 그대로 보여 준다). */
  worker_detail?: string;
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
  status:
    | "ready"
    | "no_project"
    | "not_running"
    | "api_unavailable"
    | "module_unavailable"
    | "python_incompatible";
  connected: boolean;
  process_running: boolean;
  project_open: boolean;
  project_id: string;
  project_name: string;
  resolve_version?: string;
  resolve_product?: string;
  message: string;
}

export interface ResolveDiagnosticCheck {
  key: string;
  label: string;
  state: "ok" | "warning" | "error" | "info";
  message: string;
  detail: string;
}

export interface ResolveEnvironmentDiagnostics {
  status: "ready" | "menu_ready" | "action_required";
  summary: string;
  checks: ResolveDiagnosticCheck[];
  recommendations: string[];
  script: ResolveScriptStatus;
  connection: ResolveConnectionStatus;
  environment: {
    windows_user: string;
    mvhub_python: { version: string; bits: number; path: string };
    system_pythons: Array<{
      scope: "current_user" | "all_users";
      version: string;
      bits: number | null;
      path: string;
      resolve_menu_compatible: boolean;
    }>;
    resolve_installations: Array<{
      path: string;
      executable: string;
      version: string;
      name: string;
    }>;
    api: {
      module_candidates: string[];
      existing_module_paths: string[];
      library_candidates: string[];
      library_path: string;
    };
  };
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

/**
 * ★"가져온 개수"만 말하면 준비 단계에서 떨어진 원본이 조용히 사라진다. 준비 실패와
 * 가져오기 실패를 합쳐 항상 실패 건수를 함께 적어, 일부만 성공한 전송이 '완료'로
 * 읽히지 않게 한다(백엔드도 같은 경우 queue.state 를 failed 로 확정한다).
 */
export function resolveTransferSummary(result: ResolveTransferResult): string {
  const prepared = result.downloaded + result.skipped;
  const prepareFailed = result.error_count;
  const firstPrepareError = result.items.find((item) => item.status === "error")?.error;
  const imported = result.resolve_import;
  if (imported.status === "unavailable") {
    return [
      `원본 ${prepared}개 준비 완료`,
      prepareFailed ? `· 준비 실패 ${prepareFailed}개` : "",
      `· ${imported.error || "Resolve 연결 실패"}`,
    ]
      .filter(Boolean)
      .join(" ");
  }
  const importedCount = imported.imported + imported.skipped;
  const failedTotal = prepareFailed + imported.error_count;
  if (failedTotal || imported.status === "failed" || imported.error) {
    const firstImportError = imported.items.find((item) => item.status === "error")?.error;
    const reason = firstImportError || imported.error || firstPrepareError;
    return [
      `Resolve 가져오기 ${importedCount}개 완료 · ${failedTotal}개 실패`,
      reason ? `(${reason})` : "",
      prepareFailed ? `· 원본 준비 실패 ${prepareFailed}개 포함` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  const existing = imported.skipped ? ` · 기존 ${imported.skipped}개` : "";
  return `Resolve ${imported.imported}개 가져오기 완료${existing} · ${imported.target_root}`;
}

export function resolveTransferAcceptedSummary(
  accepted: ResolveTransferAccepted,
): string {
  const head = `Resolve 원본 ${accepted.total}개를 대기열에 접수했습니다`;
  if (!accepted.worker_enabled) {
    // 워커가 왜 안 도는지(잠금 미지원 등)를 그대로 보여 준다 — 무한 대기 오해 방지.
    return `${head} · ${accepted.worker_detail || "이 PC에서는 자동 가져오기가 꺼져 있습니다"}`;
  }
  return accepted.ahead
    ? `${head} · 앞 작업 ${accepted.ahead}건`
    : `${head} · 곧 원본을 준비합니다`;
}

export function createResolveTransfer(
  genIds: string[],
  target?: ResolveProjectTarget,
): Promise<ResolveTransferAccepted> {
  return jsonFetch<ResolveTransferAccepted>("/api/resolve/transfers", {
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

export function getResolveEnvironmentDiagnostics(): Promise<ResolveEnvironmentDiagnostics> {
  return jsonFetch<ResolveEnvironmentDiagnostics>("/api/resolve/diagnostics", {
    cache: "no-store",
  });
}

export interface ResolvePythonInstallResult {
  ok: boolean;
  version: string;
  installer_path: string;
  message: string;
}

/** 호환 Python이 없는 PC에서 공식 Python 반자동 설치(UAC 승인만 필요)를 시작한다. */
export function startResolvePythonInstall(): Promise<ResolvePythonInstallResult> {
  return jsonFetch<ResolvePythonInstallResult>("/api/resolve/python-install", {
    method: "POST",
  });
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
