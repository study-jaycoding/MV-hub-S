import { jsonFetch } from "./http";
import { t } from "./i18n";

export const PANEL_PROTOCOL = 1;
export interface PanelContext { instance: string; account: string; epoch: number }
export interface PanelIdentity extends PanelContext { protocol: { min: number; max: number } }
export interface ResolveDragBridge {
  protocol: number;
  accepts: { min: number; max: number };
  startDrag(path: string, opts: { protocol: number }): boolean;
}
declare global { interface Window { mvhubResolve?: ResolveDragBridge } }
export type TargetState = "ok" | "missing" | "stale" | "busy" | "rebuild_recovery_pending" | "unavailable" | "account_changed";
export interface TargetResult {
  state: TargetState; resolve_project_id?: string; resolve_project_name?: string;
  bin_path?: string; bin_id?: string; details?: unknown;
}
export type AdoptState = "in_bin" | "stamp_failed" | "save_failed" | "ledger_failed" | "conflict" | "elsewhere" | "not_seen" | "not_prepared" | "project_changed" | "busy" | "unknown" | "account_changed" | "rebuild_recovery_pending";
export interface AdoptResult { state: AdoptState; details?: unknown }
export interface PrepareResult { gen_id: string; state: "prepared" | "failed" | "account_changed"; path?: string; error?: string }
export interface PanelSelection { ctx: PanelContext; project_id: string; folder_path: string }
export const contextKey = (ctx: PanelContext | null) => ctx ? JSON.stringify([ctx.instance, ctx.account, ctx.epoch]) : "";
const post = <T,>(path: string, body: unknown) => jsonFetch<T>(`/api/resolve/panel/${path}`, { method: "POST", body: JSON.stringify(body) });
export const resolvePanelApi = {
  identity: () => jsonFetch<PanelIdentity>("/api/resolve/panel/identity"),
  cache: (body: PanelSelection & { window: string; seq: number; gen_ids: string[] }) => post<{ state?: "account_changed"; items: { gen_id: string; state: "cached" | "failed"; error?: string }[] }>("cache", body),
  prepare: (body: PanelSelection & { gen_id: string }) => post<PrepareResult>("prepare", body),
  target: (body: PanelSelection & { window: string; seq: number; create: boolean }) => post<TargetResult>("target", body),
  currentBin: (ctx: PanelContext) => jsonFetch<TargetResult>(`/api/resolve/panel/current-bin?${new URLSearchParams({ instance: ctx.instance, account: ctx.account, epoch: String(ctx.epoch) })}`),
  adopt: (body: PanelSelection & { gen_id: string; resolve_project_id: string }) => post<AdoptResult>("adopt", body),
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
export function dragPermission(input: {
  bridge: ResolveDragBridge | undefined; identity: PanelIdentity | null; prepared: boolean;
  targetOk: boolean; contextCurrent: boolean;
}): { ok: boolean; reason: string } {
  if (!hasResolveBridge(input.bridge)) return { ok: false, reason: t(BRIDGE_MISSING) };
  if (!bridgeCompatible(input.bridge, input.identity)) return { ok: false, reason: t(PROTOCOL_MISMATCH) };
  if (!input.prepared) return { ok: false, reason: t("준비 중 — 다 되면 다시 끌어 주세요") };
  if (!input.targetOk) return { ok: false, reason: t("리졸브 빈을 먼저 확인해 주세요") };
  if (!input.contextCurrent) return { ok: false, reason: t("계정 문맥을 확인 중입니다") };
  return { ok: true, reason: "" };
}
export function startPanelDrag(bridge: ResolveDragBridge, path: string): boolean {
  return bridge.startDrag(path, { protocol: PANEL_PROTOCOL }) === true;
}
export function adoptAction(state: AdoptState): "done" | "retry" | "busy" | "prepare" | "reset" | "block" | "stop" {
  switch (state) {
    case "in_bin": return "done";
    case "not_seen": return "retry";
    case "busy": return "busy";
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
    case "missing": return { action: "set", ready: false, message: t("리졸브 빈은 첫 끌기 때 만듭니다") };
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
