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
export type TargetState = "ok" | "missing" | "stale" | "busy" | "rebuild_recovery_pending" | "unavailable" | "account_changed" | "other_window" | "active_bin" | "not_seen";
export interface TargetResult {
  state: TargetState; resolve_project_id?: string; resolve_project_name?: string;
  bin_path?: string; bin_id?: string; details?: unknown;
  used?: string[]; target_bin_id?: string;
  // 에피소드 target — 컷 경로 → 빈 ID, 에피소드 빈 ID, 못 만든 컷 / unstage(delete_empty) — 비게 된 컷 빈을 지웠다
  bins?: Record<string, string>; episode_bin_id?: string; bin_create_failed?: string[]; bin_deleted?: boolean;
}
export interface StageResult extends TargetResult { items?: { gen_id: string; state: string }[]; removed?: number; deferred?: number; capped?: boolean; unexpected_imports?: number }
export interface InventoryItem { resolve_project_id: string; project_id: string; folder_path: string; bin_id: string; bin_path: string; item_id: string; gen_id: string; usage?: number | null; recovery?: boolean }
export interface InventoryResult extends TargetResult { items?: InventoryItem[]; more?: boolean; after?: [string, string]; other_owner?: number; needs_attention?: number; active_bin_id?: string }
export type AdoptState = "in_bin" | "stamp_failed" | "save_failed" | "ledger_failed" | "conflict" | "elsewhere" | "not_seen" | "not_prepared" | "project_changed" | "busy" | "unknown" | "account_changed" | "rebuild_recovery_pending" | "replace_failed" | "other_window";
export interface AdoptResult { state: AdoptState; details?: unknown }
export interface PrepareResult { gen_id: string; state: "prepared" | "failed" | "account_changed" | "other_window"; path?: string; error?: string }
export interface PanelSelection { ctx: PanelContext; project_id: string; folder_path: string; window?: string }
export const contextKey = (ctx: PanelContext | null) => ctx ? JSON.stringify([ctx.instance, ctx.account, ctx.epoch]) : "";
const post = <T,>(path: string, body: unknown) => jsonFetch<T>(`/api/resolve/panel/${path}`, { method: "POST", body: JSON.stringify(body) });
export const resolvePanelApi = {
  identity: (window = "", claim = false) => jsonFetch<PanelIdentity>(`/api/resolve/panel/identity?${new URLSearchParams({ window, claim: String(claim) })}`),
  cache: (body: PanelSelection & { window: string; seq: number; gen_ids: string[] }) => post<{ state?: "account_changed"; items: { gen_id: string; state: "cached" | "failed"; error?: string }[] }>("cache", body),
  prepare: (body: PanelSelection & { gen_id: string }) => post<PrepareResult>("prepare", body),
  target: (body: PanelSelection & { window: string; seq: number; create: boolean; episode_path?: string; create_paths?: string[] }) => post<TargetResult>("target", body),
  currentBin: (ctx: PanelContext, project_id = "", folder_path = "") => jsonFetch<TargetResult>(`/api/resolve/panel/current-bin?${new URLSearchParams({ instance: ctx.instance, account: ctx.account, epoch: String(ctx.epoch), project_id, folder_path })}`),
  adopt: (body: PanelSelection & { gen_id: string; resolve_project_id: string; bin_id?: string; item_ids?: string[] }) => post<AdoptResult>("adopt", body),
  stage: (body: PanelSelection & { window: string; seq: number; gen_ids: string[]; capped?: boolean; bin_id?: string }) => post<StageResult>("stage", body),
  unstage: (body: PanelSelection & { bin_id: string; inventory_cleanup?: boolean; delete_empty?: boolean }) => post<TargetResult>("unstage", body),
  inventory: (ctx: PanelContext, after?: [string, string]) => jsonFetch<InventoryResult>(`/api/resolve/panel/inventory?${new URLSearchParams({ instance: ctx.instance, account: ctx.account, epoch: String(ctx.epoch), ...(after ? { after: JSON.stringify(after) } : {}) })}`),
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
    import_failed: "가져오기를 확인하지 못했습니다", conflict: "표시 충돌", not_seen: "항목을 찾지 못했습니다",
    project_changed: "프로젝트가 바뀜", busy: "확인 중 — 리졸브가 바쁨", unknown: "확인 못 함",
    unavailable: "리졸브에 연결하지 못했습니다", active_bin: "지금 쓰는 빈이라 남겼습니다",
    rebuild_recovery_pending: RECOVERY_PENDING, not_prepared: "준비 기록을 찾지 못했습니다",
  };
  return t(labels[state] || "확인 못 함");
}
