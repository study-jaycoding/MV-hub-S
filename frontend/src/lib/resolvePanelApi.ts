import { jsonFetch } from "./http";
import { t } from "./i18n";

export const PANEL_PROTOCOL = 1;
export interface PanelContext { instance: string; account: string; epoch: number }
export interface PanelIdentity extends PanelContext { protocol: { min: number; max: number }; writer?: boolean; owner_state?: "unclaimed" | "writer" | "other_window"; generation?: number; active_bin_id?: string }
export interface ResolveDragBridge {
  protocol: number;
  accepts: { min: number; max: number };
  startDrag(path: string, opts: { protocol: number }): boolean;
}
declare global { interface Window { mvhubResolve?: ResolveDragBridge } }
export type TargetState = "ok" | "missing" | "stale" | "busy" | "rebuild_recovery_pending" | "unavailable" | "account_changed" | "other_window" | "active_bin" | "not_seen"
  | "project_changed" | "restore_failed";
export interface TargetResult {
  state: TargetState; resolve_project_id?: string; resolve_project_name?: string;
  bin_path?: string; bin_id?: string; details?: unknown;
  cleanup_failed?: boolean; cleanup_details?: string;
  used?: string[]; target_bin_id?: string;
  // 에피소드 target — 컷 경로 → 빈 ID, 에피소드 빈 ID, 못 만든 컷
  bins?: Record<string, string>; episode_bin_id?: string; bin_create_failed?: string[];
  // 패널 target은 기존 빈을 보존하고 없는 빈만 추가 — 정렬·백업 필드는 호환용, ids_changed는 보수적 무효화
  reordered?: boolean; folder_order_backup?: string; order_error?: string; ids_changed?: boolean; code?: string;
}
export interface DragItem { path: string; item_id: string; preview_url: string }
export interface StageResult extends TargetResult { items?: { gen_id: string; state: string }[]; removed?: number; deferred?: number; capped?: boolean; unexpected_imports?: number; drag_items?: Record<string, DragItem> }
export interface InventoryItem { resolve_project_id: string; project_id: string; folder_path: string; bin_id: string; bin_path: string; item_id: string; gen_id: string; usage?: number | null; recovery?: boolean }
export interface InventoryResult extends TargetResult { items?: InventoryItem[]; more?: boolean; after?: [string, string]; other_owner?: number; needs_attention?: number; active_bin_id?: string; unmanaged_local?: number }
export type AdoptState = "in_bin" | "stamp_failed" | "save_failed" | "ledger_failed" | "conflict" | "elsewhere" | "not_seen" | "not_prepared" | "project_changed" | "busy" | "unknown" | "account_changed" | "rebuild_recovery_pending" | "replace_failed" | "other_window";
export interface AdoptResult { state: AdoptState; details?: unknown; missing_record_ids?: string[]; cleanup_failed?: boolean; cleanup_details?: string }
export interface PrepareResult { gen_id: string; state: "prepared" | "failed" | "account_changed" | "other_window"; path?: string; error?: string }
// expect_project = 화면이 본 다빈치 프로젝트 — 쓰기 전에 리졸브 쪽이 대조한다(다르면 쓰기 0)
export interface PanelSelection { ctx: PanelContext; project_id: string; folder_path: string; window?: string; expect_project?: string }
// 미리 띄우기·이름 뒤따르기의 컷 — 이 창이 target 으로 받은 컷 빈 ID 와 그 컷의 생성물(거르기 통과·오래된 200개)
export interface PanelCut { folder_path: string; bin_id: string; gen_ids: string[]; capped?: boolean }
export interface PrestageResult extends TargetResult { cuts?: Record<string, StageResult>; restore_failed?: boolean; restored?: boolean; restore_reason?: string }
export interface RenameResult extends TargetResult { named?: number; failed?: number; remaining?: number; after?: [number, number] | null }
// [저장] — not_clean = 이 PC 클립·패널 표식이 남아 저장하지 않음(내 허브 것 = 다시 저장하면 풀릴 수 있음, 다른 허브 것 = 다빈치에서 직접 지워야 함)
export interface SaveResult extends Omit<TargetResult, "state"> {
  state: TargetState | "not_clean" | "scan_failed" | "save_failed" | "ledger_failed" | "cleanup_failed";
  project_saved?: boolean;
  not_clean?: { mine: number; other: number; in_use: number; bins: { path: string; count?: number; in_use: boolean; mine: boolean }[] };
}
// 앞 에피소드 컷 빈 한 번에 정리 — 빈마다 결과(지운 수·빈 지움·쓰인 생성물 = 그 뒤 NAS 로), 건너뛴 빈은 state 만
export interface SettleBinResult { state: string; removed?: number; bin_deleted?: boolean; used?: string[] }
export interface SettleResult extends Omit<TargetResult, "bins"> { bins?: Record<string, SettleBinResult>; removed?: number }
export const contextKey = (ctx: PanelContext | null) => ctx ? JSON.stringify([ctx.instance, ctx.account, ctx.epoch]) : "";
const post = <T,>(path: string, body: unknown) => jsonFetch<T>(`/api/resolve/panel/${path}`, { method: "POST", body: JSON.stringify(body) });
export const resolvePanelApi = {
  identity: (window = "", claim = false) => jsonFetch<PanelIdentity>(`/api/resolve/panel/identity?${new URLSearchParams({ window, claim: String(claim) })}`),
  cache: (body: PanelSelection & { window: string; seq: number; gen_ids: string[] }) => post<{ state?: "account_changed"; items: { gen_id: string; state: "cached" | "failed"; error?: string; preview_url?: string }[] }>("cache", body),
  prepare: (body: PanelSelection & { gen_id: string }) => post<PrepareResult>("prepare", body),
  target: (body: PanelSelection & { window: string; seq: number; create: boolean; episode_path?: string; create_paths?: string[]; keep_current?: boolean }) => post<TargetResult>("target", body),
  currentBin: (ctx: PanelContext, project_id = "", folder_path = "") => jsonFetch<TargetResult>(`/api/resolve/panel/current-bin?${new URLSearchParams({ instance: ctx.instance, account: ctx.account, epoch: String(ctx.epoch), project_id, folder_path })}`),
  adopt: (body: PanelSelection & { gen_id: string; resolve_project_id: string; bin_id?: string; item_ids?: string[]; defer_save?: boolean }) => post<AdoptResult>("adopt", body),
  stage: (body: PanelSelection & { window: string; seq: number; gen_ids: string[]; capped?: boolean; bin_id?: string }) => post<StageResult>("stage", body),
  unstage: (body: PanelSelection & { bin_id: string; inventory_cleanup?: boolean }) => post<TargetResult>("unstage", body),
  inventory: (ctx: PanelContext, after?: [string, string]) => jsonFetch<InventoryResult>(`/api/resolve/panel/inventory?${new URLSearchParams({ instance: ctx.instance, account: ctx.account, epoch: String(ctx.epoch), ...(after ? { after: JSON.stringify(after) } : {}) })}`),
  prestage: (body: PanelSelection & { window: string; episode_bin_id: string; cuts: PanelCut[]; borrow?: boolean; borrow_bin_id?: string }) => post<PrestageResult>("prestage", body),
  rename: (body: PanelSelection & { window: string; cuts: PanelCut[]; limit?: number; after?: [number, number] }) => post<RenameResult>("rename", body),
  save: (body: PanelSelection & { window: string; expect_project: string }) => post<SaveResult>("save", body),
  settle: (body: PanelSelection & { window: string; bins: { folder_path: string; bin_id: string }[] }) => post<SettleResult>("settle", body),
};

