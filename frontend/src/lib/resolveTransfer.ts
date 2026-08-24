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
  /** 같은 접수 키의 재요청이라 새 전송을 만들지 않고 첫 접수분을 돌려준 경우 true. */
  duplicate?: boolean;
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
  const head = accepted.duplicate
    ? `Resolve 원본 ${accepted.total}개는 이미 대기열에 있습니다`
    : `Resolve 원본 ${accepted.total}개를 대기열에 접수했습니다`;
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

// ── v3 큐 조회·조작 ──────────────────────────────────────────────────────────
export type ResolveQueueState =
  | "queued"
  | "preparing"
  | "ready"
  | "blocked"
  | "importing"
  | "complete"
  | "failed"
  | "interrupted"
  | "recovery_required"
  | "cancelled";

export interface ResolveQueueBlocked {
  code: string;
  message?: string | null;
  expected?: string;
  observed?: string;
  expected_project_name?: string;
  observed_project_name?: string;
}

export interface ResolveQueueRecovery {
  reason: string;
  existing_count?: number;
  missing_count?: number;
  missing_item_ids?: string[];
  staging_bin?: string;
  drp_path?: string;
}

export interface ResolveQueueWarning {
  code: string;
  elapsed_seconds: number;
  message: string;
}

export interface ResolveQueueRow {
  transfer_id: string;
  project_id: string;
  project_name: string;
  resolve_target: ResolveProjectTarget;
  state: ResolveQueueState;
  dispatch_policy: string;
  created_at: string;
  state_changed_at: string;
  total: number;
  downloaded: number;
  skipped: number;
  error_count: number;
  ahead: number;
  blocked: ResolveQueueBlocked | null;
  recovery: ResolveQueueRecovery | null;
  cancel?: { requested_at: string | null; requested_by: string | null; force: boolean } | null;
  warning: ResolveQueueWarning | null;
  error_code: string | null;
  error: string | null;
}

export interface ResolveQueueSnapshot {
  items: ResolveQueueRow[];
  worker_enabled: boolean;
  worker_detail?: string;
}

export interface ResolveQueueCancelResult {
  ok: boolean;
  transfer_id: string;
  previous_state: ResolveQueueState;
  state: ResolveQueueState;
  applied: boolean;
  cooperative: boolean;
  force: boolean;
  child_stopped: boolean;
}

export interface ResolveQueueResumeResult {
  ok: boolean;
  transfer_id: string;
  previous_state: ResolveQueueState;
  state: ResolveQueueState;
  recovery: ResolveQueueRecovery | null;
}

export function getResolveQueue(): Promise<ResolveQueueSnapshot> {
  return jsonFetch<ResolveQueueSnapshot>("/api/resolve/queue", { cache: "no-store" });
}

export function cancelResolveQueueTransfer(
  transferId: string,
  force = false,
): Promise<ResolveQueueCancelResult> {
  return jsonFetch<ResolveQueueCancelResult>(
    `/api/resolve/queue/${encodeURIComponent(transferId)}/cancel`,
    { method: "POST", body: jsonBody({ force }) },
  );
}

export function resumeResolveQueueTransfer(
  transferId: string,
): Promise<ResolveQueueResumeResult> {
  return jsonFetch<ResolveQueueResumeResult>(
    `/api/resolve/queue/${encodeURIComponent(transferId)}/resume`,
    { method: "POST" },
  );
}

/** 사용자가 손봐야 진행되는 상태 — 배지에서 눈에 띄게 세는 기준. */
const ATTENTION_STATES: ResolveQueueState[] = [
  "blocked",
  "interrupted",
  "recovery_required",
  "failed",
];

export interface ResolveQueueSummary {
  waiting: number;
  running: number;
  blocked: number;
  failed: number;
  attention: number;
  active: number;
}

/** 배지에 쓸 집계. 완료·폐기는 이미 끝난 일이라 세지 않는다. */
export function summarizeResolveQueue(rows: ResolveQueueRow[]): ResolveQueueSummary {
  const summary: ResolveQueueSummary = {
    waiting: 0,
    running: 0,
    blocked: 0,
    failed: 0,
    attention: 0,
    active: 0,
  };
  for (const row of rows) {
    if (row.state === "queued" || row.state === "ready") summary.waiting += 1;
    else if (row.state === "preparing" || row.state === "importing") summary.running += 1;
    else if (row.state === "blocked") summary.blocked += 1;
    else if (row.state === "failed" || row.state === "interrupted" || row.state === "recovery_required") {
      summary.failed += 1;
    }
    if (ATTENTION_STATES.includes(row.state)) summary.attention += 1;
    if (row.state !== "complete" && row.state !== "cancelled") summary.active += 1;
  }
  return summary;
}

const STATE_LABELS: Record<ResolveQueueState, string> = {
  queued: "대기 중",
  preparing: "원본 준비 중",
  ready: "가져오기 대기",
  blocked: "보류",
  importing: "Resolve로 가져오는 중",
  complete: "완료",
  failed: "실패",
  interrupted: "중단됨 · 확인 필요",
  recovery_required: "복구 확인 필요",
  cancelled: "폐기됨",
};

export function resolveQueueStateLabel(state: ResolveQueueState): string {
  return STATE_LABELS[state] || state;
}

/**
 * 보류 원인별 "무엇이 문제이고 무엇을 하면 되는지"를 한 줄로.
 * ★코드마다 행동 지시가 다르므로 message 를 그대로 흘리지 않는다 — 사용자가 읽고
 * 바로 다음 행동을 알 수 있어야 큐가 멈춘 채 방치되지 않는다.
 */
