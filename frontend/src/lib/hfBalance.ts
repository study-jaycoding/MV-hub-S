import { jsonFetch } from "./http";
import type { BalancesResponse, BalanceLedgerResponse } from "../shared/contracts/hfBalance";
export type { BalanceMeta, BalancePartialTotals } from "../shared/contracts/hfBalance";

export function getBalances(workspaceId?: string, signal?: AbortSignal): Promise<BalancesResponse> {
  const query = workspaceId ? `?${new URLSearchParams({ workspace_id: workspaceId })}` : "";
  return jsonFetch(`/api/manage/balances${query}`, { signal });
}

export function getBalanceLedger(workspaceId: string, start: string, end: string, cursor?: string | null, signal?: AbortSignal): Promise<BalanceLedgerResponse> {
  const query = new URLSearchParams({ workspace_id: workspaceId, start, end, limit: "500" });
  if (cursor) query.set("cursor", cursor);
  return jsonFetch(`/api/manage/console/balance-ledger?${query}`, { signal });
}