export function hasResolveBridge(bridge: ResolveDragBridge | undefined): bridge is ResolveDragBridge {
  return !!bridge;
}
export function bridgeCompatible(bridge: ResolveDragBridge | undefined, identity: PanelIdentity | null): boolean {
  return hasResolveBridge(bridge) && !!identity && typeof bridge.startDrag === "function"
    && Number.isInteger(bridge.protocol) && bridge.protocol >= identity.protocol.min && bridge.protocol <= identity.protocol.max
    && PANEL_PROTOCOL >= bridge.accepts?.min && PANEL_PROTOCOL <= bridge.accepts?.max;
}
export const BRIDGE_MISSING = "리졸브의 MV Hub 창에서만 끌어 넣을 수 있습니다";
export const PROTOCOL_MISMATCH = "리졸브 창의 판이 맞지 않습니다 — 리졸브를 다시 켜 주세요";
export const RECOVERY_PENDING = "리졸브 보내기 정렬 복구가 끝나지 않았습니다 — 복구 뒤 다시";
export function adoptAction(state: AdoptState): "done" | "retry" | "busy" | "prepare" | "reset" | "block" | "stop" {
  switch (state) {
    case "in_bin": return "done";
    case "not_seen": return "stop";
    case "busy": return "stop";
    case "not_prepared": return "prepare";
    case "account_changed": return "reset";
    case "rebuild_recovery_pending": return "block";
    default: return "stop";
  }
}
export function targetView(result: TargetResult): { action: "set" | "ignore" | "reset"; ready: boolean; message: string } {
  switch (result.state) {
    case "ok": return { action: "set", ready: true, message: `${t("리졸브 빈")}: ${result.bin_path || ""}` };
    case "stale": return { action: "ignore", ready: false, message: "" };
    case "account_changed": return { action: "reset", ready: false, message: "" };
    case "missing": return { action: "set", ready: false, message: t("리졸브 빈을 먼저 확인해 주세요") };
    case "other_window": return { action: "set", ready: false, message: t("다른 MV 창이 리졸브를 맡고 있습니다") };
    case "busy": return { action: "set", ready: false, message: t("확인 중") };
    case "rebuild_recovery_pending": return { action: "set", ready: false, message: t(RECOVERY_PENDING) };
    default: return { action: "set", ready: false, message: typeof result.details === "string" ? result.details : t("리졸브에 연결하지 못했습니다") };
  }
}
export function cacheBatches(ids: string[]): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += 500) batches.push(ids.slice(index, index + 500));
  return batches;
}
export function inventoryAction(item: InventoryItem): "recover" | "adopt" | "unstage" | "preserve" {
  if (item.recovery) return "recover";
  if (Number.isInteger(item.usage) && item.usage! > 0) return "adopt";
  return item.usage === 0 ? "unstage" : "preserve";
}
export function stageSummary(result: StageResult | null) {
  const items = result?.items || [];
  return { staged: items.filter(item => ["staged", "present"].includes(item.state)).length,
    sameFile: items.filter(item => item.state === "same_file_exists").length,
    failed: items.filter(item => ["import_failed", "conflict"].includes(item.state)),
    deferred: result?.deferred || 0 };
}