export function resolveBlockedText(blocked: ResolveQueueBlocked | null): string {
  if (!blocked) return "";
  const expected = blocked.expected_project_name || blocked.expected || "";
  const observed = blocked.observed_project_name || blocked.observed || "";
  switch (blocked.code) {
    case "project_changed":
      return `다른 Resolve 프로젝트가 열려 있습니다 · 예정 ${expected || "확인 불가"} / 현재 ${observed || "확인 불가"} → 예정 프로젝트를 열면 자동으로 이어집니다`;
    case "not_running":
      return "DaVinci Resolve가 실행 중이지 않습니다 → Resolve를 실행하면 자동으로 이어집니다";
    case "no_project":
      return "Resolve에 열린 프로젝트가 없습니다 → 대상 프로젝트를 열면 자동으로 이어집니다";
    case "api_unavailable":
      return "Resolve에 연결하지 못했습니다 → Resolve를 다시 실행한 뒤 연결 상태를 확인하세요";
    case "target_unverifiable":
      return "열린 Resolve 프로젝트를 확인할 수 없습니다 → 대상 프로젝트를 다시 열어 주세요";
    case "python_incompatible":
      return "Resolve 연결용 Python을 찾지 못했습니다 → 설정의 Resolve 진단에서 설치하세요";
    case "module_unavailable":
      return "Resolve 스크립팅 모듈을 찾지 못했습니다 → 설정의 Resolve 진단을 확인하세요";
    case "spawn_failed":
      return "가져오기 프로세스를 실행하지 못했습니다 → 잠시 뒤 자동으로 다시 시도합니다";
    case "journal_unavailable":
      return "가져오기 기록을 남길 수 없습니다 → 공유 폴더 연결을 확인하세요";
    case "account_scope_changed":
      return "접수할 때와 다른 계정으로 로그인되어 있습니다 → 원래 계정으로 돌아오면 자동으로 이어집니다";
    case "server_changed":
      return "접수할 때와 다른 공유 서버에 연결되어 있습니다 → 원래 서버로 돌아오면 자동으로 이어집니다";
    case "destination_changed":
      return "렌더 폴더 위치가 접수할 때와 달라졌습니다 → 원래 위치로 되돌리거나 다시 보내세요";
    case "locking_unsupported":
      return "이 저장소에서는 대기열 잠금을 쓸 수 없습니다 → 다른 공유 폴더나 로컬 디스크를 쓰세요";
    default:
      return blocked.message || "조건이 회복되면 자동으로 이어집니다";
  }
}

/** 큐 한 줄의 설명문 — 상태별로 원인과 다음 행동을 분명히 한다. */
export function resolveQueueDetail(row: ResolveQueueRow): string {
  const prepared = row.downloaded + row.skipped;
  switch (row.state) {
    case "queued":
      return row.ahead ? `앞 작업 ${row.ahead}건` : "곧 원본을 준비합니다";
    case "preparing":
      return `원본 ${prepared}/${row.total}개 복사됨`;
    case "ready":
      return row.dispatch_policy === "manual_only"
        ? "확인을 눌러야 가져오기를 시작합니다"
        : row.ahead
          ? `가져오기 차례 대기 · 앞 작업 ${row.ahead}건`
          : "곧 Resolve로 가져옵니다";
    case "importing":
      return (
        row.warning?.message ||
        `Resolve Media Pool에 ${prepared}개를 넣는 중입니다`
      );
    case "blocked":
      return resolveBlockedText(row.blocked);
    case "interrupted":
      return `가져오기 도중 결과를 확정하지 못했습니다 · 누락 ${row.recovery?.missing_count ?? 0}개 → [누락분 다시 가져오기]로 남은 것만 넣을 수 있습니다`;
    case "recovery_required": {
      const staging = row.recovery?.staging_bin
        ? ` 임시 Bin ${row.recovery.staging_bin}과(와)`
        : "";
      const backup = row.recovery?.drp_path
        ? ` 백업: ${row.recovery.drp_path}`
        : " 백업: 없음";
      return `자동 가져오기를 멈췄습니다 → Resolve에서${staging} MV Hub Bin을 확인한 뒤 [Bin 확인함]을 누르세요.${backup}`;
    }
    case "failed":
      return row.error || "전송이 실패했습니다 → [다시 시도]를 누르면 같은 조건으로 재실행합니다";
    case "cancelled":
      return "사용자가 폐기했습니다";
    default:
      return prepared ? `원본 ${prepared}개 · ${row.total}개 중` : "";
  }
}

export interface ResolveQueueActions {
  canCancel: boolean;
  /** 취소가 Resolve 조작을 끊어야 하는 상태 — 2차 확인을 받아야 한다. */
  needsForce: boolean;
  canResume: boolean;
  resumeLabel: string;
}

export function resolveQueueActions(row: ResolveQueueRow): ResolveQueueActions {
  const terminal = row.state === "complete" || row.state === "cancelled";
  const resumeLabel =
    row.state === "interrupted"
      ? "누락분 다시 가져오기"
      : row.state === "recovery_required"
        ? "Bin 확인함 · 다시 검사"
        : "다시 시도";
  return {
    canCancel: !terminal,
    needsForce: row.state === "importing",
    canResume:
      row.state === "failed" ||
      row.state === "blocked" ||
      row.state === "interrupted" ||
      row.state === "recovery_required",
    resumeLabel,
  };
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