export function panelFailure(state: string): string {
  const labels: Record<string, string> = {
    replace_failed: "원본 바꿔 끼우기를 확인하지 못했습니다", stamp_failed: "클립 표시를 확인하지 못했습니다",
    save_failed: "프로젝트 저장을 확인하지 못했습니다", ledger_failed: "전송 장부를 기록하지 못했습니다",
    cleanup_failed: "복구 기록 정리를 마치지 못했습니다. 다시 저장해 주세요",
    // 저장과 무관한 장면(컷 옮기기·받아 두기)의 정리 실패 — '다시 저장' 안내는 [저장] 마무리에서만
    cleanup_pending: "복구 기록 파일을 정리하지 못했습니다 — 파일이 잠겨 있거나 권한이 없을 수 있습니다",
    import_failed: "가져오기를 확인하지 못했습니다",
    conflict: "클립 경로나 표시 충돌 — 다빈치에서 원래 파일로 다시 연결해 주세요. 사용하지 않는 클립은 미디어 풀에서 제거한 뒤 다시 저장해 주세요",
    not_seen: "항목을 찾지 못했습니다",
    project_changed: "프로젝트가 바뀜", busy: "확인 중 — 리졸브가 바쁨", unknown: "확인 못 함",
    unavailable: "리졸브에 연결하지 못했습니다", active_bin: "지금 쓰는 빈이라 남겼습니다",
    restore_failed: "다빈치 지금 빈을 처음 자리로 되돌리지 못했습니다",
    not_clean: "이 PC 클립이 남아 저장하지 않았습니다", scan_failed: "미디어 풀을 다 확인하지 못해 저장하지 않았습니다",
    rebuild_recovery_pending: RECOVERY_PENDING, not_prepared: "준비 기록을 찾지 못했습니다",
  };
  return t(labels[state] || "확인 못 함");
}
